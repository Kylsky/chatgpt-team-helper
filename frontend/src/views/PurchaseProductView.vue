<template>
  <RedeemShell :maxWidth="'max-w-[960px]'" showUserStatusBar>
    <div class="mx-auto w-full max-w-3xl px-2 sm:px-4 space-y-8">
    <div class="flex items-center justify-between">
      <RouterLink
        to="/purchase"
        class="inline-flex items-center gap-2 rounded-full bg-white/60 dark:bg-white/10 backdrop-blur-xl border border-white/40 dark:border-white/10 px-4 py-2 text-[13px] font-medium text-[#007AFF] hover:text-[#005FCC] transition-colors"
      >
        <ArrowLeft class="h-4 w-4" />
        返回商品
      </RouterLink>

      <div
        class="inline-flex items-center gap-2.5 rounded-full bg-white/60 dark:bg-white/10 backdrop-blur-xl border border-white/40 dark:border-white/10 px-4 py-1.5 shadow-sm"
      >
        <span class="relative flex h-2.5 w-2.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#007AFF]"></span>
        </span>
        <span class="text-[13px] font-medium text-gray-600 dark:text-gray-300 tracking-wide">
          今日库存 · {{ plan?.availableCount ?? meta?.availableCount ?? '...' }} 个
        </span>
      </div>
    </div>

    <div class="text-center space-y-3">
      <h1
        class="text-[34px] leading-tight font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 dark:from-blue-400 dark:via-purple-400 dark:to-pink-400 drop-shadow-sm animate-gradient-x"
      >
        {{ plan?.productName || '商品详情' }}
      </h1>
      <p class="text-[15px] text-[#86868b]">
        {{ tagline }}
      </p>
    </div>

    <div v-if="errorMessage" class="rounded-2xl border border-red-200/70 bg-red-50/60 p-4 text-sm text-red-700">
      {{ errorMessage }}
    </div>

    <div class="relative group perspective-1000">
      <div
        class="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-[2rem] blur opacity-25 group-hover:opacity-40 transition duration-700"
      ></div>
      <AppleCard
        variant="glass"
        className="relative overflow-hidden shadow-2xl shadow-black/10 border border-white/40 dark:border-white/10 ring-1 ring-black/5 backdrop-blur-3xl transition-all duration-500 hover:shadow-3xl hover:scale-[1.01]"
      >
        <div class="p-8 sm:p-10 space-y-8">
          <div class="rounded-2xl bg-white/50 dark:bg-black/20 border border-black/5 dark:border-white/10 p-5">
            <div class="flex items-end justify-between gap-6">
              <div>
                <p class="text-[13px] text-[#86868b]">价格</p>
                <p class="text-[38px] leading-none font-extrabold tabular-nums text-[#1d1d1f] dark:text-white">
                  ¥ {{ plan?.amount ?? meta?.amount ?? '...' }}
                </p>
              </div>
              <div class="text-right">
                <p class="text-[13px] text-[#86868b]">服务期</p>
                <p class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">
                  {{ plan?.serviceDays ?? meta?.serviceDays ?? '...' }} 天
                </p>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <AppleButton type="button" variant="secondary" size="lg" class="h-[44px]" @click="goBack">
              返回列表
            </AppleButton>
            <AppleButton
              type="button"
              variant="primary"
              size="lg"
              class="h-[44px]"
              :disabled="!planKey || isSoldOut || isAntiBanOffline"
              @click="openCheckout"
            >
              {{ isAntiBanOffline ? '已下线' : '立即购买' }}
            </AppleButton>
          </div>

          <p v-if="isSoldOut" class="text-[13px] text-[#FF3B30] text-center">
            今日库存不足，请稍后再试。
          </p>
          <p v-else-if="isAntiBanOffline" class="text-[13px] text-[#FF3B30] text-center">
            防封禁方案已下线，请返回列表选择其他商品。
          </p>

          <div class="rounded-2xl bg-white/45 dark:bg-black/20 border border-black/5 dark:border-white/10 p-4 sm:p-5 space-y-3">
            <h4 class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider">兑换码进入空间</h4>
            <p class="text-[12px] text-[#86868b]">库存不足时也可使用兑换码直接进入对应空间。</p>

            <div class="space-y-2">
              <input
                :value="redeemCode"
                type="text"
                inputmode="text"
                maxlength="14"
                placeholder="请输入兑换码（XXXX-XXXX-XXXX）"
                class="w-full rounded-xl border border-gray-200/80 bg-white/80 px-3 py-2 text-sm outline-none focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20"
                :disabled="redeemLoading"
                @input="handleRedeemCodeInput"
              />
              <input
                v-model.trim="redeemEmail"
                type="email"
                placeholder="请输入邮箱"
                class="w-full rounded-xl border border-gray-200/80 bg-white/80 px-3 py-2 text-sm outline-none focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20"
                :disabled="redeemLoading"
              />
              <p class="text-[12px] text-[#86868b]">请输入你的邮箱</p>
            </div>

            <AppleButton
              type="button"
              variant="primary"
              size="lg"
              class="w-full h-[42px]"
              :loading="redeemLoading"
              :disabled="redeemLoading"
              @click="submitRedeemCode"
            >
              {{ redeemLoading ? '兑换中...' : '兑换并进入空间' }}
            </AppleButton>

            <p v-if="redeemErrorMessage" class="text-[12px] text-[#FF3B30]">{{ redeemErrorMessage }}</p>
          </div>

          <div class="pt-6 border-t border-gray-200/60 dark:border-white/10">
            <h4 class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-4">购买须知</h4>
            <ul class="space-y-3 text-[14px] text-[#1d1d1f]/70 dark:text-white/70">
              <li v-for="(item, idx) in notes" :key="idx" class="flex items-start gap-3">
                <span class="h-1.5 w-1.5 rounded-full mt-2 flex-shrink-0 bg-[#007AFF]"></span>
                <span>{{ item }}</span>
              </li>
            </ul>
          </div>
        </div>
      </AppleCard>
    </div>

    </div>

    <PurchaseCheckoutDrawer
      v-if="planKey && !isAntiBanOffline"
      :open="isCheckoutOpen"
      :product-key="planKey"
      :plan="plan"
      :available-count="availableCount"
      @close="isCheckoutOpen = false"
      @refresh-meta="loadMeta"
    />
  </RedeemShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import RedeemShell from '@/components/RedeemShell.vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import AppleButton from '@/components/ui/apple/Button.vue'
import PurchaseCheckoutDrawer from '@/components/purchase/PurchaseCheckoutDrawer.vue'
import { purchaseService, redemptionCodeService, type PurchaseMeta, type PurchasePlan, type PurchaseOrderType } from '@/services/api'
import { ArrowLeft } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()

const meta = ref<PurchaseMeta | null>(null)
const errorMessage = ref('')
const loading = ref(false)
const isCheckoutOpen = ref(false)
const redeemCode = ref('')
const redeemEmail = ref('')
const redeemLoading = ref(false)
const redeemErrorMessage = ref('')

const formatRedeemCode = (value: string) => {
  let formatted = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (formatted.length > 4 && formatted.length <= 8) {
    formatted = `${formatted.slice(0, 4)}-${formatted.slice(4)}`
  } else if (formatted.length > 8) {
    formatted = `${formatted.slice(0, 4)}-${formatted.slice(4, 8)}-${formatted.slice(8, 12)}`
  }
  return formatted.slice(0, 14)
}

const handleRedeemCodeInput = (event: Event) => {
  const next = (event.target as HTMLInputElement)?.value || ''
  redeemCode.value = formatRedeemCode(next)
}

const planKey = computed(() => String(route.params.productKey || '').trim().toLowerCase())

const plans = computed<PurchasePlan[]>(() => meta.value?.plans || [])

const plan = computed<PurchasePlan | null>(() => {
  if (!planKey.value) return null
  return plans.value.find(item => item.key === planKey.value) || null
})

const availableCount = computed(() => plan.value?.availableCount ?? meta.value?.availableCount ?? 0)
const isSoldOut = computed(() => Number(availableCount.value || 0) <= 0)
const orderType = computed<PurchaseOrderType | null>(() => (plan.value?.orderType as PurchaseOrderType) || null)
const isAntiBanOffline = computed(() => orderType.value === 'anti_ban')

const tagline = computed(() => {
  if (orderType.value === 'no_warranty') return '无质保商品，请确认购买说明后再下单。'
  if (orderType.value === 'warranty') return '支持质保服务，适合长期使用。'
  if (orderType.value === 'anti_ban') return '防封禁方案已下线，请返回列表选择其他商品。'
  return '请选择商品后查看购买说明。'
})

const notes = computed<string[]>(() => {
  const purchaseNotes = Array.isArray(plan.value?.purchaseNotes)
    ? plan.value.purchaseNotes.map(item => String(item || '').trim()).filter(Boolean)
    : []
  if (purchaseNotes.length > 0) return purchaseNotes

  // 兼容旧数据：purchaseNotes 缺失时回退到历史文案
  const common = [
    '订单信息将发送至填写的邮箱，请确认邮箱可正常收信。',
    '支付成功后系统自动处理，无需手动兑换。',
    '如未收到邮件请检查垃圾箱，或使用"查询订单"页进行订单查询。'
  ]

  if (planKey.value === 'no_warranty') {
    return ['无质保：不支持退款 / 补号。', '仅提供首次登陆咨询与基础使用指导。', ...common]
  }

  if (planKey.value === 'warranty') {
    return ['质保：支持退款 / 补号（按平台规则处理）。', '遇到封号/异常可联系售后协助处理。', ...common]
  }

  if (planKey.value === 'anti_ban') {
    return ['经过特殊处理：开通后无法退出工作空间。', '质保：支持退款 / 补号（按平台规则处理）。', ...common]
  }

  return common
})

const loadMeta = async () => {
  if (loading.value) return
  loading.value = true
  errorMessage.value = ''
  try {
    meta.value = await purchaseService.getMeta()
  } catch (error: any) {
    errorMessage.value = error?.response?.data?.error || '加载商品信息失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

const goBack = () => {
  router.push('/purchase')
}

const openCheckout = () => {
  if (!planKey.value) return
  if (isAntiBanOffline.value) return
  if (isSoldOut.value) return
  isCheckoutOpen.value = true
}

const submitRedeemCode = async () => {
  if (redeemLoading.value) return
  redeemErrorMessage.value = ''

  const code = formatRedeemCode(redeemCode.value)
  const email = String(redeemEmail.value || '').trim()

  if (!code) {
    redeemErrorMessage.value = '请输入兑换码'
    return
  }
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    redeemErrorMessage.value = '兑换码格式不正确，应为 XXXX-XXXX-XXXX'
    return
  }
  if (!email) {
    redeemErrorMessage.value = '请输入邮箱'
    return
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    redeemErrorMessage.value = '邮箱格式不正确'
    return
  }

  redeemLoading.value = true
  try {
    // 本地联调 mock：便于前端验证成功/失败路径
    if (import.meta.env.DEV && code === 'MOCK-SUCC-0001') {
      await router.push({
        name: 'linux-do-open-accounts',
        query: {
          from: 'purchase-redeem-mock',
          accountEmail: 'mock-space@example.com',
          spaceId: 'mock-space-001'
        }
      })
      return
    }
    if (import.meta.env.DEV && code === 'MOCK-FAIL-0001') {
      redeemErrorMessage.value = '模拟失败：兑换码已过期或已使用'
      return
    }

    const response = await redemptionCodeService.redeem({
      email,
      code,
      orderType: planKey.value || undefined
    })
    const accountEmail = String(response?.data?.data?.accountEmail || '').trim()
    redeemCode.value = ''
    await router.push({
      name: 'linux-do-open-accounts',
      query: {
        from: 'purchase-redeem',
        ...(accountEmail ? { accountEmail } : {})
      }
    })
  } catch (error: any) {
    redeemErrorMessage.value = error?.response?.data?.message || error?.response?.data?.error || '兑换失败，请稍后重试'
  } finally {
    redeemLoading.value = false
  }
}

onMounted(() => {
  void loadMeta()
})

watch(planKey, () => {
  isCheckoutOpen.value = false
  if (meta.value) return
  void loadMeta()
})
</script>
