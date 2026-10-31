// 订阅转换（转换页）：多个来源 → 处理节点 → 套模板 → 输出成需要的格式。全部在本机完成，订阅链接不会发给任何转换服务
import yaml from "js-yaml";
import { ruleSetUrls } from "./core-download.js";
import { runScript } from "./enhance.js";
import { toLinks } from "./links.js";
import { applyConvert, regionOf } from "./nodes.js";
import { mergeParts } from "./profiles.js";
import { toSingBox } from "./singbox.js";
import { DEFAULTS, mergePatch } from "./store.js";

export const TARGETS = [
  ["clash", "mihomo / Clash 配置", "yaml"],
  ["singbox", "sing-box 配置", "json"],
  ["proxies", "仅节点列表（proxies）", "yaml"],
  ["base64", "分享链接（Base64 订阅）", "txt"],
  ["links", "分享链接（逐行明文）", "txt"],
];

const dump = (v) => yaml.dump(v, { lineWidth: -1, noRefs: true });

// parts：[{ label, config }]；leakGuard 为 true 时在输出里带上仓库的防泄露设置
export function convert(parts, { options = {}, target = "clash", leakGuard = false, scriptSource = "" } = {}) {
  const config = applyConvert(mergeParts(parts), options);
  const nodes = config.proxies || [];
  const regions = {};
  for (const n of nodes) {
    const r = regionOf(n.name);
    const key = r ? `${r.flag} ${r.name}` : "其他";
    regions[key] = (regions[key] || 0) + 1;
  }
  const logs = [];
  const withGuard = (c) => (leakGuard && scriptSource ? runScript(scriptSource, c, { name: "防泄露", logs }) : c);
  let text = "";
  let skipped = [];
  if (target === "clash") {
    text = dump(withGuard(Object.assign({ "mixed-port": 7890, "allow-lan": false, mode: "rule", "log-level": "info", ipv6: true }, config)));
  } else if (target === "proxies") {
    text = dump({ proxies: nodes });
  } else if (target === "singbox") {
    const settings = Object.assign(mergePatch(DEFAULTS, { mixedPort: 7890, controllerPort: 9090, tun: { enable: true }, leakGuard: { enabled: !!leakGuard } }), { secret: "" });
    const r = toSingBox(withGuard(Object.assign({ ipv6: true }, config)), settings, { ruleSetUrl: (tag) => ruleSetUrls(tag)[0] });
    r.logs.forEach((l) => logs.push(Object.assign({ source: "sing-box 转换" }, l)));
    text = JSON.stringify(r.config, null, 2);
  } else {
    const r = toLinks(nodes, { base64: target === "base64" });
    text = r.text;
    skipped = r.skipped;
  }
  return {
    text,
    count: nodes.length,
    providers: Object.keys(config["proxy-providers"] || {}).length,
    groups: (config["proxy-groups"] || []).length,
    regions: Object.entries(regions).sort((a, b) => b[1] - a[1]),
    skipped,
    warnings: logs.filter((l) => l.level === "warn").map((l) => l.message),
    ext: (TARGETS.find((t) => t[0] === target) || TARGETS[0])[2],
  };
}
