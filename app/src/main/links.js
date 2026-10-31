// 节点 → 分享链接（订阅转换的「分享链接」输出；ss / vmess / vless / trojan / hysteria2 / hysteria / tuic / anytls / socks / http / naive）
const enc = encodeURIComponent;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const host = (h) => (String(h).includes(":") && !String(h).startsWith("[") ? `[${h}]` : h);

function query(params) {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
    .map(([k, v]) => `${k}=${enc(v === true ? "1" : Array.isArray(v) ? v.join(",") : v)}`)
    .join("&");
  return q ? "?" + q : "";
}

function transportParams(n) {
  const net = n.network || "tcp";
  const ws = n["ws-opts"] || {};
  const p = { type: net === "h2" ? "http" : net };
  if (net === "ws") {
    if (ws["v2ray-http-upgrade"]) p.type = "httpupgrade";
    p.path = ws.path;
    p.host = (ws.headers || {}).Host;
  } else if (net === "grpc") p.serviceName = (n["grpc-opts"] || {})["grpc-service-name"];
  else if (net === "h2") {
    p.path = (n["h2-opts"] || {}).path;
    p.host = [].concat((n["h2-opts"] || {}).host || []).join(",");
  }
  return p;
}

function tlsParams(n, sniKey = "servername") {
  const reality = n["reality-opts"];
  return {
    security: reality ? "reality" : n.tls || n.type === "trojan" ? "tls" : undefined,
    sni: n[sniKey] || n.sni || n.servername,
    fp: n["client-fingerprint"],
    alpn: n.alpn,
    allowInsecure: n["skip-cert-verify"] ? "1" : undefined,
    pbk: reality && reality["public-key"],
    sid: reality && reality["short-id"],
  };
}

export function toLink(n) {
  if (!n || !n.type) return null;
  const name = "#" + enc(n.name || "");
  const at = `${host(n.server)}:${n.port}`;
  switch (n.type) {
    case "ss": {
      let plugin;
      const o = n["plugin-opts"] || {};
      if (n.plugin === "obfs") plugin = `obfs-local;obfs=${o.mode || "http"}${o.host ? ";obfs-host=" + o.host : ""}`;
      else if (n.plugin === "v2ray-plugin") plugin = `v2ray-plugin;mode=${o.mode || "websocket"}${o.host ? ";host=" + o.host : ""}${o.path ? ";path=" + o.path : ""}${o.tls ? ";tls" : ""}`;
      else if (n.plugin) return null;
      return `ss://${b64url(`${n.cipher}:${n.password}`)}@${at}${query({ plugin })}${name}`;
    }
    case "vmess": {
      const t = transportParams(n);
      return (
        "vmess://" +
        b64(
          JSON.stringify({
            v: "2",
            ps: n.name,
            add: n.server,
            port: String(n.port),
            id: n.uuid,
            aid: String(n.alterId || 0),
            scy: n.cipher || "auto",
            net: t.type === "httpupgrade" ? "httpupgrade" : t.type,
            type: "none",
            host: t.host || "",
            path: t.path || t.serviceName || "",
            tls: n.tls ? "tls" : "",
            sni: n.servername || "",
            alpn: [].concat(n.alpn || []).join(","),
            fp: n["client-fingerprint"] || "",
          })
        )
      );
    }
    case "vless":
      return `vless://${enc(n.uuid)}@${at}${query(Object.assign({ encryption: "none", flow: n.flow }, tlsParams(n), transportParams(n)))}${name}`;
    case "trojan":
      return `trojan://${enc(n.password)}@${at}${query(Object.assign(tlsParams(n, "sni"), transportParams(n)))}${name}`;
    case "hysteria2":
      return `hysteria2://${enc(n.password || n.auth || "")}@${at}${query({ sni: n.sni, insecure: n["skip-cert-verify"], obfs: n.obfs, "obfs-password": n["obfs-password"], mport: n.ports })}${name}`;
    case "hysteria":
      return `hysteria://${at}${query({ protocol: n.protocol || "udp", auth: n["auth-str"] || n.auth_str, peer: n.sni, insecure: n["skip-cert-verify"], upmbps: parseInt(n.up, 10) || undefined, downmbps: parseInt(n.down, 10) || undefined, obfs: n.obfs, alpn: n.alpn })}${name}`;
    case "tuic":
      return `tuic://${enc(n.uuid)}:${enc(n.password || "")}@${at}${query({ sni: n.sni, alpn: n.alpn, congestion_control: n["congestion-controller"], udp_relay_mode: n["udp-relay-mode"], allow_insecure: n["skip-cert-verify"] })}${name}`;
    case "anytls":
      return `anytls://${enc(n.password)}@${at}${query({ sni: n.sni, insecure: n["skip-cert-verify"] })}${name}`;
    case "socks5":
      return `socks5://${n.username ? enc(n.username) + ":" + enc(n.password || "") + "@" : ""}${at}${name}`;
    case "http":
      return `${n.tls ? "https" : "http"}://${n.username ? enc(n.username) + ":" + enc(n.password || "") + "@" : ""}${at}${name}`;
    case "naive":
      return `naive+${n.quic ? "quic" : "https"}://${enc(n.username || "")}:${enc(n.password || "")}@${at}${name}`;
    default:
      return null;
  }
}

// 返回 { text, skipped }；base64 为 true 时整体再做一次 Base64（多数客户端的订阅格式）
export function toLinks(proxies, { base64 = false } = {}) {
  const lines = [];
  const skipped = [];
  for (const n of proxies || []) {
    const link = toLink(n);
    if (link) lines.push(link);
    else if (n && n.name) skipped.push(n.name);
  }
  const text = lines.join("\n");
  return { text: base64 ? b64(text) : text, count: lines.length, skipped };
}
