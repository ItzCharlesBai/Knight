# Ondine 客户端

Ondine 是一个桌面代理客户端，支持 Windows、macOS 和 Linux。主内核可选 **mihomo** 或 **sing-box**，**Xray**、**Juicity** 可以搭配运行它们跑不了的节点。它内置本仓库的防泄露方案（[`clash-verge-rev/script.js`](../clash-verge-rev/script.js)），还提供：

- 订阅导入时自动识别格式并转换；
- **多个订阅同时使用**；
- **共享订阅给其他设备**；
- **VPS 管理和一键部署**。

- **界面**：塞纳河畔的街角咖啡——日式 / 美式电影海报的现代感加上法式的浪漫，以巴黎和伦敦咖啡馆的样子呈现；淡淡的，不忧郁。
  - 颜色是米色、橄榄绿和浅棕的木头，不用暖色调；侧栏是一块浅色橡木招牌，顶上一道咖啡馆的条纹遮阳篷。
  - 字是手写的：中文用霞鹜文楷，英文的花体用 Parisienne，数字和小字保留 Libre Baskerville 疏朗的线条（都随应用打包，SIL OFL）。
  - 页头像电影海报：一行演职员表式的小字、一个大大的花体词压在中文片名后面；面板是半透明的磨砂玻璃，四角有细细的装饰角。
  - 光影：右上角的窗把光斜斜地照进雾里（丁达尔效应），光里浮着微尘、偶尔一闪；地面上飘着薄雾，下雨天有细雨；压着一层胶片颗粒。
  - 动效：页面从雾里浮上来，点按钮、拨开关、提示出现时冒一小簇光点（有点像原神）；「设置 → 动态效果」可以关掉，系统要求减少动画时自动停。
  - 窗外的天气：晨雾（默认）、细雨、晴光（墙上有窗光和橄榄枝的影子），都是浅色。
- **失败有解释**：操作失败时说清楚出了什么事、为什么、怎么办（订阅被拒、不是订阅内容、网络不通、端口被占用、内核校验失败、SSH 登录失败等），原始信息放在「详情」里。
- **图标**：一只侧身坐着的小猫，几乎一笔画成的淡金色线条，没有底色、没有边框；任务栏、托盘这些小尺寸单独加粗了线条，缩小了也看得清。
- **内核**：自带 mihomo，其他内核在 设置 → 内核 里一键下载，随时切换。
- **隐私**：订阅链接只在本机下载和转换，不会发给任何在线转换服务。

## 下载安装

到 [Releases](https://github.com/ItzCharlesBai/Knight/releases/latest) 下载对应的安装包：

| 系统 | 文件 | 说明 |
| --- | --- | --- |
| Windows 10 / 11 | `Ondine-<版本>-win-x64-setup.exe`（ARM 电脑选 `arm64`） | 没有代码签名，SmartScreen 拦下时点「更多信息 → 仍要运行」 |
| macOS 12 起 | `Ondine-<版本>-mac-arm64.dmg`（Apple 芯片）或 `mac-x64.dmg`（Intel） | 只做了 ad-hoc 签名、没有公证：第一次打开被拦时，到「系统设置 → 隐私与安全性」底部点「仍要打开」（较早的系统也可以右键 → 打开） |
| Linux | `Ondine-<版本>-linux-x86_64.AppImage`，或 Debian / Ubuntu 用 `linux-amd64.deb`（ARM 选 `arm64`） | AppImage 先 `chmod +x` 再运行；deb 用 `sudo apt install ./文件名.deb` |

安装包自带 mihomo 内核和 GEO 数据，打开就能导入订阅。

国内直接下载慢、或者下到一半失败：在下载链接前面加上 `https://ghfast.top/` 再打开（Release 页面上每个文件都列好了「国内加速」链接）。加速站是第三方的，下完可以核对一下 Release 页面上的 sha256。

## 内核

| 内核 | 说明 |
| --- | --- |
| mihomo | MetaCubeX 稳定版，默认内核，随安装包发布。防泄露脚本原生运行，配置可以热重载 |
| mihomo Alpha | MetaCubeX 测试版，新协议、新功能先到 |
| sing-box | SagerNet 的另一套实现，支持 NaiveProxy。sing-box 读不了 Clash 配置，订阅、分组、规则和防泄露设置由 Ondine 自动转换（见下文） |
| sing-box 测试版 | sing-box 最新的预发布版本（alpha / beta），转换方式和正式版相同 |
| Xray | XTLS 官方实现，VLESS / XHTTP / REALITY 的参考内核。没有 Clash 控制接口，**只作搭配**：可以让它专门运行 VLESS 节点 |
| Juicity | 基于 QUIC 的 Juicity 协议的官方实现，mihomo 和 sing-box 都不支持这个协议。**只作搭配**：每个 Juicity 节点由它单独运行一个进程 |

### 搭配使用

几个内核支持的协议不完全一样。打开 设置 → 内核 →「搭配使用」（默认打开）后，当前内核跑不了的节点会交给另一个已下载的内核：

- 用 mihomo 时，NaiveProxy 节点交给 sing-box，Juicity 节点交给 Juicity。
- 用 sing-box 时，SSR、Snell、Mieru、XHTTP、VLESS 加密等节点交给 mihomo 或 Xray。
- 下载了 Xray 后，还可以在「交给 Xray 的节点」里选 **VLESS REALITY 节点**或**全部 VLESS 节点**。
  - mihomo 官方说明不再兼容 Xray v26.7.11 以后服务端的 REALITY，REALITY 节点连不上时打开这一项即可。
  - Xray 已经去掉了跳过证书验证，开了跳过证书验证的节点仍由主内核运行。

可以同时有多个搭配内核，例如 sing-box 跑 Naive、Xray 跑 REALITY、Juicity 跑 Juicity 节点。

- 搭配内核在 127.0.0.1 上为每个这样的节点开一个 SOCKS 入口（从「搭配端口」7920 起），主内核里的这个节点换成指向该入口的 SOCKS 节点。
- 分组、规则、测速都不变，防泄露规则也照常生效。
- 搭配内核自己连接节点的流量设成直连，不会再经过虚拟网卡绕回主内核。

没有可搭配的内核时，这些节点会被跳过，日志里会提示是哪些节点。

### sing-box 下的转换

- **节点**：
  - 协议：ss（obfs / v2ray-plugin）、vmess、vless（含 Reality）、trojan、hysteria、hysteria2、tuic v5、anytls、socks、http、ssh、wireguard（转成 endpoint）、naive。
  - 传输方式：ws、httpupgrade、grpc、h2、http。
- **分组**：select 转成 selector；url-test、fallback、load-balance 转成 urltest，后两种是近似转换，日志里会说明。
- **代理集合 / 规则集合**（proxy-providers / rule-providers）：sing-box 不支持这种写法。Ondine 会在更新订阅时缓存它们的内容，转换时把节点直接展开，规则集合转成内联规则集（mrs 格式除外）。
- **规则**：
  - 支持 DOMAIN 系列、GEOSITE / GEOIP、IP-CIDR、端口、进程、NETWORK、RULE-SET，以及 AND / OR / NOT 组合规则。
  - GEOSITE / GEOIP 换成 MetaCubeX 的 `.srs` 规则集，由 Ondine 预先下载到本地。
  - 没写 `no-resolve` 的 IP 规则前面自动加上解析动作，判断方式和 mihomo 一致。
  - 不支持的规则（IP-ASN、IN-PORT、SUB-RULE 等）会跳过，日志里有数量。
- **防泄露**：
  - 脚本加上的规则（拦截国内加密 DNS、WebRTC / STUN 处理）照常转换。
  - DNS 按防泄露设置直接生成等价的 sing-box DNS。国内域名用国内 DoH 并返回真实 IP。
  - 其余域名经订阅兜底分组的 Google DoH 解析，带同样的 ECS 网段，开着虚拟网卡时用 Fake-IP，IPv6 策略相同。
- **校验**：每次应用前先用 `sing-box check` 校验，通过了才重启 sing-box；校验不通过就保留原配置，并提示错误。

## 订阅：导入即转换，几个同时用

### 导入时自动转换

在订阅页粘贴一次链接，或者用机场的「一键导入」，Ondine 会自己认出格式，不用再去转换页粘贴：

| 订阅内容 | 怎么处理 |
| --- | --- |
| Clash / mihomo 配置 | 原样使用，机场自带的分组和规则不动 |
| 分享链接（Base64 或逐行明文） | 自动转换：按地区分组、加国旗、去重、去掉「剩余流量 / 到期时间」这类信息节点 |
| sing-box 配置、SIP008 | 同上 |
| Surge / Loon / Quantumult X | 整份配置文件或只有节点行都行，只读 `[Proxy]` / `[server_local]` 段，然后同上 |

导入后的提示和订阅卡片上会写明识别出的格式和「已自动转换」。转换选项在订阅卡片的「设置」里，可以改也可以关；改过之后就按你的设置来，不再自动套用。机场把订阅从分享链接换成完整的 Clash 配置时，Ondine 会自动改用机场自带的分组和规则。

### 多个订阅同时使用

打开几个订阅卡片上的开关，它们就一起生效，不用来回切换：

- **主订阅**（★）提供分组和规则，可以在卡片上「设为主订阅」。
- 其他订阅的节点各成一个分组，叫「订阅名」（手动选择）和「订阅名 · 自动」（自动测速）。
- 这些分组插进主订阅里能选代理的分组，比如「节点选择」和各个服务分组，选过去就能用。按地区自动收集节点的分组（filter / include-all）不动。
- 重名的节点、分组、代理集合自动加上订阅名，代理集合各用各的缓存文件。
- 新导入的订阅默认直接加入同时使用；不想要就关掉它的开关，或者点「只用这一个」。
- 托盘菜单的「订阅」里也能勾选。

### 转换与共享

左侧导航的「转换」页把已有的订阅转成别的客户端的格式，默认就是正在使用的那些订阅，**不用粘贴**。打开页面就会自动转换，改选项后立即重新转换。也可以展开「其他来源」临时加订阅链接或粘贴内容。

1. **处理**：只保留 / 排除（正则）、**只要某些协议**、去掉信息节点、重命名（每行 `原文 => 替换`）、加国旗、去重、排序、统一开启 UDP、跳过证书验证。
2. **分组模板**：保持原样、简洁、按地区（香港、台湾、日本、新加坡、美国、韩国、英国、德国、其他地区，各建一个自动选择分组），以及全面分流（再加上 AI 服务、流媒体、Telegram、苹果、微软、游戏、广告拦截）。
3. **输出**：
   - mihomo / Clash 配置、sing-box 配置、仅节点列表；
   - 分享链接（给 v2rayN、Shadowrocket 等的 Base64 订阅，或逐行明文）；
   - **Surge、Quantumult X、Loon 的节点列表**。

   可以选择带上防泄露设置。结果可以复制、导出文件，或者**保存为订阅**。
4. **预览**：节点数、地区分布、各协议数量、VLESS 等协议的特性（REALITY、Vision、XHTTP、gRPC、VLESS 加密、ECH），以及各内核能跑多少个。

**共享给其他设备**：打开转换页底部的开关，Ondine 会在局域网里开一个只读的订阅地址。

- 每种格式一个地址：Clash、sing-box、v2rayN / v2rayNG / Shadowrocket、Surge、Quantumult X、Loon。
- 手机扫二维码订阅就行，不用复制粘贴；这边订阅更新后，那边下次更新时自动同步。
- 地址里带随机密钥，不知道密钥的请求一律 404，可以随时「换一个地址」。
- 只有一个订阅时会带上它的流量和到期信息。
- 共享内容默认是在用的订阅，可以改成转换页上的选择和选项。

## 服务器（VPS 管理）

有自己的 VPS，在「服务器」页添加后就能管理：

- **连接**：
  - 支持密码、私钥（粘贴或选择文件）、SSH agent 三种登录方式，root 或有 sudo 权限的用户都行。
  - 第一次连接时记住服务器的主机指纹（SHA256），之后指纹变了会拒绝连接并提醒。重装过系统的话确认一下即可。
  - 直连 SSH 被阻断时可以「经本机代理连接」。
- **凭据保存**：
  - 密码和私钥用系统钥匙串加密保存（Windows DPAPI、macOS 钥匙串、Linux 的 libsecret / KWallet）。
  - Linux 没有钥匙串时只记在内存里，重启 Ondine 后再输一次。
- **运行状况**：系统版本、架构、CPU、负载、内存、硬盘、开机以来的流量、拥塞控制（是否 BBR）、服务状态。
- **一键部署**：在服务器上装 sing-box 服务端，可选下面几种协议，端口都能改：

  | 协议 | 默认端口 | 特点 |
  | --- | --- | --- |
  | VLESS REALITY（Vision） | 443/TCP | 抗封锁首选，外形和访问大网站一样，不需要域名和证书；伪装网站可选 |
  | Hysteria2 | 8443/UDP | 基于 QUIC，丢包多的线路也快 |
  | TUIC v5 | 9443/UDP | 基于 QUIC，延迟低 |
  | AnyTLS | 8444/TCP | 普通 TLS 外形，能对付按流量特征识别 |
  | Shadowsocks 2022 | 随机 | 简单轻量，适合中转或当备用 |

  - **密钥和证书**：
    - UUID、密码、REALITY 的 X25519 密钥和自签证书都在本机生成。
    - 自签证书的协议在客户端固定证书指纹，中间人换不了证书。
    - 重新部署时沿用原来的密钥和证书，已经分发出去的节点不用换。
  - **脚本**：
    - 部署脚本经 SSH 标准输入交给 `sh` 执行，不落盘，只用 POSIX sh。Debian、Ubuntu、CentOS、Alpine 都行（systemd 或 OpenRC）。
    - 服务器访问不了 GitHub 时，自动改由本机下载 sing-box 再上传，并校验 SHA256。
  - **服务**：
    - 以单独的 `ondine` 用户运行，只给绑定低端口的权限。
    - 不允许客户端借服务器访问它所在的内网。
    - 服务器上已有的程序占着端口时会停下来提示，不会动它。
  - **系统设置**（都可以不选）：
    - 自动放行服务器防火墙：ufw、firewalld，以及像 Oracle Cloud 镜像那样默认拒绝入站的 iptables。
    - 开启 BBR。
  - 云服务商控制台里的安全组要自己放行。
- **部署之后**：
  - 节点自动存成一份订阅，和机场一起同时使用。
  - 「节点与二维码」里有每个节点的分享链接和二维码，手机上的 Shadowrocket、v2rayNG、NekoBox、Clash Meta 扫码即用。
- **服务管理**：启动、停止、重启、查看日志、卸载（删掉服务、文件和用户，收回放行的端口）。
- **终端**：以登录用户执行命令，常用的几条（负载、监听端口、连接统计、磁盘、内存、服务状态）一点就行。

## 协议支持

| 协议 | 导入 | 导出 | 运行 |
| --- | --- | --- | --- |
| Shadowsocks（含 2022、obfs / v2ray-plugin） | 分享链接、SIP008、Clash、sing-box、Surge、QX、Loon | 全部格式 | mihomo、sing-box、Xray |
| ShadowsocksR | 分享链接、Clash、QX、Loon | Clash | mihomo |
| VMess | 分享链接（含 Shadowrocket 写法）、Clash、sing-box、Surge、QX、Loon | 全部格式 | mihomo、sing-box、Xray |
| VLESS（REALITY、Vision、XHTTP、加密） | 分享链接、Clash、sing-box、QX、Loon | 除 Surge 外 | mihomo、sing-box（不含 XHTTP / 加密）、Xray |
| Trojan | 分享链接、Clash、sing-box、Surge、QX、Loon | 全部格式 | mihomo、sing-box、Xray |
| Hysteria2 / Hysteria | 分享链接、Clash、sing-box、Surge、Loon | 分享链接、Clash、sing-box、Surge、Loon | mihomo、sing-box |
| TUIC v5 | 分享链接、Clash、sing-box、Surge | 分享链接、Clash、sing-box、Surge | mihomo、sing-box |
| AnyTLS | 分享链接、Clash、sing-box、Surge | 分享链接、Clash、sing-box、Surge | mihomo、sing-box |
| NaiveProxy | 分享链接、sing-box | 分享链接、sing-box | sing-box |
| Juicity | 分享链接 | 分享链接 | Juicity |
| Mieru | `mierus://` 链接、Clash | 分享链接、Clash | mihomo |
| Snell（v1–v3） | Clash、Surge | Clash、Surge | mihomo |
| SSH | Clash、sing-box、Surge | Clash、sing-box、Surge | mihomo、sing-box |
| WireGuard | 分享链接、Clash、sing-box | Clash、sing-box | mihomo、sing-box |
| SOCKS5 / HTTP(S) | 分享链接（含 v2rayN 的 Base64 写法）、Clash、Surge、QX、Loon | 全部格式 | 全部内核 |
| Sudoku、TrustTunnel、MASQUE | Clash 配置里原样保留 | Clash | mihomo |

### VLESS

VLESS 链接的参数都会完整保留：

- `encryption`（VLESS 加密）、`flow`（Vision）；
- `security=tls / reality`、`sni`、`fp`、`alpn`、`allowInsecure`；
- `pbk` / `sid` / `spx` / `pqv`（REALITY 的公钥、short id、spiderX、ML-DSA-65 校验）；
- `ech`、`packetEncoding`；
- 各种传输方式：`tcp`（含 `headerType=http`）、`ws`、`httpupgrade`、`grpc`（含 multi 模式）、`h2`、`xhttp`（`path` / `host` / `mode` / `extra`）、`kcp`。`extra` 里的 xPaddingBytes、xmux、downloadSettings 等都会转成 mihomo 的写法。

导出成分享链接时原样写回，导入再导出结果一致。

三个内核对 VLESS 的支持不同，Ondine 会自动选能跑的那个：

| | mihomo | sing-box | Xray |
| --- | --- | --- | --- |
| REALITY / Vision | ✓（不兼容 Xray v26.7.11+ 服务端） | ✓ | ✓（含 spiderX、ML-DSA-65） |
| XHTTP | ✓ | ✗ → 交给 mihomo / Xray | ✓ |
| VLESS 加密 | ✓ | ✗ → 交给 mihomo / Xray | ✓ |
| 跳过证书验证 | ✓ | ✓ | ✗（Xray 已移除） |

## 功能一览

| 页面 | 能做什么 |
| --- | --- |
| 概览 | 系统代理 / 虚拟网卡开关；规则 / 全局 / 直连模式；当前节点与延迟；实时流量；防泄露检查；在用的订阅（流量与到期时间）；内核和搭配内核的状态 |
| 代理 | 分组与节点，点选切换（切换后断开旧连接）；分组 / 单节点测速；按延迟或名称排序；搜索；代理集合的更新与测速 |
| 订阅 | 链接 / 本地文件 / 拖入 / `clash://install-config?url=…` 一键导入并自动转换；多个订阅同时使用、设主订阅；定时更新；组合订阅；订阅级转换选项；直接编辑原文 |
| 转换 | 已有订阅直接转换成各种格式；共享给其他设备（局域网订阅地址 + 二维码） |
| 服务器 | VPS 运行状况；一键部署；节点与二维码；服务管理；终端 |
| 连接 | 活动 / 已关闭连接，实时速度，搜索，断开，详情 |
| 规则 | 当前生效的全部规则（含防泄露规则），规则集合更新 |
| 日志 | 内核实时日志（级别过滤、搜索、暂停），以及防泄露脚本、自定义脚本、转换过程的输出 |
| 设置 | 内核选择与下载（六个内核）、搭配使用、交给 Xray 的节点；端口、局域网、IPv6、日志级别、测速；系统代理；虚拟网卡授权与参数；防泄露全部参数；自定义规则 / 脚本；开机启动、窗外的天气（晨雾 / 细雨 / 晴光）、动态效果、GitHub 加速等 |

托盘菜单可以切换模式、系统代理、虚拟网卡、勾选同时使用的订阅、切换内核。深度链接支持 `clash://`、`mihomo://`、`ondine://`。

## 配置生成顺序

```
在用的订阅（各自按转换选项处理）→ 多个订阅合成一份（主订阅的分组和规则 + 其他订阅的分组）
→ 当前内核跑不了的节点交给搭配内核 → 应用设置 → merge.yaml（可选）
→ script.js（防泄露，参数来自设置页）→ 自定义脚本 → 自定义规则 → 应用设置回写 → 内核是 sing-box 时整体转换
```

这和 Clash Verge Rev 的顺序一致，所以仓库里的扩展文件原样可用。设置页「防泄露」里的每一项都对应 `script.js` 顶部的 `CONFIG`，含义见[主 README 第六节](../README.md#六参数scriptjs-顶部的-config)。

## 虚拟网卡（TUN）授权

| 系统 | 授权方式 |
| --- | --- |
| Windows | 设置 → 虚拟网卡 →「以管理员身份重启」 |
| macOS | 点「授权」并输入密码，当前内核会被设置为 root 所有（setuid）。更新或换内核后需要重新授权 |
| Linux | 点「授权」，通过 pkexec 给当前内核加上 `cap_net_admin`。更新或换内核后需要重新授权 |

## 优化

- 订阅解析结果按文件修改时间和转换选项缓存；多订阅的合成结果也有缓存。状态刷新和生成配置时不会反复解析大文件。
- 窗口藏到托盘后，实时流量、日志、连接的推送都会断开，定时刷新也会暂停；重新打开窗口时自动恢复。
- sing-box 用到的规则集由 Ondine 下载到本地，下载失败时自动改走代理，内核启动时不用联网。
- 扩展脚本只读一次；搭配内核的配置没变时不重启它。
- 上次异常退出后残留的内核进程，启动时会自动清理。
- 连同一台服务器的 SSH 连接会复用，空闲一分钟后断开。

## 开发

```bash
cd app
npm install
npm run core     # 下载 mihomo 和 GEO 数据到 resources/
npm start
npm test         # 单元测试；有 mihomo 时会用 mihomo -t 校验生成的配置
```

用真实的 sing-box 校验转换结果和部署用的服务端配置：

```bash
node scripts/fetch-core.mjs --core sing-box --out /tmp/sing-box
```

```bash
SINGBOX_BIN=/tmp/sing-box/sing-box npm test
```

GitHub Actions 的「Ondine 客户端」工作流会跑完整测试，包括 `mihomo -t`、`sing-box check` 和 `xray run -test`。`package.json` 里的版本还没发布过时，推送后会打包三个平台的安装包并发布 Release（自动打上 `v<版本>` 标签），所以发新版只要改版本号再推送；推送 `v*` 标签也行。本地打包：

```bash
npm run dist:win     # Windows x64 / arm64 安装包
npm run dist:mac     # macOS arm64 / x64 dmg（ad-hoc 签名，没有公证）
npm run dist:linux   # Linux AppImage / deb
```

下载内核时需要代理的话，用 `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 npm run core`，或者加上 `--mirror https://ghfast.top/` 走 GitHub 加速。

图标和背景素材由脚本生成（需要 playwright）：`node scripts/icons.mjs`（应用图标、Windows 的 ico、macOS 的 icns、Linux 各尺寸和托盘图标）、`node scripts/art.mjs`。

应用以前叫 Knight、Lily、Chelle：第一次以 Ondine 启动时，会把最近用过的那个的设置、订阅、服务器和内核自动搬过来。

### 目录

```
app/
├─ src/main/          主进程
│  ├─ index.js        窗口、托盘、IPC、内核切换、搭配内核、规则集下载、订阅定时更新、共享订阅、VPS
│  ├─ enhance.js      生成运行配置（防泄露脚本、merge、自定义脚本、搭配拆分、转 sing-box）
│  ├─ stack.js        多个订阅同时使用：合成一份配置
│  ├─ singbox.js      Clash 配置 → sing-box 配置（节点、分组、规则、DNS）
│  ├─ sidecar.js      搭配使用：按节点挑内核、生成搭配内核（mihomo / sing-box / Xray / Juicity）的配置
│  ├─ xray.js         Clash 节点 → Xray 出站（只作搭配）
│  ├─ clients.js      Surge / Loon / Quantumult X 的节点和配置 → 节点
│  ├─ formats.js      节点 → Surge / Quantumult X / Loon 节点列表
│  ├─ nodes.js        订阅转换：节点处理、地区识别、分组模板
│  ├─ convert.js      订阅解析（YAML / 分享链接 / sing-box / SIP008 / Surge 等）
│  ├─ links.js        节点 → 分享链接
│  ├─ converter.js    转换页：合并来源、输出各种格式
│  ├─ share.js        共享订阅（局域网订阅地址）和二维码
│  ├─ profiles.js     订阅存储、导入时自动转换、组合订阅、代理 / 规则集合缓存
│  ├─ deploy.js       VPS 部署：密钥、自签证书、sing-box 服务端配置、部署 / 卸载 / 服务脚本、客户端节点
│  ├─ vps.js          VPS 管理：服务器列表（凭据加密）、SSH 连接复用、主机指纹、以 root 执行脚本
│  ├─ core.js         内核进程：启动、校验、残留进程清理、TUN 授权
│  ├─ core-download.js 内核登记表与下载（gz / zip / tar.gz）
│  ├─ sysproxy.js     系统代理
│  └─ store.js        设置
├─ src/renderer/      界面（无框架、无构建步骤）；fx.js 是光影和粒子动画，explain.js 是失败原因的解释；fonts/ 是打包的字体（SIL OFL 1.1），art/ 是窗光、叶影和雨滴素材
├─ src/preload.cjs
├─ scripts/           下载内核、生成图标（icons.mjs）和背景素材（art.mjs）
├─ build/             只在打包时用的图标（macOS icns、Linux 各尺寸）
└─ test/              单元测试（含用本机 SSH 服务器测试连接、mihomo -t 校验）
```
