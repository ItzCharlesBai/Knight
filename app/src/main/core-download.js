// 内核登记表与下载：打包脚本（scripts/fetch-core.mjs）和应用内「下载 / 更新内核」共用
import zlib from "node:zlib";

// kind：clash = mihomo 系（读 Clash YAML，一套配置通用）；singbox = sing-box（配置由 Ondine 自动转换）；
// xray = Xray-core、juicity = Juicity（没有 Clash 控制接口，只作为搭配内核运行部分节点）。sidecarOnly 的内核不能当主内核
export const CORES = {
  mihomo: {
    label: "mihomo",
    desc: "MetaCubeX 稳定版，默认内核，防泄露脚本原生支持",
    kind: "clash",
    repo: "MetaCubeX/mihomo",
    tag: "",
  },
  "mihomo-alpha": {
    label: "mihomo Alpha",
    desc: "MetaCubeX 测试版，新协议、新功能先到",
    kind: "clash",
    repo: "MetaCubeX/mihomo",
    tag: "Prerelease-Alpha",
  },
  "sing-box": {
    label: "sing-box",
    desc: "SagerNet 的另一套实现，支持 NaiveProxy；订阅和防泄露规则由 Ondine 自动转换",
    kind: "singbox",
    repo: "SagerNet/sing-box",
    tag: "",
  },
  "sing-box-beta": {
    label: "sing-box 测试版",
    desc: "sing-box 的最新预发布版本（alpha / beta），与正式版共用同一套转换",
    kind: "singbox",
    repo: "SagerNet/sing-box",
    tag: "",
    prerelease: true,
  },
  xray: {
    label: "Xray",
    desc: "XTLS 官方实现，VLESS / XHTTP / REALITY 的参考内核。只作搭配：可以让它专门运行 VLESS 节点",
    kind: "xray",
    repo: "XTLS/Xray-core",
    tag: "",
    sidecarOnly: true,
  },
  juicity: {
    label: "Juicity",
    desc: "基于 QUIC 的 Juicity 协议的官方实现，mihomo 和 sing-box 都还不支持。只作搭配：每个 Juicity 节点由它单独运行",
    kind: "juicity",
    repo: "juicity/juicity",
    tag: "",
    sidecarOnly: true,
    perNode: true, // 一个进程只能连一台服务器
  },
};
export const CORE_IDS = Object.keys(CORES);

const BIN = { clash: "mihomo", singbox: "sing-box", xray: "xray", juicity: "juicity-client" };
export const binName = (id = "mihomo", platform = process.platform) => BIN[(CORES[id] || CORES.mihomo).kind] + (platform === "win32" ? ".exe" : "");
export const coreFileName = (platform = process.platform) => binName("mihomo", platform);

const OS = { win32: "windows", darwin: "darwin", linux: "linux" };
const CPU = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "armv7" };

// 官方发布的文件名，例如 mihomo-windows-amd64-compatible-v1.19.33.zip、sing-box-1.14.4-linux-amd64.tar.gz
export function assetName(version, platform = process.platform, arch = process.arch, id = "mihomo") {
  const os = OS[platform];
  const cpu = CPU[arch];
  if (!os || !cpu) throw new Error(`不支持的平台：${platform}-${arch}`);
  const kind = (CORES[id] || {}).kind;
  if (kind === "singbox") return `sing-box-${String(version).replace(/^v/, "")}-${os}-${cpu}.${platform === "win32" ? "zip" : "tar.gz"}`;
  if (kind === "xray") {
    const xos = { windows: "windows", darwin: "macos", linux: "linux" }[os];
    const xcpu = { amd64: "64", arm64: "arm64-v8a", 386: "32", armv7: "arm32-v7a" }[cpu];
    return `Xray-${xos}-${xcpu}.zip`;
  }
  // juicity-linux-x86_64.zip、juicity-macos-arm64.zip、juicity-windows-x86_64.zip
  if (kind === "juicity") {
    const jos = { windows: "windows", darwin: "macos", linux: "linux" }[os];
    const jcpu = { amd64: "x86_64", arm64: "arm64", 386: "x86_32", armv7: "armv7" }[cpu];
    return `juicity-${jos}-${jcpu}.zip`;
  }
  // amd64 用 compatible 版本：不要求 CPU 支持 AVX2 等新指令，老电脑也能跑
  const variant = cpu === "amd64" ? "-compatible" : "";
  return `mihomo-${os}-${cpu}${variant}-${version}.${platform === "win32" ? "zip" : "gz"}`;
}

// mirror：GitHub 加速前缀，例如 "https://ghfast.top/"，留空直连 GitHub
export const withMirror = (url, mirror) => (mirror ? mirror.replace(/\/?$/, "/") + url : url);
const releases = (id) => `https://github.com/${CORES[id].repo}/releases`;

// GitHub 偶尔会回 5xx、429，或者连接中途断开、挂住不响应：等一会儿再试，最多四次（等 2、5、10 秒）
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
export const retry = { tries: 4, wait: (attempt) => [2000, 5000, 10000][attempt - 1] || 10000, headerTimeout: 30000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 一次请求：headerTimeout 内没收到响应头就放弃这一次，交给外面重试（连接挂住时 fetch 默认要等 5 分钟）
async function once(fetchFn, url, options = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`等待响应超时：${url}`)), retry.headerTimeout);
  try {
    return await fetchFn(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, ctl.signal]) : ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRetry(fetchFn, url, options, tries = retry.tries) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await once(fetchFn, url, options);
      if (!TRANSIENT.has(res.status) || attempt >= tries) return res;
    } catch (err) {
      if (attempt >= tries) throw err;
    }
    await sleep(retry.wait(attempt));
  }
}

// 下载文件：内容读到一半断了也算一次失败，一起重试
async function get(fetchFn, url, tries = retry.tries) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await once(fetchFn, url, { redirect: "follow" });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(retry.wait(attempt));
      continue;
    }
    if (!TRANSIENT.has(res.status) || attempt >= tries) throw new Error(`下载失败 ${res.status}：${url}`);
    await sleep(retry.wait(attempt));
  }
}

// tries：只是顺便查一下版本号、查不到有备用值的地方传 1，不必等重试
export async function latestVersion({ id = "mihomo", fetch: fetchFn = fetch, mirror = "", tries = retry.tries } = {}) {
  const spec = CORES[id];
  if (!spec) throw new Error("未知内核：" + id);
  if (spec.kind === "clash") {
    const url = spec.tag ? `${releases(id)}/download/${spec.tag}/version.txt` : `${releases(id)}/latest/download/version.txt`;
    try {
      const text = (await get(fetchFn, withMirror(url, mirror), tries)).toString("utf8").trim();
      if (!/^(v\d+\.\d+\.\d+|alpha-[\w-]+)$/.test(text)) throw new Error("无法识别内核版本号：" + text.slice(0, 40));
      return text;
    } catch (err) {
      // version.txt 下载不了（GitHub 的文件服务出问题时会这样）：稳定版改从 /releases/latest 的跳转里读版本号
      if (spec.tag) throw err;
      return latestFromRedirect(id, fetchFn, mirror, tries).catch(() => Promise.reject(err));
    }
  }
  // 预发布版：从发布列表里取最新的一个预发布
  if (spec.prerelease) {
    const res = await fetchRetry(fetchFn, `https://api.github.com/repos/${spec.repo}/releases?per_page=15`, { headers: { Accept: "application/vnd.github+json" } }, tries);
    if (!res.ok) throw new Error(`无法获取 ${spec.label} 的版本列表（HTTP ${res.status}）`);
    const pre = (await res.json()).find((r) => r && r.prerelease && !r.draft);
    if (!pre) throw new Error(`暂时没有 ${spec.label}`);
    return pre.tag_name;
  }
  // sing-box、Xray 没有 version.txt
  return latestFromRedirect(id, fetchFn, mirror, tries);
}

// /releases/latest 会跳转到 /releases/tag/v1.x.y：从跳转后的地址（或页面里的链接）读版本号；
// 网页也打不开时再问 GitHub API（另一套服务）。CI 里设了 ONDINE_GITHUB_TOKEN 就带上，不容易被限流
async function latestFromRedirect(id, fetchFn, mirror, tries) {
  try {
    const res = await fetchRetry(fetchFn, withMirror(`${releases(id)}/latest`, mirror), { redirect: "follow" }, tries);
    const tag = /\/releases\/tag\/(v\d+\.\d+\.\d+)(?:$|[?#])/.exec(res.url || "") || (res.ok && /\/releases\/tag\/(v\d+\.\d+\.\d+)"/.exec(await res.text()));
    if (tag) return tag[1];
  } catch {
    /* 下面问 API */
  }
  const token = globalThis.process?.env?.ONDINE_GITHUB_TOKEN;
  const headers = { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const res = await fetchRetry(fetchFn, `https://api.github.com/repos/${CORES[id].repo}/releases/latest`, { headers }, tries);
  const tag = res.ok ? (await res.json()).tag_name : "";
  if (!/^v\d+\.\d+\.\d+$/.test(tag || "")) throw new Error(`无法获取 ${CORES[id].label} 最新版本号`);
  return tag;
}

// 返回 { version, files: [{ name, data }] }，第一个是内核本身（sing-box 在 Linux / Windows 上还带 libcronet）
export async function downloadCore({ id = "mihomo", version, platform = process.platform, arch = process.arch, fetch: fetchFn = fetch, mirror = "" } = {}) {
  version = version || (await latestVersion({ id, fetch: fetchFn, mirror }));
  const name = assetName(version, platform, arch, id);
  const tag = CORES[id].tag || version;
  const archive = await get(fetchFn, withMirror(`${releases(id)}/download/${tag}/${name}`, mirror));
  return { version, files: extractCore(archive, name, binName(id, platform)) };
}

export function extractCore(archive, name, bin) {
  if (name.endsWith(".tar.gz")) return pickBinary(untar(zlib.gunzipSync(archive)), bin);
  if (name.endsWith(".gz")) return [{ name: bin, data: zlib.gunzipSync(archive) }];
  if (name.endsWith(".zip")) return pickBinary(unzip(archive), bin);
  throw new Error("未知的压缩格式：" + name);
}

// 压缩包里的文件放平；可执行文件统一改名为 mihomo(.exe) / sing-box(.exe) 等，另外只保留它要用的动态库（sing-box 的 libcronet）
const LIB = /\.(so|dylib|dll)(\.\d+)*$/i;
function pickBinary(entries, bin) {
  const files = entries.map((e) => ({ name: e.name.split("/").pop(), data: e.data })).filter((f) => f.name);
  const exact = files.find((f) => f.name.toLowerCase() === bin.toLowerCase() || f.name === bin.replace(/\.exe$/, ""));
  const exe = exact || (bin.endsWith(".exe") ? files.find((f) => /\.exe$/i.test(f.name)) : files.find((f) => !LIB.test(f.name) && !/\.(dat|json|service|md|txt)$|^(LICENSE|README)/i.test(f.name)));
  if (!exe) throw new Error("压缩包里没有找到内核文件");
  return [{ name: bin, data: exe.data }, ...files.filter((f) => f !== exe && LIB.test(f.name))];
}

// 最小 tar 解析：普通文件，支持 ustar 前缀和 GNU 长文件名
export function untar(buf) {
  const out = [];
  let longName = "";
  for (let p = 0; p + 512 <= buf.length; ) {
    const header = buf.subarray(p, p + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.toString("utf8", start, start + len).replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(257, 6).startsWith("ustar") ? field(345, 155) : "";
    let name = longName || (prefix ? prefix + "/" : "") + field(0, 100);
    longName = "";
    const data = buf.subarray(p + 512, p + 512 + size);
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "0" || type === "\0") out.push({ name, data: Buffer.from(data) });
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// 最小 zip 解析：读中央目录，存储或 deflate
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip 文件损坏");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.push({ name, data: Buffer.from(data) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(data) });
    else throw new Error("不支持的 zip 压缩方式：" + method);
  }
  return out;
}

export function unzipFirst(buf, match) {
  const entry = unzip(buf).find((e) => match(e.name));
  if (!entry) throw new Error("zip 里没有找到内核文件");
  return entry.data;
}

// GEO 数据：与 script.js 里的 geox-url 同源（MetaCubeX/meta-rules-dat）
export const GEO_FILES = ["geoip.dat", "geosite.dat", "country.mmdb"];
export async function downloadGeo(name, { fetch: fetchFn = fetch, mirror = "" } = {}) {
  return get(fetchFn, withMirror(`https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/${name}`, mirror));
}

// sing-box 的规则集（.srs）：geosite-cn → geo/geosite/cn.srs，geoip-cn → geo/geoip/cn.srs
export function ruleSetUrls(tag, mirror = "") {
  const [kind, ...rest] = tag.split("-");
  const path = `geo/${kind}/${rest.join("-")}.srs`;
  return [`https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/${path}`, withMirror(`https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/sing/${path}`, mirror)];
}
export async function downloadRuleSet(tag, { fetch: fetchFn = fetch, mirror = "" } = {}) {
  let lastError;
  for (const url of ruleSetUrls(tag, mirror)) {
    try {
      return await get(fetchFn, url);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
