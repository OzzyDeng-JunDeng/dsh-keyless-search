# Publishing dsh-keyless-search

Everything below was verified locally against DSH `0.1.6-alpha.2`. Steps 1–3 are
done in this workspace; steps 4–6 are what remains, and they need network writes
to GitHub/npm, which is why they are not done here.

## 1. Push the repo

The package lives at `outputs/dsh-keyless-search/`. It is already a complete,
publishable npm package — no build step, `lib/index.js` is the shipped artifact.

```sh
cd outputs/dsh-keyless-search
git init
git add -A
git commit -m "dsh-keyless-search 0.1.0"
git remote add origin git@github.com:ozzydeng/dsh-keyless-search.git
git push -u origin main
```

Then on GitHub:

- add the **`dsh-plugin`** topic (required by the market's CI)
- confirm the repo is **≥ 1 day old** before opening the PR (also enforced by CI)

`package.json` already points `repository` at
`https://github.com/ozzydeng/dsh-keyless-search`, and the market reads that field
back to map the entry to npm — so the two must agree, and they do.

## 2. Publish to npm

```sh
npm publish --access public
```

Check what actually ships first — `cordis.patch.yml` must be in the tarball, or
the bundle installs with no patch layer at all:

```sh
npm pack --dry-run
# expect: lib/index.js, cordis.patch.yml, package.json, README.md, LICENSE
```

## 3. Verify the install works before submitting

This is the step that matters, because it proves the claim the README makes:

```sh
dsh plugin --profile <a-test-profile> add dsh-keyless-search
dsh --profile <a-test-profile> --dump-config | grep -A4 'patched by dsh-keyless-search'
```

Expected — the bundle repoints the row itself, with no YAML editing:

```
# == @deepseek-ai/dsh-base, patched by dsh-keyless-search
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: keyless-search
    fetchProvider: http
```

Verified locally with a tarball install into a fresh profile: `dsh plugin add`
appended the package to `dsh.profile.bundles`, the composed tree showed the row
above, and `web.search({query})` returned results with no profile patch at all.

## 4. Submit to the market

The catalog is **not** crawled or keyword-matched. Listing is a one-file PR to
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp /path/to/outputs/dsh-keyless-search/publish/ozzydeng__dsh-keyless-search.yml \
   data/plugins/ozzydeng__dsh-keyless-search.yml
git checkout -b add-dsh-keyless-search
git add data/plugins/ozzydeng__dsh-keyless-search.yml
git commit -m "Add ozzydeng/dsh-keyless-search"
git push -u origin add-dsh-keyless-search
gh pr create --title "Add ozzydeng/dsh-keyless-search" \
  --body "Keyless search provider for the built-in web_search tool."
```

Rules the entry file follows:

| Rule | Status |
| --- | --- |
| Filename is `<owner>__<repo>.yml` | ✅ `ozzydeng__dsh-keyless-search.yml` |
| Only `description.en` is required | ✅ both `en` and `zh` written |
| `url` matches the repo exactly | ✅ |
| `category` from the fixed list | ✅ `browser` — the category most search providers on the list use |
| `description.en` ends with a period | ✅ verified |
| Must be quoted if it contains `: ` | ✅ quoted anyway |
| Do **not** hand-edit the generated READMEs | ✅ one file only |
| Do **not** add an `npm:` key | ✅ auto-detected from the registry |
| `dsh.bundle` declared, not just `dsh.client` | ✅ `dsh.bundle.patch` is set |
| Repo has real working code, not a wrapper around nothing | ✅ ~16 kB of parsing and failover logic, no dependencies |
| Repo ≥ 1 day old | ⏳ check before PR |
| `dsh-plugin` topic added | ⏳ step 1 |

**The description is checked against the code.** Every claim in it maps to
something verifiable:

- "keyless … without an API key" → the default chain needs no key (tested with a
  clean environment)
- "documented no-key tiers of Tavily and Firecrawl" → both are vendor-documented
- "failing over between" → the `for (const backend of this.backends)` loop
- "`TAVILY_API_KEY` or `FIRECRAWL_API_KEY` … automatically when present" → the
  `bearer()` helper, plus the keyless hint being dropped when Tavily has a key
- "Two Bing scrape backends … off by default" → `bing-rss` / `bing-html` exist but
  are absent from `DEFAULTS.searchBackends`

Duplicate-check: the closest existing entry is
[`MochiNek0/dsh-web-search-free`](https://github.com/MochiNek0/dsh-web-search-free)
(8 engines, settings card). Per the review criteria, an overlapping entry is a
tiebreaker, not an automatic rejection — a fork is added when it is the
better-kept one or genuinely adds something. The honest differentiators here:

- **only vendor-sanctioned backends by default** — nothing scrapes a search
  engine's results page, so there is no robots/ToS exposure for a default user
- **no settings card and no key required at all** — install and it works
- **fails loudly with per-backend reasons** instead of returning an empty success

Do not oversell this. If the maintainer judges it duplicative, that is a
legitimate call, and the plugin keeps working for anyone installing it directly.

## 5. What NOT to submit

Do **not** enable the Bing backends by default to make the listing look stronger.
`cn.bing.com/robots.txt` disallows `/search` for `User-agent: *`, and the RSS
endpoint is that same path. Shipping that as a default makes every user's traffic
part of a decision they never made. They are opt-in, and
[README.md](../README.md) says so.

## 6. Optional: MCP crawl endpoints

`web_fetch` is the in-box content path and this package does not touch it. If you
want real crawl/extract later, the harness already ships `dsh-mcp-client`, and
these verify as keyless:

| Endpoint | Tools seen |
| --- | --- |
| `https://mcp.firecrawl.dev/mcp` | `firecrawl_scrape`, `firecrawl_search`, `firecrawl_parse` |
| `https://mcp.exa.ai/mcp` | 2 tools, returns `mcp-session-id` |
| `https://search.parallel.ai/mcp` | 2 tools |

This was deliberately **not** installed: an MCP row adds its tools to every
session's tool list, which is a real cost for a capability `web_fetch` mostly
covers. Mounting one is a two-line addition to a profile patch when wanted.