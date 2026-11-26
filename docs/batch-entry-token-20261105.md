# 日常入口与周刷新范围调整

日期：2026-11-05（北京时间）；补丁：`BATCH_ENTRY_TOKEN_20261105`。
输入：GitHub `main` / `3dc6824d410545b3f03ca817fdcd6f1b24f15290`，已包含 `APEX_GUESS_20261103`。
当前执行环境没有 `.git`，按固定提交读取并校验文件blob后修改；不代表用户本地已应用或远端已更新。

## 三项行为

| 需求 | 实现与范围 |
|---|---|
| 逐鹿盐山ID放内部 | 点击“逐鹿盐山竞猜/补领奖”打开弹窗；在内部填写赛程ID并开始。打开/取消不执行；空值按钮为“仅补领奖”，有值为“开始竞猜并补领奖”；执行器沿用原实现。 |
| 周刷新只刷新自动周任务分组 | 周一北京时间00:10仍只生成一个计划，真正执行时读取最新已启用A/B/C所绑定分组的有效账号并集。重复账号只刷一次；未绑定/禁用/删除/未纳入账号排除，空集合跳过。 |
| 日常独立刷新任务 | “批量功能列表 → 日常 → 刷新Token”，只处理当前勾选账号；无选择或正在执行其他任务时禁用。手动启动重置旧停止状态，运行中停止跳过后续账号。 |

复用既有串行凭据刷新：不主动连接游戏WebSocket，缺少原始BIN/来源URL或不支持自动刷新时跳过；失败、待核验及确认完成分别记录。自建定时的“刷新 Token”已有注册，继续使用。独立刷新未加入普通日常链。

周刷新继续使用 `autoWeekly:YYYYMMDD:tokenRefresh:TOKENS`、原锁和历史键；已有完成/中断记录不会因为本轮范围或标签变化自动重跑。普通自动游戏任务仍对A/B/C重叠账号报错跳过；刷新仅做去重。

## 文件清单

- `src/views/BatchDailyTasks.vue`：内部弹窗、日常按钮和手动入口保护。
- `src/utils/autoSchedule/batchResolver.js`：周刷新按最新启用分组解析。
- `src/utils/autoSchedule/weeklyPlan.js`：刷新计划名称。
- `src/components/Batch/AutoWeeklyPanel.vue`：范围、去重数量和手动入口说明。
- `test/tokenRefreshRuntime.test.js`：范围、动态变更、互斥、停止及重启回归。
- `maintenance/modules.json`：登记相关入口，`test:schedule`纳入Token刷新回归。
- `docs/CURRENT_STATE.md`、`docs/MODULE_MAP.md`、`docs/TODO.md`、`docs/MAINTENANCE.md`、本文件、`PROJECT_INDEX_AND_CHANGELOG.txt`：当前行为、定位、限制与交付。

`tasksApex.js`、`tasksToken.js`、`tokenStore.ts`、共享WebSocket/BON、调度器机制、日常链和依赖锁文件字节保持输入基线。

## 验证

环境：Node 24.22.1、pnpm 10.19.0；冻结锁文件安装。首轮构建因快照缺少原仓库的 `src/xyzw` 运行依赖中断；补齐并核对blob后，现有生产构建通过，没有修改构建配置来绕过错误。

- 相关回归：`node --test test/tokenRefreshRuntime.test.js test/autoSchedule.test.js test/autoScheduleRuntime.test.js test/apexGuess.test.js`，80/80通过。
- 全量离线回归：478/478通过，0失败/跳过；维护检查通过；`pnpm build`通过，保留既有大文件/可选插件提示。
- 回归覆盖：已启用组并集、重叠、无效/删除账号、空组/禁用/未绑定不回退全部本地、排队后重新绑定/禁用、关闭总开关、双标签/重载防重、中断不重放、手动只选中、停止后重启、执行中停止和重复点击。
- 只读lint：`batchResolver.js`无报告；`weeklyPlan.js`第22/23行仍有9项既有逗号空格问题（这些行与输入基线完全一致），未做无关格式化。lint不是verify阻塞门槛。
- Vue模板解析与编译通过；自动浏览器启动因环境不允许所需socket而未完成，因此未声明浏览器交互验收通过。
- 安装器20组场景通过：LF/CRLF × BOM × 无末尾换行的8种组合，预检零写入、完整重复执行、逐字节恢复；目标/依赖/新增路径冲突、部分应用、恢复保护后续编辑、损坏备份、中断安装恢复、应用/恢复中途写入失败回滚、符号链接、混合换行及命令行默认应用。

## 安装与恢复

下载 `patch_batch_entry_token_20261105.py` 放在项目根目录，Python 3.9+：

```powershell
python .\patch_batch_entry_token_20261105.py --check
python .\patch_batch_entry_token_20261105.py --apply
pnpm verify
```

不加参数默认应用；其他目录可加 `--root "项目目录"`。预检按目标和关键依赖内容核验，允许统一LF/CRLF、BOM和末尾换行差异，保留原文本格式；冲突或部分应用停止，预检零写入，完整重复应用零写入。实际HEAD仅作为诊断，不能代替内容核验。

应用前自动备份，恢复使用脚本打印的 `--restore "patch_backups/实际目录"`；恢复核对备份完整性并保护应用后的编辑。脚本不修改Git索引、不提交、推送或部署；部署版本由用户重新构建后更新。

## 尚未验收

没有发送真实游戏或认证请求，没有更新真实Token。浏览器交互、真实来源凭据下的手动刷新、周一自动刷新现场表现见TODO-018。
逐鹿盐山仍需填写当期已核实ID；程序没有自动发现/有效期校验，本轮没有修改竞猜终态或加入跨刷新未决持久化，见TODO-016/017。2026-11-03的三BIN结果仅是之前的竞猜/领奖证据。
