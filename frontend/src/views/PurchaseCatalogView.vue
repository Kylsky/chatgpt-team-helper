<template>
  <RedeemShell :maxWidth="'max-w-[1280px]'" showUserStatusBar>
    <div class="mx-auto w-full max-w-6xl px-2 sm:px-4 space-y-8">
      <div class="text-center space-y-6">
      <div class="space-y-3">
        <h1
          class="text-[40px] leading-tight font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 dark:from-blue-400 dark:via-purple-400 dark:to-pink-400 drop-shadow-sm animate-gradient-x"
        >
          商品
        </h1>
        <p class="text-[15px] text-[#86868b]">
          选择商品查看详情与购买须知。
          <RouterLink class="text-[#007AFF] hover:text-[#005FCC] font-medium" to="/order">查询订单</RouterLink>
        </p>
      </div>
    </div>

    <div v-if="errorMessage" class="rounded-2xl border border-red-200/70 bg-red-50/60 p-4 text-sm text-red-700">
      {{ errorMessage }}
    </div>

      <div class="mx-auto grid w-full grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 xl:grid-cols-3 xl:gap-7 2xl:gap-8">
      <RouterLink
        v-for="plan in plans"
        :key="plan.key"
        class="block h-full"
        :to="{ name: 'purchase-product', params: { productKey: plan.key } }"
      >
        <div class="relative group perspective-1000 h-full">
          <div
            class="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-[2rem] blur opacity-20 group-hover:opacity-40 transition duration-700"
          ></div>
          <AppleCard
            variant="glass"
            :interactive="true"
            :clickable="true"
            className="relative h-full overflow-hidden border border-white/40 dark:border-white/10 ring-1 ring-black/5 backdrop-blur-3xl transition-all duration-500 hover:shadow-3xl hover:scale-[1.01]"
          >
            <div class="p-6 sm:p-7 h-full flex flex-col">
              <div class="space-y-5">
                <div class="flex items-start justify-between gap-4">
                  <div class="space-y-1">
                    <p class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider">商品</p>
                    <h3 class="text-[18px] font-bold text-[#1d1d1f] dark:text-white leading-snug">
                      {{ plan.productName }}
                    </h3>
                  </div>
                  <span
                    class="inline-flex items-center rounded-full px-3 py-1 text-[12px] font-semibold border"
                    :class="plan.orderType === 'no_warranty'
                      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20'
                      : 'bg-blue-500/10 text-[#007AFF] border-blue-500/20'"
                  >
                    {{ plan.badge || (plan.key === 'no_warranty' ? '无质保' : '质保') }}
                  </span>
                </div>

                <div class="flex items-end justify-between gap-4">
                  <div>
                    <p class="text-[13px] text-[#86868b]">价格</p>
                    <p class="text-[34px] leading-none font-extrabold tabular-nums text-[#1d1d1f] dark:text-white">
                      ¥ {{ plan.amount }}
                    </p>
                  </div>
                  <div class="text-right">
                    <p class="text-[13px] text-[#86868b]">服务期</p>
                    <p class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">
                      {{ plan.serviceDays }} 天
                    </p>
                  </div>
                </div>

                <ul class="space-y-3.5 text-[14px] text-[#1d1d1f]/70 dark:text-white/70 leading-relaxed">
                  <li v-for="(note, idx) in resolveCardNotes(plan)" :key="`${plan.key}-${idx}`" class="flex items-start gap-3">
                    <span class="h-1.5 w-1.5 rounded-full mt-2 flex-shrink-0 bg-[#007AFF]" ></span>
                    <span>{{ note }}</span>
                  </li>
                </ul>
              </div>

              <div class="mt-auto flex items-center justify-between pt-5 border-t border-gray-200/60 dark:border-white/10">
                <span class="text-[13px] text-[#86868b]">点击查看详情</span>
                <span class="text-[#007AFF] font-semibold text-[13px] transition group-hover:translate-x-0.5">
                  查看详情 →
                </span>
              </div>
            </div>
          </AppleCard>
        </div>
      </RouterLink>
      </div>
    </div>
  </RedeemShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import RedeemShell from '@/components/RedeemShell.vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import { purchaseService, type PurchaseMeta, type PurchasePlan } from '@/services/api'

const meta = ref<PurchaseMeta | null>(null)
const errorMessage = ref('')
const loading = ref(false)

const plans = computed<PurchasePlan[]>(() => meta.value?.plans || [])


const resolveCardNotes = (plan: PurchasePlan): string[] => {
  const notes = Array.isArray(plan.purchaseNotes)
    ? plan.purchaseNotes.map(item => String(item || '').trim()).filter(Boolean)
    : []
  if (notes.length > 0) return notes.slice(0, 3)

  const fallbackFeatures = Array.isArray(plan.features)
    ? plan.features.map(item => String(item?.text || '').trim()).filter(Boolean)
    : []
  if (fallbackFeatures.length > 0) return fallbackFeatures.slice(0, 3)

  if (plan.key === 'anti_ban') {
    return ['支持退款 / 补号', '支付成功后系统自动处理', '经过特殊处理，无法退出工作空间，介意勿拍']
  }
  if (plan.key === 'no_warranty') {
    return ['不支持退款 / 补号', '支付成功后系统自动处理']
  }
  return ['支持退款 / 补号', '支付成功后系统自动处理']
}

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

onMounted(() => {
  void loadMeta()
})
</script>
