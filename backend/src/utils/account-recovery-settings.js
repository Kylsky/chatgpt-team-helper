import { getDatabase } from '../database/init.js'

const CONFIG_KEYS = [
  'account_recovery_force_today_codes',
  'account_recovery_code_window_days',
  'account_recovery_require_expire_cover_deadline',
]

const DEFAULT_SETTINGS = Object.freeze({
  forceTodayCodes: false,
  codeWindowDays: 7,
  requireExpireCoverDeadline: false,
})

const CACHE_TTL_MS = 30 * 1000
let cachedSettings = null
let cachedAt = 0

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const parseBool = (value, fallback = false) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (value === undefined || value === null) return Boolean(fallback)
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return Boolean(fallback)
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  return Boolean(fallback)
}

const clampInt = (value, { min, max, fallback }) => {
  const parsed = toInt(value, fallback)
  const normalized = Number.isFinite(parsed) ? parsed : fallback
  return Math.max(min, Math.min(max, normalized))
}

const loadSystemConfigMap = (database, keys) => {
  if (!database) return new Map()
  const list = Array.isArray(keys) && keys.length ? keys : CONFIG_KEYS
  const placeholders = list.map(() => '?').join(',')
  const result = database.exec(
    `SELECT config_key, config_value FROM system_config WHERE config_key IN (${placeholders})`,
    list
  )
  const map = new Map()
  const rows = result[0]?.values || []
  for (const row of rows) {
    map.set(String(row?.[0] ?? ''), String(row?.[1] ?? ''))
  }
  return map
}

export const invalidateAccountRecoverySettingsCache = () => {
  cachedSettings = null
  cachedAt = 0
}

export async function getAccountRecoverySettings(db, { forceRefresh = false } = {}) {
  const now = Date.now()
  if (!forceRefresh && cachedSettings && now - cachedAt < CACHE_TTL_MS) {
    return cachedSettings
  }

  const database = db || (await getDatabase())
  const stored = loadSystemConfigMap(database, CONFIG_KEYS)

  const forceTodayCodes = stored.has('account_recovery_force_today_codes')
    ? parseBool(stored.get('account_recovery_force_today_codes'), DEFAULT_SETTINGS.forceTodayCodes)
    : DEFAULT_SETTINGS.forceTodayCodes

  const codeWindowDays = stored.has('account_recovery_code_window_days')
    ? clampInt(stored.get('account_recovery_code_window_days'), { min: 1, max: 365, fallback: DEFAULT_SETTINGS.codeWindowDays })
    : DEFAULT_SETTINGS.codeWindowDays

  const requireExpireCoverDeadlineRaw = stored.has('account_recovery_require_expire_cover_deadline')
    ? parseBool(stored.get('account_recovery_require_expire_cover_deadline'), DEFAULT_SETTINGS.requireExpireCoverDeadline)
    : DEFAULT_SETTINGS.requireExpireCoverDeadline

  const effectiveRequireExpireCoverDeadline = forceTodayCodes ? requireExpireCoverDeadlineRaw : false
  const effectiveCodeCreatedWithinDays = forceTodayCodes ? 1 : codeWindowDays

  cachedSettings = {
    forceTodayCodes,
    codeWindowDays,
    requireExpireCoverDeadline: requireExpireCoverDeadlineRaw,
    effective: {
      codeCreatedWithinDays: effectiveCodeCreatedWithinDays,
      requireExpireCoverDeadline: effectiveRequireExpireCoverDeadline
    },
    stored: {
      forceTodayCodes: stored.has('account_recovery_force_today_codes'),
      codeWindowDays: stored.has('account_recovery_code_window_days'),
      requireExpireCoverDeadline: stored.has('account_recovery_require_expire_cover_deadline')
    }
  }
  cachedAt = now
  return cachedSettings
}

