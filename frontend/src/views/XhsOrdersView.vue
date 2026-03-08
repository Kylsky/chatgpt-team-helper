<script setup lang="ts">
import { computed, onMounted, onUnmounted, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, Cookie as CookieIcon, Loader2, PenSquare, RefreshCw, Timer, Trash2, ChevronLeft, ChevronRight, Search, X } from 'lucide-vue-next'
import { authService, redemptionCodeService, xhsService, type XhsOrder, type XhsStats, type XhsStatus } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
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
import { useToast } from '@/components/ui/toast'
import { isEmail } from '@/lib/validation'

const router = useRouter()
const { success: showSuccessToast, error: showErrorToast, warning: showWarningToast, info: showInfoToast } = useToast()
const appConfigStore = useAppConfigStore()

const orders = ref<XhsOrder[]>([])
const stats = ref<XhsStats>({ total: 0, used: 0, pending: 0, today: 0 })
const status = ref<XhsStatus | null>(null)
const pageError = ref('')
const teleportReady = ref(false)

const loadingStatus = ref(false)
const loadingOrders = ref(false)
const refreshing = ref(false)

// 分页相关状态
const currentPage = ref(1)
const pageSize = ref(10)

// 搜索和筛选状态
const searchQuery = ref('')
const statusFilter = ref<'all' | 'unused' | 'used'>('all')
const timeFilter = ref<'all' | 'today' | '3d' | '7d'>('all')

const showCookieDialog = ref(false)
const configMode = ref<'curl' | 'manual'>('curl')
const curlCommandInput = ref('')
const cookieInput = ref('')
const authorizationInput = ref('')
const cookieSaving = ref(false)

const showScheduleDialog = ref(false)
const scheduleForm = ref({
  syncEnabled: false,
  syncIntervalHours: 6,
  timeFilter: 'all' as const
})
const scheduleSaving = ref(false)

const showManualSyncDialog = ref(false)
const searchOrderNumber = ref('')
const manualSyncing = ref(false)

const clearingOrders = ref(false)

const statusFilterOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'unused', label: '仅未使用' },
  { value: 'used', label: '仅已使用' },
] as const

const timeFilterOptions = [
  { value: 'all', label: '全部时间' },
  { value: 'today', label: '今日' },
  { value: '3d', label: '近3日' },
  {value: '7d', label: '近7日' },
] as const

const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))

const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)

const isSyncing = computed(() => status.value?.isSyncing ?? false)

const isOrderClosed = (order?: XhsOrder | null): boolean => String(order?.orderStatus || '').trim() === '已关闭'

const getRedeemStatusLabel = (order: XhsOrder) => {
  if (order.isUsed) return '已核销'
  if (isOrderClosed(order)) return '已关闭'
  return '待核销'
}

const getRedeemStatusClass = (order: XhsOrder) => {
  if (order.isUsed) return 'bg-gray-50 text-gray-500 border-gray-200'
  if (isOrderClosed(order)) return 'bg-red-50 text-red-700 border-red-200'
  return 'bg-green-50 text-green-700 border-green-200'
}

const getOrderTimestamp = (order: XhsOrder): number | null => {
  const candidate = order.orderTime || order.extractedAt || order.createdAt || null
  if (!candidate) return null
  const date = new Date(candidate)
  const timestamp = date.getTime()
  return Number.isNaN(timestamp) ? null : timestamp
}

// 搜索过滤和状态筛选
const filteredOrders = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()

  return orders.value.filter(order => {
    // 状态筛选
    if (statusFilter.value === 'unused' && order.isUsed) return false
    if (statusFilter.value === 'used' && !order.isUsed) return false

    // 时间筛选
    if (timeFilter.value !== 'all') {
      const timestamp = getOrderTimestamp(order)
      if (!timestamp) return false

      if (timeFilter.value === 'today') {
        const start = new Date()
        start.setHours(0, 0, 0, 0)
        if (timestamp < start.getTime()) return false
      } else {
        const days = timeFilter.value === '3d' ? 3 : 7
        const threshold = Date.now() - days * 24 * 60 * 60 * 1000
        if (timestamp < threshold) return false
      }
    }

    // 搜索过滤
    if (!query) return true

    const searchableFields = [
      order.orderNumber,
      order.userEmail,
      order.nickname,
      order.orderStatus,
      order.redemptionCode,
      order.assignedCode,
      order.status,
    ]
      .filter(Boolean)
      .map(value => String(value).toLowerCase())
      .join(' ')

    return searchableFields.includes(query)
  })
})

// 计算总页数
const totalPages = computed(() => Math.max(1, Math.ceil(filteredOrders.value.length / pageSize.value)))

// 计算当前页显示的数据
const paginatedOrders = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  const end = start + pageSize.value
  return filteredOrders.value.slice(start, end)
})

// 切换页码
const goToPage = (page: number) => {
  if (page >= 1 && page <= totalPages.value) {
    currentPage.value = page
  }
}

const openRedemptionCode = (code?: string | null) => {
  const normalized = String(code ?? '').trim()
  if (!normalized) return
  router.push({ name: 'redemption-codes', query: { q: normalized } })
}

const showRedeemDialog = ref(false)
const redeemTargetOrder = ref<XhsOrder | null>(null)
const redeemEmail = ref('')
const redeemingOrderId = ref<number | null>(null)

const showBindDialog = ref(false)
const bindTargetOrder = ref<XhsOrder | null>(null)
const bindCode = ref('')
const bindEmail = ref('')
const bindingOrderId = ref<number | null>(null)

const showRestockDialog = ref(false)
const restockMessage = ref('今日小红书渠道兑换码不足，请先补货后再核销。')

const openRestockDialog = (message?: string) => {
  restockMessage.value = message && message.trim()
    ? message.trim()
    : '今日小红书渠道兑换码不足，请先补货后再核销。'
  showRestockDialog.value = true
}

const closeRedeemDialog = () => {
  showRedeemDialog.value = false
  redeemTargetOrder.value = null
  redeemEmail.value = ''
}

const openBindDialog = (order: XhsOrder) => {
  bindTargetOrder.value = order
  bindCode.value = String(order.redemptionCode || order.assignedCode || '').trim()
  bindEmail.value = String(order.userEmail || '').trim()
  showBindDialog.value = true
}

const closeBindDialog = () => {
  showBindDialog.value = false
  bindTargetOrder.value = null
  bindCode.value = ''
  bindEmail.value = ''
  bindingOrderId.value = null
}

const handleBindCode = async () => {
  if (!bindTargetOrder.value) {
    showErrorToast('未选择订单')
    return
  }

  const code = bindCode.value.trim().toUpperCase()
  if (!code) {
    showWarningToast('请输入兑换码')
    return
  }

  const email = bindEmail.value.trim()
  if (email && !isEmail(email)) {
    showWarningToast('邮箱格式不正确')
    return
  }

  bindingOrderId.value = bindTargetOrder.value.id
  try {
    const response = await xhsService.bindOrderCode(bindTargetOrder.value.id, {
      code,
      ...(email ? { email } : {})
    })

    const updatedOrder: XhsOrder | null | undefined = response?.order
    if (updatedOrder) {
      applyUpdatedOrder(updatedOrder)
    }
    showSuccessToast(response?.message || '绑定成功')
    closeBindDialog()
    await fetchStatus()
  } catch (err: any) {
    const message = err?.response?.data?.error || err?.response?.data?.message || err?.message || '绑定失败，请稍后再试'
    showErrorToast(message)
  } finally {
    bindingOrderId.value = null
  }
}

const isXhsCodeOutOfStock = (err: any) => {
  const status = err?.response?.status
  const errorCode = err?.response?.data?.errorCode
  if (errorCode === 'xhs_codes_not_configured') return true
  if (errorCode === 'xhs_no_today_codes') return true
  if (errorCode === 'xhs_today_codes_exhausted') return true
  if (errorCode === 'xhs_codes_unavailable') return true

  const raw =
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    err?.message ||
    ''
  const message = typeof raw === 'string' ? raw : ''
  return status === 503 && message.includes('小红书') && message.includes('兑换码') && message.includes('今日')
}

const applyUpdatedOrder = (updated: XhsOrder) => {
  const index = orders.value.findIndex(item => item.id === updated.id)
  if (index === -1) return
  const prev = orders.value[index]
  const wasUsed = Boolean(prev?.isUsed)
  orders.value[index] = { ...prev, ...updated }
  orders.value = [...orders.value]

  if (!wasUsed && updated.isUsed) {
    stats.value = {
      ...stats.value,
      used: (stats.value.used || 0) + 1,
      pending: Math.max(0, (stats.value.pending || 0) - 1),
    }
  }
}

const redeemOrder = async (order: XhsOrder, email: string) => {
  if (!order?.orderNumber) {
    showErrorToast('订单号缺失，无法核销')
    return
  }

  const normalizedEmail = email.trim()
  if (!normalizedEmail) {
    showWarningToast('请输入邮箱地址')
    return
  }

  if (!isEmail(normalizedEmail)) {
    showWarningToast('邮箱格式不正确')
    return
  }

  redeemingOrderId.value = order.id
  try {
    const response = await redemptionCodeService.redeemXhsOrder({
      email: normalizedEmail,
      orderNumber: order.orderNumber,
    })

    const updatedOrder: XhsOrder | undefined = response?.data?.order
    const resultData = response?.data?.data
    const message = resultData?.message || response?.data?.message || '核销成功'

    if (updatedOrder) {
      applyUpdatedOrder(updatedOrder)
    }

    showSuccessToast(message)
    closeRedeemDialog()
    await fetchStatus()
  } catch (err: any) {
    const errorText = err?.response?.data?.error || err?.response?.data?.message || err?.message || '核销失败，请稍后再试'

    if (isXhsCodeOutOfStock(err)) {
      closeRedeemDialog()
      openRestockDialog(errorText)
      return
    }

    showErrorToast(errorText)
  } finally {
    redeemingOrderId.value = null
  }
}

const handleRedeemClick = async (order: XhsOrder) => {
  if (order.isUsed) {
    showInfoToast('该订单已核销')
    return
  }

  if (isOrderClosed(order)) {
    showWarningToast('该订单已关闭，无法核销')
    return
  }

  const existingEmail = String(order.userEmail || '').trim()
  if (existingEmail && isEmail(existingEmail)) {
    await redeemOrder(order, existingEmail)
    return
  }

  redeemTargetOrder.value = order
  redeemEmail.value = existingEmail
  showRedeemDialog.value = true
}

const goRestock = () => {
  showRestockDialog.value = false
  router.push({ name: 'redemption-codes', query: { q: 'xhs' } })
}

const handleAuthError = (err: any) => {
  if (err?.response?.status === 401 || err?.response?.status === 403) {
    authService.logout()
    router.push('/login')
    return true
  }
  return false
}

const fetchStatus = async () => {
  loadingStatus.value = true
  try {
    const response = await xhsService.getStatus()
    status.value = response.status
    stats.value = response.stats
    pageError.value = ''
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '加载同步状态失败'
    pageError.value = message
    showErrorToast(message)
  } finally {
    loadingStatus.value = false
  }
}

const fetchOrders = async () => {
  loadingOrders.value = true
  try {
    // 一次性加载所有订单数据
    const response = await xhsService.getOrders({ limit: 1000, offset: 0 })
    stats.value = response.stats
    const incoming = response.orders || []
    // 按时间倒序排列
    orders.value = incoming.sort((a, b) => (getOrderTimestamp(b) ?? 0) - (getOrderTimestamp(a) ?? 0))
    pageError.value = ''
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '加载订单失败'
    pageError.value = message
    showErrorToast(message)
  } finally {
    loadingOrders.value = false
  }
}

const refreshAll = async () => {
  refreshing.value = true
  currentPage.value = 1
  await Promise.all([fetchStatus(), fetchOrders()])
  refreshing.value = false
}

const openCookieDialog = () => {
  configMode.value = 'curl'
  curlCommandInput.value = ''
  cookieInput.value = ''
  authorizationInput.value = ''
  showCookieDialog.value = true
}

const handleCookieSave = async () => {
  if (configMode.value === 'curl') {
    if (!curlCommandInput.value.trim()) {
      showWarningToast('请粘贴 curl 命令')
      return
    }
    cookieSaving.value = true
    try {
      const response = await xhsService.updateConfig({ curlCommand: curlCommandInput.value.trim() })
      showSuccessToast(response.message || '配置已保存')
      showCookieDialog.value = false
      curlCommandInput.value = ''
      await fetchStatus()
    } catch (err: any) {
      if (handleAuthError(err)) {
        showErrorToast('登录状态已过期，请重新登录')
        return
      }
      const message = err?.response?.data?.error || '保存配置失败'
      showErrorToast(message)
    } finally {
      cookieSaving.value = false
    }
  } else {
    const hasCookie = cookieInput.value.trim()
    const hasAuth = authorizationInput.value.trim()

    if (!hasCookie && !hasAuth) {
      showWarningToast('请至少填写 Cookie 或 Authorization')
      return
    }

    cookieSaving.value = true
    try {
      const payload: { cookies?: string; authorization?: string } = {}
     if (hasCookie) {
        payload.cookies = cookieInput.value.trim()
      }
      if (hasAuth) {
        payload.authorization = authorizationInput.value.trim()
      }
      await xhsService.updateConfig(payload)
      showSuccessToast('配置已保存')
      showCookieDialog.value = false
      cookieInput.value = ''
      authorizationInput.value = ''
      await fetchStatus()
    } catch (err: any) {
      if (handleAuthError(err)) {
        showErrorToast('登录状态已过期，请重新登录')
        return
      }
      const message = err?.response?.data?.error || '保存配置失败'
      showErrorToast(message)
    } finally {
      cookieSaving.value = false
    }
  }
}

const openScheduleDialog = () => {
  scheduleForm.value = {
    syncEnabled: status.value?.syncEnabled ?? false,
    syncIntervalHours: status.value?.syncIntervalHours ?? 6,
    timeFilter: 'all'
  }
  showScheduleDialog.value = true
}

const handleScheduleSave = async () => {
  scheduleSaving.value = true
  const interval = Math.min(Math.max(Number(scheduleForm.value.syncIntervalHours) || 1, 1), 48)
  try {
    await xhsService.updateConfig({
      syncEnabled: Boolean(scheduleForm.value.syncEnabled),
      syncIntervalHours: interval,
    })
    showSuccessToast('定时策略已更新')
    showScheduleDialog.value = false
    await fetchStatus()
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '更新定时策略失败'
    showErrorToast(message)
  } finally {
    scheduleSaving.value = false
  }
}

const openManualSyncDialog = () => {
  searchOrderNumber.value = ''
  showManualSyncDialog.value = true
}

const handleManualSync = async () => {
  manualSyncing.value = true
  try {
    const payload: { searchKeyword?: string } = {}
    if (searchOrderNumber.value.trim()) {
      payload.searchKeyword = searchOrderNumber.value.trim()
    }
    const response = await xhsService.apiSync(payload)
    showSuccessToast(response.message || '同步任务已完成')
    showManualSyncDialog.value = false
    searchOrderNumber.value = ''
    currentPage.value = 1
    await Promise.all([fetchStatus(), fetchOrders()])
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '同步失败'
    showErrorToast(message)
  } finally {
    manualSyncing.value = false
  }
}

const handleClearOrders = async () => {
  if (!orders.value.length) {
    showInfoToast('没有可删除的订单')
    return
  }
  const confirmed = window.confirm('确定要删除已加载的全部订单记录吗？该操作不可恢复。')
  if (!confirmed) return
  clearingOrders.value = true
  try {
    const response = await xhsService.clearOrders()
    showSuccessToast(response.message || '订单已清空')
    currentPage.value = 1
    await Promise.all([fetchStatus(), fetchOrders()])
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '清理订单失败'
    showErrorToast(message)
  } finally {
    clearingOrders.value = false
  }
}

const copyOrderNumber = async (orderNumber: string) => {
  try {
    await navigator.clipboard.writeText(orderNumber)
    showSuccessToast(`已复制 ${orderNumber}`)
  } catch (err) {
    showErrorToast('复制失败，请手动选择')
  }
}

const deletingOrderId = ref<number | null>(null)

const handleDeleteOrder = async (order: XhsOrder) => {
  if (!order.id) {
    showErrorToast('无法删除该订单')
    return
  }
  const confirmed = window.confirm(`确定要删除订单 ${order.orderNumber} 吗？`)
  if (!confirmed) return

  deletingOrderId.value = order.id
  try {
    await xhsService.deleteOrder(order.id)
    showSuccessToast('订单已删除')
    orders.value = orders.value.filter(o => o.id !== order.id)
    const statsResponse = await xhsService.getStatus()
    stats.value = statsResponse.stats
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '删除订单失败'
    showErrorToast(message)
  } finally {
    deletingOrderId.value = null
  }
}

// 重置所有筛选条件
const resetFilters = () => {
  searchQuery.value = ''
  statusFilter.value = 'all'
  timeFilter.value = 'all'
  currentPage.value = 1
}

// 当筛选条件变化时重置到第一页
watch([searchQuery, statusFilter, timeFilter], () => {
  currentPage.value = 1
})

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  await appConfigStore.loadConfig()
  await refreshAll()
})

onUnmounted(() => {
  teleportReady.value = false
})
</script>

<template>
  <div class="space-y-8">
    <!-- 顶部操作栏 (Teleport 到 MainLayout 的 header-actions) -->
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-3 flex-wrap justify-end">
        <Button variant="outline" class="h-10 border-gray-200 hover:bg-white hover:text-blue-600" @click="refreshAll" :disabled="refreshing">
          <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': refreshing }" />
          刷新列表
        </Button>
        <div class="hidden sm:block h-6 w-px bg-gray-300"></div>
        <Button variant="outline" class="h-10 border-gray-200 bg-white" @click="openCookieDialog">
          <CookieIcon class="w-4 h-4 mr-2" />
          凭证
        </Button>
        <Button variant="outline" class="h-10 border-gray-200 bg-white" @click="openScheduleDialog">
          <Timer class="w-4 h-4 mr-2" />
          定时
        </Button>
        <Button class="bg-black hover:bg-gray-800 text-white h-10 shadow-lg shadow-black/10" :disabled="manualSyncing || isSyncing" @click="openManualSyncDialog">
          <PenSquare class="w-4 h-4 mr-2" />
          {{ manualSyncing || isSyncing ? '同步中...' : '立即同步' }}
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
              placeholder="搜索订单号 / 邮箱..."
              class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
            />
          </div>
          
          <Select v-model="statusFilter">
            <SelectTrigger class="h-11 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
              <SelectValue placeholder="状态筛选" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in statusFilterOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>

          <Select v-model="timeFilter">
            <SelectTrigger class="h-11 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
              <SelectValue placeholder="时间筛选" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in timeFilterOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
       </div>
       
       <div v-if="status?.lastSuccessAt" class="text-xs text-gray-400 font-medium px-2">
          上次同步：{{ formatDate(status?.lastSuccessAt) }}
       </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="pageError" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
      <AlertTriangle class="h-5 w-5" />
      <span class="font-medium">{{ pageError }}</span>
    </div>

    <!-- 列表区域 -->
    <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden min-h-[400px]">
      <div v-if="loadingOrders && !orders.length" class="flex flex-col items-center justify-center py-20">
        <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
        <p class="text-gray-400 text-sm font-medium mt-4">正在加载订单...</p>
      </div>

      <div v-else-if="filteredOrders.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
        <div class="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
          <Search class="w-8 h-8 text-gray-400" />
        </div>
        <h3 class="text-lg font-semibold text-gray-900">未找到订单</h3>
        <p class="text-gray-500 text-sm mt-1 mb-6">没有符合当前筛选条件的订单记录</p>
        <Button variant="outline" @click="resetFilters" class="rounded-xl border-gray-200">
          重置筛选条件
        </Button>
      </div>

      <div v-else>
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">订单号</th>
             <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">用户</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">兑换码</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">下单时间</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr 
                v-for="order in paginatedOrders" 
                :key="order.id || order.orderNumber"
                class="group hover:bg-blue-50/30 transition-colors duration-200"
              >
                <td class="px-6 py-5">
                   <div class="flex items-center gap-2">
                     <span class="font-mono text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors cursor-pointer" @click="copyOrderNumber(order.orderNumber)">{{ order.orderNumber }}</span>
                   </div>
                </td>
                <td class="px-6 py-5">
                  <div class="flex flex-col">
                    <span class="text-sm font-medium text-gray-900">{{ order.nickname || '未知用户' }}</span>
                    <span class="text-xs text-gray-400 mt-0.5">{{ order.redemptionChannel === 'xhs' ? '小红书' : order.redemptionChannel || '-' }}</span>
                  </div>
                </td>
                <td class="px-6 py-5 text-center">
                  <span 
                    class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border"
                    :class="getRedeemStatusClass(order)"
                  >
                    {{ getRedeemStatusLabel(order) }}
                  </span>
                </td>
                <td class="px-6 py-5">
                  <button
                    v-if="order.redemptionCode || order.assignedCode"
                    type="button"
                    class="font-mono text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded inline-flex items-center hover:bg-gray-200 hover:text-blue-600 transition-colors"
                    :title="'在兑换码管理中查看：' + (order.redemptionCode || order.assignedCode)"
                    @click="openRedemptionCode(order.redemptionCode || order.assignedCode)"
                  >
                    {{ order.redemptionCode || order.assignedCode }}
                  </button>
                  <div v-else class="font-mono text-xs text-gray-400 bg-gray-50 px-2 py-1 rounded inline-block">
                    待分配
                  </div>
                </td>
                <td class="px-6 py-5">
                   <div class="text-sm text-gray-500">{{ order.orderTime ? order.orderTime.split(' ')[0] : '-' }}</div>
                   <div class="text-xs text-gray-400">{{ order.orderTime ? order.orderTime.split(' ')[1] : '' }}</div>
                </td>
                <td class="px-6 py-5 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <Button 
                      size="sm"
                      variant="outline"
                      class="h-8 rounded-lg text-xs border-gray-200"
                      :disabled="order.isUsed || isOrderClosed(order) || redeemingOrderId === order.id"
                      @click="handleRedeemClick(order)"
                      :title="order.isUsed ? '该订单已核销' : (isOrderClosed(order) ? '订单已关闭，无法核销' : '自动分配今日 xhs 兑换码并发送邀请')"
                    >
                      <Loader2 v-if="redeemingOrderId === order.id" class="w-3.5 h-3.5 mr-1 animate-spin" />
                      {{ order.isUsed ? '已核销' : (isOrderClosed(order) ? '已关闭' : '核销') }}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      class="h-8 rounded-lg text-xs border-gray-200"
                      :disabled="order.isUsed || bindingOrderId === order.id"
                      @click="openBindDialog(order)"
                      title="绑定已兑换的兑换码到该订单"
                    >
                      <Loader2 v-if="bindingOrderId === order.id" class="w-3.5 h-3.5 mr-1 animate-spin" />
                      绑定码
                    </Button>
                    <Button size="icon" variant="ghost" class="h-8 w-8 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg" @click="handleDeleteOrder(order)">
                      <Trash2 class="w-4 h-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        
        <!-- 底部栏 -->
        <div class="px-6 py-4 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gray-50/30">
           <div class="text-xs text-gray-500 font-medium flex items-center gap-4">
              <span>共 {{ filteredOrders.length }} 条记录</span>
              <Button 
                v-if="filteredOrders.length > 0" 
                variant="ghost" 
                size="sm" 
                class="h-7 text-red-500 hover:text-red-600 hover:bg-red-50 text-xs px-2"
                @click="handleClearOrders"
              >
                清空当前列表
              </Button>
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

    <!-- 凭证配置弹窗 -->
    <Dialog v-model:open="showCookieDialog">
      <DialogContent class="sm:max-w-2xl p-0 bg-white border-none shadow-2xl rounded-3xl overflow-hidden">
        <DialogHeader class="px-8 pt-8 pb-2">
          <DialogTitle class="text-2xl font-bold text-gray-900">配置小红书凭证</DialogTitle>
        </DialogHeader>
        
        <div class="px-8 pb-8 pt-4">
          <div class="flex p-1 bg-gray-100 rounded-xl mb-6">
            <button
              class="flex-1 py-2 text-sm font-medium rounded-lg transition-all"
   :class="configMode === 'curl' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
              @click="configMode = 'curl'"
            >
              cURL (推荐)
            </button>
            <button
              class="flex-1 py-2 text-sm font-medium rounded-lg transition-all"
              :class="configMode === 'manual' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
              @click="configMode = 'manual'"
            >
              手动输入
            </button>
          </div>

          <div v-if="configMode === 'curl'" class="space-y-3">
             <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">粘贴 curl 命令</Label>
             <textarea
               v-model="curlCommandInput"
               class="w-full h-[200px] rounded-xl bg-gray-50 border-gray-200 p-4 font-mono text-xs text-gray-800 focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all resize-none"
               placeholder="curl 'https://ark.xiaohongshu.com/...' -H 'authorization: ...'"
             ></textarea>
             <p class="text-xs text-gray-400">请从浏览器控制台复制小红书后台请求的 cURL命令。</p>
          </div>

          <div v-else class="space-y-4">
             <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Authorization</Label>
                <Input v-model="authorizationInput" class="bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" placeholder="AT-..." />
             </div>
             <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Cookie</Label>
                <textarea
                   v-model="cookieInput"
                   class="w-full h-[120px] rounded-xl bg-gray-50 border-gray-200 p-4 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all resize-none"
                   placeholder="name=value; ..."
                 ></textarea>
             </div>
          </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
           <Button variant="ghost" @click="showCookieDialog = false" class="rounded-xl text-gray-500">取消</Button>
           <Button @click="handleCookieSave" :disabled="cookieSaving" class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6">
             {{ cookieSaving ? '保存中...' : '保存配置' }}
           </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 定时策略弹窗 -->
    <Dialog v-model:open="showScheduleDialog">
      <DialogContent class="sm:max-w-md p-0 bg-white border-none shadow-2xl rounded-3xl overflow-hidden">
        <DialogHeader class="px-8 pt-8 pb-2">
           <DialogTitle class="text-2xl font-bold text-gray-900">自动同步设置</DialogTitle>
        </DialogHeader>
        
        <div class="px-8 pb-8 pt-4 space-y-6">
           <div class="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <span class="font-medium text-gray-900">启用自动同步</span>
              <input
                type="checkbox"
                v-model="scheduleForm.syncEnabled"
                class="w-6 h-6 rounded-md border-gray-300 text-blue-600 focus:ring-blue-500"
              />
           </div>
           
           <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">同步间隔 (小时)</Label>
              <Input
                v-model="scheduleForm.syncIntervalHours"
                type="number"
                class="bg-white border-gray-200 rounded-xl"
              />
              <p class="text-xs text-gray-400">建议设置为 6 小时以上，避免触发风控。</p>
           </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
           <Button variant="ghost" @click="showScheduleDialog = false" class="rounded-xl text-gray-500">取消</Button>
           <Button @click="handleScheduleSave" :disabled="scheduleSaving" class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6">
             保存
           </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    
    <!-- 立即同步弹窗 -->
    <Dialog v-model:open="showManualSyncDialog">
      <DialogContent class="sm:max-w-md p-0 bg-white border-none shadow-2xl rounded-3xl overflow-hidden">
         <div class="p-8 text-center space-y-6">
            <div class="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto text-blue-600">
               <RefreshCw class="w-8 h-8" />
            </div>
            <div>
               <h3 class="text-xl font-bold text-gray-900">开始同步</h3>
               <p class="text-gray-500 mt-2 text-sm">将使用已保存的凭证从服务器获取最新订单。</p>
            </div>
            
            <div class="space-y-2 text-left">
               <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">指定订单号 (可选)</Label>
               <Input v-model="searchOrderNumber" placeholder="留空则抓取最新列表" class="bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
            </div>

            <div class="flex gap-3 pt-2">
               <Button variant="ghost" @click="showManualSyncDialog = false" class="flex-1 rounded-xl text-gray-500 h-11">取消</Button>
               <Button @click="handleManualSync" :disabled="manualSyncing" class="flex-1 rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 h-11">
                 {{ manualSyncing ? '同步中...' : '确认同步' }}
               </Button>
            </div>
        </div>
      </DialogContent>
    </Dialog>

    <!-- 核销弹窗 -->
    <Dialog v-model:open="showRedeemDialog">
      <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">核销订单</DialogTitle>
        </DialogHeader>

        <div class="px-8 pb-8 space-y-6">
          <div v-if="redeemTargetOrder" class="p-4 bg-gray-50 rounded-2xl border border-gray-100 space-y-2">
            <div class="flex justify-between items-center">
              <span class="text-xs text-gray-500 font-semibold uppercase">Order</span>
              <span class="font-mono font-medium text-gray-900">{{ redeemTargetOrder.orderNumber }}</span>
            </div>
            <div v-if="redeemTargetOrder.nickname" class="flex justify-between items-center">
              <span class="text-xs text-gray-500 font-semibold uppercase">User</span>
              <span class="font-medium text-gray-900 truncate max-w-[320px]">{{ redeemTargetOrder.nickname }}</span>
            </div>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">受邀邮箱</Label>
            <Input
              v-model="redeemEmail"
              type="email"
              placeholder="name@example.com"
              class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            />
            <p class="text-xs text-gray-400">将自动分配今日小红书渠道兑换码，并向该邮箱发送 ChatGPT 成员邀请。</p>
          </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
          <Button variant="ghost" @click="closeRedeemDialog" class="rounded-xl text-gray-500">取消</Button>
	          <Button
	            :disabled="!redeemTargetOrder || isOrderClosed(redeemTargetOrder) || redeemingOrderId === redeemTargetOrder?.id"
	            @click="redeemTargetOrder && redeemOrder(redeemTargetOrder, redeemEmail)"
	            class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6"
	          >
            {{ redeemingOrderId === redeemTargetOrder?.id ? '核销中...' : '确认核销' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 绑定兑换码弹窗 -->
    <Dialog v-model:open="showBindDialog">
      <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">绑定兑换码</DialogTitle>
        </DialogHeader>

        <div class="px-8 pb-8 space-y-6">
          <div v-if="bindTargetOrder" class="p-4 bg-gray-50 rounded-2xl border border-gray-100 space-y-2">
            <div class="flex justify-between items-center">
              <span class="text-xs text-gray-500 font-semibold uppercase">Order</span>
              <span class="font-mono font-medium text-gray-900">{{ bindTargetOrder.orderNumber }}</span>
            </div>
            <div v-if="bindTargetOrder.nickname" class="flex justify-between items-center">
              <span class="text-xs text-gray-500 font-semibold uppercase">User</span>
              <span class="font-medium text-gray-900 truncate max-w-[320px]">{{ bindTargetOrder.nickname }}</span>
            </div>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">兑换码</Label>
            <Input
              v-model="bindCode"
              placeholder="XXXX-XXXX-XXXX"
              class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500 font-mono"
            />
            <p class="text-xs text-gray-400">已在「兑换码管理」完成兑换后，把兑换码粘贴到这里绑定到订单。</p>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">受邀邮箱（可选）</Label>
            <Input
              v-model="bindEmail"
              type="email"
              placeholder="name@example.com"
              class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
            />
            <p class="text-xs text-gray-400">留空则尝试从兑换码的 redeemed_by 解析邮箱。</p>
          </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
          <Button variant="ghost" @click="closeBindDialog" class="rounded-xl text-gray-500">取消</Button>
          <Button
            :disabled="!bindTargetOrder || !bindCode.trim() || bindingOrderId === bindTargetOrder?.id"
            @click="handleBindCode"
            class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6"
          >
            <Loader2 v-if="bindingOrderId === bindTargetOrder?.id" class="w-4 h-4 mr-2 animate-spin" />
            {{ bindingOrderId === bindTargetOrder?.id ? '绑定中...' : '确认绑定' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 补货提醒弹窗 -->
    <Dialog v-model:open="showRestockDialog">
      <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">需要补货</DialogTitle>
        </DialogHeader>

        <div class="px-8 pb-8 space-y-4">
          <div class="p-4 bg-orange-50 rounded-2xl border border-orange-100 text-orange-700 text-sm leading-relaxed">
            {{ restockMessage }}
          </div>
          <p class="text-xs text-gray-400">请在「兑换码管理」中创建/导入今日小红书渠道（xhs）的兑换码后，再回来重试核销。</p>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
          <Button variant="ghost" @click="showRestockDialog = false" class="rounded-xl text-gray-500">关闭</Button>
          <Button @click="goRestock" class="rounded-xl bg-black text-white hover:bg-gray-800 px-6">
            去补货
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
