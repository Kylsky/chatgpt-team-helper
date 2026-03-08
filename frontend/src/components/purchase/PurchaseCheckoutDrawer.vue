<script setup lang="ts">
import { computed, onBeforeUnmount, watch, ref } from 'vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import AppleInput from '@/components/ui/apple/Input.vue'
import AppleButton from '@/components/ui/apple/Button.vue'
import { purchaseService, type PurchaseCreateOrderResponse, type PurchaseOrderQueryResponse, type PurchasePlan } from '@/services/api'
import { EMAIL_REGEX } from '@/lib/validation'
import { useToast } from '@/components/ui/toast'
import { AlertCircle, X } from 'lucide-vue-next'

const props = defineProps<{
  open: boolean
  productKey: string
  plan: PurchasePlan | null
  availableCount: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'refresh-meta'): void
}>()

const email = ref('')
const payType = ref<'alipay' | 'wxpay'>('alipay')
const creating = ref(false)
const refreshing = ref(false)
const errorMessage = ref('')
const order = ref<PurchaseCreateOrderResponse | null>(null)
const orderDetail = ref<PurchaseOrderQueryResponse | null>(null)
const orderEmail = ref('')
const autoRefreshTimer = ref<number | null>(null)
const orderFetchInFlight = ref(false)
const isInitializedForOpen = ref(false)

const { success: showSuccessToast, warning: showWarningToast } = useToast()

const isSoldOut = computed(() => Number(props.availableCount || 0) <= 0)

const isValidEmail = computed(() => {
  if (!email.value) return true
  return EMAIL_REGEX.test(email.value.trim())
})

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
  const currentOrder = orderDetail.value?.order
  if (!currentOrder) return ''
  if (currentOrder.status !== 'paid') return ''
  if (currentOrder.redeemError) {
    return `支付成功，但自动开通失败：${currentOrder.redeemError}`
  }
  if (currentOrder.inviteStatus) {
    return `支付成功，${currentOrder.inviteStatus}`
  }
  if (currentOrder.emailSentAt) {
    return '支付成功，订单信息已发送至邮箱。'
  }
  return '支付成功，处理中（如未生效请稍后在查询页查看）。'
})

const close = () => {
  emit('close')
}

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

const openPayUrl = () => {
  const url = order.value?.payUrl
  if (!url) return
  window.open(url, '_blank')
}

const resetOrderState = () => {
  errorMessage.value = ''
  order.value = null
  orderDetail.value = null
  orderEmail.value = ''
  refreshing.value = false
  creating.value = false
  stopAutoRefresh()
}

const loadRememberedEmail = () => {
  if (typeof window === 'undefined') return
  if (email.value.trim()) return
  try {
    const remembered = String(localStorage.getItem('purchase:lastEmail') || '').trim()
    if (remembered) email.value = remembered
  } catch {
    // ignore
  }
}

const rememberEmail = (value: string) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem('purchase:lastEmail', value)
  } catch {
    // ignore
  }
}

const handleCreateOrder = async () => {
  errorMessage.value = ''

  if (isSoldOut.value) {
    errorMessage.value = '今日库存不足，请稍后再试'
    return
  }

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
    rememberEmail(normalizedEmail)
    orderEmail.value = normalizedEmail
    order.value = await purchaseService.createOrder({
      email: normalizedEmail,
      type: payType.value,
      productKey: props.productKey,
    })
    await refreshOrder()
    startAutoRefresh()
    emit('refresh-meta')
  } catch (error: any) {
    errorMessage.value = error?.response?.data?.error || '创建订单失败，请稍后再试'
    emit('refresh-meta')
  } finally {
    creating.value = false
  }
}

const handleOverlayPointerDown = (event: PointerEvent) => {
  const target = event.target as HTMLElement | null
  if (!target) return
  if (target.dataset?.checkoutOverlay !== 'true') return
  close()
}

const handleEscape = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  close()
}

const lockScroll = (locked: boolean) => {
  if (typeof document === 'undefined') return
  document.documentElement.style.overflow = locked ? 'hidden' : ''
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      lockScroll(false)
      stopAutoRefresh()
      isInitializedForOpen.value = false
      window.removeEventListener('keydown', handleEscape)
      return
    }

    lockScroll(true)
    window.addEventListener('keydown', handleEscape)

    if (!isInitializedForOpen.value) {
      loadRememberedEmail()
      isInitializedForOpen.value = true
    }

    if (order.value && shouldAutoRefresh()) {
      startAutoRefresh()
    }
  },
  { immediate: true }
)

watch(
  () => props.productKey,
  () => {
    resetOrderState()
  }
)

watch(
  () => orderDetail.value?.order?.status,
  (status, previous) => {
    if (!status || status === previous) return

    if (status === 'paid') {
      showSuccessToast(orderPaidHint.value || '支付成功，正在为你处理订单')
      emit('refresh-meta')
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
  lockScroll(false)
  stopAutoRefresh()
  window.removeEventListener('keydown', handleEscape)
})
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
        data-checkout-overlay="true"
        @pointerdown="handleOverlayPointerDown"
      />
    </Transition>

    <Transition
      enter-active-class="transition duration-300 ease-out"
      enter-from-class="translate-x-full"
      enter-to-class="translate-x-0"
      leave-active-class="transition duration-200 ease-in"
      leave-from-class="translate-x-0"
      leave-to-class="translate-x-full"
    >
      <section
        v-if="open"
        class="fixed inset-y-0 right-0 z-[60] w-full max-w-[520px] bg-[#fbfbfd]/90 dark:bg-black/70 backdrop-blur-3xl border-l border-white/40 dark:border-white/10 shadow-2xl shadow-black/20"
        role="dialog"
        aria-modal="true"
        aria-label="支付"
      >
        <div class="flex h-full flex-col">
          <header class="px-6 sm:px-8 pt-6 sm:pt-7 pb-4 border-b border-black/5 dark:border-white/10">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider">支付</p>
                <h2 class="mt-1 text-[18px] font-bold text-[#1d1d1f] dark:text-white truncate">
                  {{ plan?.productName || '创建订单' }}
                </h2>
                <p class="mt-1 text-[13px] text-[#86868b]">
                  输入邮箱并选择支付方式，生成付款码。
                </p>
              </div>

              <button
                type="button"
                class="h-9 w-9 inline-flex items-center justify-center rounded-full bg-white/60 dark:bg-white/10 border border-white/40 dark:border-white/10 text-[#1d1d1f]/70 dark:text-white/70 hover:text-[#1d1d1f] dark:hover:text-white hover:bg-white/80 dark:hover:bg-white/15 transition"
                @click="close"
                aria-label="关闭"
              >
                <X class="h-4 w-4" />
              </button>
            </div>
          </header>

          <div class="flex-1 overflow-y-auto px-6 sm:px-8 py-6 space-y-6">
            <AppleCard variant="glass" className="overflow-hidden border border-white/40 dark:border-white/10 ring-1 ring-black/5">
              <div class="p-5 space-y-3">
                <div class="flex items-end justify-between gap-4">
                  <div>
                    <p class="text-[13px] text-[#86868b]">价格</p>
                    <p class="text-[30px] leading-none font-extrabold tabular-nums text-[#1d1d1f] dark:text-white">
                      ¥ {{ plan?.amount ?? '...' }}
                    </p>
                  </div>
                  <div class="text-right">
                    <p class="text-[13px] text-[#86868b]">服务期</p>
                    <p class="text-[14px] font-semibold text-[#1d1d1f] dark:text-white">
                      {{ plan?.serviceDays ?? '...' }} 天
                    </p>
                  </div>
                </div>
                <div class="flex items-center justify-between text-[13px] text-[#86868b]">
                  <span>库存</span>
                  <span class="tabular-nums">
                    {{ availableCount ?? '...' }} 个
                  </span>
                </div>
              </div>
            </AppleCard>

            <form class="space-y-6" @submit.prevent="handleCreateOrder">
              <AppleInput
                v-model.trim="email"
                label="邮箱地址"
                placeholder="name@example.com"
                type="email"
                variant="filled"
                :disabled="creating"
                helperText="用于接收订单信息（也是开通邮箱）"
                :error="email && !isValidEmail ? '请输入有效的邮箱格式' : ''"
                :autoFocus="true"
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
                class="w-full h-[50px] text-[17px] font-medium shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all duration-300 hover:scale-[1.01] active:scale-[0.99]"
                :loading="creating"
                :disabled="creating || isSoldOut"
              >
                {{ isSoldOut ? '今日已售罄' : (creating ? '正在创建订单...' : '生成付款码') }}
              </AppleButton>
            </form>

            <div v-if="errorMessage" class="animate-in fade-in slide-in-from-bottom-2 duration-300">
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
                <AppleButton
                  type="button"
                  variant="primary"
                  size="lg"
                  class="h-[44px]"
                  :loading="refreshing"
                  @click="refreshOrder({ sync: true })"
                >
                  刷新状态
                </AppleButton>
              </div>

              <p v-if="orderPaidHint" class="text-[14px] text-[#34C759] font-medium text-center">
                {{ orderPaidHint }}
              </p>

              <button
                type="button"
                class="w-full text-[13px] text-[#86868b] hover:text-[#1d1d1f] dark:hover:text-white transition"
                @click="resetOrderState"
              >
                重新下单
              </button>
            </div>

            <div class="pt-2">
              <p class="text-[12px] text-[#86868b] leading-relaxed">
                支付成功后系统自动处理，订单信息将发送到邮箱。若未收到邮件请检查垃圾箱，或前往“查询订单”页查看。
              </p>
            </div>
          </div>
        </div>
      </section>
    </Transition>
  </Teleport>
</template>
