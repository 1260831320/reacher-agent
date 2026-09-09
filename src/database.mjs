import { readFile } from 'node:fs/promises';
import pg from 'pg';

const { Pool } = pg;
let pool;

export const databaseEnabled = (config) => Boolean(config.databaseUrl);

const getPool = (config) => {
  if (!pool) pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5_000 });
  return pool;
};

export const initializeDatabase = async (config) => {
  if (!databaseEnabled(config)) return { enabled: false };
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await getPool(config).query(schema);
  return { enabled: true };
};

export const checkDatabase = async (config) => {
  if (!databaseEnabled(config)) return { enabled: false, ok: true };
  try {
    await getPool(config).query('SELECT 1');
    return { enabled: true, ok: true };
  } catch (error) {
    return { enabled: true, ok: false, error: error.message };
  }
};

export const startRun = async (config, { date, startedAt }) => {
  if (!databaseEnabled(config)) return null;
  const result = await getPool(config).query(
    `INSERT INTO research_runs (run_date, started_at, status, model)
     VALUES ($1, $2, 'running', $3) RETURNING id`,
    [date, startedAt, config.bailianModel]
  );
  return result.rows[0].id;
};

export const finishRun = async (config, runId, { status, degraded = false, metadata = {} }) => {
  if (!databaseEnabled(config) || !runId) return;
  await getPool(config).query(
    `UPDATE research_runs
     SET completed_at = NOW(), status = $2, degraded = $3, metadata = $4::jsonb
     WHERE id = $1`,
    [runId, status, degraded, JSON.stringify(metadata)]
  );
};

const summaryOf = (paper) => ({
  oneSentence: paper.oneSentence,
  whyImportant: paper.whyImportant,
  ragImpact: paper.ragImpact,
  agentImpact: paper.agentImpact,
  reproduce: paper.reproduce
});

const signalsOf = (paper) => ({
  hfTrendingRank: paper.hfTrendingRank || null,
  hfUpvotes: paper.hfUpvotes || 0,
  hfComments: paper.hfComments || 0,
  hfUrl: paper.hfUrl || '',
  githubUrl: paper.githubUrl || '',
  githubFullName: paper.githubFullName || '',
  githubStars: paper.githubStars || 0,
  githubForks: paper.githubForks || 0,
  githubOpenIssues: paper.githubOpenIssues || 0,
  githubPushedAt: paper.githubPushedAt || '',
  githubConfidence: paper.githubConfidence || 0,
  githubDiscovery: paper.githubDiscovery || ''
});

export const persistResults = async (config, runId, papers) => {
  if (!databaseEnabled(config) || !runId) return;
  const client = await getPool(config).connect();
  try {
    await client.query('BEGIN');
    for (let index = 0; index < papers.length; index += 1) {
      const paper = papers[index];
      await client.query(
        `INSERT INTO research_papers
           (arxiv_id, title, abstract, authors, categories, published_at, updated_at, url, pdf_url)
         VALUES ($1, $2, $3, $4::jsonb, $5::text[], $6, $7, $8, $9)
         ON CONFLICT (arxiv_id) DO UPDATE SET
           title = EXCLUDED.title, abstract = EXCLUDED.abstract, authors = EXCLUDED.authors,
           categories = EXCLUDED.categories, updated_at = EXCLUDED.updated_at,
           url = EXCLUDED.url, pdf_url = EXCLUDED.pdf_url, last_seen_at = NOW()`,
        [paper.arxivId, paper.title, paper.abstract, JSON.stringify(paper.authors), paper.categories, paper.published, paper.updated, paper.url, paper.pdfUrl]
      );
      await client.query(
        `INSERT INTO research_assessments
           (run_id, arxiv_id, rank, lexical_score, total_score, relevance, novelty,
            engineering_value, evidence_quality, tags, summary, signals, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb)`,
        [runId, paper.arxivId, index + 1, paper.lexicalScore || 0, paper.totalScore,
          paper.relevance, paper.novelty, paper.engineeringValue, paper.evidenceQuality,
          JSON.stringify(paper.tags || []), JSON.stringify(summaryOf(paper)),
          JSON.stringify(signalsOf(paper)), JSON.stringify(paper.evidence || {})]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export const loadTrends = async (config, days = 14) => {
  if (!databaseEnabled(config)) return [];
  const result = await getPool(config).query(
    `WITH daily_tags AS (
       SELECT DISTINCT r.run_date, a.arxiv_id, tag, a.total_score
       FROM research_assessments a
       JOIN research_runs r ON r.id = a.run_id,
            LATERAL jsonb_array_elements_text(a.tags) AS tag
       WHERE a.created_at >= NOW() - ($1::text || ' days')::interval
     )
     SELECT tag, COUNT(*)::int AS appearances,
            ROUND(AVG(total_score)::numeric, 1)::float AS average_score
     FROM daily_tags
     GROUP BY tag
     ORDER BY appearances DESC, average_score DESC, tag
     LIMIT 8`,
    [days]
  );
  return result.rows.map((row) => ({ tag: row.tag, appearances: row.appearances, averageScore: row.average_score }));
};

export const wasDelivered = async (config, date, channel) => {
  if (!databaseEnabled(config)) return false;
  const result = await getPool(config).query(
    `SELECT EXISTS(
       SELECT 1 FROM research_deliveries WHERE run_date = $1 AND channel = $2 AND status = 'delivered'
     ) AS delivered`,
    [date, channel]
  );
  return result.rows[0].delivered;
};

export const recordDelivery = async (config, runId, date, channel, delivery) => {
  if (!databaseEnabled(config)) return;
  const allowed = new Set(['delivered', 'failed', 'skipped', 'misconfigured', 'blocked-empty']);
  const status = allowed.has(delivery.status) ? delivery.status : 'failed';
  await getPool(config).query(
    `INSERT INTO research_deliveries
       (run_id, run_date, channel, status, attempts, message_id, error, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $4 = 'delivered' THEN NOW() ELSE NULL END)`,
    [runId, date, channel, status, delivery.attempts || 0, delivery.messageId || '', delivery.error || '']
  );
};

// Marks an earlier successful delivery for the same date+channel as superseded
// so a corrected digest can take the unique live-delivery slot. The original
// row is kept (message id and timestamp intact) as an audit trail.
export const supersedePreviousDelivery = async (config, date, channel) => {
  if (!databaseEnabled(config)) return 0;
  const result = await getPool(config).query(
    `UPDATE research_deliveries SET status = 'superseded'
     WHERE run_date = $1 AND channel = $2 AND status = 'delivered'`,
    [date, channel]
  );
  return result.rowCount;
};
