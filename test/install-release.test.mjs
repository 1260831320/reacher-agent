import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('a failed release restores the full private configuration and previous image tag', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'research-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  const previous = 'releases/previous-image';
  for (const dir of ['install/shared', `install/${previous}`, 'bin', 'empty']) {
    await mkdir(path.join(root, dir), { recursive: true });
  }
  await symlink(previous, path.join(install, 'current'));
  await writeFile(path.join(install, 'shared/last-good-release'), previous);
  const original = 'BAILIAN_API_KEY=private-test-only\nBAILIAN_MODEL=original-model\nFEISHU_RESEARCH_CHAT_ID=oc_original\n';
  await writeFile(path.join(install, 'shared/app.env'), original, { mode: 0o600 });
  const source = path.join(root, 'source.env');
  await writeFile(source, 'FEISHU_CUSTOM_APP_ID=test\nFEISHU_CUSTOM_APP_SECRET=test\nFEISHU_OPS_ADMIN_OPEN_IDS=ou_test\n');
  const trace = path.join(root, 'trace');
  await writeFile(path.join(root, 'bin/docker'), `#!/bin/bash
printf '%s|%s\\n' "\${RELEASE_ID:-}" "$*" >> "$RELEASE_TEST_TRACE"
if [[ "$*" == *"build research-agent"* ]]; then exit 1; fi
exit 0
`, { mode: 0o755 });
  await writeFile(path.join(root, 'bin/stat'), '#!/bin/bash\necho 600\n', { mode: 0o755 });
  const archive = path.join(root, 'release.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', path.join(root, 'empty'), '.']).status, 0);
  const script = fileURLToPath(new URL('../deploy/server/install-release.sh', import.meta.url));
  const result = spawnSync('bash', [script, archive], { encoding: 'utf8', env: {
    ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
    INSTALL_ROOT: install, SOURCE_ENV: source, SOURCE_COMMIT: 'a'.repeat(40),
    ENABLE_CODEX_RESETS: '1', FEISHU_RESEARCH_CHAT_ID: 'oc_changed', RELEASE_TEST_TRACE: trace
  } });
  assert.notEqual(result.status, 0);
  assert.equal(await readlink(path.join(install, 'current')), previous);
  assert.equal(await readFile(path.join(install, 'shared/app.env'), 'utf8'), original);
  assert.match(await readFile(trace, 'utf8'), /previous-image\|compose .* up -d/);
  assert.match(await readFile(trace, 'utf8'), /build research-agent/);
});
