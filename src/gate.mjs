// Fail-closed gate for the daily digest.
//
// A run that collapses to zero papers must never be reported as a healthy
// delivery: the pipeline is silent by nature, so an empty digest that is
// marked "delivered" is indistinguishable from a good day at a glance.
// The gate names the first stage that emptied out so the failure is
// actionable instead of just visible.

export class EmptyDigestError extends Error {
  constructor(gate) {
    super(`Empty digest blocked at stage "${gate.stage}": ${gate.reason}`);
    this.name = 'EmptyDigestError';
    this.stage = gate.stage;
    this.reason = gate.reason;
    // Tells runCollector the run row was already finalized with rich
    // metadata, so the generic error handler must not overwrite it.
    this.finalized = true;
  }
}

export const describeEmptyStage = (counts, { lookbackDays }) => {
  if (counts.selected > 0) return null;
  if (counts.source === 0) {
    return { stage: 'source', reason: 'arXiv 返回 0 篇论文，采集源没有产出' };
  }
  if (counts.recent === 0) {
    return {
      stage: 'recency',
      reason: `arXiv 返回 ${counts.source} 篇，但没有一篇的提交时间落在最近 ${lookbackDays} 天窗口内（疑似上游排序或时间字段异常）`
    };
  }
  if (counts.shortlist === 0) {
    return {
      stage: 'topic-rules',
      reason: `窗口内有 ${counts.recent} 篇，但关键词与主题规则一篇都没命中`
    };
  }
  if (counts.ranked === 0) {
    return {
      stage: 'ranking',
      reason: `初筛 ${counts.shortlist} 篇，但评分阶段没有返回任何可用打分`
    };
  }
  return {
    stage: 'selection',
    reason: `评分得到 ${counts.ranked} 篇，但最终筛选后为空`
  };
};

export const buildEmptyAlert = ({ date, gate, counts, model }) => [
  `🚨 AI 论文日报 · ${date} 生成失败，已拦截空日报`,
  '',
  `失败环节：${gate.stage}`,
  `原因：${gate.reason}`,
  '',
  `管道计数：采集 ${counts.source} → 窗口内 ${counts.recent} → 初筛 ${counts.shortlist} → 评分 ${counts.ranked} → 入选 ${counts.selected}`,
  `评分模型：${model}`,
  '',
  '本次未推送日报（内容为空时一律不投递）。修复后可手动重跑或补投。'
].join('\n');
