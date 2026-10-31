// Xray-core：只作为搭配内核（没有 Clash 控制接口，不能当主内核），专门运行 VLESS / XHTTP / REALITY 这类节点。
// 字段按 Xray v26 编写：传输层写 network（新旧版本都认），VLESS 用平铺的 address / port / id
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === "" ? [] : [v]);

function security(n, forceTls) {
  const reality = n["reality-opts"];
  if (isMap(reality)) {
    return {
      security: "reality",
      realitySettings: {
        serverName: n.servername || n.sni || "",
        fingerprint: n["client-fingerprint"] || "chrome",
        publicKey: reality["public-key"] || "",
        shortId: reality["short-id"] || "",
        spiderX: reality["spider-x"] || undefined,
        mldsa65Verify: reality["mldsa65-verify"] || undefined,
      },
    };
  }
  if (!forceTls && n.tls !== true) return {};
  // Xray 已经去掉了 allowInsecure，跳过证书验证的节点交给别的内核
  if (n["skip-cert-verify"]) return { error: "Xray 已不支持跳过证书验证" };
  const tls = { serverName: n.servername || n.sni || undefined, fingerprint: n["client-fingerprint"] || undefined, alpn: list(n.alpn).length ? list(n.alpn) : undefined };
  if (isMap(n["ech-opts"]) && n["ech-opts"].enable && n["ech-opts"].config) tls.echConfigList = n["ech-opts"].config;
  return { security: "tls", tlsSettings: tls };
}

function xhttpSettings(o) {
  let extra;
  if (o["xray-extra"]) {
    try {
      extra = JSON.parse(o["xray-extra"]);
    } catch {
      extra = undefined;
    }
  } else {
    extra = {};
    if (o.headers) extra.headers = o.headers;
    if (o["no-grpc-header"]) extra.noGRPCHeader = true;
    if (o["x-padding-bytes"]) extra.xPaddingBytes = o["x-padding-bytes"];
    if (o["sc-max-each-post-bytes"]) extra.scMaxEachPostBytes = o["sc-max-each-post-bytes"];
    if (o["sc-min-posts-interval-ms"]) extra.scMinPostsIntervalMs = o["sc-min-posts-interval-ms"];
    if (!Object.keys(extra).length) extra = undefined;
  }
  return { path: o.path || "/", host: o.host || undefined, mode: o.mode || "auto", extra };
}

// 传输层；返回 { error } 表示 Xray 不支持
function transport(n) {
  const net = n.network || "tcp";
  if (net === "tcp") return { network: "tcp" };
  if (net === "ws") {
    const o = n["ws-opts"] || {};
    const headers = Object.assign({}, o.headers);
    const host = headers.Host || headers.host;
    delete headers.Host;
    delete headers.host;
    const settings = { path: o.path || "/", host, headers: Object.keys(headers).length ? headers : undefined };
    return o["v2ray-http-upgrade"] ? { network: "httpupgrade", httpupgradeSettings: settings } : { network: "ws", wsSettings: settings };
  }
  if (net === "grpc") {
    const o = n["grpc-opts"] || {};
    return { network: "grpc", grpcSettings: { serviceName: o["grpc-service-name"] || "", multiMode: o["grpc-mode"] === "multi" || undefined, authority: o.authority } };
  }
  if (net === "xhttp") return { network: "xhttp", xhttpSettings: xhttpSettings(n["xhttp-opts"] || {}) };
  return { error: `Xray 不支持 ${net} 传输` };
}

// Clash 节点 → { outbound } | { error }
export function toXrayOutbound(n, tag = n && n.name) {
  if (!isMap(n) || !n.type) return { error: "节点格式不对" };
  const t = transport(n);
  if (t.error) return t;
  const stream = (forceTls) => {
    const sec = security(n, forceTls);
    if (sec.error) return sec;
    return Object.assign({}, t, sec);
  };
  const make = (protocol, settings, forceTls = false) => {
    const streamSettings = stream(forceTls);
    if (streamSettings.error) return { error: streamSettings.error };
    return { outbound: { tag, protocol, settings, streamSettings } };
  };
  switch (n.type) {
    case "vless":
      // Xray 要求 VLESS 有传输安全（TLS / REALITY）或 VLESS 加密
      if (!n.tls && !n["reality-opts"] && !n.encryption) return { error: "Xray 要求 VLESS 使用 TLS、REALITY 或 VLESS 加密" };
      return make("vless", { address: n.server, port: Number(n.port), id: n.uuid, encryption: n.encryption || "none", flow: n.flow || undefined });
    case "vmess":
      if (Number(n.alterId) > 0) return { error: "Xray 不支持 alterId 不为 0 的旧版 VMess" };
      return make("vmess", { address: n.server, port: Number(n.port), id: n.uuid, security: n.cipher || "auto" });
    case "trojan":
      return make("trojan", { address: n.server, port: Number(n.port), password: String(n.password ?? "") }, true);
    case "ss":
      if (n.plugin) return { error: "Xray 不支持 Shadowsocks 插件" };
      return make("shadowsocks", { address: n.server, port: Number(n.port), method: n.cipher, password: String(n.password ?? "") });
    case "socks5":
      if (n.tls) return { error: "Xray 的 SOCKS 出站不支持 TLS" };
      return make("socks", { address: n.server, port: Number(n.port), user: n.username || undefined, pass: n.password || undefined });
    case "http":
      return make("http", { address: n.server, port: Number(n.port), user: n.username || undefined, pass: n.password || undefined });
    default:
      return { error: `Xray 搭配暂不支持 ${n.type} 协议` };
  }
}

export const xraySupports = (node) => !toXrayOutbound(node).error;

// 搭配用的 Xray 配置：每个节点一个本地 SOCKS 入口
export function xrayConfig(entries) {
  const outbounds = entries.map((e, i) => toXrayOutbound(e.node, `out-${i}`).outbound).filter(Boolean);
  return JSON.stringify(
    {
      log: { loglevel: "warning" },
      dns: { servers: ["https+local://223.5.5.5/dns-query", "223.5.5.5"] },
      inbounds: entries.map((e, i) => ({ tag: `in-${i}`, listen: "127.0.0.1", port: e.port, protocol: "socks", settings: { auth: "noauth", udp: true, ip: "127.0.0.1" } })),
      outbounds: outbounds.concat({ tag: "direct", protocol: "freedom" }),
      routing: { domainStrategy: "AsIs", rules: entries.map((e, i) => ({ inboundTag: [`in-${i}`], outboundTag: `out-${i}` })) },
    },
    null,
    2
  );
}
