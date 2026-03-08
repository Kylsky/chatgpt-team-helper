import fs from 'fs'

function splitList(value) {
  const raw = String(value || '').trim()
  if (!raw) return []

  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed.map(item => String(item || '').trim()).filter(Boolean)
      }
    } catch {
      // fallthrough to delimiter parsing
    }
  }

  return raw
    .split(/[\n,;]+/g)
    .map(item => String(item || '').trim())
    .filter(Boolean)
}

export function parseProxyConfig(proxyUrl) {
  if (!proxyUrl) return null

  try {
    const parsed = new URL(String(proxyUrl))
    const protocol = String(parsed.protocol || '').replace(':', '').toLowerCase()
    if (!protocol || !['http', 'https', 'socks', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(protocol)) {
      return null
    }

    if (!parsed.hostname) return null

    const defaultPort = protocol.startsWith('socks') ? 1080 : (protocol === 'https' ? 443 : 80)
    const port = parsed.port ? Number(parsed.port) : defaultPort
    if (!Number.isFinite(port) || port <= 0) return null

    const auth = parsed.username
      ? {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password || '')
        }
      : undefined

    return {
      protocol,
      host: parsed.hostname,
      port,
      ...(auth ? { auth } : {})
    }
  } catch {
    return null
  }
}

export function formatProxyForLog(proxyUrl) {
  if (!proxyUrl) return ''
  try {
    const parsed = new URL(String(proxyUrl))
    const protocol = String(parsed.protocol || '').replace(':', '')
    const host = parsed.hostname || ''
    const port = parsed.port ? `:${parsed.port}` : ''
    return `${protocol}://${host}${port}`
  } catch {
    return String(proxyUrl)
  }
}

export function loadProxyList({ urlsEnvKey, fileEnvKey } = {}) {
  const urlsKey = urlsEnvKey || 'OPEN_ACCOUNTS_SWEEPER_PROXY_URLS'
  const fileKey = fileEnvKey || 'OPEN_ACCOUNTS_SWEEPER_PROXY_FILE'

  const rawUrls = process.env[urlsKey]
  const rawFile = process.env[fileKey]

  const urls = []

  if (rawFile) {
    const path = String(rawFile).trim()
    if (path) {
      try {
        const fileText = fs.readFileSync(path, 'utf8')
        for (const line of String(fileText).split('\n')) {
          const trimmed = String(line || '').trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          urls.push(trimmed)
        }
      } catch (error) {
        console.warn('[ProxyList] failed to read proxy file', { path, message: error?.message || String(error) })
      }
    }
  }

  urls.push(...splitList(rawUrls))

  const seen = new Set()
  const proxies = []
  for (const url of urls) {
    const normalized = String(url || '').trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    const config = parseProxyConfig(normalized)
    if (!config) {
      console.warn('[ProxyList] invalid proxy url ignored', { proxy: formatProxyForLog(normalized) })
      continue
    }
    proxies.push({ url: normalized, config })
  }

  return proxies
}

const fnv1a32 = (value) => {
  const input = String(value ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export function pickProxyByHash(proxies = [], key, { attempt = 1 } = {}) {
  const list = Array.isArray(proxies) ? proxies : []
  if (list.length === 0) return null

  const normalizedKey = String(key ?? '').trim()
  const attemptOffset = Math.max(0, Number(attempt || 1) - 1)

  if (!normalizedKey) {
    return list[attemptOffset % list.length] || null
  }

  const base = fnv1a32(normalizedKey)
  const index = (base + attemptOffset) % list.length
  return list[index] || null
}
