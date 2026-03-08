import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { configService, type AppRuntimeConfig } from '@/services/api'
import type { Channel } from '@/services/api'

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const DEFAULT_LOCALE = 'zh-CN'
const DEFAULT_OPEN_ACCOUNTS_MAINTENANCE_MESSAGE = '平台维护中'
const FALLBACK_TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim()

export type SiteNoticeState = {
  enabled: boolean
  text: string
  link: string
}

export type FeatureFlags = {
  xhs: boolean
  xianyu: boolean
  payment: boolean
  openAccounts: boolean
}

export const useAppConfigStore = defineStore('app-config', () => {
  const timezone = ref<string>(DEFAULT_TIMEZONE)
  const locale = ref<string>(DEFAULT_LOCALE)
  const loaded = ref(false)
  const turnstileSiteKey = ref('')
  const turnstileEnabled = ref<boolean | null>(null)
  const channels = ref<Channel[]>([])
  const openAccountsEnabled = ref(true)
  const openAccountsMaintenanceMessage = ref(DEFAULT_OPEN_ACCOUNTS_MAINTENANCE_MESSAGE)
  const siteNotice = ref<SiteNoticeState>({
    enabled: false,
    text: '',
    link: ''
  })
  const features = ref<FeatureFlags>({
    xhs: true,
    xianyu: true,
    payment: true,
    openAccounts: true
  })

  const resolvedTurnstileSiteKey = computed(() => (turnstileSiteKey.value || FALLBACK_TURNSTILE_SITE_KEY || '').trim())
  const resolvedTurnstileEnabled = computed(() => {
    if (!resolvedTurnstileSiteKey.value) {
      return false
    }
    if (typeof turnstileEnabled.value === 'boolean') {
      return turnstileEnabled.value
    }
    return Boolean(resolvedTurnstileSiteKey.value)
  })

  const applyConfig = (config?: Partial<AppRuntimeConfig>) => {
    if (!config) return
    if (config.timezone) {
      timezone.value = config.timezone
    }
    if (config.locale) {
      locale.value = config.locale
    }
    if ('turnstileSiteKey' in config) {
      turnstileSiteKey.value = (config.turnstileSiteKey || '').trim()
    }
    if ('turnstileEnabled' in config) {
      const value = (config.turnstileEnabled ?? null) as boolean | null
      turnstileEnabled.value = value === null ? null : Boolean(value)
    }
    if ('openAccountsEnabled' in config) {
      const value = config.openAccountsEnabled
      openAccountsEnabled.value = value === undefined || value === null ? true : Boolean(value)
    }
    if ('openAccountsMaintenanceMessage' in config) {
      const value = (config.openAccountsMaintenanceMessage || '').trim()
      openAccountsMaintenanceMessage.value = value || DEFAULT_OPEN_ACCOUNTS_MAINTENANCE_MESSAGE
    }
    if (config.siteNotice && typeof config.siteNotice === 'object') {
      siteNotice.value = {
        enabled: Boolean(config.siteNotice.enabled),
        text: String(config.siteNotice.text || '').trim(),
        link: String(config.siteNotice.link || '').trim()
      }
    }
    if (config.features && typeof config.features === 'object') {
      const next = { ...features.value }
      if ('xhs' in config.features) next.xhs = Boolean((config.features as any).xhs)
      if ('xianyu' in config.features) next.xianyu = Boolean((config.features as any).xianyu)
      if ('payment' in config.features) next.payment = Boolean((config.features as any).payment)
      if ('openAccounts' in config.features) next.openAccounts = Boolean((config.features as any).openAccounts)
      features.value = next
    }
    if (Array.isArray(config.channels)) {
      channels.value = config.channels as Channel[]
    }
  }

  const loadConfig = async () => {
    if (loaded.value) return
    try {
      const runtimeConfig = await configService.getRuntimeConfig()
      applyConfig(runtimeConfig)
    } catch (error) {
      console.warn('加载系统配置失败，使用默认值', error)
    } finally {
      loaded.value = true
    }
  }

  return {
    timezone,
    locale,
    loaded,
    turnstileSiteKey,
    turnstileEnabled,
    channels,
    openAccountsEnabled,
    openAccountsMaintenanceMessage,
    siteNotice,
    features,
    resolvedTurnstileSiteKey,
    resolvedTurnstileEnabled,
    loadConfig
  }
})
