import express from 'express'
import { getDatabase } from '../database/init.js'
import { getTurnstileSettings } from '../utils/turnstile-settings.js'
import { getFeatureFlags } from '../utils/feature-flags.js'
import { getSystemConfigValue } from '../utils/system-config.js'

const router = express.Router()

const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const DEFAULT_LOCALE = 'zh-CN'
const DEFAULT_OPEN_ACCOUNTS_MAINTENANCE_MESSAGE = '平台维护中'

const isEnabledFlag = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') return Boolean(defaultValue)
  const raw = String(value).trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const isOpenAccountsEnabled = () => isEnabledFlag(process.env.OPEN_ACCOUNTS_ENABLED, true)

const getOpenAccountsMaintenanceMessage = () => {
  const message = String(process.env.OPEN_ACCOUNTS_MAINTENANCE_MESSAGE || DEFAULT_OPEN_ACCOUNTS_MAINTENANCE_MESSAGE).trim()
  return message || DEFAULT_OPEN_ACCOUNTS_MAINTENANCE_MESSAGE
}

const getSiteNoticeConfig = async () => {
  const db = await getDatabase()
  const enabledRaw = String(getSystemConfigValue(db, 'site_notice_enabled') || '').trim().toLowerCase()
  return {
    enabled: enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'yes' || enabledRaw === 'on',
    text: String(getSystemConfigValue(db, 'site_notice_text') || '').trim()
  }
}

router.get('/runtime', async (req, res) => {
  try {
    const timezone = process.env.TZ || DEFAULT_TIMEZONE
    const locale = process.env.APP_LOCALE || DEFAULT_LOCALE
    const openAccountsEnabled = isOpenAccountsEnabled()
    const turnstileSettings = await getTurnstileSettings()
    const turnstileSiteKey = String(turnstileSettings.siteKey || '').trim()
    const features = await getFeatureFlags()
    const siteNotice = await getSiteNoticeConfig()

    res.json({
      timezone,
      locale,
      turnstileEnabled: Boolean(turnstileSettings.enabled),
      turnstileSiteKey: turnstileSiteKey || null,
      features,
      channels,
      openAccountsEnabled,
      openAccountsMaintenanceMessage: openAccountsEnabled ? null : getOpenAccountsMaintenanceMessage(),
      siteNotice
    })
  } catch (error) {
    console.error('[Config] runtime error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
