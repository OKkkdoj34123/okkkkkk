# 普通四阵营灯神手动挑战（GENIE_CHALLENGE_V1）

> 本文记录V1历史状态（当时尚未发战斗）。当前实现、真实验证及限制以 [V2说明](genie-challenge-20261027.md) 为准。

输入 main HEAD：`5a178c5e079287ccf7914ef7dcfc0704c4a31739`，已通过 GitHub 分支 API 重新核对。
直接 git 克隆不可用，因此在独立空目录按固定 SHA 获取源码并逐文件验证 Git blob SHA；开始时无已有用户改动。
这是受保护的候选实现，不是实服战斗验收完成版。没有 commit、push 或部署。

## 范围与入口

批量日常 → 副本 → 普通灯神挑战。选账号、阵营、1–10次，先读取并预览，再主动开始。
默认失败继续同一关；可选失败即停止。停止等待已发请求的结果/核验，随后不再发送挑战。
不加入 availableTasks、周计划或定时任务；保留现有灯神扫荡。
只读连接初始化不调用旧 ensureConnection，避免其 fight_startlevel 附带主线战斗。
页面 isRunning、现有推图抢占协作及同源 Web Locks 互斥；不支持 Web Locks 的浏览器不放行。

## 文件

- `src/utils/batch/genieChallengePolicy.js`：配置、阵容、战力、宠物、共享次数、进度和胜负校验。
- `src/utils/batch/tasksGenieChallenge.js`：账号执行器、逐账号预检、批量流程、持久化防重放和互斥。
- `src/components/Batch/GenieChallengeModal.vue`：配置/预览/开始/停止及分类结果。
- `src/views/BatchDailyTasks.vue`：手动入口、只读连接、推图协作、停止/卸载与预览失效控制。
- `src/utils/xyzwWebSocket.js`：仅增加命令注册、响应映射和该战斗报文的日志抑制；不改 BON 或通用收发算法。
- `test/genieChallenge.test.js`、`test/genieTransport.test.js` 与 `test/fixtures/genie-*.json`：人工样例和实际脱敏记录明确区分。
- `maintenance/modules.json`：维护入口及 genie 测试组；unit 自动包含新增测试。

## 协议及判断依据

`fight_startgenie` 使用 battleTeam（0–4）、genieId（1魏/2蜀/3吴/4群）、lordWeaponId=0、petUId；不包含深海5。
响应为 `fight_startgenieresp`，使用现有 resp 序号匹配及明确命令映射。
胜负读取 data.isWin 或 data.battleData.result.isWin，两者冲突、缺失或非布尔均停止；code=0不等于胜利。
两份原始记录来自 server-monitor-main-1793025703424(1).json、server-monitor-main-1793026952354.json。
实际9次响应确认：第一次[群失败、吴胜、蜀胜、魏胜]计数7→10；第二次蜀关卡2001/2002/2003/2003/2003，胜胜败败败，计数6→10。
空的 role.genie 为增量缺省，不能重置进度。genie条目为零基完成关卡，值0对应通关第1关。

主线优先 role.battleTeam，缺失/不完整时只读 presetteam_getinfo，必须明确 useTeamId，不默认槽1。
个人战力使用现有阵容助手同源 role.heroes[id].power；并列选最小位置索引。
四国基础阵容严格按用户指定；交换该阵营主C与目标位置，不改五人集合。
不发送 hero_exchange / hero_rebirth / 升级 / 下阵 / 装备 / 科技 / 鱼灵命令。
位置变化不会转移吕布等武将的养成战力给另一阵营主C，此限制不通过真实交换绕开。

## 宠物证据与支持范围

三个授权BIN均实际完成 login/authuser（code=0）和 role_getroleinfo。
返回 role.petData.pets 是槽位字典；UID是条目的 uId，不能使用槽位键、petId或历史固定UID。
实测宠物包含持久生命属性hp、attack、level、talentHp、starId、talentId、quenches、quenchInfoMap；与战斗中的武将curHp区分。
本版仅支持实测的无额外加成结构：talentHp/starId/talentId明确为0，quenches/quenchInfoMap为null或空对象。
逐只读取服务器hp并比较，全部宠物均须有可核验值；任意宠物存在未知加成结构即停止，避免错误选择。
并列按真实UID字典序稳定选择；界面仅显示UID末3字符。
未验证天赋、升星、淬炼条件下hp是否含全部加成，故不宣称支持这类宠物或一般化最终战斗生命公式。

## 次数与异常保护

四国共用统计键genie:battle，每次发送前重新读完整角色；额度=min(设置次数,10-当日已用)。
须同时有合法统计值和统计时间；按北京时间核验同日。缺失、旧日期、未来异常时间不推断为0。
跨日或计数回退停止；战后须回读确认次数恰好+1，进度与胜负一致。
未知结果先关闭旧连接并清除队列，再尝试只读回查；不重发战斗。
发送前持久化 xyzw_genie_pending_v1:<账号ID>，只记录日期/次数/阵营，无认证材料。
同日存在未决记录时再次启动也拦截；只读恢复计数增加仅说明请求可能已受理，不能补造胜负。
当前未提供“一键忽略待核验”按钮；当日未知结果需保留记录，不建议手工删除以强行重试。
次日只有取得明确当日统计后才可开始；不能因跨日而把缺失计数当零。

## 三个真实测试账号

| 测试别名 | BIN/认证/角色读取 | 最高已核验宠物hp | 主线最强位置 | 当日计数/时间 | 实际挑战请求 |
|---|---|---:|---|---|---:|
| 501 | 可读 / code=0 / 成功 | petId303：53000000（2只比较） | 吕布，索引0 | 两字段均缺失 | 0 |
| 502 | 可读 / code=0 / 成功 | petId403：65599994（1只） | 吕布，索引0 | 两字段均缺失 | 0 |
| 503 | 可读 / code=0 / 成功 | petId404：68133327（3只比较） | 吕布，索引0 | 两字段均缺失 | 0 |

这是真实认证及只读状态验证，不是实服战斗成功。没有消耗灯神次数，没有调用角色养成变更命令。
三个账号均因共享次数不可核验而未进入战斗。实际胜败、次数变化、连续推进还需有可靠当日计数的授权账号验证。
BIN、认证响应、完整角色状态均不随代码交付；仅保留脱敏、最小回归样例。

## 验证与限制

维护环境 Node 24.22.1、pnpm 10.19.0；使用现有 pnpm-lock.yaml，不升级或提交依赖变化。
已实际通过 `pnpm test:unit`（378项，0失败）、`pnpm maintenance:check`、`pnpm build` 和 `pnpm verify`（维护检查+378项回归+构建）。灯神新增21项测试。
只对新模块做定向测试及全量回归；未执行会改源码的pnpm lint。
构建的已有大包体积/第三方编译提示不作为实服业务验证。
页面已进行Vue编译验证和交互状态回归；未声称完成浏览器中真实账号点击验收。

## 本地应用

推荐先运行补丁 `--check`，再 `--apply`。必须处于上述 HEAD，目标文件内容也必须通过预检。
补丁不自动提交/推送，不自动安装依赖。备份位于 patch_backups/genie_20261026_<时间>/。
恢复使用补丁 `--restore <备份目录>`；恢复前核验应用后的文件未被后续修改，冲突时不覆盖。
换行LF/CRLF、BOM及无末尾换行兼容；版本/内容冲突预检零写入，重复应用不重复修改。
应用后运行 pnpm verify，在副本页打开普通灯神挑战，选择测试账号并预览；出现次数待核验时不要强行挑战。
