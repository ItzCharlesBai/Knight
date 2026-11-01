// 多个订阅同时使用：合成规则、重名处理、代理集合改名；有 mihomo 内核时用 mihomo -t 校验合成后的配置
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseSubscription } from "../src/main/convert.js";
import { generate } from "../src/main/enhance.js";
import { toSingBox } from "../src/main/singbox.js";
import { stackProfiles, stackProviderCache } from "../src/main/stack.js";
import { DEFAULTS, mergePatch } from "../src/main/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const SCRIPT = readFileSync(join(repo, "clash-verge-rev", "script.js"), "utf8");
const SUB = yaml.load(readFileSync(join(repo, "test", "fixtures", "subscription.yaml"), "utf8"));
const settings = (patch = {}) => Object.assign(mergePatch(DEFAULTS, patch), { secret: "s3cret" });

const B = parseSubscription("trojan://pw@hk9.example.com:443#🇭🇰 香港 01\nhysteria2://pw@jp9.example.com:443#JP 09").config;
const C = {
  proxies: [],
  "proxy-providers": { airport: { type: "http", url: "https://c.example.com/sub", path: "./providers/airport.yaml", interval: 3600 } },
  "proxy-groups": [{ name: "C 自己的分组", type: "select", use: ["airport"] }],
  rules: ["MATCH,C 自己的分组"],
};
const extras = [
  { id: "b1", name: "机场 B", config: B },
  { id: "c1", name: "机场 C", config: C },
];

test("多订阅：主订阅的分组和规则不变，其他订阅各成一组插进可选分组", () => {
  const before = JSON.stringify(SUB);
  const { config, groups, providers } = stackProfiles(SUB, extras, { testUrl: "https://cp.cloudflare.com" });
  assert.equal(JSON.stringify(SUB), before, "主订阅原配置不能被改");
  assert.deepEqual(groups, ["机场 B", "机场 C"]);
  const g = Object.fromEntries(config["proxy-groups"].map((x) => [x.name, x]));
  // 节点重名：后来的加上订阅名
  assert.deepEqual(g["机场 B"].proxies, ["机场 B · 自动", "🇭🇰 香港 01 · 机场 B", "JP 09"]);
  assert.equal(g["机场 B · 自动"].type, "url-test");
  assert.equal(g["机场 B · 自动"].url, "https://cp.cloudflare.com");
  // 只有代理集合的订阅：分组用 use 引用改过名、换了缓存路径的集合
  assert.deepEqual(g["机场 C"].use, ["airport"]);
  assert.equal(config["proxy-providers"].airport.path, "./providers/c1-airport.yaml");
  assert.deepEqual(providers, [{ id: "c1", key: "airport", as: "airport" }]);
  // 插进「节点选择」（自动选择之后、具体节点之前）和引用了分组的服务分组；订阅信息分组不动
  assert.deepEqual(g["🚀 节点选择"].proxies.slice(0, 3), ["♻️ 自动选择", "机场 B", "机场 C"]);
  assert.deepEqual(g["🎯 全球直连"].proxies, ["DIRECT", "🚀 节点选择", "机场 B", "机场 C"]);
  assert.deepEqual(g["🐟 漏网之鱼"].proxies, ["🚀 节点选择", "🎯 全球直连", "机场 B", "机场 C"]);
  assert.deepEqual(g["📢 订阅信息"].proxies, ["剩余流量：120.5 GB", "套餐到期：2027-01-01"]);
  assert.equal(g["C 自己的分组"], undefined, "其他订阅自己的分组和规则不带过来");
  assert.deepEqual(config.rules, SUB.rules);
  assert.equal(config.proxies.length, SUB.proxies.length + 2);
  // 没有同时使用的订阅：原样返回
  assert.equal(stackProfiles(SUB, []).config, SUB);
});

test("多订阅：代理集合重名、主订阅没有可插的分组时兜底", () => {
  const primary = { proxies: [], "proxy-providers": { airport: { type: "http", url: "https://a/sub", path: "./a.yaml" } }, "proxy-groups": [], rules: ["MATCH,DIRECT"] };
  const r = stackProfiles(primary, [{ id: "c1", name: "机场 C", config: C }]);
  assert.deepEqual(r.providers, [{ id: "c1", key: "airport", as: "airport · 机场 C" }]);
  const g = Object.fromEntries(r.config["proxy-groups"].map((x) => [x.name, x]));
  assert.deepEqual(g["多订阅"].proxies, ["机场 C", "DIRECT"]);
  assert.deepEqual(r.config.rules, ["MATCH,多订阅"]);
  const cache = stackProviderCache({ proxy: { airport: "A" }, rule: {}, at: 1 }, r.providers, (id) => (id === "c1" ? { proxy: { airport: "C" } } : {}));
  assert.deepEqual(cache.proxy, { airport: "A", "airport · 机场 C": "C" });
});

test("多订阅：生成 mihomo 和 sing-box 配置", () => {
  const { config, providers } = stackProfiles(SUB, extras);
  const r = generate({ profile: config, settings: settings({ tun: { enable: true } }), scriptSource: SCRIPT, core: { id: "mihomo", kind: "clash" } });
  assert.ok(r.config["proxy-groups"].some((x) => x.name === "机场 B"));
  // sing-box：代理集合按改名后的名字找缓存，展开成节点
  const cache = stackProviderCache({}, providers, () => ({ proxy: { airport: yaml.dump({ proxies: [{ name: "C-1", type: "ss", server: "c.example.com", port: 1, cipher: "aes-128-gcm", password: "x" }] }) } }));
  const sb = toSingBox(r.config, settings(), { providers: cache, ruleSetPath: (t) => `/rs/${t}.srs` });
  const tags = sb.config.outbounds.map((o) => o.tag);
  assert.ok(tags.includes("C-1"));
  assert.ok(tags.includes("机场 B · 自动"));
});

const mihomo = join(here, "..", "resources", "core", `${{ win32: "win", darwin: "mac", linux: "linux" }[process.platform]}-${process.arch}`, process.platform === "win32" ? "mihomo.exe" : "mihomo");
test("mihomo -t：多订阅合成后的配置", { skip: !existsSync(mihomo) && "没有内核（npm run core 下载）" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ondine-stack-"));
  const geo = join(here, "..", "resources", "geo");
  for (const f of ["geosite.dat", "geoip.dat", "country.mmdb"]) if (existsSync(join(geo, f))) copyFileSync(join(geo, f), join(dir, f));
  const { config } = stackProfiles(SUB, [extras[0]]);
  const file = join(dir, "stack.yaml");
  writeFileSync(file, generate({ profile: config, settings: settings(), scriptSource: SCRIPT, core: { id: "mihomo", kind: "clash" } }).text);
  const out = execFileSync(mihomo, ["-t", "-d", dir, "-f", file], { encoding: "utf8", timeout: 120000 });
  assert.match(out, /test is successful/, out);
});
