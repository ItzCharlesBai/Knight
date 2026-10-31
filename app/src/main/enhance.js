// 生成交给内核的运行配置，顺序与 Clash Verge Rev 一致，仓库里的 script.js / merge.yaml 可以原样使用：
//   订阅（已按订阅的转换选项处理）→ 当前内核不支持的节点交给另一个内核（搭配使用）→ 应用设置 → merge.yaml（可选）
//   → 防泄露脚本 script.js → 自定义脚本（可选）→ 自定义规则 → 应用设置回写 → 内核是 sing-box 时整体转换
import vm from "node:vm";
import yaml from "js-yaml";
import { CORES } from "./core-download.js";
import { sidecarConfig, splitNodes } from "./sidecar.js";
import { toSingBox } from "./singbox.js";

const clone = (v) => JSON.parse(JSON.stringify(v));
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// 设置页里能调的 script.js 参数（名字与脚本顶部 CONFIG 一致）
export const LEAK_OPTIONS = [
  "webrtc",
  "udpLeakGuard",
  "blockQUIC",
  "dnsIPv6",
  "realIPForCN",
  "dnsECS",
  "blockDNSBypass",
  "lanDNS",
  "removeInfoNodes",
  "forceUDP",
  "clientFingerprint",
  "sniffer",
  "tuneHealthCheck",
  "proxyGroup",
];

// 订阅不该决定的字段：端口、控制接口、TUN 等由本应用统一管理
function applySettings(config, s) {
  for (const key of ["port", "socks-port", "redir-port", "tproxy-port", "external-controller-tls", "external-controller-unix", "external-controller-pipe", "external-ui", "external-ui-url", "secret", "tls"]) {
    delete config[key];
  }
  config["mixed-port"] = s.mixedPort;
  config["allow-lan"] = !!s.allowLan;
  if (s.allowLan) config["bind-address"] = "*";
  config.ipv6 = !!s.ipv6;
  config.mode = s.mode;
  config["log-level"] = s.logLevel;
  config["unified-delay"] = !!s.unifiedDelay;
  config["find-process-mode"] = s.findProcess ? "strict" : "off";
  config["external-controller"] = "127.0.0.1:" + s.controllerPort;
  config.secret = s.secret;
  config["external-controller-cors"] = { "allow-origins": ["*"], "allow-private-network": true };
  config.tun = {
    enable: !!s.tun.enable,
    stack: s.tun.stack,
    "auto-route": true,
    "auto-redirect": process.platform === "linux" && !!s.tun.autoRedirect,
    "auto-detect-interface": true,
    "strict-route": !!s.tun.strictRoute,
    "dns-hijack": s.tun.dnsHijack && s.tun.dnsHijack.length ? s.tun.dnsHijack.slice() : ["any:53"],
    mtu: s.tun.mtu || 1500,
  };
  if (s.tun.device) config.tun.device = s.tun.device;
  return config;
}

// 与 Verge 的 use_merge 一致：dns 按子键替换，hosts 整体替换，其余递归合并
export function useMerge(merge, config) {
  const deep = (a, b) => {
    if (isMap(a) && isMap(b)) {
      for (const k of Object.keys(b)) a[k] = k in a ? deep(a[k], b[k]) : b[k];
      return a;
    }
    return b;
  };
  const out = clone(config);
  for (const [key, value] of Object.entries(clone(merge || {}))) {
    if (key === "dns" && isMap(out.dns) && isMap(value)) Object.assign(out.dns, value);
    else if (key in out && key !== "hosts") out[key] = deep(out[key], value);
    else out[key] = value;
  }
  return out;
}

// 与 Verge 一致：脚本在隔离的上下文里运行，配置以 JSON 传入传出；console 输出收集起来给界面显示
export function runScript(source, config, { overrides = null, name = "script", profileName = "", logs = [] } = {}) {
  const log = (level) => (...args) => logs.push({ source: name, level, message: args.map((a) => (typeof a === "string" ? a : safeJSON(a))).join(" ") });
  const sandbox = {
    console: { log: log("info"), info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") },
    __cfg: JSON.stringify(config),
    __overrides: JSON.stringify(overrides),
    __profile: profileName,
  };
  const code = `${source}
;(function () {
  const o = JSON.parse(__overrides);
  if (o && typeof CONFIG === "object") Object.assign(CONFIG, o);
  if (typeof main !== "function") throw new Error("脚本里没有 main(config) 函数");
  return JSON.stringify(main(JSON.parse(__cfg), __profile));
})()`;
  const result = vm.runInNewContext(code, sandbox, { timeout: 5000, filename: name + ".js" });
  const out = result ? JSON.parse(result) : null;
  if (!isMap(out)) throw new Error(`${name}：main 没有返回配置对象`);
  return out;
}

const safeJSON = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

// TUN 的 DNS 劫持需要内核 DNS；订阅没开 DNS、又关了防泄露时补一份最简的
function ensureDNS(config) {
  if (!config.tun.enable || (isMap(config.dns) && config.dns.enable)) return;
  config.dns = Object.assign({}, isMap(config.dns) ? config.dns : {}, {
    enable: true,
    ipv6: config.ipv6,
    "enhanced-mode": "fake-ip",
    "fake-ip-range": "198.18.0.1/16",
    "fake-ip-filter": ["+.lan", "+.local", "+.msftconnecttest.com", "+.msftncsi.com", "geosite:cn"],
    "default-nameserver": ["223.5.5.5", "119.29.29.29"],
    nameserver: ["https://223.5.5.5/dns-query", "https://1.12.12.12/dns-query"],
  });
}

// mihomo Smart 内核：把自动测速分组换成 Smart 分组（按实际连接质量学习选择节点）
function useSmartGroups(config) {
  config["proxy-groups"] = (config["proxy-groups"] || []).map((g) => {
    if (!isMap(g) || g.type !== "url-test") return g;
    const out = Object.assign({}, g, { type: "smart" });
    delete out.tolerance;
    return out;
  });
}

// core：{ id, kind }；sidecar：{ kind, bin } 可搭配的另一个内核（没有就是 null）
// singbox：{ providers, ruleSetPath, version } 转 sing-box 时用
export function generate({ profile, settings, scriptSource = "", mergeSource = "", profileName = "", core = { id: "mihomo", kind: "clash" }, sidecar = null, singbox = {} }) {
  const logs = [];
  const info = (message, level = "info") => logs.push({ source: "Knight", level, message });

  // 当前内核跑不了的节点：有另一个内核就交给它，没有就去掉
  const split = splitNodes(profile, core.kind, {
    sidecarKind: settings.combine && sidecar ? sidecar.kind : "",
    basePort: settings.sidecarPort,
    reserved: [settings.mixedPort, settings.controllerPort],
  });
  const otherLabel = core.kind === "singbox" ? "mihomo" : "sing-box";
  if (split.entries.length) info(`${split.entries.length} 个节点由 ${otherLabel} 搭配运行：${split.entries.map((e) => e.node.name).slice(0, 5).join("、")}`);
  if (split.dropped.length) {
    info(
      `${split.dropped.length} 个节点当前内核不支持，已跳过：${split.dropped.slice(0, 5).join("、")}` +
        (settings.combine ? `。在 设置 → 内核 里下载 ${otherLabel} 后会自动搭配使用` : "。打开「搭配使用」后可交给另一个内核运行"),
      "warn"
    );
  }

  let config = applySettings(clone(split.config), settings);

  if (settings.useMerge && mergeSource) config = useMerge(yaml.load(mergeSource), config);

  if (settings.leakGuard.enabled && scriptSource) {
    const overrides = {};
    for (const key of LEAK_OPTIONS) if (key in settings.leakGuard) overrides[key] = settings.leakGuard[key];
    if ("dnsIPv6" in overrides) overrides.dnsIPv6 = { all: true, off: false }[overrides.dnsIPv6] ?? "cn";
    config = runScript(scriptSource, config, { overrides, name: "防泄露", profileName, logs });
  }

  if (settings.customScript.enabled && settings.customScript.code.trim()) {
    config = runScript(settings.customScript.code, config, { name: "自定义脚本", profileName, logs });
  }

  // 自定义规则放在最前，重复生成不会叠加
  const extra = (settings.customRules || []).map((r) => String(r).trim()).filter(Boolean);
  if (extra.length) config.rules = extra.concat((Array.isArray(config.rules) ? config.rules : []).filter((r) => extra.indexOf(r) < 0));

  if (core.id === "mihomo-smart" && settings.smartGroups) useSmartGroups(config);

  // 回写：脚本只能读这些字段，不能改（严格路由例外：脚本只在设置没管理时才动它，这里总是由设置决定）
  config = applySettings(config, settings);
  ensureDNS(config);

  const side = split.entries.length ? { kind: sidecar.kind, entries: split.entries.length, text: sidecarConfig(sidecar.kind, split.entries) } : null;
  if (core.kind !== "singbox") {
    // 搭配的内核自己连节点，不能再被虚拟网卡绕回来
    if (side) {
      config.rules = [`PROCESS-PATH,${sidecar.bin},DIRECT`].concat(config.rules || []);
      config["find-process-mode"] = "strict";
    }
    return { kind: "clash", config, logs, text: yaml.dump(config, { lineWidth: -1, noRefs: true }), sidecar: side, ruleSets: [] };
  }
  const sb = toSingBox(config, settings, Object.assign({}, singbox, { sidecarBin: side ? sidecar.bin : "" }));
  sb.logs.forEach((l) => logs.push(Object.assign({ source: "sing-box 转换" }, l)));
  return { kind: "singbox", config, logs, text: JSON.stringify(sb.config, null, 2), sidecar: side, ruleSets: sb.ruleSets };
}

export const coreKind = (id) => (CORES[id] || CORES.mihomo).kind;
