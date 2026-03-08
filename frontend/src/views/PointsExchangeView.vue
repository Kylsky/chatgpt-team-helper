<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { authService, userService, type PointsLedgerRecord, type PointsWithdrawRecord } from '@/services/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useToast } from '@/components/ui/toast'
import { Coins, Gift, RefreshCw, Wallet, Link2 } from 'lucide-vue-next'

const router = useRouter()
const { success: showSuccessToast, error: showErrorToast } = useToast()

const teleportReady = ref(false)

const activeTab = ref<'exchange' | 'ledger'>('exchange')

const currentUser = ref(authService.getCurrentUser())
const syncCurrentUser = () => {
  currentUser.value = authService.getCurrentUser()
}

const points = ref(0)
const pointsMetaLoading = ref(false)
const teamSeatCostPoints = ref(15)
const teamSeatRemaining = ref(0)
const withdrawEnabled = ref(true)

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const teamSeatEmail = ref('')
const normalizedTeamSeatEmail = computed(() => teamSeatEmail.value.trim())
const isTeamSeatEmailValid = computed(() => EMAIL_REGEX.test(normalizedTeamSeatEmail.value))

const inviteUnlockCostPoints = ref(15)
const inviteUnlocking = ref(false)
const inviteUnlockError = ref('')
const hasInviteAbility = computed(() => Boolean(currentUser.value?.inviteEnabled))

const redeemingTeamSeat = ref(false)
const redeemTeamSeatError = ref('')

const withdrawPoints = ref('')
const withdrawMethod = ref<'alipay' | 'wechat'>('alipay')
const withdrawAccount = ref('')
const withdrawLoading = ref(false)
const withdrawError = ref('')

const withdrawRatePoints = ref(10)
const withdrawRateCashCents = ref(500)
const withdrawMinPoints = ref(10)
const withdrawStepPoints = ref(10)
const withdrawMaxPointsPerRequest = ref<number | null>(null)

const withdrawPointsText = computed(() => withdrawPoints.value.trim())
const withdrawPointsValue = computed(() => {
  if (!/^[0-9]+$/.test(withdrawPointsText.value)) return NaN
  return Number.parseInt(withdrawPointsText.value, 10)
})

const withdrawCashCents = computed(() => {
  const value = withdrawPointsValue.value
  if (!Number.isFinite(value) || value <= 0) return 0
  const ratePoints = Math.max(1, Math.round(withdrawRatePoints.value) || 10)
  const rateCashCents = Math.max(0, Math.round(withdrawRateCashCents.value) || 500)
  return Math.round((value * rateCashCents) / ratePoints)
})

const withdrawCashAmount = computed(() => {
  const yuan = withdrawCashCents.value / 100
  return Number.isFinite(yuan) ? yuan.toFixed(2) : '0.00'
})

const withdrawalsLoading = ref(false)
const withdrawals = ref<PointsWithdrawRecord[]>([])

const ledgerLoading = ref(false)
const ledger = ref<PointsLedgerRecord[]>([])
const ledgerBeforeId = ref<number | null>(null)
const ledgerHasMore = ref(false)
const ledgerNextBeforeId = ref<number | null>(null)
const ledgerBeforeIdStack = ref<Array<number | null>>([])
const ledgerPage = computed(() => ledgerBeforeIdStack.value.length + 1)
const refreshLoading = computed(() => {
  if (pointsMetaLoading.value) return true
  if (activeTab.value === 'exchange') return withdrawalsLoading.value
  if (activeTab.value === 'ledger') return ledgerLoading.value
  return false
})

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

const seatButtonLabel = computed(() => {
  if (redeemingTeamSeat.value) return '兑换中...'
  if (teamSeatRemaining.value <= 0) return '今日已兑完'
  if (points.value < teamSeatCostPoints.value) return '积分不足'
  if (!isTeamSeatEmailValid.value) return '请输入邮箱'
  return '立即兑换'
})

const canRedeemSeat = computed(() => {
  if (redeemingTeamSeat.value) return false
  if (teamSeatRemaining.value <= 0) return false
  if (points.value < teamSeatCostPoints.value) return false
  if (!isTeamSeatEmailValid.value) return false
  return true
})

const loadPointsMeta = async () => {
  pointsMetaLoading.value = true
  try {
    const result = await userService.getPointsMeta()
    points.value = Number(result.points || 0)
    teamSeatCostPoints.value = Number(result.seat?.costPoints || 15)
    teamSeatRemaining.value = Number(result.seat?.remaining || 0)
    withdrawEnabled.value = Boolean(result.withdraw?.enabled)

    withdrawRatePoints.value = Number(result.withdraw?.rate?.points || 10)
    withdrawRateCashCents.value = Number(result.withdraw?.rate?.cashCents || 500)
    withdrawMinPoints.value = Number(result.withdraw?.minPoints || 10)
    withdrawStepPoints.value = Number(result.withdraw?.stepPoints || 10)
    const maxPerRequest = result.withdraw?.maxPointsPerRequest
    withdrawMaxPointsPerRequest.value = maxPerRequest != null ? Number(maxPerRequest) : null
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '加载积分兑换信息失败')
  } finally {
    pointsMetaLoading.value = false
  }
}

const loadWithdrawals = async () => {
  withdrawalsLoading.value = true
  try {
    const result = await userService.listWithdrawals(20)
    withdrawals.value = Array.isArray(result.withdrawals) ? result.withdrawals : []
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '加载提现记录失败')
  } finally {
    withdrawalsLoading.value = false
  }
}

const loadLedger = async () => {
  ledgerLoading.value = true
  try {
    const result = await userService.listPointsLedger(20, ledgerBeforeId.value ?? undefined)
    ledger.value = Array.isArray(result.records) ? result.records : []
    ledgerHasMore.value = Boolean(result.page?.hasMore)
    ledgerNextBeforeId.value = result.page?.nextBeforeId ?? null
  } catch (err: any) {
    showErrorToast(err.response?.data?.error || '加载积分明细失败')
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
  if (ledgerLoading.value) return
  if (ledgerBeforeIdStack.value.length === 0) return
  ledgerBeforeId.value = ledgerBeforeIdStack.value.pop() ?? null
  await loadLedger()
}

const goLedgerNextPage = async () => {
  if (ledgerLoading.value) return
  if (!ledgerHasMore.value || !ledgerNextBeforeId.value) return
  ledgerBeforeIdStack.value.push(ledgerBeforeId.value)
  ledgerBeforeId.value = ledgerNextBeforeId.value
  await loadLedger()
}

const refreshAll = async () => {
  const tasks = [loadPointsMeta()]
  if (activeTab.value === 'exchange') tasks.push(loadWithdrawals())
  if (activeTab.value === 'ledger') tasks.push(loadLedger())
  await Promise.all(tasks)
}

const inviteUnlockButtonLabel = computed(() => {
  if (inviteUnlocking.value) return '兑换中...'
  if (points.value < inviteUnlockCostPoints.value) return '积分不足'
  return '立即兑换'
})

const canRedeemInviteUnlock = computed(() => {
  if (inviteUnlocking.value) return false
  if (points.value < inviteUnlockCostPoints.value) return false
  return true
})

const redeemInviteUnlock = async () => {
  inviteUnlockError.value = ''
  if (hasInviteAbility.value) return

  if (!canRedeemInviteUnlock.value) {
    inviteUnlockError.value = `积分不足（需要 ${inviteUnlockCostPoints.value} 积分）`
    showErrorToast(inviteUnlockError.value)
    return
  }

  inviteUnlocking.value = true
  try {
    const result = await userService.redeemInviteUnlock()
    points.value = Number(result.points || 0)
    inviteUnlockCostPoints.value = Number(result.invite?.costPoints || inviteUnlockCostPoints.value)

    showSuccessToast(result.message || '邀请权限已开通')
    await resetLedgerPagination()

    try {
      const me = await userService.getMe()
      authService.setCurrentUser(me)
      currentUser.value = me
    } catch (refreshError) {
      console.warn('Refresh current user after invite unlock failed:', refreshError)
    }
  } catch (err: any) {
    inviteUnlockError.value = err.response?.data?.error || '兑换失败'
    showErrorToast(inviteUnlockError.value)
  } finally {
    inviteUnlocking.value = false
  }
}

const redeemTeamSeat = async () => {
  redeemTeamSeatError.value = ''
  const email = normalizedTeamSeatEmail.value
  if (!EMAIL_REGEX.test(email)) {
    redeemTeamSeatError.value = '请输入有效的邮箱地址'
    showErrorToast(redeemTeamSeatError.value)
    return
  }

  if (!canRedeemSeat.value) {
    if (points.value < teamSeatCostPoints.value) {
      redeemTeamSeatError.value = `积分不足（需要 ${teamSeatCostPoints.value} 积分）`
    } else if (teamSeatRemaining.value <= 0) {
      redeemTeamSeatError.value = '今日可兑换名额不足'
    } else {
      redeemTeamSeatError.value = '暂时无法兑换'
    }
    showErrorToast(redeemTeamSeatError.value)
    return
  }

  redeemingTeamSeat.value = true
  try {
    const result = await userService.redeemTeamSeat({ email })
    points.value = Number(result.points || 0)
    teamSeatCostPoints.value = Number(result.seat?.costPoints || teamSeatCostPoints.value)
    teamSeatRemaining.value = Number(result.seat?.remaining || 0)

    const inviteStatus = String(result.redemption?.data?.inviteStatus || '').trim()
    showSuccessToast(inviteStatus ? `兑换成功：${inviteStatus}` : (result.message || '兑换成功'))
    await resetLedgerPagination()
  } catch (err: any) {
    redeemTeamSeatError.value = err.response?.data?.error || '兑换失败'
    showErrorToast(redeemTeamSeatError.value)
  } finally {
    redeemingTeamSeat.value = false
  }
}

const submitWithdraw = async () => {
  withdrawError.value = ''
  if (!withdrawEnabled.value) {
    withdrawError.value = '提现功能暂未开放'
    showErrorToast(withdrawError.value)
    return
  }

  const pointsValue = withdrawPointsValue.value
  if (!Number.isFinite(pointsValue) || pointsValue <= 0) {
    withdrawError.value = '请输入有效的提现积分'
    showErrorToast(withdrawError.value)
    return
  }
  if (pointsValue < withdrawMinPoints.value) {
    withdrawError.value = `最低提现 ${withdrawMinPoints.value} 积分`
    showErrorToast(withdrawError.value)
    return
  }
  if (withdrawStepPoints.value > 1 && pointsValue % withdrawStepPoints.value !== 0) {
    withdrawError.value = `提现积分需为 ${withdrawStepPoints.value} 的倍数`
    showErrorToast(withdrawError.value)
    return
  }
  if (withdrawMaxPointsPerRequest.value && withdrawMaxPointsPerRequest.value > 0 && pointsValue > withdrawMaxPointsPerRequest.value) {
    withdrawError.value = `单次最多提现 ${withdrawMaxPointsPerRequest.value} 积分`
    showErrorToast(withdrawError.value)
    return
  }
  if (pointsValue > points.value) {
    withdrawError.value = '积分不足，无法提现'
    showErrorToast(withdrawError.value)
    return
  }
  if (!withdrawAccount.value.trim()) {
    withdrawError.value = '请输入收款账号'
    showErrorToast(withdrawError.value)
    return
  }

  withdrawLoading.value = true
  try {
    const result = await userService.requestWithdrawal({
      points: pointsValue,
      method: withdrawMethod.value,
      payoutAccount: withdrawAccount.value.trim(),
    })
    points.value = Number(result.points || 0)
    showSuccessToast(result.message || '提现申请已提交')
    withdrawPoints.value = ''
    withdrawAccount.value = ''
    await loadWithdrawals()
    await resetLedgerPagination()
  } catch (err: any) {
    withdrawError.value = err.response?.data?.error || '提现失败'
    showErrorToast(withdrawError.value)
  } finally {
    withdrawLoading.value = false
  }
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')
  currentUser.value = authService.getCurrentUser()
  window.addEventListener('auth-updated', syncCurrentUser)

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  try {
    const me = await userService.getMe()
    authService.setCurrentUser(me)
    currentUser.value = me
    if (!teamSeatEmail.value.trim()) {
      teamSeatEmail.value = String(me?.email || '').trim()
    }
  } catch (error: any) {
    if (error?.response?.status === 401 || error?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
  }

  await refreshAll()
})

watch(activeTab, async (value) => {
  if (value !== 'ledger') return
  if (ledgerLoading.value) return
  if (ledger.value.length > 0) return
  await resetLedgerPagination()
})

onUnmounted(() => {
  teleportReady.value = false
  window.removeEventListener('auth-updated', syncCurrentUser)
})
</script>

<template>
  <Tabs v-model="activeTab" class="space-y-8">
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-3">
        <TabsList class="bg-gray-100/70 border border-gray-200 rounded-xl p-1">
          <TabsTrigger value="exchange" class="rounded-lg px-4">
            积分兑换
          </TabsTrigger>
          <TabsTrigger value="ledger" class="rounded-lg px-4">
            变更明细
          </TabsTrigger>
        </TabsList>

        <Button
          variant="outline"
          class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
          :disabled="refreshLoading"
          @click="refreshAll"
        >
          <RefreshCw class="h-4 w-4 mr-2" :class="refreshLoading ? 'animate-spin' : ''" />
          刷新
        </Button>
      </div>
    </Teleport>

    <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
      <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
        <CardTitle class="text-xl font-bold text-gray-900">可用积分</CardTitle>
        <CardDescription class="text-gray-500">
          兑换名额或提交提现申请（兑换会向填写的邮箱发送邀请）。
        </CardDescription>
      </CardHeader>
      <CardContent class="p-8">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
              <Coins class="w-6 h-6" />
            </div>
            <div>
              <div class="text-sm font-semibold text-gray-900">当前积分</div>
              <div class="text-xs text-gray-500">
                {{ currentUser?.email || '-' }}
              </div>
            </div>
          </div>
          <div class="text-4xl font-bold text-gray-900 tabular-nums">
            {{ points }}
          </div>
        </div>
      </CardContent>
    </Card>

    <TabsContent value="exchange" class="mt-0">
      <div class="grid gap-8 lg:grid-cols-2">
        <Card v-if="!hasInviteAbility" class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden lg:col-span-2">
          <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                <Link2 class="w-5 h-5" />
              </div>
              <div>
                <CardTitle class="text-xl font-bold text-gray-900">开通邀请权限</CardTitle>
                <CardDescription class="text-gray-500">仅可兑换一次 · {{ inviteUnlockCostPoints }} 积分</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent class="p-8 space-y-6">
            <div class="rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4 text-sm text-gray-600">
              开通后可在「用户信息」页面查看邀请数据并生成邀请链接。
            </div>

            <div v-if="inviteUnlockError" class="text-sm text-red-600">
              {{ inviteUnlockError }}
            </div>

            <Button
              class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white w-full"
              :disabled="!canRedeemInviteUnlock"
              @click="redeemInviteUnlock"
            >
              {{ inviteUnlockButtonLabel }}
            </Button>
          </CardContent>
        </Card>

	        <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
	          <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
	            <div class="flex items-center gap-3">
	              <div class="w-10 h-10 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center">
	                <Gift class="w-5 h-5" />
	              </div>
	              <div>
		                <CardTitle class="text-xl font-bold text-gray-900">兑换 ChatGPT Team 名额</CardTitle>
	                <CardDescription class="text-gray-500">30 天 · {{ teamSeatCostPoints }} 积分</CardDescription>
	              </div>
	            </div>
		          </CardHeader>
		          <CardContent class="p-8 space-y-6">
		            <div class="space-y-2">
		              <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">接收邀请邮箱</Label>
		              <Input
		                v-model="teamSeatEmail"
                type="email"
                class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                placeholder="输入邮箱地址..."
                :disabled="redeemingTeamSeat"
                @keydown.enter.prevent="redeemTeamSeat"
              />
              <div class="text-xs text-gray-500">
                邀请将发送至该邮箱。
              </div>
	            </div>
	
	            <div class="flex items-center justify-between rounded-2xl border border-gray-100 bg-gray-50/40 px-5 py-4">
	              <div>
	                <div class="text-sm font-semibold text-gray-900">今日剩余名额</div>
	              </div>
	              <div class="text-2xl font-bold text-gray-900 tabular-nums">
	                {{ teamSeatRemaining }}
	              </div>
	            </div>

            <div v-if="redeemTeamSeatError" class="text-sm text-red-600">
              {{ redeemTeamSeatError }}
            </div>

            <Button
              class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white w-full"
              :disabled="!canRedeemSeat"
              @click="redeemTeamSeat"
            >
              {{ seatButtonLabel }}
            </Button>
          </CardContent>
        </Card>

        <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
          <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <Wallet class="w-5 h-5" />
              </div>
              <div>
                <CardTitle class="text-xl font-bold text-gray-900">提现</CardTitle>
                <CardDescription class="text-gray-500">提交申请后人工处理</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent class="p-8 space-y-6">
            <div class="grid gap-5">
              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">提现积分</Label>
                <Input
                  v-model="withdrawPoints"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                  placeholder="例如：10"
                  :disabled="withdrawLoading || !withdrawEnabled"
                />
                <div class="text-xs text-gray-500">
                  返现规则：{{ withdrawRatePoints }} 积分 = {{ (withdrawRateCashCents / 100).toFixed(2) }} 元，预计返现 {{ withdrawCashAmount }} 元
                </div>
              </div>

              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">收款方式</Label>
                <div class="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    class="h-11 rounded-2xl border backdrop-blur px-4 text-[14px] font-medium transition"
                    :class="withdrawMethod === 'alipay'
                      ? 'border-blue-500/40 bg-blue-500/10 text-[#007AFF]'
                      : 'border-black/5 bg-white/60 text-[#1d1d1f]/70 hover:bg-white/80'"
                    :disabled="withdrawLoading || !withdrawEnabled"
                    @click="withdrawMethod = 'alipay'"
                  >
                    支付宝
                  </button>
                  <button
                    type="button"
                    class="h-11 rounded-2xl border backdrop-blur px-4 text-[14px] font-medium transition"
                    :class="withdrawMethod === 'wechat'
                      ? 'border-blue-500/40 bg-blue-500/10 text-[#007AFF]'
                      : 'border-black/5 bg-white/60 text-[#1d1d1f]/70 hover:bg-white/80'"
                    :disabled="withdrawLoading || !withdrawEnabled"
                    @click="withdrawMethod = 'wechat'"
                  >
                    微信
                  </button>
                </div>
              </div>

              <div class="space-y-2">
                <Label class="text-xs font-semibold text-gray-500 uppercase tracking-wider">收款账号</Label>
                <Input
                  v-model="withdrawAccount"
                  class="h-11 bg-gray-50 border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-100 focus:border-blue-500"
                  placeholder="支付宝账号 / 微信号"
                  :disabled="withdrawLoading || !withdrawEnabled"
                  @keydown.enter.prevent="submitWithdraw"
                />
              </div>

              <div v-if="withdrawError" class="text-sm text-red-600">
                {{ withdrawError }}
              </div>

              <Button
                class="h-11 rounded-xl bg-black hover:bg-gray-800 text-white w-full"
                :disabled="withdrawLoading || !withdrawEnabled"
                @click="submitWithdraw"
              >
                {{ withdrawLoading ? '提交中...' : (withdrawEnabled ? '提交提现申请' : '未开放') }}
              </Button>
            </div>

            <div class="pt-4 border-t border-gray-100 space-y-3">
              <div class="text-xs font-semibold text-gray-500 uppercase tracking-wider">最近提现</div>

              <div v-if="withdrawalsLoading" class="text-sm text-gray-500">
                加载中…
              </div>
              <div v-else-if="withdrawals.length === 0" class="text-sm text-gray-500">
                暂无提现记录
              </div>
              <div v-else class="space-y-2">
                <div
                  v-for="item in withdrawals.slice(0, 3)"
                  :key="item.id"
                  class="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50/30 px-4 py-3"
                >
                  <div class="min-w-0">
                    <div class="text-sm font-semibold text-gray-900">-{{ item.points }} 积分</div>
                    <div v-if="item.cashAmount" class="text-xs text-gray-500">
                      返现 {{ item.cashAmount }} 元
                    </div>
                    <div class="text-xs text-gray-500 truncate">
                      {{ item.method === 'alipay' ? '支付宝' : (item.method === 'wechat' ? '微信' : item.method) }} · {{ item.payoutAccount }}
                    </div>
                  </div>
                  <div class="text-xs font-semibold text-gray-600">
                    {{ item.status }}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </TabsContent>

    <TabsContent value="ledger" class="mt-0">
      <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
        <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-8 py-6">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center">
                <Coins class="w-5 h-5" />
              </div>
              <div>
                <CardTitle class="text-xl font-bold text-gray-900">积分变更明细</CardTitle>
                <CardDescription class="text-gray-500">第 {{ ledgerPage }} 页</CardDescription>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <Button
                variant="outline"
                class="h-10 rounded-xl bg-white border-gray-200"
                :disabled="ledgerLoading || ledgerBeforeIdStack.length === 0"
                @click="goLedgerPrevPage"
              >
                上一页
              </Button>
              <Button
                variant="outline"
                class="h-10 rounded-xl bg-white border-gray-200"
                :disabled="ledgerLoading || !ledgerHasMore"
                @click="goLedgerNextPage"
              >
                下一页
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent class="p-8">
          <div v-if="ledgerLoading" class="text-sm text-gray-500">
            加载中…
          </div>
          <div v-else-if="ledger.length === 0" class="text-sm text-gray-500">
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
                <tr v-for="item in ledger" :key="item.id">
                  <td class="py-3 pr-4 text-gray-600 whitespace-nowrap tabular-nums">
                    {{ item.createdAt || '' }}
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
        </CardContent>
      </Card>
    </TabsContent>
  </Tabs>
</template>
