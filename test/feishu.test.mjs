import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuDigest, resolveFeishuTarget } from '../src/feishu.mjs';

test('builds a compact private Feishu digest', () => {
  const text = buildFeishuDigest({
    date: '2026-08-17',
    model: 'qwen3.8-max',
    trends: [{ tag: 'RAG', appearances: 2 }],
    papers: [{
      title: 'Reliable RAG', totalScore: 9.1, tags: ['RAG'], oneSentence: '摘要。',
      whyImportant: '重要。', url: 'https://arxiv.org/abs/1', githubUrl: ''
    }]
  });
  assert.match(text, /AI 论文日报/);
  assert.match(text, /Reliable RAG/);
  assert.match(text, /qwen3\.8-max/);
});

test('prefers a Feishu group chat over the private recipient', () => {
  assert.deepEqual(resolveFeishuTarget({
    feishuRecipientChatId: 'oc_group',
    feishuRecipientOpenId: 'ou_person'
  }), { id: 'oc_group', type: 'chat_id', channel: 'feishu-group' });
});
