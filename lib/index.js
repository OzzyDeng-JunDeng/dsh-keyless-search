/**
 * Keyless web search for DeepSeek Harness.
 *
 * Registers one search provider on the `ctx.web` capability seam, so the
 * built-in `web_search` tool works without an API key, an account, or a
 * configuration step.
 *
 * Default backend chain:
 *
 *   tavily     api.tavily.com keyless access mode — documented, free, rate-limited
 *   firecrawl  api.firecrawl.dev keyless tier — documented, free, rate-limited
 *
 * Both are official no-key offerings from their vendors, and each is used
 * exactly as the vendor documents it. Neither scrapes a search-engine results
 * page, so this provider does not depend on anyone's markup or terms.
 *
 * A keyed environment variable (`TAVILY_API_KEY`, `FIRECRAWL_API_KEY`) is used
 * automatically when present — the vendors' documented upgrade path for higher
 * limits — with no configuration change.
 *
 * Two extra backends are available but OFF by default: `bing-rss` and
 * `bing-html`. They query Bing's results endpoint, whose `robots.txt` disallows
 * `/search` for `User-agent: *`. They are opt-in only, and the README says so
 * plainly. Do not enable them without deciding that trade-off yourself.
 *
 * This module deliberately has no static imports and no third-party
 * dependencies, so it loads even from a profile that resolves none of the
 * harness packages.
 */

/** Cordis plugin name used in loader diagnostics. */
export const name = 'keyless-search'

/** The web capability seam this provider registers into. */
export const inject = ['web']

/** Provider id. Keep in sync with the profile patch's `web` row. */
const PROVIDER_ID = 'keyless-search'

/** Defaults for every config key accepted from the loader row's `config:` map. */
const DEFAULTS = {
  /** Comma-separated failover order. */
  searchBackends: 'tavily,firecrawl',
  /** Contact string sent to the keyless APIs. */
  userAgent: 'dsh-keyless-search (+https://github.com/deepseek-ai/deepseek-harness)',
  /** Per-request timeout, applied per backend attempt. */
  timeoutMs: 15000,
  /** Bing host for the opt-in `bing-*` backends. */
  bingHost: 'cn.bing.com',
  /** Bing market for the opt-in `bing-*` backends. */
  bingMarket: 'zh-CN',
  /** Log which backend served each query. `KEYLESS_SEARCH_DEBUG=1` forces it on. */
  debug: false,
}

/* ------------------------------------------------------------------ *
 * Module resolution
 * ------------------------------------------------------------------ */

/**
 * Import a harness package from wherever this profile can see it.
 *
 * A plain `import` resolves against this file, which already walks up through
 * the profile's node_modules into the profile family's, which is the layout
 * `dsh` installs. When the package is mounted from somewhere else that walk can
 * miss, so fall back to explicitly anchoring resolution at each enclosing
 * directory before giving up.
 *
 * @param specifier - the package name to load.
 * @returns the module namespace, or `undefined` when nothing could resolve it.
 */
async function importHarnessPackage(specifier) {
  try {
    return await import(specifier)
  } catch {
    // Fall through to the anchored attempts below.
  }
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  for (const anchor of ['..', '../..', '../../..']) {
    try {
      const base = new URL(`${anchor}/`, import.meta.url)
      const resolved = createRequire(base).resolve(specifier)
      return await import(pathToFileURL(resolved).href)
    } catch {
      // Try the next anchor.
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Small text helpers
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#39': "'", '#34': '"', '#38': '&',
}

/** Decode the small HTML entity set search snippets actually contain. */
function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Strip markup from a snippet and collapse whitespace. */
function plainText(value) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** Drop a leading localized date prefix Bing puts inside RSS descriptions. */
function stripLeadingDate(value) {
  return value.replace(/^\s*\d{4}[年/-]\s?\d{1,2}[月/-]\s?\d{1,2}日?\s*[·|—-]?\s*/, '').trim()
}

/**
 * Resolve Bing's `/ck/a?...&u=a1<base64url>` click-tracking link to its target.
 * Non-tracking URLs pass through unchanged.
 */
function unwrapBingUrl(href) {
  const url = decodeEntities(String(href ?? '').trim())
  if (!/bing\.com\/ck\/a/i.test(url)) return url
  const match = /[?&]u=a1([^&"]+)/i.exec(url)
  if (match === null) return url
  try {
    const base64 = decodeURIComponent(match[1]).replace(/-/g, '+').replace(/_/g, '/')
    const decoded = Buffer.from(base64, 'base64').toString('utf8')
    return /^https?:\/\//i.test(decoded) ? decoded : url
  } catch {
    return url
  }
}

/** Normalize a URL for de-duplication; invalid URLs return `undefined`. */
function normalizeUrl(href) {
  try {
    const url = new URL(unwrapBingUrl(href))
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/** Cap a source list without mutating the caller's array. */
function cap(list, maxResults) {
  if (maxResults === undefined || !Number.isFinite(maxResults) || maxResults <= 0) return list
  return list.slice(0, maxResults)
}

/** Merge the caller's cancellation signal with this attempt's timeout. */
function attemptSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Build a source, omitting empty optional fields. */
function source(url, title, snippet, publishedAt) {
  return {
    url,
    ...title === '' ? {} : { title },
    ...snippet === '' ? {} : { snippet },
    ...publishedAt === undefined ? {} : { publishedAt },
  }
}

/* ------------------------------------------------------------------ *
 * Search backends. Each returns WebSearchSource[] (possibly empty).
 * ------------------------------------------------------------------ */

/** POST JSON and parse it, failing loudly on any non-2xx status. */
async function postJson(endpoint, body, headers, provider, backend) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': provider.config.userAgent, ...headers },
    body: JSON.stringify(body),
    signal: attemptSignal(provider.signal, provider.config.timeoutMs),
  })
  if (!response.ok) throw new Error(`${backend} returned HTTP ${response.status}`)
  return await response.json()
}

/** Add a bearer token only when the matching environment key is present. */
function bearer(envName) {
  const key = process.env[envName]
  return key === undefined || key === '' ? {} : { authorization: `Bearer ${key}` }
}

/** Read a response body as text, failing loudly on a non-2xx status. */
async function getText(url, headers, provider, backend) {
  const response = await fetch(url, {
    headers: { 'user-agent': provider.config.userAgent, ...headers },
    redirect: 'follow',
    signal: attemptSignal(provider.signal, provider.config.timeoutMs),
  })
  if (!response.ok) throw new Error(`${backend} returned HTTP ${response.status}`)
  return await response.text()
}

/**
 * `tavily` — api.tavily.com in documented keyless access mode.
 * Uses `TAVILY_API_KEY` when set, which is the vendor's documented upgrade.
 */
async function searchTavily(request, provider) {
  const payload = await postJson('https://api.tavily.com/search', {
    query: request.query,
    max_results: Math.min(request.maxResults ?? 8, 20),
    search_depth: 'basic',
  }, {
    // Sent only when keyless; a keyed request must not carry the keyless hint.
    ...(process.env.TAVILY_API_KEY ? {} : { 'x-tavily-access-mode': 'keyless' }),
    ...bearer('TAVILY_API_KEY'),
  }, provider, 'tavily')

  const rows = Array.isArray(payload?.results) ? payload.results : []
  const sources = []
  for (const row of rows) {
    const url = normalizeUrl(row?.url ?? '')
    if (url === undefined) continue
    sources.push(source(url, plainText(row?.title ?? ''), plainText(row?.content ?? '')))
  }
  return sources
}

/** `firecrawl` — api.firecrawl.dev keyless tier, or keyed when a key is set. */
async function searchFirecrawl(request, provider) {
  const payload = await postJson('https://api.firecrawl.dev/v2/search', {
    query: request.query,
    limit: Math.min(request.maxResults ?? 8, 20),
    sources: ['web'],
  }, bearer('FIRECRAWL_API_KEY'), provider, 'firecrawl')

  if (payload?.success === false) throw new Error(`firecrawl: ${String(payload?.error ?? 'request failed')}`)
  const web = Array.isArray(payload?.data?.web) ? payload.data.web : []
  const news = Array.isArray(payload?.data?.news) ? payload.data.news : []
  const sources = []
  for (const row of [...web, ...news]) {
    const url = normalizeUrl(row?.url ?? '')
    if (url === undefined) continue
    sources.push(source(url, plainText(row?.title ?? ''), plainText(row?.description ?? row?.snippet ?? '')))
  }
  return sources
}

/**
 * `bing-rss` — Bing's result RSS feed. OFF by default.
 *
 * Opt-in only: Bing's `robots.txt` disallows `/search` for `User-agent: *`, and
 * this endpoint lives under that path. It is the sturdiest parser here, which
 * is why it is offered, but enabling it is the operator's call.
 */
async function searchBingRss(request, provider) {
  const count = Math.min(request.maxResults ?? 10, 20)
  const url = `https://${provider.config.bingHost}/search?q=${encodeURIComponent(request.query)}`
    + `&format=rss&count=${String(count)}&mkt=${encodeURIComponent(provider.config.bingMarket)}`
  const xml = await getText(url, { accept: 'application/rss+xml, text/xml, */*' }, provider, 'bing-rss')

  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []
  const sources = []
  for (const item of items) {
    const url2 = normalizeUrl(/<link>([\s\S]*?)<\/link>/i.exec(item)?.[1] ?? '')
    if (url2 === undefined) continue
    const published = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(item)?.[1]?.trim()
    const publishedAt = published === undefined ? undefined : new Date(published)
    sources.push(source(
      url2,
      plainText(/<title>([\s\S]*?)<\/title>/i.exec(item)?.[1] ?? ''),
      stripLeadingDate(plainText(/<description>([\s\S]*?)<\/description>/i.exec(item)?.[1] ?? '')),
      publishedAt === undefined || Number.isNaN(publishedAt.getTime()) ? undefined : publishedAt.toISOString(),
    ))
  }
  return sources
}

/** `bing-html` — parses `<li class="b_algo">` blocks. OFF by default, same caveat. */
async function searchBingHtml(request, provider) {
  const count = Math.min(request.maxResults ?? 10, 20)
  const url = `https://${provider.config.bingHost}/search?q=${encodeURIComponent(request.query)}`
    + `&count=${String(count)}&mkt=${encodeURIComponent(provider.config.bingMarket)}`
  const html = await getText(url, {
    accept: 'text/html,application/xhtml+xml',
    'accept-language': provider.config.bingMarket === 'zh-CN' ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
  }, provider, 'bing-html')

  const sources = []
  for (const block of html.split(/<li class="b_algo"/i).slice(1)) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (anchor === null) continue
    const finalUrl = normalizeUrl(anchor[1])
    if (finalUrl === undefined) continue
    const snippet = /<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block) ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)
    sources.push(source(finalUrl, plainText(anchor[2]), stripLeadingDate(plainText(snippet?.[1] ?? ''))))
  }
  return sources
}

/** Backend name → implementation. */
const BACKENDS = {
  tavily: searchTavily,
  firecrawl: searchFirecrawl,
  'bing-rss': searchBingRss,
  'bing-html': searchBingHtml,
}

/**
 * Describe a backend failure usefully.
 *
 * A transport error surfaces as `TypeError: fetch failed`, which says nothing
 * about whether the network is down, TLS was refused, or a request was aborted.
 * The real reason is on `cause`, so unwrap it — a timeout and a DNS failure need
 * different fixes, and the operator should be able to tell them apart from the
 * error text alone.
 *
 * @param error - whatever the backend threw.
 * @returns a message including the underlying cause when there is one.
 */
function describeFailure(error) {
  const message = error?.message ?? String(error)
  const cause = error?.cause
  if (cause === undefined || cause === null) return message
  const code = cause?.code ?? cause?.name
  const detail = cause?.message ?? String(cause)
  return code === undefined ? `${message} (${detail})` : `${message} (${String(code)}: ${detail})`
}

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

/** Failover search provider over keyless backends. */
class KeylessSearchProvider {
  id = PROVIDER_ID

  constructor(config, logger, WebError) {
    this.config = config
    this.logger = logger
    this.WebError = WebError
    this.backends = config.searchBackends
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  }

  /** Usable whenever at least one known backend is configured. */
  available() {
    return this.backends.some((backend) => BACKENDS[backend] !== undefined)
  }

  /**
   * Run one query through the failover chain and return the first non-empty
   * answer. When every backend fails, throw with the per-backend reasons, so a
   * rate limit or a vendor change is visible instead of an empty success.
   *
   * @param request - the seam's search request.
   * @param signal - the seam's cancellation signal.
   * @returns the first backend's non-empty result set.
   */
  async search(request, signal) {
    const query = String(request?.query ?? '').trim()
    if (query === '') throw new this.WebError('keyless-search: empty search query', 'WEB_PROVIDER_ERROR')

    const failures = []
    for (const backend of this.backends) {
      const run = BACKENDS[backend]
      if (run === undefined) {
        failures.push(`${backend}: unknown backend`)
        continue
      }
      try {
        const provider = { config: this.config, signal }
        const sources = cap(await run({ query, maxResults: request?.maxResults }, provider), request?.maxResults)
        if (sources.length > 0) {
          if (this.config.debug) this.logger?.info?.(`keyless-search: "${query}" served by ${backend} (${String(sources.length)} sources)`)
          return { sources, truncated: false }
        }
        failures.push(`${backend}: no results`)
      } catch (error) {
        failures.push(`${backend}: ${describeFailure(error)}`)
        if (this.config.debug) this.logger?.warn?.(`keyless-search: backend ${backend} failed: ${describeFailure(error)}`)
      }
    }
    throw new this.WebError(
      `keyless-search: no backend returned results for "${query}" — ${failures.join('; ')}`,
      'WEB_PROVIDER_ERROR',
    )
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry point
 * ------------------------------------------------------------------ */

/**
 * Resolve the loader row's config over the defaults, then register the provider.
 *
 * @param ctx - plugin context carrying the `web` service.
 * @param config - the loader row's `config:` map, if any.
 */
export async function apply(ctx, config) {
  const resolved = { ...DEFAULTS, ...(config ?? {}) }
  resolved.searchBackends = process.env.KEYLESS_SEARCH_BACKENDS ?? resolved.searchBackends
  resolved.timeoutMs = Number(process.env.KEYLESS_SEARCH_TIMEOUT_MS ?? resolved.timeoutMs)
  resolved.debug = resolved.debug === true || process.env.KEYLESS_SEARCH_DEBUG === '1'
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs <= 0) resolved.timeoutMs = DEFAULTS.timeoutMs

  const logger = ctx.logger ?? ctx.console ?? undefined
  let WebError = (await importHarnessPackage('@deepseek-ai/dsh-web'))?.WebError
  if (typeof WebError !== 'function') {
    // Mirrors the seam's error shape so a missing import degrades to identical
    // semantics rather than an uncoded generic Error.
    WebError = class FallbackWebError extends Error {
      constructor(message, code, options) {
        super(message, options)
        this.name = 'WebError'
        this.code = code
      }
    }
  }

  ctx.web.registerSearchProvider(new KeylessSearchProvider(resolved, logger, WebError))
  logger?.info?.(`keyless-search: provider "${PROVIDER_ID}" registered (${resolved.searchBackends})`)
}