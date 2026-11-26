import { toRaw } from "vue";
import { sleep } from "../../utils/base.ts";
import { diagnoseQuestion, loadQuestionsData } from "../../utils/studyQuestionsFromJSON.js";
import { taskErrorResult } from "../../utils/batch/taskResult.js";
import type { EVM, XyzwSession } from ".";

const GAP = { answer: 1000, afterAnswers: 1500, reward: 1000, afterRewards: 1500 };
const rewardIds = Array.from({ length: 10 }, (_, i) => i + 1);
const active = new Set<string>();
const initial = new WeakMap<object, { tokenId: string; time: number; study: any }>();

function studyFrom(body: any) {
  for (const root of [body, body?._rawData, body?.data]) {
    const study = root?.role?.study ?? root?.data?.role?.study;
    if (study && typeof study === "object") return study;
  }
  return null;
}

// 北京时间周一 00:00。1970-01-05 是周一；不随浏览器时区变化。
function week(ms: number) {
  return Math.floor((ms + 8 * 3600000 - 4 * 86400000) / (7 * 86400000));
}

function period(study: any, now = Date.now()) {
  const sec = study?.beginTime;
  if (!Number.isSafeInteger(sec) || sec <= 0 || sec * 1000 > now) return "unknown";
  return week(sec * 1000) === week(now) ? "current" : "old";
}

function rewardMap(study: any) {
  const map = study?.taskComplete;
  return map && typeof map === "object" && !Array.isArray(map) ? map : null;
}

function rewards(study: any, status: string) {
  const map = rewardMap(study);
  return rewardIds.filter(id => map?.[id] === status);
}

function decide(study: any) {
  // 初始化抓包中的未开局形态。单独的 beginTime=0 不足以得出此判断。
  if (study?.id === 0 && study.beginTime === 0 && study.maxCorrectNum === 0 &&
      study.totRightNum === 0 && study.totCplTaskNum === 0 &&
      Array.isArray(study.question) && study.question.length === 0 &&
      study.taskComplete && typeof study.taskComplete === "object" &&
      !Array.isArray(study.taskComplete) && Object.keys(study.taskComplete).length === 0) return "answer";
  const when = period(study);
  if (when === "unknown") return "unknown";
  if (when === "old") return "answer";
  const best = study.maxCorrectNum;
  if (!Number.isInteger(best) || best < 0 || best > 10) return "unknown";
  if (best === 10) return rewards(study, "claimed").length === 10 ? "skip" : "rewards";
  if (["yes", "claimed"].includes(rewardMap(study)?.[10])) return "unknown";
  return "answer";
}

// 初始化只供同一账号、同一连接的一次近期预检使用。被动收到题目包不会触发写操作。
export const StudyPlugin = ({ onSome }: EVM) => {
  // 标记为已处理，避免通用 $any 日志记录带有客户端对象的回包。
  onSome(["study", "studyresp", "study_startgame", "study_startgameresp"], () => {});
  onSome(["I-study"], ({ tokenId, client, body }: XyzwSession) => {
    if (client) initial.set(toRaw(client), { tokenId, time: Date.now(), study: studyFrom(body) });
  });
};

type Options = {
  open?: () => Promise<any>; close?: () => any; stopped?: () => boolean;
  delay?: (ms: number) => Promise<any>; log?: (message: string) => void;
};

async function execute(store: any, tokenId: string, options: Options) {
  store.gameData.studyStatuses ||= {};
  const states = store.gameData.studyStatuses;
  states[tokenId] = { status: "starting", isAnswering: true, detail: "", warnings: [] };
  const state = states[tokenId];
  const finish = (status: string, detail: string) => {
    Object.assign(state, { status, detail });
    return state;
  };
  const delay = options.delay ?? sleep;
  let client: any;
  let previousStart: number | null = null;
  const alias = store.gameTokens?.find((item: any) => item.id === tokenId)?.name || "当前账号";
  const tag = `[一键答题][${alias}]`;
  const workflowWeek = week(Date.now());
  const check = () => {
    if (options.stopped?.()) throw Object.assign(new Error("手动停止"), { stopped: true });
    if (!client || toRaw(store.getWebSocketClient(tokenId)) !== client || week(Date.now()) !== workflowWeek)
      throw new Error("连接或周次变化，停止并待核验");
  };
  const send = async (cmd: string, params: any = {}) => {
    check();
    const start = Date.now();
    const intervalMs = previousStart === null ? null : start - previousStart;
    previousStart = start;
    let errorCode: any = null;
    try {
      return await client.sendWithPromise(cmd, params, 5000);
    } catch (error: any) {
      errorCode = error?.code ?? String(error?.message).match(/服务器错误\s*[:：]\s*(\d+)/)?.[1] ?? null;
      throw error;
    } finally {
      const end = Date.now();
      console.debug(tag, "请求时序", { cmd, start, end, durationMs: end - start, intervalMs, errorCode });
    }
  };
  const read = async () => studyFrom(await send("role_getroleinfo"));
  let answered = 0;
  let right = 0;
  let wrong = 0;
  let unknown = 0;
  let claimed = 0;
  let attempts = 0;
  let progress = "";
  try {
    await options.open?.();
    client = toRaw(store.getWebSocketClient(tokenId));
    check();
    // 建连时 tokenStore 已发出 role_getroleinfo，给在途初始化回包一个短暂接收窗口。
    if (!initial.has(client)) await delay(400);
    const cached = initial.get(client);
    initial.delete(client);
    let study = cached?.tokenId === tokenId && Date.now() - cached.time < 10000 ? cached.study : null;
    const cachedAction = decide(study);
    if (cachedAction === "unknown" || (cachedAction === "rewards" &&
        rewards(study, "yes").length + rewards(study, "claimed").length !== 10)) study = await read();
    check();
    const action = decide(study);
    console.debug(tag, "周状态", { action, beginTime: study?.beginTime, maxCorrectNum: study?.maxCorrectNum,
      round: study?.id, yes: rewards(study, "yes").length, claimed: rewards(study, "claimed").length });
    if (action === "unknown") return finish("warning", "本周学习状态待核验，未开始答题或领奖");
    if (action === "rewards" && !study?.id) return finish("warning", "缺少学习轮次，未领奖");
    if (action === "skip") return finish("skipped", "本周已完成，奖励10/10已领取，跳过");
    let round = study?.id;
    if (action === "answer") {
      const database = await loadQuestionsData();
      options.log?.("本周未完成，开始答题");
      const body = await send("study_startgame");
      const start = studyFrom(body);
      const questions = body?.questionList ?? body?._rawData?.questionList ?? body?.data?.questionList;
      if (!start?.id || period(start) !== "current" || !Array.isArray(questions) || questions.length !== 10)
        return finish("warning", "启动已响应，本轮 ID、周次或10道题待核验");
      round = start.id;
      state.status = "answering";
      const submitted = new Set<string>();
      const roundRewards: Record<string, string> = {};
      const merge = (snapshot: any) => {
        for (const value of ["yes", "not", "claimed"])
          for (const id of rewards(snapshot, value)) roundRewards[id] = value;
      };
      merge(start);
      let answerError: any;
      for (const [index, q] of questions.entries()) {
        check();
        const match = diagnoseQuestion(q?.question, database, index + 1, q?.id ?? null);
        if (!q?.id || submitted.has(String(q.id)) || match.answer === null) {
          unknown++;
          console.warn("[一键答题][题库无有效答案]", { account: alias, ...match,
            fieldIssue: !q?.id ? "missing_id" : submitted.has(String(q.id)) ? "duplicate_id" : undefined });
          state.warnings.push(`第${index + 1}题未提交，请查看控制台诊断`);
          continue;
        }
        if (answered) await delay(GAP.answer);
        try {
          const reply = studyFrom(await send("study_answer", { id: round, option: [match.answer], questionId: [q.id] }));
          submitted.add(String(q.id));
          answered++;
          if (reply && (reply.id == null || reply.id === round)) merge(reply);
        } catch (error) { answerError = error; break; }
      }
      await delay(GAP.afterAnswers);
      progress = `答题请求响应${answered}/10，未匹配${unknown}`;
      if (answerError) state.warnings.push(taskErrorResult(answerError, answered > 0).detail);
      study = await read();
      if (period(study) !== "current" || study.id !== round)
        return finish("warning", [progress, ...state.warnings, "答题后周次或轮次待核验，未领奖"].join("；"));
      const judged = new Map<string, string>((Array.isArray(study.question) ? study.question : [])
        .map((q: any) => [String(q?.id), q?.state] as const));
      for (const id of submitted) {
        if (judged.get(id) === "right") right++;
        if (judged.get(id) === "wrong") wrong++;
      }
      progress = `答题请求响应${answered}/10，服务器判定正确${right}、错误${wrong}、未确认${answered - right - wrong}，未匹配${unknown}`;
      if (answerError || right !== 10)
        return finish(answerError ? taskErrorResult(answerError, answered > 0).status : "warning",
          [progress, ...state.warnings, "本轮未确认全对，未领奖"].join("；"));
      // 当前轮增量可补全部分回读；独立回读连奖励字段都没有时不领取。
      if (!rewardIds.some(id => ["claimed", "yes", "not"].includes(rewardMap(study)?.[id])))
        return finish("warning", progress + "；答题后奖励状态待核验，未领奖");
      merge(study);
      study = { ...study, taskComplete: { ...roundRewards, ...study.taskComplete } };
    } else {
      progress = "本周已答对10题，仅核对奖励";
    }

    const eligible = rewards(study, "yes");
    if (!eligible.length) {
      if (rewards(study, "claimed").length === 10) return finish("completed", progress + "；回读已领10/10");
      return finish("warning", progress + "；当前无明确可领奖励，剩余状态待核验");
    }
    state.status = "claiming_rewards";
    let claimError: any;
    const latestRewards = { ...study.taskComplete };
    for (const rewardId of eligible) {
      if (latestRewards[rewardId] !== "yes") continue;
      if (attempts) await delay(GAP.reward);
      check();
      attempts++;
      try {
        const receipt = studyFrom(await send("study_claimreward", { rewardId }));
        claimed++;
        if (receipt?.id != null && receipt.id !== round) throw new Error("领奖回包轮次变化，待核验");
        Object.assign(latestRewards, rewardMap(receipt));
      } catch (error) {
        claimError = error;
        state.warnings.push(`奖励${rewardId}：${taskErrorResult(error).detail}`);
        break;
      }
    }
    progress += `；领奖响应${claimed}/${eligible.length}，尝试${attempts}，未发送${eligible.length - attempts}`;
    await delay(GAP.afterRewards);
    const final = await read();
    const confirmed = period(final) === "current" && final.id === round ? rewards(final, "claimed") : [];
    const detail = [progress, ...state.warnings, `最终回读确认已领${confirmed.length}/10`].join("；");
    if (claimError) return finish(taskErrorResult(claimError, answered > 0 || claimed > 0).status, detail);
    return finish(confirmed.length === 10 ? "completed" : "warning", detail);
  } catch (error: any) {
    const result = taskErrorResult(error, answered > 0 || claimed > 0);
    return finish(result.status, [progress, ...state.warnings, result.detail, "停止，未自动重试"].filter(Boolean).join("；"));
  } finally {
    if (client) initial.delete(client);
    state.isAnswering = false;
    await options.close?.();
  }
}

// 两个入口共用锁，先占用再连接，持有到最终回读及连接释放。
export async function runStudy(store: any, tokenId: string, options: Options = {}) {
  const busy = () => ({ status: "skipped", detail: "该账号已有答题正在执行，跳过重复启动", warnings: [] });
  if (active.has(tokenId)) return busy();
  active.add(tokenId);
  try {
    const locks = globalThis.navigator?.locks;
    if (locks) return await locks.request("xyzw-study:" + tokenId, { ifAvailable: true },
      lock => lock ? execute(store, tokenId, options) : busy());
    return await execute(store, tokenId, options);
  } finally { active.delete(tokenId); }
}
