<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { adminService, authService, userService, type PointsLedgerRecord, type PurchaseOrder, type RbacRole, type RbacUser } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { ChevronLeft, ChevronRight, Coins, Eye, PencilLine, RefreshCw, Trash2 } from 'lucide-vue-next'

const isSuperAdmin = computed(() => {
  const user = authService.getCurrentUser()
  return Array.isArray(user?.roles) && user.roles.includes('super_admin')
})

const teleportReady = ref(false)
const currentUserId = computed(() => Number(authService.getCurrentUser()?.id) || 0)
const isCurrentUser = (userId: number) => currentUserId.value !== 0 && currentUserId.value === userId

const listLoading = ref(false)
const error = ref('')
const success = ref('')

const roles = ref<RbacRole[]>([])
const users = ref<RbacUser[]>([])
const userRoleDrafts = ref<Record<number, string>>({})
const roleUpdating = ref<Record<number, boolean>>({})
const userInviteDrafts = ref<Record<number, boolean>>({})
const inviteUpdating = ref<Record<number, boolean>>({})

const search = ref('')

const paginationMeta = ref({ page: 1, pageSize: 10, total: 0 })
const totalPages = computed(() => Math.max(1, Math.ceil(paginationMeta.value.total / paginationMeta.value.pageSize)))

const { success: showSuccessToast, error: showErrorToast } = useToast()

const goToPage = (page: number) => {
  if (page < 1 || page > totalPages.value || page === paginationMeta.value.page) return
  paginationMeta.value.page = page
  loadUsers()
}

const loadRoles = async () => {
  const rolesRes = await adminService.getRoles()
  roles.value = rolesRes.roles || []
}

const loadUsers = async () => {
  error.value = ''
  listLoading.value = true
  try {
    const response = await adminService.getUsers({
      page: paginationMeta.value.page,
      pageSize: paginationMeta.value.pageSize,
      search: search.value.trim() || undefined,
    })
    users.value = response.users || []
    paginationMeta.value = response.pagination || paginationMeta.value

    userRoleDrafts.value = Object.fromEntries(
      (users.value || []).map(user => [user.id, user.roles?.[0]?.roleKey || ''])
    )
    userInviteDrafts.value = Object.fromEntries(
      (users.value || []).map(user => [user.id, Boolean(user.inviteEnabled)])
    )
  } catch (err: any) {
    error.value = err.response?.data?.error || '加载用户数据失败'
  } finally {
    listLoading.value = false
  }
}

const loadData = async () => {
  success.value = ''
  error.value = ''
  let rolesErrorMessage = ''
  try {
    await loadRoles()
  } catch (err: any) {
    rolesErrorMessage = err.response?.data?.error || '加载角色列表失败'
  }
  await loadUsers()
  if (!error.value && rolesErrorMessage) {
    error.value = rolesErrorMessage
  }
}

const handleSearch = () => {
  paginationMeta.value.page = 1
  loadUsers()
}

const setRoleUpdating = (userId: number, value: boolean) => {
  roleUpdating.value = {
    ...roleUpdating.value,
    [userId]: value,
  }
}

const setInviteUpdating = (userId: number, value: boolean) => {
  inviteUpdating.value = {
    ...inviteUpdating.value,
    [userId]: value,
  }
}

const handleRoleChange = async (user: RbacUser) => {
  if (!user?.id) return
  error.value = ''
  success.value = ''

  if (isSuperAdmin.value && isCurrentUser(user.id)) {
    userRoleDrafts.value[user.id] = String(user.roles?.[0]?.roleKey || '')
    showErrorToast('超级管理员不能修改自己的角色')
    return
  }

  const nextRoleKey = String(userRoleDrafts.value[user.id] || '').trim()
  const previousRoleKey = String(user.roles?.[0]?.roleKey || '')
  if (!nextRoleKey) {
    userRoleDrafts.value[user.id] = previousRoleKey
    showErrorToast('请选择角色')
    return
  }
  if (nextRoleKey === previousRoleKey) {
    return
  }

  setRoleUpdating(user.id, true)
  try {
    await adminService.setUserRoles(user.id, [nextRoleKey])
    const role = roles.value.find(r => r.roleKey === nextRoleKey)
    user.roles = role
      ? [{ roleKey: role.roleKey, roleName: role.roleName }]
      : [{ roleKey: nextRoleKey, roleName: nextRoleKey }]

    const currentUser = authService.getCurrentUser()
    if (Number(currentUser?.id) === user.id) {
      try {
        const me = await userService.getMe()
        authService.setCurrentUser(me)
      } catch (refreshError) {
        console.warn('Refresh current user after role change failed:', refreshError)
      }
    }

    showSuccessToast('角色已更新')
  } catch (err: any) {
    userRoleDrafts.value[user.id] = previousRoleKey
    const message = err.response?.data?.error || '更新用户角色失败'
    error.value = message
    showErrorToast(message)
  } finally {
    setRoleUpdating(user.id, false)
  }
}

const handleInviteEnabledChange = async (user: RbacUser) => {
  if (!user?.id) return
  error.value = ''
  success.value = ''

  const next = Boolean(userInviteDrafts.value[user.id])
  const previous = Boolean(user.inviteEnabled)
  if (next === previous) return

  setInviteUpdating(user.id, true)
  try {
    const response = await adminService.updateUser(user.id, { inviteEnabled: next })
    const updated = response.user
    const idx = users.value.findIndex(u => u.id === updated.id)
    if (idx !== -1) {
      users.value[idx] = { ...users.value[idx], ...updated }
      userRoleDrafts.value[updated.id] = updated.roles?.[0]?.roleKey || ''
      userInviteDrafts.value[updated.id] = Boolean(updated.inviteEnabled)
    }

    const currentUser = authService.getCurrentUser()
    if (Number(currentUser?.id) === user.id) {
      try {
        const me = await userService.getMe()
        authService.setCurrentUser(me)
      } catch (refreshError) {
        console.warn('Refresh current user after invite toggle failed:', refreshError)
      }
    }

    showSuccessToast('邀请权限已更新')
  } catch (err: any) {
    userInviteDrafts.value[user.id] = previous
    const message = err.response?.data?.error || '更新邀请权限失败'
    error.value = message
    showErrorToast(message)
  } finally {
    setInviteUpdating(user.id, false)
  }
}

const editDialogOpen = ref(false)
const editingUser = ref<RbacUser | null>(null)
const editUsername = ref('')
const editEmail = ref('')
const editInviteEnabled = ref(true)
const editLoading = ref(false)

const openEditDialog = (user: RbacUser) => {
  editingUser.value = user
  editUsername.value = user.username
  editEmail.value = user.email
  editInviteEnabled.value = Boolean(user.inviteEnabled)
  editDialogOpen.value = true
}

const closeEditDialog = () => {
  editDialogOpen.value = false
  editingUser.value = null
  editUsername.value = ''
  editEmail.value = ''
  editInviteEnabled.value = true
}

const saveUserEdits = async () => {
  if (!editingUser.value) return
  error.value = ''
  success.value = ''
  editLoading.value = true

  try {
    const response = await adminService.updateUser(editingUser.value.id, {
      username: editUsername.value.trim(),
      email: editEmail.value.trim(),
      inviteEnabled: editInviteEnabled.value,
    })
    const updated = response.user
    const idx = users.value.findIndex(u => u.id === updated.id)
    if (idx !== -1) {
      users.value[idx] = { ...users.value[idx], ...updated }
      userRoleDrafts.value[updated.id] = updated.roles?.[0]?.roleKey || ''
      userInviteDrafts.value[updated.id] = Boolean(updated.inviteEnabled)
    }

    const currentUser = authService.getCurrentUser()
    if (Number(currentUser?.id) === updated.id) {
      try {
        const me = await userService.getMe()
        authService.setCurrentUser(me)
      } catch (refreshError) {
        console.warn('Refresh current user after user update failed:', refreshError)
      }
    }

    showSuccessToast('用户信息已更新')
    closeEditDialog()
  } catch (err: any) {
    const message = err.response?.data?.error || '更新用户失败'
    error.value = message
    showErrorToast(message)
  } finally {
    editLoading.value = false
  }
}

const deleteDialogOpen = ref(false)
const deletingUser = ref<RbacUser | null>(null)
const deleteLoading = ref(false)

const openDeleteDialog = (user: RbacUser) => {
  deletingUser.value = user
  deleteDialogOpen.value = true
}

const closeDeleteDialog = () => {
  deleteDialogOpen.value = false
  deletingUser.value = null
}

const confirmDeleteUser = async () => {
  if (!deletingUser.value) return
  error.value = ''
  success.value = ''
  deleteLoading.value = true
  try {
    await adminService.deleteUser(deletingUser.value.id)
    showSuccessToast('用户已删除')
    closeDeleteDialog()
    await loadUsers()
  } catch (err: any) {
    const message = err.response?.data?.error || '删除用户失败'
    error.value = message
    showErrorToast(message)
  } finally {
    deleteLoading.value = false
  }
}

const setPointsDialogOpen = ref(false)
const setPointsUser = ref<RbacUser | null>(null)
const setPointsExpected = ref<number | null>(null)
const setPointsTarget = ref('')
const setPointsConfirm = ref('')
const setPointsError = ref('')
const setPointsLoading = ref(false)

const parseNonNegativeInt = (value: string) => {
  const text = String(value ?? '').trim()
  if (!/^[0-9]+$/.test(text)) return null
  const parsed = Number.parseInt(text, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

const setPointsCurrentValue = computed(() => Number(setPointsUser.value?.points ?? 0))
const setPointsTargetValue = computed(() => parseNonNegativeInt(setPointsTarget.value))
const setPointsConfirmValue = computed(() => parseNonNegativeInt(setPointsConfirm.value))

const setPointsDelta = computed(() => {
  const target = setPointsTargetValue.value
  if (target == null) return null
  return target - setPointsCurrentValue.value
})

const canSubmitSetPoints = computed(() => {
  if (!setPointsUser.value) return false
  if (setPointsLoading.value) return false
  const target = setPointsTargetValue.value
  if (target == null) return false
  if (target === setPointsCurrentValue.value) return false
  const confirm = setPointsConfirmValue.value
  if (confirm == null || confirm !== target) return false
  return true
})

const openSetPointsDialog = (user: RbacUser) => {
  setPointsUser.value = { ...user }
  setPointsExpected.value = Number(user.points ?? 0)
  setPointsTarget.value = ''
  setPointsConfirm.value = ''
  setPointsError.value = ''
  setPointsDialogOpen.value = true
}

const closeSetPointsDialog = () => {
  setPointsDialogOpen.value = false
  setPointsUser.value = null
  setPointsExpected.value = null
  setPointsTarget.value = ''
  setPointsConfirm.value = ''
  setPointsError.value = ''
  setPointsLoading.value = false
}

const applyUserUpdate = (updated: RbacUser) => {
  const idx = users.value.findIndex(item => item.id === updated.id)
  if (idx !== -1) {
    users.value[idx] = { ...users.value[idx], ...updated }
  }
  if (detailUser.value?.id === updated.id) {
    detailUser.value = { ...detailUser.value, ...updated }
  }
}

const submitSetPoints = async () => {
  if (!setPointsUser.value) return
  setPointsError.value = ''

  const target = setPointsTargetValue.value
  if (target == null) {
    setPointsError.value = '请输入 0 以上整数'
    showErrorToast(setPointsError.value)
    return
  }
  if (target === setPointsCurrentValue.value) {
    setPointsError.value = '目标积分与当前积分一致'
    showErrorToast(setPointsError.value)
    return
  }

  const confirm = setPointsConfirmValue.value
  if (confirm == null || confirm !== target) {
    setPointsError.value = '两次输入的目标积分不一致'
    showErrorToast(setPointsError.value)
    return
  }

  setPointsLoading.value = true
  try {
    const response = await adminService.setUserPoints(setPointsUser.value.id, {
      points: target,
      expectedPoints: setPointsExpected.value ?? undefined,
    })

    applyUserUpdate(response.user)
    if (setPointsUser.value?.id === response.user.id) {
      setPointsUser.value = { ...setPointsUser.value, ...response.user }
    }

    if (detailDialogOpen.value && detailUser.value?.id === response.user.id && ledgerLoaded.value) {
      await resetLedgerPagination()
    }

    showSuccessToast('积分已设置')
    closeSetPointsDialog()
  } catch (err: any) {
    const status = Number(err?.response?.status)
    const apiError = err?.response?.data?.error
    const currentPoints = err?.response?.data?.currentPoints

    if (status === 409 && Number.isFinite(Number(currentPoints))) {
      const nextPoints = Number(currentPoints)
      const updated = setPointsUser.value ? { ...setPointsUser.value, points: nextPoints } : null
      if (updated) applyUserUpdate(updated)
      if (setPointsUser.value) setPointsUser.value = updated
      setPointsExpected.value = nextPoints
      setPointsError.value = `积分已发生变化（当前为 ${nextPoints}），请刷新后重试`
    } else if (apiError === 'No change') {
      setPointsError.value = '目标积分与当前积分一致'
    } else {
      setPointsError.value = apiError || '设置积分失败'
    }

    showErrorToast(setPointsError.value)
  } finally {
    setPointsLoading.value = false
  }
}

const detailDialogOpen = ref(false)
const detailUser = ref<RbacUser | null>(null)
const detailTab = ref<'overview' | 'ledger' | 'orders'>('overview')

const ledgerLoading = ref(false)
const ledgerError = ref('')
const ledgerRecords = ref<PointsLedgerRecord[]>([])
const ledgerBeforeId = ref<number | null>(null)
const ledgerHasMore = ref(false)
const ledgerNextBeforeId = ref<number | null>(null)
const ledgerBeforeIdStack = ref<Array<number | null>>([])
const ledgerLoaded = ref(false)
const ledgerPage = computed(() => ledgerBeforeIdStack.value.length + 1)

const ordersLoading = ref(false)
const ordersError = ref('')
const orders = ref<PurchaseOrder[]>([])
const ordersPagination = ref({ page: 1, pageSize: 6, total: 0 })
const ordersLoaded = ref(false)
const ordersTotalPages = computed(() => Math.max(1, Math.ceil(ordersPagination.value.total / ordersPagination.value.pageSize)))

const detailRolesLabel = computed(() => {
  const roles = detailUser.value?.roles || []
  if (!roles.length) return '-'
  return roles.map(role => `${role.roleName} (${role.roleKey})`).join(' / ')
})

const openDetailDialog = (user: RbacUser, tab: 'overview' | 'ledger' | 'orders' = 'overview') => {
  detailUser.value = { ...user }
  detailDialogOpen.value = true
  resetDetailState()
  detailTab.value = tab
}

const closeDetailDialog = () => {
  detailDialogOpen.value = false
  detailUser.value = null
  detailTab.value = 'overview'
  resetDetailState()
}

const resetDetailState = () => {
  ledgerLoading.value = false
  ledgerError.value = ''
  ledgerRecords.value = []
  ledgerBeforeId.value = null
  ledgerHasMore.value = false
  ledgerNextBeforeId.value = null
  ledgerBeforeIdStack.value = []
  ledgerLoaded.value = false

  ordersLoading.value = false
  ordersError.value = ''
  orders.value = []
  ordersPagination.value = { page: 1, pageSize: 6, total: 0 }
  ordersLoaded.value = false
}

const formatDate = (value?: string | number | Date | null) => formatShanghaiDate(value)

const getLedgerLabel = (item: PointsLedgerRecord) => {
  if (item.remark) return item.remark
  switch (item.action) {
    case 'purchase_invite_reward':
      return '邀请奖励'
    case 'purchase_buyer_reward':
      return '购买奖励'
    case 'redeem_invite_unlock':
      return '开通邀请权限'
    case 'redeem_team_seat':
      return '兑换 ChatGPT Team 名额'
    case 'withdraw_request':
      return '提现申请'
    default:
      return item.action || '积分变更'
  }
}

const orderStatusLabel = (status?: string) => {
  if (status === 'paid') return '已支付'
  if (status === 'refunded') return '已退款'
  if (status === 'expired') return '已过期'
  if (status === 'failed') return '失败'
  if (status === 'pending_payment') return '待支付'
  if (status === 'created') return '已创建'
  return status || '未知'
}

const orderStatusClass = (status?: string) => {
  switch (status) {
    case 'paid':
      return 'bg-green-100 text-green-700 border-green-200'
    case 'refunded':
      return 'bg-purple-100 text-purple-700 border-purple-200'
    case 'pending_payment':
      return 'bg-yellow-100 text-yellow-700 border-yellow-200'
    case 'created':
      return 'bg-gray-100 text-gray-700 border-gray-200'
    case 'failed':
      return 'bg-red-100 text-red-700 border-red-200'
    case 'expired':
      return 'bg-gray-100 text-gray-500 border-gray-200'
    default:
      return 'bg-gray-100 text-gray-700 border-gray-200'
  }
}

const loadLedger = async () => {
  if (!detailUser.value) return
  ledgerLoading.value = true
  ledgerError.value = ''
  try {
    const response = await adminService.getUserPointsLedger(detailUser.value.id, {
      limit: 20,
      beforeId: ledgerBeforeId.value ?? undefined,
    })
    ledgerRecords.value = Array.isArray(response.records) ? response.records : []
    ledgerHasMore.value = Boolean(response.page?.hasMore)
    ledgerNextBeforeId.value = response.page?.nextBeforeId ?? null
  } catch (err: any) {
    ledgerError.value = err.response?.data?.error || '加载积分明细失败'
    showErrorToast(ledgerError.value)
  } finally {
    ledgerLoading.value = false
  }
}

const resetLedgerPagination = async () => {
  ledgerBeforeIdStack.value = []
  ledgerBeforeId.value = null
  await loadLedger()
}

const goLedgerPrevPage = async () => {
  if (ledgerLoading.value || ledgerBeforeIdStack.value.length === 0) return
  ledgerBeforeId.value = ledgerBeforeIdStack.value.pop() ?? null
  await loadLedger()
}

const goLedgerNextPage = async () => {
  if (ledgerLoading.value || !ledgerHasMore.value || !ledgerNextBeforeId.value) return
  ledgerBeforeIdStack.value.push(ledgerBeforeId.value)
  ledgerBeforeId.value = ledgerNextBeforeId.value
  await loadLedger()
}

const loadUserOrders = async () => {
  if (!detailUser.value) return
  ordersLoading.value = true
  ordersError.value = ''
  try {
    const response = await adminService.getUserOrders(detailUser.value.id, {
      page: ordersPagination.value.page,
      pageSize: ordersPagination.value.pageSize,
    })
    orders.value = response.orders || []
    ordersPagination.value = response.pagination || ordersPagination.value
    if (detailUser.value && response.pagination) {
      detailUser.value = { ...detailUser.value, orderCount: response.pagination.total }
    }
  } catch (err: any) {
    ordersError.value = err.response?.data?.error || '加载订单失败'
    showErrorToast(ordersError.value)
  } finally {
    ordersLoading.value = false
  }
}

const goOrdersPage = (page: number) => {
  if (page < 1 || page > ordersTotalPages.value || page === ordersPagination.value.page) return
  ordersPagination.value.page = page
  loadUserOrders()
}

let searchTimer: number | null = null
watch(search, () => {
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => {
    handleSearch()
  }, 300)
})

watch(detailTab, async (tab) => {
  if (!detailDialogOpen.value || !detailUser.value) return
  if (tab === 'ledger' && !ledgerLoaded.value) {
    ledgerLoaded.value = true
    await resetLedgerPagination()
  }
  if (tab === 'orders' && !ordersLoaded.value) {
    ordersLoaded.value = true
    await loadUserOrders()
  }
})

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')
  await loadData()
})

onUnmounted(() => {
  teleportReady.value = false
})
</script>

<template>
  <div class="space-y-6">
    <div v-if="!isSuperAdmin" class="rounded-2xl border border-gray-100 bg-white p-6 text-sm text-gray-600">
      当前账号无权限访问用户管理。
    </div>

    <template v-else>
      <Teleport v-if="teleportReady" to="#header-actions">
        <div class="flex items-center gap-3 flex-wrap justify-end">
          <Button
            type="button"
            variant="outline"
            class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
            :disabled="listLoading"
            @click="loadData"
          >
            <RefreshCw class="h-4 w-4 mr-2" :class="{ 'animate-spin': listLoading }" />
            刷新列表
          </Button>
        </div>
      </Teleport>

      <div class="flex flex-col lg:flex-row lg:items-center gap-4">
        <div class="flex gap-3 items-center">
          <Input
            v-model="search"
            placeholder="搜索用户名/邮箱"
            class="h-11 w-full lg:w-[340px] bg-white border-transparent shadow-[0_2px_10px_rgba(0,0,0,0.03)] rounded-xl"
            @keyup.enter="handleSearch"
          />
        </div>
      </div>

      <div v-if="error" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 text-red-600">
        {{ error }}
      </div>

      <div v-if="success" class="rounded-2xl border border-green-100 bg-green-50/50 p-4 text-green-700">
        {{ success }}
      </div>

      <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden min-h-[320px]">
        <div v-if="listLoading" class="flex flex-col items-center justify-center py-20">
          <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
          <p class="text-gray-400 text-sm font-medium mt-4">正在加载...</p>
        </div>

        <div v-else-if="users.length === 0" class="flex flex-col items-center justify-center py-24 text-center">
          <h3 class="text-lg font-semibold text-gray-900">暂无用户</h3>
          <p class="text-gray-500 text-sm mt-1">当前没有匹配的用户记录</p>
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">ID</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">用户</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">积分</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">邀请人数</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">订单</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">邀请</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">创建时间</th>
                <th class="px-6 py-5 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">角色</th>
                <th class="px-6 py-5 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-gray-50">
              <tr
                v-for="user in users"
                :key="user.id"
                class="group hover:bg-blue-50/30 transition-colors duration-200"
              >
                <td class="px-6 py-5 text-sm font-medium text-blue-500">#{{ user.id }}</td>
                <td class="px-6 py-5">
                  <div
                    class="flex flex-col cursor-pointer group"
                    title="查看用户信息"
                    @click="openDetailDialog(user)"
                  >
                    <span class="text-sm font-medium text-gray-900 transition-colors group-hover:text-blue-600">{{ user.username }}</span>
                    <span class="text-xs text-gray-500 transition-colors group-hover:text-blue-500/80">{{ user.email }}</span>
                  </div>
                </td>
                <td
                  class="px-6 py-5 text-right text-sm font-semibold text-gray-900 tabular-nums cursor-pointer transition-colors hover:text-blue-600"
                  title="查看积分明细"
                  @click="openDetailDialog(user, 'ledger')"
                >
                  {{ user.points ?? 0 }}
                </td>
                <td class="px-6 py-5 text-right text-sm text-gray-600 tabular-nums">
                  {{ user.invitedCount ?? 0 }}
                </td>
                <td
                  class="px-6 py-5 text-right text-sm text-gray-600 tabular-nums cursor-pointer transition-colors hover:text-blue-600"
                  title="查看订单"
                  @click="openDetailDialog(user, 'orders')"
                >
                  {{ user.orderCount ?? 0 }}
                </td>
                <td class="px-6 py-5">
                  <select
                    v-model="userInviteDrafts[user.id]"
                    :disabled="inviteUpdating[user.id]"
                    class="h-10 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    @change="handleInviteEnabledChange(user)"
                  >
                    <option :value="true">开启</option>
                    <option :value="false">关闭</option>
                  </select>
                </td>
                <td class="px-6 py-5 text-sm text-gray-500">
                  {{ formatShanghaiDate(user.createdAt) }}
                </td>
                <td class="px-6 py-5">
                  <select
                    v-model="userRoleDrafts[user.id]"
                    :disabled="roleUpdating[user.id] || isCurrentUser(user.id)"
                    class="h-10 rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-100"
                    :title="isCurrentUser(user.id) ? '超级管理员不能修改自己的角色' : undefined"
                    @change="handleRoleChange(user)"
                  >
                    <option value="" disabled>选择角色</option>
                    <option v-for="role in roles" :key="role.id" :value="role.roleKey">
                      {{ role.roleName }} ({{ role.roleKey }})
                    </option>
                  </select>
                </td>
                <td class="px-6 py-5 text-right">
                  <div class="flex items-center justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      class="rounded-xl border-gray-200 bg-white text-gray-600"
                      :disabled="listLoading"
                      title="设置积分"
                      aria-label="设置积分"
                      @click="openSetPointsDialog(user)"
                    >
                      <Coins class="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      class="rounded-xl border-gray-200 bg-white text-gray-600"
                      :disabled="listLoading"
                      title="查看用户信息"
                      aria-label="查看用户信息"
                      @click="openDetailDialog(user)"
                    >
                      <Eye class="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      class="rounded-xl border-gray-200 bg-white text-gray-600"
                      :disabled="listLoading"
                      title="编辑用户"
                      aria-label="编辑用户"
                      @click="openEditDialog(user)"
                    >
                      <PencilLine class="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon-sm"
                      class="rounded-xl border-red-200 bg-white text-red-600 hover:bg-red-50"
                      :disabled="listLoading"
                      title="删除用户"
                      aria-label="删除用户"
                      @click="openDeleteDialog(user)"
                    >
                      <Trash2 class="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="!listLoading" class="flex items-center justify-between border-t border-gray-100 px-6 py-4 text-sm text-gray-500 bg-gray-50/30">
          <p>
            第 {{ paginationMeta.page }} / {{ totalPages }} 页，共 {{ paginationMeta.total }} 个用户
          </p>
          <div class="flex items-center gap-2">
            <Button
              size="icon-sm"
              variant="outline"
              class="rounded-lg border-gray-200"
              :disabled="paginationMeta.page === 1"
              title="上一页"
              aria-label="上一页"
              @click="goToPage(paginationMeta.page - 1)"
            >
              <ChevronLeft class="h-4 w-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              class="rounded-lg border-gray-200"
              :disabled="paginationMeta.page >= totalPages"
              title="下一页"
              aria-label="下一页"
              @click="goToPage(paginationMeta.page + 1)"
            >
              <ChevronRight class="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <!-- User detail dialog -->
      <Dialog v-model:open="detailDialogOpen" @update:open="(open) => { if (!open) closeDetailDialog() }">
        <DialogContent class="sm:max-w-[980px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
          <DialogHeader class="px-8 pt-8 pb-4">
            <DialogTitle class="text-2xl font-bold text-gray-900">用户信息</DialogTitle>
            <DialogDescription class="text-gray-500">
              查看用户概览、积分明细与订单记录。
            </DialogDescription>
          </DialogHeader>
          <div class="px-8 pb-8">
            <Tabs v-model="detailTab" class="space-y-6">
              <TabsList class="bg-gray-100/70 border border-gray-200 rounded-xl p-1">
                <TabsTrigger value="overview" class="rounded-lg px-4">概览</TabsTrigger>
                <TabsTrigger value="ledger" class="rounded-lg px-4">积分明细</TabsTrigger>
                <TabsTrigger value="orders" class="rounded-lg px-4">订单</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" class="mt-0 space-y-6">
                <div class="grid gap-4 sm:grid-cols-3">
                  <div class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4">
                    <div class="flex items-start justify-between gap-3">
                      <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">积分</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        class="h-8 rounded-lg border-gray-200 bg-white text-gray-700 px-3"
                        @click="detailUser && openSetPointsDialog(detailUser)"
                      >
                        设置
                      </Button>
                    </div>
                    <p class="text-2xl font-bold text-gray-900 tabular-nums">{{ detailUser?.points ?? 0 }}</p>
                  </div>
                  <div class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4">
                    <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">邀请用户</p>
                    <p class="text-2xl font-bold text-gray-900 tabular-nums">{{ detailUser?.invitedCount ?? 0 }}</p>
                  </div>
                  <div class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4">
                    <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">订单数</p>
                    <p class="text-2xl font-bold text-gray-900 tabular-nums">{{ detailUser?.orderCount ?? 0 }}</p>
                  </div>
                </div>

                <div class="grid gap-4 lg:grid-cols-2">
                  <div class="rounded-2xl border border-gray-100 bg-white p-4">
                    <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">用户资料</p>
                    <div class="mt-3 space-y-2 text-sm">
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">ID</span>
                        <span class="font-medium text-gray-900">#{{ detailUser?.id ?? '-' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">用户名</span>
                        <span class="font-medium text-gray-900">{{ detailUser?.username || '-' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">邮箱</span>
                        <span class="font-medium text-gray-900">{{ detailUser?.email || '-' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">创建时间</span>
                        <span class="font-medium text-gray-900">{{ formatDate(detailUser?.createdAt) }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="rounded-2xl border border-gray-100 bg-white p-4">
                    <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">邀请与角色</p>
                    <div class="mt-3 space-y-2 text-sm">
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">邀请功能</span>
                        <span class="font-medium text-gray-900">{{ detailUser?.inviteEnabled ? '已开启' : '已关闭' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">邀请码</span>
                        <span class="font-mono text-gray-900">{{ detailUser?.inviteCode || '-' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">邀请人ID</span>
                        <span class="font-medium text-gray-900">{{ detailUser?.invitedByUserId ?? '-' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-6">
                        <span class="text-gray-500">角色</span>
                        <span class="font-medium text-gray-900">{{ detailRolesLabel }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="ledger" class="mt-0 space-y-4">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">当前积分</p>
                    <p class="text-lg font-semibold text-gray-900 tabular-nums">{{ detailUser?.points ?? 0 }}</p>
                    <p class="text-xs text-gray-400">第 {{ ledgerPage }} 页</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      class="rounded-lg border-gray-200"
                      :disabled="ledgerLoading || ledgerBeforeIdStack.length === 0"
                      title="上一页"
                      aria-label="上一页"
                      @click="goLedgerPrevPage"
                    >
                      <ChevronLeft class="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      class="rounded-lg border-gray-200"
                      :disabled="ledgerLoading || !ledgerHasMore"
                      title="下一页"
                      aria-label="下一页"
                      @click="goLedgerNextPage"
                    >
                      <ChevronRight class="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div v-if="ledgerError" class="rounded-xl border border-red-100 bg-red-50/50 p-3 text-sm text-red-600">
                  {{ ledgerError }}
                </div>
                <div v-else-if="ledgerLoading" class="text-sm text-gray-500">
                  加载中…
                </div>
                <div v-else-if="ledgerRecords.length === 0" class="text-sm text-gray-500">
                  暂无积分变更记录
                </div>
                <div v-else class="overflow-x-auto">
                  <table class="min-w-full text-sm">
                    <thead>
                      <tr class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        <th class="py-3 text-left">时间</th>
                        <th class="py-3 text-right">变更</th>
                        <th class="py-3 text-right">余额</th>
                        <th class="py-3 text-left">说明</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                      <tr v-for="item in ledgerRecords" :key="item.id">
                        <td class="py-3 pr-4 text-gray-600 whitespace-nowrap tabular-nums">
                          {{ formatDate(item.createdAt) }}
                        </td>
                        <td class="py-3 px-2 text-right tabular-nums">
                          <span :class="Number(item.deltaPoints) >= 0 ? 'text-emerald-600' : 'text-red-600'">
                            {{ Number(item.deltaPoints) >= 0 ? '+' : '' }}{{ item.deltaPoints }}
                          </span>
                        </td>
                        <td class="py-3 px-2 text-right tabular-nums text-gray-900">
                          {{ item.pointsAfter }}
                        </td>
                        <td class="py-3 pl-4 text-gray-900">
                          {{ getLedgerLabel(item) }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </TabsContent>

              <TabsContent value="orders" class="mt-0 space-y-4">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider">订单数</p>
                    <p class="text-lg font-semibold text-gray-900 tabular-nums">{{ ordersPagination.total }}</p>
                    <p class="text-xs text-gray-400">第 {{ ordersPagination.page }} / {{ ordersTotalPages }} 页</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      class="rounded-lg border-gray-200"
                      :disabled="ordersLoading || ordersPagination.page === 1"
                      title="上一页"
                      aria-label="上一页"
                      @click="goOrdersPage(ordersPagination.page - 1)"
                    >
                      <ChevronLeft class="h-4 w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      class="rounded-lg border-gray-200"
                      :disabled="ordersLoading || ordersPagination.page >= ordersTotalPages"
                      title="下一页"
                      aria-label="下一页"
                      @click="goOrdersPage(ordersPagination.page + 1)"
                    >
                      <ChevronRight class="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div v-if="ordersError" class="rounded-xl border border-red-100 bg-red-50/50 p-3 text-sm text-red-600">
                  {{ ordersError }}
                </div>
                <div v-else-if="ordersLoading" class="text-sm text-gray-500">
                  加载中…
                </div>
                <div v-else-if="orders.length === 0" class="text-sm text-gray-500">
                  暂无订单
                </div>
                <div v-else class="overflow-x-auto">
                  <table class="min-w-full text-sm">
                    <thead>
                      <tr class="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                        <th class="py-3 text-left">订单号</th>
                        <th class="py-3 text-left">状态</th>
                        <th class="py-3 text-right">金额</th>
                        <th class="py-3 text-left">创建时间</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-gray-100">
                      <tr v-for="order in orders" :key="order.orderNo">
                        <td class="py-3 pr-4 text-gray-900">
                          <div class="font-medium">{{ order.orderNo }}</div>
                          <div class="text-xs text-gray-500">{{ order.productName }}</div>
                        </td>
                        <td class="py-3 px-2">
                          <span :class="['inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold', orderStatusClass(order.status)]">
                            {{ orderStatusLabel(order.status) }}
                          </span>
                        </td>
                        <td class="py-3 px-2 text-right text-gray-900 tabular-nums">
                          ¥ {{ order.amount }}
                        </td>
                        <td class="py-3 pl-4 text-gray-600 whitespace-nowrap">
                          {{ formatDate(order.createdAt) }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      <!-- Edit user dialog -->
      <Dialog v-model:open="editDialogOpen" @update:open="(open) => { if (!open) closeEditDialog() }">
        <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
          <DialogHeader class="px-8 pt-8 pb-4">
            <DialogTitle class="text-2xl font-bold text-gray-900">编辑用户</DialogTitle>
            <DialogDescription class="text-gray-500">
              修改用户名与邮箱。
            </DialogDescription>
          </DialogHeader>
          <div class="px-8 pb-4 space-y-4">
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">用户名</Label>
              <Input
                v-model="editUsername"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                placeholder="请输入用户名"
                :disabled="editLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">邮箱</Label>
              <Input
                v-model="editEmail"
                type="email"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                placeholder="请输入邮箱"
                :disabled="editLoading"
              />
            </div>
            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">邀请功能</Label>
              <select
                v-model="editInviteEnabled"
                class="h-11 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-100"
                :disabled="editLoading"
              >
                <option :value="true">开启</option>
                <option :value="false">关闭</option>
              </select>
            </div>
          </div>
          <DialogFooter class="px-8 pb-8 pt-0">
            <div class="flex items-center justify-end gap-3 w-full">
              <Button
                type="button"
                variant="outline"
                class="h-11 rounded-xl border-gray-200"
                :disabled="editLoading"
                @click="closeEditDialog"
              >
                取消
              </Button>
              <Button
                type="button"
                class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white"
                :disabled="editLoading"
                @click="saveUserEdits"
              >
                {{ editLoading ? '保存中...' : '保存' }}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- Delete confirm dialog -->
      <Dialog v-model:open="deleteDialogOpen" @update:open="(open) => { if (!open) closeDeleteDialog() }">
        <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
          <DialogHeader class="px-8 pt-8 pb-4">
            <DialogTitle class="text-2xl font-bold text-gray-900">删除用户</DialogTitle>
            <DialogDescription class="text-gray-500">
              此操作不可恢复，请确认。
            </DialogDescription>
          </DialogHeader>
          <div class="px-8 pb-4">
            <div class="rounded-2xl border border-red-100 bg-red-50/50 p-4 text-sm text-red-700">
              将删除用户：<span class="font-semibold">{{ deletingUser?.username }}</span>（{{ deletingUser?.email }}）
            </div>
          </div>
          <DialogFooter class="px-8 pb-8 pt-0">
            <div class="flex items-center justify-end gap-3 w-full">
              <Button
                type="button"
                variant="outline"
                class="h-11 rounded-xl border-gray-200"
                :disabled="deleteLoading"
                @click="closeDeleteDialog"
              >
                取消
              </Button>
              <Button
                type="button"
                class="h-11 rounded-xl bg-red-600 hover:bg-red-700 text-white"
                :disabled="deleteLoading"
                @click="confirmDeleteUser"
              >
                {{ deleteLoading ? '删除中...' : '确认删除' }}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- Set points dialog -->
      <Dialog v-model:open="setPointsDialogOpen" @update:open="(open) => { if (!open) closeSetPointsDialog() }">
        <DialogContent class="sm:max-w-[520px] p-0 overflow-hidden bg-white border-none shadow-2xl rounded-3xl">
          <DialogHeader class="px-8 pt-8 pb-4">
            <DialogTitle class="text-2xl font-bold text-gray-900">设置积分</DialogTitle>
            <DialogDescription class="text-gray-500">
              将用户积分设置为指定整数（不允许负数），用户侧原因固定展示为「系统调整」。
            </DialogDescription>
          </DialogHeader>
          <div class="px-8 pb-4 space-y-4">
            <div class="rounded-2xl border border-gray-100 bg-gray-50/50 p-4 text-sm">
              <div class="flex items-center justify-between gap-4">
                <span class="text-gray-500">用户</span>
                <span class="font-medium text-gray-900">{{ setPointsUser?.username || '-' }} (#{{ setPointsUser?.id ?? '-' }})</span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-4">
                <span class="text-gray-500">当前积分</span>
                <span class="font-semibold text-gray-900 tabular-nums">{{ setPointsCurrentValue }}</span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-4">
                <span class="text-gray-500">目标积分</span>
                <span class="font-semibold text-gray-900 tabular-nums">
                  <template v-if="setPointsTargetValue != null">{{ setPointsTargetValue }}</template>
                  <template v-else>-</template>
                </span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-4">
                <span class="text-gray-500">变更预览</span>
                <span
                  class="font-semibold tabular-nums"
                  :class="setPointsDelta == null ? 'text-gray-500' : (setPointsDelta >= 0 ? 'text-emerald-600' : 'text-red-600')"
                >
                  <template v-if="setPointsDelta != null">
                    {{ setPointsDelta >= 0 ? '+' : '' }}{{ setPointsDelta }}
                  </template>
                  <template v-else>-</template>
                </span>
              </div>
              <div class="mt-2 flex items-center justify-between gap-4">
                <span class="text-gray-500">用户侧原因</span>
                <span class="font-medium text-gray-900">系统调整</span>
              </div>
            </div>

            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">目标积分</Label>
              <Input
                v-model="setPointsTarget"
                inputmode="numeric"
                pattern="[0-9]*"
                placeholder="请输入 0 以上整数"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                :disabled="setPointsLoading"
              />
            </div>

            <div class="space-y-2">
              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">再次确认目标积分</Label>
              <Input
                v-model="setPointsConfirm"
                inputmode="numeric"
                pattern="[0-9]*"
                placeholder="请再次输入目标积分"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                :disabled="setPointsLoading"
              />
            </div>

            <div v-if="setPointsError" class="rounded-xl border border-red-100 bg-red-50/50 p-3 text-sm text-red-600">
              {{ setPointsError }}
            </div>
          </div>
          <DialogFooter class="px-8 pb-8 pt-0">
            <div class="flex items-center justify-end gap-3 w-full">
              <Button
                type="button"
                variant="outline"
                class="h-11 rounded-xl border-gray-200"
                :disabled="setPointsLoading"
                @click="closeSetPointsDialog"
              >
                取消
              </Button>
              <Button
                type="button"
                class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white"
                :disabled="!canSubmitSetPoints"
                @click="submitSetPoints"
              >
                {{ setPointsLoading ? '设置中...' : '确认设置' }}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
