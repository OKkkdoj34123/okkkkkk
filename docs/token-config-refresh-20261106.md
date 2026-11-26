# 配置迁移与Token刷新（TOKEN_CONFIG_REFRESH_20261106）

基线：main / `81b2ce679d697b364c6a6d881252e5ee1a7f5290`，已含篝火补丁。使用Git blob逐文件核验的快照，本地无.git；未提交、推送或部署。

## 修复

- 日常配置导出升级为1.2，新增默认勾选的“包含原始BIN（跨设备刷新）”。保留原来源类型、URL、账号ID及既有配置；勾选时为可读取BIN的账号附带binBase64。未勾选时只导出原有Token/配置/来源元数据，不导出BIN。缺失BIN显示数量提示，不冒充完整迁移。
- 导入兼容旧1.1配置。URL来源保留；BIN/扫码来源恢复原始字节至当前浏览器IndexedDB并回读比较。全部账号和BIN编码先校验，再写入缺失BIN；写入失败撤回本次新增BIN，不改账号数组。数据库不可用时明确报错，不报告恢复成功。
- 已存在账号按ID或相同Token匹配，保留本地ID、当前Token和其他设置，只补刷新来源。保留已存在的有效来源/BIN，不用旧备份覆盖它们。ID和Token分别指向不同账号时拒绝导入，不按名称猜测账号身份。
- 账号ID映射用于新任务/分组/日常设置；已有任务和分组只修正映射涉及的账号引用，保留其他用户设置。账号原始数据异步导入期间若账号列表变化则停止应用账号列表，避免覆盖并发更新；已补齐BIN可供重试使用。
- 旧版本已经导入成import的账号，刷新时自动按有效来源URL或当前浏览器已有BIN识别，成功后恢复来源标记。无需删除账号或重新安排任务。原始BIN兼容按ID保存和唯一旧名称保存；名称重复或撞其他账号ID时不借用。
- 日常刷新仍仅当前勾选；周一00:10仍仅启用A/B/C分组并集。冷却、并发锁、认证限流、回读持久化和不强制重连语义不变。

## 使用

1. 安装后，已有账号若还保留URL或本地BIN，直接点击日常“刷新Token”。
2. 跨设备时在原设备勾选“包含原始BIN（跨设备刷新）”再导出，在目标设备导入；重复导入可补齐已有账号，不需删除账号。
3. 旧配置若完全不含BIN，目标浏览器也没有对应BIN，仍需从原设备重新导出完整配置或补导BIN。无法根据现有Token逆推出原始认证数据。

配置文件包含登录凭据和可选原始BIN，仅用于自己的设备迁移。导入导出本身不发送认证/游戏请求。此修复不改变另一个Token管理器的独立备份界面。

## 验证

针对性检查29项通过，其中新增8项（配置迁移7项、旧import刷新1项），其余为现有刷新/调度回归。测试使用人工样例，覆盖原始字节往返、旧配置补齐、ID/引用保留、损坏BIN零写入、存储失败回滚、重名保护、数据库初始化，以及提取实际Vue导入导出处理函数的模拟往返。

仓库要求的 `node scripts/maintenance/verify.mjs`（与pnpm verify入口相同）通过：维护检查、全量493项（既有485+新增8）、生产构建。安装器20种既有场景通过，含LF/CRLF、BOM、无末尾换行、预检/冲突零写入、重复应用和恢复/回滚。没有本轮真实认证请求，没有浏览器端到端操作；待用户实际浏览器迁移验收见TODO-020。

## 安装

```powershell
python .\patch_token_config_refresh_20261106.py --check
python .\patch_token_config_refresh_20261106.py --apply
pnpm verify
```

Python3.9+标准库，支持--root、自动备份及--restore，冲突零写入；重复应用零写入，恢复保护后续编辑。基线已经包含本轮之前的篝火、Token范围和逐鹿盐山改进，不需重跑旧脚本。部署版本需重建；不自动推送。

运行文件：src/utils/tokenRefreshSource.js、src/stores/tokenStore.ts、src/views/BatchDailyTasks.vue。新增测试tokenConfigTransfer.test.js，既有tokenRefreshRuntime.test.js接入实际来源解析并补旧import用例，autoScheduleRuntime.test.js适配异步导入测试环境；同步维护索引、CURRENT_STATE、MODULE_MAP、TODO、MAINTENANCE和TXT。
