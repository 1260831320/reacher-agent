const tokens = (value = '') => new Set(String(value).toLowerCase().match(/[a-z0-9]{3,}/g) || []);

const similarity = (left, right) => {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(a.size, b.size);
};

export const findExplicitGithubUrl = (paper) => {
  const match = `${paper.title}\n${paper.abstract}`.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i);
  return match?.[0]?.replace(/[),.;]+$/, '') || '';
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestJson = async (url, { signal, token }) => {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'personal-ai-research-agent/0.2'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, { signal, headers });
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3) throw new Error(`GitHub request failed: HTTP ${response.status}`);
    await sleep(attempt * 750);
  }
  throw new Error('GitHub request failed after retries');
};

const repoSignal = (repo, confidence, discovery) => ({
  githubUrl: repo.html_url,
  githubFullName: repo.full_name,
  githubStars: Number(repo.stargazers_count || 0),
  githubForks: Number(repo.forks_count || 0),
  githubOpenIssues: Number(repo.open_issues_count || 0),
  githubPushedAt: repo.pushed_at || '',
  githubConfidence: Math.round(confidence * 100) / 100,
  githubDiscovery: discovery
});

export const discoverGithubRepository = async (paper, { signal, token = '' }) => {
  const explicit = findExplicitGithubUrl(paper);
  if (explicit) {
    const path = new URL(explicit).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    if (path) {
      try {
        const repo = await requestJson(`https://api.github.com/repos/${path}`, { signal, token });
        return repoSignal(repo, 1, 'abstract-url');
      } catch {
        return { githubUrl: explicit, githubConfidence: 0.8, githubDiscovery: 'abstract-url-unverified' };
      }
    }
  }

  const query = new URLSearchParams({ q: `\"${paper.title}\" in:name,description`, per_page: '3' });
  const body = await requestJson(`https://api.github.com/search/repositories?${query}`, { signal, token });
  const candidates = (body.items || []).map((repo) => ({
    repo,
    confidence: Math.max(
      similarity(paper.title, repo.name),
      similarity(paper.title, repo.description || ''),
      String(repo.description || '').includes(paper.arxivId) ? 0.95 : 0
    )
  })).sort((a, b) => b.confidence - a.confidence);
  if (!candidates[0] || candidates[0].confidence < 0.45) return {};
  return repoSignal(candidates[0].repo, candidates[0].confidence, 'title-search');
};

export const enrichWithGithub = async (papers, options) => {
  const results = [];
  const errors = [];
  for (const paper of papers) {
    try {
      results.push({ ...paper, ...await discoverGithubRepository(paper, options) });
    } catch (error) {
      errors.push(`${paper.arxivId}: ${error.message}`);
      results.push(paper);
    }
  }
  return { papers: results, errors };
};
