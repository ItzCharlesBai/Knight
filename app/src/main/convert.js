// 订阅内容解析：Clash / mihomo YAML 原样使用；Base64 或逐行的分享链接（ss / ssr / vmess / vless / trojan / hysteria2 /
// hysteria / tuic / anytls / naive / juicity / mieru / wireguard / socks5 / http）、sing-box 配置、SIP008、
// Surge / Loon / Quantumult X 的节点和配置文件转换成节点，再套一份最简的分组和规则
import yaml from "js-yaml";
import { parseClientConfig } from "./clients.js";
import { buildTemplate } from "./nodes.js";
import { fromOutbound } from "./singbox.js";

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
      return { config: doc, converted: false, format: "clash" };
    }
    // sing-box 配置：取其中的出站节点
    if (Array.isArray(doc.outbounds)) {
      const nodes = doc.outbounds.concat(doc.endpoints || []).map(fromOutbound).filter(Boolean);
      if (!nodes.length) throw new Error("sing-box 配置里没有可识别的节点");
      return { config: wrapProxies(uniqueNames(nodes)), converted: true, format: "singbox" };
    }
    // SIP008（Shadowsocks 的 JSON 订阅）
    if (Array.isArray(doc.servers) && doc.servers.some((x) => x && x.method)) {
      const nodes = doc.servers
        .filter((x) => x && x.server && x.method)
        .map((x) => Object.assign({ name: x.remarks || `${x.server}:${x.server_port}`, type: "ss", server: x.server, port: Number(x.server_port), cipher: x.method, password: x.password, udp: true }, sip003(x.plugin, x.plugin_opts)));
      return { config: wrapProxies(uniqueNames(nodes)), converted: true, format: "sip008" };
    }
    throw new Error("订阅里没有节点（缺少 proxies / proxy-providers）");
  }

  const body = looksLikeLinks(text) ? text : decodeBase64(text) || "";
  const proxies = parseLinks(body);
  if (proxies.length) return { config: wrapProxies(proxies), converted: true, format: "links" };
  // Surge / Loon / Quantumult X（整份配置或者只有节点行，也可能是 Base64）
  for (const candidate of [text, body]) {
    const client = parseClientConfig(candidate);
    if (client.nodes.length) return { config: wrapProxies(uniqueNames(client.nodes)), converted: true, format: client.format };
  }
  throw new Error("无法识别的订阅格式：既不是 Clash 配置，也没有可用的分享链接或 Surge / Loon / Quantumult X 节点");
}

// 逐行解析分享链接，认不出的行跳过
export function parseLinks(text) {
  const nodes = [];
  for (const line of String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    try {
      const node = parseLink(line);
      if (node) nodes.push(node);
    } catch {
      /* 跳过坏链接 */
    }
  }
  return uniqueNames(nodes);
}

// 没有名字的补上，重名的加序号
function uniqueNames(nodes) {
  const names = new Set();
  return nodes.map((node) => {
    const base = node.name || `${node.type} ${node.server}:${node.port}`;
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
    names.add(name);
    return Object.assign(node, { name });
  });
}

function sip003(plugin, opts) {
  if (!plugin) return {};
  const kv = Object.fromEntries(String(opts || "").split(";").filter(Boolean).map((o) => [o.split("=")[0], o.split("=").slice(1).join("=") || true]));
  if (/obfs/.test(plugin)) return { plugin: "obfs", "plugin-opts": { mode: kv.obfs || "http", host: kv["obfs-host"] || "" } };
  if (/v2ray/.test(plugin)) return { plugin: "v2ray-plugin", "plugin-opts": { mode: kv.mode || "websocket", tls: kv.tls === true, host: kv.host || "", path: kv.path || "/" } };
  return {};
}

const looksLikeLinks = (text) => /^[a-z][a-z0-9+.-]*:\/\//im.test(text);

export function decodeBase64(text) {
  const s = String(text).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  return Buffer.from(s, "base64").toString("utf8");
}

// 只有节点链接时使用的最简配置：手动选择 + 自动选择，国内直连，其余走代理
export function wrapProxies(proxies) {
  return Object.assign({ proxies }, buildTemplate("simple", proxies.map((p) => p.name)));
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
    case "hysteria":
    case "hy":
      return parseHysteria(line);
    case "anytls":
      return parseAnyTLS(line);
    case "naive+https":
    case "naive+quic":
      return parseNaive(line, scheme);
    case "wireguard":
    case "wg":
      return parseWireGuard(line);
    case "juicity":
      return parseJuicity(line);
    case "mierus":
      return parseMieru(line);
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
  // 明文 method:password（SIP022 / 2022 系列）或 Base64(method:password)（SIP002）
  let userinfo = decodeURIComponent(url.username);
  if (url.password) userinfo += ":" + decodeURIComponent(url.password);
  else if (!userinfo.includes(":")) userinfo = decodeBase64(userinfo) || "";
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

// 分享链接里的 xhttp extra（Xray 的 JSON）→ mihomo 的 xhttp-opts 字段
const XHTTP_EXTRA = {
  headers: "headers",
  noGRPCHeader: "no-grpc-header",
  xPaddingBytes: "x-padding-bytes",
  scMaxEachPostBytes: "sc-max-each-post-bytes",
  scMinPostsIntervalMs: "sc-min-posts-interval-ms",
};
const XMUX = {
  maxConcurrency: "max-concurrency",
  maxConnections: "max-connections",
  cMaxReuseTimes: "c-max-reuse-times",
  hMaxRequestTimes: "h-max-request-times",
  hMaxReusableSecs: "h-max-reusable-secs",
  hKeepAlivePeriod: "h-keep-alive-period",
};
const pickKeys = (src, map) => Object.fromEntries(Object.entries(map).filter(([k]) => src && src[k] !== undefined).map(([k, v]) => [v, src[k]]));

function xhttpOpts(path, host, mode, extraText) {
  const opts = { path: path || "/" };
  if (host) opts.host = host;
  if (mode && mode !== "auto") opts.mode = mode;
  if (extraText) {
    let extra = null;
    try {
      extra = JSON.parse(extraText);
    } catch {
      extra = null;
    }
    if (extra && typeof extra === "object") {
      Object.assign(opts, pickKeys(extra, XHTTP_EXTRA));
      if (extra.xmux) opts["reuse-settings"] = pickKeys(extra.xmux, XMUX);
      const d = extra.downloadSettings;
      if (d && typeof d === "object") {
        const ds = { path: (d.xhttpSettings || {}).path || opts.path };
        if ((d.xhttpSettings || {}).host) ds.host = d.xhttpSettings.host;
        if (d.address) ds.server = d.address;
        if (d.port) ds.port = Number(d.port);
        if (d.security === "tls" || d.security === "reality") ds.tls = true;
        const t = d.tlsSettings || d.realitySettings || {};
        if (t.serverName) ds.servername = t.serverName;
        if (t.fingerprint) ds["client-fingerprint"] = t.fingerprint;
        if (d.security === "reality") ds["reality-opts"] = { "public-key": t.publicKey || t.password || "", "short-id": t.shortId || "" };
        opts["download-settings"] = ds;
      }
      // 原样留一份，导出分享链接、交给 Xray 时用（mihomo 会忽略不认识的字段）
      opts["xray-extra"] = extraText;
    }
  }
  return opts;
}

// 传输层：tcp / ws / httpupgrade / grpc / h2 / http / xhttp / mkcp / quic
function transportOpts(node, network, get) {
  const host = get("host");
  const path = get("path");
  if (network === "ws") node["ws-opts"] = Object.assign({ path: path || "/" }, host ? { headers: { Host: host } } : {});
  else if (network === "grpc") {
    node["grpc-opts"] = { "grpc-service-name": get("serviceName") || path || "" };
    if (get("mode") === "multi") node["grpc-opts"]["grpc-mode"] = "multi";
    if (get("authority")) node["grpc-opts"].authority = get("authority");
  } else if (network === "h2") node["h2-opts"] = Object.assign({ path: path || "/" }, host ? { host: host.split(",") } : {});
  else if (network === "http") node["http-opts"] = Object.assign({ path: [path || "/"] }, host ? { headers: { Host: host.split(",") } } : {});
  else if (network === "httpupgrade") {
    node.network = "ws";
    node["ws-opts"] = Object.assign({ path: path || "/", "v2ray-http-upgrade": true }, host ? { headers: { Host: host } } : {});
  } else if (network === "xhttp" || network === "splithttp") {
    node.network = "xhttp";
    node["xhttp-opts"] = xhttpOpts(path, host, get("mode"), get("extra"));
  } else if (network === "kcp" || network === "mkcp") {
    node.network = "mkcp";
    node["mkcp-opts"] = Object.assign({}, get("headerType") && get("headerType") !== "none" ? { header: get("headerType") } : {}, get("seed") || path ? { seed: get("seed") || path } : {});
  } else if (network === "quic") {
    node["quic-opts"] = Object.assign({}, get("quicSecurity") ? { security: get("quicSecurity") } : {}, get("key") ? { key: get("key") } : {}, get("headerType") ? { header: get("headerType") } : {});
  }
}

// Shadowrocket 的 vmess 写法：vmess://Base64(cipher:uuid@host:port)?remarks=…&obfs=websocket&tls=1&peer=…&path=…&obfsParam=…
function parseShadowrocketVmess(line) {
  const [b64, query = ""] = line.slice(8).split("?");
  const m = /^([\w-]+):([\w-]+)@(.+):(\d+)$/.exec(decodeBase64(b64.split("#")[0]) || "");
  if (!m) return null;
  const q = new URLSearchParams(query.split("#")[0]);
  const node = { name: q.get("remarks") || decodeName(line.includes("#") ? line.slice(line.indexOf("#")) : ""), type: "vmess", server: m[3].replace(/^\[|\]$/g, ""), port: Number(m[4]), uuid: m[2], alterId: Number(q.get("alterId") || 0), cipher: m[1] === "none" ? "none" : "auto", udp: true };
  if (q.get("tls") === "1") {
    node.tls = true;
    if (q.get("peer")) node.servername = q.get("peer");
    if (bool(q.get("allowInsecure"))) node["skip-cert-verify"] = true;
  }
  if (q.get("obfs") === "websocket") {
    node.network = "ws";
    node["ws-opts"] = Object.assign({ path: q.get("path") || "/" }, q.get("obfsParam") ? { headers: { Host: q.get("obfsParam") } } : {});
  } else if (q.get("obfs") === "grpc") {
    node.network = "grpc";
    node["grpc-opts"] = { "grpc-service-name": q.get("path") || "" };
  }
  return node;
}

function parseVmess(line) {
  const decoded = decodeBase64(line.slice(8).split("?")[0].split("#")[0]) || "";
  if (!decoded.trim().startsWith("{")) return parseShadowrocketVmess(line);
  const json = JSON.parse(decoded);
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
    if (json.allowInsecure === true || json.allowInsecure === "1" || json.allowInsecure === "true") node["skip-cert-verify"] = true;
  }
  if (node.network === "tcp") delete node.network;
  else transportOpts(node, node.network, (k) => (k === "serviceName" ? json.path : k === "headerType" ? json.type : json[k]));
  return node.server && node.port && node.uuid ? node : null;
}

// TLS / REALITY / ECH 参数（vless、trojan 共用）
function tlsParams(node, q) {
  const security = q.get("security");
  if (q.get("sni") || q.get("peer")) node.servername = q.get("sni") || q.get("peer");
  if (q.get("fp")) node["client-fingerprint"] = q.get("fp");
  if (q.get("alpn")) node.alpn = q.get("alpn").split(",");
  if (bool(q.get("allowInsecure")) || bool(q.get("insecure"))) node["skip-cert-verify"] = true;
  if (q.get("ech")) node["ech-opts"] = { enable: true, config: q.get("ech") };
  if (security === "reality") {
    const reality = { "public-key": q.get("pbk") || "", "short-id": q.get("sid") || "" };
    // spiderX、ML-DSA-65 校验只有 Xray 用得上，mihomo 会忽略
    if (q.get("spx")) reality["spider-x"] = q.get("spx");
    if (q.get("pqv")) reality["mldsa65-verify"] = q.get("pqv");
    node["reality-opts"] = reality;
    if (!node["client-fingerprint"]) node["client-fingerprint"] = "chrome";
  }
}

function parseVless(line) {
  const url = new URL(line);
  const q = url.searchParams;
  let network = (q.get("type") || "tcp").toLowerCase();
  if (network === "raw") network = "tcp";
  if (network === "tcp" && q.get("headerType") === "http") network = "http";
  const node = { name: decodeName(url.hash), type: "vless", server: hostOf(url), port: portOf(url, 443), uuid: decodeURIComponent(url.username), udp: true };
  const security = q.get("security");
  if (security === "tls" || security === "reality") node.tls = true;
  tlsParams(node, q);
  if (q.get("flow")) node.flow = q.get("flow");
  // VLESS Encryption（mlkem768x25519plus…）；none 表示不加密
  if (q.get("encryption") && q.get("encryption") !== "none") node.encryption = q.get("encryption");
  if (q.get("packetEncoding")) node["packet-encoding"] = q.get("packetEncoding");
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
  // 自签证书的服务器：固定证书指纹
  if (q.get("pinSHA256")) node.fingerprint = q.get("pinSHA256").replace(/:/g, "").toLowerCase();
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

function parseHysteria(line) {
  const url = new URL(line.replace(/^hy:/i, "hysteria:"));
  const q = url.searchParams;
  const node = { name: decodeName(url.hash), type: "hysteria", server: hostOf(url), port: portOf(url, 443), protocol: q.get("protocol") || "udp" };
  if (q.get("auth")) node["auth-str"] = q.get("auth");
  if (q.get("peer") || q.get("sni")) node.sni = q.get("peer") || q.get("sni");
  if (bool(q.get("insecure"))) node["skip-cert-verify"] = true;
  if (q.get("upmbps")) node.up = q.get("upmbps") + " Mbps";
  if (q.get("downmbps")) node.down = q.get("downmbps") + " Mbps";
  if (q.get("alpn")) node.alpn = q.get("alpn").split(",");
  if (q.get("obfsParam") || q.get("obfs")) node.obfs = q.get("obfsParam") || q.get("obfs");
  if (q.get("mport")) node.ports = q.get("mport");
  return node.server ? node : null;
}

function parseAnyTLS(line) {
  const url = new URL(line);
  const q = url.searchParams;
  const node = { name: decodeName(url.hash), type: "anytls", server: hostOf(url), port: portOf(url, 443), password: decodeURIComponent(url.username), udp: true };
  if (q.get("sni")) node.sni = q.get("sni");
  if (bool(q.get("insecure")) || bool(q.get("allowInsecure"))) node["skip-cert-verify"] = true;
  if (q.get("fp")) node["client-fingerprint"] = q.get("fp");
  return node.server && node.password ? node : null;
}

// NaiveProxy 只有 sing-box 支持；用 mihomo 时由 sing-box 搭配运行
function parseNaive(line, scheme) {
  const url = new URL(line.replace(/^naive\+/i, ""));
  const node = { name: decodeName(url.hash), type: "naive", server: hostOf(url), port: portOf(url, 443), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
  if (scheme === "naive+quic") node.quic = true;
  return node.server ? node : null;
}

function parseWireGuard(line) {
  const url = new URL(line.replace(/^wg:/i, "wireguard:"));
  const q = url.searchParams;
  const address = (q.get("address") || q.get("ip") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const node = {
    name: decodeName(url.hash),
    type: "wireguard",
    server: hostOf(url),
    port: portOf(url, 51820),
    "private-key": decodeURIComponent(url.username),
    "public-key": q.get("publickey") || q.get("public-key") || "",
    udp: true,
  };
  const v4 = address.find((a) => !a.includes(":"));
  const v6 = address.find((a) => a.includes(":"));
  if (v4) node.ip = v4.replace(/\/32$/, "");
  if (v6) node.ipv6 = v6.replace(/\/128$/, "");
  if (q.get("presharedkey")) node["pre-shared-key"] = q.get("presharedkey");
  if (q.get("reserved")) node.reserved = q.get("reserved").split(",").map(Number);
  if (q.get("mtu")) node.mtu = Number(q.get("mtu"));
  return node.server && node["private-key"] && node["public-key"] ? node : null;
}

// Juicity 只有它自己的内核支持：由 Juicity 内核搭配运行
function parseJuicity(line) {
  const url = new URL(line);
  const q = url.searchParams;
  const node = { name: decodeName(url.hash), type: "juicity", server: hostOf(url), port: portOf(url, 443), uuid: decodeURIComponent(url.username), password: decodeURIComponent(url.password), "congestion-controller": q.get("congestion_control") || "bbr", udp: true };
  if (q.get("sni")) node.sni = q.get("sni");
  if (bool(q.get("allow_insecure"))) node["skip-cert-verify"] = true;
  if (q.get("pinned_certchain_sha256")) node["pinned-certchain-sha256"] = q.get("pinned_certchain_sha256");
  return node.server && node.uuid ? node : null;
}

// Mieru 的简单分享链接：mierus://用户:密码@服务器?port=…&protocol=TCP&multiplexing=…（可以有多组端口和协议，取第一组 TCP）
function parseMieru(line) {
  const url = new URL(line);
  const q = url.searchParams;
  const ports = q.getAll("port");
  const protocols = q.getAll("protocol");
  let i = protocols.findIndex((p) => p.toUpperCase() === "TCP");
  if (i < 0) i = 0;
  const port = ports[i] || ports[0] || "";
  const node = { name: decodeName(url.hash) || q.get("profile") || "", type: "mieru", server: hostOf(url), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), transport: (protocols[i] || "TCP").toUpperCase(), udp: true };
  if (/^\d+-\d+$/.test(port)) node["port-range"] = port;
  else node.port = Number(port);
  if (q.get("multiplexing")) node.multiplexing = q.get("multiplexing");
  return node.server && node.username && (node.port || node["port-range"]) ? node : null;
}

function parseSocksHttp(line, scheme) {
  const url = new URL(line);
  const type = scheme.startsWith("socks") ? "socks5" : "http";
  const node = { name: decodeName(url.hash), type, server: hostOf(url), port: portOf(url, type === "http" ? (scheme === "https" ? 443 : 80) : 1080) };
  if (url.username) node.username = decodeURIComponent(url.username);
  if (url.password) node.password = decodeURIComponent(url.password);
  // v2rayN 的写法：socks://Base64(用户:密码)@服务器:端口
  if (node.username && !url.password) {
    const plain = decodeBase64(node.username);
    if (plain && /^[^:]+:.*$/.test(plain) && /^[\x20-\x7e]+$/.test(plain)) {
      node.username = plain.slice(0, plain.indexOf(":"));
      node.password = plain.slice(plain.indexOf(":") + 1);
    }
  }
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
