// 应用设置：保存在 userData/settings.json，缺的字段用默认值补齐
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const DEFAULTS = {
  // 主内核：mihomo | mihomo-alpha | sing-box | sing-box-beta（Xray 等只能搭配使用）
  core: "mihomo",
  // 搭配使用：当前内核不支持的节点交给另一个已下载的内核运行（本地 SOCKS 入口从 sidecarPort 开始）
  combine: true,
  sidecarPort: 7920,
  // 哪些 VLESS 节点优先交给 Xray（需要先下载 Xray）：off | reality | vless
  xrayFor: "off",
  mode: "rule",
  mixedPort: 7897,
  controllerPort: 9097,
  allowLan: false,
  ipv6: true,
  logLevel: "info",
  unifiedDelay: true,
  findProcess: true,
  tun: { enable: false, stack: "mixed", strictRoute: true, autoRedirect: false, dnsHijack: ["any:53"], mtu: 1500, device: "" },

  // 系统代理
  systemProxy: false,
  proxyBypass: "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>",

  // 防泄露（仓库里的 clash-verge-rev/script.js），参数含义见 README 第六节
  leakGuard: {
    enabled: true,
    webrtc: "follow",
    udpLeakGuard: true,
    blockQUIC: false,
    dnsIPv6: "cn", // "cn" | "all" | "off"，对应脚本里的 "cn" / true / false
    realIPForCN: true,
    dnsECS: "223.5.5.0/24",
    blockDNSBypass: true,
    lanDNS: "",
    removeInfoNodes: true,
    forceUDP: false,
    clientFingerprint: "",
    sniffer: false,
    tuneHealthCheck: false,
    proxyGroup: "",
  },
  useMerge: false,
  customRules: [],
  customScript: { enabled: false, code: "// 在防泄露脚本之后执行，config 是生成好的配置\nfunction main(config, profileName) {\n  return config;\n}\n" },

  // 共享订阅：局域网里的订阅地址（/sub/<token>/<格式>），profiles 为空表示共享在用的订阅
  share: {
    enabled: false,
    port: 7899,
    token: "",
    profiles: [],
    options: { template: "region", include: "", exclude: "", types: "", dropInfo: true, rename: "", emoji: true, dedupe: true, sort: "none", udp: false, skipCert: false },
    leakGuard: false,
  },

  // 测速
  delayUrl: "https://www.gstatic.com/generate_204",
  delayTimeout: 5000,

  // 订阅：主订阅（提供分组和规则）+ 同时使用的其他订阅（节点作为额外的分组加入）
  currentProfile: "",
  extraProfiles: [],
  // 应用
  autoLaunch: false,
  silentStart: false,
  closeToTray: true,
  theme: "mist", // 窗外的天气：mist 晨雾（默认）| rain 细雨 | sun 晴光，都是浅色
  script: "hant", // 界面文字：hant 繁體（默认）| hans 简体
  font: "sans", // 字体：sans 思源黑体（随应用打包，默认）| system 系统字体（微软雅黑 / 苹方）
  motion: true, // 动态效果：光束、雾、微尘、细雨和操作时的光点
  githubMirror: "",
  updateViaProxy: false,
};

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function fill(defaults, value) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : defaults;
  if (!isMap(defaults)) return value === undefined || typeof value !== typeof defaults ? defaults : value;
  const out = {};
  for (const key of Object.keys(defaults)) out[key] = fill(defaults[key], isMap(value) ? value[key] : undefined);
  return out;
}

// 只合并认识的字段，类型不对的丢掉
export function mergePatch(current, patch) {
  const out = JSON.parse(JSON.stringify(current));
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) continue;
    if (isMap(DEFAULTS[key])) out[key] = fill(DEFAULTS[key], Object.assign({}, out[key], value));
    else out[key] = fill(DEFAULTS[key], value);
  }
  return out;
}

export class Store {
  constructor(file) {
    this.file = file;
    let saved = {};
    try {
      if (existsSync(file)) saved = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      saved = {};
    }
    this.data = fill(DEFAULTS, saved);
    this.data.secret = typeof saved.secret === "string" && saved.secret ? saved.secret : randomBytes(16).toString("hex");
    this.save();
  }

  get() {
    return this.data;
  }

  set(patch) {
    const secret = this.data.secret;
    this.data = mergePatch(this.data, patch);
    this.data.secret = secret;
    this.save();
    return this.data;
  }

  save() {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
