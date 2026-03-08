import initSqlJs from 'sql.js'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const CHANNEL_LABELS = {
  common: '通用渠道',
  'linux-do': 'Linux DO 渠道',
  xhs: '小红书渠道',
  xianyu: '闲鱼渠道',
}
const DEFAULT_CHANNEL = 'common'
const DEFAULT_CHANNEL_NAME = CHANNEL_LABELS[DEFAULT_CHANNEL]

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let db = null

const LOCALTIME_MIGRATION_USER_VERSION = 1
const LOCALTIME_LIKE_PATTERN = '____-__-__ __:__:__%'

const getUserVersion = (database) => {
  try {
    const result = database.exec('PRAGMA user_version')
    const value = result[0]?.values?.[0]?.[0]
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

const setUserVersion = (database, version) => {
  if (!database) return
  const normalized = Number.isFinite(Number(version)) ? Math.max(0, Number(version)) : 0
  database.run(`PRAGMA user_version = ${normalized}`)
}

const tableExists = (database, tableName) => {
  if (!database || !tableName) return false
  const result = database.exec(
    'SELECT name FROM sqlite_master WHERE type = "table" AND name = ? LIMIT 1',
    [String(tableName)]
  )
  return Boolean(result[0]?.values?.length)
}

const getTableColumns = (database, tableName) => {
  if (!database || !tableName) return new Set()
  try {
    const result = database.exec(`PRAGMA table_info(${tableName})`)
    const rows = result[0]?.values || []
    return new Set(rows.map(row => String(row[1] || '')))
  } catch {
    return new Set()
  }
}

const ensureRbacTables = (database) => {
  let changed = false

  try {
    const indexExists = (indexName) => {
      if (!indexName) return false
      const result = database.exec(
        'SELECT name FROM sqlite_master WHERE type = "index" AND name = ? LIMIT 1',
        [String(indexName)]
      )
      return Boolean(result[0]?.values?.length)
    }

    const userColumns = getTableColumns(database, 'users')
    const addUserColumn = (name, ddl) => {
      if (userColumns.has(name)) return
      database.run(`ALTER TABLE users ADD COLUMN ${ddl}`)
      console.log(`[DB] 已添加 users.${name} 列`)
      changed = true
      userColumns.add(name)
    }

    addUserColumn('invite_code', 'invite_code TEXT')
    addUserColumn('invited_by_user_id', 'invited_by_user_id INTEGER')
    addUserColumn('points', 'points INTEGER DEFAULT 0')
    addUserColumn('invite_enabled', 'invite_enabled INTEGER DEFAULT 0')
    addUserColumn('telegram_id', 'telegram_id TEXT')

    const duplicateEmail = database.exec(`
      SELECT 1
      FROM (
        SELECT email, COUNT(*) AS cnt
        FROM users
        GROUP BY email
        HAVING cnt > 1
      )
      LIMIT 1
    `)
    if (!duplicateEmail[0]?.values?.length) {
      if (!indexExists('idx_users_email_unique')) {
        database.run('CREATE UNIQUE INDEX idx_users_email_unique ON users(email)')
        changed = true
      }
    } else {
      console.warn('[DB] users.email 存在重复值，跳过创建唯一索引 idx_users_email_unique')
    }

    if (!indexExists('idx_users_invite_code_unique')) {
      database.run('CREATE UNIQUE INDEX idx_users_invite_code_unique ON users(invite_code)')
      changed = true
    }

    const rolesExists = tableExists(database, 'roles')
    database.run(`
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_key TEXT UNIQUE NOT NULL,
        role_name TEXT NOT NULL,
        description TEXT,
        created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
        updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
      )
    `)
    if (!rolesExists) changed = true

    const menusExists = tableExists(database, 'menus')
    database.run(`
      CREATE TABLE IF NOT EXISTS menus (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        menu_key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        path TEXT NOT NULL,
        parent_id INTEGER,
        sort_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
        updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
      )
    `)
    if (!menusExists) changed = true

    const deletedMenuKeysExists = tableExists(database, 'deleted_menu_keys')
    database.run(`
      CREATE TABLE IF NOT EXISTS deleted_menu_keys (
        menu_key TEXT PRIMARY KEY,
        deleted_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
      )
    `)
    if (!deletedMenuKeysExists) changed = true

    const menuColumns = getTableColumns(database, 'menus')
    const addMenuColumn = (name, ddl) => {
      if (menuColumns.has(name)) return
      database.run(`ALTER TABLE menus ADD COLUMN ${ddl}`)
      console.log(`[DB] 已添加 menus.${name} 列`)
      changed = true
      menuColumns.add(name)
    }

    addMenuColumn('parent_id', 'parent_id INTEGER')
    addMenuColumn('sort_order', 'sort_order INTEGER DEFAULT 0')
    addMenuColumn('is_active', 'is_active INTEGER DEFAULT 1')

    const userRolesExists = tableExists(database, 'user_roles')
    database.run(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
        PRIMARY KEY (user_id, role_id)
      )
    `)
    if (!userRolesExists) changed = true

    const roleMenusExists = tableExists(database, 'role_menus')
    database.run(`
      CREATE TABLE IF NOT EXISTS role_menus (
        role_id INTEGER NOT NULL,
        menu_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
        PRIMARY KEY (role_id, menu_id)
      )
    `)
    if (!roleMenusExists) changed = true

    const emailCodesExists = tableExists(database, 'email_verification_codes')
    database.run(`
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        consumed_at DATETIME,
        created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
      )
    `)
    if (!emailCodesExists) changed = true

    if (!indexExists('idx_user_roles_user_id')) {
      database.run('CREATE INDEX idx_user_roles_user_id ON user_roles(user_id)')
      changed = true
    }
    if (!indexExists('idx_menus_parent_id')) {
      database.run('CREATE INDEX idx_menus_parent_id ON menus(parent_id)')
      changed = true
    }
    if (!indexExists('idx_menus_is_active')) {
      database.run('CREATE INDEX idx_menus_is_active ON menus(is_active)')
      changed = true
    }
    if (!indexExists('idx_role_menus_role_id')) {
      database.run('CREATE INDEX idx_role_menus_role_id ON role_menus(role_id)')
      changed = true
    }
    if (!indexExists('idx_email_verification_codes_lookup')) {
      database.run('CREATE INDEX idx_email_verification_codes_lookup ON email_verification_codes(email, purpose, created_at)')
      changed = true
    }

    const ensureRole = (roleKey, roleName, description = '') => {
      if (!roleKey) return null
      const existing = database.exec('SELECT id FROM roles WHERE role_key = ? LIMIT 1', [roleKey])
      if (existing[0]?.values?.length) {
        return { id: existing[0].values[0][0], created: false }
      }
      database.run(
        `
          INSERT INTO roles (role_key, role_name, description, created_at, updated_at)
          VALUES (?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [roleKey, roleName, description]
      )
      changed = true
      const created = database.exec('SELECT id FROM roles WHERE role_key = ? LIMIT 1', [roleKey])
      return created[0]?.values?.length ? { id: created[0].values[0][0], created: true } : null
    }

    const ensureMenu = (menuKey, label, pathValue, options = {}) => {
      if (!menuKey) return null
      const existing = database.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', [menuKey])
      if (existing[0]?.values?.length) {
        return { id: existing[0].values[0][0], created: false }
      }
      const deleted = database.exec('SELECT 1 FROM deleted_menu_keys WHERE menu_key = ? LIMIT 1', [menuKey])
      if (deleted[0]?.values?.length) {
        return null
      }
      const normalizeParentId = (value) => {
        const parsed = Number(value)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null
      }

      let parentId = normalizeParentId(options?.parentId)
      if (parentId === null && options?.parentKey) {
        const parentKey = String(options.parentKey || '').trim()
        if (parentKey) {
          const parent = database.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', [parentKey])
          parentId = parent[0]?.values?.length ? normalizeParentId(parent[0].values[0][0]) : null
        }
      }
      const sortOrder = Number.isFinite(Number(options?.sortOrder)) ? Number(options.sortOrder) : 0
      const isActive = Number(options?.isActive ?? 1) !== 0 ? 1 : 0
      database.run(
        `
          INSERT INTO menus (menu_key, label, path, parent_id, sort_order, is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
        `,
        [menuKey, label, pathValue, parentId, sortOrder, isActive]
      )
      changed = true
      const created = database.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', [menuKey])
      return created[0]?.values?.length ? { id: created[0].values[0][0], created: true } : null
    }

    const superAdminRole = ensureRole('super_admin', '超级管理员', '拥有全部后台权限')
    const defaultUserRole = ensureRole('user', '普通用户', '默认无后台菜单权限')
    const superAdminRoleId = superAdminRole?.id || null
    const defaultUserRoleId = defaultUserRole?.id || null

    const defaultMenus = [
      { key: 'stats', label: '数据统计', path: '/admin/stats', sortOrder: 1 },
      { key: 'user_info', label: '用户信息', path: '/admin/user-info', sortOrder: 2 },
      { key: 'accounts', label: '账号管理', path: '/admin/accounts', sortOrder: 3 },
      { key: 'redemption_codes', label: '兑换码管理', path: '/admin/redemption-codes', sortOrder: 4 },
      { key: 'product_management', label: '商品管理', path: '/admin/product-management', sortOrder: 5 },
      { key: 'product_management_list', label: '商品列表', path: '/admin/product-management/list', parentKey: 'product_management', sortOrder: 1 },
      { key: 'product_management_site_notice', label: '公告设置', path: '/admin/product-management/site-notice', parentKey: 'product_management', sortOrder: 2 },
      { key: 'order_management', label: '订单管理', path: '', sortOrder: 6 },
      { key: 'purchase_orders', label: '支付订单', path: '/admin/purchase-orders', parentKey: 'order_management', sortOrder: 1 },
      { key: 'xhs_orders', label: '小红书订单', path: '/admin/xhs-orders', parentKey: 'order_management', sortOrder: 2 },
      { key: 'xianyu_orders', label: '闲鱼订单', path: '/admin/xianyu-orders', parentKey: 'order_management', sortOrder: 3 },
      { key: 'credit_orders', label: 'Credit 订单', path: '/admin/credit-orders', parentKey: 'order_management', sortOrder: 4 },
      { key: 'account_recovery', label: '补号管理', path: '/admin/account-recovery', parentKey: 'order_management', sortOrder: 5 },
      { key: 'permission_management', label: '权限管理', path: '', sortOrder: 7 },
      { key: 'user_management', label: '用户管理', path: '/admin/users', parentKey: 'permission_management', sortOrder: 1 },
      { key: 'role_management', label: '角色管理', path: '/admin/roles', parentKey: 'permission_management', sortOrder: 2 },
      { key: 'menu_management', label: '菜单管理', path: '/admin/menus', parentKey: 'permission_management', sortOrder: 3 },
      { key: 'settings', label: '系统设置', path: '/admin/settings', sortOrder: 9 },
      { key: 'my_orders', label: '我的订单', path: '/admin/my-orders', sortOrder: 10 },
      { key: 'points_exchange', label: '积分兑换', path: '/admin/points-exchange', sortOrder: 11 },
      { key: 'history_exceptions', label: '历史异常', path: '/admin/history-exceptions', sortOrder: 12 },
      { key: 'history_exception:view', label: '历史异常查看权限', path: '', sortOrder: 9001, isActive: 0 },
      { key: 'history_exception:update', label: '历史异常更新权限', path: '', sortOrder: 9002, isActive: 0 },
      { key: 'history_exception:delete', label: '历史异常删除权限', path: '', sortOrder: 9003, isActive: 0 },
      { key: 'waiting_room', label: '候车室管理', path: '/admin/waiting-room', sortOrder: 99, isActive: 0 },
    ]

    const menuInfosByKey = new Map()
    for (const item of defaultMenus) {
      const menuInfo = ensureMenu(item.key, item.label, item.path, {
        parentId: item.parentId ?? null,
        parentKey: item.parentKey ?? null,
        sortOrder: item.sortOrder ?? 0,
        isActive: item.isActive ?? 1,
      })
      if (menuInfo?.id) {
        menuInfosByKey.set(item.key, menuInfo)
      }
    }

    // 兼容历史结构：商品管理曾挂在订单管理下，统一迁移为一级菜单
    try {
      const productMenuIdResult = database.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', ['product_management'])
      const productMenuId = Number(productMenuIdResult?.[0]?.values?.[0]?.[0] ?? 0)
      if (Number.isFinite(productMenuId) && productMenuId > 0) {
        const orderMenuIdResult = database.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', ['order_management'])
        const orderMenuId = Number(orderMenuIdResult?.[0]?.values?.[0]?.[0] ?? 0)
        const updateResult = database.exec('SELECT parent_id, path, label, sort_order FROM menus WHERE id = ? LIMIT 1', [productMenuId])
        const row = updateResult?.[0]?.values?.[0] || []
        const currentParentId = row[0] == null ? null : Number(row[0])
        const currentPath = String(row[1] || '')
        const currentLabel = String(row[2] || '')
        const currentSortOrder = Number(row[3] || 0)
        const shouldMoveToTopLevel = Number.isFinite(orderMenuId) && orderMenuId > 0 && currentParentId === orderMenuId
        const shouldFixPath = currentPath !== '/admin/product-management'
        const shouldFixLabel = currentLabel !== '商品管理'
        const shouldFixSort = currentSortOrder !== 5

        if (shouldMoveToTopLevel || shouldFixPath || shouldFixLabel || shouldFixSort) {
          database.run(
            `
              UPDATE menus
              SET parent_id = NULL,
                  path = ?,
                  label = ?,
                  sort_order = ?,
                  updated_at = DATETIME('now', 'localtime')
              WHERE id = ?
            `,
            ['/admin/product-management', '商品管理', 5, productMenuId]
          )
          changed = true
        }
      }
    } catch (error) {
      console.warn('[RBAC] 迁移商品管理菜单结构失败:', error?.message || error)
    }

    const resolveMenuIdByKey = (menuKey) => {
      const key = String(menuKey || '').trim()
      if (!key) return null
      const result = database.exec('SELECT id FROM menus WHERE menu_key = ? LIMIT 1', [key])
      const id = result[0]?.values?.length ? Number(result[0].values[0][0]) : null
      return Number.isFinite(id) && id > 0 ? id : null
    }

    const menuIdExists = (id) => {
      const parsed = Number(id)
      if (!Number.isFinite(parsed) || parsed <= 0) return false
      const result = database.exec('SELECT 1 FROM menus WHERE id = ? LIMIT 1', [parsed])
      return Boolean(result[0]?.values?.length)
    }

    const normalizeExistingParentId = (value) => {
      const parsed = Number(value)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null
    }

    for (const item of defaultMenus) {
      if (!item?.key) continue
      const row = database.exec('SELECT id, parent_id FROM menus WHERE menu_key = ? LIMIT 1', [String(item.key)])
      if (!row[0]?.values?.length) continue
      const menuId = Number(row[0].values[0][0])
      if (!Number.isFinite(menuId) || menuId <= 0) continue

      const currentParentId = normalizeExistingParentId(row[0].values[0][1])
      const expectedParentId = item.parentKey ? resolveMenuIdByKey(item.parentKey) : null

      const shouldFixToExpected =
        expectedParentId !== null &&
        (currentParentId === null || !menuIdExists(currentParentId))

      const shouldFixToNull =
        expectedParentId === null &&
        currentParentId !== null &&
        !menuIdExists(currentParentId)

      if (shouldFixToExpected || shouldFixToNull) {
        database.run(
          `
            UPDATE menus
            SET parent_id = ?,
                updated_at = DATETIME('now', 'localtime')
            WHERE id = ?
          `,
          [shouldFixToExpected ? expectedParentId : null, menuId]
        )
        changed = true
      }
    }

    const grantRoleMenus = (roleId, menuIds) => {
      if (!roleId || !menuIds?.length) return
      for (const menuId of menuIds) {
        const hasMenu = database.exec(
          'SELECT 1 FROM role_menus WHERE role_id = ? AND menu_id = ? LIMIT 1',
          [roleId, menuId]
        )
        if (!hasMenu[0]?.values?.length) {
          database.run(
            'INSERT INTO role_menus (role_id, menu_id) VALUES (?, ?)',
            [roleId, menuId]
          )
          changed = true
        }
      }
    }

    const superAdminExcludedMenuKeys = new Set(['my_orders', 'points_exchange', 'waiting_room'])
    const superAdminRoleCreated = Boolean(superAdminRole?.created)
    if (superAdminRoleId) {
      const menuIds = []
      for (const [menuKey, menuInfo] of menuInfosByKey.entries()) {
        if (superAdminExcludedMenuKeys.has(menuKey)) continue
        if (!superAdminRoleCreated && !menuInfo.created) continue
        menuIds.push(menuInfo.id)
      }

      grantRoleMenus(superAdminRoleId, menuIds)
    }

    // 角色授权迁移：历史具备“补号管理”的角色，自动补齐历史异常菜单和权限点
    try {
      const sourceMenuId = resolveMenuIdByKey('account_recovery')
      const migrationTargets = ['history_exceptions', 'history_exception:view', 'history_exception:update', 'history_exception:delete']
        .map(resolveMenuIdByKey)
        .filter(Boolean)

      if (sourceMenuId && migrationTargets.length) {
        const roleRows = database.exec('SELECT role_id FROM role_menus WHERE menu_id = ?', [sourceMenuId])
        for (const row of roleRows[0]?.values || []) {
          const roleId = Number(row[0])
          if (!Number.isFinite(roleId) || roleId <= 0) continue
          grantRoleMenus(roleId, migrationTargets)
        }
      }
    } catch (error) {
      console.warn('[RBAC] 历史异常权限迁移失败:', error?.message || error)
    }

    const defaultUserMenuKeys = ['my_orders', 'user_info', 'points_exchange']
    const defaultUserRoleCreated = Boolean(defaultUserRole?.created)
    if (defaultUserRoleId) {
      const menuIds = defaultUserMenuKeys
        .map(menuKey => menuInfosByKey.get(menuKey))
        .filter(Boolean)
        .filter(menuInfo => defaultUserRoleCreated || Boolean(menuInfo.created))
        .map(menuInfo => menuInfo.id)

      grantRoleMenus(defaultUserRoleId, menuIds)
    }

    const adminUserResult = database.exec('SELECT id FROM users WHERE username = ? LIMIT 1', ['admin'])
    const adminUserId = adminUserResult[0]?.values?.length ? adminUserResult[0].values[0][0] : null
    if (adminUserId && superAdminRoleId) {
      const hasRole = database.exec(
        'SELECT 1 FROM user_roles WHERE user_id = ? AND role_id = ? LIMIT 1',
        [adminUserId, superAdminRoleId]
      )
      if (!hasRole[0]?.values?.length) {
        database.run(
          'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
          [adminUserId, superAdminRoleId]
        )
        changed = true
      }
    }

    if (defaultUserRoleId) {
      const missingRolesResult = database.exec(`
        SELECT COUNT(*)
        FROM users u
        WHERE NOT EXISTS (
          SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id
        )
      `)
      const missingRoles = Number(missingRolesResult[0]?.values?.[0]?.[0] || 0)
      if (missingRoles > 0) {
        database.run(
          `
            INSERT OR IGNORE INTO user_roles (user_id, role_id)
            SELECT u.id, ?
            FROM users u
            WHERE NOT EXISTS (
              SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id
            )
          `,
          [defaultUserRoleId]
        )
        changed = true
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 RBAC 表结构:', error?.message || error)
  }

  return changed
}

const migrateUtcTimestampsToLocaltime = (database) => {
  if (!database) return { migrated: false, reason: 'no_db' }
  const currentVersion = getUserVersion(database)
  if (currentVersion >= LOCALTIME_MIGRATION_USER_VERSION) {
    return { migrated: false, skipped: true, version: currentVersion }
  }

  const targets = [
    { table: 'users', columns: ['created_at'] },
    { table: 'system_config', columns: ['updated_at'] },
    { table: 'gpt_accounts', columns: ['created_at', 'updated_at'] },
    { table: 'linuxdo_users', columns: ['created_at', 'updated_at'] },
    { table: 'redemption_codes', columns: ['created_at', 'updated_at', 'redeemed_at', 'reserved_at'] },
    { table: 'waiting_room_entries', columns: ['created_at', 'updated_at', 'reserved_at', 'boarded_at', 'left_at'] },
    { table: 'waiting_room_cooldown_resets', columns: ['reset_at'] },
    { table: 'account_recovery_logs', columns: ['created_at', 'updated_at', 'original_redeemed_at'] },
    { table: 'purchase_orders', columns: ['created_at', 'updated_at', 'query_at', 'paid_at', 'redeemed_at', 'refunded_at', 'email_sent_at', 'telegram_sent_at'] },
    { table: 'credit_orders', columns: ['created_at', 'updated_at', 'query_at', 'paid_at', 'notify_at', 'refunded_at'] },
    { table: 'xhs_config', columns: ['updated_at', 'last_sync_at', 'last_success_at'] },
    { table: 'xhs_orders', columns: ['extracted_at', 'reserved_at', 'used_at', 'created_at', 'updated_at'] },
    { table: 'xianyu_config', columns: ['updated_at', 'last_sync_at', 'last_success_at'] },
    { table: 'xianyu_orders', columns: ['extracted_at', 'reserved_at', 'used_at', 'created_at', 'updated_at'] },
  ]

  const startedAt = Date.now()
  let touchedTables = 0
  let touchedColumns = 0

  database.run('BEGIN')
  try {
    for (const target of targets) {
      const table = target.table
      if (!tableExists(database, table)) {
        continue
      }

      const existingColumns = getTableColumns(database, table)
      const columns = (target.columns || []).filter(col => existingColumns.has(col))
      if (!columns.length) continue

      const setClauses = columns
        .map(col => {
          return `${col} = CASE
            WHEN ${col} IS NULL OR TRIM(${col}) = '' THEN ${col}
            WHEN ${col} LIKE '${LOCALTIME_LIKE_PATTERN}' THEN DATETIME(${col}, 'localtime')
            ELSE ${col}
          END`
        })
        .join(',\n')

      const whereClauses = columns
        .map(col => `(${col} IS NOT NULL AND TRIM(${col}) != '' AND ${col} LIKE '${LOCALTIME_LIKE_PATTERN}')`)
        .join(' OR ')

      database.run(
        `
          UPDATE ${table}
          SET ${setClauses}
          WHERE ${whereClauses}
        `
      )

      touchedTables += 1
      touchedColumns += columns.length
    }

    setUserVersion(database, LOCALTIME_MIGRATION_USER_VERSION)
    database.run('COMMIT')
    console.log('[DB] 已将历史时间从 UTC 迁移为本地时间', {
      version: LOCALTIME_MIGRATION_USER_VERSION,
      touchedTables,
      touchedColumns,
      durationMs: Date.now() - startedAt,
    })
    return { migrated: true, touchedTables, touchedColumns }
  } catch (error) {
    try {
      database.run('ROLLBACK')
    } catch {
      // ignore
    }
    console.error('[DB] 历史时间迁移失败', error?.message || error)
    return { migrated: false, error: error?.message || String(error) }
  }
}

const ensureWaitingRoomCooldownTable = (database) => {
  if (!database) return false
  let changed = false

  const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="waiting_room_cooldown_resets"')
  if (tableExists.length === 0) {
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS waiting_room_cooldown_resets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          linuxdo_uid TEXT NOT NULL UNIQUE,
          reset_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
        )
      `)
      changed = true
    } catch (error) {
      console.warn('[DB] 无法创建冷却期重置表:', error)
    }
  }

  database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_cooldown_resets_uid ON waiting_room_cooldown_resets (linuxdo_uid)')

  return changed
}

const ensureWaitingRoomTable = (database) => {
  if (!database) return false
  let changed = false

  const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="waiting_room_entries"')
  if (tableExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS waiting_room_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          linuxdo_uid TEXT NOT NULL,
          linuxdo_username TEXT,
          linuxdo_name TEXT,
          linuxdo_trust_level INTEGER DEFAULT 0,
          email TEXT NOT NULL,
          status TEXT DEFAULT 'waiting',
          boarded_at DATETIME,
          left_at DATETIME,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          reserved_code_id INTEGER,
          reserved_code TEXT,
          reserved_at DATETIME,
          reserved_by TEXT,
          queue_position_snapshot INTEGER
        )
      `)
    changed = true
  }

  database.run('CREATE INDEX IF NOT EXISTS idx_waiting_room_status_created ON waiting_room_entries (status, created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_waiting_room_uid ON waiting_room_entries (linuxdo_uid)')

  try {
    const tableInfo = database.exec('PRAGMA table_info(waiting_room_entries)')
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map(row => row[1])
      if (!columns.includes('linuxdo_trust_level')) {
        database.run('ALTER TABLE waiting_room_entries ADD COLUMN linuxdo_trust_level INTEGER DEFAULT 0')
        changed = true
      }
      if (!columns.includes('left_at')) {
        database.run('ALTER TABLE waiting_room_entries ADD COLUMN left_at DATETIME')
        changed = true
      }
      if (!columns.includes('reserved_code_id')) {
        database.run('ALTER TABLE waiting_room_entries ADD COLUMN reserved_code_id INTEGER')
        changed = true
      }
      if (!columns.includes('reserved_code')) {
        database.run('ALTER TABLE waiting_room_entries ADD COLUMN reserved_code TEXT')
        changed = true
      }
      if (!columns.includes('reserved_at')) {
        database.run('ALTER TABLE waiting_room_entries ADD COLUMN reserved_at DATETIME')
        changed = true
      }
      if (!columns.includes('reserved_by')) {
        database.run('ALTER TABLE waiting_room_entries ADD COLUMN reserved_by TEXT')
        changed = true
      }
      if (!columns.includes('queue_position_snapshot')) {
        database.run('ALTER TABLE waiting_room_entries ADD COLUMN queue_position_snapshot INTEGER')
        changed = true
      }
    }
  } catch (error) {
    console.warn('[DB] 无法检查候车室表字段:', error)
  }

  const cooldownTableChanged = ensureWaitingRoomCooldownTable(database)

  return changed || cooldownTableChanged
}

const ensureOpenAccountSeatProtectionsTable = (database) => {
  if (!database) return false
  let changed = false

  const tableInfo = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="open_account_seat_protections"')
  if (tableInfo.length === 0) {
    database.run(`
      CREATE TABLE IF NOT EXISTS open_account_seat_protections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_email TEXT NOT NULL,
        source_channel TEXT NOT NULL,
        created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
        expires_at DATETIME,
        updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
      )
    `)
    changed = true
  }

  database.run('CREATE INDEX IF NOT EXISTS idx_open_account_seat_protections_email ON open_account_seat_protections (target_email)')
  database.run('CREATE INDEX IF NOT EXISTS idx_open_account_seat_protections_source ON open_account_seat_protections (source_channel)')
  database.run('CREATE INDEX IF NOT EXISTS idx_open_account_seat_protections_expires ON open_account_seat_protections (expires_at)')

  try {
    const columnsResult = database.exec('PRAGMA table_info(open_account_seat_protections)')
    const columns = new Set((columnsResult[0]?.values || []).map(row => String(row[1] || '')))

    if (!columns.has('target_email')) {
      database.run('ALTER TABLE open_account_seat_protections ADD COLUMN target_email TEXT')
      changed = true
    }
    if (!columns.has('source_channel')) {
      database.run('ALTER TABLE open_account_seat_protections ADD COLUMN source_channel TEXT')
      changed = true
    }
    if (!columns.has('created_at')) {
      database.run("ALTER TABLE open_account_seat_protections ADD COLUMN created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
      changed = true
    }
    if (!columns.has('expires_at')) {
      database.run('ALTER TABLE open_account_seat_protections ADD COLUMN expires_at DATETIME')
      changed = true
    }
    if (!columns.has('updated_at')) {
      database.run("ALTER TABLE open_account_seat_protections ADD COLUMN updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
      changed = true
    }
  } catch (error) {
    console.warn('[DB] 无法检查保护席位表字段:', error)
  }

  return changed
}

const ensureGptAccountMembersTable = (database) => {
  if (!database) return false
  let changed = false

  const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="gpt_account_members"')
  if (tableExists.length === 0) {
    database.run(`
      CREATE TABLE IF NOT EXISTS gpt_account_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        email TEXT,
        name TEXT,
        role TEXT,
        created_time TEXT,
        is_scim_managed INTEGER DEFAULT 0,
        synced_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
        updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
        UNIQUE(account_id, member_id)
      )
    `)
    changed = true
  }

  database.run('CREATE INDEX IF NOT EXISTS idx_gpt_account_members_account ON gpt_account_members (account_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_gpt_account_members_email ON gpt_account_members (account_id, email)')
  database.run('CREATE INDEX IF NOT EXISTS idx_gpt_account_members_name ON gpt_account_members (account_id, name)')
  return changed
}

const ensureXhsTables = (database) => {
  if (!database) return false
  let changed = false

  try {
	    const ordersExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="xhs_orders"')
	    if (ordersExists.length === 0) {
	      database.run(`
	        CREATE TABLE IF NOT EXISTS xhs_orders (
	          id INTEGER PRIMARY KEY AUTOINCREMENT,
	          order_number TEXT NOT NULL UNIQUE,
	          status TEXT DEFAULT 'pending',
	          order_status TEXT,
	          order_time DATETIME,
	          actual_paid INTEGER,
	          nickname TEXT,
	          user_email TEXT,
	          assigned_code_id INTEGER,
	          assigned_code TEXT,
	          is_used INTEGER DEFAULT 0,
          extracted_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          reserved_at DATETIME,
          used_at DATETIME,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          FOREIGN KEY (assigned_code_id) REFERENCES redemption_codes(id)
        )
      `)
      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(xhs_orders)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        if (!columns.includes('status')) {
          database.run(`ALTER TABLE xhs_orders ADD COLUMN status TEXT DEFAULT 'pending'`)
          changed = true
        }
	        if (!columns.includes('order_time')) {
	          database.run('ALTER TABLE xhs_orders ADD COLUMN order_time DATETIME')
	          changed = true
	        }
	        if (!columns.includes('actual_paid')) {
	          database.run('ALTER TABLE xhs_orders ADD COLUMN actual_paid INTEGER')
	          changed = true
	        }
	        if (!columns.includes('order_status')) {
	          database.run('ALTER TABLE xhs_orders ADD COLUMN order_status TEXT')
	          changed = true
	        }
        if (!columns.includes('nickname')) {
          database.run('ALTER TABLE xhs_orders ADD COLUMN nickname TEXT')
          changed = true
        }
        if (!columns.includes('user_email')) {
          database.run('ALTER TABLE xhs_orders ADD COLUMN user_email TEXT')
          changed = true
        }
        if (!columns.includes('assigned_code_id')) {
          database.run('ALTER TABLE xhs_orders ADD COLUMN assigned_code_id INTEGER')
          changed = true
        }
        if (!columns.includes('assigned_code')) {
          database.run('ALTER TABLE xhs_orders ADD COLUMN assigned_code TEXT')
          changed = true
        }
        if (!columns.includes('reserved_at')) {
          database.run('ALTER TABLE xhs_orders ADD COLUMN reserved_at DATETIME')
          changed = true
        }
        if (!columns.includes('used_at')) {
          database.run('ALTER TABLE xhs_orders ADD COLUMN used_at DATETIME')
          changed = true
        }
        if (!columns.includes('extracted_at')) {
          database.run("ALTER TABLE xhs_orders ADD COLUMN extracted_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
        if (!columns.includes('created_at')) {
          database.run("ALTER TABLE xhs_orders ADD COLUMN created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
        if (!columns.includes('updated_at')) {
          database.run("ALTER TABLE xhs_orders ADD COLUMN updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
      }
    }

    database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_xhs_orders_number ON xhs_orders(order_number)')
    database.run('CREATE INDEX IF NOT EXISTS idx_xhs_orders_status ON xhs_orders(status, created_at)')
    database.run('CREATE INDEX IF NOT EXISTS idx_xhs_orders_usage ON xhs_orders(is_used, created_at)')
  } catch (error) {
    console.warn('[DB] 无法初始化 xhs_orders 表:', error)
  }

  try {
	    const configExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="xhs_config"')
	    if (configExists.length === 0) {
	      database.run(`
	        CREATE TABLE IF NOT EXISTS xhs_config (
	          id INTEGER PRIMARY KEY AUTOINCREMENT,
	          cookies TEXT,
	          authorization TEXT,
	          extra_headers TEXT,
	          last_sync_at DATETIME,
	          last_success_at DATETIME,
	          sync_enabled INTEGER DEFAULT 0,
	          sync_interval_hours INTEGER DEFAULT 6,
	          last_error TEXT,
	          error_count INTEGER DEFAULT 0,
	          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
	        )
	      `)
      database.run('INSERT INTO xhs_config (sync_enabled, sync_interval_hours) VALUES (0, 6)')
      changed = true
    } else {
      const configInfo = database.exec('PRAGMA table_info(xhs_config)')
      if (configInfo.length > 0) {
        const columns = configInfo[0].values.map(row => row[1])
        if (!columns.includes('last_success_at')) {
          database.run('ALTER TABLE xhs_config ADD COLUMN last_success_at DATETIME')
          changed = true
        }
        if (!columns.includes('last_error')) {
          database.run('ALTER TABLE xhs_config ADD COLUMN last_error TEXT')
          changed = true
        }
        if (!columns.includes('error_count')) {
          database.run('ALTER TABLE xhs_config ADD COLUMN error_count INTEGER DEFAULT 0')
          changed = true
        }
        if (!columns.includes('sync_enabled')) {
          database.run('ALTER TABLE xhs_config ADD COLUMN sync_enabled INTEGER DEFAULT 0')
          changed = true
        }
        if (!columns.includes('sync_interval_hours')) {
          database.run('ALTER TABLE xhs_config ADD COLUMN sync_interval_hours INTEGER DEFAULT 6')
          changed = true
        }
        if (!columns.includes('updated_at')) {
          database.run("ALTER TABLE xhs_config ADD COLUMN updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
        if (!columns.includes('authorization')) {
          database.run('ALTER TABLE xhs_config ADD COLUMN authorization TEXT')
          changed = true
        }
        if (!columns.includes('extra_headers')) {
          database.run('ALTER TABLE xhs_config ADD COLUMN extra_headers TEXT')
          changed = true
        }
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 xhs_config 表:', error)
  }

  return changed
}

const ensureXianyuTables = (database) => {
  if (!database) return false
  let changed = false

  try {
    const ordersExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="xianyu_orders"')
    if (ordersExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS xianyu_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL UNIQUE,
          status TEXT DEFAULT 'pending',
          order_status TEXT,
          order_time DATETIME,
          actual_paid INTEGER,
          nickname TEXT,
          user_email TEXT,
          assigned_code_id INTEGER,
          assigned_code TEXT,
          is_used INTEGER DEFAULT 0,
          extracted_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          reserved_at DATETIME,
          used_at DATETIME,
          im_notified_at DATETIME,
          im_notified_message TEXT,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          FOREIGN KEY (assigned_code_id) REFERENCES redemption_codes(id)
        )
      `)
      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(xianyu_orders)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        if (!columns.includes('status')) {
          database.run(`ALTER TABLE xianyu_orders ADD COLUMN status TEXT DEFAULT 'pending'`)
          changed = true
        }
        if (!columns.includes('order_time')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN order_time DATETIME')
          changed = true
        }
        if (!columns.includes('actual_paid')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN actual_paid INTEGER')
          changed = true
        }
        if (!columns.includes('order_status')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN order_status TEXT')
          changed = true
        }
        if (!columns.includes('nickname')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN nickname TEXT')
          changed = true
        }
        if (!columns.includes('user_email')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN user_email TEXT')
          changed = true
        }
        if (!columns.includes('assigned_code_id')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN assigned_code_id INTEGER')
          changed = true
        }
        if (!columns.includes('assigned_code')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN assigned_code TEXT')
          changed = true
        }
        if (!columns.includes('reserved_at')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN reserved_at DATETIME')
          changed = true
        }
        if (!columns.includes('used_at')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN used_at DATETIME')
          changed = true
        }
        if (!columns.includes('im_notified_at')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN im_notified_at DATETIME')
          changed = true
        }
        if (!columns.includes('im_notified_message')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN im_notified_message TEXT')
          changed = true
        }
        if (!columns.includes('extracted_at')) {
          database.run("ALTER TABLE xianyu_orders ADD COLUMN extracted_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
        if (!columns.includes('created_at')) {
          database.run("ALTER TABLE xianyu_orders ADD COLUMN created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
        if (!columns.includes('updated_at')) {
          database.run("ALTER TABLE xianyu_orders ADD COLUMN updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
        if (!columns.includes('is_used')) {
          database.run('ALTER TABLE xianyu_orders ADD COLUMN is_used INTEGER DEFAULT 0')
          changed = true
        }
      }
    }

    database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_xianyu_orders_order_id ON xianyu_orders(order_id)')
    database.run('CREATE INDEX IF NOT EXISTS idx_xianyu_orders_status ON xianyu_orders(status, created_at)')
    database.run('CREATE INDEX IF NOT EXISTS idx_xianyu_orders_usage ON xianyu_orders(is_used, created_at)')
  } catch (error) {
    console.warn('[DB] 无法初始化 xianyu_orders 表:', error)
  }

  try {
    const configExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="xianyu_config"')
    if (configExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS xianyu_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cookies TEXT,
          last_sync_at DATETIME,
          last_success_at DATETIME,
          sync_enabled INTEGER DEFAULT 0,
          sync_interval_hours INTEGER DEFAULT 6,
          last_error TEXT,
          error_count INTEGER DEFAULT 0,
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
        )
      `)
      database.run('INSERT INTO xianyu_config (sync_enabled, sync_interval_hours) VALUES (0, 6)')
      changed = true
    } else {
      const configInfo = database.exec('PRAGMA table_info(xianyu_config)')
      if (configInfo.length > 0) {
        const columns = configInfo[0].values.map(row => row[1])
        if (!columns.includes('last_success_at')) {
          database.run('ALTER TABLE xianyu_config ADD COLUMN last_success_at DATETIME')
          changed = true
        }
        if (!columns.includes('last_error')) {
          database.run('ALTER TABLE xianyu_config ADD COLUMN last_error TEXT')
          changed = true
        }
        if (!columns.includes('error_count')) {
          database.run('ALTER TABLE xianyu_config ADD COLUMN error_count INTEGER DEFAULT 0')
          changed = true
        }
        if (!columns.includes('sync_enabled')) {
          database.run('ALTER TABLE xianyu_config ADD COLUMN sync_enabled INTEGER DEFAULT 0')
          changed = true
        }
        if (!columns.includes('sync_interval_hours')) {
          database.run('ALTER TABLE xianyu_config ADD COLUMN sync_interval_hours INTEGER DEFAULT 6')
          changed = true
        }
        if (!columns.includes('updated_at')) {
          database.run("ALTER TABLE xianyu_config ADD COLUMN updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 xianyu_config 表:', error)
  }

  return changed
}

const ensureLinuxDoUsersTable = (database) => {
  if (!database) return false
  let changed = false

  try {
    const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="linuxdo_users"')
	    if (tableExists.length === 0) {
	      database.run(`
	        CREATE TABLE IF NOT EXISTS linuxdo_users (
	          uid TEXT PRIMARY KEY,
	          username TEXT NOT NULL,
            name TEXT,
            trust_level INTEGER,
	          email TEXT,
	          current_open_account_id INTEGER,
	          current_open_account_email TEXT,
	          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
	          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
	        )
	      `)
	      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(linuxdo_users)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        if (!columns.includes('name')) {
          database.run('ALTER TABLE linuxdo_users ADD COLUMN name TEXT')
          changed = true
        }
        if (!columns.includes('trust_level')) {
          database.run('ALTER TABLE linuxdo_users ADD COLUMN trust_level INTEGER')
          changed = true
        }
        if (!columns.includes('email')) {
          database.run('ALTER TABLE linuxdo_users ADD COLUMN email TEXT')
          changed = true
        }
	        if (!columns.includes('current_open_account_id')) {
	          database.run('ALTER TABLE linuxdo_users ADD COLUMN current_open_account_id INTEGER')
	          changed = true
	        }
	        if (!columns.includes('current_open_account_email')) {
	          database.run('ALTER TABLE linuxdo_users ADD COLUMN current_open_account_email TEXT')
	          changed = true
	        }
	        if (!columns.includes('updated_at')) {
	          database.run("ALTER TABLE linuxdo_users ADD COLUMN updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
	          changed = true
	        }
        if (!columns.includes('created_at')) {
          database.run("ALTER TABLE linuxdo_users ADD COLUMN created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 linuxdo_users 表:', error)
  }

  return changed
}

const ensureAccountRecoveryTable = (database) => {
  if (!database) return false
  let changed = false

  try {
    const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="account_recovery_logs"')
    if (tableExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS account_recovery_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT NOT NULL,
          original_code_id INTEGER NOT NULL,
          original_redeemed_at DATETIME,
          original_account_email TEXT,
          recovery_mode TEXT,
          recovery_code_id INTEGER,
          recovery_code TEXT,
          recovery_account_email TEXT,
          status TEXT DEFAULT 'pending',
          error_message TEXT,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
        )
      `)
      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(account_recovery_logs)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        if (!columns.includes('original_code_id')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN original_code_id INTEGER')
          changed = true
        }
        if (!columns.includes('original_redeemed_at')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN original_redeemed_at DATETIME')
          changed = true
        }
        if (!columns.includes('original_account_email')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN original_account_email TEXT')
          changed = true
        }
        if (!columns.includes('recovery_mode')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN recovery_mode TEXT')
          changed = true
        }
        if (!columns.includes('recovery_code_id')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN recovery_code_id INTEGER')
          changed = true
        }
        if (!columns.includes('recovery_code')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN recovery_code TEXT')
          changed = true
        }
        if (!columns.includes('recovery_account_email')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN recovery_account_email TEXT')
          changed = true
        }
        if (!columns.includes('status')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN status TEXT DEFAULT \'pending\'')
          changed = true
        }
        if (!columns.includes('error_message')) {
          database.run('ALTER TABLE account_recovery_logs ADD COLUMN error_message TEXT')
          changed = true
        }
        if (!columns.includes('created_at')) {
          database.run("ALTER TABLE account_recovery_logs ADD COLUMN created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
        if (!columns.includes('updated_at')) {
          database.run("ALTER TABLE account_recovery_logs ADD COLUMN updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
          changed = true
        }
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 account_recovery_logs 表:', error)
  }

  database.run('CREATE INDEX IF NOT EXISTS idx_account_recovery_email ON account_recovery_logs (email)')
  database.run('CREATE INDEX IF NOT EXISTS idx_account_recovery_original_code ON account_recovery_logs (original_code_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_account_recovery_status ON account_recovery_logs (status)')

  return changed
}

const ensurePurchaseOrdersTable = (database) => {
  if (!database) return false
  let changed = false

  try {
    const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="purchase_orders"')
    if (tableExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS purchase_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER,
          invite_reward_to_user_id INTEGER,
          invite_reward_points INTEGER,
          invite_rewarded_at DATETIME,
          buyer_reward_points INTEGER,
          buyer_rewarded_at DATETIME,
          order_no TEXT NOT NULL UNIQUE,
          email TEXT NOT NULL,
          product_name TEXT NOT NULL,
          amount TEXT NOT NULL,
          service_days INTEGER DEFAULT 30,
          order_type TEXT DEFAULT 'warranty',
          pay_type TEXT,
          status TEXT DEFAULT 'created',
          zpay_oid TEXT,
          zpay_trade_no TEXT,
          zpay_payurl TEXT,
          zpay_qrcode TEXT,
          zpay_img TEXT,
          query_payload TEXT,
          query_at DATETIME,
          query_status INTEGER,
          code_id INTEGER,
          code TEXT,
          code_account_email TEXT,
          notify_payload TEXT,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          paid_at DATETIME,
          redeemed_at DATETIME,
          invite_status TEXT,
          redeem_account_email TEXT,
          redeem_user_count INTEGER,
          redeem_error TEXT,
          refunded_at DATETIME,
          refund_amount TEXT,
          refund_message TEXT,
          email_sent_at DATETIME,
          telegram_sent_at DATETIME,
          FOREIGN KEY (code_id) REFERENCES redemption_codes(id)
        )
      `)
      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(purchase_orders)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        const addColumn = (name, ddl) => {
          if (!columns.includes(name)) {
            database.run(`ALTER TABLE purchase_orders ADD COLUMN ${ddl}`)
            changed = true
          }
        }

        addColumn('user_id', 'user_id INTEGER')
        addColumn('invite_reward_to_user_id', 'invite_reward_to_user_id INTEGER')
        addColumn('invite_reward_points', 'invite_reward_points INTEGER')
        addColumn('invite_rewarded_at', 'invite_rewarded_at DATETIME')
        addColumn('buyer_reward_points', 'buyer_reward_points INTEGER')
        addColumn('buyer_rewarded_at', 'buyer_rewarded_at DATETIME')
        addColumn('order_no', 'order_no TEXT')
        addColumn('email', 'email TEXT')
        addColumn('product_name', 'product_name TEXT')
        addColumn('amount', 'amount TEXT')
        addColumn('service_days', 'service_days INTEGER DEFAULT 30')
        addColumn('order_type', "order_type TEXT DEFAULT 'warranty'")
        addColumn('pay_type', 'pay_type TEXT')
        addColumn('status', 'status TEXT DEFAULT \'created\'')
        addColumn('zpay_oid', 'zpay_oid TEXT')
        addColumn('zpay_trade_no', 'zpay_trade_no TEXT')
        addColumn('zpay_payurl', 'zpay_payurl TEXT')
        addColumn('zpay_qrcode', 'zpay_qrcode TEXT')
        addColumn('zpay_img', 'zpay_img TEXT')
        addColumn('query_payload', 'query_payload TEXT')
        addColumn('query_at', 'query_at DATETIME')
        addColumn('query_status', 'query_status INTEGER')
        addColumn('code_id', 'code_id INTEGER')
        addColumn('code', 'code TEXT')
        addColumn('code_account_email', 'code_account_email TEXT')
        addColumn('notify_payload', 'notify_payload TEXT')
        addColumn('created_at', "created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
        addColumn('updated_at', "updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
        addColumn('paid_at', 'paid_at DATETIME')
        addColumn('redeemed_at', 'redeemed_at DATETIME')
        addColumn('invite_status', 'invite_status TEXT')
        addColumn('redeem_account_email', 'redeem_account_email TEXT')
        addColumn('redeem_user_count', 'redeem_user_count INTEGER')
        addColumn('redeem_error', 'redeem_error TEXT')
        addColumn('refunded_at', 'refunded_at DATETIME')
        addColumn('refund_amount', 'refund_amount TEXT')
        addColumn('refund_message', 'refund_message TEXT')
        addColumn('email_sent_at', 'email_sent_at DATETIME')
        addColumn('telegram_sent_at', 'telegram_sent_at DATETIME')
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 purchase_orders 表:', error)
  }

  database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchase_orders_order_no ON purchase_orders(order_no)')
  database.run('CREATE INDEX IF NOT EXISTS idx_purchase_orders_status_created ON purchase_orders(status, created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_purchase_orders_email_created ON purchase_orders(email, created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_purchase_orders_user_created ON purchase_orders(user_id, created_at)')

  return changed
}

const ensurePointsWithdrawalsTable = (database) => {
  if (!database) return false
  let changed = false

  try {
    const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="points_withdrawals"')
    if (tableExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS points_withdrawals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          points INTEGER NOT NULL,
          cash_amount TEXT,
          method TEXT NOT NULL,
          payout_account TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          remark TEXT,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          processed_at DATETIME
        )
      `)
      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(points_withdrawals)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        const addColumn = (name, ddl) => {
          if (!columns.includes(name)) {
            database.run(`ALTER TABLE points_withdrawals ADD COLUMN ${ddl}`)
            changed = true
          }
        }

        addColumn('user_id', 'user_id INTEGER')
        addColumn('points', 'points INTEGER')
        addColumn('cash_amount', 'cash_amount TEXT')
        addColumn('method', 'method TEXT')
        addColumn('payout_account', 'payout_account TEXT')
        addColumn('status', "status TEXT DEFAULT 'pending'")
        addColumn('remark', 'remark TEXT')
        addColumn('created_at', "created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
        addColumn('updated_at', "updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
        addColumn('processed_at', 'processed_at DATETIME')
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 points_withdrawals 表:', error)
  }

  database.run('CREATE INDEX IF NOT EXISTS idx_points_withdrawals_user_created ON points_withdrawals(user_id, created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_points_withdrawals_status_created ON points_withdrawals(status, created_at)')

  return changed
}

const ensurePointsLedgerTable = (database) => {
  if (!database) return false
  let changed = false

  try {
    const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="points_ledger"')
    if (tableExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS points_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          delta_points INTEGER NOT NULL,
          points_before INTEGER NOT NULL,
          points_after INTEGER NOT NULL,
          action TEXT NOT NULL,
          ref_type TEXT,
          ref_id TEXT,
          remark TEXT,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
        )
      `)
      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(points_ledger)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        const addColumn = (name, ddl) => {
          if (!columns.includes(name)) {
            database.run(`ALTER TABLE points_ledger ADD COLUMN ${ddl}`)
            changed = true
          }
        }

        addColumn('user_id', 'user_id INTEGER')
        addColumn('delta_points', 'delta_points INTEGER')
        addColumn('points_before', 'points_before INTEGER')
        addColumn('points_after', 'points_after INTEGER')
        addColumn('action', "action TEXT DEFAULT ''")
        addColumn('ref_type', 'ref_type TEXT')
        addColumn('ref_id', 'ref_id TEXT')
        addColumn('remark', 'remark TEXT')
        addColumn('created_at', "created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 points_ledger 表:', error)
  }

  database.run('CREATE INDEX IF NOT EXISTS idx_points_ledger_user_created ON points_ledger(user_id, created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_points_ledger_user_id_id ON points_ledger(user_id, id)')

  return changed
}

const ensureCreditOrdersTable = (database) => {
  if (!database) return false
  let changed = false

  try {
    const tableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="credit_orders"')
    if (tableExists.length === 0) {
      database.run(`
        CREATE TABLE IF NOT EXISTS credit_orders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_no TEXT NOT NULL UNIQUE,
          trade_no TEXT,
          uid TEXT NOT NULL,
          username TEXT,
          order_email TEXT,
          scene TEXT NOT NULL,
          title TEXT NOT NULL,
          amount TEXT NOT NULL,
          status TEXT DEFAULT 'created',
          pay_url TEXT,
          target_account_id INTEGER,
          code_id INTEGER,
          code TEXT,
          code_account_email TEXT,
          action_status TEXT,
          action_message TEXT,
          action_payload TEXT,
          action_result TEXT,
          query_payload TEXT,
          query_at DATETIME,
          query_status INTEGER,
          notify_payload TEXT,
          notify_at DATETIME,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          paid_at DATETIME,
          refunded_at DATETIME,
          refund_message TEXT
        )
      `)
      changed = true
    } else {
      const tableInfo = database.exec('PRAGMA table_info(credit_orders)')
      if (tableInfo.length > 0) {
        const columns = tableInfo[0].values.map(row => row[1])
        const addColumn = (name, ddl) => {
          if (!columns.includes(name)) {
            database.run(`ALTER TABLE credit_orders ADD COLUMN ${ddl}`)
            changed = true
          }
        }

        addColumn('order_no', 'order_no TEXT')
        addColumn('trade_no', 'trade_no TEXT')
        addColumn('uid', 'uid TEXT')
        addColumn('username', 'username TEXT')
        addColumn('order_email', 'order_email TEXT')
        addColumn('scene', 'scene TEXT')
        addColumn('title', 'title TEXT')
        addColumn('amount', 'amount TEXT')
        addColumn('status', 'status TEXT DEFAULT \'created\'')
        addColumn('pay_url', 'pay_url TEXT')
        addColumn('target_account_id', 'target_account_id INTEGER')
        addColumn('code_id', 'code_id INTEGER')
        addColumn('code', 'code TEXT')
        addColumn('code_account_email', 'code_account_email TEXT')
        addColumn('action_status', 'action_status TEXT')
        addColumn('action_message', 'action_message TEXT')
        addColumn('action_payload', 'action_payload TEXT')
        addColumn('action_result', 'action_result TEXT')
        addColumn('query_payload', 'query_payload TEXT')
        addColumn('query_at', 'query_at DATETIME')
        addColumn('query_status', 'query_status INTEGER')
        addColumn('notify_payload', 'notify_payload TEXT')
        addColumn('notify_at', 'notify_at DATETIME')
        addColumn('created_at', "created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
        addColumn('updated_at', "updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))")
        addColumn('paid_at', 'paid_at DATETIME')
        addColumn('refunded_at', 'refunded_at DATETIME')
        addColumn('refund_message', 'refund_message TEXT')
      }
    }
  } catch (error) {
    console.warn('[DB] 无法初始化 credit_orders 表:', error)
  }

  database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_orders_order_no ON credit_orders(order_no)')
  database.run('CREATE INDEX IF NOT EXISTS idx_credit_orders_trade_no ON credit_orders(trade_no)')
  database.run('CREATE INDEX IF NOT EXISTS idx_credit_orders_uid_created ON credit_orders(uid, created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_credit_orders_status_created ON credit_orders(status, created_at)')
  database.run('CREATE INDEX IF NOT EXISTS idx_credit_orders_scene ON credit_orders(scene, created_at)')

  return changed
}

const ensureAccountExceptionHistoryTable = (database) => {
  if (!database) return false
  let changed = false

  const tableExistsResult = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="account_exception_history"')
  if (tableExistsResult.length === 0) {
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS account_exception_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL,
          account_name TEXT,
          exception_type TEXT NOT NULL,
          exception_code TEXT,
          exception_message TEXT,
          source TEXT,
          first_seen_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          last_seen_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          status TEXT DEFAULT 'active',
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
          UNIQUE(account_id)
        )
      `)
      changed = true
    } catch (error) {
      console.warn('[DB] 无法创建 account_exception_history 表:', error)
    }
  }

  const parseFailuresTableExists = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="account_exception_parse_failures"')
  if (parseFailuresTableExists.length === 0) {
    try {
      database.run(`
        CREATE TABLE IF NOT EXISTS account_exception_parse_failures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT,
          reason TEXT,
          raw_payload TEXT,
          created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
        )
      `)
      changed = true
    } catch (error) {
      console.warn('[DB] 无法创建 account_exception_parse_failures 表:', error)
    }
  }

  database.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_account_exception_history_account_id ON account_exception_history (account_id)')
  database.run('CREATE INDEX IF NOT EXISTS idx_account_exception_history_last_seen ON account_exception_history (last_seen_at DESC)')
  database.run('CREATE INDEX IF NOT EXISTS idx_account_exception_history_type ON account_exception_history (exception_type)')
  database.run('CREATE INDEX IF NOT EXISTS idx_account_exception_history_status ON account_exception_history (status)')
  database.run('CREATE INDEX IF NOT EXISTS idx_account_exception_parse_failures_created_at ON account_exception_parse_failures (created_at DESC)')

  return changed
}

// 获取数据库路径（优先使用环境变量，否则使用默认路径）
function getDatabasePath() {
  if (process.env.DATABASE_PATH) {
    return process.env.DATABASE_PATH
  }
  // 默认路径：backend/db/database.sqlite
  const dbDir = path.join(dirname(dirname(__dirname)), 'db')
  // 确保目录存在
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }
  return path.join(dbDir, 'database.sqlite')
}

export async function getDatabase() {
  if (!db) {
    const SQL = await initSqlJs()

    // Try to load existing database
    const dbPath = getDatabasePath()
    try {
      const buffer = fs.readFileSync(dbPath)
      db = new SQL.Database(buffer)
    } catch (err) {
      // Create new database if it doesn't exist
      db = new SQL.Database()
    }
  }
  return db
}

export async function saveDatabase() {
  const database = db || (await getDatabase())
  const data = database.export()
  const buffer = Buffer.from(data)
  const dbPath = getDatabasePath()

  // 确保目录存在
  const dbDir = path.dirname(dbPath)
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }

  fs.writeFileSync(dbPath, buffer)
}

export async function initDatabase() {
  const database = await getDatabase()
  const dbPath = getDatabasePath()

  // 检查数据库文件是否已存在且表已经创建
  const dbFileExists = fs.existsSync(dbPath)

  if (dbFileExists) {
    // 检查是否已经有完整的表结构
    try {
      const usersTable = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="users"')
      const gptAccountsTable = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="gpt_accounts"')
      const redemptionCodesTable = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="redemption_codes"')
      const systemConfigTable = database.exec('SELECT name FROM sqlite_master WHERE type="table" AND name="system_config"')

      if (usersTable.length > 0 && gptAccountsTable.length > 0 && redemptionCodesTable.length > 0 && systemConfigTable.length > 0) {
        console.log('数据库已存在且表结构完整，跳过初始化')

        const waitingRoomCreated = ensureWaitingRoomTable(database)
        const openAccountSeatProtectionsCreated = ensureOpenAccountSeatProtectionsTable(database)
        const xhsTablesCreated = ensureXhsTables(database)
        const xianyuTablesCreated = ensureXianyuTables(database)
        const linuxDoUsersCreated = ensureLinuxDoUsersTable(database)
        const accountRecoveryCreated = ensureAccountRecoveryTable(database)
        const purchaseOrdersCreated = ensurePurchaseOrdersTable(database)
        const creditOrdersCreated = ensureCreditOrdersTable(database)
        const pointsWithdrawalsCreated = ensurePointsWithdrawalsTable(database)
        const pointsLedgerCreated = ensurePointsLedgerTable(database)
        const accountExceptionHistoryCreated = ensureAccountExceptionHistoryTable(database)
        const rbacInitialized = ensureRbacTables(database)
        if (waitingRoomCreated || openAccountSeatProtectionsCreated || xhsTablesCreated || xianyuTablesCreated || linuxDoUsersCreated || accountRecoveryCreated || purchaseOrdersCreated || creditOrdersCreated || pointsWithdrawalsCreated || pointsLedgerCreated || accountExceptionHistoryCreated || rbacInitialized) {
          saveDatabase()
        }

        // 只执行必要的列添加检查（用于数据库升级）
        try {
          // 检查 gpt_accounts 表的列
          const tableInfo = database.exec('PRAGMA table_info(gpt_accounts)')
          if (tableInfo.length > 0) {
            const columns = tableInfo[0].values.map(row => row[1])

            if (!columns.includes('chatgpt_account_id')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN chatgpt_account_id TEXT')
              console.log('已添加 chatgpt_account_id 列到 gpt_accounts 表')
              saveDatabase()
            }

            if (!columns.includes('oai_device_id')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN oai_device_id TEXT')
              console.log('已添加 oai_device_id 列到 gpt_accounts 表')
              saveDatabase()
            }

            if (!columns.includes('refresh_token')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN refresh_token TEXT')
              console.log('已添加 refresh_token 列到 gpt_accounts 表')
              saveDatabase()
            }

            if (!columns.includes('invite_count')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN invite_count INTEGER DEFAULT 0')
              console.log('已添加 invite_count 列到 gpt_accounts 表')
              saveDatabase()
            }

            if (!columns.includes('is_open')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN is_open INTEGER DEFAULT 0')
              console.log('已添加 is_open 列到 gpt_accounts 表')
              saveDatabase()
            }

            if (!columns.includes('is_demoted')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN is_demoted INTEGER DEFAULT 0')
              console.log('已添加 is_demoted 列到 gpt_accounts 表')
              saveDatabase()
            }

	            if (!columns.includes('expire_at')) {
	              database.run('ALTER TABLE gpt_accounts ADD COLUMN expire_at TEXT')
	              console.log('已添加 expire_at 列到 gpt_accounts 表')
	              saveDatabase()
	            }

	            if (!columns.includes('is_banned')) {
	              database.run('ALTER TABLE gpt_accounts ADD COLUMN is_banned INTEGER DEFAULT 0')
	              console.log('已添加 is_banned 列到 gpt_accounts 表')
	              saveDatabase()
	            }

	            if (!columns.includes('ban_processed')) {
	              database.run('ALTER TABLE gpt_accounts ADD COLUMN ban_processed INTEGER DEFAULT 0')
	              console.log('已添加 ban_processed 列到 gpt_accounts 表')
	              saveDatabase()
	            }

	            if (!columns.includes('space_type')) {
	              database.run("ALTER TABLE gpt_accounts ADD COLUMN space_type TEXT DEFAULT 'child'")
	              console.log('已添加 space_type 列到 gpt_accounts 表')
	              saveDatabase()
	            }

	            if (!columns.includes('space_name')) {
	              database.run('ALTER TABLE gpt_accounts ADD COLUMN space_name TEXT')
	              console.log('已添加 space_name 列到 gpt_accounts 表')
	              saveDatabase()
	            }

            if (!columns.includes('sort_order')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN sort_order INTEGER DEFAULT 0')
              console.log('已添加 sort_order 列到 gpt_accounts 表')
              saveDatabase()
            }

            if (!columns.includes('space_status_code')) {
              database.run("ALTER TABLE gpt_accounts ADD COLUMN space_status_code TEXT DEFAULT 'normal'")
              console.log('已添加 space_status_code 列到 gpt_accounts 表')
              saveDatabase()
            }

            if (!columns.includes('space_status_reason')) {
              database.run('ALTER TABLE gpt_accounts ADD COLUMN space_status_reason TEXT')
              console.log('已添加 space_status_reason 列到 gpt_accounts 表')
              saveDatabase()
            }
	          }

	          // 检查 redemption_codes 表的列
	          const redemptionTableInfo = database.exec('PRAGMA table_info(redemption_codes)')
          if (redemptionTableInfo.length > 0) {
            const redemptionColumns = redemptionTableInfo[0].values.map(row => row[1])

            if (!redemptionColumns.includes('account_email')) {
              database.run('ALTER TABLE redemption_codes ADD COLUMN account_email TEXT')
              console.log('已添加 account_email 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('channel')) {
              database.run(`ALTER TABLE redemption_codes ADD COLUMN channel TEXT DEFAULT '${DEFAULT_CHANNEL}'`)
              console.log('已添加 channel 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('channel_name')) {
              database.run(`ALTER TABLE redemption_codes ADD COLUMN channel_name TEXT DEFAULT '${DEFAULT_CHANNEL_NAME}'`)
              console.log('已添加 channel_name 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('reserved_for_uid')) {
              database.run('ALTER TABLE redemption_codes ADD COLUMN reserved_for_uid TEXT')
              console.log('已添加 reserved_for_uid 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('reserved_for_username')) {
              database.run('ALTER TABLE redemption_codes ADD COLUMN reserved_for_username TEXT')
              console.log('已添加 reserved_for_username 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('reserved_for_entry_id')) {
              database.run('ALTER TABLE redemption_codes ADD COLUMN reserved_for_entry_id INTEGER')
              console.log('已添加 reserved_for_entry_id 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('reserved_at')) {
              database.run('ALTER TABLE redemption_codes ADD COLUMN reserved_at DATETIME')
              console.log('已添加 reserved_at 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('reserved_for_order_no')) {
              database.run('ALTER TABLE redemption_codes ADD COLUMN reserved_for_order_no TEXT')
              console.log('已添加 reserved_for_order_no 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('reserved_for_order_email')) {
              database.run('ALTER TABLE redemption_codes ADD COLUMN reserved_for_order_email TEXT')
              console.log('已添加 reserved_for_order_email 列到 redemption_codes 表')
              saveDatabase()
            }

            if (!redemptionColumns.includes('order_type')) {
              database.run(`ALTER TABLE redemption_codes ADD COLUMN order_type TEXT DEFAULT 'warranty'`)
              console.log('已添加 order_type 列到 redemption_codes 表')
              saveDatabase()
            }

            database.run(
              `UPDATE redemption_codes SET channel = ? WHERE channel IS NULL OR channel = ''`,
              [DEFAULT_CHANNEL],
            )
            database.run(
              `UPDATE redemption_codes SET channel_name = ? WHERE channel_name IS NULL OR channel_name = ''`,
              [DEFAULT_CHANNEL_NAME],
            )
            database.run(
              `UPDATE redemption_codes SET order_type = 'warranty' WHERE order_type IS NULL OR order_type = ''`
            )
            saveDatabase()
          }
        } catch (err) {
          console.log('列检查/添加已跳过:', err.message)
        }

        const migration = migrateUtcTimestampsToLocaltime(database)
        if (migration.migrated) {
          await saveDatabase()
        }

        return
      }
    } catch (err) {
      console.log('检查表结构时出错，将执行完整初始化:', err.message)
    }
  }

  console.log('开始初始化数据库...')

  // Create users table
  database.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT NOT NULL,
      telegram_id TEXT,
      created_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
    )
  `)

  // Create system_config table for storing API keys and other settings
  database.run(`
    CREATE TABLE IF NOT EXISTS system_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      config_key TEXT UNIQUE NOT NULL,
      config_value TEXT NOT NULL,
      updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
    )
  `)

  // Create gpt_accounts table to manage GPT accounts
  database.run(`
	    CREATE TABLE IF NOT EXISTS gpt_accounts (
	      id INTEGER PRIMARY KEY AUTOINCREMENT,
	      email TEXT NOT NULL,
	      token TEXT NOT NULL,
	      refresh_token TEXT,
	      user_count INTEGER DEFAULT 0,
	      invite_count INTEGER DEFAULT 0,
	      chatgpt_account_id TEXT,
	      oai_device_id TEXT,
	      expire_at TEXT,
	      is_open INTEGER DEFAULT 0,
	      is_demoted INTEGER DEFAULT 0,
	      is_banned INTEGER DEFAULT 0,
	      ban_processed INTEGER DEFAULT 0,
	      sort_order INTEGER DEFAULT 0,
	      space_type TEXT DEFAULT 'child',
	      space_name TEXT,
	      space_status_code TEXT DEFAULT 'normal',
	      space_status_reason TEXT,
	      created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
	      updated_at DATETIME DEFAULT (DATETIME('now', 'localtime'))
	    )
	  `)

  // Create redemption_codes table to manage redemption codes
  database.run(`
    CREATE TABLE IF NOT EXISTS redemption_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      is_redeemed INTEGER DEFAULT 0,
      redeemed_at DATETIME,
      redeemed_by TEXT,
      account_email TEXT,
      channel TEXT DEFAULT '${DEFAULT_CHANNEL}',
      channel_name TEXT DEFAULT '${DEFAULT_CHANNEL_NAME}',
      order_type TEXT DEFAULT 'warranty',
      created_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
      updated_at DATETIME DEFAULT (DATETIME('now', 'localtime')),
      reserved_for_uid TEXT,
      reserved_for_username TEXT,
      reserved_for_entry_id INTEGER,
      reserved_at DATETIME,
      reserved_for_order_no TEXT,
      reserved_for_order_email TEXT
    )
  `)

  const waitingRoomInitialized = ensureWaitingRoomTable(database)
  const openAccountSeatProtectionsInitialized = ensureOpenAccountSeatProtectionsTable(database)
  const gptAccountMembersInitialized = ensureGptAccountMembersTable(database)
  const xhsTablesInitialized = ensureXhsTables(database)
  const xianyuTablesInitialized = ensureXianyuTables(database)
  const linuxDoUsersInitialized = ensureLinuxDoUsersTable(database)
  const accountRecoveryInitialized = ensureAccountRecoveryTable(database)
  const purchaseOrdersInitialized = ensurePurchaseOrdersTable(database)
  const creditOrdersInitialized = ensureCreditOrdersTable(database)
  const pointsWithdrawalsInitialized = ensurePointsWithdrawalsTable(database)
  const pointsLedgerInitialized = ensurePointsLedgerTable(database)
  const accountExceptionHistoryInitialized = ensureAccountExceptionHistoryTable(database)
  if (waitingRoomInitialized || openAccountSeatProtectionsInitialized || gptAccountMembersInitialized || xhsTablesInitialized || xianyuTablesInitialized || linuxDoUsersInitialized || accountRecoveryInitialized || purchaseOrdersInitialized || creditOrdersInitialized || pointsWithdrawalsInitialized || pointsLedgerInitialized || accountExceptionHistoryInitialized) {
    saveDatabase()
  }

  // Check if columns exist and add them if they don't (for existing databases)
  try {
    const tableInfo = database.exec('PRAGMA table_info(gpt_accounts)')
    if (tableInfo.length > 0) {
      const columns = tableInfo[0].values.map(row => row[1])

      if (!columns.includes('chatgpt_account_id')) {
        database.run('ALTER TABLE gpt_accounts ADD COLUMN chatgpt_account_id TEXT')
        console.log('已添加 chatgpt_account_id 列到 gpt_accounts 表')
      }

      if (!columns.includes('oai_device_id')) {
        database.run('ALTER TABLE gpt_accounts ADD COLUMN oai_device_id TEXT')
        console.log('已添加 oai_device_id 列到 gpt_accounts 表')
      }

      if (!columns.includes('refresh_token')) {
        database.run('ALTER TABLE gpt_accounts ADD COLUMN refresh_token TEXT')
        console.log('已添加 refresh_token 列到 gpt_accounts 表')
      }

      if (!columns.includes('invite_count')) {
        database.run('ALTER TABLE gpt_accounts ADD COLUMN invite_count INTEGER DEFAULT 0')
        console.log('已添加 invite_count 列到 gpt_accounts 表')
      }

      if (!columns.includes('is_open')) {
        database.run('ALTER TABLE gpt_accounts ADD COLUMN is_open INTEGER DEFAULT 0')
        console.log('已添加 is_open 列到 gpt_accounts 表')
      }

      if (!columns.includes('is_demoted')) {
        database.run('ALTER TABLE gpt_accounts ADD COLUMN is_demoted INTEGER DEFAULT 0')
        console.log('已添加 is_demoted 列到 gpt_accounts 表')
      }

	      if (!columns.includes('expire_at')) {
	        database.run('ALTER TABLE gpt_accounts ADD COLUMN expire_at TEXT')
	        console.log('已添加 expire_at 列到 gpt_accounts 表')
	      }

	      if (!columns.includes('is_banned')) {
	        database.run('ALTER TABLE gpt_accounts ADD COLUMN is_banned INTEGER DEFAULT 0')
	        console.log('已添加 is_banned 列到 gpt_accounts 表')
	      }

	      if (!columns.includes('ban_processed')) {
	        database.run('ALTER TABLE gpt_accounts ADD COLUMN ban_processed INTEGER DEFAULT 0')
	        console.log('已添加 ban_processed 列到 gpt_accounts 表')
	      }

	      if (!columns.includes('sort_order')) {
	        database.run('ALTER TABLE gpt_accounts ADD COLUMN sort_order INTEGER DEFAULT 0')
	        console.log('已添加 sort_order 列到 gpt_accounts 表')
	      }

	      if (!columns.includes('space_type')) {
	        database.run("ALTER TABLE gpt_accounts ADD COLUMN space_type TEXT DEFAULT 'child'")
	        console.log('已添加 space_type 列到 gpt_accounts 表')
	      }

	      if (!columns.includes('space_name')) {
	        database.run('ALTER TABLE gpt_accounts ADD COLUMN space_name TEXT')
	        console.log('已添加 space_name 列到 gpt_accounts 表')
	      }

	      if (!columns.includes('space_status_code')) {
	        database.run("ALTER TABLE gpt_accounts ADD COLUMN space_status_code TEXT DEFAULT 'normal'")
	        console.log('已添加 space_status_code 列到 gpt_accounts 表')
	      }

	      if (!columns.includes('space_status_reason')) {
	        database.run('ALTER TABLE gpt_accounts ADD COLUMN space_status_reason TEXT')
	        console.log('已添加 space_status_reason 列到 gpt_accounts 表')
	      }

	      database.run(`
	        UPDATE gpt_accounts
	        SET space_type = COALESCE(NULLIF(space_type, ''), 'child')
	      `)

	      database.run(`
	        UPDATE gpt_accounts
	        SET sort_order = id
	        WHERE COALESCE(sort_order, 0) = 0
	      `)
	    }
	  } catch (err) {
	    console.log('列检查/添加已跳过:', err.message)
	  }

  // Check if admin user exists
  const adminUserResult = database.exec('SELECT id FROM users WHERE username = ? LIMIT 1', ['admin'])
  const adminUserExists = Boolean(adminUserResult?.[0]?.values?.length)

  if (!adminUserExists) {
    // Create default admin user
    const envPassword = String(process.env.INIT_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '').trim()
    const generatedPassword = crypto.randomBytes(16).toString('hex')
    const plainPassword = envPassword || generatedPassword
    const hashedPassword = bcrypt.hashSync(plainPassword, 10)
    database.run(
      `INSERT INTO users (username, password, email, created_at) VALUES (?, ?, ?, DATETIME('now', 'localtime'))`,
      ['admin', hashedPassword, 'admin@example.com']
    )

    console.log('默认管理员用户已创建: username=admin')
    if (envPassword) {
      console.log('初始密码已从环境变量 INIT_ADMIN_PASSWORD 读取')
    } else {
      console.log('初始密码(随机生成):', plainPassword)
    }
    console.log('请尽快登录后台修改密码')
  }

  ensureRbacTables(database)

  // Check if GPT accounts exist, if not create some sample data
  const gptAccountsResult = database.exec('SELECT COUNT(*) as count FROM gpt_accounts')
  const gptAccountsCount = gptAccountsResult[0]?.values[0]?.[0] || 0


  // Initialize default API key if not exists
  const apiKeyResult = database.exec(
    'SELECT config_value FROM system_config WHERE config_key = ? LIMIT 1',
    ['auto_boarding_api_key']
  )
  const hasApiKeyRow = Boolean(apiKeyResult?.[0]?.values?.length)
  const existingApiKey = hasApiKeyRow ? String(apiKeyResult[0].values[0][0] || '').trim() : ''

  if (!existingApiKey) {
    const envApiKey = String(process.env.AUTO_BOARDING_API_KEY || '').trim()

    if (envApiKey) {
      if (envApiKey.length < 16) {
        console.warn('[SECURITY] AUTO_BOARDING_API_KEY 太短，已跳过初始化（至少 16 位）')
      } else if (hasApiKeyRow) {
        database.run(
          'UPDATE system_config SET config_value = ?, updated_at = DATETIME(\'now\', \'localtime\') WHERE config_key = ?',
          [envApiKey, 'auto_boarding_api_key']
        )
        console.log('auto_boarding_api_key 已从环境变量更新')
      } else {
        database.run(
          'INSERT INTO system_config (config_key, config_value, updated_at) VALUES (?, ?, DATETIME(\'now\', \'localtime\'))',
          ['auto_boarding_api_key', envApiKey]
        )
        console.log('auto_boarding_api_key 已从环境变量初始化')
      }
    } else {
      console.log('未配置 auto_boarding_api_key，外部 API 默认禁用（可在后台系统设置中配置）')
    }
  }

  setUserVersion(database, LOCALTIME_MIGRATION_USER_VERSION)
  saveDatabase()
  console.log('数据库初始化成功')
}
