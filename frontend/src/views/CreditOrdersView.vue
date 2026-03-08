<script setup lang="ts">
import { computed, onMounted, onUnmounted, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authService, creditService, type CreditAdminBalanceResponse, type CreditAdminOrder, type CreditAdminOrdersParams, type CreditAdminOrdersSummaryResponse } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { RefreshCw, Search, Wallet, CheckCircle2, Clock, RotateCcw, AlertCircle, Coins } from 'lucide-vue-next'

const router = useRouter()
const appConfigStore = useAppConfigStore()
const { success: showSuccessToast, error: showErrorToast } = useToast()

const orders = ref<CreditAdminOrder[]>([])
const balance = ref<CreditAdminBalanceResponse | null>(null)
const ordersSummary = ref<CreditAdminOrdersSummaryResponse | null>(null)
const loading = ref(false)
const error = ref('')
const refundingOrderNo = ref<string | null>(null)
const syncingOrderNo = ref<string | null>(null)
const teleportReady = ref(false)

// 分页相关状态（真实后端分页）
const paginationMeta = ref({ page: 1, pageSize: 10, total: 0 })

// 搜索和筛选状态
const searchQuery = ref('')
const appliedSearch = ref('')
const statusFilter = ref<'all' | 'created' | 'pending_payment' | 'paid' | 'refunded' | 'expired' | 'failed'>('all')

// 计算总页数
const totalPages = computed(() => Math.max(1, Math.ceil(paginationMeta.value.total / paginationMeta.value.pageSize)))

// 构建搜索筛选参数
const buildSearchParams = (): CreditAdminOrdersParams => {
  const params: CreditAdminOrdersParams = {
    page: paginationMeta.value.page,
    pageSize: paginationMeta.value.pageSize,
  }

  // 搜索条件
  const searchTerm = appliedSearch.value.trim()
  if (searchTerm) {
    params.search = searchTerm
  }

  // 状态筛选
  if (statusFilter.value !== 'all') {
    params.status = statusFilter.value
  }

  return params
}

const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))

const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)

const statusLabel = (status?: string) => {
  if (status === 'paid') return '已完成'
  if (status === 'refunded') return '已退回'
  if (status === 'expired') return '已过期'
  if (status === 'failed') return '失败'
  if (status === 'pending_payment') return '待授权'
  if (status === 'created') return '已创建'
  return status || '未知'
}

const getStatusColor = (status?: string) => {
  switch (status) {
    case 'paid': return 'bg-green-100 text-green-700 border-green-200'
    case 'refunded': return 'bg-purple-100 text-purple-700 border-purple-200'
    case 'pending_payment': return 'bg-yellow-100 text-yellow-700 border-yellow-200'
    case 'created': return 'bg-gray-100 text-gray-700 border-gray-200'
    case 'failed': return 'bg-red-100 text-red-700 border-red-200'
    case 'expired': return 'bg-gray-100 text-gray-500 border-gray-200'
    default: return 'bg-gray-100 text-gray-700 border-gray-200'
  }
}

const stats = computed(() => {
  if (statusFilter.value !== 'all') {
    const total = paginationMeta.value.total
    return {
      total,
      paid: statusFilter.value === 'paid' ? total : 0,
      pending: statusFilter.value === 'pending_payment' || statusFilter.value === 'created' ? total : 0,
      refunded: statusFilter.value === 'refunded' ? total : 0
    }
  }

  return {
    total: ordersSummary.value?.total ?? paginationMeta.value.total,
    paid: ordersSummary.value?.paid ?? 0,
    pending: ordersSummary.value?.pending ?? 0,
    refunded: ordersSummary.value?.refunded ?? 0
  }
})

// 切换页码
const goToPage = (page: number) => {
  if (page < 1 || page > totalPages.value || page === paginationMeta.value.page) return
  paginationMeta.value.page = page
  loadOrders()
}

// 执行搜索
const applySearch = async () => {
  const searchTerm = searchQuery.value.trim()
  appliedSearch.value = searchTerm
  paginationMeta.value.page = 1
  await Promise.all([loadOrders(), loadOrdersSummary()])
}

// 清空搜索和筛选
const clearSearch = async () => {
  searchQuery.value = ''
  appliedSearch.value = ''
  statusFilter.value = 'all'
  paginationMeta.value.page = 1
  await Promise.all([loadOrders(), loadOrdersSummary()])
}

// 筛选状态变化
const onStatusFilterChange = async (value: string) => {
  const validStatuses = ['all', 'created', 'pending_payment', 'paid', 'refunded', 'expired', 'failed'] as const
  if (validStatuses.includes(value as any)) {
    statusFilter.value = value as typeof statusFilter.value
    paginationMeta.value.page = 1
    await Promise.all([
      loadOrders(),
      value === 'all' ? loadOrdersSummary() : Promise.resolve()
    ])
  }
}

const canRefund = (order: CreditAdminOrder) => order.status === 'paid' && !order.refundedAt
const canSync = (order: CreditAdminOrder) => !['paid', 'refunded'].includes(order.status)

const applyOrderUpdate = (updated: CreditAdminOrder) => {
  const index = orders.value.findIndex(item => item.orderNo === updated.orderNo)
  if (index === -1) return

  const matchesFilter = statusFilter.value === 'all' || statusFilter.value === updated.status
  if (!matchesFilter) {
    orders.value = orders.value.filter(item => item.orderNo !== updated.orderNo)
    paginationMeta.value = {
      ...paginationMeta.value,
      total: Math.max(0, paginationMeta.value.total - 1)
    }
    return
  }

  orders.value[index] = {
    ...orders.value[index],
    ...updated
  }
  orders.value = [...orders.value]
}

const syncOrderStatus = async (order: CreditAdminOrder) => {
  if (!canSync(order)) return

  syncingOrderNo.value = order.orderNo
  try {
    const resp = await creditService.adminSyncOrder(order.orderNo)
    showSuccessToast(resp.message || '已同步')
    await loadAll()
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    const message = err?.response?.data?.error || err?.message || '同步失败'
    showErrorToast(message)
  } finally {
    syncingOrderNo.value = null
  }
}

const refundOrder = async (order: CreditAdminOrder) => {
  if (!canRefund(order)) return

  refundingOrderNo.value = order.orderNo
  try {
    const resp = await creditService.adminRefundOrder(order.orderNo)
    showSuccessToast(resp.message || '退款成功')

    // 只更新对应条目，避免整表刷新导致滚动/筛选状态抖动
    applyOrderUpdate({
      ...order,
      status: 'refunded',
      refundedAt: new Date().toISOString()
    })
    if (statusFilter.value === 'all' && ordersSummary.value) {
      ordersSummary.value = {
        ...ordersSummary.value,
        paid: Math.max(0, ordersSummary.value.paid - 1),
        refunded: ordersSummary.value.refunded + 1
      }
    }
    await loadBalance()
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    const message = err?.response?.data?.error || err?.message || '退款失败'
    showErrorToast(message)
  } finally {
    refundingOrderNo.value = null
  }
}

const loadOrders = async () => {
  loading.value = true
  error.value = ''
  try {
    const params = buildSearchParams()
    const ordersResp = await creditService.adminListOrders(params)
    orders.value = ordersResp.orders || []
    paginationMeta.value = ordersResp.pagination || { page: 1, pageSize: 10, total: 0 }
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    const message = err?.response?.data?.error || '加载 Credit 订单失败'
    error.value = message
    showErrorToast(message)
  } finally {
    loading.value = false
  }
}

const loadOrdersSummary = async () => {
  try {
    const search = appliedSearch.value.trim()
    ordersSummary.value = await creditService.adminGetOrdersSummary({
      search: search || undefined
    })
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    // Summary is non-blocking; ignore errors.
    ordersSummary.value = null
  }
}

const loadBalance = async () => {
  try {
    balance.value = await creditService.adminGetBalance()
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    showErrorToast('加载余额信息失败')
  }
}

const loadAll = async () => {
  await Promise.all([loadBalance(), loadOrders(), loadOrdersSummary()])
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }
  await loadAll()
})

onUnmounted(() => {
  teleportReady.value = false
})
</script>

<template>
  <div class="space-y-8">
    <!-- Teleport Header Actions -->
    <Teleport v-if="teleportReady" to="#header-actions">
      <Button
        variant="outline"
        class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
        :disabled="loading"
        @click="loadAll"
      >
        <RefreshCw class="h-4 w-4 mr-2" :class="loading ? 'animate-spin' : ''" />
        刷新列表
      </Button>
    </Teleport>

    <!-- Stats Section -->
    <div class="space-y-6">
       <!-- Balance Cards -->
       <div v-if="balance" class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div class="bg-gradient-to-br from-blue-600 to-blue-700 rounded-3xl p-6 shadow-lg shadow-blue-500/20 text-white flex flex-col justify-between h-[120px]">
             <div class="flex items-center gap-2 opacity-90">
                <Wallet class="w-5 h-5" />
                <span class="text-sm font-medium">净入账积分</span>
             </div>
             <div>
                <span class="text-4xl font-bold tracking-tight">{{ balance.netTotal }}</span>
                <span class="text-sm opacity-80 ml-2">Credits</span>
             </div>
          </div>
          <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col justify-between h-[120px]">
             <div class="flex items-center gap-2 text-gray-500">
                <Coins class="w-5 h-5" />
                <span class="text-sm font-medium">总入账</span>
             </div>
             <div>
                <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ balance.paidTotal }}</span>
             </div>
          </div>
          <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col justify-between h-[120px]">
             <div class="flex items-center gap-2 text-gray-500">
                <RotateCcw class="w-5 h-5" />
                <span class="text-sm font-medium">总退回</span>
             </div>
             <div>
                <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ balance.refundedTotal }}</span>
             </div>
          </div>
       </div>

       <!-- Order Stats -->
       <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex items-center justify-between">
             <div>
                <p class="text-xs text-gray-500 mb-1">总订单</p>
                <p class="text-xl font-bold text-gray-900">{{ stats.total }}</p>
             </div>
             <div class="w-8 h-8 rounded-full bg-gray-50 flex items-center justify-center text-gray-400">
                <Wallet class="w-4 h-4" />
             </div>
          </div>
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex items-center justify-between">
             <div>
                <p class="text-xs text-gray-500 mb-1">已完成</p>
                <p class="text-xl font-bold text-gray-900">{{ stats.paid }}</p>
             </div>
             <div class="w-8 h-8 rounded-full bg-green-50 flex items-center justify-center text-green-600">
                <CheckCircle2 class="w-4 h-4" />
             </div>
          </div>
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex items-center justify-between">
             <div>
                <p class="text-xs text-gray-500 mb-1">待授权</p>
                <p class="text-xl font-bold text-gray-900">{{ stats.pending }}</p>
             </div>
             <div class="w-8 h-8 rounded-full bg-yellow-50 flex items-center justify-center text-yellow-600">
                <Clock class="w-4 h-4" />
             </div>
          </div>
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex items-center justify-between">
             <div>
                <p class="text-xs text-gray-500 mb-1">已退回</p>
                <p class="text-xl font-bold text-gray-900">{{ stats.refunded }}</p>
             </div>
             <div class="w-8 h-8 rounded-full bg-purple-50 flex items-center justify-center text-purple-600">
                <RotateCcw class="w-4 h-4" />
             </div>
          </div>
       </div>
    </div>

    <!-- Filter Bar -->
    <div class="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
       <div class="flex flex-wrap items-center gap-3 w-full sm:w-auto">
         <div class="relative group w-full sm:w-72">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 h-4 w-4 transition-colors" />
            <Input
               v-model="searchQuery"
               @keyup.enter="applySearch"
               placeholder="搜索订单 / UID / 目标账号..."
               class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
            />
         </div>

         <Select :model-value="statusFilter" @update:model-value="onStatusFilterChange">
            <SelectTrigger class="h-11 w-[160px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
               <SelectValue placeholder="筛选状态" />
            </SelectTrigger>
            <SelectContent>
               <SelectItem value="all">全部状态</SelectItem>
               <SelectItem value="pending_payment">待授权</SelectItem>
               <SelectItem value="paid">已完成</SelectItem>
               <SelectItem value="failed">失败</SelectItem>
               <SelectItem value="refunded">已退回</SelectItem>
            </SelectContent>
         </Select>
       </div>
       <div class="flex gap-2" v-if="searchQuery">
         <Button variant="secondary" @click="applySearch" class="h-10 rounded-xl px-4">搜索</Button>
         <Button variant="ghost" @click="clearSearch" class="h-10 rounded-xl px-4 text-gray-500">清空</Button>
       </div>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
      <AlertCircle class="h-5 w-5" />
      <span class="font-medium">{{ error }}</span>
    </div>

    <!-- Table -->
    <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden min-h-[400px]">
       <!-- Loading -->
       <div v-if="loading" class="flex flex-col items-center justify-center py-20">
         <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
         <p class="text-gray-400 text-sm font-medium mt-4">正在加载...</p>
       </div>

       <!-- Empty -->
       <div v-else-if="orders.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
         <div class="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
           <Search class="w-8 h-8 text-gray-400" />
         </div>
         <h3 class="text-lg font-semibold text-gray-900">未找到订单</h3>
         <p class="text-gray-500 text-sm mt-1">没有符合当前筛选条件的 Credit 订单</p>
       </div>

       <!-- Data -->
       <div v-else class="overflow-x-auto">
          <table class="w-full">
             <thead>
                <tr class="border-b border-gray-100 bg-gray-50/50">
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">订单号</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">UID</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">积分</th>
                   <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">目标账号</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">创建时间</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">完成时间</th>
                   <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</th>
                </tr>
             </thead>
             <tbody class="divide-y divide-gray-50">
                <tr
                   v-for="item in orders"
                   :key="item.orderNo"
                   class="group hover:bg-gray-50/50 transition-colors duration-200"
                >
                   <td class="px-6 py-5">
                      <span class="font-mono text-sm font-medium text-gray-900">{{ item.orderNo }}</span>
                   </td>
                   <td class="px-6 py-5">
                      <span class="font-mono text-sm text-gray-600 bg-gray-100 px-2 py-1 rounded">{{ item.uid }}</span>
                   </td>
                   <td class="px-6 py-5">
                      <span class="text-sm font-medium text-gray-900">{{ item.amount }}</span>
                   </td>
                   <td class="px-6 py-5 text-center">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border" :class="getStatusColor(item.status)">
                         {{ statusLabel(item.status) }}
                      </span>
                   </td>
                   <td class="px-6 py-5">
                      <span class="text-sm text-gray-600">{{ item.targetAccountId ?? '-' }}</span>
                   </td>
                   <td class="px-6 py-5 text-sm text-gray-500 whitespace-nowrap">{{ formatDate(item.createdAt) }}</td>
                   <td class="px-6 py-5 text-sm text-gray-500 whitespace-nowrap">{{ formatDate(item.paidAt || null) }}</td>
                   <td class="px-6 py-5 text-right">
                      <div class="flex items-center justify-end gap-2">
                        <Button
                          v-if="canSync(item)"
                          variant="outline"
                          size="sm"
                          class="h-8 text-xs border-gray-200 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 transition-colors"
                          :disabled="syncingOrderNo === item.orderNo"
                          @click="syncOrderStatus(item)"
                        >
                          <RefreshCw class="h-3 w-3 mr-1.5" :class="syncingOrderNo === item.orderNo ? 'animate-spin' : ''" />
                          更新状态
                        </Button>
                      <Button
                         v-if="canRefund(item)"
                         variant="outline"
                         size="sm"
                         class="h-8 text-xs border-gray-200 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition-colors"
                         :disabled="refundingOrderNo === item.orderNo || syncingOrderNo === item.orderNo"
                         @click="refundOrder(item)"
                      >
                   <RotateCcw class="h-3 w-3 mr-1.5" :class="refundingOrderNo === item.orderNo ? 'animate-spin' : ''" />
                         退款
                      </Button>
                      <span v-if="!canRefund(item) && !canSync(item)" class="text-gray-300 text-xs">-</span>
                      </div>
                   </td>
                </tr>
             </tbody>
          </table>
       </div>

       <!-- Footer -->
       <div class="flex items-center justify-between border-t border-gray-100 px-6 py-4 text-sm text-gray-500 bg-gray-50/30">
         <p>
           第 {{ paginationMeta.page }} / {{ totalPages }} 页，共 {{ paginationMeta.total }} 笔订单
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
</template>
