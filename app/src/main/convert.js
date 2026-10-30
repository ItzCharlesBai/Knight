// 订阅内容解析：Clash / mihomo YAML 原样使用；Base64 或逐行的分享链接（ss / ssr / vmess / vless / trojan /
// hysteria2 / tuic / socks5 / http）转换成节点，再套一份最简的分组和规则
import yaml from "js-yaml";

export function parseSubscription(text) {
  text = String(text || "").replace(/^﻿/, "").trim();
  if (!text) throw new Error("订阅内容为空");

  let doc;
  try {
    doc = yaml.load(text);
  } catch {
    doc = undefined;
  }
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    if (Array.isArray(doc.proxies) || (doc["proxy-providers"] && typeof doc["proxy-providers"] === "object")) {
      return { config: doc, converted: false };
    }
    throw new Error("订阅里没有节点（缺少 proxies / proxy-providers）");
  }

  const lines = (looksLikeLinks(text) ? text : decodeBase64(text) || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const proxies = [];
  const names = new Set();
  for (const line of lines) {
    let node;
    try {
      node = parseLink(line);
    } catch {
      node = null;
    }
    if (!node) continue;
    let name = node.name || `${node.type} ${node.server}:${node.port}`;
    for (let i = 2; names.has(name); i++) name = `${node.name} ${i}`;
    node.name = name;
    names.add(name);
    proxies.push(node);
  }
  if (!proxies.length) throw new Error("无法识别的订阅格式：既不是 Clash 配置，也没有可用的分享链接");
  return { config: wrapProxies(proxies), converted: true };
}

const looksLikeLinks = (text) => /^[a-z][a-z0-9+.-]*:\/\//im.test(text);

export function decodeBase64(text) {
  const s = String(text).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  return Buffer.from(s, "base64").toString("utf8");
}

// 只有节点链接时使用的最简配置：手动选择 + 自动选择，国内直连，其余走代理
export function wrapProxies(proxies) {
  const names = proxies.map((p) => p.name);
  return {
    proxies,
    "proxy-groups": [
      { name: "节点选择", type: "select", proxies: ["自动选择", ...names, "DIRECT"] },
      { name: "自动选择", type: "url-test", proxies: names, url: "https://www.gstatic.com/generate_204", interval: 300, tolerance: 50, lazy: true },
    ],
    rules: ["GEOSITE,private,DIRECT", "GEOIP,private,DIRECT,no-resolve", "GEOSITE,cn,DIRECT", "GEOIP,CN,DIRECT", "MATCH,节点选择"],
  };
}

function parseLink(line) {
  const scheme = line.slice(0, line.indexOf("://")).toLowerCase();
  switch (scheme) {
    case "ss":
      return parseSS(line);
    case "ssr":
      return parseSSR(line);
    case "vmess":
      return parseVmess(line);
    case "vless":
      return parseVless(line);
    case "trojan":
      return parseTrojan(line);
    case "hysteria2":
    case "hy2":
      return parseHysteria2(line);
    case "tuic":
      return parseTuic(line);
    case "socks":
    case "socks5":
    case "http":
    case "https":
      return parseSocksHttp(line, scheme);
    default:
      return null;
  }
}

const decodeName = (hash) => {
  if (!hash) return "";
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return hash.replace(/^#/, "");
  }
};
const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, "");
const bool = (v) => v === "1" || v === "true";
const portOf = (url, fallback) => Number(url.port || fallback);

function parseSS(line) {
  let body = line.slice(5);
  const hashAt = body.indexOf("#");
  const name = hashAt >= 0 ? decodeName(body.slice(hashAt)) : "";
  if (hashAt >= 0) body = body.slice(0, hashAt);
  // 旧格式 ss://base64(method:password@host:port)
  if (!body.includes("@")) body = decodeBase64(body.split("?")[0]) + (body.includes("?") ? "?" + body.split("?")[1] : "");
  const url = new URL("ss://" + body);
  let userinfo = decodeURIComponent(url.username);
  if (!userinfo.includes(":")) userinfo = decodeBase64(userinfo) || "";
  if (url.password) userinfo += ":" + decodeURIComponent(url.password);
  const split = userinfo.indexOf(":");
  const node = { name, type: "ss", server: hostOf(url), port: portOf(url), cipher: userinfo.slice(0, split), password: userinfo.slice(split + 1), udp: true };
  const plugin = url.searchParams.get("plugin");
  if (plugin) {
    const [kind, ...opts] = plugin.split(";");
    const kv = Object.fromEntries(opts.map((o) => [o.split("=")[0], o.split("=").slice(1).join("=") || true]));
    if (/obfs/.test(kind)) {
      node.plugin = "obfs";
      node["plugin-opts"] = { mode: kv.obfs || "http", host: kv["obfs-host"] || "" };
    } else if (/v2ray/.test(kind)) {
      node.plugin = "v2ray-plugin";
      node["plugin-opts"] = { mode: kv.mode || "websocket", tls: kv.tls === true, host: kv.host || "", path: kv.path || "/" };
    }
  }
  return node.server && node.port && node.cipher ? node : null;
}

function parseSSR(line) {
  const text = decodeBase64(line.slice(6));
  if (!text) return null;
  const [main, query = ""] = text.split("/?");
  const parts = main.split(":");
  const password = decodeBase64(parts.pop());
  const [obfs, cipher, protocol] = [parts.pop(), parts.pop(), parts.pop()];
  const port = Number(parts.pop());
  const server = parts.join(":");
  const q = new URLSearchParams(query);
  const b = (k) => (q.get(k) ? decodeBase64(q.get(k)) : "");
  return { name: b("remarks"), type: "ssr", server, port, cipher, password, protocol, obfs, "protocol-param": b("protoparam"), "obfs-param": b("obfsparam"), udp: true };
}

function transportOpts(node, network, get) {
  const host = get("host");
  const path = get("path");
  if (network === "ws") node["ws-opts"] = Object.assign({ path: path || "/" }, host ? { headers: { Host: host } } : {});
  else if (network === "grpc") node["grpc-opts"] = { "grpc-service-name": get("serviceName") || path || "" };
  else if (network === "h2") node["h2-opts"] = Object.assign({ path: path || "/" }, host ? { host: [host] } : {});
  else if (network === "http") node["http-opts"] = Object.assign({ path: [path || "/"] }, host ? { headers: { Host: [host] } } : {});
  else if (network === "httpupgrade") {
    node.network = "ws";
    node["ws-opts"] = Object.assign({ path: path || "/", "v2ray-http-upgrade": true }, host ? { headers: { Host: host } } : {});
  }
}

function parseVmess(line) {
  const json = JSON.parse(decodeBase64(line.slice(8)));
  const network = json.net || "tcp";
  const node = {
    name: json.ps || "",
    type: "vmess",
    server: json.add,
    port: Number(json.port),
    uuid: json.id,
    alterId: Number(json.aid || 0),
    cipher: json.scy || "auto",
    udp: true,
    network: network === "tcp" && json.type === "http" ? "http" : network,
  };
  if (json.tls === "tls") {
    node.tls = true;
    if (json.sni) node.servername = json.sni;
    if (json.fp) node["client-fingerprint"] = json.fp;
    if (json.alpn) node.alpn = String(json.alpn).split(",");
  }
  if (node.network === "tcp") delete node.network;
  else transportOpts(node, node.network, (k) => (k === "serviceName" ? json.path : json[k]));
  return node.server && node.port && node.uuid ? node : null;
}

function tlsParams(node, q) {
  const security = q.get("security");
  if (q.get("sni") || q.get("peer")) node.servername = q.get("sni") || q.get("peer");
  if (q.get("fp")) node["client-fingerprint"] = q.get("fp");
  if (q.get("alpn")) node.alpn = q.get("alpn").split(",");
  if (bool(q.get("allowInsecure")) || bool(q.get("insecure"))) node["skip-cert-verify"] = true;
  if (security === "reality") {
    node["reality-opts"] = { "public-key": q.get("pbk") || "", "short-id": q.get("sid") || "" };
    if (!node["client-fingerprint"]) node["client-fingerprint"] = "chrome";
  }
}

function parseVless(line) {
  const url = new URL(line);
  const q = url.searchParams;
  const network = q.get("type") || "tcp";
  const node = { name: decodeName(url.hash), type: "vless", server: hostOf(url), port: portOf(url, 443), uuid: decodeURIComponent(url.username), udp: true };
  const security = q.get("security");
  if (security === "tls" || security === "reality") node.tls = true;
  tlsParams(node, q);
  if (q.get("flow")) node.flow = q.get("flow");
  if (q.get("encryption") && q.get("encryption") !== "none") node.encryption = q.get("encryption");
  if (network !== "tcp") {
    node.network = network;
    transportOpts(node, network, (k) => q.get(k));
  }
  return node.server && node.uuid ? node : null;
}

function parseTrojan(line) {
  const url = new URL(line);
  const q = url.searchParams;
  const node = { name: decodeName(url.hash), type: "trojan", server: hostOf(url), port: portOf(url, 443), password: decodeURIComponent(url.username), udp: true };
  tlsParams(node, q);
  const network = q.get("type");
  if (network && network !== "tcp") {
    node.network = network;
    transportOpts(node, network, (k) => q.get(k));
  }
  return node.server && node.password ? node : null;
}

function parseHysteria2(line) {
  const url = new URL(line.replace(/^hy2:/i, "hysteria2:"));
  const q = url.searchParams;
  const auth = decodeURIComponent(url.username) + (url.password ? ":" + decodeURIComponent(url.password) : "");
  const node = { name: decodeName(url.hash), type: "hysteria2", server: hostOf(url), port: portOf(url, 443), password: auth };
  if (q.get("sni")) node.sni = q.get("sni");
  if (bool(q.get("insecure"))) node["skip-cert-verify"] = true;
  if (q.get("obfs")) {
    node.obfs = q.get("obfs");
    node["obfs-password"] = q.get("obfs-password") || "";
  }
  if (q.get("mport")) node.ports = q.get("mport");
  return node.server ? node : null;
}

function parseTuic(line) {
  const url = new URL(line);
  const q = url.searchParams;
  const node = {
    name: decodeName(url.hash),
    type: "tuic",
    server: hostOf(url),
    port: portOf(url, 443),
    uuid: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    "congestion-controller": q.get("congestion_control") || "bbr",
    "udp-relay-mode": q.get("udp_relay_mode") || "native",
  };
  if (q.get("sni")) node.sni = q.get("sni");
  if (q.get("alpn")) node.alpn = q.get("alpn").split(",");
  if (bool(q.get("allow_insecure")) || bool(q.get("insecure"))) node["skip-cert-verify"] = true;
  return node.server && node.uuid ? node : null;
}

function parseSocksHttp(line, scheme) {
  const url = new URL(line);
  const type = scheme.startsWith("socks") ? "socks5" : "http";
  const node = { name: decodeName(url.hash), type, server: hostOf(url), port: portOf(url, type === "http" ? (scheme === "https" ? 443 : 80) : 1080) };
  if (url.username) node.username = decodeURIComponent(url.username);
  if (url.password) node.password = decodeURIComponent(url.password);
  if (scheme === "https") node.tls = true;
  if (type === "socks5") node.udp = true;
  return node.server ? node : null;
}

// subscription-userinfo: upload=1; download=2; total=3; expire=4
export function parseUserinfo(header) {
  if (!header) return null;
  const info = {};
  for (const part of String(header).split(";")) {
    const [k, v] = part.split("=").map((s) => s && s.trim());
    if (k && v && /^\d+(\.\d+)?$/.test(v)) info[k] = Number(v);
  }
  return Object.keys(info).length ? info : null;
}

// Content-Disposition: attachment; filename*=UTF-8''%E6%9C%BA%E5%9C%BA  或 filename="name"
export function filenameFromDisposition(header) {
  if (!header) return "";
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      /* 忽略，继续尝试普通 filename */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : "";
}
