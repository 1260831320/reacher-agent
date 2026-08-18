import { loadConfig } from './config.mjs';
import { runCollector } from './collector.mjs';

try {
  const result = await runCollector(loadConfig());
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

