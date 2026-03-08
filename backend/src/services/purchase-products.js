import { getDatabase, saveDatabase } from '../database/init.js'

// NOTE: allow `_` for backward compatibility (e.g. `no_warranty`).
export const PRODUCT_KEY_REGEX = /^[a-z0-9-_]{2,32}$/

const ORDER_TYPE_WARRANTY = 'warranty'
const ORDER_TYPE_NO_WARRANTY = 'no_warranty'
const ORDER_TYPE_ANTI_BAN = 'anti_ban'
const ORDER_TYPE_SET = new Set([ORDER_TYPE_WARRANTY, ORDER_TYPE_NO_WARRANTY, ORDER_TYPE_ANTI_BAN])

export const normalizeOrderType = (value) => {
  const normalized = String(value || '').trim().toLowerCase()
  return ORDER_TYPE_SET.has(normalized) ? normalized : ORDER_TYPE_WARRANTY
}

export const normalizeProductKey = (value) => {
  const normalized = String(value ?? '').trim().toLowerCase()
  return PRODUCT_KEY_REGEX.test(normalized) ? normalized : ''
}

export const normalizeCodeChannels = (value) => {
  const raw = Array.isArray(value)
    ? value.join(',')
    : String(value ?? '')
  const tokens = raw
    .split(',')
    .map(item => String(item || '').trim().toLowerCase())
    .filter(Boolean)

  const deduped = []
  const seen = new Set()
  for (const token of tokens) {
    if (seen.has(token)) continue
    seen.add(token)
    deduped.push(token)
  }

  return {
    list: deduped,
    stored: deduped.join(',')
  }
}

const mapProductRow = (row) => {
  if (!row) return null
  return {
    id: Number(row[0]),
    productKey: row[1] ? String(row[1]) : '',
    productName: row[2] ? String(row[2]) : '',
    amount: row[3] ? String(row[3]) : '',
    serviceDays: Number(row[4] || 0),
    orderType: row[5] ? String(row[5]) : ORDER_TYPE_WARRANTY,
    codeChannels: row[6] ? String(row[6]) : '',
    isActive: Number(row[7] || 0) === 1,
    sortOrder: Number(row[8] || 0) || 0,
    createdAt: row[9] || null,
    updatedAt: row[10] || null,
  }
}

export async function listPurchaseProducts(db, { activeOnly = false } = {}) {
  const database = db || (await getDatabase())
  const whereClause = activeOnly ? 'WHERE COALESCE(is_active, 0) = 1' : ''
  const result = database.exec(
    `
      SELECT id, product_key, product_name, amount, service_days, order_type, code_channels, COALESCE(is_active, 0), COALESCE(sort_order, 0),
             created_at, updated_at
      FROM purchase_products
      ${whereClause}
      ORDER BY COALESCE(sort_order, 0) ASC, id ASC
    `
  )
  return (result[0]?.values || []).map(mapProductRow).filter(Boolean)
}

export async function getPurchaseProductByKey(db, productKey) {
  const key = normalizeProductKey(productKey)
  if (!key) return null
  const database = db || (await getDatabase())
  const result = database.exec(
    `
      SELECT id, product_key, product_name, amount, service_days, order_type, code_channels, COALESCE(is_active, 0), COALESCE(sort_order, 0),
             created_at, updated_at
      FROM purchase_products
      WHERE product_key = ?
      LIMIT 1
    `,
    [key]
  )
  const row = result[0]?.values?.[0] || null
  return mapProductRow(row)
}

export async function upsertPurchaseProduct(db, payload) {
  const database = db || (await getDatabase())
  if (!payload) return null

  const productKey = normalizeProductKey(payload.productKey || payload.product_key)
  if (!productKey) {
    throw new Error('invalid_product_key')
  }

  const productName = String(payload.productName || payload.product_name || '').trim()
  if (!productName) {
    throw new Error('missing_product_name')
  }

  const amount = String(payload.amount ?? '').trim()
  if (!amount) {
    throw new Error('missing_amount')
  }

  const serviceDays = Number(payload.serviceDays ?? payload.service_days ?? 0)
  if (!Number.isFinite(serviceDays) || serviceDays < 1) {
    throw new Error('invalid_service_days')
  }

  const orderType = normalizeOrderType(payload.orderType || payload.order_type)
  const { stored: codeChannels } = normalizeCodeChannels(payload.codeChannels || payload.code_channels)
  if (!codeChannels) {
    throw new Error('missing_code_channels')
  }

  const isActive = payload.isActive === undefined ? 1 : (payload.isActive ? 1 : 0)
  const sortOrder = Number.isFinite(Number(payload.sortOrder)) ? Number(payload.sortOrder) : 0

  const exists = database.exec('SELECT id FROM purchase_products WHERE product_key = ? LIMIT 1', [productKey])
  if (exists[0]?.values?.length) {
    database.run(
      `
        UPDATE purchase_products
        SET product_name = ?,
            amount = ?,
            service_days = ?,
            order_type = ?,
            code_channels = ?,
            is_active = ?,
            sort_order = ?,
            updated_at = DATETIME('now', 'localtime')
        WHERE product_key = ?
      `,
      [productName, amount, serviceDays, orderType, codeChannels, isActive, sortOrder, productKey]
    )
  } else {
    database.run(
      `
        INSERT INTO purchase_products (
          product_key, product_name, amount, service_days, order_type, code_channels, is_active, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
      `,
      [productKey, productName, amount, serviceDays, orderType, codeChannels, isActive, sortOrder]
    )
  }

  saveDatabase()
  return getPurchaseProductByKey(database, productKey)
}

export async function disablePurchaseProduct(db, productKey) {
  const database = db || (await getDatabase())
  const key = normalizeProductKey(productKey)
  if (!key) throw new Error('invalid_product_key')
  database.run(
    `
      UPDATE purchase_products
      SET is_active = 0,
          updated_at = DATETIME('now', 'localtime')
      WHERE product_key = ?
    `,
    [key]
  )
  saveDatabase()
  return getPurchaseProductByKey(database, key)
}
