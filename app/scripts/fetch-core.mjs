// 下载内核到 resources/core/<os>-<arch>/、GEO 数据到 resources/geo/，打包时随应用一起发布
// （首次启动不用再联网下载 GEO 数据，jsDelivr 访问不了时也能直接用）
//   node scripts/fetch-core.mjs [--core mihomo|mihomo-alpha|mihomo-smart|sing-box] [--platform win32|darwin|linux] [--arch x64|arm64]
//                               [--version v1.19.33] [--mirror https://ghfast.top/] [--out 目录]
// 安装包只带 mihomo；其他内核在应用里按需下载。--out 可以把别的内核下载到指定目录（比如给测试用）。
// 网络需要代理时：NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/fetch-core.mjs
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CORES, downloadCore, downloadGeo, GEO_FILES } from "../src/main/core-download.js";

const { values } = parseArgs({
  options: {
    core: { type: "string", default: "mihomo" },
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
    version: { type: "string", default: "" },
    mirror: { type: "string", default: process.env.GITHUB_MIRROR || "" },
    out: { type: "string", default: "" },
  },
});
if (!CORES[values.core]) throw new Error("未知内核：" + values.core);

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
// 目录名与 electron-builder 的 ${os}-${arch} 一致
const os = { win32: "win", darwin: "mac", linux: "linux" }[values.platform];
const dir = values.out || join(resources, "core", `${os}-${values.arch}`);
const { version, files } = await downloadCore({ id: values.core, version: values.version, platform: values.platform, arch: values.arch, mirror: values.mirror });
mkdirSync(dir, { recursive: true });
for (const file of files) {
  writeFileSync(join(dir, file.name), file.data);
  chmodSync(join(dir, file.name), 0o755);
}
writeFileSync(join(dir, "version.txt"), version);
console.log(`${CORES[values.core].label} ${version} → ${dir}（${files.map((f) => f.name).join("、")}）`);

if (CORES[values.core].kind === "clash" && !values.out) {
  const geoDir = join(resources, "geo");
  mkdirSync(geoDir, { recursive: true });
  for (const name of GEO_FILES) {
    if (existsSync(join(geoDir, name))) continue;
    writeFileSync(join(geoDir, name), await downloadGeo(name, values));
    console.log(`${name} → ${geoDir}`);
  }
}
