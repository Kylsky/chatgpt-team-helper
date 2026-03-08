import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/rbac.js'
import { buildMenuTree, listMenus } from '../services/rbac.js'
import { parseDomainWhitelist, getEmailDomainWhitelistFromEnv } from '../utils/email-domain-whitelist.js'
import { getPointsWithdrawSettings } from '../utils/points-withdraw-settings.js'
import { listUserPointsLedger, safeInsertPointsLedgerEntry } from '../utils/points-ledger.js'
import { upsertSystemConfigValue } from '../utils/system-config.js'
import { getSmtpSettings, getSmtpSettingsFromEnv, invalidateSmtpSettingsCache, parseBool } from '../utils/smtp-settings.js'
import { sendSmtpTestEmail } from '../services/email-service.js'
import {
  getLinuxDoOAuthSettings,
  getLinuxDoOAuthSettingsFromEnv,
  getLinuxDoCreditSettings,
  getLinuxDoCreditSettingsFromEnv,
  invalidateLinuxDoSettingsCache
} from '../utils/linuxdo-settings.js'
import { getZpaySettings, getZpaySettingsFromEnv, invalidateZpaySettingsCache } from '../utils/zpay-settings.js'
import { getTurnstileSettings, getTurnstileSettingsFromEnv, invalidateTurnstileSettingsCache } from '../utils/turnstile-settings.js'
import { getTelegramSettings, getTelegramSettingsFromEnv, invalidateTelegramSettingsCache } from '../utils/telegram-settings.js'
import { getFeatureFlags, invalidateFeatureFlagsCache } from '../utils/feature-flags.js'
import { CHANNEL_KEY_REGEX, getChannelByKey, getChannels, invalidateChannelsCache, normalizeChannelKey } from '../utils/channels.js'
import { getAccountRecoverySettings, invalidateAccountRecoverySettingsCache } from '../utils/account-recovery-settings.js'
import {
  PRODUCT_KEY_REGEX,
  getPurchaseProductByKey,
  listPurchaseProducts,
  normalizeCodeChannels,
  normalizeOrderType as normalizePurchaseProductOrderType,
  normalizeProductKey,
  disablePurchaseProduct,
  upsertPurchaseProduct,
} from '../services/purchase-products.js'
import { withLocks } from '../utils/locks.js'
import { redeemCodeInternal } from './redemption-codes.js'
import { resolveOrderDeadlineMs, selectRecoveryCode } from '../services/account-recovery.js'

const router = express.Router()

router.use(authenticateToken, requireSuperAdmin)

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()
const extractEmailFromRedeemedBy = (redeemedBy) => {
  const raw = String(redeemedBy ?? '').trim()
  if (!raw) return ''

  const match = raw.match(/email\s*:\s*([^|]+)(?:\||$)/i)
  if (match?.[1]) {
    return normalizeEmail(match[1])
  }

  const normalized = normalizeEmail(raw)
  return EMAIL_REGEX.test(normalized) ? normalized : ''
}

const normalizeAdminMenuPath = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''

  if (raw.startsWith('/')) {
    if (raw === '/admin' || raw.startsWith('/admin/')) return raw
    return null
  }

  let relative = raw
  if (relative.startsWith('admin/')) relative = relative.slice('admin/'.length)
  if (relative.startsWith('./')) relative = relative.slice(2)
  relative = relative.replace(/^\/+/, '')
  if (!relative) return '/admin'
  return `/admin/${relative}`
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const suggestSmtpTestFix = (error) => {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '').toLowerCase()
  if (code === 'SMTP_CONFIG_INCOMPLETE') return '请补全 SMTP_HOST/SMTP_USER/SMTP_PASS 等配置后再测试'
  if (code === 'SMTP_RECIPIENTS_EMPTY') return '请先在 ADMIN_ALERT_EMAIL 中配置收件人'
  if (code === 'EAUTH') return '认证失败，请检查用户名、密码/授权码是否正确'
  if (code === 'ETIMEDOUT') return '连接超时，请检查 SMTP 主机、端口或网络防火墙'
  if (code === 'ECONNECTION' || code === 'ECONNREFUSED') return '无法连接，请检查 SMTP 主机、端口是否可达'
  if (code === 'ESOCKET' && (message.includes('ssl') || message.includes('tls'))) {
    return 'TLS/SSL 握手失败，请检查端口与安全连接设置是否匹配'
  }
  if (message.includes('ssl') || message.includes('tls')) {
    return 'TLS/SSL 握手失败，请检查端口与安全连接设置是否匹配'
  }
  return ''
}

const mapSmtpTestError = (error) => {
  const code = String(error?.code || 'SMTP_TEST_FAILED')
  const message = String(error?.message || 'SMTP 测试失败')
  const suggestion = suggestSmtpTestFix(error)
  const status = ['SMTP_CONFIG_INCOMPLETE', 'SMTP_RECIPIENTS_EMPTY', 'EAUTH'].includes(code) ? 400 : 500
  return {
    status,
    error: message,
    code,
    suggestion,
    traceId: error?.traceId,
    durationMs: error?.durationMs
  }
}

const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])
const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}

const normalizeSiteNoticeText = (value) => {
  const source = String(value ?? '').trim()
  if (!source) return ''
  // 仅允许两种轻量富文本语法：**加粗** 与 [red]标红[/red]
  // 先统一红色标记大小写，避免前端展示不一致。
  return source
    .replace(/\[\s*red\s*\]/gi, '[red]')
    .replace(/\[\s*\/\s*red\s*\]/gi, '[/red]')
}

const ACCOUNT_RECOVERY_WINDOW_DAYS = Math.max(1, toInt(process.env.ACCOUNT_RECOVERY_WINDOW_DAYS, 30))
const ACCOUNT_RECOVERY_REDEEM_MAX_ATTEMPTS = Math.min(
  10,
  Math.max(1, toInt(process.env.ACCOUNT_RECOVERY_REDEEM_MAX_ATTEMPTS, 3))
)

const shouldRetryAccountRecoveryRedeem = (error) => {
  const statusCode = Number(error?.statusCode ?? error?.status)
  const message = String(error?.message || '').trim().toLowerCase()

  if (message.includes('已被使用')) return true
  if (message.includes('不存在') || message.includes('已失效')) return true

  if (statusCode === 503) {
    if (message.includes('人数上限')) return true
    if (message.includes('不可用') || message.includes('过期')) return true
    if (message.includes('暂无可用')) return true
  }

  return false
}

const ACCOUNT_RECOVERY_SOURCES = ['payment', 'credit', 'xianyu', 'xhs', 'manual']
const ACCOUNT_RECOVERY_SOURCE_SET = new Set(ACCOUNT_RECOVERY_SOURCES)
const normalizeAccountRecoverySources = (raw) => {
  if (raw === undefined || raw === null) return null

  const values = Array.isArray(raw) ? raw : String(raw).split(',')
  const normalized = []
  for (const value of values) {
    const item = String(value ?? '').trim().toLowerCase()
    if (!item) continue
    if (!ACCOUNT_RECOVERY_SOURCE_SET.has(item)) continue
    normalized.push(item)
  }

  const unique = Array.from(new Set(normalized))
  // No-op filter: treat as "all sources" to preserve legacy behavior.
  if (unique.length === ACCOUNT_RECOVERY_SOURCES.length && ACCOUNT_RECOVERY_SOURCES.every(source => unique.includes(source))) {
    return null
  }
  return unique
}

const parseBoolean = (value, fallback) => {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const raw = String(value).trim().toLowerCase()
  if (!raw) return fallback
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}

const normalizeMoney2 = (value) => {
  const parsed = Number.parseFloat(String(value ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return ''
  return (Math.round(parsed * 100) / 100).toFixed(2)
}

const recordAccountRecovery = (db, payload) => {
  if (!db || !payload) return
  db.run(
    `
      INSERT INTO account_recovery_logs (
        email,
        original_code_id,
        original_redeemed_at,
        original_account_email,
        recovery_mode,
        recovery_code_id,
        recovery_code,
        recovery_account_email,
        status,
        error_message,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
    `,
    [
      payload.email,
      payload.originalCodeId,
      payload.originalRedeemedAt || null,
      payload.originalAccountEmail || null,
      payload.recoveryMode || null,
      payload.recoveryCodeId || null,
      payload.recoveryCode || null,
      payload.recoveryAccountEmail || null,
      payload.status || 'pending',
      payload.errorMessage || null,
    ]
  )
}

const getUserWithRoles = (db, userId) => {
  const userResult = db.exec(
    `
      SELECT id, username, email, created_at, invite_code, invited_by_user_id, COALESCE(invite_enabled, 1), COALESCE(points, 0)
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
    [userId]
  )
  const row = userResult[0]?.values?.[0]
  if (!row) return null

  const rolesResult = db.exec(
    `
      SELECT r.role_key, r.role_name
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = ?
      ORDER BY r.id ASC
    `,
    [userId]
  )
  const roles = (rolesResult[0]?.values || []).map(r => ({
    roleKey: r[0],
    roleName: r[1]
  }))

  const invitedCountResult = db.exec(
    'SELECT COUNT(*) FROM users WHERE invited_by_user_id = ?',
    [row[0]]
  )
  const invitedCount = Number(invitedCountResult[0]?.values?.[0]?.[0] || 0)

  const orderCountResult = db.exec(
    'SELECT COUNT(*) FROM purchase_orders WHERE user_id = ?',
    [row[0]]
  )
  const orderCount = Number(orderCountResult[0]?.values?.[0]?.[0] || 0)

  return {
    id: row[0],
    username: row[1],
    email: row[2],
    createdAt: row[3],
    inviteCode: row[4] || null,
    invitedByUserId: row[5] || null,
    inviteEnabled: Number(row[6] ?? 1) !== 0,
    points: Number(row[7] || 0),
    invitedCount,
    orderCount,
    roles
  }
}

router.get('/email-domain-whitelist', async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', ['email_domain_whitelist'])
    const stored = result[0]?.values?.length ? String(result[0].values[0][0] || '') : ''
    const domains = stored ? parseDomainWhitelist(stored) : getEmailDomainWhitelistFromEnv()
    res.json({ domains })
  } catch (error) {
    console.error('Get email-domain-whitelist error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/email-domain-whitelist', async (req, res) => {
  try {
    const domains = parseDomainWhitelist(req.body?.domains ?? req.body?.value)
    const db = await getDatabase()

    const configValue = domains.join(',')
    const existing = db.exec('SELECT id FROM system_config WHERE config_key = ? LIMIT 1', ['email_domain_whitelist'])

    if (existing[0]?.values?.length) {
      db.run(
        `UPDATE system_config SET config_value = ?, updated_at = DATETIME('now', 'localtime') WHERE config_key = ?`,
        [configValue, 'email_domain_whitelist']
      )
    } else {
      db.run(
        `INSERT INTO system_config (config_key, config_value, updated_at) VALUES (?, ?, DATETIME('now', 'localtime'))`,
        ['email_domain_whitelist', configValue]
      )
    }

    saveDatabase()
    res.json({ domains })
  } catch (error) {
    console.error('Update email-domain-whitelist error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/points-withdraw-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getPointsWithdrawSettings(db)
    res.json({
      rate: {
        points: settings.ratePoints,
        cashCents: settings.rateCashCents,
      },
      minCashCents: settings.minCashCents,
      minPoints: settings.minPoints,
      stepPoints: settings.stepPoints,
    })
  } catch (error) {
    console.error('Get points-withdraw-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/points-withdraw-settings', async (req, res) => {
  try {
    const ratePointsRaw = req.body?.rate?.points ?? req.body?.ratePoints
    const rateCashCentsRaw = req.body?.rate?.cashCents ?? req.body?.rateCashCents
    const minCashCentsRaw = req.body?.minCashCents

    const ratePoints = Number.parseInt(String(ratePointsRaw ?? ''), 10)
    const rateCashCents = Number.parseInt(String(rateCashCentsRaw ?? ''), 10)
    const minCashCents = Number.parseInt(String(minCashCentsRaw ?? ''), 10)

    if (!Number.isFinite(ratePoints) || ratePoints <= 0) {
      return res.status(400).json({ error: 'Invalid ratePoints' })
    }
    if (!Number.isFinite(rateCashCents) || rateCashCents <= 0) {
      return res.status(400).json({ error: 'Invalid rateCashCents' })
    }
    if (!Number.isFinite(minCashCents) || minCashCents < 0) {
      return res.status(400).json({ error: 'Invalid minCashCents' })
    }

    const db = await getDatabase()
    upsertSystemConfigValue(db, 'points_withdraw_rate_points', String(ratePoints))
    upsertSystemConfigValue(db, 'points_withdraw_rate_cash_cents', String(rateCashCents))
    upsertSystemConfigValue(db, 'points_withdraw_min_cash_cents', String(minCashCents))
    saveDatabase()

    const settings = await getPointsWithdrawSettings(db)
    res.json({
      rate: {
        points: settings.ratePoints,
        cashCents: settings.rateCashCents,
      },
      minCashCents: settings.minCashCents,
      minPoints: settings.minPoints,
      stepPoints: settings.stepPoints,
    })
  } catch (error) {
    console.error('Update points-withdraw-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/feature-flags', async (req, res) => {
  try {
    const db = await getDatabase()
    const features = await getFeatureFlags(db, { forceRefresh: true })
    res.json({ features })
  } catch (error) {
    console.error('Get feature-flags error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/feature-flags', async (req, res) => {
  try {
    const payload = req.body?.features && typeof req.body.features === 'object' ? req.body.features : (req.body || {})

    const normalizeFlag = (value) => {
      if (typeof value === 'boolean') return value
      if (typeof value === 'number') return value !== 0
      const normalized = String(value ?? '').trim().toLowerCase()
      if (!normalized) return null
      if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
      if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
      return null
    }

    const nextFlags = {}
    const keys = ['xhs', 'xianyu', 'payment', 'openAccounts']
    for (const key of keys) {
      if (!(key in payload)) continue
      const value = normalizeFlag(payload?.[key])
      if (value === null) {
        return res.status(400).json({ error: `Invalid feature flag: ${key}` })
      }
      nextFlags[key] = value
    }

    if (!Object.keys(nextFlags).length) {
      return res.status(400).json({ error: 'No feature flags provided' })
    }

    const db = await getDatabase()

    if ('xhs' in nextFlags) upsertSystemConfigValue(db, 'feature_xhs_enabled', nextFlags.xhs ? 'true' : 'false')
    if ('xianyu' in nextFlags) upsertSystemConfigValue(db, 'feature_xianyu_enabled', nextFlags.xianyu ? 'true' : 'false')
    if ('payment' in nextFlags) upsertSystemConfigValue(db, 'feature_payment_enabled', nextFlags.payment ? 'true' : 'false')
    if ('openAccounts' in nextFlags) upsertSystemConfigValue(db, 'feature_open_accounts_enabled', nextFlags.openAccounts ? 'true' : 'false')

    saveDatabase()
    invalidateFeatureFlagsCache()

    const features = await getFeatureFlags(db, { forceRefresh: true })
    res.json({ features })
  } catch (error) {
    console.error('Update feature-flags error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/site-notice-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const enabledRaw = db.exec('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', ['site_notice_enabled'])
    const textRaw = db.exec('SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1', ['site_notice_text'])
    const enabled = String(enabledRaw[0]?.values?.[0]?.[0] ?? '').trim().toLowerCase()

    res.json({
      siteNotice: {
        enabled: enabled === 'true' || enabled === '1' || enabled === 'yes' || enabled === 'on',
        text: String(textRaw[0]?.values?.[0]?.[0] ?? '')
      }
    })
  } catch (error) {
    console.error('Get site-notice-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/site-notice-settings', async (req, res) => {
  try {
    const payload = req.body?.siteNotice && typeof req.body.siteNotice === 'object' ? req.body.siteNotice : (req.body || {})
    const enabled = Boolean(payload?.enabled)
    const text = normalizeSiteNoticeText(payload?.text)

    const db = await getDatabase()
    upsertSystemConfigValue(db, 'site_notice_enabled', enabled ? 'true' : 'false')
    upsertSystemConfigValue(db, 'site_notice_text', text)
    upsertSystemConfigValue(db, 'site_notice_link', '')
    saveDatabase()

    res.json({
      siteNotice: {
        enabled,
        text
      }
    })
  } catch (error) {
    console.error('Update site-notice-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/smtp-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getSmtpSettings(db, { forceRefresh: true })
    const smtp = settings.smtp || {}

    res.json({
      smtp: {
        host: String(smtp.host || ''),
        port: Number(smtp.port || 0) || 0,
        secure: Boolean(smtp.secure),
        user: String(smtp.user || ''),
        from: String(smtp.from || ''),
        passSet: Boolean(String(smtp.pass || '').trim()),
        passStored: Boolean(settings.stored?.smtpPass)
      },
      adminAlertEmail: String(settings.adminAlertEmail || '')
    })
  } catch (error) {
    console.error('Get smtp-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/smtp-settings', async (req, res) => {
  try {
    const smtpPayload = req.body?.smtp && typeof req.body.smtp === 'object' ? req.body.smtp : {}
    const recipientsRaw = req.body?.adminAlertEmail ?? req.body?.recipients ?? ''

    const db = await getDatabase()
    const current = await getSmtpSettings(db, { forceRefresh: true })
    const env = getSmtpSettingsFromEnv()

    const host = String(smtpPayload.host ?? current.smtp.host ?? '').trim()

    const rawPort = smtpPayload.port ?? current.smtp.port
    const port = Number.parseInt(String(rawPort ?? ''), 10)
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return res.status(400).json({ error: 'Invalid smtp port' })
    }

    const secureRaw = smtpPayload.secure ?? current.smtp.secure
    const secure = typeof secureRaw === 'boolean' ? secureRaw : parseBool(secureRaw, true)

    const user = String(smtpPayload.user ?? current.smtp.user ?? '').trim()

    const passInput = smtpPayload.pass
    const providedPass = typeof passInput === 'string' ? passInput.trim() : ''

    let pass = current.smtp.pass || ''
    let shouldUpsertPass = false
    if (providedPass) {
      pass = providedPass
      shouldUpsertPass = true
    } else if (!current.stored?.smtpPass) {
      const envPass = String(env.smtp.pass || '').trim()
      if (envPass && host && user) {
        pass = envPass
        shouldUpsertPass = true
      }
    }

    const wantsEnable = Boolean(host || user || providedPass)
    if (wantsEnable) {
      if (!host) return res.status(400).json({ error: 'SMTP host is required' })
      if (!user) return res.status(400).json({ error: 'SMTP user is required' })
      if (!String(pass || '').trim()) return res.status(400).json({ error: 'SMTP password is required' })
    }

    const from = String(smtpPayload.from ?? current.smtp.from ?? '').trim()
    const adminAlertEmail = String(recipientsRaw ?? current.adminAlertEmail ?? '').trim()

    upsertSystemConfigValue(db, 'smtp_host', host)
    upsertSystemConfigValue(db, 'smtp_port', String(port))
    upsertSystemConfigValue(db, 'smtp_secure', secure ? 'true' : 'false')
    upsertSystemConfigValue(db, 'smtp_user', user)
    if (shouldUpsertPass) {
      upsertSystemConfigValue(db, 'smtp_pass', pass)
    }
    upsertSystemConfigValue(db, 'smtp_from', from)
    upsertSystemConfigValue(db, 'admin_alert_email', adminAlertEmail)
    saveDatabase()
    invalidateSmtpSettingsCache()

    const updated = await getSmtpSettings(db, { forceRefresh: true })
    const smtp = updated.smtp || {}

    res.json({
      smtp: {
        host: String(smtp.host || ''),
        port: Number(smtp.port || 0) || 0,
        secure: Boolean(smtp.secure),
        user: String(smtp.user || ''),
        from: String(smtp.from || ''),
        passSet: Boolean(String(smtp.pass || '').trim()),
        passStored: Boolean(updated.stored?.smtpPass)
      },
      adminAlertEmail: String(updated.adminAlertEmail || '')
    })
  } catch (error) {
    console.error('Update smtp-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/smtp-test', async (req, res) => {
  try {
    const result = await sendSmtpTestEmail()
    res.json({
      ok: true,
      messageId: result.messageId,
      traceId: result.traceId,
      to: result.to,
      subject: result.subject,
      durationMs: result.durationMs
    })
  } catch (error) {
    const mapped = mapSmtpTestError(error)
    res.status(mapped.status).json(mapped)
  }
})

router.get('/linuxdo-oauth-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getLinuxDoOAuthSettings(db, { forceRefresh: true })

    res.json({
      oauth: {
        clientId: String(settings.clientId || ''),
        redirectUri: String(settings.redirectUri || ''),
        clientIdStored: Boolean(settings.stored?.clientId),
        redirectUriStored: Boolean(settings.stored?.redirectUri),
        clientSecretSet: Boolean(String(settings.clientSecret || '').trim()),
        clientSecretStored: Boolean(settings.stored?.clientSecret)
      }
    })
  } catch (error) {
    console.error('Get linuxdo-oauth-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/linuxdo-oauth-settings', async (req, res) => {
  try {
    const payload = req.body?.oauth && typeof req.body.oauth === 'object' ? req.body.oauth : (req.body || {})
    const db = await getDatabase()

    const current = await getLinuxDoOAuthSettings(db, { forceRefresh: true })
    const env = getLinuxDoOAuthSettingsFromEnv()

    const clientId = String(payload.clientId ?? current.clientId ?? '').trim()
    const redirectUri = String(payload.redirectUri ?? current.redirectUri ?? '').trim()

    const secretInput = typeof payload.clientSecret === 'string' ? payload.clientSecret.trim() : ''
    let clientSecret = current.clientSecret || ''
    let shouldUpsertSecret = false

    if (secretInput) {
      clientSecret = secretInput
      shouldUpsertSecret = true
    } else if (!current.stored?.clientSecret) {
      const envSecret = String(env.clientSecret || '').trim()
      if (envSecret && clientId) {
        clientSecret = envSecret
        shouldUpsertSecret = true
      }
    }

    const wantsEnable = Boolean(clientId || redirectUri || secretInput)
    if (wantsEnable) {
      if (!clientId) return res.status(400).json({ error: 'Linux DO clientId is required' })
      if (!redirectUri) return res.status(400).json({ error: 'Linux DO redirectUri is required' })
      if (!String(clientSecret || '').trim()) return res.status(400).json({ error: 'Linux DO clientSecret is required' })

      try {
        const parsed = new URL(redirectUri)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ error: 'Linux DO redirectUri must be http(s)' })
        }
      } catch {
        return res.status(400).json({ error: 'Linux DO redirectUri is invalid' })
      }
    }

    upsertSystemConfigValue(db, 'linuxdo_client_id', clientId)
    upsertSystemConfigValue(db, 'linuxdo_redirect_uri', redirectUri)
    if (shouldUpsertSecret) {
      upsertSystemConfigValue(db, 'linuxdo_client_secret', clientSecret)
    }

    saveDatabase()
    invalidateLinuxDoSettingsCache()

    const updated = await getLinuxDoOAuthSettings(db, { forceRefresh: true })
    res.json({
      oauth: {
        clientId: String(updated.clientId || ''),
        redirectUri: String(updated.redirectUri || ''),
        clientIdStored: Boolean(updated.stored?.clientId),
        redirectUriStored: Boolean(updated.stored?.redirectUri),
        clientSecretSet: Boolean(String(updated.clientSecret || '').trim()),
        clientSecretStored: Boolean(updated.stored?.clientSecret)
      }
    })
  } catch (error) {
    console.error('Update linuxdo-oauth-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/linuxdo-credit-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getLinuxDoCreditSettings(db, { forceRefresh: true })

    res.json({
      credit: {
        pid: String(settings.pid || ''),
        pidStored: Boolean(settings.stored?.pid),
        keySet: Boolean(String(settings.key || '').trim()),
        keyStored: Boolean(settings.stored?.key)
      }
    })
  } catch (error) {
    console.error('Get linuxdo-credit-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/linuxdo-credit-settings', async (req, res) => {
  try {
    const payload = req.body?.credit && typeof req.body.credit === 'object' ? req.body.credit : (req.body || {})
    const db = await getDatabase()

    const current = await getLinuxDoCreditSettings(db, { forceRefresh: true })
    const env = getLinuxDoCreditSettingsFromEnv()

    const pid = String(payload.pid ?? current.pid ?? '').trim()

    const keyInput = typeof payload.key === 'string' ? payload.key.trim() : ''
    let key = current.key || ''
    let shouldUpsertKey = false

    if (keyInput) {
      key = keyInput
      shouldUpsertKey = true
    } else if (!current.stored?.key) {
      const envKey = String(env.key || '').trim()
      if (envKey && pid) {
        key = envKey
        shouldUpsertKey = true
      }
    }

    const wantsEnable = Boolean(pid || keyInput)
    if (wantsEnable) {
      if (!pid) return res.status(400).json({ error: 'Credit pid is required' })
      if (!String(key || '').trim()) return res.status(400).json({ error: 'Credit key is required' })
    }

    upsertSystemConfigValue(db, 'linuxdo_credit_pid', pid)
    if (shouldUpsertKey) {
      upsertSystemConfigValue(db, 'linuxdo_credit_key', key)
    }

    saveDatabase()
    invalidateLinuxDoSettingsCache()

    const updated = await getLinuxDoCreditSettings(db, { forceRefresh: true })
    res.json({
      credit: {
        pid: String(updated.pid || ''),
        pidStored: Boolean(updated.stored?.pid),
        keySet: Boolean(String(updated.key || '').trim()),
        keyStored: Boolean(updated.stored?.key)
      }
    })
  } catch (error) {
    console.error('Update linuxdo-credit-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/zpay-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getZpaySettings(db, { forceRefresh: true })

    res.json({
      zpay: {
        baseUrl: String(settings.baseUrl || ''),
        pid: String(settings.pid || ''),
        baseUrlStored: Boolean(settings.stored?.baseUrl),
        pidStored: Boolean(settings.stored?.pid),
        keySet: Boolean(String(settings.key || '').trim()),
        keyStored: Boolean(settings.stored?.key)
      }
    })
  } catch (error) {
    console.error('Get zpay-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/zpay-settings', async (req, res) => {
  try {
    const payload = req.body?.zpay && typeof req.body.zpay === 'object' ? req.body.zpay : (req.body || {})
    const db = await getDatabase()

    const current = await getZpaySettings(db, { forceRefresh: true })
    const env = getZpaySettingsFromEnv()

    const baseUrlRaw = String(payload.baseUrl ?? current.baseUrl ?? '').trim()
    let baseUrl = baseUrlRaw
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return res.status(400).json({ error: 'ZPAY baseUrl must be http(s)' })
        }
      } catch {
        return res.status(400).json({ error: 'ZPAY baseUrl is invalid' })
      }
      baseUrl = baseUrl.replace(/\/+$/, '')
    }

    const pid = String(payload.pid ?? current.pid ?? '').trim()

    const keyInput = typeof payload.key === 'string' ? payload.key.trim() : ''
    let key = String(current.key || '').trim()
    let shouldUpsertKey = false

    if (keyInput) {
      key = keyInput
      shouldUpsertKey = true
    } else if (!current.stored?.key) {
      const envKey = String(env.key || '').trim()
      if (envKey && pid) {
        key = envKey
        shouldUpsertKey = true
      }
    }

    if (pid) {
      if (!key) return res.status(400).json({ error: 'ZPAY key is required' })
    }

    upsertSystemConfigValue(db, 'zpay_base_url', baseUrl)
    upsertSystemConfigValue(db, 'zpay_pid', pid)
    if (shouldUpsertKey) {
      upsertSystemConfigValue(db, 'zpay_key', key)
    }

    saveDatabase()
    invalidateZpaySettingsCache()

    const updated = await getZpaySettings(db, { forceRefresh: true })
    res.json({
      zpay: {
        baseUrl: String(updated.baseUrl || ''),
        pid: String(updated.pid || ''),
        baseUrlStored: Boolean(updated.stored?.baseUrl),
        pidStored: Boolean(updated.stored?.pid),
        keySet: Boolean(String(updated.key || '').trim()),
        keyStored: Boolean(updated.stored?.key)
      }
    })
  } catch (error) {
    console.error('Update zpay-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/turnstile-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getTurnstileSettings(db, { forceRefresh: true })

    res.json({
      turnstile: {
        siteKey: String(settings.siteKey || ''),
        siteKeyStored: Boolean(settings.stored?.siteKey),
        secretSet: Boolean(String(settings.secretKey || '').trim()),
        secretStored: Boolean(settings.stored?.secretKey)
      },
      enabled: Boolean(settings.enabled)
    })
  } catch (error) {
    console.error('Get turnstile-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/turnstile-settings', async (req, res) => {
  try {
    const payload = req.body?.turnstile && typeof req.body.turnstile === 'object' ? req.body.turnstile : (req.body || {})
    const db = await getDatabase()

    const current = await getTurnstileSettings(db, { forceRefresh: true })
    const env = getTurnstileSettingsFromEnv()

    const siteKey = String(payload.siteKey ?? current.siteKey ?? '').trim()

    const secretInput = typeof payload.secretKey === 'string' ? payload.secretKey.trim() : ''
    let secretKey = String(current.secretKey || '').trim()
    let shouldUpsertSecret = false

    if (secretInput) {
      secretKey = secretInput
      shouldUpsertSecret = true
    } else if (!current.stored?.secretKey) {
      const envSecret = String(env.secretKey || '').trim()
      if (envSecret && siteKey) {
        secretKey = envSecret
        shouldUpsertSecret = true
      }
    }

    upsertSystemConfigValue(db, 'turnstile_site_key', siteKey)
    if (shouldUpsertSecret) {
      upsertSystemConfigValue(db, 'turnstile_secret_key', secretKey)
    }

    saveDatabase()
    invalidateTurnstileSettingsCache()

    const updated = await getTurnstileSettings(db, { forceRefresh: true })

    res.json({
      turnstile: {
        siteKey: String(updated.siteKey || ''),
        siteKeyStored: Boolean(updated.stored?.siteKey),
        secretSet: Boolean(String(updated.secretKey || '').trim()),
        secretStored: Boolean(updated.stored?.secretKey)
      },
      enabled: Boolean(updated.enabled)
    })
  } catch (error) {
    console.error('Update turnstile-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/telegram-settings', async (req, res) => {
  try {
    const db = await getDatabase()
    const settings = await getTelegramSettings(db, { forceRefresh: true })

    res.json({
      telegram: {
        allowedUserIds: String(settings.allowedUserIds || ''),
        allowedUserIdsStored: Boolean(settings.stored?.allowedUserIds),
        notifyEnabled: Boolean(settings.notifyEnabled),
        notifyEnabledStored: Boolean(settings.stored?.notifyEnabled),
        notifyChatIds: String(settings.notifyChatIds || ''),
        notifyChatIdsStored: Boolean(settings.stored?.notifyChatIds),
        notifyTimeoutMs: Number(settings.notifyTimeoutMs || 0) || 0,
        notifyTimeoutMsStored: Boolean(settings.stored?.notifyTimeoutMs),
        tokenSet: Boolean(String(settings.token || '').trim()),
        tokenStored: Boolean(settings.stored?.token)
      }
    })
  } catch (error) {
    console.error('Get telegram-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/telegram-settings', async (req, res) => {
  try {
    const payload = req.body?.telegram && typeof req.body.telegram === 'object' ? req.body.telegram : (req.body || {})
    const db = await getDatabase()

    const current = await getTelegramSettings(db, { forceRefresh: true })
    const env = getTelegramSettingsFromEnv()

    const allowedUserIds = String(payload.allowedUserIds ?? current.allowedUserIds ?? '').trim()

    const tokenInput =
      typeof payload.botToken === 'string'
        ? payload.botToken.trim()
        : (typeof payload.token === 'string' ? payload.token.trim() : '')

    let token = String(current.token || '').trim()
    let shouldUpsertToken = false

    if (tokenInput) {
      token = tokenInput
      shouldUpsertToken = true
    } else if (!current.stored?.token) {
      const envToken = String(env.token || '').trim()
      if (envToken) {
        token = envToken
        shouldUpsertToken = true
      }
    }

    const notifyEnabledInput = payload.notifyEnabled ?? payload.notify_enabled ?? payload?.notify?.enabled
    let notifyEnabled = Boolean(current.notifyEnabled)
    let shouldUpsertNotifyEnabled = false
    if (notifyEnabledInput !== undefined) {
      notifyEnabled = typeof notifyEnabledInput === 'boolean'
        ? notifyEnabledInput
        : parseBool(notifyEnabledInput, notifyEnabled)
      shouldUpsertNotifyEnabled = true
    }

    const notifyChatIdsInput = payload.notifyChatIds ?? payload.notify_chat_ids ?? payload?.notify?.chatIds ?? payload?.notify?.chat_ids
    const notifyChatIds = notifyChatIdsInput !== undefined ? String(notifyChatIdsInput ?? '').trim() : ''
    const shouldUpsertNotifyChatIds = notifyChatIdsInput !== undefined

    const notifyTimeoutMsInput = payload.notifyTimeoutMs ?? payload.notify_timeout_ms ?? payload?.notify?.timeoutMs ?? payload?.notify?.timeout_ms
    let notifyTimeoutMs = Number(current.notifyTimeoutMs || 0) || 0
    let shouldUpsertNotifyTimeoutMs = false
    if (notifyTimeoutMsInput !== undefined) {
      const parsed = toInt(notifyTimeoutMsInput, Number(env.notifyTimeoutMs || 0) || 8000)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return res.status(400).json({ error: 'Invalid telegram notify timeout' })
      }
      notifyTimeoutMs = Math.min(120000, Math.max(1000, parsed))
      shouldUpsertNotifyTimeoutMs = true
    }

    upsertSystemConfigValue(db, 'telegram_allowed_user_ids', allowedUserIds)
    if (shouldUpsertNotifyEnabled) {
      upsertSystemConfigValue(db, 'telegram_notify_enabled', notifyEnabled ? 'true' : 'false')
    }
    if (shouldUpsertNotifyChatIds) {
      upsertSystemConfigValue(db, 'telegram_notify_chat_ids', notifyChatIds)
    }
    if (shouldUpsertNotifyTimeoutMs) {
      upsertSystemConfigValue(db, 'telegram_notify_timeout_ms', String(notifyTimeoutMs))
    }
    if (shouldUpsertToken) {
      upsertSystemConfigValue(db, 'telegram_bot_token', token)
    }

    saveDatabase()
    invalidateTelegramSettingsCache()

    const updated = await getTelegramSettings(db, { forceRefresh: true })

    res.json({
      telegram: {
        allowedUserIds: String(updated.allowedUserIds || ''),
        allowedUserIdsStored: Boolean(updated.stored?.allowedUserIds),
        notifyEnabled: Boolean(updated.notifyEnabled),
        notifyEnabledStored: Boolean(updated.stored?.notifyEnabled),
        notifyChatIds: String(updated.notifyChatIds || ''),
        notifyChatIdsStored: Boolean(updated.stored?.notifyChatIds),
        notifyTimeoutMs: Number(updated.notifyTimeoutMs || 0) || 0,
        notifyTimeoutMsStored: Boolean(updated.stored?.notifyTimeoutMs),
        tokenSet: Boolean(String(updated.token || '').trim()),
        tokenStored: Boolean(updated.stored?.token)
      }
    })
  } catch (error) {
    console.error('Update telegram-settings error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/rbac/menus', async (req, res) => {
  try {
    const db = await getDatabase()
    const menus = await listMenus(db, { includeInactive: true })
    res.json({ menus, tree: buildMenuTree(menus) })
  } catch (error) {
    console.error('Get menus error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/rbac/menus', async (req, res) => {
  try {
    const menuKey = String(req.body?.menuKey || '').trim()
    const label = String(req.body?.label || '').trim()
    const pathInput = req.body?.path
    const parentIdRaw = req.body?.parentId
    const sortOrder = toInt(req.body?.sortOrder, 0)
    const isActive = Boolean(req.body?.isActive ?? true)

    if (!/^[a-z][a-z0-9_]{2,63}$/.test(menuKey)) {
      return res.status(400).json({ error: 'Invalid menuKey' })
    }
    if (!label) {
      return res.status(400).json({ error: 'label is required' })
    }

    const normalizedPath = normalizeAdminMenuPath(pathInput)
    if (normalizedPath === null) {
      return res.status(400).json({ error: 'Invalid path. Only /admin paths or relative paths are allowed.' })
    }

    const parentId = Number.isFinite(Number(parentIdRaw)) && Number(parentIdRaw) > 0 ? Number(parentIdRaw) : null

    const db = await getDatabase()
    const existing = db.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', [menuKey])
    if (existing[0]?.values?.length) {
      return res.status(409).json({ error: 'Menu already exists' })
    }

    if (parentId) {
      const parent = db.exec(
        `
          SELECT id, parent_id
          FROM menus
          WHERE id = ?
          LIMIT 1
        `,
        [parentId]
      )
      if (!parent[0]?.values?.length) {
        return res.status(400).json({ error: 'Invalid parentId' })
      }
      const parentParentId = parent[0].values[0][1]
      if (parentParentId != null) {
        return res.status(400).json({ error: '父菜单必须是一级菜单（系统仅支持两级菜单）' })
      }
    }

    db.run(
      `
        INSERT INTO menus (menu_key, label, path, parent_id, sort_order, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
      `,
      [menuKey, label, normalizedPath, parentId, sortOrder, isActive ? 1 : 0]
    )

    const created = db.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', [menuKey])
    const menuId = created[0]?.values?.length ? Number(created[0].values[0][0]) : null

    if (menuId) {
      const superRole = db.exec('SELECT id FROM roles WHERE role_key = ? LIMIT 1', ['super_admin'])
      const superRoleId = superRole[0]?.values?.length ? Number(superRole[0].values[0][0]) : null
      if (superRoleId) {
        db.run(
          'INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?, ?)',
          [superRoleId, menuId]
        )
      }
    }

    saveDatabase()
    res.json({
      menu: {
        id: menuId,
        menuKey,
        label,
        path: normalizedPath,
        parentId,
        sortOrder,
        isActive,
      }
    })
  } catch (error) {
    console.error('Create menu error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/rbac/menus/:id', async (req, res) => {
  try {
    const menuId = Number(req.params.id)
    if (!Number.isFinite(menuId) || menuId <= 0) {
      return res.status(400).json({ error: 'Invalid menu id' })
    }

    const label = String(req.body?.label || '').trim()
    const pathInput = req.body?.path
    const parentIdRaw = req.body?.parentId
    const sortOrder = toInt(req.body?.sortOrder, 0)
    const isActive = Boolean(req.body?.isActive ?? true)

    if (!label) {
      return res.status(400).json({ error: 'label is required' })
    }

    const normalizedPath = normalizeAdminMenuPath(pathInput)
    if (normalizedPath === null) {
      return res.status(400).json({ error: 'Invalid path. Only /admin paths or relative paths are allowed.' })
    }

    const parentId = Number.isFinite(Number(parentIdRaw)) && Number(parentIdRaw) > 0 ? Number(parentIdRaw) : null

    const db = await getDatabase()
    const existing = db.exec(
      `
        SELECT id, menu_key, parent_id
        FROM menus
        WHERE id = ?
        LIMIT 1
      `,
      [menuId]
    )
    if (!existing[0]?.values?.length) {
      return res.status(404).json({ error: 'Menu not found' })
    }
    const existingMenuKey = String(existing[0].values[0][1] || '')

    if (parentId && parentId === menuId) {
      return res.status(400).json({ error: 'Invalid parentId' })
    }

    if (parentId) {
      const parent = db.exec(
        `
          SELECT id, parent_id
          FROM menus
          WHERE id = ?
          LIMIT 1
        `,
        [parentId]
      )
      if (!parent[0]?.values?.length) {
        return res.status(400).json({ error: 'Invalid parentId' })
      }
      const parentParentId = parent[0].values[0][1]
      if (parentParentId != null) {
        return res.status(400).json({ error: '父菜单必须是一级菜单（系统仅支持两级菜单）' })
      }

      const hasChildren = db.exec('SELECT 1 FROM menus WHERE parent_id = ? LIMIT 1', [menuId])
      if (hasChildren[0]?.values?.length) {
        return res.status(400).json({ error: '该菜单含有子菜单，无法挂到其他父菜单下（否则会超过两级）' })
      }
    }

    db.run(
      `
        UPDATE menus
        SET label = ?,
            path = ?,
            parent_id = ?,
            sort_order = ?,
            is_active = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
      `,
      [label, normalizedPath, parentId, sortOrder, isActive ? 1 : 0, menuId]
    )

    if (!isActive) {
      db.run(
        `
          UPDATE menus
          SET is_active = 0,
              updated_at = DATETIME('now', 'localtime')
          WHERE parent_id = ?
        `,
        [menuId]
      )
    }

    saveDatabase()
    res.json({
      menu: {
        id: menuId,
        menuKey: existingMenuKey,
        label,
        path: normalizedPath,
        parentId,
        sortOrder,
        isActive,
      }
    })
  } catch (error) {
    console.error('Update menu error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/rbac/menus/:id', async (req, res) => {
  try {
    const menuId = Number(req.params.id)
    if (!Number.isFinite(menuId) || menuId <= 0) {
      return res.status(400).json({ error: 'Invalid menu id' })
    }

    const db = await getDatabase()
    const subtree = db.exec(
      `
        WITH RECURSIVE subtree(id, menu_key) AS (
          SELECT id, menu_key
          FROM menus
          WHERE id = ?
          UNION ALL
          SELECT m.id, m.menu_key
          FROM menus m
          JOIN subtree s ON m.parent_id = s.id
        )
        SELECT id, menu_key FROM subtree
      `,
      [menuId]
    )
    const rows = subtree?.[0]?.values || []
    if (!rows.length) {
      return res.status(404).json({ error: 'Menu not found' })
    }

    const ids = rows.map(row => Number(row[0])).filter(id => Number.isFinite(id) && id > 0)
    const keys = rows.map(row => String(row[1] || '').trim()).filter(Boolean)

    for (const key of keys) {
      db.run(
        `
          INSERT OR IGNORE INTO deleted_menu_keys (menu_key, deleted_at)
          VALUES (?, DATETIME('now', 'localtime'))
        `,
        [key]
      )
    }

    const placeholders = ids.map(() => '?').join(',')
    db.run(`DELETE FROM role_menus WHERE menu_id IN (${placeholders})`, ids)
    db.run(`DELETE FROM menus WHERE id IN (${placeholders})`, ids)

    saveDatabase()
    res.json({ message: 'Menu deleted' })
  } catch (error) {
    console.error('Delete menu error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/rbac/roles', async (req, res) => {
  try {
    const db = await getDatabase()
    const rolesResult = db.exec('SELECT id, role_key, role_name, description FROM roles ORDER BY id ASC')
    const roleMenusResult = db.exec(
      `
        SELECT rm.role_id, m.menu_key
        FROM role_menus rm
        JOIN menus m ON m.id = rm.menu_id
        ORDER BY rm.role_id ASC, m.id ASC
      `
    )

    const roleMenusMap = new Map()
    for (const row of roleMenusResult[0]?.values || []) {
      const roleId = row[0]
      const menuKey = row[1]
      const list = roleMenusMap.get(roleId) || []
      list.push(menuKey)
      roleMenusMap.set(roleId, list)
    }

    const roles = (rolesResult[0]?.values || []).map(row => ({
      id: row[0],
      roleKey: row[1],
      roleName: row[2],
      description: row[3] || '',
      menuKeys: roleMenusMap.get(row[0]) || [],
    }))

    res.json({ roles })
  } catch (error) {
    console.error('Get roles error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/rbac/roles', async (req, res) => {
  try {
    const roleKey = String(req.body?.roleKey || '').trim()
    const roleName = String(req.body?.roleName || '').trim()
    const description = String(req.body?.description || '').trim()
    const menuKeys = Array.isArray(req.body?.menuKeys) ? req.body.menuKeys.map(String) : []

    if (!/^[a-z][a-z0-9_]{2,63}$/.test(roleKey)) {
      return res.status(400).json({ error: 'Invalid roleKey' })
    }
    if (!roleName) {
      return res.status(400).json({ error: 'roleName is required' })
    }

    const db = await getDatabase()
    const existing = db.exec('SELECT id FROM roles WHERE role_key = ? LIMIT 1', [roleKey])
    if (existing[0]?.values?.length) {
      return res.status(409).json({ error: 'Role already exists' })
    }

    db.run(
      `
        INSERT INTO roles (role_key, role_name, description, created_at, updated_at)
        VALUES (?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
      `,
      [roleKey, roleName, description]
    )

    const created = db.exec('SELECT id FROM roles WHERE role_key = ? LIMIT 1', [roleKey])
    const roleId = created[0]?.values?.length ? created[0].values[0][0] : null

    if (roleId && menuKeys.length) {
      const normalizedKeys = [...new Set(menuKeys.map(String).map(s => s.trim()).filter(Boolean))]
      const placeholders = normalizedKeys.map(() => '?').join(',')
      const menusResult = db.exec(
        `SELECT id, menu_key FROM menus WHERE menu_key IN (${placeholders})`,
        normalizedKeys
      )
      const found = new Set((menusResult[0]?.values || []).map(row => row[1]))
      const missing = normalizedKeys.filter(key => !found.has(key))
      if (missing.length) {
        return res.status(400).json({ error: 'Unknown menuKeys', missing })
      }
      for (const row of menusResult[0]?.values || []) {
        db.run(
          'INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?, ?)',
          [roleId, row[0]]
        )
      }
    }

    saveDatabase()
    res.json({ id: roleId, roleKey, roleName, description, menuKeys })
  } catch (error) {
    console.error('Create role error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/rbac/roles/:id/menus', async (req, res) => {
  try {
    const roleId = Number(req.params.id)
    if (!Number.isFinite(roleId) || roleId <= 0) {
      return res.status(400).json({ error: 'Invalid role id' })
    }

    const menuKeys = Array.isArray(req.body?.menuKeys) ? req.body.menuKeys.map(String) : []
    const normalizedKeys = [...new Set(menuKeys.map(String).map(s => s.trim()).filter(Boolean))]

    const db = await getDatabase()
    const roleExists = db.exec('SELECT id FROM roles WHERE id = ? LIMIT 1', [roleId])
    if (!roleExists[0]?.values?.length) {
      return res.status(404).json({ error: 'Role not found' })
    }

    db.run('DELETE FROM role_menus WHERE role_id = ?', [roleId])

    if (normalizedKeys.length) {
      const placeholders = normalizedKeys.map(() => '?').join(',')
      const menusResult = db.exec(
        `SELECT id, menu_key FROM menus WHERE menu_key IN (${placeholders})`,
        normalizedKeys
      )
      const found = new Set((menusResult[0]?.values || []).map(row => row[1]))
      const missing = normalizedKeys.filter(key => !found.has(key))
      if (missing.length) {
        return res.status(400).json({ error: 'Unknown menuKeys', missing })
      }
      for (const row of menusResult[0]?.values || []) {
        db.run(
          'INSERT OR IGNORE INTO role_menus (role_id, menu_id) VALUES (?, ?)',
          [roleId, row[0]]
        )
      }
    }

    saveDatabase()
    res.json({ roleId, menuKeys: normalizedKeys })
  } catch (error) {
    console.error('Update role menus error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/rbac/users', async (req, res) => {
  try {
    const db = await getDatabase()
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10))
    const search = String(req.query.search || '').trim().toLowerCase()

    const conditions = []
    const params = []

    if (search) {
      const keyword = `%${search}%`
      conditions.push('(LOWER(username) LIKE ? OR LOWER(email) LIKE ? OR LOWER(invite_code) LIKE ?)')
      params.push(keyword, keyword, keyword)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const countResult = db.exec(`SELECT COUNT(*) FROM users ${whereClause}`, params)
    const total = countResult[0]?.values?.[0]?.[0] || 0

    const offset = (page - 1) * pageSize
    const usersResult = db.exec(
      `
        SELECT id, username, email, created_at, invite_code, invited_by_user_id, COALESCE(invite_enabled, 1), COALESCE(points, 0)
        FROM users
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    )

    const userRows = usersResult[0]?.values || []
    const userIds = userRows.map(row => row[0]).filter(Boolean)

    const rolesByUser = new Map()
    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(',')
      const rolesResult = db.exec(
        `
          SELECT ur.user_id, r.role_key, r.role_name
          FROM user_roles ur
          JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id IN (${placeholders})
          ORDER BY ur.user_id ASC, r.id ASC
        `,
        userIds
      )

      for (const row of rolesResult[0]?.values || []) {
        const userId = row[0]
        const roleKey = row[1]
        const roleName = row[2]
        const list = rolesByUser.get(userId) || []
        list.push({ roleKey, roleName })
        rolesByUser.set(userId, list)
      }
    }

    const invitedCountByUser = new Map()
    const orderCountByUser = new Map()
    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(',')
      const inviteCountResult = db.exec(
        `
          SELECT invited_by_user_id, COUNT(*)
          FROM users
          WHERE invited_by_user_id IN (${placeholders})
          GROUP BY invited_by_user_id
        `,
        userIds
      )
      for (const row of inviteCountResult[0]?.values || []) {
        invitedCountByUser.set(Number(row[0]), Number(row[1] || 0))
      }

      const orderCountResult = db.exec(
        `
          SELECT user_id, COUNT(*)
          FROM purchase_orders
          WHERE user_id IN (${placeholders})
          GROUP BY user_id
        `,
        userIds
      )
      for (const row of orderCountResult[0]?.values || []) {
        orderCountByUser.set(Number(row[0]), Number(row[1] || 0))
      }
    }

    const users = userRows.map(row => ({
      id: row[0],
      username: row[1],
      email: row[2],
      createdAt: row[3],
      inviteCode: row[4] || null,
      invitedByUserId: row[5] || null,
      inviteEnabled: Number(row[6] ?? 1) !== 0,
      points: Number(row[7] || 0),
      invitedCount: invitedCountByUser.get(Number(row[0])) || 0,
      orderCount: orderCountByUser.get(Number(row[0])) || 0,
      roles: rolesByUser.get(row[0]) || [],
    }))

    res.json({
      users,
      pagination: {
        page,
        pageSize,
        total,
      }
    })
  } catch (error) {
    console.error('Get users error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/rbac/users/:id/points-ledger', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' })
    }

    const db = await getDatabase()
    const userExists = db.exec('SELECT 1 FROM users WHERE id = ? LIMIT 1', [userId])
    if (!userExists[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const limit = Math.min(100, Math.max(1, toInt(req.query.limit, 20)))
    const beforeId = req.query.beforeId != null ? toInt(req.query.beforeId, 0) : null
    const fetched = listUserPointsLedger(db, { userId, limit: limit + 1, beforeId })
    const hasMore = fetched.length > limit
    const records = hasMore ? fetched.slice(0, limit) : fetched
    const nextBeforeId = hasMore && records.length ? records[records.length - 1].id : null

    res.json({
      records,
      page: {
        limit,
        hasMore,
        nextBeforeId
      }
    })
  } catch (error) {
    console.error('List user points ledger error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/rbac/users/:id/points', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' })
    }

    const pointsRaw = req.body?.points
    const pointsText = String(pointsRaw ?? '').trim()
    if (!/^[0-9]{1,9}$/.test(pointsText)) {
      return res.status(400).json({ error: 'Invalid points' })
    }

    const targetPoints = toInt(pointsText, NaN)
    if (!Number.isFinite(targetPoints) || targetPoints < 0) {
      return res.status(400).json({ error: 'Invalid points' })
    }

    const expectedRaw = req.body?.expectedPoints
    const hasExpected = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'expectedPoints')
    let expectedPoints = null
    if (hasExpected) {
      const expectedText = String(expectedRaw ?? '').trim()
      if (!/^[0-9]{1,9}$/.test(expectedText)) {
        return res.status(400).json({ error: 'Invalid expectedPoints' })
      }
      const parsedExpected = toInt(expectedText, NaN)
      if (!Number.isFinite(parsedExpected) || parsedExpected < 0) {
        return res.status(400).json({ error: 'Invalid expectedPoints' })
      }
      expectedPoints = parsedExpected
    }

    const actorUserId = Number(req.user?.id)
    const actorRefType = Number.isFinite(actorUserId) && actorUserId > 0 ? 'admin_user' : null
    const actorRefId = Number.isFinite(actorUserId) && actorUserId > 0 ? String(actorUserId) : null

    const db = await getDatabase()

    const result = await withLocks([`points:user:${userId}`], async () => {
      const userResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      if (!userResult[0]?.values?.length) {
        return { ok: false, status: 404, error: 'User not found' }
      }

      const currentPoints = Number(userResult[0].values[0][0] || 0)
      if (expectedPoints != null && currentPoints !== expectedPoints) {
        return { ok: false, status: 409, error: 'Points changed', currentPoints }
      }

      if (currentPoints === targetPoints) {
        return { ok: false, status: 400, error: 'No change', currentPoints }
      }

      const deltaPoints = targetPoints - currentPoints
      db.run('UPDATE users SET points = ? WHERE id = ?', [targetPoints, userId])

      const ledgerId = safeInsertPointsLedgerEntry(db, {
        userId,
        deltaPoints,
        pointsBefore: currentPoints,
        pointsAfter: targetPoints,
        action: 'admin_set_points',
        refType: actorRefType,
        refId: actorRefId,
        remark: '系统调整',
      })

      saveDatabase()

      const user = getUserWithRoles(db, userId)
      return { ok: true, user, ledgerId }
    })

    if (!result?.ok) {
      const status = Number(result?.status) || 400
      const payload = { error: result?.error || 'Failed to set points' }
      if (result?.currentPoints != null) payload.currentPoints = result.currentPoints
      return res.status(status).json(payload)
    }

    res.json({ user: result.user, ledgerId: result.ledgerId ?? null })
  } catch (error) {
    console.error('Set user points error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/rbac/users/:id/orders', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' })
    }

    const db = await getDatabase()
    const userExists = db.exec('SELECT 1 FROM users WHERE id = ? LIMIT 1', [userId])
    if (!userExists[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10))
    const offset = (page - 1) * pageSize

    const countResult = db.exec(
      'SELECT COUNT(*) FROM purchase_orders WHERE user_id = ?',
      [userId]
    )
    const total = Number(countResult[0]?.values?.[0]?.[0] || 0)

    const result = db.exec(
      `
        SELECT order_no, zpay_trade_no, email, product_name, amount, service_days, order_type, pay_type, status,
               created_at, paid_at, redeemed_at, invite_status, redeem_error,
               refunded_at, refund_amount, refund_message, email_sent_at, zpay_img
        FROM purchase_orders
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [userId, pageSize, offset]
    )

    const rows = result[0]?.values || []
    res.json({
      orders: rows.map(row => ({
        orderNo: row[0],
        tradeNo: row[1] || null,
        email: row[2],
        productName: row[3],
        amount: row[4],
        serviceDays: Number(row[5]) || 30,
        orderType: normalizeOrderType(row[6]),
        payType: row[7] || null,
        img: row[18] || null,
        status: row[8],
        createdAt: row[9],
        paidAt: row[10] || null,
        redeemedAt: row[11] || null,
        inviteStatus: row[12] || null,
        redeemError: row[13] || null,
        refundedAt: row[14] || null,
        refundAmount: row[15] || null,
        refundMessage: row[16] || null,
        emailSentAt: row[17] || null
      })),
      pagination: { page, pageSize, total }
    })
  } catch (error) {
    console.error('List user orders error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/rbac/users/:id/roles', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' })
    }

    const currentUserId = Number(req.user?.id)
    if (Number.isFinite(currentUserId) && currentUserId === userId) {
      return res.status(400).json({ error: '超级管理员不能修改自己的角色' })
    }

    const roleKeys = Array.isArray(req.body?.roleKeys)
      ? req.body.roleKeys.map(String).map(s => s.trim()).filter(Boolean)
      : []

    if (!roleKeys.length) {
      return res.status(400).json({ error: 'roleKeys is required' })
    }

    const uniqueRoleKeys = [...new Set(roleKeys)]
    const db = await getDatabase()

    const userExists = db.exec('SELECT id FROM users WHERE id = ? LIMIT 1', [userId])
    if (!userExists[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const placeholders = uniqueRoleKeys.map(() => '?').join(',')
    const rolesResult = db.exec(
      `SELECT id, role_key FROM roles WHERE role_key IN (${placeholders})`,
      uniqueRoleKeys
    )
    const roleIds = (rolesResult[0]?.values || []).map(row => ({ id: row[0], roleKey: row[1] }))
    const found = new Set(roleIds.map(item => item.roleKey))
    const missing = uniqueRoleKeys.filter(key => !found.has(key))
    if (missing.length) {
      return res.status(400).json({ error: 'Unknown roleKeys', missing })
    }

    db.run('DELETE FROM user_roles WHERE user_id = ?', [userId])
    for (const item of roleIds) {
      db.run(
        'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)',
        [userId, item.id]
      )
    }

    saveDatabase()
    res.json({ userId, roleKeys: uniqueRoleKeys })
  } catch (error) {
    console.error('Update user roles error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/rbac/users/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' })
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(body, key)

    const hasUsername = hasOwn('username')
    const hasEmail = hasOwn('email')
    const hasInviteEnabled = hasOwn('inviteEnabled')

    const normalizeInviteEnabled = (value) => {
      if (typeof value === 'boolean') return value
      if (typeof value === 'number') return value !== 0
      const text = String(value ?? '').trim().toLowerCase()
      if (!text) return null
      if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true
      if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false
      return null
    }

    if (!hasUsername && !hasEmail && !hasInviteEnabled) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    const db = await getDatabase()

    const userExists = db.exec('SELECT 1 FROM users WHERE id = ? LIMIT 1', [userId])
    if (!userExists[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const updates = []
    const params = []

    if (hasUsername) {
      const username = String(body?.username ?? '').trim()
      if (!username) {
        return res.status(400).json({ error: 'username is required' })
      }

      const duplicateUsername = db.exec(
        'SELECT id FROM users WHERE lower(username) = lower(?) AND id != ? LIMIT 1',
        [username, userId]
      )
      if (duplicateUsername[0]?.values?.length) {
        return res.status(409).json({ error: 'username already exists' })
      }

      updates.push('username = ?')
      params.push(username)
    }

    if (hasEmail) {
      const email = normalizeEmail(body?.email)
      if (!email) {
        return res.status(400).json({ error: 'email is required' })
      }
      if (!EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: 'Invalid email' })
      }

      const duplicateEmail = db.exec(
        'SELECT id FROM users WHERE lower(email) = lower(?) AND id != ? LIMIT 1',
        [email, userId]
      )
      if (duplicateEmail[0]?.values?.length) {
        return res.status(409).json({ error: 'email already exists' })
      }

      updates.push('email = ?')
      params.push(email)
    }

    if (hasInviteEnabled) {
      const parsed = normalizeInviteEnabled(body?.inviteEnabled)
      if (parsed === null) {
        return res.status(400).json({ error: 'Invalid inviteEnabled' })
      }
      updates.push('invite_enabled = ?')
      params.push(parsed ? 1 : 0)
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No fields to update' })
    }

    db.run(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      [...params, userId]
    )
    saveDatabase()

    const user = getUserWithRoles(db, userId)
    res.json({ user })
  } catch (error) {
    console.error('Update user error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/rbac/users/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id)
    if (!Number.isFinite(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' })
    }

    const currentUserId = Number(req.user?.id)
    if (Number.isFinite(currentUserId) && currentUserId === userId) {
      return res.status(400).json({ error: '不能删除当前登录用户' })
    }

    const db = await getDatabase()
    const userResult = db.exec('SELECT username FROM users WHERE id = ? LIMIT 1', [userId])
    const username = userResult[0]?.values?.length ? String(userResult[0].values[0][0] || '') : ''
    if (!username) {
      return res.status(404).json({ error: 'User not found' })
    }
    if (username === 'admin') {
      return res.status(403).json({ error: '不能删除系统默认管理员' })
    }

    db.run('DELETE FROM user_roles WHERE user_id = ?', [userId])
    db.run('UPDATE users SET invited_by_user_id = NULL WHERE invited_by_user_id = ?', [userId])
    db.run('DELETE FROM users WHERE id = ?', [userId])

    saveDatabase()
    res.json({ message: 'deleted' })
  } catch (error) {
    console.error('Delete user error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

	// 封号账号补录管理
	router.get('/account-recovery/banned-accounts', async (req, res) => {
	  try {
	    const page = Math.max(1, Number(req.query.page) || 1)
	    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10))
	    const search = String(req.query.search || '').trim().toLowerCase()
	    const days = Math.max(1, Math.min(90, toInt(req.query.days, ACCOUNT_RECOVERY_WINDOW_DAYS)))
	    const threshold = `-${days} days`

	    const db = await getDatabase()
	    const pendingOnly = parseBool(req.query.pendingOnly, false)
	    const sources = normalizeAccountRecoverySources(req.query.sources)
	    const sourceFilterClause =
	      sources === null
	        ? ''
	        : sources.length
	          ? `AND source IN (${sources.map(() => '?').join(', ')})`
	          : 'AND 1=0'
	    const sourceFilterParams = sources === null ? [] : sources

	    // Always show banned accounts (unprocessed), even when no eligible codes exist in the window.
	    const accountConditions = [
	      'ga.is_banned = 1',
	      'COALESCE(ga.ban_processed, 0) = 0',
	    ]
	    const accountParams = []

	    if (search) {
	      accountConditions.push('LOWER(ga.email) LIKE ?')
	      accountParams.push(`%${search}%`)
	    }

	    const whereAccounts = accountConditions.length ? `WHERE ${accountConditions.join(' AND ')}` : ''
	    const dataConditions = [...accountConditions]
	    if (pendingOnly) {
	      dataConditions.push('(COALESCE(ea.pending_count, 0) + COALESCE(ea.failed_count, 0)) > 0')
	    }
	    if (sources !== null) {
	      // When the user selects specific sources, hide accounts that have no impacted codes in those sources.
	      dataConditions.push('COALESCE(ea.impacted_total, 0) > 0')
	    }
	    const whereAccountsFiltered = dataConditions.length ? `WHERE ${dataConditions.join(' AND ')}` : ''

	    const bannedAccountsEligibilitySql = `
	      WITH log_flags AS (
	        SELECT
	          original_code_id,
	          COUNT(*) AS attempts,
	          MAX(id) AS latest_id
	        FROM account_recovery_logs
	        GROUP BY original_code_id
	      ),
	      log_latest AS (
	        SELECT
	          ar.original_code_id,
	          ar.status
	        FROM account_recovery_logs ar
	        JOIN log_flags lf ON lf.latest_id = ar.id
	      ),
	      completed_flags AS (
	        SELECT
	          original_code_id,
	          MAX(id) AS latest_completed_id
	        FROM account_recovery_logs
	        WHERE status IN ('success', 'skipped')
	        GROUP BY original_code_id
	      ),
	      completed_latest AS (
	        SELECT
	          ar.original_code_id,
	          ar.recovery_account_email
	        FROM account_recovery_logs ar
	        JOIN completed_flags cf ON cf.latest_completed_id = ar.id
	      ),
	      eligible_codes AS (
	        SELECT
	          ga.id AS account_id,
	          rc.id AS original_code_id,
	          rc.redeemed_at AS redeemed_at,
	          rc.account_email AS original_account_email,
	          CASE
	            WHEN EXISTS (
	              SELECT 1
	              FROM purchase_orders po
	              WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
	                AND po.created_at >= DATETIME('now', 'localtime', ?)
	                AND po.refunded_at IS NULL
	                AND COALESCE(po.status, '') != 'refunded'
	            ) THEN 'payment'
	            WHEN EXISTS (
	              SELECT 1
	              FROM credit_orders co
	              WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
	                AND co.created_at >= DATETIME('now', 'localtime', ?)
	                AND co.refunded_at IS NULL
	                AND COALESCE(co.status, '') != 'refunded'
	            ) THEN 'credit'
	            WHEN EXISTS (
	              SELECT 1
	              FROM xianyu_orders xo
	              WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
	                AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
	            ) THEN 'xianyu'
	            WHEN EXISTS (
	              SELECT 1
	              FROM xhs_orders xo
	              WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
	                AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
	            ) THEN 'xhs'
	            WHEN (
	              rc.redeemed_by IS NOT NULL
	              AND trim(rc.redeemed_by) != ''
	              AND (lower(rc.redeemed_by) LIKE '%@%' OR lower(rc.redeemed_by) LIKE '%email:%')
	              AND NOT EXISTS (
	                SELECT 1
	                FROM purchase_orders po
	                WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
	              )
	              AND NOT EXISTS (
	                SELECT 1
	                FROM credit_orders co
	                WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
	              )
	              AND NOT EXISTS (
	                SELECT 1
	                FROM xhs_orders xo
	                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
	              )
	              AND NOT EXISTS (
	                SELECT 1
	                FROM xianyu_orders xo
	                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
	              )
	            ) THEN 'manual'
	            ELSE NULL
	          END AS source
	        FROM gpt_accounts ga
	        JOIN redemption_codes rc ON lower(trim(rc.account_email)) = lower(trim(ga.email))
	        WHERE ga.is_banned = 1
	          AND rc.is_redeemed = 1
	          AND rc.redeemed_at IS NOT NULL
	          AND rc.redeemed_at >= DATETIME('now', 'localtime', ?)
	          AND COALESCE(
	            NULLIF((
	              SELECT po2.order_type
	              FROM purchase_orders po2
	              WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
	              ORDER BY po2.created_at DESC
	              LIMIT 1
	            ), ''),
	            NULLIF(rc.order_type, ''),
	            'warranty'
	          ) != 'no_warranty'
	      ),
	      eligible_filtered AS (
	        SELECT *
	        FROM eligible_codes
	        WHERE source IS NOT NULL
	        ${sourceFilterClause}
	      ),
	      eligible_enriched AS (
	        SELECT
	          ec.account_id,
	          ec.original_code_id,
	          ec.redeemed_at,
	          COALESCE(lf.attempts, 0) AS attempts,
	          ll.status AS latest_status,
	          COALESCE(cl.recovery_account_email, ec.original_account_email) AS current_account_email
	        FROM eligible_filtered ec
	        LEFT JOIN log_flags lf ON lf.original_code_id = ec.original_code_id
	        LEFT JOIN log_latest ll ON ll.original_code_id = ec.original_code_id
	        LEFT JOIN completed_latest cl ON cl.original_code_id = ec.original_code_id
	      ),
	      eligible_with_current AS (
	        SELECT
	          ee.account_id,
	          ee.original_code_id,
	          ee.redeemed_at,
	          ee.attempts,
	          ee.latest_status,
	          CASE
	            WHEN current_ga.id IS NULL THEN 1
	            ELSE COALESCE(current_ga.is_banned, 0)
	          END AS current_is_banned
	        FROM eligible_enriched ee
		        LEFT JOIN gpt_accounts current_ga ON lower(trim(current_ga.email)) = lower(trim(ee.current_account_email))
	      ),
	      eligible_agg AS (
	        SELECT
	          account_id,
	          COUNT(original_code_id) AS impacted_total,
	          SUM(CASE WHEN current_is_banned = 0 THEN 1 ELSE 0 END) AS done_count,
	          SUM(CASE WHEN current_is_banned = 1 AND latest_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
	          SUM(CASE WHEN current_is_banned = 1 AND (latest_status IS NULL OR latest_status != 'failed') THEN 1 ELSE 0 END) AS pending_count,
	          MAX(redeemed_at) AS latest_redeemed_at
	        FROM eligible_with_current
	        GROUP BY account_id
	      )
	    `.trim()

	    let total = 0
	    const eligibilityParams = [threshold, threshold, threshold, threshold, threshold, ...sourceFilterParams, ...accountParams]
	    if (pendingOnly || sources !== null) {
	      const countResult = db.exec(
	        `
	          ${bannedAccountsEligibilitySql}
	          SELECT COUNT(*)
	          FROM gpt_accounts ga
	          LEFT JOIN eligible_agg ea ON ea.account_id = ga.id
	          ${whereAccountsFiltered}
	        `,
	        eligibilityParams
	      )
	      total = Number(countResult[0]?.values?.[0]?.[0] || 0)
	    } else {
	      const countResult = db.exec(
	        `
	          SELECT COUNT(*)
	          FROM gpt_accounts ga
	          ${whereAccounts}
	        `,
	        accountParams
	      )
	      total = Number(countResult[0]?.values?.[0]?.[0] || 0)
	    }
	    const offset = (page - 1) * pageSize

	    const dataResult = db.exec(
	      `
	        ${bannedAccountsEligibilitySql}
	        SELECT
	          ga.id,
	          ga.email,
	          COALESCE(ea.impacted_total, 0) AS impacted_total,
	          COALESCE(ea.done_count, 0) AS done_count,
	          COALESCE(ea.failed_count, 0) AS failed_count,
	          COALESCE(ea.pending_count, 0) AS pending_count,
	          ea.latest_redeemed_at
	        FROM gpt_accounts ga
	        LEFT JOIN eligible_agg ea ON ea.account_id = ga.id
	        ${whereAccountsFiltered}
	        ORDER BY latest_redeemed_at DESC
	        LIMIT ? OFFSET ?
	      `,
	      [...eligibilityParams, pageSize, offset]
	    )

    const accounts = (dataResult[0]?.values || []).map(row => ({
      id: Number(row[0]),
      email: String(row[1] || ''),
      impactedCount: Number(row[2] || 0),
      doneCount: Number(row[3] || 0),
      failedCount: Number(row[4] || 0),
      pendingCount: Number(row[5] || 0),
      latestRedeemedAt: row[6] ? String(row[6]) : null
    }))

    return res.json({
      accounts,
      pagination: {
        page,
        pageSize,
        total
      }
    })
  } catch (error) {
    console.error('Get banned recovery accounts error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/account-recovery/banned-accounts/processed', async (req, res) => {
  try {
    const rawIds = req.body?.accountIds ?? req.body?.ids ?? req.body?.accountIdList
    const accountIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0))]
      : []

    if (!accountIds.length) {
      return res.status(400).json({ error: 'Invalid accountIds' })
    }

    if (accountIds.length > 500) {
      return res.status(400).json({ error: 'Too many accountIds' })
    }

    const raw = req.body?.processed ?? req.body?.value
    const processed = typeof raw === 'boolean' ? raw : Number(raw ?? 1) !== 0

    const db = await getDatabase()
    const placeholders = accountIds.map(() => '?').join(', ')
    const lookupResult = db.exec(
      `
        SELECT id, COALESCE(is_banned, 0) AS is_banned
        FROM gpt_accounts
        WHERE id IN (${placeholders})
      `,
      accountIds
    )
    const rows = lookupResult[0]?.values || []
    const foundIdSet = new Set(rows.map(row => Number(row[0])))
    const missingIds = accountIds.filter(id => !foundIdSet.has(id))
    const notBannedIds = rows.filter(row => Number(row[1] || 0) !== 1).map(row => Number(row[0]))
    const bannedIds = rows.filter(row => Number(row[1] || 0) === 1).map(row => Number(row[0]))

    if (!bannedIds.length) {
      return res.status(400).json({ error: 'No banned accounts to update' })
    }

    const updatePlaceholders = bannedIds.map(() => '?').join(', ')
    db.run(
      `
        UPDATE gpt_accounts
        SET ban_processed = ?, updated_at = DATETIME('now', 'localtime')
        WHERE id IN (${updatePlaceholders})
      `,
      [processed ? 1 : 0, ...bannedIds]
    )
    saveDatabase()

    return res.json({
      requestedCount: accountIds.length,
      updatedCount: bannedIds.length,
      missingIds,
      notBannedIds,
    })
  } catch (error) {
    console.error('Batch update banned account processed error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/account-recovery/banned-accounts/:accountId/processed', async (req, res) => {
  try {
    const accountId = Number(req.params.accountId)
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'Invalid accountId' })
    }

    const raw = req.body?.processed ?? req.body?.value
    const processed = typeof raw === 'boolean' ? raw : Number(raw ?? 1) !== 0

    const db = await getDatabase()
    const accountResult = db.exec(
      `
        SELECT id, email, COALESCE(is_banned, 0) AS is_banned
        FROM gpt_accounts
        WHERE id = ?
        LIMIT 1
      `,
      [accountId]
    )
    const row = accountResult[0]?.values?.[0]
    if (!row) {
      return res.status(404).json({ error: 'Account not found' })
    }
    const isBanned = Number(row[2] || 0) === 1
    if (!isBanned) {
      return res.status(400).json({ error: 'Account is not banned' })
    }

    db.run(
      `UPDATE gpt_accounts SET ban_processed = ?, updated_at = DATETIME('now', 'localtime') WHERE id = ?`,
      [processed ? 1 : 0, accountId]
    )
    saveDatabase()

    const updatedResult = db.exec(
      `
        SELECT id, email, COALESCE(ban_processed, 0) AS ban_processed, updated_at
        FROM gpt_accounts
        WHERE id = ?
        LIMIT 1
      `,
      [accountId]
    )
    const updatedRow = updatedResult[0]?.values?.[0]

    return res.json({
      account: {
        id: Number(updatedRow?.[0] ?? accountId),
        email: String(updatedRow?.[1] || row[1] || ''),
        banProcessed: Number(updatedRow?.[2] || 0) === 1,
        updatedAt: updatedRow?.[3] ? String(updatedRow[3]) : null
      }
    })
  } catch (error) {
    console.error('Update banned account processed error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/account-recovery/banned-accounts/:accountId/redeems', async (req, res) => {
  try {
    const accountId = Number(req.params.accountId)
    if (!Number.isFinite(accountId) || accountId <= 0) {
      return res.status(400).json({ error: 'Invalid accountId' })
    }

    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20))
    const search = String(req.query.search || '').trim().toLowerCase()
    const status = String(req.query.status || 'pending').trim().toLowerCase()
    const days = Math.max(1, Math.min(90, toInt(req.query.days, ACCOUNT_RECOVERY_WINDOW_DAYS)))
    const threshold = `-${days} days`
    const sources = normalizeAccountRecoverySources(req.query.sources)
    const sourceFilterClause =
      sources === null
        ? ''
        : sources.length
          ? `AND source IN (${sources.map(() => '?').join(', ')})`
          : 'AND 1=0'
    const sourceFilterParams = sources === null ? [] : sources

    const db = await getDatabase()

    const conditions = [
      'ga.id = ?',
      'ga.is_banned = 1',
    ]

    if (search) {
      conditions.push('(LOWER(rc.code) LIKE ? OR LOWER(rc.redeemed_by) LIKE ?)')
    }

    const currentBannedExpression = `
      CASE
        WHEN current_ga.id IS NULL THEN 1
        ELSE COALESCE(current_ga.is_banned, 0)
      END
    `.trim()

    if (status === 'pending') {
      conditions.push(`(${currentBannedExpression}) = 1`)
      conditions.push(`(ll.status IS NULL OR ll.status != 'failed')`)
    } else if (status === 'done') {
      conditions.push(`(${currentBannedExpression}) = 0`)
    } else if (status === 'failed') {
      conditions.push(`(${currentBannedExpression}) = 1`)
      conditions.push(`ll.status = 'failed'`)
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

    const accountParams = [accountId]
    if (search) {
      accountParams.push(`%${search}%`, `%${search}%`)
    }
    const eligibilityParams = [threshold, threshold, threshold, threshold, threshold, ...sourceFilterParams]

    const countResult = db.exec(
      `
        WITH log_flags AS (
          SELECT
            original_code_id,
            COUNT(*) AS attempts,
            MAX(id) AS latest_id
          FROM account_recovery_logs
          GROUP BY original_code_id
        ),
        log_latest AS (
          SELECT
            ar.original_code_id,
            ar.status
          FROM account_recovery_logs ar
          JOIN log_flags lf ON lf.latest_id = ar.id
        ),
        completed_flags AS (
          SELECT
            original_code_id,
            MAX(id) AS latest_completed_id
          FROM account_recovery_logs
          WHERE status IN ('success', 'skipped')
          GROUP BY original_code_id
        ),
        completed_latest AS (
          SELECT
            ar.original_code_id,
            ar.recovery_account_email
          FROM account_recovery_logs ar
          JOIN completed_flags cf ON cf.latest_completed_id = ar.id
        ),
        eligible_codes AS (
          SELECT
            rc.id,
            rc.code,
            rc.channel,
            rc.redeemed_at,
            rc.redeemed_by,
            rc.account_email,
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM purchase_orders po
                WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
                  AND po.created_at >= DATETIME('now', 'localtime', ?)
                  AND po.refunded_at IS NULL
                  AND COALESCE(po.status, '') != 'refunded'
              ) THEN 'payment'
              WHEN EXISTS (
                SELECT 1
                FROM credit_orders co
                WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
                  AND co.created_at >= DATETIME('now', 'localtime', ?)
                  AND co.refunded_at IS NULL
                  AND COALESCE(co.status, '') != 'refunded'
              ) THEN 'credit'
              WHEN EXISTS (
                SELECT 1
                FROM xianyu_orders xo
                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                  AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
              ) THEN 'xianyu'
              WHEN EXISTS (
                SELECT 1
                FROM xhs_orders xo
                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                  AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
              ) THEN 'xhs'
              WHEN (
                rc.redeemed_by IS NOT NULL
                AND trim(rc.redeemed_by) != ''
                AND (lower(rc.redeemed_by) LIKE '%@%' OR lower(rc.redeemed_by) LIKE '%email:%')
                AND NOT EXISTS (
                  SELECT 1
                  FROM purchase_orders po
                  WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM credit_orders co
                  WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM xhs_orders xo
                  WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM xianyu_orders xo
                  WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                )
              ) THEN 'manual'
              ELSE NULL
            END AS source
          FROM redemption_codes rc
          WHERE rc.is_redeemed = 1
            AND rc.redeemed_at IS NOT NULL
            AND rc.redeemed_at >= DATETIME('now', 'localtime', ?)
            AND COALESCE(
              NULLIF((
                SELECT po2.order_type
                FROM purchase_orders po2
                WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
                ORDER BY po2.created_at DESC
                LIMIT 1
              ), ''),
              NULLIF(rc.order_type, ''),
              'warranty'
            ) != 'no_warranty'
        ),
        eligible_filtered AS (
          SELECT *
          FROM eligible_codes
          WHERE source IS NOT NULL
          ${sourceFilterClause}
        )
        SELECT COUNT(*)
        FROM eligible_filtered rc
        JOIN gpt_accounts ga ON lower(trim(ga.email)) = lower(trim(rc.account_email))
        LEFT JOIN log_flags lf ON lf.original_code_id = rc.id
        LEFT JOIN log_latest ll ON ll.original_code_id = rc.id
        LEFT JOIN completed_latest cl ON cl.original_code_id = rc.id
	        LEFT JOIN gpt_accounts current_ga ON lower(trim(current_ga.email)) = lower(trim(COALESCE(NULLIF(TRIM(cl.recovery_account_email), ''), rc.account_email)))
        ${whereClause}
      `,
      [...eligibilityParams, ...accountParams]
    )
    const total = Number(countResult[0]?.values?.[0]?.[0] || 0)
    const offset = (page - 1) * pageSize

    const dataResult = db.exec(
      `
        WITH log_flags AS (
          SELECT
            original_code_id,
            COUNT(*) AS attempts,
            MAX(id) AS latest_id
          FROM account_recovery_logs
          GROUP BY original_code_id
        ),
        log_latest AS (
          SELECT
            ar.original_code_id,
            ar.id,
            ar.status,
            ar.error_message,
            ar.recovery_mode,
            ar.recovery_code,
            ar.recovery_account_email,
            ar.created_at
          FROM account_recovery_logs ar
          JOIN log_flags lf ON lf.latest_id = ar.id
        ),
        completed_flags AS (
          SELECT
            original_code_id,
            MAX(id) AS latest_completed_id
          FROM account_recovery_logs
          WHERE status IN ('success', 'skipped')
          GROUP BY original_code_id
        ),
        completed_latest AS (
          SELECT
            ar.original_code_id,
            ar.recovery_account_email
          FROM account_recovery_logs ar
          JOIN completed_flags cf ON cf.latest_completed_id = ar.id
        ),
        eligible_codes AS (
          SELECT
            rc.id,
            rc.code,
            rc.channel,
            rc.redeemed_at,
            rc.redeemed_by,
            rc.account_email,
            CASE
              WHEN EXISTS (
                SELECT 1
                FROM purchase_orders po
                WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
                  AND po.created_at >= DATETIME('now', 'localtime', ?)
                  AND po.refunded_at IS NULL
                  AND COALESCE(po.status, '') != 'refunded'
              ) THEN 'payment'
              WHEN EXISTS (
                SELECT 1
                FROM credit_orders co
                WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
                  AND co.created_at >= DATETIME('now', 'localtime', ?)
                  AND co.refunded_at IS NULL
                  AND COALESCE(co.status, '') != 'refunded'
              ) THEN 'credit'
              WHEN EXISTS (
                SELECT 1
                FROM xianyu_orders xo
                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                  AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
              ) THEN 'xianyu'
              WHEN EXISTS (
                SELECT 1
                FROM xhs_orders xo
                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                  AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
              ) THEN 'xhs'
              WHEN (
                rc.redeemed_by IS NOT NULL
                AND trim(rc.redeemed_by) != ''
                AND (lower(rc.redeemed_by) LIKE '%@%' OR lower(rc.redeemed_by) LIKE '%email:%')
                AND NOT EXISTS (
                  SELECT 1
                  FROM purchase_orders po
                  WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM credit_orders co
                  WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM xhs_orders xo
                  WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM xianyu_orders xo
                  WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                )
              ) THEN 'manual'
              ELSE NULL
            END AS source
          FROM redemption_codes rc
          WHERE rc.is_redeemed = 1
            AND rc.redeemed_at IS NOT NULL
            AND rc.redeemed_at >= DATETIME('now', 'localtime', ?)
            AND COALESCE(
              NULLIF((
                SELECT po2.order_type
                FROM purchase_orders po2
                WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
                ORDER BY po2.created_at DESC
                LIMIT 1
              ), ''),
              NULLIF(rc.order_type, ''),
              'warranty'
            ) != 'no_warranty'
        ),
        eligible_filtered AS (
          SELECT *
          FROM eligible_codes
          WHERE source IS NOT NULL
          ${sourceFilterClause}
        )
        SELECT
          rc.id,
          rc.code,
          rc.channel,
          rc.redeemed_at,
          rc.redeemed_by,
          rc.account_email,
          COALESCE(lf.attempts, 0) AS attempts,
          CASE
            WHEN current_ga.id IS NULL THEN 1
            ELSE COALESCE(current_ga.is_banned, 0)
          END AS current_is_banned,
          ll.id AS latest_log_id,
          ll.status AS latest_status,
          ll.error_message AS latest_error_message,
          ll.recovery_mode AS latest_recovery_mode,
          ll.recovery_code AS latest_recovery_code,
          ll.recovery_account_email AS latest_recovery_account_email,
          ll.created_at AS latest_created_at,
          rc.source AS source
        FROM eligible_filtered rc
        JOIN gpt_accounts ga ON lower(trim(ga.email)) = lower(trim(rc.account_email))
        LEFT JOIN log_flags lf ON lf.original_code_id = rc.id
        LEFT JOIN log_latest ll ON ll.original_code_id = rc.id
        LEFT JOIN completed_latest cl ON cl.original_code_id = rc.id
	        LEFT JOIN gpt_accounts current_ga ON lower(trim(current_ga.email)) = lower(trim(COALESCE(NULLIF(TRIM(cl.recovery_account_email), ''), rc.account_email)))
        ${whereClause}
        ORDER BY rc.redeemed_at DESC
        LIMIT ? OFFSET ?
      `,
      [...eligibilityParams, ...accountParams, pageSize, offset]
    )

    const redeems = (dataResult[0]?.values || []).map(row => {
      const attempts = Number(row[6] || 0)
      const currentIsBanned = Number(row[7] || 0) === 1
      const latestStatus = row[9] ? String(row[9]) : ''
      const state = currentIsBanned ? (latestStatus === 'failed' ? 'failed' : 'pending') : 'done'
      return {
        originalCodeId: Number(row[0]),
        code: String(row[1] || ''),
        channel: String(row[2] || ''),
        redeemedAt: row[3] ? String(row[3]) : null,
        userEmail: extractEmailFromRedeemedBy(row[4]),
        originalAccountEmail: String(row[5] || ''),
        source: row[15] ? String(row[15]) : '',
        state,
        attempts,
        latest: row[8]
          ? {
              id: Number(row[8]),
              status: String(row[9] || ''),
              errorMessage: row[10] ? String(row[10]) : null,
              recoveryMode: row[11] ? String(row[11]) : null,
              recoveryCode: row[12] ? String(row[12]) : null,
              recoveryAccountEmail: row[13] ? String(row[13]) : null,
              createdAt: row[14] ? String(row[14]) : null
            }
          : null
      }
    })

    return res.json({
      redeems,
      pagination: {
        page,
        pageSize,
        total
      }
    })
  } catch (error) {
    console.error('Get banned account redeems error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/account-recovery/logs', async (req, res) => {
  try {
    const originalCodeId = Number(req.query.originalCodeId || req.query.original_code_id)
    if (!Number.isFinite(originalCodeId) || originalCodeId <= 0) {
      return res.status(400).json({ error: 'originalCodeId is required' })
    }

    const db = await getDatabase()
    const result = db.exec(
      `
        SELECT
          id,
          email,
          original_code_id,
          original_redeemed_at,
          original_account_email,
          recovery_mode,
          recovery_code_id,
          recovery_code,
          recovery_account_email,
          status,
          error_message,
          created_at,
          updated_at
        FROM account_recovery_logs
        WHERE original_code_id = ?
        ORDER BY id DESC
      `,
      [originalCodeId]
    )
    const logs = (result[0]?.values || []).map(row => ({
      id: Number(row[0]),
      email: String(row[1] || ''),
      originalCodeId: Number(row[2]),
      originalRedeemedAt: row[3] ? String(row[3]) : null,
      originalAccountEmail: row[4] ? String(row[4]) : null,
      recoveryMode: row[5] ? String(row[5]) : null,
      recoveryCodeId: row[6] != null ? Number(row[6]) : null,
      recoveryCode: row[7] ? String(row[7]) : null,
      recoveryAccountEmail: row[8] ? String(row[8]) : null,
      status: String(row[9] || ''),
      errorMessage: row[10] ? String(row[10]) : null,
      createdAt: row[11] ? String(row[11]) : null,
      updatedAt: row[12] ? String(row[12]) : null
    }))

    return res.json({ logs })
  } catch (error) {
    console.error('Get account recovery logs error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/account-recovery/one-click/preview', async (req, res) => {
  try {
    const source = String(req.query.source || '').trim().toLowerCase()
    if (!ACCOUNT_RECOVERY_SOURCE_SET.has(source)) {
      return res.status(400).json({ error: 'Invalid source' })
    }

    const days = Math.max(1, Math.min(90, toInt(req.query.days, ACCOUNT_RECOVERY_WINDOW_DAYS)))
    const limit = Math.min(200, Math.max(1, toInt(req.query.limit, 200)))
    const threshold = `-${days} days`

    const db = await getDatabase()

    // Best-effort inventory count (common channel only); actual recovery may still fail due to per-order expiry requirements.
    const capacityLimit = 6
    const availableResult = db.exec(
      `
        SELECT COUNT(*)
        FROM redemption_codes rc
        JOIN gpt_accounts ga ON lower(trim(ga.email)) = lower(trim(rc.account_email))
        WHERE rc.is_redeemed = 0
          AND rc.account_email IS NOT NULL
          AND trim(rc.account_email) != ''
          AND COALESCE(NULLIF(lower(trim(rc.channel)), ''), 'common') = 'common'
          AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
          AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
          AND (rc.reserved_for_uid IS NULL OR rc.reserved_for_uid = '')
          AND COALESCE(ga.user_count, 0) + COALESCE(ga.invite_count, 0) < ?
          AND COALESCE(ga.is_open, 0) = 1
          AND COALESCE(ga.is_banned, 0) = 0
          AND ga.token IS NOT NULL
          AND trim(ga.token) != ''
          AND ga.chatgpt_account_id IS NOT NULL
          AND trim(ga.chatgpt_account_id) != ''
          AND ga.expire_at IS NOT NULL
          AND trim(ga.expire_at) != ''
          AND DATETIME(REPLACE(ga.expire_at, '/', '-')) >= DATETIME('now', 'localtime')
      `,
      [capacityLimit]
    )
    const availableCount = Number(availableResult[0]?.values?.[0]?.[0] || 0)

    const eligibilitySql = `
      WITH log_flags AS (
        SELECT
          original_code_id,
          COUNT(*) AS attempts,
          MAX(id) AS latest_id
        FROM account_recovery_logs
        GROUP BY original_code_id
      ),
      log_latest AS (
        SELECT
          ar.original_code_id,
          ar.status
        FROM account_recovery_logs ar
        JOIN log_flags lf ON lf.latest_id = ar.id
      ),
      completed_flags AS (
        SELECT
          original_code_id,
          MAX(id) AS latest_completed_id
        FROM account_recovery_logs
        WHERE status IN ('success', 'skipped')
        GROUP BY original_code_id
      ),
      completed_latest AS (
        SELECT
          ar.original_code_id,
          ar.recovery_account_email
        FROM account_recovery_logs ar
        JOIN completed_flags cf ON cf.latest_completed_id = ar.id
      ),
      eligible_codes AS (
        SELECT
          ga.id AS account_id,
          rc.id AS original_code_id,
          rc.redeemed_at AS redeemed_at,
          rc.account_email AS original_account_email,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM purchase_orders po
              WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
                AND po.created_at >= DATETIME('now', 'localtime', ?)
                AND po.refunded_at IS NULL
                AND COALESCE(po.status, '') != 'refunded'
            ) THEN 'payment'
            WHEN EXISTS (
              SELECT 1
              FROM credit_orders co
              WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
                AND co.created_at >= DATETIME('now', 'localtime', ?)
                AND co.refunded_at IS NULL
                AND COALESCE(co.status, '') != 'refunded'
            ) THEN 'credit'
            WHEN EXISTS (
              SELECT 1
              FROM xianyu_orders xo
              WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
            ) THEN 'xianyu'
            WHEN EXISTS (
              SELECT 1
              FROM xhs_orders xo
              WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
            ) THEN 'xhs'
            WHEN (
              rc.redeemed_by IS NOT NULL
              AND trim(rc.redeemed_by) != ''
              AND (lower(rc.redeemed_by) LIKE '%@%' OR lower(rc.redeemed_by) LIKE '%email:%')
              AND NOT EXISTS (
                SELECT 1
                FROM purchase_orders po
                WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
              )
              AND NOT EXISTS (
                SELECT 1
                FROM credit_orders co
                WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
              )
              AND NOT EXISTS (
                SELECT 1
                FROM xhs_orders xo
                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
              )
              AND NOT EXISTS (
                SELECT 1
                FROM xianyu_orders xo
                WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
              )
            ) THEN 'manual'
            ELSE NULL
          END AS source
        FROM gpt_accounts ga
        JOIN redemption_codes rc ON lower(trim(rc.account_email)) = lower(trim(ga.email))
        WHERE ga.is_banned = 1
          AND COALESCE(ga.ban_processed, 0) = 0
          AND rc.is_redeemed = 1
          AND rc.redeemed_at IS NOT NULL
          AND rc.redeemed_at >= DATETIME('now', 'localtime', ?)
          AND COALESCE(
            NULLIF((
              SELECT po2.order_type
              FROM purchase_orders po2
              WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
              ORDER BY po2.created_at DESC
              LIMIT 1
            ), ''),
            NULLIF(rc.order_type, ''),
            'warranty'
          ) != 'no_warranty'
      ),
      eligible_filtered AS (
        SELECT *
        FROM eligible_codes
        WHERE source = ?
      ),
      eligible_enriched AS (
        SELECT
          ef.original_code_id,
          ef.redeemed_at,
          ll.status AS latest_status,
          COALESCE(NULLIF(TRIM(cl.recovery_account_email), ''), ef.original_account_email) AS current_account_email
        FROM eligible_filtered ef
        LEFT JOIN log_latest ll ON ll.original_code_id = ef.original_code_id
        LEFT JOIN completed_latest cl ON cl.original_code_id = ef.original_code_id
      ),
      eligible_with_current AS (
        SELECT
          ee.original_code_id,
          ee.redeemed_at,
          ee.latest_status,
          CASE
            WHEN current_ga.id IS NULL THEN 1
            ELSE COALESCE(current_ga.is_banned, 0)
          END AS current_is_banned
        FROM eligible_enriched ee
	        LEFT JOIN gpt_accounts current_ga ON lower(trim(current_ga.email)) = lower(trim(ee.current_account_email))
      )
    `.trim()

    const eligibilityParams = [threshold, threshold, threshold, threshold, threshold, source]
    const statsResult = db.exec(
      `
        ${eligibilitySql}
        SELECT
          SUM(CASE WHEN current_is_banned = 1 AND (latest_status IS NULL OR latest_status != 'failed') THEN 1 ELSE 0 END) AS pending_count,
          SUM(CASE WHEN current_is_banned = 1 AND latest_status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
          SUM(CASE WHEN current_is_banned = 1 THEN 1 ELSE 0 END) AS need_count
        FROM eligible_with_current
      `,
      eligibilityParams
    )

    const statsRow = statsResult[0]?.values?.[0] || []
    const pendingCount = Number(statsRow[0] || 0)
    const failedCount = Number(statsRow[1] || 0)
    const needCount = Number(statsRow[2] || 0)

    const willProcessCount = Math.min(needCount, availableCount, limit)

    let originalCodeIds = []
    if (willProcessCount > 0) {
      const idsResult = db.exec(
        `
          ${eligibilitySql}
          SELECT original_code_id
          FROM eligible_with_current
          WHERE current_is_banned = 1
          ORDER BY redeemed_at ASC, original_code_id ASC
          LIMIT ?
        `,
        [...eligibilityParams, willProcessCount]
      )
      originalCodeIds = (idsResult[0]?.values || [])
        .map(row => Number(row?.[0] || 0))
        .filter(value => Number.isFinite(value) && value > 0)
    }

    const generatedAtResult = db.exec(`SELECT DATETIME('now', 'localtime')`)
    const generatedAtRaw = generatedAtResult[0]?.values?.[0]?.[0]
    const generatedAt = generatedAtRaw ? String(generatedAtRaw) : new Date().toISOString()

    return res.json({
      source,
      days,
      pendingCount,
      failedCount,
      needCount,
      availableCount,
      willProcessCount,
      originalCodeIds,
      generatedAt
    })
  } catch (error) {
    console.error('Account recovery one-click preview error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/account-recovery/recover', async (req, res) => {
  try {
    const rawIds = req.body?.originalCodeIds ?? req.body?.original_code_ids ?? []
    const originalCodeIds = Array.isArray(rawIds)
      ? rawIds.map(value => Number(value)).filter(value => Number.isFinite(value) && value > 0)
      : []

    if (originalCodeIds.length === 0) {
      return res.status(400).json({ error: 'originalCodeIds is required' })
    }
    if (originalCodeIds.length > 200) {
      return res.status(400).json({ error: 'originalCodeIds is too large (max 200)' })
    }

    const days = ACCOUNT_RECOVERY_WINDOW_DAYS
    const threshold = `-${days} days`

    const db = await getDatabase()
    const results = []

	    for (const originalCodeId of originalCodeIds) {
	      const outcome = await withLocks([`account-recovery:original:${originalCodeId}`], async () => {
	        const originalResult = db.exec(
	          `
	            SELECT
	              rc.id,
              rc.code,
              rc.redeemed_at,
              rc.redeemed_by,
              rc.account_email,
              ga.id,
              ga.email,
              COALESCE(
                NULLIF((
                  SELECT po2.order_type
                  FROM purchase_orders po2
                  WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
                  ORDER BY po2.created_at DESC
                  LIMIT 1
                ), ''),
                NULLIF(rc.order_type, ''),
                'warranty'
              ) AS order_type
	            FROM redemption_codes rc
	            JOIN gpt_accounts ga ON lower(trim(ga.email)) = lower(trim(rc.account_email))
	            LEFT JOIN account_recovery_logs ar_recovery
	              ON ar_recovery.recovery_code_id = rc.id
	              AND ar_recovery.status IN ('success', 'skipped')
	            WHERE rc.id = ?
	              AND rc.is_redeemed = 1
	              AND rc.redeemed_at IS NOT NULL
	              AND rc.redeemed_at >= DATETIME('now', 'localtime', ?)
	              AND ar_recovery.id IS NULL
	              AND ga.is_banned = 1
		              AND (
		                EXISTS (
		                  SELECT 1
		                  FROM purchase_orders po
		                  WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
		                    AND po.created_at >= DATETIME('now', 'localtime', ?)
		                    AND po.refunded_at IS NULL
		                    AND COALESCE(po.status, '') != 'refunded'
		                )
		                OR EXISTS (
		                  SELECT 1
		                  FROM credit_orders co
		                  WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
		                    AND co.created_at >= DATETIME('now', 'localtime', ?)
		                    AND co.refunded_at IS NULL
		                    AND COALESCE(co.status, '') != 'refunded'
		                )
		                OR EXISTS (
		                  SELECT 1
		                  FROM xhs_orders xo
                  WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                    AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
                )
                OR EXISTS (
                  SELECT 1
                  FROM xianyu_orders xo
                  WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                    AND COALESCE(xo.order_time, xo.created_at) >= DATETIME('now', 'localtime', ?)
                )
                OR (
                  rc.redeemed_by IS NOT NULL
                  AND trim(rc.redeemed_by) != ''
                  AND (lower(rc.redeemed_by) LIKE '%@%' OR lower(rc.redeemed_by) LIKE '%email:%')
                  AND NOT EXISTS (
                    SELECT 1
                    FROM purchase_orders po
                    WHERE (po.code_id = rc.id OR (po.code_id IS NULL AND po.code = rc.code))
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM credit_orders co
                    WHERE (co.code_id = rc.id OR (co.code_id IS NULL AND co.code = rc.code))
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM xhs_orders xo
                    WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                  )
                  AND NOT EXISTS (
                    SELECT 1
                    FROM xianyu_orders xo
                    WHERE (xo.assigned_code_id = rc.id OR (xo.assigned_code_id IS NULL AND xo.assigned_code = rc.code))
                  )
                )
              )
              AND COALESCE(
                NULLIF((
                  SELECT po2.order_type
                  FROM purchase_orders po2
                  WHERE (po2.code_id = rc.id OR (po2.code_id IS NULL AND po2.code = rc.code))
                  ORDER BY po2.created_at DESC
                  LIMIT 1
                ), ''),
                NULLIF(rc.order_type, ''),
                'warranty'
              ) != 'no_warranty'
            LIMIT 1
          `,
	          [originalCodeId, threshold, threshold, threshold, threshold, threshold]
	        )

	        const row = originalResult[0]?.values?.[0]
	        if (!row) {
	          return { originalCodeId, outcome: 'invalid', message: '兑换码不存在 / 不在窗口期 / 非封号账号 / 无质保订单' }
	        }

        const redeemedBy = extractEmailFromRedeemedBy(row[3])
        if (!redeemedBy) {
          return { originalCodeId, outcome: 'invalid', message: '兑换记录缺少有效用户邮箱' }
        }

	        const redeemedAt = row[2] ? String(row[2]) : null
	        const originalAccountEmail = String(row[6] || row[4] || '')

	        const completedLogResult = db.exec(
	          `
	            SELECT recovery_account_email
	            FROM account_recovery_logs
	            WHERE original_code_id = ?
	              AND status IN ('success', 'skipped')
	            ORDER BY id DESC
	            LIMIT 1
	          `,
	          [originalCodeId]
	        )
	        const completedLogRow = completedLogResult[0]?.values?.[0]
	        const currentAccountEmail = completedLogRow?.[0]
	          ? normalizeEmail(completedLogRow[0])
	          : normalizeEmail(originalAccountEmail)

	        if (currentAccountEmail) {
	          const currentAccountResult = db.exec(
	            `
	              SELECT COALESCE(is_banned, 0) AS is_banned
	              FROM gpt_accounts
	              WHERE lower(email) = ?
	              LIMIT 1
	            `,
	            [currentAccountEmail]
	          )
	          const currentAccountRow = currentAccountResult[0]?.values?.[0]
	          if (currentAccountRow && Number(currentAccountRow[0] || 0) === 0) {
	            return { originalCodeId, outcome: 'already_done', message: '当前账号仍可用，无需补录' }
	          }
	        }

        const originalCode = row[1] ? String(row[1]) : ''
        const resolvedOrderType = row[7] ? String(row[7]) : null
        const orderDeadlineMs = resolveOrderDeadlineMs(db, {
          originalCodeId,
          originalCode,
          redeemedAt,
          orderType: resolvedOrderType
        })

        const recoverySettings = await getAccountRecoverySettings(db)
        const codeCreatedWithinDays = Math.max(1, toInt(recoverySettings?.effective?.codeCreatedWithinDays, 7))
        const requireExpireCoverDeadline = Boolean(recoverySettings?.effective?.requireExpireCoverDeadline)
        const triedRecoveryCodeIds = new Set()
        let lastAttemptError = null
        let lastAttemptRecovery = null

        for (let attempt = 1; attempt <= ACCOUNT_RECOVERY_REDEEM_MAX_ATTEMPTS; attempt += 1) {
          const selectedRecovery = selectRecoveryCode(db, {
            minExpireMs: requireExpireCoverDeadline ? orderDeadlineMs : Date.now(),
            capacityLimit: 6,
            preferNonToday: requireExpireCoverDeadline,
            preferLatestExpire: !requireExpireCoverDeadline,
            limit: 200,
            codeCreatedWithinDays,
            excludeCodeIds: Array.from(triedRecoveryCodeIds)
          })
          if (!selectedRecovery) break

          lastAttemptRecovery = selectedRecovery
          triedRecoveryCodeIds.add(selectedRecovery.recoveryCodeId)

          const recoveryCodeId = selectedRecovery.recoveryCodeId
          const recoveryCode = selectedRecovery.recoveryCode
          const recoveryChannel = selectedRecovery.recoveryChannel || 'common'
          const recoveryAccountEmail = selectedRecovery.recoveryAccountEmail

          try {
            const redemptionResult = await redeemCodeInternal({
              code: recoveryCode,
              email: redeemedBy,
              channel: recoveryChannel
            })

            recordAccountRecovery(db, {
              email: redeemedBy,
              originalCodeId,
              originalRedeemedAt: redeemedAt,
              originalAccountEmail,
              recoveryMode: 'open-account',
              recoveryCodeId,
              recoveryCode,
              recoveryAccountEmail: redemptionResult.metadata?.accountEmail || recoveryAccountEmail,
              status: 'success'
            })
            saveDatabase()
            return {
              originalCodeId,
              outcome: 'success',
              message: '补录成功',
              recovery: {
                recoveryCodeId,
                recoveryCode,
                recoveryAccountEmail: redemptionResult.metadata?.accountEmail || recoveryAccountEmail
              }
            }
          } catch (error) {
            lastAttemptError = error
            const shouldRetry = attempt < ACCOUNT_RECOVERY_REDEEM_MAX_ATTEMPTS && shouldRetryAccountRecoveryRedeem(error)
            if (shouldRetry) continue

            const statusCode = typeof error?.statusCode === 'number'
              ? error.statusCode
              : (typeof error?.status === 'number' ? error.status : 500)
            recordAccountRecovery(db, {
              email: redeemedBy,
              originalCodeId,
              originalRedeemedAt: redeemedAt,
              originalAccountEmail,
              recoveryMode: 'open-account',
              recoveryCodeId,
              recoveryCode,
              recoveryAccountEmail,
              status: 'failed',
              errorMessage: error?.message || '补录失败'
            })
            saveDatabase()
            return {
              originalCodeId,
              outcome: 'failed',
              message: error?.message || '补录失败',
              statusCode
            }
          }
        }

        const errorMessage = lastAttemptError?.message || '暂无可用通用渠道补录兑换码'
        recordAccountRecovery(db, {
          email: redeemedBy,
          originalCodeId,
          originalRedeemedAt: redeemedAt,
          originalAccountEmail,
          recoveryMode: 'open-account',
          recoveryCodeId: lastAttemptRecovery?.recoveryCodeId,
          recoveryCode: lastAttemptRecovery?.recoveryCode,
          recoveryAccountEmail: lastAttemptRecovery?.recoveryAccountEmail,
          status: 'failed',
          errorMessage
        })
        saveDatabase()

        return {
          originalCodeId,
          outcome: 'failed',
          message: errorMessage
        }
      })

      results.push(outcome)
    }

    return res.json({ results })
  } catch (error) {
    console.error('Admin account recovery error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------
// Channels Admin
// ---------------------------

router.get('/channels', async (req, res) => {
  try {
    const db = await getDatabase()
    const { list } = await getChannels(db, { forceRefresh: true })
    return res.json({ channels: list })
  } catch (error) {
    console.error('[Admin] get channels error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/channels', async (req, res) => {
  try {
    const rawKey = req.body?.key ?? req.body?.channelKey
    const key = normalizeChannelKey(rawKey, '')
    if (!key || !CHANNEL_KEY_REGEX.test(key)) {
      return res.status(400).json({ error: '渠道 key 不合法（仅允许 2-32 位小写字母/数字/连字符）' })
    }

    const name = String(req.body?.name ?? '').trim()
    if (!name) {
      return res.status(400).json({ error: '请输入渠道名称' })
    }

    const allowCommonFallback = parseBoolean(req.body?.allowCommonFallback ?? req.body?.allow_common_fallback, false)
    const isActive = parseBoolean(req.body?.isActive ?? req.body?.is_active, true)
    const sortOrder = Number.isFinite(Number(req.body?.sortOrder ?? req.body?.sort_order))
      ? Number(req.body?.sortOrder ?? req.body?.sort_order)
      : 0

    const db = await getDatabase()
    const exists = db.exec('SELECT id FROM channels WHERE key = ? LIMIT 1', [key])
    if (exists[0]?.values?.length) {
      return res.status(409).json({ error: '渠道已存在' })
    }

    db.run(
      `
        INSERT INTO channels (
          key, name, redeem_mode, allow_common_fallback, is_active, is_builtin, sort_order, created_at, updated_at
        ) VALUES (?, ?, 'code', ?, ?, 0, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
      `,
      [key, name, allowCommonFallback ? 1 : 0, isActive ? 1 : 0, sortOrder]
    )
    saveDatabase()
    invalidateChannelsCache()

    const channel = await getChannelByKey(db, key, { forceRefresh: true })
    return res.status(201).json({ channel })
  } catch (error) {
    console.error('[Admin] create channel error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/channels/:key', async (req, res) => {
  try {
    const key = normalizeChannelKey(req.params.key, '')
    if (!key || !CHANNEL_KEY_REGEX.test(key)) {
      return res.status(400).json({ error: '渠道 key 不合法' })
    }

    const db = await getDatabase()
    const existingResult = db.exec(
      `
        SELECT key, name, redeem_mode, allow_common_fallback, is_active, is_builtin, sort_order
        FROM channels
        WHERE key = ?
        LIMIT 1
      `,
      [key]
    )
    const existingRow = existingResult[0]?.values?.[0]
    if (!existingRow) {
      return res.status(404).json({ error: '渠道不存在' })
    }

    const prevName = String(existingRow[1] ?? '').trim()
    const updates = []
    const params = []

    if (req.body?.name !== undefined) {
      const name = String(req.body?.name ?? '').trim()
      if (!name) return res.status(400).json({ error: '渠道名称不能为空' })
      updates.push('name = ?')
      params.push(name)
    }

    if (req.body?.allowCommonFallback !== undefined || req.body?.allow_common_fallback !== undefined) {
      const allowCommonFallback = parseBoolean(req.body?.allowCommonFallback ?? req.body?.allow_common_fallback, false)
      updates.push('allow_common_fallback = ?')
      params.push(allowCommonFallback ? 1 : 0)
    }

    if (req.body?.isActive !== undefined || req.body?.is_active !== undefined) {
      const isActive = parseBoolean(req.body?.isActive ?? req.body?.is_active, true)
      updates.push('is_active = ?')
      params.push(isActive ? 1 : 0)
    }

    if (req.body?.sortOrder !== undefined || req.body?.sort_order !== undefined) {
      const sortOrder = Number.isFinite(Number(req.body?.sortOrder ?? req.body?.sort_order))
        ? Number(req.body?.sortOrder ?? req.body?.sort_order)
        : 0
      updates.push('sort_order = ?')
      params.push(sortOrder)
    }

    if (!updates.length) {
      const channel = await getChannelByKey(db, key, { forceRefresh: true })
      return res.json({ channel })
    }

    db.run(
      `
        UPDATE channels
        SET ${updates.join(', ')},
            updated_at = DATETIME('now', 'localtime')
        WHERE key = ?
      `,
      [...params, key]
    )

    if (req.body?.name !== undefined) {
      const nextName = String(req.body?.name ?? '').trim()
      if (nextName && nextName !== prevName) {
        db.run(
          `
            UPDATE redemption_codes
            SET channel_name = ?,
                updated_at = DATETIME('now', 'localtime')
            WHERE lower(trim(channel)) = ?
          `,
          [nextName, key]
        )
      }
    }

    saveDatabase()
    invalidateChannelsCache()

    const channel = await getChannelByKey(db, key, { forceRefresh: true })
    return res.json({ channel })
  } catch (error) {
    console.error('[Admin] update channel error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/channels/:key', async (req, res) => {
  try {
    const key = normalizeChannelKey(req.params.key, '')
    if (!key || !CHANNEL_KEY_REGEX.test(key)) {
      return res.status(400).json({ error: '渠道 key 不合法' })
    }

    const db = await getDatabase()
    const result = db.exec('SELECT is_builtin FROM channels WHERE key = ? LIMIT 1', [key])
    const row = result[0]?.values?.[0]
    if (!row) {
      return res.status(404).json({ error: '渠道不存在' })
    }
    const isBuiltin = Number(row[0] || 0) === 1
    if (isBuiltin) {
      return res.status(400).json({ error: '内置渠道不可删除' })
    }

    db.run('DELETE FROM channels WHERE key = ?', [key])
    saveDatabase()
    invalidateChannelsCache()
    return res.json({ ok: true })
  } catch (error) {
    console.error('[Admin] delete channel error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

// ---------------------------
// Purchase Products Admin
// ---------------------------

const validateProductKey = (value) => {
  const normalized = normalizeProductKey(value)
  return normalized && PRODUCT_KEY_REGEX.test(normalized) ? normalized : ''
}

const validateChannelList = async (db, rawChannels) => {
  const { list } = normalizeCodeChannels(rawChannels)
  if (!list.length) {
    return { ok: false, error: '请选择至少 1 个渠道', channels: [] }
  }
  if (list.length > 3) {
    return { ok: false, error: '最多仅支持配置 3 个渠道（按优先级排序）', channels: [] }
  }

  const { byKey } = await getChannels(db)
  const resolved = []
  for (const token of list) {
    const key = normalizeChannelKey(token, '')
    if (!key) continue
    const channel = byKey.get(key)
    if (!channel) {
      return { ok: false, error: `渠道不存在：${key}`, channels: [] }
    }
    if (!channel.isActive) {
      return { ok: false, error: `渠道已停用：${key}`, channels: [] }
    }
    resolved.push(key)
  }
  if (!resolved.length) {
    return { ok: false, error: '渠道配置无效', channels: [] }
  }
  return { ok: true, channels: resolved }
}

router.get('/purchase-products', async (req, res) => {
  try {
    const db = await getDatabase()
    const products = await listPurchaseProducts(db, { activeOnly: false })
    return res.json({ products })
  } catch (error) {
    console.error('[Admin] get purchase-products error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/purchase-products', async (req, res) => {
  try {
    const raw = req.body || {}
    const productKey = validateProductKey(raw.productKey ?? raw.product_key)
    if (!productKey) {
      return res.status(400).json({ error: 'productKey 不合法（仅允许 2-32 位小写字母/数字/连字符）' })
    }

    const productName = String(raw.productName ?? raw.product_name ?? '').trim()
    if (!productName) {
      return res.status(400).json({ error: '请输入商品名称' })
    }

    const amount = normalizeMoney2(raw.amount)
    if (!amount) {
      return res.status(400).json({ error: 'amount 不合法（必须为大于 0 的金额）' })
    }

    const serviceDays = Number(raw.serviceDays ?? raw.service_days)
    if (!Number.isFinite(serviceDays) || serviceDays < 1) {
      return res.status(400).json({ error: 'serviceDays 不合法（必须 >= 1）' })
    }

    const rawOrderType = String(raw.orderType ?? raw.order_type ?? '').trim().toLowerCase()
    if (!rawOrderType) {
      return res.status(400).json({ error: '请选择订单类型（orderType）' })
    }
    const orderType = normalizePurchaseProductOrderType(rawOrderType)
    if (orderType !== rawOrderType) {
      return res.status(400).json({ error: 'orderType 不合法（仅允许 warranty/no_warranty/anti_ban）' })
    }

    const db = await getDatabase()
    const exists = await getPurchaseProductByKey(db, productKey)
    if (exists) {
      return res.status(409).json({ error: '商品已存在' })
    }

    const channelValidation = await validateChannelList(db, raw.codeChannels ?? raw.code_channels)
    if (!channelValidation.ok) {
      return res.status(400).json({ error: channelValidation.error })
    }

    const isActive = parseBoolean(raw.isActive ?? raw.is_active, true)
    const sortOrder = Number.isFinite(Number(raw.sortOrder ?? raw.sort_order)) ? Number(raw.sortOrder ?? raw.sort_order) : 0

    const product = await upsertPurchaseProduct(db, {
      productKey,
      productName,
      amount,
      serviceDays,
      orderType,
      codeChannels: channelValidation.channels.join(','),
      isActive,
      sortOrder,
    })

    return res.status(201).json({ product })
  } catch (error) {
    console.error('[Admin] create purchase-product error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.patch('/purchase-products/:productKey', async (req, res) => {
  try {
    const productKey = validateProductKey(req.params.productKey)
    if (!productKey) {
      return res.status(400).json({ error: 'productKey 不合法' })
    }

    const db = await getDatabase()
    const existing = await getPurchaseProductByKey(db, productKey)
    if (!existing) {
      return res.status(404).json({ error: '商品不存在' })
    }

    const raw = req.body || {}
    const nextProductName = raw.productName !== undefined || raw.product_name !== undefined
      ? String(raw.productName ?? raw.product_name ?? '').trim()
      : existing.productName
    if (!nextProductName) {
      return res.status(400).json({ error: '商品名称不能为空' })
    }

    const nextAmount = raw.amount !== undefined ? normalizeMoney2(raw.amount) : String(existing.amount || '').trim()
    if (!nextAmount) {
      return res.status(400).json({ error: 'amount 不合法（必须为大于 0 的金额）' })
    }

    const nextServiceDays = raw.serviceDays !== undefined || raw.service_days !== undefined
      ? Number(raw.serviceDays ?? raw.service_days)
      : Number(existing.serviceDays)
    if (!Number.isFinite(nextServiceDays) || nextServiceDays < 1) {
      return res.status(400).json({ error: 'serviceDays 不合法（必须 >= 1）' })
    }

    let nextOrderType = existing.orderType
    if (raw.orderType !== undefined || raw.order_type !== undefined) {
      const rawOrderType = String(raw.orderType ?? raw.order_type ?? '').trim().toLowerCase()
      if (!rawOrderType) return res.status(400).json({ error: 'orderType 不能为空' })
      const normalized = normalizePurchaseProductOrderType(rawOrderType)
      if (normalized !== rawOrderType) {
        return res.status(400).json({ error: 'orderType 不合法（仅允许 warranty/no_warranty/anti_ban）' })
      }
      nextOrderType = normalized
    }

    let nextCodeChannels = existing.codeChannels
    if (raw.codeChannels !== undefined || raw.code_channels !== undefined) {
      const channelValidation = await validateChannelList(db, raw.codeChannels ?? raw.code_channels)
      if (!channelValidation.ok) {
        return res.status(400).json({ error: channelValidation.error })
      }
      nextCodeChannels = channelValidation.channels.join(',')
    }

    const nextIsActive = raw.isActive !== undefined || raw.is_active !== undefined
      ? parseBoolean(raw.isActive ?? raw.is_active, Boolean(existing.isActive))
      : Boolean(existing.isActive)
    const nextSortOrder = raw.sortOrder !== undefined || raw.sort_order !== undefined
      ? (Number.isFinite(Number(raw.sortOrder ?? raw.sort_order)) ? Number(raw.sortOrder ?? raw.sort_order) : 0)
      : Number(existing.sortOrder || 0)

    const product = await upsertPurchaseProduct(db, {
      productKey,
      productName: nextProductName,
      amount: nextAmount,
      serviceDays: nextServiceDays,
      orderType: nextOrderType,
      codeChannels: nextCodeChannels,
      isActive: nextIsActive,
      sortOrder: nextSortOrder,
    })

    return res.json({ product })
  } catch (error) {
    console.error('[Admin] update purchase-product error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.delete('/purchase-products/:productKey', async (req, res) => {
  try {
    const productKey = validateProductKey(req.params.productKey)
    if (!productKey) {
      return res.status(400).json({ error: 'productKey 不合法' })
    }

    const db = await getDatabase()
    const existing = await getPurchaseProductByKey(db, productKey)
    if (!existing) {
      return res.status(404).json({ error: '商品不存在' })
    }

    db.run('DELETE FROM purchase_products WHERE product_key = ?', [productKey])
    saveDatabase()
    return res.json({ ok: true })
  } catch (error) {
    console.error('[Admin] delete purchase-product error:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
