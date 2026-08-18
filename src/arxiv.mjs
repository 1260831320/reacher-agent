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

export const fetchArxivPapers = async ({ maxResults, signal }) => {
  const params = new URLSearchParams({
    search_query: '(cat:cs.AI OR cat:cs.CL OR cat:cs.IR OR cat:cs.LG)',
    start: '0',
    max_results: String(maxResults),
    sortBy: 'submittedDate',
    sortOrder: 'descending'
  });
  const response = await fetch(`https://export.arxiv.org/api/query?${params}`, {
    signal,
    headers: {
      'User-Agent': 'personal-ai-research-agent/0.1 (daily academic digest)'
    }
  });
  if (!response.ok) throw new Error(`arXiv request failed: HTTP ${response.status}`);
  return parseArxivFeed(await response.text());
};

