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
  //   "proxy"  发往国内 STUN 服务器的请求改走代理（会直连暴露真实 IP 的只有这部分）；
  //            发往国外的照你原来的规则走（推荐）
  //   "reject" 拦截所有 STUN 请求，最彻底，但网页音视频通话可能无法建立
  //   "off"    不处理
  webrtc: "proxy",

  // ---- 以下优化默认关闭：它们会改变流量走法或节点连接方式，个别软件可能因此打不开 ----
  // 拦截境外 QUIC（UDP 443），让浏览器回落到 TCP
  blockQUIC: false,

  // DNS 是否返回 IPv6 地址。关闭可避免 IPv6 流量绕开代理
  dnsIPv6: false,

  // 未收录在国内/境外域名列表里的域名，用境外 DoH（经代理）解析时附带的 ECS 子网。
  // 填一个通用的国内网段（不是你的 IP），解析结果就和国内 DNS 一致，GEOIP 分流不会误判；
  // 查询仍经代理发出，运营商看不到。填 "" 关闭（未收录的国内网站可能被判成境外走代理）
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

  // 自动测速分组（url-test / fallback / load-balance）统一参数
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
// 国内 DoH：解析国内域名、节点域名和直连流量，固定直连
const DNS_DOMESTIC_IPS = ["223.5.5.5", "1.12.12.12"];
// 境外 DoH：解析已知境外域名，固定走代理组，运营商看不到查询内容
const DNS_FOREIGN_IPS = ["1.1.1.1", "8.8.8.8"];
// 解析未收录域名：Google DNS 会把 ECS 转给权威服务器（Cloudflare 不会），保证分流判断准确
const DNS_ECS_IPS = ["8.8.8.8", "8.8.4.4"];
// 仅用于解析 DoH 服务器自身的域名（上面都是 IP，基本用不到）
const DNS_BOOTSTRAP = ["223.5.5.5", "119.29.29.29"];

// 会绕过 Clash 的国内加密 DNS 端点（DoH 443 / DoT 853；53 端口的普通 DNS 已被 TUN 劫持，不在此列）
const BYPASS_DNS_RULES = [
  "DOMAIN,dns.alidns.com,REJECT",
  "DOMAIN-SUFFIX,doh.pub,REJECT",
  "DOMAIN-SUFFIX,dns.pub,REJECT",
  "DOMAIN,doh.360.cn,REJECT",
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
    tuneGroups(config);
    target = pickMainGroup(config);
  }
  if (!target) console.warn("[防泄露] 找不到代理分组：境外 DNS 将按规则出站" + (CONFIG.webrtc === "off" ? "" : "，WebRTC 流量改为拦截"));

  applyDNS(config, target);

  const head = CONFIG.extraRules.concat(leakRules(target));
  const rules = Array.isArray(config.rules) ? config.rules : [];
  config.rules = head.concat(rules.filter((r) => head.indexOf(r) < 0));

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
  const ecs = CONFIG.dnsECS ? ["ecs=" + CONFIG.dnsECS, "ecs-override=true"] : [];
  const doh = (ip, params) => "https://" + ip + "/dns-query" + (params.length ? "#" + params.join("&") : "");

  const domestic = DNS_DOMESTIC_IPS.map((ip) => doh(ip, ["DIRECT"]));
  const foreign = DNS_FOREIGN_IPS.map((ip) => doh(ip, proxy ? [proxy] : []));
  const unknown = ecs.length ? DNS_ECS_IPS.map((ip) => doh(ip, (proxy ? [proxy] : []).concat(ecs))) : foreign.slice();
  const old = config.dns && typeof config.dns === "object" ? config.dns : {};

  // policy 按书写顺序匹配：局域网 → 国内 → 已知境外 → 订阅自带的条目；都不命中的交给 nameserver（带 ECS）
  const policy = {};
  if (CONFIG.lanDNS) policy["+.lan,+.local,+.localdomain,+.home.arpa"] = [CONFIG.lanDNS + "#DIRECT"];
  policy["geosite:cn,private"] = domestic.slice();
  policy["geosite:geolocation-!cn"] = foreign;
  const oldPolicy = old["nameserver-policy"] && typeof old["nameserver-policy"] === "object" ? old["nameserver-policy"] : {};
  Object.keys(oldPolicy).forEach((key) => {
    if (!(key in policy)) policy[key] = oldPolicy[key];
  });

  // 在订阅原有 DNS 设置上叠加：只替换会造成泄露的上游，其余（模式、过滤列表、hosts 等）保留
  const dns = Object.assign({}, old, {
    enable: true,
    ipv6: CONFIG.dnsIPv6,
    "prefer-h3": false,
    "respect-rules": true,
    "cache-algorithm": old["cache-algorithm"] || "arc",
    "default-nameserver": DNS_BOOTSTRAP.slice(),
    "proxy-server-nameserver": domestic.slice(),
    "direct-nameserver": domestic.slice(),
    nameserver: unknown,
    "nameserver-policy": policy,
  });
  delete dns.fallback; // 旧式“国内 + 境外同时查”的设置，会把境外域名发给国内 DNS
  delete dns["fallback-filter"];

  // 订阅原本用 redir-host 就保持；否则用 Fake-IP（Verge TUN 的默认）
  if (dns["enhanced-mode"] !== "redir-host") dns["enhanced-mode"] = "fake-ip";
  if (dns["enhanced-mode"] === "fake-ip") {
    if (!dns["fake-ip-range"]) dns["fake-ip-range"] = "198.18.0.1/16";
    if (dns["fake-ip-filter-mode"] !== "whitelist") {
      // 黑名单模式：与订阅的列表合并；白名单模式下列表含义相反，保持订阅原样
      dns["fake-ip-filter-mode"] = "blacklist";
      const merged = (Array.isArray(old["fake-ip-filter"]) ? old["fake-ip-filter"] : []).slice();
      FAKE_IP_FILTER.forEach((d) => {
        if (merged.indexOf(d) < 0) merged.push(d);
      });
      dns["fake-ip-filter"] = merged;
    }
  }
  if (CONFIG.dnsIPv6) dns["fake-ip-range6"] = old["fake-ip-range6"] || "2001:2::0/64";
  config.dns = dns;
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
function leakRules(target) {
  // 这里只放防泄露所需的规则；DNS 服务器的出站已在 DNS 地址里固定，不再占用分流规则
  const rules = CONFIG.blockDNSBypass ? BYPASS_DNS_RULES.slice() : [];

  // WebRTC：直连暴露真实 IP 的只有发往国内 STUN 服务器的请求，只把这部分改走代理；
  // 发往国外的 STUN 照原规则走，不打乱国外软件的分流
  if (CONFIG.webrtc === "reject" || (CONFIG.webrtc === "proxy" && !target)) {
    rules.push("DST-PORT," + STUN_PORTS + ",REJECT");
  } else if (CONFIG.webrtc === "proxy") {
    rules.push("AND,((DST-PORT," + STUN_PORTS + "),(OR,((GEOSITE,cn),(GEOIP,CN))))," + target);
  }

  if (CONFIG.blockQUIC) rules.push("AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn)))),REJECT");
  return rules;
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

  if (CONFIG.mainGroup) {
    if (byName(CONFIG.mainGroup)) return CONFIG.mainGroup;
    console.warn("[防泄露] 未找到分组 “" + CONFIG.mainGroup + "”，改为自动识别");
  }
  const selects = groups.filter((g) => g.type === "select");
  const named = selects.find((g) => /节点选择|代理选择|选择节点|选择代理|手动选择|[Pp]roxy|PROXY/.test(g.name));
  if (named) return named.name;
  if (selects.length) return selects[0].name;
  if (groups.length) return groups[0].name;

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
