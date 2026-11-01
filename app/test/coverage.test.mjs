// 更多协议和内核：Surge / Loon / Quantumult X 导入、Juicity（搭配内核，每个节点一个进程）、Mieru、Shadowrocket 写法；
// 有 mihomo 时用 mihomo -t 校验导入的节点
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseClientConfig } from "../src/main/clients.js";
import { parseSubscription, wrapProxies } from "../src/main/convert.js";
import { assetName, extractCore } from "../src/main/core-download.js";
import { generate } from "../src/main/enhance.js";
import { toClientList } from "../src/main/formats.js";
import { toLink } from "../src/main/links.js";
import { clashSupports } from "../src/main/sidecar.js";
import { DEFAULTS, mergePatch } from "../src/main/store.js";

const here = dirname(fileURLToPath(import.meta.url));
const settings = (patch = {}) => Object.assign(mergePatch(DEFAULTS, patch), { secret: "s" });
const UUID = "0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3";
const PBK = "EnKtqzrPzBCjwiZwhiwmovV2_XpFTu68YznEDNMSTFI";

const SURGE = `[General]
loglevel = notify
internet-test-url = http://www.gstatic.com/generate_204

[Proxy]
Direct = direct
🇭🇰 香港 = ss, hk.example.com, 8388, encrypt-method=aes-128-gcm, password=pw, obfs=http, obfs-host=www.bing.com, udp-relay=true
🇯🇵 日本 = vmess, jp.example.com, 443, username=${UUID}, ws=true, ws-path=/ws, ws-headers=Host:cdn.example.com, tls=true, sni=jp.example.com, vmess-aead=true
🇺🇸 美国 = trojan, us.example.com, 443, password=pw, sni=us.example.com, skip-cert-verify=true
🇸🇬 新加坡 = hysteria2, sg.example.com, 443, password=pw, sni=sg.example.com, download-bandwidth=200, port-hopping="5000-6000;7000"
🇹🇼 台湾 = tuic-v5, tw.example.com, 443, password=pw, uuid=${UUID}, alpn=h3, sni=tw.example.com
Snell = snell, sn.example.com, 6160, psk=abc, version=3, obfs=tls
Snell5 = snell, sn5.example.com, 6160, psk=abc, version=5
SSH = ssh, ssh.example.com, 22, username=root, password=pw
HTTPS = https, h.example.com, 443, user, pass, sni=h.example.com
WG = wireguard, section-name=Cloudflare

[Proxy Group]
Proxy = select, 🇭🇰 香港, 🇯🇵 日本
`;

const QUANX = `[server_local]
shadowsocks=hk.example.com:8388, method=chacha20-ietf-poly1305, password=pw, obfs=http, obfs-host=www.bing.com, udp-relay=true, tag=港 HK
vmess=jp.example.com:443, method=aes-128-gcm, password=${UUID}, obfs=wss, obfs-host=cdn.example.com, obfs-uri=/ws, tag=日 JP
trojan=us.example.com:443, password=pw, over-tls=true, tls-host=us.example.com, tls-verification=false, tag=美 US
vless=sg.example.com:443, method=none, password=${UUID}, obfs=over-tls, obfs-host=www.microsoft.com, vless-flow=xtls-rprx-vision, reality-base64-pubkey=${PBK}, reality-hex-shortid=a9b0d813, tag=新 SG
shadowsocks=ssr.example.com:443, method=aes-256-cfb, password=pw, ssr-protocol=auth_aes128_md5, ssr-protocol-param=, obfs=tls1.2_ticket_auth, obfs-host=www.bing.com, tag=SSR
http=p.example.com:8080, username=u, password=p, tag=HTTP

[filter_local]
host-suffix, google.com, proxy
`;

const LOON = `[Proxy]
HK = Shadowsocks,hk.example.com,8388,aes-128-gcm,"p=w,1",obfs-name=http,obfs-host=www.bing.com,udp=true
SSR = ShadowsocksR,ssr.example.com,443,aes-256-cfb,"pw",protocol=auth_aes128_md5,protocol-param=,obfs=tls1.2_ticket_auth,obfs-param=www.bing.com
JP = vmess,jp.example.com,443,auto,"${UUID}",transport=ws,path=/ws,host=cdn.example.com,over-tls=true,sni=jp.example.com,alterId=0
SG = VLESS,sg.example.com,443,"${UUID}",transport=tcp,flow=xtls-rprx-vision,public-key="${PBK}",short-id=a9b0d813,over-tls=true,sni=www.microsoft.com
US = trojan,us.example.com,443,"pw",transport=grpc,grpc-service-name=gun,over-tls=true,sni=us.example.com
H2 = Hysteria2,h2.example.com,443,"pw",sni=h2.example.com,download-bandwidth=100
`;

const byName = (nodes) => Object.fromEntries(nodes.map((n) => [n.name, n]));

test("Surge 配置：只读 [Proxy] 段，常见协议都能转", () => {
  const r = parseSubscription(SURGE);
  assert.equal(r.format, "surge");
  const n = byName(r.config.proxies);
  assert.deepEqual(Object.keys(n), ["🇭🇰 香港", "🇯🇵 日本", "🇺🇸 美国", "🇸🇬 新加坡", "🇹🇼 台湾", "Snell", "Snell5", "SSH", "HTTPS"]);
  assert.deepEqual(n["🇭🇰 香港"]["plugin-opts"], { mode: "http", host: "www.bing.com" });
  assert.equal(n["🇯🇵 日本"]["ws-opts"].headers.Host, "cdn.example.com");
  assert.equal(n["🇯🇵 日本"].servername, "jp.example.com");
  assert.equal(n["🇺🇸 美国"]["skip-cert-verify"], true);
  assert.equal(n["🇸🇬 新加坡"].ports, "5000-6000,7000");
  assert.equal(n["🇹🇼 台湾"].uuid, UUID);
  assert.equal(n.SSH.type, "ssh");
  assert.deepEqual([n.HTTPS.username, n.HTTPS.password, n.HTTPS.tls], ["user", "pass", true]);
  // mihomo 只支持到 Snell v3
  assert.equal(clashSupports(n.Snell), true);
  assert.equal(clashSupports(n.Snell5), false);
  // 整份配置之外的分组段落不当节点
  assert.ok(!r.config.proxies.some((x) => x.name === "Proxy"));
});

test("Quantumult X / Loon 配置", () => {
  const q = parseSubscription(QUANX);
  assert.equal(q.format, "quanx");
  const qn = byName(q.config.proxies);
  assert.equal(qn["港 HK"].cipher, "chacha20-ietf-poly1305");
  assert.equal(qn["日 JP"].tls, true);
  assert.equal(qn["日 JP"]["ws-opts"].path, "/ws");
  assert.equal(qn["美 US"]["skip-cert-verify"], true);
  assert.equal(qn["新 SG"]["reality-opts"]["public-key"], PBK);
  assert.equal(qn["新 SG"].flow, "xtls-rprx-vision");
  assert.equal(qn.SSR.type, "ssr");
  assert.equal(qn.HTTP.username, "u");
  const l = parseSubscription(LOON);
  assert.equal(l.format, "loon");
  const ln = byName(l.config.proxies);
  assert.equal(ln.HK.password, "p=w,1", "引号里的逗号和等号原样保留");
  assert.equal(ln.SSR.protocol, "auth_aes128_md5");
  assert.equal(ln.JP.uuid, UUID);
  assert.equal(ln.SG["reality-opts"]["short-id"], "a9b0d813");
  assert.equal(ln.US.network, "grpc");
  assert.equal(ln.US["grpc-opts"]["grpc-service-name"], "gun");
  assert.equal(ln.H2.down, "100 Mbps");
  // Base64 包着的节点列表也认
  assert.equal(parseSubscription(Buffer.from(QUANX).toString("base64")).config.proxies.length, 6);
});

test("Surge / Quantumult X / Loon：本应用导出的节点列表能原样导回来", () => {
  const nodes = [
    { name: "SS", type: "ss", server: "a.example.com", port: 8388, cipher: "aes-128-gcm", password: "pw", udp: true },
    { name: "VM", type: "vmess", server: "b.example.com", port: 443, uuid: UUID, alterId: 0, cipher: "auto", tls: true, servername: "b.example.com", network: "ws", "ws-opts": { path: "/ws", headers: { Host: "b.example.com" } } },
    { name: "TJ", type: "trojan", server: "c.example.com", port: 443, password: "pw", sni: "c.example.com" },
    { name: "VL", type: "vless", server: "d.example.com", port: 443, uuid: UUID, tls: true, flow: "xtls-rprx-vision", servername: "www.microsoft.com", "reality-opts": { "public-key": PBK, "short-id": "a9b0d813" } },
    { name: "H2", type: "hysteria2", server: "e.example.com", port: 443, password: "pw", sni: "e.example.com" },
  ];
  const key = (n) => [n.type, n.server, n.port, n.uuid || n.password || "", (n["reality-opts"] || {})["public-key"] || "", n.network || "tcp"].join("|");
  for (const target of ["surge", "quanx", "loon"]) {
    const { text } = toClientList(target, nodes);
    const back = parseClientConfig(text).nodes;
    const expected = nodes.filter((n) => toClientList(target, [n]).count);
    assert.deepEqual(back.map(key), expected.map(key), target);
  }
});

test("分享链接：Juicity、Mieru、Shadowrocket 的 vmess、v2rayN 的 socks", () => {
  const j = parseSubscription("juicity://" + UUID + ":pw@j.example.com:23182?congestion_control=bbr&sni=www.example.com&allow_insecure=1&pinned_certchain_sha256=abc#J").config.proxies[0];
  assert.deepEqual([j.type, j.port, j.password, j.sni, j["skip-cert-verify"], j["pinned-certchain-sha256"]], ["juicity", 23182, "pw", "www.example.com", true, "abc"]);
  assert.equal(parseSubscription(toLink(j)).config.proxies[0].uuid, UUID);
  const m = parseSubscription("mierus://baozi:manlianpenfen@1.2.3.4?multiplexing=MULTIPLEXING_HIGH&port=6666&port=9998-9999&profile=default&protocol=UDP&protocol=TCP").config.proxies[0];
  assert.deepEqual([m.type, m["port-range"], m.transport, m.username, m.multiplexing], ["mieru", "9998-9999", "TCP", "baozi", "MULTIPLEXING_HIGH"]);
  const back = parseSubscription(toLink(Object.assign({ name: "M" }, m))).config.proxies[0];
  assert.equal(back["port-range"], "9998-9999");
  const sr = parseSubscription("vmess://" + Buffer.from(`auto:${UUID}@v.example.com:443`).toString("base64") + "?remarks=SR&obfs=websocket&tls=1&peer=v.example.com&path=/ws&obfsParam=cdn.example.com").config.proxies[0];
  assert.deepEqual([sr.name, sr.uuid, sr.network, sr["ws-opts"].headers.Host, sr.servername], ["SR", UUID, "ws", "cdn.example.com", "v.example.com"]);
  const so = parseSubscription("socks://" + Buffer.from("user:pa:ss").toString("base64") + "@1.2.3.4:1080#S").config.proxies[0];
  assert.deepEqual([so.username, so.password], ["user", "pa:ss"]);
  // SS2022 的明文写法
  const ss = parseSubscription("ss://2022-blake3-aes-128-gcm:YWJjZGVmZ2hpamtsbW5vcA%3D%3D@1.2.3.4:8388#S").config.proxies[0];
  assert.deepEqual([ss.cipher, ss.password], ["2022-blake3-aes-128-gcm", "YWJjZGVmZ2hpamtsbW5vcA=="]);
});

test("Juicity 搭配：每个节点一个进程，配置是 Juicity 客户端的 JSON", () => {
  const nodes = [
    { name: "J1", type: "juicity", server: "j1.example.com", port: 443, uuid: UUID, password: "a", sni: "j1.example.com", "congestion-controller": "bbr" },
    { name: "J2", type: "juicity", server: "2001:db8::1", port: 8443, uuid: UUID, password: "b", "skip-cert-verify": true },
    { name: "SS", type: "ss", server: "s.example.com", port: 8388, cipher: "aes-128-gcm", password: "x" },
  ];
  const JC = { id: "juicity", kind: "juicity", bin: "/opt/j/juicity-client", label: "Juicity" };
  const r = generate({ profile: wrapProxies(nodes), settings: settings({ sidecarPort: 7940 }), core: { id: "mihomo", kind: "clash" }, sidecars: [JC] });
  assert.deepEqual(r.sidecars.map((p) => p.key), ["juicity-1", "juicity-2"]);
  const c1 = JSON.parse(r.sidecars[0].text);
  const c2 = JSON.parse(r.sidecars[1].text);
  assert.deepEqual([c1.listen, c1.server, c1.sni, c1.allow_insecure], ["127.0.0.1:7940", "j1.example.com:443", "j1.example.com", false]);
  assert.deepEqual([c2.listen, c2.server, c2.allow_insecure], ["127.0.0.1:7941", "[2001:db8::1]:8443", true]);
  const proxies = byName(r.config.proxies);
  assert.deepEqual([proxies.J1.type, proxies.J1.port], ["socks5", 7940]);
  assert.equal(r.config.rules.filter((x) => x === "PROCESS-PATH,/opt/j/juicity-client,DIRECT").length, 1, "进程规则只加一次");
  // 没下载 Juicity：节点跳过并提示
  const none = generate({ profile: wrapProxies(nodes), settings: settings(), core: { id: "mihomo", kind: "clash" } });
  assert.equal(none.config.proxies.length, 1);
  assert.ok(none.logs.some((l) => /Juicity/.test(l.message)));
});

test("内核下载：Juicity 的文件名，压缩包里只取客户端", () => {
  assert.equal(assetName("v0.5.0", "linux", "x64", "juicity"), "juicity-linux-x86_64.zip");
  assert.equal(assetName("v0.5.0", "darwin", "arm64", "juicity"), "juicity-macos-arm64.zip");
  assert.equal(assetName("v0.5.0", "win32", "x64", "juicity"), "juicity-windows-x86_64.zip");
  // 最小 zip（存储方式）：客户端、服务端、示例配置
  const entry = (name, data) => {
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    return { n, data, local };
  };
  const files = [entry("juicity-server", Buffer.from("SERVER")), entry("example-client.json", Buffer.from("{}")), entry("juicity-client", Buffer.from("CLIENT"))];
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(f.n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, f.n);
    parts.push(f.local, f.n, f.data);
    offset += 30 + f.n.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const out = extractCore(Buffer.concat([...parts, cd, end]), "juicity-linux-x86_64.zip", "juicity-client");
  assert.deepEqual(out.map((f) => [f.name, f.data.toString()]), [["juicity-client", "CLIENT"]]);
});

const mihomo = join(here, "..", "resources", "core", `${{ win32: "win", darwin: "mac", linux: "linux" }[process.platform]}-${process.arch}`, process.platform === "win32" ? "mihomo.exe" : "mihomo");
test("mihomo -t：Surge / Loon / Quantumult X 导入的节点、Mieru、SSH", { skip: !existsSync(mihomo) && "没有内核（npm run core 下载）" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ondine-cover-"));
  for (const f of ["geosite.dat", "geoip.dat", "country.mmdb"]) {
    const src = join(here, "..", "resources", "geo", f);
    if (existsSync(src)) copyFileSync(src, join(dir, f));
  }
  const all = [SURGE, QUANX, LOON]
    .flatMap((t, i) => parseSubscription(t).config.proxies.map((n) => Object.assign({}, n, { name: `${i}-${n.name}` })))
    .concat(parseSubscription("mierus://u:p@1.2.3.4?port=6666&protocol=TCP#M").config.proxies)
    .filter(clashSupports);
  const file = join(dir, "clients.yaml");
  writeFileSync(file, generate({ profile: wrapProxies(all), settings: settings() }).text);
  const out = execFileSync(mihomo, ["-t", "-d", dir, "-f", file], { encoding: "utf8", timeout: 120000 });
  assert.match(out, /test is successful/, out);
});
