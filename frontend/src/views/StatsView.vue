<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { AlertTriangle, BarChart3, RefreshCw } from 'lucide-vue-next'
import { authService, adminStatsService, type AdminStatsOverviewResponse } from '@/services/api'
import { useAppConfigStore } from '@/stores/appConfig'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import NativeDateInput from '@/components/ui/apple/NativeDateInput.vue'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const router = useRouter()
const appConfigStore = useAppConfigStore()

const teleportReady = ref(false)
const loading = ref(false)
const error = ref('')
const overview = ref<AdminStatsOverviewResponse | null>(null)

type RangePreset = 'today' | '7d' | '30d' | 'custom'
const rangePreset = ref<RangePreset>('today')
const rangeFrom = ref('')
const rangeTo = ref('')
const applyingPreset = ref(false)

const formatLocalDateOnly = (date: Date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const addDays = (date: Date, days: number) => {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

const applyRangePreset = (preset: RangePreset) => {
  const today = new Date()
  applyingPreset.value = true
  if (preset === 'today') {
    rangeFrom.value = formatLocalDateOnly(today)
    rangeTo.value = formatLocalDateOnly(today)
  } else if (preset === '7d') {
    rangeFrom.value = formatLocalDateOnly(addDays(today, -6))
    rangeTo.value = formatLocalDateOnly(today)
  } else if (preset === '30d') {
    rangeFrom.value = formatLocalDateOnly(addDays(today, -29))
    rangeTo.value = formatLocalDateOnly(today)
  }
  applyingPreset.value = false
}

watch(rangePreset, (preset) => {
  if (preset === 'custom') return
  applyRangePreset(preset)
}, { immediate: true })

watch([rangeFrom, rangeTo], () => {
  if (applyingPreset.value) return
  if (rangePreset.value !== 'custom') {
    rangePreset.value = 'custom'
  }
}, { flush: 'sync' })

const locale = computed(() => appConfigStore.locale || 'zh-CN')
const numberFmt = computed(() => new Intl.NumberFormat(locale.value))
const moneyFmt = computed(() => new Intl.NumberFormat(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const moneyIntFmt = computed(() => new Intl.NumberFormat(locale.value, { minimumFractionDigits: 0, maximumFractionDigits: 0 }))

const formatNumber = (value?: number | null) => numberFmt.value.format(Number(value || 0))
const formatMoney = (value?: number | null) => moneyFmt.value.format(Number(value || 0))
const formatMoneyInt = (value?: number | null) => moneyIntFmt.value.format(Number(value || 0))
const formatPercent = (value?: number | null) => {
  const normalized = Number(value || 0)
  if (!Number.isFinite(normalized)) return '0%'
  return `${Math.round(normalized * 1000) / 10}%`
}

const totalRevenue = computed(() => {
  if (!overview.value) return 0
  return (
    Number(overview.value.purchaseOrders?.paidAmount || 0) +
    Number(overview.value.xhsOrders?.amount?.range || 0) +
    Number(overview.value.xianyuOrders?.amount?.range || 0)
  )
})

const channelLabel = (channel: string) => {
  const normalized = String(channel || '').trim()
  const mapping: Record<string, string> = {
    common: '通用',
    paypal: 'PayPal',
    'linux-do': 'Linux DO',
    xhs: '小红书',
    xianyu: '闲鱼',
    'artisan-flow': 'ArtisanFlow'
  }
  return mapping[normalized] || normalized || '-'
}

const loadOverview = async () => {
  loading.value = true
  error.value = ''
  try {
    overview.value = await adminStatsService.getOverview({
      from: rangeFrom.value,
      to: rangeTo.value
    })
  } catch (err: any) {
    const message = err?.response?.data?.error || '加载统计数据失败'
    error.value = message
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      authService.logout()
      router.push('/login')
      return
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')

  await appConfigStore.loadConfig()

  if (!authService.isAuthenticated()) {
    router.push('/login')
    return
  }

  if (!rangeFrom.value || !rangeTo.value) {
    applyRangePreset(rangePreset.value)
  }

  await loadOverview()
})
</script>

<template>
  <div class="space-y-8">
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="w-full flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-end">
        <div class="grid grid-cols-2 gap-3 w-full sm:w-auto sm:flex sm:items-end sm:gap-2">
          <div class="space-y-1 col-span-2 sm:col-span-1">
            <Label class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">范围</Label>
            <Select v-model="rangePreset">
              <SelectTrigger class="h-10 w-full sm:w-[120px] bg-white border-gray-200 rounded-xl">
                <SelectValue placeholder="选择范围" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="today">今日</SelectItem>
                <SelectItem value="7d">近 7 天</SelectItem>
                <SelectItem value="30d">近 30 天</SelectItem>
                <SelectItem value="custom">自定义</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-1">
            <Label class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">开始</Label>
            <NativeDateInput v-model="rangeFrom" placeholder="开始日期" class="w-full sm:w-[160px]" />
          </div>

          <div class="space-y-1">
            <Label class="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">结束</Label>
            <NativeDateInput v-model="rangeTo" placeholder="结束日期" class="w-full sm:w-[160px]" />
          </div>
        </div>

        <Button
          variant="outline"
          class="h-10 w-full rounded-xl border-gray-200 bg-white sm:w-auto"
          :disabled="loading"
          @click="loadOverview"
        >
          <RefreshCw class="w-4 h-4 mr-2" :class="{ 'animate-spin': loading }" />
          刷新
        </Button>
      </div>
    </Teleport>

    <div v-if="error" class="rounded-2xl border border-red-100 bg-red-50/50 p-4 flex items-center gap-3 text-red-600">
      <AlertTriangle class="h-5 w-5" />
      <span class="font-medium">{{ error }}</span>
    </div>

    <div class="bg-white rounded-[32px] shadow-sm border border-gray-100 overflow-hidden min-h-[400px]">
      <div v-if="loading && !overview" class="flex flex-col items-center justify-center py-20">
        <div class="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
        <p class="text-gray-400 text-sm font-medium mt-4">正在加载统计数据...</p>
      </div>

      <div v-else class="p-6 lg:p-8 space-y-8">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600">
            <BarChart3 class="w-5 h-5" />
          </div>
          <div>
            <h3 class="text-lg font-semibold text-gray-900">平台概览</h3>
            <p v-if="overview" class="text-xs text-gray-400 mt-0.5">
              范围：{{ overview.range.from }} ~ {{ overview.range.to }}
            </p>
          </div>
        </div>

        <div v-if="overview" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">总营收</p>
              <p class="text-2xl font-bold text-gray-900">¥{{ formatMoney(totalRevenue) }}</p>
              <p class="text-xs text-gray-500">按区间汇总（支付 + 小红书 + 闲鱼）</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">支付收入（区间）</p>
              <p class="text-2xl font-bold text-gray-900">¥{{ formatMoney(overview.purchaseOrders.paidAmount) }}</p>
              <p class="text-xs text-gray-500">已支付 {{ formatNumber(overview.purchaseOrders.paid) }} 单</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">小红书订单金额（区间）</p>
              <p class="text-2xl font-bold text-gray-900">¥{{ formatMoneyInt(overview.xhsOrders.amount.range) }}</p>
              <p class="text-xs text-gray-500">今日 ¥{{ formatMoneyInt(overview.xhsOrders.amount.today) }}</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">闲鱼订单金额（区间）</p>
              <p class="text-2xl font-bold text-gray-900">¥{{ formatMoneyInt(overview.xianyuOrders.amount.range) }}</p>
              <p class="text-xs text-gray-500">今日 ¥{{ formatMoneyInt(overview.xianyuOrders.amount.today) }}</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">用户</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.users.total) }}</p>
              <p class="text-xs text-gray-500">区间新增 {{ formatNumber(overview.users.created) }}</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">通用渠道今日库存</p>
              <p class="text-2xl font-bold text-gray-900">
                {{ formatNumber(overview.redemptionCodes.todayCommon.unused) }} / {{ formatNumber(overview.redemptionCodes.todayCommon.total) }}
              </p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">小红书今日库存</p>
              <p class="text-2xl font-bold text-gray-900">
                {{ formatNumber(overview.redemptionCodes.todayXhs.unused) }} / {{ formatNumber(overview.redemptionCodes.todayXhs.total) }}
              </p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">闲鱼今日库存</p>
              <p class="text-2xl font-bold text-gray-900">
                {{ formatNumber(overview.redemptionCodes.todayXianyu.unused) }} / {{ formatNumber(overview.redemptionCodes.todayXianyu.total) }}
              </p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">支付订单今日</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.purchaseOrders.today.pending) }}</p>
              <p class="text-xs text-gray-500">
                待支付（今日总 {{ formatNumber(overview.purchaseOrders.today.total) }} · 已付 {{ formatNumber(overview.purchaseOrders.today.paid) }}）
              </p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">小红书订单今日</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.xhsOrders.today.pending) }}</p>
              <p class="text-xs text-gray-500">待核销（今日总 {{ formatNumber(overview.xhsOrders.today.total) }}）</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">闲鱼订单今日</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.xianyuOrders.today.pending) }}</p>
              <p class="text-xs text-gray-500">待核销（今日总 {{ formatNumber(overview.xianyuOrders.today.total) }}）</p>
            </CardContent>
          </Card>

          <Card class="rounded-2xl border-gray-100">
            <CardContent class="p-5 space-y-2">
              <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider">提现待处理</p>
              <p class="text-2xl font-bold text-gray-900">{{ formatNumber(overview.pointsWithdrawals.pending) }}</p>
              <p class="text-xs text-gray-500">
                {{ formatNumber(overview.pointsWithdrawals.pendingPoints) }} 积分 · ¥{{ formatMoney(overview.pointsWithdrawals.pendingCash) }}
              </p>
            </CardContent>
          </Card>
        </div>

        <div v-if="overview" class="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div class="rounded-2xl border border-gray-100 overflow-hidden">
            <div class="px-5 py-4 bg-gray-50/50 border-b border-gray-100">
              <h4 class="text-sm font-semibold text-gray-900">兑换码渠道分布</h4>
              <p class="text-xs text-gray-400 mt-0.5">总量 / 未使用</p>
            </div>
            <div class="p-5 overflow-x-auto">
              <table class="w-full text-sm">
                <thead class="text-xs text-gray-400 uppercase">
                  <tr>
                    <th class="text-left font-semibold py-2">渠道</th>
                    <th class="text-right font-semibold py-2">总量</th>
                    <th class="text-right font-semibold py-2">未使用</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-50">
                  <tr v-for="row in overview.redemptionCodes.byChannel" :key="row.channel" class="hover:bg-gray-50/30">
                    <td class="py-3 font-medium text-gray-900">{{ channelLabel(row.channel) }}</td>
                    <td class="py-3 text-right text-gray-600">{{ formatNumber(row.total) }}</td>
                    <td class="py-3 text-right text-gray-600">{{ formatNumber(row.unused) }}</td>
                  </tr>
                  <tr v-if="!overview.redemptionCodes.byChannel.length">
                    <td colspan="3" class="py-8 text-center text-gray-400">暂无数据</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="rounded-2xl border border-gray-100 overflow-hidden">
            <div class="px-5 py-4 bg-gray-50/50 border-b border-gray-100">
              <h4 class="text-sm font-semibold text-gray-900">订单概览（区间）</h4>
              <p class="text-xs text-gray-400 mt-0.5">支付订单 + Credit 订单 + 小红书 + 闲鱼</p>
            </div>
            <div class="p-5 space-y-4">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">支付订单</p>
                  <p class="text-sm text-gray-600 mt-1">总 {{ formatNumber(overview.purchaseOrders.total) }} · 待付 {{ formatNumber(overview.purchaseOrders.pending) }} · 已付 {{ formatNumber(overview.purchaseOrders.paid) }} · 已退 {{ formatNumber(overview.purchaseOrders.refunded) }}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">已付金额</p>
                  <p class="text-lg font-bold text-gray-900 mt-1">¥{{ formatMoney(overview.purchaseOrders.paidAmount) }}</p>
                  <p class="text-xs text-gray-500 mt-0.5">退款 ¥{{ formatMoney(overview.purchaseOrders.refundAmount) }}</p>
                </div>
              </div>

              <div class="h-px bg-gray-100"></div>

              <div class="flex items-center justify-between">
                <div>
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">Credit 订单</p>
                  <p class="text-sm text-gray-600 mt-1">总 {{ formatNumber(overview.creditOrders.total) }} · 已付 {{ formatNumber(overview.creditOrders.paid) }} · 已退 {{ formatNumber(overview.creditOrders.refunded) }}</p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">已付金额</p>
                  <p class="text-lg font-bold text-gray-900 mt-1">¥{{ formatMoney(overview.creditOrders.paidAmount) }}</p>
                </div>
              </div>

              <div class="h-px bg-gray-100"></div>

              <div class="flex items-center justify-between">
                <div>
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">小红书订单</p>
                  <p class="text-sm text-gray-600 mt-1">
                    总 {{ formatNumber(overview.xhsOrders.total) }} · 待核销 {{ formatNumber(overview.xhsOrders.pending) }} · 已核销 {{ formatNumber(overview.xhsOrders.used) }}
                  </p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">订单金额</p>
                  <p class="text-lg font-bold text-gray-900 mt-1">¥{{ formatMoneyInt(overview.xhsOrders.amount.range) }}</p>
                </div>
              </div>

              <div class="h-px bg-gray-100"></div>

              <div class="flex items-center justify-between">
                <div>
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">闲鱼订单</p>
                  <p class="text-sm text-gray-600 mt-1">
                    总 {{ formatNumber(overview.xianyuOrders.total) }} · 待核销 {{ formatNumber(overview.xianyuOrders.pending) }} · 已核销 {{ formatNumber(overview.xianyuOrders.used) }}
                  </p>
                </div>
                <div class="text-right">
                  <p class="text-xs text-gray-400 font-semibold uppercase tracking-wider">订单金额</p>
                  <p class="text-lg font-bold text-gray-900 mt-1">¥{{ formatMoneyInt(overview.xianyuOrders.amount.range) }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
