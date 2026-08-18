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
  return {
    arxivId: paper.arxivId,
    relevance,
    novelty,
    engineeringValue,
    evidenceQuality,
    totalScore: Math.round((relevance * 0.4 + novelty * 0.25 + engineeringValue * 0.25 + evidenceQuality * 0.1) * 10) / 10,
    tags: paper.lexicalTopics,
    oneSentence: paper.abstract.split(/(?<=[.!?])\s+/)[0]?.slice(0, 220) || paper.title,
    whyImportant: '基于标题与摘要的规则初筛结果，需人工或模型进一步复核。',
    ragImpact: paper.lexicalTopics.includes('RAG') || paper.lexicalTopics.includes('Retrieval') ? '可能直接影响检索与生成链路。' : '间接相关。',
    agentImpact: paper.lexicalTopics.includes('Agent') || paper.lexicalTopics.includes('Memory') ? '可能影响 Agent 架构或记忆设计。' : '间接相关。',
    reproduce: '需检查正文、代码与实验设置后决定。'
  };
};

