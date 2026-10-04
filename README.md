# 订阅合成器

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sunwu51/subscription-composer)

点击按钮可在自己的 Cloudflare 账户中创建独立部署。Cloudflare 会复制此公开仓库、创建并绑定新的 KV 命名空间，然后通过 Workers Builds 部署。部署表单中的 `ADMIN_SECRET` 必须填写你自己生成的 UUID，并妥善保存；它是管理令牌，也会作为本站 VLESS 节点的 UUID。此按钮不会关联或迁移作者已部署 Worker 中的 KV 数据；要维护已有 Worker，请看下文「GitHub 与已有 Worker」。

一个 Cloudflare Worker 应用。每组输入信息作为一条 JSON 存在 Workers KV；管理页面创建、编辑和删除配置组；每组生成三个带独立令牌的 URL：

| URL | 返回内容 |
| --- | --- |
| `/s/<id>/<token>/mihomo.yaml` | 完整 Mihomo YAML，保留原 YAML 的节点、分组、规则和其他字段，并前置自定义内容 |
| `/s/<id>/<token>/shadowrocket.nodes` | 将原 Mihomo YAML 中可可靠转换的节点转成 URI，再与新节点合并成 Base64 订阅 |
| `/s/<id>/<token>/shadowrocket.conf` | 用户提供的 `default.conf` 或自定义 `.conf`，加上 `RESI` 分组和优先规则 |

**仅支持 Mihomo 和 Shadowrocket。** 原 Mihomo 订阅 URL 可选，填写时须返回完整 YAML。Shadowrocket 节点订阅只从其中的内联 `proxies` 提取节点，原 `rules`、`proxy-groups` 和 `proxy-providers` 不会转换；若只有 provider 而没有内联 `proxies`，会报错。当前节点转换覆盖常见的 HTTP、SOCKS5、普通 SS、VMess（TCP/WS）、VLESS（TCP/WS）、Trojan（TCP/WS）和基础 AnyTLS（密码、SNI、跳过证书校验）。Hysteria2 等不支持的协议类型会跳过，其余节点仍会生成；已支持协议若缺少必要参数、使用 SS 插件、Reality 或无法由 AnyTLS URI 表达的高级 TLS 选项，仍会报错。

Shadowrocket 原 `.conf` URL 必填。页面默认填入本站的 `/shadowrocket-default.conf` 完整链接，它返回用户在 2026-09-29 提供的 App 导出文件；KV 将该默认链接保存为站内路径，换域名后仍指向本站的文件。GitHub 的 [`Shadowrocket/config/default.conf`](https://github.com/Shadowrocket/config/blob/master/default.conf) 可以找到，但该仓库最后更新于 2022 年，不能作为会跟随当前 App 更新的默认规则源。也可填写自定义 HTTPS `.conf` URL。

## 部署到 Cloudflare

在 PowerShell 中进入此目录后：

```powershell
npm install
npx wrangler login
```

`wrangler.jsonc` 已有一组 KV 绑定。使用同一 Cloudflare 账户时无需重复创建；若部署到另一账户，先运行 `npx wrangler kv namespace create CONFIGS`，再将新 namespace `id` 填入 `wrangler.jsonc`。然后设置 `ADMIN_SECRET`，其值必须是 UUID（可用 PowerShell 的 `[guid]::NewGuid().ToString()` 生成）：

```powershell
npx wrangler secret put ADMIN_SECRET
npm run deploy
```

浏览器打开部署命令给出的 HTTPS 地址，初始只显示管理令牌卡片；连接成功后才显示配置管理页面。「第一跳节点」是一条分享链接，住宅节点经它链式连接（Mihomo `dialer-proxy`）。默认填入本站 Worker 中转的 VLESS 链接（节点名 `cf-worker`，UUID 为 `ADMIN_SECRET`，WebSocket 路径 `/ws`），保存时识别为本站中转，KV 中不保存 UUID；点击「恢复本站中转」可重新填入。也可换成任意自建节点的分享链接，例如 233boy 脚本 `sb url` 输出的 Hysteria2 / VLESS Reality 链接。支持 `vless://`、`vmess://`、`trojan://`、`ss://`（不含插件）、`hysteria2://`（`hy2://`）、`tuic://`、`anytls://`、`socks5://`、`http(s)://`；`#` 后的文字是节点名，缺省时为 `first-hop`。Mihomo 端由链接转换成节点；Hysteria2 链接可追加 `up`、`down` 参数（Mbps）写入 Mihomo 带宽。Shadowrocket 端原样下发该链接，只把名称固定为同一节点名。配置 JSON 存在绑定的 KV 命名空间中；项目不使用 Node 本地 JSON 数据文件。KV 键名为 `config:<id>`，每条值含原订阅 URL、第一跳节点、兜底规则、住宅代理账号密码和订阅访问令牌；自定义第一跳时保存完整链接（含其密码或 UUID）。旧版保存的 CF 域名配置读取时自动转换，重新保存后改为新格式。请限制 Cloudflare 账户与 KV 的访问权限。

本地开发可创建一个**不提交**的 `.dev.vars` 文件，内容为 `ADMIN_SECRET=你的UUID`，然后运行 `npm run dev`。默认使用本地 KV；生产部署仍绑定 `wrangler.jsonc` 中现有的 `CONFIGS` 命名空间。`npm test` 运行合并与 Worker 接口测试。`npx wrangler deploy --dry-run` 可在不发布的情况下检查打包。

## GitHub 与已有 Worker

当前 `wrangler.jsonc` 中的 KV ID 指向现有 Cloudflare 账户的 `CONFIGS` 命名空间。发布到公开 GitHub 仓库可以保留这个 ID：它是公开标识，不是访问密钥。部署到其他账户时须换成目标账户的 KV ID；不要删除此 ID 后直接部署，否则可能新建空命名空间，原配置不会自动迁移。

已有的 `subscription-composer` Worker 可以在 Cloudflare 控制台的 **Workers & Pages → subscription-composer → Settings → Builds → Connect** 中关联 GitHub 仓库。仓库根目录就是项目根目录，Worker 名称须与 `wrangler.jsonc` 的 `name` 一致；本项目没有额外构建步骤，部署命令用 `npx wrangler deploy`。将生产分支设为 `main` 后，向该分支推送会触发部署。运行时的 `ADMIN_SECRET` 要在 Worker 的 Variables & Secrets 中配置，不要写入仓库；`.dev.vars*` 和 `.env*` 已加入 `.gitignore`。关联后请核对生产 KV 绑定仍指向现有 `CONFIGS`。

## 更新机制

每次客户端请求 Mihomo 或 Shadowrocket 节点订阅时，若填写了原 Mihomo URL，Worker 会重新请求它。Mihomo 输出合并完整配置；Shadowrocket 输出仅转换内联 `proxies` 节点。使用自定义 Shadowrocket `.conf` URL 时，`.conf` 请求会重新抓取它；使用默认站内链接时读取打包的 default.conf。客户端可设置约 24 小时刷新；本服务不会在后台定时刷新。若上游不可用，此次请求会返回错误，不会返回缺失原节点的“成功”配置。客户端已有的旧配置通常仍在本机，但具体行为取决于客户端。

更新配置组后，KV 在不同边缘节点的读取可能短暂延迟；Cloudflare [说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)称这类变更可能需要约 60 秒或更久传播。不要在一秒内连续写同一组配置。

## Shadowrocket 使用

1. 首页添加节点订阅 URL。
2. 「配置」页面添加远程 `.conf` URL，启用后将全局路由设为「配置」。
3. 逐个打开住宅节点的 `ⓘ → 代理通过`，选择第一跳节点（默认 `cf-worker`，自定义时为链接 `#` 后的名称）。不要给第一跳节点自身设置代理通过。
4. 在「设置 → 订阅」开启「保持代理通过」，并在更新后检查链式关系。

Shadowrocket 的节点订阅和 `.conf` 不能等同于 Mihomo 完整 YAML。当前版本不会自动下发 Shadowrocket 的链式关系；应用页面也明确显示了手动步骤。UDP 443 拒绝规则不再手动勾选：第一跳支持 UDP（本站 Worker 中转和 `http://` 不支持），且所有住宅节点都是支持 UDP 的 SOCKS5 时不添加；否则两端都对 OpenAI/Claude 域名拒绝 UDP 443，让 App 立即改走 TCP。该规则只有客户端能识别 UDP 连接的域名时才会命中。Shadowrocket URI 导入行为受客户端版本影响，首次使用请在 iPhone 上检查节点、分组以及规则是否正确识别。

## 安全与限制

- 订阅 URL 中的 `<token>` 是访问凭据；拿到它的人能读取包含代理账号密码的配置。不要公开分享 URL。删除配置组会使 URL 失效，受 KV 传播延迟影响，失效不是全球瞬时的。
- 管理接口每次请求都需要 `Authorization: Bearer <ADMIN_SECRET>` 请求头；管理令牌不放在请求体内。网页仅把令牌放入本标签页的 `sessionStorage`。客户端更新订阅时无需管理令牌，使用 URL 路径里的独立 `<token>`。
- 第一跳使用本站 Worker 中转时，`ADMIN_SECRET` 也是 VLESS UUID，会直接出现在 Mihomo 和 Shadowrocket 节点订阅中。持有这类订阅链接的人能读出它并调用全部管理接口。不要向不应拥有管理权限的人分享订阅链接；使用自定义第一跳时，节点订阅不会包含本站的 `ADMIN_SECRET`。
- 原订阅只允许 HTTPS，单个响应上限 2 MB，读取超时 20 秒。
- Mihomo 原配置与新增节点或 `RESI` 重名时，生成会报错，以免静默覆盖。
- 域名路由使用明确的 `DOMAIN-SUFFIX`，不再用 `DOMAIN-KEYWORD`。规则列表在 `src/model.js` 中：OpenAI 域名参考其[网络建议](https://help.openai.com/en/articles/9247338-network-recommendations-for-chatgpt-errors-on-web-and-apps)，Claude 域名参考其[网络访问说明](https://support.claude.com/en/articles/13198485-enforce-network-level-access-control-with-tenant-restrictions)。`ipinfo.io` 仍路由到住宅组，但不列入 UDP 443 拒绝范围。
- 自定义第一跳插入 Mihomo 原订阅每个分组的第 2 位（不改变各分组的默认选择）；本站 Worker 中转只追加到第一个分组末尾；兜底选第一跳分组，或原订阅没有分组时，新建只含第一跳节点的 `FIRST-HOP` 分组。
- 住宅代理可选 HTTP（默认）或 SOCKS5；SOCKS5 可标记是否支持 UDP（默认支持，服务商实际不支持时请改为否）。住宅分组名为 `RESI`（旧版的 `US-RESI` 兜底选项读取时自动迁移）。
- 兜底规则可选：沿用原订阅（需填写 Mihomo 原订阅，为默认值）、`DIRECT`（未填原订阅时的默认值）、`RESI` 住宅分组、第一跳分组（`FIRST-HOP`）。选「沿用原订阅」时，Mihomo 原规则若非空，保持原样接在新规则后面，**不额外添加** `MATCH`；若没有原规则才添加 `MATCH,DIRECT`；Shadowrocket `.conf` 保留原 `FINAL`，没有规则时添加 `FINAL,PROXY`。选其他项时，原规则中的 `MATCH` / `FINAL` 被移除，并在末尾写入所选目标；Shadowrocket 选第一跳分组时新增 `FIRST-HOP = select, <第一跳节点>` 分组。
- 未填写 Mihomo 原订阅时，生成的配置额外写入 `mixed-port: 7890` 和 `dns` 段（`redir-host` 模式，国内 DoH 为主、Cloudflare 等为 fallback，配置见 `src/model.js` 的 `DEFAULT_MIHOMO_DNS`）；填写原订阅时沿用原配置的 DNS，不做改动。
- 「兜底前追加中国大陆直连」默认勾选（旧配置读取时也视为勾选）：Mihomo 在 `MATCH` 正前方插入 `GEOSITE,CN,DIRECT`、`GEOIP,CN,DIRECT`，使用客户端内置的 geo 数据库；Shadowrocket 在 `FINAL` 正前方插入 [blackmatrix7 China 规则集](https://github.com/blackmatrix7/ios_rule_script/tree/master/rule/Shadowrocket/China)（`RULE-SET`）和 `GEOIP,CN,DIRECT`。原订阅已有同类规则时重复一条无副作用。
