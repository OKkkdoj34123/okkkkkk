import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const group = process.argv[2] || 'unit';
const map = JSON.parse(readFileSync(resolve(root, 'maintenance/modules.json'), 'utf8'));
const files = group === 'unit'
  ? readdirSync(resolve(root, 'test')).filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`)
  : map.groups[group];
if (!Array.isArray(files) || !files.length) {
  console.error(`未知或空测试组：${group}`);
  process.exit(1);
}
console.log(`离线回归：${group}，${files.length} 个测试文件`);
// Explicit arguments work on Windows without relying on shell wildcard expansion.
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', shell: false });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
