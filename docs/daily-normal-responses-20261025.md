# 批量日常正常返回分类

日期：2026-10-25（北京时间）。输入提交：`88cc5a331a29adaaf5c9b9245e1daf4ae2e04d2e`。
补丁标识：`DAILY_NORMAL_RESPONSES_20261025`；打包修订：`20261025.1`。

## 处理约定

用户反馈所列日常任务运行正常，要求这些特定返回不再显示为警告或错误。
原实现用一组数字错误码统一生成 warning，并为 200020 统一追加“执行结果未确认”；
领奖请求还有独立的强制警告诊断，因此只改最终汇总无法完整解决。

本轮在批量日常分类器中按命令及必要参数识别正常结果，在执行器中记录 completed/skipped，
保留 code、requestCmd、originalMessage、正常处理说明和原有任务间隔。
页面、控制台汇总及 PushPlus 使用既有结果链路，不再收到这些子项的 warning。
普通成功仍表示对应任务处理正常结束；不会通过本次兼容规则虚构实际奖励数量。

| 命令 / 场景 | 返回码 | 新结果 |
|---|---|---|
| task_claimdailyreward、task_claimweekreward | 200020 | completed：按用户指定的日常领奖兼容规则正常结束，不重发 |
| system_signinreward | 400190 | skipped：当前没有可领取的签到奖励 |
| legion_signin | 2300190 | skipped：今天已签到 |
| discount_claimreward、card_claimreward | 1000020 | skipped：今天已领该礼包 |
| card_claimreward，cardId=4003 | 1400010 | skipped：未购永久卡，无需领取 |
| genie_sweep，genieId=1～4 且未传 sweepCnt | 3300060 | skipped：该灯神免费扫荡条件未满足 |
| genie_buysweep | 3300050 | skipped：免费扫荡券领取已达上限 |
| task_claimdailypoint | 700020 | skipped：该任务奖励已领取 |
| activity_recyclewarorderrewardclaim | 3500020 | skipped：当前没有可领取的通行证奖励 |
| gacha_drawreward，num=1、isGroup=false | 400000、1000020 | skipped：当前免费扭蛋不可领取 / 今天已领取 |

“正常跳过”计入现有“完成/跳过”分子，不产生账号警告。
200020 的处理依据是用户反馈和本次明确要求，不是已证明服务端接口存在缺陷；
代码未通过奖励字段核实到账，因此日志写“正常处理”，不会写“奖励到账已确认”或“请求正常返回”。

## 活动日与影响范围

- 批量免费扭蛋按 UTC+8（北京时间）周二、周四、周六执行；非活动日生成正常跳过说明且不发请求。
- 保留免费扭蛋开关和已有当天领取统计判断；在实际执行步骤时判断活动日。
- 活动日期依据本次用户说明；不修改账号设置，不新增重复请求。
- 单账号入口没有传入批量分类器，保持原有策略；梦境逻辑不修改。
- 同码不同命令、缺少必要上下文、未知码及 200160 保持原分类。
- 超时、断线、停止及前置步骤未执行优先于正常返回分类，保留中止和防重放。
- 不改通用 WebSocket/BON、盐场、盐罐、调度、PushPlus 布局、依赖或锁文件。

## 修改与验证入口

业务源码仅两处：`src/utils/batch/dailyErrorPolicy.js`、`src/utils/dailyTaskRunner.js`。
新增 `test/dailyNormalResponses.test.js`；调整 `batchRelease20261022.test.js` 中两个领奖返回和
`bottleConnectionFix.test.js` 中已领取签到的旧预期。其他异常/断线测试保留。
同步 `docs/CURRENT_STATE.md`、`docs/MODULE_MAP.md` 和 `PROJECT_INDEX_AND_CHANGELOG.txt`。

验证环境：Linux、Node 24.22.1、pnpm 10.19.0，复用同一锁文件安装的依赖。
- 原始代码离线回归：329 项通过，0 失败。
- 新增24项回归通过，覆盖所有指定码、命令/参数边界、字符串码、七天活动日及跨零点、
  已领取/开关、单账号旧策略、未知错误、超时断线、请求次数与任务间隔，以及真实源码的
  DailyTaskRunner → Vue 批量入口 → 定时汇总 → PushPlus 路径（网络为人工模拟）。
- `pnpm verify`：维护检查、353 项离线回归及生产构建通过；保留既有构建警告。
- 补丁交付检查：仅预检零写入、重复应用、版本/依赖冲突零写入、恢复冲突保护、
  备份损坏拒绝、CRLF/BOM/无末尾换行处理、逐字节恢复及模拟写入失败回滚。

未运行真实游戏请求、未提交/推送/部署；上线后的结果以用户下一轮日志为准。
403/404 个仓库 blob 已按当前 Git 树核验原始字节；未获取的大静态图 `public/icons/grayRockMap.png`
不在本次修改范围。本地构建未包含该图，因此构建通过不代表线上全部静态资源验证通过。
未在原生 Windows 上执行；换行/BOM 和补丁路径恢复通过本地模拟测试。
