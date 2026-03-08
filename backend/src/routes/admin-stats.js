import express from 'express'
import { getDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/rbac.js'
import { SPACE_MEMBER_LIMIT } from '../utils/space-capacity.js'

const router = express.Router()

router.use(authenticateToken, requireSuperAdmin)

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/
const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const formatLocalDateOnly = (date) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const resolveDateRange = (query) => {
  const today = formatLocalDateOnly(new Date())
  const rawFrom = String(query?.from ?? '').trim()
  const rawTo = String(query?.to ?? '').trim()

  const from = DATE_ONLY_REGEX.test(rawFrom) ? rawFrom : today
  const to = DATE_ONLY_REGEX.test(rawTo) ? rawTo : today

  if (from > to) {
    return { ok: false, error: '`from` must be <= `to`' }
  }

  const maxDays = 366
  const maxDaysRaw = query?.maxDays
  const maxDaysLimit = Math.max(1, toInt(maxDaysRaw, maxDays))
  if (maxDaysLimit > 0) {
    const start = new Date(`${from}T00:00:00`)
    const end = new Date(`${to}T00:00:00`)
    const diffDays = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1
    if (diffDays > maxDaysLimit) {
      return { ok: false, error: `date range too large (max ${maxDaysLimit} days)` }
    }
  }

  return { ok: true, from, to }
}

const ACCOUNT_CAPACITY = SPACE_MEMBER_LIMIT

router.get('/overview', async (req, res) => {
  const range = resolveDateRange(req.query)
  if (!range.ok) {
    return res.status(400).json({ error: range.error })
  }

  try {
    const db = await getDatabase()
    const { from, to } = range

    const scalar = (sql, params = []) => {
      const result = db.exec(sql, params)
      const value = result?.[0]?.values?.[0]?.[0]
      return value == null ? 0 : Number(value)
    }

    const sumAmount = (sql, params = []) => {
      const value = scalar(sql, params)
      return Number.isFinite(value) ? value : 0
    }

    const usersTotal = scalar('SELECT COUNT(*) FROM users')
    const usersNew = scalar(
      `SELECT COUNT(*) FROM users WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
      [from, to]
    )
    const usersPointsTotal = scalar(`SELECT COALESCE(SUM(COALESCE(points, 0)), 0) FROM users`)
    const usersInviteEnabled = scalar(`SELECT COUNT(*) FROM users WHERE COALESCE(invite_enabled, 0) != 0`)

    const gptAccountsTotal = scalar('SELECT COUNT(*) FROM gpt_accounts')
    const gptAccountsOpen = scalar(`SELECT COUNT(*) FROM gpt_accounts WHERE COALESCE(is_open, 0) = 1`)
    const gptAccountsUsedSeats = scalar(`SELECT COALESCE(SUM(COALESCE(user_count, 0)), 0) FROM gpt_accounts`)
    const gptAccountsInvitePending = scalar(`SELECT COALESCE(SUM(COALESCE(invite_count, 0)), 0) FROM gpt_accounts`)
    const gptAccountsTotalSeats = gptAccountsTotal * ACCOUNT_CAPACITY
    const gptAccountsSeatUtilization = gptAccountsTotalSeats > 0 ? gptAccountsUsedSeats / gptAccountsTotalSeats : 0

    const codesTotal = scalar('SELECT COUNT(*) FROM redemption_codes')
    const codesUnused = scalar(`SELECT COUNT(*) FROM redemption_codes WHERE COALESCE(is_redeemed, 0) = 0`)

    const xhsCodesTodayTotal = scalar(
      `
        SELECT COUNT(*)
        FROM redemption_codes
        WHERE channel = 'xhs'
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const xhsCodesTodayUnused = scalar(
      `
        SELECT COUNT(*)
        FROM redemption_codes
        WHERE channel = 'xhs'
          AND COALESCE(is_redeemed, 0) = 0
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const xianyuCodesTodayTotal = scalar(
      `
        SELECT COUNT(*)
        FROM redemption_codes
        WHERE channel = 'xianyu'
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const xianyuCodesTodayUnused = scalar(
      `
        SELECT COUNT(*)
        FROM redemption_codes
        WHERE channel = 'xianyu'
          AND COALESCE(is_redeemed, 0) = 0
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const commonCodesTodayTotal = scalar(
      `
        SELECT COUNT(*)
        FROM redemption_codes
        WHERE COALESCE(NULLIF(TRIM(channel), ''), 'common') = 'common'
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const commonCodesTodayUnused = scalar(
      `
        SELECT COUNT(*)
        FROM redemption_codes
        WHERE COALESCE(NULLIF(TRIM(channel), ''), 'common') = 'common'
          AND COALESCE(is_redeemed, 0) = 0
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )

    const codesByChannelResult = db.exec(
      `
        SELECT
          COALESCE(channel, 'common') as channel,
          COUNT(*) as total,
          SUM(CASE WHEN COALESCE(is_redeemed, 0) = 0 THEN 1 ELSE 0 END) as unused
        FROM redemption_codes
        GROUP BY COALESCE(channel, 'common')
        ORDER BY total DESC
      `
    )
    const codesByChannel = (codesByChannelResult?.[0]?.values || []).map(row => ({
      channel: String(row[0] || 'common'),
      total: Number(row[1] || 0),
      unused: Number(row[2] || 0),
    }))

    const xhsOrdersTotal = scalar('SELECT COUNT(*) FROM xhs_orders')
    const xhsOrdersUsed = scalar(`SELECT COUNT(*) FROM xhs_orders WHERE COALESCE(is_used, 0) = 1`)
    const xhsOrdersPending = Math.max(0, xhsOrdersTotal - xhsOrdersUsed)
    const xhsOrdersTodayTotal = scalar(
      `
        SELECT COUNT(*)
        FROM xhs_orders
        WHERE DATE(REPLACE(COALESCE(NULLIF(TRIM(order_time), ''), created_at), '/', '-')) = DATE('now', 'localtime')
      `
    )
	    const xhsOrdersTodayUsed = scalar(
	      `
	        SELECT COUNT(*)
	        FROM xhs_orders
	        WHERE COALESCE(is_used, 0) = 1
	          AND DATE(REPLACE(COALESCE(NULLIF(TRIM(order_time), ''), created_at), '/', '-')) = DATE('now', 'localtime')
	      `
	    )
	    const xhsOrdersTodayPending = Math.max(0, xhsOrdersTodayTotal - xhsOrdersTodayUsed)
	    const xhsOrdersAmountRange = sumAmount(
	      `
	        SELECT COALESCE(SUM(COALESCE(actual_paid, 0)), 0)
	        FROM xhs_orders
	        WHERE COALESCE(order_status, '') != '已关闭'
	          AND DATE(REPLACE(COALESCE(NULLIF(TRIM(order_time), ''), created_at), '/', '-')) BETWEEN DATE(?) AND DATE(?)
	      `,
	      [from, to]
	    )
    const xhsOrdersAmountToday = sumAmount(
      `
	        SELECT COALESCE(SUM(COALESCE(actual_paid, 0)), 0)
	        FROM xhs_orders
	        WHERE COALESCE(order_status, '') != '已关闭'
	          AND DATE(REPLACE(COALESCE(NULLIF(TRIM(order_time), ''), created_at), '/', '-')) = DATE('now', 'localtime')
	      `
	    )

    const xianyuOrdersTotal = scalar('SELECT COUNT(*) FROM xianyu_orders')
    const xianyuOrdersUsed = scalar(`SELECT COUNT(*) FROM xianyu_orders WHERE COALESCE(is_used, 0) = 1`)
    const xianyuOrdersPending = Math.max(0, xianyuOrdersTotal - xianyuOrdersUsed)
    const xianyuOrdersTodayTotal = scalar(
      `
        SELECT COUNT(*)
        FROM xianyu_orders
        WHERE DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const xianyuOrdersTodayUsed = scalar(
      `
        SELECT COUNT(*)
        FROM xianyu_orders
        WHERE COALESCE(is_used, 0) = 1
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const xianyuOrdersTodayPending = Math.max(0, xianyuOrdersTodayTotal - xianyuOrdersTodayUsed)
    const xianyuOrdersAmountRange = sumAmount(
      `
        SELECT COALESCE(SUM(COALESCE(actual_paid, 0)), 0)
        FROM xianyu_orders
        WHERE COALESCE(order_status, '') NOT LIKE '%关闭%'
          AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      `,
      [from, to]
    )
    const xianyuOrdersAmountToday = sumAmount(
      `
        SELECT COALESCE(SUM(COALESCE(actual_paid, 0)), 0)
        FROM xianyu_orders
        WHERE COALESCE(order_status, '') NOT LIKE '%关闭%'
          AND DATE(created_at) = DATE('now', 'localtime')
      `
    )

	    const purchaseOrdersTotal = scalar(
	      `SELECT COUNT(*) FROM purchase_orders WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
	      [from, to]
    )
    const purchaseOrdersPaid = scalar(
      `SELECT COUNT(*) FROM purchase_orders WHERE status = 'paid' AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
      [from, to]
    )
    const purchaseOrdersPending = scalar(
      `SELECT COUNT(*) FROM purchase_orders WHERE status IN ('created', 'pending_payment') AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
      [from, to]
    )
    const purchaseOrdersRefunded = scalar(
      `SELECT COUNT(*) FROM purchase_orders WHERE status = 'refunded' AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
      [from, to]
    )
    const purchaseOrdersPaidAmount = sumAmount(
      `
        SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) ELSE 0 END), 0)
        FROM purchase_orders
        WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      `,
      [from, to]
    )
    const purchaseOrdersRefundAmount = sumAmount(
      `
        SELECT COALESCE(SUM(CASE WHEN status = 'refunded' THEN CAST(COALESCE(refund_amount, amount) AS REAL) ELSE 0 END), 0)
        FROM purchase_orders
        WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      `,
      [from, to]
    )

    const purchaseOrdersTodayTotal = scalar(
      `SELECT COUNT(*) FROM purchase_orders WHERE DATE(created_at) = DATE('now', 'localtime')`
    )
    const purchaseOrdersTodayPaid = scalar(
      `SELECT COUNT(*) FROM purchase_orders WHERE status = 'paid' AND DATE(created_at) = DATE('now', 'localtime')`
    )
    const purchaseOrdersTodayPending = scalar(
      `SELECT COUNT(*) FROM purchase_orders WHERE status IN ('created', 'pending_payment') AND DATE(created_at) = DATE('now', 'localtime')`
    )
    const purchaseOrdersTodayRefunded = scalar(
      `SELECT COUNT(*) FROM purchase_orders WHERE status = 'refunded' AND DATE(created_at) = DATE('now', 'localtime')`
    )
    const purchaseOrdersTodayPaidAmount = sumAmount(
      `
        SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) ELSE 0 END), 0)
        FROM purchase_orders
        WHERE DATE(created_at) = DATE('now', 'localtime')
      `
    )
    const purchaseOrdersTodayRefundAmount = sumAmount(
      `
        SELECT COALESCE(SUM(CASE WHEN status = 'refunded' THEN CAST(COALESCE(refund_amount, amount) AS REAL) ELSE 0 END), 0)
        FROM purchase_orders
        WHERE DATE(created_at) = DATE('now', 'localtime')
      `
    )

    const creditOrdersTotal = scalar(
      `SELECT COUNT(*) FROM credit_orders WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
      [from, to]
    )
    const creditOrdersPaid = scalar(
      `SELECT COUNT(*) FROM credit_orders WHERE status = 'paid' AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
      [from, to]
    )
    const creditOrdersRefunded = scalar(
      `SELECT COUNT(*) FROM credit_orders WHERE status = 'refunded' AND DATE(created_at) BETWEEN DATE(?) AND DATE(?)`,
      [from, to]
    )
    const creditOrdersPaidAmount = sumAmount(
      `
        SELECT COALESCE(SUM(CASE WHEN status = 'paid' THEN CAST(amount AS REAL) ELSE 0 END), 0)
        FROM credit_orders
        WHERE DATE(created_at) BETWEEN DATE(?) AND DATE(?)
      `,
      [from, to]
    )

    const pointsWithdrawalsPending = scalar(
      `SELECT COUNT(*) FROM points_withdrawals WHERE status = 'pending'`
    )
    const pointsWithdrawalsPendingPoints = scalar(
      `SELECT COALESCE(SUM(COALESCE(points, 0)), 0) FROM points_withdrawals WHERE status = 'pending'`
    )
    const pointsWithdrawalsPendingCash = sumAmount(
      `SELECT COALESCE(SUM(CAST(COALESCE(cash_amount, '0') AS REAL)), 0) FROM points_withdrawals WHERE status = 'pending'`
    )

    res.json({
      range: { from, to },
      users: {
        total: usersTotal,
        created: usersNew,
        pointsTotal: usersPointsTotal,
        inviteEnabled: usersInviteEnabled,
      },
      gptAccounts: {
        total: gptAccountsTotal,
        open: gptAccountsOpen,
        usedSeats: gptAccountsUsedSeats,
        totalSeats: gptAccountsTotalSeats,
        seatUtilization: gptAccountsSeatUtilization,
        invitePending: gptAccountsInvitePending,
      },
      redemptionCodes: {
        total: codesTotal,
        unused: codesUnused,
        byChannel: codesByChannel,
        todayCommon: {
          total: commonCodesTodayTotal,
          unused: commonCodesTodayUnused,
        },
        todayXhs: {
          total: xhsCodesTodayTotal,
          unused: xhsCodesTodayUnused,
        },
        todayXianyu: {
          total: xianyuCodesTodayTotal,
          unused: xianyuCodesTodayUnused,
        },
      },
	      xhsOrders: {
	        total: xhsOrdersTotal,
	        used: xhsOrdersUsed,
	        pending: xhsOrdersPending,
	        amount: {
	          range: xhsOrdersAmountRange,
	          today: xhsOrdersAmountToday,
	        },
	        today: {
	          total: xhsOrdersTodayTotal,
	          used: xhsOrdersTodayUsed,
	          pending: xhsOrdersTodayPending,
	        }
	      },
      xianyuOrders: {
        total: xianyuOrdersTotal,
        used: xianyuOrdersUsed,
        pending: xianyuOrdersPending,
        amount: {
          range: xianyuOrdersAmountRange,
          today: xianyuOrdersAmountToday,
        },
        today: {
          total: xianyuOrdersTodayTotal,
          used: xianyuOrdersTodayUsed,
          pending: xianyuOrdersTodayPending,
        }
      },
      purchaseOrders: {
        total: purchaseOrdersTotal,
        paid: purchaseOrdersPaid,
        pending: purchaseOrdersPending,
        refunded: purchaseOrdersRefunded,
        paidAmount: purchaseOrdersPaidAmount,
        refundAmount: purchaseOrdersRefundAmount,
        today: {
          total: purchaseOrdersTodayTotal,
          paid: purchaseOrdersTodayPaid,
          pending: purchaseOrdersTodayPending,
          refunded: purchaseOrdersTodayRefunded,
          paidAmount: purchaseOrdersTodayPaidAmount,
          refundAmount: purchaseOrdersTodayRefundAmount,
        }
      },
      creditOrders: {
        total: creditOrdersTotal,
        paid: creditOrdersPaid,
        refunded: creditOrdersRefunded,
        paidAmount: creditOrdersPaidAmount,
      },
      pointsWithdrawals: {
        pending: pointsWithdrawalsPending,
        pendingPoints: pointsWithdrawalsPendingPoints,
        pendingCash: pointsWithdrawalsPendingCash,
      }
    })
  } catch (error) {
    console.error('[Admin Stats] overview error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
