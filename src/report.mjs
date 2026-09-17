const escapeMd = (value = '') => String(value).replaceAll('|', '\\|');
const bulletList = (items) => (items || []).map((item) => `  - ${escapeMd(item)}`);

export const buildMarkdownReport = ({
  date, generatedAt, papers, sourceCount, recentCount, shortlistCount, model,
  degraded, modelDegraded, degradedReason, sourceStatus = {}, trends = [],
  emptyGate = null, pipelineCounts = null
}) => {
  const hf = sourceStatus.huggingFace || {};
  const github = sourceStatus.github || {};
  const pdf = sourceStatus.pdf || {};
  const lines = [
    `# AI Research Daily — ${date}`,
    '',
    `生成时间：${generatedAt}`,
    '',
    `采集 ${sourceCount} 篇，近期待选 ${recentCount} 篇，规则初筛 ${shortlistCount} 篇，最终推荐 ${papers.length} 篇。`,
    '',
    `评分模型：${model}${modelDegraded ? '（评分已降级）' : ''}`,
    `信号覆盖：HF Daily Papers ${hf.ok ? `${hf.count || 0} 篇` : '不可用'}；GitHub 核验 ${github.checked || 0} 篇 / 命中 ${github.matched || 0}；PDF 正文证据 ${pdf.succeeded || 0} / ${Math.min(pdf.requested || 0, papers.length)}。`,
    ''
  ];

  if (modelDegraded) {
    lines.push('> ⚠️ 百炼模型评分未完成，本期采用规则评分。创新度与证据充分度不应视为模型结论。');
    if (degradedReason) lines.push(`> 原因：${escapeMd(degradedReason).slice(0, 240)}`);
    lines.push('');
  } else if (degraded) {
    lines.push('> ℹ️ 核心评分已完成，但一个或多个补充信号源不可用；对应结论已明确留空，不会自动臆测。');
    lines.push('');
  }

  if (trends.length > 0) {
    lines.push('## 近 14 日主题趋势', '');
    lines.push('| 主题 | 入选次数 | 平均分 |', '|---|---:|---:|');
    trends.forEach((trend) => lines.push(`| ${escapeMd(trend.tag)} | ${trend.appearances} | ${trend.averageScore} |`));
    lines.push('');
  }

  if (papers.length === 0) {
    lines.push('> 🚨 本次运行未产出任何论文，已被空结果闸门拦截，**未推送日报**。');
    if (emptyGate) {
      lines.push('>', `> 失败环节：${escapeMd(emptyGate.stage)}`, `> 原因：${escapeMd(emptyGate.reason)}`);
    }
    if (pipelineCounts) {
      lines.push('>', `> 管道计数：采集 ${pipelineCounts.source} → 窗口内 ${pipelineCounts.recent} → 初筛 ${pipelineCounts.shortlist} → 评分 ${pipelineCounts.ranked} → 入选 ${pipelineCounts.selected}`);
    }
    return `${lines.join('\n')}\n`;
  }

  papers.forEach((paper, index) => {
    lines.push(`## ${index + 1}. ${paper.title}`, '');
    lines.push(`- 综合评分：**${paper.totalScore.toFixed(1)} / 10**（基础 ${paper.baseTotalScore?.toFixed(1) || paper.totalScore.toFixed(1)} + 社区信号 ${paper.communityBonus?.toFixed(1) || '0.0'}；方向 ${paper.relevance} / 创新 ${paper.novelty} / 工程 ${paper.engineeringValue} / 摘要证据 ${paper.evidenceQuality}）`);
    lines.push(`- 标签：${paper.tags.join('、') || '未分类'}`);
    lines.push(`- 一句话：${paper.oneSentence}`);
    lines.push(`- 为什么重要：${paper.whyImportant}`);
    lines.push(`- 对 RAG：${paper.ragImpact}`);
    lines.push(`- 对 Agent：${paper.agentImpact}`);
    lines.push(`- 复现建议：${paper.reproduce}`);
    lines.push(`- RAG 复用 / 精读价值：${paper.ragReuseScore.toFixed(1)} / ${paper.studyValueScore.toFixed(1)}（优先分 ${paper.priorityScore.toFixed(1)}）`);
    if (paper.isPriorityPick && paper.directReusePoints?.length) {
      lines.push('- 可直接复用点：', ...bulletList(paper.directReusePoints));
    }
    if (paper.isPriorityPick) lines.push(`- 精读判断：${paper.studyRationale}`);
    if (paper.hfUrl) lines.push(`- Hugging Face：Daily Papers 第 ${paper.hfTrendingRank} 位，${paper.hfUpvotes || 0} 赞 · [页面](${paper.hfUrl})`);
    if (paper.githubUrl) lines.push(`- GitHub：${paper.githubFullName || '正文中的仓库'}，★ ${paper.githubStars || 0} / Fork ${paper.githubForks || 0} · [仓库](${paper.githubUrl})`);
    lines.push(`- 作者：${paper.authors.slice(0, 6).join(', ')}${paper.authors.length > 6 ? ' 等' : ''}`);
    lines.push(`- 链接：[摘要](${paper.url}) · [PDF](${paper.pdfUrl})`);
    lines.push('');

    if (paper.evidence?.status === 'extracted') {
      lines.push('### 正文证据', '');
      if (paper.evidence.methods?.length) lines.push('- 方法：', ...bulletList(paper.evidence.methods));
      if (paper.evidence.datasets?.length) lines.push('- 数据集/任务：', ...bulletList(paper.evidence.datasets));
      if (paper.evidence.baselines?.length) lines.push('- 对比基线：', ...bulletList(paper.evidence.baselines));
      if (paper.evidence.keyResults?.length) lines.push('- 关键结果：', ...bulletList(paper.evidence.keyResults));
      if (paper.evidence.limitations?.length) lines.push('- 局限：', ...bulletList(paper.evidence.limitations));
      if (paper.evidence.reproducibility?.length) lines.push('- 复现清单：', ...bulletList(paper.evidence.reproducibility));
      lines.push('');
    } else if (paper.evidence?.status === 'failed') {
      lines.push(`> 正文证据抽取失败：${escapeMd(paper.evidence.error).slice(0, 180)}`, '');
    }
  });

  lines.push('---', '', '说明：综合分中的社区信号最多加 0.9 分；GitHub 标题搜索只有达到匹配阈值才展示。PDF 结论来自正文截取的中文转述，建议复现前回看原文。');
  return `${lines.join('\n')}\n`;
};
