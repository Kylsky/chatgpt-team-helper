import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { getDatabase, saveDatabase } from '../database/init.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireMenu, requireSuperAdmin } from '../middleware/rbac.js'
import { getAdminMenuTreeForAccessContext, getUserAccessContext } from '../services/rbac.js'
import { withLocks } from '../utils/locks.js'
import { redeemCodeInternal } from './redemption-codes.js'
import { getPointsWithdrawSettings } from '../utils/points-withdraw-settings.js'
import { listUserPointsLedger, safeInsertPointsLedgerEntry } from '../utils/points-ledger.js'

const router = express.Router()

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const generateInviteCode = (length = 10) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(crypto.randomInt(0, chars.length))
  }
  return result
}

// Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec('SELECT id, username, email, COALESCE(invite_enabled, 1) FROM users WHERE id = ?', [req.user.id])

    if (result.length === 0 || result[0].values.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = {
      id: result[0].values[0][0],
      username: result[0].values[0][1],
      email: result[0].values[0][2],
      inviteEnabled: Number(result[0].values[0][3] ?? 1) !== 0,
    }

    const access = await getUserAccessContext(req.user.id, db)
    const adminMenus = await getAdminMenuTreeForAccessContext(access, db)
    res.json({
      ...user,
      roles: access.roles,
      menus: access.menus,
      adminMenus,
    })
  } catch (error) {
    console.error('Get user error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/invite-code', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec(
      'SELECT invite_code, COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    )
    if (!result[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const inviteEnabled = Number(result[0].values[0][1] ?? 1) !== 0
    if (!inviteEnabled) {
      return res.status(403).json({ error: '邀请功能未开启' })
    }

    const inviteCode = result[0].values[0][0] || null
    res.json({ inviteCode: inviteCode || null })
  } catch (error) {
    console.error('Get invite code error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/invite-code', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec(
      'SELECT invite_code, COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    )
    if (!result[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const inviteEnabled = Number(result[0].values[0][1] ?? 1) !== 0
    if (!inviteEnabled) {
      return res.status(403).json({ error: '邀请功能未开启' })
    }

    const existing = result[0].values[0][0] || null
    if (existing) {
      return res.json({ inviteCode: existing })
    }

    let inviteCode = null
    for (let i = 0; i < 10; i++) {
      const candidate = generateInviteCode(10)
      const check = db.exec('SELECT id FROM users WHERE invite_code = ? LIMIT 1', [candidate])
      if (!check[0]?.values?.length) {
        inviteCode = candidate
        break
      }
    }

    if (!inviteCode) {
      return res.status(500).json({ error: '生成邀请码失败，请重试' })
    }

    db.run('UPDATE users SET invite_code = ? WHERE id = ?', [inviteCode, req.user.id])
    saveDatabase()

    res.json({ inviteCode })
  } catch (error) {
    console.error('Generate invite code error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/invite-summary', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()

    const userResult = db.exec(
      'SELECT invite_code, COALESCE(points, 0), COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [req.user.id]
    )
    if (!userResult[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const inviteCode = userResult[0].values[0][0] || null
    const points = Number(userResult[0].values[0][1] || 0)
    const inviteEnabled = Number(userResult[0].values[0][2] ?? 1) !== 0

    if (!inviteEnabled) {
      return res.status(403).json({ error: '邀请功能未开启' })
    }

    const invitedCountResult = db.exec(
      'SELECT COUNT(*) FROM users WHERE invited_by_user_id = ?',
      [req.user.id]
    )
    const invitedCount = Number(invitedCountResult[0]?.values?.[0]?.[0] || 0)

    res.json({
      inviteCode,
      points,
      invitedCount
    })
  } catch (error) {
    console.error('Get invite summary error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const TEAM_SEAT_COST_POINTS = Math.max(1, toInt(process.env.TEAM_SEAT_COST_POINTS, 15))
const INVITE_UNLOCK_COST_POINTS = Math.max(1, toInt(process.env.INVITE_UNLOCK_COST_POINTS, 15))

const WITHDRAW_MAX_POINTS_PER_REQUEST = Math.max(0, toInt(process.env.WITHDRAW_MAX_POINTS_PER_REQUEST, 500))
const WITHDRAW_DAILY_MAX_POINTS = Math.max(0, toInt(process.env.WITHDRAW_DAILY_MAX_POINTS, 500))
const WITHDRAW_DAILY_MAX_REQUESTS = Math.max(0, toInt(process.env.WITHDRAW_DAILY_MAX_REQUESTS, 3))
const WITHDRAW_MAX_PENDING = Math.max(0, toInt(process.env.WITHDRAW_MAX_PENDING, 1))
const WITHDRAW_COOLDOWN_SECONDS = Math.max(0, toInt(process.env.WITHDRAW_COOLDOWN_SECONDS, 60))

const toCashCentsFromPoints = (points, withdrawSettings) => {
  const normalized = Number(points)
  if (!Number.isFinite(normalized) || normalized <= 0) return 0
  const ratePoints = Math.max(1, Number(withdrawSettings?.ratePoints) || 1)
  const rateCashCents = Math.max(0, Number(withdrawSettings?.rateCashCents) || 0)
  if (rateCashCents <= 0) return 0
  return Math.round((normalized * rateCashCents) / ratePoints)
}

const formatCashAmount = (cashCents) => {
  const normalized = Number(cashCents)
  if (!Number.isFinite(normalized) || normalized <= 0) return '0.00'
  const yuan = Math.round(normalized) / 100
  return yuan.toFixed(2)
}

const SEAT_TYPE_UNDEMOTED = 'undemoted'
const SEAT_TYPE_DEMOTED = 'demoted'

const getTodayCommonCodeCount = (db) => {
  const result = db.exec(
    `
	      SELECT COUNT(*)
	      FROM redemption_codes rc
	      JOIN gpt_accounts ga ON lower(trim(ga.email)) = lower(trim(rc.account_email))
	      WHERE rc.is_redeemed = 0
	        AND rc.channel = 'common'
	        AND DATE(rc.created_at) = DATE('now', 'localtime')
        AND (rc.reserved_for_uid IS NULL OR TRIM(rc.reserved_for_uid) = '')
        AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
        AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
    `
  )
  return Number(result[0]?.values?.[0]?.[0] || 0)
}

const pickTodayCommonCode = (db) => {
  const row = db.exec(
    `
	      SELECT rc.code
	      FROM redemption_codes rc
	      JOIN gpt_accounts ga ON lower(trim(ga.email)) = lower(trim(rc.account_email))
	      WHERE rc.is_redeemed = 0
	        AND rc.channel = 'common'
	        AND DATE(rc.created_at) = DATE('now', 'localtime')
        AND (rc.reserved_for_uid IS NULL OR TRIM(rc.reserved_for_uid) = '')
        AND (rc.reserved_for_order_no IS NULL OR rc.reserved_for_order_no = '')
        AND (rc.reserved_for_entry_id IS NULL OR rc.reserved_for_entry_id = 0)
      ORDER BY rc.created_at ASC
      LIMIT 1
    `
  )[0]?.values?.[0]

  if (!row?.[0]) return ''
  return String(row[0]).trim().toUpperCase()
}

router.get('/points/meta', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const db = await getDatabase()
    const userResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
    if (!userResult[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const points = Number(userResult[0].values[0][0] || 0)
    const remaining = getTodayCommonCodeCount(db)
    const remainingByType = {
      [SEAT_TYPE_UNDEMOTED]: remaining,
      [SEAT_TYPE_DEMOTED]: 0,
    }
    const withdrawSettings = await getPointsWithdrawSettings(db)

    res.json({
      points,
      seat: {
        costPoints: TEAM_SEAT_COST_POINTS,
        remaining,
        remainingByType,
        defaultType: SEAT_TYPE_UNDEMOTED,
      },
      withdraw: {
        enabled: true,
        rate: {
          points: withdrawSettings.ratePoints,
          cashCents: withdrawSettings.rateCashCents,
        },
        minPoints: withdrawSettings.minPoints,
        stepPoints: withdrawSettings.stepPoints,
        maxPointsPerRequest: WITHDRAW_MAX_POINTS_PER_REQUEST,
        dailyMaxPoints: WITHDRAW_DAILY_MAX_POINTS,
        dailyMaxRequests: WITHDRAW_DAILY_MAX_REQUESTS,
        maxPending: WITHDRAW_MAX_PENDING,
        cooldownSeconds: WITHDRAW_COOLDOWN_SECONDS,
      }
    })
  } catch (error) {
    console.error('Get points meta error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/points/redeem/invite', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const result = await withLocks([`points:redeem-invite`, `points:user:${userId}`], async () => {
      const db = await getDatabase()
      const userResult = db.exec(
        'SELECT COALESCE(points, 0), COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
        [userId]
      )
      const row = userResult[0]?.values?.[0]
      if (!row) {
        return { ok: false, status: 404, error: 'User not found' }
      }

      const points = Number(row[0] || 0)
      const inviteEnabled = Number(row[1] ?? 1) !== 0

      if (inviteEnabled) {
        return { ok: false, status: 409, error: '已拥有邀请权限，无需兑换' }
      }

      if (points < INVITE_UNLOCK_COST_POINTS) {
        return { ok: false, status: 409, error: `积分不足（需要 ${INVITE_UNLOCK_COST_POINTS} 积分）` }
      }

      db.run(
        'UPDATE users SET points = COALESCE(points, 0) - ?, invite_enabled = 1 WHERE id = ?',
        [INVITE_UNLOCK_COST_POINTS, userId]
      )
      safeInsertPointsLedgerEntry(db, {
        userId,
        deltaPoints: -INVITE_UNLOCK_COST_POINTS,
        pointsBefore: points,
        pointsAfter: points - INVITE_UNLOCK_COST_POINTS,
        action: 'redeem_invite_unlock',
        remark: '开通邀请权限'
      })
      saveDatabase()

      const pointsAfterResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      const pointsAfter = Number(pointsAfterResult[0]?.values?.[0]?.[0] || 0)
      return { ok: true, points: pointsAfter }
    })

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error || '兑换失败' })
    }

    res.json({
      message: '邀请权限已开通',
      points: result.points,
      invite: {
        enabled: true,
        costPoints: INVITE_UNLOCK_COST_POINTS,
      }
    })
  } catch (error) {
    console.error('Redeem invite unlock error:', error)
    const statusCode = Number(error?.statusCode || error?.status || 0)
    if (statusCode >= 400 && statusCode < 600) {
      return res.status(statusCode).json({ error: error?.message || '兑换失败' })
    }
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/points/redeem/team', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  const requestedEmail = String(req.body?.email || '').trim()

  try {
    const result = await withLocks([`points:redeem-team`, `points:user:${userId}`], async () => {
      const db = await getDatabase()
      const userResult = db.exec(
        'SELECT email, COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1',
        [userId]
      )
      const userRow = userResult[0]?.values?.[0]
      if (!userRow) {
        return { ok: false, status: 404, error: 'User not found' }
      }

      const userEmail = String(userRow[0] || '').trim()
      const points = Number(userRow[1] || 0)
      const email = requestedEmail || userEmail

      if (!email) {
        return { ok: false, status: 400, error: '请输入邮箱地址' }
      }

      if (points < TEAM_SEAT_COST_POINTS) {
        return { ok: false, status: 409, error: `积分不足（需要 ${TEAM_SEAT_COST_POINTS} 积分）` }
      }

      const code = pickTodayCommonCode(db)
      if (!code) {
        return { ok: false, status: 409, error: '今日可兑换名额不足，请稍后再试' }
      }

      const redemption = await redeemCodeInternal({
        email,
        code,
        channel: 'common',
        skipCodeFormatValidation: true
      })

      db.run('UPDATE users SET points = COALESCE(points, 0) - ? WHERE id = ?', [TEAM_SEAT_COST_POINTS, userId])
      safeInsertPointsLedgerEntry(db, {
        userId,
        deltaPoints: -TEAM_SEAT_COST_POINTS,
        pointsBefore: points,
        pointsAfter: points - TEAM_SEAT_COST_POINTS,
        action: 'redeem_team_seat',
        refType: 'redemption_code',
        refId: redemption?.metadata?.codeId ?? null,
        remark: '兑换 ChatGPT Team 名额'
      })
      saveDatabase()

      const pointsAfterResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      const pointsAfter = Number(pointsAfterResult[0]?.values?.[0]?.[0] || 0)

      const remaining = getTodayCommonCodeCount(db)
      const remainingByType = {
        [SEAT_TYPE_UNDEMOTED]: remaining,
        [SEAT_TYPE_DEMOTED]: 0,
      }
      return { ok: true, redemption, points: pointsAfter, remainingByType }
    })

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error || '兑换失败' })
    }

    res.json({
      message: '兑换成功',
      points: result.points,
      seat: {
        costPoints: TEAM_SEAT_COST_POINTS,
        remaining: result.remainingByType?.[SEAT_TYPE_UNDEMOTED] || 0,
        remainingByType: result.remainingByType,
        defaultType: SEAT_TYPE_UNDEMOTED,
      },
      redemption: result.redemption
    })
  } catch (error) {
    console.error('Redeem team seat error:', error)
    const statusCode = Number(error?.statusCode || error?.status || 0)
    if (statusCode >= 400 && statusCode < 600) {
      return res.status(statusCode).json({ error: error?.message || '兑换失败' })
    }
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/points/withdrawals', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const db = await getDatabase()
    const limit = Math.min(50, Math.max(1, toInt(req.query.limit, 20)))

    const result = db.exec(
      `
        SELECT id, points, cash_amount, method, payout_account, status, remark, created_at, updated_at, processed_at
        FROM points_withdrawals
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `,
      [userId, limit]
    )

    const rows = result[0]?.values || []
    res.json({
      withdrawals: rows.map(row => ({
        id: row[0],
        points: Number(row[1] || 0),
        cashAmount: row[2] || null,
        method: row[3],
        payoutAccount: row[4],
        status: row[5] || 'pending',
        remark: row[6] || null,
        createdAt: row[7],
        updatedAt: row[8],
        processedAt: row[9] || null,
      }))
    })
  } catch (error) {
    console.error('List withdrawals error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/points/withdraw', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  const pointsRaw = req.body?.points
  const pointsText = String(pointsRaw ?? '').trim()
  if (!/^[0-9]{1,9}$/.test(pointsText)) {
    return res.status(400).json({ error: '请输入有效的提现积分' })
  }

  const pointsToWithdraw = toInt(pointsText, 0)
  const method = String(req.body?.method || '').trim().toLowerCase()
  const payoutAccount = String(req.body?.payoutAccount || req.body?.account || '').trim()

  if (pointsToWithdraw <= 0) {
    return res.status(400).json({ error: '请输入有效的提现积分' })
  }
  if (WITHDRAW_MAX_POINTS_PER_REQUEST > 0 && pointsToWithdraw > WITHDRAW_MAX_POINTS_PER_REQUEST) {
    return res.status(400).json({ error: `单次最多提现 ${WITHDRAW_MAX_POINTS_PER_REQUEST} 积分` })
  }
  if (!['alipay', 'wechat'].includes(method)) {
    return res.status(400).json({ error: '请选择有效的提现方式' })
  }
  if (!payoutAccount) {
    return res.status(400).json({ error: '请输入收款账号' })
  }
  if (/[\r\n]/.test(payoutAccount)) {
    return res.status(400).json({ error: '收款账号格式不正确' })
  }
  if (payoutAccount.length > 120) {
    return res.status(400).json({ error: '收款账号过长' })
  }

  try {
    const result = await withLocks([`points:user:${userId}`], async () => {
      const db = await getDatabase()
      const withdrawSettings = await getPointsWithdrawSettings(db)

      if (pointsToWithdraw < withdrawSettings.minPoints) {
        return { ok: false, status: 400, error: `最低提现 ${withdrawSettings.minPoints} 积分` }
      }
      if (withdrawSettings.stepPoints > 1 && pointsToWithdraw % withdrawSettings.stepPoints !== 0) {
        return { ok: false, status: 400, error: `提现积分需为 ${withdrawSettings.stepPoints} 的倍数` }
      }

      const userResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      if (!userResult[0]?.values?.length) {
        return { ok: false, status: 404, error: 'User not found' }
      }
      const currentPoints = Number(userResult[0].values[0][0] || 0)
      if (currentPoints < pointsToWithdraw) {
        return { ok: false, status: 409, error: '积分不足，无法提现' }
      }

      if (WITHDRAW_MAX_PENDING > 0) {
        const pending = db.exec(
          `SELECT COUNT(*) FROM points_withdrawals WHERE user_id = ? AND status = 'pending'`,
          [userId]
        )
        const pendingCount = Number(pending[0]?.values?.[0]?.[0] || 0)
        if (pendingCount >= WITHDRAW_MAX_PENDING) {
          return { ok: false, status: 429, error: '存在未处理的提现申请，请稍后再试' }
        }
      }

      if (WITHDRAW_COOLDOWN_SECONDS > 0) {
        const cooldown = `-${WITHDRAW_COOLDOWN_SECONDS} seconds`
        const recent = db.exec(
          `
            SELECT COUNT(*)
            FROM points_withdrawals
            WHERE user_id = ?
              AND created_at >= DATETIME('now', 'localtime', ?)
          `,
          [userId, cooldown]
        )
        const recentCount = Number(recent[0]?.values?.[0]?.[0] || 0)
        if (recentCount > 0) {
          return { ok: false, status: 429, error: '操作过于频繁，请稍后再试' }
        }
      }

      if (WITHDRAW_DAILY_MAX_REQUESTS > 0) {
        const todayCountResult = db.exec(
          `
            SELECT COUNT(*)
            FROM points_withdrawals
            WHERE user_id = ?
              AND DATE(created_at) = DATE('now', 'localtime')
          `,
          [userId]
        )
        const todayCount = Number(todayCountResult[0]?.values?.[0]?.[0] || 0)
        if (todayCount >= WITHDRAW_DAILY_MAX_REQUESTS) {
          return { ok: false, status: 429, error: '今日提现次数已达上限' }
        }
      }

      if (WITHDRAW_DAILY_MAX_POINTS > 0) {
        const todaySumResult = db.exec(
          `
            SELECT COALESCE(SUM(points), 0)
            FROM points_withdrawals
            WHERE user_id = ?
              AND DATE(created_at) = DATE('now', 'localtime')
              AND COALESCE(status, '') != 'rejected'
          `,
          [userId]
        )
        const todaySum = Number(todaySumResult[0]?.values?.[0]?.[0] || 0)
        if (todaySum + pointsToWithdraw > WITHDRAW_DAILY_MAX_POINTS) {
          return { ok: false, status: 429, error: `今日最多可提现 ${WITHDRAW_DAILY_MAX_POINTS} 积分` }
        }
      }

      const cashCents = toCashCentsFromPoints(pointsToWithdraw, withdrawSettings)
      if (cashCents <= 0) {
        return { ok: false, status: 400, error: '提现积分不合法' }
      }
      const cashAmount = formatCashAmount(cashCents)

      db.run(
        `
          INSERT INTO points_withdrawals (user_id, points, cash_amount, method, payout_account, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [userId, pointsToWithdraw, cashAmount, method, payoutAccount]
      )
      const withdrawalId = Number(db.exec('SELECT last_insert_rowid()')[0]?.values?.[0]?.[0] || 0)

      db.run('UPDATE users SET points = COALESCE(points, 0) - ? WHERE id = ?', [pointsToWithdraw, userId])
      safeInsertPointsLedgerEntry(db, {
        userId,
        deltaPoints: -pointsToWithdraw,
        pointsBefore: currentPoints,
        pointsAfter: currentPoints - pointsToWithdraw,
        action: 'withdraw_request',
        refType: 'points_withdrawal',
        refId: withdrawalId,
        remark: `提现申请（${method}）`
      })
      saveDatabase()

      const pointsAfterResult = db.exec('SELECT COALESCE(points, 0) FROM users WHERE id = ? LIMIT 1', [userId])
      const pointsAfter = Number(pointsAfterResult[0]?.values?.[0]?.[0] || 0)

      const row = db.exec(
        `
          SELECT id, points, cash_amount, method, payout_account, status, remark, created_at, updated_at, processed_at
          FROM points_withdrawals
          WHERE id = ? AND user_id = ?
          LIMIT 1
        `,
        [withdrawalId, userId]
      )[0]?.values?.[0]

      const withdrawal = row
        ? {
            id: row[0],
            points: Number(row[1] || 0),
            cashAmount: row[2] || null,
            method: row[3],
            payoutAccount: row[4],
            status: row[5] || 'pending',
            remark: row[6] || null,
            createdAt: row[7],
            updatedAt: row[8],
            processedAt: row[9] || null,
          }
        : null

      return { ok: true, points: pointsAfter, withdrawal }
    })

    if (!result.ok) {
      return res.status(result.status || 400).json({ error: result.error || '提现失败' })
    }

    res.json({
      message: '提现申请已提交（人工处理）',
      points: result.points,
      withdrawal: result.withdrawal
    })
  } catch (error) {
    console.error('Create withdrawal error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get user stats (email and user count)
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const db = await getDatabase()

    // Get user info
    const userResult = db.exec('SELECT username, email FROM users WHERE id = ?', [req.user.id])

    if (userResult.length === 0 || userResult[0].values.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get total user count
    const countResult = db.exec('SELECT COUNT(*) as count FROM users')
    const totalUsers = countResult[0].values[0][0]

    res.json({
      username: userResult[0].values[0][0],
      email: userResult[0].values[0][1],
      totalUsers: totalUsers
    })
  } catch (error) {
    console.error('Get stats error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.get('/points/ledger', authenticateToken, async (req, res) => {
  const userId = req.user?.id
  if (!userId) {
    return res.status(401).json({ error: 'Access denied. No user provided.' })
  }

  try {
    const db = await getDatabase()
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
    console.error('List points ledger error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

router.put('/username', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Access denied. No user provided.' })
    }

    const username = String(req.body?.username ?? '').trim()
    if (!username) {
      return res.status(400).json({ error: '用户名不能为空' })
    }
    if (username.length > 64) {
      return res.status(400).json({ error: '用户名过长' })
    }

    const db = await getDatabase()
    const existingUser = db.exec(
      'SELECT id, username, email, COALESCE(invite_enabled, 1) FROM users WHERE id = ? LIMIT 1',
      [userId]
    )
    if (!existingUser[0]?.values?.length) {
      return res.status(404).json({ error: 'User not found' })
    }

    const currentUsername = String(existingUser[0].values[0][1] || '').trim()
    const email = existingUser[0].values[0][2]
    const inviteEnabled = Number(existingUser[0].values[0][3] ?? 1) !== 0

    if (currentUsername && currentUsername.toLowerCase() === username.toLowerCase()) {
      const access = await getUserAccessContext(userId, db)
      return res.json({
        message: '用户名未变化',
        user: {
          id: userId,
          username: currentUsername,
          email,
          inviteEnabled,
          roles: access.roles,
          menus: access.menus,
        }
      })
    }

    const duplicate = db.exec(
      'SELECT 1 FROM users WHERE lower(username) = lower(?) AND id != ? LIMIT 1',
      [username, userId]
    )
    if (duplicate[0]?.values?.length) {
      return res.status(409).json({ error: '用户名已存在' })
    }

    db.run('UPDATE users SET username = ? WHERE id = ?', [username, userId])
    saveDatabase()

    const access = await getUserAccessContext(userId, db)
    res.json({
      message: '用户名已更新',
      user: {
        id: userId,
        username,
        email,
        inviteEnabled,
        roles: access.roles,
        menus: access.menus,
      }
    })
  } catch (error) {
    console.error('Update username error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Change password
router.put('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' })
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' })
    }

    const db = await getDatabase()

    // Get current user with password
    const userResult = db.exec('SELECT id, username, password FROM users WHERE id = ?', [req.user.id])

    if (userResult.length === 0 || userResult[0].values.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = {
      id: userResult[0].values[0][0],
      username: userResult[0].values[0][1],
      password: userResult[0].values[0][2]
    }

    // Verify current password
    const isPasswordValid = bcrypt.compareSync(currentPassword, user.password)

    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Current password is incorrect' })
    }

    // Hash new password
    const hashedPassword = bcrypt.hashSync(newPassword, 10)

    // Update password
    db.run(
      'UPDATE users SET password = ? WHERE id = ?',
      [hashedPassword, req.user.id]
    )
    saveDatabase()

    res.json({ message: 'Password changed successfully' })
  } catch (error) {
    console.error('Change password error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get API key
router.get('/api-key', authenticateToken, requireSuperAdmin, requireMenu('settings'), async (req, res) => {
  try {
    const db = await getDatabase()
    const result = db.exec('SELECT config_value FROM system_config WHERE config_key = "auto_boarding_api_key"')

    if (result.length === 0 || result[0].values.length === 0) {
      return res.json({ apiKey: null, configured: false })
    }

    res.json({ apiKey: result[0].values[0][0], configured: true })
  } catch (error) {
    console.error('Get API key error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update API key
router.put('/api-key', authenticateToken, requireSuperAdmin, requireMenu('settings'), async (req, res) => {
  try {
    const { apiKey } = req.body

    if (!apiKey) {
      return res.status(400).json({ error: 'API key is required' })
    }

    if (apiKey.length < 16) {
      return res.status(400).json({ error: 'API key must be at least 16 characters for security' })
    }

    const db = await getDatabase()

    // Check if key exists
    const checkResult = db.exec('SELECT id FROM system_config WHERE config_key = "auto_boarding_api_key"')

    if (checkResult.length === 0 || checkResult[0].values.length === 0) {
      // Insert new
      db.run(
        `INSERT INTO system_config (config_key, config_value, updated_at) VALUES (?, ?, DATETIME('now', 'localtime'))`,
        ['auto_boarding_api_key', apiKey]
      )
    } else {
      // Update existing
      db.run(
        `UPDATE system_config SET config_value = ?, updated_at = DATETIME('now', 'localtime') WHERE config_key = "auto_boarding_api_key"`,
        [apiKey]
      )
    }

    saveDatabase()

    res.json({
      message: 'API key updated successfully',
      apiKey: apiKey
    })
  } catch (error) {
    console.error('Update API key error:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
