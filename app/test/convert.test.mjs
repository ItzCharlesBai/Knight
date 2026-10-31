// 订阅转换、sing-box 转换、搭配使用、多内核下载的单元测试
//   npm test
// 有 mihomo 内核时（npm run core）会用 mihomo -t 校验模板和搭配内核的配置；
// 有 sing-box 时（SINGBOX_BIN=/path/to/sing-box npm test）会用 sing-box check 校验转换结果
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import yaml from "js-yaml";
import { parseSubscription } from "../src/main/convert.js";
import { assetName, extractCore, untar } from "../src/main/core-download.js";
import { convert } from "../src/main/converter.js";
import { generate } from "../src/main/enhance.js";
import { toLinks } from "../src/main/links.js";
import { applyConvert, buildTemplate, processNodes, regionOf } from "../src/main/nodes.js";
import { Profiles } from "../src/main/profiles.js";
import { sidecarConfig, splitNodes } from "../src/main/sidecar.js";
import { fromOutbound, goRegex, toOutbound, toSingBox } from "../src/main/singbox.js";
import { DEFAULTS, mergePatch } from "../src/main/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const SCRIPT = readFileSync(join(repo, "clash-verge-rev", "script.js"), "utf8");
const SUB = yaml.load(readFileSync(join(repo, "test", "fixtures", "subscription.yaml"), "utf8"));
const settings = (patch = {}) => Object.assign(mergePatch(DEFAULTS, patch), { secret: "s3cret" });
const allSets = { ruleSetPath: (tag) => `/rs/${tag}.srs` };

const NAMES = ["🇭🇰 香港 01", "HK-02 IPLC", "台湾 03", "Japan Tokyo 04", "SG 05", "US 06", "RUS 07", "Bus 08", "美国 洛杉矶 09", "剩余流量 1G"];
const nodes = NAMES.map((name, i) => ({ name, type: "ss", server: `s${i}.example.com`, port: 8388, cipher: "aes-128-gcm", password: "p" }));

test("地区识别：中英文、国旗、代码不误伤（RUS / Bus 不算美国）", () => {
  const got = NAMES.map((n) => (regionOf(n) || {}).code || "-");
  assert.deepEqual(got, ["HK", "HK", "TW", "JP", "SG", "US", "-", "-", "US", "-"]);
  // 同一份正则交给 mihomo（Go）用时以 (?i) 开头
  assert.ok(goRegex("(?i)hk|港")[0].test("HK"));
});

test("节点处理：筛选、重命名、国旗、去重、排序、UDP / 证书", () => {
  const dup = Object.assign({}, nodes[0], { name: "重复" });
  const { proxies, renamed, removed } = processNodes(nodes.concat(dup), {
    exclude: "剩余|RUS",
    rename: "IPLC => 专线\n^(.*) 0(\\d)$ => $1-$2",
    emoji: true,
    dedupe: true,
    sort: "region",
    udp: true,
  });
  const names = proxies.map((p) => p.name);
  assert.ok(removed.has("剩余流量 1G") && removed.has("RUS 07") && removed.has("重复"));
  assert.equal(names[0], "🇭🇰 香港-1");
  assert.ok(names.includes("🇭🇰 HK-02 专线"));
  assert.equal(renamed.get("台湾 03"), "🇹🇼 台湾-3");
  assert.ok(names.indexOf("🇺🇸 US-6") > names.indexOf("🇸🇬 SG-5")); // 按地区排序
  assert.equal(names.at(-1), "Bus-8"); // 认不出地区的排最后，也不加国旗
  assert.ok(proxies.every((p) => p.udp === true));
  assert.throws(() => processNodes(nodes, { include: "(" }), /正则写错了/);
});

test("模板：按地区 / 全面分流生成分组，空地区不建组；保持原样时同步改名", () => {
  const region = buildTemplate("region", NAMES);
  const groups = region["proxy-groups"].map((g) => g.name);
  assert.deepEqual(groups, ["节点选择", "自动选择", "香港", "台湾", "日本", "新加坡", "美国", "其他地区"]);
  assert.deepEqual(region["proxy-groups"].find((g) => g.name === "香港").proxies, ["🇭🇰 香港 01", "HK-02 IPLC"]);
  assert.equal(region.rules.at(-1), "MATCH,节点选择");
  const full = buildTemplate("full", NAMES);
  assert.equal(full["proxy-groups"].find((g) => g.name === "AI 服务").proxies[0], "美国");
  assert.equal(full.rules.at(-1), "MATCH,漏网之鱼");
  // 代理集合：节点名未知时用 use + filter
  const prov = buildTemplate("region", [], ["airport"], ["HK 01", "JP 01"]);
  const hk = prov["proxy-groups"].find((g) => g.name === "香港");
  assert.deepEqual(hk.use, ["airport"]);
  assert.match(hk.filter, /^\(\?i\)/);

  const kept = applyConvert(SUB, { template: "keep", exclude: "台湾", rename: "香港 => HK" });
  const select = kept["proxy-groups"].find((g) => g.name === "🚀 节点选择").proxies;
  assert.ok(select.includes("🇭🇰 HK 01") && !select.some((n) => n.includes("台湾")));
  assert.deepEqual(kept.rules, SUB.rules);
});

test("分享链接：导出后能再导入，字段一致", () => {
  const sub = parseSubscription(
    [
      "vless://0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3@jp.example.com:443?security=reality&pbk=KEY&sid=ab&sni=www.apple.com&flow=xtls-rprx-vision&fp=chrome&type=grpc&serviceName=gs#JP",
      "trojan://pw@hk.example.com:443?sni=hk.example.com&type=ws&path=%2Fws&host=cdn.example.com#TJ",
      "hysteria2://pw@sg.example.com:443?sni=sg.example.com&insecure=1&obfs=salamander&obfs-password=o#SG",
      "anytls://pw@a.example.com:443?sni=a.example.com#AT",
      "naive+https://u:p@n.example.com:443#NV",
      "hysteria://h.example.com:443?protocol=udp&auth=a&peer=h.example.com&upmbps=50&downmbps=100#HY",
      "wireguard://cHJpdmF0ZQ%3D%3D@w.example.com:51820?publickey=cHVibGlj&address=10.0.0.2/32,fd00::2/128&mtu=1420#WG",
    ].join("\n")
  ).config.proxies;
  assert.deepEqual(sub.map((p) => p.type), ["vless", "trojan", "hysteria2", "anytls", "naive", "hysteria", "wireguard"]);
  const { text, skipped } = toLinks(sub, { base64: true });
  assert.deepEqual(skipped, ["WG"]); // WireGuard 没有通用的分享链接格式
  const again = parseSubscription(text).config.proxies;
  const pick = (p) => JSON.stringify([p.type, p.server, p.port, p.uuid || p.password || p.username, p.sni || p.servername, p.network]);
  assert.deepEqual(again.map(pick), sub.filter((p) => p.type !== "wireguard").map(pick));
  assert.equal(again[0]["reality-opts"]["public-key"], "KEY");
  assert.equal(again[0]["grpc-opts"]["grpc-service-name"], "gs");
});

test("sing-box 节点：TLS / Reality / 传输方式 / 插件；不支持的给出原因；能反向导入", () => {
  const vless = toOutbound({ name: "R", type: "vless", server: "a", port: 443, uuid: "u", tls: true, servername: "s", "reality-opts": { "public-key": "K", "short-id": "1" }, network: "grpc", "grpc-opts": { "grpc-service-name": "g" } }).outbound;
  assert.deepEqual(vless.tls, { enabled: true, server_name: "s", reality: { enabled: true, public_key: "K", short_id: "1" }, utls: { enabled: true, fingerprint: "chrome" } });
  assert.deepEqual(vless.transport, { type: "grpc", service_name: "g" });
  const ws = toOutbound({ name: "W", type: "vmess", server: "a", port: 443, uuid: "u", cipher: "auto", network: "ws", "ws-opts": { path: "/x", headers: { Host: "h" }, "v2ray-http-upgrade": true } }).outbound;
  assert.deepEqual(JSON.parse(JSON.stringify(ws.transport)), { type: "httpupgrade", path: "/x", host: "h" });
  const obfs = toOutbound({ name: "O", type: "ss", server: "a", port: 1, cipher: "aes-128-gcm", password: "p", plugin: "obfs", "plugin-opts": { mode: "tls", host: "b.com" }, udp: false }).outbound;
  assert.equal(obfs.plugin_opts, "obfs=tls;obfs-host=b.com");
  assert.equal(obfs.network, "tcp");
  assert.match(toOutbound({ name: "S", type: "ssr", server: "a", port: 1 }).error, /ssr/);
  assert.match(toOutbound({ name: "X", type: "vless", server: "a", port: 1, uuid: "u", network: "xhttp" }).error, /xhttp/);
  const wg = toOutbound({ name: "WG", type: "wireguard", server: "w", port: 51820, ip: "10.0.0.2", "private-key": "k", "public-key": "p" });
  assert.deepEqual(wg.endpoint.address, ["10.0.0.2/32"]);
  assert.equal(fromOutbound(vless)["reality-opts"]["public-key"], "K");
  const json = JSON.stringify({ outbounds: [vless, ws, { type: "direct", tag: "direct" }] });
  assert.equal(parseSubscription(json).format, "singbox");
  assert.equal(parseSubscription(json).config.proxies.length, 2);
});

test("sing-box 配置：防泄露规则逐条转换，DNS 按设置生成，出口跟随兜底规则", () => {
  const r = generate({ profile: SUB, settings: settings({ core: "sing-box", tun: { enable: true }, leakGuard: { webrtc: "strict" } }), scriptSource: SCRIPT, core: { id: "sing-box", kind: "singbox" }, singbox: allSets });
  assert.equal(r.kind, "singbox");
  const c = JSON.parse(r.text);
  const rules = c.route.rules;
  assert.deepEqual(rules.slice(0, 2), [{ action: "sniff" }, { protocol: "dns", action: "hijack-dns" }]);
  // 加密 DNS 拦截、STUN 走代理（逻辑规则）、境外域名经代理解析
  assert.ok(rules.some((x) => x.domain && x.domain[0] === "dns.alidns.com" && x.action === "reject"));
  const stun = rules.find((x) => x.type === "logical" && x.outbound === "🐟 漏网之鱼");
  assert.deepEqual(stun.rules[0], { port_range: ["3478:3479", "5349:5350", "19302:19309"] });
  assert.deepEqual(stun.rules[1].rules.map((x) => x.rule_set[0]), ["geosite-cn", "geoip-cn"]);
  assert.equal(c.route.final, "🐟 漏网之鱼");
  assert.equal(c.dns.servers.find((x) => x.tag === "dns-remote").detour, "🐟 漏网之鱼");
  assert.equal(c.dns.client_subnet, "223.5.5.0/24");
  assert.ok(c.dns.servers.some((x) => x.type === "fakeip"));
  // GEOIP,CN 没有 no-resolve：前面要先 resolve
  const geoip = rules.findIndex((x) => x.rule_set && x.rule_set[0] === "geoip-cn" && !x.type);
  assert.ok(rules.slice(0, geoip).some((x) => x.action === "resolve"));
  // 信息节点被脚本删掉，只含信息节点的分组变成 REJECT 占位，sing-box 下整组去掉
  assert.ok(!c.outbounds.some((o) => o.tag === "📢 订阅信息"));
  assert.ok(c.outbounds.some((o) => o.tag === "GLOBAL" && o.type === "selector"));
  assert.equal(c.experimental.clash_api.secret, "s3cret");
  assert.equal(c.inbounds[1].type, "tun");
  assert.equal(c.inbounds[1].strict_route, true);
  assert.deepEqual(r.ruleSets.sort(), ["geoip-cn", "geosite-cn"]);
  // 规则集还没下载时相关规则跳过，并提示
  const none = generate({ profile: SUB, settings: settings({ core: "sing-box" }), scriptSource: SCRIPT, core: { id: "sing-box", kind: "singbox" }, singbox: { ruleSetPath: () => "" } });
  assert.ok(none.logs.some((l) => /缺少规则集/.test(l.message)));
});

test("sing-box：IPv6 策略、关闭防泄露、规则集合与代理集合的转换", () => {
  const off = toSingBox(SUB, settings({ ipv6: false, leakGuard: { enabled: false } }), allSets).config;
  assert.equal(off.dns.strategy, "ipv4_only");
  assert.equal(off.dns.servers.find((x) => x.tag === "dns-remote").detour, undefined);
  assert.deepEqual(off.dns.rules[0], { query_type: ["AAAA"], action: "predefined" });
  const providers = {
    "proxy-providers": { air: { type: "http", url: "https://x", path: "./a.yaml", filter: "港|日" } },
    "rule-providers": {
      ai: { type: "http", behavior: "classical", url: "https://y", path: "./ai.yaml" },
      bad: { type: "http", behavior: "domain", format: "mrs", url: "https://z", path: "./b.mrs" },
    },
    "proxy-groups": [{ name: "P", type: "select", use: ["air"] }],
    rules: ["RULE-SET,ai,P", "RULE-SET,bad,P", "IP-ASN,13335,P", "MATCH,P"],
  };
  const r = toSingBox(providers, settings(), {
    ruleSetPath: allSets.ruleSetPath,
    providers: {
      proxy: { air: yaml.dump({ proxies: [{ name: "港 1", type: "ss", server: "a", port: 1, cipher: "aes-128-gcm", password: "p" }, { name: "美 2", type: "ss", server: "b", port: 1, cipher: "aes-128-gcm", password: "p" }] }) },
      rule: { ai: "payload:\n  - DOMAIN-SUFFIX,openai.com\n  - IP-CIDR,1.2.3.0/24\n" },
    },
  });
  const p = r.config.outbounds.find((o) => o.tag === "P");
  assert.deepEqual(p.outbounds, ["港 1"]);
  const inline = r.config.route.rule_set.find((x) => x.tag === "rp-ai");
  assert.deepEqual(inline.rules, [{ domain_suffix: ["openai.com"] }, { ip_cidr: ["1.2.3.0/24"] }]);
  assert.ok(r.logs.some((l) => /mrs/.test(l.message)));
  assert.ok(r.logs.some((l) => /不支持，已跳过/.test(l.message)));
});

test("搭配使用：主内核不支持的节点交给另一个内核，换成本地 SOCKS 入口", () => {
  const profile = parseSubscription("naive+https://u:p@n.example.com:443#NV\ntrojan://pw@t.example.com:443#TJ").config;
  // mihomo 主内核 + sing-box 搭配
  const r = generate({ profile, settings: settings({ sidecarPort: 7930 }), scriptSource: SCRIPT, core: { id: "mihomo", kind: "clash" }, sidecar: { kind: "singbox", bin: "/opt/sb/sing-box" } });
  const nv = r.config.proxies.find((p) => p.name === "NV");
  assert.deepEqual(nv, { name: "NV", type: "socks5", server: "127.0.0.1", port: 7930, udp: true });
  assert.equal(r.config.rules[0], "PROCESS-PATH,/opt/sb/sing-box,DIRECT");
  assert.equal(r.config["find-process-mode"], "strict");
  const side = JSON.parse(r.sidecar.text);
  assert.equal(side.outbounds[0].type, "naive");
  assert.deepEqual(side.route.rules, [{ inbound: ["in-0"], outbound: "NV" }]);
  // 没有可搭配的内核：去掉节点，分组里的引用也去掉
  const alone = generate({ profile, settings: settings(), scriptSource: SCRIPT, core: { id: "mihomo", kind: "clash" } });
  assert.ok(!alone.config.proxies.some((p) => p.name === "NV"));
  assert.ok(!JSON.stringify(alone.config["proxy-groups"]).includes('"NV"'));
  assert.ok(alone.logs.some((l) => /不支持，已跳过/.test(l.message)));
  // sing-box 主内核 + mihomo 搭配跑 SSR
  const ssr = { proxies: [{ name: "SSR", type: "ssr", server: "s", port: 1, cipher: "aes-256-cfb", password: "p", protocol: "origin", obfs: "plain" }], "proxy-groups": [{ name: "G", type: "select", proxies: ["SSR"] }], rules: ["MATCH,G"] };
  const split = splitNodes(ssr, "singbox", { sidecarKind: "clash", basePort: 7897, reserved: [7897] });
  assert.equal(split.entries[0].port, 7898); // 跳过已占用的端口
  const sb = generate({ profile: ssr, settings: settings({ core: "sing-box" }), scriptSource: SCRIPT, core: { id: "sing-box", kind: "singbox" }, sidecar: { kind: "clash", bin: "/opt/m/mihomo" }, singbox: allSets });
  const c = JSON.parse(sb.text);
  assert.deepEqual(c.outbounds.find((o) => o.tag === "SSR"), { type: "socks", tag: "SSR", server: "127.0.0.1", server_port: 7920, version: "5" });
  assert.ok(c.route.rules.some((x) => x.process_path && x.process_path[0] === "/opt/m/mihomo"));
  assert.match(sb.sidecar.text, /listeners:/);
});

test("订阅转换页：多来源合并、模板、各种输出格式", () => {
  const parts = [
    { label: "A", config: { proxies: nodes.slice(0, 3) } },
    { label: "B", config: { proxies: [nodes[0], nodes[4]] } },
  ];
  const clash = convert(parts, { options: { template: "region" }, target: "clash", leakGuard: true, scriptSource: SCRIPT });
  const doc = yaml.load(clash.text);
  assert.equal(clash.count, 5);
  assert.ok(doc.proxies.some((p) => p.name === "🇭🇰 香港 01 · B")); // 重名加来源
  assert.ok(doc.rules[0].startsWith("DOMAIN,dns.alidns.com")); // 带上了防泄露规则
  assert.deepEqual(clash.regions[0], ["🇭🇰 香港", 3]);
  const sb = JSON.parse(convert(parts, { options: { template: "full" }, target: "singbox" }).text);
  assert.ok(sb.route.rule_set.every((r) => r.type === "remote" && r.url.startsWith("https://")));
  assert.deepEqual(sb.http_clients, [{ tag: "rule-set" }]);
  const links = convert(parts, { target: "links" });
  assert.equal(links.text.split("\n").length, 5);
  assert.equal(yaml.load(convert(parts, { target: "proxies" }).text).proxies.length, 5);
  assert.equal(convert(parts, { options: { dedupe: true }, target: "proxies" }).count, 4); // 去重后同一台服务器只留一个
});

test("组合订阅：多个来源合成一份，更新时重新拉取；转换选项随订阅保存", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knight-combo-"));
  const bodies = { "https://a/1": yaml.dump({ proxies: nodes.slice(0, 2) }), "https://b/2": Buffer.from(["trojan://pw@x.example.com:443#TJ"].join("\n")).toString("base64") };
  const profiles = new Profiles(dir, async (url) => new Response(bodies[url], { headers: { "subscription-userinfo": "upload=1; download=2; total=3" } }));
  const local = profiles.import({ name: "local.yaml", text: yaml.dump({ proxies: [nodes[5]] }) });
  const combo = await profiles.addCombo({ name: "合集", sources: [{ type: "url", url: "https://a/1" }, { type: "url", url: "https://b/2" }, { type: "profile", id: local.id }] });
  assert.equal(combo.nodes, 4);
  assert.deepEqual(combo.userinfo, { upload: 1, download: 2, total: 3 });
  const loaded = profiles.load(combo.id);
  assert.ok(loaded["proxy-groups"].some((g) => g.name === "美国")); // 组合订阅默认按地区分组
  profiles.edit(combo.id, { convert: { template: "simple", exclude: "TJ" } });
  assert.equal(profiles.load(combo.id).proxies.length, 3);
  assert.ok(profiles.load(combo.id) === profiles.load(combo.id)); // 解析结果有缓存
  assert.throws(() => profiles.edit(combo.id, { convert: { include: "[" } }), /正则/);
  bodies["https://a/1"] = yaml.dump({ proxies: nodes.slice(0, 1) });
  await profiles.update(combo.id);
  assert.equal(profiles.get(combo.id).nodes, 3);
});

test("内核下载：sing-box 的文件名与 tar.gz 解压（带动态库）", () => {
  assert.equal(assetName("v1.14.4", "linux", "x64", "sing-box"), "sing-box-1.14.4-linux-amd64.tar.gz");
  assert.equal(assetName("v1.14.4", "win32", "arm64", "sing-box"), "sing-box-1.14.4-windows-arm64.zip");
  assert.equal(assetName("alpha-smart-77af480", "darwin", "arm64", "mihomo-smart"), "mihomo-darwin-arm64-alpha-smart-77af480.gz");
  const entry = (name, body) => {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("0", 156);
    h.write("ustar\0", 257);
    return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  };
  const tar = Buffer.concat([entry("sing-box-1.14.4-linux-amd64/LICENSE", Buffer.from("MIT")), entry("sing-box-1.14.4-linux-amd64/sing-box", Buffer.from("ELF")), entry("sing-box-1.14.4-linux-amd64/libcronet.so", Buffer.from("SO")), Buffer.alloc(1024)]);
  assert.equal(untar(tar).length, 3);
  const files = extractCore(zlib.gzipSync(tar), "sing-box-1.14.4-linux-amd64.tar.gz", "sing-box");
  assert.deepEqual(files.map((f) => [f.name, f.data.toString()]), [["sing-box", "ELF"], ["libcronet.so", "SO"]]);
});

// ---------------- 用真实内核校验 ----------------
const mihomo = join(here, "..", "resources", "core", `${{ win32: "win", darwin: "mac", linux: "linux" }[process.platform]}-${process.arch}`, process.platform === "win32" ? "mihomo.exe" : "mihomo");
test("mihomo -t：按地区 / 全面分流模板、搭配内核（mihomo 作 SOCKS 入口）", { skip: !existsSync(mihomo) && "没有内核（npm run core 下载）" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "knight-tpl-"));
  const geo = process.env.GEODATA_DIR || join(here, "..", "resources", "geo");
  for (const f of ["geosite.dat", "geoip.dat", "country.mmdb"]) if (existsSync(join(geo, f))) copyFileSync(join(geo, f), join(dir, f));
  const check = (name, text) => {
    const file = join(dir, name);
    writeFileSync(file, text);
    const out = execFileSync(mihomo, ["-t", "-d", dir, "-f", file], { encoding: "utf8", timeout: 120000 });
    assert.match(out, /test is successful/, name + "\n" + out);
  };
  for (const template of ["region", "full"]) {
    const r = generate({ profile: applyConvert({ proxies: nodes }, { template, emoji: true }), settings: settings({ tun: { enable: true } }), scriptSource: SCRIPT });
    check(template + ".yaml", r.text);
  }
  const ssr = [{ name: "SSR", type: "ssr", server: "s.example.com", port: 1, cipher: "aes-256-cfb", password: "p", protocol: "origin", obfs: "plain" }];
  check("sidecar.yaml", sidecarConfig("clash", [{ node: ssr[0], port: 7931 }]));
});

const singbox = process.env.SINGBOX_BIN;
test("sing-box check：转换出的配置", { skip: !singbox && "未设置 SINGBOX_BIN" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "knight-sb-"));
  const check = (name, text) => {
    const file = join(dir, name);
    writeFileSync(file, text);
    execFileSync(singbox, ["check", "-c", file, "-D", dir], { encoding: "utf8", timeout: 60000 });
  };
  const remote = { ruleSetUrl: (t) => `https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/${t.split("-")[0]}/${t.split("-").slice(1).join("-")}.srs` };
  check("leak.json", JSON.stringify(toSingBox(generate({ profile: SUB, settings: settings({ tun: { enable: true } }), scriptSource: SCRIPT }).config, settings({ tun: { enable: true } }), remote).config));
  check("full.json", convert([{ label: "A", config: { proxies: nodes } }], { options: { template: "full" }, target: "singbox", leakGuard: true, scriptSource: SCRIPT }).text);
  check("sidecar.json", sidecarConfig("singbox", [{ node: { name: "NV", type: "naive", server: "n.example.com", port: 443, username: "u", password: "p" }, port: 7932 }]));
});
