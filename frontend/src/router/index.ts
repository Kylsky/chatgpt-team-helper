import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '../views/LoginView.vue'
import RegisterView from '../views/RegisterView.vue'
import RedeemView from '../views/RedeemView.vue'
import GenericRedeemView from '../views/GenericRedeemView.vue'
import AccountRecoveryView from '../views/AccountRecoveryView.vue'
import LinuxDoRedeemView from '../views/LinuxDoRedeemView.vue'
import LinuxDoOpenAccountsView from '../views/LinuxDoOpenAccountsView.vue'
import XhsRedeemView from '../views/XhsRedeemView.vue'
import XianyuRedeemView from '../views/XianyuRedeemView.vue'
import PurchaseCatalogView from '../views/PurchaseCatalogView.vue'
import PurchaseProductView from '../views/PurchaseProductView.vue'
import OrderView from '../views/OrderView.vue'
import WaitingRoomView from '../views/WaitingRoomView.vue'
import MainLayout from '../views/MainLayout.vue'
import AccountsView from '../views/AccountsView.vue'
import UserManagementView from '../views/UserManagementView.vue'
import SettingsView from '../views/SettingsView.vue'
import RedemptionCodesView from '../views/RedemptionCodesView.vue'
import AppleShowcase from '../views/AppleShowcase.vue'
import WaitingRoomAdminView from '../views/WaitingRoomAdminView.vue'
import XhsOrdersView from '../views/XhsOrdersView.vue'
import XianyuOrdersView from '../views/XianyuOrdersView.vue'
import PurchaseOrdersView from '../views/PurchaseOrdersView.vue'
import CreditOrdersView from '../views/CreditOrdersView.vue'
import AccountRecoveryAdminView from '../views/AccountRecoveryAdminView.vue'
import StatsView from '../views/StatsView.vue'
import MyOrdersView from '../views/MyOrdersView.vue'
import UserInfoView from '../views/UserInfoView.vue'
import PointsExchangeView from '../views/PointsExchangeView.vue'
import RoleManagementView from '../views/RoleManagementView.vue'
import MenuManagementView from '../views/MenuManagementView.vue'
import { authService } from '@/services/api'
import FeatureDisabledView from '../views/FeatureDisabledView.vue'
import { useAppConfigStore } from '@/stores/appConfig'
import { pinia } from '@/stores/pinia'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/login',
    },
    {
      path: '/feature-disabled/:feature',
      name: 'feature-disabled',
      component: FeatureDisabledView,
    },
    {
      path: '/buy',
      name: 'purchase',
      redirect: { name: 'purchase-catalog' },
      meta: { featureKey: 'payment' }
    },
    {
      path: '/purchase',
      name: 'purchase-catalog',
      component: PurchaseCatalogView,
      meta: { featureKey: 'payment' },
    },
    {
      path: '/purchase/:productKey',
      name: 'purchase-product',
      component: PurchaseProductView,
      meta: { featureKey: 'payment' },
    },
    {
      path: '/order',
      name: 'order',
      component: OrderView,
      meta: { featureKey: 'payment' },
    },
    {
      path: '/login',
      name: 'login',
      component: LoginView,
    },
    {
      path: '/register',
      name: 'register',
      component: RegisterView,
    },
    {
      path: '/redeem/common',
      name: 'redeem',
      component: RedeemView,
    },
    {
      path: '/redeem/account-recovery',
      name: 'account-recovery',
      component: AccountRecoveryView,
    },
    {
      path: '/redeem/linux-do',
      name: 'linux-do-redeem',
      component: LinuxDoRedeemView,
    },
    {
      path: '/linux-do/open-accounts',
      redirect: '/redeem/open-accounts',
    },
    {
      path: '/redeem/open-accounts',
      name: 'linux-do-open-accounts',
      component: LinuxDoOpenAccountsView,
      meta: { featureKey: 'openAccounts' },
    },
    {
      path: '/redeem/xhs',
      name: 'xhs-redeem',
      component: XhsRedeemView,
      meta: { featureKey: 'xhs' },
    },
    {
      path: '/redeem/xianyu',
      name: 'xianyu-redeem',
      component: XianyuRedeemView,
      meta: { featureKey: 'xianyu' },
    },
    {
      path: '/redeem/:channelKey',
      name: 'generic-redeem',
      component: GenericRedeemView,
    },
    {
      path: '/waiting-room',
      name: 'waiting-room',
      component: WaitingRoomView,
    },
    {
      path: '/apple-showcase',
      name: 'apple-showcase',
      component: AppleShowcase,
    },
    {
      path: '/admin',  // 将管理后台路径改为 /admin
      component: MainLayout,
      meta: { requiresAuth: true },
      redirect: () => {
        const currentUser = authService.getCurrentUser()
        const roles = Array.isArray(currentUser?.roles) ? currentUser.roles.map(String) : []
        return roles.includes('super_admin') ? '/admin/accounts' : '/admin/user-info'
      },
      children: [
        {
          path: 'user-info',
          name: 'user-info',
          component: UserInfoView,
          meta: { requiredMenuKey: 'user_info' },
        },
        {
          path: 'my-orders',
          name: 'my-orders',
          component: MyOrdersView,
          meta: { requiredMenuKey: 'my_orders' },
        },
        {
          path: 'points-exchange',
          name: 'points-exchange',
          component: PointsExchangeView,
          meta: { requiredMenuKey: 'points_exchange' },
        },
        {
          path: 'accounts',
          name: 'accounts',
          component: AccountsView,
          meta: { requiredMenuKey: 'accounts' },
        },
        {
          path: 'account-recovery',
          name: 'account-recovery-admin',
          component: AccountRecoveryAdminView,
          meta: { requiredMenuKey: 'account_recovery', superAdminOnly: true },
        },
        {
          path: 'stats',
          name: 'stats',
          component: StatsView,
          meta: { requiredMenuKey: 'stats', superAdminOnly: true },
        },
        {
          path: 'users',
          name: 'user-management',
          component: UserManagementView,
          meta: { requiredMenuKey: 'user_management' },
        },
        {
          path: 'redemption-codes',
          name: 'redemption-codes',
          component: RedemptionCodesView,
          meta: { requiredMenuKey: 'redemption_codes' },
        },
        {
          path: 'xhs-orders',
          name: 'xhs-orders',
          component: XhsOrdersView,
          meta: { requiredMenuKey: 'xhs_orders', featureKey: 'xhs' },
        },
        {
          path: 'xianyu-orders',
          name: 'xianyu-orders',
          component: XianyuOrdersView,
          meta: { requiredMenuKey: 'xianyu_orders', featureKey: 'xianyu' },
        },
        {
          path: 'purchase-orders',
          name: 'purchase-orders',
          component: PurchaseOrdersView,
          meta: { requiredMenuKey: 'purchase_orders', featureKey: 'payment' },
        },
        {
          path: 'credit-orders',
          name: 'credit-orders',
          component: CreditOrdersView,
          meta: { requiredMenuKey: 'credit_orders', featureKey: 'openAccounts' },
        },
        {
          path: 'waiting-room',
          name: 'waiting-room-admin',
          component: WaitingRoomAdminView,
          meta: { requiredMenuKey: 'waiting_room' },
        },
        {
          path: 'settings',
          name: 'settings',
          component: SettingsView,
          meta: { requiredMenuKey: 'settings' },
        },
        {
          path: 'roles',
          name: 'role-management',
          component: RoleManagementView,
          meta: { requiredMenuKey: 'role_management', superAdminOnly: true },
        },
        {
          path: 'menus',
          name: 'menu-management',
          component: MenuManagementView,
          meta: { requiredMenuKey: 'menu_management', superAdminOnly: true },
        },
        {
          path: 'feature-disabled/:feature',
          name: 'admin-feature-disabled',
          component: FeatureDisabledView,
        },
      ]
    },
  ],
})

// Navigation guard
router.beforeEach(async (to, from, next) => {
  const appConfigStore = useAppConfigStore(pinia)
  await appConfigStore.loadConfig()

  const requiredFeatureKey = String((to.meta as any)?.featureKey || '').trim()
  if (requiredFeatureKey) {
    const flags: any = appConfigStore.features || {}
    const enabled =
      requiredFeatureKey === 'xhs'
        ? flags.xhs !== false
        : requiredFeatureKey === 'xianyu'
          ? flags.xianyu !== false
          : requiredFeatureKey === 'payment'
            ? flags.payment !== false
            : requiredFeatureKey === 'openAccounts'
              ? flags.openAccounts !== false
              : true

    if (!enabled) {
      const query = { from: to.fullPath }
      if (to.path.startsWith('/admin')) {
        next({ name: 'admin-feature-disabled', params: { feature: requiredFeatureKey }, query })
        return
      }
      next({ name: 'feature-disabled', params: { feature: requiredFeatureKey }, query })
      return
    }
  }

  const isAuthenticated = authService.isAuthenticated()
  const currentUser = authService.getCurrentUser()
  const roles = Array.isArray(currentUser?.roles) ? currentUser.roles.map(String) : []
  const menus = Array.isArray(currentUser?.menus) ? currentUser.menus.map(String) : []
  const isSuperAdmin = roles.includes('super_admin')
  const defaultAdminPath = isSuperAdmin ? '/admin/accounts' : '/admin/user-info'

  if (to.meta.requiresAuth && !isAuthenticated) {
    next('/login')
    return
  }

  if ((to.path === '/login' || to.path === '/register') && isAuthenticated) {
    next(defaultAdminPath)
    return
  }

  const superAdminOnly = Boolean((to.meta as any)?.superAdminOnly)
  if (to.meta.requiresAuth && superAdminOnly && !isSuperAdmin) {
    next(defaultAdminPath)
    return
  }

  const requiredMenuKey = String((to.meta as any)?.requiredMenuKey || '').trim()
  if (to.meta.requiresAuth && requiredMenuKey) {
    const alwaysAllowed = requiredMenuKey === 'user_info' || requiredMenuKey === 'my_orders'
    if (!isSuperAdmin && !alwaysAllowed && !menus.includes(requiredMenuKey)) {
      next(defaultAdminPath)
      return
    }
  }

  next()
})

export default router
