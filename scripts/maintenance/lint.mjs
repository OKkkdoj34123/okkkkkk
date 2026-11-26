import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../package.json', import.meta.url));
try {
  // Reuse the ESLint peer already resolved by the existing pnpm lockfile.
  const local = createRequire(require.resolve('@antfu/eslint-config'));
  const { ESLint } = local('eslint');
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const files = args.filter(arg => arg !== '--fix');
  if (files.some(arg => arg.startsWith('-'))) throw new Error('仅接受路径参数及显式 --fix');
  const eslint = new ESLint({ cwd: root, fix,
    // The locked Antfu config supplies import-lite, which has no import/order.
    // Disable only that unavailable legacy rule in this new maintenance entry.
    overrideConfig: { rules: { 'import/order': 'off' } },
    ignorePatterns: ['src/xyzw/**', 'src/**/*.d.ts'] });
  const results = await eslint.lintFiles(files.length ? files : ['src/**/*.{vue,js,ts}']);
  if (fix) await ESLint.outputFixes(results);
  const errors = results.reduce((sum, r) => sum + r.errorCount, 0);
  const warnings = results.reduce((sum, r) => sum + r.warningCount, 0);
  let shown = 0;
  for (const result of results) for (const message of result.messages) {
    if (shown++ < 30) console.log(`${result.filePath}:${message.line || 1}:${message.column || 1} ${message.message} (${message.ruleId || 'parse'})`);
  }
  console.log(`${fix ? '显式修复' : '只读检查'}：${errors} errors，${warnings} warnings；最多展示前30条。可传入具体路径缩小检查范围。`);
  process.exitCode = errors ? 1 : 0;
} catch (error) {
  console.error(`检查未完成：${error.message}。先按现有锁文件安装依赖；本入口不会自动安装或更改锁文件。`);
  process.exitCode = 1;
}
