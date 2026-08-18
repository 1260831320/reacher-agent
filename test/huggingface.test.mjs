import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichWithHuggingFace, normalizeDailyPapers } from '../src/huggingface.mjs';

test('normalizes and joins Hugging Face daily paper signals by arXiv id', () => {
  const daily = normalizeDailyPapers([{ paper: { id: '2608.01234v2' }, upvotes: 42, numComments: 3 }]);
  assert.equal(daily[0].arxivId, '2608.01234');
  assert.equal(daily[0].hfUpvotes, 42);
  const enriched = enrichWithHuggingFace([{ arxivId: '2608.01234', title: 'A' }], daily);
  assert.equal(enriched[0].hfTrendingRank, 1);
});
