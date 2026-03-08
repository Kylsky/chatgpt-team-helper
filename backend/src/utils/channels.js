import { getDatabase } from '../database/init.js'

export const CHANNEL_KEY_REGEX = /^[a-z0-9-]{2,32}$/

const CACHE_TTL_MS = 30 * 1000
let cached = { list: [], byKey: new Map() }
let cachedAt = 0

export const normalizeChannelKey = (value, fallback = 'common') => {
  const normalized = String(value ?? '').trim().toLowerCase()
  return normalized ? normalized : String(fallback || 'common').trim().toLowerCase() || 'common'
}

const mapChannelRow = (row) => {
  if (!row) return null
  const key = normalizeChannelKey(row[0], '')
  if (!key) return null
  return {
    key,
    name: String(row[1] ?? '').trim(),
    redeemMode: String(row[2] ?? 'code').trim() || 'code',
    allowCommonFallback: Number(row[3] || 0) === 1,
    isActive: Number(row[4] ?? 1) !== 0,
    isBuiltin: Number(row[5] || 0) === 1,
    sortOrder: Number(row[6] || 0) || 0,
    createdAt: row[7] || null,
    updatedAt: row[8] || null,
  }
}

const loadChannelsFromDb = (database) => {
  const result = database.exec(
    `
      SELECT key, name, redeem_mode, allow_common_fallback, is_active, is_builtin, sort_order, created_at, updated_at
      FROM channels
      ORDER BY sort_order ASC, id ASC
    `
  )
  const rows = result[0]?.values || []
  const list = []
  const byKey = new Map()
  for (const row of rows) {
    const channel = mapChannelRow(row)
    if (!channel?.key) continue
    list.push(channel)
    byKey.set(channel.key, channel)
  }
  return { list, byKey }
}

export const invalidateChannelsCache = () => {
  cached = { list: [], byKey: new Map() }
  cachedAt = 0
}

export async function getChannels(db, { forceRefresh = false } = {}) {
  const now = Date.now()
  if (!forceRefresh && cachedAt && now - cachedAt < CACHE_TTL_MS && cached?.list?.length) {
    return cached
  }

  const database = db || (await getDatabase())
  try {
    cached = loadChannelsFromDb(database)
    cachedAt = now
    return cached
  } catch (error) {
    // Keep previous cache if DB read fails.
    console.warn('[Channels] load failed', error?.message || error)
    return cached
  }
}

export const getCachedChannelByKey = (key) => {
  const normalized = normalizeChannelKey(key, '')
  if (!normalized) return null
  return cached?.byKey?.get(normalized) || null
}

export const getCachedChannelName = (key) => {
  const channel = getCachedChannelByKey(key)
  const name = channel?.name ? String(channel.name).trim() : ''
  return name || ''
}

export async function getChannelByKey(db, key, { forceRefresh = false } = {}) {
  const normalized = normalizeChannelKey(key, '')
  if (!normalized) return null
  const { byKey } = await getChannels(db, { forceRefresh })
  return byKey.get(normalized) || null
}

