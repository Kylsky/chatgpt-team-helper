<script setup lang="ts">
import { ref, onMounted, computed, onUnmounted, nextTick, watch } from 'vue'
import { useRouter } from 'vue-router'
import { authService, gptAccountService, type GptAccount, type CreateGptAccountDto, type SyncUserCountResponse, type GptAccountsListParams, type ChatgptAccountInviteItem } from '@/services/api'
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
const { success: showSuccessToast, error: showErrorToast } = useToast()
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
const autoCompleting = ref(false)
const foundAccounts = ref<any[]>([])
const showSuggestions = ref(false)
const showAccountSelectDialog = ref(false)
const showBatchImportDialog = ref(false)
const batchImportData = ref('')
const isImporting = ref(false)

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
  isDemoted: false,
  isBanned: false,
  chatgptAccountId: '',
  oaiDeviceId: '',
  expireAt: ''
})

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

const openEditDialog = (account: GptAccount) => {
  editingAccount.value = account
  formData.value = {
    email: account.email,
    token: account.token,
    refreshToken: account.refreshToken || '',
    userCount: account.userCount,
    isDemoted: Boolean(account.isDemoted),
    isBanned: Boolean(account.isBanned),
    chatgptAccountId: account.chatgptAccountId || '',
    oaiDeviceId: account.oaiDeviceId || '',
    expireAt: toDatetimeLocal(account.expireAt || '')
  }
  showDialog.value = true
}

const closeDialog = () => {
  showDialog.value = false
  editingAccount.value = null
  formData.value = { email: '', token: '', refreshToken: '', userCount: 0, isDemoted: false, isBanned: false, chatgptAccountId: '', oaiDeviceId: '', expireAt: '' }
  autoCompleting.value = false
}

const handleAutoComplete = async () => {
  if (!formData.value.token?.trim()) {
    showErrorToast('请先输入 Access Token')
    return
  }

  autoCompleting.value = true
  try {
    const result = await gptAccountService.completeInfo(formData.value.token.trim())
    
    // Set email if it's currently empty
    if (result.email && !formData.value.email) {
      formData.value.email = result.email
    }
    
    // Collect accounts and decide showing selection or directly applying
    if (result.accounts && result.accounts.length > 0) {
      foundAccounts.value = result.accounts
      if (result.accounts.length === 1) {
        applyAccountSelection(result.accounts[0])
        showSuccessToast('已成功补全账号信息')
      } else {
        showSuggestions.value = true
        showSuccessToast(`检测到 ${result.accounts.length} 个 Team 账号，请点击输入框选择`)
      }
    } else {
      showErrorToast('未找到 Team 类型的账号')
    }
  } catch (err: any) {
    const message = err.response?.data?.error || '自动补全失败，请手动填写'
    showErrorToast(message)
  } finally {
    autoCompleting.value = false
  }
}

const applyAccountSelection = (account: any) => {
  formData.value.chatgptAccountId = account.accountId
  formData.value.isDemoted = account.isDemoted === true
  if (account.expiresAt) {
    formData.value.expireAt = toDatetimeLocal(account.expiresAt)
  }
  showSuggestions.value = false
}

const selectAccount = (account: any) => {
  applyAccountSelection(account)
}

const handleInputFocus = () => {
  if (foundAccounts.value.length > 0) {
    showSuggestions.value = true
  }
}

const handleInputBlur = () => {
  // 延迟关闭，以便点击事件能先触发
  setTimeout(() => {
    showSuggestions.value = false
  }, 200)
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

const handleBatchImport = async () => {
  const lines = batchImportData.value.split('\n').filter(l => l.trim())
  if (lines.length === 0) {
    showErrorToast('请输入导入数据')
    return
  }

  const accessTokenRegex = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  const accountIdRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
  const refreshTokenRegex = /rt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g

  const importAccounts: Partial<CreateGptAccountDto>[] = []

  for (const line of lines) {
    const tokens = line.match(accessTokenRegex)
    const emails = line.match(emailRegex)
    const ids = line.match(accountIdRegex)
    const refreshTokens = line.match(refreshTokenRegex)

    if (tokens || refreshTokens || emails || ids) {
      importAccounts.push({
        token: tokens ? tokens[0] : '',
        email: emails ? emails[0] : '',
        chatgptAccountId: ids ? ids[0] : '',
        refreshToken: refreshTokens ? refreshTokens[0] : '',
        userCount: 1,
        isBanned: false
      })
    }
  }

  if (importAccounts.length === 0) {
    showErrorToast('未能解析到任何账号信息，请检查格式')
    return
  }

  isImporting.value = true
  try {
    const response = await gptAccountService.batchCreate(importAccounts)
    const successCount = response.results.filter((r: any) => r.success).length
    const failCount = response.results.length - successCount
    
    showSuccessToast(`导入完成: 成功 ${successCount} 个, 失败 ${failCount} 个`)
    
    if (failCount > 0) {
      console.warn('部分账号导入失败:', response.results.filter((r: any) => !r.success))
    }
    
    await loadAccounts()
    showBatchImportDialog.value = false
    batchImportData.value = ''
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '批量导入失败')
  } finally {
    isImporting.value = false
  }
}
</script>

<template>
  <div class="space-y-8">
    <!-- Header Actions -->
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-3">
        <Button
          @click="showBatchImportDialog = true"
          variant="outline"
          class="bg-white hover:bg-gray-50 text-gray-700 border-gray-200 rounded-xl px-5 h-10 shadow-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
        >
          <Plus class="w-4 h-4 mr-2" />
          批量导入
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
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">已加入</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">待加入</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">降级</th>
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
	                    <span
	                      class="text-sm font-medium"
	                      :class="account.isBanned ? 'text-red-600' : 'text-gray-900'"
	                    >
	                      {{ account.email }}
	                    </span>
	                  </div>
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
                <td class="px-6 py-5 text-center">
                  <span
                    class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border"
                    :class="account.isDemoted ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-gray-50 text-gray-500 border-gray-100'"
                  >
                    {{ account.isDemoted ? '已降级' : '未降级' }}
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
                 <span
                   class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold border"
                   :class="account.isDemoted ? 'bg-amber-50 text-amber-700 border-amber-100' : 'bg-gray-50 text-gray-500 border-gray-100'"
                 >
                   {{ account.isDemoted ? '已降级' : '未降级' }}
                 </span>
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

    <!-- Batch Import Dialog -->
    <Dialog v-model:open="showBatchImportDialog">
      <DialogContent class="sm:max-w-[500px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">
            批量导入账号
          </DialogTitle>
          <p class="text-sm text-gray-500 mt-1">支持每行一个账号，将自动支持解析 Token、邮箱、ChatGPT ID 和 Refresh Token。</p>
        </DialogHeader>
        
        <div class="px-8 pb-8 space-y-5">
          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">批量数据</Label>
            <textarea
              v-model="batchImportData"
              placeholder="eyJ... | example@mail.com | 00000000-0000-... | rt_..."
              class="w-full h-48 p-4 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm resize-none"
            ></textarea>
          </div>

          <div class="flex flex-col gap-2">
            <Button
              @click="handleBatchImport"
              class="w-full h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-semibold shadow-lg shadow-blue-200 transition-all hover:scale-[1.01] active:scale-[0.99]"
              :disabled="isImporting"
            >
              <RefreshCw v-if="isImporting" class="w-4 h-4 mr-2 animate-spin" />
              立即导入
            </Button>
            <Button
              @click="showBatchImportDialog = false"
              variant="ghost"
              class="w-full h-12 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-xl font-medium transition-all"
            >
              取消
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Edit Dialog -->
    <Dialog v-model:open="showDialog">
      <DialogContent class="sm:max-w-[500px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">
            {{ editingAccount ? '编辑账号' : '新建账号' }}
          </DialogTitle>
        </DialogHeader>
        
        <form @submit.prevent="handleSubmit" class="px-8 pb-8 space-y-5">
           <div class="space-y-4">
              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">邮箱</Label>
                <Input
                  v-model="formData.email"
                  type="email"
                  placeholder="name@example.com"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all"
                />
              </div>

   <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Access Token</Label>
                <div class="flex gap-2">
                  <Input
                    v-model="formData.token"
                    required
                    placeholder="sk-proj-..."
                    class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm flex-1"
                  />
                  <Button 
                    type="button" 
                    variant="outline" 
                    class="h-11 px-3 rounded-xl border-gray-200 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-all"
                    @click="handleAutoComplete"
                    :disabled="autoCompleting"
                  >
                    <RefreshCw v-if="autoCompleting" class="w-4 h-4 animate-spin" />
                    <span v-else class="text-xs font-medium whitespace-nowrap">自动补全</span>
                  </Button>
                </div>
              </div>

              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Refresh Token</Label>
                <Input
                  v-model="formData.refreshToken"
                  placeholder="可选，用于自动刷新"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                />
              </div>

		              <div class="grid grid-cols-2 gap-4">
		                 <div class="space-y-2">
		                    <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">ChatGPT ID</Label>
                        <div class="relative">
                          <Input
                            v-model="formData.chatgptAccountId"
                            placeholder="自动补全或手动输入"
                            class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all font-mono text-sm"
                            @focus="handleInputFocus"
                            @blur="handleInputBlur"
                          />
                          
                          <!-- Suggestions Dropdown -->
                          <div 
                            v-if="showSuggestions && foundAccounts.length > 0" 
                            class="absolute z-10 w-full mt-1 bg-white border border-gray-100 rounded-2xl shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-1"
                          >
                            <div class="max-h-48 overflow-y-auto">
                              <button
                                v-for="acc in foundAccounts"
                                :key="acc.accountId"
                                type="button"
                                class="w-full px-4 py-3 text-left hover:bg-blue-50 transition-colors flex flex-col gap-0.5"
                                @click="selectAccount(acc)"
                              >
                                <span class="text-sm font-bold text-gray-900">{{ acc.name }}</span>
                                <span class="text-xs text-gray-400 font-mono">{{ acc.accountId }}</span>
                              </button>
                            </div>
                          </div>
                        </div>
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
                      <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">降级状态</Label>
                      <div class="flex items-center gap-1 bg-gray-100 p-1 rounded-xl">
                        <button
                          type="button"
                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="!formData.isDemoted ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                          @click="formData.isDemoted = false"
                        >
                          未降级
                        </button>
                        <button
                          type="button"
                          class="flex-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                          :class="formData.isDemoted ? 'bg-amber-50 text-amber-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
                          @click="formData.isDemoted = true"
                        >
                          已降级
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

           <DialogFooter class="pt-4">
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
