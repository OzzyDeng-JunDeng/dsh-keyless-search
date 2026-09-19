# dsh-keyless-search

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供免密钥的网页搜索。

它让内置的 `web_search` 工具在 **无需 API Key、无需账号、无需任何配置** 的情况下直接可用。`dsh-base` 默认把该能力接口指向 DeepSeek 自托管的搜索提供方，需要 `DEEPSEEK_API_KEY`；没有这个 Key 时，`web_search` 会报错：

> DeepSeek search has no API key for "DEEPSEEK_API_KEY"

本 bundle 注册一个免密钥的提供方，并把接口重新指向它。

## 安装

```bash
dsh plugin --profile <your-profile> add dsh-keyless-search
```

这就是全部安装步骤。本包声明了 `dsh.bundle`，因此 `dsh plugin add` 会把它追加到
`dsh.profile.bundles` 中——位置在 `@deepseek-ai/dsh-base` **之后**，这正是它覆盖
`web` 那一行能生效的原因。**不需要手改任何 YAML。** 新开一个会话即可验证：提供方会在会话启动、工具列表组装时注册。

卸载：

```bash
dsh plugin --profile <your-profile> remove dsh-keyless-search
```

## 后端

按顺序尝试，第一个返回非空结果的后端即被采用。

| 后端 | 默认启用 | 来源 |
| --- | --- | --- |
| `tavily` | ✅ | [`api.tavily.com/search`](https://docs.tavily.com/documentation/keyless) 的 keyless 访问模式 |
| `firecrawl` | ✅ | `api.firecrawl.dev/v2/search` 的 keyless 通道 |
| `bing-rss` | ❌ 需手动开启 | Bing 结果页的 RSS 源 |
| `bing-html` | ❌ 需手动开启 | Bing 结果页的 HTML 结构 |

### 为什么 Bing 后端默认关闭

这两个后端请求的是 Bing 的搜索结果端点，而 Bing 的 `robots.txt` 对
`User-agent: *` 明确禁止了 `/search`：

```
User-agent: *
Disallow: /search
Disallow: /Search
```

RSS 版本只是同一路径加上 `?format=rss`，因此受同一条规则约束。它确实是这里**最稳的**解析方式——结构化 feed，没有会变动的页面结构——这也是它仍被保留的原因。但把一个搜索引擎抓取器作为**默认**行为发布，等于在用户不知情的情况下，让每个人的流量都参与了这个决定。所以它被设为手动开启，启用它应当被视为对该取舍深思熟虑后的选择。

相比之下，`tavily` 与 `firecrawl` 是厂商**官方文档化的**免密钥服务。Tavily 的
[keyless 页面](https://docs.tavily.com/documentation/keyless) 写明「No account, no API key, no configuration」，并说明免密钥响应与带密钥响应的 schema 完全一致。这两个后端都不抓取任何人的搜索结果页。

## 配置

所有配置项均为可选。

```yaml
# 写在某个 profile 的 cordis.patch.yml 里，用于覆盖 bundle 的默认值：
- id: keyless-search
  name: dsh-keyless-search
  config:
    searchBackends: tavily,firecrawl
    timeoutMs: 15000
    debug: false
    bingHost: cn.bing.com
    bingMarket: zh-CN
```

环境变量覆盖：`KEYLESS_SEARCH_BACKENDS`、`KEYLESS_SEARCH_TIMEOUT_MS`、
`KEYLESS_SEARCH_DEBUG=1`。

### 之后想加 Key

两家厂商官方文档化的升级路径都无需改动配置。设置 `TAVILY_API_KEY` 或
`FIRECRAWL_API_KEY`，提供方会自动携带——这些免费 Key 能提高限额（Tavily：每月 1,000 credits，无需信用卡）。当 Tavily 存在 Key 时，`x-tavily-access-mode: keyless` 提示会被省略，因为带密钥的请求不应携带它。

## 行为特性

- **失败时如实报错。** 若所有后端都失败，提供方会抛出携带每个后端具体原因的异常，而不是返回一个「空成功」，因此限流或厂商侧变更都是可见的，不会静默。传输层错误会从 `cause` 中解出真实原因，DNS 错误、TLS 拒绝、超时不再一律显示为 `fetch failed`。
- **可归因。** 开启 `debug: true` 后，每次查询都会记录是哪个后端服务了它。
- **限流是真实存在的。** 免密钥通道免费但按设计有限流。「降级链 + 一个 Key」才是预期做法，而不是绕过手段。
- **零依赖。** 本模块没有任何静态 import，因此即使所在 profile 解析不到任何 harness 包也能加载。唯一的运行时 import 是用于获取错误类的 `@deepseek-ai/dsh-web`，并带有形状兼容的兜底实现。

## 作用范围

本 bundle 只注册**搜索**提供方。它不触碰 `web_fetch`，也不提供任何抓取提供方。

如果你机器上的 `web_fetch` 报 `resolves to a non-public IP address`，那是你本地网络环境的另一个独立问题，解法是配置而非代码——见下。

<details>
<summary>web_fetch 与本地 fake-IP / 透明代理</summary>

`dsh-web-fetch-http` 会校验每一个 DNS 解析结果，并拒绝非公网地址。在透明
fake-IP 代理（Clash/Surge 一类）后面，**所有**域名都会解析到 `198.18.0.0/15`
——这属于 RFC 2544 基准测试地址段，因此被拒绝，于是尽管网络本身是通的，
`web_fetch` 对每个 URL 都失败。

而该提供方本身已经为这种情况准备好了正确的处理方式。在
`@deepseek-ai/dsh-web-fetch-http` 中：

```js
const route = proxyRouteFor(url);
if (route.proxied && !isNonPublicIpLiteral(url.hostname))
  return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal);
const addresses = await this.resolveAddresses(url.hostname, signal); // 代理路径会跳过这一步
```

当已安装代理策略时，地址校验会被完全跳过，改由代理完成解析。而
`$DSH_HOME/.env` 被明确允许设置这些代理变量（`dsh-app-boot` 中的
`HOME_LAYER_PROXY_NAMES`）——其它启动期变量都不允许从 `.env` 注入，代理是特意开的例外。

所以解法是两行配置，无需写代码：

```bash
# ~/.dsh/.env —— 请改成你自己本地代理的地址与端口
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
```

（`7897` 是 Clash 一类代理常用的端口，请替换为你自己的。）

已验证：**未经修改的**原厂提供方此后能正常抓取公网站点，同时仍然拦截
`127.0.0.1`、`169.254.169.254` 以及 RFC1918 地址字面量。

⚠️ 采用前请注意这个取舍。代理路径会跳过地址校验，意味着一个解析到内网地址的**域名**会被交给代理。IP **字面量**仍然被拦截（`isNonPublicIpLiteral`），但解析向内网的域名不会。如果 `web_fetch` 会接触不可信输入，这是一个真实的 SSRF 暴露面——而本 bundle 不提供抓取提供方，因此它既没有引入、也没有修复这个问题。
</details>

## 环境要求

- Node ≥ 18（需要 `fetch`、`AbortSignal.any`、`AbortSignal.timeout`）
- 一个组合了 `@deepseek-ai/dsh-base` 的 DSH profile

## 许可证

MIT