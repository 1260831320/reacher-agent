import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeFeedIntegrity, fetchArxivPapers } from './arxiv.mjs';
import { analyzePaperEvidence, rankWithBailian } from './bailian.mjs';
import { finishRun, initializeDatabase, loadTrends, persistResults, startRun } from './database.mjs';
import { deliverReport } from './delivery.mjs';
import { sendFeishuAlert } from './feishu.mjs';
import { buildEmptyAlert, describeEmptyStage, EmptyDigestError } from './gate.mjs';
import { enrichWithGithub } from './github.mjs';
import { enrichWithHuggingFace, fetchHuggingFaceDailyPapers } from './huggingface.mjs';
import { extractPdfText } from './pdf.mjs';
import { prioritizeDailyPapers, shortlistPapers } from './ranking.mjs';
import { buildMarkdownReport } from './report.mjs';

const zonedDate = (date, timezone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(date);

const scopedSignal = (parent, timeoutMs) => AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);

const communityBonus = (paper) => {
  const hf = paper.hfTrendingRank ? Math.max(0.05, 0.45 - (paper.hfTrendingRank - 1) * 0.015) : 0;
  const github = paper.githubStars ? Math.min(0.45, Math.log10(paper.githubStars + 1) * 0.13) : 0;
  return Math.round((hf + github) * 10) / 10;
};

const addEvidence = async (papers, config, signal, sourceStatus) => {
  const enriched = [];
  for (let index = 0; index < papers.length; index += 1) {
    const paper = papers[index];
    if (index >= config.pdfEvidenceCount) {
      enriched.push({ ...paper, evidence: { status: 'not-requested' } });
      continue;
    }
    try {
      const extracted = await extractPdfText(paper, {
        signal,
        maxBytes: config.pdfMaxBytes,
        maxChars: config.pdfMaxChars
      });
      const evidence = await analyzePaperEvidence(paper, extracted.text, config, signal);
      enriched.push({ ...paper, evidence: { ...evidence, pdfBytes: extracted.pdfBytes, textTruncated: extracted.truncated } });
      sourceStatus.pdf.succeeded += 1;
    } catch (error) {
      sourceStatus.pdf.errors.push(`${paper.arxivId}: ${error.message}`);
      enriched.push({ ...paper, evidence: { status: 'failed', error: error.message } });
    }
  }
  return enriched;
};

export const runCollector = async (config, { force = false } = {}) => {
  const startedAt = new Date();
  const date = zonedDate(startedAt, config.timezone);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Research run timed out')), 510_000);
  let runId;
  try {
    await initializeDatabase(config);
    runId = await startRun(config, { date, startedAt: startedAt.toISOString() });
    const sourceStatus = {
      arxiv: { ok: false, count: 0 },
      huggingFace: { ok: false, count: 0, error: '' },
      github: { ok: true, checked: 0, matched: 0, errors: [] },
      pdf: { requested: config.pdfEvidenceCount, succeeded: 0, errors: [] },
      database: { enabled: Boolean(config.databaseUrl), ok: true, error: '' }
    };

    const [arxivResult, hfResult] = await Promise.allSettled([
      fetchArxivPapers({ maxResults: config.arxivMaxResults, signal: controller.signal }),
      fetchHuggingFaceDailyPapers({
        signal: scopedSignal(controller.signal, config.externalSourceTimeoutMs),
        token: config.huggingFaceToken
      })
    ]);
    if (arxivResult.status === 'rejected') throw arxivResult.reason;
    const allPapers = arxivResult.value;
    // Keep the shape of what arXiv actually returned: when the upstream sort
    // silently degrades, these fields are the only forensic trail afterwards.
    const arxivIntegrity = describeFeedIntegrity(allPapers);
    sourceStatus.arxiv = { ok: true, count: allPapers.length, ...arxivIntegrity };
    const hfPapers = hfResult.status === 'fulfilled' ? hfResult.value : [];
    sourceStatus.huggingFace = hfResult.status === 'fulfilled'
      ? { ok: true, count: hfPapers.length, error: '' }
      : { ok: false, count: 0, error: hfResult.reason?.message || 'Unknown Hugging Face error' };

    const cutoff = Date.now() - config.arxivLookbackDays * 24 * 60 * 60 * 1000;
    const recent = allPapers.filter((paper) => Number.isFinite(new Date(paper.published).getTime()) && new Date(paper.published).getTime() >= cutoff);
    const shortlist = enrichWithHuggingFace(shortlistPapers(recent, config.shortlistSize), hfPapers);
    const ranking = shortlist.length > 0
      ? await rankWithBailian(shortlist, config, controller.signal)
      : { assessments: [], degraded: false, reason: '' };
    const byId = new Map(ranking.assessments.map((assessment) => [assessment.arxivId, assessment]));
    const ranked = shortlist
      .map((paper) => ({ ...paper, ...byId.get(paper.arxivId) }))
      .filter((paper) => Number.isFinite(paper.totalScore))
      .sort((a, b) => b.totalScore - a.totalScore || b.lexicalScore - a.lexicalScore)
      .slice(0, Math.min(shortlist.length, config.dailyTopCount + 3));

    const github = await enrichWithGithub(ranked, {
      signal: scopedSignal(controller.signal, Math.max(config.externalSourceTimeoutMs * ranked.length, 15_000)),
      token: config.githubToken
    });
    sourceStatus.github = {
      ok: github.errors.length === 0,
      checked: ranked.length,
      matched: github.papers.filter((paper) => paper.githubUrl).length,
      errors: github.errors
    };
    const scoredCandidates = github.papers
      .map((paper) => {
        const bonus = communityBonus(paper);
        return { ...paper, baseTotalScore: paper.totalScore, communityBonus: bonus, totalScore: Math.min(10, Math.round((paper.totalScore + bonus) * 10) / 10) };
      });
    let selected = prioritizeDailyPapers(scoredCandidates, config.dailyTopCount);
    selected = await addEvidence(selected, config, controller.signal, sourceStatus);

    try {
      await persistResults(config, runId, selected);
    } catch (error) {
      sourceStatus.database = { enabled: true, ok: false, error: error.message };
    }
    const trends = sourceStatus.database.ok ? await loadTrends(config) : [];
    const pipelineCounts = {
      source: allPapers.length,
      recent: recent.length,
      shortlist: shortlist.length,
      ranked: ranked.length,
      selected: selected.length
    };
    const emptyGate = describeEmptyStage(pipelineCounts, { lookbackDays: config.arxivLookbackDays });
    const optionalDegraded = !sourceStatus.huggingFace.ok || !sourceStatus.github.ok
      || sourceStatus.pdf.errors.length > 0 || !sourceStatus.database.ok
      || !arxivIntegrity.sortedDescending;
    const generatedAt = new Date().toISOString();
    const metadata = {
      runId,
      date,
      generatedAt,
      source: 'arXiv + Hugging Face + GitHub + PDF',
      sourceCount: allPapers.length,
      recentCount: recent.length,
      shortlistCount: shortlist.length,
      selectedCount: selected.length,
      pipelineCounts,
      emptyGate,
      model: config.bailianModel,
      protocol: config.bailianProtocol,
      degraded: ranking.degraded || optionalDegraded || Boolean(emptyGate),
      modelDegraded: ranking.degraded,
      degradedReason: ranking.reason || '',
      sourceStatus,
      trends,
      delivery: { enabled: config.feishuEnabled, status: 'pending', attempts: 0 }
    };
    const report = { ...metadata, papers: selected };
    const markdown = buildMarkdownReport(report);

    await Promise.all([mkdir(config.dataDir, { recursive: true }), mkdir(config.reportsDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(config.reportsDir, `${date}.md`), markdown, 'utf8'),
      writeFile(path.join(config.reportsDir, `${date}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
      writeFile(path.join(config.reportsDir, 'latest.md'), markdown, 'utf8'),
      writeFile(path.join(config.dataDir, 'last-run.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    ]);

    // deliverReport refuses a zero-paper digest itself; this call records the
    // block so the refusal is auditable rather than merely absent.
    metadata.delivery = await deliverReport(report, config, controller.signal, { force });

    if (emptyGate) {
      metadata.alert = await sendFeishuAlert(
        buildEmptyAlert({ date, gate: emptyGate, counts: pipelineCounts, model: config.bailianModel }),
        config,
        controller.signal
      );
    }

    await Promise.all([
      writeFile(path.join(config.reportsDir, `${date}.json`), `${JSON.stringify({ ...metadata, papers: selected }, null, 2)}\n`, 'utf8'),
      writeFile(path.join(config.dataDir, 'last-run.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')
    ]);

    if (emptyGate) {
      // Fail closed: an empty day is a failed run, never a completed one.
      await finishRun(config, runId, { status: 'failed', degraded: true, metadata });
      throw new EmptyDigestError(emptyGate);
    }

    await finishRun(config, runId, { status: 'completed', degraded: metadata.degraded, metadata });

    return { ok: true, ...metadata, reportPath: path.join(config.reportsDir, `${date}.md`) };
  } catch (error) {
    if (!error.finalized) {
      try {
        await finishRun(config, runId, { status: 'failed', degraded: true, metadata: { error: error.message } });
      } catch {
        // Preserve the original collection error.
      }
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
