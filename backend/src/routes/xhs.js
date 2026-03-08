import express from 'express'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu } from '../middleware/rbac.js'
import { getDatabase } from '../database/init.js'
import {
  getXhsConfig,
  updateXhsConfig,
  importXhsOrders,
  getXhsOrderStats,
  getXhsOrders,
  getXhsOrderByNumber,
  markXhsOrderRedeemed,
  recordXhsSyncResult,
  clearXhsOrders,
  deleteXhsOrder,
  queryXhsOrdersFromApi,
  transformXhsApiOrder,
  syncOrdersFromApi,
  parseCurlCommand,
} from '../services/xhs-orders.js'
import { isXhsSyncing, runXhsOrderSync, setXhsSyncing } from '../services/xhs-sync-runner.js'
import { sendTelegramBotNotification } from '../services/telegram-notifier.js'
import { requireFeatureEnabled } from '../middleware/feature-flags.js'

const router = express.Router()
let lastSyncResult = null

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

const extractEmailFromRedeemedBy = (redeemedBy) => {
  const raw = String(redeemedBy ?? '').trim()
  if (!raw) return ''

  const match = raw.match(/email\s*:\s*([^|]+)(?:\||$)/i)
  if (match?.[1]) {
    const extracted = String(match[1]).trim()
    return EMAIL_REGEX.test(extracted) ? extracted.toLowerCase() : ''
  }

  return EMAIL_REGEX.test(raw) ? raw.toLowerCase() : ''
}

router.use(requireFeatureEnabled('xhs'))

router.use(authenticateToken, requireMenu('xhs_orders'))

router.get('/config', async (req, res) => {
  try {
    const config = await getXhsConfig()
    if (!config) {
      return res.json({ config: null })
    }
    const sanitizedConfig = {
      ...config,
      cookies: undefined,
      authorization: undefined,
      cookiesConfigured: Boolean(config.cookies),
      authorizationConfigured: Boolean(config.authorization),
    }
    res.json({ config: sanitizedConfig })
  } catch (error) {
    console.error('[XHS Config] 获取配置失败:', error)
    res.status(500).json({ error: '获取配置失败' })
  }
})

router.post('/config', async (req, res) => {
  try {
    const { curlCommand, cookies, authorization, extraHeaders, syncEnabled, syncIntervalHours } = req.body || {}

    let finalCookies = cookies
    let finalAuthorization = authorization
    let finalExtraHeaders = extraHeaders

    // 如果提供了 curl 命令，从中解析所有配置
    if (curlCommand) {
      const parsed = parseCurlCommand(curlCommand)
      console.log('[XHS Config] 从 curl 命令解析到的请求头:', Object.keys(parsed.headers).join(', '))

      // 从 curl 解析的值
      if (parsed.cookies) {
        finalCookies = parsed.cookies
      }
      if (parsed.headers['authorization']) {
        finalAuthorization = parsed.headers['authorization']
      }

      // 提取签名相关的头
      const signHeaders = ['x-s', 'x-s-common', 'x-t', 'x-b3-traceid']
      const extractedHeaders = {}
      for (const key of signHeaders) {
        if (parsed.headers[key]) {
          extractedHeaders[key] = parsed.headers[key]
        }
      }
      if (Object.keys(extractedHeaders).length > 0) {
        finalExtraHeaders = extractedHeaders
      }
    }

    const updated = await updateXhsConfig({
      cookies: finalCookies,
      authorization: finalAuthorization,
      extraHeaders: finalExtraHeaders,
      syncEnabled,
      syncIntervalHours,
    })

    res.json({
      message: curlCommand ? '已从 curl 命令解析并保存配置' : '配置已更新',
      config: {
        ...updated,
        cookies: undefined,
        authorization: undefined,
        extraHeaders: undefined,
        cookiesConfigured: Boolean(updated?.cookies),
        authorizationConfigured: Boolean(updated?.authorization),
        extraHeadersConfigured: Boolean(updated?.extraHeaders),
      },
    })
  } catch (error) {
    console.error('[XHS Config] 更新配置失败:', error)
    res.status(500).json({ error: '配置更新失败' })
  }
})

router.post('/sync', async (req, res) => {
  if (isXhsSyncing()) {
    return res.status(409).json({ error: '同步任务正在运行，请稍后再试' })
  }

  const searchOrder = (req.body?.searchOrder || '').trim() || null
  const startedAt = new Date().toISOString()
  const source = searchOrder ? 'search' : 'auto'

  try {
    const config = await getXhsConfig()
    if (!config || !config.cookiesConfigured) {
      return res.status(400).json({ error: '请先在配置中粘贴有效的 Cookie JSON' })
    }

    if (isXhsSyncing()) {
      return res.status(409).json({ error: '同步任务正在运行，请稍后再试' })
    }

    const pythonResult = await runXhsOrderSync({
      maxScrolls: req.body?.maxScrolls,
      scrollPause: req.body?.scrollPause,
      searchOrder
    })

    if (!pythonResult.success) {
      throw new Error(pythonResult.error || '同步脚本执行失败')
    }

    const ordersFromScript = Array.isArray(pythonResult.orders) ? pythonResult.orders : []
    const importResult = await importXhsOrders(ordersFromScript)

    await recordXhsSyncResult({ success: true })
    lastSyncResult = {
      success: true,
      source,
      ...importResult,
      startedAt,
      finishedAt: new Date().toISOString(),
    }

    const message = searchOrder
      ? `搜索同步完成，新增 ${importResult.created || 0} 个订单`
      : `自动同步完成，新增 ${importResult.created || 0} 个订单`

    await sendTelegramBotNotification(
      [
        '✅ 小红书订单同步完成',
        source === 'search' ? `订单号：${searchOrder}` : null,
        `新增：${importResult.created || 0}`,
        `跳过：${importResult.skipped || 0}`,
        `总计：${importResult.total || 0}`,
      ].filter(Boolean).join('\n')
    ).catch(() => {})

    res.json({
      message,
      result: {
        ...importResult,
        orders: ordersFromScript.length
      },
    })
  } catch (error) {
    if (error?.code === 'XHS_SYNC_IN_PROGRESS') {
      return res.status(409).json({ error: '同步任务正在运行，请稍后再试' })
    }
    console.error('[XHS Sync] 同步失败:', error)
    await recordXhsSyncResult({ success: false, error: error.message })
    lastSyncResult = {
      success: false,
      error: error.message,
      source,
      startedAt,
      finishedAt: new Date().toISOString(),
    }

    await sendTelegramBotNotification(
      [
        '❌ 小红书订单同步失败',
        source === 'search' ? `订单号：${searchOrder}` : null,
        `原因：${error?.message || '未知错误'}`
      ].filter(Boolean).join('\n')
    ).catch(() => {})

    res.status(500).json({ error: '同步失败，请检查 Cookie 是否有效' })
  } finally {
    // no-op, runXhsOrderSync handles sync lock lifecycle
  }
})

router.get('/status', async (req, res) => {
  try {
    const config = await getXhsConfig()
    const stats = await getXhsOrderStats()
    res.json({
      status: {
        cookiesConfigured: Boolean(config?.cookies),
        lastSyncAt: config?.lastSyncAt || null,
        lastSuccessAt: config?.lastSuccessAt || null,
        lastError: config?.lastError || null,
        errorCount: config?.errorCount || 0,
        syncEnabled: config?.syncEnabled ?? false,
        syncIntervalHours: config?.syncIntervalHours ?? 6,
        isSyncing: isXhsSyncing(),
        lastSyncResult,
      },
      stats,
    })
  } catch (error) {
    console.error('[XHS Status] 获取状态失败:', error)
    res.status(500).json({ error: '获取状态失败' })
  }
})

router.get('/orders', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100
    const offset = Number(req.query.offset) || 0
    const orders = await getXhsOrders({ limit, offset })
    const stats = await getXhsOrderStats()
    res.json({ orders, stats })
  } catch (error) {
    console.error('[XHS Orders] 获取订单失败:', error)
    res.status(500).json({ error: '获取订单列表失败' })
  }
})

router.post('/orders/:id/bind-code', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: '无效的订单ID' })
    }

    const sanitizedCode = String(req.body?.code ?? '').trim().toUpperCase()
    if (!sanitizedCode) {
      return res.status(400).json({ error: '请输入兑换码' })
    }

    const db = await getDatabase()
    const orderRow = db.exec(
      `
        SELECT id, order_number, COALESCE(is_used, 0) AS is_used, user_email
        FROM xhs_orders
        WHERE id = ?
        LIMIT 1
      `,
      [id]
    )[0]?.values?.[0]

    if (!orderRow) {
      return res.status(404).json({ error: '订单不存在' })
    }

    const orderNumber = String(orderRow[1] || '')
    const isUsed = Number(orderRow[2] || 0) === 1
    const existingOrderEmail = normalizeEmail(orderRow[3])
    if (isUsed) {
      return res.status(409).json({ error: '该订单已核销' })
    }

    const codeRow = db.exec(
      `
        SELECT id, code, is_redeemed, redeemed_by
        FROM redemption_codes
        WHERE upper(code) = ?
        LIMIT 1
      `,
      [sanitizedCode]
    )[0]?.values?.[0]

    if (!codeRow) {
      return res.status(404).json({ error: '兑换码不存在' })
    }

    const codeId = Number(codeRow[0])
    const isRedeemed = Number(codeRow[2] || 0) === 1
    const redeemedBy = codeRow[3]
    if (!isRedeemed) {
      return res.status(409).json({ error: '该兑换码尚未使用，无法绑定' })
    }

    let resolvedEmail = normalizeEmail(req.body?.email)
    if (!resolvedEmail) resolvedEmail = extractEmailFromRedeemedBy(redeemedBy)
    if (!resolvedEmail) resolvedEmail = existingOrderEmail
    if (!resolvedEmail || !EMAIL_REGEX.test(resolvedEmail)) {
      return res.status(400).json({ error: '缺少有效邮箱，无法绑定' })
    }

    const boundXhs = db.exec(
      `
        SELECT id, order_number
        FROM xhs_orders
        WHERE assigned_code_id = ?
          AND id != ?
        LIMIT 1
      `,
      [codeId, id]
    )[0]?.values?.[0]
    if (boundXhs) {
      return res.status(409).json({
        error: '该兑换码已绑定其他订单',
        existing: { channel: 'xhs', id: Number(boundXhs[0]), orderNumber: String(boundXhs[1] || '') }
      })
    }

    const boundXianyu = db.exec(
      `
        SELECT id, order_id
        FROM xianyu_orders
        WHERE assigned_code_id = ?
        LIMIT 1
      `,
      [codeId]
    )[0]?.values?.[0]
    if (boundXianyu) {
      return res.status(409).json({
        error: '该兑换码已绑定其他订单',
        existing: { channel: 'xianyu', id: Number(boundXianyu[0]), orderId: String(boundXianyu[1] || '') }
      })
    }

    await markXhsOrderRedeemed(id, codeId, sanitizedCode, resolvedEmail)

    const updatedOrder = await getXhsOrderByNumber(orderNumber)
    return res.json({ message: '绑定成功', order: updatedOrder })
  } catch (error) {
    console.error('[XHS Orders] 绑定兑换码失败:', error)
    res.status(500).json({ error: '绑定失败，请稍后再试' })
  }
})

router.post('/orders/clear', async (req, res) => {
  try {
    const result = await clearXhsOrders()
    lastSyncResult = null
    res.json({ message: `已删除 ${result.cleared} 条订单`, cleared: result.cleared })
  } catch (error) {
    console.error('[XHS Orders] 清理订单失败:', error)
    res.status(500).json({ error: '清理订单失败，请稍后再试' })
  }
})

router.delete('/orders/:id', async (req, res) => {
  try {
    const id = Number(req.params.id)
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: '无效的订单ID' })
    }
    const result = await deleteXhsOrder(id)
    if (!result.deleted) {
      return res.status(404).json({ error: result.reason || '订单不存在' })
    }
    res.json({ message: '订单已删除' })
  } catch (error) {
    console.error('[XHS Orders] 删除订单失败:', error)
    res.status(500).json({ error: '删除订单失败，请稍后再试' })
  }
})

// 从小红书API查询订单（代理接口）
router.post('/api-query', async (req, res) => {
  try {
    const {
      authorization,
      cookies,
      searchKeyword,
      pageNo,
      pageSize,
      startTime,
      endTime,
    } = req.body || {}

    if (!authorization) {
      return res.status(400).json({ error: '缺少 authorization 参数' })
    }
    if (!cookies) {
      return res.status(400).json({ error: '缺少 cookies 参数' })
    }

    const apiResult = await queryXhsOrdersFromApi({
      authorization,
      cookies,
      searchKeyword: searchKeyword || '',
      pageNo: pageNo || 1,
      pageSize: pageSize || 20,
      startTime,
      endTime,
    })

    // 转换订单数据为简化格式
    const packages = apiResult.data?.packages || []
    const orders = packages.map(transformXhsApiOrder)

    res.json({
      success: true,
      data: {
        orders,
        total: apiResult.data?.total || 0,
        raw: apiResult.data, // 保留原始数据以便调试
      },
    })
  } catch (error) {
    console.error('[XHS API Query] 查询失败:', error)
    res.status(500).json({
      success: false,
      error: error.message || '查询小红书订单失败',
    })
  }
})

// 使用API分页同步所有订单
router.post('/api-sync', async (req, res) => {
  if (isXhsSyncing()) {
    return res.status(409).json({ error: '同步任务正在运行，请稍后再试' })
  }

  const startedAt = new Date().toISOString()
  setXhsSyncing(true)

  try {
    const { searchKeyword, pageSize, maxPages, startTime, endTime } = req.body || {}

    // 从数据库读取配置
    const config = await getXhsConfig()

    if (!config?.authorization) {
      return res.status(400).json({ error: '请先在配置中设置 Authorization（推荐粘贴 curl 命令）' })
    }
    if (!config?.cookies) {
      return res.status(400).json({ error: '请先在配置中设置 Cookie（推荐粘贴 curl 命令）' })
    }

    const syncResult = await syncOrdersFromApi({
      authorization: config.authorization,
      cookies: config.cookies,
      extraHeaders: config.extraHeaders || {},
      searchKeyword: searchKeyword || '',
      pageSize: pageSize || 50,
      maxPages: maxPages || 100,
      startTime,
      endTime,
    })

    await recordXhsSyncResult({ success: true })

    lastSyncResult = {
      success: true,
      source: 'api',
      ...syncResult,
      startedAt,
      finishedAt: new Date().toISOString(),
    }

    res.json({
      message: `API同步完成，获取${syncResult.totalFetched}条订单，新增${syncResult.created}条，跳过${syncResult.skipped}条`,
      result: syncResult,
    })
  } catch (error) {
    console.error('[XHS API Sync] 同步失败:', error)
    await recordXhsSyncResult({ success: false, error: error.message })

    lastSyncResult = {
      success: false,
      error: error.message,
      source: 'api',
      startedAt,
      finishedAt: new Date().toISOString(),
    }

    res.status(500).json({
      success: false,
      error: error.message || 'API同步失败',
    })
  } finally {
    setXhsSyncing(false)
  }
})

export default router
