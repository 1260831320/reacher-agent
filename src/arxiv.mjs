const decodeXml = (value = '') => value
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&apos;', "'")
  .replaceAll('&amp;', '&');

const cleanText = (value = '') => decodeXml(value.replace(/<[^>]+>/g, ' '))
  .replace(/\s+/g, ' ')
  .trim();

const firstTag = (xml, tag) => {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? cleanText(match[1]) : '';
};

const allTags = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi'))]
  .map((match) => cleanText(match[1]));

const attr = (fragment, name) => {
  const match = fragment.match(new RegExp(`${name}=["']([^"']+)["']`, 'i'));
  return match ? decodeXml(match[1]) : '';
};

export const parseArxivFeed = (xml) => {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((match) => match[1]);
  return entries.map((entry) => {
    const canonicalUrl = firstTag(entry, 'id');
    const links = [...entry.matchAll(/<link\s+([^>]*?)\/?\s*>/gi)].map((match) => match[1]);
    const alternate = links.find((link) => attr(link, 'rel') === 'alternate');
    const pdf = links.find((link) => attr(link, 'title') === 'pdf' || attr(link, 'type') === 'application/pdf');
    const categories = [...entry.matchAll(/<category\s+([^>]*?)\/?\s*>/gi)].map((match) => attr(match[1], 'term')).filter(Boolean);
    return {
      arxivId: canonicalUrl.split('/').pop()?.replace(/v\d+$/, '') || canonicalUrl,
      title: firstTag(entry, 'title'),
      abstract: firstTag(entry, 'summary'),
      authors: allTags(entry, 'name'),
      published: firstTag(entry, 'published'),
      updated: firstTag(entry, 'updated'),
      categories,
      url: alternate ? attr(alternate, 'href') : canonicalUrl,
      pdfUrl: pdf ? attr(pdf, 'href') : `${canonicalUrl.replace('/abs/', '/pdf/')}.pdf`
    };
  });
};

// arXiv answers a submittedDate-descending query with a *relevance*-ordered
// page when its search backend is degraded. The HTTP status stays 200, so the
// only way to notice is to check the ordering we asked for. Callers use this
// to refuse a payload that silently lost its sort.
export const describeFeedIntegrity = (papers) => {
  const times = papers
    .map((paper) => new Date(paper.published).getTime())
    .filter((time) => Number.isFinite(time));
  const sortedDescending = times.every((time, index) => index === 0 || times[index - 1] >= time);
  return {
    count: papers.length,
    datedCount: times.length,
    undatedCount: papers.length - times.length,
    sortedDescending,
    newestPublished: times.length ? new Date(Math.max(...times)).toISOString() : '',
    oldestPublished: times.length ? new Date(Math.min(...times)).toISOString() : ''
  };
};

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const fetchArxivPapers = async ({ maxResults, signal, attempts = 3, retryBaseMs = 4_000 }) => {
  const params = new URLSearchParams({
    search_query: '(cat:cs.AI OR cat:cs.CL OR cat:cs.IR OR cat:cs.LG)',
    start: '0',
    max_results: String(maxResults),
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryable = true;
    try {
      const response = await fetch(`https://export.arxiv.org/api/query?${params}`, {
        signal,
        headers: {
          'User-Agent': 'personal-ai-research-agent/0.1 (daily academic digest)'
        }
      });
      if (response.ok) return parseArxivFeed(await response.text());
      retryable = RETRYABLE_STATUS.has(response.status);
      lastError = new Error(`arXiv request failed: HTTP ${response.status}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
    if (!retryable) break;
    if (attempt < attempts) await sleep(retryBaseMs * attempt);
  }
  throw lastError;
};

