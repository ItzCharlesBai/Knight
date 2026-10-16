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
  "IP-CIDR,223.5.5.5/32,REJECT,no-resolve",
  "IP-CIDR,223.6.6.6/32,REJECT,no-resolve",
  "IP-CIDR,1.12.12.12/32,REJECT,no-resolve",
  "IP-CIDR,120.53.53.53/32,REJECT,no-resolve",
  "IP-CIDR6,2400:3200::1/128,REJECT,no-resolve",
  "IP-CIDR6,2400:3200:baba::1/128,REJECT,no-resolve",
  "DST-PORT,853,REJECT",
];
const leakHead = (t) => [
  ...BYPASS,
  `DST-PORT,3478-3479,${t}`,
  `DST-PORT,5349-5350,${t}`,
  `DST-PORT,19302-19309,${t}`,
  "AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn)))),REJECT",
];
const ECS = "ecs=223.5.5.0/24&ecs-override=true";

const outputs = {};
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("enhance：只在最前面加防泄露规则，订阅自己的分流原样保留", () => {
  const sub = fixture("subscription.yaml");
  const { config, logs } = runScript(withTun(useMerge(MERGE, sub)));
  const head = leakHead("🚀 节点选择");
  assert.deepEqual(config.rules.slice(0, head.length), head);
  assert.deepEqual(config.rules.slice(head.length), sub.rules);
  // 不再为 DNS 服务器添加改变分流的 IP 规则
  assert.ok(!config.rules.some((r) => /^IP-CIDR,(1\.1\.1\.1|8\.8\.8\.8)\//.test(r)));
  assert.equal(logs.filter(([l]) => l === "warn").length, 0);
  checkReferences(config);
  outputs["enhance"] = config;
});

test("enhance：清理信息节点、补 UDP 与 TLS 指纹、调整测速", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")));
  const names = config.proxies.map((p) => p.name);
  assert.ok(!names.some((n) => /剩余|到期/.test(n)));
  const byName = Object.fromEntries(config.proxies.map((p) => [p.name, p]));
  assert.equal(byName["🇷🇺 RUS 01"].udp, true);
  assert.equal(byName["🇭🇰 香港 01"].udp, true);
  assert.equal(byName["🇭🇰 HK02 IPLC"]["client-fingerprint"], "chrome");
  assert.equal(byName["🇹🇼 台湾 01"]["client-fingerprint"], "chrome");
  assert.equal(byName["🇯🇵 日本 东京 01"]["client-fingerprint"], "chrome");
  assert.equal(byName["🇭🇰 香港 01"]["client-fingerprint"], undefined);
  assert.equal(byName["🇸🇬 SG 01"]["client-fingerprint"], undefined);
  assert.equal(config["global-client-fingerprint"], undefined);

  const groups = Object.fromEntries(config["proxy-groups"].map((g) => [g.name, g]));
  assert.deepEqual(groups["📢 订阅信息"].proxies, ["REJECT"]);
  assert.ok(!groups["♻️ 自动选择"].proxies.includes("剩余流量：120.5 GB"));
  assert.equal(groups["♻️ 自动选择"].url, "https://www.gstatic.com/generate_204");
  assert.equal(groups["♻️ 自动选择"].interval, 300);
  assert.equal(groups["♻️ 自动选择"].tolerance, 50);
  checkReferences(config);
});

test("DNS：国内固定直连，境外固定走代理组，未收录域名带 ECS", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")));
  const dns = config.dns;
  assert.equal(dns["enhanced-mode"], "fake-ip");
  assert.equal(dns["respect-rules"], true);
  assert.equal(dns.ipv6, false);
  assert.equal(dns.listen, "0.0.0.0:1053");
  assert.equal(dns.fallback, undefined);
  assert.equal(dns["fallback-filter"], undefined);
  assert.deepEqual(dns.nameserver, [
    `https://8.8.8.8/dns-query#🚀 节点选择&${ECS}`,
    `https://8.8.4.4/dns-query#🚀 节点选择&${ECS}`,
  ]);
  assert.deepEqual(dns["nameserver-policy"], {
    "geosite:cn,private": ["https://223.5.5.5/dns-query#DIRECT", "https://1.12.12.12/dns-query#DIRECT"],
    "geosite:geolocation-!cn": ["https://1.1.1.1/dns-query#🚀 节点选择", "https://8.8.8.8/dns-query#🚀 节点选择"],
  });
  assert.deepEqual(dns["direct-nameserver"], dns["nameserver-policy"]["geosite:cn,private"]);
});

test("DNS：关闭 ECS 时未收录域名改用 Cloudflare/Google", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")), { dnsECS: "" });
  assert.deepEqual(config.dns.nameserver, ["https://1.1.1.1/dns-query#🚀 节点选择", "https://8.8.8.8/dns-query#🚀 节点选择"]);
});

test("DNS：分组名含 & 时退回按规则出站，不生成错误地址", () => {
  const sub = fixture("subscription.yaml");
  const text = JSON.stringify(sub).split("🚀 节点选择").join("Proxy & Co");
  const { config, logs } = runScript(withTun(JSON.parse(text)));
  assert.deepEqual(config.dns.nameserver, [`https://8.8.8.8/dns-query#${ECS}`, `https://8.8.4.4/dns-query#${ECS}`]);
  assert.ok(logs.some(([l, m]) => l === "warn" && /按规则出站/.test(m)));
  assert.ok(config.rules.includes("DST-PORT,3478-3479,Proxy & Co"));
});

test("merge.yaml 与 script.js 写入的值一致（脚本额外固定了代理组）", () => {
  const sub = fixture("subscription.yaml");
  const merged = useMerge(MERGE, sub);
  const { config: scripted } = runScript(withTun(sub));
  const dropGroup = (v) => JSON.parse(JSON.stringify(v).split("#🚀 节点选择&").join("#").split("#🚀 节点选择\"").join("\""));
  for (const key of Object.keys(scripted.dns)) {
    if (key === "listen") continue;
    assert.deepEqual(merged.dns[key], dropGroup(scripted.dns[key]), `dns.${key} 不一致`);
  }
  assert.deepEqual(merged.dns.fallback, []);
  for (const key of ["sniffer", "geox-url", "profile", "tcp-concurrent", "geodata-loader", "geo-auto-update", "geo-update-interval"]) {
    assert.deepEqual(merged[key], scripted[key], `${key} 不一致`);
  }
  outputs["merge-only"] = merged;
});

test("WebRTC / 加密 DNS 拦截可以分别关闭", () => {
  const sub = withTun(fixture("subscription.yaml"));
  const reject = runScript(sub, { webrtc: "reject" }).config.rules;
  assert.ok(reject.includes("DST-PORT,3478-3479,REJECT"));
  const off = runScript(sub, { webrtc: "off", blockQUIC: false, blockDNSBypass: false }).config.rules;
  assert.deepEqual(off, sub.rules);
});

test("extraRules 排在最前，重复运行不叠加规则", () => {
  const extra = "SRC-IP-CIDR,192.168.1.50/32,DIRECT";
  const once = runScript(withTun(fixture("subscription.yaml")), { extraRules: [extra] }).config;
  assert.equal(once.rules[0], extra);
  const twice = runScript(withTun(once), { extraRules: [extra] }).config;
  assert.deepEqual(twice.rules, once.rules);
});

test("lanDNS：局域网域名交给路由器，固定直连，且排在 geosite 之前", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")), { lanDNS: "192.168.1.1" });
  const policy = config.dns["nameserver-policy"];
  assert.deepEqual(Object.keys(policy), ["+.lan,+.local,+.localdomain,+.home.arpa", "geosite:cn,private", "geosite:geolocation-!cn"]);
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

test("full：按节点生成地区组与服务分流", () => {
  const { config } = runScript(withTun(fixture("subscription.yaml")), { mode: "full" });
  const groups = Object.fromEntries(config["proxy-groups"].map((g) => [g.name, g]));
  for (const r of ["🇭🇰 香港节点", "🇹🇼 台湾节点", "🇯🇵 日本节点", "🇸🇬 新加坡节点", "🇺🇸 美国节点"]) assert.ok(groups[r], r);

  const members = (g) => config.proxies.map((p) => p.name).filter((n) => new RegExp(g.filter).test(n));
  assert.deepEqual(members(groups["🇭🇰 香港节点"]), ["🇭🇰 香港 01", "🇭🇰 HK02 IPLC"]);
  assert.deepEqual(members(groups["🇺🇸 美国节点"]), ["🇺🇸 美国 洛杉矶 01"]);
  assert.deepEqual(groups["🤖 AI 服务"].proxies.slice(0, 4), ["🇺🇸 美国节点", "🇯🇵 日本节点", "🇸🇬 新加坡节点", "🇹🇼 台湾节点"]);
  assert.ok(!groups["🤖 AI 服务"].proxies.includes("🇭🇰 香港节点"));
  assert.equal(groups["🇭🇰 香港节点"]["empty-fallback"], "REJECT");

  const idx = (p) => config.rules.findIndex((r) => r.startsWith(p));
  assert.ok(idx("RULE-SET,geosite-github,") < idx("RULE-SET,geosite-microsoft,"));
  assert.ok(idx("RULE-SET,geosite-youtube,") < idx("RULE-SET,geosite-google,"));
  assert.equal(config.rules[config.rules.length - 1], "MATCH,🐟 漏网之鱼");
  assert.deepEqual(config.rules.slice(0, leakHead("🚀 节点选择").length), leakHead("🚀 节点选择"));
  assert.ok(config.dns.nameserver[0].includes("#🚀 节点选择&"));
  checkReferences(config);
  outputs["full"] = config;
});

test("proxy-providers 订阅：enhance 识别 Proxy 组，full 建出全部地区组", () => {
  const enhance = runScript(withTun(fixture("providers.yaml"))).config;
  assert.ok(enhance.rules.includes("DST-PORT,3478-3479,Proxy"));
  assert.ok(enhance.dns.nameserver[0].includes("#Proxy&"));
  assert.equal(enhance["proxy-providers"].airport["health-check"].url, "https://www.gstatic.com/generate_204");
  assert.ok(new RegExp(enhance["proxy-providers"].airport["exclude-filter"]).test("剩余流量：1 GB"));
  checkReferences(enhance);
  outputs["providers-enhance"] = enhance;

  const full = runScript(withTun(fixture("providers.yaml")), { mode: "full" }).config;
  assert.equal(full["proxy-groups"].filter((g) => g.filter).length, 5);
  checkReferences(full);
  outputs["providers-full"] = full;
});

test("没有任何节点时不报错，WebRTC 直接拦截，境外 DNS 按规则出站", () => {
  const { config, logs } = runScript(withTun({ proxies: [], rules: ["MATCH,DIRECT"] }), { mode: "full" });
  assert.ok(config.rules.includes("DST-PORT,3478-3479,REJECT"));
  assert.deepEqual(config.dns.nameserver, [`https://8.8.8.8/dns-query#${ECS}`, `https://8.8.4.4/dns-query#${ECS}`]);
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
