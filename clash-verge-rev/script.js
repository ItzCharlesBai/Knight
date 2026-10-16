/**
 * Clash Verge Rev · 全局扩展脚本（Script）
 * 防 DNS 泄露 · 防 WebRTC 泄露 · 代理优化
 *
 * 内核：mihomo ≥ 1.19（Clash Verge Rev 自带）
 * 用法：订阅 → 全局扩展脚本 → 编辑文件 → 全选粘贴本文件 → 保存
 *       只想对某个订阅生效：右键该订阅 → 扩展脚本
 * 说明：可单独使用，也可与 merge.yaml 同时启用（两者的 DNS 参数一致，脚本额外把境外 DNS 固定到代理组）。
 *       WebRTC 防护依赖 TUN（虚拟网卡）模式，详见 README。
 * 原则：默认只做防 DNS / WebRTC 泄露，不改节点、不拦正常流量、不覆盖订阅原有的 DNS 兼容设置；
 *       其余优化默认关闭，需要时在下面手动打开。
 */

// ============================== 可调参数 ==============================
const CONFIG = {
  // "enhance"：保留订阅自带的分组与规则，只叠加防泄露规则和优化（默认）
  // "full"   ：订阅只提供节点，分组和分流规则全部由本脚本生成（规则集来自 MetaCubeX）
  mode: "enhance",

  // 代理出口所用的分组名；留空自动识别订阅的主选择组（如“🚀 节点选择”）
  mainGroup: "",

  // WebRTC / STUN 流量：
  //   "proxy"  发往国内的 STUN 请求改走代理；订阅的兜底规则是直连时，其余 STUN 也改走代理；
  //            其他的照你原来的规则走（推荐）。订阅里明确写了直连的国外服务器仍会直连
  //   "reject" 拦截所有 STUN 请求，最彻底，但网页音视频通话可能无法建立
  //   "off"    不处理
  webrtc: "proxy",

  // 节点不支持 UDP 时，内核会把本该走代理的 UDP 悄悄改成直连，暴露真实 IP。
  // 打开后拦截其中的 QUIC（UDP 443），浏览器会自动改用 TCP 走代理（WebRTC 的这部分始终拦截）
  udpLeakGuard: true,

  // ---- 以下优化默认关闭：它们会改变流量走法或节点连接方式，个别软件可能因此打不开 ----
  // 拦截境外 QUIC（UDP 443），让浏览器回落到 TCP
  blockQUIC: false,

  // DNS 是否返回 IPv6 地址。关闭可避免 IPv6 流量绕开代理
  dnsIPv6: false,

  // 国内域名以外的域名用 Google DoH（经代理）解析时附带的 ECS 网段。
  // 填一个通用的国内网段（不是你的 IP），解析结果就和国内 DNS 一致，GEOIP 分流不会误判
  // （比如 Windows 更新、Steam 下载在国内有节点的服务照样直连）；查询仍经代理发出，运营商看不到。
  // 填 "" 关闭，改用 Cloudflare + Google 且不带 ECS（部分本该直连的下载会改走代理）
  dnsECS: "223.5.5.0/24",

  // 拦截绕过 Clash 的国内加密 DNS（浏览器/系统里设置的阿里、腾讯、360 的 DoH/DoT），
  // 它们会自动回落到普通 DNS，由 Clash 接管。内核自己的 DNS 查询不受影响
  blockDNSBypass: true,

  // 局域网主机名（router.lan、nas.local 等）交给哪个 DNS 解析，填路由器 IP，如 "192.168.1.1"；留空不处理
  lanDNS: "",

  // 删除“剩余流量 / 到期时间 / 官网”这类信息节点，避免污染自动测速。
  // 要删的超过一半时视为节点名本身带这些字样，一个都不删
  removeInfoNodes: true,

  // 为支持 UDP 的协议补上 udp: true（默认关闭）
  forceUDP: false,

  // TLS 类节点未指定指纹时补上的 uTLS 指纹，如 "chrome"；"" 不处理（默认）
  clientFingerprint: "",

  // 域名嗅探：应用直接用 IP 连接时从握手里还原域名再分流（默认关闭，不改订阅原有设置）
  sniffer: false,

  // 把订阅里自动测速分组（url-test / fallback / load-balance）的测速地址、间隔统一成下面的值。
  // 默认关闭：它会改变「自动选择」挑中的节点，而 X 等网站对节点 IP 很挑剔
  tuneHealthCheck: false,

  // 测速参数：tuneHealthCheck 打开时用于订阅的分组；full 模式生成的分组始终使用
  healthCheck: {
    url: "https://www.gstatic.com/generate_204",
    interval: 300, // 秒
    tolerance: 50, // 毫秒，url-test 切换节点的容差
  },

  // 最先匹配的自定义规则，优先级高于防泄露规则。
  // 例：让游戏主机直连 ["SRC-IP-CIDR,192.168.1.50/32,DIRECT"]
  extraRules: [],

  // ---- 以下仅 full 模式使用 ----
  adBlock: true, // 广告拦截分组（可在面板中切换为 DIRECT）

  // 规则集与 GEO 数据下载地址（国内可直连的 jsDelivr 镜像）
  ruleBase: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo",
  geoBase: "https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release",
};

// ============================== 内置数据 ==============================
// 国内 DNS：解析国内域名、节点域名和直连流量，固定直连。DoH 为主，普通 UDP 作后备（有的网络会拦 DoH）
const DNS_DOMESTIC_IPS = ["223.5.5.5", "1.12.12.12"];
const DNS_DOMESTIC_UDP = ["223.5.5.5", "119.29.29.29"];
// 境外 DoH（dnsECS 关闭时用），固定走代理组，运营商看不到查询内容
const DNS_FOREIGN_IPS = ["1.1.1.1", "8.8.8.8"];
// 带 ECS 的境外 DoH：Google DNS 会把 ECS 转给权威服务器（Cloudflare 不会），保证分流判断准确
const DNS_ECS_IPS = ["8.8.8.8", "8.8.4.4"];
// 系统联网检测、时间同步、游戏平台：不敏感，交给国内 DNS，节点不可用时也不会出现“无 Internet”
const SYSTEM_DOMAINS =
  "+.msftconnecttest.com,+.msftncsi.com,time.windows.com,time.apple.com,time-ios.apple.com,time.asia.apple.com," +
  "+.pool.ntp.org,+.ntp.org.cn,+.srv.nintendo.net,+.stun.playstation.net,xbox.*.microsoft.com,+.xboxlive.com";
const LAN_DOMAINS = "+.lan,+.local,+.localdomain,+.home.arpa";
// 仅用于解析 DoH 服务器自身的域名（上面都是 IP，基本用不到）
const DNS_BOOTSTRAP = ["223.5.5.5", "119.29.29.29"];

// 会绕过 Clash 的国内加密 DNS 端点（DoH 443 / DoT 853；53 端口的普通 DNS 已被 TUN 劫持，不在此列）
const BYPASS_DNS_RULES = [
  "DOMAIN,dns.alidns.com,REJECT",
  "DOMAIN-SUFFIX,doh.pub,REJECT",
  "DOMAIN-SUFFIX,dns.pub,REJECT",
  "DOMAIN,doh.360.cn,REJECT",
  "DOMAIN,dot.pub,REJECT",
  "DOMAIN,dot.360.cn,REJECT",
  "IP-CIDR,223.5.5.5/32,REJECT,no-resolve",
  "IP-CIDR,223.6.6.6/32,REJECT,no-resolve",
  "IP-CIDR,1.12.12.12/32,REJECT,no-resolve",
  "IP-CIDR,120.53.53.53/32,REJECT,no-resolve",
  "IP-CIDR6,2400:3200::1/128,REJECT,no-resolve",
  "IP-CIDR6,2400:3200:baba::1/128,REJECT,no-resolve",
];

// STUN / TURN 常用端口：3478-3479 标准端口，5349-5350 TLS，19302-19309 Google
const STUN_PORTS = "3478-3479/5349-5350/19302-19309";

// 这些域名返回真实 IP 而不是 Fake-IP（局域网、系统联网检测、NTP、STUN、游戏、远程控制、运营商一键登录）。
// 会与订阅自带的列表合并，不会替换
const FAKE_IP_FILTER = [
  "+.lan",
  "+.local",
  "+.localdomain",
  "+.home.arpa",
  "+.internal",
  "+.ts.net",
  "WORKGROUP",
  "+.msftconnecttest.com",
  "+.msftncsi.com",
  "localhost.ptlogin2.qq.com",
  "localhost.sec.qq.com",
  "localhost.work.weixin.qq.com",
  "time.*.com",
  "time.*.gov",
  "time.*.edu.cn",
  "time.*.apple.com",
  "time-ios.apple.com",
  "time1.cloud.tencent.com",
  "ntp.*.com",
  "+.pool.ntp.org",
  "+.ntp.org.cn",
  "+.stun.*.*",
  "+.stun.*.*.*",
  "+.stun.*.*.*.*",
  "+.stun.*.*.*.*.*",
  "+.srv.nintendo.net",
  "+.stun.playstation.net",
  "xbox.*.microsoft.com",
  "+.xboxlive.com",
  "+.battlenet.com.cn",
  "+.wotgame.cn",
  "+.wggames.cn",
  "+.wowsgame.cn",
  "+.wargaming.net",
  "+.mcdn.bilivideo.cn",
  "+.oray.com",
  "+.sunlogin.net",
  "+.cmpassport.com",
  "id6.me",
  "open.e.189.cn",
  "mdn.open.wo.cn",
  "opencloud.wostore.cn",
  "auth.wosms.cn",
  "+.10099.com.cn",
];

// 信息节点名称特征（同时用于 JS 和 mihomo 的 exclude-filter，只用两边都支持的语法）
const INFO_NODE_PATTERN =
  "剩余|到期|过期|有效期|重置|官网|网址|客服|失联|发布页|[Ee]xpire|[Tt]raffic|[Rr]emaining|[Rr]eset";

// 支持 UDP、但需要显式开启 udp 的协议
const UDP_TYPES = ["ss", "ssr", "vmess", "vless", "trojan", "socks5", "anytls"];

// 地区匹配。缩写两侧不能紧挨字母，避免 “RUS” 被当成 “US”
const abbr = (codes) => "(^|[^A-Za-z])(" + codes + ")([^A-Za-z]|$)";
const REGIONS = [
  { id: "HK", name: "🇭🇰 香港节点", pattern: "港|🇭🇰|" + abbr("HK|HKG") + "|[Hh]ong ?[Kk]ong" },
  { id: "TW", name: "🇹🇼 台湾节点", pattern: "台湾|台灣|台北|新北|彰化|🇹🇼|" + abbr("TW|TWN") + "|[Tt]aiwan" },
  { id: "JP", name: "🇯🇵 日本节点", pattern: "日本|东京|東京|大阪|埼玉|🇯🇵|" + abbr("JP|JPN") + "|[Jj]apan|[Tt]okyo|[Oo]saka" },
  { id: "SG", name: "🇸🇬 新加坡节点", pattern: "新加坡|狮城|獅城|🇸🇬|" + abbr("SG|SGP") + "|[Ss]ingapore" },
  {
    id: "US",
    name: "🇺🇸 美国节点",
    pattern: "美国|美國|洛杉矶|圣何塞|硅谷|西雅图|芝加哥|纽约|达拉斯|🇺🇸|" + abbr("US|USA") + "|[Uu]nited ?[Ss]tates|[Aa]merica",
  },
];

// full 模式的服务分流（顺序即匹配顺序：GitHub 必须在微软之前，YouTube 在 Google 之前）
const SERVICES = [
  { name: "🤖 AI 服务", geosite: ["category-ai-!cn"], prefer: ["US", "JP", "SG", "TW"] },
  { name: "🐙 GitHub", geosite: ["github"] },
  { name: "📺 YouTube", geosite: ["youtube"] },
  { name: "🔍 Google", geosite: ["google"], geoip: ["google"] },
  { name: "✈️ Telegram", geosite: ["telegram"], geoip: ["telegram"] },
  { name: "🎬 Netflix", geosite: ["netflix"], geoip: ["netflix"] },
  { name: "Ⓜ️ 微软服务", geosite: ["microsoft"], direct: true },
  { name: "🍎 苹果服务", geosite: ["apple"], direct: true },
];

const GROUP = {
  main: "🚀 节点选择",
  auto: "♻️ 自动选择",
  direct: "🎯 全球直连",
  ads: "🛑 广告拦截",
  final: "🐟 漏网之鱼",
};

// ============================== 入口 ==============================
function main(config, profileName) {
  if (!config || typeof config !== "object") return config;

  applyBase(config);
  if (CONFIG.sniffer) applySniffer(config);
  if (CONFIG.removeInfoNodes) removeInfoNodes(config);
  tuneProxies(config);

  let target;
  if (CONFIG.mode === "full" && hasNodes(config)) {
    target = buildFullRouting(config);
  } else {
    if (CONFIG.mode === "full") console.warn("[防泄露] 订阅里没有节点，full 模式已退回 enhance 模式");
    if (CONFIG.tuneHealthCheck) tuneGroups(config);
    target = pickMainGroup(config);
  }
  if (!target) console.warn("[防泄露] 找不到代理分组：境外 DNS 将按规则出站" + (CONFIG.webrtc === "off" ? "" : "，WebRTC 流量改为拦截"));

  applyDNS(config, target);

  const head = CONFIG.extraRules.concat(headRules(target));
  const tail = tailRules();
  const rules = (Array.isArray(config.rules) ? config.rules : []).filter((r) => head.indexOf(r) < 0 && tail.indexOf(r) < 0);
  config.rules = head.concat(guardDirectMatch(config, rules, target), tail);

  checkTun(config.tun);
  return config;
}

// Verge 在执行扩展前已写入设置页管理的 TUN 字段，脚本改这些字段会被设置页覆盖，只能提示。
// 设置页没有管理严格路由（tun 里没有这个键）时，脚本直接打开它
function checkTun(tun) {
  if (!tun || !tun.enable) {
    if (CONFIG.webrtc !== "off") console.warn("[防泄露] 未开启 TUN 模式：浏览器的 WebRTC(UDP) 流量不经过 Clash，请开启虚拟网卡模式");
    return;
  }
  if (!("strict-route" in tun)) {
    tun["strict-route"] = true;
    console.log("[防泄露] 设置页未管理严格路由，已由脚本开启");
  } else if (tun["strict-route"] !== true) {
    console.warn(
      "[防泄露] 未开启「严格路由」：Windows 会绕过 TUN 直接向路由器 / IPv6 DNS 发查询，这是最常见的残留 DNS 泄露。" +
        "开启位置：设置 → 系统设置 →「虚拟网卡模式」文字右边的齿轮图标 → 严格路由"
    );
  }
}

// ============================== 基础与性能 ==============================
function applyBase(config) {
  config["tcp-concurrent"] = true;
  config["geodata-loader"] = "memconservative";
  config["geo-auto-update"] = true;
  config["geo-update-interval"] = 24;
  config["geox-url"] = {
    geoip: CONFIG.geoBase + "/geoip.dat",
    geosite: CONFIG.geoBase + "/geosite.dat",
    mmdb: CONFIG.geoBase + "/country.mmdb",
    asn: CONFIG.geoBase + "/GeoLite2-ASN.mmdb",
  };
  config.profile = Object.assign({}, config.profile, { "store-selected": true, "store-fake-ip": true });
}

// ============================== DNS ==============================
function applyDNS(config, target) {
  // “#出站&参数” 让每个 DNS 服务器固定出站，不经过分流规则，也就不需要为它们加规则、改动你的分流。
  // 分组名含 & % # 时 URL 无法表达，退回 respect-rules（按规则出站）
  const proxy = target && !/[&%#]/.test(target) ? target : "";
  if (target && !proxy) console.warn("[防泄露] 分组名 “" + target + "” 含 & % #，境外 DNS 改为按规则出站");
  const via = proxy ? [proxy] : [];
  const doh = (ip, params) => "https://" + ip + "/dns-query" + (params.length ? "#" + params.join("&") : "");

  const domestic = DNS_DOMESTIC_IPS.map((ip) => doh(ip, ["DIRECT"])).concat(DNS_DOMESTIC_UDP.map((ip) => ip + "#DIRECT"));
  const foreign = CONFIG.dnsECS
    ? DNS_ECS_IPS.map((ip) => doh(ip, via.concat(["ecs=" + CONFIG.dnsECS, "ecs-override=true"])))
    : DNS_FOREIGN_IPS.map((ip) => doh(ip, via));
  const old = config.dns && typeof config.dns === "object" ? config.dns : {};

  // policy 按书写顺序匹配，第一个命中的生效：
  //   局域网 → 订阅针对具体域名写的条目（机场面板、公司内网、路由器等，保持原效果并固定直连）
  //   → 系统服务 → 国内 → 境外 → 订阅的 geosite / rule-set 大类条目；都不命中的交给 nameserver
  const oldPolicy = old["nameserver-policy"] && typeof old["nameserver-policy"] === "object" ? old["nameserver-policy"] : {};
  const policy = {};
  const put = (key, value) => {
    if (!(key in policy)) policy[key] = value;
  };
  if (CONFIG.lanDNS) put(LAN_DOMAINS, [CONFIG.lanDNS + "#DIRECT"]);
  Object.keys(oldPolicy).forEach((key) => {
    if (!/^(geosite|rule-set):/i.test(key)) put(key, pinDirect(oldPolicy[key]));
  });
  put(SYSTEM_DOMAINS, domestic.slice());
  put("geosite:cn,private", domestic.slice());
  put("geosite:geolocation-!cn", foreign.slice());
  Object.keys(oldPolicy).forEach((key) => put(key, pinDirect(oldPolicy[key])));

  // 在订阅原有 DNS 设置上叠加：只替换会造成泄露的上游，其余（监听、hosts、过滤列表等）保留
  const oldPsn = old["proxy-server-nameserver"];
  const dns = Object.assign({}, old, {
    enable: true,
    ipv6: CONFIG.dnsIPv6,
    "prefer-h3": false,
    "respect-rules": true,
    "cache-algorithm": old["cache-algorithm"] || "arc",
    "enhanced-mode": "fake-ip",
    "default-nameserver": DNS_BOOTSTRAP.slice(),
    // 解析节点域名：订阅自己指定了就沿用
    "proxy-server-nameserver": Array.isArray(oldPsn) && oldPsn.length ? oldPsn : domestic.slice(),
    "direct-nameserver": domestic.slice(),
    nameserver: foreign.slice(),
    "nameserver-policy": policy,
  });
  delete dns.fallback; // 旧式“国内 + 境外同时查”的设置，会把境外域名发给国内 DNS
  delete dns["fallback-filter"];

  // redir-host 下每次解析境外域名都要等节点，节点一慢所有软件都慢；统一用 Fake-IP（Verge TUN 的默认）
  if (old["enhanced-mode"] === "redir-host") console.log("[防泄露] 订阅用的是 redir-host，已改为 Fake-IP，避免每次解析境外域名都要等节点");
  if (!dns["fake-ip-range"]) dns["fake-ip-range"] = "198.18.0.1/16";
  const mode = dns["fake-ip-filter-mode"];
  if (!mode || mode === "blacklist") {
    // 黑名单模式：与订阅的列表合并；白名单 / rule 模式下列表含义不同，保持订阅原样
    dns["fake-ip-filter-mode"] = "blacklist";
    const merged = (Array.isArray(old["fake-ip-filter"]) ? old["fake-ip-filter"] : []).slice();
    FAKE_IP_FILTER.forEach((d) => {
      if (merged.indexOf(d) < 0) merged.push(d);
    });
    dns["fake-ip-filter"] = merged;
  }
  if (CONFIG.dnsIPv6) dns["fake-ip-range6"] = old["fake-ip-range6"] || "2001:2::0/64";
  config.dns = dns;
}

// 订阅 policy 里没指定出站的服务器补上 #DIRECT：开了 respect-rules 后它们不会被分流规则拦截或送进代理，
// 效果和原来一样。system / dhcp 这类特殊写法不能加
function pinDirect(value) {
  return (Array.isArray(value) ? value : [value]).map((server) =>
    typeof server === "string" && server.indexOf("#") < 0 && !/^(system|dhcp:|rcode:|ts:|tailscale:|et:|easytier:)/i.test(server)
      ? server + "#DIRECT"
      : server
  );
}

// ============================== 域名嗅探 ==============================
function applySniffer(config) {
  config.sniffer = {
    enable: true,
    "force-dns-mapping": true,
    "parse-pure-ip": true,
    "override-destination": false,
    sniff: {
      HTTP: { ports: [80, "8080-8880"] },
      TLS: { ports: [443, 8443] },
      QUIC: { ports: [443, 8443] },
    },
    "skip-domain": ["Mijia Cloud", "dlg.io.mi.com", "+.push.apple.com", "+.oray.com", "+.sunlogin.net"],
  };
}

// ============================== 防泄露规则 ==============================
// 放在最前面的防泄露规则
function headRules(target) {
  // DNS 服务器的出站已在 DNS 地址里固定，不再占用分流规则
  const rules = CONFIG.blockDNSBypass ? BYPASS_DNS_RULES.slice() : [];

  // WebRTC：发往国内 STUN 服务器的请求会被订阅的 GEOIP,CN 等规则直连，暴露真实 IP，只把这部分改走代理。
  // no-resolve：不为判断去解析域名（国内域名由 GEOSITE,cn 识别），不拖慢其他软件的连接
  const cnStun = "AND,((DST-PORT," + STUN_PORTS + "),(OR,((GEOSITE,cn),(GEOIP,CN,no-resolve))))";
  if (CONFIG.webrtc === "reject" || (CONFIG.webrtc === "proxy" && !target)) {
    rules.push("DST-PORT," + STUN_PORTS + ",REJECT");
  } else if (CONFIG.webrtc === "proxy") {
    rules.push(cnStun + "," + target);
    // 代理组的节点不支持 UDP 时内核会跳过上一条继续往下匹配，最后直连；这里兜住
    rules.push(cnStun + ",REJECT");
  }

  if (CONFIG.blockQUIC) rules.push("AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn)))),REJECT");
  return rules;
}

// 放在订阅规则最后（MATCH 之后）：只有规则选中的代理不支持 UDP、内核准备悄悄改成直连时才会走到这里
function tailRules() {
  const rules = [];
  if (CONFIG.webrtc !== "off") rules.push("AND,((NETWORK,UDP),(DST-PORT," + STUN_PORTS + ")),REJECT");
  if (CONFIG.udpLeakGuard) rules.push("AND,((NETWORK,UDP),(DST-PORT,443)),REJECT");
  return rules;
}

// 订阅的兜底规则（MATCH）是直连时（白名单模式），网页可以挑一个国外 STUN 服务器直连拿到真实 IP，
// 在 MATCH 前把这部分 STUN 改走代理；局域网的不动
function guardDirectMatch(config, rules, target) {
  if (CONFIG.webrtc !== "proxy" || !target) return rules;
  const index = rules.findIndex((r) => /^MATCH,/i.test(r));
  if (index < 0 || !isDirectPolicy(config, rules[index].split(",")[1].trim())) return rules;
  const stun = "AND,((DST-PORT," + STUN_PORTS + "),(NOT,((GEOIP,LAN,no-resolve))))";
  if (rules.indexOf(stun + "," + target) >= 0) return rules;
  return rules.slice(0, index).concat([stun + "," + target, stun + ",REJECT"], rules.slice(index));
}

const BUILTIN_NONPROXY = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"];

// DIRECT 本身，或第一个选项是 DIRECT 的分组
function isDirectPolicy(config, name) {
  if (name === "DIRECT") return true;
  const group = (config["proxy-groups"] || []).find((g) => g && g.name === name);
  return !!group && Array.isArray(group.proxies) && group.proxies[0] === "DIRECT";
}

// ============================== 节点处理 ==============================
function nodeList(config) {
  return Array.isArray(config.proxies) ? config.proxies : [];
}

function hasNodes(config) {
  return nodeList(config).length > 0 || Object.keys(config["proxy-providers"] || {}).length > 0;
}

// 只处理订阅里直接写出的节点；proxy-providers 的节点脚本看不到，不去过滤，免得误删
function removeInfoNodes(config) {
  const re = new RegExp(INFO_NODE_PATTERN);
  const nodes = nodeList(config);
  const info = nodes.filter((p) => p && typeof p.name === "string" && re.test(p.name));
  if (info.length === 0) return;
  if (info.length * 2 > nodes.length) {
    console.warn("[防泄露] 超过一半的节点名带有“到期/官网”等字样，判断为正常节点，未删除任何节点");
    return;
  }
  const removed = {};
  info.forEach((p) => (removed[p.name] = true));
  config.proxies = nodes.filter((p) => !(p && removed[p.name]));

  (config["proxy-groups"] || []).forEach((g) => {
    if (!g || !Array.isArray(g.proxies)) return;
    g.proxies = g.proxies.filter((name) => !removed[name]);
    // 只含信息节点的分组会变空，mihomo 会拒绝加载，补一个 REJECT 占位
    if (g.proxies.length === 0 && !g.use && !g["include-all"] && !g["include-all-proxies"] && !g["include-all-providers"]) {
      g.proxies = ["REJECT"];
    }
  });
}

// 默认不改节点；只有在 CONFIG 里明确打开时才补 UDP / 指纹
function tuneProxies(config) {
  // 新版内核已废弃并忽略这个字段（只会在日志里报错），删掉不影响任何连接
  delete config["global-client-fingerprint"];
  const fp = CONFIG.clientFingerprint;
  if (!fp && !CONFIG.forceUDP) return;
  nodeList(config).forEach((p) => {
    if (!p || typeof p !== "object") return;
    if (CONFIG.forceUDP && UDP_TYPES.indexOf(p.type) >= 0) p.udp = true;

    const usesTLS = p.type === "trojan" || p.type === "anytls" || ((p.type === "vmess" || p.type === "vless") && p.tls === true);
    if (fp && usesTLS && !p["client-fingerprint"]) p["client-fingerprint"] = fp;
  });
}

// ============================== enhance 模式 ==============================
function healthCheck(type) {
  const h = CONFIG.healthCheck;
  const fields = { url: h.url, interval: h.interval, lazy: true };
  if (type === "url-test") fields.tolerance = h.tolerance;
  return fields;
}

function tuneGroups(config) {
  (config["proxy-groups"] || []).forEach((g) => {
    if (g && (g.type === "url-test" || g.type === "fallback" || g.type === "load-balance")) {
      Object.assign(g, healthCheck(g.type));
    }
  });

  const providers = config["proxy-providers"] || {};
  Object.keys(providers).forEach((key) => {
    const hc = providers[key] && providers[key]["health-check"];
    if (hc && hc.enable) {
      hc.url = CONFIG.healthCheck.url;
      hc.interval = CONFIG.healthCheck.interval;
    }
  });
}

function pickMainGroup(config) {
  const groups = (config["proxy-groups"] || []).filter((g) => g && typeof g.name === "string");
  const byName = (name) => groups.find((g) => g.name === name);
  // 第一个选项是 DIRECT / REJECT 的分组不能当出口，否则境外 DNS 会直连（国内连不上 Google / Cloudflare）
  const usable = (g) => !(Array.isArray(g.proxies) && g.proxies.length && BUILTIN_NONPROXY.indexOf(g.proxies[0]) >= 0);
  const fallback = (name, why) => {
    console.warn("[防泄露] " + why + "，境外 DNS 和 WebRTC 改用「" + name + "」出站；不对的话请在 CONFIG.mainGroup 里指定");
    return name;
  };

  if (CONFIG.mainGroup) {
    if (byName(CONFIG.mainGroup)) return CONFIG.mainGroup;
    console.warn("[防泄露] 未找到分组 “" + CONFIG.mainGroup + "”，改为自动识别");
  }
  const named = groups.find((g) => g.type === "select" && usable(g) && /节点选择|代理选择|选择节点|选择代理|手动选择|[Pp]roxy|PROXY/.test(g.name));
  if (named) return named.name;

  // 订阅兜底规则（MATCH）指向的分组，通常就是主出口
  const match = (Array.isArray(config.rules) ? config.rules : []).find((r) => /^MATCH,/i.test(r));
  const matchGroup = match && byName(match.split(",")[1].trim());
  if (matchGroup && usable(matchGroup)) return fallback(matchGroup.name, "没找到名字带「节点选择 / Proxy」的分组");

  const other = groups.find((g) => g.type === "select" && usable(g)) || groups.find(usable);
  if (other) return fallback(other.name, "没找到名字带「节点选择 / Proxy」的分组");

  const first = nodeList(config).find((p) => p && p.name);
  return first ? first.name : null;
}

// ============================== full 模式 ==============================
function buildFullRouting(config) {
  const providers = {};
  const ruleSet = (kind, name) => {
    const key = kind + "-" + name.replace(/!/g, "not-");
    providers[key] = {
      type: "http",
      behavior: kind === "geosite" ? "domain" : "ipcidr",
      format: "mrs",
      url: CONFIG.ruleBase + "/" + kind + "/" + name + ".mrs",
      path: "./ruleset/" + key + ".mrs",
      interval: 86400,
    };
    return key;
  };

  const names = nodeList(config).map((p) => p && p.name).filter(Boolean);
  const hasProviders = Object.keys(config["proxy-providers"] || {}).length > 0;
  // 只建有节点的地区组；有 proxy-providers 时无法预知节点，全部建出（空组回落为 REJECT，不会直连）
  const regions = REGIONS.filter((r) => {
    const re = new RegExp(r.pattern);
    return hasProviders || names.some((n) => re.test(n));
  });
  const regionNames = regions.map((r) => r.name);
  const regionById = (id) => regions.filter((r) => r.id === id).map((r) => r.name);

  const groups = [
    { name: GROUP.main, type: "select", proxies: [GROUP.auto].concat(regionNames), "include-all": true, "exclude-filter": INFO_NODE_PATTERN },
    Object.assign({ name: GROUP.auto, type: "url-test", "include-all": true, "exclude-filter": INFO_NODE_PATTERN }, healthCheck("url-test")),
  ];

  SERVICES.forEach((s) => {
    let proxies;
    if (s.direct) proxies = ["DIRECT", GROUP.main, GROUP.auto];
    else if (s.prefer && hasProviders) proxies = [GROUP.main, GROUP.auto].concat([].concat.apply([], s.prefer.map(regionById))); // 地区组可能为空，默认走节点选择
    else if (s.prefer) proxies = [].concat.apply([], s.prefer.map(regionById)).concat([GROUP.main, GROUP.auto]);
    else proxies = [GROUP.main, GROUP.auto].concat(regionNames);
    groups.push({ name: s.name, type: "select", proxies: proxies });
  });

  groups.push({ name: GROUP.direct, type: "select", proxies: ["DIRECT", GROUP.main] });
  if (CONFIG.adBlock) groups.push({ name: GROUP.ads, type: "select", proxies: ["REJECT", "DIRECT"] });
  groups.push({ name: GROUP.final, type: "select", proxies: [GROUP.main, GROUP.auto, "DIRECT"] });

  regions.forEach((r) => {
    groups.push(
      Object.assign(
        {
          name: r.name,
          type: "url-test",
          "include-all": true,
          filter: r.pattern,
          "exclude-filter": INFO_NODE_PATTERN,
          "empty-fallback": "REJECT",
        },
        healthCheck("url-test")
      )
    );
  });

  const rules = ["RULE-SET," + ruleSet("geosite", "private") + ",DIRECT"];
  if (CONFIG.adBlock) rules.push("RULE-SET," + ruleSet("geosite", "category-ads-all") + "," + GROUP.ads);
  SERVICES.forEach((s) => s.geosite.forEach((n) => rules.push("RULE-SET," + ruleSet("geosite", n) + "," + s.name)));
  rules.push("RULE-SET," + ruleSet("geosite", "geolocation-!cn") + "," + GROUP.main);
  rules.push("RULE-SET," + ruleSet("geosite", "cn") + "," + GROUP.direct);
  rules.push("RULE-SET," + ruleSet("geoip", "private") + ",DIRECT,no-resolve");
  SERVICES.forEach((s) => (s.geoip || []).forEach((n) => rules.push("RULE-SET," + ruleSet("geoip", n) + "," + s.name + ",no-resolve")));
  // 未命中任何域名规则的域名会在这里本地解析；境外域名走境外 DoH（经代理），不会泄露给运营商
  rules.push("RULE-SET," + ruleSet("geoip", "cn") + "," + GROUP.direct);
  rules.push("MATCH," + GROUP.final);

  config["proxy-groups"] = groups;
  config["rule-providers"] = providers;
  config.rules = rules;
  return GROUP.main;
}
