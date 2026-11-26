# 功能定位与回归入口

更新于 2026-11-23。本轮基线为 GitHub main `972d79dab9b23b187f29d656ce30bdb792ae09c1`，路径相对于项目根目录。

本页为人工定位表。`maintenance/modules.json` 仅校验其中已登记的路径/测试组，不能保证整份Markdown自动同步；机器索引补齐见TODO-007。全部离线测试由 `pnpm test:unit` 自动枚举。

## 运行模块

| 功能 | 主要入口 | 边界 | 验证入口 |
|---|---|---|---|
| 界面统一/三周活动免费福利 | `src/router/index.js`、`src/layout/DefaultLayout.vue`、`src/views/TokenImport/index.vue`、`src/components/Test/MessageTester.vue`、`src/utils/dailyTaskRunner.js`、`src/utils/autoSchedule/activityCycle.js` | 按北京时间分流黑市周活动5/9、招募周活动6、宝箱周活动7；商品0严格免费核验、领取后回读与未决保护；既有周常领奖接口不变 | `test/boxWeekBenefit.test.js`、`test/fixtures/recruitWeekBenefit-20261120.json` |
| Token与配置工具栏 | `src/views/TokenImport/index.vue`、`src/views/BatchDailyTasks.vue` | 按钮换行、迁移独立行、折叠验证说明 | `docs/token-layout-help-20261106.md`；浏览器待验收 |
| 批量页面与登记 | `src/views/BatchDailyTasks.vue`、`src/utils/batch/index.js`、`src/utils/batch/constants.js` | 手动入口、availableTasks、分组、基础/Scoped执行映射需同步；智能发车/一键收车已下线 | `pnpm test:unit`、`test/scheduledTaskAdapters.test.js` |
| 自建定时任务适配 | `src/utils/batch/scheduledTaskAdapters.js`、`src/views/BatchDailyTasks.vue`、`src/utils/batch/retiredActivities.js` | 篝火、凤仪祈愿、江湖黑市、逐鹿盐山自动识别复用原业务执行器；PushPlus逐账号结果；旧车辆任务配置迁移剔除；不加入自动周计划 | `node scripts/maintenance/test.mjs schedule` |
| 下线活动兼容 | `src/utils/batch/retiredActivities.js`、`src/views/BatchDailyTasks.vue` | 加载/导入移除旧宝库项；其他任务保留，空计划禁用 | `test/retiredActivities.test.js` |
| 每日黑市采购 | `src/utils/batch/dailyBlackMarket.js`、`src/utils/dailyTaskRunner.js`、`src/utils/batch/tasksStore.js`、`src/views/BatchDailyTasks.vue` | 4000关分流、本机整组限价（黄金鱼竿默认1999，整组2000跳过）、BON第0页省略字段、首刷与回包核对。服务器清单同步入口仍在 `tasksUpstreamExtras.js` | `node scripts/maintenance/test.mjs daily-market`；`test/dailyBlackMarket.test.js`覆盖限价边界 |
| 凤仪祈愿 | `src/utils/batch/phoenixPrayer.js`、`phoenixSign.js`、`tasksPhoenixPrayer.js`、`scheduledTaskAdapters.js`、`src/views/BatchDailyTasks.vue` | 普通日10抽，确认本期末日后补签、清券；已完成盐场任务领奖；两类兑换待核对 | `node --test test/phoenixPrayer.test.js test/phoenixLive.test.js test/phoenixFinal.test.js`、[本期核验](phoenix-prayer-20261120.md) |
| 江湖黑市 | `src/utils/batch/jianghuMarket.js`、`src/utils/batch/tasksJianghuMarket.js`、`src/utils/batch/scheduledTaskAdapters.js`、`src/components/Batch/JianghuMarketModal.vue` | 活动9、整清单预算、本期目标份数、未决保护；手动入口与自建定时共用，定时读取已保存清单 | `node --test test/jianghuMarket.test.js test/scheduledTaskAdapters.test.js` |
| 普通灯神计划/执行 | `src/utils/batch/genieChallengePlan.js`、`src/utils/batch/genieChallengePolicy.js`、`src/utils/batch/tasksGenieChallenge.js`、`src/components/Batch/GenieChallengeModal.vue` | 四国2/2/2/4、共享10次、首战核验；不改扫荡/深海/调度 | `pnpm test:unit`，关注 `test/geniePlan.test.js`、`test/genieChallenge.test.js` |
| 灯神科技 | `src/utils/batch/genieTechnology.js` | 职业映射、置换、多套重建101–108、持久化恢复；不同于回退原多职业等级 | `test/genieTechnology.test.js` |
| 灯神玩具 | `src/utils/batch/genieWeapon.js` | 库存ID与0，服务器power比较；不枚举不存在ID | `test/genieWeapon.test.js`、`test/genieTransport.test.js` |
| 自动周计划 | `src/utils/autoSchedule/weeklyPlan.js`、`src/utils/autoSchedule/planGenerator.js`、`src/utils/autoSchedule/batchResolver.js`、`src/utils/autoSchedule/activityCycle.js`、`src/utils/autoSchedule/scheduler.js`、`src/utils/autoSchedule/useAutoSchedule.js`、`src/utils/autoSchedule/scheduleStorage.js`、`src/utils/autoSchedule/scheduleGuard.js`、`src/components/Batch/AutoWeeklyPanel.vue` | A/B/C × 13 项规则开关、北京时间、锁、执行前复核及历史。周刷新合并参与批次，下午备用窗口跟随最后一个启用塔时段，盐场另行定时 | `pnpm test:schedule` |
| 配置迁移与来源恢复 | `src/components/Batch/ConfigExportDialog.vue`、`src/utils/binConfigArchive.js`、`src/utils/tokenRefreshSource.js`、`src/stores/tokenStore.ts`、`src/views/BatchDailyTasks.vue` | 账号配置1.1/1.2、纯BIN v1/v2。v2随选区迁移分组，按实际本地账号ID还原，同ID组并集 | `node scripts/maintenance/test.mjs token-config` |
| Token刷新 | `src/utils/batch/tasksToken.js`、`src/stores/tokenStore.ts`、`src/utils/autoSchedule/batchResolver.js`、`src/views/BatchDailyTasks.vue` | 周一仅启用A/B/C分组并集；日常按钮仅当前勾选；自建定时保留；不进日常链 | `test/tokenRefreshRuntime.test.js`（已纳入 `pnpm test:schedule`） |
| 日常/盐罐/挂机 | `src/utils/dailyTaskRunner.js`、`src/utils/batch/tasksHangUp.js`、`src/utils/batch/tasksBottle.js`、`src/utils/batch/bottleWorkflow.js`、`src/utils/batch/hangUpWorkflow.js` | 领罐前置、共享结果去重；未知码不推断成功 | `test/bottleConnectionFix.test.js`、`test/dailyNormalResponses.test.js` |
| 逐鹿盐山竞猜/补领奖 | `src/utils/apexStageMap.js`、`src/utils/apexRules.js`、`src/utils/batch/tasksApex.js`、`src/utils/batch/scheduledTaskAdapters.js`、`src/views/BatchDailyTasks.vue` | 第一赛季stage4～10自动识别；手动ID覆盖默认关闭；手动/定时共用Web Locks；自建定时固定自动模式；APEX_CLAIM_HISTORY_ROUNDS=1；任一方已竞猜跳过；分页按实际组数；全局串行自适应限流；跨刷新未决账本仍待办 | `node scripts/maintenance/test.mjs apex`、`node scripts/maintenance/test.mjs schedule`；当前期及上一期领奖已通过真实账号验证；更早历史期出现200020，正式范围已限制为当前期+上一期。 |
| 日常结果分类 | `src/utils/batch/dailyErrorPolicy.js`、`src/utils/batch/taskResult.js` | 错误规则按命令/参数限定，保留待核验 | `test/dailyNormalResponses.test.js`、`test/batchTerminalRuntime.test.js` |
| 一键答题与领奖 | `src/stores/events/study.ts` 的 `runStudy`、`src/stores/events/role.ts`、`src/components/cards/StudyChallengeCard.vue`、`src/utils/batch/tasksHangUp.js`、`src/utils/studyQuestionsFromJSON.js`、`public/answer.json` | 按账号/连接预检、严格查题和异常诊断、独立领奖回读 | `node scripts/maintenance/test.mjs study` |
| 页面日志/推送 | `src/utils/batch/logUtils.js`、`src/utils/pushPlusNotifier.js`、`src/views/BatchDailyTasks.vue` | 控制台详细、PushPlus摘要；版本标签和诊断导出见待办 | `test/batchConsole20261023.test.js`、`test/batchTable20261023.test.js` |
| 盐场参与一次 | `src/utils/saltField/`、`src/utils/batch/tasksSaltOnce.js`、`src/components/Batch/SaltDiagnosticsPanel.vue` | 地图13静态道路推导实时据点；R2同批同距离候选均衡与大本营核对日志；逐个尝试、未决防重、v3未提交受限恢复；最近3批JSON。地图13已实服确认分流、自然到达和一次攻击结算，异常恢复见TODO-010 | `pnpm test:salt`（含saltJsonDiagnostics） |
| 盐场地图 | `src/views/LegionWar.vue`、`src/utils/legionWar.js` | 与参与一次任务分开，静态地图不能证明可达 | `pnpm test:salt` + 活动期验证 |
| 积分开箱 | `src/utils/batch/boxPointsRuntime.js`、`src/utils/batch/tasksItem.js` | 库存核验、积分领奖、有限循环 | `pnpm test:boxes` |
| 怪异塔综合 | `src/utils/batch/tasksWeirdTowerIntegrated.js`、`src/utils/batch/tasksTower.js` | 钥匙/合成/领奖/免费道具，保留原入口 | `pnpm test:unit` + 活动期证据 |
| 梦境及购买 | `src/utils/dreamTeam.js`、`src/utils/dreamStatePolicy.js`、`src/utils/batch/tasksDungeon.js`、`src/utils/batch/tasksStore.js` | 吕布阵容、进度、模板和购买边界 | `pnpm test:dream` |
| 篝火报名 | `src/utils/batch/tasksBonfire.js`、`src/utils/batch/scheduledTaskAdapters.js`、`src/views/BatchDailyTasks.vue`、`src/utils/xyzwWebSocket.js` | 手动/自建定时共用，周五至周日、团长/副团长、赛期回读和未决保护 | `node scripts/maintenance/test.mjs bonfire`、`node scripts/maintenance/test.mjs schedule`；501真实报名与核心跳过 |
| 营地/俱乐部 | `src/utils/batch/tasksCampChallenge.js`、`src/utils/batch/tasksLegionApply.js` | 空投保底/申请俱乐部独立任务 | `pnpm test:unit` + 对应真实反馈 |
| Token/连接/协议 | `src/stores/tokenStore.ts`、`src/utils/xyzwWebSocket.js`、`src/utils/bonProtocol.js` | 共享层改动需跨模块回归，不能先猜BON | `pnpm test:unit`；通信待办001/002 |
| 构建/代理 | `vite.config.js`、`worker.js` | 构建成功不等于生产代理/账号连接通过 | `pnpm build` |
| 可选后端 | `render-backend/server.js` | 独立环境，不假定与浏览器调度同时运行 | 按实际部署验证 |

表中单列测试文件可通过 `node --test 路径` 单独执行；交付前按影响范围执行 `pnpm verify`。江湖黑市输入版本有30个 `*.test.js` 文件，这是当时清单，不要求以后数量固定。

## 专题与证据

| 范围 | 文档 | 使用方式 |
|---|---|---|
| 配置迁移与来源恢复 | `docs/token-config-refresh-20261106.md` | 修复范围、迁移说明、测试和安装 |
| 篝火报名 | `docs/bonfire-signup-20261106.md` | 协议、501实测、安装和限制 |
| 日常入口与周刷新 | `docs/batch-entry-token-20261105.md` | 本轮范围、安装、离线验证与待实测项 |
| 江湖黑市 | `docs/jianghu-market-20261029.md` | 商品、协议、原始验证与安装说明；最新用户反馈见CURRENT_STATE |
| 灯神四国 | `docs/genie-four-nation-20261028.md` | 四国计划与当时战斗证据，科技说明以当前状态/后续专题为准 |
| 科技协议 | `docs/genie-technology-analysis-20261028.md` | 协议调研；其中“仅分析”描述该文当时阶段 |
| 科技联动/重建 | `docs/genie-technology-integration-20261028.md`、`docs/genie-tech-rebuild-afternoon-20261028.md` | 联动、101–108重建和下午计划演进 |
| 宠物/玩具 | `docs/genie-pet-toy-20261028.md` | hp字段、库存、power及实测限制 |
| 日常/领罐 | `docs/daily-normal-responses-20261025.md`、`docs/daily-bottle-order-20261026.md` | 分类规则、顺序和证据 |
| 一键答题 | `docs/study-answer-20261030.md` | 题库数据审计、抓包事实、领奖门槛和待实服验证 |
| 盐场 | `docs/salt-dynamic-evidence-20261024.md`、`docs/salt-once.md` | 最新候选策略见 `docs/salt-road-candidates-20261114.md`；其他文件为历史演进 |
| 旧灯神版本 | `docs/genie-challenge-20261026.md`、`docs/genie-challenge-20261027.md`、`docs/genie-day-fix-20261027.md` | 历史原因，不覆盖当前默认值 |
| 维护历史 | `docs/MAINTENANCE_VALIDATION.md`、`docs/history/` | 当时测试/安装记录，不当作新补丁验收 |

真实脱敏样例在 `test/fixtures/`。此前PDF定位报告适合架构导航，其旧文件数、环境建议不优先于当前源码和维护工具链。

## 推荐检索范围

先查上表入口和对应测试。排除 `patch_backups/`、`_patch_backups/`、`xyzw_web_helper-main/`，它们不是运行真值。
只有协议争议时才按明确文件读取 `source/`、`src/xyzw/`、`public/game/`。不要重写生成的声明或大型游戏bundle来完成普通业务修改。

盐场JSON交付与使用：`docs/salt-json-diagnostics-20261107.md`。
