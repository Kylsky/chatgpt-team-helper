<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted, nextTick, watch } from 'vue'
import { useRouter, useRoute, type LocationQueryRaw } from 'vue-router'
import { authService, gptAccountService, openaiOAuthService, userService, type GptAccount, type CreateGptAccountDto, type SyncUserCountResponse, type SyncAllAccountsResponse, type GptAccountsListParams, type ChatgptAccountInviteItem, type ChatgptAccountCheckInfo, type OpenAIOAuthSession, type OpenAIOAuthExchangeResult } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { buildSpaceTabQuery, buildSpaceTypeQuery, createRequestGuard, readSpaceTabStorage, readSpaceTypeStorage, resolveInitialSpaceTab, resolveInitialSpaceType, resolveSpaceTab, resolveSpaceType, writeSpaceTabStorage, writeSpaceTypeStorage } from '@/lib/accounts-view-state'
import {
  Card,
  CardContent,
  CardFooter,
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import AppleNativeDateTimeInput from '@/components/ui/apple/NativeDateTimeInput.vue'
import { Plus, Eye, EyeOff, RefreshCw, Ban, FilePenLine, Trash2, AlertTriangle, X, FolderOpen, Search, CheckCircle2, AlertCircle, ArrowUp, ArrowDown, Users, Wrench } from 'lucide-vue-next'

const router = useRouter()
const route = useRoute()
const accounts = ref<GptAccount[]>([])
const loading = ref(true)
const error = ref('')
const showDialog = ref(false)
const editingAccount = ref<GptAccount | null>(null)
const paginationMeta = ref({ page: 1, pageSize: 10, total: 0 })

// 搜索和筛选状态
const searchQuery = ref('')
const memberSearchQuery = ref('')
const openStatusFilter = ref<'all' | 'open' | 'closed'>('all')
const spaceTypeFilter = ref<'mother' | 'child'>('child')
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
const { success: showSuccessToast, error: showErrorToast, warning: showWarningToast, info: showInfoToast } = useToast()
const appConfigStore = useAppConfigStore()
const dateFormatOptions = computed(() => ({
  timeZone: 'Asia/Shanghai',
  locale: appConfigStore.locale || 'zh-CN',
}))


const syncingAllAccounts = ref(false)
const rebuildingSortOrder = ref(false)
const showSyncAllProgressPanel = ref(false)
const syncAllProgress = ref<SyncAllAccountsResponse | null>(null)
let syncAllPollingTimer: ReturnType<typeof setTimeout> | null = null
let syncAllPanelAutoHideTimer: ReturnType<typeof setTimeout> | null = null
const activeSpaceTab = ref<'normal' | 'abnormal'>('normal')
const requestGuard = createRequestGuard()

const resolveAccountStatus = (account: GptAccount) => {
  const rawStatusCode = String(account.spaceStatus?.code || account.spaceStatusCode || '').trim().toLowerCase()
  const statusReason = String(account.spaceStatus?.reason || account.spaceStatusReason || '').trim()
  const userCount = Number(account.userCount ?? 0)

  // 优先展示后端持久化状态，避免“到期/异常”被人数文案覆盖。
  if (rawStatusCode === 'abnormal') return { code: 'abnormal' as const, reason: statusReason || '空间异常' }

  if (Number.isFinite(userCount) && userCount > 5) {
    return { code: 'abnormal' as const, reason: `超员（${userCount}人）` }
  }

  if (rawStatusCode === 'normal') {
    if (Number.isFinite(userCount) && userCount === 5) {
      return { code: 'normal' as const, reason: '满员' }
    }
    return { code: 'normal' as const, reason: statusReason || '正常' }
  }

  if (Number.isFinite(userCount) && userCount === 5) {
    return { code: 'normal' as const, reason: '满员' }
  }

  if (rawStatusCode === 'unknown') return { code: 'unknown' as const, reason: statusReason || '状态待确认' }

  return { code: 'unknown' as const, reason: statusReason || '状态待确认' }
}

const resolveStatusBadgeClass = (account: GptAccount) => {
  const status = resolveAccountStatus(account)
  if (status.code === 'normal') return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  if (status.code === 'abnormal') return 'border-red-200 bg-red-50 text-red-700'
  return 'border-amber-200 bg-amber-50 text-amber-700'
}
// Teleport 目标是否存在
const teleportReady = ref(false)

const clearSyncAllPanelAutoHideTimer = () => {
  if (!syncAllPanelAutoHideTimer) return
  clearTimeout(syncAllPanelAutoHideTimer)
  syncAllPanelAutoHideTimer = null
}

const closeSyncAllProgressPanel = () => {
  clearSyncAllPanelAutoHideTimer()
  showSyncAllProgressPanel.value = false
}

const scheduleCloseSyncAllProgressPanel = () => {
  clearSyncAllPanelAutoHideTimer()
  syncAllPanelAutoHideTimer = setTimeout(() => {
    showSyncAllProgressPanel.value = false
    syncAllPanelAutoHideTimer = null
  }, 3000)
}

onMounted(async () => {
  // 等待 DOM 更新后检查 teleport 目标
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  const initialTab = resolveInitialSpaceTab({
    queryValue: route.query.spaceStatus,
    storedValue: readSpaceTabStorage()
  })
  activeSpaceTab.value = initialTab
  writeSpaceTabStorage(initialTab)
  const initialSpaceType = resolveInitialSpaceType({
    queryValue: route.query.spaceType,
    storedValue: readSpaceTypeStorage()
  })
  spaceTypeFilter.value = initialSpaceType
  writeSpaceTypeStorage(initialSpaceType)
  const mergedQuery = buildSpaceTypeQuery(buildSpaceTabQuery(route.query, initialTab), initialSpaceType) as LocationQueryRaw
  if (route.query.spaceStatus !== initialTab || route.query.spaceType !== initialSpaceType) {
    router.replace({ query: mergedQuery })
  }

  await loadAccounts()
})

onUnmounted(() => {
  teleportReady.value = false
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  if (syncAllPollingTimer) {
    clearTimeout(syncAllPollingTimer)
    syncAllPollingTimer = null
  }
  clearSyncAllPanelAutoHideTimer()
  cancelResyncAfterAction()
})

// 计算总页数
const totalPages = computed(() => Math.max(1, Math.ceil(paginationMeta.value.total / paginationMeta.value.pageSize)))

// 同步相关状态
const syncingAccountId = ref<number | null>(null)
const showSyncResultDialog = ref(false)
const syncResult = ref<SyncUserCountResponse | null>(null)
const syncError = ref('')
const hasShownTokenExpiredHint = ref(false)
const previousUserCount = ref<number | null>(null)
const previousInviteCount = ref<number | null>(null)
const deletingUserId = ref<string | null>(null)
const revokingInviteEmail = ref<string | null>(null)
const showInviteForm = ref(false)
const inviteEmail = ref('')
const inviting = ref(false)
const togglingOpenAccountId = ref<number | null>(null)
const banningAccountId = ref<number | null>(null)

// Tab 和 邀请列表状态
const activeTab = ref<'members' | 'invites'>('members')
const membersList = ref<SyncUserCountResponse['users']['items']>([])
const loadingMembers = ref(false)
const invitesList = ref<ChatgptAccountInviteItem[]>([])
const loadingInvites = ref(false)
const resyncingAfterAction = ref(false)
const RESYNC_AFTER_ACTION_DELAY_MS = 3000
let resyncAfterActionTimer: ReturnType<typeof setTimeout> | null = null
let resyncAfterActionVersion = 0

const formData = ref<CreateGptAccountDto>({
  email: '',
  token: '',
  refreshToken: '',
  userCount: 0,
  isBanned: false,
  spaceType: 'child',
  chatgptAccountId: '',
  oaiDeviceId: '',
  expireAt: ''
})

const checkingAccessToken = ref(false)
const checkedChatgptAccounts = ref<ChatgptAccountCheckInfo[]>([])
const checkAccessTokenError = ref('')

// OpenAI OAuth: 从授权码获取 refresh token（会话有效期 10 分钟）
const showOpenaiOAuthPanel = ref(false)
const openaiOAuthSession = ref<OpenAIOAuthSession | null>(null)
const openaiOAuthResult = ref<OpenAIOAuthExchangeResult | null>(null)
const openaiOAuthInput = ref('')
const openaiOAuthError = ref('')
const generatingOpenaiAuthUrl = ref(false)
const exchangingOpenaiCode = ref(false)
const refreshingAccessToken = ref(false)
const cachedApiKey = ref<string>('')
const cachedApiKeyConfigured = ref<boolean | null>(null)
let openaiOAuthFlowNonce = 0

const resolveRequestError = (err: any, fallback: string) => {
  return (
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    err?.message ||
    fallback
  )
}

const isTokenInvalidError = (err: any) => {
  const status = Number(err?.response?.status ?? err?.status ?? 0)
  const message = String(err?.response?.data?.error || err?.response?.data?.message || err?.message || '').toLowerCase()
  if (status === 401 || status === 403) return true
  return /token.*(过期|无效|invalid|expired)|unauthorized|invalid token/.test(message)
}


const isWorkspaceExpiredSyncError = (err: any) => {
  const status = Number(err?.response?.status ?? err?.status ?? 0)
  const code = String(err?.response?.data?.code || err?.code || '').trim().toLowerCase()
  const message = String(err?.response?.data?.error || err?.response?.data?.message || err?.message || '').trim()
  if (code === 'deactivated_workspace') return true
  if (status !== 402) return false
  return /空间已到期|到期|deactivated_workspace/i.test(message)
}

const markAccountStatusAbnormal = async (accountId: number, reason: string) => {
  const idx = accounts.value.findIndex(item => item.id === accountId)
  if (idx === -1) return
  const current = accounts.value[idx]
  if (!current) return

  accounts.value[idx] = {
    ...current,
    spaceStatus: { code: 'abnormal', reason },
    spaceStatusCode: 'abnormal',
    spaceStatusReason: reason,
    updatedAt: current.updatedAt
  }
  accounts.value = [...accounts.value]

  try {
    await gptAccountService.updateSpaceStatus(accountId, { code: 'abnormal', reason })
    await loadAccounts()
  } catch (err: any) {
    showErrorToast(err?.response?.data?.error || '空间状态持久化失败')
  }
}

const ensureSystemApiKey = async (): Promise<string | null> => {
  if (cachedApiKey.value) return cachedApiKey.value

  try {
    const result = await userService.getApiKey()
    const apiKey = typeof result?.apiKey === 'string' ? result.apiKey.trim() : ''
    cachedApiKeyConfigured.value = typeof result?.configured === 'boolean' ? result.configured : null
    if (!apiKey) return null
    cachedApiKey.value = apiKey
    return apiKey
  } catch (err) {
    cachedApiKeyConfigured.value = null
    return null
  }
}

const resetOpenaiOAuthFlow = () => {
  openaiOAuthFlowNonce += 1
  showOpenaiOAuthPanel.value = false
  openaiOAuthSession.value = null
  openaiOAuthResult.value = null
  openaiOAuthInput.value = ''
  openaiOAuthError.value = ''
  generatingOpenaiAuthUrl.value = false
  exchangingOpenaiCode.value = false
}

const copyText = async (value: string, successMessage: string) => {
  if (!value) return
  try {
    await navigator.clipboard.writeText(value)
    showInfoToast(successMessage)
  } catch (error) {
    console.error('Copy failed', error)
    showErrorToast('复制失败，请手动复制')
  }
}

const extractOAuthCode = (value: string): string => {
  const raw = String(value || '').trim()
  if (!raw) return ''

  try {
    const url = new URL(raw)
    const code = url.searchParams.get('code')
    if (code) return code
  } catch {
    // ignore
  }

  const match = raw.match(/[?&]code=([^&#]+)/)
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1])
    } catch {
      return match[1]
    }
  }

  return raw
}

const generateOpenaiAuthUrl = async () => {
  const currentNonce = openaiOAuthFlowNonce
  openaiOAuthError.value = ''
  openaiOAuthResult.value = null
  openaiOAuthInput.value = ''

  const apiKey = await ensureSystemApiKey()
  if (!apiKey) {
    const message =
      cachedApiKeyConfigured.value === false
        ? '系统未配置 API Key，请先到「系统设置」配置后再试'
        : '获取 API Key 失败（需要系统设置权限）'
    openaiOAuthError.value = message
    showErrorToast(message)
    return
  }

  try {
    generatingOpenaiAuthUrl.value = true
    const session = await openaiOAuthService.generateAuthUrl(apiKey)
    if (currentNonce !== openaiOAuthFlowNonce) return
    openaiOAuthSession.value = session
    showOpenaiOAuthPanel.value = true
  } catch (err: any) {
    if (currentNonce !== openaiOAuthFlowNonce) return
    openaiOAuthError.value = resolveRequestError(err, '生成授权链接失败')
    showErrorToast(openaiOAuthError.value)
  } finally {
    if (currentNonce === openaiOAuthFlowNonce) {
      generatingOpenaiAuthUrl.value = false
    }
  }
}

const handleClickGetRefreshToken = async () => {
  showOpenaiOAuthPanel.value = true
  if (openaiOAuthSession.value?.authUrl && openaiOAuthSession.value?.sessionId) return
  await generateOpenaiAuthUrl()
}

const handleManualRefreshAccessToken = async () => {
  if (!editingAccount.value?.id) {
    showErrorToast('请先保存账号后再手动获取 Access Token')
    return
  }

  if (!String(formData.value.refreshToken || '').trim()) {
    showErrorToast('请先填写 Refresh Token')
    return
  }

  refreshingAccessToken.value = true
  try {
    const result = await gptAccountService.refreshToken(editingAccount.value.id)
    const nextAccessToken = String(result?.accessToken || '').trim()
    const nextRefreshToken = String(result?.refreshToken || '').trim()

    if (nextAccessToken) {
      formData.value.token = nextAccessToken
    }
    if (nextRefreshToken) {
      formData.value.refreshToken = nextRefreshToken
    }

    if (result?.account?.updatedAt && editingAccount.value) {
      editingAccount.value = {
        ...editingAccount.value,
        token: nextAccessToken || editingAccount.value.token,
        refreshToken: nextRefreshToken || editingAccount.value.refreshToken,
        updatedAt: result.account.updatedAt
      }
    }

    showSuccessToast(result?.message || 'Access Token 刷新成功，已回填')
  } catch (err: any) {
    showErrorToast(resolveRequestError(err, '刷新 Access Token 失败'))
  } finally {
    refreshingAccessToken.value = false
  }
}

const handleOpenAuthUrl = () => {
  const url = String(openaiOAuthSession.value?.authUrl || '').trim()
  if (!url) return
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch (error) {
    console.error('Open auth url failed', error)
    showErrorToast('打开失败，请复制链接到浏览器打开')
  }
}

const handleExchangeOpenaiCode = async () => {
  const currentNonce = openaiOAuthFlowNonce
  const sessionId = String(openaiOAuthSession.value?.sessionId || '').trim()
  if (!sessionId) {
    showErrorToast('请先点击“获取”生成授权链接')
    return
  }

  const code = extractOAuthCode(openaiOAuthInput.value)
  if (!code) {
    showErrorToast('请粘贴回调 URL 或授权码（code）')
    return
  }

  const apiKey = await ensureSystemApiKey()
  if (!apiKey) {
    const message = '获取 API Key 失败（需要系统设置权限）'
    openaiOAuthError.value = message
    showErrorToast(message)
    return
  }

  try {
    exchangingOpenaiCode.value = true
    openaiOAuthError.value = ''
    const result = await openaiOAuthService.exchangeCode(apiKey, { code, sessionId })
    if (currentNonce !== openaiOAuthFlowNonce) return
    openaiOAuthResult.value = result

    const accessToken = String(result?.tokens?.accessToken || '').trim()
    const refreshToken = String(result?.tokens?.refreshToken || '').trim()
    const accountId = String(result?.accountInfo?.accountId || '').trim()
    const oauthEmail = String(result?.accountInfo?.email || '').trim()

    if (accessToken) {
      formData.value.token = accessToken
    }
    if (refreshToken) {
      formData.value.refreshToken = refreshToken
    } else {
      showWarningToast('未返回 refresh token（可能未授予 offline_access），请确认授权 scope')
    }
    if (accountId) {
      const existingAccountId = String(formData.value.chatgptAccountId || '').trim()
      if (!existingAccountId) {
        formData.value.chatgptAccountId = accountId
      } else if (existingAccountId !== accountId) {
        showWarningToast(`授权返回的 ChatGPT ID 为 ${accountId}，与表单不一致，请确认是否填错`)
      }
    }
    if (oauthEmail) {
      if (!String(formData.value.email || '').trim()) {
        formData.value.email = oauthEmail
      } else if (String(formData.value.email || '').trim().toLowerCase() !== oauthEmail.toLowerCase()) {
        showWarningToast(`授权账号邮箱为 ${oauthEmail}，与表单邮箱不一致，请确认是否填错`)
      }
    }

    // OAuth 交换接口不会返回 Team 订阅到期时间；这里用 access token 额外拉一次账号信息，
    // 尝试自动填充过期时间（entitlement.expires_at）。
    if (accessToken) {
      const alreadyChecking = checkingAccessToken.value
      if (!alreadyChecking) {
        checkingAccessToken.value = true
      }
      try {
        const checked = await gptAccountService.checkAccessToken(accessToken)
        if (currentNonce !== openaiOAuthFlowNonce) return

        checkedChatgptAccounts.value = Array.isArray(checked?.accounts) ? checked.accounts : []
        checkAccessTokenError.value = ''

        const preferredId = String(formData.value.chatgptAccountId || accountId || '').trim()
        if (preferredId) {
          applyCheckedAccountSelection(preferredId)
        }
      } catch (err: any) {
        if (currentNonce !== openaiOAuthFlowNonce) return
        // 不阻塞主流程，失败时允许用户手动填写
        const message = resolveRequestError(err, '获取账号到期时间失败')
        checkAccessTokenError.value = message
      } finally {
        if (!alreadyChecking && currentNonce === openaiOAuthFlowNonce) {
          checkingAccessToken.value = false
        }
      }
    }

    showSuccessToast('已获取并填入 token 信息')
  } catch (err: any) {
    if (currentNonce !== openaiOAuthFlowNonce) return
    openaiOAuthError.value = resolveRequestError(err, '交换授权码失败')
    showErrorToast(openaiOAuthError.value)
  } finally {
    if (currentNonce === openaiOAuthFlowNonce) {
      exchangingOpenaiCode.value = false
    }
  }
}

// 转换存储格式 (YYYY/MM/DD HH:mm:ss) 为 datetime-local 格式 (YYYY-MM-DDTHH:mm:ss)
const toDatetimeLocal = (expireAt: string): string => {
  if (!expireAt) return ''
  // 匹配 YYYY/MM/DD HH:mm:ss 或 YYYY/MM/DD HH:mm 格式
  const match = expireAt.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const [, year, month, day, hour, minute, second = '00'] = match
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`
  }
  return ''
}

// 转换 datetime-local 格式 (YYYY-MM-DDTHH:mm:ss) 为存储格式 (YYYY/MM/DD HH:mm:ss)
const fromDatetimeLocal = (datetimeLocal: string): string => {
  if (!datetimeLocal) return ''
  // datetime-local 格式: YYYY-MM-DDTHH:mm:ss
  const match = datetimeLocal.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (match) {
    const [, year, month, day, hour, minute, second = '00'] = match
    return `${year}/${month}/${day} ${hour}:${minute}:${second}`
  }
  return datetimeLocal // 如果不匹配，返回原值让后端处理
}

const isoToDatetimeLocal = (isoString: string): string => {
  const raw = String(isoString || '').trim()
  if (!raw) return ''
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return ''

  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: appConfigStore.timezone || 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(date)
    const get = (type: string) => parts.find(p => p.type === type)?.value || ''
    const year = get('year')
    const month = get('month')
    const day = get('day')
    const hour = get('hour')
    const minute = get('minute')
    const second = get('second') || '00'
    if (year && month && day && hour && minute) {
      return `${year}-${month}-${day}T${hour}:${minute}:${second}`
    }
  } catch {
    // ignore and fallback to local time
  }

  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const applyCheckedAccountSelection = (accountId: string) => {
  const normalized = String(accountId || '').trim()
  if (!normalized) return

  const matched = checkedChatgptAccounts.value.find(acc => acc.accountId === normalized)
  if (!matched) return

  if (matched.expiresAt) {
    const localValue = isoToDatetimeLocal(matched.expiresAt)
    if (localValue) {
      formData.value.expireAt = localValue
    }
  }
}

const resolveCheckedAccountEmail = (accountId: string) => {
  const normalized = String(accountId || '').trim()
  if (!normalized) return ''
  const matched = checkedChatgptAccounts.value.find(acc => acc.accountId === normalized)
  return String(matched?.email || '').trim()
}

const openChatgptIdDropdown = async () => {
  await nextTick()
  const el = document.getElementById('chatgpt-account-id-input') as HTMLInputElement | null
  el?.focus()
  try {
    // Best-effort: trigger the browser's datalist dropdown.
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
  } catch {
    // ignore
  }
}

const handleCheckAccessToken = async () => {
  const token = String(formData.value.token || '').trim()
  if (!token) {
    showErrorToast('请先填写 Access Token')
    return
  }

  try {
    checkingAccessToken.value = true
    checkAccessTokenError.value = ''

    const result = await gptAccountService.checkAccessToken(token)
    checkedChatgptAccounts.value = Array.isArray(result?.accounts) ? result.accounts : []

    if (!checkedChatgptAccounts.value.length) {
      showErrorToast('校验成功，但未返回可用账号（可能没有 Team 账号权限）')
      return
    }

    showSuccessToast(`校验成功：获取到 ${checkedChatgptAccounts.value.length} 个账号`)

    // If user hasn't filled chatgptAccountId yet and there is only 1 option, autofill it.
    if (!String(formData.value.chatgptAccountId || '').trim() && checkedChatgptAccounts.value.length === 1) {
      formData.value.chatgptAccountId = checkedChatgptAccounts.value[0]?.accountId || ''
    }

    const selectedAccountId = String(formData.value.chatgptAccountId || '').trim()
    applyCheckedAccountSelection(selectedAccountId)

    const checkedEmail = resolveCheckedAccountEmail(selectedAccountId)
    if (checkedEmail) {
      const currentEmail = String(formData.value.email || '').trim()
      if (!currentEmail) {
        formData.value.email = checkedEmail
      } else if (currentEmail.toLowerCase() !== checkedEmail.toLowerCase()) {
        showWarningToast(`授权账号邮箱为 ${checkedEmail}，与表单邮箱不一致，请确认是否填错`)
      }
    }
    await openChatgptIdDropdown()
  } catch (err: any) {
    const message = err?.response?.data?.error || '校验失败'
    checkAccessTokenError.value = message
    showErrorToast(message)
  } finally {
    checkingAccessToken.value = false
  }
}

// 切换页码
const goToPage = (page: number) => {
  if (page < 1 || page > totalPages.value || page === paginationMeta.value.page) return
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  paginationMeta.value.page = page
  loadAccounts()
}

const loadAccounts = async () => {
  const requestId = requestGuard.nextId()
  try {
    loading.value = true
    error.value = ''
    const params: GptAccountsListParams = {
      page: paginationMeta.value.page,
      pageSize: paginationMeta.value.pageSize,
    }
    // 添加搜索参数
    if (searchQuery.value.trim()) {
      params.search = searchQuery.value.trim()
    }
    if (memberSearchQuery.value.trim()) {
      params.memberSearch = memberSearchQuery.value.trim()
    }
    // 添加筛选参数
    if (openStatusFilter.value !== 'all') {
      params.openStatus = openStatusFilter.value
    }
    params.spaceType = spaceTypeFilter.value
    params.spaceStatus = activeSpaceTab.value === 'normal' ? 'normal' : 'abnormal'
    const response = await gptAccountService.getAll(params)
    if (!requestGuard.isLatest(requestId)) return
    const normalizedAccounts = (response.accounts || []).map((item: any) => {
      const source = item && typeof item === 'object' ? item : {}
      const expireAt = source.expireAt ?? source.expire_at ?? source.expireTime ?? source.expire_time ?? source.expiresAt ?? null
      const rawSpaceStatusCode = String(source.spaceStatusCode ?? source.space_status_code ?? source.spaceStatus?.code ?? '').trim().toLowerCase()
      const spaceStatusCode = rawSpaceStatusCode === 'normal' || rawSpaceStatusCode === 'abnormal' || rawSpaceStatusCode === 'unknown'
        ? rawSpaceStatusCode
        : 'unknown'
      const spaceStatusReason = String(source.spaceStatusReason ?? source.space_status_reason ?? source.spaceStatus?.reason ?? '').trim()
      return {
        ...source,
        spaceType: source.spaceType || source.space_type || 'child',
        spaceName: String(source.spaceName ?? source.space_name ?? '').trim(),
        spaceStatusCode,
        spaceStatusReason,
        spaceStatus: { code: spaceStatusCode, reason: spaceStatusReason },
        expireAt: expireAt == null ? null : String(expireAt),
      }
    })
    accounts.value = normalizedAccounts
    paginationMeta.value = response.pagination || { page: 1, pageSize: 10, total: 0 }
  } catch (err: any) {
    if (!requestGuard.isLatest(requestId)) return
    error.value = err.response?.data?.error || 'Failed to load accounts'
    if (err.response?.status === 401 || err.response?.status === 403) {
      authService.logout()
      router.push('/login')
    }
  } finally {
    if (requestGuard.isLatest(requestId)) {
      loading.value = false
    }
  }
}

// 搜索处理
const handleSpaceTabChange = (tab: 'normal' | 'abnormal') => {
  if (resolveSpaceTab(route.query.spaceStatus) === tab) return
  router.replace({ query: buildSpaceTabQuery(route.query, tab) as LocationQueryRaw })
}

const handleSearch = () => {
  paginationMeta.value.page = 1
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  loadAccounts()
}

// 监听筛选变化
watch(openStatusFilter, () => {
  paginationMeta.value.page = 1
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  loadAccounts()
})

watch(spaceTypeFilter, (value) => {
  if (resolveSpaceType(route.query.spaceType) === value) return
  writeSpaceTypeStorage(value)
  router.replace({ query: buildSpaceTypeQuery(route.query, value) as LocationQueryRaw })
})

watch(searchQuery, () => {
  paginationMeta.value.page = 1
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }
  searchDebounceTimer = setTimeout(() => {
    loadAccounts()
    searchDebounceTimer = null
  }, 300)
})

watch(memberSearchQuery, () => {
  paginationMeta.value.page = 1
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }
  searchDebounceTimer = setTimeout(() => {
    loadAccounts()
    searchDebounceTimer = null
  }, 300)
})

watch(
  () => route.query.spaceStatus,
  (value) => {
    const nextTab = resolveSpaceTab(value)
    if (activeSpaceTab.value !== nextTab) {
      activeSpaceTab.value = nextTab
    }
    writeSpaceTabStorage(nextTab)
    paginationMeta.value.page = 1
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
    }
    loadAccounts()
  }
)

watch(
  () => route.query.spaceType,
  (value) => {
    const nextType = resolveSpaceType(value)
    if (spaceTypeFilter.value !== nextType) {
      spaceTypeFilter.value = nextType
    }
    writeSpaceTypeStorage(nextType)
    paginationMeta.value = {
      ...paginationMeta.value,
      page: 1
    }
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer)
      searchDebounceTimer = null
    }
    loadAccounts()
  }
)


watch(
  () => formData.value.chatgptAccountId,
  (nextValue) => {
    applyCheckedAccountSelection(String(nextValue || ''))
  }
)

const openEditDialog = (account: GptAccount) => {
  editingAccount.value = account
  formData.value = {
    email: account.email,
    token: account.token,
    refreshToken: account.refreshToken || '',
    userCount: account.userCount,
    isBanned: Boolean(account.isBanned),
    spaceType: account.spaceType || 'child',
    chatgptAccountId: account.chatgptAccountId || '',
    oaiDeviceId: account.oaiDeviceId || '',
    expireAt: toDatetimeLocal(account.expireAt || '')
  }
  showDialog.value = true
}

const closeDialog = () => {
  showDialog.value = false
  editingAccount.value = null
  formData.value = { email: '', token: '', refreshToken: '', userCount: 0, isBanned: false, spaceType: 'child', chatgptAccountId: '', oaiDeviceId: '', expireAt: '' }
  checkedChatgptAccounts.value = []
  checkAccessTokenError.value = ''
  checkingAccessToken.value = false
  resetOpenaiOAuthFlow()
}

const handleSubmit = async () => {
  try {
    const payload: CreateGptAccountDto = {
      ...formData.value,
      email: formData.value.email.trim(),
      token: formData.value.token.trim(),
      refreshToken: formData.value.refreshToken?.trim() || '',
      chatgptAccountId: formData.value.chatgptAccountId?.trim() || '',
      oaiDeviceId: formData.value.oaiDeviceId?.trim() || '',
      expireAt: fromDatetimeLocal(formData.value.expireAt?.trim() || ''),
      spaceType: formData.value.spaceType || 'child',
    }

    if (!payload.chatgptAccountId) {
      showErrorToast('ChatGPT ID 为必填')
      return
    }

    if (editingAccount.value) {
      await gptAccountService.update(editingAccount.value.id, payload)
      showSuccessToast('账号更新成功')
    } else {
      await gptAccountService.create(payload)
      showSuccessToast('账号创建成功')
    }
    await loadAccounts()
    closeDialog()
  } catch (err: any) {
    error.value = err.response?.data?.error || 'Operation failed'
    showErrorToast(error.value)
  }
}

const handleDelete = async (id: number) => {
  if (!confirm('确定要删除这个账号吗？')) return

  try {
    await gptAccountService.delete(id)
    showSuccessToast('账号已删除')
    await loadAccounts()
  } catch (err: any) {
    error.value = err.response?.data?.error || 'Delete failed'
    showErrorToast(error.value)
  }
}

const handleToggleOpen = async (account: GptAccount) => {
  togglingOpenAccountId.value = account.id
  try {
    const nextOpen = !Boolean(account.isOpen)
    const updated = await gptAccountService.setOpen(account.id, nextOpen)

    const index = accounts.value.findIndex(a => a.id === account.id)
   if (index !== -1) {
      const current = accounts.value[index]
      if (!current) return
      accounts.value[index] = {
        ...current,
        isOpen: Boolean(updated.isOpen),
        updatedAt: updated.updatedAt
      }
      accounts.value = [...accounts.value]
    }

    showSuccessToast(nextOpen ? '账号已开放' : '账号已隐藏')
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '操作失败')
  } finally {
    togglingOpenAccountId.value = null
  }
}

const handleBanAccount = async (account: GptAccount) => {
  if (account.isBanned) return

  if (!confirm(`确定将账号 ${account.email} 标记为封号吗？标记后将自动关闭开放状态。`)) return

  banningAccountId.value = account.id
  try {
    const updated = await gptAccountService.ban(account.id)
    const index = accounts.value.findIndex(a => a.id === account.id)
    if (index !== -1) {
      const current = accounts.value[index]
      if (!current) return
      accounts.value[index] = { ...current, ...updated }
      accounts.value = [...accounts.value]
    }
    showSuccessToast('账号已标记为封号')
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '操作失败')
  } finally {
    banningAccountId.value = null
  }
}

// 同步用户数量
const applySyncResultToState = (result: SyncUserCountResponse) => {
  syncResult.value = result
  membersList.value = Array.isArray(result.users?.items) ? [...result.users.items] : []

  const index = accounts.value.findIndex(a => a.id === result.account.id)
  if (index !== -1) {
    const current = accounts.value[index]
    if (!current) return
    const nextInviteCount = typeof result.inviteCount === 'number'
      ? result.inviteCount
      : typeof result.account.inviteCount === 'number'
        ? result.account.inviteCount
        : current.inviteCount
    accounts.value[index] = {
      ...current,
      userCount: result.syncedUserCount,
      inviteCount: typeof nextInviteCount === 'number' ? nextInviteCount : current.inviteCount,
      spaceStatus: result.account?.spaceStatus || current.spaceStatus,
      updatedAt: result.account.updatedAt
    }
    accounts.value = [...accounts.value]
  }
}

const cancelResyncAfterAction = () => {
  resyncAfterActionVersion += 1
  if (resyncAfterActionTimer) {
    clearTimeout(resyncAfterActionTimer)
    resyncAfterActionTimer = null
  }
  resyncingAfterAction.value = false
}

const scheduleResyncAfterAction = (accountId: number) => {
  if (!accountId) return

  resyncAfterActionVersion += 1
  if (resyncAfterActionTimer) {
    clearTimeout(resyncAfterActionTimer)
    resyncAfterActionTimer = null
  }

  const version = resyncAfterActionVersion
  resyncingAfterAction.value = true

  resyncAfterActionTimer = setTimeout(async () => {
    try {
      if (version !== resyncAfterActionVersion) return
      if (!showSyncResultDialog.value) return
      if (syncResult.value?.account?.id !== accountId) return

      previousUserCount.value = syncResult.value?.syncedUserCount ?? previousUserCount.value
      previousInviteCount.value = syncResult.value?.inviteCount ?? previousInviteCount.value

      const latestResult = await gptAccountService.syncUserCount(accountId)
      if (version !== resyncAfterActionVersion) return
      applySyncResultToState(latestResult)
      await loadMembers(accountId)

      await loadInvites(accountId)
    } catch (err: any) {
      if (version !== resyncAfterActionVersion) return
      const message = err.response?.data?.error || '重新同步失败，请稍后再试'
      showErrorToast(message)
    } finally {
      if (version === resyncAfterActionVersion) {
        resyncingAfterAction.value = false
        resyncAfterActionTimer = null
      }
    }
  }, RESYNC_AFTER_ACTION_DELAY_MS)
}

const loadMembers = async (accountId: number) => {
  if (!accountId) return
  loadingMembers.value = true
  try {
    const response = await gptAccountService.getMembers(accountId, {
      offset: 0,
      limit: 200,
      query: '',
    })
    membersList.value = Array.isArray(response.items) ? response.items : []
  } catch (err: any) {
    const message = resolveRequestError(err, '获取成员缓存失败')
    showErrorToast(message)
    membersList.value = []
  } finally {
    loadingMembers.value = false
  }
}


const handleMoveAccount = async (account: GptAccount, direction: 'up' | 'down') => {
  const list = accounts.value
  const index = list.findIndex(item => item.id === account.id)
  if (index === -1) return
  const targetIndex = direction === 'up' ? index - 1 : index + 1
  if (targetIndex < 0 || targetIndex >= list.length) return

  const next = [...list]
  const current = next[index]
  const target = next[targetIndex]
  if (!current || !target) return
  next[index] = target
  next[targetIndex] = current
  accounts.value = next

  try {
    await gptAccountService.reorder(next.map(item => item.id))
    showSuccessToast('排序已更新')
  } catch (err: any) {
    showErrorToast(err?.response?.data?.error || '排序保存失败')
    await loadAccounts()
  }
}


const handleRebuildSortOrder = async () => {
  if (rebuildingSortOrder.value) return
  const confirmed = window.confirm('将按创建时间重建全量账号排序，是否继续？')
  if (!confirmed) return

  rebuildingSortOrder.value = true
  try {
    const result = await gptAccountService.rebuildSortOrder()
    showSuccessToast(result?.message || '排序已重建')
    paginationMeta.value.page = 1
    await loadAccounts()
  } catch (err: any) {
    showErrorToast(err?.response?.data?.error || '重建排序失败')
  } finally {
    rebuildingSortOrder.value = false
  }
}

const handleSyncAllSpaces = async () => {
  if (syncingAllAccounts.value) return

  if (syncAllPollingTimer) {
    clearTimeout(syncAllPollingTimer)
    syncAllPollingTimer = null
  }
  clearSyncAllPanelAutoHideTimer()
  syncingAllAccounts.value = true
  showSyncAllProgressPanel.value = true
  syncAllProgress.value = null

  const pollSyncAllProgress = async (taskId: string) => {
    try {
      const progress = await gptAccountService.getSyncAllProgress(taskId)
      syncAllProgress.value = progress

      if (progress.status === 'running') {
        syncAllPollingTimer = setTimeout(() => {
          pollSyncAllProgress(taskId)
        }, 1000)
        return
      }

      const failCount = Number(progress.failedCount || 0)
      const successCount = Number(progress.successCount || 0)
      if (progress.status === 'completed') {
        showSuccessToast(`同步完成：成功 ${successCount}，异常 ${failCount}`)
        scheduleCloseSyncAllProgressPanel()
      } else {
        showErrorToast(`同步任务失败：异常 ${failCount}`)
      }
      await loadAccounts()
    } catch (err: any) {
      showErrorToast(err?.response?.data?.error || '获取同步进度失败')
    } finally {
      syncingAllAccounts.value = false
      syncAllPollingTimer = null
    }
  }

  try {
    const task = await gptAccountService.syncAll()
    syncAllProgress.value = task
    if (!task.taskId) {
      throw new Error('同步任务创建失败：缺少任务ID')
    }
    await pollSyncAllProgress(task.taskId)
  } catch (err: any) {
    showErrorToast(err?.response?.data?.error || '一键同步失败')
    syncingAllAccounts.value = false
    syncAllPollingTimer = null
  } finally {
    if (syncAllPollingTimer) {
      clearTimeout(syncAllPollingTimer)
      syncAllPollingTimer = null
    }
  }
}

const handleShowMembers = async (account: GptAccount) => {
  cancelResyncAfterAction()
  syncingAccountId.value = account.id
  membersList.value = []
  syncError.value = ''
  syncResult.value = {
    message: '已加载本地缓存成员信息',
    account,
    syncedUserCount: Number(account.userCount || 0),
    inviteCount: typeof account.inviteCount === 'number' ? account.inviteCount : 0,
    users: { items: [], total: 0, limit: 0, offset: 0 },
  }
  invitesList.value = []
  activeTab.value = 'members'
  previousUserCount.value = account.userCount
  previousInviteCount.value = typeof account.inviteCount === 'number' ? account.inviteCount : null
  showSyncResultDialog.value = true

  try {
    await loadMembers(account.id)
  } catch (err: any) {
    syncError.value = err.response?.data?.error || '获取成员信息失败'
    showErrorToast(syncError.value)
  } finally {
    syncingAccountId.value = null
  }
}

const handleSyncUserCount = async (account: GptAccount) => {
  cancelResyncAfterAction()
  syncingAccountId.value = account.id
  syncError.value = ''
  syncResult.value = null
  invitesList.value = []
  activeTab.value = 'members'
  previousUserCount.value = account.userCount
  previousInviteCount.value = typeof account.inviteCount === 'number' ? account.inviteCount : null

  try {
    const result = await gptAccountService.syncUserCount(account.id)
    applySyncResultToState(result)

    // 同步后仅更新列表，不弹出成员信息
    showSuccessToast('同步成功')
  } catch (err: any) {
    if (isWorkspaceExpiredSyncError(err)) {
      await markAccountStatusAbnormal(account.id, '到期')
      showErrorToast('空间已到期')
    } else if (isTokenInvalidError(err)) {
      await markAccountStatusAbnormal(account.id, 'Token 已过期或无效，请更新账号 token')
      if (!hasShownTokenExpiredHint.value) {
        showErrorToast('Token 已过期或无效，请更新账号 token 后重试同步')
        hasShownTokenExpiredHint.value = true
      }
    } else {
      showErrorToast(err.response?.data?.error || '同步失败，请检查网络连接和账号配置')
    }
  } finally {
    syncingAccountId.value = null
  }
}

const loadInvites = async (accountId: number) => {
  loadingInvites.value = true
  try {
    const response = await gptAccountService.getInvites(accountId)
    invitesList.value = response.items || []
  } catch (err) {
    console.error('Failed to load invites:', err)
  } finally {
    loadingInvites.value = false
  }
}

const resetInviteForm = () => {
  inviteEmail.value = ''
  showInviteForm.value = false
  inviting.value = false
}

// 关闭同步结果对话框
const closeSyncResultDialog = () => {
  cancelResyncAfterAction()
  showSyncResultDialog.value = false
  syncResult.value = null
  syncError.value = ''
  membersList.value = []
  previousUserCount.value = null
  previousInviteCount.value = null
  invitesList.value = []
  activeTab.value = 'members'
  resetInviteForm()
}

const handleMembersTabClick = async () => {
  activeTab.value = 'members'
  const accountId = syncResult.value?.account?.id
  if (accountId) {
    await loadMembers(accountId)
  }
}

const handleInvitesTabClick = async () => {
  activeTab.value = 'invites'
  const accountId = syncResult.value?.account?.id
  if (accountId) {
    await loadInvites(accountId)
  }
}

const handleDeleteSyncedUser = async (userId?: string) => {
  if (!syncResult.value || !syncResult.value.account || !userId) {
    showErrorToast('缺少必要的账号或成员信息')
    return
  }

  if (!confirm('确定要从 ChatGPT 账号中删除该成员吗？此操作不可撤销。')) {
    return
  }

  deletingUserId.value = userId
  try {
    previousUserCount.value = syncResult.value?.syncedUserCount ?? previousUserCount.value
    const result = await gptAccountService.deleteAccountUser(syncResult.value.account.id, userId)
    applySyncResultToState(result)
    showSuccessToast(result.message || '成员已删除')
    scheduleResyncAfterAction(result.account.id)
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '删除失败')
  } finally {
    deletingUserId.value = null
  }
}

const handleRevokeInvite = async (emailAddress?: string) => {
  if (!syncResult.value?.account?.id) {
    showErrorToast('请先同步账号后再撤回邀请')
    return
  }

  const email = String(emailAddress || '').trim()
  if (!email) {
    showErrorToast('缺少邀请邮箱')
    return
  }
  const normalizedEmail = email.toLowerCase()

  if (!confirm(`确定要撤回对 ${email} 的邀请吗？`)) {
    return
  }

  revokingInviteEmail.value = normalizedEmail
  const currentInviteCount = syncResult.value.inviteCount ?? 0

  try {
    const result = await gptAccountService.deleteAccountInvite(syncResult.value.account.id, normalizedEmail)
    showSuccessToast(result.message || '邀请已撤回')

    previousInviteCount.value = currentInviteCount
    syncResult.value.account = result.account
    syncResult.value.inviteCount = result.inviteCount

    const index = accounts.value.findIndex(a => a.id === result.account.id)
    if (index !== -1) {
      const current = accounts.value[index]
      if (current) {
        accounts.value[index] = {
          ...current,
          inviteCount: result.inviteCount,
          updatedAt: result.account.updatedAt
        }
        accounts.value = [...accounts.value]
      }
    }

    invitesList.value = invitesList.value.filter(invite => {
      const inviteEmail = String(invite.email_address || '').trim().toLowerCase()
      return inviteEmail !== normalizedEmail
    })
    scheduleResyncAfterAction(syncResult.value.account.id)
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '撤回邀请失败')
  } finally {
    revokingInviteEmail.value = null
  }
}

const handleInviteSubmit = async () => {
  if (!syncResult.value || !syncResult.value.account) {
    showErrorToast('请先同步账号后再邀请成员')
    return
  }

  const email = inviteEmail.value.trim()
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

  if (!email) {
    showErrorToast('请输入邮箱地址')
    return
  }

  if (!emailRegex.test(email)) {
    showErrorToast('邮箱格式不正确')
    return
  }

  inviting.value = true
  try {
    const result = await gptAccountService.inviteAccountUser(syncResult.value.account.id, email)
    showSuccessToast(result.message || '邀请已发送')
    resetInviteForm()
    // 切换到邀请列表 Tab
    activeTab.value = 'invites'
    scheduleResyncAfterAction(syncResult.value.account.id)
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '邀请失败')
  } finally {
    inviting.value = false
  }
}
</script>

<template>
  <div class="space-y-8">
    <div
      v-if="showSyncAllProgressPanel"
      class="fixed right-6 top-20 z-50 w-80 rounded-2xl border border-gray-200 bg-white/95 p-4 shadow-xl backdrop-blur"
    >
      <div class="mb-2 flex items-center justify-between">
        <div class="text-sm font-semibold text-gray-900">一键同步进度</div>
        <button
          type="button"
          class="rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
          @click="closeSyncAllProgressPanel"
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <div v-if="syncAllProgress" class="space-y-2 text-sm text-gray-700">
        <p>
          {{ syncAllProgress.status === 'running' ? '同步中' : '同步完成' }}：
          {{ syncAllProgress.completed }}/{{ syncAllProgress.total }}
        </p>
        <p>异常数：{{ syncAllProgress.failedCount }}</p>
        <div class="h-2 overflow-hidden rounded-full bg-gray-100">
          <div
            class="h-full rounded-full bg-blue-500 transition-all duration-300"
            :style="{ width: `${syncAllProgress.total > 0 ? Math.min(100, Math.round((syncAllProgress.completed / syncAllProgress.total) * 100)) : 0}%` }"
          />
        </div>
      </div>

      <div v-else class="text-sm text-gray-500">正在初始化同步任务...</div>
    </div>

    <!-- Header Actions -->
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-2">
      <Button
        @click="handleSyncAllSpaces"
        :disabled="syncingAllAccounts"
        variant="outline"
        class="rounded-xl px-5 h-10"
      >
        <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': syncingAllAccounts }" />
        一键同步
      </Button>
      <Button
        @click="handleRebuildSortOrder"
        :disabled="rebuildingSortOrder"
        variant="outline"
        class="rounded-xl px-5 h-10"
      >
        <Wrench class="w-4 h-4 mr-2" :class="{ 'animate-spin': rebuildingSortOrder }" />
        重建排序
      </Button>
      <Button
        @click="showDialog = true"
        class="bg-black hover:bg-gray-800 text-white rounded-xl px-5 h-10 shadow-lg shadow-black/10 transition-all hover:scale-[1.02] active:scale-[0.98]"
      >
        <Plus class="w-4 h-4 mr-2" />
        新建账号
      </Button>
      </div>
    </Teleport>

    <!-- 筛选控制栏 -->
    <div class="flex flex-col sm:flex-row gap-4 justify-between items-start sm:items-center">
      <div class="flex flex-wrap items-center gap-3 w-full sm:w-auto">
        <div class="relative group w-full sm:w-64">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 h-4 w-4 transition-colors" />
          <Input
            v-model.trim="searchQuery"
            placeholder="搜索邮箱/空间名称..."
            class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
            @keyup.enter="handleSearch"
          />
        </div>

        <div class="relative group w-full sm:w-72">
          <Users class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 h-4 w-4 transition-colors" />
          <Input
            v-model.trim="memberSearchQuery"
            placeholder="按成员邮箱/昵称/ID搜索空间..."
            class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
          />
        </div>

        <Select v-model="openStatusFilter">
          <SelectTrigger class="h-11 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
            <SelectValue placeholder="状态筛选" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="open">已开放</SelectItem>
            <SelectItem value="closed">未开放</SelectItem>
          </SelectContent>
        </Select>

        <Select v-model="spaceTypeFilter">
          <SelectTrigger class="h-11 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
            <SelectValue placeholder="空间归属" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="child">子空间</SelectItem>
            <SelectItem value="mother">母空间</SelectItem>
          </SelectContent>
        </Select>

      </div>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
      <AlertTriangle class="h-5 w-5" />
      <span class="font-medium">{{ error }}</span>
    </div>

    <!-- Main Content -->
    <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden min-h-[400px]">
      
      <div class="px-6 pt-5">
        <div class="inline-flex rounded-xl bg-gray-100 p-1 text-sm">
          <button
            class="px-4 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :class="activeSpaceTab === 'normal' ? 'bg-white shadow text-gray-900' : 'text-gray-500'"
            :disabled="loading"
            @click="handleSpaceTabChange('normal')"
          >
            正常空间
          </button>
          <button
            class="px-4 py-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            :class="activeSpaceTab === 'abnormal' ? 'bg-white shadow text-gray-900' : 'text-gray-500'"
            :disabled="loading"
            @click="handleSpaceTabChange('abnormal')"
          >
            异常空间
          </button>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="flex flex-col items-center justify-center py-20">
        <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
        <p class="text-gray-400 text-sm font-medium mt-4">正在加载...</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="accounts.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
        <div class="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
          <FolderOpen class="w-8 h-8 text-gray-400" />
        </div>
        <h3 class="text-lg font-semibold text-gray-900">暂无账号</h3>
        <p class="text-gray-500 text-sm mt-1 mb-6">点击上方按钮创建第一个账号</p>
        <Button @click="showDialog = true" class="rounded-xl bg-blue-600 hover:bg-blue-700 text-white">
          <Plus class="w-4 h-4 mr-2" />
          新建账号
        </Button>
      </div>

      <!-- Table & Mobile List -->
      <div v-else>
        <!-- Desktop Table -->
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">ID</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">排序</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">邮箱</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">空间名称</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">已加入</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">待加入</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">空间状态</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">过期时间</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">创建时间</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr
                v-for="account in accounts"
                :key="account.id"
                class="group hover:bg-blue-50/30 transition-colors duration-200"
              >
                <td class="px-6 py-5 text-sm font-medium text-blue-500">#{{ account.id }}</td>
                <td class="px-6 py-5">
                  <div class="flex items-center justify-center gap-1">
                    <Button size="icon" variant="ghost" class="h-7 w-7" @click="handleMoveAccount(account, 'up')"><ArrowUp class="w-3.5 h-3.5" /></Button>
                    <Button size="icon" variant="ghost" class="h-7 w-7" @click="handleMoveAccount(account, 'down')"><ArrowDown class="w-3.5 h-3.5" /></Button>
                  </div>
                </td>
	                <td class="px-6 py-5">
	                  <div class="flex items-center gap-3">
	                    <div class="w-8 h-8 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-xs font-bold text-gray-600">
	                      {{ account.email.charAt(0).toUpperCase() }}
	                    </div>
	                    <span
	                      class="text-sm font-medium"
	                      :class="account.isBanned ? 'text-red-600' : 'text-gray-900'"
	                    >
	                      {{ account.email }}
	                    </span>
	                  </div>
	                </td>
                <td class="px-6 py-5 text-sm text-gray-500">
                  {{ account.spaceName || '-' }}
                </td>
                <td class="px-6 py-5 text-center">
                  <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-100">
                    {{ account.userCount }} 人
                  </span>
                </td>
                <td class="px-6 py-5 text-center">
                   <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold bg-purple-50 text-purple-600 border border-purple-100">
                    {{ account.inviteCount ?? 0 }} 人
                  </span>
                </td>
                <td class="px-6 py-5">
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
                    :class="resolveStatusBadgeClass(account)"
                  >
                    <CheckCircle2 v-if="resolveAccountStatus(account).code === 'normal'" class="w-3.5 h-3.5" />
                    <AlertTriangle v-else-if="resolveAccountStatus(account).code === 'unknown'" class="w-3.5 h-3.5" />
                    <AlertCircle v-else class="w-3.5 h-3.5" />
                    {{ resolveAccountStatus(account).reason }}
                  </span>
                </td>
                <td class="px-6 py-5 text-sm text-gray-500 font-mono">{{ account.expireAt ? formatShanghaiDate(account.expireAt, dateFormatOptions) : '-' }}</td>
                <td class="px-6 py-5 text-sm text-gray-500">{{ formatShanghaiDate(account.createdAt, dateFormatOptions).split(" ")[0] }}</td>
                <td class="px-6 py-5 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <!-- Toggle Open -->
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      class="h-8 w-8 rounded-lg"
                      :class="account.isOpen ? 'text-gray-400 hover:text-gray-900' : 'text-blue-500 bg-blue-50 hover:bg-blue-100'"
                      @click="handleToggleOpen(account)"
                      :disabled="togglingOpenAccountId === account.id"
                      :title="account.isOpen ? '隐藏账号' : '开放账号'"
                    >
                       <span v-if="togglingOpenAccountId === account.id" class="animate-spin">⏳</span>
           <template v-else>
                          <EyeOff v-if="account.isOpen" class="w-4 h-4" />
                          <Eye v-else class="w-4 h-4" />
                       </template>
                    </Button>

                    <!-- Sync -->
                    <Button 
                      size="icon" 
          variant="ghost" 
                      class="h-8 w-8 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                      @click="handleSyncUserCount(account)"
                      :disabled="syncingAccountId === account.id"
                      title="同步数据"
                    >
                      <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': syncingAccountId === account.id }" />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      class="h-8 rounded-lg"
                      @click="handleShowMembers(account)"
                    >
                      <Users class="w-3.5 h-3.5 mr-1" />成员
                    </Button>

                    <!-- Ban -->
                    <Button
                      size="icon"
                      variant="ghost"
                      class="h-8 w-8 rounded-lg"
                      :class="account.isBanned ? 'text-red-600 bg-red-50' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'"
                      @click="handleBanAccount(account)"
                      :disabled="account.isBanned || banningAccountId === account.id"
                      :title="account.isBanned ? '已封号' : '标记为封号'"
                    >
                      <span v-if="banningAccountId === account.id" class="animate-spin">⏳</span>
                      <Ban v-else class="w-4 h-4" />
                    </Button>

                    <!-- Edit -->
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      class="h-8 w-8 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
                      @click="openEditDialog(account)"
                      title="编辑"
                    >
                      <FilePenLine class="w-4 h-4" />
                    </Button>

                    <!-- Delete -->
                    <Button 
                      size="icon" 
                      variant="ghost" 
                      class="h-8 w-8 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                      @click="handleDelete(account.id)"
                      title="删除"
                    >
                      <Trash2 class="w-4 h-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Mobile Card List -->
        <div class="md:hidden p-4 space-y-4 bg-gray-50/50">
          <div v-for="account in accounts" :key="account.id" class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <div class="flex items-start justify-between mb-4">
              <div class="flex items-center gap-3">
                 <div class="w-10 h-10 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-sm font-bold text-gray-600">
	                    {{ account.email.charAt(0).toUpperCase() }}
                 </div>
                 <div>
                    <p class="text-sm font-bold break-all" :class="account.isBanned ? 'text-red-600' : 'text-gray-900'">{{ account.email }}</p>
                    <p class="text-xs text-gray-500 mt-0.5">{{ account.spaceName || '-' }}</p>
                    <p class="text-xs text-blue-500 font-medium mt-0.5">#{{ account.id }}</p>
                 </div>
              </div>
              <div class="flex flex-wrap justify-end gap-2">
                 <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-100">
                    {{ account.userCount }} 人
                 </span>
                 <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-purple-50 text-purple-600 border border-purple-100">
                    {{ account.inviteCount ?? 0 }} 待
                 </span>
                 <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold border" :class="resolveStatusBadgeClass(account)">{{ resolveAccountStatus(account).reason }}</span>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-4 text-xs text-gray-500 mb-4 bg-gray-50/50 p-3 rounded-xl">
          <div>
                  <p class="mb-1 text-gray-400">过期时间</p>
                  <p class="font-mono text-gray-700">{{ account.expireAt ? formatShanghaiDate(account.expireAt, dateFormatOptions) : '-' }}</p>
               </div>
               <div>
                  <p class="mb-1 text-gray-400">创建时间</p>
                  <p class="text-gray-700">{{ formatShanghaiDate(account.createdAt, dateFormatOptions).split(' ')[0] }}</p>
               </div>
            </div>

            <div class="flex items-center justify-between gap-2 pt-2 border-t border-gray-50">
               <!-- Toggle Open -->
               <Button 
                  size="sm" 
                  variant="ghost" 
                  class="flex-1 h-9 rounded-lg"
                  :class="account.isOpen ? 'text-gray-500 hover:text-gray-900' : 'text-blue-600 bg-blue-50'"
                  @click="handleToggleOpen(account)"
                  :disabled="togglingOpenAccountId === account.id"
               >
                  <span v-if="togglingOpenAccountId === account.id" class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full"></span>
                  <template v-if="account.isOpen">
                     <EyeOff class="w-4 h-4 mr-1.5" />
                     {{ '隐藏' }}
                  </template>
                  <template v-else>
                     <Eye class="w-4 h-4 mr-1.5" />
                     {{ '开放' }}
                  </template>
               </Button>

               <!-- More Actions -->
               <div class="flex gap-1">
                  <Button size="icon" variant="ghost" class="h-9 w-9 text-gray-400" @click="handleSyncUserCount(account)">
                     <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': syncingAccountId === account.id }" />
                  </Button>
                  <Button size="sm" variant="outline" class="h-9" @click="handleShowMembers(account)">成员</Button>
                  <Button size="icon" variant="ghost" class="h-9 w-9 text-gray-400"@click="openEditDialog(account)">
                     <FilePenLine class="w-4 h-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    class="h-9 w-9"
                    :class="account.isBanned ? 'text-red-600 bg-red-50' : 'text-gray-400 hover:text-red-600 hover:bg-red-50'"
                    @click="handleBanAccount(account)"
                    :disabled="account.isBanned || banningAccountId === account.id"
                    :title="account.isBanned ? '已封号' : '标记为封号'"
                  >
                    <span v-if="banningAccountId === account.id" class="animate-spin">⏳</span>
                    <Ban v-else class="w-4 h-4" />
                  </Button>
                  <Button size="icon" variant="ghost" class="h-9 w-9 text-gray-400 text-red-400 hover:text-red-600" @click="handleDelete(account.id)">
                     <Trash2 class="w-4 h-4" />
                  </Button>
               </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center justify-between border-t border-gray-100 px-6 py-4 text-sm text-gray-500 bg-gray-50/30">
          <p>
            第 {{ paginationMeta.page }} / {{ totalPages }} 页，共 {{ paginationMeta.total }} 个账号
          </p>
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              class="h-8 rounded-lg border-gray-200"
              :disabled="paginationMeta.page === 1"
              @click="goToPage(paginationMeta.page - 1)"
            >
              上一页
            </Button>
            <Button
              size="sm"
              variant="outline"
              class="h-8 rounded-lg border-gray-200"
              :disabled="paginationMeta.page >= totalPages"
              @click="goToPage(paginationMeta.page + 1)"
            >
              下一页
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Edit Dialog -->
    <Dialog v-model:open="showDialog">
      <DialogContent class="sm:max-w-[500px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl max-h-[90vh] flex flex-col">
        <DialogHeader class="px-8 pt-8 pb-4 shrink-0">
          <DialogTitle class="text-2xl font-bold text-gray-900">
            {{ editingAccount ? '编辑账号' : '新建账号' }}
          </DialogTitle>
        </DialogHeader>
        
        <form @submit.prevent="handleSubmit" class="flex-1 min-h-0 flex flex-col">
           <div class="flex-1 min-h-0 px-8 pb-6 space-y-4 overflow-y-auto">
              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">邮箱</Label>
                <Input
                  v-model="formData.email"
                  type="email"
                  required
                  placeholder="name@example.com"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all"
                />
              </div>

              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Access Token</Label>
                <div class="flex items-center gap-2">
                  <Input
                    v-model="formData.token"
                    required
                    placeholder="sk-proj-..."
                    class="h-11 flex-1 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    class="h-11 rounded-xl border-gray-200"
                    :disabled="checkingAccessToken || !formData.token?.trim()"
                    @click="handleCheckAccessToken"
                  >
                    <template v-if="checkingAccessToken">
                      <span class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full mr-2"></span>
                      校验中
                    </template>
                    <template v-else>
                      校验
                    </template>
                  </Button>
                </div>
                <p v-if="checkAccessTokenError" class="text-[12px] text-red-600">{{ checkAccessTokenError }}</p>
                <p v-else-if="checkedChatgptAccounts.length" class="text-[12px] text-gray-400">已获取 {{ checkedChatgptAccounts.length }} 个账号，可在 ChatGPT ID 下拉选择</p>
              </div>

              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Refresh Token</Label>
                <div class="flex items-center gap-2">
                  <Input
                    v-model="formData.refreshToken"
                    placeholder="可选，用于自动刷新"
                    class="h-11 flex-1 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    class="h-11 rounded-xl border-gray-200"
                    :disabled="generatingOpenaiAuthUrl"
                    @click="handleClickGetRefreshToken"
                  >
                    <template v-if="generatingOpenaiAuthUrl">
                      <span class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full mr-2"></span>
                      生成中
                    </template>
                    <template v-else>
                      获取
                    </template>
                  </Button>
                  <Button
                    v-if="editingAccount"
                    type="button"
                    size="sm"
                    variant="outline"
                    class="h-11 rounded-xl border-gray-200"
                    :disabled="refreshingAccessToken || !formData.refreshToken?.trim()"
                    @click="handleManualRefreshAccessToken"
                  >
                    <template v-if="refreshingAccessToken">
                      <span class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full mr-2"></span>
                      获取中
                    </template>
                    <template v-else>
                      手动获取AT
                    </template>
                  </Button>
                </div>
                <p class="text-[12px] text-gray-400">手动获取AT会调用 refresh_token 立即换取新的 access token，并自动回填表单。</p>

                <div
                  v-if="showOpenaiOAuthPanel"
                  class="rounded-2xl border border-gray-100 bg-gray-50/70 p-4 space-y-4"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="space-y-1">
                      <p class="text-sm font-semibold text-gray-800">通过 OpenAI OAuth 获取 Refresh Token</p>
                      <p class="text-[12px] text-gray-500">会话有效期约 10 分钟；支持粘贴回调 URL 或直接粘贴 code。</p>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      class="h-8 w-8 text-gray-400 hover:text-gray-700"
                      :disabled="generatingOpenaiAuthUrl || exchangingOpenaiCode"
                      @click="resetOpenaiOAuthFlow"
                      title="关闭"
                    >
                      <X class="w-4 h-4" />
                    </Button>
                  </div>

                  <div v-if="openaiOAuthSession?.authUrl" class="space-y-2">
                    <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">授权链接</Label>
                    <div class="flex items-center gap-2">
                      <Input
                        :model-value="openaiOAuthSession?.authUrl || ''"
                        readonly
                        class="h-11 flex-1 bg-white border-gray-200 rounded-xl font-mono text-xs"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        class="h-11 rounded-xl border-gray-200"
                        @click="copyText(openaiOAuthSession?.authUrl || '', '已复制授权链接')"
                      >
                        复制
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        class="h-11 rounded-xl border-gray-200"
                        @click="handleOpenAuthUrl"
                      >
                        打开
                      </Button>
                    </div>

                    <div v-if="openaiOAuthSession?.instructions?.length" class="space-y-1 text-[12px] text-gray-500">
                      <p v-for="(item, idx) in openaiOAuthSession.instructions" :key="idx">{{ item }}</p>
                    </div>
                  </div>

                  <div class="space-y-2">
                    <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">回调 URL / 授权码</Label>
                    <Input
                      v-model="openaiOAuthInput"
                      placeholder="粘贴回调 URL（含 code=）或直接粘贴 code"
                      class="h-11 bg-white border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                    />
                  </div>

                  <div class="flex items-center gap-2">
                    <Button
                      type="button"
                      class="h-11 rounded-xl"
                      :disabled="exchangingOpenaiCode || !openaiOAuthInput.trim() || !openaiOAuthSession?.sessionId"
                      @click="handleExchangeOpenaiCode"
                    >
                      <template v-if="exchangingOpenaiCode">
                        <span class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full mr-2"></span>
                        转换中
                      </template>
                      <template v-else>
                        转换并填入
                      </template>
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      class="h-11 rounded-xl border-gray-200"
                      :disabled="generatingOpenaiAuthUrl || exchangingOpenaiCode"
                      @click="generateOpenaiAuthUrl"
                    >
                      重新获取链接
                    </Button>
                  </div>

                  <p v-if="openaiOAuthError" class="text-[12px] text-red-600">{{ openaiOAuthError }}</p>

                  <div
                    v-if="openaiOAuthResult"
                    class="rounded-xl bg-white/80 border border-gray-100 p-3 text-[12px] text-gray-600 space-y-1"
                  >
                    <p>已解析账号：{{ openaiOAuthResult?.accountInfo?.email || '-' }}</p>
                    <p>ChatGPT ID：{{ openaiOAuthResult?.accountInfo?.accountId || '-' }}</p>
                  </div>
                </div>
              </div>

		              <div class="grid grid-cols-2 gap-4">
		                 <div class="space-y-2">
		                    <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">ChatGPT ID</Label>
                        <div class="flex items-center gap-2">
                          <Input
                            id="chatgpt-account-id-input"
                            v-model="formData.chatgptAccountId"
                            required
                            placeholder="必填"
                            :list="checkedChatgptAccounts.length ? 'chatgpt-account-id-options' : undefined"
                            class="h-11 flex-1 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                          />
                        </div>
                        <datalist v-if="checkedChatgptAccounts.length" id="chatgpt-account-id-options">
                          <option
                            v-for="acc in checkedChatgptAccounts"
                            :key="acc.accountId"
                            :value="acc.accountId"
                          >
                            {{ acc.name }}{{ acc.expiresAt ? ` (到期 ${acc.expiresAt})` : '' }}
                          </option>
                        </datalist>
		                 </div>
		                 <div class="space-y-2">
		                    <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">设备 ID</Label>
		                    <Input
		                      v-model="formData.oaiDeviceId"
		                      placeholder="可选"
		                      class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
		                    />
		                 </div>
		              </div>

                  <div class="grid grid-cols-2 gap-4">
                    <div class="space-y-2">
                      <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">空间类型</Label>
                      <div class="flex items-center gap-1 bg-gray-100 p-1 rounded-xl">
                        <button
                          type="button"
                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="formData.spaceType !== 'mother' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                          @click="formData.spaceType = 'child'"
                        >
                          子号空间
                        </button>
                        <button
                          type="button"
                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="formData.spaceType === 'mother' ? 'bg-indigo-50 text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                          @click="formData.spaceType = 'mother'"
                        >
                          母号空间
                        </button>
                      </div>
                    </div>
                    <div class="space-y-2">
                      <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">封禁状态</Label>
                      <div class="flex items-center gap-1 bg-gray-100 p-1 rounded-xl">
                        <button
                          type="button"
                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="!formData.isBanned ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                          @click="formData.isBanned = false"
                        >
                          正常
                        </button>
                        <button
                          type="button"
                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="formData.isBanned ? 'bg-red-50 text-red-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                          @click="formData.isBanned = true"
                        >
                          已封禁
                        </button>
                      </div>
                      <p class="text-[12px] text-gray-400">封禁后将自动关闭开放状态</p>
                    </div>
                  </div>
		
		              <div class="space-y-2">
		                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">过期时间</Label>
                    <AppleNativeDateTimeInput
                      v-model="formData.expireAt"
                      placeholder="选择过期时间（可选）"
                    />
		              </div>
		           </div>

           <DialogFooter class="px-8 pb-8 pt-4 shrink-0 border-t border-gray-100 bg-white/80 backdrop-blur">
              <Button type="button" variant="ghost" @click="closeDialog" class="rounded-xl h-11 px-6 text-gray-500 hover:text-gray-900 hover:bg-gray-100">
                取消
              </Button>
              <Button type="submit" class="rounded-xl h-11 px-6 bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-200">
                保存
              </Button>
         </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <!-- Sync Result Dialog -->
    <Dialog v-model:open="showSyncResultDialog">
   <DialogContent class="sm:max-w-[800px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
      <div class="relative w-full">
        <div v-if="syncResult" class="flex flex-col h-[600px]">
           <!-- Header -->
           <div class="px-8 py-6 bg-green-50/50 border-b border-green-100 flex flex-col md:flex-row md:items-center justify-between gap-6 pr-12 relative">
              <div>
                 <h3 class="text-xl font-bold text-green-900 flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-green-500"></span>
                    同步成功
                 </h3>
                 <p class="text-green-700/80 text-sm mt-1">{{ syncResult.message }}</p>
                 <p class="text-green-600/50 text-xs mt-2 flex items-center gap-1">
                    <span class="w-1 h-1 rounded-full bg-green-400"></span>
                    更新于 {{ formatShanghaiDate(syncResult.account.updatedAt, dateFormatOptions) }}
                 </p>
              </div>
              
              <div class="flex items-center gap-8 md:gap-12 border-t md:border-t-0 md:border-l border-green-200/50 pt-4 md:pt-0 md:pl-8">
                 <!-- 当前人数 -->
                 <div class="text-right">
                    <p class="text-xs font-medium text-green-600/60 uppercase tracking-wider mb-1">当前人数</p>
                    <div class="flex items-baseline gap-1 justify-end">
                       <span v-if="previousUserCount !== null && previousUserCount !== syncResult.syncedUserCount" class="text-xl font-semibold text-green-600/40 mr-1">
                          {{ previousUserCount }} <span class="text-sm mx-0.5">→</span>
                       </span>
                       <span class="text-3xl font-bold text-green-600">{{ syncResult.syncedUserCount }}</span>
                       <span class="text-sm text-green-600 font-medium">人</span>
                    </div>
                 </div>

                 <!-- 待加入 -->
                 <div class="text-right">
                    <p class="text-xs font-medium text-green-600/60 uppercase tracking-wider mb-1">待加入人数</p>
                    <div class="flex items-baseline gap-1 justify-end">
                       <span v-if="previousInviteCount !== null && previousInviteCount !== (syncResult.inviteCount ?? 0)" class="text-xl font-semibold text-green-600/40 mr-1">
                          {{ previousInviteCount }} <span class="text-sm mx-0.5">→</span>
                       </span>
                       <span class="text-3xl font-bold text-green-600">{{ syncResult.inviteCount ?? 0 }}</span>
                       <span class="text-sm text-green-600 font-medium">待</span>
                    </div>
                 </div>
              </div>
           </div>

           <!-- Content -->
           <div class="flex-1 overflow-y-auto p-8">

              <div class="space-y-4">
                 <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <!-- Tabs -->
                    <div class="flex items-center gap-1 bg-gray-100 p-1 rounded-xl w-fit">
                       <button
                          @click="handleMembersTabClick"
                          class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="activeTab === 'members' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                 >
                          成员列表
                       </button>
                       <button
                          @click="handleInvitesTabClick"
                          class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="activeTab === 'invites' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                       >
                          待加入列表
                       </button>
                    </div>

                    <Button size="sm" variant="outline" class="rounded-lg text-xs h-8 border-gray-200" @click="showInviteForm = !showInviteForm">
                       {{ showInviteForm ? '取消' : '邀请新成员' }}
                    </Button>
                 </div>

                 <!-- Invite Form -->
                 <div v-if="showInviteForm" class="p-4 bg-blue-50/50 rounded-xl border border-blue-100 animate-in fade-in slide-in-from-top-2">
                    <div class="flex gap-2">
                       <Input v-model="inviteEmail" placeholder="输入邮箱地址..." class="bg-white h-10 border-blue-200 focus:border-blue-400" />
                       <Button @click="handleInviteSubmit" :disabled="inviting" class="bg-blue-600 hover:bg-blue-700 text-white h-10 px-4 whitespace-nowrap">
                          发送邀请
                       </Button>
                    </div>
                 </div>

                 <!-- Members Table -->
                 <div v-show="activeTab === 'members'" class="border border-gray-100 rounded-xl overflow-hidden">
                    <div v-if="loadingMembers" class="p-8 flex justify-center">
                      <div class="w-6 h-6 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
                    </div>
                    <table class="w-full text-sm">
                       <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
                          <tr>
                             <th class="px-4 py-3 text-left font-medium">用户</th>
                             <th class="px-4 py-3 text-left font-medium">角色</th>
                             <th class="px-4 py-3 text-right font-medium">操作</th>
                          </tr>
                       </thead>
                       <tbody v-if="!loadingMembers" class="divide-y divide-gray-50">
                          <tr v-for="user in membersList" :key="user.id" class="group hover:bg-gray-50/50">
                             <td class="px-4 py-3">
                          <div class="font-medium text-gray-900">{{ user.name }}</div>
                                <div class="text-xs text-gray-400 flex items-center gap-2 flex-wrap">
                                  <span>{{ user.email }}</span>
                                  <span v-if="user.isProtected" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">[保护]</span>
                                </div>
                             </td>
                             <td class="px-4 py-3 text-gray-500">
                                <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 capitalize">
                                   {{ user.role }}
                                </span>
                             </td>
                             <td class="px-4 py-3 text-right">
                                <button 
                                   v-if="!['account-owner', 'account-admin'].includes((user.role || '').toLowerCase())"
                                   class="text-gray-400 hover:text-red-600 transition-colors p-1 rounded hover:bg-red-50"
                                   @click="handleDeleteSyncedUser(user.id || user.account_user_id || '')"
                                   :disabled="deletingUserId === (user.id || user.account_user_id)"
                                >
                                   <Trash2 class="w-4 h-4" />
              </button>
                             </td>
                          </tr>
                          <tr v-if="!membersList.length">
                             <td colspan="3" class="px-4 py-8 text-center text-gray-400">暂无成员缓存数据</td>
                          </tr>
                       </tbody>
                    </table>
                 </div>

                 <!-- Invites Table -->
                 <div v-show="activeTab === 'invites'" class="border border-gray-100 rounded-xl overflow-hidden">
                     <div v-if="loadingInvites" class="p-8 flex justify-center">
                        <div class="w-6 h-6 border-2 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
                     </div>
                     <table v-else class="w-full text-sm">
                       <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
                          <tr>
                             <th class="px-4 py-3 text-left font-medium">受邀邮箱</th>
                             <th class="px-4 py-3 text-left font-medium">角色</th>
                             <th class="px-4 py-3 text-left font-medium">邀请时间</th>
                             <th class="px-4 py-3 text-right font-medium">操作</th>
                          </tr>
                       </thead>
                       <tbody class="divide-y divide-gray-50">
                          <tr v-for="invite in invitesList" :key="invite.id" class="group hover:bg-gray-50/50">
                             <td class="px-4 py-3">
                                <div class="font-medium text-gray-900 flex items-center gap-2 flex-wrap">
                                  <span>{{ invite.email_address }}</span>
                                  <span v-if="invite.isProtected" class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-700 border border-amber-200">[保护]</span>
                                </div>
                             </td>
                             <td class="px-4 py-3 text-gray-500">
                                <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600 capitalize">
                                   {{ invite.role }}
                                </span>
                             </td>
                             <td class="px-4 py-3 text-gray-500 text-xs">
                                {{ formatShanghaiDate(invite.created_time || '', dateFormatOptions) }}
                             </td>
                             <td class="px-4 py-3 text-right">
                                <button
                                  class="text-gray-400 hover:text-red-600 transition-colors p-1 rounded hover:bg-red-50 disabled:opacity-50 disabled:hover:bg-transparent"
                                  @click="handleRevokeInvite(invite.email_address)"
                                  :disabled="!invite.email_address || revokingInviteEmail === String(invite.email_address).trim().toLowerCase()"
                                  title="撤回邀请"
                                >
                                  <span v-if="revokingInviteEmail === String(invite.email_address).trim().toLowerCase()" class="animate-spin">⏳</span>
                                  <Trash2 v-else class="w-4 h-4" />
                                </button>
                             </td>
                          </tr>
                          <tr v-if="!invitesList.length">
                             <td colspan="4" class="px-4 py-8 text-center text-gray-400">暂无待加入邀请</td>
                          </tr>
                       </tbody>
                    </table>
                 </div>

              </div>
           </div>

           <!-- Footer -->
           <div class="px-8 py-4 border-t border-gray-100 bg-gray-50/50 flex justify-end">
              <Button @click="closeSyncResultDialog" class="rounded-xl px-6 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50">关闭</Button>
           </div>
        </div>

        <!-- Error State -->
        <div v-else class="p-8 text-center space-y-6">
           <div class="w-16 h-16 rounded-full bg-red-100 mx-auto flex items-center justify-center text-red-500">
              <X class="w-8 h-8" />
           </div>
           <div>
              <h3 class="text-xl font-bold text-gray-900">同步失败</h3>
              <p class="text-gray-500 mt-2 max-w-sm mx-auto">{{ syncError }}</p>
           </div>
           <Button @click="closeSyncResultDialog" variant="outline" class="rounded-xl px-8">关闭</Button>
        </div>

        <div v-if="resyncingAfterAction" class="absolute inset-0 z-50 bg-white/70 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
          <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
          <p class="text-sm text-gray-600 font-medium">正在同步成员信息...</p>
        </div>
      </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
