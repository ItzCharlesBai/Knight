// 订阅转换：节点处理（筛选、重命名、国旗、去重、排序）与分组模板
// 模板生成的是 mihomo 配置（proxy-groups + rules），转 sing-box 时再统一转换

// 地区：名字里的关键词（中英文、城市、国旗）。正则同时给 JS 和 mihomo（Go RE2）用，所以不用前后断言
export const REGIONS = [
  { code: "HK", name: "香港", flag: "🇭🇰", re: "香港|港|深港|沪港|Hong ?Kong|HKG|(?:^|[^A-Za-z])HK(?:[^A-Za-z]|$)|🇭🇰" },
  { code: "TW", name: "台湾", flag: "🇹🇼", re: "台湾|台灣|臺灣|台北|新北|彰化|Taiwan|(?:^|[^A-Za-z])TW(?:[^A-Za-z]|$)|🇹🇼" },
  { code: "JP", name: "日本", flag: "🇯🇵", re: "日本|东京|東京|大阪|埼玉|Japan|Tokyo|Osaka|(?:^|[^A-Za-z])JP(?:[^A-Za-z]|$)|🇯🇵" },
  { code: "SG", name: "新加坡", flag: "🇸🇬", re: "新加坡|狮城|獅城|Singapore|(?:^|[^A-Za-z])SG(?:[^A-Za-z]|$)|🇸🇬" },
  { code: "US", name: "美国", flag: "🇺🇸", re: "美国|美國|洛杉矶|洛杉磯|硅谷|西雅图|纽约|芝加哥|圣何塞|达拉斯|凤凰城|United ?States|America|(?:^|[^A-Za-z])USA?(?:[^A-Za-z]|$)|🇺🇸" },
  { code: "KR", name: "韩国", flag: "🇰🇷", re: "韩国|韓國|首尔|首爾|春川|Korea|Seoul|(?:^|[^A-Za-z])KR(?:[^A-Za-z]|$)|🇰🇷" },
  { code: "GB", name: "英国", flag: "🇬🇧", re: "英国|英國|伦敦|倫敦|Britain|London|(?:^|[^A-Za-z])(?:UK|GB)(?:[^A-Za-z]|$)|🇬🇧" },
  { code: "DE", name: "德国", flag: "🇩🇪", re: "德国|德國|法兰克福|Germany|Frankfurt|(?:^|[^A-Za-z])DE(?:[^A-Za-z]|$)|🇩🇪" },
];
const REGION_RES = REGIONS.map((r) => Object.assign({}, r, { js: new RegExp(r.re, "iu") }));

export function regionOf(name) {
  return REGION_RES.find((r) => r.js.test(String(name))) || null;
}

// 已经以国旗开头的名字不再加
const FLAG_START = /^\s*(?:[\u{1F1E6}-\u{1F1FF}]{2}|🏳|🏴)/u;

export const DEFAULT_CONVERT = {
  template: "keep", // keep 保持订阅自带的分组和规则 | simple 简洁 | region 按地区 | full 全面分流
  include: "",
  exclude: "",
  rename: "", // 每行一条「原文 => 替换」，原文按正则处理
  emoji: false,
  dedupe: false,
  sort: "none", // none | name | region
  udp: false,
  skipCert: false,
};

export const TEMPLATES = [
  ["keep", "保持原样", "订阅自带的分组和规则不动；只有节点链接时用「简洁」"],
  ["simple", "简洁", "节点选择 + 自动选择，国内直连、其余走代理"],
  ["region", "按地区", "在简洁的基础上，按香港、台湾、日本、新加坡、美国等地区各建一个自动选择分组"],
  ["full", "全面分流", "按地区分组，再加上 AI、流媒体、Telegram、苹果、微软、游戏、广告拦截等分流"],
];

const safeRegex = (pattern) => {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, "iu");
  } catch {
    throw new Error(`正则写错了：${pattern}`);
  }
};

function renameRules(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("=>"))
    .map((line) => {
      const at = line.indexOf("=>");
      return [safeRegex(line.slice(0, at).trim()), line.slice(at + 2).trim()];
    })
    .filter(([re]) => re);
}

// 两个节点是不是同一台服务器的同一个账号（名字不算）
const nodeKey = (p) => {
  const rest = Object.assign({}, p);
  delete rest.name;
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
};

// 返回 { proxies, renamed: Map(旧名 → 新名), removed: Set(旧名) }
export function processNodes(proxies, options = {}) {
  const o = Object.assign({}, DEFAULT_CONVERT, options);
  const include = safeRegex(o.include);
  const exclude = safeRegex(o.exclude);
  const rules = renameRules(o.rename);
  const renamed = new Map();
  const removed = new Set();
  const seen = new Set();
  const names = new Set();
  let out = [];
  for (const p of Array.isArray(proxies) ? proxies : []) {
    if (!p || typeof p !== "object" || !p.name) continue;
    if ((include && !include.test(p.name)) || (exclude && exclude.test(p.name))) {
      removed.add(p.name);
      continue;
    }
    if (o.dedupe) {
      const key = nodeKey(p);
      if (seen.has(key)) {
        removed.add(p.name);
        continue;
      }
      seen.add(key);
    }
    const node = Object.assign({}, p);
    let name = node.name;
    for (const [re, to] of rules) name = name.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), to);
    name = name.trim() || node.name;
    if (o.emoji && !FLAG_START.test(name)) {
      const region = regionOf(name);
      if (region) name = `${region.flag} ${name}`;
    }
    for (let i = 2; names.has(name); i++) name = `${name.replace(/ #\d+$/, "")} #${i}`;
    names.add(name);
    if (name !== node.name) renamed.set(node.name, name);
    node.name = name;
    if (o.udp && ["ss", "ssr", "vmess", "vless", "trojan", "socks5", "anytls"].includes(node.type)) node.udp = true;
    if (o.skipCert && ["vmess", "vless", "trojan", "hysteria", "hysteria2", "tuic", "anytls", "http", "socks5"].includes(node.type)) node["skip-cert-verify"] = true;
    out.push(node);
  }
  if (o.sort === "name") out = out.slice().sort((a, b) => a.name.localeCompare(b.name, "zh"));
  if (o.sort === "region") {
    const rank = (p) => {
      const i = REGION_RES.findIndex((r) => r.js.test(p.name));
      return i < 0 ? REGION_RES.length : i;
    };
    out = out.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([p]) => p);
  }
  return { proxies: out, renamed, removed };
}

// ============================== 模板 ==============================
const TEST_URL = "https://www.gstatic.com/generate_204";
const autoGroup = (name, members, extra = {}) => Object.assign({ name, type: "url-test", url: TEST_URL, interval: 300, tolerance: 50, lazy: true }, members, extra);

// names：已知的节点名；providers：代理集合名（节点名未知，用 use + filter 引用）
export function buildTemplate(template, names, providers = [], knownProviderNames = []) {
  const all = names.concat(knownProviderNames);
  const use = providers.length ? { use: providers } : {};
  const regionGroups = [];
  if (template === "region" || template === "full") {
    const matched = new Set();
    for (const r of REGION_RES) {
      const inline = names.filter((n) => r.js.test(n));
      const fromProviders = knownProviderNames.some((n) => r.js.test(n));
      if (!inline.length && !fromProviders) continue;
      inline.forEach((n) => matched.add(n));
      knownProviderNames.filter((n) => r.js.test(n)).forEach((n) => matched.add(n));
      regionGroups.push(
        autoGroup(r.name, Object.assign(inline.length ? { proxies: inline } : {}, fromProviders ? { use: providers, filter: "(?i)" + r.re } : {}))
      );
    }
    const others = names.filter((n) => !matched.has(n));
    const othersFromProviders = knownProviderNames.some((n) => !matched.has(n));
    if (regionGroups.length && (others.length || othersFromProviders)) {
      regionGroups.push(
        autoGroup(
          "其他地区",
          Object.assign(others.length ? { proxies: others } : {}, othersFromProviders ? { use: providers, "exclude-filter": "(?i)" + REGIONS.map((r) => r.re).join("|") } : {})
        )
      );
    }
  }
  const regionNames = regionGroups.map((g) => g.name);
  const hasNodes = all.length > 0 || providers.length > 0;
  const groups = [
    Object.assign({ name: "节点选择", type: "select", proxies: (hasNodes ? ["自动选择"] : []).concat(regionNames, names, ["DIRECT"]) }, use),
  ];
  if (hasNodes) groups.push(autoGroup("自动选择", Object.assign(names.length ? { proxies: names } : {}, use)));
  groups.push(...regionGroups);

  const rules = ["GEOSITE,private,DIRECT", "GEOIP,private,DIRECT,no-resolve"];
  if (template === "full") {
    const pick = (first, ...rest) => [...new Set([first, ...rest, "节点选择", ...regionNames])];
    const us = regionNames.includes("美国") ? "美国" : "节点选择";
    groups.push(
      { name: "AI 服务", type: "select", proxies: pick(us) },
      { name: "流媒体", type: "select", proxies: pick("节点选择").concat("DIRECT") },
      { name: "Telegram", type: "select", proxies: pick("节点选择") },
      { name: "苹果服务", type: "select", proxies: ["DIRECT", "节点选择"] },
      { name: "微软服务", type: "select", proxies: ["DIRECT", "节点选择"] },
      { name: "游戏平台", type: "select", proxies: ["DIRECT", "节点选择"] },
      { name: "广告拦截", type: "select", proxies: ["REJECT", "DIRECT"] },
      { name: "国内直连", type: "select", proxies: ["DIRECT", "节点选择"] },
      { name: "漏网之鱼", type: "select", proxies: ["节点选择", "DIRECT"] }
    );
    rules.push(
      "GEOSITE,category-ads-all,广告拦截",
      "GEOSITE,openai,AI 服务",
      "GEOSITE,anthropic,AI 服务",
      "GEOSITE,google-gemini,AI 服务",
      "GEOSITE,category-ai-!cn,AI 服务",
      "GEOSITE,telegram,Telegram",
      "GEOIP,telegram,Telegram,no-resolve",
      "GEOSITE,netflix,流媒体",
      "GEOSITE,disney,流媒体",
      "GEOSITE,youtube,流媒体",
      "GEOSITE,spotify,流媒体",
      "GEOSITE,tiktok,流媒体",
      "GEOIP,netflix,流媒体,no-resolve",
      "GEOSITE,github,节点选择",
      "GEOSITE,google,节点选择",
      "GEOSITE,apple,苹果服务",
      "GEOSITE,onedrive,微软服务",
      "GEOSITE,microsoft,微软服务",
      "GEOSITE,steam,游戏平台",
      "GEOSITE,category-games,游戏平台",
      "GEOSITE,cn,国内直连",
      "GEOIP,CN,国内直连",
      "MATCH,漏网之鱼"
    );
  } else {
    rules.push("GEOSITE,cn,DIRECT", "GEOIP,CN,DIRECT", "MATCH,节点选择");
  }
  return { "proxy-groups": groups, rules };
}

// 对整份配置做转换：节点处理后同步分组里的名字；模板不是 keep（或订阅没有分组）时重建分组和规则
// providerNodeNames：代理集合里已知的节点名（订阅更新时缓存过才有），只用来判断有哪些地区
export function applyConvert(config, options = {}, providerNodeNames = []) {
  const o = Object.assign({}, DEFAULT_CONVERT, options);
  const out = Object.assign({}, config);
  const { proxies, renamed, removed } = processNodes(config.proxies, o);
  out.proxies = proxies;
  const providers = Object.keys(config["proxy-providers"] || {});
  const hasGroups = Array.isArray(config["proxy-groups"]) && config["proxy-groups"].length > 0;
  const template = o.template === "keep" && !hasGroups ? "simple" : o.template;
  if (template === "keep") {
    out["proxy-groups"] = config["proxy-groups"].map((g) => {
      if (!g || !Array.isArray(g.proxies)) return g;
      const members = g.proxies.filter((n) => !removed.has(n)).map((n) => renamed.get(n) || n);
      // 筛掉节点后变空的分组用 REJECT 占位：宁可连不上，也不悄悄直连
      return Object.assign({}, g, { proxies: members.length || g.use || g["include-all"] || g["include-all-proxies"] || g["include-all-providers"] ? members : ["REJECT"] });
    });
    return out;
  }
  const built = buildTemplate(template, proxies.map((p) => p.name), providers, providerNodeNames);
  out["proxy-groups"] = built["proxy-groups"];
  out.rules = built.rules;
  delete out["rule-providers"];
  return out;
}
