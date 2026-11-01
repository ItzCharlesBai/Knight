// 主进程模块的单元测试：配置生成（含仓库的 script.js）、订阅解析、设置、zip 解压
//   npm test
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import yaml from "js-yaml";
import { assetName, unzipFirst } from "../src/main/core-download.js";
import { compareVersion, cleanLog } from "../src/main/core.js";
import { filenameFromDisposition, parseSubscription, parseUserinfo } from "../src/main/convert.js";
import { generate, useMerge } from "../src/main/enhance.js";
import { Profiles } from "../src/main/profiles.js";
import { DEFAULTS, mergePatch, Store } from "../src/main/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const SCRIPT = readFileSync(join(repo, "clash-verge-rev", "script.js"), "utf8");
const MERGE = readFileSync(join(repo, "clash-verge-rev", "merge.yaml"), "utf8");
const SUB = yaml.load(readFileSync(join(repo, "test", "fixtures", "subscription.yaml"), "utf8"));
const settings = (patch = {}) => Object.assign(mergePatch(DEFAULTS, patch), { secret: "s3cret" });
const run = (patch, profile = SUB) => generate({ profile, settings: settings(patch), scriptSource: SCRIPT, mergeSource: MERGE, profileName: "test" });

test("应用设置覆盖订阅的端口、控制接口和 TUN", () => {
  const { config } = run({ mixedPort: 7000, tun: { enable: true, strictRoute: false } });
  assert.equal(config["mixed-port"], 7000);
  assert.equal(config.port, undefined);
  assert.equal(config["external-controller"], "127.0.0.1:9097");
  assert.equal(config.secret, "s3cret");
  assert.equal(config.tun.enable, true);
  assert.equal(config.tun["strict-route"], false); // 由设置决定，脚本不会改
  assert.equal(config.mode, "rule");
});

test("默认启用仓库里的防泄露脚本：DNS 改写、加密 DNS 拦截、UDP 兜底", () => {
  const { config, logs } = run({ tun: { enable: true } });
  assert.equal(config.rules[0], "DOMAIN,dns.alidns.com,REJECT");
  assert.ok(config.rules.includes("MATCH,🐟 漏网之鱼"));
  assert.equal(config.rules.at(-1), "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT");
  assert.equal(config.dns["enhanced-mode"], "fake-ip");
  assert.equal(config.dns.fallback, undefined);
  assert.ok(config.dns.nameserver[0].includes("#🐟 漏网之鱼&"));
  assert.ok(!config.proxies.some((p) => /剩余|到期/.test(p.name)));
  assert.ok(!logs.some((l) => l.level === "warn"), JSON.stringify(logs)); // TUN + 严格路由都开着，没有警告
  assert.ok(logs.some((l) => /redir-host/.test(l.message)));
});

test("脚本参数从设置传入；dnsIPv6 的 all / off 对应脚本的 true / false", () => {
  const strict = run({ leakGuard: { webrtc: "strict", dnsIPv6: "off" } }).config;
  assert.ok(strict.rules.some((r) => r.startsWith("AND,((DST-PORT,3478") && r.endsWith(",🐟 漏网之鱼")));
  assert.equal(strict.dns.ipv6, false);
  const all = run({ leakGuard: { dnsIPv6: "all" } }).config;
  assert.equal(all.dns["fake-ip-range6"], "2001:2::0/64");
  const manual = run({ leakGuard: { proxyGroup: "♻️ 自动选择" } }).config;
  assert.ok(manual.dns.nameserver[0].includes("#♻️ 自动选择&"));
});

test("未开 TUN 时脚本的提醒会出现在日志里", () => {
  const { logs } = run({});
  assert.ok(logs.some((l) => l.level === "warn" && /TUN/.test(l.message)));
});

test("关闭防泄露：订阅规则原样；TUN 开着且订阅没有 DNS 时补最简 DNS", () => {
  const profile = Object.assign({}, SUB);
  delete profile.dns;
  const { config } = run({ leakGuard: { enabled: false }, tun: { enable: true } }, profile);
  assert.deepEqual(config.rules, SUB.rules);
  assert.equal(config.dns.enable, true);
  assert.equal(config.dns["enhanced-mode"], "fake-ip");
});

test("自定义规则排在最前且不重复；自定义脚本在防泄露之后执行", () => {
  const once = run({
    customRules: ["DOMAIN-SUFFIX,example.com,DIRECT"],
    customScript: { enabled: true, code: "function main(c){ c['log-level']='debug'; c.rules.push('DOMAIN,x.test,REJECT'); console.log('hi'); return c; }" },
  });
  assert.equal(once.config.rules[0], "DOMAIN-SUFFIX,example.com,DIRECT");
  assert.equal(once.config.rules.filter((r) => r === "DOMAIN-SUFFIX,example.com,DIRECT").length, 1);
  assert.ok(once.config.rules.includes("DOMAIN,x.test,REJECT"));
  assert.equal(once.config["log-level"], "info"); // 应用管理的字段会被回写
  assert.ok(once.logs.some((l) => l.source === "自定义脚本" && l.message === "hi"));
  assert.throws(() => run({ customScript: { enabled: true, code: "function main(){ return 1 }" } }), /没有返回配置对象/);
});

test("merge.yaml 可选启用，行为与 Verge 相同（dns 按子键替换）", () => {
  const merged = useMerge(yaml.load(MERGE), SUB);
  assert.deepEqual(merged.dns.fallback, []);
  assert.equal(merged.dns.listen, "0.0.0.0:1053");
  const { config } = run({ useMerge: true, leakGuard: { enabled: false } });
  assert.equal(config["tcp-concurrent"], true);
});

test("订阅解析：Clash YAML、Base64 分享链接、明文链接", () => {
  assert.equal(parseSubscription(yaml.dump(SUB)).converted, false);
  const links = [
    "ss://" + Buffer.from("aes-128-gcm:pass").toString("base64") + "@1.2.3.4:8388#HK%2001",
    "trojan://pw@hk.example.com:443?sni=hk.example.com&type=ws&path=%2Fws&host=cdn.example.com#TJ",
    "vless://0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3@jp.example.com:443?security=reality&pbk=KEY&sid=ab&sni=www.apple.com&flow=xtls-rprx-vision&fp=chrome#JP",
    "vmess://" + Buffer.from(JSON.stringify({ v: "2", ps: "TW", add: "tw.example.com", port: "443", id: "0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3", aid: "0", net: "ws", path: "/v", host: "tw.example.com", tls: "tls" })).toString("base64"),
    "hysteria2://pw@sg.example.com:443?sni=sg.example.com&insecure=1#SG",
    "tuic://0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3:pw@us.example.com:443?congestion_control=bbr&alpn=h3#US",
    "ss://YWVzLTEyOC1nY206cGFzc0AxLjIuMy41Ojg4ODg#OLD",
    "unknown://whatever",
  ];
  const { config, converted } = parseSubscription(Buffer.from(links.join("\n")).toString("base64"));
  assert.equal(converted, true);
  const byName = Object.fromEntries(config.proxies.map((p) => [p.name, p]));
  assert.deepEqual(Object.keys(byName), ["HK 01", "TJ", "JP", "TW", "SG", "US", "OLD"]);
  assert.equal(byName["HK 01"].cipher, "aes-128-gcm");
  assert.equal(byName["OLD"].server, "1.2.3.5");
  assert.equal(byName.TJ["ws-opts"].headers.Host, "cdn.example.com");
  assert.equal(byName.JP["reality-opts"]["public-key"], "KEY");
  assert.equal(byName.JP.tls, true);
  assert.equal(byName.TW.network, "ws");
  assert.equal(byName.SG["skip-cert-verify"], true);
  assert.deepEqual(byName.US.alpn, ["h3"]);
  assert.equal(config.rules.at(-1), "MATCH,节点选择");
  assert.equal(parseSubscription(links.join("\n")).config.proxies.length, 7);
  assert.throws(() => parseSubscription("hello world"), /无法识别/);
  assert.throws(() => parseSubscription("a: 1"), /没有节点/);
});

test("订阅响应头：流量信息与文件名", () => {
  assert.deepEqual(parseUserinfo("upload=10; download=20; total=1000; expire=1798732800"), { upload: 10, download: 20, total: 1000, expire: 1798732800 });
  assert.equal(parseUserinfo(""), null);
  assert.equal(filenameFromDisposition("attachment; filename*=UTF-8''%E6%9C%BA%E5%9C%BA"), "机场");
  assert.equal(filenameFromDisposition('attachment; filename="Airport.yaml"'), "Airport.yaml");
});

test("订阅管理：下载、更新、到期、坏内容不覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lily-profiles-"));
  let body = yaml.dump(SUB);
  const fetchFn = async () =>
    new Response(body, { headers: { "subscription-userinfo": "upload=1; download=2; total=10", "profile-update-interval": "12", "content-disposition": "attachment; filename=Air" } });
  const profiles = new Profiles(dir, fetchFn);
  const item = await profiles.add({ url: "https://sub.example.com/x" });
  assert.equal(item.name, "Air");
  assert.equal(item.interval, 720);
  assert.equal(item.userinfo.total, 10);
  assert.ok(profiles.load(item.id).proxies.length > 0);
  body = "<html>blocked</html>";
  await assert.rejects(() => profiles.update(item.id), /无法识别/);
  assert.ok(profiles.read(item.id).includes("proxies")); // 旧内容还在
  assert.deepEqual(profiles.due(Date.now() + 721 * 60000).map((p) => p.id), [item.id]);
  assert.ok(profiles.groups(item.id).includes("🚀 节点选择"));
  const again = new Profiles(dir, fetchFn); // 重新读取索引
  assert.equal(again.list().length, 1);
  await assert.rejects(() => profiles.add({ url: "ftp://x" }), /http/);
  const local = profiles.import({ name: "mine.yaml", text: yaml.dump(SUB) });
  assert.equal(local.name, "mine");
  profiles.remove(local.id);
  assert.equal(profiles.list().length, 1);
});

test("设置：缺字段补默认值，类型不对的丢弃，密钥保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "lily-store-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ mixedPort: "bad", tun: { enable: true, stack: 1 }, leakGuard: { webrtc: "strict" } }));
  const store = new Store(file);
  assert.equal(store.get().mixedPort, DEFAULTS.mixedPort);
  assert.equal(store.get().tun.enable, true);
  assert.equal(store.get().tun.stack, "mixed");
  assert.equal(store.get().leakGuard.webrtc, "strict");
  assert.equal(store.get().leakGuard.udpLeakGuard, true);
  const secret = store.get().secret;
  assert.match(secret, /^[0-9a-f]{32}$/);
  store.set({ secret: "x", unknown: 1, tun: { strictRoute: false }, customRules: ["A"] });
  assert.equal(store.get().secret, secret);
  assert.equal(store.get().unknown, undefined);
  assert.equal(store.get().tun.enable, true);
  assert.equal(store.get().tun.strictRoute, false);
  assert.deepEqual(new Store(file).get().customRules, ["A"]);
});

test("内核下载：发布文件名、zip 解压、版本比较", () => {
  assert.equal(assetName("v1.19.33", "win32", "x64"), "mihomo-windows-amd64-compatible-v1.19.33.zip");
  assert.equal(assetName("v1.19.33", "darwin", "arm64"), "mihomo-darwin-arm64-v1.19.33.gz");
  assert.equal(assetName("v1.19.33", "linux", "x64"), "mihomo-linux-amd64-compatible-v1.19.33.gz");
  assert.throws(() => assetName("v1", "sunos", "x64"));
  // 手工拼一个 deflate 的 zip
  const data = Buffer.from("MZ fake exe ".repeat(100));
  const comp = zlib.deflateRawSync(data);
  const name = Buffer.from("mihomo-windows-amd64.exe");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  const zip = Buffer.concat([local, name, comp, central, name, eocd]);
  assert.deepEqual(unzipFirst(zip, (n) => n.endsWith(".exe")), data);
  assert.ok(compareVersion("v1.19.33", "v1.19.4") > 0);
  assert.equal(compareVersion("v1.19.33", "1.19.33"), 0);
  assert.equal(cleanLog('time="x" level=error msg="bad \\"thing\\""'), 'bad "thing"');
});

// 有内核时，用真实 mihomo 校验生成的配置。GEO 数据优先用 GEODATA_DIR，其次用 resources/geo（npm run core 会下载）
const bin = join(here, "..", "resources", "core", `${{ win32: "win", darwin: "mac", linux: "linux" }[process.platform]}-${process.arch}`, process.platform === "win32" ? "mihomo.exe" : "mihomo");
test("mihomo -t 校验生成的配置", { skip: !existsSync(bin) && "没有内核（npm run core 下载）" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lily-core-"));
  const geo = process.env.GEODATA_DIR || join(here, "..", "resources", "geo");
  for (const f of ["geosite.dat", "geoip.dat", "country.mmdb"]) if (existsSync(join(geo, f))) copyFileSync(join(geo, f), join(dir, f));
  for (const [name, patch, profile] of [
    ["default", { tun: { enable: true } }, SUB],
    ["strict", { leakGuard: { webrtc: "strict", sniffer: true, dnsIPv6: "all" }, customRules: ["DOMAIN,a.test,DIRECT"] }, SUB],
    ["links", {}, parseSubscription("trojan://pw@hk.example.com:443#HK\nhysteria2://pw@sg.example.com:443#SG").config],
  ]) {
    const file = join(dir, name + ".yaml");
    writeFileSync(file, run(patch, profile).text);
    const out = execFileSync(bin, ["-t", "-d", dir, "-f", file], { encoding: "utf8", timeout: 120000 });
    assert.match(out, /test is successful/, name + "\n" + out);
  }
});
