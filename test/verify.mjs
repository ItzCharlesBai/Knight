// 离线验证 merge.yaml 与 script.js：模拟 Clash Verge Rev 的执行流程，检查输出，
// 设置 MIHOMO_BIN 后再交给真实内核做 `mihomo -t` 语法校验。
//
//   npm test
//   MIHOMO_BIN=/path/to/mihomo GEODATA_DIR=/path/to/geodata npm test
//
// GEODATA_DIR 里放 geosite.dat / country.mmdb（Country.mmdb），供内核解析 GEOSITE/GEOIP。

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import yaml from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const MERGE = yaml.load(read("clash-verge-rev/merge.yaml"));
const SCRIPT = read("clash-verge-rev/script.js");
const fixture = (name) => yaml.load(read("test/fixtures/" + name));
const clone = (v) => JSON.parse(JSON.stringify(v));

// 与 Verge 的 use_merge 一致：dns 按子键替换，hosts 整体替换，其余递归合并
function useMerge(merge, config) {
  const deep = (a, b) => {
    if (isMap(a) && isMap(b)) {
      for (const k of Object.keys(b)) a[k] = k in a ? deep(a[k], b[k]) : b[k];
      return a;
    }
    return b;
  };
  const out = clone(config);
  for (const [key, value] of Object.entries(clone(merge))) {
    if (key === "dns" && isMap(out.dns) && isMap(value)) Object.assign(out.dns, value);
    else if (key in out && key !== "hosts") out[key] = deep(out[key], value);
    else out[key] = value;
  }
  return out;
}
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// 与 Verge 一致：脚本被包进 try 块执行，配置以 JSON 传入传出
function runScript(config, overrides = {}) {
  const logs = [];
  const log = (level) => (data) => logs.push([level, data]);
  const sandbox = {
    console: { log: log("log"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    __cfg: JSON.stringify(config),
    __overrides: JSON.stringify(overrides),
  };
  const code = `try{
    ${SCRIPT};
    Object.assign(CONFIG, JSON.parse(__overrides));
    JSON.stringify(main(JSON.parse(__cfg),'test')||'')
  } catch(err) { '__error_flag__ ' + err.stack }`;
  const result = vm.runInNewContext(code, sandbox, { timeout: 5000 });
  assert.ok(!result.startsWith("__error_flag__"), result);
  return { config: JSON.parse(result), logs };
}

// Verge 在扩展之前把 GUI 的 TUN 设置写进 tun
const withTun = (config, enable = true, extra = { "strict-route": true }) =>
  Object.assign(clone(config), { tun: Object.assign({ enable }, enable ? extra : {}) });

const builtin = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
function checkReferences(config) {
  const groups = config["proxy-groups"] || [];
  const names = new Set([...(config.proxies || []).map((p) => p.name), ...groups.map((g) => g.name), ...builtin]);
  for (const g of groups) {
    for (const p of g.proxies || []) assert.ok(names.has(p), `分组 ${g.name} 引用了不存在的 ${p}`);
    assert.ok((g.proxies || []).length || g.use || g["include-all"], `分组 ${g.name} 为空`);
  }
  const providers = config["rule-providers"] || {};
  for (const rule of config.rules) {
    const parts = rule.split(",");
    const target = rule.startsWith("AND,") ? parts[parts.length - 1] : rule.startsWith("MATCH,") ? parts[1] : parts[2];
    assert.ok(names.has(target), `规则 ${rule} 的目标不存在`);
    if (parts[0] === "RULE-SET") assert.ok(providers[parts[1]], `规则集 ${parts[1]} 未定义`);
  }
  // DNS 服务器固定的出站必须真实存在
  const dnsServers = [].concat(config.dns.nameserver, ...Object.values(config.dns["nameserver-policy"]));
  for (const server of dnsServers) {
    const out = (server.split("#")[1] || "").split("&").find((p) => p && !p.includes("="));
    if (out) assert.ok(names.has(out), `DNS ${server} 的出站不存在`);
  }
}

const BYPASS = [
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
const STUN = "3478-3479/5349-5350/19302-19309";
const CN_STUN = `AND,((DST-PORT,${STUN}),(OR,((GEOSITE,cn),(GEOIP,CN,no-resolve))))`;
const leakHead = (t) => [...BYPASS, `${CN_STUN},${t}`, `${CN_STUN},REJECT`];
const TAIL = [`AND,((NETWORK,UDP),(DST-PORT,${STUN})),REJECT`, "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT"];
const ECS = "ecs=223.5.5.0/24&ecs-override=true";
const DOMESTIC = ["https://223.5.5.5/dns-query#DIRECT", "https://1.12.12.12/dns-query#DIRECT", "223.5.5.5#DIRECT", "119.29.29.29#DIRECT"];
const SYSTEM =
  "+.msftconnecttest.com,+.msftncsi.com,time.windows.com,time.apple.com,time-ios.apple.com,time.asia.apple.com," +
  "+.pool.ntp.org,+.ntp.org.cn,+.srv.nintendo.net,+.stun.playstation.net,xbox.*.microsoft.com,+.xboxlive.com";
const googleECS = (g) => [`https://8.8.8.8/dns-query#${g ? g + "&" : ""}${ECS}`, `https://8.8.4.4/dns-query#${g ? g + "&" : ""}${ECS}`];

const outputs = {};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("默认：订阅自己的分流原样保留，最前只加加密 DNS 拦截，最后只加 UDP 兜底", () => {
  const sub = fixture("subscription.yaml");
  const { config, logs } = runScript(withTun(useMerge(MERGE, sub)));
  assert.deepEqual(config.rules, [...BYPASS, ...sub.rules, ...TAIL]);
  // 国内网站的 WebRTC 跟着订阅直连：没有任何把 STUN 送进代理的规则
  assert.ok(!config.rules.some((r) => r.includes("DST-PORT," + STUN) && !r.endsWith(",REJECT")));
  // 不拦 QUIC、不拦整个 853 端口、不为 DNS 服务器加改变分流的规则
  assert.ok(!config.rules.some((r) => /^DST-PORT,853|^IP-CIDR,(1\.1\.1\.1|8\.8\.8\.8)\/|NOT,\(\(GEOSITE,cn\)\)\)\),REJECT/.test(r)));
  assert.equal(logs.filter(([l]) => l === "warn").length, 0);
  checkReferences(config);
  outputs["enhance"] = config;
});

test("默认不改节点：除信息节点外，节点保持原样；测速参数不变", () => {
  const sub = fixture("subscription.yaml");
  const { config } = runScript(withTun(sub));
  const kept = sub.proxies.filter((p) => !/剩余|到期/.test(p.name));
  assert.deepEqual(config.proxies, kept); // 节点一个字段都不改
  assert.equal(config["global-client-fingerprint"], undefined); // 内核已忽略的废弃字段，只删不转写
  assert.equal(config.sniffer, undefined); // 默认不加嗅探
  const groups = Object.fromEntries(config["proxy-groups"].map((g) => [g.name, g]));
  assert.deepEqual(groups["📢 订阅信息"].proxies, ["REJECT"]);
  assert.ok(!groups["♻️ 自动选择"].proxies.includes("剩余流量：120.5 GB"));
  const original = sub["proxy-groups"].find((g) => g.name === "♻️ 自动选择");
  assert.equal(groups["♻️ 自动选择"].url, original.url);
  assert.equal(groups["♻️ 自动选择"].interval, original.interval);
  checkReferences(config);
});

test("可选优化：手动打开后补 UDP、TLS 指纹、嗅探、QUIC 拦截、测速参数", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")), { forceUDP: true, clientFingerprint: "chrome", sniffer: true, blockQUIC: true, tuneHealthCheck: true });
  const byName = Object.fromEntries(config.proxies.map((p) => [p.name, p]));
  assert.equal(byName["🇷🇺 RUS 01"].udp, true);
  assert.equal(byName["🇭🇰 HK02 IPLC"]["client-fingerprint"], "chrome");
  assert.equal(byName["🇹🇼 台湾 01"]["client-fingerprint"], "chrome");
  assert.equal(byName["🇭🇰 香港 01"]["client-fingerprint"], undefined); // ss 不加
  assert.equal(config.sniffer.enable, true);
  assert.equal(config.sniffer.sniff.HTTP["override-destination"], undefined); // 不改写目标地址
  assert.ok(config.rules.includes("AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn)))),REJECT"));
  const auto = config["proxy-groups"].find((g) => g.name === "♻️ 自动选择");
  assert.deepEqual([auto.url, auto.interval, auto.tolerance, auto.timeout], ["https://www.gstatic.com/generate_204", 300, 50, undefined]);
  checkReferences(config);
  outputs["optional-on"] = config;
});

test("信息节点保护：超过一半节点名带关键字时一个都不删", () => {
  const sub = fixture("subscription.yaml");
  sub.proxies.forEach((p) => (p.name += " | 官网 example.com"));
  sub["proxy-groups"].forEach((g) => (g.proxies = g.proxies.map((n) => (n === "DIRECT" || n.startsWith("♻️") || n.startsWith("🚀") || n.startsWith("🎯") ? n : n + " | 官网 example.com"))));
  const { config, logs } = runScript(withTun(sub));
  assert.equal(config.proxies.length, sub.proxies.length);
  assert.ok(logs.some(([l, m]) => l === "warn" && /未删除/.test(m)));
});

test("DNS：只替换上游；国内外判断与国内 DNS 一致；redir-host 改为 Fake-IP", () => {
  const { config, logs } = runScript(withTun(fixture("subscription.yaml")));
  const dns = config.dns;
  assert.equal(dns["enhanced-mode"], "fake-ip");
  assert.ok(logs.some(([l, m]) => l === "log" && /redir-host/.test(m)));
  assert.equal(dns["respect-rules"], true);
  assert.equal(dns.ipv6, false);
  assert.equal(dns.listen, "0.0.0.0:1053");
  assert.equal(dns.fallback, undefined);
  assert.equal(dns["fallback-filter"], undefined);
  assert.deepEqual(dns.nameserver, googleECS("🐟 漏网之鱼"));
  assert.deepEqual(dns["proxy-server-nameserver"], DOMESTIC);
  assert.deepEqual(dns["direct-nameserver"], DOMESTIC);
  assert.deepEqual(dns["nameserver-policy"], {
    "+.example-airport.com": ["114.114.114.114#DIRECT"], // 订阅针对具体域名的条目：最先匹配，固定直连
    [SYSTEM]: DOMESTIC,
    "geosite:cn,private": DOMESTIC,
    "geosite:geolocation-!cn": googleECS("🐟 漏网之鱼"),
  });
});

test("DNS：订阅解析条目的顺序与直连固定；特殊写法不动", () => {
  const sub = fixture("subscription.yaml");
  sub.dns = {
    enable: true,
    "enhanced-mode": "fake-ip",
    "proxy-server-nameserver": ["https://doh.example-airport.com/dns-query"],
    "nameserver-policy": {
      "geosite:cn": "114.114.114.114",
      "+.lan": "system",
      "+.corp.example": ["10.0.0.53", "tls://10.0.0.54#内网"],
      "+.panel.example": "https://223.5.5.5/dns-query",
      "+.box.example": "dhcp://en0",
    },
  };
  const { config } = runScript(withTun(sub));
  const policy = config.dns["nameserver-policy"];
  assert.deepEqual(Object.keys(policy), ["+.lan", "+.corp.example", "+.panel.example", "+.box.example", SYSTEM, "geosite:cn,private", "geosite:geolocation-!cn", "geosite:cn"]);
  assert.deepEqual(policy["+.lan"], ["system"]);
  assert.deepEqual(policy["+.corp.example"], ["10.0.0.53#DIRECT", "tls://10.0.0.54#内网"]);
  assert.deepEqual(policy["+.panel.example"], ["https://223.5.5.5/dns-query#DIRECT"]);
  assert.deepEqual(policy["+.box.example"], ["dhcp://en0"]);
  assert.deepEqual(config.dns["proxy-server-nameserver"], ["https://doh.example-airport.com/dns-query"]); // 订阅自己指定的沿用
  outputs["policy-order"] = config;
});

test("DNS：Fake-IP 过滤列表与订阅合并；白名单 / rule 模式保持原样", () => {
  const base = fixture("subscription.yaml");
  base.dns = { enable: true, "enhanced-mode": "fake-ip", "fake-ip-filter": ["+.corp.example", "+.lan"] };
  const merged = runScript(withTun(base)).config.dns;
  assert.equal(merged["fake-ip-filter"][0], "+.corp.example");
  assert.equal(merged["fake-ip-filter"].filter((d) => d === "+.lan").length, 1);
  assert.ok(merged["fake-ip-filter"].includes("+.msftconnecttest.com"));
  outputs["fake-ip-merge"] = runScript(withTun(base)).config;

  for (const mode of ["whitelist", "rule"]) {
    const list = mode === "rule" ? ["GEOSITE,cn,real-ip", "MATCH,fake-ip"] : ["+.google.com"];
    base.dns = { enable: true, "enhanced-mode": "fake-ip", "fake-ip-filter-mode": mode, "fake-ip-filter": list };
    const kept = runScript(withTun(base)).config.dns;
    assert.deepEqual(kept["fake-ip-filter"], list, mode);
    assert.equal(kept["fake-ip-filter-mode"], mode);
  }

  delete base.dns;
  const none = runScript(withTun(base)).config.dns;
  assert.equal(none["enhanced-mode"], "fake-ip");
  assert.equal(none["fake-ip-range"], "198.18.0.1/16");
});

test("DNS：关闭 ECS 时改用 Cloudflare/Google", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")), { dnsECS: "" });
  const plain = ["https://1.1.1.1/dns-query#🐟 漏网之鱼", "https://8.8.8.8/dns-query#🐟 漏网之鱼"];
  assert.deepEqual(config.dns.nameserver, plain);
  assert.deepEqual(config.dns["nameserver-policy"]["geosite:geolocation-!cn"], plain);
});

test("DNS：分组名含 & 时退回按规则出站，不生成错误地址", () => {
  const sub = fixture("subscription.yaml");
  const text = JSON.stringify(sub).split("🐟 漏网之鱼").join("Final & Co");
  const { config, logs } = runScript(withTun(JSON.parse(text)), { webrtc: "strict" });
  assert.deepEqual(config.dns.nameserver, googleECS(""));
  assert.ok(logs.some(([l, m]) => l === "warn" && /按分流规则出站/.test(m)));
  assert.ok(config.rules.includes(`${CN_STUN},Final & Co`));
});

test("merge.yaml 与 script.js 写入的 DNS 值一致（脚本额外固定代理组、保留订阅条目）", () => {
  const sub = fixture("subscription.yaml");
  sub.dns["enhanced-mode"] = "fake-ip";
  const merged = useMerge(MERGE, sub);
  const { config: scripted } = runScript(withTun(sub));
  const dropGroup = (v) => JSON.parse(JSON.stringify(v).split("#🐟 漏网之鱼&").join("#").split("#🐟 漏网之鱼\"").join("\""));
  for (const key of Object.keys(MERGE.dns)) {
    if (key === "fallback") continue;
    if (key === "nameserver-policy") {
      for (const k of Object.keys(MERGE.dns[key])) assert.deepEqual(MERGE.dns[key][k], dropGroup(scripted.dns[key][k]), `policy ${k} 不一致`);
      continue;
    }
    assert.deepEqual(merged.dns[key], dropGroup(scripted.dns[key]), `dns.${key} 不一致`);
  }
  assert.deepEqual(merged.dns.fallback, []);
  for (const key of ["sniffer", "geox-url", "profile", "tcp-concurrent", "geodata-loader", "geo-auto-update", "geo-update-interval"]) {
    assert.deepEqual(merged[key], scripted[key], `${key} 不一致`);
  }
  outputs["merge-only"] = merged;
});

test("WebRTC strict：国内 STUN 走代理，节点不支持 UDP 时兜底拦截；reject / off 可选", () => {
  const sub = withTun(fixture("subscription.yaml"));
  const { rules } = runScript(sub, { webrtc: "strict" }).config;
  assert.deepEqual(rules.slice(0, BYPASS.length + 2), leakHead("🐟 漏网之鱼"));
  assert.deepEqual(runScript(sub, { webrtc: "proxy" }).config.rules, rules); // 旧写法等同 strict
  const i = rules.indexOf(`${CN_STUN},🐟 漏网之鱼`);
  assert.equal(rules[i + 1], `${CN_STUN},REJECT`); // 代理组不支持 UDP 时接住
  assert.ok(rules.indexOf("MATCH,🐟 漏网之鱼") < rules.indexOf(TAIL[0])); // 兜底在 MATCH 之后
  const reject = runScript(sub, { webrtc: "reject" }).config.rules;
  assert.ok(reject.includes(`DST-PORT,${STUN},REJECT`));
  const off = runScript(sub, { webrtc: "off", blockDNSBypass: false, udpLeakGuard: false }).config.rules;
  assert.deepEqual(off, sub.rules);
});

test("出口不写死：跟随订阅兜底规则指向的分组，订阅改名自动跟上；proxyGroup 可手动指定", () => {
  const sub = fixture("subscription.yaml");
  const renamed = JSON.parse(JSON.stringify(sub).split("🐟 漏网之鱼").join("🌍 其他流量").split("🚀 节点选择").join("✈️ 机场线路"));
  const auto = runScript(withTun(renamed), { webrtc: "strict" }).config;
  assert.deepEqual(auto.dns.nameserver, googleECS("🌍 其他流量"));
  assert.ok(auto.rules.includes(`${CN_STUN},🌍 其他流量`));
  assert.ok(!JSON.stringify(auto.dns).includes("节点选择") && !JSON.stringify(auto.rules).includes("节点选择"));

  const manual = runScript(withTun(sub), { proxyGroup: "♻️ 自动选择", webrtc: "strict" }).config;
  assert.deepEqual(manual.dns.nameserver, googleECS("♻️ 自动选择"));
  assert.ok(manual.rules.includes(`${CN_STUN},♻️ 自动选择`));
  checkReferences(auto);
  checkReferences(manual);
});

test("兜底分组第一个选项是 DIRECT 时不当作代理出口", () => {
  const sub = fixture("subscription.yaml");
  sub["proxy-groups"].find((g) => g.name === "🐟 漏网之鱼").proxies = ["DIRECT", "🚀 节点选择"];
  const { config, logs } = runScript(withTun(sub), { webrtc: "strict" });
  assert.deepEqual(config.dns.nameserver, googleECS(""));
  assert.ok(config.rules.includes(`${CN_STUN},REJECT`));
  assert.ok(logs.some(([l, m]) => l === "warn" && /兜底规则不是代理分组/.test(m)));
});

test("WebRTC strict：兜底规则是直连时（白名单式订阅）拦截 STUN；重复运行不叠加；默认模式不拦", () => {
  const sub = fixture("subscription.yaml");
  sub.rules = ["DOMAIN-SUFFIX,google.com,🚀 节点选择", "MATCH,DIRECT"];
  const follow = runScript(withTun(sub)).config;
  assert.deepEqual(follow.rules, [...BYPASS, ...sub.rules, ...TAIL]);
  const once = runScript(withTun(sub), { webrtc: "strict" }).config;
  const guard = `AND,((DST-PORT,${STUN}),(NOT,((GEOIP,LAN,no-resolve)))),REJECT`;
  const m = once.rules.indexOf("MATCH,DIRECT");
  assert.equal(once.rules[m - 1], guard);
  assert.ok(once.rules.includes(`${CN_STUN},REJECT`));
  assert.ok(!once.rules.some((r) => r.startsWith(CN_STUN + ",") && !r.endsWith(",REJECT")));
  const twice = runScript(withTun(once), { webrtc: "strict" }).config;
  assert.deepEqual(twice.rules, once.rules);
  checkReferences(once);
  outputs["whitelist-match"] = once;

  // 兜底是代理分组时不插入
  const normal = runScript(withTun(fixture("subscription.yaml")), { webrtc: "strict" }).config;
  assert.ok(!normal.rules.some((r) => r.includes("GEOIP,LAN")));
});

test("extraRules 排在最前，重复运行不叠加规则", () => {
  const extra = "SRC-IP-CIDR,192.168.1.50/32,DIRECT";
  const once = runScript(withTun(fixture("subscription.yaml")), { extraRules: [extra] }).config;
  assert.equal(once.rules[0], extra);
  const twice = runScript(withTun(once), { extraRules: [extra] }).config;
  assert.deepEqual(twice.rules, once.rules);
});

test("lanDNS：局域网域名交给路由器，固定直连，且排在最前", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")), { lanDNS: "192.168.1.1" });
  const policy = config.dns["nameserver-policy"];
  assert.equal(Object.keys(policy)[0], "+.lan,+.local,+.localdomain,+.home.arpa");
  assert.deepEqual(policy["+.lan,+.local,+.localdomain,+.home.arpa"], ["192.168.1.1#DIRECT"]);
  assert.ok(!config.rules.some((r) => r.includes("192.168.1.1")));
  outputs["lan-dns"] = config;
});

test("未开启 TUN / 严格路由时给出提示", () => {
  const noTun = runScript(withTun(fixture("subscription.yaml"), false)).logs;
  assert.ok(noTun.some(([l, m]) => l === "warn" && /TUN/.test(m)));
  const strictOff = runScript(withTun(fixture("subscription.yaml"), true, { "strict-route": false }));
  assert.ok(strictOff.logs.some(([l, m]) => l === "warn" && /严格路由/.test(m)));
  assert.equal(strictOff.config.tun["strict-route"], false); // 设置页管理的值不去改

  // 设置页没有这个键（旧版本或从未保存过 TUN 设置）：脚本直接打开
  const unmanaged = runScript(withTun(fixture("subscription.yaml"), true, {}));
  assert.equal(unmanaged.config.tun["strict-route"], true);
  assert.ok(!unmanaged.logs.some(([l]) => l === "warn"));
});

test("proxy-providers 订阅：不过滤代理集合节点，出口跟随兜底规则", () => {
  const enhance = runScript(withTun(fixture("providers.yaml"))).config;
  assert.ok(runScript(withTun(fixture("providers.yaml")), { webrtc: "strict" }).config.rules.includes(`${CN_STUN},Proxy`));
  assert.ok(enhance.dns.nameserver[0].includes("#Proxy&"));
  assert.equal(enhance["proxy-providers"].airport["health-check"].url, "http://cp.cloudflare.com"); // 默认不改
  assert.equal(enhance["proxy-providers"].airport["exclude-filter"], undefined);
  checkReferences(enhance);
  outputs["providers-enhance"] = enhance;
});

test("没有任何节点、兜底是直连时不报错：境外 DNS 按规则出站", () => {
  const { config, logs } = runScript(withTun({ proxies: [], rules: ["MATCH,DIRECT"] }));
  assert.ok(config.rules.includes(TAIL[0]));
  assert.ok(runScript(withTun({ proxies: [], rules: ["MATCH,DIRECT"] }), { webrtc: "strict" }).config.rules.includes(`${CN_STUN},REJECT`));
  assert.deepEqual(config.dns.nameserver, googleECS(""));
  assert.ok(logs.some(([l]) => l === "warn"));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log("✔", name);
  } catch (err) {
    failed++;
    console.log("✘", name, "\n ", err.message);
  }
}

// Merge 只能覆盖、不能删除键：订阅自带的已废弃字段会留下一条不致命的报错，脚本会负责清理
const allowedErrors = { "merge-only": /global-client-fingerprint/ };

const mihomo = process.env.MIHOMO_BIN;
if (mihomo && !failed) {
  const geodata = process.env.GEODATA_DIR;
  for (const [name, config] of Object.entries(outputs)) {
    const dir = mkdtempSync(join(tmpdir(), "verge-" + name + "-"));
    if (geodata) {
      for (const [src, dst] of [["geosite.dat", "geosite.dat"], ["geoip.dat", "geoip.dat"], ["country.mmdb", "Country.mmdb"], ["Country.mmdb", "Country.mmdb"]]) {
        if (existsSync(join(geodata, src))) copyFileSync(join(geodata, src), join(dir, dst));
      }
    }
    mkdirSync(join(dir, "ruleset"), { recursive: true });
    writeFileSync(join(dir, "config.yaml"), yaml.dump(config, { lineWidth: -1 }));
    try {
      const out = execFileSync(mihomo, ["-t", "-d", dir, "-f", join(dir, "config.yaml")], { encoding: "utf8", stdio: "pipe" });
      const allowed = allowedErrors[name];
      const errors = out.split("\n").filter((l) => /level=(error|fatal)/.test(l) && !(allowed && allowed.test(l)));
      if (errors.length) throw new Error(errors.join("\n"));
      console.log("✔ mihomo -t", name);
    } catch (err) {
      failed++;
      console.log("✘ mihomo -t", name, "\n ", (err.stdout || "") + (err.stderr || "") || err.message);
    }
  }
} else if (!mihomo) {
  console.log("（未设置 MIHOMO_BIN，跳过内核校验）");
}

process.exit(failed ? 1 : 0);
