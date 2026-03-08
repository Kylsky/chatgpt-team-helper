<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { authService, historyExceptionService, type HistoryExceptionItem, type HistoryExceptionStatus } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { useToast } from '@/components/ui/toast'
import { useRouter } from 'vue-router'

const router = useRouter()
const { error: showErrorToast, success: showSuccessToast } = useToast()

const loading = ref(false)
const errorText = ref('')
const items = ref<HistoryExceptionItem[]>([])
const pagination = ref({ page: 1, pageSize: 20, total: 0, totalPages: 1 })

const filters = ref({
  keyword: '',
  exceptionType: '',
  status: 'all' as HistoryExceptionStatus | 'all',
  startTime: '',
  endTime: '',
})

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '待处理', value: 'active' },
  { label: '已解决', value: 'resolved' },
  { label: '已忽略', value: 'ignored' },
]

const currentUser = computed<any>(() => authService.getCurrentUser())
const currentMenus = computed<string[]>(() => {
  const menus = currentUser.value?.menus
  return Array.isArray(menus) ? menus.map(String) : []
})
const isSuperAdmin = computed<boolean>(() => {
  const roles = currentUser.value?.roles
  return Array.isArray(roles) && roles.includes('super_admin')
})

const canUpdate = computed(() => currentMenus.value.includes('history_exception:update') || isSuperAdmin.value)
const canDelete = computed(() => currentMenus.value.includes('history_exception:delete') || isSuperAdmin.value)

const statusLabel = (status: string) => {
  if (status === 'resolved') return '已解决'
  if (status === 'ignored') return '已忽略'
  return '待处理'
}

const statusClass = (status: string) => {
  if (status === 'resolved') return 'bg-green-50 text-green-700 border border-green-100'
  if (status === 'ignored') return 'bg-gray-100 text-gray-700 border border-gray-200'
  return 'bg-amber-50 text-amber-700 border border-amber-100'
}

const loadData = async () => {
  loading.value = true
  errorText.value = ''
  try {
    const response = await historyExceptionService.list({
      page: pagination.value.page,
      pageSize: pagination.value.pageSize,
      keyword: filters.value.keyword.trim() || undefined,
      exceptionType: filters.value.exceptionType.trim() || undefined,
      status: filters.value.status === 'all' ? undefined : filters.value.status,
      startTime: filters.value.startTime || undefined,
      endTime: filters.value.endTime || undefined,
    })
    items.value = response.items || []
    pagination.value = response.pagination || { page: 1, pageSize: 20, total: 0, totalPages: 1 }
  } catch (error: any) {
    errorText.value = error?.response?.data?.error || '加载失败'
    if (error?.response?.status === 401 || error?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
    showErrorToast(errorText.value)
  } finally {
    loading.value = false
  }
}

const applyFilters = () => {
  pagination.value.page = 1
  loadData()
}

const resetFilters = () => {
  filters.value.keyword = ''
  filters.value.exceptionType = ''
  filters.value.status = 'all'
  filters.value.startTime = ''
  filters.value.endTime = ''
  pagination.value.page = 1
  loadData()
}

const updateStatus = async (item: HistoryExceptionItem, status: HistoryExceptionStatus) => {
  if (!canUpdate.value || item.status === status) return
  try {
    await historyExceptionService.updateStatus(item.accountId, status)
    showSuccessToast('状态更新成功')
    await loadData()
  } catch (error: any) {
    showErrorToast(error?.response?.data?.error || '状态更新失败')
  }
}

const removeItem = async (item: HistoryExceptionItem) => {
  if (!canDelete.value) return
  const label = item.accountName || `账号 #${item.accountId}`
  const ok = window.confirm(`确认删除「${label}」的历史异常记录？删除后不可恢复。`)
  if (!ok) return

  try {
    await historyExceptionService.remove(item.accountId)
    showSuccessToast('删除成功')
    const willBeEmpty = items.value.length === 1 && pagination.value.page > 1
    if (willBeEmpty) pagination.value.page -= 1
    await loadData()
  } catch (error: any) {
    showErrorToast(error?.response?.data?.error || '删除失败')
  }
}

const goPage = (nextPage: number) => {
  if (nextPage < 1 || nextPage > pagination.value.totalPages || nextPage === pagination.value.page) return
  pagination.value.page = nextPage
  loadData()
}

onMounted(loadData)
</script>

<template>
  <div class="space-y-4">
    <header class="space-y-1">
      <h1 class="text-2xl font-semibold text-gray-900">历史异常</h1>
      <p class="text-sm text-gray-500">按账号保留最新一条异常记录，便于快速定位与处理。</p>
    </header>

    <section class="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
      <div class="grid grid-cols-1 md:grid-cols-5 gap-3">
        <input v-model="filters.keyword" type="text" placeholder="账号ID/账号名关键词" class="h-9 px-3 rounded-md border border-gray-200 text-sm" />
        <input v-model="filters.exceptionType" type="text" placeholder="异常类型" class="h-9 px-3 rounded-md border border-gray-200 text-sm" />
        <select v-model="filters.status" class="h-9 px-3 rounded-md border border-gray-200 text-sm">
          <option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <input v-model="filters.startTime" type="datetime-local" class="h-9 px-3 rounded-md border border-gray-200 text-sm" />
        <input v-model="filters.endTime" type="datetime-local" class="h-9 px-3 rounded-md border border-gray-200 text-sm" />
      </div>
      <div class="flex gap-2">
        <button class="h-9 px-4 rounded-md bg-black text-white text-sm" @click="applyFilters">筛选</button>
        <button class="h-9 px-4 rounded-md border border-gray-300 text-sm" @click="resetFilters">重置</button>
      </div>
    </section>

    <section class="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div v-if="loading" class="p-8 text-center text-gray-500">加载中...</div>
      <div v-else-if="errorText" class="p-8 text-center text-red-500">{{ errorText }}</div>
      <div v-else-if="items.length === 0" class="p-8 text-center text-gray-500">暂无历史异常记录</div>

      <template v-else>
        <table class="hidden md:table w-full text-sm">
          <thead class="bg-gray-50 text-gray-500">
            <tr>
              <th class="text-left px-4 py-3">账号</th>
              <th class="text-left px-4 py-3">异常类型</th>
              <th class="text-left px-4 py-3">异常摘要</th>
              <th class="text-left px-4 py-3">最近发生时间</th>
              <th class="text-left px-4 py-3">状态</th>
              <th class="text-left px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="item.accountId" class="border-t border-gray-100">
              <td class="px-4 py-3">
                <div class="font-medium text-gray-900">{{ item.accountName || `账号 #${item.accountId}` }}</div>
                <div class="text-xs text-gray-500">ID: {{ item.accountId }}</div>
              </td>
              <td class="px-4 py-3">{{ item.exceptionType || '-' }}</td>
              <td class="px-4 py-3">
                <div class="text-gray-800">{{ item.exceptionMessage || '-' }}</div>
                <div v-if="item.exceptionCode" class="text-xs text-gray-500">代码: {{ item.exceptionCode }}</div>
              </td>
              <td class="px-4 py-3 text-gray-700">{{ formatShanghaiDate(item.lastSeenAt || '', {}) || '-' }}</td>
              <td class="px-4 py-3">
                <span class="px-2 py-1 rounded-full text-xs" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
              </td>
              <td class="px-4 py-3">
                <div class="flex flex-wrap gap-2">
                  <button class="px-2 py-1 text-xs border rounded" :disabled="!canUpdate" @click="updateStatus(item, 'active')">标记待处理</button>
                  <button class="px-2 py-1 text-xs border rounded" :disabled="!canUpdate" @click="updateStatus(item, 'resolved')">标记已解决</button>
                  <button class="px-2 py-1 text-xs border rounded" :disabled="!canUpdate" @click="updateStatus(item, 'ignored')">标记忽略</button>
                  <button class="px-2 py-1 text-xs border border-red-300 text-red-600 rounded" :disabled="!canDelete" @click="removeItem(item)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="md:hidden divide-y divide-gray-100">
          <article v-for="item in items" :key="item.accountId" class="p-4 space-y-3">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="font-medium text-gray-900">{{ item.accountName || `账号 #${item.accountId}` }}</div>
                <div class="text-xs text-gray-500">ID: {{ item.accountId }}</div>
              </div>
              <span class="px-2 py-1 rounded-full text-xs shrink-0" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
            </div>
            <div class="text-sm text-gray-700 space-y-1">
              <div>类型：{{ item.exceptionType || '-' }}</div>
              <div>摘要：{{ item.exceptionMessage || '-' }}</div>
              <div v-if="item.exceptionCode" class="text-xs text-gray-500">代码：{{ item.exceptionCode }}</div>
              <div>最近：{{ formatShanghaiDate(item.lastSeenAt || '', {}) || '-' }}</div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <button class="h-9 px-2 text-xs border rounded" :disabled="!canUpdate" @click="updateStatus(item, 'active')">标记待处理</button>
              <button class="h-9 px-2 text-xs border rounded" :disabled="!canUpdate" @click="updateStatus(item, 'resolved')">标记已解决</button>
              <button class="h-9 px-2 text-xs border rounded" :disabled="!canUpdate" @click="updateStatus(item, 'ignored')">标记忽略</button>
              <button class="h-9 px-2 text-xs border border-red-300 text-red-600 rounded" :disabled="!canDelete" @click="removeItem(item)">删除</button>
            </div>
          </article>
        </div>
      </template>

      <div class="border-t border-gray-100 p-3 flex items-center justify-between text-sm">
        <span class="text-gray-500">共 {{ pagination.total }} 条</span>
        <div class="flex items-center gap-2">
          <button class="h-8 px-3 border rounded" :disabled="pagination.page <= 1" @click="goPage(pagination.page - 1)">上一页</button>
          <span>{{ pagination.page }} / {{ pagination.totalPages }}</span>
          <button class="h-8 px-3 border rounded" :disabled="pagination.page >= pagination.totalPages" @click="goPage(pagination.page + 1)">下一页</button>
        </div>
      </div>
    </section>
  </div>
</template>
