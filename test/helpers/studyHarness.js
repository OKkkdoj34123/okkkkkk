// Synthetic server for the same runStudy entry point used by the card and batch.
import { readFileSync } from "node:fs";
import { runStudy, StudyPlugin } from "../../src/stores/events/study.ts";
import { loadQuestionsData } from "../../src/utils/studyQuestionsFromJSON.js";

export const rows = JSON.parse(readFileSync(new URL("../../public/answer.json", import.meta.url), "utf8"));
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
  await loadQuestionsData();
} finally { globalThis.fetch = originalFetch; }

export function harness(options = {}) {
  const id = options.id ?? "A";
  const ids = Array.from({ length: 10 }, (_, i) => i + 1);
  const now = Math.floor(Date.now() / 1000);
  const questions = ids.map(i => ({ id: i, question: rows[i].name }));
  const study = {
    id: 42, beginTime: now, maxCorrectNum: 0, totRightNum: 18,
    taskComplete: Object.fromEntries(ids.map(i => [i, "not"])),
    question: ids.map(i => ({ id: i, state: "init" })),
    ...options.initial,
  };
  const snapshot = () => ({ role: { study: structuredClone(study) } });
  const calls = [];
  let elapsed = 0;
  let reads = 0;
  const client = { async sendWithPromise(cmd, params) {
    calls.push({ cmd, params, at: elapsed });
    if (cmd === "role_getroleinfo") {
      reads++;
      return options.read ? await options.read(snapshot(), reads) : snapshot();
    }
    if (cmd === "study_startgame") {
      study.id++;
      study.question = ids.map(i => ({ id: i, state: "init" }));
      study.beginTime = now;
      return { role: { study: { id: study.id, beginTime: now } }, questionList: questions };
    }
    if (cmd === "study_answer") {
      const qid = params.questionId[0];
      if (qid === options.answerFailure) throw Object.assign(new Error("服务器错误: 400340"), { code: 400340 });
      study.question[qid - 1].state = options.wrong === qid ? "wrong" : "right";
      const count = study.question.filter(q => q.state === "right").length;
      study.maxCorrectNum = Math.max(study.maxCorrectNum, count);
      if (count && study.taskComplete[count] !== "claimed") study.taskComplete[count] = "yes";
      return { role: { study: { taskComplete: { [count]: study.taskComplete[count] } } } };
    }
    if (cmd === "study_claimreward") {
      if (params.rewardId === options.claimFailure) {
        if (options.timeout) throw new Error("timeout");
        throw Object.assign(new Error("服务器错误: 3100060"), { code: 3100060 });
      }
      study.taskComplete[params.rewardId] = "claimed";
      return snapshot();
    }
    throw new Error("Unexpected command " + cmd);
  } };
  const store = options.store ?? { gameData: {}, clients: {}, getWebSocketClient(key) { return this.clients[key]; } };
  store.clients[id] = client;
  const handlers = new Map();
  StudyPlugin({ onSome: (events, listener) => events.forEach(e => handlers.set(e, listener)) });
  const initialize = (body = snapshot(), tokenId = id) => handlers.get("I-study")({ tokenId, client, body });
  if (options.cache !== false) initialize();
  return {
    study, store, calls, questions, initialize, handlers,
    run: (extra = {}) => runStudy(store, id, { delay: async ms => { elapsed += ms; }, ...extra }),
    of: cmd => calls.filter(c => c.cmd === cmd),
  };
}
export const marked = (best, claimed = best) => ({
  maxCorrectNum: best,
  taskComplete: Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
    [i + 1, i < claimed ? "claimed" : i < best ? "yes" : "not"])),
});
