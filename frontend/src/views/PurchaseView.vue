<template>
  <RedeemShell :maxWidth="'max-w-[520px]'" showUserStatusBar>
    <div class="text-center space-y-6">
      <div
        class="inline-flex items-center gap-2.5 rounded-full bg-white/60 dark:bg-white/10 backdrop-blur-xl border border-white/40 dark:border-white/10 px-4 py-1.5 shadow-sm transition-transform hover:scale-105 duration-300 cursor-default"
      >
        <span class="relative flex h-2.5 w-2.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#007AFF]"></span>
        </span>
        <span class="text-[13px] font-medium text-gray-600 dark:text-gray-300 tracking-wide">
          今日库存 · {{ currentPlan?.availableCount ?? meta?.availableCount ?? '...' }} 个
        </span>
      </div>

      <div class="space-y-3">
        <h1
          class="text-[40px] leading-tight font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 dark:from-blue-400 dark:via-purple-400 dark:to-pink-400 drop-shadow-sm animate-gradient-x"
        >
          购买
        </h1>
        <p class="text-[15px] text-[#86868b]">
          下单后完成支付，系统自动处理，订单信息发送到邮箱。
          <RouterLink class="text-[#007AFF] hover:text-[#005FCC] font-medium" to="/order">查询订单</RouterLink>
        </p>
      </div>
    </div>

    <div class="relative group perspective-1000">
      <div
        class="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-[2rem] blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200 animate-tilt"
      ></div>
      <AppleCard
        variant="glass"
        class="relative overflow-hidden shadow-2xl shadow-black/10 border border-white/40 dark:border-white/10 ring-1 ring-black/5 backdrop-blur-3xl transition-all duration-500 hover:shadow-3xl hover:scale-[1.01] animate-float"
      >
        <div class="p-8 sm:p-10 space-y-8">
          <div class="space-y-2">
            <p class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider">订单类型</p>
            <div
              class="grid gap-3"
              :class="warrantyPlan && noWarrantyPlan ? 'grid-cols-2' : 'grid-cols-1'"
            >
              <button
                v-if="warrantyPlan"
                type="button"
                class="rounded-2xl border backdrop-blur px-4 py-3 text-left text-[14px] font-medium transition"
                :class="orderType === 'warranty'
                  ? 'border-blue-500/40 bg-blue-500/10 text-[#007AFF]'
                  : 'border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 text-[#1d1d1f]/70 dark:text-white/70 hover:bg-white/60'"
                :disabled="creating"
                @click="orderType = 'warranty'"
              >
                <div class="flex items-center justify-between">
                  <span>质保</span>
                  <span class="tabular-nums">¥ {{ warrantyPlan?.amount ?? meta?.amount ?? '...' }}</span>
                </div>
                <p class="mt-1 text-[12px] text-[#86868b]">支持退款 / 补号</p>
              </button>
              <button
                v-if="noWarrantyPlan"
                type="button"
                class="rounded-2xl border backdrop-blur px-4 py-3 text-left text-[14px] font-medium transition"
                :class="orderType === 'no_warranty'
                  ? 'border-blue-500/40 bg-blue-500/10 text-[#007AFF]'
                  : 'border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 text-[#1d1d1f]/70 dark:text-white/70 hover:bg-white/60'"
                :disabled="creating"
                @click="orderType = 'no_warranty'"
              >
                <div class="flex items-center justify-between">
                  <span>无质保</span>
                  <span class="tabular-nums">¥ {{ noWarrantyPlan?.amount ?? '5.00' }}</span>
                </div>
                <p class="mt-1 text-[12px] text-[#86868b]">仅提供首次登陆咨询</p>
              </button>
            </div>
          </div>

          <div class="rounded-2xl bg-white/50 dark:bg-black/20 border border-black/5 dark:border-white/10 p-4">
            <div class="flex items-center justify-between">
              <p class="text-[14px] text-[#1d1d1f]/80 dark:text-white/80">
                {{ currentPlan?.productName || meta?.productName || '通用渠道激活码' }}
              </p>
              <p class="text-[15px] font-semibold tabular-nums text-[#1d1d1f] dark:text-white">
                ¥ {{ currentPlan?.amount || meta?.amount || '...' }}
              </p>
            </div>
            <div class="mt-1 space-y-1 text-[13px] text-[#86868b]">
              <p>
                有效期：{{ currentPlan?.serviceDays ?? meta?.serviceDays ?? 30 }} 天（下单日起算）
              </p>
              <p>
                购买奖励： +{{ currentPlan?.buyerRewardPoints ?? (orderType === 'no_warranty' ? 1 : '...') }} 积分
              </p>
            </div>
          </div>

          <form @submit.prevent="handleCreateOrder" class="space-y-6">
            <AppleInput
              v-model.trim="email"
              label="邮箱地址"
              placeholder="name@example.com"
              type="email"
              variant="filled"
              :disabled="creating"
              helperText="用于接收订单信息（也是开通邮箱）"
              :error="email && !isValidEmail ? '请输入有效的邮箱格式' : ''"
            />

            <div class="space-y-2">
              <p class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider">支付方式</p>
              <div class="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  class="h-11 rounded-2xl border backdrop-blur px-4 text-[14px] font-medium transition"
                  :class="payType === 'alipay'
                    ? 'border-blue-500/40 bg-blue-500/10 text-[#007AFF]'
                    : 'border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 text-[#1d1d1f]/70 dark:text-white/70 hover:bg-white/60'"
                  :disabled="creating"
                  @click="payType = 'alipay'"
                >
                  支付宝
                </button>
                <button
                  type="button"
                  class="h-11 rounded-2xl border backdrop-blur px-4 text-[14px] font-medium transition"
                  :class="payType === 'wxpay'
                    ? 'border-blue-500/40 bg-blue-500/10 text-[#007AFF]'
                    : 'border-black/5 dark:border-white/10 bg-white/40 dark:bg-black/20 text-[#1d1d1f]/70 dark:text-white/70 hover:bg-white/60'"
                  :disabled="creating"
                  @click="payType = 'wxpay'"
                >
                  微信
                </button>
              </div>
            </div>

            <AppleButton
              type="submit"
              variant="primary"
              size="lg"
              class="w-full h-[50px] text-[17px] font-medium shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
              :loading="creating"
              :disabled="creating || isSoldOut"
            >
              {{ isSoldOut ? '今日已售罄' : (creating ? '正在创建订单...' : '立即购买') }}
            </AppleButton>
          </form>

          <div v-if="errorMessage" class="animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out-expo">
            <div class="rounded-2xl bg-[#FF3B30]/10 border border-[#FF3B30]/20 p-5 flex gap-4">
              <div class="flex-shrink-0 mt-0.5">
                <div class="h-6 w-6 rounded-full bg-[#FF3B30] flex items-center justify-center shadow-sm">
                  <AlertCircle class="h-4 w-4 text-white" />
                </div>
              </div>
              <div class="flex-1">
                <h3 class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">操作失败</h3>
                <p class="mt-1 text-[14px] text-[#1d1d1f]/80 dark:text-white/80">{{ errorMessage }}</p>
              </div>
            </div>
          </div>

          <div v-if="order" class="rounded-2xl bg-white/50 dark:bg-black/20 border border-black/5 dark:border-white/10 p-5 space-y-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-[13px] text-[#86868b]">订单号</p>
                <p class="text-[15px] font-semibold tabular-nums text-[#1d1d1f] dark:text-white">{{ order.orderNo }}</p>
              </div>
              <div class="text-right">
                <p class="text-[13px] text-[#86868b]">状态</p>
                <p class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">{{ orderStatusLabel }}</p>
              </div>
            </div>

            <div v-if="order.img" class="flex items-center justify-center">
              <img :src="order.img" alt="支付二维码" class="h-[220px] w-[220px] rounded-xl bg-white p-2" />
            </div>

            <div class="grid grid-cols-2 gap-3">
              <AppleButton
                type="button"
                variant="secondary"
                size="lg"
                class="h-[44px]"
                :disabled="!order.payUrl"
                @click="openPayUrl"
              >
                打开支付页
              </AppleButton>
              <AppleButton type="button" variant="primary" size="lg" class="h-[44px]" :loading="refreshing" @click="refreshOrder({ sync: true })">
                刷新状态
              </AppleButton>
            </div>

            <p v-if="orderPaidHint" class="text-[14px] text-[#34C759] font-medium text-center">
              {{ orderPaidHint }}
            </p>
          </div>

          <div class="pt-6 border-t border-gray-200/60 dark:border-white/10">
            <h4 class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-4">购买须知</h4>
            <ul class="space-y-3 text-[14px] text-[#1d1d1f]/70 dark:text-white/70">
              <li class="flex items-start gap-3">
                <span class="h-1.5 w-1.5 rounded-full bg-[#007AFF] mt-2 flex-shrink-0"></span>
                <span>订单信息将发送至填写的邮箱，请确认邮箱可正常收信。</span>
              </li>
              <li class="flex items-start gap-3">
                <span class="h-1.5 w-1.5 rounded-full bg-[#007AFF] mt-2 flex-shrink-0"></span>
                <span>支付成功后系统自动开通，无需手动兑换。</span>
              </li>
              <li class="flex items-start gap-3">
                <span class="h-1.5 w-1.5 rounded-full bg-[#007AFF] mt-2 flex-shrink-0"></span>
                <span>如未收到邮件请检查垃圾箱，或使用“查询订单”页进行订单查询。</span>
              </li>
            </ul>
          </div>
        </div>
      </AppleCard>
    </div>
  </RedeemShell>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import RedeemShell from '@/components/RedeemShell.vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import AppleInput from '@/components/ui/apple/Input.vue'
import AppleButton from '@/components/ui/apple/Button.vue'
import { purchaseService, type PurchaseMeta, type PurchasePlan, type PurchaseCreateOrderResponse, type PurchaseOrderQueryResponse, type PurchaseOrderType } from '@/services/api'
import { EMAIL_REGEX } from '@/lib/validation'
import { useToast } from '@/components/ui/toast'
import { AlertCircle } from 'lucide-vue-next'

const route = useRoute()

const meta = ref<PurchaseMeta | null>(null)
const email = ref('')
const payType = ref<'alipay' | 'wxpay'>('alipay')
const orderType = ref<PurchaseOrderType>('warranty')
const creating = ref(false)
const refreshing = ref(false)
const errorMessage = ref('')
const order = ref<PurchaseCreateOrderResponse | null>(null)
const orderDetail = ref<PurchaseOrderQueryResponse | null>(null)
const orderEmail = ref('')
const autoRefreshTimer = ref<number | null>(null)
const orderFetchInFlight = ref(false)

const { success: showSuccessToast, warning: showWarningToast } = useToast()

const normalizeOrderTypeFromQuery = (value: unknown): PurchaseOrderType | null => {
  const raw = Array.isArray(value) ? value[0] : value
  const normalized = String(raw ?? '').trim().toLowerCase()
  if (normalized === 'warranty') return 'warranty'
  if (normalized === 'no_warranty' || normalized === 'no-warranty' || normalized === 'nowarranty') return 'no_warranty'
  return null
}

watch(
  () => route.query.orderType,
  (value) => {
    const parsed = normalizeOrderTypeFromQuery(value)
    if (parsed) orderType.value = parsed
  },
  { immediate: true }
)

const isValidEmail = computed(() => {
  if (!email.value) return true
  return EMAIL_REGEX.test(email.value.trim())
})

const plans = computed<PurchasePlan[]>(() => meta.value?.plans || [])

const currentPlan = computed<PurchasePlan | null>(() => {
  if (!plans.value.length) return null
  const firstPlan = plans.value[0]
  if (!firstPlan) return null
  return plans.value.find(plan => plan.orderType === orderType.value) || firstPlan
})

const warrantyPlan = computed<PurchasePlan | null>(
  () => plans.value.find(plan => plan.orderType === 'warranty') || null
)

const noWarrantyPlan = computed<PurchasePlan | null>(
  () => plans.value.find(plan => plan.orderType === 'no_warranty') || null
)

const currentAvailableCount = computed(() => (
  currentPlan.value?.availableCount ?? meta.value?.availableCount ?? 0
))

const isSoldOut = computed(() => currentAvailableCount.value <= 0)

const orderStatusLabel = computed(() => {
  const status = orderDetail.value?.order?.status || (order.value ? 'pending_payment' : '')
  if (status === 'paid') return '已支付'
  if (status === 'refunded') return '已退款'
  if (status === 'expired') return '已过期'
  if (status === 'failed') return '失败'
  if (status === 'pending_payment') return '待支付'
  return status || '待支付'
})

const orderPaidHint = computed(() => {
  const order = orderDetail.value?.order
  if (!order) return ''
  if (order.status !== 'paid') return ''
  if (order.redeemError) {
    return `支付成功，但自动开通失败：${order.redeemError}`
  }
  if (order.inviteStatus) {
    return `支付成功，${order.inviteStatus}`
  }
  if (order.emailSentAt) {
    return '支付成功，订单信息已发送至邮箱。'
  }
  return '支付成功，处理中（如未生效请稍后在查询页查看）。'
})

const loadMeta = async () => {
  try {
    meta.value = await purchaseService.getMeta()
    if (meta.value?.plans?.length) {
      const hasSelected = meta.value.plans.some(plan => plan.orderType === orderType.value)
      if (!hasSelected) {
        const firstPlan = meta.value.plans[0]
        if (firstPlan?.orderType) {
          orderType.value = firstPlan.orderType
        }
      }
    }
  } catch (error: any) {
    errorMessage.value = error?.response?.data?.error || '加载库存失败，请稍后重试'
  }
}

onMounted(async () => {
  await loadMeta()
})

const stopAutoRefresh = () => {
  if (autoRefreshTimer.value) {
    window.clearInterval(autoRefreshTimer.value)
    autoRefreshTimer.value = null
  }
}

const shouldAutoRefresh = () => {
  const status = orderDetail.value?.order?.status || ''
  return Boolean(order.value) && !['paid', 'refunded', 'expired', 'failed'].includes(status)
}

const startAutoRefresh = () => {
  if (typeof window === 'undefined') return
  stopAutoRefresh()
  if (!shouldAutoRefresh()) return

  autoRefreshTimer.value = window.setInterval(() => {
    if (!shouldAutoRefresh()) {
      stopAutoRefresh()
      return
    }
    void fetchOrderDetail({ showLoading: false })
  }, 5000)
}

const handleCreateOrder = async () => {
  errorMessage.value = ''
  order.value = null
  orderDetail.value = null
  orderEmail.value = ''
  stopAutoRefresh()

  const normalizedEmail = email.value.trim()
  if (!normalizedEmail) {
    errorMessage.value = '请输入邮箱地址'
    return
  }
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    errorMessage.value = '请输入有效的邮箱地址'
    return
  }

  creating.value = true
  try {
    if (!currentPlan.value?.key) {
      errorMessage.value = '商品信息缺失，请刷新页面重试'
      return
    }
    orderEmail.value = normalizedEmail
    order.value = await purchaseService.createOrder({
      email: normalizedEmail,
      type: payType.value,
      productKey: currentPlan.value.key,
      orderType: orderType.value
    })
    await refreshOrder()
    startAutoRefresh()
    await loadMeta()
  } catch (error: any) {
    errorMessage.value = error?.response?.data?.error || '创建订单失败，请稍后再试'
    await loadMeta()
  } finally {
    creating.value = false
  }
}

const fetchOrderDetail = async ({ showLoading, sync }: { showLoading: boolean; sync?: boolean }) => {
  if (!order.value) return
  if (orderFetchInFlight.value) return
  orderFetchInFlight.value = true
  if (showLoading) refreshing.value = true
  try {
    const queryEmail = orderEmail.value || email.value.trim()
    orderDetail.value = await purchaseService.getOrder(order.value.orderNo, queryEmail, { sync })
  } catch (error: any) {
    if (showLoading) {
      errorMessage.value = error?.response?.data?.error || '查询订单失败，请稍后再试'
    }
  } finally {
    if (showLoading) refreshing.value = false
    orderFetchInFlight.value = false
  }
}

const refreshOrder = async ({ sync = false }: { sync?: boolean } = {}) => {
  await fetchOrderDetail({ showLoading: true, sync })
}

const openPayUrl = () => {
  const url = order.value?.payUrl
  if (!url) return
  window.open(url, '_blank')
}

watch(
  () => orderDetail.value?.order?.status,
  (status, previous) => {
    if (!status || status === previous) return

    if (status === 'paid') {
      showSuccessToast(orderPaidHint.value || '支付成功，正在为你处理订单')
    } else if (status === 'expired') {
      showWarningToast('订单已过期，请重新下单')
    } else if (status === 'failed') {
      showWarningToast('订单状态异常，请稍后重试或联系客服')
    } else if (status === 'refunded') {
      showWarningToast('订单已退款')
    }

    if (['paid', 'refunded', 'expired', 'failed'].includes(status)) {
      stopAutoRefresh()
    }
  }
)

onBeforeUnmount(() => {
  stopAutoRefresh()
})
</script>

<style scoped>
.ease-out-expo {
  transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
}
</style>
