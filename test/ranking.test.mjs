import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicAssessment, prioritizeDailyPapers } from '../src/ranking.mjs';

const paper = (arxivId, totalScore, priorityScore, ragReuseScore, studyValueScore) => ({
  arxivId,
  totalScore,
  priorityScore,
  ragReuseScore,
  studyValueScore,
  lexicalScore: 10
});

test('promotes the best reuse-and-study paper to position one with at most one Top N replacement', () => {
  const result = prioritizeDailyPapers([
    paper('quality-1', 9.8, 7.0, 7, 7),
    paper('quality-2', 9.6, 7.1, 7, 7.25),
    paper('quality-3', 9.4, 7.2, 7, 7.5),
    paper('quality-4', 9.2, 7.3, 7, 7.75),
    paper('quality-5', 9.0, 7.4, 7, 8),
    paper('priority', 8.9, 9.6, 10, 9)
  ], 5);

  assert.deepEqual(result.map(({ arxivId }) => arxivId), [
    'priority', 'quality-1', 'quality-2', 'quality-3', 'quality-4'
  ]);
  assert.equal(result[0].isPriorityPick, true);
  assert.ok(result.slice(1).every(({ isPriorityPick }) => isPriorityPick === false));
});

test('moves an existing quality pick to position one without changing the remaining order', () => {
  const result = prioritizeDailyPapers([
    paper('quality-1', 9.8, 7.0, 7, 7),
    paper('priority', 9.6, 9.5, 10, 8.75),
    paper('quality-3', 9.4, 7.2, 7, 7.5)
  ], 3);

  assert.deepEqual(result.map(({ arxivId }) => arxivId), ['priority', 'quality-1', 'quality-3']);
});

test('heuristic fallback exports the priority dimensions', () => {
  const assessment = heuristicAssessment({
    arxivId: 'fallback',
    title: 'Reliable RAG Retrieval',
    abstract: 'A retrieval augmented generation evaluation.',
    lexicalScore: 12,
    lexicalTopics: ['RAG', 'Retrieval', 'Evaluation']
  });

  assert.ok(Number.isFinite(assessment.ragReuseScore));
  assert.ok(Number.isFinite(assessment.studyValueScore));
  assert.ok(Number.isFinite(assessment.priorityScore));
  assert.ok(assessment.directReusePoints.length > 0);
});
