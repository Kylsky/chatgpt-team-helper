import axios from 'axios'
import { formatProxyForLog, loadProxyList, parseProxyConfig, pickProxyByHash } from '../utils/proxy.js'

const OAI_CLIENT_VERSION = 'prod-eddc2f6ff65fee2d0d6439e379eab94fe3047f72'
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 800
const DEFAULT_RETRY_MAX_DELAY_MS = 5000

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const clampDelay = (value, { min = 0, max = Number.POSITIVE_INFINITY } = {}) => Math.max(min, Math.min(max, value))

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const isRetryableNetworkError = (error) => {
  const code = String(error?.code || '').toUpperCase()
  const message = String(error?.message || '').toLowerCase()
  const retryableCodes = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENOTFOUND', 'EPIPE'])
  if (retryableCodes.has(code)) return true
  if (message.includes('before secure tls connection was established')) return true
  if (message.includes('network socket disconnected')) return true
  if (message.includes('socket hang up')) return true
  if (message.includes('timeout')) return true
  return false
}

const isRetryableHttpStatus = (status, bodyText = '') => {
  const code = Number(status)
  if (!Number.isFinite(code)) return false
  if (code === 408 || code === 429) return true
  if (code >= 500 && code <= 599) return true
  // 某些节点会被 CF / 风控 403，切代理重试可能可恢复
  if (code === 403 && bodyText) {
    const normalized = String(bodyText).toLowerCase()
    if (normalized.includes('cloudflare') || normalized.includes('cf-') || normalized.includes('just a moment')) {
      return true
    }
  }
  return false
}

let socksProxyAgentModulePromise = null
const socksAgentCache = new Map()

async function getSocksProxyAgentModule() {
  if (!socksProxyAgentModulePromise) {
    socksProxyAgentModulePromise = import('socks-proxy-agent')
  }
  return socksProxyAgentModulePromise
}

async function getSocksAgent(proxyUrl) {
  const url = String(proxyUrl || '').trim()
  if (!url) return null

  const cached = socksAgentCache.get(url)
  if (cached) return cached

  let module
  try {
    module = await getSocksProxyAgentModule()
  } catch (error) {
    console.error('[ChatGPTInvite] SOCKS 代理依赖缺失（socks-proxy-agent）', { message: error?.message || String(error) })
    throw new Error('SOCKS5 代理需要安装依赖 socks-proxy-agent')
  }

  const SocksProxyAgent = module?.SocksProxyAgent || module?.default
  if (!SocksProxyAgent) {
    throw new Error('SOCKS5 代理依赖 socks-proxy-agent 加载失败')
  }

  const agent = new SocksProxyAgent(url)
  socksAgentCache.set(url, agent)
  return agent
}

const loadInviteProxyList = () => {
  return loadProxyList()
}

const pickProxySequence = (proxies = [], key) => {
  if (!proxies.length) return () => null
  return (attemptIndex) => pickProxyByHash(proxies, key, { attempt: attemptIndex }) || null
}

const buildProxyConfigFromUrl = (proxyUrl) => {
  const normalized = String(proxyUrl || '').trim()
  if (!normalized) return null
  const config = parseProxyConfig(normalized)
  if (!config) return null
  return { url: normalized, config }
}

export async function inviteUserToChatGPTTeam(email, accountData, options = {}) {
  const maxAttempts = Math.max(1, toInt(options.maxAttempts, toInt(process.env.CHATGPT_INVITE_RETRY_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS)))
  const timeoutMs = Math.max(1000, toInt(options.timeoutMs, toInt(process.env.CHATGPT_INVITE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)))
  const baseDelayMs = clampDelay(toInt(options.baseDelayMs, toInt(process.env.CHATGPT_INVITE_RETRY_BASE_DELAY_MS, DEFAULT_RETRY_BASE_DELAY_MS)), { min: 0 })
  const maxDelayMs = clampDelay(toInt(options.maxDelayMs, toInt(process.env.CHATGPT_INVITE_RETRY_MAX_DELAY_MS, DEFAULT_RETRY_MAX_DELAY_MS)), { min: baseDelayMs })

  const { token, chatgpt_account_id: chatgptAccountId, oai_device_id: oaiDeviceId } = accountData || {}

  const proxyOverrides = options.proxy ? [buildProxyConfigFromUrl(options.proxy)].filter(Boolean) : []
  const proxies = proxyOverrides.length ? proxyOverrides : loadInviteProxyList()
  const proxyKey = options.proxyKey ?? chatgptAccountId ?? ''
  const pickProxy = pickProxySequence(proxies, proxyKey)

  if (!token || !chatgptAccountId) {
    console.error('账号缺少必要的认证信息：token 或 chatgptAccountId')
    return { success: false, error: '账号配置不完整' }
  }

  const normalizedEmail = String(email || '').trim()
  if (!normalizedEmail) {
    return { success: false, error: '缺少邀请邮箱' }
  }

  const url = `https://chatgpt.com/backend-api/accounts/${chatgptAccountId}/invites`

  const headers = {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'authorization': `Bearer ${token}`,
    'chatgpt-account-id': chatgptAccountId,
    'content-type': 'application/json',
    'oai-client-version': OAI_CLIENT_VERSION,
    'oai-device-id': oaiDeviceId || '',
    'oai-language': 'zh-CN',
    'origin': 'https://chatgpt.com',
    'referer': 'https://chatgpt.com/admin/members',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
  }

  const data = {
    email_addresses: [normalizedEmail],
    role: 'standard-user',
    resend_emails: true
  }

  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const proxyEntry = pickProxy(attempt)
    const proxyUrl = proxyEntry?.url || ''
    const proxyConfig = proxyEntry?.config || null
    const proxyLabel = proxyUrl ? formatProxyForLog(proxyUrl) : null
    const protocol = String(proxyConfig?.protocol || '').toLowerCase()
    const isSocksProxy = protocol.startsWith('socks')

    let socksAgent = null
    if (isSocksProxy && proxyUrl) {
      try {
        socksAgent = await getSocksAgent(proxyUrl)
      } catch (error) {
        lastError = error
        console.error('[ChatGPTInvite] socks agent init failed', { proxy: proxyLabel, message: error?.message || String(error) })
        break
      }
    }

    try {
      const response = await axios.request({
        url,
        method: 'POST',
        headers,
        data,
        timeout: timeoutMs,
        validateStatus: () => true,
        proxy: socksAgent ? false : (proxyConfig || false),
        httpAgent: socksAgent || undefined,
        httpsAgent: socksAgent || undefined,
      })

      if (response.status >= 200 && response.status < 300) {
        console.log(`成功发送邀请给 ${normalizedEmail}，响应:`, response.data)
        return {
          success: true,
          inviteId: response.data?.account_invites?.[0]?.id,
          response: response.data
        }
      }

      const responseText = response.data == null
        ? ''
        : (typeof response.data === 'string' ? response.data : JSON.stringify(response.data))
      const retryable = isRetryableHttpStatus(response.status, responseText)

      lastError = new Error(`HTTP ${response.status}: ${responseText.slice(0, 500)}`)
      console.error('[ChatGPTInvite] invite failed', {
        email: normalizedEmail,
        attempt,
        maxAttempts,
        proxy: proxyLabel,
        status: response.status,
        bodySnippet: responseText.slice(0, 300)
      })

      if (!retryable || attempt >= maxAttempts) {
        return {
          success: false,
          error: `邀请失败（HTTP ${response.status}，已尝试 ${attempt} 次）: ${responseText.slice(0, 500)}`
        }
      }

      const delay = clampDelay(baseDelayMs * (2 ** Math.max(0, attempt - 1)), { min: 0, max: maxDelayMs })
      await sleep(delay)
    } catch (error) {
      lastError = error
      const retryable = isRetryableNetworkError(error)
      console.error('[ChatGPTInvite] invite network error', {
        email: normalizedEmail,
        attempt,
        maxAttempts,
        proxy: proxyLabel,
        code: error?.code,
        message: error?.message || String(error)
      })

      if (!retryable || attempt >= maxAttempts) {
        return {
          success: false,
          error: `邀请失败（已尝试 ${attempt} 次）: ${error?.message || String(error) || '邀请接口调用失败'}`
        }
      }

      const delay = clampDelay(baseDelayMs * (2 ** Math.max(0, attempt - 1)), { min: 0, max: maxDelayMs })
      await sleep(delay)
    }
  }

  return {
    success: false,
    error: lastError?.message ? `邀请失败（已尝试 ${maxAttempts} 次）: ${lastError.message}` : '邀请接口调用失败'
  }
}
