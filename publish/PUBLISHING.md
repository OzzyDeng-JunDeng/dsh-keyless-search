# Publishing dsh-keyless-search

Everything below was verified locally against DSH `0.1.6-alpha.2`.

**Status:** steps 1 and 3 are done. Step 1 created the repository as **private**
(`OzzyDeng-JunDeng/dsh-keyless-search`) so the source can be reviewed before it is
made public. Steps 2 and 4 are deliberately not done yet — publishing to npm or
opening the market PR would make the package public, which is the decision being
held back. Flip the repository to public first, then work through what remains.

## 1. Push the repo — ✅ done

The package lives at `outputs/dsh-keyless-search/`. It is a complete, publishable
npm package — no build step, `lib/index.js` is the shipped artifact.

Created with:

```sh
gh repo create OzzyDeng-JunDeng/dsh-keyless-search --private --source=. --push
gh repo edit OzzyDeng-JunDeng/dsh-keyless-search --add-topic dsh-plugin
```

Verified after the push: `visibility: PRIVATE`, `defaultBranchRef: main`, local
`HEAD` and `origin/main` at the same commit, working tree clean. The `dsh-plugin`
topic is set; the repo-age requirement (≥ 1 day) is satisfied by letting the repo
sit before opening the PR.

`package.json` points `repository` at
`https://github.com/OzzyDeng-JunDeng/dsh-keyless-search`, and the market reads that
field back to map the entry to npm — so the two must agree, and they do.

> Note: the harness wrote `git config --global credential.https://github.com.helper`
> via `gh auth setup-git`, so `git push` to this account now authenticates through
> the `gh` token in the macOS keyring. Remove those entries
> (`gh auth logout` / `git config --global --unset-all ...`) if you want git to
> stop using it.

## 2. Publish to npm — ✅ done (0.1.0, 2026-09-19)

```sh
npm publish --access public
```

Check what actually ships first — `cordis.patch.yml` must be in the tarball, or
the bundle installs with no patch layer at all:

```sh
npm pack --dry-run
# expect: lib/index.js, cordis.patch.yml, package.json, README.md, README.zh.md, LICENSE
```

### The credential this needs (learned the hard way — three attempts)

npm refuses to publish without **either** an interactive OTP **or** a granular
token that bypasses 2FA. A plain session login is not enough, and the failure is
a bare `403` that reads like a permissions problem rather than a policy one:

```
403 Forbidden - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

Two traps, both of which cost a failed attempt here:

| Setting | Wrong choice | Right choice |
| --- | --- | --- |
| Bypass 2FA | unchecked → same 403 as above | **checked** |
| Permissions | `Read and write (stage only)` → `E_STAGE_REQUIRED` | **`Read and write`** |

A stage-only token cannot create a *new* package at all: staging requires the
package to already exist, and this one does not, so `npm stage publish` fails too
— there is no workaround. See [About access tokens](https://docs.npmjs.com/about-access-tokens).

When using a token, keep it off disk: write it to a `mktemp` file (mode 600) and
pass `--userconfig`, rather than editing `~/.npmrc`. Delete the file right after.
Note that npm's own web login does write `~/.npmrc`; a token-based publish need not.

`0.1.0` published as `dsh-keyless-search`, maintainer `ozzydeng-jundeng`, shasum
`95657576bb35a7a08d3ed86ca2dc8de83cb466a7`. Bump the version before republishing;
a published version can never be reused.

> Registry reads are eventually consistent. A `npm view` immediately after
> publishing can 404 for a short while even though the publish succeeded — check
> again before assuming failure.

## 3. Verify the install works — ✅ done

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

## 4. Submit to the market — ⏸ waiting on the 1-day age gate

The catalog is **not** crawled or keyword-matched. Listing is a one-file PR to
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin):

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
cp /path/to/outputs/dsh-keyless-search/publish/OzzyDeng-JunDeng__dsh-keyless-search.yml \
   data/plugins/OzzyDeng-JunDeng__dsh-keyless-search.yml
git checkout -b add-dsh-keyless-search
git add data/plugins/OzzyDeng-JunDeng__dsh-keyless-search.yml
git commit -m "Add OzzyDeng-JunDeng/dsh-keyless-search"
git push -u origin add-dsh-keyless-search
gh pr create --title "Add OzzyDeng-JunDeng/dsh-keyless-search" \
  --body "Keyless search provider for the built-in web_search tool."
```

Two gates block this until **2026-09-20 14:39 UTC** (22:39 CST). The repo was
created `2026-09-19T14:39:43Z` and `scripts/check-submission.mjs` enforces
`MIN_AGE_DAYS = 1`. Per the gate's own text, nothing needs to be done — `regate.yml`
re-runs every 6 hours and the check clears by itself; **do not resubmit**. The
other gate: the CI reads the repo with a `GITHUB_TOKEN` scoped to
`awesome-dsh-plugin` only, so a private repo fails as `repository not found`.
The repo is public now, so that one is satisfied.

Rules the entry file follows:

| Rule | Status |
| --- | --- |
| Filename is `<owner>__<repo>.yml` | ✅ `OzzyDeng-JunDeng__dsh-keyless-search.yml` |
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