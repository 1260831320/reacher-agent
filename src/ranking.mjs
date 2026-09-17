const TOPIC_RULES = [
  ['RAG', /\b(rag|retrieval[- ]augmented|retrieval augmented generation|knowledge grounding|grounded generation)\b/i, 5],
  ['Agent', /\b(agentic|llm agents?|multi[- ]agent|tool use|tool calling|computer use)\b/i, 5],
  ['Memory', /\b(long[- ]term memory|agent memory|memory system|memory architecture)\b/i, 4],
  ['Reasoning', /\b(reasoning|planning|reflection|self-correction|test[- ]time compute)\b/i, 3],
  ['Retrieval', /\b(information retrieval|rerank|embedding|vector database|dense retrieval|hybrid retrieval)\b/i, 4],
  ['Evaluation', /\b(benchmark|evaluation|evals?|hallucination|factuality|reliability)\b/i, 2],
  ['LLM Systems', /\b(large language model|foundation model|prompt caching|inference|context window)\b/i, 1]
];

export const lexicalScore = (paper) => {
  const text = `${paper.title}\n${paper.abstract}`;
  const matches = TOPIC_RULES.filter(([, pattern]) => pattern.test(text));
  const titleBoost = TOPIC_RULES.reduce((sum, [, pattern, weight]) => sum + (pattern.test(paper.title) ? weight : 0), 0);
  return {
    lexicalScore: matches.reduce((sum, [, , weight]) => sum + weight, 0) + titleBoost,
    lexicalTopics: matches.map(([topic]) => topic)
  };
};

export const shortlistPapers = (papers, size) => papers
  .map((paper) => ({ ...paper, ...lexicalScore(paper) }))
  .filter((paper) => paper.lexicalScore > 0)
  .sort((a, b) => b.lexicalScore - a.lexicalScore || new Date(b.published) - new Date(a.published))
  .slice(0, size);

export const heuristicAssessment = (paper) => {
  const relevance = Math.min(10, Math.max(3, Math.round(paper.lexicalScore / 2)));
  const engineeringValue = Math.min(8, 3 + paper.lexicalTopics.filter((topic) => ['RAG', 'Agent', 'Retrieval', 'LLM Systems'].includes(topic)).length);
  const novelty = 5;
  const evidenceQuality = 4;
  const ragReuseScore = Math.min(10, Math.max(3, relevance + (paper.lexicalTopics.includes('RAG') ? 2 : 0)));
  const studyValueScore = Math.min(10, Math.max(4, Math.round((novelty + engineeringValue + evidenceQuality) / 3)));
  const directTopics = paper.lexicalTopics.filter((topic) => ['RAG', 'Retrieval', 'Agent', 'Memory', 'Evaluation'].includes(topic));
  return {
    arxivId: paper.arxivId,
    relevance,
    novelty,
    engineeringValue,
    evidenceQuality,
    totalScore: Math.round((relevance * 0.4 + novelty * 0.25 + engineeringValue * 0.25 + evidenceQuality * 0.1) * 10) / 10,
    ragReuseScore,
    studyValueScore,
    priorityScore: Math.round((ragReuseScore * 0.6 + studyValueScore * 0.4) * 10) / 10,
    tags: paper.lexicalTopics,
    oneSentence: paper.abstract.split(/(?<=[.!?])\s+/)[0]?.slice(0, 220) || paper.title,
    whyImportant: '基于标题与摘要的规则初筛结果，需人工或模型进一步复核。',
    ragImpact: paper.lexicalTopics.includes('RAG') || paper.lexicalTopics.includes('Retrieval') ? '可能直接影响检索与生成链路。' : '间接相关。',
    agentImpact: paper.lexicalTopics.includes('Agent') || paper.lexicalTopics.includes('Memory') ? '可能影响 Agent 架构或记忆设计。' : '间接相关。',
    reproduce: '需检查正文、代码与实验设置后决定。',
    directReusePoints: directTopics.slice(0, 3).map((topic) => `${topic} 方向的实现可作为现有服务的候选改进点`),
    studyRationale: '规则降级仅能判断主题与摘要结构，精读价值需结合正文复核。',
    priorityReason: '按 RAG 主题贴合度与工程学习价值综合排序，需模型恢复后复核。'
  };
};

const qualityOrder = (a, b) => b.totalScore - a.totalScore || b.lexicalScore - a.lexicalScore;
const priorityOrder = (a, b) => b.priorityScore - a.priorityScore
  || b.ragReuseScore - a.ragReuseScore
  || b.studyValueScore - a.studyValueScore
  || qualityOrder(a, b);

// Preserve the existing quality-based Top N, but allow exactly one paper from
// the wider ranked pool to take the final slot when it is the strongest
// RAG-reuse + study candidate. The priority paper is always position 1; the
// relative order of the other papers remains unchanged.
export const prioritizeDailyPapers = (papers, count) => {
  if (count <= 0 || papers.length === 0) return [];
  const qualityTop = [...papers].sort(qualityOrder).slice(0, count);
  const priorityPaper = [...papers].sort(priorityOrder)[0];
  const selected = qualityTop.some((paper) => paper.arxivId === priorityPaper.arxivId)
    ? qualityTop
    : [...qualityTop.slice(0, Math.max(0, count - 1)), priorityPaper];
  return [
    { ...priorityPaper, isPriorityPick: true },
    ...selected
      .filter((paper) => paper.arxivId !== priorityPaper.arxivId)
      .map((paper) => ({ ...paper, isPriorityPick: false }))
  ];
};
