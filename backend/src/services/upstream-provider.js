import axios from 'axios'
import crypto from 'crypto'
import { getUpstreamSettings } from '../utils/upstream-settings.js'
import { getPublicBaseUrlSettings } from '../utils/public-base-url.js'

const UPSTREAM_PROVIDER_LOG_LABEL = '[UpstreamProvider]'

export const UPSTREAM_PROVIDER_TYPES = {
  LOCAL: 'local',
  CUSTOM_HTTP: 'custom-http',
  PLATFORM_UPSTREAM: 'platform-upstream',
}

const UPSTREAM_PROVIDER_TYPE_SET = new Set(Object.values(UPSTREAM_PROVIDER_TYPES))

export const normalizeProviderType = (value, fallback = UPSTREAM_PROVIDER_TYPES.CUSTOM_HTTP) => {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'legacy-http') return UPSTREAM_PROVIDER_TYPES.CUSTOM_HTTP
  return UPSTREAM_PROVIDER_TYPE_SET.has(normalized) ? normalized : fallback
}

const buildUrl = (baseUrl, path) => {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  const suffix = String(path || '').trim()
  if (!base) return ''
  if (!suffix) return base
  return `${base}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

const toRawString = (value) => {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const parseBooleanEnv = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

const isVerboseUpstreamProviderLogsEnabled = () => parseBooleanEnv(process.env.UPSTREAM_PROVIDER_VERBOSE_LOGS, false)

const getUpstreamProviderLogSnippetLimit = () => {
  const parsed = Number.parseInt(String(process.env.UPSTREAM_PROVIDER_LOG_SNIPPET_LIMIT ?? ''), 10)
  if (!Number.isFinite(parsed)) return 1200
  return Math.min(5000, Math.max(200, parsed))
}

const clipLogString = (value, limit = getUpstreamProviderLogSnippetLimit()) => {
  const raw = String(value || '')
  if (!raw) return ''
  return raw.length > limit ? `${raw.slice(0, limit)}...` : raw
}

const maskEmailForLog = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const atIndex = raw.indexOf('@')
  if (atIndex <= 0) return clipLogString(raw)
  const local = raw.slice(0, atIndex)
  const domain = raw.slice(atIndex + 1)
  const visibleLocal = local.length <= 2 ? local[0] || '*' : local.slice(0, 2)
  return `${visibleLocal}***@${domain}`
}

const maskCodeForLog = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const compact = raw.replace(/[^a-zA-Z0-9]/g, '')
  if (compact.length <= 4) return '***'
  if (compact.length <= 8) return `${compact.slice(0, 2)}***${compact.slice(-2)}`
  return `${compact.slice(0, 4)}...${compact.slice(-4)}`
}

const maskSecretForLog = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length <= 6) return '***'
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`
}

const shouldMaskAsSecret = (key) => {
  const normalized = String(key || '').trim().toLowerCase()
  if (!normalized) return false
  if (normalized.includes('authorization')) return true
  if (normalized.includes('token')) return true
  if (normalized.includes('secret')) return true
  if (normalized.includes('password')) return true
  if (normalized.includes('apikey')) return true
  if (normalized.endsWith('_key') || normalized.endsWith('-key')) return true
  return false
}

const shouldMaskAsEmail = (key) => String(key || '').trim().toLowerCase().includes('email')

const shouldMaskAsCode = (key) => {
  const normalized = String(key || '').trim().toLowerCase()
  return normalized === 'code'
    || normalized === 'cardcode'
    || normalized === 'publiccode'
    || normalized === 'realcode'
    || normalized === 'redeemcode'
    || normalized === 'recoverycode'
    || /(card|public|real|redeem|recovery)_?code$/.test(normalized)
}

const sanitizeForLog = (value, { key = '', depth = 0, seen } = {}) => {
  if (value == null) return value
  if (typeof value === 'string') {
    if (shouldMaskAsSecret(key)) return maskSecretForLog(value)
    if (shouldMaskAsEmail(key)) return maskEmailForLog(value)
    if (shouldMaskAsCode(key)) return maskCodeForLog(value)
    return clipLogString(value)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    if (depth >= 4) return `[Array(${value.length})]`
    return value.map(item => sanitizeForLog(item, { depth: depth + 1, seen }))
  }
  if (typeof value !== 'object') return clipLogString(String(value))

  const refs = seen || new WeakSet()
  if (refs.has(value)) return '[Circular]'
  refs.add(value)

  if (depth >= 4) return '[Object]'

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeForLog(entryValue, { key: entryKey, depth: depth + 1, seen: refs })
    ])
  )
}

const sanitizeUrlForLog = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''

  try {
    const parsed = new URL(raw)
    if (parsed.username) parsed.username = '***'
    if (parsed.password) parsed.password = '***'
    for (const key of Array.from(parsed.searchParams.keys())) {
      const current = parsed.searchParams.get(key)
      if (shouldMaskAsSecret(key)) {
        parsed.searchParams.set(key, '***')
      } else if (shouldMaskAsEmail(key)) {
        parsed.searchParams.set(key, maskEmailForLog(current))
      } else if (shouldMaskAsCode(key)) {
        parsed.searchParams.set(key, maskCodeForLog(current))
      } else {
        parsed.searchParams.set(key, clipLogString(current, 64))
      }
    }
    return parsed.toString()
  } catch {
    return clipLogString(raw)
  }
}

const buildRequestLogContext = ({ requestId, providerType, supplierName, requestUrl, timeoutMs, payload, headers }) => ({
  requestId,
  providerType,
  supplierName: String(supplierName || '').trim(),
  requestUrl: sanitizeUrlForLog(requestUrl),
  timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null,
  payload: sanitizeForLog(payload),
  headers: sanitizeForLog(headers)
})

const logUpstreamProviderEvent = (level, event, payload, { verboseOnly = false } = {}) => {
  if (verboseOnly && !isVerboseUpstreamProviderLogsEnabled()) return
  const logger = typeof console[level] === 'function' ? console[level] : console.info
  logger(UPSTREAM_PROVIDER_LOG_LABEL, event, payload)
}

const buildProviderResult = ({
  ok,
  status,
  retryable,
  providerType,
  supplierName,
  requestId,
  responseCode,
  message,
  redeemedAt,
  responseRaw,
  data
}) => ({
  ok: Boolean(ok),
  status: String(status || 'failed'),
  retryable: Boolean(retryable),
  providerType: normalizeProviderType(providerType),
  supplierName: String(supplierName || '').trim(),
  requestId: String(requestId || '').trim(),
  responseCode: responseCode == null ? '' : String(responseCode),
  message: String(message || '').trim() || '兑换失败，请稍后重试',
  redeemedAt: redeemedAt || null,
  responseRaw: String(responseRaw || ''),
  data: data || null
})

const isLegacyInvalidMessage = (message) => {
  const normalized = String(message || '').trim()
  return normalized.includes('卡密不存在') || normalized.includes('已使用')
}

const DEFAULT_CUSTOM_HTTP_BODY_TEMPLATE = JSON.stringify({
  userEmail: '{{email}}',
  cardCode: '{{code}}'
}, null, 2)
const PLATFORM_UPSTREAM_CHECK_PATH = '/api/upstream/cards/check'
const PLATFORM_UPSTREAM_REDEEM_PATH = '/api/upstream/cards/redeem'

const resolveCustomRequestUrl = (settings) => {
  return String(settings?.customUrl || '').trim()
}

const interpolateTemplateString = (template, payload) => (
  String(template || '').replace(/\{\{\s*(email|code|channel)\s*\}\}/gi, (_, rawKey) => {
    const key = String(rawKey || '').trim().toLowerCase()
    if (key === 'email') return String(payload?.email || '')
    if (key === 'code') return String(payload?.code || '')
    if (key === 'channel') return String(payload?.channel || '')
    return ''
  })
)

const applyTemplatePayload = (value, payload) => {
  if (typeof value === 'string') {
    return interpolateTemplateString(value, payload)
  }
  if (Array.isArray(value)) {
    return value.map(item => applyTemplatePayload(item, payload))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, applyTemplatePayload(entry, payload)])
    )
  }
  return value
}

const buildCustomRequestBody = (template, payload) => {
  const rawTemplate = String(template || '').trim() || DEFAULT_CUSTOM_HTTP_BODY_TEMPLATE
  const parsedTemplate = JSON.parse(rawTemplate)
  const parsed = applyTemplatePayload(parsedTemplate, payload)
  return {
    rawTemplate,
    parsed
  }
}

export const getUpstreamProviderReadiness = (settings, providerTypeValue) => {
  const providerType = normalizeProviderType(providerTypeValue || settings?.providerType)

  if (providerType === UPSTREAM_PROVIDER_TYPES.LOCAL) {
    return {
      ready: false,
      providerType,
      responseCode: 'CONFIG',
      message: '服务配置错误，请联系管理员'
    }
  }

  if (!settings?.providerEnabled) {
    return {
      ready: false,
      providerType,
      responseCode: 'DISABLED',
      message: '服务暂不可用，请联系管理员'
    }
  }

  if (providerType === UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM) {
    const baseUrl = String(settings?.baseUrl || '').trim()
    if (!baseUrl) {
      return {
        ready: false,
        providerType,
        responseCode: 'CONFIG',
        message: '服务暂不可用，请联系管理员'
      }
    }
    try {
      const parsed = new URL(baseUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_protocol')
    } catch {
      return {
        ready: false,
        providerType,
        responseCode: 'CONFIG',
        message: '服务配置错误，请联系管理员'
      }
    }
    return { ready: true, providerType, responseCode: '', message: '' }
  }

  const requestUrl = resolveCustomRequestUrl(settings)
  if (!requestUrl) {
    return {
      ready: false,
      providerType,
      responseCode: 'CONFIG',
      message: '服务暂不可用，请联系管理员'
    }
  }

  try {
    const parsed = new URL(requestUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_protocol')
  } catch {
    return {
      ready: false,
      providerType,
      responseCode: 'CONFIG',
      message: '服务配置错误，请联系管理员'
    }
  }

  try {
    buildCustomRequestBody(settings?.customBodyTemplate, {
      email: 'demo@example.com',
      code: 'DEMO-CODE',
      channel: 'common'
    })
  } catch {
    return {
      ready: false,
      providerType,
      responseCode: 'CONFIG',
      message: '服务配置错误，请联系管理员'
    }
  }

  return { ready: true, providerType, responseCode: '', message: '' }
}

async function redeemWithCustomHttp(settings, payload) {
  const requestId = crypto.randomUUID()
  const requestUrl = resolveCustomRequestUrl(settings)
  const url = new URL(requestUrl)
  const requestBody = buildCustomRequestBody(settings.customBodyTemplate, payload)

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': 'chatgpt-team-helper/upstream-provider',
    Origin: url.origin,
    Referer: `${url.origin}/`
  }
  const requestLogContext = buildRequestLogContext({
    requestId,
    providerType: UPSTREAM_PROVIDER_TYPES.CUSTOM_HTTP,
    supplierName: settings.supplierName,
    requestUrl,
    timeoutMs: settings.timeoutMs,
    payload: requestBody.parsed,
    headers
  })

  logUpstreamProviderEvent('info', 'custom-http redeem request', requestLogContext, { verboseOnly: true })

  try {
    const response = await axios.post(
      requestUrl,
      requestBody.parsed,
      {
        timeout: settings.timeoutMs,
        headers
      }
    )

    const responseRaw = toRawString(response.data)
    const explicitCode = response.data?.code
    const explicitMessage = String(response.data?.message || '').trim()
    if (explicitCode === 400 && isLegacyInvalidMessage(explicitMessage)) {
      const result = buildProviderResult({
        ok: false,
        status: 'invalid',
        retryable: false,
        providerType: UPSTREAM_PROVIDER_TYPES.CUSTOM_HTTP,
        supplierName: settings.supplierName,
        requestId,
        responseCode: explicitCode,
        message: explicitMessage || '卡密不存在或已使用',
        responseRaw,
        data: response.data
      })
      logUpstreamProviderEvent('warn', 'custom-http redeem rejected', {
        ...requestLogContext,
        httpStatus: response.status,
        responseCode: result.responseCode,
        providerStatus: result.status,
        retryable: result.retryable,
        message: result.message,
        responseBody: sanitizeForLog(response.data),
        responseRawSnippet: clipLogString(responseRaw)
      })
      return result
    }

    const result = buildProviderResult({
      ok: true,
      status: 'success',
      retryable: false,
      providerType: UPSTREAM_PROVIDER_TYPES.CUSTOM_HTTP,
      supplierName: settings.supplierName,
      requestId,
      responseCode: response.status,
      message: '兑换成功，权益已开通',
      redeemedAt: new Date().toISOString(),
      responseRaw,
      data: response.data
    })
    logUpstreamProviderEvent('info', 'custom-http redeem success', {
      ...requestLogContext,
      httpStatus: response.status,
      responseCode: result.responseCode,
      providerStatus: result.status,
      message: result.message,
      responseBody: sanitizeForLog(response.data),
      responseRawSnippet: clipLogString(responseRaw)
    }, { verboseOnly: true })
    return result
  } catch (error) {
    const responseStatus = error.response?.status
    const responseData = error.response?.data
    const responseRaw = toRawString(responseData || error.message)
    const explicitCode = responseData?.code ?? responseStatus
    const explicitMessage = String(responseData?.message || responseData?.error || error.message || '').trim()

    if (Number(explicitCode) === 400 && isLegacyInvalidMessage(explicitMessage)) {
      const result = buildProviderResult({
        ok: false,
        status: 'invalid',
        retryable: false,
        providerType: UPSTREAM_PROVIDER_TYPES.CUSTOM_HTTP,
        supplierName: settings.supplierName,
        requestId,
        responseCode: explicitCode,
        message: explicitMessage || '卡密不存在或已使用',
        responseRaw,
        data: responseData
      })
      logUpstreamProviderEvent('warn', 'custom-http redeem rejected', {
        ...requestLogContext,
        axiosCode: String(error.code || ''),
        httpStatus: responseStatus || null,
        responseCode: result.responseCode,
        providerStatus: result.status,
        retryable: result.retryable,
        message: result.message,
        responseBody: sanitizeForLog(responseData),
        responseRawSnippet: clipLogString(responseRaw)
      })
      return result
    }

    const result = buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: true,
      providerType: UPSTREAM_PROVIDER_TYPES.CUSTOM_HTTP,
      supplierName: settings.supplierName,
      requestId,
      responseCode: explicitCode || 'NETWORK',
      message: explicitMessage || '兑换失败，请稍后重试',
      responseRaw,
      data: responseData
    })
    logUpstreamProviderEvent('warn', 'custom-http redeem failure', {
      ...requestLogContext,
      axiosCode: String(error.code || ''),
      httpStatus: responseStatus || null,
      responseCode: result.responseCode,
      providerStatus: result.status,
      retryable: result.retryable,
      message: result.message,
      responseBody: sanitizeForLog(responseData),
      responseRawSnippet: clipLogString(responseRaw)
    })
    return result
  }
}

async function redeemWithPlatformUpstream(settings, payload) {
  const requestId = crypto.randomUUID()
  const requestUrl = buildUrl(settings.baseUrl, PLATFORM_UPSTREAM_REDEEM_PATH)
  if (!requestUrl) {
    return buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: false,
      providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
      supplierName: settings.supplierName,
      requestId,
      responseCode: 'CONFIG',
      message: '服务暂不可用，请联系管理员'
    })
  }

  const headers = await buildPlatformUpstreamHeaders(settings)
  const requestPayload = {
    email: payload.email,
    code: payload.code,
    channel: payload.channel || 'common'
  }
  const requestLogContext = buildRequestLogContext({
    requestId,
    providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
    supplierName: settings.supplierName,
    requestUrl,
    timeoutMs: settings.timeoutMs,
    payload: requestPayload,
    headers
  })

  logUpstreamProviderEvent('info', 'platform-upstream redeem request', requestLogContext, { verboseOnly: true })

  try {
    const response = await axios.post(
      requestUrl,
      requestPayload,
      {
        timeout: settings.timeoutMs,
        headers
      }
    )

    const body = response.data || {}
    const responseRaw = toRawString(body)
    const status = String(body.status || '').trim().toLowerCase()
    const message = String(body.message || '').trim()

    if (body.ok === true && status === 'success') {
      const result = buildProviderResult({
        ok: true,
        status: 'success',
        retryable: false,
        providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
        supplierName: settings.supplierName,
        requestId,
        responseCode: response.status,
        message: '兑换成功，权益已开通',
        redeemedAt: body.data?.redeemedAt || new Date().toISOString(),
        responseRaw,
        data: body
      })
      logUpstreamProviderEvent('info', 'platform-upstream redeem success', {
        ...requestLogContext,
        httpStatus: response.status,
        responseCode: result.responseCode,
        providerStatus: result.status,
        message: result.message,
        responseBody: sanitizeForLog(body),
        responseRawSnippet: clipLogString(responseRaw)
      }, { verboseOnly: true })
      return result
    }

    if (status === 'invalid') {
      const result = buildProviderResult({
        ok: false,
        status: 'invalid',
        retryable: false,
        providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
        supplierName: settings.supplierName,
        requestId,
        responseCode: body.code || response.status,
        message: message || '卡密不存在或已使用',
        responseRaw,
        data: body
      })
      logUpstreamProviderEvent('warn', 'platform-upstream redeem rejected', {
        ...requestLogContext,
        httpStatus: response.status,
        responseCode: result.responseCode,
        providerStatus: result.status,
        retryable: result.retryable,
        message: result.message,
        responseBody: sanitizeForLog(body),
        responseRawSnippet: clipLogString(responseRaw)
      })
      return result
    }

    const result = buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: Boolean(body.retryable),
      providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
      supplierName: settings.supplierName,
      requestId,
      responseCode: body.code || response.status,
      message: message || '兑换失败，请稍后重试',
      responseRaw,
      data: body
    })
    logUpstreamProviderEvent('warn', 'platform-upstream redeem failure', {
      ...requestLogContext,
      httpStatus: response.status,
      responseCode: result.responseCode,
      providerStatus: result.status,
      retryable: result.retryable,
      message: result.message,
      responseBody: sanitizeForLog(body),
      responseRawSnippet: clipLogString(responseRaw)
    })
    return result
  } catch (error) {
    const responseStatus = error.response?.status
    const responseData = error.response?.data
    const responseRaw = toRawString(responseData || error.message)
    const normalizedStatus = String(responseData?.status || '').trim().toLowerCase()
    const message = String(responseData?.message || responseData?.error || error.message || '').trim()

    const result = buildProviderResult({
      ok: false,
      status: normalizedStatus === 'invalid' ? 'invalid' : 'failed',
      retryable: normalizedStatus === 'invalid' ? false : true,
      providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
      supplierName: settings.supplierName,
      requestId,
      responseCode: responseData?.code || responseStatus || 'NETWORK',
      message: message || '兑换失败，请稍后重试',
      responseRaw,
      data: responseData
    })
    logUpstreamProviderEvent('warn', 'platform-upstream redeem failure', {
      ...requestLogContext,
      axiosCode: String(error.code || ''),
      httpStatus: responseStatus || null,
      responseCode: result.responseCode,
      providerStatus: result.status,
      retryable: result.retryable,
      message: result.message,
      responseBody: sanitizeForLog(responseData),
      responseRawSnippet: clipLogString(responseRaw)
    })
    return result
  }
}

const buildPlatformUpstreamHeaders = async (settings) => {
  const publicBaseUrlSettings = await getPublicBaseUrlSettings()
  const publicBaseUrl = String(publicBaseUrlSettings.baseUrl || '').trim()
  let publicOrigin = ''
  let downstreamDomain = ''
  if (publicBaseUrl) {
    try {
      const parsed = new URL(publicBaseUrl)
      publicOrigin = parsed.origin
      downstreamDomain = String(parsed.hostname || '').trim().toLowerCase()
    } catch {
      publicOrigin = ''
      downstreamDomain = ''
    }
  }

  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'User-Agent': 'chatgpt-team-helper/upstream-provider',
    ...(settings.outboundApiKey ? { 'X-Upstream-Key': settings.outboundApiKey } : {}),
    ...(downstreamDomain ? { 'X-Downstream-Domain': downstreamDomain } : {}),
    ...(publicOrigin ? { Origin: publicOrigin, Referer: `${publicOrigin}/` } : {}),
  }
}

async function checkWithPlatformUpstream(settings, payload) {
  const requestId = crypto.randomUUID()
  const requestUrl = buildUrl(settings.baseUrl, PLATFORM_UPSTREAM_CHECK_PATH)
  if (!requestUrl) {
    return buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: false,
      providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
      supplierName: settings.supplierName,
      requestId,
      responseCode: 'CONFIG',
      message: '服务暂不可用，请联系管理员'
    })
  }

  const headers = await buildPlatformUpstreamHeaders(settings)
  const requestPayload = {
    code: payload.code,
    channel: payload.channel || 'common'
  }
  const requestLogContext = buildRequestLogContext({
    requestId,
    providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
    supplierName: settings.supplierName,
    requestUrl,
    timeoutMs: settings.timeoutMs,
    payload: requestPayload,
    headers
  })

  logUpstreamProviderEvent('info', 'platform-upstream check request', requestLogContext, { verboseOnly: true })

  try {
    const response = await axios.post(
      requestUrl,
      requestPayload,
      {
        timeout: settings.timeoutMs,
        headers
      }
    )

    const body = response.data || {}
    const responseRaw = toRawString(body)
    const status = String(body.status || '').trim().toLowerCase()
    const message = String(body.message || '').trim()

    if (body.ok === true && status === 'available') {
      const result = buildProviderResult({
        ok: true,
        status: 'available',
        retryable: false,
        providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
        supplierName: settings.supplierName,
        requestId,
        responseCode: response.status,
        message: message || '卡密可用',
        responseRaw,
        data: body
      })
      logUpstreamProviderEvent('info', 'platform-upstream check success', {
        ...requestLogContext,
        httpStatus: response.status,
        responseCode: result.responseCode,
        providerStatus: result.status,
        message: result.message,
        responseBody: sanitizeForLog(body),
        responseRawSnippet: clipLogString(responseRaw)
      }, { verboseOnly: true })
      return result
    }

    if (status === 'used') {
      const result = buildProviderResult({
        ok: false,
        status: 'used',
        retryable: false,
        providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
        supplierName: settings.supplierName,
        requestId,
        responseCode: body.code || response.status,
        message: message || '卡密已使用',
        responseRaw,
        data: body
      })
      logUpstreamProviderEvent('warn', 'platform-upstream check rejected', {
        ...requestLogContext,
        httpStatus: response.status,
        responseCode: result.responseCode,
        providerStatus: result.status,
        retryable: result.retryable,
        message: result.message,
        responseBody: sanitizeForLog(body),
        responseRawSnippet: clipLogString(responseRaw)
      })
      return result
    }

    if (status === 'invalid') {
      const result = buildProviderResult({
        ok: false,
        status: 'invalid',
        retryable: false,
        providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
        supplierName: settings.supplierName,
        requestId,
        responseCode: body.code || response.status,
        message: message || '卡密已失效',
        responseRaw,
        data: body
      })
      logUpstreamProviderEvent('warn', 'platform-upstream check rejected', {
        ...requestLogContext,
        httpStatus: response.status,
        responseCode: result.responseCode,
        providerStatus: result.status,
        retryable: result.retryable,
        message: result.message,
        responseBody: sanitizeForLog(body),
        responseRawSnippet: clipLogString(responseRaw)
      })
      return result
    }

    const result = buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: Boolean(body.retryable),
      providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
      supplierName: settings.supplierName,
      requestId,
      responseCode: body.code || response.status,
      message: message || '查询卡密失败，请稍后重试',
      responseRaw,
      data: body
    })
    logUpstreamProviderEvent('warn', 'platform-upstream check failure', {
      ...requestLogContext,
      httpStatus: response.status,
      responseCode: result.responseCode,
      providerStatus: result.status,
      retryable: result.retryable,
      message: result.message,
      responseBody: sanitizeForLog(body),
      responseRawSnippet: clipLogString(responseRaw)
    })
    return result
  } catch (error) {
    const responseStatus = error.response?.status
    const responseData = error.response?.data
    const responseRaw = toRawString(responseData || error.message)
    const normalizedStatus = String(responseData?.status || '').trim().toLowerCase()
    const message = String(responseData?.message || responseData?.error || error.message || '').trim()
    const resolvedStatus = normalizedStatus === 'invalid'
      ? 'invalid'
      : normalizedStatus === 'used'
        ? 'used'
        : 'failed'

    const result = buildProviderResult({
      ok: false,
      status: resolvedStatus,
      retryable: resolvedStatus === 'failed',
      providerType: UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM,
      supplierName: settings.supplierName,
      requestId,
      responseCode: responseData?.code || responseStatus || 'NETWORK',
      message: message || '查询卡密失败，请稍后重试',
      responseRaw,
      data: responseData
    })
    logUpstreamProviderEvent('warn', 'platform-upstream check failure', {
      ...requestLogContext,
      axiosCode: String(error.code || ''),
      httpStatus: responseStatus || null,
      responseCode: result.responseCode,
      providerStatus: result.status,
      retryable: result.retryable,
      message: result.message,
      responseBody: sanitizeForLog(responseData),
      responseRawSnippet: clipLogString(responseRaw)
    })
    return result
  }
}

export async function redeemViaUpstreamProvider(payload, options = {}) {
  const settings = options.settings || await getUpstreamSettings()
  const readiness = getUpstreamProviderReadiness(settings, options.providerType || settings.providerType)

  if (!readiness.ready) {
    return buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: false,
      providerType: readiness.providerType,
      supplierName: settings.supplierName,
      requestId: crypto.randomUUID(),
      responseCode: readiness.responseCode,
      message: readiness.message
    })
  }

  if (readiness.providerType === UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM) {
    return redeemWithPlatformUpstream(settings, payload)
  }

  return redeemWithCustomHttp(settings, payload)
}

export async function checkViaUpstreamProvider(payload, options = {}) {
  const settings = options.settings || await getUpstreamSettings()
  const readiness = getUpstreamProviderReadiness(settings, options.providerType || settings.providerType)

  if (!readiness.ready) {
    return buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: false,
      providerType: readiness.providerType,
      supplierName: settings.supplierName,
      requestId: crypto.randomUUID(),
      responseCode: readiness.responseCode,
      message: readiness.message
    })
  }

  if (readiness.providerType !== UPSTREAM_PROVIDER_TYPES.PLATFORM_UPSTREAM) {
    return buildProviderResult({
      ok: false,
      status: 'failed',
      retryable: false,
      providerType: readiness.providerType,
      supplierName: settings.supplierName,
      requestId: crypto.randomUUID(),
      responseCode: 'UNSUPPORTED',
      message: '当前出站履约类型不支持卡密检查'
    })
  }

  return checkWithPlatformUpstream(settings, payload)
}
