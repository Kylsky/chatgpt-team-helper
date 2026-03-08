<script setup lang="ts">
import { computed, onMounted, onUnmounted, nextTick, ref, watch } from 'vue'
import { waitingRoomService, redemptionCodeService, type WaitingRoomEntry, type RedemptionCode, type WaitingRoomConfig } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { AlertCircle, RefreshCcw, Search, Trash2, Users, Hourglass, UserX, Link } from 'lucide-vue-next'

type WaitingStatusFilter = 'waiting' | 'boarded' | 'left' | 'all'

const entries = ref<WaitingRoomEntry[]>([])
const paginationMeta = ref({ page: 1, pageSize: 15, total: 0 })
const stats = ref({ waiting: 0, boarded: 0, left: 0 })
const config = ref<WaitingRoomConfig | null>(null)
const loading = ref(true)
const teleportReady = ref(false)

// 搜索和筛选状态
const statusFilter = ref<WaitingStatusFilter>('waiting')
const searchValue = ref('')
const appliedSearch = ref('')

const codes = ref<RedemptionCode[]>([])
const codesLoading = ref(false)
const bindDialogOpen = ref(false)
const bindTarget = ref<WaitingRoomEntry | null>(null)
const selectedCodeValue = ref('')
const binding = ref(false)
const clearingId = ref<number | null>(null)
const updatingStatusId = ref<number | null>(null)
const redeemingEntryId = ref<number | null>(null)
const clearingQueue = ref(false)
const resettingCooldownId = ref<number | null>(null)
const { success: showSuccessToast, error: showErrorToast } = useToast()

const statusOptions: { label: string; value: WaitingStatusFilter }[] = [
  { label: '等待中', value: 'waiting' },
  { label: '已上车', value: 'boarded' },
  { label: '已离队', value: 'left' },
  { label: '全部', value: 'all' }
]

const totalPages = computed(() => Math.max(1, Math.ceil(paginationMeta.value.total / paginationMeta.value.pageSize)))

const availableLinuxDoCodes = computed(() =>
  codes.value.filter(code => code.channel === 'linux-do' && !code.isRedeemed && !code.reservedForEntryId)
)
const selectedBindCodeLabel = computed(() => {
  const codeId = Number(selectedCodeValue.value)
  if (!codeId) return ''
  const matched = availableLinuxDoCodes.value.find(code => code.id === codeId)
  return matched ? matched.code : ''
})

const formatDate = (value?: string | null) => {
  if (!value) return '—'
  return formatShanghaiDate(value)
}

// 构建搜索筛选参数
const buildSearchParams = () => {
  const params: {
    page: number
    pageSize: number
    status: WaitingStatusFilter
    search?: string
  } = {
    page: paginationMeta.value.page,
    pageSize: paginationMeta.value.pageSize,
    status: statusFilter.value,
  }

  // 搜索条件
  const searchTerm = appliedSearch.value.trim()
  if (searchTerm) {
    params.search = searchTerm
  }

  return params
}

const loadEntries = async () => {
  loading.value = true
  try {
    const params = buildSearchParams()
    const response = await waitingRoomService.getAdminEntries(params)
    entries.value = response.entries
    stats.value = response.stats
    config.value = response.config
    paginationMeta.value = response.pagination
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '加载候车室数据失败')
  } finally {
    loading.value = false
  }
}

const loadCodes = async () => {
  codesLoading.value = true
  try {
    codes.value = await redemptionCodeService.getAll()
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '加载兑换码列表失败')
  } finally {
    codesLoading.value = false
  }
}

const refreshAll = async () => {
  await Promise.all([loadEntries(), loadCodes()])
}

// 执行搜索
const applySearch = () => {
  const searchTerm = searchValue.value.trim()
  appliedSearch.value = searchTerm
  paginationMeta.value.page = 1
  loadEntries()
}

// 清空搜索和筛选
const clearSearch = () => {
  searchValue.value = ''
  appliedSearch.value = ''
  statusFilter.value = 'waiting'
  paginationMeta.value.page = 1
  loadEntries()
}

// 切换页码
const goToPage = (page: number) => {
  if (page < 1 || page > totalPages.value || page === paginationMeta.value.page) return
  paginationMeta.value.page = page
  loadEntries()
}

const openBindDialog = (entry: WaitingRoomEntry) => {
  bindTarget.value = entry
  selectedCodeValue.value = ''
  bindDialogOpen.value = true
  loadCodes()
}

const updateEntryInList = (entry: WaitingRoomEntry) => {
  const index = entries.value.findIndex(item => item.id === entry.id)
  if (index !== -1) {
    entries.value.splice(index, 1, entry)
  }
}

const redeemBoundCode = async (entry: WaitingRoomEntry) => {
  if (!entry.reservedCode) return
  redeemingEntryId.value = entry.id
  try {
    const response = await waitingRoomService.redeemEntry(entry.id)
    showSuccessToast(response.message || '兑换成功')
    await Promise.all([loadEntries(), loadCodes()])
  } catch (err: any) {
    showErrorToast(err.response?.data?.message || err.response?.data?.error || '兑换失败，请稍后再试')
  } finally {
    redeemingEntryId.value = null
  }
}

const handleBindConfirm = async () => {
  if (!bindTarget.value) return
  const codeId = Number(selectedCodeValue.value)
  if (!codeId) {
    showErrorToast('请选择可用的兑换码')
    return
  }

  binding.value = true
  try {
    const response = await waitingRoomService.bindCode(bindTarget.value.id, { codeId })
    const updatedEntry = response.entry
    updateEntryInList(updatedEntry)
    showSuccessToast('兑换码已绑定')
    bindDialogOpen.value = false
    await loadCodes()
    if (updatedEntry?.reservedCode && typeof window !== 'undefined') {
      const shouldRedeem = window.confirm(`兑换码 ${updatedEntry.reservedCode} 已绑定到 UID ${updatedEntry.linuxDoUid}，是否立即为该邮箱(${updatedEntry.email})完成兑换？`)
      if (shouldRedeem) {
        await redeemBoundCode(updatedEntry)
      }
    }
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '绑定兑换码失败')
  } finally {
    binding.value = false
  }
}

const handleClearReservation = async (entry: WaitingRoomEntry) => {
  clearingId.value = entry.id
  try {
    const response = await waitingRoomService.clearReservation(entry.id)
    updateEntryInList(response.entry)
    showSuccessToast('已解除绑定')
    await loadCodes()
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '解除绑定失败')
  } finally {
    clearingId.value = null
  }
}

const handleStatusChange = async (entry: WaitingRoomEntry, status: WaitingRoomEntry['status']) => {
  updatingStatusId.value = entry.id
  try {
    const response = await waitingRoomService.updateStatus(entry.id, status)
    updateEntryInList(response.entry)
    showSuccessToast('状态已更新')
    if (status === 'boarded' || status === 'left') {
      await loadCodes()
    }
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '更新状态失败')
  } finally {
    updatingStatusId.value = null
  }
}

const handleResetCooldown = async (entry: WaitingRoomEntry) => {
  if (entry.status !== 'left') return
  resettingCooldownId.value = entry.id
  try {
    const response = await waitingRoomService.resetCooldown(entry.id)
    showSuccessToast(response.message || '冷却期已重置')
    await loadEntries()
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '重置冷却期失败')
  } finally {
    resettingCooldownId.value = null
  }
}

const handleClearQueue = async () => {
  if (clearingQueue.value) return
  const confirmed = typeof window === 'undefined' ? false : window.confirm('确认要清空所有等待中的用户吗？该操作不可撤销。')
  if (!confirmed) return
  clearingQueue.value = true
  try {
    const response = await waitingRoomService.clearQueue()
    showSuccessToast(response.message || '候车队列已清空')
    await refreshAll()
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '清空候车队列失败')
  } finally {
    clearingQueue.value = false
  }
}

const reservationHint = (entry: WaitingRoomEntry) => {
  if (!entry.reservedCode) return '未绑定'
  return `#${entry.reservedCode}`
}
const getEntryQueuePosition = (entry: WaitingRoomEntry) => {
  if (entry.status !== 'waiting') {
    return null
  }
  return entry.queuePosition ?? entry.queuePositionSnapshot ?? null
}

const getStatusColor = (status: string) => {
  switch (status) {
    case 'waiting': return 'bg-blue-100 text-blue-700'
    case 'boarded': return 'bg-green-100 text-green-700'
    case 'left': return 'bg-gray-100 text-gray-500'
    default: return 'bg-gray-100 text-gray-700'
  }
}

watch(statusFilter, () => {
  paginationMeta.value.page = 1
  loadEntries()
})

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  await refreshAll()
})

onUnmounted(() => {
  teleportReady.value = false
})
</script>

<template>
  <div class="space-y-8">
    <!-- Teleport Header Actions -->
    <Teleport v-if="teleportReady" to="#header-actions">
       <div class="flex items-center gap-3 flex-wrap justify-end">
          <Button
            variant="destructive"
            class="h-10 rounded-xl px-4 shadow-sm bg-red-50 text-red-600 hover:bg-red-100 border-none"
            :disabled="clearingQueue || loading"
            @click="handleClearQueue"
          >
            <Trash2 class="mr-2 h-4 w-4" />
            清空队列
          </Button>
          <Button
            variant="outline"
            class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
            :disabled="loading"
            @click="refreshAll"
          >
            <RefreshCcw class="h-4 w-4 mr-2" :class="loading ? 'animate-spin' : ''" />
            刷新列表
          </Button>
       </div>
    </Teleport>

    <!-- Stats Cards -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
       <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
          <div class="flex items-center justify-between">
             <span class="text-sm font-medium text-gray-500">等待中</span>
             <div class="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600">
                <Hourglass class="w-5 h-5" />
             </div>
          </div>
          <div>
             <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.waiting }}</span>
             <span class="text-xs text-gray-400 ml-2">
                 <template v-if="config?.enabled === false">
                  <span class="text-orange-500">已关闭</span>
                </template>
                <template v-else>
                  {{ config?.capacity ? `上限 ${config.capacity} 人` : '不限人数' }}
                </template>
             </span>
          </div>
       </div>

       <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
          <div class="flex items-center justify-between">
             <span class="text-sm font-medium text-gray-500">已上车</span>
             <div class="w-10 h-10 rounded-2xl bg-green-50 flex items-center justify-center text-green-600">
                <Users class="w-5 h-5" />
        </div>
          </div>
          <div>
             <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.boarded }}</span>
             <span class="text-xs text-gray-400 ml-2">冷却期 {{ config?.cooldownDays ?? 0 }} 天</span>
          </div>
       </div>

       <div class="bg-white rounded-3xl p-6 shadow-sm border border-gray-100 flex flex-col gap-4 hover:shadow-md transition-all duration-300">
          <div class="flex items-center justify-between">
             <span class="text-sm font-medium text-gray-500">已离队</span>
             <div class="w-10 h-10 rounded-2xl bg-gray-50 flex items-center justify-center text-gray-400">
                <UserX class="w-5 h-5" />
             </div>
          </div>
          <div>
             <span class="text-3xl font-bold text-gray-900 tracking-tight">{{ stats.left }}</span>
             <span class="text-xs text-gray-400 ml-2">Lv.{{ config?.minTrustLevel ?? 0 }}+</span>
          </div>
       </div>
    </div>

    <!-- Filter Bar -->
    <div class="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div class="flex flex-wrap items-center gap-3 w-full sm:w-auto">
            <div class="relative group w-full sm:w-72">
              <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 group-focus-within:text-blue-500 h-4 w-4 transition-colors" />
              <Input
                v-model="searchValue"
                placeholder="搜索 UID / 用户名 / 邮箱 / 兑换码"
                class="pl-9 h-11 bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] focus:shadow-[0_4px_12px_rgba(0,0,0,0.06)] rounded-xl transition-all"
                @keyup.enter="applySearch"
              />
            </div>
            <Select v-model="statusFilter">
              <SelectTrigger class="h-11 w-[140px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="option in statusOptions"
                  :key="option.value"
                  :value="option.value"
                >
                  {{ option.label }}
             </SelectItem>
              </SelectContent>
            </Select>
            <div class="text-xs text-gray-400 ml-2">
                可用兑换码：{{ availableLinuxDoCodes.length }}
            </div>
        </div>
        
        <div class="flex gap-2" v-if="searchValue">
             <Button variant="secondary" @click="applySearch" class="h-10 rounded-xl px-4">搜索</Button>
             <Button variant="ghost" @click="clearSearch" class="h-10 rounded-xl px-4 text-gray-500">清空</Button>
        </div>
    </div>

    <!-- Table -->
    <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden min-h-[400px]">
        <!-- Loading -->
       <div v-if="loading" class="flex flex-col items-center justify-center py-20">
         <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
         <p class="text-gray-400 text-sm font-medium mt-4">正在加载候车数据...</p>
       </div>

        <!-- Empty -->
       <div v-else-if="!entries.length" class="flex flex-col items-center justify-center py-24 text-center">
         <div class="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center mb-4">
           <AlertCircle class="w-8 h-8 text-gray-400" />
         </div>
         <h3 class="text-lg font-semibold text-gray-900">暂无记录</h3>
         <p class="text-gray-500 text-sm mt-1">没有符合当前筛选条件的数据</p>
       </div>

       <!-- Data -->
       <div v-else>
          <div class="hidden md:block overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider w-[80px]">排队</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Linux DO 用户</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">邮箱</th>
                <th class="px-6 py-5 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">绑定兑换码</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider w-[240px]">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr v-for="entry in entries" :key="entry.id" class="group hover:bg-gray-50/50 transition-colors">
                <td class="px-6 py-5">
                  <div class="text-base font-semibold text-gray-900">
                    {{ getEntryQueuePosition(entry) ?? '—' }}
                  </div>
                  <p class="text-xs text-gray-400">Lv.{{ entry.linuxDoTrustLevel ?? 0 }}</p>
                </td>
                <td class="px-6 py-5">
                  <div class="font-medium text-gray-900">{{ entry.linuxDoUsername || entry.linuxDoName || '—' }}</div>
                  <p class="text-xs text-gray-400 font-mono">UID {{ entry.linuxDoUid }}</p>
      </td>
                <td class="px-6 py-5">
                  <div class="text-sm text-gray-900">{{ entry.email }}</div>
                  <p class="text-xs text-gray-400">加入于 {{ formatDate(entry.createdAt).split(' ')[0] }}</p>
                </td>
                <td class="px-6 py-5 text-center">
                  <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold" :class="getStatusColor(entry.status)">
                    {{ entry.status === 'waiting' ? '等待中' : entry.status === 'boarded' ? '已上车' : '已离队' }}
                  </span>
                </td>
                <td class="px-6 py-5">
                  <div class="font-medium text-gray-900 font-mono">{{ reservationHint(entry) }}</div>
                  <p v-if="entry.reservedAt" class="text-xs text-gray-400">
                    {{ formatDate(entry.reservedAt).split(' ')[0] }}
                  </p>
                </td>
                <td class="px-6 py-5 text-right">
                   <div class="flex justify-end gap-2 flex-wrap">
                    <!-- 绑定/解绑 -->
    <Button
                      v-if="entry.status === 'waiting' && !entry.reservedCodeId"
                      size="sm"
                      variant="outline"
                      class="h-7 text-xs border-blue-200 text-blue-600 hover:bg-blue-50"
                      @click="openBindDialog(entry)"
                    >
                      <Link class="w-3 h-3 mr-1" />绑定
                    </Button>
                    <Button
                      v-if="entry.status === 'waiting' && entry.reservedCodeId"
                      size="sm"
                      variant="outline"
                      class="h-7 text-xs border-red-200 text-red-600 hover:bg-red-50"
                      :disabled="clearingId === entry.id"
                      @click="handleClearReservation(entry)"
                    >
                      {{ clearingId === entry.id ? '解绑中' : '解绑' }}
                    </Button>

                    <!-- 标记上车 -->
                    <Button
                      v-if="entry.status === 'waiting'"
                      size="sm"
                      variant="outline"
                      class="h-7 text-xs border-green-200 text-green-600 hover:bg-green-50"
                      :disabled="updatingStatusId === entry.id || redeemingEntryId === entry.id"
                      @click="handleStatusChange(entry, 'boarded')"
                    >
                      {{ redeemingEntryId === entry.id ? '兑换中' : '上车' }}
                    </Button>

                    <!-- 移出 -->
                     <Button
                      v-if="entry.status === 'waiting'"
                      size="sm"
                      variant="ghost"
                      class="h-7 text-xs text-gray-400 hover:text-gray-600"
                      :disabled="updatingStatusId === entry.id"
                      @click="handleStatusChange(entry, 'left')"
                    >
                      移出
                    </Button>

                    <!-- 重置冷却 -->
                    <Button
                      v-if="entry.status === 'left'"
                      size="sm"
                      variant="outline"
                      class="h-7 text-xs"
                      :disabled="resettingCooldownId === entry.id"
                      @click="handleResetCooldown(entry)"
                    >
                      {{ resettingCooldownId === entry.id ? '重置中' : '重置' }}
                    </Button>

                    <!-- 恢复 -->
                    <Button
                      v-if="entry.status !== 'waiting'"
                      size="sm"
                      variant="ghost"
                      class="h-7 text-xs text-gray-400"
                      :disabled="updatingStatusId === entry.id"
                      @click="handleStatusChange(entry, 'waiting')"
                    >
                      恢复
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Mobile Card List -->
        <div class="md:hidden p-4 space-y-4 bg-gray-50/50">
          <div v-for="entry in entries" :key="entry.id" class="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
             <div class="flex items-start justify-between mb-4">
                <div class="flex items-center gap-2">
                   <div class="px-2 py-1 rounded-lg bg-gray-100 text-gray-900 font-bold text-sm">
                      #{{ getEntryQueuePosition(entry) ?? '-' }}
                   </div>
                   <span class="inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold" :class="getStatusColor(entry.status)">
                      {{ entry.status === 'waiting' ? '等待中' : entry.status === 'boarded' ? '已上车' : '已离队' }}
                   </span>
                </div>
                <div class="text-xs text-gray-400">
                   Lv.{{ entry.linuxDoTrustLevel ?? 0 }}
                </div>
             </div>

             <div class="space-y-3 mb-4">
                <div class="flex flex-col gap-1">
                   <span class="text-xs text-gray-400">Linux DO 用户</span>
                   <div class="flex items-center gap-2">
                      <span class="font-medium text-gray-900">{{ entry.linuxDoUsername || entry.linuxDoName || '—' }}</span>
                      <span class="text-xs text-gray-400 font-mono bg-gray-50 px-1 rounded">UID {{ entry.linuxDoUid }}</span>
                   </div>
                </div>
                <div class="flex flex-col gap-1">
                   <span class="text-xs text-gray-400">邮箱</span>
                   <span class="text-sm text-gray-900 break-all">{{ entry.email }}</span>
                </div>
                <div class="flex flex-col gap-1 bg-gray-50 p-2 rounded-lg">
                   <span class="text-xs text-gray-400">绑定兑换码</span>
                   <div class="flex items-center justify-between">
                      <span class="font-mono text-sm font-medium text-gray-900">{{ reservationHint(entry) }}</span>
                      <span v-if="entry.reservedAt" class="text-xs text-gray-400">{{ formatDate(entry.reservedAt).split(' ')[0] }}</span>
                   </div>
                </div>
             </div>

             <div class="flex flex-wrap gap-2 pt-2 border-t border-gray-50">
                <!-- 绑定/解绑 -->
                <Button
                  v-if="entry.status === 'waiting' && !entry.reservedCodeId"
                  size="sm"
                  variant="outline"
                  class="flex-1 h-8 text-xs border-blue-200 text-blue-600 hover:bg-blue-50"
                  @click="openBindDialog(entry)"
                >
                  <Link class="w-3 h-3 mr-1" />绑定
                </Button>
                <Button
     v-if="entry.status === 'waiting' && entry.reservedCodeId"
                  size="sm"
                  variant="outline"
                  class="flex-1 h-8 text-xs border-red-200 text-red-600 hover:bg-red-50"
                  :disabled="clearingId === entry.id"
                  @click="handleClearReservation(entry)"
                >
                  {{ clearingId === entry.id ? '解绑中' : '解绑' }}
                </Button>

                <!-- 标记上车 -->
                <Button
                  v-if="entry.status === 'waiting'"
                  size="sm"
                  variant="outline"
                  class="flex-1 h-8 text-xs border-green-200 text-green-600 hover:bg-green-50"
                  :disabled="updatingStatusId === entry.id || redeemingEntryId === entry.id"
                  @click="handleStatusChange(entry, 'boarded')"
                >
                  {{ redeemingEntryId === entry.id ? '兑换中' : '上车' }}
                </Button>

                <!-- 移出 -->
                <Button
                  v-if="entry.status === 'waiting'"
                  size="sm"
                  variant="ghost"
                  class="h-8 text-xs text-gray-400 hover:text-gray-600"
 :disabled="updatingStatusId === entry.id"
                  @click="handleStatusChange(entry, 'left')"
                >
                  移出
                </Button>
                
                 <!-- 重置冷却 -->
                <Button
                  v-if="entry.status === 'left'"
                  size="sm"
                  variant="outline"
                  class="flex-1 h-8 text-xs"
                  :disabled="resettingCooldownId === entry.id"
                  @click="handleResetCooldown(entry)"
                >
                  {{ resettingCooldownId === entry.id ? '重置中' : '重置' }}
                </Button>

                <!-- 恢复 -->
                <Button
                  v-if="entry.status !== 'waiting'"
                  size="sm"
                  variant="ghost"
                  class="h-8 text-xs text-gray-400"
                  :disabled="updatingStatusId === entry.id"
                  @click="handleStatusChange(entry, 'waiting')"
                >
                  恢复
                </Button>
             </div>
          </div>
        </div>
       </div>

        <div class="flex items-center justify-between border-t border-gray-100 px-6 py-4 text-sm text-gray-500 bg-gray-50/30">
          <p>
            第 {{ paginationMeta.page }} / {{ totalPages }} 页，共 {{ paginationMeta.total }} 人
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

    <!-- Bind Dialog -->
    <Dialog v-model:open="bindDialogOpen">
      <DialogContent class="sm:max-w-[500px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
        <DialogHeader class="px-8 pt-8 pb-4">
          <DialogTitle class="text-2xl font-bold text-gray-900">绑定兑换码</DialogTitle>
          <DialogDescription class="text-gray-500">
            为 UID <span class="font-mono text-gray-900">{{ bindTarget?.linuxDoUid }}</span> 分配兑换码。
          </DialogDescription>
        </DialogHeader>
        
        <div class="px-8 pb-8 space-y-6">
           <div class="p-4 bg-gray-50 rounded-2xl border border-gray-100 space-y-2">
              <div class="flex justify-between items-center text-sm">
<span class="text-gray-500">目标邮箱</span>
                 <span class="font-medium text-gray-900">{{ bindTarget?.email }}</span>
              </div>
           </div>

           <div class="space-y-2">
             <label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">选择兑换码</label>
             <Select v-model="selectedCodeValue">
                <SelectTrigger class="h-11 bg-white border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500">
                  <SelectValue
                    placeholder="选择可用兑换码"
                    :display-text="selectedBindCodeLabel || undefined"
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="code in availableLinuxDoCodes"
                    :key="code.id"
                    :value="String(code.id)"
                  >
                    <div class="flex w-full items-center gap-3">
                      <span class="font-medium text-gray-900">{{ code.code }}</span>
                      <span class="ml-auto text-right text-xs text-gray-400">{{ code.accountEmail || '未绑定账号' }}</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
               <p class="text-xs text-gray-400">
                当前可用 {{ availableLinuxDoCodes.length }} 枚
              </p>
           </div>
        </div>

        <DialogFooter class="px-8 pb-8 pt-0">
          <Button variant="ghost" @click="bindDialogOpen = false" class="rounded-xl text-gray-500">
            取消
          </Button>
          <Button
            :disabled="binding || !selectedCodeValue"
            @click="handleBindConfirm"
            class="rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-200 hover:bg-blue-700 px-6"
          >
            {{ binding ? '绑定中...' : '确认绑定' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
