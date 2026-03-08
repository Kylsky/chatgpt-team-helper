import { getDatabase, saveDatabase } from '../database/init.js'
import { syncAccountInviteCount, syncAccountUserCount } from './account-sync.js'
import { inviteUserToChatGPTTeam } from './chatgpt-invite.js'
import { SPACE_MEMBER_LIMIT } from '../utils/space-capacity.js'

const LABEL = '[WaitingRoomAutoBoarding]'
const DEFAULT_ACTIVE_HOURS = [8, 9, 10, 11, 12, 13, 14]
const MAX_LOOKAHEAD_HOURS = 48
const RESERVED_BY = 'auto-scheduler'

const configuredHours = parseActiveHours(process.env.WAITING_ROOM_AUTO_BOARDING_HOURS)
const activeHours = configuredHours.length ? configuredHours : DEFAULT_ACTIVE_HOURS
const ACTIVE_HOUR_SET = new Set(activeHours)

let schedulerTimer = null
let jobInProgress = false

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null) {
    return defaultValue
  }
  if (typeof value === 'boolean') {
    return value
  }
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value).toLowerCase())
}

function parseActiveHours(value) {
  if (!value || typeof value !== 'string') {
    return []
  }
  const hours = new Set()
  value.split(',').map(part => part.trim()).forEach(part => {
    if (!part) {
      return
    }
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-')
      const start = Number.parseInt(startStr, 10)
      const end = Number.parseInt(endStr, 10)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        const minHour = Math.max(0, Math.min(start, end))
        const maxHour = Math.min(23, Math.max(start, end))
        for (let hour = minHour; hour <= maxHour; hour++) {
          hours.add(hour)
        }
      }
      return
    }
    const hour = Number.parseInt(part, 10)
    if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
      hours.add(hour)
    }
  })
  return Array.from(hours).sort((a, b) => a - b)
}

function formatLocalTime(date) {
  return date.toLocaleString('zh-CN', { hour12: false })
}

function getNextScheduledTime(from = new Date()) {
  if (!ACTIVE_HOUR_SET.size) {
    return null
  }

  const next = new Date(from.getTime())
  next.setMinutes(0, 0, 0)
  if (from.getMinutes() !== 0 || from.getSeconds() !== 0 || from.getMilliseconds() !== 0) {
    next.setHours(next.getHours() + 1)
    next.setMinutes(0, 0, 0)
  }

  for (let i = 0; i < MAX_LOOKAHEAD_HOURS; i++) {
    if (ACTIVE_HOUR_SET.has(next.getHours()) && next.getTime() >= from.getTime()) {
      return next
    }
    next.setHours(next.getHours() + 1)
    next.setMinutes(0, 0, 0)
  }
  return null
}

function fetchNextWaitingEntry(db) {
  const result = db.exec(
    `
      SELECT id, linuxdo_uid, linuxdo_username, linuxdo_name, email, reserved_code_id, reserved_code
      FROM waiting_room_entries
      WHERE status = 'waiting'
      ORDER BY datetime(created_at) ASC
      LIMIT 1
    `
  )
  if (!result.length || !result[0].values.length) {
    return null
  }
  const [id, linuxDoUid, linuxDoUsername, linuxDoName, email, reservedCodeId, reservedCode] = result[0].values[0]
  return {
    id,
    linuxDoUid: linuxDoUid ? String(linuxDoUid).trim() : '',
    linuxDoUsername: linuxDoUsername || '',
    linuxDoName: linuxDoName || '',
    email: email || '',
    reservedCodeId: reservedCodeId || null,
    reservedCode: reservedCode || null
  }
}

function fetchAvailableLinuxDoCode(db) {
  const result = db.exec(
    `
      SELECT id, code, account_email
      FROM redemption_codes
      WHERE channel = 'linux-do'
        AND is_redeemed = 0
        AND reserved_for_entry_id IS NULL
        AND (reserved_for_uid IS NULL OR TRIM(reserved_for_uid) = '')
      ORDER BY datetime(created_at) ASC
      LIMIT 1
    `
  )
  if (!result.length || !result[0].values.length) {
    return null
  }
  const [id, code, accountEmail] = result[0].values[0]
  return {
    id,
    code,
    accountEmail: accountEmail || null
  }
}

function fetchCodeById(db, codeId) {
  if (!codeId) {
    return null
  }
  const result = db.exec(
    `
      SELECT id, code, is_redeemed, channel, account_email
      FROM redemption_codes
      WHERE id = ?
      LIMIT 1
    `,
    [codeId]
  )
  if (!result.length || !result[0].values.length) {
    return null
  }
  const [id, code, isRedeemed, channel, accountEmail] = result[0].values[0]
  return {
    id,
    code,
    isRedeemed: isRedeemed === 1,
    channel,
    accountEmail: accountEmail || null
  }
}

function reserveCodeForEntry(db, entry, code) {
  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_uid = ?,
          reserved_for_username = ?,
          reserved_for_entry_id = ?,
          reserved_at = DATETIME('now', 'localtime'),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [
      entry.linuxDoUid,
      entry.linuxDoUsername || entry.linuxDoName || null,
      entry.id,
      code.id
    ]
  )

  db.run(
    `
      UPDATE waiting_room_entries
      SET reserved_code_id = ?,
          reserved_code = ?,
          reserved_at = DATETIME('now', 'localtime'),
          reserved_by = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [code.id, code.code, RESERVED_BY, entry.id]
  )
}

function releaseReservation(db, entryId, codeId) {
  if (!entryId || !codeId) {
    return false
  }

  const codeResult = db.exec(
    `
      SELECT is_redeemed
      FROM redemption_codes
      WHERE id = ?
      LIMIT 1
    `,
    [codeId]
  )

  if (!codeResult.length || !codeResult[0].values.length) {
    return false
  }

  const isRedeemed = codeResult[0].values[0][0] === 1
  if (isRedeemed) {
    return false
  }

  db.run(
    `
      UPDATE waiting_room_entries
      SET reserved_code_id = NULL,
          reserved_code = NULL,
          reserved_at = NULL,
          reserved_by = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [entryId]
  )

  db.run(
    `
      UPDATE redemption_codes
      SET reserved_for_uid = NULL,
          reserved_for_username = NULL,
          reserved_for_entry_id = NULL,
          reserved_at = NULL,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [codeId]
  )

  return true
}

function selectAccountForCode(db, accountEmail) {
  if (accountEmail) {
    const result = db.exec(
      `
      SELECT id, email, token, user_count, chatgpt_account_id, oai_device_id
      FROM gpt_accounts
      WHERE email = ?
        AND COALESCE(user_count, 0) + COALESCE(invite_count, 0) < ?
      LIMIT 1
      `,
      [accountEmail, SPACE_MEMBER_LIMIT]
    )
    if (result.length && result[0].values.length) {
      const [id, email, token, userCount, chatgptAccountId, oaiDeviceId] = result[0].values[0]
      return { id, email, token, userCount: userCount || 0, chatgptAccountId, oaiDeviceId }
    }
  }

  const fallback = db.exec(
    `
      SELECT id, email, token, user_count, chatgpt_account_id, oai_device_id
      FROM gpt_accounts
      WHERE COALESCE(user_count, 0) + COALESCE(invite_count, 0) < ?
      ORDER BY COALESCE(user_count, 0) + COALESCE(invite_count, 0) ASC, RANDOM()
      LIMIT 1
    `,
    [SPACE_MEMBER_LIMIT]
  )

  if (!fallback.length || !fallback[0].values.length) {
    return null
  }
  const [id, email, token, userCount, chatgptAccountId, oaiDeviceId] = fallback[0].values[0]
  return { id, email, token, userCount: userCount || 0, chatgptAccountId, oaiDeviceId }
}

async function redeemReservedCode(db, entry, code) {
  const normalizedEmail = String(entry.email || '').trim().toLowerCase()
  if (!normalizedEmail) {
    throw new Error('候车用户缺少有效邮箱')
  }
  const normalizedUid = String(entry.linuxDoUid || '').trim()
  if (!normalizedUid) {
    throw new Error('候车用户缺少 Linux DO UID')
  }

  const codeResult = db.exec(
    `
      SELECT id, code, is_redeemed, account_email, channel, reserved_for_entry_id
      FROM redemption_codes
      WHERE id = ?
      LIMIT 1
    `,
    [code.id]
  )

  if (!codeResult.length || !codeResult[0].values.length) {
    throw new Error('兑换码不存在')
  }

  const [codeId, codeValue, isRedeemed, boundAccountEmail, channel, reservedEntryId] = codeResult[0].values[0]

  if (isRedeemed === 1) {
    throw new Error('兑换码已被使用')
  }

  if (channel !== 'linux-do') {
    throw new Error('兑换码渠道不匹配')
  }

  if (reservedEntryId && reservedEntryId !== entry.id) {
    throw new Error('兑换码已绑定其他候车成员')
  }

  const account = selectAccountForCode(db, boundAccountEmail)
  if (!account) {
    throw new Error('暂无可用账号，请先补充账号名额')
  }

  const redeemerIdentifier = `UID:${normalizedUid} | Email:${normalizedEmail}`

  db.run(
    `
      UPDATE redemption_codes
      SET is_redeemed = 1,
          redeemed_at = DATETIME('now', 'localtime'),
          redeemed_by = ?,
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [redeemerIdentifier, codeId]
  )

  db.run(
    `
      UPDATE waiting_room_entries
      SET status = 'boarded',
          boarded_at = COALESCE(boarded_at, DATETIME('now', 'localtime')),
          updated_at = DATETIME('now', 'localtime')
      WHERE id = ?
    `,
    [entry.id]
  )

  let inviteResult = { success: false, message: '邀请功能未启用' }
  let syncedAccount = null
  let syncedUserCount = null
  let syncedInviteCount = null
  if (account.chatgptAccountId && account.token) {
    inviteResult = await inviteUserToChatGPTTeam(entry.email, {
      token: account.token,
      chatgpt_account_id: account.chatgptAccountId,
      oai_device_id: account.oaiDeviceId
    }, { proxyKey: account.id })
    if (!inviteResult.success) {
      console.error(`${LABEL} 邀请 ${entry.email} 时失败:`, inviteResult.error)
    } else {
      try {
        const userSync = await syncAccountUserCount(account.id, {
          userListParams: { offset: 0, limit: 1, query: '' }
        })
        syncedAccount = userSync.account
        if (typeof userSync.syncedUserCount === 'number') {
          syncedUserCount = userSync.syncedUserCount
        }
      } catch (error) {
        console.warn(`${LABEL} 同步账号人数失败:`, error)
      }

      try {
        const inviteSync = await syncAccountInviteCount(account.id, {
          inviteListParams: { offset: 0, limit: 1, query: '' }
        })
        syncedAccount = inviteSync.account || syncedAccount
        if (typeof inviteSync.inviteCount === 'number') {
          syncedInviteCount = inviteSync.inviteCount
        }
      } catch (error) {
        console.warn(`${LABEL} 同步邀请数量失败:`, error)
      }
    }
  } else {
    console.log(`${LABEL} 账号 ${account.email} 缺少 ChatGPT 认证信息，跳过邀请步骤`)
  }

  const resolvedUserCount = typeof syncedAccount?.userCount === 'number'
    ? syncedAccount.userCount
    : typeof syncedUserCount === 'number'
      ? syncedUserCount
      : account.userCount || 0

  return {
    accountEmail: account.email,
    userCount: resolvedUserCount,
    inviteResult,
    code: codeValue,
    inviteCount: typeof syncedAccount?.inviteCount === 'number'
      ? syncedAccount.inviteCount
      : typeof syncedInviteCount === 'number'
        ? syncedInviteCount
        : null
  }
}

async function runAutoBoardingJob(trigger = 'scheduler') {
  if (jobInProgress) {
    console.log(`${LABEL} 上一次任务尚未完成，跳过本次触发 (${trigger})`)
    return
  }

  const now = new Date()
  if (!ACTIVE_HOUR_SET.has(now.getHours())) {
    console.log(`${LABEL} 当前时间 ${formatLocalTime(now)} 不在设定时段，跳过执行`)
    return
  }

  jobInProgress = true
  let entry = null
  let code = null
  let db = null
  let createdReservation = false

  try {
    db = await getDatabase()

    entry = fetchNextWaitingEntry(db)
    if (!entry) {
      console.log(`${LABEL} 候车队列为空，本次无需处理`)
      return
    }

    if (!entry.email) {
      console.warn(`${LABEL} 队首用户 UID:${entry.linuxDoUid} 缺少邮箱，跳过`)
      return
    }

    if (!entry.linuxDoUid) {
      console.warn(`${LABEL} 队首用户缺少 Linux DO UID，跳过`)
      return
    }

    if (entry.reservedCodeId) {
      const existingCode = fetchCodeById(db, entry.reservedCodeId)
      if (existingCode && !existingCode.isRedeemed && existingCode.channel === 'linux-do') {
        code = existingCode
        console.log(`${LABEL} 队首用户已有兑换码 ${code.code}，尝试直接兑换`)
      } else {
        const released = releaseReservation(db, entry.id, entry.reservedCodeId)
        if (released) {
          await saveDatabase()
          console.log(`${LABEL} 已释放失效兑换码 ${entry.reservedCode || entry.reservedCodeId}`)
        }
      }
    }

    if (!code) {
      code = fetchAvailableLinuxDoCode(db)
      if (!code) {
        console.warn(`${LABEL} 当前没有可用的 Linux DO 渠道兑换码，跳过此次任务`)
        return
      }
      console.log(`${LABEL} 准备为 UID:${entry.linuxDoUid} (${entry.email}) 分配兑换码 ${code.code}`)
      reserveCodeForEntry(db, entry, code)
      createdReservation = true
    }

    const redemptionResult = await redeemReservedCode(db, entry, code)

    await saveDatabase()

    console.log(
      `${LABEL} 已完成 UID:${entry.linuxDoUid} 的上车兑换，账号 ${redemptionResult.accountEmail} 当前人数 ${redemptionResult.userCount}`
    )

    if (redemptionResult.inviteResult?.success) {
      console.log(`${LABEL} 已发送 ChatGPT 团队邀请，Invite ID: ${redemptionResult.inviteResult.inviteId || '未知'}`)
    } else if (redemptionResult.inviteResult?.error) {
      console.warn(`${LABEL} 未能发送邀请（${redemptionResult.inviteResult.error}）`)
    } else {
      console.log(`${LABEL} 未发送邀请：${redemptionResult.inviteResult?.message || '邀请功能未启用'}`)
    }
  } catch (error) {
    if (db && entry && code && createdReservation) {
      try {
        const released = releaseReservation(db, entry.id, code.id)
        if (released) {
          await saveDatabase()
          console.log(`${LABEL} 已回滚兑换码 ${code.code} 的绑定`)
        }
      } catch (releaseError) {
        console.error(`${LABEL} 回滚绑定失败:`, releaseError)
      }
    }
    console.error(`${LABEL} 任务 (${trigger}) 执行失败:`, error)
  } finally {
    jobInProgress = false
  }
}

function scheduleNextRun() {
  const nextRun = getNextScheduledTime()
  if (!nextRun) {
    console.warn(`${LABEL} 无法计算下次运行时间，自动任务已停止`)
    return
  }

  const delay = Math.max(0, nextRun.getTime() - Date.now())
  const minutes = (delay / 60000).toFixed(2)
  console.log(`${LABEL} 下次执行时间：${formatLocalTime(nextRun)}（约 ${minutes} 分钟后）`)

  schedulerTimer = setTimeout(async () => {
    schedulerTimer = null
    try {
      await runAutoBoardingJob('scheduler')
    } finally {
      scheduleNextRun()
    }
  }, delay)

  schedulerTimer.unref?.()
}

export function startWaitingRoomAutoBoardingScheduler() {
  if (!parseBool(process.env.WAITING_ROOM_AUTO_BOARDING_ENABLED, true)) {
    console.log(`${LABEL} 自动上车任务已禁用 (WAITING_ROOM_AUTO_BOARDING_ENABLED=false)`)
    return
  }

  if (!ACTIVE_HOUR_SET.size) {
    console.warn(`${LABEL} 未配置有效的执行时段，任务不会启动`)
    return
  }

  if (schedulerTimer) {
    clearTimeout(schedulerTimer)
    schedulerTimer = null
  }

  console.log(
    `${LABEL} 定时任务已启动，将在以下整点执行：${Array.from(ACTIVE_HOUR_SET).sort((a, b) => a - b).join(', ')}`
  )
  scheduleNextRun()
}

export async function runWaitingRoomAutoBoardingNow() {
  await runAutoBoardingJob('manual')
}
