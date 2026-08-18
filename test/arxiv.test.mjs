import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseArxivFeed } from '../src/arxiv.mjs';
import { shortlistPapers } from '../src/ranking.mjs';

test('parses arXiv Atom entries and normalizes versioned ids', async () => {
  const xml = await readFile(new URL('./fixtures/arxiv.xml', import.meta.url), 'utf8');
  const papers = parseArxivFeed(xml);
  assert.equal(papers.length, 1);
  assert.equal(papers[0].arxivId, '2608.00001');
  assert.deepEqual(papers[0].authors, ['Alice Example', 'Bob Example']);
  assert.deepEqual(papers[0].categories, ['cs.AI', 'cs.IR']);
  assert.equal(papers[0].pdfUrl, 'https://arxiv.org/pdf/2608.00001');
});

test('shortlists papers relevant to RAG and Agent engineering', async () => {
  const xml = await readFile(new URL('./fixtures/arxiv.xml', import.meta.url), 'utf8');
  const shortlisted = shortlistPapers(parseArxivFeed(xml), 5);
  assert.equal(shortlisted.length, 1);
  assert.ok(shortlisted[0].lexicalScore >= 10);
  assert.ok(shortlisted[0].lexicalTopics.includes('RAG'));
  assert.ok(shortlisted[0].lexicalTopics.includes('Agent'));
});

