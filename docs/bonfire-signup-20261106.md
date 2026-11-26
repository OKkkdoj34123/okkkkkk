# 篝火报名（BONFIRE_SIGNUP_20261106）

输入：GitHub main `33934aacb29f5810e08b9132f4dc884d4b8ccfc8`。本地为逐文件Git blob核验的快照，无.git；未提交、推送或部署。

## 功能与边界

“批量功能列表 → 日常 → 篝火报名”，仅处理当前勾选账号。北京时间周五至周日，团长job=1、副团长job=2可执行；普通成员或未入会跳过。逐账号串行，同俱乐部每批次只处理一次。不加入自动日常链、自动周计划或自建定时，不读取/领取邮件。

先读取role_getroleinfo、legion_getinfo核对账号与所属俱乐部及职位，再查club_getinfo。club.phase等于动态计算的下一周一赛期则跳过；否则读取club_getsignupcnt并提交一次club_signup，参数均为{}。人数仅用于日志，不推测最低人数门槛，不作为报名状态。只有独立club_getinfo回读匹配所属俱乐部和目标赛期才报告成功；报名响应可能是增量，不能直接当作完整状态。

提交前写入xyzw_bonfire_signup_v1:<legionId>:<phase>未决记录；超时关闭旧连接并丢弃旧队列，再只读回查。未确认则保留记录，刷新/重跑不重发；明确服务器拒绝记录rejected，允许用户之后重新运行。已提交时点击停止仍完成本次回查。采用现有任务抢占/连接清理和Web Locks跨标签互斥；没有Web Locks时不提交。

## 实际证据

- 用户11月6日抓包：club_getsignupcnt返回22，用户补充其应指俱乐部人数；club_signupresp code=0，phase由261102变261109。邮件只有摘要ID/更新时间，无正文及领取请求，不能证明“入围”。
- 501真实读取：副团长job=2；团长job=1，普通成员job=999；cnt=20，与成员列表20人相符。
- 501仅提交club_signup一次，返回增量club字段power/phase/weekScore/members，没有legionId；独立club_getinfo确认原俱乐部不变，phase由261019变261109。legion_getinfo.info前后无变化，不使用其signUp字段判断本活动。
- 重新连接后，通过本次实际runBonfireSignup函数和真实只读传输运行，返回“本期261109已报名，跳过”，只发角色/俱乐部/活动查询，零报名请求。
- 报名后单独查询club_getsignupcnt返回空对象，因此实现先查赛期，已报名时不依赖人数接口。
- 真实提交使用临时串行程序复用项目BON协议；重跑使用本次任务核心。未通过浏览器点击新按钮，未实测非团长拒绝、周末边界或断线。
- test/fixtures/bonfire-live-redacted.json只保留相关字段，ID替换；不包含BIN、Token、登录回包、原始成员名单或邮件。

## 消息测试

选择账号并连接，命令框填club_getinfo、club_getsignupcnt或club_signup，JSON框填{}。补丁已注册后两条命令；club_signup是真实报名。页面“已发送”只表示入队，需要查看club_signupresp并用club_getinfo回查。手动消息测试不执行日常按钮的权限、日期与未决保护，日常使用新增按钮即可。

## 验证与安装

专项：node --test test/bonfireSignup.test.js，7项通过。覆盖时间/职位、真实字段、成功回读、重复/未决、异常/停止、存储和实际通信类注册/映射。仓库整体验证 `node scripts/maintenance/verify.mjs`（与pnpm verify入口相同）：维护检查通过、全量485项通过、构建成功；其中478项是既有回归，仅7项为本次新增。安装器20种既有场景通过：LF/CRLF、BOM、无末尾换行、零写入预检、重复应用、目标/依赖冲突、恢复保护和中断回滚；不新增业务测试计数。

```powershell
python .\patch_bonfire_signup_20261106.py --check
python .\patch_bonfire_signup_20261106.py --apply
pnpm verify
```

Python3.9+标准库，无参数默认应用；支持--root，输入/依赖冲突零写入，自动备份，重复应用零写入。恢复使用脚本打印的--restore命令，保护应用后编辑。保留之前Token/逐鹿盐山改进，不需重跑旧补丁。部署由用户重新构建并上传。

未完成现场边界见TODO-019。设备时间需正确。全新俱乐部若返回空活动信息，目前保守停止。历史通信TODO-001/002未修复；本模块通过串行、记录及关闭旧队列限制影响，不宣称共享层已修复。
