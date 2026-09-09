import assert from 'node:assert/strict';
import test from 'node:test';
import { describeFeedIntegrity } from '../src/arxiv.mjs';
import { deliverReport } from '../src/delivery.mjs';
import { buildEmptyAlert, describeEmptyStage, EmptyDigestError } from '../src/gate.mjs';
import { sendFeishuDigest } from '../src/feishu.mjs';
import { buildMarkdownReport } from '../src/report.mjs';

const counts = (overrides) => ({ source: 100, recent: 100, shortlist: 12, ranked: 8, selected: 5, ...overrides });
const gateOptions = { lookbackDays: 4 };

test('a healthy run is not gated', () => {
  assert.equal(describeEmptyStage(counts(), gateOptions), null);
});

test('names the first stage that emptied out', () => {
  assert.equal(
    describeEmptyStage(counts({ source: 0, recent: 0, shortlist: 0, ranked: 0, selected: 0 }), gateOptions).stage,
    'source'
  );
  assert.equal(
    describeEmptyStage(counts({ recent: 0, shortlist: 0, ranked: 0, selected: 0 }), gateOptions).stage,
    'recency'
  );
  assert.equal(
    describeEmptyStage(counts({ shortlist: 0, ranked: 0, selected: 0 }), gateOptions).stage,
    'topic-rules'
  );
  assert.equal(describeEmptyStage(counts({ ranked: 0, selected: 0 }), gateOptions).stage, 'ranking');
  assert.equal(describeEmptyStage(counts({ selected: 0 }), gateOptions).stage, 'selection');
});

test('reproduces the 2026-09-09 incident: 100 collected, none inside the window', () => {
  const gate = describeEmptyStage(counts({ recent: 0, shortlist: 0, ranked: 0, selected: 0 }), gateOptions);
  assert.equal(gate.stage, 'recency');
  assert.match(gate.reason, /100 篇/);
  assert.match(gate.reason, /最近 4 天/);
  const error = new EmptyDigestError(gate);
  assert.equal(error.name, 'EmptyDigestError');
  assert.equal(error.finalized, true, 'must stop the generic handler overwriting run metadata');
});

test('detects an arXiv page that lost its submittedDate sort', () => {
  const descending = describeFeedIntegrity([
    { published: '2026-09-08T10:00:00Z' },
    { published: '2026-09-07T10:00:00Z' }
  ]);
  assert.equal(descending.sortedDescending, true);
  assert.equal(descending.newestPublished, '2026-09-08T10:00:00.000Z');

  const scrambled = describeFeedIntegrity([
    { published: '2026-09-01T10:00:00Z' },
    { published: '2026-09-08T10:00:00Z' }
  ]);
  assert.equal(scrambled.sortedDescending, false);
  assert.equal(scrambled.datedCount, 2);

  const undated = describeFeedIntegrity([{ published: '' }, { published: 'not-a-date' }]);
  assert.equal(undated.undatedCount, 2);
  assert.equal(undated.newestPublished, '');
});

test('deliverReport blocks a zero-paper digest and never reports it as delivered', async () => {
  const config = {
    feishuEnabled: true,
    feishuAppId: 'app',
    feishuAppSecret: 'secret',
    feishuRecipientChatId: 'oc_test',
    feishuRecipientOpenId: '',
    databaseUrl: ''
  };
  const delivery = await deliverReport({ date: '2026-09-09', runId: 1, papers: [] }, config, AbortSignal.timeout(1_000));
  assert.equal(delivery.status, 'blocked-empty');
  assert.notEqual(delivery.status, 'delivered');
  assert.equal(delivery.attempts, 0);
});

test('sendFeishuDigest refuses an empty digest before any network call', async () => {
  const config = {
    feishuEnabled: true,
    feishuAppId: 'app',
    feishuAppSecret: 'secret',
    feishuRecipientChatId: 'oc_test',
    feishuRecipientOpenId: ''
  };
  const result = await sendFeishuDigest({ date: '2026-09-09', papers: [] }, config, AbortSignal.timeout(1_000));
  assert.equal(result.status, 'blocked-empty');
});

test('the empty markdown report states it was blocked instead of reading as a quiet day', () => {
  const gate = describeEmptyStage(counts({ recent: 0, shortlist: 0, ranked: 0, selected: 0 }), gateOptions);
  const markdown = buildMarkdownReport({
    date: '2026-09-09',
    generatedAt: '2026-09-08T19:30:00.000Z',
    papers: [],
    sourceCount: 100,
    recentCount: 0,
    shortlistCount: 0,
    model: 'qwen3.7-max',
    emptyGate: gate,
    pipelineCounts: counts({ recent: 0, shortlist: 0, ranked: 0, selected: 0 })
  });
  assert.match(markdown, /未推送日报/);
  assert.match(markdown, /recency/);
  assert.doesNotMatch(markdown, /没有符合当前主题规则的论文。$/);
});

test('the alert names the stage and the pipeline counts', () => {
  const gate = describeEmptyStage(counts({ recent: 0, shortlist: 0, ranked: 0, selected: 0 }), gateOptions);
  const alert = buildEmptyAlert({
    date: '2026-09-09',
    gate,
    counts: counts({ recent: 0, shortlist: 0, ranked: 0, selected: 0 }),
    model: 'qwen3.7-max'
  });
  assert.match(alert, /生成失败/);
  assert.match(alert, /recency/);
  assert.match(alert, /采集 100 → 窗口内 0/);
});
