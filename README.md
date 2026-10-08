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
- **Its own text is hardened.** Everything page-controlled is escaped before the
  consumer formats it, so page content cannot break the line the consumer owns or
  replay the consumer's own framing — see
  [Untrusted provider text](#untrusted-provider-text). Ordinary prose passes
  through byte for byte.

## Scope

This bundle registers a **search** provider only. It does not touch `web_fetch`
and ships no fetch provider.

### Untrusted provider text

The consumer (`dsh-tool-web`) splices provider text into a line it owns:

```
- [<title>](<url>) — <snippet> (<publishedAt>)
```

and escapes none of it. The title and the snippet both come from a web page, so
page content can break that line — a title of `Legit title](https://evil.example)`
makes the renderer emit a second link and retarget the citation — and the same
text sits beside the consumer's own framing sentences, which it can replay
verbatim. The consumer already marks its results untrusted; what it cannot do is
stop provider text from breaking the framing it is marked with.

So the provider hardens what it contributes, once, at the provider boundary:
every backend goes through it, so the failover chain cannot route around it.

**What it does.** Each field is normalized, stripped of the consumer's framing
sentences (replaced with `«text withheld»`), and escaped for the eight characters
that can *begin* an inline construct — `` \ ` [ ] < * _ ~ ``. Escaping is
lossless: each escape renders as the character it guards, so
`A function (from a set to a set) is a relation.` reaches the reader unchanged.
`*` and `_` are escaped because emphasis consumes its own delimiters, which would
otherwise let a page delete characters from the text. Parentheses are deliberately
*not* escaped — they cannot begin a construct on this line, and escaping them would
lace ordinary prose with backslashes. URLs get `( ) [ ]` percent-encoded, because
an unbalanced `)` in a destination is what lets a crafted URL close the link
early and open a second one. The snippet is then wrapped in
`⟦UNTRUSTED-WEB backend=<name>⟧ … ⟧` — inline and single-line, because the
consumer's list is line-oriented and a boundary carrying a newline would break the
format it exists to protect. The title stays bare: it is the visible link text, so
a boundary there would put marker noise on every citation. The URL stays outside
the boundary, because the consumer instructs the model to cite it.

**What it does not do.** It stops structural forgery: breaking the line,
injecting raw HTML, an image or a code span, retargeting a link, or impersonating
the consumer's framing. It does **not** stop semantic misdirection — a persuasive
snippet is still read as text, and a reworded instruction is not recognized. A
bare URL inside a snippet is still autolinked, because GFM resolves escapes before
it looks for URLs; only invisible characters or mangling the URL would prevent
that, and neither is worth the cost. Nor does it cover other providers or
`web_fetch`: the durable fix belongs in the consumer's formatter, where one change
would cover every provider at once.

**If the consumer starts escaping its own line.** Both layers must not escape.
The escaping above exists only because the formatter today escapes nothing, and
backslash escaping is not idempotent in effect — applying it twice shows the
backslashes to the reader. The change that belongs in the consumer is the same
one, one place, covering every provider: escape the label, snippet and date, and
percent-encode the destination. When that lands, this provider's escape step and
URL encoding should be **deleted**, not left in place; the boundary and the
framing handling stay, because the consumer still cannot stop provider text from
replaying its own framing sentences.

Each claim above is a test in `test/hardening.test.js`, which parses the
consumer's line with the consumer's own grammar (mdast + GFM) instead of
asserting on substrings of the hardened string.

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

- Node ≥ 18 (for `fetch` and `AbortSignal.timeout`)
- A DSH profile that composes `@deepseek-ai/dsh-base`

## License

MIT