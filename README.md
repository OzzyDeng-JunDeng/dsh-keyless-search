# dsh-keyless-search

English | [中文](README.zh.md)

Keyless web search for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Makes the built-in `web_search` tool work with **no API key, no account, and no
configuration step**. `dsh-base` ships the seam pinned to a DeepSeek-hosted
provider that requires `DEEPSEEK_API_KEY`, so without one `web_search` fails
with:

> DeepSeek search has no API key for "DEEPSEEK_API_KEY"

This bundle registers a keyless provider and repoints the seam at it.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-keyless-search
```

That is the whole install. The package is on npm as
[`dsh-keyless-search`](https://www.npmjs.com/package/dsh-keyless-search), and it
declares `dsh.bundle`, so `dsh plugin add` appends it to `dsh.profile.bundles` —
after `@deepseek-ai/dsh-base`, which is why its `web` row override wins. **No YAML
editing is required.** Verify in a new session: the provider registers at session
start, when the tool list is composed.

To remove it:

```bash
dsh plugin --profile <your-profile> remove dsh-keyless-search
```

## Backends

Searched in order; the first non-empty result wins.

| Backend | Default | Source |
| --- | --- | --- |
| `tavily` | ✅ | [`api.tavily.com/search`](https://docs.tavily.com/documentation/keyless) keyless access mode |
| `firecrawl` | ✅ | `api.firecrawl.dev/v2/search` keyless tier |
| `bing-rss` | ❌ opt-in | Bing's result RSS feed |
| `bing-html` | ❌ opt-in | Bing result-page markup |

### Why the Bing backends are off by default

They request Bing's result endpoint, and Bing's `robots.txt` disallows `/search`
for `User-agent: *`:

```
User-agent: *
Disallow: /search
Disallow: /Search
```

The RSS variant is the same path with `?format=rss`, so it falls under the same
rule. It genuinely is the sturdiest parser here — a structured feed with no
markup to break — which is why it is included at all. But shipping a
search-engine scraper as a *default* would make every user's traffic part of that
decision without their knowledge, so it is opt-in and you should treat enabling
it as a deliberate choice about the trade-off.

By contrast, `tavily` and `firecrawl` are the vendors' own documented no-key
offerings. Tavily's [keyless page](https://docs.tavily.com/documentation/keyless)
says "No account, no API key, no configuration", and describes keyless responses
as identical in schema to keyed ones. Neither backend scrapes anyone's result
page.

## Configuration

All keys are optional.

```yaml
# In a profile's cordis.patch.yml, to override the bundle's defaults:
- id: keyless-search
  name: dsh-keyless-search
  config:
    searchBackends: tavily,firecrawl
    timeoutMs: 15000
    debug: false
    bingHost: cn.bing.com
    bingMarket: zh-CN
```

Environment overrides: `KEYLESS_SEARCH_BACKENDS`, `KEYLESS_SEARCH_TIMEOUT_MS`,
`KEYLESS_SEARCH_DEBUG=1`.

### Adding a key later

Both vendors' documented upgrade path works with no configuration change. Set
`TAVILY_API_KEY` or `FIRECRAWL_API_KEY` and the provider sends it automatically —
these free keys raise the rate limit (Tavily: 1,000 credits/month, no credit
card). When a key is present for Tavily, the `x-tavily-access-mode: keyless`
hint is omitted, because a keyed request must not carry it.

## Behaviour

- **Fails loudly.** If every backend fails, the provider throws with the
  per-backend reason rather than returning an empty success, so a rate limit or
  a vendor-side change is visible instead of silent. Transport failures are
  unwrapped from `cause`, so a DNS error, a TLS refusal, and a timeout read
  differently instead of all saying `fetch failed`.
- **Attribution.** With `debug: true`, each query logs the backend that served it.
- **Rate limits are real.** Keyless tiers are free and throttled by design. The
  failover chain plus a key is the intended answer, not a workaround.
- **Zero dependencies.** The module has no static imports, so it loads even from
  a profile that resolves none of the harness packages. Its only runtime import
  is `@deepseek-ai/dsh-web` for the error class, with a shape-compatible
  fallback.

## Scope

This bundle registers a **search** provider only. It does not touch `web_fetch`
and ships no fetch provider.

If `web_fetch` fails on your machine with `resolves to a non-public IP address`,
that is a separate issue with your local network setup, and the fix is
configuration rather than code — see below.

<details>
<summary>web_fetch and local fake-IP / transparent proxies</summary>

`dsh-web-fetch-http` validates every DNS answer and refuses non-public
addresses. On a machine behind a transparent fake-IP proxy (Clash/Surge-style),
*every* hostname resolves into `198.18.0.0/15`, which is RFC 2544 benchmarking
space and therefore rejected — so `web_fetch` fails for every URL even though the
network works.

The provider already has the right answer for this. In
`@deepseek-ai/dsh-web-fetch-http`:

```js
const route = proxyRouteFor(url);
if (route.proxied && !isNonPublicIpLiteral(url.hostname))
  return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);
const addresses = await this.resolveAddresses(url.hostname, signal); // proxy path skips this
```

When a proxy policy is installed, the address check is skipped entirely and the
proxy does the resolution. And `$DSH_HOME/.env` is explicitly allowed to set the
proxy names (`HOME_LAYER_PROXY_NAMES` in `dsh-app-boot`) — other bootstrap
variables are refused from `.env`, but a proxy is deliberately exempted.

So the fix is two lines, no code:

```bash
# ~/.dsh/.env — point these at your own local proxy's address and port
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
```

(`7897` is a port Clash-style proxies commonly use; substitute your own.)

Verified: the **unmodified** shipped provider then fetches public sites while
still blocking `127.0.0.1`, `169.254.169.254`, and RFC1918 literals.

⚠️ Note the trade-off before reaching for that. The proxy path skips the address
check, which means a hostname that resolves to an internal address can be handed
to the proxy. IP *literals* stay blocked (`isNonPublicIpLiteral`), but a name
resolving inward does not. If `web_fetch` is exposed to untrusted input, that is
a real SSRF surface — and this bundle does not add a fetch provider, so it
neither introduces nor fixes it.
</details>

## Requirements

- Node ≥ 18 (for `fetch`, `AbortSignal.any`, `AbortSignal.timeout`)
- A DSH profile that composes `@deepseek-ai/dsh-base`

## License

MIT