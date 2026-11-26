import { getMainStageLevel } from "../gameFeatureUnlocks.js";

export const MARKET_LIST_STAGE = 4000;

// 商店1。basePrice 是整组原价，由两份手动购买记录的折扣、奖励和扣款换算。
export const lowMarketGoods = [
  { goodsId: 1, itemId: 2002, name: "青铜宝箱", quantity: 2, basePrice: 400, defaultLimit: 200 },
  { goodsId: 2, itemId: 2003, name: "黄金宝箱", quantity: 1, basePrice: 375, defaultLimit: 200 },
  { goodsId: 3, itemId: 2004, name: "铂金宝箱", quantity: 1, basePrice: 625, defaultLimit: 500 },
  { goodsId: 11, itemId: 1011, name: "普通鱼竿", quantity: 10, basePrice: 1000, defaultLimit: 400 },
  { goodsId: 12, itemId: 1012, name: "黄金鱼竿", quantity: 5, basePrice: 2500, defaultLimit: 1999 },
];

export function defaultLowMarketLimits() {
  return Object.fromEntries(lowMarketGoods.map(g => [g.goodsId, g.defaultLimit]));
}

// 旧配置没有这个键时使用初始值。损坏、清空或缺项的已保存清单需要用户修正。
export function validLowMarketLimits(limits) {
  return limits != null && typeof limits === "object" && !Array.isArray(limits) &&
    lowMarketGoods.every(({ goodsId }) => Number.isSafeInteger(limits[goodsId]) && limits[goodsId] >= 0);
}

function savedLimits() {
  const raw = globalThis.localStorage?.getItem("batchSettings");
  const settings = raw == null ? {} : JSON.parse(raw);
  return settings.lowMarketLimits === undefined ? defaultLowMarketLimits() : settings.lowMarketLimits;
}

class MarketEvidenceError extends Error {}
const activeRoles = new Set();

const wholeNumber = value =>
  (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) && Number(value) >= 0;

function pageNumber(shelf) {
  // BON 实服第0页省略 refresh；11月12日三账号完整货架均如此。
  // 只接受字段省略对应的协议默认0，显式 null/非法值仍须停止。
  const refresh = shelf?.refresh === undefined ? 0 : shelf.refresh;
  if (!wholeNumber(refresh) || !shelf?.goodsList || typeof shelf.goodsList !== "object" || Array.isArray(shelf.goodsList)) {
    throw new MarketEvidenceError("货架缺少刷新次数或商品列表");
  }
  return Number(refresh);
}

function offer(shelf, goods) {
  const row = shelf.goodsList[goods.goodsId];
  if (!wholeNumber(row?.buy_quantity)) throw new MarketEvidenceError(goods.name + "缺少已购数量");
  if (Number(row.buy_quantity) > 0) return null;
  const discount = row.discount;
  const tenths = Math.round(discount * 10);
  if (typeof discount !== "number" || !Number.isFinite(discount) || tenths < 1 || tenths > 10 ||
      Math.abs(discount * 10 - tenths) > 0.00001) {
    throw new MarketEvidenceError(goods.name + "折扣无法确认");
  }
  return goods.basePrice * tenths / 10;
}

function roleBalance(role) {
  if (!wholeNumber(role?.diamond)) throw new MarketEvidenceError("完整角色信息缺少金砖余额");
  return Number(role.diamond);
}

function marketStage(role) {
  const stage = getMainStageLevel(role);
  if (!wholeNumber(role?.levelId) || !(stage > 0)) throw new MarketEvidenceError("主线关卡待核验");
  return stage;
}

const result = (taskStatus, detail) => ({ taskStatus, detail, ...(taskStatus === "warning"
  ? { verificationRequired: true, verificationDetails: [detail] } : {}) });

async function withRoleLock(key, action) {
  const busy = () => result("skipped", "本账号黑市采购正在执行，跳过重复入口");
  if (globalThis.navigator?.locks?.request) {
    return globalThis.navigator.locks.request("xyzw-daily-market:" + key, { ifAvailable: true },
      lock => lock ? action() : busy());
  }
  if (activeRoles.has(key)) return busy();
  activeRoles.add(key);
  try { return await action(); }
  finally { activeRoles.delete(key); }
}

export async function runDailyBlackMarket({ tokenId, send, initialRole, daily = false,
  getLimits = savedLimits, storage, stopped = () => false }) {
  let spent = 0, groups = 0, refreshes = 0, overLimit = 0, sold = 0, unaffordable = 0;
  const quantities = new Map();
  const summary = () => {
    const items = [...quantities].map(([name, n]) => name + "×" + n).join("、");
    return `已确认${groups}组${items ? "（" + items + "）" : ""}，扣${spent}金砖，刷新${refreshes}次`;
  };

  async function request(cmd, params = {}) {
    if (stopped()) throw Object.assign(new Error("用户已停止采购"), { stopped: true });
    let response;
    try { response = await send(cmd, params); }
    catch (error) {
      if (error instanceof Error) {
        error.requestCmd ??= cmd;
        if (error.code != null && !error.message.includes(String(error.code))) error.message += " [" + error.code + "]";
      }
      throw error;
    }
    if (response?.error || (response?.code != null && Number(response.code) !== 0)) {
      throw Object.assign(new Error(`${cmd} 返回 ${response.code ?? response.error}`), { code: response.code, requestCmd: cmd });
    }
    return response?._rawData ?? response?.data ?? response?.body ?? response;
  }
  const readRole = async () => (await request("role_getroleinfo"))?.role;

  try {
    const justRead = !wholeNumber(initialRole?.levelId) || Number(initialRole.levelId) <= 0;
    const role = justRead ? await readRole() : initialRole;
    const stage = marketStage(role);
    const roleKey = String(role.roleId || tokenId);
    return await withRoleLock(roleKey, async () => {
      if (stage >= MARKET_LIST_STAGE) {
        if (daily && role.dailyTask?.complete?.[12] === -1) return result("skipped", "日常黑市任务已完成");
        if (await request("store_purchase", { goodsId: 1 }) == null) throw new MarketEvidenceError("采购清单回包为空");
        return result("completed", `主线${stage}关，服务器采购清单请求已响应`);
      }

      let limits;
      try { limits = getLimits(); } catch { throw new MarketEvidenceError("无法读取本机低关卡限价配置"); }
      if (!validLowMarketLimits(limits)) throw new MarketEvidenceError("低关卡限价无效，请在黑市清单配置中保存五项整组限价");
      limits = { ...limits };
      const enabled = lowMarketGoods.filter(g => limits[g.goodsId] > 0);
      if (!enabled.length) return result("skipped", "五项整组限价均为0，跳过低关卡采购");

      const freshBalance = async () => {
        const fresh = await readRole();
        if (marketStage(fresh) >= MARKET_LIST_STAGE || String(fresh.roleId || tokenId) !== roleKey) {
          throw new MarketEvidenceError("完整回读的账号或主线分组发生变化");
        }
        return roleBalance(fresh);
      };
      // 日常任务较早读取过角色；采购时重新取余额。独立入口刚刚读取了完整角色。
      let balance = justRead ? roleBalance(role) : await freshBalance();
      const readShelf = () => request("store_goodslist", { storeId: 1 });
      let shelf = await readShelf();
      let page = pageNumber(shelf);
      // 按角色记录首刷。丢失回包时即使另一入口仍读到第0页，也不能再尝试可能收费的第二刷。
      const reset = Number(role.dailyTask?.dailyTime);
      const gameDay = String(Math.floor(((reset > 0 ? reset : Date.now() / 1000) + 8 * 3600) / 86400));
      const refreshKey = "xyzw-daily-market-first-refresh:" + roleKey;
      let ledger;
      if (page === 0) {
        let previous;
        try { ledger = storage ?? globalThis.localStorage; previous = ledger.getItem(refreshKey); }
        catch { throw new MarketEvidenceError("无法读取首刷记录"); }
        if (previous === gameDay) throw new MarketEvidenceError("当天已发送首刷，服务器仍为第0页，请核对游戏内货架");
      }
      for (;;) {
        // 先核验每个启用货架，再执行本页购买。每次回执都会替换/重新读取货架。
        for (const goods of enabled) offer(shelf, goods);
        for (const goods of enabled) {
          const exact = offer(shelf, goods);
          if (exact === null) { sold++; continue; }
          const ceiling = Math.ceil(exact);
          if (ceiling > limits[goods.goodsId]) { overLimit++; continue; }
          if (ceiling > balance) { unaffordable++; continue; }

          const receipt = await request("store_buy", { goodsId: goods.goodsId });
          const rewards = receipt?.reward;
          const nextBalance = receipt?.role?.diamond;
          if (!Array.isArray(rewards) || rewards.length !== 1 || Number(rewards[0]?.itemId) !== goods.itemId ||
              Number(rewards[0]?.value) !== goods.quantity || !wholeNumber(nextBalance)) {
            throw new MarketEvidenceError(goods.name + "购买回包的奖励或余额待核验");
          }
          const charge = balance - Number(nextBalance);
          if (charge < Math.floor(exact) || charge > ceiling) {
            throw new MarketEvidenceError(`${goods.name}预计${ceiling}金砖以内，余额实差${charge}，已停止后续采购`);
          }
          // 部分协议只回增量。缺全页时只读回货架，不重复发购买。
          shelf = receipt;
          if (!wholeNumber(shelf.refresh) || !enabled.every(g => shelf.goodsList?.[g.goodsId] != null)) shelf = await readShelf();
          if (pageNumber(shelf) !== page || Number(shelf.goodsList[goods.goodsId]?.buy_quantity) !== 1) {
            throw new MarketEvidenceError(goods.name + "的购买页次或已购次数待核验");
          }
          balance = Number(nextBalance);
          spent += charge;
          groups++;
          quantities.set(goods.name, (quantities.get(goods.name) || 0) + goods.quantity);
        }
        if (page !== 0 || !enabled.some(g => Math.ceil(g.basePrice / 10) <= Math.min(limits[g.goodsId], balance))) break;
        // 首刷前再读一次，避免在手动操作已翻页后发送第二次刷新。
        if (pageNumber(await readShelf()) !== 0) throw new MarketEvidenceError("首刷前货架已换页");
        if (stopped()) throw Object.assign(new Error("用户已停止采购"), { stopped: true });
        try {
          ledger.setItem(refreshKey, gameDay);
          if (ledger.getItem(refreshKey) !== gameDay) throw new Error();
        } catch { throw new MarketEvidenceError("无法保存本账号首刷记录"); }
        try { shelf = await request("store_refresh", { storeId: 1 }); }
        catch (error) {
          // 有明确拒绝回包时允许用户另行执行；超时和断线仍保留当日记录。
          if (Number(error?.code) > 0 && ledger.getItem(refreshKey) === gameDay) ledger.removeItem(refreshKey);
          throw error;
        }
        if (!wholeNumber(shelf?.refresh) || !enabled.every(g => shelf?.goodsList?.[g.goodsId] != null)) shelf = await readShelf();
        page = pageNumber(shelf);
        if (page !== 1) throw new MarketEvidenceError("首次刷新后的页次待核验");
        refreshes++;
        // 抓包中刷新增量的 diamond 为0。只使用完整回读核对首次刷新未额外扣款。
        if (await freshBalance() !== balance) throw new MarketEvidenceError("刷新前后金砖余额不一致，已停止第二页采购");
      }
      return result(groups || refreshes ? "completed" : "skipped",
        `主线${stage}关，${summary()}；已购${sold}档、超价${overLimit}档、余额不足${unaffordable}档`);
    });
  } catch (error) {
    if (error instanceof MarketEvidenceError) return result("warning", `待核验：${error.message}；${summary()}`);
    // 保留上层的断线/取消和错误码处理；当前市场流程不重发写命令。
    if (error instanceof Error && (groups || refreshes)) {
      error.marketProgress = true;
      error.message += "；" + summary();
    }
    throw error;
  }
}
