<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, Cookie as CookieIcon, Loader2, PenSquare, RefreshCw, Trash2, ChevronLeft, ChevronRight, Search } from 'lucide-vue-next'
import { authService, redemptionCodeService, xianyuService, type XianyuOrder, type XianyuStats, type XianyuStatus } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useAppConfigStore } from '@/stores/appConfig'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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

const orders = ref<XianyuOrder[]>([])
const stats = ref<XianyuStats>({ total: 0, used: 0, pending: 0, today: 0 })
const status = ref<XianyuStatus | null>(null)
const pageError = ref('')
const teleportReady = ref(false)

const loadingStatus = ref(false)
const loadingOrders = ref(false)
const refreshing = ref(false)

const currentPage = ref(1)
const pageSize = ref(10)

const searchQuery = ref('')
const statusFilter = ref<'all' | 'unused' | 'used'>('all')
const timeFilter = ref<'all' | 'today' | '3d' | '7d'>('all')

const showCookieDialog = ref(false)
const cookieInput = ref('')
const cookieSaving = ref(false)

const showManualSyncDialog = ref(false)
const searchOrderId = ref('')
const manualSyncing = ref(false)

const clearingOrders = ref(false)

const showRedeemDialog = ref(false)
const redeemTargetOrder = ref<XianyuOrder | null>(null)
const redeemEmail = ref('')
const redeemingOrderId = ref<number | null>(null)

const showBindDialog = ref(false)
const bindTargetOrder = ref<XianyuOrder | null>(null)
const bindCode = ref('')
const bindEmail = ref('')
const bindingOrderId = ref<number | null>(null)

const showRestockDialog = ref(false)
const restockMessage = ref('')

const dateFormatOptions = computed(() => ({
  timeZone: appConfigStore.timezone,
  locale: appConfigStore.locale,
}))
const formatDate = (value?: string | null) => formatShanghaiDate(value, dateFormatOptions.value)

const isOrderClosed = (order?: XianyuOrder | null): boolean => String(order?.orderStatus || '').includes('关闭')

const getRedeemStatusLabel = (order: XianyuOrder) => {
  if (order.isUsed) return '已核销'
  if (isOrderClosed(order)) return '已关闭'
  return '待核销'
}

const getRedeemStatusClass = (order: XianyuOrder) => {
  if (order.isUsed) return 'bg-gray-50 text-gray-500 border-gray-200'
  if (isOrderClosed(order)) return 'bg-red-50 text-red-700 border-red-200'
  return 'bg-green-50 text-green-700 border-green-200'
}

const getOrderTimestamp = (order: XianyuOrder): number | null => {
  const candidate = order.orderTime || order.extractedAt || order.createdAt || null
  if (!candidate) return null
  const date = new Date(candidate)
  const timestamp = date.getTime()
  return Number.isNaN(timestamp) ? null : timestamp
}

const filteredOrders = computed(() => {
  const query = searchQuery.value.trim().toLowerCase()

  return orders.value.filter(order => {
    if (statusFilter.value === 'unused' && order.isUsed) return false
    if (statusFilter.value === 'used' && !order.isUsed) return false

    if (timeFilter.value !== 'all') {
      const timestamp = getOrderTimestamp(order)
      if (!timestamp) return false
      const now = Date.now()
      const dayMs = 24 * 60 * 60 * 1000
      if (timeFilter.value === 'today') {
        const todayStart = new Date()
        todayStart.setHours(0, 0, 0, 0)
        if (timestamp < todayStart.getTime()) return false
      } else if (timeFilter.value === '3d') {
        if (timestamp < now - 3 * dayMs) return false
      } else if (timeFilter.value === '7d') {
        if (timestamp < now - 7 * dayMs) return false
      }
    }

    if (!query) return true

    const orderId = String(order.orderId || '').toLowerCase()
    const nickname = String(order.nickname || '').toLowerCase()
    const email = String(order.userEmail || '').toLowerCase()
    const code = String(order.redemptionCode || order.assignedCode || '').toLowerCase()

    return orderId.includes(query) || nickname.includes(query) || email.includes(query) || code.includes(query)
  })
})

const totalPages = computed(() => Math.max(1, Math.ceil(filteredOrders.value.length / pageSize.value)))
const paginatedOrders = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredOrders.value.slice(start, start + pageSize.value)
})

watch([searchQuery, statusFilter, timeFilter, pageSize], () => {
  currentPage.value = 1
})

const goToPage = (page: number) => {
  if (page >= 1 && page <= totalPages.value) {
    currentPage.value = page
  }
}

const resetFilters = () => {
  searchQuery.value = ''
  statusFilter.value = 'all'
  timeFilter.value = 'all'
  currentPage.value = 1
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
    const response = await xianyuService.getStatus()
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
    const response = await xianyuService.getOrders({ limit: 1000, offset: 0 })
    orders.value = response.orders || []
    stats.value = response.stats || stats.value
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
  try {
    await Promise.all([fetchStatus(), fetchOrders()])
  } finally {
    refreshing.value = false
  }
}

const openCookieDialog = () => {
  cookieInput.value = ''
  showCookieDialog.value = true
}

const handleCookieSave = async () => {
  const cookieText = cookieInput.value.trim()
  if (!cookieText) {
    showWarningToast('请粘贴有效的 Cookie')
    return
  }
  cookieSaving.value = true
  try {
    const response = await xianyuService.updateConfig({ cookies: cookieText })
    showSuccessToast(response.message || '配置已更新')
    showCookieDialog.value = false
    await fetchStatus()
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '保存失败'
    showErrorToast(message)
  } finally {
    cookieSaving.value = false
  }
}

const openManualSyncDialog = () => {
  searchOrderId.value = ''
  showManualSyncDialog.value = true
}

const handleManualSync = async () => {
  const value = searchOrderId.value.trim()
  if (!value) {
    showWarningToast('请输入订单号')
    return
  }
  manualSyncing.value = true
  try {
    const response = await xianyuService.syncOrder({ orderId: value })
    showSuccessToast(response.message || '同步任务已完成')
    showManualSyncDialog.value = false
    searchOrderId.value = ''
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
    const response = await xianyuService.clearOrders()
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

const copyOrderId = async (orderId: string) => {
  try {
    await navigator.clipboard.writeText(orderId)
    showSuccessToast(`已复制 ${orderId}`)
  } catch {
    showErrorToast('复制失败，请手动选择')
  }
}

const deletingOrderId = ref<number | null>(null)

const handleDeleteOrder = async (order: XianyuOrder) => {
  if (!order.id) {
    showErrorToast('无法删除该订单')
    return
  }
  const confirmed = window.confirm(`确定要删除订单 ${order.orderId} 吗？`)
  if (!confirmed) return

  deletingOrderId.value = order.id
  try {
    await xianyuService.deleteOrder(order.id)
    showSuccessToast('订单已删除')
    orders.value = orders.value.filter(o => o.id !== order.id)
    const statsResponse = await xianyuService.getStatus()
    stats.value = statsResponse.stats
  } catch (err: any) {
    if (handleAuthError(err)) {
      showErrorToast('登录状态已过期，请重新登录')
      return
    }
    const message = err?.response?.data?.error || '删除失败'
    showErrorToast(message)
  } finally {
    deletingOrderId.value = null
  }
}

const applyUpdatedOrder = (updated: XianyuOrder) => {
  const idx = orders.value.findIndex(o => o.id === updated.id)
  if (idx >= 0) {
    orders.value[idx] = updated
  }
}

const closeRedeemDialog = () => {
  showRedeemDialog.value = false
  redeemTargetOrder.value = null
  redeemEmail.value = ''
}

const openBindDialog = (order: XianyuOrder) => {
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
    const response = await xianyuService.bindOrderCode(bindTargetOrder.value.id, {
      code,
      ...(email ? { email } : {})
    })

    const updatedOrder: XianyuOrder | null | undefined = response?.order
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

const isXianyuCodeOutOfStock = (err: any) => {
  const errorCode = err?.response?.data?.errorCode
  return (
    errorCode === 'xianyu_codes_not_configured' ||
    errorCode === 'xianyu_no_today_codes' ||
    errorCode === 'xianyu_today_codes_exhausted' ||
    errorCode === 'xianyu_codes_unavailable'
  )
}

const openRestockDialog = (message: string) => {
  restockMessage.value = message
  showRestockDialog.value = true
}

const redeemOrder = async (order: XianyuOrder, email: string) => {
  if (!order?.orderId) {
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
    const response = await redemptionCodeService.redeemXianyuOrder({
      email: normalizedEmail,
      orderId: order.orderId,
    })

    const updatedOrder: XianyuOrder | undefined = response?.data?.order
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

    if (isXianyuCodeOutOfStock(err)) {
      closeRedeemDialog()
      openRestockDialog(errorText)
      return
    }

    showErrorToast(errorText)
  } finally {
    redeemingOrderId.value = null
  }
}

const handleRedeemClick = async (order: XianyuOrder) => {
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
  router.push({ name: 'redemption-codes', query: { q: 'xianyu' } })
}

const openRedemptionCode = (code: string) => {
  if (!code) return
  router.push({ name: 'redemption-codes', query: { q: code } })
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  await refreshAll()
})

onUnmounted(() => {
  teleportReady.value = false
})
</script>

<template>
  <div class="space-y-8">
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
        <Button class="bg-black hover:bg-gray-800 text-white h-10 shadow-lg shadow-black/10" :disabled="manualSyncing" @click="openManualSyncDialog">
          <PenSquare class="w-4 h-4 mr-2" />
          {{ manualSyncing ? '同步中...' : '同步订单' }}
        </Button>
      </div>
    </Teleport>

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

        <select v-model="statusFilter" class="h-11 px-3 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl text-sm text-gray-700">
          <option value="all">全部状态</option>
          <option value="unused">仅未使用</option>
          <option value="used">仅已使用</option>
        </select>

        <select v-model="timeFilter" class="h-11 px-3 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl text-sm text-gray-700">
          <option value="all">全部时间</option>
          <option value="today">今日</option>
          <option value="3d">近3日</option>
          <option value="7d">近7日</option>
        </select>
      </div>

      <div v-if="status?.lastSuccessAt" class="text-xs text-gray-400 font-medium px-2">
        上次同步：{{ formatDate(status?.lastSuccessAt) }}
      </div>
    </div>

    <div v-if="pageError" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-center gap-3 text-red-600 animate-in slide-in-from-top-2">
      <AlertTriangle class="h-5 w-5" />
      <span class="font-medium">{{ pageError }}</span>
    </div>

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
                :key="order.id || order.orderId"
                class="group hover:bg-blue-50/30 transition-colors duration-200"
              >
                <td class="px-6 py-5">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-sm font-medium text-gray-900 group-hover:text-blue-600 transition-colors cursor-pointer" @click="copyOrderId(order.orderId)">{{ order.orderId }}</span>
                  </div>
                </td>
                <td class="px-6 py-5">
                  <div class="flex flex-col">
                    <span class="text-sm font-medium text-gray-900">{{ order.nickname || '未知用户' }}</span>
                    <span class="text-xs text-gray-400 mt-0.5">{{ order.redemptionChannel === 'xianyu' ? '闲鱼' : order.redemptionChannel || '-' }}</span>
                  </div>
                </td>
                <td class="px-6 py-5 text-center">
                  <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold border" :class="getRedeemStatusClass(order)">
                    {{ getRedeemStatusLabel(order) }}
                  </span>
                </td>
                <td class="px-6 py-5">
                  <button
                    v-if="order.redemptionCode || order.assignedCode"
                    type="button"
                    class="font-mono text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded inline-flex items-center hover:bg-gray-200 hover:text-blue-600 transition-colors"
                    :title="'在兑换码管理中查看：' + (order.redemptionCode || order.assignedCode)"
                    @click="openRedemptionCode(order.redemptionCode || order.assignedCode || '')"
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
                      :title="order.isUsed ? '该订单已核销' : (isOrderClosed(order) ? '订单已关闭，无法核销' : '自动分配今日 xianyu 兑换码并发送邀请')"
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
                    <Button
                      size="icon"
                      variant="ghost"
                      class="h-8 w-8 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
                      :disabled="deletingOrderId === order.id"
                      @click="handleDeleteOrder(order)"
                    >
                      <Loader2 v-if="deletingOrderId === order.id" class="w-4 h-4 animate-spin" />
                      <Trash2 v-else class="w-4 h-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="px-6 py-4 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-4 bg-gray-50/30">
          <div class="text-xs text-gray-500 font-medium flex items-center gap-4">
            <span>共 {{ filteredOrders.length }} 条记录</span>
            <Button
              v-if="filteredOrders.length > 0"
              variant="ghost"
              size="sm"
              class="h-7 text-red-500 hover:text-red-600 hover:bg-red-50 text-xs px-2"
              :disabled="clearingOrders"
              @click="handleClearOrders"
            >
              清空当前列表
            </Button>
          </div>

          <div v-if="totalPages > 1" class="flex items-center gap-1">
            <Button size="icon" variant="outline" class="h-8 w-8 rounded-lg border-gray-200" :disabled="currentPage <= 1" @click="goToPage(currentPage - 1)">
              <ChevronLeft class="h-4 w-4" />
            </Button>
            <span class="text-sm font-medium text-gray-600 px-2">
              {{ currentPage }} / {{ totalPages }}
            </span>
            <Button size="icon" variant="outline" class="h-8 w-8 rounded-lg border-gray-200" :disabled="currentPage >= totalPages" @click="goToPage(currentPage + 1)">
              <ChevronRight class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <Dialog v-model:open="showCookieDialog">
      <DialogContent class="sm:max-w-2xl p-0 bg-white border-none shadow-2xl rounded-3xl overflow-hidden">
        <DialogHeader class="px-8 pt-8 pb-2">
          <DialogTitle class="text-2xl font-bold text-gray-900">配置闲鱼凭证</DialogTitle>
        </DialogHeader>

        <div class="px-8 pb-8 pt-4 space-y-3">
          <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Cookie</Label>
          <textarea
            v-model="cookieInput"
            class="w-full h-[200px] rounded-xl bg-gray-50 border-gray-200 p-4 font-mono text-xs text-gray-800 focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all resize-none"
            placeholder="name=value; ..."
          ></textarea>
          <p class="text-xs text-gray-400">从浏览器开发者工具复制闲鱼（goofish.com）的 Cookie，确保包含 _m_h5_tk。</p>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
          <Button variant="ghost" @click="showCookieDialog = false" class="rounded-xl text-gray-500">取消</Button>
          <Button @click="handleCookieSave" :disabled="cookieSaving" class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6">
            {{ cookieSaving ? '保存中...' : '保存配置' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showManualSyncDialog">
      <DialogContent class="sm:max-w-md p-0 bg-white border-none shadow-2xl rounded-3xl overflow-hidden">
        <div class="p-8 text-center space-y-6">
          <div class="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto text-blue-600">
            <RefreshCw class="w-8 h-8" />
          </div>
          <div>
            <h3 class="text-xl font-bold text-gray-900">同步指定订单</h3>
            <p class="text-gray-500 mt-2 text-sm">将使用已保存的凭证从服务器获取订单详情并入库。</p>
          </div>

          <div class="space-y-2 text-left">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">订单号</Label>
            <Input v-model="searchOrderId" placeholder="请输入数字订单号" class="bg-gray-50 border-gray-200 rounded-xl font-mono text-sm" />
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

    <Dialog v-model:open="showRedeemDialog">
      <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">核销订单</DialogTitle>
        </DialogHeader>

        <div class="px-8 pb-8 space-y-6">
          <div v-if="redeemTargetOrder" class="p-4 bg-gray-50 rounded-2xl border border-gray-100 space-y-2">
            <div class="flex justify-between items-center">
              <span class="text-xs text-gray-500 font-semibold uppercase">Order</span>
              <span class="font-mono font-medium text-gray-900">{{ redeemTargetOrder.orderId }}</span>
            </div>
            <div v-if="redeemTargetOrder.nickname" class="flex justify-between items-center">
              <span class="text-xs text-gray-500 font-semibold uppercase">User</span>
              <span class="font-medium text-gray-900 truncate max-w-[320px]">{{ redeemTargetOrder.nickname }}</span>
            </div>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">受邀邮箱</Label>
            <Input v-model="redeemEmail" type="email" placeholder="name@example.com" class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500" />
            <p class="text-xs text-gray-400">将自动分配今日闲鱼渠道兑换码，并向该邮箱发送 ChatGPT 成员邀请。</p>
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
              <span class="font-mono font-medium text-gray-900">{{ bindTargetOrder.orderId }}</span>
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

    <Dialog v-model:open="showRestockDialog">
      <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">需要补货</DialogTitle>
        </DialogHeader>

        <div class="px-8 pb-8 space-y-4">
          <div class="p-4 bg-orange-50 rounded-2xl border border-orange-100 text-orange-700 text-sm leading-relaxed">
            {{ restockMessage }}
          </div>
          <p class="text-xs text-gray-400">请在「兑换码管理」中创建/导入今日闲鱼渠道（xianyu）的兑换码后，再回来重试核销。</p>
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
