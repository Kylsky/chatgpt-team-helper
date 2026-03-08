<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { authService, configService, redemptionCodeService, gptAccountService, type RedemptionCode, type GptAccount, type PurchaseOrderType, type SyncUserCountResponse, type ChatgptAccountInviteItem } from '@/services/api'
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
import { Search, Plus, Download, Trash2, ChevronLeft, ChevronRight, RefreshCcw, RefreshCw, Ticket, X } from 'lucide-vue-next'

const router = useRouter()
const route = useRoute()
const codes = ref<RedemptionCode[]>([])
const totalCodes = ref(0)
const accounts = ref<GptAccount[]>([])
const loading = ref(true)
const error = ref('')
const teleportReady = ref(false)
const showBatchDialog = ref(false)
const batchCount = ref(10)
const selectedAccountEmail = ref('')
const selectedBatchChannel = ref('common')
const creating = ref(false)
const selectedCodes = ref<number[]>([])
const showRedeemDialog = ref(false)
const redeemTargetCode = ref<RedemptionCode | null>(null)
const redeemEmail = ref('')
const redeemOrderType = ref<PurchaseOrderType>('warranty')
const redeeming = ref(false)
const reinvitingCodeIds = ref<number[]>([])
const appConfigStore = useAppConfigStore()
const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))
const showTextPopover = ref(false)
const popoverText = ref('')
const popoverPosition = ref({ x: 0, y: 0 })
const channelOptions = ref<Array<{ value: string; label: string }>>([
  { value: 'common', label: '通用渠道' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'linux-do', label: 'Linux DO' },
  { value: 'xhs', label: '小红书' },
  { value: 'xianyu', label: '闲鱼' },
  { value: 'artisan-flow', label: 'ArtisanFlow' }
])
const channelOptionsMap = computed(() => new Map(channelOptions.value.map(option => [option.value, option.label])))
const orderTypeOptions: { value: PurchaseOrderType; label: string }[] = [
  { value: 'warranty', label: '质保订单' },
  { value: 'no_warranty', label: '无质保订单' },
]
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const updatingChannelId = ref<number | null>(null)
let popoverTimer: ReturnType<typeof setTimeout> | null = null
const { success: showSuccessToast, info: showInfoToast, warning: showWarningToast, error: showErrorToast } = useToast()

const accountsByEmail = computed(() => {
  const map = new Map<string, GptAccount>()
  for (const account of accounts.value) {
    const normalizedEmail = String(account?.email || '').trim().toLowerCase()
    if (!normalizedEmail) continue
    map.set(normalizedEmail, account)
  }
  return map
})

const isAccountBanned = (accountEmail?: string | null) => {
  const normalizedEmail = String(accountEmail || '').trim().toLowerCase()
  if (!normalizedEmail) return false
  const account = accountsByEmail.value.get(normalizedEmail)
  return Boolean(account?.isBanned)
}

const isCodeAccountBanned = (code?: RedemptionCode | null) => {
  if (!code) return false
  if (typeof code.accountIsBanned === 'boolean') return code.accountIsBanned
  return isAccountBanned(code.accountEmail)
}

// 同步相关状态（参考账号管理的同步按钮交互）
const syncingAccountId = ref<number | null>(null)
const syncingAccountEmail = ref<string | null>(null)
const showSyncResultDialog = ref(false)
const syncResult = ref<SyncUserCountResponse | null>(null)
const syncError = ref('')
const previousUserCount = ref<number | null>(null)
const previousInviteCount = ref<number | null>(null)
const deletingUserId = ref<string | null>(null)
const showInviteForm = ref(false)
const inviteEmail = ref('')
const inviting = ref(false)
const activeTab = ref<'members' | 'invites'>('members')
const invitesList = ref<ChatgptAccountInviteItem[]>([])
const loadingInvites = ref(false)

const isCodeReserved = (code: RedemptionCode) => Boolean(code.reservedForEntryId)
const reservationLabel = (code: RedemptionCode) => {
  if (!isCodeReserved(code)) return ''
  const segments: string[] = []
  if (code.reservedForUsername) {
    segments.push(code.reservedForUsername)
  }
  if (code.reservedForUid) {
    segments.push(`UID ${code.reservedForUid}`)
  }
  return segments.length ? segments.join(' · ') : '候车绑定'
}
const extractRedeemerEmail = (redeemedBy?: string | null) => {
  const raw = String(redeemedBy ?? '').trim()
  if (!raw) return ''
  const match = raw.match(/([^\s@|]+@[^\s@|]+\.[^\s@|]+)/)
  if (match?.[1]) return match[1]
  return EMAIL_REGEX.test(raw) ? raw : ''
}
const getRedeemerEmail = (code: RedemptionCode) => extractRedeemerEmail(code.redeemedBy)
const getRedeemerDisplay = (code: RedemptionCode) => code.redeemedBy || code.reservedForUid || ''
const hasPendingReservation = (code: RedemptionCode) => Boolean(code.reservedForUid && !code.isRedeemed)

const hideTextPopover = () => {
  showTextPopover.value = false
  if (popoverTimer) {
    clearTimeout(popoverTimer)
    popoverTimer = null
  }
}

const getChannelLabel = (value?: string) => {
  const fallback = channelOptions.value[0]?.label || '通用渠道'
  if (!value) return fallback
  return channelOptionsMap.value.get(value) || fallback
}

const handleChannelChange = async (target: RedemptionCode, nextChannel: string) => {
  const normalized = String(nextChannel || '').trim().toLowerCase()
  if (!normalized) return
  if (target.channel === normalized || updatingChannelId.value === target.id) {
    return
  }
  if (!channelOptionsMap.value.has(normalized)) {
    showErrorToast('未知渠道，请刷新页面后重试')
    return
  }

  updatingChannelId.value = target.id
  try {
    const { message, code } = await redemptionCodeService.updateChannel(target.id, normalized)
    const updatedCode = code || {
      ...target,
      channel: normalized,
      channelName: getChannelLabel(normalized)
    }
    const index = codes.value.findIndex(item => item.id === target.id)
    if (index !== -1) {
      codes.value[index] = {
        ...codes.value[index],
        ...updatedCode
      }
      codes.value = [...codes.value]
    }
    showSuccessToast(message || '渠道已更新')
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '更新渠道失败')
  } finally {
    updatingChannelId.value = null
  }
}

// 分页相关状态
const currentPage = ref(1)
const pageSize = ref(10)

// 搜索和筛选状态
const searchQuery = ref('')
const statusFilter = ref<'全部' | '已使用' | '未使用'>('全部')

// 计算总页数
const totalPages = computed(() => Math.max(1, Math.ceil(totalCodes.value / pageSize.value)))
const isCurrentPageAllSelected = computed(() => {
  if (codes.value.length === 0) return false
  const selectedSet = new Set(selectedCodes.value)
  return codes.value.every(code => selectedSet.has(code.id))
})

// 切换页码
const goToPage = async (page: number) => {
  if (page < 1 || page > totalPages.value || page === currentPage.value) return
  currentPage.value = page
  await loadCodes()
}

// 重置搜索并返回第一页
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null
const handleSearch = () => {
  currentPage.value = 1
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
  }
  searchDebounceTimer = setTimeout(() => {
    loadCodes()
  }, 300)
}

// 清空搜索和筛选
const clearFilters = () => {
  searchQuery.value = ''
  statusFilter.value = '全部'
  currentPage.value = 1
  loadCodes()
}

const handleRefresh = async () => {
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  await Promise.all([
    loadCodes(),
    loadAccounts()
  ])
}

const applySearchFromQuery = () => {
  const raw = route.query.q ?? route.query.search ?? route.query.code
  const value = Array.isArray(raw) ? raw[0] : raw
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized === searchQuery.value) return false
  searchQuery.value = normalized
  currentPage.value = 1
  return true
}

const loadChannels = async () => {
  try {
    const runtime = await configService.getRuntimeConfig()
    const channels = Array.isArray(runtime.channels) ? runtime.channels : []
    if (!channels.length) return

    channelOptions.value = channels.map(channel => ({
      value: channel.key,
      label: channel.isActive ? channel.name : `${channel.name}（停用）`
    }))

    if (!channelOptions.value.some(option => option.value === selectedBatchChannel.value)) {
      selectedBatchChannel.value = channelOptions.value[0]?.value || 'common'
    }
  } catch (err) {
    console.warn('[RedemptionCodes] load channels failed', err)
  }
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  applySearchFromQuery()
  await Promise.all([
    loadCodes(),
    loadAccounts(),
    loadChannels(),
  ])

  if (typeof window !== 'undefined') {
    window.addEventListener('scroll', hideTextPopover, true)
  }
})

onUnmounted(() => {
  teleportReady.value = false
})

onBeforeUnmount(() => {
  hideTextPopover()
  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', hideTextPopover, true)
  }
})

watch(
  () => route.query,
  () => {
    const changed = applySearchFromQuery()
    if (changed) {
      loadCodes()
    }
  },
  { deep: true }
)

watch(statusFilter, () => {
  currentPage.value = 1
  loadCodes()
})

const loadCodes = async () => {
  try {
    loading.value = true
    error.value = ''

    const status = statusFilter.value === '已使用'
      ? 'redeemed'
      : statusFilter.value === '未使用'
        ? 'unused'
        : 'all'

    const response = await redemptionCodeService.list({
      page: currentPage.value,
      pageSize: pageSize.value,
      search: searchQuery.value.trim() || undefined,
      status,
    })
    codes.value = response.codes || []
    totalCodes.value = Number(response.pagination?.total || 0)
    currentPage.value = Number(response.pagination?.page || currentPage.value)
    pageSize.value = Number(response.pagination?.pageSize || pageSize.value)
  } catch (err: any) {
    error.value = err.response?.data?.error || '加载兑换码失败'
    if (err.response?.status === 401 || err.response?.status === 403) {
      authService.logout()
      router.push('/login')
    }
  } finally {
    loading.value = false
  }
}

const loadAccounts = async () => {
  try {
    // Backend caps pageSize at 100. If we request more, the API will still return 100
    // but our pagination loop would stop early (batch.length < requested pageSize).
    const pageSize = 100
    let page = 1
    const allAccounts: GptAccount[] = []

    while (true) {
      const response = await gptAccountService.getAll({ page, pageSize })
      const batch = response.accounts || []
      allAccounts.push(...batch)

      const total = Number(response.pagination?.total ?? allAccounts.length)
      const effectivePageSize = Number(response.pagination?.pageSize ?? pageSize)

      if (allAccounts.length >= total) break
      if (batch.length < effectivePageSize) break

      page += 1
      // Safety valve to avoid an infinite loop if the backend pagination breaks.
      if (page > 200) break
    }

    accounts.value = allAccounts
  } catch (err: any) {
    console.error('加载账号列表失败:', err)
  }
}

const truncateText = (text?: string | null, maxLength: number = 20) => {
  if (!text) return ''
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

const openBatchDialog = () => {
  batchCount.value = 10
  selectedAccountEmail.value = accounts.value.length > 0 ? (accounts.value[0]?.email || '') : ''
  selectedBatchChannel.value = 'common'
  showBatchDialog.value = true
}

const closeBatchDialog = () => {
  showBatchDialog.value = false
  batchCount.value = 10
  selectedAccountEmail.value = ''
  selectedBatchChannel.value = 'common'
}

const handleBatchCreate = async () => {
  if (batchCount.value < 1 || batchCount.value > 1000) {
    error.value = '数量必须在 1-1000 之间'
    return
  }

  if (!selectedAccountEmail.value) {
    error.value = '请选择所属账号'
    return
  }

  creating.value = true
  error.value = ''

  try {
    const result = await redemptionCodeService.batchCreate(batchCount.value, selectedAccountEmail.value, selectedBatchChannel.value)
    await loadCodes()
    closeBatchDialog()

    // 显示成功提示
    showSuccessToast(`成功创建 ${result.codes.length} 个兑换码${result.failed > 0 ? `，失败 ${result.failed} 个` : ''}`)
  } catch (err: any) {
    error.value = err.response?.data?.error || '创建兑换码失败'
  } finally {
    creating.value = false
  }
}

const handleDelete = async (id: number) => {
  if (!confirm('确定要删除这个兑换码吗？')) return

  try {
    await redemptionCodeService.delete(id)
    await loadCodes()
  } catch (err: any) {
    error.value = err.response?.data?.error || '删除失败'
  }
}

const isReinviting = (id: number) => reinvitingCodeIds.value.includes(id)
const handleReinvite = async (code: RedemptionCode) => {
  if (!code.isRedeemed) {
    showWarningToast('该兑换码尚未使用，无法重新邀请')
    return
  }

  if (isReinviting(code.id)) return

  reinvitingCodeIds.value = [...reinvitingCodeIds.value, code.id]
  try {
    const result = await redemptionCodeService.reinvite(code.id)
    showSuccessToast(result.message || '重新邀请已发送')
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '重新邀请失败')
  } finally {
    reinvitingCodeIds.value = reinvitingCodeIds.value.filter(id => id !== code.id)
  }
}

const toggleSelectAll = () => {
  const pageIds = codes.value.map(code => code.id)
  if (pageIds.length === 0) return

  const selectedSet = new Set(selectedCodes.value)
  const allSelected = pageIds.every(id => selectedSet.has(id))
  if (allSelected) {
    selectedCodes.value = selectedCodes.value.filter(id => !pageIds.includes(id))
    return
  }

  for (const id of pageIds) {
    selectedSet.add(id)
  }
  selectedCodes.value = Array.from(selectedSet)
}

const toggleSelect = (id: number) => {
  const index = selectedCodes.value.indexOf(id)
  if (index > -1) {
    selectedCodes.value.splice(index, 1)
  } else {
    selectedCodes.value.push(id)
  }
}

const handleBatchDelete = async () => {
  if (selectedCodes.value.length === 0) {
    showWarningToast('请选择要删除的兑换码')
    return
  }

  if (!confirm(`确定要删除选中的 ${selectedCodes.value.length} 个兑换码吗？`)) return

  try {
    await redemptionCodeService.batchDelete(selectedCodes.value)
    selectedCodes.value = []
    await loadCodes()
  } catch (err: any) {
    error.value = err.response?.data?.error || '批量删除失败'
  }
}

const copyToClipboard = async (text: string, options: { silent?: boolean } = {}) => {
  const { silent = false } = options
  try {
    await navigator.clipboard.writeText(text)
    if (!silent) {
      showSuccessToast('已复制到剪贴板')
    }
  } catch (err) {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
    if (!silent) {
      showSuccessToast('已复制到剪贴板')
    }
  }
}

const handleCopyRedeemerEmail = async (code: RedemptionCode) => {
  const email = getRedeemerEmail(code)
  if (!email) {
    showWarningToast('暂无可复制的邮箱')
    return
  }
  await copyToClipboard(email)
}

const getEventPoint = (event: MouseEvent | TouchEvent) => {
  if ('touches' in event) {
    const touch = event.touches.item(0)
    if (touch) {
      return { x: touch.clientX, y: touch.clientY }
    }
  }

  const mouseEvent = event as MouseEvent
  const fallbackX = typeof window !== 'undefined' ? window.innerWidth / 2 : 0
  const fallbackY = typeof window !== 'undefined' ? window.innerHeight / 2 : 0
  return {
    x: typeof mouseEvent.clientX === 'number' ? mouseEvent.clientX : fallbackX,
    y: typeof mouseEvent.clientY === 'number' ? mouseEvent.clientY : fallbackY
  }
}

const handleTextPreview = async (text: string, event: MouseEvent | TouchEvent) => {
  if (!text || !text.trim()) return

  const point = getEventPoint(event)
  popoverText.value = text
  popoverPosition.value = point
  showTextPopover.value = true

  if (popoverTimer) {
    clearTimeout(popoverTimer)
  }
  popoverTimer = window.setTimeout(() => {
    showTextPopover.value = false
    popoverTimer = null
  }, 2000)

  try {
    await copyToClipboard(text, { silent: true })
  } catch (error) {
    showErrorToast('复制失败，请手动选择文本')
  }
}

const exportCodes = async () => {
  try {
    const exportPageSize = 200
    let page = 1
    const exported: string[] = []

    while (true) {
      const response = await redemptionCodeService.list({
        page,
        pageSize: exportPageSize,
        status: 'unused',
      })
      const batch = (response.codes || []).map(item => item.code).filter(Boolean)
      exported.push(...batch)

      const total = Number(response.pagination?.total || 0)
      if (!total || exported.length >= total) break
      if (batch.length < exportPageSize) break

      page += 1
      if (page > 5000) break
    }

    if (exported.length === 0) {
      showInfoToast('没有未使用的兑换码可导出')
      return
    }

    const content = exported.join('\n')
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `兑换码_${new Date().toISOString().split('T')[0]}.txt`
    a.click()
    URL.revokeObjectURL(url)
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '导出失败')
  }
}

const openRedeemDialog = (code: RedemptionCode) => {
  if (code.isRedeemed) {
    showWarningToast('该兑换码已被使用，无法再次兑换')
    return
  }

  redeemTargetCode.value = code
  redeemEmail.value = code.redeemedBy || ''
  redeemOrderType.value = code.orderType === 'no_warranty' ? 'no_warranty' : 'warranty'
  showRedeemDialog.value = true
}

const closeRedeemDialog = () => {
  showRedeemDialog.value = false
  redeemTargetCode.value = null
  redeemEmail.value = ''
  redeemOrderType.value = 'warranty'
  redeeming.value = false
}

const handleRedeemInvite = async () => {
  if (!redeemTargetCode.value) {
    showErrorToast('请选择要兑换的兑换码')
    return
  }

  const email = redeemEmail.value.trim()

  if (!email) {
    showWarningToast('请输入兑换所需的邮箱')
    return
  }

  if (!EMAIL_REGEX.test(email)) {
    showWarningToast('邮箱格式不正确')
    return
  }

  redeeming.value = true
  try {
    const response = await redemptionCodeService.redeemAdmin({
      email,
      code: redeemTargetCode.value.code,
      channel: redeemTargetCode.value.channel || 'common',
      orderType: redeemOrderType.value
    })

    const successMessage = response.data?.message || '兑换成功，邀请已发送'
    showSuccessToast(successMessage)

    const updatedAt = new Date().toISOString()
    const updatedCode = {
      ...redeemTargetCode.value,
      isRedeemed: true,
      redeemedBy: email,
      redeemedAt: updatedAt,
      orderType: redeemOrderType.value
    }

    redeemTargetCode.value = updatedCode

    const index = codes.value.findIndex(code => code.id === updatedCode.id)
    if (index !== -1) {
      codes.value[index] = updatedCode
      codes.value = [...codes.value]
    }

    closeRedeemDialog()
  } catch (err: any) {
    const message = err.response?.data?.message || err.response?.data?.error || '兑换失败，请稍后再试'
    showErrorToast(message)
  } finally {
    redeeming.value = false
  }
}

const applySyncResultToAccountsState = (result: SyncUserCountResponse) => {
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
      userCount: result.syncedUserCount,
      inviteCount: typeof nextInviteCount === 'number' ? nextInviteCount : current.inviteCount,
      updatedAt: result.account.updatedAt
    }
    accounts.value = [...accounts.value]
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

const closeSyncResultDialog = () => {
  showSyncResultDialog.value = false
  syncResult.value = null
  syncError.value = ''
  previousUserCount.value = null
  previousInviteCount.value = null
  invitesList.value = []
  activeTab.value = 'members'
  resetInviteForm()
}

const refreshAccountSyncResult = async (accountId: number) => {
  try {
    const latestResult = await gptAccountService.syncUserCount(accountId)
    applySyncResultToAccountsState(latestResult)
    previousUserCount.value = latestResult.syncedUserCount
    previousInviteCount.value = typeof latestResult.inviteCount === 'number'
      ? latestResult.inviteCount
      : typeof latestResult.account?.inviteCount === 'number'
        ? latestResult.account.inviteCount
        : previousInviteCount.value
  } catch (err: any) {
    const message = err.response?.data?.error || '删除成功，但重新同步失败，请稍后再试'
    showErrorToast(message)
  }
}

const handleSyncUserCount = async (account: GptAccount) => {
  if (syncingAccountId.value === account.id) return

  syncingAccountId.value = account.id
  syncError.value = ''
  syncResult.value = null
  invitesList.value = []
  activeTab.value = 'members'
  previousUserCount.value = account.userCount
  previousInviteCount.value = typeof account.inviteCount === 'number' ? account.inviteCount : null

  try {
    const result = await gptAccountService.syncUserCount(account.id)
    applySyncResultToAccountsState(result)

    showSyncResultDialog.value = true
    loadInvites(account.id)
  } catch (err: any) {
    syncError.value = err.response?.data?.error || '同步失败，请检查网络连接和账号配置'
    showSyncResultDialog.value = true
  } finally {
    syncingAccountId.value = null
  }
}

const resolveAccountByEmail = async (email: string): Promise<GptAccount | null> => {
  const normalized = String(email || '').trim().toLowerCase()
  if (!normalized) return null

  const localMatch = accounts.value.find(account => String(account.email || '').trim().toLowerCase() === normalized)
  if (localMatch) return localMatch

  try {
    const response = await gptAccountService.getAll({ page: 1, pageSize: 100, search: normalized })
    const exact = (response.accounts || []).find(account => String(account.email || '').trim().toLowerCase() === normalized)
    return exact || null
  } catch (err) {
    return null
  }
}

const handleSyncAccountByEmail = async (email?: string) => {
  const normalized = String(email || '').trim()
  if (!normalized) return
  if (syncingAccountEmail.value === normalized) return

  syncingAccountEmail.value = normalized
  try {
    const account = await resolveAccountByEmail(normalized)
    if (!account) {
      showErrorToast('未找到该邮箱对应的账号')
      return
    }
    await handleSyncUserCount(account)
  } finally {
    syncingAccountEmail.value = null
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
    const result = await gptAccountService.deleteAccountUser(syncResult.value.account.id, userId)
    applySyncResultToAccountsState(result)
    previousUserCount.value = result.syncedUserCount
    showSuccessToast(result.message || '成员已删除')
    await refreshAccountSyncResult(result.account.id)
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '删除失败')
  } finally {
    deletingUserId.value = null
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
    await loadInvites(syncResult.value.account.id)
    activeTab.value = 'invites'
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
            class="h-10 border-gray-200 bg-white"
            :disabled="loading"
            @click="handleRefresh"
          >
            <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': loading }" />
            刷新列表
          </Button>
          <Button @click="exportCodes" variant="outline" class="h-10 bg-white border-gray-200">
            <Download class="mr-2 h-4 w-4" />
            导出
          </Button>
          <Button @click="openBatchDialog" class="h-10 bg-black hover:bg-gray-800 text-white rounded-xl shadow-lg shadow-black/10">
            <Plus class="mr-2 h-4 w-4" />
            批量生成
          </Button>
       </div>
    </Teleport>

    <!-- Filter Bar -->
    <div class="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
      <div class="flex flex-wrap items-center gap-3 w-full sm:w-auto">
        <div class="relative group w-full sm:w-72">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 h-4 w-4 transition-colors" />
          <Input
            v-model="searchQuery"
            @input="handleSearch"
            placeholder="搜索兑换码 / 邮箱 / 用户..."
            class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
          />
        </div>
        <Select v-model="statusFilter">
          <SelectTrigger class="h-11 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
            <SelectValue placeholder="状态筛选" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="全部">全部状态</SelectItem>
            <SelectItem value="未使用">未使用</SelectItem>
            <SelectItem value="已使用">已使用</SelectItem>
          </SelectContent>
        </Select>
      </div>

       <div v-if="selectedCodes.length > 0" class="animate-in fade-in slide-in-from-right-4">
          <Button
            variant="destructive"
            size="sm"
            @click="handleBatchDelete"
            class="h-10 rounded-xl px-4 shadow-sm"
          >
            <Trash2 class="mr-2 h-4 w-4" />
            批量删除 ({{ selectedCodes.length }})
          </Button>
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
        <p class="text-gray-400 text-sm font-medium mt-4">正在加载兑换码...</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="codes.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
        <div class="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
          <Ticket class="w-8 h-8 text-gray-400" />
        </div>
        <h3 class="text-lg font-semibold text-gray-900">暂无兑换码</h3>
        <p class="text-gray-500 text-sm mt-1 mb-6">没有符合当前筛选条件的兑换码</p>
        <Button
          v-if="searchQuery || statusFilter !== '全部'"
          variant="outline"
          @click="clearFilters"
          class="rounded-xl border-gray-200"
        >
          清除筛选条件
        </Button>
         <Button
            v-else
            class="rounded-xl bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-200"
            @click="openBatchDialog"
          >
            立即生成
          </Button>
      </div>

      <!-- Table & Mobile List -->
      <div v-else>
        <!-- Desktop Table -->
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="w-[50px] px-6 py-5">
                   <input
                      type="checkbox"
                      :checked="isCurrentPageAllSelected"
                      @change="toggleSelectAll"
                      class="rounded-md border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                    />
                </th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">兑换码</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">渠道</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">所属账号</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">兑换用户</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">创建时间</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr 
                v-for="code in codes" 
                :key="code.id"
                class="group hover:bg-blue-50/30 transition-colors duration-200"
              >
                 <td class="px-6 py-5">
                    <input
                      type="checkbox"
                      :checked="selectedCodes.includes(code.id)"
                      @change="toggleSelect(code.id)"
                      class="rounded-md border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                    />
                 </td>
                <td class="px-6 py-5">
                  <div class="flex items-center gap-2">
                    <span 
                       class="font-mono text-sm font-medium text-gray-900 bg-gray-100 px-2 py-1 rounded cursor-pointer hover:bg-gray-200 transition-colors"
                       @click="copyToClipboard(code.code)"
                    >
                       {{ code.code }}
                    </span>
                    <span
                        v-if="!code.isRedeemed && isCodeReserved(code)"
                        class="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600 border border-orange-200"
                      >
                        已绑定
                      </span>
                  </div>
                </td>
                <td class="px-6 py-5 text-center">
                  <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border"
                    :class="code.isRedeemed ? 'bg-gray-50 text-gray-500 border-gray-200' : 'bg-green-50 text-green-700 border-green-200'"
                  >
                    {{ code.isRedeemed ? '已使用' : '未使用' }}
                  </span>
                </td>
                <td class="px-6 py-5">
                   <Select
                      :model-value="code.channel || 'common'"
                      @update:modelValue="value => handleChannelChange(code, value)"
                      :disabled="updatingChannelId === code.id"
                    >
                      <SelectTrigger class="w-[140px] h-8 text-xs border-transparent bg-transparent hover:bg-white hover:border-gray-200 rounded-lg transition-all focus:ring-0">
                        <SelectValue
                          placeholder="选择渠道"
                          :display-text="code.channelName || getChannelLabel(code.channel)"
                        />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="option in channelOptions" :key="option.value" :value="option.value">
                          {{ option.label }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                </td>
                <td class="px-6 py-5">
                  <div class="flex items-center gap-2">
                    <div class="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 font-bold">
		                       {{ code.accountEmail ? code.accountEmail.charAt(0).toUpperCase() : '?' }}
                    </div>
                    <template v-if="code.accountEmail">
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 text-sm text-gray-600 truncate max-w-[180px] hover:text-blue-600 hover:underline transition-colors disabled:opacity-60 disabled:hover:no-underline"
                        :title="code.accountEmail"
                        :disabled="syncingAccountEmail === code.accountEmail"
                        @click="handleSyncAccountByEmail(code.accountEmail)"
                      >
                        <span class="truncate" :class="isCodeAccountBanned(code) ? 'text-red-600' : ''">{{ code.accountEmail }}</span>
                        <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': syncingAccountEmail === code.accountEmail }" />
	                      </button>
	                    </template>
	                    <span v-else class="text-sm text-gray-400">-</span>
	                  </div>
	                </td>
                <td class="px-6 py-5">
                   <div class="flex flex-col items-start gap-1">
                      <span
                        class="text-sm font-medium text-gray-900 truncate max-w-[150px]"
                        :class="getRedeemerEmail(code) ? 'cursor-pointer hover:text-blue-600' : ''"
                        :title="getRedeemerDisplay(code) || '-'"
                        @click="getRedeemerEmail(code) ? handleCopyRedeemerEmail(code) : null"
                      >
                        {{ getRedeemerDisplay(code) || '-' }}
                      </span>
                      <span
                        v-if="hasPendingReservation(code)"
                        class="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600"
                      >
                        待兑换
                      </span>
                      <span
                        v-else-if="code.isRedeemed"
                        class="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600"
                      >
                        {{ code.orderType === 'no_warranty' ? '无质保' : (code.orderType === 'anti_ban' ? '防封禁' : '质保') }}
                      </span>
                   </div>
                </td>
                <td class="px-6 py-5 text-sm text-gray-500">{{ formatShanghaiDate(code.createdAt, dateFormatOptions).split(' ')[0] }}</td>
	                <td class="px-6 py-5 text-right">
	                  <div class="flex items-center justify-end gap-1">
	                    <!-- Reinvite -->
	                    <Button
	                      v-if="code.isRedeemed"
	                      size="icon"
	                      variant="ghost"
	                      class="h-8 w-8 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg"
	                      @click="handleReinvite(code)"
	                      :disabled="isReinviting(code.id)"
	                      title="重新邀请"
	                    >
	                      <RefreshCcw class="w-4 h-4" :class="isReinviting(code.id) ? 'animate-spin' : ''" />
	                    </Button>
	                    <!-- Redeem -->
	                    <Button
	                      v-else
	                      size="icon"
	                      variant="ghost"
	                      class="h-8 w-8 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-lg"
	                      @click="openRedeemDialog(code)"
	                      title="发起兑换"
	                    >
	                      <Ticket class="w-4 h-4" />
	                    </Button>

	                    <!-- Delete -->
	                    <Button 
	                      size="icon" 
                      variant="ghost" 
                      class="h-8 w-8 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                      @click="handleDelete(code.id)"
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
          <div v-for="code in codes" :key="code.id" class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
             <div class="flex items-start justify-between mb-4">
                <div class="flex items-center gap-2">
                   <span 
                      class="font-mono text-sm font-medium text-gray-900 bg-gray-100 px-2 py-1 rounded cursor-pointer active:bg-gray-200 transition-colors"
                      @click="copyToClipboard(code.code)"
                   >
                      {{ code.code }}
                   </span>
                   <span
                      v-if="!code.isRedeemed && isCodeReserved(code)"
                      class="rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600 border border-orange-200"
                   >
                      已绑定
                   </span>
                </div>
                <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold border"
                   :class="code.isRedeemed ? 'bg-gray-50 text-gray-500 border-gray-200' : 'bg-green-50 text-green-700 border-green-200'"
                >
                   {{ code.isRedeemed ? '已使用' : '未使用' }}
                </span>
             </div>

             <div class="space-y-3 mb-4">
                <div class="grid grid-cols-2 gap-4">
                   <div>
                      <p class="text-xs text-gray-400 mb-1">渠道</p>
                      <Select
                         :model-value="code.channel || 'common'"
                         @update:modelValue="value => handleChannelChange(code, value)"
                         :disabled="updatingChannelId === code.id"
                       >
                         <SelectTrigger class="w-full h-8 text-xs bg-gray-50 border-gray-200 rounded-lg">
                           <SelectValue
                             :display-text="code.channelName || getChannelLabel(code.channel)"
                           />
                         </SelectTrigger>
                         <SelectContent>
                           <SelectItem v-for="option in channelOptions" :key="option.value" :value="option.value">
                             {{ option.label }}
                           </SelectItem>
                         </SelectContent>
                       </Select>
                   </div>
                   <div>
                      <p class="text-xs text-gray-400 mb-1">所属账号</p>
	                      <button
	                        v-if="code.accountEmail"
	                        type="button"
	                        class="w-full h-8 flex items-center px-3 gap-2 bg-gray-50 border border-gray-200 rounded-lg overflow-hidden hover:bg-white transition-colors disabled:opacity-60"
	                        :disabled="syncingAccountEmail === code.accountEmail"
	                        @click="handleSyncAccountByEmail(code.accountEmail)"
	                      >
		                        <div class="w-4 h-4 flex-shrink-0 rounded-full bg-white flex items-center justify-center text-[10px] text-gray-500 font-bold shadow-sm">
		                          {{ code.accountEmail.charAt(0).toUpperCase() }}
		                        </div>
		                        <span class="text-xs truncate" :class="isCodeAccountBanned(code) ? 'text-red-600' : 'text-gray-700'">{{ code.accountEmail }}</span>
		                        <RefreshCw class="w-3.5 h-3.5 text-gray-400 ml-auto" :class="{ 'animate-spin': syncingAccountEmail === code.accountEmail }" />
		                      </button>
                      <div v-else class="w-full h-8 flex items-center px-3 gap-2 bg-gray-50 border border-gray-200 rounded-lg overflow-hidden">
                        <div class="w-4 h-4 flex-shrink-0 rounded-full bg-white flex items-center justify-center text-[10px] text-gray-500 font-bold shadow-sm">
                          ?
                        </div>
                        <span class="text-xs text-gray-700 truncate">-</span>
                      </div>
                   </div>
                </div>

                <div v-if="getRedeemerDisplay(code) || hasPendingReservation(code)" class="bg-gray-50 p-3 rounded-xl">
                   <div class="flex items-center justify-between">
                      <span class="text-xs text-gray-400">兑换用户</span>
                      <span
                         v-if="hasPendingReservation(code)"
                         class="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-medium text-orange-600 border border-orange-100"
                      >
                         待兑换
                      </span>
                   </div>
                   <p
                      class="text-sm font-medium text-gray-900 mt-1 truncate"
                      :class="getRedeemerEmail(code) ? 'cursor-pointer hover:text-blue-600' : ''"
                      :title="getRedeemerDisplay(code) || '-'"
                      @click="getRedeemerEmail(code) ? handleCopyRedeemerEmail(code) : null"
                   >
                      {{ getRedeemerDisplay(code) || '-' }}
                   </p>
                   <span
                      v-if="code.isRedeemed"
                      class="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600 mt-2"
                   >
                      {{ code.orderType === 'no_warranty' ? '无质保' : (code.orderType === 'anti_ban' ? '防封禁' : '质保') }}
                   </span>
                </div>
                
                <div class="flex items-center justify-between text-xs text-gray-400 pt-2 border-t border-gray-50">
                   <span>创建时间</span>
                   <span>{{ formatShanghaiDate(code.createdAt, dateFormatOptions).split(' ')[0] }}</span>
                </div>
             </div>

	             <div class="flex items-center justify-end gap-2 pt-2 border-t border-gray-50">
	                <Button
	                   v-if="code.isRedeemed"
	                   size="sm"
	                   variant="outline"
	                   class="h-9 text-xs border-blue-200 text-blue-600 hover:bg-blue-50"
	                   @click="handleReinvite(code)"
	                   :disabled="isReinviting(code.id)"
	                >
	                   <RefreshCcw class="w-3.5 h-3.5 mr-1" :class="isReinviting(code.id) ? 'animate-spin' : ''" />
	                   重新邀请
	                </Button>
	                <Button
	                   v-else
	                   size="sm"
	                   variant="outline"
	                   class="h-9 text-xs border-green-200 text-green-600 hover:bg-green-50"
	                   @click="openRedeemDialog(code)"
	                >
	                   <Ticket class="w-3.5 h-3.5 mr-1" />
	                   兑换
	                </Button>
	                <Button 
	                   size="sm" 
	                   variant="ghost" 
	                   class="h-9 w-9 p-0 text-gray-400 text-red-400 hover:text-red-600 hover:bg-red-50" 
                   @click="handleDelete(code.id)"
                >
                   <Trash2 class="w-4 h-4"/>
                </Button>
             </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="px-6 py-4 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gray-50/30">
           <div class="text-xs text-gray-500 font-medium">
              共 {{ totalCodes }} 个兑换码
           </div>
           
           <div v-if="totalPages > 1" class="flex items-center gap-1">
              <Button
                size="icon"
                variant="outline"
                class="h-8 w-8 rounded-lg border-gray-200"
     :disabled="currentPage <= 1"
                @click="goToPage(currentPage - 1)"
              >
                <ChevronLeft class="h-4 w-4" />
              </Button>
              <span class="text-sm font-medium text-gray-600 px-2">
                {{ currentPage }} / {{ totalPages }}
              </span>
              <Button
                size="icon"
                variant="outline"
                class="h-8 w-8 rounded-lg border-gray-200"
                :disabled="currentPage >= totalPages"
                @click="goToPage(currentPage + 1)"
              >
                <ChevronRight class="h-4 w-4" />
              </Button>
           </div>
        </div>
      </div>
    </div>

    <!-- Sync Result Dialog -->
    <Dialog v-model:open="showSyncResultDialog">
      <DialogContent class="sm:max-w-[800px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
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
                      <th class="px-4 py-3 text-left font-medium">成员</th>
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
                          class="text-gray-400 hover:text-red-600 transition-colors p-1 rounded hover:bg-red-50 disabled:opacity-50"
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
                    </tr>
                    <tr v-if="!invitesList.length">
                      <td colspan="3" class="px-4 py-8 text-center text-gray-400">暂无待加入邀请</td>
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
      </DialogContent>
    </Dialog>

    <!-- Batch Generate Dialog -->
    <Dialog v-model:open="showBatchDialog">
      <DialogContent class="sm:max-w-[500px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">批量生成兑换码</DialogTitle>
        </DialogHeader>
        
        <div class="px-8 pb-8 space-y-6">
           <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">所属账号</Label>
              <Select v-model="selectedAccountEmail">
                <SelectTrigger class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500">
                  <SelectValue placeholder="选择账号" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="account in accounts" :key="account.id" :value="account.email">
                    {{ account.email }} (当前{{ account.userCount }}人)
                  </SelectItem>
                </SelectContent>
              </Select>
              <p class="text-xs text-gray-400">
                可创建数量 = 6 - 当前人数 - 未使用的兑换码数。
              </p>
           </div>

           <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">渠道</Label>
              <Select v-model="selectedBatchChannel">
                <SelectTrigger class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500">
                  <SelectValue placeholder="选择渠道" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="channel in channelOptions" :key="channel.value" :value="channel.value">
                    {{ channel.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
           </div>
           
           <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">生成数量</Label>
              <Input
                v-model.number="batchCount"
                type="number"
                min="1"
                max="1000"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
              />
           </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
           <Button variant="ghost" @click="closeBatchDialog" class="rounded-xl text-gray-500">取消</Button>
           <Button @click="handleBatchCreate" :disabled="creating" class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6">
             {{ creating ? '生成中...' : '开始生成' }}
           </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Redeem Dialog -->
    <Dialog v-model:open="showRedeemDialog">
      <DialogContent class="sm:max-w-[500px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">发送兑换邀请</DialogTitle>
        </DialogHeader>
        
        <div class="px-8 pb-8 space-y-6">
           <div v-if="redeemTargetCode" class="p-4 bg-blue-50 rounded-2xl border border-blue-100 space-y-2">
              <div class="flex justify-between items-center">
                 <span class="text-xs text-blue-600 font-semibold uppercase">Code</span>
                 <span class="font-mono font-medium text-blue-900">{{ redeemTargetCode.code }}</span>
              </div>
              <div class="flex justify-between items-center">
                 <span class="text-xs text-blue-600 font-semibold uppercase">Account</span>
                 <span
                   class="font-medium"
                   :class="isCodeAccountBanned(redeemTargetCode) ? 'text-red-600' : 'text-blue-900'"
                 >
                   {{ redeemTargetCode.accountEmail || '未指定' }}
                 </span>
              </div>
           </div>

           <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">订单类型</Label>
              <Select v-model="redeemOrderType">
                <SelectTrigger class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500">
                  <SelectValue placeholder="选择订单类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in orderTypeOptions" :key="option.value" :value="option.value">
                    {{ option.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p class="text-xs text-gray-400">无质保订单不支持退款与补号。</p>
           </div>

           <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">受邀邮箱</Label>
              <Input
                v-model="redeemEmail"
                type="email"
                placeholder="name@example.com"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
              />
              <p class="text-xs text-gray-400">将向该邮箱发送 ChatGPT 成员邀请链接。</p>
           </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
           <Button variant="ghost" @click="closeRedeemDialog" class="rounded-xl text-gray-500">取消</Button>
           <Button @click="handleRedeemInvite" :disabled="redeeming" class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6">
             {{ redeeming ? '发送中...' : '确认发送' }}
           </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Text Popover (Legacy) -->
    <div
      v-if="showTextPopover"
      class="fixed z-50 px-3 py-2 bg-gray-900/90 text-white text-xs rounded-lg pointer-events-none shadow-xl max-w-[280px] backdrop-blur-sm"
      :style="{
        top: `${popoverPosition.y - 12}px`,
        left: `${popoverPosition.x}px`,
        transform: 'translate(-50%, -100%)'
      }"
    >
      <p class="text-[10px] uppercase tracking-widest text-gray-400 mb-1">已复制</p>
      <p class="break-all leading-snug">{{ popoverText }}</p>
    </div>
  </div>
</template>
