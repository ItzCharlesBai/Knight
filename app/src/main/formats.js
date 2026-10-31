// 其他客户端的节点列表：Surge（Proxy 段）、Quantumult X（server_local）、Loon（Proxy 段）。
// 只转换这些客户端支持的常见协议，转不了的节点会列出来（例如 Surge 不支持 VLESS）
const clean = (s) => String(s ?? "").replace(/[,=\n\r]/g, " ").trim();
const quote = (s) => `"${String(s ?? "").replace(/"/g, '\\"')}"`;
const has = (v) => v !== undefined && v !== null && v !== "";
const join = (parts) => parts.filter(Boolean).join(", ");
const sniOf = (n) => n.servername || n.sni;
const wsOpts = (n) => (n.network === "ws" ? n["ws-opts"] || {} : null);
const mbps = (v) => (/^\s*(\d+)/.exec(String(v ?? "")) || [])[1];

// ---------------- Surge ----------------
function surge(n) {
  const name = clean(n.name);
  const base = `${name} = `;
  const tls = (force) => (force || n.tls ? [sniOf(n) && `sni=${sniOf(n)}`, n["skip-cert-verify"] && "skip-cert-verify=true"] : []);
  const ws = () => {
    const o = wsOpts(n);
    if (!o) return [];
    if (o["v2ray-http-upgrade"]) return null;
    const host = (o.headers || {}).Host;
    return ["ws=true", `ws-path=${o.path || "/"}`, host && `ws-headers=Host:${host}`];
  };
  if (n.network && n.network !== "tcp" && n.network !== "ws") return null; // Surge 只支持 WebSocket 传输
  const w = ws();
  if (w === null) return null;
  switch (n.type) {
    case "ss": {
      const o = n["plugin-opts"] || {};
      if (n.plugin && n.plugin !== "obfs") return null;
      return base + join(["ss", n.server, n.port, `encrypt-method=${n.cipher}`, `password=${n.password}`, n.plugin && `obfs=${o.mode || "http"}`, n.plugin && o.host && `obfs-host=${o.host}`, n.udp && "udp-relay=true"]);
    }
    case "vmess":
      return base + join(["vmess", n.server, n.port, `username=${n.uuid}`, !Number(n.alterId) && "vmess-aead=true", n.tls && "tls=true", ...tls(), ...w]);
    case "trojan":
      return base + join(["trojan", n.server, n.port, `password=${n.password}`, ...tls(true), ...w]);
    case "hysteria2":
      return base + join(["hysteria2", n.server, n.port, `password=${n.password || n.auth}`, ...tls(true), mbps(n.down) && `download-bandwidth=${mbps(n.down)}`]);
    case "tuic":
      return base + join(["tuic-v5", n.server, n.port, `password=${n.password}`, `uuid=${n.uuid}`, ...tls(true), `alpn=${[].concat(n.alpn || ["h3"])[0]}`]);
    case "snell":
      return base + join(["snell", n.server, n.port, `psk=${n.psk}`, n.version && `version=${n.version}`]);
    case "socks5":
      return base + join([n.tls ? "socks5-tls" : "socks5", n.server, n.port, n.username, n.password, ...tls()]);
    case "http":
      return base + join([n.tls ? "https" : "http", n.server, n.port, n.username, n.password, ...tls()]);
    default:
      return null;
  }
}

// ---------------- Quantumult X ----------------
function quanx(n) {
  const tag = `tag=${clean(n.name)}`;
  const at = `${n.server}:${n.port}`;
  const verify = n["skip-cert-verify"] ? "tls-verification=false" : "tls-verification=true";
  const o = wsOpts(n);
  if (n.network && n.network !== "tcp" && n.network !== "ws") return null; // Quantumult X 不支持 gRPC / XHTTP 等
  if (o && o["v2ray-http-upgrade"]) return null;
  const obfs = (tlsOn) => {
    if (o) return [`obfs=${tlsOn ? "wss" : "ws"}`, `obfs-host=${(o.headers || {}).Host || sniOf(n) || n.server}`, `obfs-uri=${o.path || "/"}`];
    if (tlsOn) return ["obfs=over-tls", `obfs-host=${sniOf(n) || n.server}`];
    return [];
  };
  switch (n.type) {
    case "ss": {
      const p = n["plugin-opts"] || {};
      if (n.plugin && n.plugin !== "obfs") return null;
      return join([`shadowsocks=${at}`, `method=${n.cipher}`, `password=${n.password}`, n.plugin && `obfs=${p.mode || "http"}`, n.plugin && p.host && `obfs-host=${p.host}`, n.udp && "udp-relay=true", tag]);
    }
    case "vmess":
      return join([`vmess=${at}`, `method=${n.cipher === "auto" || !n.cipher ? "chacha20-poly1305" : n.cipher}`, `password=${n.uuid}`, ...obfs(n.tls), n.tls && verify, tag]);
    case "vless": {
      if (n.encryption) return null;
      const reality = n["reality-opts"];
      return join([
        `vless=${at}`,
        "method=none",
        `password=${n.uuid}`,
        ...obfs(n.tls),
        n.tls && verify,
        n.flow && `vless-flow=${n.flow}`,
        reality && `reality-base64-pubkey=${reality["public-key"]}`,
        reality && reality["short-id"] && `reality-hex-shortid=${reality["short-id"]}`,
        tag,
      ]);
    }
    case "trojan":
      return join([`trojan=${at}`, `password=${n.password}`, o ? obfs(true).join(", ") : "over-tls=true", !o && sniOf(n) && `tls-host=${sniOf(n)}`, verify, tag]);
    case "http":
      return join([`http=${at}`, n.username && `username=${n.username}`, n.password && `password=${n.password}`, n.tls && "over-tls=true", n.tls && sniOf(n) && `tls-host=${sniOf(n)}`, n.tls && verify, tag]);
    case "socks5":
      return join([`socks5=${at}`, n.username && `username=${n.username}`, n.password && `password=${n.password}`, n.tls && "over-tls=true", tag]);
    default:
      return null;
  }
}

// ---------------- Loon ----------------
function loon(n) {
  const name = clean(n.name);
  const tls = (force) => (force || n.tls ? ["over-tls=true", sniOf(n) && `sni=${sniOf(n)}`, n["skip-cert-verify"] ? "skip-cert-verify=true" : "skip-cert-verify=false"] : []);
  const o = wsOpts(n);
  const transport = () => {
    if (!n.network || n.network === "tcp") return ["transport=tcp"];
    if (o && !o["v2ray-http-upgrade"]) return ["transport=ws", `path=${o.path || "/"}`, (o.headers || {}).Host && `host=${o.headers.Host}`];
    if (n.network === "grpc") return ["transport=grpc", `grpc-service-name=${(n["grpc-opts"] || {})["grpc-service-name"] || ""}`];
    return null;
  };
  const t = transport();
  switch (n.type) {
    case "ss": {
      const p = n["plugin-opts"] || {};
      if (n.plugin && n.plugin !== "obfs") return null;
      return `${name} = ` + [`Shadowsocks`, n.server, n.port, n.cipher, quote(n.password), n.plugin && `obfs-name=${p.mode || "http"}`, n.plugin && p.host && `obfs-host=${p.host}`, n.udp && "udp=true"].filter(Boolean).join(",");
    }
    case "vmess":
      if (!t) return null;
      return `${name} = ` + ["vmess", n.server, n.port, n.cipher || "auto", quote(n.uuid), ...t, ...tls(), `alterId=${Number(n.alterId) || 0}`].filter(Boolean).join(",");
    case "vless": {
      if (!t || n.encryption) return null;
      const reality = n["reality-opts"];
      return (
        `${name} = ` +
        ["VLESS", n.server, n.port, quote(n.uuid), ...t, n.flow && `flow=${n.flow}`, reality && `public-key=${quote(reality["public-key"])}`, reality && reality["short-id"] && `short-id=${reality["short-id"]}`, ...tls()]
          .filter(Boolean)
          .join(",")
      );
    }
    case "trojan":
      if (!t) return null;
      return `${name} = ` + ["trojan", n.server, n.port, quote(n.password), ...t, ...tls(true)].filter(Boolean).join(",");
    case "hysteria2":
      return `${name} = ` + ["Hysteria2", n.server, n.port, quote(n.password || n.auth), sniOf(n) && `sni=${sniOf(n)}`, n["skip-cert-verify"] && "skip-cert-verify=true", mbps(n.down) && `download-bandwidth=${mbps(n.down)}`].filter(Boolean).join(",");
    case "http":
      return `${name} = ` + [n.tls ? "https" : "http", n.server, n.port, n.username || "", quote(n.password || "")].join(",");
    case "socks5":
      return `${name} = ` + ["socks5", n.server, n.port, n.username || "", quote(n.password || "")].join(",");
    default:
      return null;
  }
}

const WRITERS = { surge, quanx, loon };

// 返回 { text, count, skipped }
export function toClientList(target, proxies) {
  const write = WRITERS[target];
  const lines = [];
  const skipped = [];
  for (const n of proxies || []) {
    let line = null;
    try {
      line = n && n.type && has(n.server) ? write(n) : null;
    } catch {
      line = null;
    }
    if (line) lines.push(line);
    else if (n && n.name) skipped.push(n.name);
  }
  return { text: lines.join("\n"), count: lines.length, skipped };
}
