// VPS 管理：服务器列表（登录凭据用系统钥匙串加密保存）、SSH 连接（第一次连接记住主机指纹，之后变了就拒绝）、
// 以 root 身份执行部署脚本、上传文件。连接按服务器复用，空闲一分钟后断开
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import ssh2 from "ssh2";
import { deployScript, INFO_SCRIPT, parseInfo, parseMarker } from "./deploy.js";

const { Client } = ssh2;
const AUTHS = ["password", "key", "agent"];

// ---------------- 服务器列表 ----------------
export class Servers {
  // vault：{ secure() → 能否加密保存, encrypt(text) → string, decrypt(string) → text }；不能加密时密码只记在内存里
  constructor(file, vault) {
    this.file = file;
    this.vault = vault;
    this.memory = new Map(); // id → 凭据（钥匙串不可用时）
    try {
      this.items = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(this.items)) this.items = [];
    } catch {
      this.items = [];
    }
  }

  // 给界面看的：不含任何凭据
  list() {
    return this.items.map((s) => {
      const out = Object.assign({}, s);
      delete out.secret;
      out.hasSecret = !!s.secret || this.memory.has(s.id);
      if (out.deployment) out.deployment = { at: s.deployment.at, version: s.deployment.version, protocols: s.deployment.protocols, address: s.deployment.address, bbr: s.deployment.bbr };
      return out;
    });
  }

  get(id) {
    return this.items.find((s) => s.id === id) || null;
  }

  add(input) {
    const item = { id: Date.now().toString(36) + randomBytes(3).toString("hex"), createdAt: Date.now(), hostKey: "" };
    this.apply(item, input, true);
    this.items.push(item);
    this.save();
    return item;
  }

  edit(id, patch) {
    const item = this.get(id);
    if (!item) throw new Error("服务器不存在");
    const before = item.host + ":" + item.port;
    this.apply(item, patch, false);
    if (before !== item.host + ":" + item.port) item.hostKey = ""; // 换了地址：重新记指纹
    this.save();
    return item;
  }

  apply(item, input, creating) {
    const str = (v) => String(v ?? "").trim();
    if (creating || input.host !== undefined) {
      const host = str(input.host).replace(/^\[|\]$/g, "");
      if (!/^[\w.:-]+$/.test(host)) throw new Error("服务器地址不对");
      item.host = host;
    }
    if (creating || input.port !== undefined) {
      const port = Number(input.port || 22);
      if (!(port >= 1 && port <= 65535)) throw new Error("SSH 端口不对");
      item.port = port;
    }
    if (creating || input.username !== undefined) {
      const user = str(input.username) || "root";
      if (!/^[\w.-]+$/.test(user)) throw new Error("用户名不对");
      item.username = user;
    }
    if (creating || input.name !== undefined) item.name = str(input.name) || item.host;
    if (creating || input.auth !== undefined) item.auth = AUTHS.includes(input.auth) ? input.auth : "password";
    if (input.keyFile !== undefined) item.keyFile = str(input.keyFile);
    if (input.viaProxy !== undefined) item.viaProxy = !!input.viaProxy;
    // 凭据：只在填了新值时替换
    const secret = {};
    if (str(input.password)) secret.password = String(input.password);
    if (str(input.privateKey)) secret.privateKey = String(input.privateKey).trim() + "\n";
    if (input.passphrase !== undefined && str(input.passphrase)) secret.passphrase = String(input.passphrase);
    if (Object.keys(secret).length) this.setCreds(item, Object.assign({}, creating ? {} : this.creds(item.id), secret));
    if (creating && item.auth === "password" && !secret.password) throw new Error("请填写密码");
    if (creating && item.auth === "key" && !secret.privateKey && !item.keyFile) throw new Error("请粘贴私钥或选择私钥文件");
  }

  setCreds(item, creds) {
    if (this.vault.secure()) {
      item.secret = this.vault.encrypt(JSON.stringify(creds));
      this.memory.delete(item.id);
    } else {
      delete item.secret;
      this.memory.set(item.id, creds);
    }
  }

  creds(id) {
    const item = this.get(id);
    if (!item) return {};
    if (this.memory.has(id)) return this.memory.get(id);
    if (!item.secret) return {};
    try {
      return JSON.parse(this.vault.decrypt(item.secret));
    } catch {
      return {};
    }
  }

  touch(id, patch) {
    const item = this.get(id);
    if (item) Object.assign(item, patch);
    this.save();
    return item;
  }

  remove(id) {
    this.items = this.items.filter((s) => s.id !== id);
    this.memory.delete(id);
    this.save();
  }

  save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.items, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

// ---------------- SSH ----------------
export const fingerprint = (key) => "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

// 经本机代理（SOCKS5，mihomo / sing-box 的 mixed 端口）连服务器：直连 SSH 被阻断时用
export function socks5(port, host, dport, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = (msg) => {
      sock.destroy();
      reject(new Error(msg));
    };
    sock.setTimeout(timeout, () => fail("经本机代理连接超时"));
    sock.once("error", (err) => reject(new Error("本机代理连不上（内核在运行吗？）：" + err.message)));
    sock.once("connect", () => sock.write(Buffer.from([5, 1, 0])));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 0) return fail("本机代理不接受 SOCKS5 连接");
        buf = buf.subarray(2);
        stage = 1;
        const h = Buffer.from(String(host));
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([dport >> 8, dport & 255])]));
      }
      if (stage === 1 && buf.length >= 5) {
        if (buf[1] !== 0) return fail(`本机代理连不上服务器（SOCKS 错误 ${buf[1]}）`);
        const need = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < need) return;
        sock.removeListener("data", onData);
        sock.setTimeout(0);
        if (buf.length > need) sock.unshift(buf.subarray(need));
        resolve(sock);
      }
    };
    sock.on("data", onData);
  });
}

function friendly(err) {
  const code = err.code || "";
  if (err.level === "client-authentication") return new Error("登录失败：用户名、密码或密钥不对");
  if (err.level === "client-timeout" || code === "ETIMEDOUT") return new Error("连接超时：检查地址、端口，或者试试「经本机代理连接」");
  if (code === "ECONNREFUSED") return new Error("连接被拒绝：SSH 端口不对或者服务器没开 SSH");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new Error("找不到这个服务器地址");
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return new Error("网络不通，连不上服务器");
  if (/Cannot parse privateKey|Encrypted private OpenSSH key|bad decrypt/i.test(err.message)) return new Error("私钥读不了：格式不对或者口令不对");
  return new Error(err.message || String(err));
}

// 返回 { client, hostKey }；指纹和记住的不一样时抛出 HOSTKEY_CHANGED（err.hostKey 是新指纹）
export function connect(server, creds = {}, { sock = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seen = "";
    const opts = {
      host: server.host,
      port: server.port || 22,
      username: server.username || "root",
      readyTimeout: timeout,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => {
        seen = fingerprint(key);
        return !server.hostKey || server.hostKey === seen;
      },
    };
    try {
      if (server.auth === "key") {
        opts.privateKey = creds.privateKey || (server.keyFile && existsSync(server.keyFile) ? readFileSync(server.keyFile) : "");
        if (!opts.privateKey) throw new Error("没有私钥：请重新粘贴私钥或选择私钥文件");
        if (creds.passphrase) opts.passphrase = creds.passphrase;
      } else if (server.auth === "agent") {
        opts.agent = process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : "");
        if (!opts.agent) throw new Error("没有找到 SSH agent");
      } else {
        if (!creds.password) throw new Error("NEED_PASSWORD");
        opts.password = creds.password;
        opts.tryKeyboard = true;
      }
    } catch (err) {
      return reject(err);
    }
    if (sock) opts.sock = sock;
    client.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => creds.password || "")));
    client.once("ready", () => resolve({ client, hostKey: seen }));
    client.once("error", (err) => {
      if (server.hostKey && seen && seen !== server.hostKey) return reject(Object.assign(new Error("HOSTKEY_CHANGED"), { hostKey: seen }));
      reject(friendly(err));
    });
    client.connect(opts);
  });
}

// 执行命令：stdin 可以是字符串或 Buffer；onLine 逐行回调（标准错误也算）
export function exec(client, command, { stdin, onLine, timeout = 0, maxBytes = 2 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(friendly(err));
      let out = "";
      let errText = "";
      const pending = ["", ""];
      const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
      const take = (chunk, i) => {
        const s = decoders[i].write(chunk);
        if (i) errText = (errText + s).slice(-maxBytes);
        else out = (out + s).slice(-maxBytes);
        if (!onLine) return;
        pending[i] += s;
        const lines = pending[i].split(/\r?\n/);
        pending[i] = lines.pop();
        lines.forEach((l) => onLine(l, !!i));
      };
      const timer = timeout
        ? setTimeout(() => {
            stream.close();
            reject(new Error("执行超时"));
          }, timeout)
        : null;
      stream.on("data", (d) => take(d, 0));
      stream.stderr.on("data", (d) => take(d, 1));
      stream.on("close", (code) => {
        clearTimeout(timer);
        if (onLine) pending.forEach((l, i) => l && onLine(l, !!i));
        resolve({ code: code ?? 0, out, err: errText });
      });
      stream.end(stdin === undefined ? undefined : stdin);
    });
  });
}

// ---------------- 连接复用 ----------------
export class SSHPool {
  // servers：Servers；proxyPort() → 本机 mixed 端口；onHostKey(id, 指纹) 第一次连接时调用
  constructor(servers, { proxyPort = () => 0, onHostKey = () => {}, idle = 60000 } = {}) {
    this.servers = servers;
    this.proxyPort = proxyPort;
    this.onHostKey = onHostKey;
    this.idle = idle;
    this.map = new Map(); // id → { session, timer }
    this.pending = new Map(); // id → Promise（同一台服务器同时只建一个连接）
  }

  async session(id) {
    const live = this.map.get(id);
    if (live && live.session.alive) {
      this.touch(id);
      return live.session;
    }
    if (!this.pending.has(id)) this.pending.set(id, this.open(id).finally(() => this.pending.delete(id)));
    return this.pending.get(id);
  }

  async open(id) {
    const server = this.servers.get(id);
    if (!server) throw new Error("服务器不存在");
    const creds = this.servers.creds(id);
    const sock = server.viaProxy && this.proxyPort() ? await socks5(this.proxyPort(), server.host, server.port || 22) : null;
    const { client, hostKey } = await connect(server, creds, { sock });
    if (!server.hostKey) this.onHostKey(id, hostKey);
    const session = { id, client, alive: true, hostKey, password: creds.password || "" };
    const dead = () => {
      session.alive = false;
      const e = this.map.get(id);
      if (e && e.session === session) {
        clearTimeout(e.timer);
        this.map.delete(id);
      }
    };
    client.on("close", dead);
    client.on("end", dead);
    client.on("error", dead);
    // 权限：root 直接执行；普通用户看能不能免密 sudo，不能的话用登录密码
    const uid = (await exec(client, "id -u", { timeout: 15000 })).out.trim();
    session.root = uid === "0";
    if (!session.root) {
      if ((await exec(client, "sudo -n true", { timeout: 15000 })).code === 0) session.sudo = "nopass";
      else if (session.password && (await exec(client, "sudo -S -k -p '' true", { stdin: session.password + "\n", timeout: 15000 })).code === 0) session.sudo = "password";
      else session.sudo = "";
    }
    this.map.set(id, { session, timer: null });
    this.touch(id);
    return session;
  }

  touch(id) {
    const e = this.map.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.close(id), this.idle);
  }

  close(id) {
    const e = this.map.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    this.map.delete(id);
    try {
      e.session.client.end();
    } catch {
      /* 已经断开 */
    }
  }

  closeAll() {
    for (const id of [...this.map.keys()]) this.close(id);
  }
}

// 以 root 身份把脚本交给 sh（脚本走标准输入，不落盘，进程列表里也看不到）
export function runRoot(session, script, opts = {}) {
  if (session.root) return exec(session.client, "sh -s", Object.assign({}, opts, { stdin: script }));
  if (session.sudo === "nopass") return exec(session.client, "sudo -n sh -s", Object.assign({}, opts, { stdin: script }));
  if (session.sudo === "password") return exec(session.client, "sudo -S -k -p '' sh -s", Object.assign({}, opts, { stdin: session.password + "\n" + script }));
  return Promise.reject(new Error("需要 root 权限：请用 root 登录，或者给这个用户配置 sudo"));
}

// 服务器概况
export async function serverInfo(session) {
  const r = await exec(session.client, "sh -s", { stdin: INFO_SCRIPT, timeout: 30000 });
  return Object.assign(parseInfo(r.out), { sudo: session.root ? "root" : session.sudo || "none" });
}

// 部署：脚本在服务器上下载 sing-box；下载不了（比如服务器访问不了 GitHub）时由本机下载后上传再来一次
// fetchTarball(version, arch) → Buffer；log({ kind: "step" | "out" | "warn" | "error", text })
export async function deploy(session, dep, { version, mirror = "", fetchTarball, log = () => {} }) {
  let arch = "";
  let failure = "";
  let done = "";
  let needUpload = false;
  const onLine = (line, isErr) => {
    const m = parseMarker(line);
    if (!m) return line.trim() && log({ kind: isErr ? "warn" : "out", text: line });
    if (m.kind === "arch") arch = m.text;
    else if (m.kind === "need-upload") needUpload = true;
    else if (m.kind === "error") failure = m.text;
    else if (m.kind === "done") done = m.text;
    if (m.kind === "step" || m.kind === "warn" || m.kind === "error") log({ kind: m.kind, text: m.text });
    if (m.kind === "bbr") log({ kind: "step", text: "BBR 已开启" });
  };
  const run = (upload) => runRoot(session, deployScript(dep, { version, mirror, upload }), { onLine, timeout: 15 * 60000 });
  let r = await run(null);
  if (needUpload && r.code === 3) {
    log({ kind: "step", text: "服务器下载不了 sing-box，改由本机下载后上传" });
    const data = await fetchTarball(version, arch);
    const path = `/tmp/lily-${randomBytes(6).toString("hex")}.tar.gz`;
    log({ kind: "step", text: `上传 sing-box（${(data.length / 1048576).toFixed(1)} MB）` });
    const up = await exec(session.client, `umask 077; cat > ${path}`, { stdin: data, timeout: 10 * 60000 });
    if (up.code !== 0) throw new Error("上传失败：" + (up.err.trim() || "退出码 " + up.code));
    needUpload = false;
    r = await run({ path, sha256: createHash("sha256").update(data).digest("hex") });
  }
  if (r.code !== 0 || !done) {
    const tail = (r.err || r.out).trim().split("\n").slice(-3).join(" ");
    throw new Error(failure || (needUpload ? "下载 sing-box 失败" : `部署没有完成（退出码 ${r.code}）${tail ? "：" + tail : ""}`));
  }
  return { version: done.replace(/^sing-box version\s*/, "") };
}
