# 一键答题与领奖：协议分析和维护记录

日期：2026-10-30。代码基线：`main/d4583244ced5b6c65d0240143ae35e116c4e2a63`。

## 本轮范围

只维护一键答题和奖励领取，保留原有 `StudyChallengeCard.vue` 手动入口、`study_startgame`、`study_answer`、`study_claimreward` 流程。未改自动日常顺序、自动周计划、其他批量任务、WebSocket通用关联逻辑或部署配置。

## 抓包事实

### 第一份网络记录

- `study_startgame` 返回 `study.id=1`，并在 `questionList` 中返回10道题，题目ID依次为 `368、289、323、302、337、263、286、306、258、318`。
- 抓包中先出现一条 `study_answer` 空数组请求（`questionId=[]`、`option=[]`，响应code=0），随后有10条带单个 `questionId/option` 的有效答题请求；当前 `StudyPlugin` 不会生成空数组请求，该空请求来源待BIN实测确认。
- 这10条答题响应均为协议成功，回读的 `role.study.question[].state` 依次成为 `right`，`maxCorrectNum` 从1增加到10；每条答题响应的 `taskComplete` 增量分别将对应奖励项更新为 `yes`，10条响应合计覆盖1至10号。
- 随后 `study_claimreward` 的 `rewardId=1...10` 均返回成功，回包包含奖励数据，`taskComplete` 对应项变为 `claimed`。
- 同一文件还出现 `SystemService.custom` 的 `key=quizSkin`，先后设置 `value=2`、`value=3`。第一次设置发生在 `study_startgame` 返回题目之后，不能据此证明它改变了本轮题目集合。

### 第二份网络记录

- 出现四次 `study_setskin`：`10150 → 10250 → 10150 → 10000`。
- 每次响应中的 `role.study.useSkinID` 均更新为对应请求ID。
- 该记录没有后续 `study_startgame` 或 `questionList`，因此无法判断切换后题目文本或题目ID是否改变。
- `study_setskin` 和 `study_unlockskin` 的字段表现是 `useSkinID` / `unlockedSkin`；本轮不把这些ID直接当作题库ID，也不主动发送皮肤切换请求。

## 当前题库数据审计

当前 `public/answer.json`：

| 项目 | 数量 |
|---|---:|
| 原始记录 | 583 |
| 题目与答案字段有效 | 582 |
| 不重复题目文本 | 581 |
| 重复文本 | 1组 |
| 空题目记录 | 1条 |

唯一重复文本的两条记录答案相同；空题目记录不作为可用题目。第一份抓包中的10道题均能在当前文件中完整匹配，答案选项依次为 `1、1、2、1、1、1、2、1、2、1`。

这只能证明该次抓包中的10题已收录，不能证明其他题目集合或所有题库均完整。

## 当前源码问题与本轮调整

原 `src/utils/studyQuestionsFromJSON.js` 使用双向包含匹配，可能把短题误匹配到长题；未匹配时返回 `null`。

原 `src/stores/events/study.ts` 在答案为 `null` 时仍默认提交选项1；答题后不读取服务端领奖状态，直接请求奖励1至10。请求响应数量因此不能证明答题正确或奖励可领取。

本轮调整：

1. 题目文本先进行NFKC和空白规范化，只接受完整文本匹配；同一题目存在冲突答案时返回未匹配，不猜答案。
2. 未匹配、答案冲突或答案越界的题目不发送 `study_answer`，不再默认提交选项1。
3. 合并启动回包、逐题答题响应和 `role_getroleinfo` 中的 `taskComplete` 增量，只对合并后状态为 `yes` 的奖励发送领取请求；`not`、`claimed` 或状态缺失均不发送。
4. 领奖请求失败后停止剩余领奖请求，不自动重试；合并领奖响应与最终回读的 `taskComplete` 增量，区分请求成功响应与服务端确认已领取。
5. `3100060`、`400340` 均保留为实际异常，不增加全局忽略规则，也不推断错误码含义。

## 题库选择结论

当前网页端答题入口没有题库选择控件；`StudyPlugin` 只消费服务器返回的 `questionList`，题目答案从单一 `public/answer.json` 查找。当前答题模块没有主动调用 `SystemService.custom(quizSkin)` 或 `study_setskin`。

抓包能证明存在 `quizSkin` 自定义字段和 `study_setskin/useSkinID` 状态变化，但尚未证明它们会改变 `study_startgame` 返回的题目集合。需要在同一测试账号上记录“切换前启动答题→切换操作→切换后启动答题”的完整请求与响应，比较 `questionList` 的文本和ID，才能确认题库选择机制。

## 验证边界（2026-10-30补验更新）

- 已重新读取两份JSON日志及三个BIN，已完成501/502/503的真实答题与领奖。
- 三账号各10题服务器判对、10次领奖有奖励回包，最终taskComplete全部claimed；金砖变化0、阵容/科技/答题皮肤不变。
- 专项离线回归7/7通过；3100060、400340本轮实服未复现，不扩大结论。
- 当前皮肤0下三组题目成功；未做题库或皮肤切换，旧抓包的切换机制与空请求来源仍待验证。
- 详见[实测记录](study-live-validation-20261030.md)。业务代码沿用上次补丁，本次仅同步验证文档；未提交、推送、部署。
