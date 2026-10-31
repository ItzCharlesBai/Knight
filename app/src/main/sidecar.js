// 搭配使用：主内核跑不了（或者指定交给别的内核）的节点，由另一个内核运行。
// 搭配内核在 127.0.0.1 上为每个这样的节点开一个 SOCKS 入口，主内核里把节点换成指向这个入口的 socks5 节点，
// 分组、规则、测速都不变。例：mihomo 下的 NaiveProxy 交给 sing-box；sing-box 下的 SSR / XHTTP 交给 mihomo 或 Xray；
// 还可以指定 VLESS（或只是 REALITY）节点一律交给 Xray
import yaml from "js-yaml";
import { singboxSupports, toOutbound } from "./singbox.js";
import { xrayConfig, xraySupports } from "./xray.js";

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// mihomo 不支持的类型（来自分享链接的 naive 等）
const CLASH_UNSUPPORTED = new Set(["naive"]);
export const clashSupports = (node) => isMap(node) && !CLASH_UNSUPPORTED.has(node.type) && !(node.type === "vless" && node.network === "mkcp");
export function supports(kind, node) {
  if (kind === "singbox") return singboxSupports(node);
  if (kind === "xray") return xraySupports(node);
  return clashSupports(node);
}

// 「交给 Xray」的范围：off | reality | vless
export const wantsXray = (mode, node) =>
  isMap(node) && node.type === "vless" && (mode === "vless" || (mode === "reality" && isMap(node["reality-opts"])));

// sidecars：可搭配的内核 [{ id, kind }]，按优先顺序；xrayFor：哪些 VLESS 节点优先交给 Xray
// 返回 { config, entries: [{ node, port, sidecar }], dropped: [名字] }
export function splitNodes(config, mainKind, { sidecars = [], xrayFor = "off", basePort = 7920, reserved = [] } = {}) {
  const proxies = Array.isArray(config.proxies) ? config.proxies : [];
  const entries = [];
  const dropped = [];
  const used = new Set(reserved);
  let port = basePort;
  const nextPort = () => {
    while (used.has(port)) port++;
    used.add(port);
    return port++;
  };
  const xray = sidecars.find((s) => s.kind === "xray");
  const out = [];
  for (const node of proxies) {
    let target = null;
    if (xray && wantsXray(xrayFor, node) && supports("xray", node)) target = xray;
    else if (!isMap(node) || supports(mainKind, node)) {
      out.push(node);
      continue;
    } else target = sidecars.find((s) => s.kind !== mainKind && supports(s.kind, node)) || null;
    if (target) {
      const p = nextPort();
      entries.push({ node, port: p, sidecar: target.id });
      out.push({ name: node.name, type: "socks5", server: "127.0.0.1", port: p, udp: true });
    } else {
      dropped.push(node.name);
    }
  }
  if (!entries.length && !dropped.length) return { config, entries, dropped };
  const result = Object.assign({}, config, { proxies: out });
  if (dropped.length) {
    const gone = new Set(dropped);
    result["proxy-groups"] = (config["proxy-groups"] || []).map((g) =>
      isMap(g) && Array.isArray(g.proxies) ? Object.assign({}, g, { proxies: g.proxies.filter((n) => !gone.has(n)) }) : g
    );
  }
  return { config: result, entries, dropped };
}

// 搭配内核的配置：只负责把每个本地入口转到对应节点
export function sidecarConfig(kind, entries) {
  if (kind === "xray") return xrayConfig(entries);
  if (kind === "clash") {
    return yaml.dump(
      {
        "log-level": "warning",
        ipv6: true,
        "find-process-mode": "off",
        dns: { enable: true, ipv6: true, nameserver: ["https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query"], "default-nameserver": ["223.5.5.5", "119.29.29.29"] },
        proxies: entries.map((e) => e.node),
        listeners: entries.map((e, i) => ({ name: `knight-${i}`, type: "socks", listen: "127.0.0.1", port: e.port, udp: true, proxy: e.node.name })),
        rules: ["MATCH,DIRECT"],
      },
      { lineWidth: -1, noRefs: true }
    );
  }
  const outbounds = [];
  const endpoints = [];
  entries.forEach((e) => {
    const r = toOutbound(e.node);
    if (r.endpoint) endpoints.push(r.endpoint);
    else if (r.outbound) outbounds.push(r.outbound);
  });
  return JSON.stringify(
    {
      log: { level: "warn", timestamp: true },
      dns: { servers: [{ type: "https", tag: "dns", server: "223.5.5.5" }] },
      endpoints: endpoints.length ? endpoints : undefined,
      inbounds: entries.map((e, i) => ({ type: "socks", tag: `in-${i}`, listen: "127.0.0.1", listen_port: e.port })),
      outbounds: outbounds.concat({ type: "direct", tag: "direct" }),
      route: {
        rules: entries.map((e, i) => ({ inbound: [`in-${i}`], outbound: e.node.name })),
        final: "direct",
        default_domain_resolver: "dns",
      },
    },
    null,
    2
  );
}
