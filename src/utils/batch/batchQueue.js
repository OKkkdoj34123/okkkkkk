/**
 * 分批执行队列工具
 *
 * 把账号列表切分为若干批次，并在批次之间插入可中断的延迟。
 * 纯函数实现，便于单元测试；不依赖 Vue 或组件运行时。
 */

/**
 * 规范化分批数量：必须是 1~200 的整数，非法值回退到默认值。
 * @param {*} value 原始输入
 * @param {number} fallback 默认值
 * @returns {number} 合法的分批数量
 */
export const normalizeBatchSize = (value, fallback = 5) => {
  const size = Number(value);
  if (!Number.isFinite(size)) return fallback;
  return Math.min(200, Math.max(1, Math.floor(size)));
};

/**
 * 规范化延迟秒数：必须是 0~600（10分钟）的整数，非法值回退到默认值。
 * @param {*} value 原始输入
 * @param {number} fallback 默认值
 * @returns {number} 合法的延迟秒数
 */
export const normalizeBatchDelay = (value, fallback = 0) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return fallback;
  return Math.min(600, Math.max(0, Math.floor(seconds)));
};

/**
 * 将账号列表按指定大小切分为批次。
 * @param {Array<string>} tokenIds 账号 ID 列表
 * @param {number} batchSize 每批账号数
 * @returns {Array<Array<string>>} 批次数组；空输入返回空数组
 */
export const chunkTokens = (tokenIds, batchSize) => {
  if (!Array.isArray(tokenIds) || tokenIds.length === 0) return [];
  const size = normalizeBatchSize(batchSize);
  const batches = [];
  for (let i = 0; i < tokenIds.length; i += size) {
    batches.push(tokenIds.slice(i, i + size));
  }
  return batches;
};

/**
 * 可中断的延迟等待。每 200ms 检查一次停止标记，
 * 以便"停止"按钮能在延迟期间立即生效。
 * @param {number} ms 等待毫秒数
 * @param {Function} shouldStop 返回 true 表示中止等待
 * @param {Function} sleep 可注入的 sleep，便于测试
 * @returns {Promise<boolean>} true 表示正常等待完成，false 表示被中止
 */
export const waitWithStop = async (
  ms,
  shouldStop = () => false,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
) => {
  const total = Math.max(0, Number(ms) || 0);
  if (total === 0) return !shouldStop();
  const step = 200;
  let elapsed = 0;
  while (elapsed < total) {
    if (shouldStop()) return false;
    const duration = Math.min(step, total - elapsed);
    await sleep(duration);
    elapsed += duration;
  }
  return !shouldStop();
};
