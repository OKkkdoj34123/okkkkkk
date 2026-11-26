# 历史归档：旧维护基础说明

归档于2026-10-29。以下为整理前原文；其中“当前”“本轮”“未实现”等均属于记录当时，不代表现状。当前结论请见 `docs/CURRENT_STATE.md`，未完成事项见 `docs/TODO.md`。

---

# 独立维护基础整理

标记：`MAINTENANCE_FOUNDATION_20261025`。输入基线：`c95c032641234fd954f296db6e19db89600bfd1e`。

## 不变范围

本轮不修改任何游戏业务源码、原有测试、代理/构建配置、运行时存储或依赖版本。
`package.json` 只新增 scripts；既有 scripts、dependencies、devDependencies 和两个锁文件保持原样。
不会改变当前浏览器中正在执行的任务，也不发送游戏请求、提交或部署。

## 应用和恢复

在项目根目录执行 `python patch_maintenance_foundation_20261025.py --check` 预检，
再执行 `python patch_maintenance_foundation_20261025.py` 应用。
脚本先逐文件核对版本，备份原字节，再写入；重复运行会跳过已应用内容。
任何冲突均停止，不覆盖本机修改。恢复使用脚本输出的 `--restore` 命令和实际备份目录。

脚本还会取消 `patch_backups/`、`_patch_backups/` 中已跟踪文件的Git跟踪，
工作区的备份文件保留。其他暂存内容保持不变；Git索引另有原字节备份。
Git会显示这些备份路径为“暂存删除”，这是取消跟踪的预期结果，不是删除本地文件。
恢复前会同时预检文件和索引，后续文件编辑或暂存内容变化会阻止自动覆盖。
不要在补丁写入或恢复期间同时执行Git暂存操作。无Git元数据的源码包只更新文件和忽略规则。

本轮新增 `.github/workflows/maintenance.yml`，移除了忽略整个 `.github` 的规则。
提交前检查该目录，避免把其他临时内容一并提交。补丁不会代你提交任何变更。

## 维护命令

验证环境为 Node `24.22.1`、pnpm `10.19.0`，记录在 `maintenance/toolchain.json`。
这里只固定维护CI环境；没有新增 engines、.nvmrc 或生产平台版本设置。
已安装依赖时无需重新安装；缺少依赖可按现有锁文件运行 `pnpm install --frozen-lockfile`。

| 命令 | 行为 |
|---|---|
| `pnpm maintenance:check` | 检查维护入口、模块路径和维护脚本语法 |
| `pnpm test:unit` | 枚举全部 `test/*.test.js`；不运行旧手动调试脚本 |
| `pnpm test:salt` | 盐场5个测试文件 |
| `pnpm test:schedule` | 自动周计划/调度2个测试文件 |
| `pnpm test:dream` | 梦境阵容/重试/开放条件测试 |
| `pnpm test:boxes` | 积分开箱测试 |
| `pnpm lint:check [路径]` | 复用已锁定依赖中的ESLint，只读检查；不安装、不改源码 |
| `pnpm lint:fix [路径]` | 显式自动修复，只有确有需要时使用 |
| `pnpm verify` | 维护检查 + 全部离线回归 + 现有Vite生产构建，失败即退出 |

原有 `pnpm lint` 仍带 `--fix`，不要当作只读检查运行。
lint入口排除参考bundle `src/xyzw/` 和生成的 `.d.ts`，最多展示前30条问题。
现有配置的 `import/order` 与锁定的import插件不兼容；新增入口仅关闭这一不可用规则，
其余规则仍执行。原eslint配置和原lint命令不改动。
全仓格式/静态规则存在历史债务；本轮不自动修复，也不把lint纳入verify/CI阻塞门槛。
测试文件显式传给Node，不依赖Windows或Unix shell对通配符的不同处理。

## 自动检查

工作流在main推送、PR和手动触发时，分别使用Ubuntu/Windows执行冻结安装和 `pnpm verify`。
权限仅为读取仓库，没有部署、发布、消息发送或真实账号测试步骤。
工作流提交后才实际运行；不要将本地验证结果表述为GitHub两种系统均已验证。

## 日常维护顺序

1. 看 `AGENTS.md`、当前状态和模块索引，确认当前HEAD与用户本机改动。
2. 运行相关离线测试，区分已有失败与本次新增失败。
3. 做最小修改，验证影响模块；交付前按范围执行verify。
4. 更新当前状态和TXT简短记录；真实运行尚未验证时明确保留该状态。
5. 用户自行决定何时提交和部署。

## 验证记录

本轮本地对照结果见 `docs/MAINTENANCE_VALIDATION.md`。
源码检查与构建不能替代真实活动验收，盐场实测结论仍以当前状态页为准。
