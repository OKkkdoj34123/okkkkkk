# 项目维护流程

更新于 2026-11-22。本页记录项目维护与补丁流程。

## 原始 BIN 分组迁移与盐场台账（2026-11-22）

基线 `81bf37b509cad9d5dd87f1b9b54f5cc63bb020d0`。在项目根目录运行 `python patch_bin_groups_salt_20261122.py --check` 预检，去掉 `--check` 即备份、应用并执行 `node scripts/maintenance/verify.mjs`。恢复用 `python patch_bin_groups_salt_20261122.py --restore latest`。配置专项为 `node scripts/maintenance/test.mjs token-config`。盐场实服结论在 [当前维护状态](CURRENT_STATE.md)，后续观察在 [TODO-010](TODO.md#todo-010)。

## 凤仪祈愿本期补丁（2026-11-20）

指定基线 `f6797fca59bdb3345e23355638cae38ef8eb8d29`。脚本 `patch_fengyi_f6797fca.py` 支持 `--check`、`--apply` 和 `--rollback`。默认应用时备份目标原件并运行维护检查、全量离线测试与构建。验证、适用期次及商店待核对项见 [本期核验报告](phoenix-prayer-20261120.md)。

## 三周活动免费福利补丁（2026-11-20）

基线为 GitHub main `6d102f1c15b9c3f785941d92dc5ff0fbae339108`。脚本 `patch_recruit_week_benefit_20261120_R2.py` 在现有 `claimBoxWeekBenefit()` 中新增活动6招募周免费商品：活动type=4、buyType=1、goodsIndex=0、price=0、limit=1、奖励招募令（type=3/itemId=1001/value=5）；按既有北京时间周期分流，黑市周活动5/9、招募周活动6、宝箱周活动7。保留原防重键、活动期检查、服务端领取记录、回包核验及领取后activity_get回读，不修改常规task_claimweekreward。

完整实服日志确认了招募周领取前目录、myStoreInfo[6].complete为空，以及activity_buystoregoods code=0和招募令×5回包；日志没有领取后的activity_get。新增fixture与专项测试模拟回读成功、已领取、目录变化、超时未决和三个周的周期分流；实服回读仍待用户应用后验收。R2同时修正batchRuntimeFix.test.js的免费福利排除名单，以及dailyNormalResponses.test.js中招募周应生成活动6任务的旧预期。

项目根目录运行 `python .\patch_recruit_week_benefit_20261120_R2.py --check`、`--apply`。应用前自动备份，并执行 `node scripts/maintenance/verify.mjs`（维护检查、全量离线回归、生产构建）；失败自动回滚。恢复运行 `python .\patch_recruit_week_benefit_20261120_R2.py --restore latest`。备份位于项目根目录同级的 `<项目目录名>_patch_backups/RECRUIT_WEEK_BENEFIT_20261120_R2/`。脚本不发送游戏请求、不提交、不推送、不部署。

## 批量日常与自建定时任务对齐补丁（2026-11-15）

`patch_batch_schedule_task_alignment_20261115.py`基于GitHub main `e877f96587a90fc743d1195fe235c06ff269d4c1`。先执行`--check`，确认目标文件内容与基线一致后再执行`--apply`。补丁新增篝火报名、凤仪祈愿、江湖黑市和逐鹿盐山自动识别四项自建定时任务；删除批量智能发车/一键收车及专属配置；清理旧定时配置中的车辆任务ID；自动周计划说明默认折叠、配置迁移验证说明区域删除。

定时适配复用既有业务执行器，外层定时任务持有抢占租约；篝火/凤仪/江湖/逐鹿盐山保留各自Web Locks，江湖定时读取已保存购买清单，逐鹿盐山固定自动识别，不读取手动ID。四项任务只加入用户自建每日/Cron定时，不加入自动周计划；盐场独立定时入口不变。

`--apply`写入前自动备份，并运行`node scripts/maintenance/verify.mjs`（维护检查、全量离线测试、生产构建）；任何写入或验证失败均自动回滚。恢复使用`python .\patch_batch_schedule_task_alignment_20261115.py --restore latest`。备份保存在项目根目录同级的`<项目目录名>_patch_backups/BATCH_SCHEDULE_TASK_ALIGNMENT_20261115_R2/`，不污染Git工作区。脚本不执行游戏请求、Git提交、推送或部署。车辆展示/俱乐部车辆页面及其独立协议不在删除范围。

## 盐场候选据点补丁（2026-11-14）

`patch_salt_road_candidates_20261114.py`（R2）输入为main `e63cd59c9237c5154fc4923d5310f723eeef2652`（包含凤仪祈愿/竞技场/周福利最新改进）。用户未应用旧版时，重新下载同名脚本后直接使用本版，无需先装R1。先`--check`、再`--apply`，按内容预检、自动备份与恢复；仅更改盐场4个运行模块及测试/管理文档，通用通信和其它活动业务保持原样。完成后`pnpm verify`并由用户自行构建部署。支持`--restore latest`或指定备份目录，保护安装后的额外编辑，不清空浏览器执行记录。诊断标识SALT_ROAD_CANDIDATES_20261114_R2；活动期验证与JSON导出见[salt-road-candidates-20261114.md](salt-road-candidates-20261114.md)。

## 每日黑市维护（2026-11-12实服修正版）

基线为 `d6202fae8e951525478ed68d65bffcc3b30ca6cf`。在项目根目录运行 `python .\patch_daily_black_market.py --check`、`--apply`。用 `node scripts/maintenance/test.mjs daily-market` 回放脱敏样例并检查错误分支，`pnpm verify` 执行维护检查、全量离线测试和生产构建。回退运行 `python .\patch_daily_black_market.py --restore`。备份位于 `_patch_backups/daily_black_market_20261112/`。同一脚本支持干净基线或上一版完整每日黑市补丁，升级时核对全部目标的旧版哈希，备份当前字节；restore恢复到本次执行前的版本。已经提交其他SHA或目标有额外编辑时需按实际版本重新核对。

11月12日实服验证已完成三账号采购和同日重复，第二号两档配置补购扣1100且无额外刷新，回放样例包括BON第0页省略refresh、浮点折扣与整数扣款、余额不足跳过。该批实服回放记录的黄金鱼竿限价为2000；当前默认值为1999，2000价位应跳过。专项26项和全量564项是此前记录的验证结果，最新GitHub Actions的8项测试预期失败见下方限价测试维护记录。

在批量日常的“黑市清单配置”调整低关卡五项最高价，点击“保存配置”后生效。需复现第二份手动记录时，将黄金宝箱设为 300、普通鱼竿设为 800。首轮可用一个账号核对任务日志的已确认组数、扣款和刷新次数，再检查同日重复执行。购买按奖励、实差和已购数确认，刷新按页次和完整角色余额核对；超时后先核对服务器货架。同账号跨标签采购在支持 Web Locks 的浏览器中互斥。协议下单参数仅有货架编号，同时在其他设备手动改页可能改变成交条件。

## 每日黑市限价测试预期维护（2026-11-12）

输入基线：GitHub main `859000b394d1201b8391c07daa6f15eecfd4197f`。黄金鱼竿 goodsId=12 的业务默认限价为1999金砖，折后整组价2000时按超价跳过；本轮不修改 `src/utils/batch/dailyBlackMarket.js`，也不修改历史实服回放中记录的2000限价。

修改范围：仅更新 `test/dailyBlackMarket.test.js` 中依赖旧2000上限的汇总、余额、购买数量和请求数量预期，新增默认1999/整组2000边界测试；同步 CURRENT_STATE、MODULE_MAP、TODO、项目台账。实服BIN、Token、游戏请求和采购配置均不触碰。

在项目根目录运行 `python .\patch_daily_black_market_limit_tests_20261112.py --check`、`--apply`。`--apply` 自动备份目标文件并执行 `node scripts/maintenance/verify.mjs`（维护检查、全量离线回归和生产构建）；任一步失败自动回滚。恢复运行 `python .\patch_daily_black_market_limit_tests_20261112.py --restore latest`。备份位于 `_patch_backups/daily_black_market_limit_tests_20261112/`。本补丁不执行Git提交、推送或部署。

## 一键答题维护（2026-11-11）

输入 GitHub main `7fb016d9c252e617074e15ac830a770724bc012a`。在项目根目录运行 `python .\patch_study_final.py --check`、`--apply`，再运行 `node scripts/maintenance/test.mjs study`、`pnpm maintenance:check`、`pnpm test:unit`、`pnpm build`。回退用同一脚本 `--restore`。备份保留原字节；目标文件出现额外编辑时停止。
浏览器 F12 → Console，启用 Preserve log 和 Verbose；按“一键答题”筛选。周状态记录 action、beginTime、最高正确数与奖励数；“请求时序”的 start/end 为客户端毫秒时间戳，intervalMs 为本账号相邻调用开始时间差。筛选“题库无有效答案”，展开对应对象或右键 Copy object；只分享账号别名、该诊断和任务汇总，避免导出原始角色包或认证信息。
实测优先选已完成号查零写入，再用一个未完成号查全流程。不要为了追同一道题反复开局。501的同轮补验是现场受控验证，插件没有自动补交操作。

## 文档职责

| 文件 | 负责记录 | 更新时机 |
|---|---|---|
| `AGENTS.md` | 定位顺序、边界和验证约定 | 维护约定变化时 |
| `docs/CURRENT_STATE.md` | 当前最终行为、输入版本、证据和限制 | 功能变化或新增验证结论时 |
| `docs/MODULE_MAP.md` | 源码、测试和专题入口 | 新增/移动模块时 |
| `docs/TODO.md` | 未完成事项、证据、目标和验收条件 | 新发现问题或进展变化时 |
| `PROJECT_INDEX_AND_CHANGELOG.txt` | 可检索的简短历史台账 | 每次交付时 |
| `docs/history/`、专题文档 | 历史方案和当时验证依据 | 归档保留，不覆盖当前状态页 |

`maintenance/modules.json` 是维护检查读取的索引，不是业务注册表；尚未覆盖全部新模块。2026-10-29文档维护仅补全人工模块表；本次 `STUDY_ANSWER_20261030` 新增study源码入口与专项测试组登记，不代表业务任务接入自动日常或自动周计划。

## 盐场诊断JSON（2026-11-07）

`patch_salt_json_diagnostics_20261107.py`基于main / `22350ec0924b4dee1985caac44b585addbfe73fe`。先--check再--apply；自动备份和--restore；部署需重建。运行盐场自动采集，批量日常卡片导出，无需控制台开关。记录不改变游戏请求及防重放规则。专题：[交付与验收](salt-json-diagnostics-20261107.md)。

## 界面统一与宝箱周免费福利（2026-11-07）

`patch_ui_box_benefit_20261107.py`基于main / `7f960ab76c76e3ceef8771e20560b531a5126721`，已含此前所有已上传补丁。先--check再--apply，自动备份并打印--restore命令；支持--root，冲突零写入。部署版本需重新构建；不自动推送。专题：[安装和验收](ui-box-benefit-20261107.md)。

## 工具栏布局与验证说明补丁（2026-11-06）

`patch_token_layout_help_20261106.py`输入为81b2ce6加已交付TOKEN_CONFIG_REFRESH_20261106，必须先应用配置刷新补丁。先--check再--apply；按文件内容核对，Git SHA变化不单独阻止应用。支持--root、自动备份和--restore。仅调整两个页面模板/样式、帮助文字及管理文档；需要更新前端构建。见[说明与验收步骤](token-layout-help-20261106.md)。

## 配置刷新来源补丁（2026-11-06）

`patch_token_config_refresh_20261106.py`基于main / `81b2ce679d697b364c6a6d881252e5ee1a7f5290`（已含篝火）。先--check再--apply，支持自动备份/--restore和--root；源码变更需重新构建。专项命令`node scripts/maintenance/test.mjs token-config`，迁移说明见[专题](token-config-refresh-20261106.md)。

## 篝火报名补丁（2026-11-06）

`patch_bonfire_signup_20261106.py`输入main / `33934aacb29f5810e08b9132f4dc884d4b8ccfc8`，已含11月5日改进。先--check再--apply；支持--root、自动备份和--restore，冲突零写入。运行代码有变化，部署需重建；不自动推送。见[交付记录](bonfire-signup-20261106.md)。专项命令：`node scripts/maintenance/test.mjs bonfire`。

## 历史入口与Token刷新补丁（2026-11-05）

`patch_batch_entry_token_20261105.py` 基于 main / `3dc6824d410545b3f03ca817fdcd6f1b24f15290`，已包含上一版逐鹿盐山实现；不需要重跑旧逐鹿盐山补丁。

```powershell
python .\patch_batch_entry_token_20261105.py --check
python .\patch_batch_entry_token_20261105.py --apply
pnpm verify
```

Python 3.9+、标准库。支持 `--root`；无参数默认应用；`--check`零写入。目标及关键共享依赖按内容核验，允许统一LF/CRLF、BOM和末尾换行差异；冲突或部分应用停止。写入前备份，恢复命令使用脚本打印的实际目录；恢复保护应用后的编辑。不会修改Git索引、提交、推送或部署。

本轮运行代码有变化：本地开发刷新页面，部署版本需重新构建。周刷新记录键不变，不清除执行历史；`pnpm test:schedule`现包含Token刷新专项。详细范围与验证见 [交付记录](batch-entry-token-20261105.md)。

## 一次修改的流程

1. 记录实际Git HEAD、工作区改动和已应用本地补丁。无.git时明确说明，不用远端覆盖指定本地增量。
2. 阅读当前状态、目标模块和对应待办。历史解释由来，源码决定实际行为。
3. 明确本次目标和验收方式；待办优先级不表示已授权同时实施。
4. 业务问题先找回归或脱敏样例，复现后最小修改；没有新证据时不为凑数量写重复测试。
5. 按范围验证，区分代码检查、离线回归、页面模拟、真实账号、Git/CI、部署和用户反馈。
6. 更新状态、TODO、索引和TXT，再交付可预检、备份、恢复的补丁。

## 维护命令

维护验证环境：Node `24.22.1`、pnpm `10.19.0`，以 `maintenance/toolchain.json` 为准；不据此改动生产环境。

| 命令 | 用途 |
|---|---|
| `pnpm maintenance:check` | 已登记路径、维护入口和维护脚本语法；不检查全部文档事实 |
| `pnpm test:unit` | 全部 `test/*.test.js` 离线回归，含江湖黑市；不运行旧手工调试脚本 |
| `pnpm test:salt` | 盐场回归 |
| `pnpm test:schedule` | 自动周计划和调度回归 |
| `pnpm test:dream` | 梦境、重试、开放条件回归 |
| `pnpm test:boxes` | 积分开箱回归 |
| `node --test test/jianghuMarket.test.js` | 江湖黑市专项离线回归 |
| `node scripts/maintenance/test.mjs study` | 一键答题与领奖专项离线回归 |
| `pnpm lint:check [路径]` | 只读静态检查；原 `pnpm lint` 带自动修复 |
| `pnpm verify` | 维护检查 + 全部离线回归 + 现有生产构建 |

纯文档改动检查路径、维护入口、安装器恢复和运行文件哈希。运行代码改动执行相关回归，交付前按仓库约定执行verify；通用WebSocket/Token/调度变化覆盖受影响调用方。

全仓静态规则有历史债务；现有只读入口关闭不兼容的import/order规则，lint不属于verify/CI阻塞门槛。不要在功能补丁中全仓自动格式化。

现有CI在main推送、PR或手动触发时分别使用Ubuntu/Windows冻结安装并执行verify。检查实际SHA和结果，不用旧提交成功覆盖新补丁。

## 历史文档补丁（2026-10-29）

文件：`patch_docs_maintenance_20261029.py`，Python 3.9及以上，仅用标准库。

输入为3b7f2527加江湖黑市补丁后的文件。安装器按目标文档及业务文件指纹核对；Git HEAD仅作诊断。同样代码另行提交后HEAD变化不会单独阻止应用，内容不匹配仍停止。

项目根目录运行：

```sh
python patch_docs_maintenance_20261029.py --check
python patch_docs_maintenance_20261029.py --apply
```

不加参数等同于 `--apply`；其他目录可增加 `--root "项目目录"`。预检零写入；应用前备份原字节并打印恢复命令。冲突或部分应用停止；完整重复应用零写入。

恢复使用打印的实际备份目录：

```sh
python patch_docs_maintenance_20261029.py --restore "patch_backups/安装器打印的目录名"
```

恢复只还原本轮文档、移除本轮新建文档，不撤销江湖黑市业务补丁。有应用后的编辑时停止，防止覆盖。备份保留，不改变Git索引，不提交、推送或部署。

本轮仅文本维护，无需为这些文件重启服务或重新构建；后续业务改动另按发布流程操作。

## 故障资料

统一诊断导出实现前，可提供实际Git/补丁版本、任务/时间/账号别名、预期与实际表现、开始到终态日志、相关设置和请求/回包。协议资料保留时间、命令、序号、错误码及必要前后状态。

移除token、BIN、登录签名和带凭据URL；完整迁移备份与诊断资料分开保存。结果未知时保留未决记录，不靠清除记录或盲目重发诊断。

旧维护基础补丁说明已归档：[2026-10-25维护基础](history/maintenance-foundation-before-docs-20261029.md)。不要为本次文档维护重新运行旧补丁。


## 原始Git版本的一键完整安装

文件：patch_study_answer_full_20261030.py；标记：STUDY_ANSWER_FULL_20261030。
适用输入：Git d4583244ced5b6c65d0240143ae35e116c4e2a63 的未应用答题补丁版本。
包含原STUDY_ANSWER_20261030全部功能、专项测试和实测记录，并同步两份旧测试，共13个文件。不需要先执行旧答题补丁或实测记录补丁。
运行代码与已完成三BIN实测的版本逐字节相同；本轮仅整合安装路径，没有重新执行游戏操作。

```powershell
python .\patch_study_answer_full_20261030.py --check
python .\patch_study_answer_full_20261030.py --apply
pnpm verify
```

脚本默认执行应用，支持--root指定项目目录；冲突停止，应用前备份，重复应用零写入。
恢复使用脚本打印的--restore命令；恢复到本次应用前的原始代码，保护应用后的编辑。
旧py文件可保留在项目目录，它们不会造成预检失败。已应用旧答题补丁的工作区不属于本完整包的输入，不能强行覆盖。
本包修改业务源码，开发环境应刷新页面；部署版本需重新构建并由用户自行部署。脚本不会推送或部署。
