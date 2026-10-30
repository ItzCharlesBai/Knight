// 下载 mihomo 内核：打包脚本（scripts/fetch-core.mjs）和应用内「更新内核」共用
import zlib from "node:zlib";

const RELEASES = "https://github.com/MetaCubeX/mihomo/releases";

export const coreFileName = (platform = process.platform) => (platform === "win32" ? "mihomo.exe" : "mihomo");

// 官方发布的文件名，例如 mihomo-windows-amd64-v1.19.33.zip / mihomo-darwin-arm64-v1.19.33.gz
export function assetName(version, platform = process.platform, arch = process.arch) {
  const os = { win32: "windows", darwin: "darwin", linux: "linux" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64", ia32: "386", arm: "armv7" }[arch];
  if (!os || !cpu) throw new Error(`不支持的平台：${platform}-${arch}`);
  // amd64 用 compatible 版本：不要求 CPU 支持 AVX2 等新指令，老电脑也能跑
  const variant = cpu === "amd64" ? "-compatible" : "";
  return `mihomo-${os}-${cpu}${variant}-${version}.${platform === "win32" ? "zip" : "gz"}`;
}

// mirror：GitHub 加速前缀，例如 "https://ghfast.top/"，留空直连 GitHub
const withMirror = (url, mirror) => (mirror ? mirror.replace(/\/?$/, "/") + url : url);

async function get(fetchFn, url) {
  const res = await fetchFn(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function latestVersion({ fetch: fetchFn = fetch, mirror = "" } = {}) {
  const text = (await get(fetchFn, withMirror(`${RELEASES}/latest/download/version.txt`, mirror))).toString("utf8").trim();
  if (!/^v\d+\.\d+\.\d+/.test(text)) throw new Error("无法识别内核版本号：" + text.slice(0, 40));
  return text;
}

export async function downloadCore({ version, platform = process.platform, arch = process.arch, fetch: fetchFn = fetch, mirror = "" } = {}) {
  version = version || (await latestVersion({ fetch: fetchFn, mirror }));
  const name = assetName(version, platform, arch);
  const archive = await get(fetchFn, withMirror(`${RELEASES}/download/${version}/${name}`, mirror));
  return { version, binary: extract(archive, name) };
}

// GEO 数据：与 script.js 里的 geox-url 同源（MetaCubeX/meta-rules-dat）
export const GEO_FILES = ["geoip.dat", "geosite.dat", "country.mmdb"];
export async function downloadGeo(name, { fetch: fetchFn = fetch, mirror = "" } = {}) {
  return get(fetchFn, withMirror(`https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/${name}`, mirror));
}

export function extract(buf, name) {
  if (name.endsWith(".gz")) return zlib.gunzipSync(buf);
  if (name.endsWith(".zip")) return unzipFirst(buf, (entry) => /\.exe$/i.test(entry));
  throw new Error("未知的压缩格式：" + name);
}

// 只够解开官方 zip 的最小实现：读中央目录，取第一个匹配的文件（存储或 deflate）
export function unzipFirst(buf, match) {
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
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const entry = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!match(entry)) continue;
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error("不支持的 zip 压缩方式：" + method);
  }
  throw new Error("zip 里没有找到内核文件");
}
