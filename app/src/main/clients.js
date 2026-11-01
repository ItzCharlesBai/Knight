// 其他客户端的节点写法 → mihomo 节点：Surge（[Proxy] 段）、Loon（[Proxy] 段）、Quantumult X（[server_local] 段），
// 整份配置文件或只有节点行都行。认不出的行跳过（DIRECT、REJECT、WireGuard 这类引用了别的段的节点）
const isTrue = (v) => v === "true" || v === "1" || v === true;

// 按逗号拆分，引号里的逗号和等号不算；quoted 标记引号括起来的值（Loon 的密码）
function tokens(text) {
  const out = [];
  let cur = "";
  let q = false;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      // 整个值用引号括起来才算（Loon 的密码）；public-key="…" 这种还是键值
      if (!q && cur.trim() === "") quoted = true;
      q = !q;
      continue;
    }
    if (ch === "," && !q) {
      out.push({ v: cur.trim(), quoted });
      cur = "";
      quoted = false;
      continue;
    }
    cur += ch;
  }
  out.push({ v: cur.trim(), quoted });
  return out.filter((t) => t.v !== "" || t.quoted);
}

// → { pos: 位置参数, kv: 键值参数（键小写）}
function parseArgs(list) {
  const pos = [];
  const kv = {};
  for (const t of list) {
    const i = t.v.indexOf("=");
    if (!t.quoted && i > 0 && /^[\w-]+$/.test(t.v.slice(0, i).trim())) kv[t.v.slice(0, i).trim().toLowerCase()] = t.v.slice(i + 1).trim().replace(/^"|"$/g, "");
    else pos.push(t.v);
  }
  return { pos, kv };
}

function hostPort(at) {
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(String(at).trim());
  return m ? [m[1], Number(m[2])] : [String(at).trim(), 0];
}

const wsHost = (headers) => {
  const m = /(?:^|\|)\s*Host\s*:\s*([^|]+)/i.exec(headers || "");
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
};

// ---------------- Surge ----------------
function surge(name, type, pos, kv) {
  const [server, port] = [pos[0], Number(pos[1])];
  const tls = (n, key = "servername") => {
    if (kv.sni && kv.sni !== "off") n[key] = kv.sni;
    if (isTrue(kv["skip-cert-verify"])) n["skip-cert-verify"] = true;
    return n;
  };
  const ws = (n) => {
    if (!isTrue(kv.ws)) return n;
    n.network = "ws";
    const host = wsHost(kv["ws-headers"]);
    n["ws-opts"] = Object.assign({ path: kv["ws-path"] || "/" }, host ? { headers: { Host: host } } : {});
    return n;
  };
  switch (type) {
    case "ss":
    case "shadowsocks": {
      const n = { name, type: "ss", server, port, cipher: kv["encrypt-method"], password: kv.password, udp: isTrue(kv["udp-relay"]) };
      if (kv.obfs) Object.assign(n, { plugin: "obfs", "plugin-opts": { mode: kv.obfs, host: kv["obfs-host"] || "" } });
      return n.cipher && n.password !== undefined ? n : null;
    }
    case "vmess": {
      const n = { name, type: "vmess", server, port, uuid: kv.username, alterId: 0, cipher: kv["encrypt-method"] || "auto", udp: true };
      if (isTrue(kv.tls)) tls(Object.assign(n, { tls: true }));
      return n.uuid ? ws(n) : null;
    }
    case "trojan": {
      const n = tls({ name, type: "trojan", server, port, password: kv.password, udp: true }, "sni");
      return n.password ? ws(n) : null;
    }
    case "http":
    case "https":
    case "socks5":
    case "socks5-tls": {
      const n = { name, type: type.startsWith("socks") ? "socks5" : "http", server, port };
      const user = kv.username || pos[2];
      const pass = kv.password || pos[3];
      if (user) n.username = user;
      if (pass) n.password = pass;
      if (type === "https" || type === "socks5-tls") tls(Object.assign(n, { tls: true }), "sni");
      if (n.type === "socks5") n.udp = true;
      return n;
    }
    case "snell": {
      const n = { name, type: "snell", server, port, psk: kv.psk, version: Number(kv.version) || 1, udp: Number(kv.version) >= 3 };
      if (kv.obfs) n["obfs-opts"] = { mode: kv.obfs, host: kv["obfs-host"] || "" };
      return n.psk ? n : null;
    }
    case "tuic":
    case "tuic-v5": {
      const n = { name, type: "tuic", server, port, alpn: (kv.alpn || "h3").split(",").map((s) => s.trim()) };
      if (type === "tuic-v5" || kv.uuid) Object.assign(n, { uuid: kv.uuid, password: kv.password });
      else n.token = kv.token;
      if (kv.sni) n.sni = kv.sni;
      if (isTrue(kv["skip-cert-verify"])) n["skip-cert-verify"] = true;
      return n.uuid || n.token ? n : null;
    }
    case "hysteria2": {
      const n = tls({ name, type: "hysteria2", server, port, password: kv.password }, "sni");
      if (kv["download-bandwidth"]) n.down = kv["download-bandwidth"] + " Mbps";
      if (kv["port-hopping"]) n.ports = kv["port-hopping"].replace(/;/g, ",");
      if (kv["port-hopping-interval"]) n["hop-interval"] = Number(kv["port-hopping-interval"]);
      return n.password ? n : null;
    }
    case "anytls":
      return kv.password ? tls({ name, type: "anytls", server, port, password: kv.password, udp: true }, "sni") : null;
    case "ssh":
      return kv.username && kv.password ? { name, type: "ssh", server, port: port || 22, username: kv.username, password: kv.password } : null;
    default:
      return null;
  }
}

// ---------------- Loon ----------------
function loon(name, type, pos, kv) {
  const [server, port] = [pos[0], Number(pos[1])];
  const tls = (n, key, force = false) => {
    if ((force || isTrue(kv["over-tls"])) && n.type !== "trojan") n.tls = true;
    const sni = kv.sni || kv["tls-name"];
    if (sni) n[key] = sni;
    if (isTrue(kv["skip-cert-verify"])) n["skip-cert-verify"] = true;
    return n;
  };
  const transport = (n) => {
    if (kv.transport === "ws") {
      n.network = "ws";
      n["ws-opts"] = Object.assign({ path: kv.path || "/" }, kv.host ? { headers: { Host: kv.host } } : {});
    } else if (kv.transport === "grpc") {
      n.network = "grpc";
      n["grpc-opts"] = { "grpc-service-name": kv["grpc-service-name"] || "" };
    } else if (kv.transport === "http") {
      n.network = "http";
      n["http-opts"] = Object.assign({ path: [kv.path || "/"] }, kv.host ? { headers: { Host: [kv.host] } } : {});
    }
    return n;
  };
  switch (type) {
    case "shadowsocks": {
      const n = { name, type: "ss", server, port, cipher: pos[2], password: pos[3], udp: isTrue(kv.udp) };
      if (kv["obfs-name"]) Object.assign(n, { plugin: "obfs", "plugin-opts": { mode: kv["obfs-name"], host: kv["obfs-host"] || "" } });
      return n.cipher ? n : null;
    }
    case "shadowsocksr":
      return { name, type: "ssr", server, port, cipher: pos[2], password: pos[3], protocol: kv.protocol || "origin", "protocol-param": kv["protocol-param"] || "", obfs: kv.obfs || "plain", "obfs-param": kv["obfs-param"] || "", udp: isTrue(kv.udp) };
    case "vmess": {
      const n = transport({ name, type: "vmess", server, port, uuid: pos[3], cipher: pos[2] || "auto", alterId: Number(kv.alterid) || 0, udp: true });
      return n.uuid ? tls(n, "servername") : null;
    }
    case "vless": {
      const n = transport({ name, type: "vless", server, port, uuid: pos[2], udp: true });
      if (kv.flow) n.flow = kv.flow;
      if (kv["public-key"]) {
        n["reality-opts"] = Object.assign({ "public-key": kv["public-key"] }, kv["short-id"] ? { "short-id": kv["short-id"] } : {});
        n["client-fingerprint"] = "chrome";
      }
      return n.uuid ? tls(n, "servername", !!n["reality-opts"]) : null;
    }
    case "trojan": {
      const n = transport({ name, type: "trojan", server, port, password: pos[2], udp: true });
      return n.password ? tls(n, "sni", true) : null;
    }
    case "hysteria2": {
      const n = tls({ name, type: "hysteria2", server, port, password: pos[2] }, "sni");
      delete n.tls;
      if (kv["download-bandwidth"]) n.down = kv["download-bandwidth"] + " Mbps";
      return n.password ? n : null;
    }
    case "http":
    case "https":
    case "socks5": {
      const n = { name, type: type === "socks5" ? "socks5" : "http", server, port };
      if (pos[2]) n.username = pos[2];
      if (pos[3]) n.password = pos[3];
      if (type === "https") tls(n, "sni", true);
      return n;
    }
    default:
      return null;
  }
}

// ---------------- Quantumult X ----------------
function quanx(type, at, kv) {
  const [server, port] = hostPort(at);
  if (!port) return null;
  const name = kv.tag || `${type} ${server}:${port}`;
  const obfs = kv.obfs || "";
  const tlsOn = obfs === "wss" || obfs === "over-tls" || isTrue(kv["over-tls"]);
  const host = kv["obfs-host"] || kv["tls-host"] || "";
  const verifyOff = kv["tls-verification"] === "false";
  const ws = (n) => {
    if (obfs !== "ws" && obfs !== "wss") return n;
    n.network = "ws";
    n["ws-opts"] = Object.assign({ path: kv["obfs-uri"] || "/" }, host ? { headers: { Host: host } } : {});
    return n;
  };
  const tls = (n, key) => {
    if (!tlsOn) return n;
    if (n.type !== "trojan") n.tls = true;
    if (host) n[key] = host;
    if (verifyOff) n["skip-cert-verify"] = true;
    return n;
  };
  switch (type) {
    case "shadowsocks": {
      if (kv["ssr-protocol"]) return { name, type: "ssr", server, port, cipher: kv.method, password: kv.password, protocol: kv["ssr-protocol"], "protocol-param": kv["ssr-protocol-param"] || "", obfs: obfs || "plain", "obfs-param": host, udp: isTrue(kv["udp-relay"]) };
      const n = { name, type: "ss", server, port, cipher: kv.method, password: kv.password, udp: isTrue(kv["udp-relay"]) };
      if (obfs === "http" || obfs === "tls") Object.assign(n, { plugin: "obfs", "plugin-opts": { mode: obfs, host } });
      return n.cipher ? n : null;
    }
    case "vmess": {
      const n = { name, type: "vmess", server, port, uuid: kv.password, alterId: 0, cipher: !kv.method || kv.method === "chacha20-ietf-poly1305" ? "auto" : kv.method, udp: true };
      return n.uuid ? ws(tls(n, "servername")) : null;
    }
    case "vless": {
      const n = { name, type: "vless", server, port, uuid: kv.password, udp: true };
      if (kv["vless-flow"]) n.flow = kv["vless-flow"];
      if (kv["reality-base64-pubkey"]) {
        n.tls = true;
        n["reality-opts"] = Object.assign({ "public-key": kv["reality-base64-pubkey"] }, kv["reality-hex-shortid"] ? { "short-id": kv["reality-hex-shortid"] } : {});
        n["client-fingerprint"] = "chrome";
        if (host) n.servername = host;
      }
      return n.uuid ? ws(tls(n, "servername")) : null;
    }
    case "trojan": {
      const n = { name, type: "trojan", server, port, password: kv.password, udp: isTrue(kv["udp-relay"]) };
      if (host) n.sni = host;
      if (verifyOff) n["skip-cert-verify"] = true;
      return n.password ? ws(n) : null;
    }
    case "http":
    case "socks5": {
      const n = { name, type, server, port };
      if (kv.username) n.username = kv.username;
      if (kv.password) n.password = kv.password;
      if (isTrue(kv["over-tls"])) Object.assign(n, { tls: true }, kv["tls-host"] ? { sni: kv["tls-host"] } : {});
      if (type === "socks5") n.udp = true;
      return n;
    }
    default:
      return null;
  }
}

const SURGE_TYPES = new Set(["ss", "vmess", "trojan", "http", "https", "socks5", "socks5-tls", "snell", "tuic", "tuic-v5", "hysteria2", "anytls", "ssh"]);
const LOON_TYPES = new Set(["shadowsocks", "shadowsocksr", "vmess", "vless", "trojan", "hysteria2", "http", "https", "socks5"]);
const QUANX_TYPES = new Set(["shadowsocks", "vmess", "vless", "trojan", "http", "socks5"]);

// 一行节点 → { node, format }；不是节点行返回 null
export function parseClientLine(line) {
  line = String(line).trim();
  if (!line || /^[#;\/]/.test(line)) return null;
  // Quantumult X：类型=服务器:端口, 键=值…, tag=名字
  let m = /^([a-z0-9]+)\s*=\s*([^,=\s]+:\d+)\s*,(.*)$/i.exec(line);
  if (m && QUANX_TYPES.has(m[1].toLowerCase())) {
    const { kv } = parseArgs(tokens(m[3]));
    const node = quanx(m[1].toLowerCase(), m[2], kv);
    return node ? { node, format: "quanx" } : null;
  }
  // Surge / Loon：名字 = 类型, 服务器, 端口, …
  m = /^(.+?)\s*=\s*([A-Za-z0-9-]+)\s*,(.*)$/.exec(line);
  if (!m) return null;
  const name = m[1].trim().replace(/^"|"$/g, "");
  const rawType = m[2];
  const { pos, kv } = parseArgs(tokens(m[3]));
  if (pos.length < 2 || !/^\d+$/.test(pos[1])) return null;
  const type = rawType.toLowerCase();
  // Loon 的协议名首字母大写（Shadowsocks、VLESS、Hysteria2），参数里的密码和 UUID 是位置参数
  const positional = pos.length > 2 && !("username" in kv) && !("password" in kv) && !("encrypt-method" in kv) && !["http", "https", "socks5", "socks5-tls"].includes(type);
  const loonish = /^[A-Z]/.test(rawType) || (LOON_TYPES.has(type) && !SURGE_TYPES.has(type)) || (LOON_TYPES.has(type) && positional);
  const node = loonish ? loon(name, type, pos, kv) : SURGE_TYPES.has(type) ? surge(name, type, pos, kv) : null;
  return node && node.server && node.port ? { node, format: loonish ? "loon" : "surge" } : null;
}

// 整段文本：有 [Proxy] / [server_local] 段时只看那几段；返回 { nodes, format }
export function parseClientConfig(text) {
  const lines = String(text).split(/\r?\n/);
  const hasSections = lines.some((l) => /^\s*\[[^\]]+\]\s*$/.test(l));
  let section = "";
  const nodes = [];
  const formats = {};
  for (const raw of lines) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
    if (head) {
      section = head[1].trim().toLowerCase();
      continue;
    }
    if (hasSections && section !== "proxy" && section !== "server_local") continue;
    const r = parseClientLine(raw);
    if (!r) continue;
    nodes.push(r.node);
    formats[r.format] = (formats[r.format] || 0) + 1;
  }
  const format = Object.entries(formats).sort((a, b) => b[1] - a[1]).map((e) => e[0])[0] || "";
  return { nodes, format };
}
