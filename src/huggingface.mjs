const normalizeId = (value = '') => String(value)
  .replace(/^https?:\/\/arxiv\.org\/(?:abs|pdf)\//, '')
  .replace(/\.pdf$/, '')
  .replace(/v\d+$/, '')
  .trim();

const asNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

export const normalizeDailyPapers = (payload) => {
  const entries = Array.isArray(payload) ? payload : payload?.papers || payload?.items || [];
  return entries.map((entry, index) => {
    const paper = entry?.paper || entry;
    const arxivId = normalizeId(paper?.id || paper?.arxivId || paper?.paperId || '');
    if (!arxivId) return null;
    return {
      arxivId,
      hfTrendingRank: index + 1,
      hfUpvotes: asNumber(entry?.upvotes ?? paper?.upvotes ?? entry?.numUpvotes),
      hfComments: asNumber(entry?.numComments ?? paper?.numComments),
      hfPublishedAt: paper?.publishedAt || paper?.submittedOnDailyAt || entry?.publishedAt || '',
      hfUrl: `https://huggingface.co/papers/${arxivId}`
    };
  }).filter(Boolean);
};

export const fetchHuggingFaceDailyPapers = async ({ signal, token = '' }) => {
  const headers = { 'User-Agent': 'personal-ai-research-agent/0.2' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch('https://huggingface.co/api/daily_papers?limit=100', { headers, signal });
  if (!response.ok) throw new Error(`Hugging Face request failed: HTTP ${response.status}`);
  return normalizeDailyPapers(await response.json());
};

export const enrichWithHuggingFace = (papers, dailyPapers) => {
  const byId = new Map(dailyPapers.map((paper) => [paper.arxivId, paper]));
  return papers.map((paper) => ({ ...paper, ...(byId.get(paper.arxivId) || {}) }));
};
