// VPS 管理：自签证书、REALITY 密钥、部署脚本（sh -n 语法检查）、客户端节点（有 mihomo 时 mihomo -t）、
// 以及用本机起的 SSH 服务器测试连接、主机指纹、执行命令、经 SOCKS5 连接。部署脚本不会在本机执行
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey as pub, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import { parseSubscription, wrapProxies } from "../src/main/convert.js";
import { clientNodes, deployScript, INFO_SCRIPT, parseInfo, portList, prepare, realityKeypair, selfSignedCert, serverConfig, serviceScript, shareLinks, uninstallScript } from "../src/main/deploy.js";
import { generate } from "../src/main/enhance.js";
import { DEFAULTS, mergePatch } from "../src/main/store.js";
import { connect, deploy, exec, fingerprint, Servers, serverInfo, socks5, SSHPool } from "../src/main/vps.js";

const here = dirname(fileURLToPath(import.meta.url));
const ALL = [
  { id: "reality", port: 443 },
  { id: "hysteria2", port: 8443 },
  { id: "tuic", port: 9443 },
  { id: "anytls", port: 8444 },
  { id: "ss2022", port: 23456 },
];

test("自签证书：能被解析、自己验签通过、私钥配对、指纹一致", () => {
  const c = selfSignedCert("www.bing.com");
  const x = new X509Certificate(c.cert);
  assert.match(x.subject, /CN=www\.bing\.com/);
  assert.equal(x.subjectAltName, "DNS:www.bing.com");
  assert.ok(x.verify(x.publicKey));
  assert.ok(x.checkPrivateKey(createPrivateKey(c.key)));
  assert.equal(x.fingerprint256.replace(/:/g, "").toLowerCase(), c.sha256);
  assert.ok(new Date(x.validTo) > new Date(Date.now() + 9 * 365 * 86400000));
});

test("REALITY 密钥：公钥由私钥推出", () => {
  const { privateKey, publicKey } = realityKeypair();
  assert.match(privateKey, /^[\w-]{43}$/);
  const derived = pub(createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: privateKey, x: publicKey }, format: "jwk" })).export({ format: "jwk" }).x;
  assert.equal(derived, publicKey);
});

test("部署方案：重新部署沿用密钥和证书，端口冲突报错", () => {
  const dep = prepare({ protocols: ALL, address: "203.0.113.7" });
  assert.deepEqual(portList(dep), ["443/tcp", "8443/udp", "9443/udp", "8444/tcp", "23456/tcp", "23456/udp"]);
  const again = prepare({ protocols: ALL.slice(0, 2) }, dep);
  assert.equal(again.secrets.uuid, dep.secrets.uuid);
  assert.equal(again.reality.privateKey, dep.reality.privateKey);
  assert.equal(again.cert.sha256, dep.cert.sha256);
  assert.notEqual(prepare({ protocols: ALL, tlsName: "cdn.example.com" }, dep).cert.sha256, dep.cert.sha256, "换了证书域名就重新签");
  assert.throws(() => prepare({ protocols: [{ id: "reality", port: 443 }, { id: "anytls", port: 443 }] }), /重复/);
  // 同一个端口 TCP 和 UDP 各用一次可以
  assert.doesNotThrow(() => prepare({ protocols: [{ id: "reality", port: 443 }, { id: "hysteria2", port: 443 }] }));
  assert.throws(() => prepare({ protocols: [] }), /至少/);
  assert.throws(() => prepare({ protocols: ALL, realityTarget: "a b" }), /域名/);
  const sb = serverConfig(dep);
  assert.deepEqual(sb.inbounds.map((i) => i.type), ["vless", "hysteria2", "tuic", "anytls", "shadowsocks"]);
  assert.equal(sb.inbounds[0].tls.reality.private_key, dep.reality.privateKey);
  assert.equal(sb.route.rules[0].action, "reject");
});

test("部署脚本：语法正确，占位符都替换了，配置原样写入", () => {
  const dep = prepare({ protocols: ALL });
  for (const [name, script] of [
    ["deploy", deployScript(dep, { version: "v1.14.4", mirror: "https://ghfast.top/" })],
    ["upload", deployScript(dep, { upload: { path: "/tmp/lily-x.tar.gz", sha256: "ab".repeat(32) } })],
    ["uninstall", uninstallScript()],
    ["logs", serviceScript("logs")],
    ["restart", serviceScript("restart")],
    ["info", INFO_SCRIPT],
  ]) {
    execFileSync("sh", ["-n"], { input: script }); // 语法错误会抛异常
    assert.equal(/__(?!GROUP__)[A-Z_]+__/.exec(script), null, name);
  }
  const script = deployScript(dep);
  const json = /config\.json\.new <<'LILY_EOF'\n([\s\S]*?)\nLILY_EOF/.exec(script)[1];
  assert.deepEqual(JSON.parse(json), serverConfig(dep));
  assert.ok(script.includes(dep.cert.cert.trim()));
  assert.throws(() => deployScript(dep, { version: "1.14; rm -rf /" }), /版本/);
  assert.throws(() => deployScript(dep, { mirror: "https://x/'; reboot" }), /加速/);
  assert.throws(() => serviceScript("rm"), /未知/);
  // 低端口在 OpenRC 下只能用 root 跑
  assert.ok(!/command_user/.test(deployScript(dep)));
  assert.ok(/command_user="lily"/.test(deployScript(prepare({ protocols: [{ id: "hysteria2", port: 8443 }] }))));
});

test("服务器概况：在本机跑一遍概况脚本", () => {
  const info = parseInfo(execFileSync("sh", ["-s"], { input: INFO_SCRIPT, encoding: "utf8" }));
  assert.ok(info.cpus > 0);
  assert.ok(info.mem.total > info.mem.free && info.mem.free > 0);
  assert.ok(info.disk.total > 0);
  assert.ok(info.uptime > 0);
  assert.equal(info.load.length, 3);
});

test("客户端节点：分享链接来回转换不丢字段", () => {
  const dep = prepare({ protocols: ALL, address: "203.0.113.7" });
  const nodes = clientNodes(dep, "东京", "vps.example.com");
  assert.equal(nodes[0].server, "203.0.113.7");
  const links = shareLinks(nodes);
  assert.equal(links.length, 5);
  const back = parseSubscription(links.map((l) => l.link).join("\n")).config.proxies;
  const pick = (n) => [n.type, n.server, n.port, n.uuid || "", n.password || "", n.servername || n.sni || "", (n["reality-opts"] || {})["public-key"] || "", n.flow || "", n.cipher || ""].join("|");
  assert.deepEqual(back.map(pick), nodes.map(pick));
  assert.equal(back[1].fingerprint, dep.cert.sha256, "Hysteria2 链接带上证书指纹");
});

const mihomo = join(here, "..", "resources", "core", `${{ win32: "win", darwin: "mac", linux: "linux" }[process.platform]}-${process.arch}`, process.platform === "win32" ? "mihomo.exe" : "mihomo");
test("mihomo -t：部署出来的节点", { skip: !existsSync(mihomo) && "没有内核（npm run core 下载）" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lily-vps-"));
  for (const f of ["geosite.dat", "geoip.dat", "country.mmdb"]) {
    const src = join(here, "..", "resources", "geo", f);
    if (existsSync(src)) copyFileSync(src, join(dir, f));
  }
  const dep = prepare({ protocols: ALL });
  const settings = Object.assign(mergePatch(DEFAULTS, {}), { secret: "s" });
  const file = join(dir, "vps.yaml");
  writeFileSync(file, generate({ profile: wrapProxies(clientNodes(dep, "VPS", "203.0.113.7")), settings }).text);
  const out = execFileSync(mihomo, ["-t", "-d", dir, "-f", file], { encoding: "utf8", timeout: 120000 });
  assert.match(out, /test is successful/, out);
});

// sing-box 服务端配置：有 sing-box 时（SINGBOX_BIN=… npm test）用 sing-box check 校验
const singbox = process.env.SINGBOX_BIN;
test("sing-box check：服务端配置", { skip: !singbox && "设置 SINGBOX_BIN 后校验" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "lily-sbs-"));
  const dep = prepare({ protocols: ALL });
  writeFileSync(join(dir, "cert.pem"), dep.cert.cert);
  writeFileSync(join(dir, "key.pem"), dep.cert.key);
  writeFileSync(join(dir, "config.json"), JSON.stringify(serverConfig(dep, { certPath: join(dir, "cert.pem"), keyPath: join(dir, "key.pem") })));
  execFileSync(singbox, ["check", "-c", join(dir, "config.json")], { encoding: "utf8", timeout: 60000 });
});

// ---------------- 用本机 SSH 服务器测连接 ----------------
function sshServer(password) {
  const hostKey = ssh2.utils.generateKeyPairSync("ed25519").private;
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {}); // 客户端拒绝主机指纹时会断开，服务端这边忽略
    client.on("authentication", (ctx) => (ctx.method === "password" && ctx.username === "lily" && ctx.password === password ? ctx.accept() : ctx.reject(["password"])));
    client.on("ready", () =>
      client.on("session", (accept) =>
        accept().on("exec", (ok, _no, info) => {
          const stream = ok();
          // 只允许测试里用到的几条只读命令
          if (!/^(id -u|sudo -n true|sh -s|cat|echo [\w ]+)$/.test(info.command)) {
            stream.stderr.write("denied\n");
            stream.exit(126);
            return stream.end();
          }
          const child = spawn("sh", ["-c", info.command === "sudo -n true" ? "exit 1" : info.command]);
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on("close", (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
        })
      )
    );
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

const memoryVault = { secure: () => false, encrypt: (s) => s, decrypt: (s) => s };

test("SSH：首次记住指纹、指纹变了拒绝、密码错误、执行命令、经 SOCKS5", async () => {
  const { server, port } = await sshServer("pw");
  const dir = mkdtempSync(join(tmpdir(), "lily-ssh-"));
  const servers = new Servers(join(dir, "servers.json"), memoryVault);
  try {
    const item = servers.add({ name: "本机", host: "127.0.0.1", port, username: "lily", auth: "password", password: "pw" });
    assert.equal(servers.list()[0].secret, undefined, "列表里不带凭据");
    assert.equal(servers.list()[0].hasSecret, true);
    const seen = [];
    const pool = new SSHPool(servers, { onHostKey: (id, fp) => (seen.push(fp), servers.touch(id, { hostKey: fp })), idle: 500 });
    const s = await pool.session(item.id);
    assert.match(seen[0], /^SHA256:[A-Za-z0-9+/]{43}$/);
    assert.equal(s, await pool.session(item.id), "连接复用");
    const r = await exec(s.client, "cat", { stdin: "你好，Lily\n" });
    assert.equal(r.out, "你好，Lily\n");
    const lines = [];
    await exec(s.client, "sh -s", { stdin: "echo a; echo b >&2; printf c", onLine: (l, err) => lines.push((err ? "!" : "") + l) });
    assert.deepEqual(lines.sort(), ["!b", "a", "c"]);
    const info = await serverInfo(s);
    assert.ok(info.cpus > 0);
    pool.closeAll();

    // 指纹变了：拒绝并给出新指纹
    servers.touch(item.id, { hostKey: "SHA256:" + "A".repeat(43) });
    await assert.rejects(() => connect(servers.get(item.id), { password: "pw" }), (err) => err.message === "HOSTKEY_CHANGED" && err.hostKey === seen[0]);
    servers.touch(item.id, { hostKey: seen[0] });
    await assert.rejects(() => connect(servers.get(item.id), { password: "bad" }), /登录失败/);
    await assert.rejects(() => connect(servers.get(item.id), {}), /NEED_PASSWORD/);

    // 经 SOCKS5：起一个最简单的 SOCKS5 转发
    const proxy = net.createServer((c) => {
      c.once("data", () => {
        c.write(Buffer.from([5, 0]));
        c.once("data", (req) => {
          const len = req[4];
          const host = req.subarray(5, 5 + len).toString();
          const dport = req.readUInt16BE(5 + len);
          const up = net.connect(dport, host, () => {
            c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            c.pipe(up).pipe(c);
          });
          up.on("error", () => c.destroy());
        });
      });
    });
    await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
    try {
      const sock = await socks5(proxy.address().port, "127.0.0.1", port);
      const { client, hostKey } = await connect(servers.get(item.id), { password: "pw" }, { sock });
      assert.equal(hostKey, seen[0]);
      assert.equal((await exec(client, "echo via proxy")).out, "via proxy\n");
      client.end();
    } finally {
      proxy.close();
    }
    assert.equal(fingerprint(Buffer.from("x")).length, 50);
  } finally {
    server.close();
  }
});

// 部署流程：服务器下载不了 sing-box 时改由本机上传（用假的 SSH 会话，不执行真的脚本）
test("部署流程：下载失败时本机上传再部署", async () => {
  const calls = [];
  const fakeClient = {
    exec(command, cb) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      const input = new PassThrough();
      const chunks = [];
      input.on("data", (d) => chunks.push(d));
      input.on("end", () => {
        const stdin = Buffer.concat(chunks).toString("utf8");
        calls.push({ command, stdin });
        const reply = (text, code) => {
          if (text) stream.emit("data", Buffer.from(text));
          stream.emit("close", code);
        };
        if (command.startsWith("umask 077; cat >")) return reply("", 0);
        if (/UPLOAD='\/tmp\/lily-[0-9a-f]+\.tar\.gz'/.test(stdin)) return reply("@@LILY arch amd64\n@@LILY step 写入配置\n@@LILY bbr on\n@@LILY done sing-box version 1.14.4\n", 0);
        reply("@@LILY arch arm64\n@@LILY step 下载 sing-box 1.14.4\n@@LILY need-upload arm64\n", 3);
      });
      stream.end = (data) => input.end(data);
      cb(null, stream);
    },
  };
  const logs = [];
  const asked = [];
  const r = await deploy({ client: fakeClient, root: true }, prepare({ protocols: ALL.slice(0, 1) }), {
    version: "1.14.4",
    fetchTarball: async (version, arch) => (asked.push([version, arch]), Buffer.from("tarball")),
    log: (l) => logs.push(l.kind + ":" + l.text),
  });
  assert.equal(r.version, "1.14.4");
  assert.deepEqual(asked, [["1.14.4", "arm64"]]);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].stdin, "tarball");
  assert.ok(calls[2].stdin.includes(createHash("sha256").update("tarball").digest("hex")), "第二次部署带上上传文件的校验值");
  assert.ok(logs.includes("step:BBR 已开启"));
  // 普通用户没有 sudo：直接报错
  await assert.rejects(() => deploy({ client: fakeClient, root: false, sudo: "" }, prepare({ protocols: ALL.slice(0, 1) }), { version: "1.14.4", fetchTarball: async () => Buffer.alloc(0) }), /root/);
});
