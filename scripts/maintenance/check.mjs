import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as moduleApi from 'node:module';
import { resolve, isAbsolute } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const manifest = read('maintenance/modules.json');
const toolchain = read('maintenance/toolchain.json');
const pkg = read('package.json');
const errors = [];
if (typeof moduleApi.registerHooks !== 'function') errors.push(`测试需要支持 registerHooks 的Node；验证版本为 ${toolchain.node}`);
if (pkg.packageManager !== `pnpm@${toolchain.pnpm}`) errors.push('包管理器与维护环境声明不同，请核实后同步文档');
for (const [group, paths] of Object.entries(manifest.groups)) {
  if (!Array.isArray(paths) || !paths.length) errors.push(`空测试组：${group}`);
}
const paths = [...manifest.entrypoints, ...Object.values(manifest.groups).flat(),
  'AGENTS.md', 'docs/CURRENT_STATE.md', 'docs/MODULE_MAP.md', 'docs/MAINTENANCE.md', '.github/workflows/maintenance.yml'];
for (const name of paths) {
  if (isAbsolute(name) || name.split('/').includes('..') || !existsSync(resolve(root, name))) errors.push(`索引路径无效：${name}`);
}
for (const name of ['test:unit', 'test:salt', 'test:schedule', 'maintenance:check', 'verify', 'lint:check']) {
  if (!pkg.scripts[name]) errors.push(`缺少维护命令：${name}`);
}
const ignored = readFileSync(resolve(root, '.gitignore'), 'utf8').split(/\r?\n/);
if (ignored.includes('.github')) errors.push('.github仍被整体忽略');
for (const name of ['/patch_backups/', '/_patch_backups/', '/.patch_backups/']) if (!ignored.includes(name)) errors.push(`缺少备份忽略规则：${name}`);
for (const file of ['test.mjs', 'verify.mjs', 'check.mjs', 'lint.mjs']) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, 'scripts/maintenance', file)], { encoding: 'utf8' });
  if (result.status !== 0) errors.push(result.stderr || `语法检查失败：${file}`);
}
if (process.versions.node !== toolchain.node) console.warn(`提示：当前Node ${process.versions.node}；维护CI使用 ${toolchain.node}，本检查不改变本机或部署环境。`);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('维护入口、模块路径和脚本语法检查通过。');
