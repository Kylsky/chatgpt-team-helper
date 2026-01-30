import axios from 'axios'

// 动态获取 API URL
// 生产环境使用相对路径，自动使用当前域名
// 开发环境使用 localhost
const getApiUrl = () => {
  // 如果有环境变量配置，优先使用
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL
  }

  // 生产环境：使用相对路径（会自动使用当前域名）
  if (import.meta.env.PROD) {
    // 如果部署在子路径，可以在这里配置
    return '/api'
  }

  // 开发环境：使用 localhost
  return 'http://localhost:3000/api'
}

const API_URL = getApiUrl()

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  }
})

const notifyAuthUpdated = () => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('auth-updated'))
}

// Add token to requests if available
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export const authService = {
  async login(username: string, password: string) {
    const response = await api.post('/auth/login', { username, password })
    if (response.data.token) {
      localStorage.setItem('token', response.data.token)
      localStorage.setItem('user', JSON.stringify(response.data.user))
      notifyAuthUpdated()
    }
    return response.data
  },

  async sendRegisterCode(email: string) {
    const response = await api.post('/auth/register/send-code', { email })
    return response.data
  },

  async register(payload: { email: string; code: string; password: string; inviteCode?: string }) {
    const response = await api.post('/auth/register', payload)
    if (response.data.token) {
      localStorage.setItem('token', response.data.token)
      localStorage.setItem('user', JSON.stringify(response.data.user))
      notifyAuthUpdated()
    }
    return response.data
  },

  setCurrentUser(user: any) {
    localStorage.setItem('user', JSON.stringify(user))
    notifyAuthUpdated()
  },

  logout() {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    notifyAuthUpdated()
  },

  getCurrentUser() {
    const userStr = localStorage.getItem('user')
    return userStr ? JSON.parse(userStr) : null
  },

  isAuthenticated() {
    return !!localStorage.getItem('token')
  }
}

export const userService = {
  async getStats() {
    const response = await api.get('/user/stats')
    return response.data
  },

  async getMe() {
    const response = await api.get('/user/me')
    return response.data
  },

  async getInviteCode(): Promise<{ inviteCode: string | null }> {
    const response = await api.get('/user/invite-code')
    return response.data
  },

  async getInviteSummary(): Promise<{ inviteCode: string | null; points: number; invitedCount: number }> {
    const response = await api.get('/user/invite-summary')
    return response.data
  },

  async updateUsername(username: string): Promise<{ message: string; user: any }> {
    const response = await api.put('/user/username', { username })
    return response.data
  },

  async generateInviteCode(): Promise<{ inviteCode: string }> {
    const response = await api.post('/user/invite-code')
    return response.data
  },

  async changePassword(currentPassword: string, newPassword: string) {
    const response = await api.put('/user/change-password', {
      currentPassword,
      newPassword
    })
    return response.data
  },

  async getApiKey() {
    const response = await api.get('/user/api-key')
    return response.data
  },

  async updateApiKey(apiKey: string) {
    const response = await api.put('/user/api-key', {
      apiKey
    })
    return response.data
  },

  async getPointsMeta(): Promise<PointsMetaResponse> {
    const response = await api.get('/user/points/meta')
    return response.data
  },

  async redeemTeamSeat(payload?: { email?: string; seatType?: TeamSeatType }): Promise<PointsRedeemTeamSeatResponse> {
    const response = await api.post('/user/points/redeem/team', payload || {})
    return response.data
  },

  async redeemInviteUnlock(): Promise<PointsRedeemInviteUnlockResponse> {
    const response = await api.post('/user/points/redeem/invite')
    return response.data
  },

  async listWithdrawals(limit: number = 20): Promise<PointsWithdrawalsResponse> {
    const response = await api.get('/user/points/withdrawals', { params: { limit } })
    return response.data
  },

  async listPointsLedger(limit: number = 20, beforeId?: number): Promise<PointsLedgerResponse> {
    const response = await api.get('/user/points/ledger', { params: { limit, ...(beforeId ? { beforeId } : {}) } })
    return response.data
  },

  async requestWithdrawal(payload: { points: number; method: 'alipay' | 'wechat'; payoutAccount: string }): Promise<PointsWithdrawRequestResponse> {
    const response = await api.post('/user/points/withdraw', payload)
    return response.data
  }
}

export type TeamSeatType = 'undemoted' | 'demoted'

export interface PointsMetaResponse {
  points: number
  seat: {
    costPoints: number
    remaining: number
    remainingByType?: Record<TeamSeatType, number>
    defaultType?: TeamSeatType
  }
  withdraw: {
    enabled: boolean
    rate?: {
      points: number
      cashCents: number
    }
    minPoints?: number
    stepPoints?: number
    maxPointsPerRequest?: number
    dailyMaxPoints?: number
    dailyMaxRequests?: number
    maxPending?: number
    cooldownSeconds?: number
  }
}

export interface PointsWithdrawRecord {
  id: number
  points: number
  cashAmount?: string | null
  method: 'alipay' | 'wechat' | string
  payoutAccount: string
  status: 'pending' | 'approved' | 'rejected' | 'paid' | string
  remark?: string | null
  createdAt: string
  updatedAt: string
  processedAt?: string | null
}

export interface PointsWithdrawalsResponse {
  withdrawals: PointsWithdrawRecord[]
}

export interface PointsWithdrawRequestResponse {
  message: string
  points: number
  withdrawal: PointsWithdrawRecord | null
}

export interface PointsLedgerRecord {
  id: number
  deltaPoints: number
  pointsBefore: number
  pointsAfter: number
  action: string
  refType?: string | null
  refId?: string | null
  remark?: string | null
  createdAt?: string | null
}

export interface PointsLedgerResponse {
  records: PointsLedgerRecord[]
  page: {
    limit: number
    hasMore: boolean
    nextBeforeId: number | null
  }
}

export interface PointsRedeemTeamSeatResponse {
  message: string
  points: number
  seat: {
    costPoints: number
    remaining: number
    remainingByType?: Record<TeamSeatType, number>
    defaultType?: TeamSeatType
  }
  redemption: any
}

export interface PointsRedeemInviteUnlockResponse {
  message: string
  points: number
  invite: {
    enabled: boolean
    costPoints: number
  }
}

export interface GptAccount {
  id: number
  email: string
  token: string
  refreshToken?: string
  userCount: number
  inviteCount?: number
  isOpen?: boolean
  isDemoted?: boolean
  isBanned?: boolean
  chatgptAccountId?: string
  oaiDeviceId?: string
  expireAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateGptAccountDto {
  email: string
  token: string
  refreshToken?: string
  userCount?: number
  isDemoted?: boolean
  isBanned?: boolean
  chatgptAccountId: string
  oaiDeviceId?: string
  expireAt?: string
}

export interface ChatgptAccountUser {
  id: string
  account_user_id?: string
  email?: string
  role?: string
  name?: string
  created_time?: string
  is_scim_managed?: boolean
}

export interface ChatgptAccountUsersResponse {
  items: ChatgptAccountUser[]
  total: number
  limit: number
  offset: number
}

export interface ChatgptAccountInviteItem {
  id: string
  email_address?: string
  role?: string
  created_time?: string
  is_scim_managed?: boolean
}

export interface ChatgptAccountInvitesResponse {
  items: ChatgptAccountInviteItem[]
  total: number
  limit: number
  offset: number
}

export interface SyncUserCountResponse {
  message: string
  account: GptAccount
  syncedUserCount: number
  inviteCount?: number
  users: ChatgptAccountUsersResponse
}

export interface InviteUserResponse {
  message: string
  invite: any
}

export interface DeleteInviteResponse {
  message: string
  result?: any
  account: GptAccount
  inviteCount: number
}

export interface RefreshTokenResponse {
  message: string
  account: GptAccount
  accessToken: string
  idToken?: string
  refreshToken?: string
  expiresIn?: number
}

export type RedemptionChannel = 'common' | 'linux-do' | 'xhs' | 'xianyu' | 'artisan-flow'
export type PurchaseOrderType = 'warranty' | 'no_warranty' | 'anti_ban'

export interface RedemptionCode {
  id: number
  code: string
  isRedeemed: boolean
  redeemedAt?: string
  redeemedBy?: string
  accountEmail?: string
  channel: RedemptionChannel
  channelName?: string
  orderType?: PurchaseOrderType | null
  createdAt: string
  updatedAt: string
  reservedForUid?: string | null
  reservedForUsername?: string | null
  reservedForEntryId?: number | null
  reservedAt?: string | null
}

export interface AccountRecoveryData {
  accountEmail: string
  userCount?: number | null
  inviteStatus?: string
  recoveryMode?: 'original' | 'open-account' | 'not-needed'
  windowEndsAt?: string | null
}

export interface AppRuntimeConfig {
  timezone: string
  locale: string
  turnstileSiteKey?: string | null
  turnstileEnabled?: boolean
  features?: {
    xhs?: boolean
    xianyu?: boolean
    payment?: boolean
    openAccounts?: boolean
  }
  openAccountsEnabled?: boolean
  openAccountsMaintenanceMessage?: string | null
}

export interface PurchaseMeta {
  productName: string
  amount: string
  serviceDays: number
  availableCount: number
  plans?: PurchasePlan[]
}

export interface PurchasePlan {
  key: PurchaseOrderType
  productName: string
  amount: string
  serviceDays: number
  availableCount: number
  buyerRewardPoints?: number
  inviteRewardPoints?: number
}

export interface PurchaseCreateOrderResponse {
  orderNo: string
  amount: string
  productName: string
  orderType?: PurchaseOrderType
  payType: 'alipay' | 'wxpay'
  payUrl?: string | null
  qrcode?: string | null
  img?: string | null
}

export interface PurchaseOrder {
  orderNo: string
  tradeNo?: string | null
  email: string
  productName: string
  amount: string
  serviceDays: number
  orderType?: PurchaseOrderType
  payType?: 'alipay' | 'wxpay' | null
  payUrl?: string | null
  qrcode?: string | null
  img?: string | null
  status: string
  createdAt: string
  paidAt?: string | null
  redeemedAt?: string | null
  inviteStatus?: string | null
  redeemError?: string | null
  refundedAt?: string | null
  refundAmount?: string | null
  refundMessage?: string | null
  emailSentAt?: string | null
}

export interface PurchaseOrderQueryResponse {
  order: PurchaseOrder
  refundable: boolean
  computedRefundAmount: string
  refundMeta?: any
}

export interface XhsConfig {
  id: number
  syncEnabled: boolean
  syncIntervalHours: number
  lastSyncAt?: string | null
  lastSuccessAt?: string | null
  lastError?: string | null
  errorCount?: number
  updatedAt?: string
  cookiesConfigured?: boolean
  authorizationConfigured?: boolean
  extraHeadersConfigured?: boolean
}

export interface XhsOrder {
  id: number
  orderNumber: string
  orderTime?: string | null
  nickname?: string | null
  orderStatus?: string | null
  status: 'pending' | 'redeemed' | 'used' | string
  userEmail?: string | null
  assignedCodeId?: number | null
  assignedCode?: string | null
  isUsed: boolean
  extractedAt?: string | null
  reservedAt?: string | null
  usedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  redemptionCode?: string | null
  redemptionChannel?: RedemptionChannel | null
}

export interface XhsStats {
  total: number
  used: number
  pending: number
  today: number
}

export interface XhsStatus {
  cookiesConfigured: boolean
  lastSyncAt?: string | null
  lastSuccessAt?: string | null
  lastError?: string | null
  errorCount?: number
  syncEnabled: boolean
  syncIntervalHours: number
  isSyncing: boolean
  lastSyncResult?: {
    success: boolean
    created?: number
    skipped?: number
    total?: number
    error?: string
    startedAt?: string
    finishedAt?: string
  } | null
}

export interface XianyuConfig {
  id: number
  syncEnabled: boolean
  syncIntervalHours: number
  lastSyncAt?: string | null
  lastSuccessAt?: string | null
  lastError?: string | null
  errorCount?: number
  updatedAt?: string
  cookiesConfigured?: boolean
}

export interface XianyuOrder {
  id: number
  orderId: string
  orderTime?: string | null
  nickname?: string | null
  orderStatus?: string | null
  status: 'pending' | 'redeemed' | 'used' | string
  userEmail?: string | null
  assignedCodeId?: number | null
  assignedCode?: string | null
  isUsed: boolean
  extractedAt?: string | null
  reservedAt?: string | null
  usedAt?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  redemptionCode?: string | null
  redemptionChannel?: RedemptionChannel | null
  actualPaid?: number | null
}

export interface XianyuStats {
  total: number
  used: number
  pending: number
  today: number
}

export interface XianyuStatus {
  cookiesConfigured: boolean
  lastSyncAt?: string | null
  lastSuccessAt?: string | null
  lastError?: string | null
  errorCount?: number
  syncEnabled: boolean
  syncIntervalHours: number
  isSyncing: boolean
  lastSyncResult?: {
    success: boolean
    created?: number
    skipped?: number
    total?: number
    error?: string
    startedAt?: string
    finishedAt?: string
  } | null
}

export interface LinuxDoUser {
  id: number
  username: string
  name?: string
  avatar_template?: string
  active?: boolean
  trust_level?: number
  silenced?: boolean
  external_ids?: Record<string, unknown>
  email?: string
}

export interface OpenAccountItem {
  id: number
  emailPrefix: string
  joinedCount: number
  pendingCount: number | null
  expireAt?: string | null
  remainingCodes: number
  isDemoted: boolean
  orderType?: string
  creditCost?: string | null
}

export interface OpenAccountsResponse {
  items: OpenAccountItem[]
  total: number
  rules?: {
    creditCost: string
    dailyLimit: number | null
    todayBoardCount: number
    redeemBlockedHours?: { start: number; end: number }
    redeemBlockedNow?: boolean
    redeemBlockedMessage?: string
  }
}

export interface CreditOrder {
  orderNo: string
  tradeNo?: string | null
  scene: string
  title: string
  amount: string
  status: string
  payUrl?: string | null
  targetAccountId?: number | null
  actionStatus?: string | null
  actionMessage?: string | null
  createdAt: string
  paidAt?: string | null
  refundedAt?: string | null
  refundMessage?: string | null
}

export interface CreditOrderQueryResponse {
  order: CreditOrder
}

export interface CreditAdminOrder {
  orderNo: string
  uid: string
  username?: string | null
  scene: string
  title: string
  amount: string
  status: string
  targetAccountId?: number | null
  createdAt: string
  paidAt?: string | null
  refundedAt?: string | null
}

export interface CreditAdminOrdersResponse {
  orders: CreditAdminOrder[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface CreditAdminBalanceResponse {
  paidTotal: string
  refundedTotal: string
  netTotal: string
}

export interface CreditAdminRefundResponse {
  message: string
}

export interface WaitingRoomEntry {
  id: number
  linuxDoUid: string
  linuxDoUsername?: string
  linuxDoName?: string
  linuxDoTrustLevel?: number
  email: string
  status: 'waiting' | 'boarded' | 'left'
  boardedAt?: string | null
  leftAt?: string | null
  createdAt: string
  updatedAt: string
  reservedCodeId?: number | null
  reservedCode?: string | null
  reservedAt?: string | null
  reservedBy?: string | null
  queuePositionSnapshot?: number | null
  queuePosition?: number | null
}

export interface WaitingRoomConfig {
  capacity: number
  minTrustLevel: number
  cooldownDays: number
  enabled: boolean
}

export interface WaitingRoomSnapshot {
  entry: WaitingRoomEntry | null
  queuePosition: number | null
  queuePositionSnapshot?: number | null
  totalWaiting: number
  boardedCount: number
  lastBoardedAt: string | null
  cooldownEndsAt?: string | null
  cooldownActive?: boolean
  config?: WaitingRoomConfig
  cooldownLastBoardedAt?: string | null
  cooldownLastBoardedEmail?: string | null
  cooldownResetAt?: string | null
  message?: string
}

export interface WaitingRoomJoinPayload {
  email: string
  turnstileToken?: string
}

export interface WaitingRoomAdminListResponse {
  entries: WaitingRoomEntry[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
  stats: {
    waiting: number
    boarded: number
    left: number
  }
  config: WaitingRoomConfig
}

export interface BatchCreateResponse {
  message: string
  codes: RedemptionCode[]
  failed: number
}

export interface AdminEmailDomainWhitelistResponse {
  domains: string[]
}

export interface AdminFeatureFlagsResponse {
  features: {
    xhs: boolean
    xianyu: boolean
    payment: boolean
    openAccounts: boolean
  }
}

export interface AdminPointsWithdrawSettingsResponse {
  rate: {
    points: number
    cashCents: number
  }
  minCashCents: number
  minPoints: number
  stepPoints: number
}

export interface AdminSmtpSettingsResponse {
  smtp: {
    host: string
    port: number
    secure: boolean
    user: string
    from: string
    passSet: boolean
    passStored?: boolean
  }
  adminAlertEmail: string
}

export interface AdminLinuxDoOAuthSettingsResponse {
  oauth: {
    clientId: string
    redirectUri: string
    clientIdStored?: boolean
    redirectUriStored?: boolean
    clientSecretSet: boolean
    clientSecretStored?: boolean
  }
}

export interface AdminLinuxDoCreditSettingsResponse {
  credit: {
    pid: string
    pidStored?: boolean
    keySet: boolean
    keyStored?: boolean
  }
}

export interface AdminZpaySettingsResponse {
  zpay: {
    baseUrl: string
    pid: string
    baseUrlStored?: boolean
    pidStored?: boolean
    keySet: boolean
    keyStored?: boolean
  }
}

export interface AdminTurnstileSettingsResponse {
  turnstile: {
    siteKey: string
    siteKeyStored?: boolean
    secretSet: boolean
    secretStored?: boolean
  }
  enabled: boolean
}

export interface AdminTelegramSettingsResponse {
  telegram: {
    allowedUserIds: string
    allowedUserIdsStored?: boolean
    notifyEnabled?: boolean
    notifyEnabledStored?: boolean
    notifyChatIds?: string
    notifyChatIdsStored?: boolean
    notifyTimeoutMs?: number
    notifyTimeoutMsStored?: boolean
    tokenSet: boolean
    tokenStored?: boolean
  }
}

export interface RbacMenu {
  id: number
  menuKey: string
  label: string
  path: string
  parentId?: number | null
  sortOrder?: number
  isActive?: boolean
}

export interface RbacMenuPayload {
  menuKey: string
  label: string
  path: string
  parentId?: number | null
  sortOrder?: number
  isActive?: boolean
}

export interface RbacRole {
  id: number
  roleKey: string
  roleName: string
  description: string
  menuKeys: string[]
}

export interface RbacUserRole {
  roleKey: string
  roleName: string
}

export interface RbacUser {
  id: number
  username: string
  email: string
  createdAt: string
  inviteCode: string | null
  invitedByUserId: number | null
  inviteEnabled: boolean
  roles: RbacUserRole[]
  points?: number
  invitedCount?: number
  orderCount?: number
}

export interface RbacUsersListParams {
  page?: number
  pageSize?: number
  search?: string
}

export interface RbacUsersListResponse {
  users: RbacUser[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface AdminUserPointsLedgerResponse {
  records: PointsLedgerRecord[]
  page: {
    limit: number
    hasMore: boolean
    nextBeforeId?: number | null
  }
}

export interface AdminSetUserPointsResponse {
  user: RbacUser
  ledgerId?: number | null
}

export interface AdminUserOrdersParams {
  page?: number
  pageSize?: number
}

export interface AdminUserOrdersResponse {
  orders: PurchaseOrder[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export const adminService = {
  async getEmailDomainWhitelist(): Promise<AdminEmailDomainWhitelistResponse> {
    const response = await api.get('/admin/email-domain-whitelist')
    return response.data
  },

  async updateEmailDomainWhitelist(domains: string[]): Promise<AdminEmailDomainWhitelistResponse> {
    const response = await api.put('/admin/email-domain-whitelist', { domains })
    return response.data
  },

  async getFeatureFlags(): Promise<AdminFeatureFlagsResponse> {
    const response = await api.get('/admin/feature-flags')
    return response.data
  },

  async updateFeatureFlags(payload: {
    features: {
      xhs: boolean
      xianyu: boolean
      payment: boolean
      openAccounts: boolean
    }
  }): Promise<AdminFeatureFlagsResponse> {
    const response = await api.put('/admin/feature-flags', payload)
    return response.data
  },

  async getPointsWithdrawSettings(): Promise<AdminPointsWithdrawSettingsResponse> {
    const response = await api.get('/admin/points-withdraw-settings')
    return response.data
  },

  async updatePointsWithdrawSettings(payload: { ratePoints: number; rateCashCents: number; minCashCents: number }): Promise<AdminPointsWithdrawSettingsResponse> {
    const response = await api.put('/admin/points-withdraw-settings', {
      rate: {
        points: payload.ratePoints,
        cashCents: payload.rateCashCents,
      },
      minCashCents: payload.minCashCents,
    })
    return response.data
  },

  async getSmtpSettings(): Promise<AdminSmtpSettingsResponse> {
    const response = await api.get('/admin/smtp-settings')
    return response.data
  },

  async updateSmtpSettings(payload: { smtp: { host: string; port: number; secure: boolean; user: string; pass?: string; from?: string }; adminAlertEmail: string }): Promise<AdminSmtpSettingsResponse> {
    const response = await api.put('/admin/smtp-settings', payload)
    return response.data
  },

  async getLinuxDoOAuthSettings(): Promise<AdminLinuxDoOAuthSettingsResponse> {
    const response = await api.get('/admin/linuxdo-oauth-settings')
    return response.data
  },

  async updateLinuxDoOAuthSettings(payload: { oauth: { clientId: string; clientSecret?: string; redirectUri: string } }): Promise<AdminLinuxDoOAuthSettingsResponse> {
    const response = await api.put('/admin/linuxdo-oauth-settings', payload)
    return response.data
  },

  async getLinuxDoCreditSettings(): Promise<AdminLinuxDoCreditSettingsResponse> {
    const response = await api.get('/admin/linuxdo-credit-settings')
    return response.data
  },

  async updateLinuxDoCreditSettings(payload: { credit: { pid: string; key?: string } }): Promise<AdminLinuxDoCreditSettingsResponse> {
    const response = await api.put('/admin/linuxdo-credit-settings', payload)
    return response.data
  },

  async getZpaySettings(): Promise<AdminZpaySettingsResponse> {
    const response = await api.get('/admin/zpay-settings')
    return response.data
  },

  async updateZpaySettings(payload: { zpay: { baseUrl: string; pid: string; key?: string } }): Promise<AdminZpaySettingsResponse> {
    const response = await api.put('/admin/zpay-settings', payload)
    return response.data
  },

  async getTurnstileSettings(): Promise<AdminTurnstileSettingsResponse> {
    const response = await api.get('/admin/turnstile-settings')
    return response.data
  },

  async updateTurnstileSettings(payload: { turnstile: { siteKey: string; secretKey?: string } }): Promise<AdminTurnstileSettingsResponse> {
    const response = await api.put('/admin/turnstile-settings', payload)
    return response.data
  },

  async getTelegramSettings(): Promise<AdminTelegramSettingsResponse> {
    const response = await api.get('/admin/telegram-settings')
    return response.data
  },

  async updateTelegramSettings(payload: {
    telegram: {
      allowedUserIds: string
      botToken?: string
      notifyEnabled?: boolean
      notifyChatIds?: string
      notifyTimeoutMs?: number
    }
  }): Promise<AdminTelegramSettingsResponse> {
    const response = await api.put('/admin/telegram-settings', payload)
    return response.data
  },

  async getMenus(): Promise<{ menus: RbacMenu[] }> {
    const response = await api.get('/admin/rbac/menus')
    return response.data
  },

  async createMenu(payload: RbacMenuPayload): Promise<{ menu: RbacMenu }> {
    const response = await api.post('/admin/rbac/menus', payload)
    return response.data
  },

  async updateMenu(menuId: number, payload: Omit<RbacMenuPayload, 'menuKey'>): Promise<{ menu: RbacMenu }> {
    const response = await api.put(`/admin/rbac/menus/${menuId}`, payload)
    return response.data
  },

  async deleteMenu(menuId: number): Promise<{ message: string }> {
    const response = await api.delete(`/admin/rbac/menus/${menuId}`)
    return response.data
  },

  async getRoles(): Promise<{ roles: RbacRole[] }> {
    const response = await api.get('/admin/rbac/roles')
    return response.data
  },

  async createRole(payload: { roleKey: string; roleName: string; description?: string; menuKeys?: string[] }) {
    const response = await api.post('/admin/rbac/roles', payload)
    return response.data
  },

  async updateRoleMenus(roleId: number, menuKeys: string[]): Promise<{ roleId: number; menuKeys: string[] }> {
    const response = await api.put(`/admin/rbac/roles/${roleId}/menus`, { menuKeys })
    return response.data
  },

  async getUsers(params?: RbacUsersListParams): Promise<RbacUsersListResponse> {
    const response = await api.get('/admin/rbac/users', { params })
    return response.data
  },

  async getUserPointsLedger(userId: number, params?: { limit?: number; beforeId?: number }): Promise<AdminUserPointsLedgerResponse> {
    const response = await api.get(`/admin/rbac/users/${userId}/points-ledger`, { params })
    return response.data
  },

  async setUserPoints(
    userId: number,
    payload: { points: number; expectedPoints?: number }
  ): Promise<AdminSetUserPointsResponse> {
    const response = await api.put(`/admin/rbac/users/${userId}/points`, payload)
    return response.data
  },

  async getUserOrders(userId: number, params?: AdminUserOrdersParams): Promise<AdminUserOrdersResponse> {
    const response = await api.get(`/admin/rbac/users/${userId}/orders`, { params })
    return response.data
  },

  async setUserRoles(userId: number, roleKeys: string[]): Promise<{ userId: number; roleKeys: string[] }> {
    const response = await api.put(`/admin/rbac/users/${userId}/roles`, { roleKeys })
    return response.data
  },

  async updateUser(
    userId: number,
    payload: { username?: string; email?: string; inviteEnabled?: boolean }
  ): Promise<{ user: RbacUser }> {
    const response = await api.put(`/admin/rbac/users/${userId}`, payload)
    return response.data
  },

  async deleteUser(userId: number): Promise<{ message: string }> {
    const response = await api.delete(`/admin/rbac/users/${userId}`)
    return response.data
  },
}

export type AccountRecoveryRedeemState = 'pending' | 'failed' | 'done'

export interface AccountRecoveryBannedAccountsListParams {
  page?: number
  pageSize?: number
  search?: string
  days?: number
}

export interface AccountRecoveryBannedAccountSummary {
  id: number
  email: string
  impactedCount: number
  doneCount: number
  failedCount: number
  pendingCount: number
  latestRedeemedAt: string | null
}

export interface AccountRecoveryBannedAccountsResponse {
  accounts: AccountRecoveryBannedAccountSummary[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface AccountRecoveryBannedAccountRedeemsListParams {
  page?: number
  pageSize?: number
  search?: string
  status?: 'pending' | 'failed' | 'done' | 'all'
  days?: number
}

export interface AccountRecoveryRedeemLatestLog {
  id: number
  status: string
  errorMessage: string | null
  recoveryMode: string | null
  recoveryCode: string | null
  recoveryAccountEmail: string | null
  createdAt: string | null
}

export interface AccountRecoveryBannedAccountRedeem {
  originalCodeId: number
  code: string
  channel: string
  redeemedAt: string | null
  userEmail: string
  originalAccountEmail: string
  state: AccountRecoveryRedeemState
  attempts: number
  latest: AccountRecoveryRedeemLatestLog | null
}

export interface AccountRecoveryBannedAccountRedeemsResponse {
  redeems: AccountRecoveryBannedAccountRedeem[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface AccountRecoveryLogRecord {
  id: number
  email: string
  originalCodeId: number
  originalRedeemedAt: string | null
  originalAccountEmail: string | null
  recoveryMode: string | null
  recoveryCodeId: number | null
  recoveryCode: string | null
  recoveryAccountEmail: string | null
  status: string
  errorMessage: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface AccountRecoveryLogsResponse {
  logs: AccountRecoveryLogRecord[]
}

export interface AccountRecoveryRecoverResult {
  originalCodeId: number
  outcome: string
  message: string
  statusCode?: number
  recovery?: {
    recoveryCodeId: number
    recoveryCode: string
    recoveryAccountEmail: string
  }
}

export interface AccountRecoveryRecoverResponse {
  results: AccountRecoveryRecoverResult[]
}

export interface AccountRecoveryBannedAccountProcessedResponse {
  account: {
    id: number
    email: string
    banProcessed: boolean
    updatedAt: string | null
  }
}

export const accountRecoveryAdminService = {
  async listBannedAccounts(params?: AccountRecoveryBannedAccountsListParams): Promise<AccountRecoveryBannedAccountsResponse> {
    const response = await api.get('/admin/account-recovery/banned-accounts', { params })
    return response.data
  },

  async listBannedAccountRedeems(
    accountId: number,
    params?: AccountRecoveryBannedAccountRedeemsListParams,
  ): Promise<AccountRecoveryBannedAccountRedeemsResponse> {
    const response = await api.get(`/admin/account-recovery/banned-accounts/${accountId}/redeems`, { params })
    return response.data
  },

  async getLogs(originalCodeId: number): Promise<AccountRecoveryLogsResponse> {
    const response = await api.get('/admin/account-recovery/logs', { params: { originalCodeId } })
    return response.data
  },

  async recover(originalCodeIds: number[]): Promise<AccountRecoveryRecoverResponse> {
    const response = await api.post('/admin/account-recovery/recover', { originalCodeIds })
    return response.data
  },

  async setBannedAccountProcessed(accountId: number, processed: boolean = true): Promise<AccountRecoveryBannedAccountProcessedResponse> {
    const response = await api.patch(`/admin/account-recovery/banned-accounts/${accountId}/processed`, { processed })
    return response.data
  },
}

export const configService = {
  async getRuntimeConfig(): Promise<AppRuntimeConfig> {
    const response = await api.get('/config/runtime')
    return response.data
  }
}

export interface VersionInfo {
  version: string
}

export interface LatestVersionInfo {
  version: string
  tagName: string | null
  name: string | null
  publishedAt: string | null
  htmlUrl: string | null
  body: string | null
}

export const versionService = {
  async getVersion(): Promise<VersionInfo> {
    const response = await api.get('/version')
    return response.data
  },

  async getLatest(): Promise<LatestVersionInfo> {
    const response = await api.get('/version/latest')
    return response.data
  }
}

export interface GptAccountsListParams {
  page?: number
  pageSize?: number
  search?: string
  openStatus?: 'open' | 'closed'
}

export interface GptAccountsListResponse {
  accounts: GptAccount[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface CompleteGptAccountInfoResponse {
  email: string | null
  accounts: {
    accountId: string
    name: string | null
    planType: string | null
    expiresAt: string | null
    hasActiveSubscription: boolean
  }[]
}

export const gptAccountService = {
  async completeInfo(token: string): Promise<CompleteGptAccountInfoResponse> {
    const response = await api.post('/gpt-accounts/complete-info', { token })
    return response.data
  },

  async getAll(params?: GptAccountsListParams): Promise<GptAccountsListResponse> {
    const response = await api.get('/gpt-accounts', { params })
    return response.data
  },

  async getById(id: number): Promise<GptAccount> {
    const response = await api.get(`/gpt-accounts/${id}`)
    return response.data
  },

  async create(data: CreateGptAccountDto): Promise<GptAccount> {
    const response = await api.post('/gpt-accounts', data)
    return response.data
  },

  async batchCreate(accounts: Partial<CreateGptAccountDto>[]): Promise<{ results: any[] }> {
    const response = await api.post('/gpt-accounts/batch', { accounts })
    return response.data
  },

  async update(id: number, data: CreateGptAccountDto): Promise<GptAccount> {
    const response = await api.put(`/gpt-accounts/${id}`, data)
    return response.data
  },

  async delete(id: number): Promise<void> {
    await api.delete(`/gpt-accounts/${id}`)
  },

  async syncUserCount(id: number): Promise<SyncUserCountResponse> {
    const response = await api.post(`/gpt-accounts/${id}/sync-user-count`)
    return response.data
  },

  async deleteAccountUser(accountId: number, userId: string): Promise<SyncUserCountResponse> {
    const response = await api.delete(`/gpt-accounts/${accountId}/users/${encodeURIComponent(userId)}`)
    return response.data
  },

  async inviteAccountUser(accountId: number, email: string): Promise<InviteUserResponse> {
    const response = await api.post(`/gpt-accounts/${accountId}/invite-user`, { email })
    return response.data
  },

  async deleteAccountInvite(accountId: number, emailAddress: string): Promise<DeleteInviteResponse> {
    const response = await api.delete(`/gpt-accounts/${accountId}/invites`, {
      data: { email_address: emailAddress }
    })
    return response.data
  },

  async refreshToken(id: number): Promise<RefreshTokenResponse> {
    const response = await api.post(`/gpt-accounts/${id}/refresh-token`)
    return response.data
  },

  async setOpen(id: number, isOpen: boolean): Promise<GptAccount> {
    const response = await api.patch(`/gpt-accounts/${id}/open`, { isOpen })
    return response.data
  },

  async ban(id: number): Promise<GptAccount> {
    const response = await api.patch(`/gpt-accounts/${id}/ban`)
    return response.data
  },

  async getInvites(accountId: number, params?: { offset?: number; limit?: number; query?: string }): Promise<ChatgptAccountInvitesResponse> {
    const response = await api.get(`/gpt-accounts/${accountId}/invites`, { params })
    return response.data
  }
}

export const linuxDoAuthService = {
  async getAuthorizeUrl(redirectUri: string): Promise<{ url: string }> {
    const response = await api.get('/linuxdo/authorize-url', {
      params: { redirectUri },
    })
    return response.data
  },

  async exchangeCode(code: string, redirectUri: string): Promise<{ user: LinuxDoUser | null; sessionToken?: string | null }> {
    const response = await api.post('/linuxdo/exchange', {
      code,
      redirectUri,
    })
    return response.data
  },
}

export interface LinuxDoMe {
  uid: string
  username: string
  email?: string
  currentOpenAccountId?: number | null
}

export const linuxDoUserService = {
  async getMe(sessionToken: string): Promise<LinuxDoMe> {
    const response = await api.get('/linuxdo/me', {
      headers: {
        'x-linuxdo-token': sessionToken
      }
    })
    return response.data
  },

  async updateEmail(sessionToken: string, email: string): Promise<LinuxDoMe> {
    const response = await api.put(
      '/linuxdo/me/email',
      { email },
      {
        headers: {
          'x-linuxdo-token': sessionToken
        }
      }
    )
    return response.data
  }
}

export const linuxDoPreferenceService = {
  async setCurrentOpenAccount(sessionToken: string, accountId: number | null): Promise<Pick<LinuxDoMe, 'uid' | 'username' | 'currentOpenAccountId'>> {
    const response = await api.put(
      '/linuxdo/me/current-open-account',
      { accountId },
      {
        headers: {
          'x-linuxdo-token': sessionToken
        }
      }
    )
    return response.data
  }
}

export const openAccountsService = {
  async list(sessionToken: string): Promise<OpenAccountsResponse> {
    const response = await api.get('/open-accounts', {
      headers: {
        'x-linuxdo-token': sessionToken
      }
    })
    return response.data
  },

  async board(
    sessionToken: string,
    accountId: number,
    options?: { turnstileToken?: string; creditOrderNo?: string }
  ): Promise<
    | { message: string; currentOpenAccountId: number; account?: { id: number; userCount?: number; inviteCount?: number } }
    | {
      requiresCredit: true
      message: string
      creditOrder: {
        orderNo: string
        amount: string
        payUrl?: string | null
        payRequest?: { method?: 'POST' | 'GET'; url: string; fields?: Record<string, string> }
      }
    }
  > {
    const response = await api.post(
      `/open-accounts/${accountId}/board`,
      { turnstileToken: options?.turnstileToken, creditOrderNo: options?.creditOrderNo },
      {
        headers: {
          'x-linuxdo-token': sessionToken
        }
      }
    )
    return response.data
  }
}

export interface CreditAdminOrdersParams {
  page?: number
  pageSize?: number
  search?: string
  status?: 'all' | 'created' | 'pending_payment' | 'paid' | 'refunded' | 'expired' | 'failed'
}

export const creditService = {
  async getOrder(sessionToken: string, orderNo: string): Promise<CreditOrderQueryResponse> {
    const response = await api.get(`/credit/orders/${encodeURIComponent(orderNo)}`, {
      headers: {
        'x-linuxdo-token': sessionToken
      }
    })
    return response.data
  },

  async adminListOrders(params?: CreditAdminOrdersParams): Promise<CreditAdminOrdersResponse> {
    const response = await api.get('/credit/admin/orders', { params })
    return response.data
  },

  async adminGetBalance(): Promise<CreditAdminBalanceResponse> {
    const response = await api.get('/credit/admin/balance')
    return response.data
  },

  async adminRefundOrder(orderNo: string): Promise<CreditAdminRefundResponse> {
    const response = await api.post(`/credit/admin/orders/${encodeURIComponent(orderNo)}/refund`)
    return response.data
  }
}

export const waitingRoomService = {
  async getStatus(sessionToken: string): Promise<WaitingRoomSnapshot> {
    const response = await api.get('/waiting-room/status', {
      headers: {
        'x-linuxdo-token': sessionToken
      }
    })
    return response.data
  },

  async joinQueue(sessionToken: string, payload: WaitingRoomJoinPayload): Promise<WaitingRoomSnapshot> {
    const response = await api.post('/waiting-room/join', payload, {
      headers: {
        'x-linuxdo-token': sessionToken
      }
    })
    return response.data
  },

  async leaveQueue(sessionToken: string): Promise<WaitingRoomSnapshot> {
    const response = await api.post(
      '/waiting-room/leave',
      {},
      {
        headers: {
          'x-linuxdo-token': sessionToken
        }
      }
    )
    return response.data
  },

  async getAdminEntries(params?: { page?: number; pageSize?: number; status?: string; search?: string }): Promise<WaitingRoomAdminListResponse> {
    const response = await api.get('/waiting-room/admin/entries', {
      params
    })
    return response.data
  },

  async bindCode(entryId: number, payload: { codeId?: number; code?: string }): Promise<{ message: string; entry: WaitingRoomEntry }> {
    const response = await api.post(`/waiting-room/admin/entries/${entryId}/bind-code`, payload)
    return response.data
  },

  async redeemEntry(entryId: number): Promise<{ message: string; entry: WaitingRoomEntry }> {
    const response = await api.post(`/waiting-room/admin/entries/${entryId}/redeem`)
    return response.data
  },

  async clearReservation(entryId: number): Promise<{ message: string; entry: WaitingRoomEntry }> {
    const response = await api.post(`/waiting-room/admin/entries/${entryId}/clear-reservation`)
    return response.data
  },

  async updateStatus(entryId: number, status: WaitingRoomEntry['status']): Promise<{ message: string; entry: WaitingRoomEntry }> {
    const response = await api.post(`/waiting-room/admin/entries/${entryId}/status`, { status })
    return response.data
  },

  async clearQueue(): Promise<{ message: string; cleared: number }> {
    const response = await api.post('/waiting-room/admin/clear-queue')
    return response.data
  },

  async resetCooldown(entryId: number): Promise<{ message: string }> {
    const response = await api.post(`/waiting-room/admin/entries/${entryId}/reset-cooldown`)
    return response.data
  }
}

export const redemptionCodeService = {
  async getAll(): Promise<RedemptionCode[]> {
    const response = await api.get('/redemption-codes')
    return response.data
  },

  async list(params?: {
    page?: number
    pageSize?: number
    search?: string
    status?: 'all' | 'redeemed' | 'unused'
  }): Promise<{
    codes: RedemptionCode[]
    pagination: { page: number; pageSize: number; total: number }
  }> {
    const response = await api.get('/redemption-codes', { params })
    return response.data
  },

  async reinvite(id: number): Promise<{ message: string }> {
    const response = await api.post(`/redemption-codes/${id}/reinvite`)
    return response.data
  },

  async batchCreate(count: number, accountEmail: string, channel?: RedemptionChannel): Promise<BatchCreateResponse> {
    const response = await api.post('/redemption-codes/batch', { count, accountEmail, ...(channel ? { channel } : {}) })
    return response.data
  },

  async delete(id: number): Promise<void> {
    await api.delete(`/redemption-codes/${id}`)
  },

  async batchDelete(ids: number[]): Promise<void> {
    await api.post('/redemption-codes/batch-delete', { ids })
  },

  async redeem(
    data: { email: string; code: string; channel?: RedemptionChannel; redeemerUid?: string; orderType?: PurchaseOrderType },
    options?: { linuxDoSessionToken?: string }
  ): Promise<any> {
    // 为兑换接口创建一个不带认证的请求
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    if (options?.linuxDoSessionToken) {
      headers['x-linuxdo-token'] = options.linuxDoSessionToken
    }
    const response = await axios.post(`${API_URL}/redemption-codes/redeem`, data, {
      headers
    })
    return response
  },

  async redeemAdmin(data: {
    email: string
    code: string
    channel?: RedemptionChannel
    redeemerUid?: string
    orderType?: PurchaseOrderType
  }): Promise<any> {
    const response = await api.post('/redemption-codes/admin/redeem', data)
    return response
  },

  async recoverAccount(data: { email: string }): Promise<any> {
    const response = await axios.post(`${API_URL}/redemption-codes/recover`, data, {
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return response
  },

  async redeemXhsOrder(data: { email: string; orderNumber: string; strictToday?: boolean }): Promise<any> {
    const response = await axios.post(`${API_URL}/redemption-codes/xhs/redeem-order`, data, {
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return response
  },

  async checkXhsOrder(data: { orderNumber: string }): Promise<any> {
    const response = await axios.post(`${API_URL}/redemption-codes/xhs/check-order`, data, {
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return response
  },

  async syncXhsOrder(data: { orderNumber: string }): Promise<any> {
    const response = await axios.post(`${API_URL}/redemption-codes/xhs/search-order`, data, {
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return response
  },

  async redeemXianyuOrder(data: { email: string; orderId: string; strictToday?: boolean }): Promise<any> {
    const response = await axios.post(`${API_URL}/redemption-codes/xianyu/redeem-order`, data, {
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return response
  },

  async checkXianyuOrder(data: { orderId: string }): Promise<any> {
    const response = await axios.post(`${API_URL}/redemption-codes/xianyu/check-order`, data, {
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return response
  },

  async syncXianyuOrder(data: { orderId: string }): Promise<any> {
    const response = await axios.post(`${API_URL}/redemption-codes/xianyu/search-order`, data, {
      headers: {
        'Content-Type': 'application/json'
      }
    })
    return response
  },

  async updateChannel(id: number, channel: RedemptionChannel): Promise<{ message: string; code: RedemptionCode }> {
    const response = await api.patch(`/redemption-codes/${id}/channel`, { channel })
    return response.data
  }
}

export interface AdminStatsOverviewResponse {
  range: { from: string; to: string }
  users: {
    total: number
    created: number
    pointsTotal: number
    inviteEnabled: number
  }
  gptAccounts: {
    total: number
    open: number
    usedSeats: number
    totalSeats: number
    seatUtilization: number
    invitePending: number
  }
  redemptionCodes: {
    total: number
    unused: number
    byChannel: Array<{ channel: string; total: number; unused: number }>
    todayXhs: { total: number; unused: number }
    todayXianyu: { total: number; unused: number }
  }
  xhsOrders: {
    total: number
    used: number
    pending: number
    amount: {
      range: number
      today: number
    }
    today: { total: number; used: number; pending: number }
  }
  xianyuOrders: {
    total: number
    used: number
    pending: number
    amount: {
      range: number
      today: number
    }
    today: { total: number; used: number; pending: number }
  }
  purchaseOrders: {
    total: number
    paid: number
    pending: number
    refunded: number
    paidAmount: number
    refundAmount: number
  }
  creditOrders: {
    total: number
    paid: number
    refunded: number
    paidAmount: number
  }
  pointsWithdrawals: {
    pending: number
    pendingPoints: number
    pendingCash: number
  }
}

export const adminStatsService = {
  async getOverview(params?: { from?: string; to?: string }): Promise<AdminStatsOverviewResponse> {
    const response = await api.get('/admin/stats/overview', { params })
    return response.data
  }
}

export interface PurchaseAdminOrdersParams {
  page?: number
  pageSize?: number
  search?: string
  status?: 'all' | 'pending_payment' | 'paid' | 'refunded' | 'expired' | 'failed'
}

export interface PurchaseAdminOrdersResponse {
  orders: PurchaseOrder[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface PurchaseMyOrdersParams {
  page?: number
  pageSize?: number
}

export interface PurchaseMyOrdersResponse {
  orders: PurchaseOrder[]
  pagination: {
    page: number
    pageSize: number
    total: number
  }
}

export interface PurchaseMyOrdersSummaryResponse {
  total: number
  paid: number
  pending: number
  refunded: number
  expired: number
  failed: number
  recentOrders: Array<{
    orderNo: string
    status: string
    amount: string
    productName: string
    createdAt: string
    paidAt?: string | null
  }>
}

export const purchaseService = {
  async getMeta(): Promise<PurchaseMeta> {
    const response = await api.get('/purchase/meta')
    return response.data
  },

  async createOrder(payload: { email: string; type: 'alipay' | 'wxpay'; orderType?: PurchaseOrderType }): Promise<PurchaseCreateOrderResponse> {
    const response = await api.post('/purchase/orders', payload)
    return response.data
  },

  async getOrder(orderNo: string, email: string, options?: { sync?: boolean }): Promise<PurchaseOrderQueryResponse> {
    const response = await api.get(`/purchase/orders/${encodeURIComponent(orderNo)}`, {
      params: {
        email,
        sync: options?.sync ? 1 : undefined
      }
    })
    return response.data
  },

  async adminListOrders(params?: PurchaseAdminOrdersParams): Promise<PurchaseAdminOrdersResponse> {
    const response = await api.get('/purchase/admin/orders', { params })
    return response.data
  },

  async adminGetOrder(orderNo: string): Promise<{ order: any }> {
    const response = await api.get(`/purchase/admin/orders/${encodeURIComponent(orderNo)}`)
    return response.data
  },

  async adminRefund(orderNo: string): Promise<{ message: string; refund: any }> {
    const response = await api.post(`/purchase/admin/orders/${encodeURIComponent(orderNo)}/refund`)
    return response.data
  },

  async myListOrders(params?: PurchaseMyOrdersParams): Promise<PurchaseMyOrdersResponse> {
    const response = await api.get('/purchase/my/orders', { params })
    return response.data
  },

  async myOrdersSummary(): Promise<PurchaseMyOrdersSummaryResponse> {
    const response = await api.get('/purchase/my/orders/summary')
    return response.data
  },

  async myBindOrder(orderNo: string): Promise<{ message: string; order: PurchaseOrder }> {
    const response = await api.post('/purchase/my/orders/bind', { orderNo })
    return response.data
  },
}

export const xhsService = {
  async getConfig(): Promise<{ config: XhsConfig | null }> {
    const response = await api.get('/xhs/config')
    return response.data
  },

  async updateConfig(payload: Partial<{ curlCommand: string; cookies: string; authorization: string; syncEnabled: boolean; syncIntervalHours: number }>): Promise<{ message: string; config: XhsConfig | null }> {
    const response = await api.post('/xhs/config', payload)
    return response.data
  },

  async getStatus(): Promise<{ status: XhsStatus; stats: XhsStats }> {
    const response = await api.get('/xhs/status')
    return response.data
  },

  async syncOrders(payload: { searchOrder?: string }): Promise<{ message: string; result: { created: number; skipped: number; total: number } }> {
    const response = await api.post('/xhs/sync', payload)
    return response.data
  },

  async apiSync(payload: { searchKeyword?: string; pageSize?: number; maxPages?: number }): Promise<{ message: string; result: { created: number; skipped: number; totalFetched: number; pages: number } }> {
    const response = await api.post('/xhs/api-sync', payload)
    return response.data
  },

  async getOrders(params: { limit?: number; offset?: number } = {}): Promise<{ orders: XhsOrder[]; stats: XhsStats }> {
    const response = await api.get('/xhs/orders', { params })
    return response.data
  },

  async clearOrders(): Promise<{ message: string; cleared: number }> {
    const response = await api.post('/xhs/orders/clear')
    return response.data
  },

  async deleteOrder(id: number): Promise<{ message: string }> {
    const response = await api.delete(`/xhs/orders/${id}`)
    return response.data
  }
}

export const xianyuService = {
  async getConfig(): Promise<{ config: XianyuConfig | null }> {
    const response = await api.get('/xianyu/config')
    return response.data
  },

  async updateConfig(payload: Partial<{ cookies: string; syncEnabled: boolean; syncIntervalHours: number }>): Promise<{ message: string; config: XianyuConfig | null }> {
    const response = await api.post('/xianyu/config', payload)
    return response.data
  },

  async getStatus(): Promise<{ status: XianyuStatus; stats: XianyuStats }> {
    const response = await api.get('/xianyu/status')
    return response.data
  },

  async syncOrder(payload: { orderId: string }): Promise<{ message: string; result: { created: number; skipped: number; total: number }; order: XianyuOrder; synced: boolean }> {
    const response = await api.post('/xianyu/sync', payload)
    return response.data
  },

  async getOrders(params: { limit?: number; offset?: number } = {}): Promise<{ orders: XianyuOrder[]; stats: XianyuStats }> {
    const response = await api.get('/xianyu/orders', { params })
    return response.data
  },

  async clearOrders(): Promise<{ message: string; cleared: number }> {
    const response = await api.post('/xianyu/orders/clear')
    return response.data
  },

  async deleteOrder(id: number): Promise<{ message: string }> {
    const response = await api.delete(`/xianyu/orders/${id}`)
    return response.data
  }
}

export default api
