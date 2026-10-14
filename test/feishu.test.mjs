import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeishuDigest, resolveFeishuTarget, sendFeishuAlert, sendFeishuDigest } from '../src/feishu.mjs';

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

const config = {
  feishuEnabled: true, alertOnEmpty: true,
  feishuAppId: 'test-app', feishuAppSecret: 'test-secret',
  feishuRecipientChatId: 'oc_group', feishuRecipientOpenId: 'ou_owner'
};

test('empty-digest errors go privately while a normal digest still goes to the group', async (t) => {
  const sends = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/auth/')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'test-token' }) };
    }
    sends.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ code: 0, data: { message_id: `om_test_${sends.length}` } }) };
  });
  const alert = await sendFeishuAlert('Research failed: recency', config, AbortSignal.timeout(1_000));
  assert.equal(alert.status, 'sent');
  assert.equal(alert.targetType, 'open_id');
  assert.match(sends[0].url, /receive_id_type=open_id$/);
  assert.equal(sends[0].body.receive_id, 'ou_owner');

  const digest = await sendFeishuDigest({ date: '2026-10-14', model: 'test-model', papers: [{
    title: 'Test paper', totalScore: 9, tags: [], oneSentence: 'Summary', whyImportant: 'Value', url: 'https://example.test/paper'
  }] }, config, AbortSignal.timeout(1_000));
  assert.equal(digest.status, 'delivered');
  assert.match(sends[1].url, /receive_id_type=chat_id$/);
  assert.equal(sends[1].body.receive_id, 'oc_group');
});

test('missing private recipient does not send an error to the configured group', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  const alert = await sendFeishuAlert('Research failed', { ...config, feishuRecipientOpenId: '' }, AbortSignal.timeout(1_000));
  assert.equal(alert.status, 'misconfigured');
  assert.equal(alert.targetType, 'open_id');
  assert.equal(fetch.mock.callCount(), 0);
});

test('failed private error delivery does not fall back to the configured group', async (t) => {
  const sends = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/auth/')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'test-token' }) };
    }
    sends.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: false, status: 400, json: async () => ({ code: 123, msg: 'Private delivery rejected' }) };
  });
  const alert = await sendFeishuAlert('Research failed', config, AbortSignal.timeout(1_000));
  assert.equal(alert.status, 'failed');
  assert.equal(sends.length, 1);
  assert.match(sends[0].url, /receive_id_type=open_id$/);
  assert.equal(sends[0].body.receive_id, 'ou_owner');
});

test('muted error alerts make no network requests', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network request'); });
  for (const overrides of [{ alertOnEmpty: false }, { feishuEnabled: false }]) {
    const alert = await sendFeishuAlert('Research failed', { ...config, ...overrides }, AbortSignal.timeout(1_000));
    assert.equal(alert.status, 'disabled');
  }
  assert.equal(fetch.mock.callCount(), 0);
});
