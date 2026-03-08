<script setup lang="ts">
import { computed, onMounted, onUnmounted, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { authService, purchaseService, type PurchaseOrder, type PurchaseAdminOrdersParams } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/toast'
import { RefreshCw, Search, RotateCcw, ShoppingCart, CheckCircle2, Clock, Ban, AlertCircle } from 'lucide-vue-next'

const router = useRouter()
const appConfigStore = useAppConfigStore()
const { success: showSuccessToast, error: showErrorToast } = useToast()

const orders = ref<PurchaseOrder[]>([])
const loading = ref(false)
const error = ref('')
const teleportReady = ref(false)

// 分页相关状态（真实后端分页）
const paginationMeta = ref({ page: 1, pageSize: 10, total: 0 })

// 搜索和筛选状态
const searchQuery = ref('')
const appliedSearch = ref('')
const statusFilter = ref<'all' | 'pending_payment' | 'paid' | 'refunded' | 'expired' | 'failed'>('all')
const refundingOrderNo = ref<string | null>(null)

// 计算总页数
const totalPages = computed(() => Math.max(1, Math.ceil(paginationMeta.value.total / paginationMeta.value.pageSize)))

// 构建搜索筛选参数
const buildSearchParams = (): PurchaseAdminOrdersParams => {
  const params: PurchaseAdminOrdersParams = {
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

const dateFormatOptions =computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))

const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)

const stats = computed(() => {
  const total = orders.value.length
  const paid = orders.value.filter(o => o.status === 'paid').length
  const refunded = orders.value.filter(o => o.status === 'refunded').length
  const pending = orders.value.filter(o => o.status === 'pending_payment' || o.status === 'created').length
  return { total, paid, refunded, pending }
})

// 切换页码
const goToPage = (page: number) => {
  if (page < 1 || page > totalPages.value || page === paginationMeta.value.page) return
  paginationMeta.value.page = page
  loadOrders()
}

// 执行搜索
const applySearch = () => {
  const searchTerm = searchQuery.value.trim()
  appliedSearch.value = searchTerm
  paginationMeta.value.page = 1
  loadOrders()
}

// 清空搜索和筛选
const clearSearch = () => {
  searchQuery.value = ''
  appliedSearch.value = ''
  statusFilter.value = 'all'
  paginationMeta.value.page = 1
  loadOrders()
}

// 筛选状态变化
const onStatusFilterChange = (value: string) => {
  const validStatuses = ['all', 'pending_payment', 'paid', 'refunded', 'expired', 'failed'] as const
  if (validStatuses.includes(value as any)) {
    statusFilter.value = value as typeof statusFilter.value
    paginationMeta.value.page = 1
    loadOrders()
  }
}

const statusLabel = (status?: string) => {
  if (status === 'paid') return '已支付'
  if (status === 'refunded') return '已退款'
  if (status === 'expired') return '已过期'
  if (status === 'failed') return '失败'
 if (status === 'pending_payment') return '待支付'
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

const loadOrders = async () => {
  loading.value = true
  error.value = ''
  try {
    const params = buildSearchParams()
    const response = await purchaseService.adminListOrders(params)
    orders.value = response.orders || []
    paginationMeta.value = response.pagination || { page: 1, pageSize: 10, total: 0 }
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    const message = err?.response?.data?.error || '加载订单失败'
    error.value = message
    showErrorToast(message)
  } finally {
    loading.value = false
  }
}

const handleRefund = async (orderNo: string) => {
  if (!confirm(`确定要退款订单 ${orderNo} 吗？`)) return
  
  refundingOrderNo.value = orderNo
  try {
    await purchaseService.adminRefund(orderNo)
    showSuccessToast('已提交退款')
    await loadOrders()
  } catch (err: any) {
    const message = err?.response?.data?.error || '退款失败'
    showErrorToast(message)
  } finally {
    refundingOrderNo.value = null
  }
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }
  await loadOrders()
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
        @click="loadOrders"
      >
        <RefreshCw class="h-4 w-4 mr-2" :class="loading ? 'animate-spin' : ''" />
        刷新列表
      </Button>
    </Teleport>

    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
       <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
          <div class="flex items-center justify-between">
             <span class="text-sm font-medium text-gray-500">总订单</span>
             <div class="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600">
                <ShoppingCart class="w-5 h-5" />
             </div>
          </div>
          <div>
             <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.total }}</span>
             <span class="text-xs text-gray-400 ml-2">笔</span>
          </div>
       </div>

       <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
          <div class="flex items-center justify-between">
             <span class="text-sm font-medium text-gray-500">已支付</span>
             <div class="w-10 h-10 rounded-2xl bg-green-50 flex items-center justify-center text-green-600">
                <CheckCircle2 class="w-5 h-5" />
             </div>
          </div>
          <div>
             <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.paid }}</span>
             <span class="text-xs text-gray-400 ml-2">笔</span>
          </div>
       </div>

       <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
          <div class="flex items-center justify-between">
             <span class="text-sm font-medium text-gray-500">待支付</span>
             <div class="w-10 h-10 rounded-2xl bg-yellow-50 flex items-center justify-center text-yellow-600">
                <Clock class="w-5 h-5" />
             </div>
          </div>
          <div>
             <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.pending }}</span>
             <span class="text-xs text-gray-400 ml-2">笔</span>
          </div>
       </div>

       <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
          <div class="flex items-center justify-between">
             <span class="text-sm font-medium text-gray-500">已退款</span>
             <div class="w-10 h-10 rounded-2xl bg-purple-50 flex items-center justify-center text-purple-600">
                <RotateCcw class="w-5 h-5" />
             </div>
          </div>
          <div>
             <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.refunded }}</span>
             <span class="text-xs text-gray-400 ml-2">笔</span>
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
               placeholder="搜索订单号 / 邮箱 / 金额..."
               class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
            />
         </div>

         <Select :model-value="statusFilter" @update:model-value="onStatusFilterChange">
            <SelectTrigger class="h-11 w-[160px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
               <SelectValue placeholder="筛选状态" />
            </SelectTrigger>
            <SelectContent>
               <SelectItem value="all">全部状态</SelectItem>
               <SelectItem value="pending_payment">待支付</SelectItem>
               <SelectItem value="paid">已支付</SelectItem>
               <SelectItem value="refunded">已退款</SelectItem>
               <SelectItem value="expired">已过期</SelectItem>
               <SelectItem value="failed">失败</SelectItem>
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
         <p class="text-gray-400 text-sm font-medium mt-4">正在加载订单...</p>
       </div>

       <!-- Empty -->
       <div v-else-if="orders.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
         <div class="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
           <ShoppingCart class="w-8 h-8 text-gray-400" />
         </div>
         <h3 class="text-lg font-semibold text-gray-900">未找到订单</h3>
         <p class="text-gray-500 text-sm mt-1">没有符合当前筛选条件的支付订单</p>
       </div>

       <!-- Data -->
       <div v-else class="overflow-x-auto">
          <table class="w-full">
             <thead>
                <tr class="border-b border-gray-100 bg-gray-50/50">
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">订单号</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">用户邮箱</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">商品</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">金额</th>
                   <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">创建时间</th>
                   <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">支付时间</th>
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
                      <div class="flex items-center gap-2">
                         <div class="w-6 h-6 rounded-full bg-gray-100 flex items-center justify-center text-xs text-gray-500 font-bold">
                            {{ item.email ? item.email.charAt(0).toUpperCase() : '?' }}
                         </div>
                         <span class="text-sm text-gray-600">{{ item.email }}</span>
                      </div>
                   </td>
                   <td class="px-6 py-5">
                      <span class="text-sm font-medium text-gray-900">{{ item.productName }}</span>
                   </td>
                   <td class="px-6 py-5">
                      <span class="text-sm font-medium text-gray-900">¥ {{ item.amount }}</span>
                   </td>
                   <td class="px-6 py-5 text-center">
                      <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border" :class="getStatusColor(item.status)">
                         {{ statusLabel(item.status) }}
                      </span>
                   </td>
                   <td class="px-6 py-5 text-sm text-gray-500 whitespace-nowrap">{{ formatDate(item.createdAt) }}</td>
                   <td class="px-6 py-5 text-sm text-gray-500 whitespace-nowrap">{{ formatDate(item.paidAt || null) }}</td>
                   <td class="px-6 py-5 text-right">
                      <Button
                         v-if="item.status === 'paid'"
                         variant="outline"
                         size="sm"
                         class="h-8 text-xs border-gray-200 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition-colors"
                         :disabled="refundingOrderNo === item.orderNo"
                         @click="handleRefund(item.orderNo)"
                      >
                         <RotateCcw class="h-3 w-3 mr-1.5" :class="refundingOrderNo === item.orderNo ? 'animate-spin' : ''" />
          退款
                      </Button>
                      <span v-else class="text-gray-300 text-xs">-</span>
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
