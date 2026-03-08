import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateLinuxDoSession } from '../middleware/linuxdo-session.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { buildCreditSign, formatCreditMoney, getCreditGatewayConfig, queryCreditOrder, refundCreditOrder } from '../services/credit-gateway.js'
import { withLocks } from '../utils/locks.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'

const router = express.Router()

router.use(requireFeatureEnabled('openAccounts'))

router.use('/admin', authenticateToken, requireMenu('credit_orders'))

router.get('/admin/orders/summary', async (req, res) => {
  try {
    const db = await getDatabase()
    const search = (req.query.search || '').trim().toLowerCase()

    const conditions = []
    const params = []

    if (search) {
      conditions.push(`(LOWER(order_no) LIKE ? OR LOWER(uid) LIKE ? OR LOWER(username) LIKE ? OR LOWER(title) LIKE ?)`)
      const searchPattern = `%${search}%`
      params.push(searchPattern, searchPattern, searchPattern, searchPattern)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const result = db.exec(
      `
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS paid,
          COALESCE(SUM(CASE WHEN status IN ('pending_payment', 'created') THEN 1 ELSE 0 END), 0) AS pending,
          COALESCE(SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END), 0) AS refunded
        FROM credit_orders
        ${whereClause}
      `,
      params
    )

    const row = result[0]?.values?.[0] || [0, 0, 0, 0]
    res.json({
      total: Number(row[0] || 0),
      paid: Number(row[1] || 0),
      pending: Number(row[2] || 0),
      refunded: Number(row[3] || 0)
    })
  } catch (error) {
    console.error('[Credit] admin summary error:', error)
    res.status(500).json({ error: '查询失败' })
  }
})

const safeSnippet = (value, limit = 420) => {
  if (value == null) return ''
  const raw = typeof value === 'string' ? value : (() => {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  })()
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, limit)}…`
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const isEnabledFlag = (value, defaultValue = true) => {
  if (value === undefined || value === null || value === '') return Boolean(defaultValue)
  const raw = String(value).trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

const creditGatewayServerQueryEnabled = () => isEnabledFlag(process.env.CREDIT_GATEWAY_SERVER_QUERY_ENABLED, false)
const creditRefundEnabled = () => isEnabledFlag(process.env.CREDIT_GATEWAY_SERVER_REFUND_ENABLED, true)

const normalizeUid = (value) => String(value ?? '').trim()
const normalizeOrderNo = (value) => String(value ?? '').trim()

const getClientIp = (req) => {
  const cfConnectingIp = req.headers['cf-connecting-ip']
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim()
  }
  const forwardedFor = req.headers['x-forwarded-for']
  if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
    return forwardedFor.split(',')[0].trim()
  }
  return req.ip
}

const summarizeCreditNotifyPayload = (payload) => {
  const safeText = (value) => String(value ?? '').trim()
  const sign = safeText(payload?.sign)
  return {
    pid: safeText(payload?.pid) || null,
    tradeNo: safeText(payload?.trade_no) || null,
    outTradeNo: safeText(payload?.out_trade_no) || null,
    type: safeText(payload?.type) || null,
    name: safeText(payload?.name) || null,
    money: safeText(payload?.money) || null,
    tradeStatus: safeText(payload?.trade_status) || null,
    signType: safeText(payload?.sign_type) || null,
    hasSign: Boolean(sign),
    signLength: sign.length || 0,
    signPrefix: sign ? sign.slice(0, 8) : null
  }
}

const fetchCreditOrder = (db, orderNo) => {
  const result = db.exec(
    `
      SELECT order_no, trade_no, uid, username, scene, title, amount, status, pay_url, target_account_id,
             code_id, code, code_account_email,
             action_status, action_message, action_payload, action_result,
             query_payload, query_at, query_status,
             notify_payload, notify_at,
             created_at, updated_at, paid_at, refunded_at, refund_message
      FROM credit_orders
      WHERE order_no = ?
      LIMIT 1
    `,
    [orderNo]
  )

  const row = result[0]?.values?.[0]
  if (!row) return null
  return {
    orderNo: row[0],
    tradeNo: row[1] || null,
    uid: row[2],
    username: row[3] || null,
    scene: row[4],
    title: row[5],
    amount: row[6],
    status: row[7],
    payUrl: row[8] || null,
    targetAccountId: row[9] != null ? Number(row[9]) : null,
    codeId: row[10] != null ? Number(row[10]) : null,
    code: row[11] || null,
    codeAccountEmail: row[12] || null,
    actionStatus: row[13] || null,
    actionMessage: row[14] || null,
    actionPayload: row[15] || null,
    actionResult: row[16] || null,
    queryPayload: row[17] || null,
    queryAt: row[18] || null,
    queryStatus: row[19] != null ? Number(row[19]) : null,
    notifyPayload: row[20] || null,
    notifyAt: row[21] || null,
    createdAt: row[22],
    updatedAt: row[23],
    paidAt: row[24] || null,
    refundedAt: row[25] || null,
    refundMessage: row[26] || null
  }
}

const resolveCreditOrderNoByTradeNo = (db, tradeNo) => {
  if (!db) return ''
  const normalized = String(tradeNo || '').trim()
  if (!normalized) return ''
  const result = db.exec(
    `
      SELECT order_no
      FROM credit_orders
      WHERE trade_no = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [normalized]
  )
  const row = result[0]?.values?.[0]
  return row?.[0] ? String(row[0]).trim() : ''
}

const persistCreditQueryResult = (db, orderNo, queryResult) => {
  if (!db || !orderNo) return
  const payload = queryResult?.ok ? queryResult.data : queryResult
  const queryStatus = queryResult?.ok ? Number(queryResult?.data?.status ?? null) : null
  db.run(
    `
      UPDATE credit_orders
      SET query_payload = ?,
          query_at = DATETIME('now', 'localtime'),
          query_status = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE order_no = ?
    `,
    [payload ? JSON.stringify(payload) : null, Number.isFinite(queryStatus) ? queryStatus : null, orderNo]
  )
}

const shouldSyncCreditOrder = (order, { force = false } = {}) => {
  if (!order) return false
  if (order.refundedAt || order.status === 'refunded') return false
  if (force) return true
  if (order.status === 'paid' || order.status === 'expired' || order.status === 'failed') return false
  const last = order.queryAt ? Date.parse(String(order.queryAt)) : 0
  const minIntervalMs = Math.max(2000, toInt(process.env.CREDIT_ORDER_QUERY_MIN_INTERVAL_MS, 8000))
  return !last || Number.isNaN(last) || Date.now() - last > minIntervalMs
}

const normalizeCreditDatetime = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return null
  return raw
}

const handlePaidCreditOrder = async (db, orderNo, { tradeNo, paidAt, notifyPayload, source }) => {
  await withLocks([`credit:${orderNo}`], async () => {
    const order = fetchCreditOrder(db, orderNo)
    if (!order) return

    if (order.refundedAt || order.status === 'refunded') {
      return
    }

    if (order.status !== 'paid') {
      const normalizedPaidAt = normalizeCreditDatetime(paidAt)
      db.run(
        `
          UPDATE credit_orders
          SET status = 'paid',
              paid_at = COALESCE(?, DATETIME('now', 'localtime')),
              trade_no = COALESCE(?, trade_no),
              notify_payload = COALESCE(?, notify_payload),
              notify_at = COALESCE(notify_at, DATETIME('now', 'localtime')),
              updated_at = DATETIME('now', 'localtime')
          WHERE order_no = ?
        `,
        [
          normalizedPaidAt,
          tradeNo || null,
          notifyPayload ? JSON.stringify({ source: source || 'notify', payload: notifyPayload }) : null,
          orderNo
        ]
      )
    } else if (notifyPayload || tradeNo) {
      db.run(
        `
          UPDATE credit_orders
          SET trade_no = COALESCE(?, trade_no),
              notify_payload = COALESCE(?, notify_payload),
              notify_at = COALESCE(notify_at, DATETIME('now', 'localtime')),
              updated_at = DATETIME('now', 'localtime')
          WHERE order_no = ?
        `,
        [
          tradeNo || null,
          notifyPayload ? JSON.stringify({ source: source || 'notify', payload: notifyPayload }) : null,
          orderNo
        ]
      )
    }

    saveDatabase()
  })
}

const syncCreditOrderStatusFromGateway = async (db, orderNo, { force = false } = {}) => {
  const order = fetchCreditOrder(db, orderNo)
  if (!order) return { ok: false, reason: 'not_found' }
  if (!shouldSyncCreditOrder(order, { force })) return { ok: true, skipped: true, order }

  let query = null
  if (order.tradeNo) {
    query = await queryCreditOrder({ tradeNo: order.tradeNo, outTradeNo: order.orderNo })
  } else {
    // 优先仅用 out_trade_no（我方订单号），避免 trade_no 不一致时影响查询结果
    const outTradeQuery = await queryCreditOrder({ tradeNo: '', outTradeNo: order.orderNo })
    if (outTradeQuery.ok) {
      query = outTradeQuery
    } else {
      const fallbackTradeNo = order.orderNo
      query = await queryCreditOrder({ tradeNo: fallbackTradeNo, outTradeNo: order.orderNo })
    }
  }
  try {
    persistCreditQueryResult(db, orderNo, query)
    saveDatabase()
  } catch (error) {
    console.warn('[Credit] persist query payload failed', { orderNo, message: error?.message || String(error) })
  }

  if (!query.ok) {
    return { ok: false, reason: query.error || 'query_failed' }
  }

  const data = query.data || {}
  const status = Number(data.status || 0)
  if (!Number.isFinite(status) || status !== 1) {
    return { ok: true, paid: false }
  }

  const notifyMoney = formatCreditMoney(data.money)
  const orderMoney = formatCreditMoney(order.amount)
  if (notifyMoney && orderMoney && notifyMoney !== orderMoney) {
    db.run(
      `UPDATE credit_orders SET refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
      [`money_mismatch:${notifyMoney}`, orderNo]
    )
    saveDatabase()
    return { ok: false, reason: 'money_mismatch' }
  }

  await handlePaidCreditOrder(db, orderNo, {
    tradeNo: data.trade_no || data.tradeNo || null,
    paidAt: data.endtime || null,
    notifyPayload: data,
    source: 'query'
  })

  return { ok: true, paid: true }
}

router.get('/orders/:orderNo', authenticateLinuxDoSession, async (req, res) => {
  const uid = normalizeUid(req.linuxdo?.uid)
  const orderNo = normalizeOrderNo(req.params.orderNo)
  if (!uid) return res.status(400).json({ error: '缺少 uid' })
  if (!orderNo) return res.status(400).json({ error: '缺少订单号' })

  try {
    const db = await getDatabase()
    let order = fetchCreditOrder(db, orderNo)
    if (!order) return res.status(404).json({ error: '订单不存在' })
    if (order.uid !== uid) return res.status(403).json({ error: '订单信息不匹配' })

    if (creditGatewayServerQueryEnabled() && (order.status === 'created' || order.status === 'pending_payment')) {
      try {
        await syncCreditOrderStatusFromGateway(db, orderNo)
        order = fetchCreditOrder(db, orderNo) || order
      } catch (error) {
        console.warn('[Credit] sync order status failed', { orderNo, message: error?.message || String(error) })
      }
    }

    res.json({
      order: {
        orderNo: order.orderNo,
        tradeNo: order.tradeNo,
        scene: order.scene,
        title: order.title,
        amount: order.amount,
        status: order.status,
        payUrl: order.payUrl,
        targetAccountId: order.targetAccountId,
        actionStatus: order.actionStatus,
        actionMessage: order.actionMessage,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        refundedAt: order.refundedAt,
        refundMessage: order.refundMessage
      }
    })
  } catch (error) {
    console.error('[Credit] get order error:', error)
    res.status(500).json({ error: '查询失败，请稍后再试' })
  }
})

router.get('/admin/orders', async (req, res) => {
  try {
    const db = await getDatabase()
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 15))
    const search = (req.query.search || '').trim().toLowerCase()
    const status = req.query.status // 'created' | 'pending_payment' | 'paid' | 'refunded' | 'expired' | 'failed' | undefined

    // 构建 WHERE 条件
    const conditions = []
    const params = []

    if (search) {
      conditions.push(`(LOWER(order_no) LIKE ? OR LOWER(uid) LIKE ? OR LOWER(username) LIKE ? OR LOWER(title) LIKE ?)`)
      const searchPattern = `%${search}%`
      params.push(searchPattern, searchPattern, searchPattern, searchPattern)
    }

    if (status && status !== 'all') {
      conditions.push('status = ?')
      params.push(status)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // 查询总数
    const countResult = db.exec(`SELECT COUNT(*) FROM credit_orders ${whereClause}`, params)
    const total = countResult[0]?.values?.[0]?.[0] || 0

    // 查询分页数据
    const offset = (page - 1) * pageSize
    const result = db.exec(
      `
        SELECT order_no, uid, username, scene, title, amount, status, target_account_id, created_at, paid_at, refunded_at
        FROM credit_orders
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    )
    const rows = result[0]?.values || []
    res.json({
      orders: rows.map(row => ({
        orderNo: row[0],
        uid: row[1],
        username: row[2] || null,
        scene: row[3],
        title: row[4],
        amount: row[5],
        status: row[6],
        targetAccountId: row[7] != null ? Number(row[7]) : null,
        createdAt: row[8],
        paidAt: row[9] || null,
        refundedAt: row[10] || null
      })),
      pagination: { page, pageSize, total }
    })
  } catch (error) {
    console.error('[Credit] admin list error:', error)
    res.status(500).json({ error: '查询失败' })
  }
})

router.get('/admin/balance', async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec(
      `
        SELECT
          COALESCE(SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) ELSE 0 END), 0) AS paid_total,
          COALESCE(SUM(CASE WHEN status = 'refunded' THEN CAST(amount AS REAL) ELSE 0 END), 0) AS refunded_total
        FROM credit_orders
      `
    )
    const row = result[0]?.values?.[0] || [0, 0]
    const paidTotal = Number(row[0] || 0)
    const refundedTotal = Number(row[1] || 0)
    res.json({
      paidTotal: paidTotal.toFixed(2),
      refundedTotal: refundedTotal.toFixed(2),
      netTotal: (paidTotal - refundedTotal).toFixed(2)
    })
  } catch (error) {
    console.error('[Credit] admin balance error:', error)
    res.status(500).json({ error: '查询失败' })
  }
})

router.post('/admin/orders/:orderNo/refund', async (req, res) => {
  const orderNo = normalizeOrderNo(req.params.orderNo)
  if (!orderNo) return res.status(400).json({ error: '缺少订单号' })

  if (!creditRefundEnabled()) {
    return res.status(400).json({ error: '已禁用 Credit 服务端退款，请联系管理员' })
  }

  const { pid, key } = await getCreditGatewayConfig()
  if (!pid || !key) {
    return res.status(500).json({ error: 'Credit 未配置，请联系管理员' })
  }

  try {
    const db = await getDatabase()
    const result = await withLocks([`credit:${orderNo}`], async () => {
      const order = fetchCreditOrder(db, orderNo)
      if (!order) return { ok: false, status: 404, error: '订单不存在' }
      if (order.refundedAt || order.status === 'refunded') return { ok: false, status: 400, error: '订单已退款' }
      if (order.status !== 'paid') return { ok: false, status: 400, error: '订单未完成，无法退款' }

      const tradeNo = String(order.tradeNo || '').trim()
      if (!tradeNo) return { ok: false, status: 400, error: '缺少 trade_no，无法退款' }

      const money = formatCreditMoney(order.amount)
      if (!money) return { ok: false, status: 400, error: '订单金额异常，无法退款' }

      console.info('[Credit] admin refund start', { orderNo, tradeNo, amount: money })
      const refundResult = await refundCreditOrder({ tradeNo, outTradeNo: orderNo, money })

      if (!refundResult.ok) {
        const msg =
          refundResult.error === 'missing_config'
            ? 'Credit 未配置，请联系管理员'
            : refundResult.error === 'missing_trade_no'
              ? '缺少 trade_no，无法退款'
              : refundResult.error === 'invalid_money'
                ? '退款金额异常'
                : refundResult.error === 'cf_challenge'
                  ? 'Credit 平台启用 Cloudflare challenge，服务端无法执行退款，请放行服务器 IP 或在平台后台手动退款'
                  : refundResult.error?.startsWith('http_')
                    ? `Credit 通道异常（HTTP ${refundResult.error.slice(5)}）`
                    : refundResult.msg
                      ? String(refundResult.msg)
                      : refundResult.message
                        ? String(refundResult.message)
                        : '退款失败'

        console.warn('[Credit] admin refund failed', { orderNo, tradeNo, error: refundResult.error, message: msg })
        db.run(
          `UPDATE credit_orders SET refund_message = ?, updated_at = DATETIME('now', 'localtime') WHERE order_no = ?`,
          [String(msg), orderNo]
        )
        saveDatabase()
        return { ok: false, status: 502, error: msg }
      }

      const successMsg = refundResult?.data?.msg ? String(refundResult.data.msg) : '退款成功'
      db.run(
        `
          UPDATE credit_orders
          SET status = 'refunded',
              refunded_at = DATETIME('now', 'localtime'),
              refund_message = ?,
              updated_at = DATETIME('now', 'localtime')
          WHERE order_no = ?
        `,
        [successMsg, orderNo]
      )
      saveDatabase()
      console.info('[Credit] admin refund succeeded', { orderNo, tradeNo, message: successMsg })
      return { ok: true, message: successMsg }
    })

    if (!result.ok) return res.status(result.status || 400).json({ error: result.error })
    res.json({ message: result.message })
  } catch (error) {
    console.error('[Credit] admin refund error:', error)
    res.status(500).json({ error: '退款失败' })
  }
})

router.post('/admin/orders/:orderNo/sync', async (req, res) => {
  const orderNo = normalizeOrderNo(req.params.orderNo)
  if (!orderNo) return res.status(400).json({ error: '缺少订单号' })

  if (!creditGatewayServerQueryEnabled()) {
    return res.status(400).json({ error: '已禁用 Credit 服务端查单，请联系管理员' })
  }

  const { pid, key } = await getCreditGatewayConfig()
  if (!pid || !key) {
    return res.status(500).json({ error: 'Credit 未配置，请联系管理员' })
  }

  try {
    const db = await getDatabase()
    const result = await withLocks([`credit:${orderNo}`], async () => {
      const order = fetchCreditOrder(db, orderNo)
      if (!order) return { ok: false, status: 404, error: '订单不存在' }
      if (order.refundedAt || order.status === 'refunded') return { ok: false, status: 400, error: '订单已退款，无法更新' }

      const syncResult = await syncCreditOrderStatusFromGateway(db, orderNo, { force: true })
      const updated = fetchCreditOrder(db, orderNo) || order

      if (!syncResult.ok) {
        const msg =
          syncResult.reason === 'money_mismatch'
            ? '订单金额不一致，请人工核对'
            : syncResult.reason === 'not_found'
              ? 'Credit 未找到该订单'
              : '同步失败'
        return { ok: false, status: 502, error: msg }
      }

      const message = syncResult.skipped
        ? '无需更新'
        : syncResult.paid
          ? '已更新为已完成'
          : '订单未完成'

      return {
        ok: true,
        message,
        order: {
          orderNo: updated.orderNo,
          status: updated.status,
          tradeNo: updated.tradeNo,
          paidAt: updated.paidAt,
          refundedAt: updated.refundedAt
        }
      }
    })

    if (!result.ok) return res.status(result.status || 400).json({ error: result.error })
    res.json({ message: result.message, order: result.order })
  } catch (error) {
    console.error('[Credit] admin sync error:', error)
    res.status(500).json({ error: '同步失败' })
  }
})

const processCreditNotify = async (orderNo, payload) => {
  const startedAt = Date.now()
  try {
    console.info('[Credit] notify async received', { orderNo, payload: summarizeCreditNotifyPayload(payload) })
    const db = await getDatabase()
    const order = fetchCreditOrder(db, orderNo)
    if (!order) {
      console.warn('[Credit] notify async order not found', { orderNo })
      return
    }

    console.info('[Credit] notify async order loaded', {
      orderNo,
      status: order.status,
      amount: order.amount,
      paidAt: order.paidAt,
      refundedAt: order.refundedAt,
      tradeNo: order.tradeNo
    })

    const notifyMoney = formatCreditMoney(payload.money)
    const orderMoney = formatCreditMoney(order.amount)
    if (notifyMoney && orderMoney && notifyMoney !== orderMoney) {
      console.warn('[Credit] notify money mismatch', { orderNo, notifyMoney, orderMoney })
      db.run(
        `
          UPDATE credit_orders
          SET notify_payload = ?,
              refund_message = ?,
              notify_at = DATETIME('now', 'localtime'),
              updated_at = DATETIME('now', 'localtime')
          WHERE order_no = ?
        `,
        [JSON.stringify(payload), `money_mismatch:${notifyMoney}`, orderNo]
      )
      saveDatabase()
      return
    }

    await handlePaidCreditOrder(db, orderNo, {
      tradeNo: payload.trade_no || null,
      paidAt: null,
      notifyPayload: payload,
      source: 'notify'
    })

    const updated = fetchCreditOrder(db, orderNo)
    console.info('[Credit] notify async handled', {
      orderNo,
      beforeStatus: order.status,
      afterStatus: updated?.status || null,
      paidAt: updated?.paidAt || null,
      durationMs: Date.now() - startedAt
    })
  } catch (error) {
    console.error('[Credit] notify async error:', { orderNo, message: error?.message || String(error) })
  }
}

router.all('/notify', async (req, res) => {
  const payload = { ...(req.query || {}), ...(req.body || {}) }
  const outTradeNo = String(payload.out_trade_no || '').trim()
  const tradeNo = String(payload.trade_no || '').trim()
  const orderNo = outTradeNo || String(payload.order_no || '').trim()
  const ip = getClientIp(req)
  const summary = summarizeCreditNotifyPayload(payload)
  const ua = safeSnippet(req.headers['user-agent'] || '', 180)
  const originalUrl = safeSnippet(req.originalUrl || '', 420)
  const referer = safeSnippet(req.headers.referer || req.headers.referrer || '', 180)

  console.info('[Credit] notify received', {
    method: req.method,
    path: req.path,
    ip,
    orderNo: orderNo || summary.outTradeNo || '',
    tradeNo: tradeNo || summary.tradeNo || '',
    ua: ua || null,
    referer: referer || null,
    url: originalUrl || null,
    queryKeys: Object.keys(req.query || {}).length,
    bodyKeys: Object.keys(req.body || {}).length,
    payload: summary
  })

  const replySuccess = () => res.set('Content-Type', 'text/plain; charset=utf-8').status(200).end('success')
  const replyFail = () => res.set('Content-Type', 'text/plain; charset=utf-8').status(200).end('fail')

  if (!orderNo && !tradeNo) {
    console.warn('[Credit] notify missing orderNo', { method: req.method, ip, payload: summary })
    replySuccess()
    return
  }

  const { pid, key } = await getCreditGatewayConfig()
  const signature = String(payload.sign || '').trim().toLowerCase()

  if (!pid || !key) {
    console.warn('[Credit] notify missing config', { orderNo, method: req.method, ip, hasPid: Boolean(pid), hasKey: Boolean(key) })
    replyFail()
    return
  }

  if (String(payload.pid || '').trim() !== pid) {
    console.warn('[Credit] notify pid mismatch', { orderNo, method: req.method, ip, providedPid: String(payload.pid || '').trim() })
    replyFail()
    return
  }

  const expected = buildCreditSign(payload, key).toLowerCase()
  if (!signature || signature !== expected) {
    console.warn('[Credit] notify sign mismatch', {
      orderNo,
      method: req.method,
      ip,
      signType: String(payload.sign_type || '').trim() || null,
      hasSignature: Boolean(signature),
      signatureLength: signature.length || 0,
      signaturePrefix: signature ? signature.slice(0, 8) : null,
      expectedPrefix: expected ? expected.slice(0, 8) : null
    })
    replyFail()
    return
  }

  const tradeStatus = String(payload.trade_status || '').trim()
  if (tradeStatus !== 'TRADE_SUCCESS') {
    console.info('[Credit] notify trade not success', { orderNo, method: req.method, ip, tradeStatus })
    replySuccess()
    return
  }

  replySuccess()

  queueMicrotask(() => {
    console.info('[Credit] notify accepted', { orderNo: orderNo || '', tradeNo: tradeNo || '', method: req.method, ip, tradeStatus })
    void (async () => {
      let resolvedOrderNo = orderNo
      if (!resolvedOrderNo && tradeNo) {
        try {
          const db = await getDatabase()
          resolvedOrderNo = resolveCreditOrderNoByTradeNo(db, tradeNo)
          if (!resolvedOrderNo) {
            if (creditGatewayServerQueryEnabled()) {
              const query = await queryCreditOrder({ tradeNo, outTradeNo: '' })
              if (query.ok) {
                resolvedOrderNo = String(query?.data?.out_trade_no || query?.data?.outTradeNo || '').trim()
              } else {
                console.warn('[Credit] resolve order_no by trade_no failed', { tradeNo, error: query.error || 'query_failed', message: query.message || query.msg || null })
              }
            } else {
              console.warn('[Credit] resolve order_no by trade_no skipped (server query disabled)', { tradeNo })
            }
          }
        } catch (error) {
          console.warn('[Credit] resolve order_no by trade_no failed', { tradeNo, message: error?.message || String(error) })
        }
      }
      if (!resolvedOrderNo) {
        console.warn('[Credit] notify order not resolved', { orderNo: orderNo || '', tradeNo: tradeNo || '' })
        return
      }
      await processCreditNotify(resolvedOrderNo, payload)
    })()
  })
})

export default router
