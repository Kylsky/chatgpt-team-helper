import express from 'express'
import { getDatabase, saveDatabase } from '../database/init.js'
import { apiKeyAuth } from '../middleware/api-key-auth.js'
import { syncAccountUserCount } from '../services/account-sync.js'
import { SPACE_MEMBER_LIMIT } from '../utils/space-capacity.js'
import { SPACE_TYPE_CHILD, shouldAutoGenerateCodes } from '../utils/space-type.js'

const router = express.Router()

const EXPIRE_AT_REGEX = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/

const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase()

const normalizeBoolean = (value) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return null
  if (['1', 'true', 'yes'].includes(raw)) return true
  if (['0', 'false', 'no'].includes(raw)) return false
  return null
}

const formatExpireAt = (date) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date)
  } catch {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }
}

const normalizeExpireAt = (value) => {
  if (value == null) return null
  const raw = String(value).trim()
  if (!raw) return null
  if (EXPIRE_AT_REGEX.test(raw)) return raw

  const match = raw.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/)
  if (match) {
    return `${match[1]}/${match[2]}/${match[3]} ${match[4]}:${match[5]}`
  }

  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const date = new Date(asNumber)
    if (!Number.isNaN(date.getTime())) {
      return formatExpireAt(date)
    }
  }

  return null
}

const decodeJwtPayload = (token) => {
  const raw = String(token || '').trim()
  if (!raw) return null
  const parts = raw.split('.')
  if (parts.length < 2) return null
  const payload = parts[1]
  if (!payload) return null
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

const deriveExpireAtFromToken = (token) => {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload !== 'object') return null
  const exp = Number(payload.exp)
  if (!Number.isFinite(exp) || exp <= 0) return null
  const date = new Date(exp * 1000)
  if (Number.isNaN(date.getTime())) return null
  return formatExpireAt(date)
}

// 生成随机兑换码的辅助函数
function generateRedemptionCode(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 排除容易混淆的字符
  let code = ''
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length))
    // 每4位添加一个分隔符
    if ((i + 1) % 4 === 0 && i < length - 1) {
      code += '-'
    }
  }
  return code
}

async function syncAccountAndCleanup(account) {
  let syncData = null
  const removedUsers = []

  try {
    console.log('[Auto Boarding] 准备同步账号:', {
      email: account.email,
      chatgptAccountId: account.chatgptAccountId
    })
    syncData = await syncAccountUserCount(account.id, {
      accountRecord: account
    })
    console.log('[Auto Boarding] 同步完成:', {
      email: account.email,
      syncedUserCount: syncData.syncedUserCount,
      fetchedUsers: syncData?.users?.items?.length || 0
    })
  } catch (syncError) {
    console.error('[Auto Boarding] 同步失败:', syncError)
    return {
      account,
      syncResult: null,
      removedUsers
    }
  }

  return {
    account: syncData?.account || account,
    syncResult: syncData
      ? {
        syncedUserCount: syncData.syncedUserCount,
        users: syncData.users
      }
      : null,
    removedUsers
  }
}

// 自动上车接口
router.post('/', apiKeyAuth, async (req, res) => {
  try {
    const { email, token, refreshToken, chatgptAccountId, oaiDeviceId } = req.body
    const body = req.body || {}
    const hasExpireAt = Object.prototype.hasOwnProperty.call(req.body || {}, 'expireAt')
    const expireAtInput = req.body?.expireAt
    const normalizedExpireAt = hasExpireAt ? normalizeExpireAt(expireAtInput) : null
	    const shouldUpdateExpireAt = hasExpireAt || Boolean(deriveExpireAtFromToken(token))
	    const derivedExpireAt = shouldUpdateExpireAt && !hasExpireAt ? deriveExpireAtFromToken(token) : null
	    const expireAt = hasExpireAt ? normalizedExpireAt : (derivedExpireAt || null)
	    // isDemoted/is_demoted: deprecated (ignored). Keep request compatibility.

    if (hasExpireAt && expireAtInput != null && String(expireAtInput).trim() && !normalizedExpireAt) {
      return res.status(400).json({
        error: 'Invalid expireAt format',
        message: 'expireAt 格式错误，请使用 YYYY/MM/DD HH:mm'
      })
    }

    // 验证必填字段
    if (!email || !token) {
      return res.status(400).json({
        error: 'Email and token are required',
        message: '邮箱和Token是必填项'
      })
    }

    const normalizedEmail = normalizeEmail(email)

    const db = await getDatabase()

    // 检查账号是否已存在（通过email或chatgptAccountId）
    let existingAccount = null

    if (chatgptAccountId) {
      const result = db.exec(
        'SELECT id, email FROM gpt_accounts WHERE chatgpt_account_id = ?',
        [chatgptAccountId]
      )
      if (result.length > 0 && result[0].values.length > 0) {
        existingAccount = {
          id: result[0].values[0][0],
          email: result[0].values[0][1]
        }
      }
    }

    // 如果chatgptAccountId未找到，再通过email查找
    if (!existingAccount) {
      const result = db.exec(
        'SELECT id, email FROM gpt_accounts WHERE lower(email) = ?',
        [normalizedEmail]
      )
      if (result.length > 0 && result[0].values.length > 0) {
        existingAccount = {
          id: result[0].values[0][0],
          email: result[0].values[0][1]
        }
      }
    }

    if (existingAccount) {
      // 账号已存在，更新token和其他信息
	      db.run(
	        `UPDATE gpt_accounts
	         SET token = ?,
	             refresh_token = ?,
	             chatgpt_account_id = ?,
	             oai_device_id = ?,
	             is_open = 1,
	             expire_at = CASE WHEN ? = 1 THEN ? ELSE expire_at END,
	             updated_at = DATETIME('now', 'localtime')
	         WHERE id = ?`,
	        [token, refreshToken || null, chatgptAccountId || null, oaiDeviceId || null, shouldUpdateExpireAt ? 1 : 0, expireAt, existingAccount.id]
	      )
	      saveDatabase()

	      // 获取更新后的账号信息
	      const result = db.exec(`
	        SELECT id, email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at,
	               created_at, updated_at
	        FROM gpt_accounts
	        WHERE id = ?
	      `, [existingAccount.id])

	      const row = result[0].values[0]
	      const account = {
	        id: row[0],
	        email: row[1],
	        token: row[2],
	        refreshToken: row[3],
	        userCount: row[4],
	        chatgptAccountId: row[5],
	        oaiDeviceId: row[6],
	        expireAt: row[7] || null,
	        isDemoted: false,
	        createdAt: row[8],
	        updatedAt: row[9]
	      }

      const { account: syncedAccount, syncResult, removedUsers } = await syncAccountAndCleanup(account)

      return res.json({
        success: true,
        message: '账号信息已更新',
        action: 'updated',
        account: syncedAccount,
        syncResult,
        removedUsers
      })
    } else {
      // 创建新账号，默认人数设置为1而不是0
      db.run(
        `INSERT INTO gpt_accounts
         (email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at, is_open, is_demoted, space_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
        [
          normalizedEmail,
          token,
          refreshToken || null,
          1,
          chatgptAccountId || null,
          oaiDeviceId || null,
          expireAt,
          shouldUpdateIsDemoted ? isDemotedValue : 0,
          SPACE_TYPE_CHILD
        ]
      )

      // 获取新创建的账号
      const result = db.exec(`
        SELECT id, email, token, refresh_token, user_count, chatgpt_account_id, oai_device_id, expire_at,
               COALESCE(is_demoted, 0) AS is_demoted,
               COALESCE(space_type, '${SPACE_TYPE_CHILD}') AS space_type,
               created_at, updated_at
        FROM gpt_accounts
        WHERE id = last_insert_rowid()
      `)

      const row = result[0].values[0]
      const account = {
        id: row[0],
        email: row[1],
        token: row[2],
        refreshToken: row[3],
        userCount: row[4],
        chatgptAccountId: row[5],
        oaiDeviceId: row[6],
        expireAt: row[7] || null,
        isDemoted: Boolean(row[8]),
        spaceType: row[9] || SPACE_TYPE_CHILD,
        createdAt: row[10],
        updatedAt: row[11]
      }

      // 自动生成兑换码，数量为可用名额
      // 可用名额 = 总容量(5) - 当前人数 - 所有兑换码数(0)
      const totalCapacity = SPACE_MEMBER_LIMIT
      const userSync = await syncAccountUserCount(account.id, { accountRecord: account, userListParams: { offset: 0, limit: 1, query: '' } })
      const currentUserCount = Number(userSync?.syncedUserCount ?? account.userCount ?? 1)
      const allCodesCount = 0  // 新账号还没有任何兑换码
      const availableSlots = totalCapacity - currentUserCount - allCodesCount
      const shouldGenerateCodes = shouldAutoGenerateCodes(account.spaceType)
      if (!shouldGenerateCodes) {
        console.info('[AutoBoarding] skip auto redemption codes for mother space', {
          email: account.email,
          spaceType: account.spaceType
        })
      }
      const codesToGenerate = shouldGenerateCodes ? Math.min(4, availableSlots) : 0  // 生成4个兑换码（正好填满可用名额）

      const generatedCodes = []
      for (let i = 0; i < codesToGenerate; i++) {
        let code = generateRedemptionCode()
        let attempts = 0
        let success = false

        // 尝试生成唯一的兑换码（最多重试4次）
        while (attempts < 4 && !success) {
          try {
	            db.run(
	              `INSERT INTO redemption_codes (code, account_email, created_at, updated_at) VALUES (?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))`,
	              [code, normalizedEmail]
	            )
	            generatedCodes.push(code)
	            success = true
	          } catch (err) {
            if (err.message.includes('UNIQUE')) {
              // 如果重复，重新生成
              code = generateRedemptionCode()
              attempts++
            } else {
              throw err
            }
          }
        }
      }

      saveDatabase()

      const { account: responseAccount, syncResult, removedUsers } = await syncAccountAndCleanup(account)

      return res.status(201).json({
        success: true,
        message: '自动上车成功！账号已添加到系统',
        action: 'created',
        account: responseAccount,
        generatedCodes,
        codesMessage: shouldGenerateCodes ? `已自动生成${generatedCodes.length}个兑换码` : '母号空间已跳过自动生成兑换码',
        syncResult,
        removedUsers
      })
    }
  } catch (error) {
    console.error('Auto boarding error:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: '服务器错误，请稍后重试'
    })
  }
})

// 获取自动上车统计信息（可选）
router.get('/stats', apiKeyAuth, async (req, res) => {
  try {
    const db = await getDatabase()

    // 获取总账号数
    const totalResult = db.exec('SELECT COUNT(*) as count FROM gpt_accounts')
    const total = totalResult[0]?.values[0]?.[0] || 0

    // 获取最近24小时新增的账号数
    const recentResult = db.exec(`
      SELECT COUNT(*) as count
      FROM gpt_accounts
      WHERE created_at >= datetime('now', 'localtime', '-1 day')
    `)
    const recent = recentResult[0]?.values[0]?.[0] || 0

    res.json({
      success: true,
      stats: {
        totalAccounts: total,
        recentAccounts: recent
      }
    })
  } catch (error) {
    console.error('Get stats error:', error)
    res.status(500).json({
      error: 'Internal server error',
      message: '获取统计信息失败'
    })
  }
})

export default router
