/**
 * GitHub Pages SPA 回退：404.html 把原始路径编码到 ?spa-redirect=。
 *
 * 必须在 vue-router 创建 history 之前执行 —— createWebHistory() 会在模块求值时
 * 同步快照当前 location，晚于此还原会让初始导航落在 ?spa-redirect= 上并渲染
 * 错误路由（刷新深层页面会跳回首页）。
 *
 * 由 main.js 的第一个 import 引入，保证早于 `import router from "./router"`。
 */
try {
  const params = new URLSearchParams(window.location.search);
  const redirected = params.get("spa-redirect");
  if (redirected) {
    // 保留 history.state，避免清掉 vue-router 写入的状态对象
    window.history.replaceState(window.history.state, "", redirected);
  }
} catch (e) {
  console.warn("SPA redirect restore failed", e);
}
