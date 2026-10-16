# Knight · Clash Verge Rev 防泄露与代理优化

给 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)（mihomo 内核）用的两个扩展文件，作用是防 **DNS 泄露**、防 **WebRTC 泄露**，并顺带做一些代理优化。

| 文件 | 放在哪 | 作用 |
| --- | --- | --- |
| [`clash-verge-rev/script.js`](clash-verge-rev/script.js) | 订阅 → **全局扩展脚本** | 全部功能：DNS、嗅探、性能参数、前置防泄露规则、节点和分组优化，可选完整分流 |
| [`clash-verge-rev/merge.yaml`](clash-verge-rev/merge.yaml) | 订阅 → **全局扩展覆写配置** | DNS、嗅探、性能参数（不含规则） |

**只装 `script.js` 就够了。** `merge.yaml` 适合不想用脚本的人；Merge 没办法把规则插到规则列表最前面，所以 WebRTC 规则只能靠脚本来加。两个都启用也没问题，它们写入的值相同。

> 适用版本：Clash Verge Rev 2.x，内核 mihomo ≥ 1.19。

---

## 一、处理了哪些泄露

| 泄露 | 怎么发生的 | 本方案怎么处理 |
| --- | --- | --- |
| **DNS 泄露** | 订阅常用国内 DNS 解析所有域名，或者带着 `fallback`，运营商能看到你查了哪些境外网站 | 使用 Fake-IP；国内域名交给国内 DoH，其余域名交给境外 DoH，并且这些 DNS 查询本身也走代理发出（`respect-rules`）；同时清掉订阅自带的 `fallback` |
| **规则匹配引起的解析** | `GEOIP` / `IP-CIDR` 这类规则要先把域名解析成 IP 才能匹配 | 同上：境外域名只会被境外 DoH 解析，而且查询经过代理 |
| **WebRTC 泄露** | 浏览器用 UDP 去问 STUN 服务器你的公网 IP。系统代理模式下 UDP 根本不经过 Clash；就算开了 TUN，如果 STUN 服务器在国内，也会被 `GEOIP,CN` 规则放行直连 | 要求开启 TUN；STUN/TURN 端口（3478-3479、5349-5350、19302-19309）不管目标在哪，一律走代理（或直接拦截） |
| **IPv6 泄露** | 只代理 IPv4 时，IPv6 流量可能直接出去 | DNS 不返回 IPv6 地址；另外建议在 Verge 里关闭 IPv6，并开启 TUN 的严格路由 |
| **Windows 多网卡 DNS** | Windows 会同时向每块网卡的 DNS 发查询 | 开启 TUN 的「严格路由」 |
| **浏览器 / 系统自带 DoH** | 绕过 Clash 自己去解析 | 建议关掉（见第四节）；域名嗅探可以兜底还原出域名，DoH 服务器的 IP 也有专门规则 |

### 优化项

- `tcp-concurrent`：一个域名解析出多个 IP 时同时握手，用最快的那个
- 域名嗅探（sniffer）：应用直接用 IP 连接时也能按域名分流
- 境外 QUIC（UDP 443）被拦截，浏览器会改用 TCP。多数机场节点走 TCP 更稳更快，国内 QUIC 不受影响
- 删除「剩余流量 / 到期时间 / 官网」这类信息节点，它们不会再混进自动测速
- 给支持 UDP 的协议补上 `udp: true`（机场漏配时语音和 WebRTC 会失败）
- 给 TLS 类节点补 uTLS 指纹（`chrome`）。新版 mihomo 已经删掉了 `global-client-fingerprint`，脚本会把它改成逐个节点设置
- 统一测速参数：`https://www.gstatic.com/generate_204`，间隔 300 秒，容差 50 ms
- 记住手动选择的节点，重启后保留 Fake-IP 映射
- GEO 数据走国内可以直连的 jsDelivr 镜像，并自动更新
- **full 模式（可选）**：地区自动测速分组，AI / GitHub / YouTube / Google / Telegram / Netflix / 微软 / 苹果 各自分流，广告拦截，规则集使用 MetaCubeX 的 `.mrs` 格式

---

## 二、安装

1. 打开 Clash Verge Rev，进入「**订阅**」页。
2. 右键页面上方的「**全局扩展脚本**」→「编辑文件」，把里面的内容全部换成 [`script.js`](clash-verge-rev/script.js)，保存。
3. （可选）右键「**全局扩展覆写配置**」→「编辑文件」，把内容全部换成 [`merge.yaml`](clash-verge-rev/merge.yaml)，保存。
4. 保存后 Verge 会重新生成配置。如果没生效，重新点选一次当前订阅。
5. 点「全局扩展脚本」卡片右侧的日志按钮（脚本控制台输出），确认没有 `[防泄露]` 开头的警告。

只想对某一个订阅生效：右键那个订阅 →「扩展脚本」或「扩展覆写配置」。

> Verge 的执行顺序：订阅原文 → 应用设置 → 全局扩展覆写配置 → 全局扩展脚本 → 订阅扩展覆写配置 → 订阅扩展脚本 → 应用设置回写。

---

## 三、需要配合的 Verge 设置（重要）

`ipv6`、`unified-delay`、`tun.*` 这些字段归 Verge 的设置页管。在扩展文件里写了也会被丢掉，所以这里没写，需要你在界面里手动设置：

| 位置 | 怎么设 | 为什么 |
| --- | --- | --- |
| 设置 → 系统设置 → **虚拟网卡模式** | **开启** | WebRTC 这类 UDP 流量只有在 TUN 模式下才会经过 Clash |
| 虚拟网卡模式右侧的设置按钮 | **严格路由：开**；DNS 劫持：`any:53`（默认值）；TUN 模式堆栈：Mixed 或 gVisor | 严格路由能防住 Windows 多网卡 DNS 泄露，不受支持的网络会被直接断开而不是直连 |
| 设置 → Clash 设置 → **IPv6** | 关闭 | 避免 IPv6 流量绕开代理 |
| 设置 → Clash 设置 → **DNS 覆写** | **关闭** | 开着的话，Verge 会用自己的 DNS 设置盖掉本方案 |
| 设置 → Clash 设置 → 统一延迟 | 开启（可选） | 测速结果更准 |

开了 TUN 之后就不需要再开系统代理了，同时开着也没关系。

---

## 四、浏览器和系统（建议）

- **关闭浏览器自带的安全 DNS**，DNS 统一交给 Clash 处理：
  - Chrome / Edge：设置 → 隐私和安全 → 安全 →「使用安全 DNS」关闭
  - Firefox：设置 → 隐私与安全 →「基于 HTTPS 的 DNS」关闭
- **Windows 11**：网卡的「DNS 服务器分配」保持自动，不要设置系统级 DoH（比如填 223.5.5.5 加密）。
- **只能用系统代理、开不了 TUN 时**，Clash 管不到 WebRTC，只能在浏览器里限制：
  - Chrome / Edge：安装 Google 官方扩展「WebRTC Network Limiter」，选择 *Use my proxy server (if present)*
  - Firefox：在 `about:config` 中设置 `media.peerconnection.ice.proxy_only_if_behind_proxy = true` 和 `media.peerconnection.ice.default_address_only = true`；想彻底关掉 WebRTC 就设 `media.peerconnection.enabled = false`

---

## 五、自检

| 网站 | 应该看到 |
| --- | --- |
| <https://browserleaks.com/webrtc> | Public IP 是节点的 IP 或者为空，**不能出现你的真实 IP** |
| <https://browserleaks.com/dns> 或 <https://www.dnsleaktest.com>（Extended test） | 只有 Cloudflare、Google 或节点所在机房的 DNS，**不能出现国内运营商** |
| <https://ipleak.net> | 综合检查，IP、DNS、WebRTC 都不是你的真实信息 |

---

## 六、参数（`script.js` 顶部的 `CONFIG`）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `"enhance"` | `enhance`：保留订阅自带的分组和规则，只叠加防泄露规则和优化；`full`：订阅只负责提供节点，分组和分流由脚本生成 |
| `mainGroup` | `""` | 防泄露规则用哪个分组出站。留空会自动识别（优先找名字里带「节点选择 / Proxy」的 select 分组） |
| `webrtc` | `"proxy"` | `proxy` 走代理（通话可用，只暴露节点 IP）；`reject` 直接拦截（最彻底，网页音视频通话可能失败）；`off` 不处理 |
| `blockQUIC` | `true` | 拦截境外 QUIC，让浏览器回落到 TCP |
| `dnsIPv6` | `false` | DNS 是否返回 IPv6 地址 |
| `lanDNS` | `""` | 局域网主机名（`router.lan`、`nas.local`）用哪个 DNS 解析，填路由器 IP，比如 `"192.168.1.1"` |
| `removeInfoNodes` | `true` | 删除信息节点（`proxy-providers` 里的节点由内核通过 `exclude-filter` 过滤） |
| `forceUDP` | `true` | 为 ss / ssr / vmess / vless / trojan / socks5 / anytls 开启 UDP |
| `clientFingerprint` | `"chrome"` | TLS 类节点没有指纹时补上的 uTLS 指纹，填 `""` 表示不处理 |
| `healthCheck` | 见文件 | 自动测速分组的测速地址、间隔、容差和超时 |
| `extraRules` | `[]` | 优先级最高的自定义规则，排在防泄露规则前面 |
| `adBlock` | `true` | full 模式下的广告拦截分组（可以在面板里切到 DIRECT） |
| `ruleBase` / `geoBase` | jsDelivr 镜像 | 规则集和 GEO 数据的下载地址 |

### full 模式生成的分组

`🚀 节点选择`、`♻️ 自动选择`、`🤖 AI 服务`（默认优先美国，不含香港）、`🐙 GitHub`、`📺 YouTube`、`🔍 Google`、`✈️ Telegram`、`🎬 Netflix`、`Ⓜ️ 微软服务`（默认直连）、`🍎 苹果服务`（默认直连）、`🎯 全球直连`、`🛑 广告拦截`、`🐟 漏网之鱼`，以及按节点名自动识别出来的 `香港 / 台湾 / 日本 / 新加坡 / 美国` 测速组。

- 只会给有节点的地区建分组。订阅用的是 `proxy-providers` 时没法预先知道有哪些节点，脚本会把五个地区组全部建出来。空分组会回落到 `REJECT`，不会悄悄变成直连。
- 第一次启动时要下载规则集，下载完成前对应规则不会生效。

---

## 七、常见问题

**网页语音 / 视频（Google Meet、Discord、Teams 网页版）卡顿或连不上？**
WebRTC 走代理需要节点支持 UDP。换一个 UDP 好的节点（Hysteria2、TUIC 这类协议通常更合适）。如果实在不行，可以把 `webrtc` 改成 `"off"`，但这样就没有 WebRTC 防护了。

**游戏、游戏主机、FaceTime 的 NAT 类型变差？**
它们也用 STUN 端口，所以同样被送进了代理。用 `extraRules` 给它们放行，例如：

```js
extraRules: [
  "SRC-IP-CIDR,192.168.1.50/32,DIRECT", // 游戏主机
  "PROCESS-NAME,Game.exe,DIRECT",       // 某个游戏进程
],
```

**`router.lan` 这种局域网主机名解析不了？**
脚本里设置 `lanDNS: "192.168.1.1"`（换成你的路由器 IP）。如果只用 `merge.yaml`，把文件里 `nameserver-policy` 下面那两行注释取消掉。

**规则集或 GEO 数据下载失败？**
把 `ruleBase` / `geoBase`（或 `merge.yaml` 里的 `geox-url`）换成你能访问的镜像，比如把 `fastly.jsdelivr.net` 换成 `testingcf.jsdelivr.net`。能直连 GitHub 的话，也可以用 `https://github.com/MetaCubeX/meta-rules-dat/raw/meta/geo` 和 `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest`。

**某个境外网站必须用 HTTP/3？**
把 `blockQUIC` 设成 `false`。

**订阅更新后设置会丢吗？**
不会。每次生成配置时扩展都会重新执行一遍。

**只用 `merge.yaml` 时，内核日志提示 `global-client-fingerprint` 已移除？**
这个字段是订阅自带的。Merge 只能覆盖键、删不掉键。这条报错不影响使用，启用 `script.js` 后会被自动处理掉。

---

## 八、开发与测试

`test/verify.mjs` 按 Verge 的方式模拟整个流程（订阅 → Merge → 脚本），对输出做断言。设置 `MIHOMO_BIN` 后，还会把生成的配置交给真实的 mihomo 内核跑 `mihomo -t` 做校验。

```bash
npm install
npm test
# 加上内核校验（GEODATA_DIR 里放 geosite.dat 和 country.mmdb）
MIHOMO_BIN=/path/to/mihomo GEODATA_DIR=/path/to/geodata npm test
```

修改 `merge.yaml` 或 `script.js` 中任意一个的 DNS / 嗅探 / 性能参数时，另一个也要同步改。测试会检查两边是否一致。
