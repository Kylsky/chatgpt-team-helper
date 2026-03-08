<template>
  <RedeemShell>
    <div class="text-center space-y-6">
      <div
        class="inline-flex items-center gap-2.5 rounded-full bg-white/60 dark:bg-white/10 backdrop-blur-xl border border-white/40 dark:border-white/10 px-4 py-1.5 shadow-sm transition-transform hover:scale-105 duration-300 cursor-default"
      >
        <span class="relative flex h-2.5 w-2.5">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#007AFF]"></span>
        </span>
        <span class="text-[13px] font-medium text-gray-600 dark:text-gray-300 tracking-wide">自动发邀请 · 验证码一次性</span>
      </div>

      <div class="space-y-3">
        <h1
          class="text-[40px] leading-tight font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 dark:from-blue-400 dark:via-purple-400 dark:to-pink-400 drop-shadow-sm animate-gradient-x"
        >
          {{ title }}
        </h1>
      </div>
    </div>

    <div class="relative group perspective-1000">
      <div class="absolute -inset-1 bg-gradient-to-r from-blue-600 to-purple-600 rounded-[2rem] blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200 animate-tilt"></div>
      <AppleCard
        variant="glass"
        class="relative overflow-hidden shadow-2xl shadow-black/10 border border-white/40 dark:border-white/10 ring-1 ring-black/5 backdrop-blur-3xl transition-all duration-500 hover:shadow-3xl hover:scale-[1.01] animate-float"
      >
        <div class="p-8 sm:p-10 space-y-8">
          <form @submit.prevent="handleRedeem()" class="space-y-8">
            <div
              class="space-y-2 group animate-in fade-in slide-in-from-bottom-4 duration-700 delay-100 fill-mode-backwards"
              :class="{ 'animate-shake': errorMessage && !formData.email }"
            >
              <AppleInput
                v-model.trim="formData.email"
                label="邮箱地址"
                placeholder="name@example.com"
                type="email"
                variant="filled"
                :disabled="isLoading"
                helperText="请填写 ChatGPT 账号邮箱，用于接收邀请邮件"
                :error="formData.email && !isValidEmail ? '请输入有效的邮箱格式' : ''"
                class="transition-all duration-300 group-hover:translate-x-1"
              />
            </div>

            <div
              class="space-y-2 group animate-in fade-in slide-in-from-bottom-4 duration-700 delay-200 fill-mode-backwards"
              :class="{ 'animate-shake': errorMessage && !formData.code }"
            >
              <AppleInput
                v-model="formData.code"
                label="兑换码"
                placeholder="XXXX-XXXX-XXXX"
                type="text"
                variant="filled"
                :disabled="isLoading"
                helperText="格式：XXXX-XXXX-XXXX（自动转大写）"
                :error="formData.code && !isValidCode ? '兑换码格式应为 XXXX-XXXX-XXXX' : ''"
                @input="handleCodeInput"
                class="transition-all duration-300 group-hover:translate-x-1"
              />
            </div>

            <div class="pt-2 animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300 fill-mode-backwards">
              <AppleButton
                type="submit"
                variant="primary"
                size="lg"
                class="w-full h-[50px] text-[17px] font-medium shadow-lg shadow-blue-500/20 hover:shadow-blue-500/30 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
                :loading="isLoading"
                :disabled="isLoading"
              >
                {{ isLoading ? '正在兑换...' : '立即兑换' }}
              </AppleButton>
            </div>
          </form>

          <div
            v-if="successInfo"
            class="absolute inset-0 z-20 flex items-center justify-center p-6 bg-white/60 dark:bg-black/60 backdrop-blur-md rounded-[2rem] animate-in fade-in duration-300"
          >
            <div class="w-full rounded-2xl bg-[#34C759]/10 border border-[#34C759]/20 p-5 flex gap-4 shadow-lg backdrop-blur-xl">
              <div class="flex-shrink-0 mt-0.5">
                <div class="h-6 w-6 rounded-full bg-[#34C759] flex items-center justify-center shadow-sm">
                  <CheckCircle2 class="h-4 w-4 text-white" />
                </div>
              </div>
              <div class="flex-1 space-y-3">
                <h3 class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">兑换成功！</h3>
                <div class="text-[14px] text-[#1d1d1f]/80 dark:text-white/80 space-y-3">
                  <p>您已成功兑换并加入 ChatGPT Team 账号。</p>
                  <div class="bg-white/50 dark:bg-black/20 rounded-xl p-3 border border-black/5 dark:border-white/10 space-y-1.5">
                    <p class="flex justify-between">
                      <span class="text-[#86868b]">当前成员数</span>
                      <span class="font-medium tabular-nums">{{ successInfo.userCount }} / 5</span>
                    </p>
                    <p v-if="successInfo.inviteStatus" class="flex justify-between items-center">
                      <span class="text-[#86868b]">邀请状态</span>
                      <span
                        class="px-2 py-0.5 rounded-md text-[12px] font-medium"
                        :class="successInfo.inviteStatus.includes('已发送') ? 'bg-[#34C759]/10 text-[#34C759]' : 'bg-[#FF9F0A]/10 text-[#FF9F0A]'"
                      >
                        {{ successInfo.inviteStatus }}
                      </span>
                    </p>
                  </div>
                  <p class="text-[13px] leading-normal text-[#86868b]">
                    <template v-if="successInfo.inviteStatus && successInfo.inviteStatus.includes('已发送')">
                      请查看邮箱并接收邀请邮件，然后登录 ChatGPT 使用。
                    </template>
                    <template v-else>
                      如未收到自动邀请，请联系管理员手动添加。
                    </template>
                  </p>
                  <div class="pt-1">
                    <button type="button" class="text-xs text-[#007AFF] hover:text-[#005FCC] font-medium transition" @click="successInfo = null">
                      继续兑换
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="errorMessage" class="animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out-expo">
            <div class="rounded-2xl bg-[#FF3B30]/10 border border-[#FF3B30]/20 p-5 flex gap-4">
              <div class="flex-shrink-0 mt-0.5">
                <div class="h-6 w-6 rounded-full bg-[#FF3B30] flex items-center justify-center shadow-sm">
                  <AlertCircle class="h-4 w-4 text-white" />
                </div>
              </div>
              <div class="flex-1">
                <h3 class="text-[15px] font-semibold text-[#1d1d1f] dark:text-white">兑换失败</h3>
                <p class="mt-1 text-[14px] text-[#1d1d1f]/80 dark:text-white/80">{{ errorMessage }}</p>
              </div>
            </div>
          </div>

          <div class="pt-6 border-t border-gray-200/60 dark:border-white/10">
            <h4 class="text-[13px] font-semibold text-[#86868b] uppercase tracking-wider mb-4">使用提示</h4>
            <ul class="space-y-3 text-[14px] text-[#1d1d1f]/70 dark:text-white/70">
              <li class="flex items-start gap-3">
                <span class="h-1.5 w-1.5 rounded-full bg-[#007AFF] mt-2 flex-shrink-0"></span>
                <span>每个兑换码只能使用一次。</span>
              </li>
              <li class="flex items-start gap-3">
                <span class="h-1.5 w-1.5 rounded-full bg-[#007AFF] mt-2 flex-shrink-0"></span>
                <span>未收到邮件请检查垃圾箱/联系管理员。</span>
              </li>
            </ul>
          </div>
        </div>
      </AppleCard>
    </div>
  </RedeemShell>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppleButton from '@/components/ui/apple/Button.vue'
import AppleCard from '@/components/ui/apple/Card.vue'
import AppleInput from '@/components/ui/apple/Input.vue'
import RedeemShell from '@/components/RedeemShell.vue'
import { useRedeemForm } from '@/composables/useRedeemForm'
import { useAppConfigStore } from '@/stores/appConfig'
import { AlertCircle, CheckCircle2 } from 'lucide-vue-next'

const route = useRoute()
const router = useRouter()
const appConfigStore = useAppConfigStore()

const channelKey = computed(() => String(route.params.channelKey || '').trim().toLowerCase())

const redirectTargets: Record<string, string> = {
  '': '/redeem/common',
  'common': '/redeem/common',
  'linux-do': '/redeem/linux-do',
  'xhs': '/redeem/xhs',
  'xianyu': '/redeem/xianyu',
  'open-accounts': '/redeem/open-accounts',
  'account-recovery': '/redeem/account-recovery',
}

watch(
  channelKey,
  (value) => {
    const target = redirectTargets[value] || ''
    if (target) {
      router.replace(target)
    }
  },
  { immediate: true }
)

onMounted(() => {
  void appConfigStore.loadConfig()
})

const channelName = computed(() => {
  const key = channelKey.value
  if (!key) return ''
  const match = appConfigStore.channels.find(channel => channel.key === key)
  return (match?.name || key).trim()
})

const title = computed(() => {
  const name = channelName.value
  return name ? `${name} 兑换` : '兑换'
})

const {
  formData,
  isLoading,
  errorMessage,
  successInfo,
  isValidEmail,
  isValidCode,
  handleCodeInput,
  handleRedeem,
} = useRedeemForm(channelKey)
</script>

<style scoped>
.ease-out-expo {
  transition-timing-function: cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-4px);
  }
  75% {
    transform: translateX(4px);
  }
}

.animate-shake {
  animation: shake 0.4s cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}
</style>

