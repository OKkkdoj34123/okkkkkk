# 逐鹿盐山第一赛季配置自动识别（2026-11-10）

## 基线与来源

- custom基线：`560ad14d7b89a7a926dfe61a25d380f23798bef3`
- 上游固定提交：`cf45acf7d9b2a7987227c191fad6a2584323d3a2`
- 上游配置文件Git blob SHA：`5c459f2b880998ee1d92968e1a7d535e443cfcff`
- 只迁移第一赛季312条赛程配置；不包含第二赛季赛程，也不实现远端自动刷新配置。

## 行为

1. 默认自动识别第一赛季淘汰赛stage 4～10中唯一处于Unlocked/Locked的scheduleId。
2. 零个或多个候选时停止新竞猜；不使用最大scheduleId或历史guessMap推断。
3. 手动ID开关默认关闭；开启后只使用手动输入值，无效时不回退自动模式。
4. 根据当前scheduleId的round，只检查前一期round-1的stage 4～10领奖记录。
5. `teamId:false`为待领奖，`teamId:true`已领取，`_teamId:false`不领取。首次领奖未确认即停止该账号后续领奖请求；20020不重试，状态回读成功后仍可继续新竞猜。
6. 任一方已出现在当前scheduleId的guessMap即跳过整场。
7. 分页idx是同一scheduleId对阵列表的偏移量，按本页实际返回组数推进；未确认分页完整时不提交竞猜。
8. Apex命令全局串行，读取初始冷却600ms，竞猜/领奖3000ms；200400时自适应延长，连续成功后逐步回降。写请求不自动重发。
9. 不做服务器时钟校准。配置日期按北京时间UTC+8解释，使用运行设备系统时钟；定时任务时刻由用户自行确认。

## 主要文件

- `src/utils/apexStageMap.js`：第一赛季配置快照及来源元数据。
- `src/utils/apexRules.js`：北京时间配置日期、赛程状态、唯一开放赛程和前一期ID计算。
- `src/utils/batch/tasksApex.js`：自动/手动ID选择、前一期领奖、分页、竞猜回读、串行限流。
- `src/views/BatchDailyTasks.vue`：手动ID开关及输入框。
- `test/apexRules.test.js`、`test/apexGuess.test.js`：离线回归。
- `maintenance/modules.json`：维护入口与apex测试组登记。

## 验证

在项目根目录执行：

```powershell
node scripts/maintenance/test.mjs apex
pnpm test:unit
pnpm build
pnpm lint:check
```

本补丁只进行离线代码测试和构建，不发送真实游戏请求，不代表新版本BIN实测通过。501/502/503的2026-11-03记录仅作为旧版基础协议证据。新版本仍需先用测试账号验证只读赛程识别，再验证真实竞猜和前一期领奖。

## 未覆盖范围

- 第二赛季及后续赛季配置。
- 自动下载/更新赛程快照。
- 服务端时钟校准。
- 跨页面刷新持久化未决操作账本。
