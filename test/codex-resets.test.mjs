import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildResetMessage, resetTargets, retryAfterMs, runResetCycle, validateResetPage } from '../src/codex-resets.mjs';
import { createResetStore, deliveryUuid } from '../src/reset-store.mjs';
import { sendFeishuText } from '../src/feishu.mjs';

const event = (id, type = 'regular', overrides = {}) => ({
  id, reset_type: type, announced_at: '2026-10-09T00:30:00Z', text: 'Reset has landed.',
  source: { type: 'x_post', author: 'thsottiaux', url: `https://x.com/thsottiaux/status/${id}` }, ...overrides
});
const page = (events, more = false, cursor = null, etag = 'v1') => new Response(JSON.stringify({
  data: events, pagination: { has_more: more, next_cursor: cursor }
}), { headers: { etag } });
const config = {
  databaseUrl: process.env.RESET_TEST_DATABASE_URL || 'postgresql://localhost/reset_monitor_test', feishuEnabled: true,
  feishuAppId: 'app-test', feishuAppSecret: 'test-only',
  feishuRecipientChatId: 'oc_group', feishuRecipientOpenId: 'ou_user',
  codexResetsPollMs: 300000, codexResetsJitterMs: 60000, codexResetsTimeoutMs: 1000
};

test('full and banked messages have GMT+8 time, source credit and distinct target UUIDs', () => {
  const full = event('1');
  assert.match(buildResetMessage(full), /Full reset/);
  assert.match(buildResetMessage(full), /08:30:00 GMT\+8/);
  assert.match(buildResetMessage(event('1', 'banked')), /储备重置额度/);
  assert.match(buildResetMessage(full), /https:\/\/codex-resets.com/);
  const [group, user] = resetTargets(config);
  assert.notEqual(deliveryUuid(full, group), deliveryUuid(full, user));
  assert.notEqual(deliveryUuid(full, group), deliveryUuid(event('1', 'banked'), group));
  assert.throws(() => resetTargets({ ...config, feishuRecipientOpenId: '' }));
});

test('forecast/scheduled records do not trigger; invalid events and cursors fail closed', () => {
  const envelope = (data, pagination = { has_more: false, next_cursor: null }) => ({ data, pagination });
  assert.equal(validateResetPage(envelope([event('1', 'regular', { status: 'scheduled' })])).events.length, 0);
  assert.throws(() => validateResetPage(envelope([event('1', 'forecast')])));
  assert.throws(() => validateResetPage(envelope([event('1', 'regular', { announced_at: 'bad' })])));
  assert.throws(() => validateResetPage(envelope([], { has_more: true, next_cursor: '../bad' })));
  assert.equal(retryAfterMs('120', 0), 120000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120000);
});

test('daily schedule starts at 08:30 in Asia/Shanghai', async () => {
  const workflow = JSON.parse(await readFile(new URL('../n8n/daily-ai-research.json', import.meta.url)));
  assert.equal(workflow.settings.timezone, 'Asia/Shanghai');
  assert.equal(workflow.nodes.find((n) => n.type.includes('scheduleTrigger')).parameters.rule.interval[0].expression, '0 30 8 * * *');
});

test('Feishu sender submits the persisted UUID and distinguishes known from uncertain failures', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(url.includes('/auth/')
      ? { code: 0, tenant_access_token: 'test-token' } : { code: 0, data: { message_id: 'om_test' } }));
  });
  const target = resetTargets(config)[0];
  const uuid = deliveryUuid(event('1'), target);
  assert.equal(await sendFeishuText('test', config, target, undefined, uuid), 'om_test');
  assert.equal(calls[1].body.uuid, uuid);
  assert.equal(calls[1].body.receive_id, 'oc_group');
  globalThis.fetch.mock.mockImplementation(async (url) => {
    if (url.includes('/auth/')) return new Response(JSON.stringify({ code: 0, tenant_access_token: 'test-token' }));
    throw new Error('connection lost');
  });
  await assert.rejects(sendFeishuText('test', config, target, undefined, uuid), (error) => error.deliveryUncertain === true);
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error('token connection lost'); });
  await assert.rejects(sendFeishuText('test', config, target, undefined, uuid), (error) => error.deliveryUncertain === false);
});

test('PostgreSQL monitor integration: baseline, fanout, locks, restart, retries and pagination',
  { skip: !process.env.RESET_TEST_DATABASE_URL }, async (t) => {
    const url = new URL(config.databaseUrl);
    assert.equal(url.pathname, '/reset_monitor_test', 'integration test only uses the dedicated test database');
    const db = new pg.Pool({ connectionString: config.databaseUrl });
    const store = createResetStore(config);
    t.after(async () => { await store.close(); await db.end(); });
    await db.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    const clear = async () => db.query('TRUNCATE research_codex_deliveries, research_codex_events, research_codex_monitor');
    const due = async () => db.query("UPDATE research_codex_monitor SET next_poll_at = NOW() - interval '1 second'");
    const sent = [];
    const send = async (text, cfg, target, signal, uuid) => { sent.push({ text, target, uuid }); return `om_${sent.length}`; };
    const cycle = (fetchImpl, sender = send) => runResetCycle({ config, store, fetchImpl, send: sender, random: () => 0 });

    await t.test('baseline persists every page without any notification', async () => {
      await clear();
      await cycle(async (url) => url.includes('cursor=') ? page([event('old2', 'banked')]) : page([event('old1')], true, 'next'));
      assert.equal(sent.length, 0);
      assert.equal((await store.summary()).events.baseline, 2);
    });
    await t.test('both types fan out to both targets; repeated IDs and restart do not resend', async () => {
      await due();
      await cycle(async () => page([event('new'), event('new', 'banked'), event('old1')], false, null, 'v2'));
      assert.equal(sent.length, 4);
      assert.equal(new Set(sent.map((s) => s.uuid)).size, 4);
      const restarted = createResetStore(config);
      try {
        await due();
        await runResetCycle({ config, store: restarted, fetchImpl: async () => page([event('new'), event('new', 'banked')]), send, random: () => 0 });
        assert.equal(sent.length, 4);
      } finally { await restarted.close(); }
    });
    await t.test('304 uses persisted ETag and same shared schedule prevents extra requests', async () => {
      await due();
      let polls = 0;
      await cycle(async (url, opts) => { polls += 1; assert.equal(opts.headers['If-None-Match'], 'v1'); return new Response(null, { status: 304 }); });
      await cycle(async () => { polls += 1; throw new Error('should not poll'); });
      assert.equal(polls, 1);
      assert.equal(sent.length, 4);
    });
    await t.test('concurrent instances allow one request and one pair of deliveries', async () => {
      await due();
      let release;
      const blocked = new Promise((resolve) => { release = resolve; });
      let entered;
      const entering = new Promise((resolve) => { entered = resolve; });
      const first = cycle(async () => { entered(); await blocked; return page([event('concurrent')]); });
      await entering;
      const competing = createResetStore(config);
      try {
        const result = await runResetCycle({ config, store: competing, fetchImpl: async () => { throw new Error('double poll'); }, send });
        assert.equal(result.status, 'busy');
      } finally { release(); await first; await competing.close(); }
      assert.equal(sent.length, 6);
    });
    await t.test('only failed private route retries; retries proceed during source backoff', async () => {
      await due();
      await cycle(async () => page([event('retry')]), async (...args) => {
        if (args[2].type === 'open_id') throw new Error('known rejection');
        return send(...args);
      });
      const before = sent.length;
      await db.query("UPDATE research_codex_deliveries SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'pending'");
      await due();
      await cycle(async () => new Response(null, { status: 429, headers: { 'retry-after': '7200' } }));
      const state = (await store.summary()).monitor;
      assert.ok(state.next_poll_at.getTime() - Date.now() > 7100000);
      assert.equal(sent.length, before + 1);
      assert.equal(sent.at(-1).target.type, 'open_id');
      assert.equal((await store.summary()).deliveries.pending, undefined);
    });
    await t.test('a later page failure does not advance ETag or partially enqueue events', async () => {
      await due();
      const before = await store.summary();
      await cycle(async (url) => url.includes('cursor=') ? new Response(null, { status: 503 })
        : page([event('partial')], true, 'next', 'changed'));
      const after = await store.summary();
      assert.equal(after.events.total, before.events.total);
      assert.equal(after.monitor.etag, before.monitor.etag);
    });
    await t.test('late executed event on an older history page is not missed', async () => {
      await due();
      const before = sent.length;
      await cycle(async (url) => url.includes('cursor=') ? page([event('late', 'banked', { announced_at: '2026-09-01T00:00:00Z' })])
        : page([event('new')], true, 'next'));
      assert.equal(sent.length, before + 2);
    });
    await t.test('unknown send outcomes reuse UUID within one hour; expired outcomes stop retrying', async () => {
      await due();
      const uuidByTarget = new Map();
      await cycle(async () => page([event('ambiguous')]), async (text, cfg, target, signal, uuid) => {
        uuidByTarget.set(target.type, uuid);
        const error = new Error('lost acknowledgement'); error.deliveryUncertain = true; throw error;
      });
      await db.query("UPDATE research_codex_deliveries SET next_attempt_at = NOW() - interval '1 second' WHERE status = 'sending'");
      await cycle(async () => { throw new Error('unexpected source poll'); }, async (...args) => {
        assert.equal(args[4], uuidByTarget.get(args[2].type)); return send(...args);
      });
      assert.equal((await store.summary()).deliveries.sending, undefined);
      // Model a process crash after the request was sent but before recording its outcome.
      await db.query("UPDATE research_codex_deliveries SET status = 'sending', first_attempt_at = NOW() - interval '55 minutes', next_attempt_at = NOW() - interval '1 second' WHERE event_id = 'ambiguous'");
      const before = sent.length;
      await cycle(async () => { throw new Error('unexpected source poll'); });
      assert.equal(sent.length, before);
      assert.equal((await store.summary()).deliveries.uncertain, 2);
    });
  });
