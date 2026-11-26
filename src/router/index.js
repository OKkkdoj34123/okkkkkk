import { createRouter, createWebHistory } from 'vue-router'
import * as autoRoutes from "vue-router/auto-routes";
import { useTokenStore } from '@/stores/tokenStore'
import { isNowInLegionWarTime } from "@/utils/clubBattleUtils"

const generatedRoutes = autoRoutes.routes ?? [];

const my_routes = [
  {
    path: '/',
    name: 'Home',
    component: () => import('@/views/Home.vue'),
    meta: {
      title: '首页',
      requiresToken: false
    }
  },
  {
    path: '/game',
    name: 'GamePlayer',
    component: () => import('@/views/GamePlayer.vue'),
    meta: {
      title: '游戏',
      requiresToken: true
    },
    props: route => ({
      bin_id: route.query.bin_id
    })
  },
  {
    name: 'DefaultLayout',
    path: '/admin',
    component: () => import('@/layout/DefaultLayout.vue'),
    children: [
      // Absolute path keeps existing links and import query parameters.
      {
        path: '/tokens',
        name: 'TokenImport',
        component: () => import('@/views/TokenImport/index.vue'),
        meta: {
          title: 'Token管理',
          requiresToken: false
        },
        props: route => ({
          token: route.query.token,
          name: route.query.name,
          server: route.query.server,
          wsUrl: route.query.wsUrl,
          api: route.query.api,
          auto: route.query.auto === 'true'
        })
      },

      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: {
          title: '控制台',
          requiresToken: true
        }
      },
      {
        path: 'game-features',
        name: 'GameFeatures',
        component: () => import('@/views/GameFeatures.vue'),
        meta: {
          title: '游戏功能',
          requiresToken: true
        }
      },
      {
        path: 'message-test',
        name: 'MessageTest',
        component: () => import('@/components/Test/MessageTester.vue'),
        meta: {
          title: '消息测试',
          requiresToken: true
        }
      },
      {
        path: 'legion-war',
        name: 'LegionWar',
        component: () => import('@/views/LegionWar.vue'),
        meta: {
          title: '实时盐场',
          requiresToken: true
        }
      },
      {
        path: 'profile',
        name: 'Profile',
        component: () => import('@/views/Profile.vue'),
        meta: {
          title: '个人设置',
          requiresToken: true
        }
      },
      {
        path: 'daily-tasks',
        name: 'DailyTasks',
        component: () => import('@/views/DailyTasks.vue'),
        meta: {
          title: '日常任务',
          requiresToken: true
        }
      },
      {
        path: 'batch-daily-tasks',
        name: 'BatchDailyTasks',
        component: () => import('@/views/BatchDailyTasks.vue'),
        meta: {
          title: '批量日常',
          requiresToken: true
        }
      },
      {
        path: 'PushingLevels',
        name: 'PushingLevels',
        component: () => import('@/views/PushingLevels.vue'),
        meta: {
          title: '主线推关',
          requiresToken: true
        }
      },
      // 增加自动路由引用
      ...generatedRoutes,
    ]
  },
  {
    path: '/websocket-test',
    name: 'WebSocketTest',
    component: () => import('@/components/Test/WebSocketTester.vue'),
    meta: {
      title: 'WebSocket测试',
      requiresToken: true
    }
  },
  // 兼容旧路由，重定向到新的token管理页面
  {
    path: '/login',
    redirect: '/tokens'
  },
  {
    path: '/register',
    redirect: '/tokens'
  },
  {
    path: '/game-roles',
    redirect: '/tokens'
  },
  // 增加自动路由引用
  ...generatedRoutes,
  {
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@/views/NotFound.vue'),
    meta: {
      title: '页面不存在'
    }
  }
]

// GitHub Pages SPA 回退：404.html 把原始路径编码到 ?spa-redirect=。
// 必须在 createWebHistory() 之前还原——history 会在创建时快照当前 location，
// 若晚于快照还原，初始导航会把地址改回 ?spa-redirect= 并渲染错误路由。
// 前置分号：避免上一行数组字面量 ] 与本 IIFE 的 ( 被解析成函数调用（ASI 陷阱）
;(function restoreSpaRedirect() {
  try {
    const params = new URLSearchParams(window.location.search)
    const redirected = params.get('spa-redirect')
    if (!redirected) return
    window.history.replaceState(null, '', redirected)
  } catch (e) {
    console.warn('SPA redirect restore failed', e)
  }
})();

const router = createRouter({
  history: createWebHistory(),
  routes: my_routes,
  scrollBehavior(to, from, savedPosition) {
    if (to.name === 'BatchDailyTasks' && to.query.restore === '1') return { el: '#config-transfer' }
    if (savedPosition) {
      return savedPosition
    } else {
      return { top: 0 }
    }
  }
})

// 导航守卫
router.beforeEach((to, from, next) => {
  const tokenStore = useTokenStore()

  // 设置页面标题
  document.title = to.meta.title ? `${to.meta.title} - XYZW 游戏管理系统` : 'XYZW 游戏管理系统'
  if(to.name==="LegionWar"&&!isNowInLegionWarTime()){
  // if(to.name==="LegionWar"&&isNowInLegionWarTime()){
    next('/admin/dashboard');
    return;
  }
  const restoringConfig = to.name === 'BatchDailyTasks' && to.query.restore === '1'
  if (to.meta.requiresToken && !tokenStore.hasTokens && !restoringConfig) {
    next('/tokens')
  } else if (to.path === '/' && tokenStore.hasTokens) {
    // 首页重定向逻辑
    if (tokenStore.selectedToken) {
      next('/admin/dashboard')
    } else {
      next('/tokens')
    }
  } else {
    next()
  }
})



export default router
