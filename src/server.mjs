import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { checkDatabase, initializeDatabase } from './database.mjs';
import { deliverReport } from './delivery.mjs';
import { runCollector } from './collector.mjs';
import { startResetMonitor } from './codex-resets.mjs';

const config = loadConfig();
let activeRun = null;

await initializeDatabase(config);
const resetMonitor = startResetMonitor(config, { isBusy: () => Boolean(activeRun) });

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
};

// `force` replays a delivery for a date that already has one, used to correct
// a bad push. It never bypasses the empty-result gate.
const parseRequest = (url) => {
  const parsed = new URL(url, 'http://localhost');
  return { path: parsed.pathname, force: parsed.searchParams.get('force') === '1' };
};

const server = http.createServer(async (request, response) => {
  const { path: requestPath, force } = parseRequest(request.url);
  if (request.method === 'GET' && requestPath === '/health') {
    const database = await checkDatabase(config);
    return json(response, database.ok ? 200 : 503, {
      ok: database.ok,
      running: Boolean(activeRun),
      model: config.bailianModel,
      database,
      codexResets: resetMonitor.snapshot()
    });
  }
  if (request.method === 'GET' && requestPath === '/codex-resets/status') {
    try {
      return json(response, 200, await resetMonitor.summary());
    } catch (error) {
      return json(response, 503, { ok: false, error: error.message });
    }
  }
  if (request.method === 'POST' && requestPath === '/run') {
    if (activeRun) return json(response, 409, { ok: false, error: 'A research run is already in progress' });
    activeRun = runCollector(config, { force });
    try {
      return json(response, 200, await activeRun);
    } catch (error) {
      // A blocked empty digest must surface as a failed HTTP call so the n8n
      // execution turns red instead of quietly reporting success.
      return json(response, 500, {
        ok: false,
        error: error.message,
        ...(error.name === 'EmptyDigestError' ? { emptyGate: { stage: error.stage, reason: error.reason } } : {})
      });
    } finally {
      activeRun = null;
    }
  }
  if (request.method === 'POST' && requestPath === '/deliver/latest') {
    try {
      const lastRun = JSON.parse(await readFile(path.join(config.dataDir, 'last-run.json'), 'utf8'));
      const report = JSON.parse(await readFile(path.join(config.reportsDir, `${lastRun.date}.json`), 'utf8'));
      const delivery = await deliverReport(report, config, AbortSignal.timeout(30_000), { force });
      const ok = delivery.status === 'delivered' || delivery.status === 'skipped';
      return json(response, ok ? 200 : 502, { ok, date: report.date, delivery });
    } catch (error) {
      return json(response, 500, { ok: false, error: error.message });
    }
  }
  return json(response, 404, { ok: false, error: 'Not found' });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`AI Research Agent listening on port ${config.port}; model=${config.bailianModel}`);
});

for (const event of ['SIGTERM', 'SIGINT']) {
  process.once(event, async () => {
    server.close();
    await resetMonitor.stop();
    process.exit(0);
  });
}
