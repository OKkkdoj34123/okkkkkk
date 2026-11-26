/**
 * 从 public/answer.json 加载一键答题数据。
 * 只接受规范化后的完整题目文本匹配；重复记录答案冲突时返回 null。
 */

let questionsPromise = null;

const fetchQuestionsData = async () => {
  const base = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL)
    ? import.meta.env.BASE_URL
    : "/";
  const candidates = [
    `${base.replace(/\/$/, "")}/answer.json`,
    "/answer.json",
    "answer.json",
  ];

  for (const url of candidates) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        try {
          const text = await response.text();
          console.warn(`studyQuestionsFromJSON: ${url} returned non-JSON response (length ${text.length})`);
        } catch {}
        continue;
      }
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (error) {
      console.warn(`studyQuestionsFromJSON: failed to fetch ${url}:`, error);
    }
  }

  console.error("加载答题数据失败：无法找到有效的 answer.json");
  return [];
};

/** 异步加载并缓存题库数据。 */
export async function loadQuestionsData() {
  if (!questionsPromise) questionsPromise = fetchQuestionsData();
  return questionsPromise;
}

/** 统一全半角形式并去除空白；不做包含匹配，避免短题误命中长题。 */
export function normalizeQuestionText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

/** 仅完整匹配；保留 threshold 参数以兼容旧调用方。 */
export function matchQuestion(questionFromDB, actualQuestion, threshold = 1) {
  if (threshold !== 1) return false;
  const databaseText = normalizeQuestionText(questionFromDB);
  const actualText = normalizeQuestionText(actualQuestion);
  return Boolean(databaseText && actualText && databaseText === actualText);
}

const isValidAnswer = (value) =>
  Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 4;

/** 诊断和提交共用一次严格匹配；仅记录题库中的题干和选项序号。 */
export function diagnoseQuestion(question, questions, questionIndex = null, questionId = null) {
  const normalizedQuestionText = normalizeQuestionText(question);
  const rows = Array.isArray(questions) ? questions : [];
  const databaseEntries = normalizedQuestionText
    ? rows.filter(row => row && normalizeQuestionText(row.name) === normalizedQuestionText)
      .map(({ name, value }) => ({ name, value }))
    : [];
  const valid = databaseEntries.filter(row => isValidAnswer(row.value));
  const answers = [...new Set(valid.map(row => row.value))];
  let reason = "matched";
  if (!rows.length) reason = "database_empty";
  else if (!databaseEntries.length) reason = "not_found";
  else if (!valid.length) reason = "invalid_answer";
  else if (answers.length > 1) reason = "conflicting_answers";
  return {
    questionIndex, questionId, questionText: question ?? null, normalizedQuestionText, reason,
    databaseSize: rows.length, matchedRecordCount: databaseEntries.length,
    validRecordCount: valid.length, answerValues: [...new Set(databaseEntries.map(row => row.value))],
    databaseEntries, answer: reason === "matched" ? answers[0] : null,
  };
}

export function findAnswerInQuestions(question, questions) {
  return diagnoseQuestion(question, questions).answer;
}

export async function findAnswer(question) {
  return findAnswerInQuestions(question, await loadQuestionsData());
}

/** 返回可用且答案无冲突的唯一题目数量。 */
export async function getQuestionCount() {
  const questions = await loadQuestionsData();
  const answersByQuestion = new Map();
  for (const item of questions) {
    if (!item || !isValidAnswer(item.value)) continue;
    const key = normalizeQuestionText(item.name);
    if (!key) continue;
    const answers = answersByQuestion.get(key) || new Set();
    answers.add(item.value);
    answersByQuestion.set(key, answers);
  }
  return [...answersByQuestion.values()].filter((answers) => answers.size === 1).length;
}

/** 预加载题库。 */
export async function preloadQuestions() {
  await loadQuestionsData();
}

/** 清除实际使用的Promise缓存，下次调用重新加载。 */
export function clearCache() {
  questionsPromise = null;
}
