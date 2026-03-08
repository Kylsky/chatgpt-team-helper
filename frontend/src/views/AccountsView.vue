<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { API_URL, authService, gptAccountService, openaiOAuthService, userService, type AccountStatus, type CheckAccountStatusItem, type CheckAccountStatusResponse, type GptAccount, type CreateGptAccountDto, type SyncUserCountResponse, type GptAccountsListParams, type ChatgptAccountInviteItem, type ChatgptAccountCheckInfo, type OpenAIOAuthSession, type OpenAIOAuthExchangeResult } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
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
import { Plus, Eye, EyeOff, RefreshCw, Ban, FilePenLine, Trash2, AlertTriangle, X, FolderOpen, Search } from 'lucide-vue-next'

const router = useRouter()
const accounts = ref<GptAccount[]>([])
const loading = ref(true)
const error = ref('')
const showDialog = ref(false)
const editingAccount = ref<GptAccount | null>(null)
const paginationMeta = ref({ page: 1, pageSize: 10, total: 0 })

// 搜索和筛选状态
const searchQuery = ref('')
const openStatusFilter = ref<'all' | 'open' | 'closed'>('all')
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
const { success: showSuccessToast, error: showErrorToast, warning: showWarningToast, info: showInfoToast } = useToast()
const appConfigStore = useAppConfigStore()
const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))

// Teleport 目标是否存在
const teleportReady = ref(false)

onMounted(async () => {
  // 等待 DOM 更新后检查 teleport 目标
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  await loadAccounts()
})

onUnmounted(() => {
  teleportReady.value = false
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  if (checkAbortController) {
    checkAbortController.abort()
    checkAbortController = null
  }
  cancelResyncAfterAction()
})

// 计算总页数
const totalPages = computed(() => Math.max(1, Math.ceil(paginationMeta.value.total / paginationMeta.value.pageSize)))

// 同步相关状态
const syncingAccountId = ref<number | null>(null)
const showSyncResultDialog = ref(false)
const syncResult = ref<SyncUserCountResponse | null>(null)
const syncError = ref('')
const previousUserCount = ref<number | null>(null)
const previousInviteCount = ref<number | null>(null)
const deletingUserId = ref<string | null>(null)
const revokingInviteEmail = ref<string | null>(null)
const showInviteForm = ref(false)
const inviteEmail = ref('')
const inviting = ref(false)
const togglingOpenAccountId = ref<number | null>(null)
const banningAccountId = ref<number | null>(null)

// 批量检查相关状态
type CheckResultFilter = 'all' | 'abnormal' | 'banned' | 'expired' | 'normal' | 'failed'
const showCheckDialog = ref(false)
const checkRangeDays = ref<'7' | '15' | '30'>('7')
const checking = ref(false)
const checkProgress = ref(0)
const checkTotal = ref<number | null>(null)
const checkProcessed = ref(0)
const checkError = ref('')
const checkResult = ref<CheckAccountStatusResponse | null>(null)
const resultFilter = ref<CheckResultFilter>('abnormal')
let checkAbortController: AbortController | null = null

// Tab 和 邀请列表状态
const activeTab = ref<'members' | 'invites'>('members')
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
  isOpen: true,
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

const logHttpErrorWithBody = (label: string, err: any) => {
  try {
    console.error(label, {
      message: err?.message,
      status: err?.response?.status,
      statusText: err?.response?.statusText,
      headers: err?.response?.headers,
      body: err?.response?.data
    })
  } catch (error) {
    console.error(label, err, error)
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
        logHttpErrorWithBody('[Accounts] 校验 token 失败（OAuth 自动检查）', err)
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

const pad2 = (value: number) => String(value).padStart(2, '0')
const EXPIRE_AT_PARSE_REGEX = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
const parseExpireAtToMs = (value?: string | null): number | null => {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const match = raw.match(EXPIRE_AT_PARSE_REGEX)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = match[6] != null ? Number(match[6]) : 0

  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null
  if (month < 1 || month > 12) return null
  if (day < 1 || day > 31) return null
  if (hour < 0 || hour > 23) return null
  if (minute < 0 || minute > 59) return null
  if (second < 0 || second > 59) return null

  // NOTE: expireAt is stored as Asia/Shanghai time.
  const iso = `${match[1]}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}+08:00`
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? null : parsed
}

const getAccountListStatus = (account: GptAccount): AccountStatus => {
  if (account.isBanned) return 'banned'
  const expireAtMs = parseExpireAtToMs(account.expireAt)
  if (expireAtMs != null && expireAtMs < Date.now()) return 'expired'
  return 'normal'
}

const STATUS_BADGE_MAP: Record<AccountStatus, { label: string; class: string }> = {
  normal: { label: '正常', class: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  expired: { label: '过期', class: 'bg-orange-50 text-orange-700 border-orange-200' },
  banned: { label: '封号', class: 'bg-red-50 text-red-700 border-red-200' },
  failed: { label: '失败', class: 'bg-gray-50 text-gray-700 border-gray-200' },
}
const statusBadge = (status: AccountStatus) => STATUS_BADGE_MAP[status] || STATUS_BADGE_MAP.normal

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

    applyCheckedAccountSelection(formData.value.chatgptAccountId)
    await openChatgptIdDropdown()
  } catch (err: any) {
    const message = err?.response?.data?.error || '校验失败'
    logHttpErrorWithBody('[Accounts] 校验 token 失败', err)
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
    // 添加筛选参数
    if (openStatusFilter.value !== 'all') {
      params.openStatus = openStatusFilter.value
    }
    const response = await gptAccountService.getAll(params)
    accounts.value = response.accounts || []
    paginationMeta.value = response.pagination || { page: 1, pageSize: 10, total: 0 }
  } catch (err: any) {
    error.value = err.response?.data?.error || 'Failed to load accounts'
    if (err.response?.status === 401 || err.response?.status === 403) {
      authService.logout()
      router.push('/login')
    }
  } finally {
    loading.value = false
  }
}

const handleRefresh = () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  loadAccounts()
}

const openCheckDialog = () => {
  checkError.value = ''
  resultFilter.value = 'abnormal'
  checkProgress.value = 0
  checkTotal.value = null
  checkProcessed.value = 0
  checkResult.value = null
  showCheckDialog.value = true
}

const closeCheckDialog = () => {
  showCheckDialog.value = false
  if (checkAbortController) {
    checkAbortController.abort()
    checkAbortController = null
  }
  checking.value = false
  checkProgress.value = 0
  checkTotal.value = null
  checkProcessed.value = 0
  checkError.value = ''
  checkResult.value = null
  resultFilter.value = 'abnormal'
}

watch(checkRangeDays, () => {
  checkError.value = ''
  checkResult.value = null
  resultFilter.value = 'abnormal'
  checkProgress.value = 0
  checkTotal.value = null
  checkProcessed.value = 0
})

const checkItems = computed<CheckAccountStatusItem[]>(() => {
  const items = checkResult.value?.items
  return Array.isArray(items) ? items : []
})

const filteredCheckItems = computed(() => {
  const filter = resultFilter.value
  const list = checkItems.value

  if (filter === 'all') return list
  if (filter === 'abnormal') return list.filter(item => item.status !== 'normal' || Boolean(item.refreshed))
  return list.filter(item => item.status === filter)
})

const handleStartCheck = async () => {
  checkError.value = ''
  checkResult.value = null
  resultFilter.value = 'abnormal'
  checkProgress.value = 0
  checkTotal.value = null
  checkProcessed.value = 0

  if (checkAbortController) {
    checkAbortController.abort()
    checkAbortController = null
  }

  try {
    checking.value = true
    const rangeDays = Number.parseInt(checkRangeDays.value, 10) as 7 | 15 | 30
    const token = localStorage.getItem('token')
    if (!token) {
      throw new Error('登录已过期，请重新登录')
    }

    checkAbortController = new AbortController()
    const streamUrl = `${API_URL}/gpt-accounts/check-status/stream?rangeDays=${rangeDays}`
    const response = await fetch(streamUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream'
      },
      signal: checkAbortController.signal
    })

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        authService.logout()
        router.push('/login')
      }
      let message = '检查失败，请稍后重试'
      try {
        const data = await response.json()
        message = data?.error || data?.message || message
      } catch {
        try {
          const text = await response.text()
          if (text) message = text
        } catch {
          // ignore
        }
      }
      throw new Error(message)
    }

    if (!response.body) {
      throw new Error('当前浏览器不支持流式响应')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let doneReceived = false

    const makeCheckResult = (payload: any): CheckAccountStatusResponse => {
      const nextRangeDays = Number(payload?.rangeDays || rangeDays) as 7 | 15 | 30
      const truncated = Boolean(payload?.truncated)
      const skipped = Number(payload?.skipped || 0)
      const total = Number(payload?.total || 0)

      checkTotal.value = Number.isFinite(total) ? total : null
      checkProcessed.value = 0
      checkProgress.value = total ? 0 : 100

      return {
        message: 'ok',
        rangeDays: nextRangeDays,
        checkedTotal: 0,
        summary: { normal: 0, expired: 0, banned: 0, failed: 0 },
        refreshedCount: 0,
        items: [],
        truncated,
        skipped
      }
    }

    const appendItem = (item: CheckAccountStatusItem) => {
      let result = checkResult.value
      if (!result) {
        result = makeCheckResult({ rangeDays, total: checkTotal.value || 0 })
        checkResult.value = result
      }

      result.items.push(item)
      result.checkedTotal = result.items.length

      if (Object.prototype.hasOwnProperty.call(result.summary, item.status)) {
        result.summary[item.status] += 1
      }
      if (item.refreshed) {
        result.refreshedCount += 1
      }
    }

    const handleProgress = (payload: any) => {
      const processed = Number(payload?.processed || 0)
      const total = Number(payload?.total ?? checkTotal.value ?? 0)
      const percent = Number(payload?.percent)

      if (Number.isFinite(processed)) {
        checkProcessed.value = processed
      }
      if (Number.isFinite(total)) {
        checkTotal.value = total
      }
      if (Number.isFinite(percent)) {
        checkProgress.value = Math.max(0, Math.min(100, Math.round(percent)))
      } else if (Number.isFinite(processed) && Number.isFinite(total) && total > 0) {
        checkProgress.value = Math.max(0, Math.min(100, Math.round((processed / total) * 100)))
      }

      const result = checkResult.value
      if (result) {
        result.checkedTotal = Math.max(result.checkedTotal, checkProcessed.value)
      }
    }

    const parseEventBlock = (block: string): { event: string; data: any } | null => {
      const trimmed = block.trim()
      if (!trimmed || trimmed.startsWith(':')) return null

      const lines = trimmed.split(/\r?\n/)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of lines) {
        if (!line) continue
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          event = line.slice('event:'.length).trim() || event
          continue
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart())
        }
      }

      const dataText = dataLines.join('\n')
      let data: any = dataText
      if (dataText) {
        try {
          data = JSON.parse(dataText)
        } catch {
          // keep raw text
        }
      }

      return { event, data }
    }

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      // Events are delimited by a blank line.
      // Keep a buffer because chunk boundaries may split frames.
      while (true) {
        const index = buffer.indexOf('\n\n')
        if (index === -1) break

        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const parsed = parseEventBlock(block)
        if (!parsed) continue

        if (parsed.event === 'meta') {
          checkResult.value = makeCheckResult(parsed.data)
          continue
        }
        if (parsed.event === 'progress') {
          handleProgress(parsed.data)
          continue
        }
        if (parsed.event === 'item') {
          appendItem(parsed.data as CheckAccountStatusItem)
          continue
        }
        if (parsed.event === 'done') {
          doneReceived = true

          let result = checkResult.value
          if (!result) {
            result = makeCheckResult(parsed.data)
            checkResult.value = result
          }

          result.message = parsed.data?.message || 'ok'
          result.rangeDays = parsed.data?.rangeDays || rangeDays
          result.checkedTotal = Number(parsed.data?.checkedTotal ?? result.items.length)
          result.summary = parsed.data?.summary || result.summary
          result.refreshedCount = Number(parsed.data?.refreshedCount ?? result.refreshedCount)
          result.truncated = Boolean(parsed.data?.truncated ?? result.truncated)
          result.skipped = Number(parsed.data?.skipped ?? result.skipped)
          checkProgress.value = 100
          break
        }
        if (parsed.event === 'error') {
          const message = parsed.data?.error || '检查失败，请稍后重试'
          throw new Error(message)
        }
      }

      if (doneReceived) break
    }

    if (doneReceived) {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
    }

    if (!doneReceived && checking.value && !checkAbortController?.signal.aborted) {
      throw new Error('检查中断，请稍后重试')
    }

    const result = checkResult.value
    if (result) {
      const refreshedCount = Number(result?.refreshedCount || 0)
      showSuccessToast({
        title: '检查完成',
        description: `正常 ${result.summary.normal} / 过期 ${result.summary.expired} / 封号 ${result.summary.banned} / 失败 ${result.summary.failed}${refreshedCount ? `；已刷新 Token ${refreshedCount} 个` : ''}`
      })
    }

    try {
      await loadAccounts()
    } catch {
      // ignore list refresh errors; keep check result visible
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      checkError.value = ''
      checkProgress.value = 0
      return
    }
    const message = err?.response?.data?.error || '检查失败，请稍后重试'
    checkError.value = err?.message || message
    showErrorToast(err?.message || message)
    checkProgress.value = 0
  } finally {
    checking.value = false
    if (checkAbortController) {
      checkAbortController = null
    }
  }
}

// 搜索处理
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
	    isOpen: Boolean(account.isOpen),
	    chatgptAccountId: account.chatgptAccountId || '',
	    oaiDeviceId: account.oaiDeviceId || '',
	    expireAt: toDatetimeLocal(account.expireAt || '')
	  }
  showDialog.value = true
}

	const closeDialog = () => {
	  showDialog.value = false
	  editingAccount.value = null
	  formData.value = { email: '', token: '', refreshToken: '', userCount: 0, isBanned: false, isOpen: true, chatgptAccountId: '', oaiDeviceId: '', expireAt: '' }
	  checkedChatgptAccounts.value = []
	  checkAccessTokenError.value = ''
	  checkingAccessToken.value = false
	  resetOpenaiOAuthFlow()
	}

const handleSubmit = async () => {
  try {
    const payload: CreateGptAccountDto = {
      ...formData.value,
      isOpen: formData.value.isOpen !== false,
      email: formData.value.email.trim(),
      token: formData.value.token.trim(),
      refreshToken: formData.value.refreshToken?.trim() || '',
      chatgptAccountId: formData.value.chatgptAccountId?.trim() || '',
      oaiDeviceId: formData.value.oaiDeviceId?.trim() || '',
      expireAt: fromDatetimeLocal(formData.value.expireAt?.trim() || ''),
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
      ...result.account,
      userCount: result.syncedUserCount,
      inviteCount: typeof nextInviteCount === 'number' ? nextInviteCount : current.inviteCount,
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

    // 显示同步结果对话框
    showSyncResultDialog.value = true
    
    // 加载待加入列表
    loadInvites(account.id)
  } catch (err: any) {
    syncError.value = err.response?.data?.error || '同步失败，请检查网络连接和账号配置'
    showSyncResultDialog.value = true
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
  previousUserCount.value = null
  previousInviteCount.value = null
  invitesList.value = []
  activeTab.value = 'members'
  resetInviteForm()
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
    <!-- Header Actions -->
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-3 flex-wrap justify-end">
        <Button
          variant="outline"
          class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
          :disabled="loading"
          @click="handleRefresh"
        >
          <RefreshCw class="w-4 h-4 mr-2" :class="loading ? 'animate-spin' : ''" />
          刷新列表
        </Button>
        <Button
          variant="outline"
          class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
          :disabled="loading"
          @click="openCheckDialog"
        >
          <Search class="w-4 h-4 mr-2" />
          检查
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
            placeholder="搜索邮箱..."
            class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
            @keyup.enter="handleSearch"
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
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
      <AlertTriangle class="h-5 w-5" />
      <span class="font-medium">{{ error }}</span>
    </div>

    <!-- Main Content -->
    <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden min-h-[400px]">
      
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
	                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">邮箱</th>
	                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
	                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">已加入</th>
	                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">待加入</th>
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
	                  <div class="flex items-center gap-3">
	                    <div class="w-8 h-8 rounded-full bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-xs font-bold text-gray-600">
	                      {{ account.email.charAt(0).toUpperCase() }}
	                    </div>
                      <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2">
                          <span
                            class="text-sm font-medium break-all"
                            :class="account.isBanned ? 'text-red-600' : 'text-gray-900'"
                          >
                            {{ account.email }}
                          </span>
                        </div>
                      </div>
	                  </div>
	                </td>
	                <td class="px-6 py-5 text-center">
	                  <span
	                    class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border"
	                    :class="statusBadge(getAccountListStatus(account)).class"
	                  >
	                    {{ statusBadge(getAccountListStatus(account)).label }}
	                  </span>
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
	                <td class="px-6 py-5 text-sm text-gray-500 font-mono">{{ account.expireAt || '-' }}</td>
	                <td class="px-6 py-5 text-sm text-gray-500">{{ formatShanghaiDate(account.createdAt, dateFormatOptions) }}</td>
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
                    <div class="mt-1 flex flex-wrap items-center gap-2">
                      <p class="text-xs text-blue-500 font-medium">#{{ account.id }}</p>
                    </div>
                 </div>
              </div>
              <div class="flex flex-col items-end gap-2">
                <span
                  class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border"
                  :class="statusBadge(getAccountListStatus(account)).class"
                >
                  {{ statusBadge(getAccountListStatus(account)).label }}
                </span>
                <div class="flex flex-wrap justify-end gap-2">
                  <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-600 border border-blue-100">
                    {{ account.userCount }} 人
                  </span>
                  <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold bg-purple-50 text-purple-600 border border-purple-100">
                    {{ account.inviteCount ?? 0 }} 待
                  </span>
                </div>
              </div>
	            </div>

            <div class="grid grid-cols-2 gap-4 text-xs text-gray-500 mb-4 bg-gray-50/50 p-3 rounded-xl">
          <div>
                  <p class="mb-1 text-gray-400">过期时间</p>
                  <p class="font-mono text-gray-700">{{ account.expireAt || '-' }}</p>
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
                    placeholder="eyJhbGciOi..."
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
                </div>

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

	                  <div class="grid grid-cols-1 gap-4">
	                    <div v-if="!editingAccount" class="space-y-2">
	                      <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">开放状态</Label>
	                      <div class="flex items-center gap-1 bg-gray-100 p-1 rounded-xl">
	                        <button
	                          type="button"
	                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
	                          :class="formData.isOpen !== false ? 'bg-blue-50 text-blue-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
	                          @click="formData.isOpen = true"
	                        >
	                          开放
	                        </button>
	                        <button
	                          type="button"
	                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
	                          :class="formData.isOpen === false ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
	                          @click="formData.isOpen = false"
	                        >
	                          隐藏
	                        </button>
	                      </div>
	                      <p class="text-[12px] text-gray-400">默认开放，可按需改为隐藏</p>
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

    <!-- Check Status Dialog -->
    <Dialog v-model:open="showCheckDialog">
      <DialogContent class="sm:max-w-[900px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl max-h-[90vh] flex flex-col">
        <DialogHeader class="px-8 pt-8 pb-4 shrink-0">
          <DialogTitle class="text-2xl font-bold text-gray-900">检查账号状态</DialogTitle>
          <p class="text-sm text-gray-500 mt-2">
            选择时间范围后，将同步该范围内创建账号的状态（封号 / 过期 / 正常）。已封号账号会自动跳过；新发现封号会写入系统；过期仅展示不做自动关闭。
          </p>
        </DialogHeader>

        <div class="flex-1 min-h-0 px-8 pb-6 space-y-5 overflow-y-auto">
          <div class="flex flex-col sm:flex-row sm:items-end gap-4">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">时间范围</Label>
              <Select v-model="checkRangeDays" :disabled="checking">
                <SelectTrigger class="h-11 w-full sm:w-[160px] bg-gray-50 border-gray-200 rounded-xl">
                  <SelectValue placeholder="选择范围" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">近 7 天</SelectItem>
                  <SelectItem value="15">近 15 天</SelectItem>
                  <SelectItem value="30">近 30 天</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              class="h-11 rounded-xl bg-black text-white hover:bg-gray-800 sm:ml-auto"
              :disabled="checking"
              @click="handleStartCheck"
            >
              <template v-if="checking">
                <span class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full mr-2"></span>
                检查中...
              </template>
              <template v-else>
                开始检查
              </template>
            </Button>
          </div>

          <div v-if="checking" class="space-y-2">
            <div class="flex items-center justify-between text-xs text-gray-500">
              <span>
                正在检查账号状态...
                <span v-if="checkTotal !== null" class="ml-2 font-mono text-gray-400">({{ checkProcessed }}/{{ checkTotal }})</span>
              </span>
              <span class="font-mono">{{ checkProgress }}%</span>
            </div>
            <div class="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                class="h-2 rounded-full bg-black transition-[width] duration-200"
                :style="{ width: `${checkProgress}%` }"
              ></div>
            </div>
          </div>

          <div v-if="checkError" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-start gap-3 text-red-600">
            <AlertTriangle class="h-5 w-5 mt-0.5" />
            <div class="min-w-0">
              <p class="font-medium">检查失败</p>
              <p class="text-sm text-red-600/90 mt-1 break-words">{{ checkError }}</p>
            </div>
          </div>

          <div v-if="checkResult" class="space-y-4">
            <div v-if="checkResult.truncated" class="rounded-2xl border border-orange-100 bg-orange-50/50 p-4 text-orange-700 text-sm leading-relaxed">
              仅检查最近 {{ checkTotal ?? checkResult.checkedTotal }} 个账号，跳过 {{ checkResult.skipped }} 个（为避免请求耗时过长）。
            </div>

            <p class="text-sm text-gray-500">共检查 {{ checkResult.checkedTotal }} 个账号（近 {{ checkResult.rangeDays }} 天）</p>
            <div v-if="checkResult.refreshedCount" class="rounded-2xl border border-blue-100 bg-blue-50/50 p-4 text-blue-700 text-sm leading-relaxed">
              已自动刷新 Token：{{ checkResult.refreshedCount }} 个
            </div>

            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div class="rounded-2xl border border-gray-100 bg-gray-50/60 p-4">
                <p class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">正常</p>
                <p class="text-2xl font-bold text-gray-900 mt-1">{{ checkResult.summary.normal }}</p>
              </div>
              <div class="rounded-2xl border border-orange-100 bg-orange-50/60 p-4">
                <p class="text-[11px] font-semibold text-orange-700/70 uppercase tracking-wider">过期</p>
                <p class="text-2xl font-bold text-orange-700 mt-1">{{ checkResult.summary.expired }}</p>
              </div>
              <div class="rounded-2xl border border-red-100 bg-red-50/60 p-4">
                <p class="text-[11px] font-semibold text-red-700/70 uppercase tracking-wider">封号</p>
                <p class="text-2xl font-bold text-red-700 mt-1">{{ checkResult.summary.banned }}</p>
              </div>
              <div class="rounded-2xl border border-gray-200 bg-gray-50/60 p-4">
                <p class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">失败</p>
                <p class="text-2xl font-bold text-gray-900 mt-1">{{ checkResult.summary.failed }}</p>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <button
                type="button"
                class="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
                :class="resultFilter === 'all' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'"
                @click="resultFilter = 'all'"
              >
                全部
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
                :class="resultFilter === 'abnormal' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'"
                @click="resultFilter = 'abnormal'"
              >
                异常
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
                :class="resultFilter === 'banned' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'"
                @click="resultFilter = 'banned'"
              >
                封号
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
                :class="resultFilter === 'expired' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'"
                @click="resultFilter = 'expired'"
              >
                过期
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
                :class="resultFilter === 'normal' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'"
                @click="resultFilter = 'normal'"
              >
                正常
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors"
                :class="resultFilter === 'failed' ? 'bg-black text-white border-black' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'"
                @click="resultFilter = 'failed'"
              >
                失败
              </button>
            </div>

            <div class="border border-gray-100 rounded-2xl overflow-hidden">
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
                    <tr>
                      <th class="px-4 py-3 text-left font-medium">状态</th>
                      <th class="px-4 py-3 text-left font-medium">账号</th>
                      <th class="px-4 py-3 text-left font-medium">创建时间</th>
                      <th class="px-4 py-3 text-left font-medium">过期时间</th>
                      <th class="px-4 py-3 text-left font-medium">原因</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-50">
                    <tr v-for="item in filteredCheckItems" :key="item.id" class="hover:bg-gray-50/50">
                      <td class="px-4 py-3">
                        <div class="flex flex-wrap items-center gap-2">
                          <span
                            class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border"
                            :class="statusBadge(item.status).class"
                          >
                            {{ statusBadge(item.status).label }}
                          </span>
                          <span
                            v-if="item.refreshed"
                            class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border bg-blue-50 text-blue-700 border-blue-200"
                          >
                            已刷新
                          </span>
                        </div>
                      </td>
                      <td class="px-4 py-3">
                        <div class="font-medium text-gray-900 break-all">{{ item.email }}</div>
                        <div class="text-xs text-gray-400">#{{ item.id }}</div>
                      </td>
                      <td class="px-4 py-3 text-gray-500 font-mono">{{ formatShanghaiDate(item.createdAt, dateFormatOptions) }}</td>
                      <td class="px-4 py-3 text-gray-500 font-mono">{{ item.expireAt || '-' }}</td>
                      <td class="px-4 py-3 text-gray-500">
                        <span v-if="!item.reason">-</span>
                        <span v-else class="break-words">{{ item.reason }}</span>
                      </td>
                    </tr>
                    <tr v-if="!filteredCheckItems.length">
                      <td colspan="5" class="px-4 py-8 text-center text-gray-400">暂无数据</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div v-else class="rounded-2xl border border-gray-100 bg-gray-50/40 p-4 text-sm text-gray-500 leading-relaxed">
            提示：本功能只检查“近 N 天创建”的账号（已封号账号会跳过）；检查过程中可能会触发封号账号自动写入系统（is_banned=1）。
          </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-4 shrink-0 border-t border-gray-100 bg-white/80 backdrop-blur">
          <Button type="button" variant="outline" class="rounded-xl h-11 px-6 border-gray-200" @click="closeCheckDialog">
            关闭
          </Button>
        </DialogFooter>
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
                          @click="activeTab = 'members'"
                          class="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="activeTab === 'members' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                 >
                          成员列表
                       </button>
                       <button
                          @click="activeTab = 'invites'"
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
                    <table class="w-full text-sm">
                       <thead class="bg-gray-50 text-gray-500 text-xs uppercase">
                          <tr>
                             <th class="px-4 py-3 text-left font-medium">用户</th>
                             <th class="px-4 py-3 text-left font-medium">角色</th>
                             <th class="px-4 py-3 text-right font-medium">操作</th>
                          </tr>
                       </thead>
                       <tbody class="divide-y divide-gray-50">
                          <tr v-for="user in syncResult.users?.items" :key="user.id" class="group hover:bg-gray-50/50">
                             <td class="px-4 py-3">
                          <div class="font-medium text-gray-900">{{ user.name }}</div>
                                <div class="text-xs text-gray-400">{{ user.email }}</div>
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
                          <tr v-if="!syncResult.users?.items?.length">
                             <td colspan="3" class="px-4 py-8 text-center text-gray-400">暂无成员数据</td>
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
                                <div class="font-medium text-gray-900">{{ invite.email_address }}</div>
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
