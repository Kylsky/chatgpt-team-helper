<script setup lang="ts">
import { computed, onMounted, ref, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
	import {
	  authService,
	  accountRecoveryAdminService,
	  type AccountRecoveryBannedAccountSummary,
	  type AccountRecoveryBannedAccountRedeem,
	  type AccountRecoveryRedeemSource,
	  type AccountRecoveryLogRecord,
	  type AccountRecoveryOneClickPreviewResponse,
	} from '@/services/api'
	import { formatShanghaiDate } from '@/lib/datetime'
	import { useAppConfigStore } from '@/stores/appConfig'
	import { useToast } from '@/components/ui/toast'
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
		  DialogFooter,
		  DialogHeader,
		  DialogTitle,
		} from '@/components/ui/dialog'
		import { Search, RefreshCw, ChevronLeft, ChevronRight, ClipboardList, BadgeCheck, Sparkles } from 'lucide-vue-next'

const router = useRouter()
const { success: showSuccessToast, warning: showWarningToast, error: showErrorToast } = useToast()
const appConfigStore = useAppConfigStore()
const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))

const teleportReady = ref(false)

const days = ref('30')
const daysNumber = computed(() => {
  const parsed = Number.parseInt(days.value, 10)
  if (!Number.isFinite(parsed)) return 30
  return Math.max(1, Math.min(90, parsed))
})

const accounts = ref<AccountRecoveryBannedAccountSummary[]>([])
const accountsLoading = ref(false)
const accountsError = ref('')
const accountsSearch = ref('')
const accountsFilter = ref<'all' | 'pending'>('all')
type AccountRecoverySourceFilter = Exclude<AccountRecoveryRedeemSource, ''>
const sourceOptions: Array<{ value: AccountRecoverySourceFilter; label: string }> = [
  { value: 'payment', label: '支付订单' },
  { value: 'credit', label: '积分订单' },
  { value: 'xianyu', label: '闲鱼' },
  { value: 'xhs', label: '小红书' },
  { value: 'manual', label: '手动' },
]
const selectedSources = ref<AccountRecoverySourceFilter[]>(sourceOptions.map(item => item.value))
const selectedSourcesParam = computed(() => selectedSources.value.join(','))
const selectedSourcesKey = computed(() => [...selectedSources.value].slice().sort().join(','))
const accountsPagination = ref({ page: 1, pageSize: 8, total: 0 })
const accountsPageSize = computed({
  get: () => String(accountsPagination.value.pageSize),
  set: (value) => {
    const nextPageSize = Number.parseInt(String(value ?? ''), 10)
    if (!Number.isFinite(nextPageSize)) return
    const normalized = Math.max(1, Math.min(100, nextPageSize))
    if (normalized === accountsPagination.value.pageSize) return

    accountsPagination.value.page = 1
    accountsPagination.value.pageSize = normalized
    loadAccounts()
  },
})

const selectedAccountId = ref<number | null>(null)
const selectedAccountEmail = ref('')
const accountSelectionMode = ref(false)
const selectedAccountIds = ref<number[]>([])
const accountsCurrentPageIds = computed(() => accounts.value.map(account => account.id))
const allAccountsSelectedCurrentPage = computed(() => {
  if (!accountSelectionMode.value) return false
  const ids = accountsCurrentPageIds.value
  if (!ids.length) return false
  const selectedSet = new Set(selectedAccountIds.value)
  return ids.every(id => selectedSet.has(id))
})
const processedAccountIds = computed(() => {
  if (accountSelectionMode.value) return selectedAccountIds.value
  const accountId = selectedAccountId.value
  return accountId != null ? [accountId] : []
})

const redeems = ref<AccountRecoveryBannedAccountRedeem[]>([])
const redeemsLoading = ref(false)
const redeemsError = ref('')
const redeemsSearch = ref('')
const redeemsStatus = ref<'pending' | 'failed' | 'done' | 'all'>('pending')
const redeemsPagination = ref({ page: 1, pageSize: 8, total: 0 })

	const selectedOriginalCodeIds = ref<number[]>([])
const sourcePopoverOpen = ref(false)
	const recovering = ref(false)
	const markingProcessed = ref(false)

	const ONE_CLICK_SOURCE_STORAGE_KEY = 'accountRecovery.oneClickSource'
	const oneClickDialogOpen = ref(false)
	const oneClickSource = ref<AccountRecoverySourceFilter>('payment')
	const oneClickLoading = ref(false)
	const oneClickProcessing = ref(false)
	const oneClickError = ref('')
	const oneClickHasProcessed = ref(false)
	const oneClickStats = ref<AccountRecoveryOneClickPreviewResponse | null>(null)
	const oneClickSourceOptions: Array<{ value: AccountRecoverySourceFilter; label: string }> = [
	  { value: 'payment', label: '支付订单' },
	  { value: 'xianyu', label: '闲鱼' },
	  { value: 'credit', label: '积分订单（credit）' },
	  { value: 'xhs', label: '小红书' },
	  { value: 'manual', label: '手动' },
	]

const logsDialogOpen = ref(false)
const logsLoading = ref(false)
const logs = ref<AccountRecoveryLogRecord[]>([])
const logsOriginalCodeId = ref<number | null>(null)

onMounted(() => {
  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }
})

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')
  await loadAccounts()
})

const accountsTotalPages = computed(() =>
  Math.max(1, Math.ceil(accountsPagination.value.total / accountsPagination.value.pageSize))
)

const redeemsTotalPages = computed(() =>
  Math.max(1, Math.ceil(redeemsPagination.value.total / redeemsPagination.value.pageSize))
)

const oneClickPrimaryLabel = computed(() => {
  const stats = oneClickStats.value
  if (!stats) return '确定'
  const count = Number(stats.willProcessCount || 0)
  if (!Number.isFinite(count) || count <= 0) {
    return oneClickHasProcessed.value ? '继续处理下一批' : '确定'
  }
  return oneClickHasProcessed.value ? `继续处理下一批（${count}）` : `确定并开始（${count}）`
})

const channelLabel = (channel?: string) => {
  const normalized = String(channel || '').trim()
  if (normalized === 'xhs') return '小红书'
  if (normalized === 'xianyu') return '闲鱼'
  if (normalized === 'common') return '通用'
  return normalized || '-'
}

const sourceLabel = (source?: string) => {
  const normalized = String(source || '').trim()
  if (normalized === 'payment') return '支付订单'
  if (normalized === 'credit') return '积分订单'
  if (normalized === 'xianyu') return '闲鱼'
  if (normalized === 'xhs') return '小红书'
  if (normalized === 'manual') return '手动'
  return normalized || '-'
}

const stateLabel = (state: string) => {
  if (state === 'done') return '已完成'
  if (state === 'failed') return '失败'
  return '待补录'
}

const stateClass = (state: string) => {
  if (state === 'done') return 'bg-green-50 text-green-700 border border-green-100'
  if (state === 'failed') return 'bg-red-50 text-red-700 border border-red-100'
  return 'bg-amber-50 text-amber-700 border border-amber-100'
}

	const loadAccounts = async () => {
	  accountsLoading.value = true
	  accountsError.value = ''
	  try {
	    const response = await accountRecoveryAdminService.listBannedAccounts({
	      page: accountsPagination.value.page,
	      pageSize: accountsPagination.value.pageSize,
	      search: accountsSearch.value.trim() || undefined,
	      days: daysNumber.value,
	      pendingOnly: accountsFilter.value === 'pending' ? true : undefined,
	      sources: selectedSourcesParam.value,
	    })
	    const nextAccounts = response.accounts || []
	    accounts.value = nextAccounts
	    accountsPagination.value = response.pagination || { page: 1, pageSize: accountsPagination.value.pageSize, total: 0 }

	    const currentSelectedId = selectedAccountId.value
	    if (currentSelectedId != null) {
	      const existing = nextAccounts.find(item => item.id === currentSelectedId) || null
	      if (existing) {
	        selectedAccountEmail.value = existing.email
	      } else {
	        selectedAccountId.value = null
	        selectedAccountEmail.value = ''
	        selectedOriginalCodeIds.value = []
	        redeems.value = []
	        redeemsPagination.value = { page: 1, pageSize: redeemsPagination.value.pageSize, total: 0 }
	      }
	    }

	    if (selectedAccountId.value == null && nextAccounts.length > 0) {
	      selectAccount(nextAccounts[0]!)
	    }

	    if (nextAccounts.length === 0) {
	      selectedAccountId.value = null
	      selectedAccountEmail.value = ''
	      selectedOriginalCodeIds.value = []
	      redeems.value = []
	      redeemsPagination.value = { page: 1, pageSize: redeemsPagination.value.pageSize, total: 0 }
	    }
	  } catch (err: any) {
	    accountsError.value = err.response?.data?.error || '加载失败'
	    if (err.response?.status === 401 || err.response?.status === 403) {
	      authService.logout()
      router.push('/login')
    }
  } finally {
    accountsLoading.value = false
  }
}

const loadRedeems = async () => {
  if (!selectedAccountId.value) return

  redeemsLoading.value = true
  redeemsError.value = ''
  try {
    const response = await accountRecoveryAdminService.listBannedAccountRedeems(selectedAccountId.value, {
      page: redeemsPagination.value.page,
      pageSize: redeemsPagination.value.pageSize,
      search: redeemsSearch.value.trim() || undefined,
      status: redeemsStatus.value,
      days: daysNumber.value,
      sources: selectedSourcesParam.value,
    })
    redeems.value = response.redeems || []
    redeemsPagination.value = response.pagination || { page: 1, pageSize: 5, total: 0 }
    selectedOriginalCodeIds.value = redeems.value.filter(isSelectableRedeem).map(item => item.originalCodeId)
  } catch (err: any) {
    redeemsError.value = err.response?.data?.error || '加载失败'
    if (err.response?.status === 401 || err.response?.status === 403) {
      authService.logout()
      router.push('/login')
    }
  } finally {
    redeemsLoading.value = false
  }
}

const selectAccount = (account: AccountRecoveryBannedAccountSummary) => {
  selectedAccountId.value = account.id
  selectedAccountEmail.value = account.email
  selectedOriginalCodeIds.value = []
  redeemsPagination.value.page = 1
  loadRedeems()
}

const toggleAccountSelectionMode = () => {
  accountSelectionMode.value = !accountSelectionMode.value
  if (!accountSelectionMode.value) {
    selectedAccountIds.value = []
  }
}

const toggleAccountSelected = (accountId: number) => {
  const index = selectedAccountIds.value.indexOf(accountId)
  if (index >= 0) {
    selectedAccountIds.value.splice(index, 1)
  } else {
    selectedAccountIds.value.push(accountId)
  }
}

const toggleSelectAllAccountsCurrentPage = () => {
  const ids = accountsCurrentPageIds.value
  if (!ids.length) return

  const selectedSet = new Set(selectedAccountIds.value)
  const allSelected = ids.every(id => selectedSet.has(id))
  if (allSelected) {
    selectedAccountIds.value = selectedAccountIds.value.filter(id => !ids.includes(id))
    return
  }

  for (const id of ids) {
    selectedSet.add(id)
  }
  selectedAccountIds.value = Array.from(selectedSet)
}

const handleAccountsSearch = () => {
  selectedAccountIds.value = []
  accountsPagination.value.page = 1
  loadAccounts()
}

const goToAccountsPage = (page: number) => {
  if (page < 1 || page > accountsTotalPages.value || page === accountsPagination.value.page) return
  accountsPagination.value.page = page
  loadAccounts()
}

watch(accountsFilter, () => {
  selectedAccountIds.value = []
  accountsPagination.value.page = 1
  loadAccounts()
})

watch(selectedSourcesKey, async () => {
  selectedAccountIds.value = []
  accountsPagination.value.page = 1
  redeemsPagination.value.page = 1
  selectedOriginalCodeIds.value = []
  await loadAccounts()
  await loadRedeems()
})

const handleRedeemsSearch = () => {
  redeemsPagination.value.page = 1
  selectedOriginalCodeIds.value = []
  loadRedeems()
}

const goToRedeemsPage = (page: number) => {
  if (page < 1 || page > redeemsTotalPages.value || page === redeemsPagination.value.page) return
  redeemsPagination.value.page = page
  selectedOriginalCodeIds.value = []
  loadRedeems()
}

watch(redeemsStatus, () => {
  redeemsPagination.value.page = 1
  selectedOriginalCodeIds.value = []
  loadRedeems()
})

watch(oneClickSource, async () => {
  if (!oneClickDialogOpen.value) return
  oneClickHasProcessed.value = false
  await fetchOneClickPreview()
})

watch(days, async () => {
  selectedAccountIds.value = []
  accountsPagination.value.page = 1
  redeemsPagination.value.page = 1
  selectedOriginalCodeIds.value = []
  await loadAccounts()
  await loadRedeems()
  if (oneClickDialogOpen.value) {
    oneClickHasProcessed.value = false
    await fetchOneClickPreview()
  }
})

const isSelectableRedeem = (redeem: AccountRecoveryBannedAccountRedeem) => redeem.state !== 'done'

const toggleSelect = (originalCodeId: number) => {
  const index = selectedOriginalCodeIds.value.indexOf(originalCodeId)
  if (index >= 0) {
    selectedOriginalCodeIds.value.splice(index, 1)
  } else {
    selectedOriginalCodeIds.value.push(originalCodeId)
  }
}

const toggleSelectAllCurrentPage = () => {
  const selectableIds = redeems.value.filter(isSelectableRedeem).map(item => item.originalCodeId)
  if (selectableIds.length === 0) return
  const selectedSet = new Set(selectedOriginalCodeIds.value)
  const allSelected = selectableIds.every(id => selectedSet.has(id))
  if (allSelected) {
    selectedOriginalCodeIds.value = selectedOriginalCodeIds.value.filter(id => !selectableIds.includes(id))
    return
  }
  for (const id of selectableIds) {
    selectedSet.add(id)
  }
  selectedOriginalCodeIds.value = Array.from(selectedSet)
}

const handleRecover = async (originalCodeIds: number[]) => {
  const ids = Array.isArray(originalCodeIds) ? [...new Set(originalCodeIds)].filter(Boolean) : []
  if (!ids.length) {
    showWarningToast('请选择要补录的兑换码')
    return
  }

  if (!confirm(`确定要补录选中的 ${ids.length} 条记录吗？`)) {
    return
  }

  recovering.value = true
  try {
    const response = await accountRecoveryAdminService.recover(ids)
    const results = response.results || []
    const counters = results.reduce(
      (acc, item) => {
        const outcome = String(item.outcome || '')
        if (outcome === 'success') acc.success += 1
        else if (outcome === 'already_done') acc.alreadyDone += 1
        else if (outcome === 'failed') acc.failed += 1
        else acc.other += 1
        return acc
      },
      { success: 0, failed: 0, alreadyDone: 0, other: 0 }
    )

    showSuccessToast(
      `补录完成：成功 ${counters.success}，失败 ${counters.failed}，已完成 ${counters.alreadyDone}${counters.other ? `，其他 ${counters.other}` : ''}`
    )

    selectedOriginalCodeIds.value = []
    await loadAccounts()
    await loadRedeems()
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '补录失败')
    if (err.response?.status === 401 || err.response?.status === 403) {
      authService.logout()
      router.push('/login')
    }
  } finally {
    recovering.value = false
  }
}

const openLogs = async (originalCodeId: number) => {
  logsDialogOpen.value = true
  logsOriginalCodeId.value = originalCodeId
  logsLoading.value = true
  logs.value = []
  try {
    const response = await accountRecoveryAdminService.getLogs(originalCodeId)
    logs.value = response.logs || []
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '加载日志失败')
  } finally {
    logsLoading.value = false
  }
}

	const closeLogs = () => {
	  logsDialogOpen.value = false
	  logsOriginalCodeId.value = null
	  logsLoading.value = false
	  logs.value = []
	}

let oneClickPreviewSeq = 0
const fetchOneClickPreview = async () => {
  const source = oneClickSource.value
  if (!source) return

  const seq = ++oneClickPreviewSeq
  oneClickLoading.value = true
  oneClickError.value = ''

  try {
    const response = await accountRecoveryAdminService.oneClickPreview({
      source,
      days: daysNumber.value,
      limit: 200,
    })

    if (seq !== oneClickPreviewSeq) return
    oneClickStats.value = response
  } catch (err: any) {
    if (seq !== oneClickPreviewSeq) return
    const message = err.response?.data?.error || '加载统计失败'
    oneClickStats.value = null
    oneClickError.value = message
    showErrorToast(message)
    if (err.response?.status === 401 || err.response?.status === 403) {
      authService.logout()
      router.push('/login')
    }
  } finally {
    if (seq === oneClickPreviewSeq) {
      oneClickLoading.value = false
    }
  }
}

const openOneClickDialog = async () => {
  oneClickError.value = ''
  oneClickStats.value = null
  oneClickHasProcessed.value = false

  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(ONE_CLICK_SOURCE_STORAGE_KEY)
    if (saved && sourceOptions.some(item => item.value === saved)) {
      oneClickSource.value = saved as AccountRecoverySourceFilter
    } else {
      oneClickSource.value = 'payment'
    }
  } else {
    oneClickSource.value = 'payment'
  }

  oneClickDialogOpen.value = true
  await fetchOneClickPreview()
}

const refreshOneClickPreview = async () => {
  if (oneClickProcessing.value) return
  await fetchOneClickPreview()
}

const runOneClick = async () => {
  if (oneClickProcessing.value) return

  oneClickProcessing.value = true
  try {
    const preview = await accountRecoveryAdminService.oneClickPreview({
      source: oneClickSource.value,
      days: daysNumber.value,
      limit: 200,
    })
    oneClickStats.value = preview

    const ids = Array.isArray(preview.originalCodeIds)
      ? [...new Set(preview.originalCodeIds)]
          .map(value => Number(value))
          .filter(value => Number.isFinite(value) && value > 0)
      : []

    if (!ids.length || !preview.willProcessCount) {
      showWarningToast('当前没有可处理记录')
      return
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem(ONE_CLICK_SOURCE_STORAGE_KEY, oneClickSource.value)
    }

    const response = await accountRecoveryAdminService.recover(ids)
    const results = response.results || []
    const counters = results.reduce(
      (acc, item) => {
        const outcome = String(item.outcome || '')
        if (outcome === 'success') acc.success += 1
        else if (outcome === 'already_done') acc.alreadyDone += 1
        else if (outcome === 'failed') acc.failed += 1
        else acc.other += 1
        return acc
      },
      { success: 0, failed: 0, alreadyDone: 0, other: 0 }
    )

    showSuccessToast(
      `补录完成：成功 ${counters.success}，失败 ${counters.failed}，已完成 ${counters.alreadyDone}${counters.other ? `，其他 ${counters.other}` : ''}`
    )

    oneClickHasProcessed.value = true
    selectedOriginalCodeIds.value = []

    await loadAccounts()
    await loadRedeems()
    await fetchOneClickPreview()
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '补录失败')
    if (err.response?.status === 401 || err.response?.status === 403) {
      authService.logout()
      router.push('/login')
    }
  } finally {
    oneClickProcessing.value = false
  }
}

	const markSelectedAccountsProcessed = async () => {
	  const ids = Array.isArray(processedAccountIds.value)
	    ? [...new Set(processedAccountIds.value)]
	        .map(value => Number(value))
	        .filter(value => Number.isFinite(value) && value > 0)
	    : []

	  if (!ids.length) {
	    showWarningToast(accountSelectionMode.value ? '请选择要标记的封号账号' : '请先选择封号账号')
	    return
	  }

	  const confirmMessage =
	    ids.length === 1 ? '确定要标记该账号已处理吗？' : `确定要标记选中的 ${ids.length} 个账号已处理吗？`
	  if (!confirm(confirmMessage)) {
	    return
	  }

	  markingProcessed.value = true
	  try {
	    if (ids.length === 1) {
	      await accountRecoveryAdminService.setBannedAccountProcessed(ids[0]!, true)
	      showSuccessToast('已标记为已处理')
	    } else {
	      const response = await accountRecoveryAdminService.setBannedAccountsProcessed(ids, true)
	      const updatedCount = Math.max(0, Number(response.updatedCount || 0) || ids.length)
	      const skippedCount = Math.max(0, ids.length - updatedCount)
	      if (skippedCount > 0) {
	        showSuccessToast(`已标记 ${updatedCount} 个账号为已处理，跳过 ${skippedCount} 个`)
	      } else {
	        showSuccessToast(`已标记 ${updatedCount} 个账号为已处理`)
	      }
	    }

	    selectedAccountIds.value = []
	    await loadAccounts()
	  } catch (err: any) {
	    showErrorToast(err.response?.data?.error || '标记失败')
	    if (err.response?.status === 401 || err.response?.status === 403) {
	      authService.logout()
	      router.push('/login')
	    }
	  } finally {
	    markingProcessed.value = false
	  }
	}

const reloadAll = async () => {
  await loadAccounts()
  await loadRedeems()
}
</script>

<template>
	  <div class="space-y-6">
	    <Teleport v-if="teleportReady" to="#header-actions">
		      <div class="flex items-center gap-3 flex-wrap justify-end">
		        <Button
		          variant="outline"
		          class="rounded-xl"
		          :disabled="accountsLoading || redeemsLoading || recovering || markingProcessed || oneClickProcessing"
		          @click="reloadAll"
		        >
		          <RefreshCw class="w-4 h-4 mr-2" />
		          刷新列表
		        </Button>
		        <Button
		          variant="outline"
		          class="rounded-xl"
		          :disabled="accountsLoading || redeemsLoading || recovering || markingProcessed || oneClickProcessing"
		          @click="openOneClickDialog"
		        >
		          <Sparkles class="w-4 h-4 mr-2" />
		          一键处理
		        </Button>
		        <Button
		          variant="outline"
		          class="rounded-xl"
		          :disabled="processedAccountIds.length === 0 || accountsLoading || redeemsLoading || recovering || markingProcessed || oneClickProcessing"
		          @click="markSelectedAccountsProcessed"
		        >
		          <BadgeCheck class="w-4 h-4 mr-2" />
		          标记已处理
		          <span v-if="accountSelectionMode && processedAccountIds.length" class="ml-1">({{ processedAccountIds.length }})</span>
		        </Button>
		        <Button
		          class="rounded-xl bg-blue-600 hover:bg-blue-700 text-white"
		          :disabled="recovering || markingProcessed || oneClickProcessing || selectedOriginalCodeIds.length === 0"
		          @click="handleRecover(selectedOriginalCodeIds)"
		        >
		          <ClipboardList class="w-4 h-4 mr-2" />
		          批量补录 ({{ selectedOriginalCodeIds.length }})
	        </Button>
	      </div>
	    </Teleport>

    <div class="flex flex-col lg:flex-row gap-4 lg:items-center lg:justify-between">
      <div class="flex items-center gap-3">
        <span class="text-sm font-medium text-gray-700">窗口</span>
        <Select v-model="days">
          <SelectTrigger class="h-10 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
            <SelectValue placeholder="选择天数" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="30">近 30 天</SelectItem>
          </SelectContent>
        </Select>
        <span class="text-xs text-gray-500">仅统计已兑换记录</span>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- 左：封号账号 -->
      <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 flex flex-col max-h-[calc(100vh-240px)] overflow-hidden">
        <div class="p-6 border-b border-gray-100">
          <div class="flex items-center justify-between gap-4">
            <div>
              <h3 class="text-lg font-semibold text-gray-900">封号账号</h3>
              <p class="text-xs text-gray-500 mt-1">近 {{ daysNumber }} 天存在影响记录</p>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                class="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-all duration-150 select-none"
                :class="accountSelectionMode
                  ? 'bg-blue-50 border-blue-200 text-blue-600'
                  : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'"
                @click="toggleAccountSelectionMode"
              >
                <svg class="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 3h10v10H3z" stroke-linejoin="round"/>
                  <path d="M5.5 8l1.5 1.5L10.5 6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                {{ accountSelectionMode ? '取消选择' : '选择' }}
                <span
                  v-if="accountSelectionMode && selectedAccountIds.length"
                  class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-500 text-white text-[10px] font-semibold leading-none"
                >{{ selectedAccountIds.length }}</span>
              </button>

              <button
                v-if="accountSelectionMode"
                type="button"
                class="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-all duration-150 select-none"
                :class="allAccountsSelectedCurrentPage
                  ? 'bg-blue-50 border-blue-200 text-blue-600'
                  : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'"
                @click="toggleSelectAllAccountsCurrentPage"
              >
                {{ allAccountsSelectedCurrentPage ? '取消全选' : '全选' }}
              </button>

              <!-- 来源筛选器 -->
              <div
                class="relative flex-shrink-0"
                @mouseenter="sourcePopoverOpen = true"
                @mouseleave="sourcePopoverOpen = false"
              >
                <button
                  type="button"
                  class="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-all duration-150 select-none"
                  :class="selectedSources.length < sourceOptions.length
                    ? 'bg-blue-50 border-blue-200 text-blue-600'
                    : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 hover:border-gray-300'"
                >
                  <svg class="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 4h12M4 8h8M6 12h4" stroke-linecap="round"/>
                  </svg>
                  来源
                  <span
                    v-if="selectedSources.length < sourceOptions.length"
                    class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-500 text-white text-[10px] font-semibold leading-none"
                  >{{ selectedSources.length }}</span>
                  <svg class="w-3 h-3 opacity-50 transition-transform duration-150" :class="sourcePopoverOpen ? 'rotate-180' : ''" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M4 6l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>

                <!-- hover 展开的来源选项浮层 -->
                <Transition
                  enter-active-class="transition-all duration-150 ease-out"
                  enter-from-class="opacity-0 -translate-y-1 scale-95"
                  enter-to-class="opacity-100 translate-y-0 scale-100"
                  leave-active-class="transition-all duration-100 ease-in"
                  leave-from-class="opacity-100 translate-y-0 scale-100"
                  leave-to-class="opacity-0 -translate-y-1 scale-95"
                >
                  <div
                    v-show="sourcePopoverOpen"
                    class="absolute right-0 top-full mt-2 z-50 bg-white border border-gray-100 rounded-2xl shadow-xl shadow-black/[0.08] overflow-hidden min-w-[148px]"
                  >
                    <div class="px-3 pt-3 pb-2">
                      <p class="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">筛选来源</p>
                      <div class="flex flex-col gap-0.5">
                        <label
                          v-for="item in sourceOptions"
                          :key="item.value"
                          class="group/item flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors hover:bg-gray-50 whitespace-nowrap"
                        >
                          <input
                            v-model="selectedSources"
                            type="checkbox"
                            class="w-3.5 h-3.5 rounded border-gray-300 text-blue-500 focus:ring-blue-400 focus:ring-1 focus:ring-offset-0 cursor-pointer"
                            :value="item.value"
                          />
                          <span class="text-xs text-gray-600 group-hover/item:text-gray-900 transition-colors">{{ item.label }}</span>
                        </label>
                      </div>
                    </div>
                    <div class="border-t border-gray-50 px-3 py-2">
                      <button
                        type="button"
                        class="w-full text-[11px] text-gray-400 hover:text-blue-500 transition-colors text-left"
                        @click="selectedSources = selectedSources.length === sourceOptions.length ? [] : sourceOptions.map(o => o.value)"
                      >
                        {{ selectedSources.length === sourceOptions.length ? '取消全选' : '全选' }}
                      </button>
                    </div>
                  </div>
                </Transition>
              </div>
            </div>
          </div>
          <div class="mt-4 flex flex-col sm:flex-row gap-3">
            <div class="relative group w-full">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 h-4 w-4 transition-colors" />
              <Input
                v-model.trim="accountsSearch"
                placeholder="搜索账号邮箱…"
                class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl"
                @keyup.enter="handleAccountsSearch"
              />
            </div>

            <Select v-model="accountsFilter">
              <SelectTrigger class="h-11 w-full sm:w-[160px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
                <SelectValue placeholder="筛选" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部账号</SelectItem>
                <SelectItem value="pending">仍有待处理</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div v-if="accountsError" class="p-4 text-sm text-red-600 border-b border-gray-100">
          {{ accountsError }}
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto">
          <div v-if="accountsLoading" class="flex flex-col items-center justify-center py-16">
            <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
            <p class="text-gray-400 text-sm font-medium mt-4">正在加载…</p>
          </div>

          <div v-else-if="accounts.length === 0" class="p-10 text-center text-sm text-gray-500">
            暂无数据
          </div>

          <div v-else class="divide-y divide-gray-50">
            <button
              v-for="account in accounts"
              :key="account.id"
              class="w-full text-left p-5 hover:bg-blue-50/30 transition-colors"
              :class="selectedAccountId === account.id ? 'bg-blue-50/40' : ''"
              @click="selectAccount(account)"
            >
              <div class="flex items-start justify-between gap-4">
                <div class="flex items-start gap-3 min-w-0">
                  <input
                    v-if="accountSelectionMode"
                    type="checkbox"
                    class="mt-0.5 w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-400 focus:ring-1 focus:ring-offset-0 cursor-pointer flex-shrink-0"
                    :checked="selectedAccountIds.includes(account.id)"
                    @click.stop
                    @change.stop="toggleAccountSelected(account.id)"
                  />
                  <div class="min-w-0">
                    <div class="text-sm font-semibold text-gray-900 truncate">{{ account.email }}</div>
                    <div class="mt-2 flex flex-wrap gap-2 text-xs text-gray-500">
                      <span>影响 {{ account.impactedCount }}</span>
                      <span class="text-amber-700">待 {{ account.pendingCount }}</span>
                      <span class="text-red-600">失败 {{ account.failedCount }}</span>
                      <span class="text-green-700">完成 {{ account.doneCount }}</span>
                    </div>
                  </div>
                </div>
                <div class="text-xs text-gray-400 whitespace-nowrap">
                  {{ formatShanghaiDate(account.latestRedeemedAt, dateFormatOptions) }}
                </div>
              </div>
            </button>
          </div>
        </div>

        <div class="p-4 border-t border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <Button
            variant="ghost"
            class="rounded-xl"
            :disabled="accountsPagination.page <= 1"
            @click="goToAccountsPage(accountsPagination.page - 1)"
          >
            <ChevronLeft class="w-4 h-4 mr-1" />
            上一页
          </Button>

          <div class="flex items-center gap-3 flex-wrap justify-center">
            <div class="flex items-center gap-2">
              <span class="text-xs text-gray-500">每页</span>
              <Select v-model="accountsPageSize" :disabled="accountsLoading">
                <SelectTrigger class="h-8 w-[90px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
                  <SelectValue placeholder="条数" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="8">8</SelectItem>
                  <SelectItem value="20">20</SelectItem>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="text-xs text-gray-500 whitespace-nowrap">
              第 {{ accountsPagination.page }} / {{ accountsTotalPages }} 页 · {{ accountsPagination.total }} 条
            </div>
          </div>

          <Button
            variant="ghost"
            class="rounded-xl"
            :disabled="accountsPagination.page >= accountsTotalPages"
            @click="goToAccountsPage(accountsPagination.page + 1)"
          >
            下一页
            <ChevronRight class="w-4 h-4 ml-1" />
          </Button>
        </div>
      </div>

      <!-- 右：影响兑换码 -->
      <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden lg:col-span-2">
        <div class="p-6 border-b border-gray-100">
          <div class="flex flex-col lg:flex-row gap-4 lg:items-center lg:justify-between">
            <div>
              <h3 class="text-lg font-semibold text-gray-900">影响兑换码</h3>
              <p class="text-xs text-gray-500 mt-1">
                {{ selectedAccountEmail ? `当前：${selectedAccountEmail}` : '请选择左侧封号账号' }}
              </p>
            </div>

            <div class="flex flex-col sm:flex-row gap-3 w-full lg:w-auto">
              <div class="relative group w-full sm:w-64">
                <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 h-4 w-4 transition-colors" />
                <Input
                  v-model.trim="redeemsSearch"
                  placeholder="搜索兑换码 / 用户邮箱…"
                  class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl"
                  @keyup.enter="handleRedeemsSearch"
                />
              </div>

              <Select v-model="redeemsStatus">
                <SelectTrigger class="h-11 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
                  <SelectValue placeholder="状态" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">待补录</SelectItem>
                  <SelectItem value="failed">失败</SelectItem>
                  <SelectItem value="done">已完成</SelectItem>
                  <SelectItem value="all">全部</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div v-if="redeemsError" class="p-4 text-sm text-red-600 border-b border-gray-100">
          {{ redeemsError }}
        </div>

        <div v-if="!selectedAccountId" class="p-10 text-center text-sm text-gray-500">
          请选择左侧封号账号查看详情
        </div>

        <div v-else-if="redeemsLoading" class="flex flex-col items-center justify-center py-16">
          <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
          <p class="text-gray-400 text-sm font-medium mt-4">正在加载…</p>
        </div>

        <div v-else-if="redeems.length === 0" class="p-10 text-center text-sm text-gray-500">
          暂无数据
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider w-10">
                  <input
                    type="checkbox"
                    class="rounded border-gray-300"
                    :checked="redeems.filter(isSelectableRedeem).length > 0 && redeems.filter(isSelectableRedeem).every(item => selectedOriginalCodeIds.includes(item.originalCodeId))"
                    @change="toggleSelectAllCurrentPage"
                  />
                </th>
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">兑换码</th>
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">来源</th>
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">渠道</th>
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">用户邮箱</th>
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">兑换时间</th>
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                <th class="px-4 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">尝试</th>
                <th class="px-4 py-4 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr
                v-for="redeem in redeems"
                :key="redeem.originalCodeId"
                class="group hover:bg-blue-50/30 transition-colors"
              >
                <td class="px-4 py-4">
                  <input
                    type="checkbox"
                    class="rounded border-gray-300"
                    :disabled="!isSelectableRedeem(redeem)"
                    :checked="selectedOriginalCodeIds.includes(redeem.originalCodeId)"
                    @change="toggleSelect(redeem.originalCodeId)"
                  />
                </td>
                <td class="px-4 py-4 text-sm text-gray-900 font-mono">{{ redeem.code }}</td>
                <td class="px-4 py-4 text-sm text-gray-600">{{ sourceLabel(redeem.source) }}</td>
                <td class="px-4 py-4 text-sm text-gray-600">{{ channelLabel(redeem.channel) }}</td>
                <td class="px-4 py-4 text-sm text-gray-900">{{ redeem.userEmail }}</td>
                <td class="px-4 py-4 text-sm text-gray-600">
                  {{ formatShanghaiDate(redeem.redeemedAt, dateFormatOptions) }}
                </td>
                <td class="px-4 py-4">
                  <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium" :class="stateClass(redeem.state)">
                    {{ stateLabel(redeem.state) }}
                  </span>
                  <div v-if="redeem.latest?.errorMessage" class="text-xs text-gray-400 mt-1 max-w-[280px] truncate">
                    {{ redeem.latest.errorMessage }}
                  </div>
                </td>
                <td class="px-4 py-4 text-sm text-gray-600">
                  {{ redeem.attempts }}
                </td>
                <td class="px-4 py-4 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      class="rounded-xl"
                      @click="openLogs(redeem.originalCodeId)"
                    >
                      日志
                    </Button>
                    <Button
                      class="rounded-xl bg-blue-600 hover:bg-blue-700 text-white"
                      :disabled="recovering || oneClickProcessing || !isSelectableRedeem(redeem)"
                      @click="handleRecover([redeem.originalCodeId])"
                    >
                      补录
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="p-4 border-t border-gray-100 flex items-center justify-between">
          <Button
            variant="ghost"
            class="rounded-xl"
            :disabled="redeemsPagination.page <= 1"
            @click="goToRedeemsPage(redeemsPagination.page - 1)"
          >
            <ChevronLeft class="w-4 h-4 mr-1" />
            上一页
          </Button>
          <div class="text-xs text-gray-500">
            第 {{ redeemsPagination.page }} / {{ redeemsTotalPages }} 页 · {{ redeemsPagination.total }} 条
          </div>
          <Button
            variant="ghost"
            class="rounded-xl"
            :disabled="redeemsPagination.page >= redeemsTotalPages"
            @click="goToRedeemsPage(redeemsPagination.page + 1)"
          >
            下一页
            <ChevronRight class="w-4 h-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>

    <!-- 一键处理弹窗 -->
    <Dialog v-model:open="oneClickDialogOpen">
      <DialogContent class="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>一键处理补录</DialogTitle>
        </DialogHeader>

        <p class="text-xs text-gray-500 -mt-2">
          按来源统计待处理记录，并使用通用渠道补录码进行批量补录（单次最多 200 条）。
        </p>

        <div class="mt-5 space-y-5">
          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">来源</Label>
            <Select v-model="oneClickSource" :disabled="oneClickProcessing">
              <SelectTrigger class="h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
                <SelectValue placeholder="选择来源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="item in oneClickSourceOptions" :key="item.value" :value="item.value">
                  {{ item.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="flex items-center justify-between">
            <Button
              variant="ghost"
              class="h-8 px-2 rounded-lg text-xs text-blue-600 hover:text-blue-700"
              :disabled="oneClickLoading || oneClickProcessing"
              @click="refreshOneClickPreview"
            >
              <RefreshCw class="w-3.5 h-3.5 mr-1.5" :class="{ 'animate-spin': oneClickLoading }" />
              刷新统计
            </Button>
            <div v-if="oneClickStats?.generatedAt" class="text-[11px] text-gray-400">
              更新于 {{ oneClickStats.generatedAt }}
            </div>
          </div>

          <div v-if="oneClickError" class="p-3 rounded-xl border border-red-100 bg-red-50/50 text-sm text-red-600">
            {{ oneClickError }}
          </div>

          <div v-if="oneClickLoading" class="flex flex-col items-center justify-center py-10">
            <div class="w-8 h-8 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
            <p class="text-gray-400 text-sm font-medium mt-4">正在加载统计…</p>
          </div>

          <div v-else-if="oneClickStats" class="space-y-4">
            <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4">
                <div class="text-xs text-gray-500">需要补录</div>
                <div class="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{{ oneClickStats.needCount }}</div>
                <div class="mt-1 text-xs text-gray-400">
                  包含：待补录 {{ oneClickStats.pendingCount }} + 失败 {{ oneClickStats.failedCount }}
                </div>
              </div>

              <div class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4">
                <div class="text-xs text-gray-500">可用补录码</div>
                <div class="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{{ oneClickStats.availableCount }}</div>
                <div class="mt-1 text-xs text-gray-400">仅统计通用渠道可用库存</div>
              </div>

              <div class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4">
                <div class="text-xs text-gray-500">本次将处理</div>
                <div class="mt-1 text-2xl font-semibold text-gray-900 tabular-nums">{{ oneClickStats.willProcessCount }}</div>
                <div class="mt-1 text-xs text-gray-400">单次最多 200 条</div>
              </div>
            </div>

            <div v-if="oneClickStats.needCount === 0" class="text-sm text-gray-500">
              当前来源暂无需要补录的记录。
            </div>
            <div v-else-if="oneClickStats.availableCount === 0" class="text-sm text-gray-500">
              暂无可用补录码，请先补充通用渠道兑换码库存。
            </div>
            <div
              v-else-if="oneClickStats.availableCount < oneClickStats.needCount"
              class="rounded-xl border border-amber-100 bg-amber-50/60 p-3 text-sm text-amber-700"
            >
              补录码不足，本次仅处理 {{ oneClickStats.willProcessCount }} 条，其余仍保持待补录/失败状态，可补充库存后继续执行。
            </div>
            <div v-else class="text-xs text-gray-400">
              将按兑换时间从早到晚依次处理。
            </div>
          </div>
        </div>

        <DialogFooter class="mt-4">
          <Button
            variant="outline"
            class="rounded-xl"
            :disabled="oneClickProcessing"
            @click="oneClickDialogOpen = false"
          >
            取消
          </Button>
          <Button
            class="rounded-xl bg-blue-600 hover:bg-blue-700 text-white"
            :disabled="oneClickProcessing || oneClickLoading || !oneClickStats || oneClickStats.willProcessCount === 0"
            @click="runOneClick"
          >
            {{ oneClickProcessing ? '处理中...' : oneClickPrimaryLabel }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 日志弹窗 -->
    <Dialog v-model:open="logsDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>补录日志 {{ logsOriginalCodeId ? `#${logsOriginalCodeId}` : '' }}</DialogTitle>
        </DialogHeader>

        <div v-if="logsLoading" class="py-10 text-center text-sm text-gray-500">加载中…</div>
        <div v-else-if="logs.length === 0" class="py-10 text-center text-sm text-gray-500">暂无日志</div>
        <div v-else class="max-h-[60vh] overflow-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">ID</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">补录码</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">补录账号</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">时间</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">错误</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr v-for="item in logs" :key="item.id">
                <td class="px-4 py-3 text-sm text-gray-600">#{{ item.id }}</td>
                <td class="px-4 py-3 text-sm text-gray-900">{{ item.status }}</td>
                <td class="px-4 py-3 text-sm text-gray-900 font-mono">{{ item.recoveryCode || '-' }}</td>
                <td class="px-4 py-3 text-sm text-gray-900">{{ item.recoveryAccountEmail || '-' }}</td>
                <td class="px-4 py-3 text-sm text-gray-600">{{ formatShanghaiDate(item.createdAt, dateFormatOptions) }}</td>
                <td class="px-4 py-3 text-sm text-gray-500 max-w-[260px] truncate">{{ item.errorMessage || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <DialogFooter class="mt-4">
          <Button variant="outline" class="rounded-xl" @click="closeLogs">关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
