# Knight · Clash Verge Rev 防泄露与代理优化

给 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)（mihomo 内核）用的两个扩展文件，作用是防 **DNS 泄露**、防 **WebRTC 泄露**，并顺带做一些代理优化。

| 文件 | 放在哪 | 作用 |
| --- | --- | --- |
| [`clash-verge-rev/script.js`](clash-verge-rev/script.js) | 订阅 → **全局扩展脚本** | 全部功能：防 DNS / WebRTC 泄露，以及可选的优化 |
| [`clash-verge-rev/merge.yaml`](clash-verge-rev/merge.yaml) | 订阅 → **全局扩展覆写配置** | 只有 DNS 和性能参数（不含规则） |

**只装 `script.js` 就够了，推荐只用它。** 脚本会在订阅原有的 DNS 设置上叠加；Merge 只能整体替换，还没办法把规则插到最前面，所以 WebRTC 防护只能靠脚本。

**默认原则：只做防泄露，不改节点、不拦正常流量、不打乱你的分流。** 拦截 QUIC、补 UDP / TLS 指纹、域名嗅探这些会改变流量走法的优化都默认关闭，需要时在 `CONFIG` 里手动打开（见第六节）。

> 适用版本：Clash Verge Rev 2.x，内核 mihomo ≥ 1.19。

---

## 一、处理了哪些泄露

| 泄露 | 怎么发生的 | 本方案怎么处理 |
| --- | --- | --- |
| **DNS 泄露** | 订阅常用国内 DNS 解析所有域名，或者带着 `fallback`，运营商能看到你查了哪些境外网站 | 只替换 DNS 上游并清掉 `fallback`：国内域名交给国内 DNS（DoH 为主、UDP 后备，固定直连），其余域名交给 Google DoH（**固定走代理组**）。Windows 联网检测、时间同步这类系统域名交给国内 DNS，节点不可用时也不会出现「无 Internet」。订阅里针对具体域名写的解析条目（机场面板、公司内网、路由器）优先生效，Fake-IP 过滤列表合并保留 |
| **DNS 跟着分流规则直连** | 只靠 `respect-rules` 时，如果订阅里有把 `8.8.8.8` 设成直连的规则，境外 DNS 也会跟着直连 | 脚本把境外 DNS 固定走订阅兜底规则（MATCH）指向的分组，国内 DNS 固定直连，不受其他分流规则影响。分组名每次从订阅里现读，不写死，订阅改名也会自动跟上；也因此不需要为 DNS 服务器加规则，你的分流规则保持原样 |
| **规则匹配引起的解析** | `GEOIP` 这类规则要先把域名解析成 IP 才能匹配 | 国内域名以外的解析都经代理发出，并附带一个通用的国内 ECS 网段（不是你的 IP）。解析结果和国内 DNS 一致，`GEOIP,CN` 的判断和你订阅原来一样：未收录的国内网站、Windows 更新、Steam 下载这类在国内有节点的服务照样直连 |
| **浏览器 / 系统自带的国内加密 DNS** | 浏览器「安全 DNS」或系统 DoH 设成阿里、腾讯、360 时会绕过 Clash | 只拦截这几家的 DoH / DoT 服务器，它们会自动回落到普通 DNS，由 TUN 劫持交给 Clash。内核自己的 DNS 查询不受影响 |
| **WebRTC 泄露** | 浏览器用 UDP 去问 STUN 服务器你的公网 IP。系统代理模式下 UDP 根本不经过 Clash，网页能直接拿到真实 IP | 要求开启 TUN。WebRTC 默认**跟着你订阅的分流走**：国外网站的 WebRTC 走代理，对方只能看到代理 IP；国内网站（B 站等）照常直连，不绕道代理——你本来就是直连访问它们，对方早已知道你的真实 IP，这不算泄露。想连「国外网站借国内 STUN 服务器探测真实 IP」这种少见情况也防住，可以用 `webrtc: "strict"`，代价是国内网站的 WebRTC 也会走代理 |
| **节点不支持 UDP 时悄悄直连** | 很多机场节点没开 UDP。规则选中这样的节点时，内核会跳过它继续往下匹配，最后**直接直连**，STUN 和 QUIC 都会暴露真实 IP | 这种情况下的 STUN 和 QUIC（UDP 443）改为拦截：网页拿不到真实 IP，浏览器会自动改用 TCP 走代理。实测只用订阅时这三类请求都直连，加上脚本后都被拦截 |
| **Windows 多网卡 / IPv6 DNS** | Windows 会同时向每块网卡的 DNS（包括路由器和 IPv6 DNS）发查询，这些查询**不进 TUN**，配置文件管不到 | 开启 TUN 的「严格路由」：它会挡住发往其他网卡的 DNS，并在 TUN 不接管 IPv6 时断开 IPv6，软件自动改用 IPv4。脚本检测到没开会在日志里提醒 |
| **IPv6 泄露** | 代理只处理 IPv4 时，IPv6 流量可能直接出去 | DNS 不返回 IPv6 地址，配合严格路由；Verge 的 IPv6 保持关闭（见第三节） |

### 优化项

默认开启（不改变流量走向；只拦截本会泄露的那部分）：

- `udpLeakGuard`：节点不支持 UDP、内核准备悄悄直连时，拦截 QUIC（UDP 443），浏览器自动改用 TCP 走代理

- `tcp-concurrent`：一个域名解析出多个 IP 时同时握手，用最快的那个
- 删除「剩余流量 / 到期时间 / 官网」这类信息节点，它们不会再混进自动测速。超过一半的节点名都带这些字样时，判断为正常节点，一个都不删
- 记住手动选择的节点，重启后保留 Fake-IP 映射
- GEO 数据走国内可以直连的 jsDelivr 镜像，并自动更新

默认关闭（会改变流量走法或节点连接方式，个别软件可能因此打不开，按需打开）：

- `blockQUIC`：拦截境外 QUIC（UDP 443），浏览器会改用 TCP
- `forceUDP`：给支持 UDP 的协议补上 `udp: true`
- `clientFingerprint`：给 TLS 类节点补 uTLS 指纹
- `sniffer`：域名嗅探，应用直接用 IP 连接时也能按域名分流
- `tuneHealthCheck`：统一订阅里自动测速分组的测速地址和间隔（`https://www.gstatic.com/generate_204`、300 秒、容差 50 ms）。它会改变「自动选择」挑中的节点

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
| 「虚拟网卡模式」文字右边的**齿轮图标**（不是开关，点开是一个叫「虚拟网卡模式」的窗口） | **严格路由：开**，改完点「保存」；DNS 劫持：`any:53`（默认值，TCP 和 UDP 都会劫持）；TUN 模式堆栈：Mixed 或 gVisor | 不开严格路由时，Windows 发给路由器和 IPv6 DNS 的查询会绕过 TUN，这是开了本方案后**最常见的残留 DNS 泄露**。如果 WSL、虚拟机或其他 VPN 因此出问题，再关掉它 |
| 设置 → Clash 设置 → **IPv6** | **关闭**（Verge 默认） | 很多机场节点不支持 IPv6。开启后 TUN 会接管 IPv6，直接用 IPv6 地址连接的软件就会失败。关闭并配合严格路由，IPv6 也不会泄露 |
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

> browserleaks 的 DNS 页面可能会在 Google 那一行显示 ECS 为 `223.5.5.0/24`（中国）。这是脚本为了让分流判断准确而附带的通用国内网段，不是你的 IP，查询本身也经过代理。不想看到它就把 `dnsECS` 设为 `""`，代价是没收录的国内网站可能被判成境外、改走代理。

### 测试仍然看到国内 DNS？逐项排查

1. **严格路由没开**（Windows 上最常见）：设置 → 系统设置 →「虚拟网卡模式」文字右边的齿轮图标 → 严格路由，打开后点「保存」再重新测试。设置页没有这一项的旧版本，脚本会自动打开它。
2. **IPv6 DNS 绕过**：如果测出的国内 DNS 是 IPv6 地址（`240e:`、`2408:`、`2409:` 开头），确认严格路由已开。仍然有的话，可以在系统网卡设置里关掉 IPv6。
3. **TUN 没开或没生效**：脚本日志里有 `[防泄露] 未开启 TUN` 的提示就说明没开。
4. **浏览器安全 DNS 还开着**：按第四节关掉。脚本已经拦截了国内 DoH，但浏览器如果用的是「自定义」严格模式，被拦截后可能打不开网页，关掉即可。
5. **其他 VPN / 加速器同时在运行**：它们可能自己接管 DNS，先退出再测试。
6. **旧缓存干扰**：改完设置后退出并重新打开 Verge（或重启内核），再完全关闭、重新打开浏览器后测试。浏览器和系统缓存的旧解析结果会让测试失真。

### 某个软件打不开？

1. 先确认是不是扩展导致的：把「全局扩展脚本」暂时换成下面三行并保存，看软件能否恢复。

   ```js
   function main(config, profileName) {
     return config;
   }
   ```

2. 确认是扩展导致的话，恢复脚本，打开 Verge 的「连接」页，再打开那个软件，找到它的连接，看命中了哪条规则：
   - 命中 `DOMAIN,dns.alidns.com` / `IP-CIDR,223.5.5.5` 这类 `REJECT`：是加密 DNS 拦截规则，把 `blockDNSBypass` 设为 `false`。
   - 命中 `AND,((DST-PORT,3478...`：是 `webrtc: "strict"` 的规则，改回默认的 `"follow"`，或用 `extraRules` 给这个软件放行。
   - 命中 `AND,((NETWORK,UDP),(DST-PORT,443)),REJECT`：当前节点不支持 UDP。浏览器会自动改走 TCP；别的软件需要 UDP 的话，换一个支持 UDP 的节点。
   - 打开很慢、或者境外网站全都打不开：境外域名的解析要经过订阅兜底规则指向的分组。节点挂了、这个分组选成了 DIRECT、或者 Verge 切到了直连模式，解析都会失败。换一个能用的节点即可。
3. 如果你打开过默认关闭的优化，逐个关回去排查。
4. 还是不行，把软件名和「连接」页 / 「日志」页里相关的几行发给我。

---

## 六、参数（`script.js` 顶部的 `CONFIG`）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `proxyGroup` | `""` | 境外 DNS（以及 `webrtc: "strict"` 时的 WebRTC）用哪个分组出站。留空 = 订阅兜底规则（MATCH）指向的分组，每次从订阅里现读、不写死；只有想手动指定时才填 |
| `webrtc` | `"follow"` | `follow`：跟着订阅的分流走，国内直连、国外走代理；只在节点不支持 UDP、内核准备悄悄直连时拦截 STUN。`strict`：发往国内的 STUN 也改走代理分组（旧写法 `proxy` 等同于它），国内网站的 WebRTC 会绕道代理。`reject`：拦截所有 STUN 请求（最彻底，网页音视频通话可能失败）。`off`：不处理 |
| `udpLeakGuard` | `true` | 节点不支持 UDP、内核准备把 UDP 悄悄改成直连时，拦截其中的 QUIC（UDP 443），浏览器自动改用 TCP 走代理 |
| `blockQUIC` | `false` | 拦截境外 QUIC，让浏览器回落到 TCP |
| `dnsIPv6` | `false` | DNS 是否返回 IPv6 地址 |
| `dnsECS` | `"223.5.5.0/24"` | 国内域名以外的域名用 Google DoH 解析时附带的国内 ECS 网段（不是你的 IP），让 `GEOIP` 分流和用国内 DNS 时一致。填 `""` 关闭，改用 Cloudflare + Google 不带 ECS（部分本该直连的下载会改走代理） |
| `blockDNSBypass` | `true` | 拦截浏览器 / 系统里设置的阿里、腾讯、360 的 DoH / DoT 服务器，让它们回落到被 Clash 接管的普通 DNS |
| `lanDNS` | `""` | 局域网主机名（`router.lan`、`nas.local`）用哪个 DNS 解析，填路由器 IP，比如 `"192.168.1.1"` |
| `removeInfoNodes` | `true` | 删除订阅里直接写出的信息节点；超过一半的节点名带关键字时不删。`proxy-providers` 里的节点不处理 |
| `forceUDP` | `false` | 为 ss / ssr / vmess / vless / trojan / socks5 / anytls 开启 UDP |
| `clientFingerprint` | `""` | TLS 类节点没有指纹时补上的 uTLS 指纹，比如 `"chrome"`；`""` 表示不处理 |
| `sniffer` | `false` | 开启域名嗅探（只用嗅探到的域名匹配规则，不改写连接目标） |
| `tuneHealthCheck` | `false` | 把订阅里自动测速分组的测速地址、间隔统一成 `healthCheck` 的值。会改变「自动选择」挑中的节点，X 这类对节点 IP 敏感的网站可能因此加载失败 |
| `healthCheck` | 见文件 | `tuneHealthCheck` 打开时使用的测速地址、间隔和容差 |
| `extraRules` | `[]` | 优先级最高的自定义规则，排在防泄露规则前面 |
| `geoBase` | jsDelivr 镜像 | GEO 数据的下载地址 |

---

## 七、常见问题

**网页语音 / 视频（Google Meet、Discord、Teams 网页版）卡顿或连不上？**
WebRTC 走代理需要节点支持 UDP。换一个 UDP 好的节点（Hysteria2、TUIC 这类协议通常更合适）。如果实在不行，可以把 `webrtc` 改成 `"off"`，但这样就没有 WebRTC 防护了。

**开了 `webrtc: "strict"` 后，游戏、游戏主机、FaceTime 的 NAT 类型变差？**
strict 模式会把它们发往国内服务器的 STUN 请求送进代理。改回默认的 `"follow"`，或用 `extraRules` 给它们放行，例如：

```js
extraRules: [
  "SRC-IP-CIDR,192.168.1.50/32,DIRECT", // 游戏主机
  "PROCESS-NAME,Game.exe,DIRECT",       // 某个游戏进程
],
```

**`router.lan` 这种局域网主机名解析不了？**
脚本里设置 `lanDNS: "192.168.1.1"`（换成你的路由器 IP）。如果只用 `merge.yaml`，把文件里 `nameserver-policy` 下面那两行注释取消掉。

**GEO 数据下载失败？**
把 `geoBase`（或 `merge.yaml` 里的 `geox-url`）换成你能访问的镜像，比如把 `fastly.jsdelivr.net` 换成 `testingcf.jsdelivr.net`。能直连 GitHub 的话，也可以用 `https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest`。


**订阅更新后设置会丢吗？**
不会。每次生成配置时扩展都会重新执行一遍。

**只用 `merge.yaml` 时，内核日志提示 `global-client-fingerprint` 已移除？**
这个字段是订阅自带的，新版内核已经不读它，所以这条报错不影响使用。Merge 只能覆盖键、删不掉键；启用 `script.js` 后会删掉这个字段，但不会把它转写到节点上。

---

## 八、开发与测试

`test/verify.mjs` 按 Verge 的方式模拟整个流程（订阅 → Merge → 脚本），对输出做断言。设置 `MIHOMO_BIN` 后，还会把生成的配置交给真实的 mihomo 内核跑 `mihomo -t` 做校验。

```bash
npm install
npm test
# 加上内核校验（GEODATA_DIR 里放 geosite.dat 和 country.mmdb）
MIHOMO_BIN=/path/to/mihomo GEODATA_DIR=/path/to/geodata npm test
```

修改 `merge.yaml` 或 `script.js` 中任意一个的 DNS / 性能参数时，另一个也要同步改。测试会检查两边是否一致。
