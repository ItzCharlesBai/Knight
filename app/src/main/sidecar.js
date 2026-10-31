// 搭配使用：当前内核不支持的节点交给另一个内核运行。
// 另一个内核在 127.0.0.1 上为每个这样的节点开一个 SOCKS 入口，主内核里把节点换成指向这个入口的 socks5 节点，
// 分组、规则、测速都不变。例：用 mihomo 时 NaiveProxy 节点交给 sing-box；用 sing-box 时 SSR / Snell / Mieru 节点交给 mihomo
import yaml from "js-yaml";
import { singboxSupports, toOutbound } from "./singbox.js";

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// mihomo 不支持的类型（来自分享链接的 naive 等）
const CLASH_UNSUPPORTED = new Set(["naive"]);
export const clashSupports = (node) => isMap(node) && !CLASH_UNSUPPORTED.has(node.type);
export const supports = (kind, node) => (kind === "singbox" ? singboxSupports(node) : clashSupports(node));
const other = (kind) => (kind === "singbox" ? "clash" : "singbox");

// 返回 { config, entries: [{ node, port }], dropped: [名字] }
// sidecarKind 为空表示没有可搭配的内核：不支持的节点直接去掉（分组里的引用一并去掉）
export function splitNodes(config, mainKind, { sidecarKind = "", basePort = 7920, reserved = [] } = {}) {
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
  const out = [];
  for (const node of proxies) {
    if (!isMap(node) || supports(mainKind, node)) {
      out.push(node);
      continue;
    }
    if (sidecarKind === other(mainKind) && supports(sidecarKind, node)) {
      const p = nextPort();
      entries.push({ node, port: p });
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
