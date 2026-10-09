import { createResetStore, eventKey } from './reset-store.mjs';
import { sendFeishuText } from './feishu.mjs';

const API_URL = 'https://codex-resets.com/api/v1/resets?limit=100';

export const resetTargets = (config) => {
  if (!config.databaseUrl || !config.feishuEnabled || !config.feishuAppId || !config.feishuAppSecret
    || !/^oc_[\w]+$/.test(config.feishuRecipientChatId) || !/^ou_[\w]+$/.test(config.feishuRecipientOpenId)) {
    throw new Error('Codex reset monitoring requires a database, Feishu credentials, a group chat_id and a personal open_id');
  }
  return [
    { type: 'chat_id', id: config.feishuRecipientChatId },
    { type: 'open_id', id: config.feishuRecipientOpenId }
  ];
};

export const validateResetPage = (body) => {
  if (!Array.isArray(body.data) || typeof body.pagination?.has_more !== 'boolean') {
    throw new Error('Invalid Codex Resets response envelope');
  }
  const events = body.data.filter((event) => event.status !== 'scheduled');
  for (const event of events) {
    if (typeof event.id !== 'string' || !event.id || event.id.length > 64
      || !['regular', 'banked'].includes(event.reset_type) || !Number.isFinite(Date.parse(event.announced_at))
      || typeof event.text !== 'string' || !['x_post', 'observed'].includes(event.source?.type)
      || (event.status !== undefined && event.status !== 'executed')) {
      throw new Error('Invalid executed Codex reset event');
    }
    if (event.source.url && !/^https:\/\//.test(event.source.url)) throw new Error('Invalid Codex reset source URL');
  }
  if (body.pagination.has_more && (typeof body.pagination.next_cursor !== 'string'
    || !/^[A-Za-z0-9_-]{1,1024}$/.test(body.pagination.next_cursor))) {
    throw new Error('Invalid Codex Resets pagination cursor');
  }
  return { events, pagination: body.pagination };
};

export const buildResetMessage = (event) => {
  const banked = event.reset_type === 'banked';
  const time = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium'
  }).format(new Date(event.announced_at));
  return [
    `🔔 Codex 重置提醒｜${banked ? 'Banked reset' : 'Full reset'}`,
    banked ? '社区记录显示已发放储备重置额度，可按需使用。' : '社区记录显示已执行用量重置。',
    `公告／首次观察时间：${time} GMT+8`,
    '', '原始公告：', event.text.slice(0, 2000), '',
    event.source.url ? `原始来源：${event.source.url}` : '原始来源：社区观察记录（未附 X 公告）',
    '数据来源：Codex Resets https://codex-resets.com',
    '实际到账情况请以你的 Codex 账号为准。'
  ].join('\n');
};

export const retryAfterMs = (value, now) => {
  if (!value) return 0;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(value) - now) || 0;
};

export const runResetCycle = async ({ config, store, fetchImpl = fetch, send = sendFeishuText,
  nowMs = Date.now, random = Math.random, signal }) => {
  const targets = resetTargets(config);
  return store.withLock(async (session) => {
    const state = await session.state();
    const now = nowMs();
    const pollDue = new Date(state.next_poll_at).getTime() <= now;
    let delayMs = pollDue ? config.codexResetsPollMs + Math.floor(random() * config.codexResetsJitterMs)
      : new Date(state.next_poll_at).getTime() - now;
    let pollError;
    let discovered = 0;
    if (pollDue) try {
      let url = API_URL;
      let etag = '';
      const events = [];
      const visited = new Set();
      for (let page = 0; page < 10; page += 1) {
        if (visited.has(url)) throw new Error('Repeated Codex Resets pagination cursor');
        visited.add(url);
        const response = await fetchImpl(url, {
          headers: { Accept: 'application/json', ...(page === 0 && state.initialized_at && state.etag
            ? { 'If-None-Match': state.etag } : {}) },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.codexResetsTimeoutMs)])
            : AbortSignal.timeout(config.codexResetsTimeoutMs)
        });
        if (response.status === 304 && page === 0 && state.initialized_at) {
          etag = state.etag;
          break;
        }
        if (!response.ok) {
          const error = new Error(`Codex Resets API HTTP ${response.status}`);
          error.retryAfterMs = retryAfterMs(response.headers.get('retry-after'), now);
          throw error;
        }
        const text = await response.text();
        if (text.length > 2_000_000) throw new Error('Codex Resets page exceeds size limit');
        const parsed = validateResetPage(JSON.parse(text));
        if (page === 0) etag = response.headers.get('etag') || '';
        events.push(...parsed.events);
        // Read every page on a changed response: a scheduled reset may only
        // become executed later while keeping an older announcement timestamp.
        // Commit the ETag only after the complete snapshot has been ingested.
        if (!parsed.pagination.has_more) break;
        if (page === 9) throw new Error('Codex Resets history exceeded the 10-page safety limit');
        url = `${API_URL}&cursor=${encodeURIComponent(parsed.pagination.next_cursor)}`;
      }
      const unique = [...new Map(events.map((event) => [eventKey(event), event])).values()]
        .sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at));
      discovered = unique.length;
      await session.ingest(unique, targets, !state.initialized_at, etag, new Date(now), new Date(now + delayMs));
    } catch (error) {
      if (signal?.aborted) throw error;
      pollError = error.message;
      delayMs = Math.max(error.retryAfterMs || 0,
        Math.min(3_600_000, config.codexResetsPollMs * 2 ** Math.min(state.failures + 1, 8)))
        + Math.floor(random() * config.codexResetsJitterMs);
      await session.pollFailed(error, new Date(now + delayMs));
    }
    // A source outage must not prevent retrying an already discovered event.
    const deliveries = await session.dueDeliveries(new Date(nowMs()));
    let delivered = 0;
    for (const delivery of deliveries) {
      if (signal?.aborted) break;
      await session.attempt(delivery, new Date(nowMs()));
      let accepted = false;
      try {
        const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
        const messageId = await send(buildResetMessage(delivery.payload), config,
          { type: delivery.target_type, id: delivery.target_id }, requestSignal, delivery.uuid);
        accepted = true;
        await session.delivered(delivery, messageId, new Date(nowMs()));
        delivered += 1;
      } catch (error) {
        // Failure to persist an accepted send is also uncertain, even if the
        // thrown error came from PostgreSQL rather than the HTTP client.
        error.deliveryUncertain = accepted || error.deliveryUncertain === true;
        const backoff = Math.min(3_600_000, 60000 * 2 ** Math.min(delivery.attempts, 6));
        await session.deliveryFailed(delivery, error, new Date(nowMs() + backoff));
      }
    }
    delayMs = Math.min(delayMs, await session.nextDeliveryDelay(nowMs()));
    return { status: pollError ? 'degraded' : pollDue ? 'ok' : 'waiting', delayMs, discovered, delivered,
      ...(pollError ? { error: pollError } : {}) };
  });
};

export const startResetMonitor = (config, { isBusy = () => false, log = console.log } = {}) => {
  if (!config.codexResetsEnabled || config.dryRun) {
    return { snapshot: () => ({ enabled: false }), summary: async () => ({ enabled: false }), stop: async () => {} };
  }
  resetTargets(config);
  const store = createResetStore(config);
  const controller = new AbortController();
  let timer;
  let active;
  let snapshot = { enabled: true, status: 'starting' };
  const schedule = (delayMs) => { timer = setTimeout(tick, Math.max(1000, delayMs)); };
  const tick = () => {
    active = (async () => {
      if (isBusy()) {
        snapshot = { enabled: true, status: 'deferred-for-research' };
        schedule(60000 + Math.random() * config.codexResetsJitterMs);
        return;
      }
      try {
        const result = await runResetCycle({ config, store, signal: controller.signal });
        snapshot = { enabled: true, ...result, checkedAt: new Date().toISOString() };
        if (result.status === 'degraded' || result.delivered) log(`Codex reset monitor: ${JSON.stringify(result)}`);
        if (!controller.signal.aborted) schedule(result.delayMs);
      } catch (error) {
        snapshot = { enabled: true, status: 'failed', error: error.message };
        if (!controller.signal.aborted) {
          log(`Codex reset monitor failed: ${error.message}`);
          schedule(config.codexResetsPollMs + Math.random() * config.codexResetsJitterMs);
        }
      }
    })();
  };
  schedule(Math.random() * config.codexResetsJitterMs);
  return {
    snapshot: () => snapshot,
    summary: async () => ({ enabled: true, runtime: snapshot, ...await store.summary() }),
    async stop() {
      clearTimeout(timer);
      controller.abort();
      await active;
      await store.close();
    }
  };
};
