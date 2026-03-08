<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue'
import { authService, userService, adminService, versionService, purchaseService } from '@/services/api'
import type { VersionInfo, LatestVersionInfo, Channel, PurchaseProduct, PurchaseMeta, PurchaseOrderType } from '@/services/api'
import { useAppConfigStore } from '@/stores/appConfig'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AnnouncementAdminPanel from '@/components/AnnouncementAdminPanel.vue'
import { Eye, EyeOff, Sparkles, KeyRound, AlertCircle, CheckCircle2, RefreshCw, Settings, CreditCard, Link, Mail, Shield } from 'lucide-vue-next'

const teleportReady = ref(false)
const activeTab = ref<'settings' | 'announcements'>('settings')
const settingsSubTab = ref('general')

const settingsNav = [
  { id: 'general', label: '基础设置', desc: '功能开关、白名单与补录', icon: Settings },
  { id: 'billing', label: '支付与财务', desc: '商品、支付通道与提现', icon: CreditCard },
  { id: 'integrations', label: '第三方集成', desc: 'OAuth、验证与机器人', icon: Link },
  { id: 'notifications', label: '邮件与通知', desc: 'SMTP 告警邮件配置', icon: Mail },
  { id: 'security', label: '核心与安全', desc: 'API 密钥与渠道管理', icon: Shield },
]

const activeNavItem = computed(() => settingsNav.find(n => n.id === settingsSubTab.value))

// 版本检查相关
const versionLoading = ref(false)
const versionDialogOpen = ref(false)
const currentVersion = ref<VersionInfo | null>(null)
const latestVersion = ref<LatestVersionInfo | null>(null)
const versionError = ref('')

const hasNewVersion = computed(() => {
  if (!currentVersion.value || !latestVersion.value) return false
  return currentVersion.value.version !== latestVersion.value.version
})

const checkForUpdates = async () => {
  versionLoading.value = true
  versionError.value = ''
  currentVersion.value = null
  latestVersion.value = null

  try {
    const [current, latest] = await Promise.all([
      versionService.getVersion(),
      versionService.getLatest().catch(err => {
        if (err.response?.status === 404) {
          return null
        }
        throw err
      })
    ])
    currentVersion.value = current
    latestVersion.value = latest
    versionDialogOpen.value = true
  } catch (err: any) {
    versionError.value = err.response?.data?.error || '检查更新失败'
    versionDialogOpen.value = true
  } finally {
    versionLoading.value = false
  }
}

// API密钥相关
const apiKey = ref('')
const apiKeyError = ref('')
const apiKeySuccess = ref('')
const apiKeyLoading = ref(false)
const showApiKey = ref(false) // 控制显示/隐藏API密钥

const isSuperAdmin = computed(() => {
  const user = authService.getCurrentUser()
  return Array.isArray(user?.roles) && user.roles.includes('super_admin')
})

const appConfigStore = useAppConfigStore()

// 功能开关（仅超级管理员）
const featureFlags = ref({
  xhs: true,
  xianyu: true,
  payment: true,
  openAccounts: true
})
const featureFlagsError = ref('')
const featureFlagsSuccess = ref('')
const featureFlagsLoading = ref(false)

// 补录设置（仅超级管理员）
const accountRecoveryForceTodayCodes = ref(false)
const accountRecoveryCodeWindowDays = ref('7')
const accountRecoveryRequireExpireCoverDeadline = ref(false)
const accountRecoverySettingsError = ref('')
const accountRecoverySettingsSuccess = ref('')
const accountRecoverySettingsLoading = ref(false)

// 渠道管理（仅超级管理员）
const channels = ref<Channel[]>([])
const channelsLoading = ref(false)
const channelsError = ref('')
const channelsSuccess = ref('')
const channelDialogOpen = ref(false)
const channelDialogMode = ref<'create' | 'edit'>('create')
const channelFormKey = ref('')
const channelFormName = ref('')
const channelFormAllowFallback = ref(false)
const channelFormIsActive = ref(true)
const channelFormSortOrder = ref('0')

// 支付商品管理（仅超级管理员）
const purchaseProducts = ref<PurchaseProduct[]>([])
const purchaseProductsLoading = ref(false)
const purchaseProductsError = ref('')
const purchaseProductsSuccess = ref('')
const purchaseProductDialogOpen = ref(false)
const purchaseProductDialogMode = ref<'create' | 'edit'>('create')
const purchaseProductFormKey = ref('')
const purchaseProductFormName = ref('')
const purchaseProductFormAmount = ref('')
const purchaseProductFormServiceDays = ref('30')
const purchaseProductFormOrderType = ref<PurchaseOrderType>('warranty')
const purchaseProductFormCodeChannels = ref('')
const purchaseProductFormIsActive = ref(true)
const purchaseProductFormSortOrder = ref('0')
const purchaseAvailability = ref<Record<string, number>>({})

// 邮箱后缀白名单
const emailDomainWhitelist = ref('')
const emailDomainWhitelistError = ref('')
const emailDomainWhitelistSuccess = ref('')
const emailDomainWhitelistLoading = ref(false)

// 积分提现设置（仅超级管理员）
const pointsWithdrawRatePoints = ref('1')
const pointsWithdrawRateCashYuan = ref('1.00')
const pointsWithdrawMinCashYuan = ref('10.00')
const pointsWithdrawMinPoints = ref<number | null>(null)
const pointsWithdrawStepPoints = ref<number | null>(null)
const pointsWithdrawError = ref('')
const pointsWithdrawSuccess = ref('')
const pointsWithdrawLoading = ref(false)

// SMTP 邮件告警配置（仅超级管理员）
const smtpHost = ref('')
const smtpPort = ref('465')
const smtpSecure = ref<'true' | 'false'>('true')
const smtpUser = ref('')
const smtpPass = ref('')
const smtpPassSet = ref(false)
const smtpPassStored = ref(false)
const smtpFrom = ref('')
const adminAlertEmail = ref('')
const smtpError = ref('')
const smtpSuccess = ref('')
const smtpLoading = ref(false)
const smtpTestLoading = ref(false)
const smtpTestSuccess = ref('')
const smtpTestError = ref('')
const smtpTestSuggestion = ref('')
const showSmtpPass = ref(false)

// Linux DO OAuth 配置（仅超级管理员）
const linuxdoClientId = ref('')
const linuxdoClientSecret = ref('')
const linuxdoRedirectUri = ref('')
const linuxdoClientSecretSet = ref(false)
const linuxdoClientSecretStored = ref(false)
const linuxdoOauthError = ref('')
const linuxdoOauthSuccess = ref('')
const linuxdoOauthLoading = ref(false)
const showLinuxdoClientSecret = ref(false)

// Linux DO Credit 配置（仅超级管理员）
const linuxdoCreditPid = ref('')
const linuxdoCreditKey = ref('')
const linuxdoCreditKeySet = ref(false)
const linuxdoCreditKeyStored = ref(false)
const linuxdoCreditError = ref('')
const linuxdoCreditSuccess = ref('')
const linuxdoCreditLoading = ref(false)
const showLinuxdoCreditKey = ref(false)

// ZPAY 支付配置（仅超级管理员）
const zpayBaseUrl = ref('https://zpayz.cn')
const zpayPid = ref('')
const zpayKey = ref('')
const zpayKeySet = ref(false)
const zpayKeyStored = ref(false)
const zpayError = ref('')
const zpaySuccess = ref('')
const zpayLoading = ref(false)
const showZpayKey = ref(false)

// Cloudflare Turnstile 配置（仅超级管理员）
const turnstileSiteKey = ref('')
const turnstileSecretKey = ref('')
const turnstileEnabled = ref(false)
const turnstileSecretSet = ref(false)
const turnstileSecretStored = ref(false)
const turnstileSiteKeyStored = ref(false)
const turnstileError = ref('')
const turnstileSuccess = ref('')
const turnstileLoading = ref(false)
const showTurnstileSecretKey = ref(false)

// Telegram Bot 配置（仅超级管理员）
const telegramAllowedUserIds = ref('')
const telegramAllowedUserIdsStored = ref(false)
const telegramBotToken = ref('')
const telegramTokenSet = ref(false)
const telegramTokenStored = ref(false)
const telegramNotifyEnabled = ref<'true' | 'false'>('true')
const telegramNotifyEnabledStored = ref(false)
const telegramNotifyChatIds = ref('')
const telegramNotifyChatIdsStored = ref(false)
const telegramNotifyTimeoutMs = ref('8000')
const telegramNotifyTimeoutMsStored = ref(false)
const telegramError = ref('')
const telegramSuccess = ref('')
const telegramLoading = ref(false)
const showTelegramBotToken = ref(false)

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!isSuperAdmin.value) return
  await loadApiKey()
  await Promise.all([
    loadFeatureFlags(),
    loadAccountRecoverySettings(),
    loadChannels(),
    loadPurchaseProducts(),
    loadPurchaseAvailability(),
    loadEmailDomainWhitelist(),
    loadPointsWithdrawSettings(),
    loadSmtpSettings(),
    loadLinuxDoOAuthSettings(),
    loadLinuxDoCreditSettings(),
    loadZpaySettings(),
    loadTurnstileSettings(),
    loadTelegramSettings(),
  ])
})

onUnmounted(() => {
  teleportReady.value = false
})

const loadApiKey = async () => {
  try {
    const response = await userService.getApiKey()
    apiKey.value = typeof response.apiKey === 'string' ? response.apiKey : ''
  } catch (err: any) {
    console.error('Load API key error:', err)
  }
}

const loadFeatureFlags = async () => {
  featureFlagsError.value = ''
  featureFlagsSuccess.value = ''
  try {
    const response = await adminService.getFeatureFlags()
    const next = response.features || {}
    featureFlags.value = {
      xhs: next.xhs !== false,
      xianyu: next.xianyu !== false,
      payment: next.payment !== false,
      openAccounts: next.openAccounts !== false
    }
    appConfigStore.features = { ...featureFlags.value }
  } catch (err: any) {
    featureFlagsError.value = err.response?.data?.error || '加载功能开关失败'
  }
}

const saveFeatureFlags = async () => {
  featureFlagsError.value = ''
  featureFlagsSuccess.value = ''
  featureFlagsLoading.value = true
  try {
    const response = await adminService.updateFeatureFlags({
      features: { ...featureFlags.value }
    })
    const next = response.features || {}
    featureFlags.value = {
      xhs: next.xhs !== false,
      xianyu: next.xianyu !== false,
      payment: next.payment !== false,
      openAccounts: next.openAccounts !== false
    }
    appConfigStore.features = { ...featureFlags.value }
    featureFlagsSuccess.value = '已保存'
    setTimeout(() => (featureFlagsSuccess.value = ''), 3000)
  } catch (err: any) {
    featureFlagsError.value = err.response?.data?.error || '保存失败'
  } finally {
    featureFlagsLoading.value = false
  }
}

watch(accountRecoveryForceTodayCodes, (next) => {
  if (!next) {
    accountRecoveryRequireExpireCoverDeadline.value = false
  }
  if (!accountRecoveryCodeWindowDays.value.trim()) {
    accountRecoveryCodeWindowDays.value = '7'
  }
})

const loadAccountRecoverySettings = async () => {
  accountRecoverySettingsError.value = ''
  accountRecoverySettingsSuccess.value = ''
  try {
    const response = await adminService.getAccountRecoverySettings()
    const next = response.settings || ({} as any)
    accountRecoveryForceTodayCodes.value = Boolean(next.forceTodayCodes)
    accountRecoveryCodeWindowDays.value = String(next.codeWindowDays ?? 7)
    accountRecoveryRequireExpireCoverDeadline.value = Boolean(next.requireExpireCoverDeadline)
    if (!accountRecoveryForceTodayCodes.value) {
      accountRecoveryRequireExpireCoverDeadline.value = false
    }
  } catch (err: any) {
    accountRecoverySettingsError.value = err.response?.data?.error || '加载补录设置失败'
  }
}

const saveAccountRecoverySettings = async () => {
  accountRecoverySettingsError.value = ''
  accountRecoverySettingsSuccess.value = ''
  accountRecoverySettingsLoading.value = true
  try {
    const parsedDays = Number.parseInt(accountRecoveryCodeWindowDays.value, 10)
    const codeWindowDays = Number.isFinite(parsedDays) ? Math.max(1, Math.min(365, parsedDays)) : 7
    const settingsPayload = {
      forceTodayCodes: accountRecoveryForceTodayCodes.value,
      codeWindowDays,
      requireExpireCoverDeadline: accountRecoveryForceTodayCodes.value ? accountRecoveryRequireExpireCoverDeadline.value : false
    }
    const response = await adminService.updateAccountRecoverySettings({ settings: settingsPayload })
    const next = response.settings || ({} as any)
    accountRecoveryForceTodayCodes.value = Boolean(next.forceTodayCodes)
    accountRecoveryCodeWindowDays.value = String(next.codeWindowDays ?? 7)
    accountRecoveryRequireExpireCoverDeadline.value = Boolean(next.requireExpireCoverDeadline)
    if (!accountRecoveryForceTodayCodes.value) {
      accountRecoveryRequireExpireCoverDeadline.value = false
    }
    accountRecoverySettingsSuccess.value = '已保存'
    setTimeout(() => (accountRecoverySettingsSuccess.value = ''), 3000)
  } catch (err: any) {
    accountRecoverySettingsError.value = err.response?.data?.error || '保存失败'
  } finally {
    accountRecoverySettingsLoading.value = false
  }
}

const loadChannels = async () => {
  if (channelsLoading.value) return
  channelsLoading.value = true
  channelsError.value = ''
  channelsSuccess.value = ''
  try {
    const response = await adminService.getChannels()
    channels.value = Array.isArray(response.channels) ? response.channels : []
  } catch (err: any) {
    channelsError.value = err.response?.data?.error || '加载渠道失败'
  } finally {
    channelsLoading.value = false
  }
}

const openCreateChannelDialog = () => {
  channelDialogMode.value = 'create'
  channelFormKey.value = ''
  channelFormName.value = ''
  channelFormAllowFallback.value = false
  channelFormIsActive.value = true
  channelFormSortOrder.value = '0'
  channelDialogOpen.value = true
}

const openEditChannelDialog = (channel: Channel) => {
  channelDialogMode.value = 'edit'
  channelFormKey.value = channel.key
  channelFormName.value = channel.name
  channelFormAllowFallback.value = Boolean(channel.allowCommonFallback)
  channelFormIsActive.value = Boolean(channel.isActive)
  channelFormSortOrder.value = String(channel.sortOrder ?? 0)
  channelDialogOpen.value = true
}

const submitChannelDialog = async () => {
  channelsError.value = ''
  channelsSuccess.value = ''
  try {
    if (channelDialogMode.value === 'create') {
      await adminService.createChannel({
        key: channelFormKey.value.trim(),
        name: channelFormName.value.trim(),
        allowCommonFallback: channelFormAllowFallback.value,
        isActive: channelFormIsActive.value,
        sortOrder: Number.parseInt(channelFormSortOrder.value || '0', 10) || 0
      })
    } else {
      await adminService.updateChannel(channelFormKey.value, {
        name: channelFormName.value.trim(),
        allowCommonFallback: channelFormAllowFallback.value,
        isActive: channelFormIsActive.value,
        sortOrder: Number.parseInt(channelFormSortOrder.value || '0', 10) || 0
      })
    }
    channelDialogOpen.value = false
    channelsSuccess.value = '已保存'
    setTimeout(() => (channelsSuccess.value = ''), 3000)
    await loadChannels()
  } catch (err: any) {
    channelsError.value = err.response?.data?.error || '保存失败'
  }
}

const toggleChannelActive = async (channel: Channel) => {
  channelsError.value = ''
  channelsSuccess.value = ''
  try {
    await adminService.updateChannel(channel.key, { isActive: !channel.isActive })
    await loadChannels()
    channelsSuccess.value = '已保存'
    setTimeout(() => (channelsSuccess.value = ''), 3000)
  } catch (err: any) {
    channelsError.value = err.response?.data?.error || '更新失败'
  }
}

const deleteChannel = async (channel: Channel) => {
  if (!confirm(`确定要删除渠道「${channel.name || channel.key}」吗？此操作不可撤销。`)) return
  channelsError.value = ''
  channelsSuccess.value = ''
  try {
    await adminService.deleteChannel(channel.key)
    await loadChannels()
    channelsSuccess.value = '已删除'
    setTimeout(() => (channelsSuccess.value = ''), 3000)
  } catch (err: any) {
    channelsError.value = err.response?.data?.error || '删除失败'
  }
}

const loadPurchaseProducts = async () => {
  if (purchaseProductsLoading.value) return
  purchaseProductsLoading.value = true
  purchaseProductsError.value = ''
  purchaseProductsSuccess.value = ''
  try {
    const response = await adminService.getPurchaseProducts()
    purchaseProducts.value = Array.isArray(response.products) ? response.products : []
  } catch (err: any) {
    purchaseProductsError.value = err.response?.data?.error || '加载商品失败'
  } finally {
    purchaseProductsLoading.value = false
  }
}

const loadPurchaseAvailability = async () => {
  try {
    const meta: PurchaseMeta = await purchaseService.getMeta()
    const map: Record<string, number> = {}
    for (const plan of meta.plans || []) {
      map[plan.key] = Number(plan.availableCount || 0)
    }
    purchaseAvailability.value = map
  } catch {
    purchaseAvailability.value = {}
  }
}

const refreshPurchaseProducts = async () => {
  await Promise.all([loadPurchaseProducts(), loadPurchaseAvailability()])
}

const openCreatePurchaseProductDialog = () => {
  purchaseProductDialogMode.value = 'create'
  purchaseProductFormKey.value = ''
  purchaseProductFormName.value = ''
  purchaseProductFormAmount.value = ''
  purchaseProductFormServiceDays.value = '30'
  purchaseProductFormOrderType.value = 'warranty'
  purchaseProductFormCodeChannels.value = 'paypal,common'
  purchaseProductFormIsActive.value = true
  purchaseProductFormSortOrder.value = '0'
  purchaseProductDialogOpen.value = true
}

const openEditPurchaseProductDialog = (product: PurchaseProduct) => {
  purchaseProductDialogMode.value = 'edit'
  purchaseProductFormKey.value = product.productKey
  purchaseProductFormName.value = product.productName
  purchaseProductFormAmount.value = product.amount
  purchaseProductFormServiceDays.value = String(product.serviceDays ?? 30)
  purchaseProductFormOrderType.value = product.orderType
  purchaseProductFormCodeChannels.value = product.codeChannels
  purchaseProductFormIsActive.value = Boolean(product.isActive)
  purchaseProductFormSortOrder.value = String(product.sortOrder ?? 0)
  purchaseProductDialogOpen.value = true
}

const submitPurchaseProductDialog = async () => {
  purchaseProductsError.value = ''
  purchaseProductsSuccess.value = ''

  const payload = {
    productKey: purchaseProductFormKey.value.trim(),
    productName: purchaseProductFormName.value.trim(),
    amount: purchaseProductFormAmount.value.trim(),
    serviceDays: Number.parseInt(purchaseProductFormServiceDays.value || '0', 10),
    orderType: purchaseProductFormOrderType.value,
    codeChannels: purchaseProductFormCodeChannels.value.trim(),
    isActive: purchaseProductFormIsActive.value,
    sortOrder: Number.parseInt(purchaseProductFormSortOrder.value || '0', 10) || 0,
  }

  try {
    if (purchaseProductDialogMode.value === 'create') {
      await adminService.createPurchaseProduct(payload)
    } else {
      await adminService.updatePurchaseProduct(payload.productKey, payload)
    }
    purchaseProductDialogOpen.value = false
    purchaseProductsSuccess.value = '已保存'
    setTimeout(() => (purchaseProductsSuccess.value = ''), 3000)
    await Promise.all([loadPurchaseProducts(), loadPurchaseAvailability()])
  } catch (err: any) {
    purchaseProductsError.value = err.response?.data?.error || '保存失败'
  }
}

const togglePurchaseProductActive = async (product: PurchaseProduct) => {
  purchaseProductsError.value = ''
  purchaseProductsSuccess.value = ''
  try {
    await adminService.updatePurchaseProduct(product.productKey, { isActive: !product.isActive })
    await Promise.all([loadPurchaseProducts(), loadPurchaseAvailability()])
    purchaseProductsSuccess.value = '已保存'
    setTimeout(() => (purchaseProductsSuccess.value = ''), 3000)
  } catch (err: any) {
    purchaseProductsError.value = err.response?.data?.error || '更新失败'
  }
}

const deletePurchaseProduct = async (product: PurchaseProduct) => {
  if (!confirm(`确定要删除商品「${product.productName || product.productKey}」吗？此操作不可撤销。`)) return
  purchaseProductsError.value = ''
  purchaseProductsSuccess.value = ''
  try {
    await adminService.deletePurchaseProduct(product.productKey)
    await Promise.all([loadPurchaseProducts(), loadPurchaseAvailability()])
    purchaseProductsSuccess.value = '已删除'
    setTimeout(() => (purchaseProductsSuccess.value = ''), 3000)
  } catch (err: any) {
    purchaseProductsError.value = err.response?.data?.error || '删除失败'
  }
}

const handleUpdateApiKey = async () => {
  apiKeyError.value = ''
  apiKeySuccess.value = ''

  // Validation
  if (!apiKey.value) {
    apiKeyError.value = '请输入API密钥'
    return
  }

  if (apiKey.value.length < 16) {
    apiKeyError.value = 'API密钥至少需要 16 个字符以确保安全性'
    return
  }

  apiKeyLoading.value = true

  try {
    await userService.updateApiKey(apiKey.value)
    apiKeySuccess.value = 'API密钥更新成功！请在油猴脚本中使用新密钥'

    // Clear success message after 5 seconds
    setTimeout(() => {
      apiKeySuccess.value = ''
    }, 5000)
  } catch (err: any) {
    apiKeyError.value = err.response?.data?.error || '更新API密钥失败，请重试'
  } finally {
    apiKeyLoading.value = false
  }
}

// 生成随机API密钥
const generateApiKey = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  const length = 32
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  apiKey.value = result
  showApiKey.value = true // 生成后自动显示
  apiKeySuccess.value = '✅ 已生成随机密钥，点击"更新 API 密钥"保存'
}

// 切换显示/隐藏API密钥
const toggleShowApiKey = () => {
  showApiKey.value = !showApiKey.value
}

const toggleShowSmtpPass = () => {
  showSmtpPass.value = !showSmtpPass.value
}

const toggleShowLinuxdoClientSecret = () => {
  showLinuxdoClientSecret.value = !showLinuxdoClientSecret.value
}

const toggleShowLinuxdoCreditKey = () => {
  showLinuxdoCreditKey.value = !showLinuxdoCreditKey.value
}

const toggleShowZpayKey = () => {
  showZpayKey.value = !showZpayKey.value
}

const toggleShowTurnstileSecretKey = () => {
  showTurnstileSecretKey.value = !showTurnstileSecretKey.value
}

const toggleShowTelegramBotToken = () => {
  showTelegramBotToken.value = !showTelegramBotToken.value
}

const loadEmailDomainWhitelist = async () => {
  emailDomainWhitelistError.value = ''
  emailDomainWhitelistSuccess.value = ''
  try {
    const response = await adminService.getEmailDomainWhitelist()
    emailDomainWhitelist.value = (response.domains || []).join(',')
  } catch (err: any) {
    emailDomainWhitelistError.value = err.response?.data?.error || '加载邮箱白名单失败'
  }
}

const saveEmailDomainWhitelist = async () => {
  emailDomainWhitelistError.value = ''
  emailDomainWhitelistSuccess.value = ''
  emailDomainWhitelistLoading.value = true
  try {
    const domains = emailDomainWhitelist.value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
    await adminService.updateEmailDomainWhitelist(domains)
    emailDomainWhitelistSuccess.value = '已保存'
    setTimeout(() => (emailDomainWhitelistSuccess.value = ''), 3000)
  } catch (err: any) {
    emailDomainWhitelistError.value = err.response?.data?.error || '保存失败'
  } finally {
    emailDomainWhitelistLoading.value = false
  }
}

const loadLinuxDoOAuthSettings = async () => {
  linuxdoOauthError.value = ''
  linuxdoOauthSuccess.value = ''
  try {
    const response = await adminService.getLinuxDoOAuthSettings()
    linuxdoClientId.value = response.oauth?.clientId || ''
    linuxdoRedirectUri.value = response.oauth?.redirectUri || ''
    linuxdoClientSecret.value = ''
    linuxdoClientSecretSet.value = Boolean(response.oauth?.clientSecretSet)
    linuxdoClientSecretStored.value = Boolean(response.oauth?.clientSecretStored)
  } catch (err: any) {
    linuxdoOauthError.value = err.response?.data?.error || '加载 Linux DO OAuth 配置失败'
  }
}

const saveLinuxDoOAuthSettings = async () => {
  linuxdoOauthError.value = ''
  linuxdoOauthSuccess.value = ''

  const clientId = linuxdoClientId.value.trim()
  const redirectUri = linuxdoRedirectUri.value.trim()
  const clientSecretTrimmed = linuxdoClientSecret.value.trim()

  const wantsEnable = Boolean(clientId || redirectUri || clientSecretTrimmed)
  if (wantsEnable) {
    if (!clientId) {
      linuxdoOauthError.value = '请输入 Linux DO Client ID'
      return
    }
    if (!redirectUri) {
      linuxdoOauthError.value = '请输入 Linux DO Redirect URI'
      return
    }
    if (!clientSecretTrimmed && !linuxdoClientSecretSet.value) {
      linuxdoOauthError.value = '请输入 Linux DO Client Secret'
      return
    }

    try {
      const parsed = new URL(redirectUri)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        linuxdoOauthError.value = 'Redirect URI 必须是 http(s)'
        return
      }
    } catch {
      linuxdoOauthError.value = 'Redirect URI 格式不正确'
      return
    }
  }

  linuxdoOauthLoading.value = true
  try {
    const payload: any = {
      oauth: {
        clientId,
        redirectUri,
      },
    }
    if (clientSecretTrimmed) {
      payload.oauth.clientSecret = clientSecretTrimmed
    }

    const response = await adminService.updateLinuxDoOAuthSettings(payload)
    linuxdoClientId.value = response.oauth?.clientId || clientId
    linuxdoRedirectUri.value = response.oauth?.redirectUri || redirectUri
    linuxdoClientSecret.value = ''
    linuxdoClientSecretSet.value = Boolean(response.oauth?.clientSecretSet)
    linuxdoClientSecretStored.value = Boolean(response.oauth?.clientSecretStored)

    linuxdoOauthSuccess.value = '已保存'
    setTimeout(() => (linuxdoOauthSuccess.value = ''), 3000)
  } catch (err: any) {
    linuxdoOauthError.value = err.response?.data?.error || '保存失败'
  } finally {
    linuxdoOauthLoading.value = false
  }
}

const loadLinuxDoCreditSettings = async () => {
  linuxdoCreditError.value = ''
  linuxdoCreditSuccess.value = ''
  try {
    const response = await adminService.getLinuxDoCreditSettings()
    linuxdoCreditPid.value = response.credit?.pid || ''
    linuxdoCreditKey.value = ''
    linuxdoCreditKeySet.value = Boolean(response.credit?.keySet)
    linuxdoCreditKeyStored.value = Boolean(response.credit?.keyStored)
  } catch (err: any) {
    linuxdoCreditError.value = err.response?.data?.error || '加载 Linux DO Credit 配置失败'
  }
}

const saveLinuxDoCreditSettings = async () => {
  linuxdoCreditError.value = ''
  linuxdoCreditSuccess.value = ''

  const pid = linuxdoCreditPid.value.trim()
  const keyTrimmed = linuxdoCreditKey.value.trim()
  const wantsEnable = Boolean(pid || keyTrimmed)

  if (wantsEnable) {
    if (!pid) {
      linuxdoCreditError.value = '请输入 Credit PID'
      return
    }
    if (!keyTrimmed && !linuxdoCreditKeySet.value) {
      linuxdoCreditError.value = '请输入 Credit KEY'
      return
    }
  }

  linuxdoCreditLoading.value = true
  try {
    const payload: any = { credit: { pid } }
    if (keyTrimmed) {
      payload.credit.key = keyTrimmed
    }
    const response = await adminService.updateLinuxDoCreditSettings(payload)
    linuxdoCreditPid.value = response.credit?.pid || pid
    linuxdoCreditKey.value = ''
    linuxdoCreditKeySet.value = Boolean(response.credit?.keySet)
    linuxdoCreditKeyStored.value = Boolean(response.credit?.keyStored)

    linuxdoCreditSuccess.value = '已保存'
    setTimeout(() => (linuxdoCreditSuccess.value = ''), 3000)
  } catch (err: any) {
    linuxdoCreditError.value = err.response?.data?.error || '保存失败'
  } finally {
    linuxdoCreditLoading.value = false
  }
}

const loadZpaySettings = async () => {
  zpayError.value = ''
  zpaySuccess.value = ''
  try {
    const response = await adminService.getZpaySettings()
    zpayBaseUrl.value = response.zpay?.baseUrl || 'https://zpayz.cn'
    zpayPid.value = response.zpay?.pid || ''
    zpayKey.value = ''
    zpayKeySet.value = Boolean(response.zpay?.keySet)
    zpayKeyStored.value = Boolean(response.zpay?.keyStored)
  } catch (err: any) {
    zpayError.value = err.response?.data?.error || '加载 ZPAY 配置失败'
  }
}

const saveZpaySettings = async () => {
  zpayError.value = ''
  zpaySuccess.value = ''

  const baseUrl = zpayBaseUrl.value.trim()
  if (baseUrl) {
    try {
      const parsed = new URL(baseUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        zpayError.value = 'ZPAY Base URL 必须是 http(s)'
        return
      }
    } catch {
      zpayError.value = 'ZPAY Base URL 格式不正确'
      return
    }
  }

  const pid = zpayPid.value.trim()
  const keyTrimmed = zpayKey.value.trim()
  if (pid) {
    if (!keyTrimmed && !zpayKeySet.value) {
      zpayError.value = '请输入 ZPAY KEY'
      return
    }
  }

  zpayLoading.value = true
  try {
    const payload: any = { zpay: { baseUrl, pid } }
    if (keyTrimmed) {
      payload.zpay.key = keyTrimmed
    }
    const response = await adminService.updateZpaySettings(payload)
    zpayBaseUrl.value = response.zpay?.baseUrl || baseUrl || 'https://zpayz.cn'
    zpayPid.value = response.zpay?.pid || pid
    zpayKey.value = ''
    zpayKeySet.value = Boolean(response.zpay?.keySet)
    zpayKeyStored.value = Boolean(response.zpay?.keyStored)

    zpaySuccess.value = '已保存'
    setTimeout(() => (zpaySuccess.value = ''), 3000)
  } catch (err: any) {
    zpayError.value = err.response?.data?.error || '保存失败'
  } finally {
    zpayLoading.value = false
  }
}

const loadTurnstileSettings = async () => {
  turnstileError.value = ''
  turnstileSuccess.value = ''
  try {
    const response = await adminService.getTurnstileSettings()
    turnstileSiteKey.value = response.turnstile?.siteKey || ''
    turnstileSecretKey.value = ''
    turnstileEnabled.value = Boolean(response.enabled)
    turnstileSecretSet.value = Boolean(response.turnstile?.secretSet)
    turnstileSecretStored.value = Boolean(response.turnstile?.secretStored)
    turnstileSiteKeyStored.value = Boolean(response.turnstile?.siteKeyStored)
  } catch (err: any) {
    turnstileError.value = err.response?.data?.error || '加载 Turnstile 配置失败'
  }
}

const saveTurnstileSettings = async () => {
  turnstileError.value = ''
  turnstileSuccess.value = ''

  const siteKey = turnstileSiteKey.value.trim()
  const secretTrimmed = turnstileSecretKey.value.trim()

  turnstileLoading.value = true
  try {
    const payload: any = { turnstile: { siteKey } }
    if (secretTrimmed) {
      payload.turnstile.secretKey = secretTrimmed
    }

    const response = await adminService.updateTurnstileSettings(payload)
    turnstileSiteKey.value = response.turnstile?.siteKey || siteKey
    turnstileSecretKey.value = ''
    turnstileEnabled.value = Boolean(response.enabled)
    turnstileSecretSet.value = Boolean(response.turnstile?.secretSet)
    turnstileSecretStored.value = Boolean(response.turnstile?.secretStored)
    turnstileSiteKeyStored.value = Boolean(response.turnstile?.siteKeyStored)

    turnstileSuccess.value = '已保存'
    setTimeout(() => (turnstileSuccess.value = ''), 3000)
  } catch (err: any) {
    turnstileError.value = err.response?.data?.error || '保存失败'
  } finally {
    turnstileLoading.value = false
  }
}

const loadTelegramSettings = async () => {
  telegramError.value = ''
  telegramSuccess.value = ''
  try {
    const response = await adminService.getTelegramSettings()
    telegramAllowedUserIds.value = response.telegram?.allowedUserIds || ''
    telegramAllowedUserIdsStored.value = Boolean(response.telegram?.allowedUserIdsStored)
    telegramBotToken.value = ''
    telegramTokenSet.value = Boolean(response.telegram?.tokenSet)
    telegramTokenStored.value = Boolean(response.telegram?.tokenStored)
    telegramNotifyEnabled.value = response.telegram?.notifyEnabled === false ? 'false' : 'true'
    telegramNotifyEnabledStored.value = Boolean(response.telegram?.notifyEnabledStored)
    telegramNotifyChatIds.value = response.telegram?.notifyChatIds || ''
    telegramNotifyChatIdsStored.value = Boolean(response.telegram?.notifyChatIdsStored)
    telegramNotifyTimeoutMs.value = String(response.telegram?.notifyTimeoutMs ?? 8000)
    telegramNotifyTimeoutMsStored.value = Boolean(response.telegram?.notifyTimeoutMsStored)
  } catch (err: any) {
    telegramError.value = err.response?.data?.error || '加载 Telegram 配置失败'
  }
}

const saveTelegramSettings = async () => {
  telegramError.value = ''
  telegramSuccess.value = ''

  const allowedIdsRaw = telegramAllowedUserIds.value.trim()
  if (allowedIdsRaw) {
    const items = allowedIdsRaw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
    const invalid = items.find(item => !/^\d+$/.test(item))
    if (invalid) {
      telegramError.value = `允许的用户 ID 格式不正确：${invalid}`
      return
    }
  }

  const notifyChatIdsRaw = telegramNotifyChatIds.value.trim()
  if (notifyChatIdsRaw) {
    const items = notifyChatIdsRaw
      .split(',')
      .map(item => item.trim())
      .filter(Boolean)
    const invalid = items.find(item => !/^-?\d+$/.test(item) && !/^@[\w_]{5,32}$/.test(item))
    if (invalid) {
      telegramError.value = `通知 chat_id 格式不正确：${invalid}`
      return
    }
  }

  const notifyTimeoutRaw = telegramNotifyTimeoutMs.value.trim()
  const notifyTimeoutMs = Number.parseInt(notifyTimeoutRaw, 10)
  if (!Number.isFinite(notifyTimeoutMs) || notifyTimeoutMs <= 0) {
    telegramError.value = '通知超时时间需为正整数（毫秒）'
    return
  }

  telegramLoading.value = true
  try {
    const payload: any = { telegram: { allowedUserIds: allowedIdsRaw } }
    const tokenTrimmed = telegramBotToken.value.trim()
    if (tokenTrimmed) {
      payload.telegram.botToken = tokenTrimmed
    }
    payload.telegram.notifyEnabled = telegramNotifyEnabled.value === 'true'
    payload.telegram.notifyChatIds = notifyChatIdsRaw
    payload.telegram.notifyTimeoutMs = notifyTimeoutMs

    const response = await adminService.updateTelegramSettings(payload)
    telegramAllowedUserIds.value = response.telegram?.allowedUserIds || allowedIdsRaw
    telegramAllowedUserIdsStored.value = Boolean(response.telegram?.allowedUserIdsStored)
    telegramBotToken.value = ''
    telegramTokenSet.value = Boolean(response.telegram?.tokenSet)
    telegramTokenStored.value = Boolean(response.telegram?.tokenStored)
    telegramNotifyEnabled.value = response.telegram?.notifyEnabled === false ? 'false' : 'true'
    telegramNotifyEnabledStored.value = Boolean(response.telegram?.notifyEnabledStored)
    telegramNotifyChatIds.value = response.telegram?.notifyChatIds || notifyChatIdsRaw
    telegramNotifyChatIdsStored.value = Boolean(response.telegram?.notifyChatIdsStored)
    telegramNotifyTimeoutMs.value = String(response.telegram?.notifyTimeoutMs ?? notifyTimeoutMs)
    telegramNotifyTimeoutMsStored.value = Boolean(response.telegram?.notifyTimeoutMsStored)

    telegramSuccess.value = '已保存（Bot Token 修改需重启后端生效；通知配置实时生效）'
    setTimeout(() => (telegramSuccess.value = ''), 3000)
  } catch (err: any) {
    telegramError.value = err.response?.data?.error || '保存失败'
  } finally {
    telegramLoading.value = false
  }
}

const loadSmtpSettings = async () => {
  smtpError.value = ''
  smtpSuccess.value = ''
  smtpTestSuccess.value = ''
  smtpTestError.value = ''
  smtpTestSuggestion.value = ''
  try {
    const response = await adminService.getSmtpSettings()
    smtpHost.value = response.smtp?.host || ''
    smtpPort.value = String(response.smtp?.port ?? 465)
    smtpSecure.value = response.smtp?.secure ? 'true' : 'false'
    smtpUser.value = response.smtp?.user || ''
    smtpFrom.value = response.smtp?.from || ''
    adminAlertEmail.value = response.adminAlertEmail || ''
    smtpPass.value = ''
    smtpPassSet.value = Boolean(response.smtp?.passSet)
    smtpPassStored.value = Boolean(response.smtp?.passStored)
  } catch (err: any) {
    smtpError.value = err.response?.data?.error || '加载 SMTP 配置失败'
  }
}

const saveSmtpSettings = async () => {
  smtpError.value = ''
  smtpSuccess.value = ''
  smtpTestSuccess.value = ''
  smtpTestError.value = ''
  smtpTestSuggestion.value = ''

  const host = smtpHost.value.trim()
  const port = Number.parseInt(smtpPort.value.trim(), 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    smtpError.value = '请输入有效的 SMTP 端口（1-65535）'
    return
  }

  const secure = smtpSecure.value === 'true'
  const user = smtpUser.value.trim()
  const from = smtpFrom.value.trim()
  const recipients = adminAlertEmail.value.trim()

  const passTrimmed = smtpPass.value.trim()

  smtpLoading.value = true
  try {
    const payload: any = {
      smtp: {
        host,
        port,
        secure,
        user,
        from,
      },
      adminAlertEmail: recipients,
    }
    if (passTrimmed) {
      payload.smtp.pass = passTrimmed
    }

    const response = await adminService.updateSmtpSettings(payload)
    smtpHost.value = response.smtp?.host || host
    smtpPort.value = String(response.smtp?.port ?? port)
    smtpSecure.value = response.smtp?.secure ? 'true' : 'false'
    smtpUser.value = response.smtp?.user || user
    smtpFrom.value = response.smtp?.from || from
    adminAlertEmail.value = response.adminAlertEmail || recipients
    smtpPass.value = ''
    smtpPassSet.value = Boolean(response.smtp?.passSet)
    smtpPassStored.value = Boolean(response.smtp?.passStored)
    smtpSuccess.value = '已保存'
    setTimeout(() => (smtpSuccess.value = ''), 3000)
  } catch (err: any) {
    smtpError.value = err.response?.data?.error || '保存失败'
  } finally {
    smtpLoading.value = false
  }
}

const testSmtpSettings = async () => {
  smtpTestSuccess.value = ''
  smtpTestError.value = ''
  smtpTestSuggestion.value = ''

  smtpTestLoading.value = true
  try {
    const response = await adminService.testSmtpSettings()
    const messageId = response.messageId ? `，messageId=${response.messageId}` : ''
    const traceInfo = response.traceId ? `（traceId=${response.traceId}）` : ''
    const toInfo = response.to ? `发送至 ${response.to}` : '发送成功'
    smtpTestSuccess.value = `${toInfo}${messageId}${traceInfo}`
  } catch (err: any) {
    smtpTestError.value = err.response?.data?.error || '测试失败'
    smtpTestSuggestion.value = err.response?.data?.suggestion || ''
  } finally {
    smtpTestLoading.value = false
  }
}

const parseYuanToCents = (value: string) => {
  const raw = String(value ?? '').trim()
  if (!raw) return NaN
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(raw)) return NaN

  const parts = raw.split('.')
  const yuan = Number.parseInt(parts[0] || '0', 10)
  const centsText = String(parts[1] || '')
  const cents = Number.parseInt((centsText + '00').slice(0, 2), 10)
  return yuan * 100 + cents
}

const loadPointsWithdrawSettings = async () => {
  pointsWithdrawError.value = ''
  pointsWithdrawSuccess.value = ''
  try {
    const response = await adminService.getPointsWithdrawSettings()
    pointsWithdrawRatePoints.value = String(response.rate?.points ?? 1)
    pointsWithdrawRateCashYuan.value = ((Number(response.rate?.cashCents ?? 100) || 0) / 100).toFixed(2)
    pointsWithdrawMinCashYuan.value = ((Number(response.minCashCents ?? 1000) || 0) / 100).toFixed(2)
    pointsWithdrawMinPoints.value = Number(response.minPoints ?? 0)
    pointsWithdrawStepPoints.value = Number(response.stepPoints ?? 0)
  } catch (err: any) {
    pointsWithdrawError.value = err.response?.data?.error || '加载积分提现设置失败'
  }
}

const savePointsWithdrawSettings = async () => {
  pointsWithdrawError.value = ''
  pointsWithdrawSuccess.value = ''

  const ratePoints = Number.parseInt(pointsWithdrawRatePoints.value.trim(), 10)
  if (!Number.isFinite(ratePoints) || ratePoints <= 0) {
    pointsWithdrawError.value = '请输入有效的积分比例（正整数）'
    return
  }

  const rateCashCents = parseYuanToCents(pointsWithdrawRateCashYuan.value)
  if (!Number.isFinite(rateCashCents) || rateCashCents <= 0) {
    pointsWithdrawError.value = '请输入有效的返现金额（元）'
    return
  }

  const minCashCents = parseYuanToCents(pointsWithdrawMinCashYuan.value)
  if (!Number.isFinite(minCashCents) || minCashCents < 0) {
    pointsWithdrawError.value = '请输入有效的最低提现金额（元）'
    return
  }

  pointsWithdrawLoading.value = true
  try {
    const response = await adminService.updatePointsWithdrawSettings({
      ratePoints,
      rateCashCents,
      minCashCents,
    })
    pointsWithdrawRatePoints.value = String(response.rate?.points ?? ratePoints)
    pointsWithdrawRateCashYuan.value = ((Number(response.rate?.cashCents ?? rateCashCents) || 0) / 100).toFixed(2)
    pointsWithdrawMinCashYuan.value = ((Number(response.minCashCents ?? minCashCents) || 0) / 100).toFixed(2)
    pointsWithdrawMinPoints.value = Number(response.minPoints ?? 0)
    pointsWithdrawStepPoints.value = Number(response.stepPoints ?? 0)
    pointsWithdrawSuccess.value = '已保存'
    setTimeout(() => (pointsWithdrawSuccess.value = ''), 3000)
  } catch (err: any) {
    pointsWithdrawError.value = err.response?.data?.error || '保存失败'
  } finally {
    pointsWithdrawLoading.value = false
  }
}
</script>

<template>
  <Tabs v-model="activeTab" class="space-y-8">
    <!-- Header Actions -->
    <Teleport v-if="teleportReady && isSuperAdmin" to="#header-actions">
      <div class="flex items-center gap-3">
        <TabsList class="bg-gray-100/70 border border-gray-200 rounded-xl p-1">
          <TabsTrigger value="settings" class="rounded-lg px-4">
            系统设置
          </TabsTrigger>
          <TabsTrigger value="announcements" class="rounded-lg px-4">
            公告管理
          </TabsTrigger>
        </TabsList>

        <Button
          variant="outline"
          :disabled="versionLoading"
          class="h-10 px-4 border-gray-200 bg-white hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 rounded-xl transition-all"
          @click="checkForUpdates"
        >
          <RefreshCw v-if="versionLoading" class="w-4 h-4 mr-2 animate-spin" />
          <RefreshCw v-else class="w-4 h-4 mr-2" />
          检查更新
        </Button>
      </div>
    </Teleport>

    <!-- 版本检查对话框 -->
    <Dialog v-model:open="versionDialogOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="text-xl font-bold text-gray-900">版本信息</DialogTitle>
          <DialogDescription class="text-gray-500">
            查看当前版本和最新版本信息
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4 py-4">
          <div v-if="versionError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ versionError }}
          </div>

          <template v-else>
            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="text-sm text-gray-500">当前版本</p>
                <p class="font-mono font-semibold text-gray-900">{{ currentVersion?.version || '-' }}</p>
              </div>
            </div>

            <div class="flex items-center justify-between p-4 rounded-2xl border" :class="hasNewVersion ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-100'">
              <div class="space-y-1">
                <p class="text-sm" :class="hasNewVersion ? 'text-green-600' : 'text-gray-500'">最新版本</p>
                <p class="font-mono font-semibold" :class="hasNewVersion ? 'text-green-700' : 'text-gray-900'">
                  {{ latestVersion?.version || '尚未发布' }}
                </p>
                <p v-if="latestVersion?.publishedAt" class="text-xs text-gray-400">
                  发布于 {{ new Date(latestVersion.publishedAt).toLocaleDateString('zh-CN') }}
                </p>
              </div>
              <div v-if="hasNewVersion" class="flex items-center gap-2">
                <span class="px-2 py-1 text-xs font-medium text-green-700 bg-green-100 rounded-full">有新版本</span>
              </div>
            </div>

            <div v-if="hasNewVersion && latestVersion?.htmlUrl" class="pt-2">
              <a
                :href="latestVersion.htmlUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center justify-center w-full h-11 px-4 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-xl transition-colors"
              >
                前往 GitHub 查看新版本
              </a>
            </div>

            <div v-else-if="!hasNewVersion && currentVersion" class="text-center text-sm text-gray-500 py-2">
              已是最新版本
            </div>
          </template>
        </div>
      </DialogContent>
    </Dialog>

    <TabsContent value="settings" class="mt-0">
      <!-- 非超级管理员提示 -->
      <Card
        v-if="!isSuperAdmin"
        class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2"
      >
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">系统设置</CardTitle>
          <CardDescription class="text-gray-500">仅超级管理员可查看与修改系统级配置。</CardDescription>
        </CardHeader>
      </Card>

      <div v-else class="space-y-6">
        <!-- 顶部分类导航 (sticky) -->
        <div class="sticky -top-4 lg:-top-8 z-20 -mx-4 px-4 lg:-mx-8 lg:px-8 pt-4 lg:pt-8 pb-3 bg-[#F5F5F7]/90 backdrop-blur-md border-b border-gray-200/60">
          <nav class="flex items-center gap-1.5 overflow-x-auto scrollbar-hide -mb-px">
            <button
              v-for="nav in settingsNav"
              :key="nav.id"
              @click="settingsSubTab = nav.id"
              class="group relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all shrink-0"
              :class="settingsSubTab === nav.id
                ? 'text-blue-700 bg-blue-50'
                : 'text-gray-500 hover:text-gray-800 hover:bg-gray-50'"
            >
              <component
                :is="nav.icon"
                class="w-4 h-4 shrink-0"
                :class="settingsSubTab === nav.id ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'"
              />
              <span>{{ nav.label }}</span>
            </button>
          </nav>
        </div>

        <!-- 内容区 -->
        <div class="space-y-6">
          <!-- 当前分类标题 -->
          <div class="flex items-center gap-3">
            <div class="flex items-center justify-center w-9 h-9 rounded-xl bg-blue-50 text-blue-600">
              <component :is="activeNavItem?.icon" class="w-[18px] h-[18px]" />
            </div>
            <div>
              <h2 class="text-base font-bold text-gray-900">{{ activeNavItem?.label }}</h2>
              <p class="text-xs text-gray-500">{{ activeNavItem?.desc }}</p>
            </div>
          </div>

          <!-- 卡片列表 -->
          <div class="grid gap-6 lg:grid-cols-2">
            <template v-if="settingsSubTab === 'security'">
            <!-- API密钥管理 -->
      <Card
        v-if="isSuperAdmin"
        class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2"
      >
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <div class="flex items-center gap-3 mb-1">
            <div class="w-10 h-10 rounded-2xl bg-purple-50 flex items-center justify-center text-purple-600">
              <KeyRound class="w-5 h-5" />
            </div>
            <CardTitle class="text-xl font-bold text-gray-900">API 密钥</CardTitle>
          </div>
          <CardDescription class="text-gray-500 pl-[52px]">用于外部调用API接口。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
          <form @submit.prevent="handleUpdateApiKey" class="space-y-5">
            <div class="space-y-2">
              <Label for="apiKey" class="text-xs font-semibold text-gray-500 uppercase tracking-wider">API 密钥</Label>
              <div class="flex flex-col sm:flex-row gap-3">
                <div class="relative w-full sm:flex-1">
                  <Input
                    id="apiKey"
                    v-model="apiKey"
                    :type="showApiKey ? 'text' : 'password'"
                    placeholder="至少 16 个字符"
                    required
                    class="h-11 pr-10 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-purple-100 focus:border-purple-500 transition-all font-mono text-sm"
                  />
                  <button
                    type="button"
                    @click="toggleShowApiKey"
                    class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <EyeOff v-if="showApiKey" class="h-4 w-4" />
                    <Eye v-else class="h-4 w-4" />
                  </button>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  @click="generateApiKey"
                  class="w-full sm:w-auto h-11 px-4 border-gray-200 hover:bg-purple-50 hover:text-purple-600 hover:border-purple-200 rounded-xl transition-all"
                >
                  <Sparkles class="h-4 w-4 mr-2" />
                  生成
                </Button>
              </div>
              <p class="text-xs text-gray-400">建议使用 32 位随机字符。</p>
            </div>

            <div v-if="apiKeyError" class="rounded-xl bg-red-50 p-4 flex items-center gap-3 text-red-600 border border-red-100">
              <AlertCircle class="w-5 h-5 flex-shrink-0" />
              <span class="text-sm font-medium">{{ apiKeyError }}</span>
            </div>

            <div v-if="apiKeySuccess" class="rounded-xl bg-green-50 p-4 flex items-center gap-3 text-green-600 border border-green-100">
              <CheckCircle2 class="w-5 h-5 flex-shrink-0" />
              <span class="text-sm font-medium">{{ apiKeySuccess }}</span>
            </div>

            <Button
              type="submit"
              :disabled="apiKeyLoading"
              class="w-full h-11 rounded-xl bg-purple-600 hover:bg-purple-700 text-white shadow-lg shadow-purple-200"
            >
              {{ apiKeyLoading ? '更新中...' : '更新 API 密钥' }}
            </Button>
          </form>

          <div class="rounded-2xl bg-blue-50/50 border border-blue-100 p-5 space-y-2">
            <p class="text-sm font-semibold text-blue-900 flex items-center gap-2">
              <AlertCircle class="w-4 h-4" />
              安全提示
            </p>
            <ul class="list-disc list-inside space-y-1 text-xs text-blue-700/80 pl-1">
              <li>定期轮换密钥可提升安全性。</li>
              <li>请勿将密钥泄露给他人。</li>
            </ul>
          </div>
        </CardContent>
      </Card>

            </template>

            <template v-if="settingsSubTab === 'general'">
            <!-- 邮箱后缀白名单 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">邮箱后缀白名单</CardTitle>
          <CardDescription class="text-gray-500">用于注册时校验邮箱域名（逗号分隔）。留空表示不限制。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-5 flex-1">
          <div class="space-y-2">
            <Label for="emailDomainWhitelist" class="text-xs font-semibold text-gray-500 uppercase tracking-wider">允许的域名</Label>
            <Input
              id="emailDomainWhitelist"
              v-model="emailDomainWhitelist"
              type="text"
              placeholder="example.com,company.com"
              class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
            />
            <p class="text-xs text-gray-400">示例：example.com 或 .example.com（允许子域名）</p>
          </div>

          <div v-if="emailDomainWhitelistError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ emailDomainWhitelistError }}
          </div>

          <div v-if="emailDomainWhitelistSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ emailDomainWhitelistSuccess }}
          </div>

          <Button
            type="button"
            :disabled="emailDomainWhitelistLoading"
            class="w-full h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
            @click="saveEmailDomainWhitelist"
          >
            {{ emailDomainWhitelistLoading ? '保存中...' : '保存白名单' }}
          </Button>
        </CardContent>
      </Card>

      <!-- 功能开关 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">功能开关</CardTitle>
          <CardDescription class="text-gray-500">
            用于快速启用/禁用可选模块；禁用后相关页面/API 会返回 403 提示。
          </CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-5 flex-1">
          <div class="space-y-3">
            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">小红书（订单同步/兑换）</p>
              </div>
              <input
                type="checkbox"
                v-model="featureFlags.xhs"
                class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>

            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">闲鱼（订单同步/兑换）</p>
              </div>
              <input
                type="checkbox"
                v-model="featureFlags.xianyu"
                class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>

            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">支付（ZPAY）</p>
              </div>
              <input
                type="checkbox"
                v-model="featureFlags.payment"
                class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>

            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">开放账号（含 Credit 订单）</p>
              </div>
              <input
                type="checkbox"
                v-model="featureFlags.openAccounts"
                class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>
          </div>

          <div v-if="featureFlagsError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ featureFlagsError }}
          </div>

          <div v-if="featureFlagsSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ featureFlagsSuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 px-4 border-gray-200 rounded-xl"
              @click="loadFeatureFlags"
            >
              刷新
            </Button>
            <Button
              type="button"
              :disabled="featureFlagsLoading"
              class="w-full h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              @click="saveFeatureFlags"
            >
              {{ featureFlagsLoading ? '保存中...' : '保存功能开关' }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <!-- 补录设置 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">补录设置</CardTitle>
          <CardDescription class="text-gray-500">
            控制补录时可用兑换码的创建时间窗口，以及是否强制账号过期覆盖订单截止日。
          </CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-5 flex-1">
          <div class="space-y-3">
            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">强制仅使用当天新创建的兑换码</p>
                <p class="text-xs text-gray-500">关闭后默认使用近 7 天内创建的兑换码（可自定义）。</p>
              </div>
              <input
                type="checkbox"
                v-model="accountRecoveryForceTodayCodes"
                class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500"
              />
            </div>

            <div v-if="!accountRecoveryForceTodayCodes" class="space-y-2 p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <Label for="accountRecoveryCodeWindowDays" class="text-xs font-semibold text-gray-500 uppercase tracking-wider">兑换码创建范围（天）</Label>
              <Input
                id="accountRecoveryCodeWindowDays"
                v-model="accountRecoveryCodeWindowDays"
                type="number"
                min="1"
                max="365"
                placeholder="7"
                class="h-11 bg-white border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
              />
              <p class="text-xs text-gray-400">例如 7 表示允许使用近 7 天内创建的补录码。</p>
            </div>

            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">要求账号过期时间覆盖订单截止日</p>
                <p class="text-xs text-gray-500">仅在开启“强制当天码”时可用；否则后端会强制关闭。</p>
              </div>
              <input
                type="checkbox"
                v-model="accountRecoveryRequireExpireCoverDeadline"
                :disabled="!accountRecoveryForceTodayCodes"
                class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
          </div>

          <div v-if="accountRecoverySettingsError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ accountRecoverySettingsError }}
          </div>

          <div v-if="accountRecoverySettingsSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ accountRecoverySettingsSuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 px-4 border-gray-200 rounded-xl"
              @click="loadAccountRecoverySettings"
            >
              刷新
            </Button>
            <Button
              type="button"
              :disabled="accountRecoverySettingsLoading"
              class="w-full h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              @click="saveAccountRecoverySettings"
            >
              {{ accountRecoverySettingsLoading ? '保存中...' : '保存补录设置' }}
            </Button>
          </div>
        </CardContent>
      </Card>

            </template>

            <template v-if="settingsSubTab === 'security'">
            <!-- 渠道管理 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">渠道管理</CardTitle>
          <CardDescription class="text-gray-500">
            新增/停用渠道，并配置是否允许回退通用码；新增渠道默认使用通用兑换页（/redeem/&lt;key&gt;）。
          </CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-5 flex-1">
          <div class="flex flex-col sm:flex-row gap-3">
            <Button type="button" variant="outline" class="w-full sm:w-auto h-11 px-4 border-gray-200 rounded-xl" :disabled="channelsLoading" @click="loadChannels">
              {{ channelsLoading ? '加载中...' : '刷新' }}
            </Button>
            <Button type="button" class="w-full h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5" @click="openCreateChannelDialog">
              新增渠道
            </Button>
          </div>

          <div v-if="channelsError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ channelsError }}
          </div>
          <div v-if="channelsSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ channelsSuccess }}
          </div>

          <div class="overflow-x-auto border border-gray-100 rounded-2xl">
            <table class="min-w-full text-sm">
              <thead class="bg-gray-50">
                <tr class="text-left text-gray-500">
                  <th class="px-4 py-3 font-semibold">Key</th>
                  <th class="px-4 py-3 font-semibold">名称</th>
                  <th class="px-4 py-3 font-semibold">模式</th>
                  <th class="px-4 py-3 font-semibold">回退通用码</th>
                  <th class="px-4 py-3 font-semibold">状态</th>
                  <th class="px-4 py-3 font-semibold">兑换链接</th>
                  <th class="px-4 py-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="channel in channels" :key="channel.key" class="border-t border-gray-100">
                  <td class="px-4 py-3 font-mono text-gray-900">{{ channel.key }}</td>
                  <td class="px-4 py-3 text-gray-900">{{ channel.name }}</td>
                  <td class="px-4 py-3 font-mono text-gray-700">{{ channel.redeemMode }}</td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-1 rounded-full text-xs font-medium" :class="channel.allowCommonFallback ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'">
                      {{ channel.allowCommonFallback ? '允许' : '不允许' }}
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-1 rounded-full text-xs font-medium" :class="channel.isActive ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'">
                      {{ channel.isActive ? '启用' : '停用' }}
                    </span>
                  </td>
                  <td class="px-4 py-3 font-mono text-gray-700">/redeem/{{ channel.key }}</td>
                  <td class="px-4 py-3">
                    <div class="flex items-center justify-end gap-2">
                      <Button type="button" variant="outline" class="h-9 px-3 border-gray-200 rounded-xl" @click="openEditChannelDialog(channel)">
                        编辑
                      </Button>
                      <Button type="button" variant="outline" class="h-9 px-3 border-gray-200 rounded-xl" @click="toggleChannelActive(channel)">
                        {{ channel.isActive ? '停用' : '启用' }}
                      </Button>
                      <Button v-if="!channel.isBuiltin" type="button" variant="outline" class="h-9 px-3 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 rounded-xl" @click="deleteChannel(channel)">
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!channels.length">
                  <td colspan="7" class="px-4 py-6 text-center text-gray-400">暂无渠道数据</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

            </template>

            <template v-if="settingsSubTab === 'billing'">
            <!-- 支付商品管理 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">支付商品管理</CardTitle>
          <CardDescription class="text-gray-500">
            配置商品价格/服务期/订单类型以及渠道优先级（codeChannels），下单时系统会按优先级自动匹配有库存的渠道并锁定。
          </CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-5 flex-1">
          <div class="flex flex-col sm:flex-row gap-3">
            <Button type="button" variant="outline" class="w-full sm:w-auto h-11 px-4 border-gray-200 rounded-xl" :disabled="purchaseProductsLoading" @click="refreshPurchaseProducts">
              {{ purchaseProductsLoading ? '加载中...' : '刷新' }}
            </Button>
            <Button type="button" class="w-full h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5" @click="openCreatePurchaseProductDialog">
              新增商品
            </Button>
          </div>

          <div v-if="purchaseProductsError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ purchaseProductsError }}
          </div>
          <div v-if="purchaseProductsSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ purchaseProductsSuccess }}
          </div>

          <div class="overflow-x-auto border border-gray-100 rounded-2xl">
            <table class="min-w-full text-sm">
              <thead class="bg-gray-50">
                <tr class="text-left text-gray-500">
                  <th class="px-4 py-3 font-semibold">Key</th>
                  <th class="px-4 py-3 font-semibold">名称</th>
                  <th class="px-4 py-3 font-semibold">价格</th>
                  <th class="px-4 py-3 font-semibold">服务期</th>
                  <th class="px-4 py-3 font-semibold">类型</th>
                  <th class="px-4 py-3 font-semibold">渠道策略</th>
                  <th class="px-4 py-3 font-semibold">库存</th>
                  <th class="px-4 py-3 font-semibold">状态</th>
                  <th class="px-4 py-3 font-semibold text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="product in purchaseProducts" :key="product.productKey" class="border-t border-gray-100">
                  <td class="px-4 py-3 font-mono text-gray-900">{{ product.productKey }}</td>
                  <td class="px-4 py-3 text-gray-900">{{ product.productName }}</td>
                  <td class="px-4 py-3 font-mono text-gray-700">¥ {{ product.amount }}</td>
                  <td class="px-4 py-3 text-gray-700">{{ product.serviceDays }} 天</td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{{ product.orderType }}</span>
                  </td>
                  <td class="px-4 py-3 font-mono text-gray-700">{{ product.codeChannels }}</td>
                  <td class="px-4 py-3 font-mono text-gray-700">{{ purchaseAvailability[product.productKey] ?? '-' }}</td>
                  <td class="px-4 py-3">
                    <span class="px-2 py-1 rounded-full text-xs font-medium" :class="product.isActive ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'">
                      {{ product.isActive ? '上架' : '下架' }}
                    </span>
                  </td>
                  <td class="px-4 py-3">
                    <div class="flex items-center justify-end gap-2">
                      <Button type="button" variant="outline" class="h-9 px-3 border-gray-200 rounded-xl" @click="openEditPurchaseProductDialog(product)">
                        编辑
                      </Button>
                      <Button type="button" variant="outline" class="h-9 px-3 border-gray-200 rounded-xl" @click="togglePurchaseProductActive(product)">
                        {{ product.isActive ? '停用' : '启用' }}
                      </Button>
                      <Button type="button" variant="outline" class="h-9 px-3 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 rounded-xl" @click="deletePurchaseProduct(product)">
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!purchaseProducts.length">
                  <td colspan="9" class="px-4 py-6 text-center text-gray-400">暂无商品数据</td>
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog v-model:open="channelDialogOpen">
        <DialogContent class="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle class="text-xl font-bold text-gray-900">{{ channelDialogMode === 'create' ? '新增渠道' : '编辑渠道' }}</DialogTitle>
            <DialogDescription class="text-gray-500">渠道 key 仅支持小写字母/数字/连字符。</DialogDescription>
          </DialogHeader>

          <div class="space-y-4 py-4">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">渠道 Key</Label>
              <Input v-model="channelFormKey" :disabled="channelDialogMode === 'edit'" placeholder="douyin" class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">渠道名称</Label>
              <Input v-model="channelFormName" placeholder="抖音渠道" class="h-11 bg-gray-50 border-gray-200 rounded-xl text-sm" />
            </div>
            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">允许回退通用码</p>
                <p class="text-xs text-gray-500">开启后可在该渠道入口使用通用渠道兑换码。</p>
              </div>
              <input type="checkbox" v-model="channelFormAllowFallback" class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500" />
            </div>
            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">启用</p>
              </div>
              <input type="checkbox" v-model="channelFormIsActive" class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500" />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">排序（sortOrder）</Label>
              <Input v-model="channelFormSortOrder" type="number" class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
            </div>

            <div class="flex flex-col sm:flex-row gap-3 pt-2">
              <Button type="button" variant="outline" class="w-full sm:w-auto h-11 px-4 border-gray-200 rounded-xl" @click="channelDialogOpen = false">
                取消
              </Button>
              <Button type="button" class="w-full h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5" @click="submitChannelDialog">
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog v-model:open="purchaseProductDialogOpen">
        <DialogContent class="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle class="text-xl font-bold text-gray-900">{{ purchaseProductDialogMode === 'create' ? '新增商品' : '编辑商品' }}</DialogTitle>
            <DialogDescription class="text-gray-500">codeChannels 按优先级用英文逗号分隔，例如：paypal,common</DialogDescription>
          </DialogHeader>

          <div class="space-y-4 py-4">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">商品 Key</Label>
              <Input v-model="purchaseProductFormKey" :disabled="purchaseProductDialogMode === 'edit'" placeholder="warranty_90" class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">名称</Label>
              <Input v-model="purchaseProductFormName" placeholder="质保 90 天" class="h-11 bg-gray-50 border-gray-200 rounded-xl text-sm" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">价格（amount）</Label>
                <Input v-model="purchaseProductFormAmount" placeholder="15.00" class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
              </div>
              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">服务期（天）</Label>
                <Input v-model="purchaseProductFormServiceDays" type="number" class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
              </div>
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">订单类型（orderType）</Label>
              <Select v-model="purchaseProductFormOrderType">
                <SelectTrigger class="h-11 bg-gray-50 border-gray-200 rounded-xl">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="warranty">warranty</SelectItem>
                  <SelectItem value="no_warranty">no_warranty</SelectItem>
                  <SelectItem value="anti_ban">anti_ban</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">渠道策略（codeChannels）</Label>
              <Input v-model="purchaseProductFormCodeChannels" placeholder="paypal,common" class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
              <p class="text-xs text-gray-400">可用渠道：{{ channels.map(c => c.key).join(', ') || '（暂无）' }}</p>
            </div>
            <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div class="space-y-1">
                <p class="font-medium text-gray-900">上架</p>
              </div>
              <input type="checkbox" v-model="purchaseProductFormIsActive" class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500" />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">排序（sortOrder）</Label>
              <Input v-model="purchaseProductFormSortOrder" type="number" class="h-11 bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
            </div>

            <div class="flex flex-col sm:flex-row gap-3 pt-2">
              <Button type="button" variant="outline" class="w-full sm:w-auto h-11 px-4 border-gray-200 rounded-xl" @click="purchaseProductDialogOpen = false">
                取消
              </Button>
              <Button type="button" class="w-full h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5" @click="submitPurchaseProductDialog">
                保存
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

            </template>

            <template v-if="settingsSubTab === 'notifications'">
            <!-- SMTP / 第三方配置 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">SMTP 邮件告警配置</CardTitle>
          <CardDescription class="text-gray-500">用于发送验证码/订单邮件/系统告警邮件（保存后实时生效）。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
          <div class="grid gap-4 lg:grid-cols-3">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">SMTP Host</Label>
              <Input
                v-model="smtpHost"
                type="text"
                placeholder="smtp.example.com"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="smtpLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">端口</Label>
              <Input
                v-model="smtpPort"
                type="text"
                placeholder="465"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="smtpLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">安全连接</Label>
              <Select v-model="smtpSecure" :disabled="smtpLoading">
                <SelectTrigger class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all">
                  <SelectValue placeholder="选择" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">启用 TLS/SSL</SelectItem>
                  <SelectItem value="false">不启用 TLS/SSL</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">用户名</Label>
              <Input
                v-model="smtpUser"
                type="text"
                placeholder="bot@example.com"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="smtpLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">密码</Label>
              <div class="relative">
                <Input
                  v-model="smtpPass"
                  :type="showSmtpPass ? 'text' : 'password'"
                  placeholder="留空表示不修改"
                  class="h-11 pr-10 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  :disabled="smtpLoading"
                />
                <button
                  type="button"
                  @click="toggleShowSmtpPass"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <EyeOff v-if="showSmtpPass" class="h-4 w-4" />
                  <Eye v-else class="h-4 w-4" />
                </button>
              </div>
              <p class="text-xs text-gray-400">
                <template v-if="smtpPassStored">密码已入库；留空表示不修改。</template>
                <template v-else-if="smtpPassSet">当前密码未入库；保存时可自动从 .env 迁移或在此重新填写。</template>
                <template v-else>未设置密码。</template>
              </p>
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">发件人 From</Label>
              <Input
                v-model="smtpFrom"
                type="text"
                placeholder="留空则使用 SMTP_USER"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all text-sm"
                :disabled="smtpLoading"
              />
            </div>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">告警收件人（ADMIN_ALERT_EMAIL）</Label>
            <Input
              v-model="adminAlertEmail"
              type="text"
              placeholder="admin@example.com,ops@example.com"
              class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
              :disabled="smtpLoading"
            />
            <p class="text-xs text-gray-400">多个收件人用逗号分隔；留空则不发送系统告警邮件。</p>
          </div>

          <div v-if="smtpError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ smtpError }}
          </div>

          <div v-if="smtpSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ smtpSuccess }}
          </div>

          <div v-if="smtpTestError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium space-y-2">
            <div>{{ smtpTestError }}</div>
            <div v-if="smtpTestSuggestion" class="text-xs text-red-500">建议：{{ smtpTestSuggestion }}</div>
          </div>

          <div v-if="smtpTestSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ smtpTestSuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 rounded-xl"
              :disabled="smtpLoading || smtpTestLoading"
              @click="loadSmtpSettings"
            >
              刷新
            </Button>
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 rounded-xl"
              :disabled="smtpLoading || smtpTestLoading"
              @click="testSmtpSettings"
            >
              {{ smtpTestLoading ? '测试中...' : '测试 SMTP' }}
            </Button>
            <Button
              type="button"
              class="w-full sm:flex-1 h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              :disabled="smtpLoading || smtpTestLoading"
              @click="saveSmtpSettings"
            >
              {{ smtpLoading ? '保存中...' : '保存 SMTP 配置' }}
            </Button>
          </div>
        </CardContent>
      </Card>
      </template>

      <template v-if="settingsSubTab === 'integrations'">
      <!-- Linux DO OAuth 配置 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">Linux DO OAuth 配置</CardTitle>
          <CardDescription class="text-gray-500">用于 Linux DO 登录/授权（保存后实时生效）。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
          <div class="grid gap-4">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Client ID</Label>
              <Input
                v-model="linuxdoClientId"
                type="text"
                placeholder="Linux DO Client ID"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="linuxdoOauthLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Client Secret</Label>
              <div class="relative">
                <Input
                  v-model="linuxdoClientSecret"
                  :type="showLinuxdoClientSecret ? 'text' : 'password'"
                  placeholder="留空表示不修改"
                  class="h-11 pr-10 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  :disabled="linuxdoOauthLoading"
                />
                <button
                  type="button"
                  @click="toggleShowLinuxdoClientSecret"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <EyeOff v-if="showLinuxdoClientSecret" class="h-4 w-4" />
                  <Eye v-else class="h-4 w-4" />
                </button>
              </div>
              <p class="text-xs text-gray-400">
                <template v-if="linuxdoClientSecretStored">Client Secret 已入库；留空表示不修改。</template>
                <template v-else-if="linuxdoClientSecretSet">Client Secret 未入库；保存时可从 .env 自动迁移或在此重新填写。</template>
                <template v-else>未设置 Client Secret。</template>
              </p>
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Redirect URI</Label>
              <Input
                v-model="linuxdoRedirectUri"
                type="text"
                placeholder="https://example.com/redeem/linux-do"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all text-sm font-mono"
                :disabled="linuxdoOauthLoading"
              />
            </div>
          </div>

          <div v-if="linuxdoOauthError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ linuxdoOauthError }}
          </div>

          <div v-if="linuxdoOauthSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ linuxdoOauthSuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 rounded-xl"
              :disabled="linuxdoOauthLoading"
              @click="loadLinuxDoOAuthSettings"
            >
              刷新
            </Button>
            <Button
              type="button"
              class="w-full sm:flex-1 h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              :disabled="linuxdoOauthLoading"
              @click="saveLinuxDoOAuthSettings"
            >
              {{ linuxdoOauthLoading ? '保存中...' : '保存 Linux DO OAuth 配置' }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">Linux DO Credit 配置</CardTitle>
          <CardDescription class="text-gray-500">用于 Credit 积分支付/回调验签（保存后实时生效）。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
          <div class="grid gap-4 lg:grid-cols-2">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">PID</Label>
              <Input
                v-model="linuxdoCreditPid"
                type="text"
                placeholder="Credit PID"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="linuxdoCreditLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">KEY</Label>
              <div class="relative">
                <Input
                  v-model="linuxdoCreditKey"
                  :type="showLinuxdoCreditKey ? 'text' : 'password'"
                  placeholder="留空表示不修改"
                  class="h-11 pr-10 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  :disabled="linuxdoCreditLoading"
                />
                <button
                  type="button"
                  @click="toggleShowLinuxdoCreditKey"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <EyeOff v-if="showLinuxdoCreditKey" class="h-4 w-4" />
                  <Eye v-else class="h-4 w-4" />
                </button>
              </div>
              <p class="text-xs text-gray-400">
                <template v-if="linuxdoCreditKeyStored">KEY 已入库；留空表示不修改。</template>
                <template v-else-if="linuxdoCreditKeySet">KEY 未入库；保存时可从 .env 自动迁移或在此重新填写。</template>
                <template v-else>未设置 KEY。</template>
              </p>
            </div>
          </div>

          <div v-if="linuxdoCreditError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ linuxdoCreditError }}
          </div>

          <div v-if="linuxdoCreditSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ linuxdoCreditSuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 rounded-xl"
              :disabled="linuxdoCreditLoading"
              @click="loadLinuxDoCreditSettings"
            >
              刷新
            </Button>
            <Button
              type="button"
              class="w-full sm:flex-1 h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              :disabled="linuxdoCreditLoading"
              @click="saveLinuxDoCreditSettings"
            >
              {{ linuxdoCreditLoading ? '保存中...' : '保存 Linux DO Credit 配置' }}
            </Button>
          </div>
        </CardContent>
      </Card>
      </template>

      <template v-if="settingsSubTab === 'billing'">
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">ZPAY 支付配置</CardTitle>
          <CardDescription class="text-gray-500">用于购买下单与回调验签（保存后实时生效）。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
          <div class="grid gap-4 lg:grid-cols-3">
            <div class="space-y-2 lg:col-span-1">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Base URL</Label>
              <Input
                v-model="zpayBaseUrl"
                type="text"
                placeholder="https://zpayz.cn"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="zpayLoading"
              />
              <p class="text-xs text-gray-400">示例：https://zpayz.cn（无需以 / 结尾）</p>
            </div>
            <div class="space-y-2 lg:col-span-1">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">PID</Label>
              <Input
                v-model="zpayPid"
                type="text"
                placeholder="ZPAY PID"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="zpayLoading"
              />
              <p class="text-xs text-gray-400">留空表示不启用支付。</p>
            </div>
            <div class="space-y-2 lg:col-span-1">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">KEY</Label>
              <div class="relative">
                <Input
                  v-model="zpayKey"
                  :type="showZpayKey ? 'text' : 'password'"
                  placeholder="留空表示不修改"
                  class="h-11 pr-10 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  :disabled="zpayLoading"
                />
                <button
                  type="button"
                  @click="toggleShowZpayKey"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <EyeOff v-if="showZpayKey" class="h-4 w-4" />
                  <Eye v-else class="h-4 w-4" />
                </button>
              </div>
              <p class="text-xs text-gray-400">
                <template v-if="zpayKeyStored">KEY 已入库；留空表示不修改。</template>
                <template v-else-if="zpayKeySet">KEY 未入库；保存时可从 .env 自动迁移或在此重新填写。</template>
                <template v-else>未设置 KEY。</template>
              </p>
            </div>
          </div>

          <div v-if="zpayError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ zpayError }}
          </div>

          <div v-if="zpaySuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ zpaySuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 rounded-xl"
              :disabled="zpayLoading"
              @click="loadZpaySettings"
            >
              刷新
            </Button>
            <Button
              type="button"
              class="w-full sm:flex-1 h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              :disabled="zpayLoading"
              @click="saveZpaySettings"
            >
              {{ zpayLoading ? '保存中...' : '保存 ZPAY 配置' }}
            </Button>
          </div>
        </CardContent>
      </Card>
      </template>

      <template v-if="settingsSubTab === 'integrations'">
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">Cloudflare Turnstile 配置</CardTitle>
          <CardDescription class="text-gray-500">用于候车室加入队列的人机验证（保存后实时生效）。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
          <div class="text-xs text-gray-500">
            当前状态：<span class="font-semibold">{{ turnstileEnabled ? '已启用' : '未启用' }}</span>
            <span class="text-gray-400">（需同时配置 Site Key + Secret Key）</span>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Site Key</Label>
              <Input
                v-model="turnstileSiteKey"
                type="text"
                placeholder="0x..."
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="turnstileLoading"
              />
              <p class="text-xs text-gray-400">留空表示禁用人机验证。</p>
            </div>

            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Secret Key</Label>
              <div class="relative">
                <Input
                  v-model="turnstileSecretKey"
                  :type="showTurnstileSecretKey ? 'text' : 'password'"
                  placeholder="留空表示不修改"
                  class="h-11 pr-10 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  :disabled="turnstileLoading"
                />
                <button
                  type="button"
                  @click="toggleShowTurnstileSecretKey"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <EyeOff v-if="showTurnstileSecretKey" class="h-4 w-4" />
                  <Eye v-else class="h-4 w-4" />
                </button>
              </div>
              <p class="text-xs text-gray-400">
                <template v-if="turnstileSecretStored">Secret Key 已入库；留空表示不修改。</template>
                <template v-else-if="turnstileSecretSet">Secret Key 未入库；保存时可从 .env 自动迁移或在此重新填写。</template>
                <template v-else>未设置 Secret Key。</template>
              </p>
            </div>
          </div>

          <div v-if="turnstileError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ turnstileError }}
          </div>

          <div v-if="turnstileSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ turnstileSuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 rounded-xl"
              :disabled="turnstileLoading"
              @click="loadTurnstileSettings"
            >
              刷新
            </Button>
            <Button
              type="button"
              class="w-full sm:flex-1 h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              :disabled="turnstileLoading"
              @click="saveTurnstileSettings"
            >
              {{ turnstileLoading ? '保存中...' : '保存 Turnstile 配置' }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
          <CardTitle class="text-xl font-bold text-gray-900">Telegram Bot 配置</CardTitle>
          <CardDescription class="text-gray-500">用于 Telegram 兑换机器人与系统通知。</CardDescription>
        </CardHeader>
        <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
          <div class="grid gap-4 lg:grid-cols-2">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Bot Token</Label>
              <div class="relative">
                <Input
                  v-model="telegramBotToken"
                  :type="showTelegramBotToken ? 'text' : 'password'"
                  placeholder="留空表示不修改"
                  class="h-11 pr-10 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  :disabled="telegramLoading"
                />
                <button
                  type="button"
                  @click="toggleShowTelegramBotToken"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <EyeOff v-if="showTelegramBotToken" class="h-4 w-4" />
                  <Eye v-else class="h-4 w-4" />
                </button>
              </div>
              <p class="text-xs text-gray-400">
                <template v-if="telegramTokenStored">Token 已入库；留空表示不修改。</template>
                <template v-else-if="telegramTokenSet">Token 未入库；保存时可从 .env 自动迁移或在此重新填写。</template>
                <template v-else>未设置 Token。</template>
              </p>
            </div>

            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">允许的用户 ID (可选)</Label>
              <Input
                v-model="telegramAllowedUserIds"
                type="text"
                placeholder="123456,789012"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="telegramLoading"
              />
              <p class="text-xs text-gray-400">留空表示对所有用户开放；填写后仅允许这些 Telegram User ID。</p>
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">通知开关</Label>
              <Select v-model="telegramNotifyEnabled" :disabled="telegramLoading">
                <SelectTrigger class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all">
                  <SelectValue placeholder="选择" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">启用通知</SelectItem>
                  <SelectItem value="false">禁用通知</SelectItem>
                </SelectContent>
              </Select>
              <p class="text-xs text-gray-400">
                <template v-if="telegramNotifyEnabledStored">已入库。</template>
                <template v-else>未入库（当前值可能来自 .env）。</template>
              </p>
            </div>

            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">通知 chat_id (可选)</Label>
              <Input
                v-model="telegramNotifyChatIds"
                type="text"
                placeholder="-1001234567890,@channelname"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="telegramLoading"
              />
              <p class="text-xs text-gray-400">
                <template v-if="telegramNotifyChatIdsStored">已入库。</template>
                <template v-else>未入库（当前值可能来自 .env）。</template>
                留空则默认发送给「允许的用户 ID」；支持用户ID/群ID（-100...）/频道（@xxx），逗号分隔。
              </p>
            </div>

            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">通知超时（毫秒）</Label>
              <Input
                v-model="telegramNotifyTimeoutMs"
                type="text"
                placeholder="8000"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                :disabled="telegramLoading"
              />
              <p class="text-xs text-gray-400">
                <template v-if="telegramNotifyTimeoutMsStored">已入库。</template>
                <template v-else>未入库（当前值可能来自 .env）。</template>
              </p>
            </div>
          </div>

          <div v-if="telegramError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ telegramError }}
          </div>

          <div v-if="telegramSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
            {{ telegramSuccess }}
          </div>

          <div class="flex flex-col sm:flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              class="w-full sm:w-auto h-11 rounded-xl"
              :disabled="telegramLoading"
              @click="loadTelegramSettings"
            >
              刷新
            </Button>
            <Button
              type="button"
              class="w-full sm:flex-1 h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
              :disabled="telegramLoading"
              @click="saveTelegramSettings"
            >
              {{ telegramLoading ? '保存中...' : '保存 Telegram 配置' }}
            </Button>
          </div>
        </CardContent>
      </Card>
      </template>

      <template v-if="settingsSubTab === 'billing'">
      <!-- 积分提现设置 -->
      <Card v-if="isSuperAdmin" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden flex flex-col lg:col-span-2">
	          <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
	            <CardTitle class="text-xl font-bold text-gray-900">积分提现设置</CardTitle>
	            <CardDescription class="text-gray-500">配置返现比例与提现门槛（保存后实时生效）。</CardDescription>
	          </CardHeader>
	          <CardContent class="p-6 sm:p-8 space-y-6 flex-1">
	            <div class="grid gap-4 lg:grid-cols-3">
	              <div class="space-y-2">
	                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">返现比例：积分</Label>
                <Input
                  v-model="pointsWithdrawRatePoints"
                  type="text"
                  placeholder="1"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all"
                  :disabled="pointsWithdrawLoading"
                />
              </div>
              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">返现比例：金额（元）</Label>
                <Input
                  v-model="pointsWithdrawRateCashYuan"
                  type="text"
                  placeholder="1.00"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all"
                  :disabled="pointsWithdrawLoading"
                />
              </div>
              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">最低提现金额（元）</Label>
                <Input
                  v-model="pointsWithdrawMinCashYuan"
                  type="text"
                  placeholder="10.00"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all"
                  :disabled="pointsWithdrawLoading"
                />
              </div>
            </div>

            <div class="text-xs text-gray-500">
              当前规则：{{ pointsWithdrawRatePoints }} 积分 = {{ pointsWithdrawRateCashYuan }} 元；最低提现约 {{ pointsWithdrawMinPoints ?? '-' }} 积分；步进 {{ pointsWithdrawStepPoints ?? '-' }} 积分
            </div>

            <div v-if="pointsWithdrawError" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
              {{ pointsWithdrawError }}
            </div>

            <div v-if="pointsWithdrawSuccess" class="rounded-xl bg-green-50 p-4 text-green-600 border border-green-100 text-sm font-medium">
              {{ pointsWithdrawSuccess }}
            </div>

	            <div class="flex flex-col sm:flex-row gap-3">
	              <Button
	                type="button"
	                variant="outline"
	                class="w-full sm:w-auto h-11 rounded-xl"
	                :disabled="pointsWithdrawLoading"
	                @click="loadPointsWithdrawSettings"
	              >
	                刷新
	              </Button>
	              <Button
	                type="button"
	                class="w-full sm:flex-1 h-11 rounded-xl bg-black hover:bg-gray-800 text-white shadow-lg shadow-black/5"
	                :disabled="pointsWithdrawLoading"
	                @click="savePointsWithdrawSettings"
	              >
	                {{ pointsWithdrawLoading ? '保存中...' : '保存设置' }}
              </Button>
            </div>
          </CardContent>
      </Card>
      </template>
          </div>
        </div>
      </div>
    </TabsContent>

    <TabsContent v-if="isSuperAdmin" value="announcements" class="mt-0">
      <AnnouncementAdminPanel />
    </TabsContent>
  </Tabs>
</template>
