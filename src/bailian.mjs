import { heuristicAssessment } from './ranking.mjs';

const extractJson = (text) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) {
    const parsed = JSON.parse(candidate.slice(objectStart, objectEnd + 1));
    if (Array.isArray(parsed.papers)) return parsed.papers;
  }
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart < 0 || arrayEnd <= arrayStart) throw new Error('Model response does not contain a papers JSON payload');
  return JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
};

const extractJsonObject = (text) => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Model response does not contain a JSON object');
  return JSON.parse(candidate.slice(start, end + 1));
};

const clamp = (value, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(10, number)) : fallback;
};

const normalizeAssessment = (paper, raw) => {
  const fallback = heuristicAssessment(paper);
  const relevance = clamp(raw?.relevance, fallback.relevance);
  const novelty = clamp(raw?.novelty, fallback.novelty);
  const engineeringValue = clamp(raw?.engineeringValue, fallback.engineeringValue);
  const evidenceQuality = clamp(raw?.evidenceQuality, fallback.evidenceQuality);
  return {
    arxivId: paper.arxivId,
    relevance,
    novelty,
    engineeringValue,
    evidenceQuality,
    totalScore: Math.round((relevance * 0.4 + novelty * 0.25 + engineeringValue * 0.25 + evidenceQuality * 0.1) * 10) / 10,
    tags: Array.isArray(raw?.tags) ? raw.tags.slice(0, 5).map(String) : fallback.tags,
    oneSentence: String(raw?.oneSentence || fallback.oneSentence),
    whyImportant: String(raw?.whyImportant || fallback.whyImportant),
    ragImpact: String(raw?.ragImpact || fallback.ragImpact),
    agentImpact: String(raw?.agentImpact || fallback.agentImpact),
    reproduce: String(raw?.reproduce || fallback.reproduce)
  };
};

const buildPrompt = (papers) => `你是一名专注 RAG、LLM Agent 与 AI 工程落地的研究负责人。
只能依据给出的标题和摘要判断，不得虚构引用量、GitHub、实验结果或顶会录用状态。

请逐篇评分并输出严格 JSON Object，不要输出 Markdown，顶层格式必须是 {"papers":[...]}。papers 中每项字段：
- arxivId: 原样返回
- relevance: 与 RAG/Agent/AI 工程方向匹配度，0-10
- novelty: 摘要所体现的方法创新度，0-10
- engineeringValue: 可落地或可复现价值，0-10
- evidenceQuality: 摘要中实验、数据集、基线、量化结论的充分度，0-10
- tags: 最多 5 个简短中文或英文标签
- oneSentence: 一句话中文摘要
- whyImportant: 为什么值得关注，中文，最多 80 字
- ragImpact: 对 RAG 的影响；无直接影响就明确写“间接相关”
- agentImpact: 对 Agent 的影响；无直接影响就明确写“间接相关”
- reproduce: 是否值得复现及首要验证点，中文，最多 80 字

论文：
${JSON.stringify(papers.map(({ arxivId, title, abstract, categories }) => ({ arxivId, title, abstract, categories })))}`;

const requestOpenAi = async (papers, config, signal) => {
  const response = await fetch(config.bailianApiUrl, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${config.bailianApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.bailianModel,
      temperature: 0.1,
      max_tokens: 6000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是严谨的 AI 论文筛选与研究分析助手。' },
        { role: 'user', content: buildPrompt(papers) }
      ]
    })
  });
  if (!response.ok) throw new Error(`Bailian request failed: HTTP ${response.status} ${await response.text().then((value) => value.slice(0, 300))}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content || '';
};

const requestAnthropic = async (papers, config, signal) => {
  const response = await fetch(config.bailianApiUrl, {
    method: 'POST',
    signal,
    headers: {
      'x-api-key': config.bailianApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.bailianModel,
      max_tokens: 6000,
      thinking: { type: 'disabled' },
      system: '你是严谨的 AI 论文筛选与研究分析助手。',
      messages: [{ role: 'user', content: buildPrompt(papers) }]
    })
  });
  if (!response.ok) throw new Error(`Bailian request failed: HTTP ${response.status} ${await response.text().then((value) => value.slice(0, 300))}`);
  const body = await response.json();
  return (body.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
};

const requestPrompt = async (prompt, config, signal) => {
  if (config.bailianProtocol === 'anthropic') {
    const response = await fetch(config.bailianApiUrl, {
      method: 'POST', signal,
      headers: { 'x-api-key': config.bailianApiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.bailianModel,
        max_tokens: 3200,
        thinking: { type: 'disabled' },
        system: '你是严谨的 AI 论文正文证据审阅助手，只能依据输入正文作答。',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!response.ok) throw new Error(`Bailian evidence request failed: HTTP ${response.status}`);
    const body = await response.json();
    return (body.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  }
  const response = await fetch(config.bailianApiUrl, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${config.bailianApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.bailianModel,
      temperature: 0.1,
      max_tokens: 3200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是严谨的 AI 论文正文证据审阅助手，只能依据输入正文作答。' },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) throw new Error(`Bailian evidence request failed: HTTP ${response.status}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content || '';
};

const list = (value, limit = 6) => Array.isArray(value) ? value.slice(0, limit).map(String) : [];

export const analyzePaperEvidence = async (paper, text, config, signal) => {
  if (config.dryRun) return {
    status: 'dry-run', methods: [], datasets: [], baselines: [], keyResults: [], limitations: [], reproducibility: []
  };
  const prompt = `请依据以下论文正文提取可核验的实验与复现证据。不要补充正文中没有的信息；不确定就写“正文截取范围内未发现”。
输出严格 JSON Object，字段为：
- methods: 最多 5 条核心方法步骤
- datasets: 最多 6 个数据集或任务
- baselines: 最多 6 个对比基线
- keyResults: 最多 6 条量化结果的中文转述（不要长段引用）
- limitations: 最多 5 条作者明示或可由实验范围直接判断的限制
- reproducibility: 最多 6 条复现所需配置、资源、代码或检查项

论文标题：${paper.title}
arXiv ID：${paper.arxivId}
正文截取：
${text}`;
  const raw = extractJsonObject(await requestPrompt(prompt, config, signal));
  return {
    status: 'extracted',
    methods: list(raw.methods, 5),
    datasets: list(raw.datasets),
    baselines: list(raw.baselines),
    keyResults: list(raw.keyResults),
    limitations: list(raw.limitations, 5),
    reproducibility: list(raw.reproducibility)
  };
};

export const rankWithBailian = async (papers, config, signal) => {
  if (config.dryRun) return { assessments: papers.map(heuristicAssessment), degraded: true, reason: 'DRY_RUN=1' };
  if (!config.bailianApiKey) throw new Error('BAILIAN_API_KEY is required');
  const assessments = [];
  const errors = [];
  for (let index = 0; index < papers.length; index += 6) {
    const batch = papers.slice(index, index + 6);
    try {
      const text = config.bailianProtocol === 'anthropic'
        ? await requestAnthropic(batch, config, signal)
        : await requestOpenAi(batch, config, signal);
      const parsed = extractJson(text);
      const byId = new Map(parsed.map((item) => [String(item.arxivId), item]));
      assessments.push(...batch.map((paper) => normalizeAssessment(paper, byId.get(paper.arxivId))));
    } catch (error) {
      errors.push(`batch ${Math.floor(index / 6) + 1}: ${error.message}`);
      assessments.push(...batch.map(heuristicAssessment));
    }
  }
  return {
    assessments,
    degraded: errors.length > 0,
    reason: errors.join('; ')
  };
};
