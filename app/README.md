# Knight 客户端

简洁的代理客户端（Windows / macOS / Linux），可选 **mihomo** 或 **sing-box** 内核，内置本仓库的防泄露方案（[`clash-verge-rev/script.js`](../clash-verge-rev/script.js)）和**订阅转换**。

- 界面：简洁的英伦风格。标题用 Baskerville，侧栏是牛津蓝，正文用系统字体。中文标题配 Noto Serif SC，字体都随应用打包，不同系统看到的效果一样。有浅色和深色两种外观
- 内核：自带 mihomo，其他内核在 设置 → 内核 里一键下载，随时切换
- 订阅链接只在本机下载和转换，不会发给任何在线转换服务

## 内核

| 内核 | 说明 |
| --- | --- |
| mihomo | MetaCubeX 稳定版，默认内核，随安装包发布。防泄露脚本原生运行，配置可以热重载 |
| mihomo Alpha | MetaCubeX 测试版，新协议、新功能先到 |
| mihomo Smart | 第三方分支（vernesong），多一种 Smart 分组：按实际使用情况自动挑节点。打开「Smart 分组」后，订阅里的自动选择分组会换成 Smart 分组 |
| sing-box | SagerNet 的另一套实现，支持 NaiveProxy。sing-box 读不了 Clash 配置，订阅、分组、规则和防泄露设置由 Knight 自动转换（见下文） |

### 搭配使用

两种内核支持的协议不完全一样。打开 设置 → 内核 →「搭配使用」（默认打开）后，当前内核跑不了的节点会交给另一个已下载的内核：

- 用 mihomo 时，NaiveProxy 节点交给 sing-box；
- 用 sing-box 时，SSR、Snell、Mieru 等节点交给 mihomo。

另一个内核在 127.0.0.1 上为每个这样的节点开一个 SOCKS 入口（从「搭配端口」7920 起），主内核里的这个节点会换成指向该入口的 SOCKS 节点。分组、规则、测速都不变，防泄露规则也照常生效。搭配内核自己连接节点的流量会被设成直连，不会再经过虚拟网卡绕回主内核。

没有可搭配的内核时，这些节点会被跳过，日志里会提示是哪些节点。

### sing-box 下的转换

- **节点**：ss（obfs / v2ray-plugin）、vmess、vless（含 Reality）、trojan、hysteria、hysteria2、tuic v5、anytls、socks、http、ssh、wireguard（转成 endpoint）、naive。传输方式支持 ws、httpupgrade、grpc、h2、http
- **分组**：select → selector；url-test、fallback、load-balance → urltest，后两种是近似转换，日志里会说明
- **代理集合 / 规则集合**（proxy-providers / rule-providers）：sing-box 不支持这种写法。Knight 会在更新订阅时缓存它们的内容，转换时把节点直接展开，规则集合转成内联规则集（mrs 格式除外）
- **规则**：DOMAIN 系列、GEOSITE / GEOIP（换成 MetaCubeX 的 `.srs` 规则集，由 Knight 预先下载到本地）、IP-CIDR、端口、进程、NETWORK、RULE-SET，以及 AND / OR / NOT 组合规则。没写 `no-resolve` 的 IP 规则前面会自动加上解析动作，判断方式和 mihomo 一致。不支持的规则（IP-ASN、IN-PORT、SUB-RULE 等）会跳过，日志里有数量
- **防泄露**：脚本加上的规则（拦截国内加密 DNS、WebRTC / STUN 处理）照常转换。DNS 按防泄露设置直接生成等价的 sing-box DNS：国内域名用国内 DoH 并返回真实 IP；其余域名经订阅兜底分组的 Google DoH 解析，带同样的 ECS 网段，开着虚拟网卡时用 Fake-IP；IPv6 策略相同
- 每次应用前先用 `sing-box check` 校验，通过了才重启 sing-box；校验不通过就保留原配置，并提示错误

## 订阅转换

左侧导航的「转换」页：

1. **来源**：订阅链接（可以填多个）、已有订阅、直接粘贴内容。粘贴的内容可以是 Clash / mihomo YAML、分享链接（ss / ssr / vmess / vless / trojan / hysteria / hysteria2 / tuic / anytls / naive / wireguard / socks / http，Base64 或逐行明文都行）、sing-box 配置或 SIP008
2. **处理**：只保留 / 排除（正则）、重命名（每行 `原文 => 替换`）、加国旗、去重、排序、统一开启 UDP、跳过证书验证
3. **分组模板**：保持原样、简洁、按地区（香港、台湾、日本、新加坡、美国、韩国、英国、德国、其他地区，各建一个自动选择分组），以及全面分流（再加上 AI 服务、流媒体、Telegram、苹果、微软、游戏、广告拦截）
4. **输出**：mihomo / Clash 配置、sing-box 配置、仅节点列表、分享链接（Base64 订阅或逐行明文），可以选择带上防泄露设置。结果可以复制、导出文件，或者**保存为订阅**

保存为订阅后，它和普通订阅一样定时更新，每次都会重新拉取所有来源，再按当时的选项转换。多个来源合并时，重名的节点后面会加上来源名。

普通订阅也能单独转换：在订阅卡片上点「设置」，勾选「加载时转换这份订阅」。转换不会改动订阅原文，随时可以关掉。

## 功能一览

| 页面 | 能做什么 |
| --- | --- |
| 概览 | 系统代理 / 虚拟网卡开关，规则 / 全局 / 直连模式，当前节点与延迟，实时流量，防泄露检查，订阅流量与到期时间，当前内核和搭配内核的状态 |
| 代理 | 分组与节点，点选切换（切换后断开旧连接），分组 / 单节点测速，按延迟或名称排序，搜索，代理集合的更新与测速 |
| 订阅 | 链接 / 本地文件 / 拖入 / `clash://install-config?url=…` 一键导入，定时更新，组合订阅，订阅级转换选项，直接编辑原文 |
| 转换 | 见上文 |
| 连接 | 活动 / 已关闭连接，实时速度，搜索，断开，详情 |
| 规则 | 当前生效的全部规则（含防泄露规则），规则集合更新 |
| 日志 | 内核实时日志（级别过滤、搜索、暂停），以及防泄露脚本、自定义脚本、转换过程的输出 |
| 设置 | 内核选择与下载、搭配使用；端口、局域网、IPv6、日志级别、测速；系统代理；虚拟网卡授权与参数；防泄露全部参数；自定义规则 / 脚本；开机启动、外观、GitHub 加速等 |

托盘菜单可以切换模式、系统代理、虚拟网卡、订阅和内核。

## 配置生成顺序

```
订阅（按订阅的转换选项处理）→ 当前内核跑不了的节点交给搭配内核 → 应用设置 → merge.yaml（可选）
→ script.js（防泄露，参数来自设置页）→ 自定义脚本 → 自定义规则 → 应用设置回写 → 内核是 sing-box 时整体转换
```

和 Clash Verge Rev 的顺序一致，所以仓库里的扩展文件原样可用。设置页「防泄露」里的每一项都对应 `script.js` 顶部的 `CONFIG`，含义见[主 README 第六节](../README.md#六参数scriptjs-顶部的-config)。

## 虚拟网卡（TUN）授权

| 系统 | 授权方式 |
| --- | --- |
| Windows | 设置 → 虚拟网卡 →「以管理员身份重启」 |
| macOS | 点「授权」并输入密码，当前内核会被设置为 root 所有（setuid）。更新或换内核后需要重新授权 |
| Linux | 点「授权」，通过 pkexec 给当前内核加上 `cap_net_admin`。更新或换内核后需要重新授权 |

## 优化

- 订阅解析结果按文件修改时间和转换选项缓存，状态刷新和生成配置时不再反复解析大文件
- 窗口藏到托盘后，实时流量、日志、连接的推送都会断开，定时刷新也会暂停；重新打开窗口时自动恢复
- sing-box 用到的规则集由 Knight 下载到本地，下载失败时自动改走代理，内核启动时不用联网
- 扩展脚本只读一次；搭配内核的配置没变时不重启它
- 上次异常退出后残留的内核进程，启动时会自动清理

## 开发

```bash
cd app
npm install
npm run core     # 下载 mihomo 和 GEO 数据到 resources/
npm start
npm test         # 单元测试；有 mihomo 时会用 mihomo -t 校验生成的配置
```

用真实的 sing-box 校验转换结果：

```bash
node scripts/fetch-core.mjs --core sing-box --out /tmp/sing-box
```

```bash
SINGBOX_BIN=/tmp/sing-box/sing-box npm test
```

GitHub Actions 的「Knight 客户端」工作流会跑完整测试，包括 `mihomo -t` 和 `sing-box check`，然后打包三个平台的安装包；推送 `v*` 标签会自动发布 Release。本地打包：

```bash
npm run dist:win     # Windows x64 / arm64 安装包
npm run dist:mac     # macOS arm64 / x64 dmg（未签名，首次打开需右键 → 打开）
npm run dist:linux   # Linux AppImage / deb
```

下载内核时需要代理：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 npm run core`，或者加上 `--mirror https://ghfast.top/` 走 GitHub 加速。

### 目录

```
app/
├─ src/main/          主进程
│  ├─ index.js        窗口、托盘、IPC、内核切换、搭配内核、规则集下载、订阅定时更新
│  ├─ enhance.js      生成运行配置（防泄露脚本、merge、自定义脚本、搭配拆分、转 sing-box）
│  ├─ singbox.js      Clash 配置 → sing-box 配置（节点、分组、规则、DNS）
│  ├─ sidecar.js      搭配使用：拆分节点、生成搭配内核的配置
│  ├─ nodes.js        订阅转换：节点处理、地区识别、分组模板
│  ├─ convert.js      订阅解析（YAML / 分享链接 / sing-box / SIP008）
│  ├─ links.js        节点 → 分享链接
│  ├─ converter.js    转换页：合并来源、输出各种格式
│  ├─ profiles.js     订阅存储、组合订阅、代理 / 规则集合缓存
│  ├─ core.js         内核进程：启动、校验、残留进程清理、TUN 授权
│  ├─ core-download.js 内核登记表与下载（gz / zip / tar.gz）
│  ├─ sysproxy.js     系统代理
│  └─ store.js        设置
├─ src/renderer/      界面（无框架、无构建步骤）；fonts/ 是打包的字体（SIL OFL 1.1）
├─ src/preload.cjs
├─ scripts/           下载内核、生成图标
└─ test/              单元测试
```
