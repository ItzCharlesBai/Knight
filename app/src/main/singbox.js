// Clash / mihomo 配置 → sing-box 配置（按 sing-box 1.14 的格式）
// 节点、分组、规则（含防泄露脚本加上的规则）逐条转换；DNS 不照搬 Clash 的写法，按防泄露设置直接生成等价的 sing-box DNS
import yaml from "js-yaml";

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);
const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
const seconds = (v) => (v ? (/^\d+$/.test(String(v)) ? `${v}s` : String(v)) : undefined);

// ============================== 节点 ==============================
function tlsOf(n, force = false) {
  if (!force && n.tls !== true) return undefined;
  const tls = { enabled: true };
  const sni = n.servername || n.sni;
  if (sni) tls.server_name = sni;
  if (n["skip-cert-verify"]) tls.insecure = true;
  if (n["disable-sni"]) tls.disable_sni = true;
  if (list(n.alpn).length) tls.alpn = list(n.alpn);
  if (n["client-fingerprint"]) tls.utls = { enabled: true, fingerprint: n["client-fingerprint"] };
  const reality = n["reality-opts"];
  if (isMap(reality)) {
    tls.reality = { enabled: true, public_key: reality["public-key"] || "", short_id: reality["short-id"] || "" };
    if (!tls.utls) tls.utls = { enabled: true, fingerprint: "chrome" };
  }
  if (isMap(n["ech-opts"]) && n["ech-opts"].enable) tls.ech = { enabled: true };
  return tls;
}

// 返回 sing-box transport；不支持的传输方式返回 { error }
function transportOf(n) {
  const net = n.network;
  if (!net || net === "tcp") return undefined;
  if (net === "ws") {
    const o = n["ws-opts"] || {};
    const headers = Object.assign({}, o.headers);
    if (o["v2ray-http-upgrade"]) {
      const host = headers.Host || headers.host;
      delete headers.Host;
      delete headers.host;
      return { type: "httpupgrade", path: o.path || "/", host, headers: Object.keys(headers).length ? headers : undefined };
    }
    return {
      type: "ws",
      path: o.path || "/",
      headers: Object.keys(headers).length ? headers : undefined,
      max_early_data: num(o["max-early-data"]),
      early_data_header_name: o["early-data-header-name"],
    };
  }
  if (net === "grpc") return { type: "grpc", service_name: (n["grpc-opts"] || {})["grpc-service-name"] || "" };
  if (net === "h2") {
    const o = n["h2-opts"] || {};
    return { type: "http", host: list(o.host).length ? list(o.host) : undefined, path: o.path || "/" };
  }
  if (net === "http") {
    const o = n["http-opts"] || {};
    return { type: "http", method: o.method, path: list(o.path)[0] || "/", headers: o.headers };
  }
  return { error: `sing-box 不支持 ${net} 传输` };
}

const mbps = (v) => {
  const m = /^\s*([\d.]+)/.exec(String(v ?? ""));
  return m ? Number(m[1]) : undefined;
};
// "443,8443-9000" → ["443:443", "8443:9000"]
const portRanges = (v) =>
  v
    ? String(v)
        .split(/[,/]/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => (p.includes("-") ? p.replace("-", ":") : `${p}:${p}`))
    : undefined;

const UDP_OPTIONAL = new Set(["ss", "vmess", "vless", "trojan", "socks5", "anytls"]);

// Clash 节点 → { outbound } | { endpoint } | { error }
export function toOutbound(n) {
  if (!isMap(n) || !n.name || !n.type) return { error: "节点格式不对" };
  const base = { tag: n.name, server: n.server, server_port: num(n.port) };
  if (n.tfo) base.tcp_fast_open = true;
  if (n["dialer-proxy"]) base.detour = n["dialer-proxy"];
  if (n.udp === false && UDP_OPTIONAL.has(n.type)) base.network = "tcp";
  const transport = transportOf(n);
  if (transport && transport.error) return { error: transport.error };
  const out = (type, fields) => ({ outbound: Object.assign({ type }, base, fields) });

  switch (n.type) {
    case "ss": {
      const fields = { method: n.cipher, password: String(n.password ?? "") };
      const opts = n["plugin-opts"] || {};
      if (n.plugin === "obfs") {
        fields.plugin = "obfs-local";
        fields.plugin_opts = `obfs=${opts.mode || "http"}` + (opts.host ? `;obfs-host=${opts.host}` : "");
      } else if (n.plugin === "v2ray-plugin") {
        fields.plugin = "v2ray-plugin";
        fields.plugin_opts = [`mode=${opts.mode || "websocket"}`, opts.host && `host=${opts.host}`, opts.path && `path=${opts.path}`, opts.tls && "tls", opts.mux === false ? "" : null]
          .filter(Boolean)
          .join(";");
      } else if (n.plugin) {
        return { error: `sing-box 不支持 ${n.plugin} 插件` };
      }
      if (n["udp-over-tcp"]) fields.udp_over_tcp = true;
      if (isMap(n.smux) && n.smux.enabled) fields.multiplex = { enabled: true, protocol: n.smux.protocol || "h2mux", max_connections: num(n.smux["max-connections"]), padding: n.smux.padding || undefined };
      return out("shadowsocks", fields);
    }
    case "vmess":
      return out("vmess", {
        uuid: n.uuid,
        security: n.cipher || "auto",
        alter_id: num(n.alterId) || 0,
        global_padding: n["global-padding"] || undefined,
        authenticated_length: n["authenticated-length"] || undefined,
        packet_encoding: n["packet-encoding"] || (n.xudp ? "xudp" : undefined),
        tls: tlsOf(n),
        transport,
      });
    case "vless":
      if (n.encryption && n.encryption !== "none") return { error: "sing-box 不支持 VLESS encryption" };
      return out("vless", { uuid: n.uuid, flow: n.flow || undefined, packet_encoding: n["packet-encoding"] || undefined, tls: tlsOf(n), transport });
    case "trojan":
      return out("trojan", { password: String(n.password ?? ""), tls: tlsOf(n, true), transport });
    case "hysteria2":
      return out("hysteria2", {
        password: String(n.password ?? n.auth ?? ""),
        server_ports: portRanges(n.ports),
        hop_interval: seconds(n["hop-interval"]),
        up_mbps: mbps(n.up),
        down_mbps: mbps(n.down),
        obfs: n.obfs ? { type: n.obfs, password: n["obfs-password"] || "" } : undefined,
        tls: tlsOf(n, true),
      });
    case "hysteria":
      if (n.protocol && n.protocol !== "udp") return { error: `sing-box 不支持 Hysteria ${n.protocol} 模式` };
      return out("hysteria", {
        auth_str: n["auth-str"] || n.auth_str || undefined,
        obfs: n.obfs || undefined,
        server_ports: portRanges(n.ports),
        up_mbps: mbps(n.up) || 10,
        down_mbps: mbps(n.down) || 50,
        tls: tlsOf(n, true),
      });
    case "tuic":
      if (n.token) return { error: "sing-box 只支持 TUIC v5" };
      return out("tuic", {
        uuid: n.uuid,
        password: String(n.password ?? ""),
        congestion_control: n["congestion-controller"] || undefined,
        udp_relay_mode: n["udp-relay-mode"] || undefined,
        zero_rtt_handshake: n["reduce-rtt"] || undefined,
        heartbeat: n["heartbeat-interval"] ? `${n["heartbeat-interval"]}ms` : undefined,
        tls: Object.assign(tlsOf(n, true), list(n.alpn).length ? {} : { alpn: ["h3"] }),
      });
    case "anytls":
      return out("anytls", { password: String(n.password ?? ""), tls: tlsOf(n, true) });
    case "socks5":
      if (n.tls) return { error: "sing-box 的 SOCKS 不支持 TLS" };
      return out("socks", { version: "5", username: n.username, password: n.password });
    case "http":
      return out("http", { username: n.username, password: n.password, headers: n.headers, tls: tlsOf(n) });
    case "ssh":
      return out("ssh", {
        user: n.username || "root",
        password: n.password,
        private_key: n["private-key"],
        private_key_passphrase: n["private-key-passphrase"],
        host_key: list(n["host-key"]).length ? list(n["host-key"]) : undefined,
        host_key_algorithms: list(n["host-key-algorithms"]).length ? list(n["host-key-algorithms"]) : undefined,
      });
    case "naive":
      return out("naive", {
        username: n.username,
        password: n.password,
        quic: n.quic || undefined,
        extra_headers: n["extra-headers"],
        tls: tlsOf(Object.assign({}, n, { sni: n.sni || n.server }), true),
      });
    case "wireguard": {
      if (Array.isArray(n.peers) && n.peers.length > 1) return { error: "sing-box 转换暂不支持多个 WireGuard peer" };
      const peer = Array.isArray(n.peers) && n.peers[0] ? n.peers[0] : n;
      const address = [n.ip && (n.ip.includes("/") ? n.ip : n.ip + "/32"), n.ipv6 && (n.ipv6.includes("/") ? n.ipv6 : n.ipv6 + "/128")].filter(Boolean);
      return {
        endpoint: {
          type: "wireguard",
          tag: n.name,
          address,
          private_key: n["private-key"],
          mtu: num(n.mtu),
          peers: [
            {
              address: peer.server || n.server,
              port: num(peer.port || n.port),
              public_key: peer["public-key"],
              pre_shared_key: peer["pre-shared-key"] || peer["preshared-key"] || undefined,
              allowed_ips: list(peer["allowed-ips"]).length ? list(peer["allowed-ips"]) : ["0.0.0.0/0", "::/0"],
              reserved: Array.isArray(peer.reserved) ? peer.reserved : undefined,
            },
          ],
        },
      };
    }
    case "direct":
      return { outbound: { type: "direct", tag: n.name } };
    default:
      return { error: `sing-box 不支持 ${n.type} 协议` };
  }
}

export const singboxSupports = (node) => !toOutbound(node).error;

// sing-box 出站 → Clash 节点（导入 sing-box 格式的订阅用）
export function fromOutbound(o) {
  if (!isMap(o) || !o.tag) return null;
  const tls = isMap(o.tls) && o.tls.enabled ? o.tls : null;
  const base = { name: o.tag, server: o.server, port: o.server_port };
  const withTls = (node, sniKey = "servername") => {
    if (!tls) return node;
    node.tls = true;
    if (tls.server_name) node[sniKey] = tls.server_name;
    if (tls.insecure) node["skip-cert-verify"] = true;
    if (list(tls.alpn).length) node.alpn = list(tls.alpn);
    if (tls.utls && tls.utls.enabled) node["client-fingerprint"] = tls.utls.fingerprint || "chrome";
    if (tls.reality && tls.reality.enabled) node["reality-opts"] = { "public-key": tls.reality.public_key, "short-id": tls.reality.short_id || "" };
    return node;
  };
  const withTransport = (node) => {
    const t = o.transport;
    if (!isMap(t)) return node;
    if (t.type === "ws") Object.assign(node, { network: "ws", "ws-opts": { path: t.path || "/", headers: t.headers } });
    else if (t.type === "httpupgrade") Object.assign(node, { network: "ws", "ws-opts": { path: t.path || "/", headers: t.host ? { Host: t.host } : undefined, "v2ray-http-upgrade": true } });
    else if (t.type === "grpc") Object.assign(node, { network: "grpc", "grpc-opts": { "grpc-service-name": t.service_name || "" } });
    else if (t.type === "http") Object.assign(node, tls ? { network: "h2", "h2-opts": { host: list(t.host), path: t.path || "/" } } : { network: "http", "http-opts": { path: [t.path || "/"] } });
    return node;
  };
  switch (o.type) {
    case "shadowsocks":
      return Object.assign(base, { type: "ss", cipher: o.method, password: o.password, udp: o.network !== "tcp" });
    case "vmess":
      return withTransport(withTls(Object.assign(base, { type: "vmess", uuid: o.uuid, alterId: o.alter_id || 0, cipher: o.security || "auto", udp: true })));
    case "vless":
      return withTransport(withTls(Object.assign(base, { type: "vless", uuid: o.uuid, flow: o.flow, udp: true })));
    case "trojan":
      return withTransport(withTls(Object.assign(base, { type: "trojan", password: o.password, udp: true }), "sni"));
    case "hysteria2":
      return withTls(Object.assign(base, { type: "hysteria2", password: o.password, obfs: o.obfs && o.obfs.type, "obfs-password": o.obfs && o.obfs.password }), "sni");
    case "tuic":
      return withTls(Object.assign(base, { type: "tuic", uuid: o.uuid, password: o.password, "congestion-controller": o.congestion_control, "udp-relay-mode": o.udp_relay_mode }), "sni");
    case "anytls":
      return withTls(Object.assign(base, { type: "anytls", password: o.password, udp: true }), "sni");
    case "socks":
      return Object.assign(base, { type: "socks5", username: o.username, password: o.password, udp: o.network !== "tcp" });
    case "http":
      return withTls(Object.assign(base, { type: "http", username: o.username, password: o.password }), "sni");
    case "naive":
      return Object.assign(base, { type: "naive", username: o.username, password: o.password, sni: tls && tls.server_name, quic: o.quic || undefined });
    default:
      return null;
  }
}

// ============================== 分组 ==============================
// mihomo 的 filter 是 Go 正则：(?i) 开头表示忽略大小写；多个正则用 ` 分隔
export function goRegex(pattern) {
  return String(pattern || "")
    .split("`")
    .filter(Boolean)
    .map((p) => {
      const ci = /^\(\?i\)/.test(p);
      try {
        return new RegExp(ci ? p.slice(4) : p, ci ? "iu" : "u");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
const matchAny = (res, name) => res.some((re) => re.test(name));

// 代理集合（proxy-providers）展开成节点：内容来自订阅更新时缓存的原文
function providerNodes(config, providers, logs) {
  const out = {};
  for (const [name, p] of Object.entries(config["proxy-providers"] || {})) {
    let nodes = [];
    if (p && Array.isArray(p.payload)) nodes = p.payload;
    else if (providers && providers[name]) {
      try {
        const doc = yaml.load(providers[name]);
        nodes = isMap(doc) && Array.isArray(doc.proxies) ? doc.proxies : [];
      } catch {
        nodes = [];
      }
    }
    if (!nodes.length) logs.push({ level: "warn", message: `代理集合「${name}」还没有内容（请更新订阅），其中的节点暂不可用` });
    const filter = goRegex(p && p.filter);
    const exclude = goRegex(p && p["exclude-filter"]);
    const override = (p && p.override) || {};
    out[name] = nodes
      .filter((n) => isMap(n) && n.name && (!filter.length || matchAny(filter, n.name)) && !(exclude.length && matchAny(exclude, n.name)))
      .map((n) => Object.assign({}, n, { name: (override["additional-prefix"] || "") + n.name + (override["additional-suffix"] || "") }));
  }
  return out;
}

// ============================== 规则 ==============================
// 按最外层逗号拆分，括号里的逗号不拆
function splitTop(text) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim());
}
const unwrap = (s) => (s.startsWith("(") && s.endsWith(")") ? s.slice(1, -1) : s);

function ports(payload) {
  const port = [];
  const range = [];
  for (const p of String(payload).split(/[/,]/).map((s) => s.trim()).filter(Boolean)) {
    if (p.includes("-")) range.push(p.replace("-", ":"));
    else if (/^\d+$/.test(p)) port.push(Number(p));
  }
  return { port, range };
}

const wildcardRegex = (w) => "^" + w.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]+").replace(/\?/g, ".") + "$";

// 单条匹配条件（不含出站）→ sing-box 规则字段；返回 null 表示不支持
function condition(text, ctx) {
  const parts = splitTop(text);
  const type = parts[0].toUpperCase();
  const payload = parts[1] || "";
  const noResolve = parts.slice(2).some((p) => p.toLowerCase() === "no-resolve");
  const ipRule = (fields) => {
    if (!noResolve) ctx.needResolve = true;
    return fields;
  };
  switch (type) {
    case "DOMAIN":
      return { domain: [payload] };
    case "DOMAIN-SUFFIX":
      return { domain_suffix: [payload] };
    case "DOMAIN-KEYWORD":
      return { domain_keyword: [payload] };
    case "DOMAIN-REGEX":
      return { domain_regex: [payload] };
    case "DOMAIN-WILDCARD":
      return { domain_regex: [wildcardRegex(payload)] };
    case "GEOSITE":
      return ctx.ruleSet(`geosite-${payload.toLowerCase()}`);
    case "GEOIP": {
      const code = payload.toLowerCase();
      if (code === "lan" || code === "private") return ipRule({ ip_is_private: true });
      const rs = ctx.ruleSet(`geoip-${code}`);
      return rs && ipRule(rs);
    }
    case "IP-CIDR":
    case "IP-CIDR6":
      return ipRule({ ip_cidr: [payload] });
    case "SRC-IP-CIDR":
      return { source_ip_cidr: [payload] };
    case "DST-PORT": {
      const { port, range } = ports(payload);
      return Object.assign({}, port.length ? { port } : {}, range.length ? { port_range: range } : {});
    }
    case "SRC-PORT": {
      const { port, range } = ports(payload);
      return Object.assign({}, port.length ? { source_port: port } : {}, range.length ? { source_port_range: range } : {});
    }
    case "PROCESS-NAME":
      return { process_name: [payload] };
    case "PROCESS-PATH":
      return { process_path: [payload] };
    case "PROCESS-PATH-REGEX":
      return { process_path_regex: [payload] };
    case "NETWORK":
      return { network: [payload.toLowerCase()] };
    case "RULE-SET": {
      const rs = ctx.providerRuleSet(payload);
      if (rs && rs.hasIP && !noResolve) ctx.needResolve = true;
      return rs && { rule_set: [rs.tag] };
    }
    case "AND":
    case "OR":
    case "NOT": {
      const subs = splitTop(unwrap(payload)).map((s) => condition(unwrap(s), ctx));
      if (!subs.length || subs.some((s) => !s)) return null;
      if (type === "NOT") return Object.assign({}, subs.length === 1 ? subs[0] : { type: "logical", mode: "and", rules: subs }, { invert: true });
      return { type: "logical", mode: type.toLowerCase(), rules: subs };
    }
    default:
      return null;
  }
}

// Clash 规则集合（rule-providers）→ sing-box 内联规则集
function providerRuleSet(name, provider, text) {
  if (!provider) return null;
  if (provider.format === "mrs") return { error: "mrs 格式无法转换" };
  let entries = [];
  if (Array.isArray(provider.payload)) entries = provider.payload;
  else if (text) {
    try {
      const doc = provider.format === "text" ? null : yaml.load(text);
      entries = isMap(doc) && Array.isArray(doc.payload) ? doc.payload : String(text).split(/\r?\n/);
    } catch {
      entries = String(text).split(/\r?\n/);
    }
  } else return { error: "还没有内容（请更新订阅）" };
  entries = entries.map((e) => String(e).trim()).filter((e) => e && !e.startsWith("#"));
  const fields = {};
  const add = (key, value) => (fields[key] = fields[key] || []).push(value);
  for (const e of entries) {
    if (provider.behavior === "ipcidr") add("ip_cidr", e);
    else if (provider.behavior === "domain") {
      if (e.startsWith("+.")) add("domain_suffix", e.slice(2));
      else if (e.startsWith(".")) add("domain_suffix", e.slice(1));
      else if (e.includes("*")) add("domain_regex", wildcardRegex(e));
      else add("domain", e);
    } else {
      const [type, value] = e.split(",").map((s) => s.trim());
      const key = {
        DOMAIN: "domain",
        "DOMAIN-SUFFIX": "domain_suffix",
        "DOMAIN-KEYWORD": "domain_keyword",
        "DOMAIN-REGEX": "domain_regex",
        "IP-CIDR": "ip_cidr",
        "IP-CIDR6": "ip_cidr",
        "SRC-IP-CIDR": "source_ip_cidr",
        "PROCESS-NAME": "process_name",
        "PROCESS-PATH": "process_path",
      }[String(type).toUpperCase()];
      if (key && value) add(key, value);
    }
  }
  const rules = Object.entries(fields).map(([k, v]) => ({ [k]: v }));
  if (!rules.length) return { error: "没有可转换的条目" };
  return { ruleSet: { type: "inline", tag: `rp-${name}`, rules }, hasIP: "ip_cidr" in fields };
}

// ============================== DNS ==============================
const SYSTEM_DOMAINS = [
  "msftconnecttest.com",
  "msftncsi.com",
  "time.windows.com",
  "time.apple.com",
  "time-ios.apple.com",
  "time.asia.apple.com",
  "pool.ntp.org",
  "ntp.org.cn",
  "srv.nintendo.net",
  "stun.playstation.net",
  "xboxlive.com",
];
const LAN_SUFFIXES = ["lan", "local", "localdomain", "home.arpa"];

function buildDNS(settings, target, ctx) {
  const lg = settings.leakGuard || {};
  const guard = !!lg.enabled;
  const ecs = guard ? lg.dnsECS || "" : "";
  const v6 = !settings.ipv6 ? "off" : guard ? lg.dnsIPv6 || "cn" : "all";
  const tun = !!(settings.tun && settings.tun.enable);
  const noECS = ecs && ctx.supports("remove_client_subnet") ? { remove_client_subnet: true } : {};
  const servers = [
    { type: "https", tag: "dns-cn", server: "223.5.5.5" },
    // 防泄露关闭时境外查询也直连（与 mihomo 下关闭脚本的效果一致）
    Object.assign({ type: "https", tag: "dns-remote", server: ecs ? "8.8.8.8" : "1.1.1.1" }, guard && target ? { detour: target } : {}),
  ];
  if (tun) servers.push({ type: "fakeip", tag: "dns-fake", inet4_range: "198.18.0.0/15", inet6_range: "fc00::/18" });
  if (guard && lg.lanDNS) servers.push({ type: "udp", tag: "dns-lan", server: lg.lanDNS });

  const cn = ctx.ruleSet("geosite-cn");
  const rules = [];
  if (v6 === "off") rules.push({ query_type: ["AAAA"], action: "predefined" });
  if (guard && lg.lanDNS) rules.push({ domain_suffix: LAN_SUFFIXES, server: "dns-lan" });
  rules.push(Object.assign({ clash_mode: "Direct", server: "dns-cn" }, noECS));
  if (v6 === "cn") rules.push({ domain_suffix: SYSTEM_DOMAINS, query_type: ["AAAA"], action: "predefined" });
  rules.push(Object.assign({ domain_suffix: SYSTEM_DOMAINS, server: "dns-cn" }, noECS));
  // 国内域名：国内 DNS 直接给真实 IP（关闭 realIPForCN 时也用 Fake-IP）
  if (cn && (!tun || lg.realIPForCN !== false || !guard)) rules.push(Object.assign({}, cn, { server: "dns-cn" }, noECS));
  if (v6 === "cn") rules.push({ query_type: ["AAAA"], action: "predefined" });
  if (tun) rules.push({ query_type: ["A", "AAAA"], server: "dns-fake" });
  if (cn && tun && guard && lg.realIPForCN === false) rules.push(Object.assign({}, cn, { server: "dns-cn" }, noECS));

  return Object.assign(
    { servers, rules, final: "dns-remote", strategy: settings.ipv6 ? undefined : "ipv4_only" },
    ecs ? { client_subnet: ecs } : {}
  );
}

// ============================== 主转换 ==============================
// ctx: { providers: { proxy: {名字: 原文}, rule: {名字: 原文} }, ruleSetPath(tag) → 本地 .srs 路径（缺了返回空），
//        sidecarBin: 搭配使用的内核路径（不让它进 TUN 绕回来）, version: sing-box 版本 }
export function toSingBox(clash, settings, ctx = {}) {
  const logs = [];
  const warn = (message) => logs.push({ level: "warn", message });
  const needed = new Set();
  const ruleSets = [];
  const ruleSetPath = ctx.ruleSetPath || (() => "");
  const version = String(ctx.version || "1.14.0").replace(/^v/, "");
  const newer = (min) => version.split(".").map(Number).reduce((acc, n, i) => (acc !== 0 ? acc : n - (min.split(".").map(Number)[i] || 0)), 0) >= 0;
  const helpers = {
    supports: (feature) => (feature === "remove_client_subnet" ? newer("1.14.0") : true),
    ruleSet(tag) {
      needed.add(tag);
      // 导出给别的设备用：规则集写成远程地址；在本机运行：用 Knight 预先下载好的本地文件
      const entry = ctx.ruleSetUrl ? { type: "remote", tag, format: "binary", url: ctx.ruleSetUrl(tag) } : ruleSetPath(tag) ? { type: "local", tag, format: "binary", path: ruleSetPath(tag) } : null;
      if (!entry) return null;
      if (!ruleSets.some((r) => r.tag === tag)) ruleSets.push(entry);
      return { rule_set: [tag] };
    },
  };

  // ---- 节点 ----
  const providerMap = providerNodes(clash, (ctx.providers || {}).proxy, logs);
  const nodes = (Array.isArray(clash.proxies) ? clash.proxies : []).concat(...Object.values(providerMap));
  const outbounds = [];
  const endpoints = [];
  const names = new Set();
  const skipped = [];
  for (const n of nodes) {
    if (!isMap(n) || names.has(n.name)) continue;
    const r = toOutbound(n);
    if (r.error) {
      skipped.push(`${n.name}（${r.error}）`);
      continue;
    }
    names.add(n.name);
    if (r.endpoint) endpoints.push(r.endpoint);
    else outbounds.push(r.outbound);
  }
  if (skipped.length) warn(`sing-box 跳过了 ${skipped.length} 个节点：${skipped.slice(0, 5).join("、")}${skipped.length > 5 ? " 等" : ""}`);
  const nodeNames = [...names];

  // ---- 分组 ----
  const groups = (clash["proxy-groups"] || []).filter((g) => isMap(g) && g.name);
  const groupNames = new Set(groups.map((g) => g.name));
  const members = new Map();
  for (const g of groups) {
    const explicit = list(g.proxies);
    let dynamic = [];
    if (g["include-all"] || g["include-all-proxies"]) dynamic = dynamic.concat((clash.proxies || []).map((p) => p && p.name));
    const use = g["include-all"] || g["include-all-providers"] ? Object.keys(providerMap) : list(g.use);
    for (const p of use) dynamic = dynamic.concat((providerMap[p] || []).map((n) => n.name));
    const filter = goRegex(g.filter);
    const exclude = goRegex(g["exclude-filter"]);
    const excludeType = String(g["exclude-type"] || "").toLowerCase().split("|").filter(Boolean);
    const byName = new Map(nodes.filter(isMap).map((n) => [n.name, n]));
    dynamic = dynamic.filter(
      (n) => n && (!filter.length || matchAny(filter, n)) && !(exclude.length && matchAny(exclude, n)) && !(excludeType.length && excludeType.includes(String((byName.get(n) || {}).type).toLowerCase()))
    );
    members.set(g.name, [...new Set(explicit.concat(dynamic))]);
  }
  // 引用了不存在的分组、或只剩 REJECT 的分组：去掉，规则里指向它的改为拦截
  const kept = new Set(groupNames);
  const usable = (name) => name === "DIRECT" || names.has(name) || kept.has(name);
  for (let changed = true; changed; ) {
    changed = false;
    for (const g of groups) {
      if (!kept.has(g.name)) continue;
      if (!members.get(g.name).some(usable)) {
        kept.delete(g.name);
        changed = true;
      }
    }
  }
  const groupOutbounds = [];
  for (const g of groups) {
    if (!kept.has(g.name)) {
      warn(`分组「${g.name}」在 sing-box 下没有可用的节点，指向它的规则改为拦截`);
      continue;
    }
    const outs = members.get(g.name).filter(usable);
    if (g.type === "select" || g.type === "relay" || !g.type) {
      if (g.type === "relay") warn(`sing-box 没有链式分组，「${g.name}」改为手动选择`);
      groupOutbounds.push({ type: "selector", tag: g.name, outbounds: outs, interrupt_exist_connections: true });
    } else {
      if (g.type === "load-balance" || g.type === "fallback") warn(`「${g.name}」（${g.type}）在 sing-box 下改为自动选择`);
      groupOutbounds.push({
        type: "urltest",
        tag: g.name,
        outbounds: outs,
        url: g.url || settings.delayUrl || undefined,
        interval: seconds(g.interval),
        tolerance: num(g.tolerance),
        interrupt_exist_connections: true,
      });
    }
  }
  // 全局模式用的 GLOBAL：订阅自己定义了就用它的
  const allTags = groupOutbounds.map((o) => o.tag).filter((t) => t !== "GLOBAL").concat(nodeNames);
  const globalOut = kept.has("GLOBAL") ? [] : [{ type: "selector", tag: "GLOBAL", outbounds: allTags.concat("DIRECT") }];
  const outTag = (name) => (name === "DIRECT" || name === "GLOBAL" || names.has(name) || kept.has(name) ? name : null);

  // ---- 规则 ----
  const providers = clash["rule-providers"] || {};
  const providerTexts = (ctx.providers || {}).rule || {};
  const convertedProviders = new Map();
  const condCtx = Object.assign({}, helpers, {
    needResolve: false,
    providerRuleSet(name) {
      if (!convertedProviders.has(name)) {
        const r = providerRuleSet(name, providers[name], providerTexts[name]);
        if (r && r.error) warn(`规则集合「${name}」${r.error}，相关规则已跳过`);
        if (r && r.ruleSet) ruleSets.push(r.ruleSet);
        convertedProviders.set(name, r && r.ruleSet ? { tag: r.ruleSet.tag, hasIP: r.hasIP } : null);
      }
      return convertedProviders.get(name);
    },
  });

  const routeRules = [{ action: "sniff" }, { protocol: "dns", action: "hijack-dns" }];
  if (ctx.sidecarBin) routeRules.push({ process_path: [ctx.sidecarBin], outbound: "DIRECT" });
  routeRules.push({ ip_is_private: true, outbound: "DIRECT" }, { clash_mode: "Direct", outbound: "DIRECT" }, { clash_mode: "Global", outbound: "GLOBAL" });

  let final = "DIRECT";
  let finalReject = false;
  let resolved = false;
  let unsupported = 0;
  for (const rule of Array.isArray(clash.rules) ? clash.rules : []) {
    const parts = splitTop(String(rule));
    const type = parts[0].toUpperCase();
    if (type === "MATCH") {
      const t = parts[1];
      if (t === "REJECT" || t === "REJECT-DROP" || !outTag(t)) finalReject = true;
      else final = t;
      break; // MATCH 之后的规则在 sing-box 里走不到
    }
    const logical = type === "AND" || type === "OR" || type === "NOT";
    const target = logical ? parts[parts.length - 1] : parts[2];
    const condText = logical ? parts.slice(0, -1).join(",") : [parts[0], parts[1]].concat(parts.slice(3)).join(",");
    if (target === "PASS") continue;
    condCtx.needResolve = false;
    const cond = condition(condText, condCtx);
    if (!cond || !Object.keys(cond).length) {
      unsupported++;
      continue;
    }
    // Clash 的 IP 规则（没有 no-resolve）会先解析域名再匹配；sing-box 需要显式的 resolve 动作
    if (condCtx.needResolve && !resolved) {
      routeRules.push({ action: "resolve" });
      resolved = true;
    }
    let action;
    if (target === "REJECT") action = { action: "reject" };
    else if (target === "REJECT-DROP") action = { action: "reject", method: "drop" };
    else if (outTag(target)) action = { outbound: target };
    else action = { action: "reject" };
    routeRules.push(Object.assign({}, cond, action));
  }
  if (unsupported) warn(`有 ${unsupported} 条规则 sing-box 不支持，已跳过（如 IP-ASN、IN-PORT、SUB-RULE 等）`);
  if (finalReject) routeRules.push({ type: "logical", mode: "or", rules: [{ network: ["tcp"] }, { network: ["udp"] }], action: "reject" });
  const missing = ctx.ruleSetUrl ? [] : [...needed].filter((t) => !ruleSetPath(t));
  if (missing.length) warn(`缺少规则集 ${missing.join("、")}，相关规则已跳过`);

  // ---- 入站、DNS、其余 ----
  const s = settings;
  const inbounds = [{ type: "mixed", tag: "mixed-in", listen: s.allowLan ? "::" : "127.0.0.1", listen_port: s.mixedPort }];
  if (s.tun && s.tun.enable) {
    inbounds.push(
      Object.assign(
        {
          type: "tun",
          tag: "tun-in",
          address: ["172.19.0.1/30"].concat(s.ipv6 ? ["fdfe:dcba:9876::1/126"] : []),
          mtu: s.tun.mtu || 1500,
          auto_route: true,
          strict_route: !!s.tun.strictRoute,
          stack: s.tun.stack || "mixed",
        },
        process.platform === "linux" && s.tun.autoRedirect ? { auto_redirect: true } : {},
        s.tun.device ? { interface_name: s.tun.device } : {}
      )
    );
  }
  // 境外 DNS 的出口：跟随兜底规则（MATCH）指向的代理分组，与 script.js 相同；也可以在设置里手动指定
  const lgGroup = s.leakGuard && s.leakGuard.proxyGroup;
  const dnsTarget = lgGroup && outTag(lgGroup) ? lgGroup : final !== "DIRECT" && !finalReject ? final : null;
  const level = { silent: null, error: "error", warning: "warn", info: "info", debug: "debug" }[s.logLevel] || "info";
  // DNS 也会引用规则集（geosite-cn），要先生成，再判断是否需要下载规则集用的 HTTP 客户端
  const dns = buildDNS(s, dnsTarget, helpers);
  const remote = ruleSets.some((r) => r.type === "remote");
  const config = {
    log: level ? { level, timestamp: true } : { disabled: true },
    http_clients: remote ? [{ tag: "rule-set" }] : undefined,
    dns,
    endpoints: endpoints.length ? endpoints : undefined,
    inbounds,
    outbounds: groupOutbounds.concat(globalOut, outbounds, [{ type: "direct", tag: "DIRECT" }]),
    route: {
      rules: routeRules,
      rule_set: ruleSets.length ? ruleSets : undefined,
      final,
      auto_detect_interface: true,
      find_process: !!s.findProcess,
      default_domain_resolver: "dns-cn",
      default_http_client: remote ? "rule-set" : undefined,
    },
    experimental: {
      clash_api: {
        external_controller: "127.0.0.1:" + s.controllerPort,
        secret: s.secret || undefined,
        default_mode: { rule: "Rule", global: "Global", direct: "Direct" }[s.mode] || "Rule",
        access_control_allow_origin: ["*"],
        access_control_allow_private_network: true,
      },
      cache_file: { enabled: true, path: "cache.db", store_fakeip: true },
    },
  };
  return { config: JSON.parse(JSON.stringify(config)), logs, ruleSets: [...needed] };
}

export const SINGBOX_MODES = { rule: "Rule", global: "Global", direct: "Direct" };
