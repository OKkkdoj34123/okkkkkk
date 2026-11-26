// 商人配置
export const merchantConfig = {
  1: {
    name: "初级商人",
    items: [
      "进阶石",
      "精铁",
      "木质宝箱",
      "青铜宝箱",
      "普通鱼竿",
      "咸神门票",
      "咸神火把",
    ],
  },
  2: {
    name: "中级商人",
    items: [
      "梦魇晶石",
      "进阶石",
      "精铁",
      "黄金宝箱",
      "黄金鱼竿",
      "招募令",
      "橙将碎片",
      "紫将碎片",
    ],
  },
  3: {
    name: "高级商人",
    items: [
      "梦魇晶石",
      "铂金宝箱",
      "黄金鱼竿",
      "招募令",
      "红将碎片",
      "橙将碎片",
      "红将碎片",
      "普通鱼竿",
    ],
  },
};

// 金币购买的商品配置 [商人ID][商品索引]
export const goldItemsConfig = {
  1: [5, 6], // 初级商人: 咸神门票, 咸神火把
  2: [6, 7], // 中级商人: 橙将碎片, 紫将碎片
  3: [5, 6, 7], // 高级商人: 橙将碎片, 红将碎片, 普通鱼竿
};

// 检查梦境开放时间（周三/周四/周日/周一）
export function isDungeonOpen() {
  const now = new Date();
  const day = now.getDay(); // 0=周日, 1=周一, 2=周二, 3=周三, 4=周四, 5=周五, 6=周六
  return day === 0 || day === 1 || day === 3 || day === 4; // 周日、周一、周三、周四
}

// DREAM_PURCHASE_TEMPLATES_V1
// 商品索引沿用 merchantConfig；高级金币红将碎片是3-6，不是3-4。
export const dreamPurchaseTemplates = Object.freeze([
  Object.freeze({ id: "low", name: "主公小于4000", rule: "自动：主公等级≤4000（含4000级）",
    items: Object.freeze(["1-2", "1-3", "1-5", "1-6", "3-1", "3-2", "3-7"]) }),
  Object.freeze({ id: "high", name: "主公大于4000", rule: "自动：主公等级>4000",
    items: Object.freeze(["1-2", "1-3", "1-5", "1-6", "2-7", "2-6", "3-1", "3-2", "3-7", "3-5", "3-6"]) }),
  Object.freeze({ id: "blackMarket", name: "黑市周", rule: "手动开启，优先于自动模板",
    items: Object.freeze(["1-2", "1-3", "1-5", "1-6", "2-7", "2-6", "2-3", "2-4", "3-1", "3-2", "3-7", "3-5", "3-6"]) }),
]);

export function dreamPurchaseItemLabel(merchantId, index) {
  const name = merchantConfig[merchantId]?.items?.[index] ?? "未知商品";
  if (Number(merchantId) === 3 && Number(index) === 6) return `${name}（金币）`;
  if (Number(merchantId) === 3 && Number(index) === 4) return `${name}（非金币）`;
  return name;
}

export function dreamPurchaseTemplateSummary(template, merchantId) {
  const prefix = `${merchantId}-`;
  return template.items.filter(key => key.startsWith(prefix))
    .map(key => dreamPurchaseItemLabel(merchantId, Number(key.split("-")[1]))).join("、") || "不购买";
}

export function resolveDreamPurchasePlan(settings, role) {
  const raw = role?.level; // 主公等级；不能使用主线关卡levelId或武将等级替代。
  const numeric = typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw.trim()));
  const level = numeric && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : null;
  let name, keys;
  if (settings.dreamPurchaseManualEnabled === true) {
    name = "单独勾选";
    if (!Array.isArray(settings.dreamPurchaseList)) throw new Error("单独购买清单格式无效");
    keys = settings.dreamPurchaseList;
  } else if (settings.dreamPurchaseBlackMarketEnabled === true) {
    name = dreamPurchaseTemplates[2].name;
    keys = dreamPurchaseTemplates[2].items;
  } else {
    if (level === null) return { name: "自动识别", level, items: [], reason: "未能读取有效主公等级，已跳过购买" };
    const template = dreamPurchaseTemplates[level > 4000 ? 1 : 0];
    name = template.name;
    keys = template.items;
  }
  const items = [...new Set(keys)].map(key => {
    if (typeof key !== "string" || !/^[1-3]-\d+$/.test(key)) throw new Error("梦境购买清单格式无效");
    const [merchantId, index] = key.split("-").map(Number);
    if (!merchantConfig[merchantId]?.items?.[index]) throw new Error(`未识别的梦境商品：${key}`);
    return { merchantId, index };
  });
  return { name, level, items, reason: items.length ? null : "单独购买已开启但未勾选商品，已跳过购买" };
}
