import test from 'node:test';
import assert from 'node:assert/strict';
import { findExplicitGithubUrl } from '../src/github.mjs';

test('extracts an explicit GitHub repository URL from the abstract', () => {
  const url = findExplicitGithubUrl({ title: 'Demo', abstract: 'Code: https://github.com/example/research-agent).' });
  assert.equal(url, 'https://github.com/example/research-agent');
});
