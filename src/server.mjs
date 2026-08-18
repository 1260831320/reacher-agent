import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { checkDatabase, initializeDatabase } from './database.mjs';
import { deliverReport } from './delivery.mjs';
import { runCollector } from './collector.mjs';

const config = loadConfig();
let activeRun = null;

await initializeDatabase(config);

const json = (response, status, body) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body)}\n`);
};

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    const database = await checkDatabase(config);
    return json(response, database.ok ? 200 : 503, {
      ok: database.ok,
      running: Boolean(activeRun),
      model: config.bailianModel,
      database
    });
  }
  if (request.method === 'POST' && request.url === '/run') {
    if (activeRun) return json(response, 409, { ok: false, error: 'A research run is already in progress' });
    activeRun = runCollector(config);
    try {
      return json(response, 200, await activeRun);
    } catch (error) {
      return json(response, 500, { ok: false, error: error.message });
    } finally {
      activeRun = null;
    }
  }
  if (request.method === 'POST' && request.url === '/deliver/latest') {
    try {
      const lastRun = JSON.parse(await readFile(path.join(config.dataDir, 'last-run.json'), 'utf8'));
      const report = JSON.parse(await readFile(path.join(config.reportsDir, `${lastRun.date}.json`), 'utf8'));
      const delivery = await deliverReport(report, config, AbortSignal.timeout(30_000));
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
