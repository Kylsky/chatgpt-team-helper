<template>
  <RedeemShell maxWidth="max-w-screen-2xl">
    <div class="relative w-full">
      <div class="w-full">
        <div
          v-if="isRedirecting || isFetchingUser"
          class="w-full rounded-3xl bg-white/70 dark:bg-black/30 border border-white/40 dark:border-white/10 backdrop-blur-2xl p-6 flex flex-col items-center text-center gap-3 shadow-xl"
        >
          <div class="h-10 w-10 rounded-full bg-[#007AFF]/10 flex items-center justify-center">
            <span class="h-5 w-5 rounded-full border-2 border-[#007AFF] border-dashed animate-spin"></span>
          </div>
          <div class="space-y-1">
            <p class="text-lg font-semibold text-[#1d1d1f] dark:text-white">
              {{ isRedirecting ? '正在前往 Linux DO 授权' : '正在连接 Linux DO' }}
            </p>
            <p class="text-sm text-[#86868b]">请稍候，我们正在确认您的身份...</p>
          </div>
        </div>

        <div
          v-else-if="oauthError && !linuxDoUser"
          class="w-full rounded-3xl bg-white/70 dark:bg-black/30 border border-white/40 dark:border-white/10 backdrop-blur-2xl p-6 flex flex-col gap-4 shadow-xl"
        >
          <div class="flex items-center gap-3 text-left">
            <div class="h-10 w-10 rounded-full bg-[#FF3B30]/10 text-[#FF3B30] flex items-center justify-center">
              <AlertCircle class="h-5 w-5" />
            </div>
            <div>
              <p class="text-base font-semibold text-[#1d1d1f] dark:text-white">授权失败</p>
              <p class="text-sm text-[#86868b]">{{ oauthError }}</p>
            </div>
          </div>
          <AppleButton variant="secondary" class="w-full justify-center" @click="handleReauthorize">
            重新连接 Linux DO
          </AppleButton>
        </div>

        <template v-else-if="linuxDoUser">
          <div class="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between mb-10">
            <div class="space-y-3">
              <div class="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50/50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 text-blue-600 dark:text-blue-400 backdrop-blur-md">
                <span class="relative flex h-2 w-2">
                  <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span class="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                </span>
                <span class="text-xs font-semibold tracking-wide">Linux DO 已连接</span>
              </div>
              <h1 class="text-4xl sm:text-5xl font-extrabold tracking-tight text-[#1d1d1f] dark:text-white font-display">
                <span class="text-transparent bg-clip-text bg-gradient-to-r from-blue-600 via-purple-600 to-pink-600 dark:from-blue-400 dark:via-purple-400 dark:to-pink-400">
                  开放账号
                </span>
              </h1>
              <p class="text-lg text-[#86868b] max-w-lg leading-relaxed">
                实时监控账号池状态，展示当前可用的共享账号及其负载情况。
              </p>
              <!-- 规则提示 -->
              <div v-if="rules" class="flex flex-wrap gap-2 text-xs mt-1">
                <span class="relative group cursor-help inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-800 overflow-visible">
                  <span>消耗 {{ creditCostRange }} Credit</span>
                  <HelpCircle class="h-3 w-3" />
                  
                  <!-- Tooltip -->
                  <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-gray-900/90 dark:bg-white/90 text-white dark:text-black text-xs rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 z-50 pointer-events-none text-left">
                    <div class="font-bold mb-1 border-b border-white/20 dark:border-black/10 pb-1">折扣规则 (按剩余天数)</div>
                    <div class="space-y-0.5">
                      <div class="flex justify-between"><span>&lt; 7天</span><span class="font-mono">2折</span></div>
                      <div class="flex justify-between"><span>7~14天</span><span class="font-mono">4折</span></div>
                      <div class="flex justify-between"><span>14~20天</span><span class="font-mono">6折</span></div>
                      <div class="flex justify-between"><span>20~25天</span><span class="font-mono">8折</span></div>
                      <div class="flex justify-between"><span>&gt; 25天</span><span class="font-mono">原价</span></div>
                    </div>
                    <div class="absolute bottom-[-4px] left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-900/90 dark:bg-white/90 rotate-45"></div>
                  </div>
                </span>
                <span v-if="rules.dailyLimit" class="px-2 py-1 rounded-full bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400 border border-orange-100 dark:border-orange-800">
                  今日名额 {{ rules.todayBoardCount }}/{{ rules.dailyLimit }}
                </span>
                <span
                  v-if="rules.userDailyLimitEnabled && rules.userDailyLimit"
                  class="px-2 py-1 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-800"
                >
                  当日购买次数 {{ rules.userDailyLimitRemaining ?? 0 }}/{{ rules.userDailyLimit }}
                </span>
	                <span class="px-2 py-1 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-100 dark:border-amber-800">
	                  每日 {{ redeemBlockedHoursLabel }} 暂停兑换
	                </span>
		                <RouterLink
		                  to="/redeem/account-recovery"
		                  class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 border border-purple-100 dark:border-purple-800 hover:bg-purple-100/70 dark:hover:bg-purple-900/30 transition-colors cursor-pointer"
		                >
		                  <span>封禁补录入口</span>
		                  <ExternalLink class="h-3 w-3" />
		                </RouterLink>
	              </div>
	            </div>

            <div class="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
              <div class="hidden sm:block text-xs font-medium text-[#86868b] bg-gray-100/50 dark:bg-white/5 px-3 py-2 rounded-lg border border-black/5 dark:border-white/5">
                {{ userEmail || '未配置邮箱' }}
              </div>
              <div class="flex items-center gap-2 w-full sm:w-auto">
                <AppleButton variant="secondary" @click="openEmailDialog" :disabled="!sessionToken || savingEmail" class="flex-1 sm:flex-none justify-center">
                  {{ userEmail ? '修改邮箱' : '配置邮箱' }}
                </AppleButton>
                <AppleButton
                  variant="primary"
                  @click="loadOpenAccounts"
                  :loading="loading"
                  :disabled="openAccountsMaintenance || !sessionToken"
                  class="flex-1 sm:flex-none justify-center"
                >
                  {{ loading ? '刷新中' : '刷新列表' }}
                </AppleButton>
              </div>
            </div>
          </div>

          <div class="mt-8">
            <div
              v-if="loading"
              class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            >
              <div v-for="i in 8" :key="i" class="h-[220px] rounded-3xl bg-gray-100/50 dark:bg-white/5 animate-pulse"></div>
            </div>

	            <div
	              v-else-if="loadError"
	              class="w-full rounded-3xl bg-red-50/50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 backdrop-blur-2xl p-8 flex flex-col items-center justify-center gap-4 text-center min-h-[300px]"
	            >
              <div class="h-14 w-14 rounded-full bg-red-100 dark:bg-red-900/30 text-red-500 flex items-center justify-center mb-2">
                <AlertCircle class="h-7 w-7" />
              </div>
              <div class="space-y-1">
                <p class="text-lg font-bold text-[#1d1d1f] dark:text-white">无法加载账号列表</p>
                <p class="text-[#86868b]">{{ loadError }}</p>
              </div>
              <AppleButton variant="secondary" class="mt-4" @click="loadOpenAccounts">
                重试
              </AppleButton>
	            </div>

              <div
                v-else-if="openAccountsMaintenance"
                class="w-full rounded-3xl bg-amber-50/50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 backdrop-blur-2xl p-8 flex flex-col items-center justify-center gap-4 text-center min-h-[300px]"
              >
                <div class="h-14 w-14 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300 flex items-center justify-center mb-2">
                  <AlertCircle class="h-7 w-7" />
                </div>
                <div class="space-y-1">
                  <p class="text-lg font-bold text-[#1d1d1f] dark:text-white">{{ openAccountsMaintenanceMessage }}</p>
                  <p class="text-[#86868b]">开放账号暂不可用，请稍后再试。</p>
                </div>
              </div>

	            <div
	              v-else-if="accounts.length === 0"
	              class="w-full rounded-3xl bg-white/60 dark:bg-black/25 border border-white/40 dark:border-white/10 backdrop-blur-2xl p-12 text-center flex flex-col items-center justify-center min-h-[300px]"
	            >
              <div class="h-20 w-20 rounded-full bg-gray-50 dark:bg-white/5 flex items-center justify-center mb-4">
                <Users class="h-10 w-10 text-gray-400" />
              </div>
              <p class="text-lg font-medium text-[#1d1d1f] dark:text-white">暂无开放账号</p>
              <p class="text-[#86868b] mt-1">当前没有可用的共享账号，请稍后再来看看。</p>
            </div>

            <div v-else class="grid gap-6 sm:gap-6 lg:gap-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              <AppleCard
                v-for="(item, index) in sortedAccounts"
                :key="item.id"
                variant="glass"
                padding="none"
                radius="xl"
                :interactive="true"
                :class="[
                  'group relative overflow-hidden transition-all duration-500 flex flex-col h-full',
                  currentOpenAccountId === item.id
                    ? 'border-2 border-blue-500/80 dark:border-blue-400/80 shadow-[0_0_30px_rgba(59,130,246,0.2)] dark:shadow-[0_0_30px_rgba(96,165,250,0.15)] bg-blue-50/40 dark:bg-blue-500/5 ring-1 ring-blue-500/20'
                    : 'border border-white/60 dark:border-white/10 shadow-sm hover:shadow-xl'
                ]"
                :style="{ animationDelay: `${index * 50}ms` }"
              >
                <div class="relative p-5 flex flex-col h-full z-10">
                   <!-- Header: Icon + Info + Status -->
                   <div class="flex items-start gap-4 mb-5">
                      <!-- Icon -->
                      <div class="h-12 w-12 shrink-0 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg shadow-blue-500/30 text-white flex items-center justify-center transform group-hover:scale-105 transition-transform duration-500 ring-4 ring-white/10">
                        <span class="text-lg font-bold font-mono">{{ (item.emailPrefix || 'A').charAt(0).toUpperCase() }}</span>
                      </div>

                      <!-- Name & Meta -->
                      <div class="flex-1 min-w-0 pt-0.5">
                          <div class="flex items-center justify-between gap-2 mb-1">
                              <div class="flex items-center gap-2 min-w-0">
                                <h3 class="text-lg font-bold text-[#1d1d1f] dark:text-white font-display tracking-tight truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                  {{ item.emailPrefix || 'Unknown' }}
                                </h3>
                                
                                <!-- Discount Badge -->
                                <div
                                  v-if="getDiscountInfo(item.expireAt)"
                                  :class="[
                                    'shrink-0 px-1.5 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider shadow-sm flex items-center justify-center',
                                    getDiscountInfo(item.expireAt)!.color,
                                    getDiscountInfo(item.expireAt)!.text
                                  ]"
                                >
                                  {{ getDiscountInfo(item.expireAt)!.label }}
                                </div>

	                              </div>
                              
                              <!-- Status Badge -->
                              <div
                                v-if="currentOpenAccountId === item.id"
                                class="shrink-0 px-2 py-0.5 rounded-full bg-blue-500 text-white text-[10px] font-bold uppercase tracking-wider shadow-lg shadow-blue-500/20 flex items-center gap-1"
                              >
                                <div class="w-1 h-1 rounded-full bg-white animate-pulse"></div>
                                已上车
                              </div>
                              <div
     v-else
                                class="shrink-0 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1"
                              >
                                <div class="w-1 h-1 rounded-full bg-emerald-500"></div>
                                可加入
                              </div>
                          </div>

                          <div class="flex items-center gap-1 text-xs text-[#86868b] dark:text-gray-400 truncate">
                            <Calendar class="h-3.5 w-3.5 shrink-0" />
                            <span class="truncate">到期：{{ item.expireAt || '未设置' }}</span>
                          </div>
                          <div class="flex items-center gap-1 text-xs text-[#86868b] dark:text-gray-400 truncate mt-1">
                            <span class="truncate">消耗：{{ item.creditCost || rules?.creditCost || '未知' }} Credit</span>
                          </div>
                      </div>
                   </div>

                   <!-- Stats Row (Compact) -->
                   <div class="grid grid-cols-2 gap-3 mb-5">
                      <div class="bg-white/50 dark:bg-white/5 rounded-xl p-2.5 flex items-center gap-3 border border-black/5 dark:border-white/5 group/stat hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors">
       <div class="h-8 w-8 rounded-lg bg-blue-50 dark:bg-blue-500/20 flex items-center justify-center text-blue-500 dark:text-blue-400 shrink-0">
                            <Users class="h-4 w-4" />
                         </div>
                         <div class="min-w-0">
                            <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider leading-none mb-1 truncate">Joined</div>
                            <div class="text-lg font-bold text-[#1d1d1f] dark:text-white tabular-nums leading-none">{{ item.joinedCount }}</div>
                         </div>
                      </div>
                      <div class="bg-white/50 dark:bg-white/5 rounded-xl p-2.5 flex items-center gap-3 border border-black/5 dark:border-white/5 group/stat hover:bg-purple-50/50 dark:hover:bg-purple-500/10 transition-colors">
                         <div class="h-8 w-8 rounded-lg bg-purple-50 dark:bg-purple-500/20 flex items-center justify-center text-purple-500 dark:text-purple-400 shrink-0">
                            <Clock class="h-4 w-4" />
                         </div>
                         <div class="min-w-0">
                            <div class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider leading-none mb-1 truncate">Remaining</div>
                            <div class="text-lg font-bold text-[#1d1d1f] dark:text-white tabular-nums leading-none">{{ item.remainingCodes }}</div>
                         </div>
                      </div>
                   </div>

                   <!-- Spacer -->
                   <div class="flex-1"></div>

	                   <!-- Action Button -->
	                   <AppleButton
                      v-if="currentOpenAccountId === item.id"
                      variant="secondary"
                      class="w-full justify-center h-9 text-sm"
                      :disabled="true"
                    >
                      已上车
                    </AppleButton>
                    <AppleButton
                      v-else
                      variant="premium"
                      class="w-full justify-center h-9 text-sm"
                      :disabled="!sessionToken || selectingAccountId !== null"
                      :loading="selectingAccountId === item.id"
                      @click.stop="board(item.id)"
                    >
                      <span v-if="selectingAccountId === item.id">上车中…</span>
                      <span v-else>{{ !userEmail ? '先配置邮箱' : '立即上车' }}</span>
                    </AppleButton>

                    <!-- Decorative Elements (Removed for performance) -->
                    <!-- <div class="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-blue-500/10 to-transparent rounded-bl-[100px] pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div> -->
                    <!-- <div class="absolute -bottom-20 -right-20 w-64 h-64 bg-gradient-to-t from-blue-500/10 to-purple-500/5 rounded-full blur-3xl pointer-events-none group-hover:scale-125 transition-transform duration-700"></div> -->
                </div>
              </AppleCard>
            </div>
          </div>
        </template>
      </div>

	      <LinuxDoUserPopover
	        v-if="linuxDoUser"
	        :user="linuxDoUser"
	        :avatar-url="avatarUrl"
	        :display-name="linuxDoDisplayName"
	        :trust-level-label="trustLevelLabel"
	        :github-repo-url="githubRepoUrl"
	        @reauthorize="handleReauthorize"
	      />

	      <Dialog v-model:open="showEmailDialog">
	        <DialogContent :showClose="false" class="sm:max-w-[360px] p-0 overflow-hidden rounded-[20px] border-0 shadow-2xl bg-transparent">
	          <div class="absolute inset-0 bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-md z-0"></div>

          <div class="relative z-10 flex flex-col items-center pt-6 pb-5 px-5 text-center">
            <div class="h-12 w-12 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mb-3 shadow-sm">
               <Mail class="h-6 w-6 text-blue-600 dark:text-blue-500" />
            </div>

            <DialogHeader class="mb-5 space-y-1.5 w-full">
              <DialogTitle class="text-[17px] font-semibold text-[#1d1d1f] dark:text-white">配置接收邮箱</DialogTitle>
              <DialogDescription class="text-[13px] text-gray-500 dark:text-gray-400 leading-normal mx-auto">
                请输入常用邮箱以接收邀请通知。保存前会进行一次确认。
              </DialogDescription>
            </DialogHeader>

            <div class="w-full space-y-3">
              <AppleInput
                v-model.trim="emailDraft"
                placeholder="name@example.com"
                type="email"
                variant="filled"
                :disabled="savingEmail"
                :error="emailError"
                clearable
                class="bg-transparent"
              />
            </div>
          </div>

          <div class="relative z-10 flex border-t border-gray-300/30 dark:border-white/10 mt-auto divide-x divide-gray-300/30 dark:divide-white/10">
            <button
              @click="showEmailDialog = false"
              :disabled="savingEmail"
              class="flex-1 py-3 text-[15px] font-medium text-[#007AFF] hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors disabled:opacity-50 active:bg-gray-200/50"
            >
              取消
            </button>
            <button
              @click="saveEmail"
              :disabled="!sessionToken || savingEmail"
              class="flex-1 py-3 text-[15px] font-semibold text-[#007AFF] hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50 active:bg-blue-100/50 relative"
            >
              <span v-if="savingEmail" class="absolute inset-0 flex items-center justify-center">
                <span class="h-4 w-4 border-2 border-[#007AFF] border-r-transparent rounded-full animate-spin"></span>
              </span>
              <span :class="{ 'opacity-0': savingEmail }">保存</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

	      <Dialog v-model:open="showEmailSaveConfirm">
	        <DialogContent :showClose="false" class="sm:max-w-[360px] p-0 overflow-hidden rounded-[20px] border-0 shadow-2xl bg-transparent">
	          <div class="absolute inset-0 bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-md z-0"></div>

          <div class="relative z-10 flex flex-col items-center pt-6 pb-5 px-5 text-center">
            <div class="h-12 w-12 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mb-3 shadow-sm">
              <Mail class="h-6 w-6 text-blue-600 dark:text-blue-500" />
            </div>

            <DialogHeader class="mb-3 space-y-1.5 w-full">
              <DialogTitle class="text-[17px] font-semibold text-[#1d1d1f] dark:text-white">确认保存邮箱？</DialogTitle>
            </DialogHeader>

            <div class="space-y-3 text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed px-1">
              <p>
                将保存为：
                <span class="font-mono text-[#1d1d1f] dark:text-white break-all">{{ emailDraft || '-' }}</span>
              </p>
            </div>
          </div>

          <div class="relative z-10 flex border-t border-gray-300/30 dark:border-white/10 mt-auto divide-x divide-gray-300/30 dark:divide-white/10">
            <button
              @click="cancelEmailSaveConfirm"
              :disabled="savingEmail"
              class="flex-1 py-3 text-[15px] font-medium text-[#007AFF] hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors disabled:opacity-50 active:bg-gray-200/50"
            >
              返回修改
            </button>
            <button
              @click="confirmEmailSave"
              :disabled="!sessionToken || savingEmail"
              class="flex-1 py-3 text-[15px] font-semibold text-[#007AFF] hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50 active:bg-blue-100/50 relative"
            >
              <span v-if="savingEmail" class="absolute inset-0 flex items-center justify-center">
                <span class="h-4 w-4 border-2 border-[#007AFF] border-r-transparent rounded-full animate-spin"></span>
              </span>
              <span :class="{ 'opacity-0': savingEmail }">确认</span>
            </button>
          </div>
        </DialogContent>
      </Dialog>

	      <Dialog v-model:open="showNoWarrantySwitchDialog">
	        <DialogContent :showClose="false" class="sm:max-w-[360px] p-0 overflow-hidden rounded-[20px] border-0 shadow-2xl bg-transparent">
	          <div class="absolute inset-0 bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-md z-0"></div>

          <div class="relative z-10 flex flex-col items-center pt-6 pb-5 px-5 text-center">
            <div class="h-12 w-12 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center mb-3 shadow-sm">
              <AlertCircle class="h-6 w-6 text-blue-600 dark:text-blue-500" />
            </div>

            <DialogHeader class="mb-3 space-y-1.5 w-full">
              <DialogTitle class="text-[17px] font-semibold text-[#1d1d1f] dark:text-white">当前订阅无质保</DialogTitle>
            </DialogHeader>

            <DialogDescription class="text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed px-1">
              {{ noWarrantySwitchMessage }}
            </DialogDescription>
          </div>

          <div class="relative z-10 flex border-t border-gray-300/30 dark:border-white/10 mt-auto divide-x divide-gray-300/30 dark:divide-white/10">
            <button
              @click="closeNoWarrantySwitchDialog"
              class="flex-1 py-3 text-[15px] font-medium text-[#007AFF] hover:bg-gray-100/50 dark:hover:bg-white/5 transition-colors active:bg-gray-200/50"
            >
              取消
            </button>
            <button
              @click="goToPurchase"
              class="flex-1 py-3 text-[15px] font-semibold text-[#007AFF] hover:bg-blue-50/50 dark:hover:bg-blue-500/10 transition-colors active:bg-blue-100/50"
            >
              去下单
            </button>
          </div>
        </DialogContent>
      </Dialog>

	    </div>
	  </RedeemShell>
	</template>

	<script setup lang="ts">
		import { AlertCircle, Mail, Users, Clock, Calendar, HelpCircle, ExternalLink } from 'lucide-vue-next'
	import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { useRouter } from 'vue-router'
	import AppleButton from '@/components/ui/apple/Button.vue'
	import AppleCard from '@/components/ui/apple/Card.vue'
	import AppleInput from '@/components/ui/apple/Input.vue'
	import RedeemShell from '@/components/RedeemShell.vue'
	import LinuxDoUserPopover from '@/components/LinuxDoUserPopover.vue'
	import { useLinuxDoAuthSession } from '@/composables/useLinuxDoAuthSession'
	import { creditService, openAccountsService, linuxDoUserService, type OpenAccountItem, type OpenAccountsResponse } from '@/services/api'
		import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
	import { useToast } from '@/components/ui/toast'
  import { useAppConfigStore } from '@/stores/appConfig'

	const githubRepoUrl = 'https://github.com/Kylsky/chatgpt-team-helper'

	const accounts = ref<OpenAccountItem[]>([])
	const loading = ref(false)
	const loadError = ref('')
  const serverMaintenance = ref(false)
  const serverMaintenanceMessage = ref('')
	const userEmail = ref('')
	const currentOpenAccountId = ref<number | null>(null)
const showEmailDialog = ref(false)
const showEmailSaveConfirm = ref(false)
const showNoWarrantySwitchDialog = ref(false)
const emailDraft = ref('')
const emailError = ref('')
const savingEmail = ref(false)
const selectingAccountId = ref<number | null>(null)
const pendingCreditOrderNo = ref<string | null>(null)
const pendingCreditAccountId = ref<number | null>(null)
const creditPollingTimer = ref<number | null>(null)
const creditPollingInFlight = ref(false)
const rules = ref<OpenAccountsResponse['rules'] | null>(null)

const creditCostRange = computed(() => {
  if (!rules.value?.creditCost) return '...'
  const base = parseFloat(rules.value.creditCost)
  if (isNaN(base)) return rules.value.creditCost
  // 简单的去除多余零的格式化
  const fmt = (n: number) => parseFloat(n.toFixed(2)).toString()
  return `${fmt(base * 0.2)} ~ ${fmt(base)}`
})

const redeemBlockedHoursLabel = computed(() => {
  const start = rules.value?.redeemBlockedHours?.start ?? 0
  const end = rules.value?.redeemBlockedHours?.end ?? 8
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(start)}:00-${pad(end)}:00`
})

const redeemBlockedMessage = computed(() => {
  if (rules.value?.redeemBlockedMessage) return rules.value.redeemBlockedMessage
  const end = rules.value?.redeemBlockedHours?.end ?? 8
  const pad = (value: number) => String(value).padStart(2, '0')
  return `开放账号每日 ${redeemBlockedHoursLabel.value} 暂停兑换，请在 ${pad(end)}:00 后再试`
})

const redeemBlockedNow = computed(() => {
  if (typeof rules.value?.redeemBlockedNow === 'boolean') {
    return rules.value.redeemBlockedNow
  }
  const start = rules.value?.redeemBlockedHours?.start ?? 0
  const end = rules.value?.redeemBlockedHours?.end ?? 8
  const hour = new Date().getHours()
  return hour >= start && hour < end
})

const sortedAccounts = computed(() => {
  const list = accounts.value || []
  const currentId = currentOpenAccountId.value
  if (!currentId) return list
  const current = list.find(item => item.id === currentId)
  if (!current) return list
  return [current, ...list.filter(item => item.id !== currentId)]
})

const {
  linuxDoUser,
  sessionToken,
  oauthError,
  isRedirecting,
  isFetchingUser,
  avatarUrl,
  trustLevelLabel,
  linuxDoDisplayName,
  handleReauthorize,
} = useLinuxDoAuthSession({ redirectRouteName: 'linux-do-open-accounts' })

	const { success: showSuccessToast, error: showErrorToast, info: showInfoToast } = useToast()
  const router = useRouter()
  const appConfigStore = useAppConfigStore()
  const noWarrantySwitchMessage = ref('当前订阅账号无质保，需重新下单')

  const openAccountsMaintenance = computed(() => serverMaintenance.value)
  const openAccountsMaintenanceMessage = computed(() => {
    return serverMaintenanceMessage.value || appConfigStore.openAccountsMaintenanceMessage || '平台维护中'
  })

	const validateEmail = (value: string) => {
	  const trimmed = String(value || '').trim()
	  if (!trimmed) return ''
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(trimmed)) return '请输入有效的邮箱格式'
  return ''
}

const getDiscountInfo = (expireAtStr?: string | null) => {
  if (!expireAtStr) return null

  const expireDate = new Date(expireAtStr)
  if (isNaN(expireDate.getTime())) return null

  const now = new Date()
  const diffTime = expireDate.getTime() - now.getTime()
  const diffDays = diffTime / (1000 * 60 * 60 * 24)

  if (diffDays < 0) return null

  if (diffDays < 7) {
    return { label: '2折', color: 'bg-rose-500', text: 'text-white' }
  } else if (diffDays < 14) {
    return { label: '4折', color: 'bg-orange-500', text: 'text-white' }
  } else if (diffDays < 20) {
    return { label: '6折', color: 'bg-amber-500', text: 'text-white' }
  } else if (diffDays < 25) {
    return { label: '8折', color: 'bg-emerald-500', text: 'text-white' }
  }

  return null
}

const loadMe = async () => {
  if (!linuxDoUser.value) return
  if (!sessionToken.value) return
  try {
    const me = await linuxDoUserService.getMe(sessionToken.value)
    userEmail.value = me.email || ''
    currentOpenAccountId.value = me.currentOpenAccountId ?? null
    emailDraft.value = userEmail.value
  } catch (error: any) {
    console.warn('读取 Linux DO 用户邮箱失败:', error?.response?.data?.error || error?.message || error)
  }
}

	const loadOpenAccounts = async () => {
	  if (!linuxDoUser.value) return
	  if (!sessionToken.value) return
	  loading.value = true
	  loadError.value = ''
    serverMaintenance.value = false
    serverMaintenanceMessage.value = ''
	  try {
	    const response = await openAccountsService.list(sessionToken.value)
	    accounts.value = response.items || []
	    rules.value = response.rules || null
	  } catch (error: any) {
      const code = error?.response?.data?.code
      const message = error?.response?.data?.error || '加载失败，请稍后重试'
      if (code === 'OPEN_ACCOUNTS_MAINTENANCE') {
        accounts.value = []
        rules.value = null
        loadError.value = ''
        serverMaintenance.value = true
        serverMaintenanceMessage.value = message || '平台维护中'
        return
      }
	    loadError.value = message
	  } finally {
	    loading.value = false
	  }
	}

watch([linuxDoUser, sessionToken], ([user, token]) => {
  if (!user) return
  if (!token) {
    handleReauthorize()
    return
  }
  loadOpenAccounts()
  loadMe()
})

const openEmailDialog = () => {
  emailError.value = ''
  emailDraft.value = userEmail.value
  showEmailDialog.value = true
}

const cancelEmailSaveConfirm = () => {
  showEmailSaveConfirm.value = false
  showEmailDialog.value = true
}

const openNoWarrantySwitchDialog = (message?: string) => {
  noWarrantySwitchMessage.value = message || '当前订阅账号无质保，需重新下单'
  showNoWarrantySwitchDialog.value = true
}

const closeNoWarrantySwitchDialog = () => {
  showNoWarrantySwitchDialog.value = false
}

const goToPurchase = () => {
  showNoWarrantySwitchDialog.value = false
  router.push('/purchase')
}

const doSaveEmail = async () => {
  if (!sessionToken.value) return
  try {
    const me = await linuxDoUserService.updateEmail(sessionToken.value, emailDraft.value)
    userEmail.value = me.email || ''
    currentOpenAccountId.value = me.currentOpenAccountId ?? null
    showEmailDialog.value = false
    showEmailSaveConfirm.value = false
    showSuccessToast('邮箱已更新')
  } catch (error: any) {
    emailError.value = error.response?.data?.error || '保存失败，请稍后重试'
    showEmailSaveConfirm.value = false
  }
}

const saveEmail = async () => {
  if (!sessionToken.value) return
  emailError.value = validateEmail(emailDraft.value)
  if (emailError.value) return

  const oldNormalized = String(userEmail.value || '').trim().toLowerCase()
  const newNormalized = String(emailDraft.value || '').trim().toLowerCase()
  if (oldNormalized !== newNormalized) {
    showEmailDialog.value = false
    showEmailSaveConfirm.value = true
    return
  }

  savingEmail.value = true
  try {
    await doSaveEmail()
  } finally {
    savingEmail.value = false
  }
}

const confirmEmailSave = async () => {
  if (!sessionToken.value) return
  emailError.value = validateEmail(emailDraft.value)
  if (emailError.value) return
  savingEmail.value = true
  try {
    await doSaveEmail()
  } finally {
    savingEmail.value = false
  }
}

watch(emailDraft, () => {
  if (emailError.value) emailError.value = validateEmail(emailDraft.value)
})

const stopCreditPolling = () => {
  if (creditPollingTimer.value) {
    window.clearInterval(creditPollingTimer.value)
    creditPollingTimer.value = null
  }
  pendingCreditOrderNo.value = null
  pendingCreditAccountId.value = null
}

const openCreditPayPage = (creditOrder?: { payUrl?: string | null; payRequest?: { method?: 'POST' | 'GET'; url: string; fields?: Record<string, string> } }) => {
  if (typeof window === 'undefined') return
  const payUrl = creditOrder?.payUrl ? String(creditOrder.payUrl) : ''
  if (payUrl) {
    console.info('[OpenAccounts][Credit] open payUrl', { payUrl })
    window.open(payUrl, '_blank')
    return
  }

  const request = creditOrder?.payRequest
  if (!request?.url) return

  const fields = request.fields || {}
  console.info('[OpenAccounts][Credit] submit pay form', {
    method: request.method === 'GET' ? 'GET' : 'POST',
    url: request.url,
    payload: {
      pid: fields.pid,
      type: fields.type,
      out_trade_no: fields.out_trade_no,
      name: fields.name,
      money: fields.money,
      notify_url: fields.notify_url,
      device: fields.device,
      sign_type: fields.sign_type,
      signPrefix: typeof fields.sign === 'string' ? fields.sign.slice(0, 8) : null,
      signLength: typeof fields.sign === 'string' ? fields.sign.length : null
    }
  })

  const form = document.createElement('form')
  form.method = request.method === 'GET' ? 'GET' : 'POST'
  form.action = request.url
  form.target = '_blank'
  form.style.display = 'none'

  Object.entries(fields).forEach(([name, value]) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = String(value ?? '')
    form.appendChild(input)
  })

  document.body.appendChild(form)
  form.submit()
  form.remove()
}

	const pollCreditOrder = async () => {
	  if (!sessionToken.value) return
	  if (!pendingCreditOrderNo.value) return
	  if (!pendingCreditAccountId.value) return
	  if (creditPollingInFlight.value) return

  creditPollingInFlight.value = true
  try {
    const response = await creditService.getOrder(sessionToken.value, pendingCreditOrderNo.value)
    const order = response.order

    if (order.status === 'paid') {
      const result = await openAccountsService.board(sessionToken.value, pendingCreditAccountId.value, {
        creditOrderNo: order.orderNo
      })

	      if ('requiresCredit' in result) {
	        showErrorToast('Credit 订单状态异常，请刷新后重试')
	        stopCreditPolling()
	        return
	      }

      currentOpenAccountId.value = result.currentOpenAccountId
      await loadOpenAccounts()
      await loadMe()
      showSuccessToast(result.message || '上车成功')
      stopCreditPolling()
      return
    }

    if (['failed', 'expired', 'refunded'].includes(order.status)) {
      showErrorToast(order.actionMessage || order.refundMessage || `Credit 订单状态异常：${order.status}`)
      stopCreditPolling()
    }
	  } catch (error: any) {
	    const message = error?.response?.data?.error || error?.message || '查询 Credit 订单失败'
      if (error?.response?.data?.code === 'OPEN_ACCOUNTS_MAINTENANCE') {
        serverMaintenance.value = true
        serverMaintenanceMessage.value = message
      }
      if (error?.response?.data?.code === 'NO_WARRANTY_ORDER') {
        openNoWarrantySwitchDialog(message)
        stopCreditPolling()
        return
      }
	    showErrorToast(message)
	    stopCreditPolling()
	  } finally {
	    creditPollingInFlight.value = false
	  }
}

const startCreditPolling = (orderNo: string, accountId: number) => {
  if (typeof window === 'undefined') return
  stopCreditPolling()
  pendingCreditOrderNo.value = orderNo
  pendingCreditAccountId.value = accountId
  void pollCreditOrder()
  creditPollingTimer.value = window.setInterval(() => {
    void pollCreditOrder()
  }, 3000)
}

const doBoard = async (accountId: number) => {
  if (!sessionToken.value) return
  if (redeemBlockedNow.value) {
    showErrorToast(redeemBlockedMessage.value)
    return
  }
  if (!userEmail.value) {
    showErrorToast('请先配置接收邮箱')
    openEmailDialog()
    return
  }
  selectingAccountId.value = accountId
  loadError.value = ''
  try {
    const result = await openAccountsService.board(sessionToken.value, accountId)

	    if ('requiresCredit' in result) {
	      showInfoToast(result.message || '请在新窗口完成 Credit 授权')
	      openCreditPayPage(result.creditOrder)
	      startCreditPolling(result.creditOrder.orderNo, accountId)
	      return
	    }

    currentOpenAccountId.value = result.currentOpenAccountId
    await loadOpenAccounts()
    await loadMe()
    showSuccessToast(result.message || '上车成功')
	  } catch (error: any) {
      const code = error?.response?.data?.code
      const message = error.response?.data?.error || error?.message || '上车失败，请稍后重试'
      if (code === 'OPEN_ACCOUNTS_MAINTENANCE') {
        accounts.value = []
        rules.value = null
        loadError.value = ''
        serverMaintenance.value = true
        serverMaintenanceMessage.value = message
        return
      }
      if (code === 'NO_WARRANTY_ORDER') {
        loadError.value = ''
        openNoWarrantySwitchDialog(message)
        return
      }
	    loadError.value = message
			  } finally {
			    selectingAccountId.value = null
			  }
			}

const board = async (accountId: number) => {
  await doBoard(accountId)
}

onMounted(() => {
  // useLinuxDoAuthSession 会处理授权流程，这里只需等待即可
})

onBeforeUnmount(() => {
  stopCreditPolling()
})
</script>
