import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const steps = [
  ['scripts/maintenance/check.mjs'],
  ['scripts/maintenance/test.mjs', 'unit'],
  ['node_modules/vite/bin/vite.js', 'build'],
];
for (const [file, ...args] of steps) {
  const result = spawnSync(process.execPath, [resolve(root, file), ...args], { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
