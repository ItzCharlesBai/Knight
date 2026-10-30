# Knight 客户端

简洁的 mihomo 桌面客户端（Windows / macOS / Linux），内置本仓库的防泄露方案：[`clash-verge-rev/script.js`](../clash-verge-rev/script.js) 会在生成配置时自动执行，不用再手动粘贴到 Verge 里。

- 内核：[mihomo](https://github.com/MetaCubeX/mihomo)（安装包自带，也可以在设置里一键更新）
- 界面：概览、代理、订阅、连接、规则、日志、设置，七个页面，浅色 / 深色

## 功能

| 页面 | 能做什么 |
| --- | --- |
| 概览 | 系统代理 / 虚拟网卡开关，规则 / 全局 / 直连模式，当前节点与延迟，实时流量曲线，防泄露检查清单，订阅流量与到期时间 |
| 代理 | 分组与节点，点选切换（切换后自动断开旧连接），分组测速 / 单节点测速，按延迟或名称排序，搜索，代理集合（proxy-providers）更新与测速 |
| 订阅 | 粘贴链接导入、本地文件导入、拖入文件导入、`clash://install-config?url=…` 一键导入；自动定时更新、全部更新、编辑名称 / 链接 / 更新间隔 / User-Agent、直接编辑配置原文。支持 Clash / mihomo YAML，也支持 ss / ssr / vmess / vless / trojan / hysteria2 / tuic / socks / http 分享链接（Base64 或明文） |
| 连接 | 活动 / 已关闭连接，实时速度，搜索，单个或全部断开，连接详情（进程、规则、代理链、嗅探域名等） |
| 规则 | 当前生效的全部规则（包括防泄露规则），搜索，规则集合（rule-providers）更新 |
| 日志 | 内核实时日志（级别过滤、搜索、暂停）；防泄露脚本和自定义脚本的输出 |
| 设置 | 端口、局域网、IPv6、统一延迟、进程识别、日志级别、测速地址；系统代理例外列表、复制终端代理命令；TUN 授权、严格路由、协议栈、DNS 劫持、MTU；防泄露全部参数；自定义规则、自定义脚本、查看运行配置；开机启动、静默启动、关闭到托盘、外观、GitHub 加速；内核重启 / 更新、GEO 数据更新、清空 Fake-IP / DNS 缓存、查看内核输出 |

托盘菜单：打开窗口、切换模式、系统代理、虚拟网卡、切换订阅、复制终端代理命令、重启内核、退出。

## 配置是怎么生成的

和 Clash Verge Rev 的顺序一致，所以仓库里的扩展文件原样可用：

```
订阅原文 → 应用设置（端口、TUN、IPv6…）→ merge.yaml（可选）→ script.js（防泄露，参数来自设置页）
        → 自定义脚本（可选）→ 自定义规则 → 应用设置回写
```

- 设置页「防泄露」里的每一项都对应 `script.js` 顶部的 `CONFIG`，含义见[主 README 第六节](../README.md#六参数scriptjs-顶部的-config)。
- 生成后先用 `mihomo -t` 校验，通过了才热重载（不重启内核、不断开连接）；不通过时保留原配置并提示错误，刚改的设置自动撤回。
- 脚本的 `console.warn` 等输出显示在「日志 → 脚本」和概览的防泄露卡片里。

## 虚拟网卡（TUN）授权

防 WebRTC 泄露必须开虚拟网卡，创建虚拟网卡需要管理员权限，第一次开启时按提示授权：

| 系统 | 授权方式 |
| --- | --- |
| Windows | 设置 → 虚拟网卡 →「以管理员身份重启」，Knight 会以管理员身份重新打开 |
| macOS | 点「授权」并输入密码，内核会被设置为 root 所有（setuid）。更新内核后需要重新授权 |
| Linux | 点「授权」，通过 pkexec 给内核加上 `cap_net_admin` 能力。更新内核后需要重新授权 |

内核放在用户数据目录里运行（不在安装目录），所以授权不会修改安装包本身。

## 开发

```bash
cd app
npm install
npm run core     # 下载当前平台的 mihomo 内核和 GEO 数据到 resources/
npm start        # 启动（开发模式直接读取 ../clash-verge-rev/ 下的脚本）
npm test         # 单元测试；有内核时会用 mihomo -t 校验生成的配置
```

打包（会自动下载对应平台的内核）：

```bash
npm run dist:win     # Windows x64 / arm64 安装包
npm run dist:mac     # macOS arm64 / x64 dmg（未签名，首次打开需右键 → 打开）
npm run dist:linux   # Linux AppImage / deb
```

也可以在 GitHub 上运行 Actions 里的「Knight 客户端」工作流，三个平台的安装包会作为构建产物上传；推送 `v*` 标签会自动发布 Release。

下载内核或 GEO 数据需要代理时：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 npm run core`，或用 `--mirror https://ghfast.top/` 走 GitHub 加速。

### 目录

```
app/
├─ src/main/          主进程
│  ├─ index.js        窗口、托盘、IPC、设置变更、订阅定时更新、一键导入
│  ├─ enhance.js      生成运行配置（执行 script.js / merge.yaml / 自定义脚本）
│  ├─ core.js         mihomo 进程：启动、校验、热重载、残留进程清理、TUN 授权
│  ├─ core-download.js 内核与 GEO 数据下载
│  ├─ profiles.js     订阅存储与更新
│  ├─ convert.js      订阅解析、分享链接转换
│  ├─ sysproxy.js     系统代理（Windows 注册表 / macOS networksetup / GNOME、KDE）
│  └─ store.js        设置
├─ src/renderer/      界面（无框架、无构建步骤），直接访问内核的 RESTful API
├─ src/preload.cjs    渲染进程与主进程之间的桥
├─ scripts/           下载内核、生成图标
└─ test/              单元测试
```

数据目录（设置 → 应用 → 数据目录）：`settings.json` 设置、`profiles/` 订阅原文、`core/` 内核、`mihomo/` 内核工作目录（运行配置、GEO 数据、缓存）。
