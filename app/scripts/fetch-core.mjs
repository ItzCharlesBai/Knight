// 下载 mihomo 内核到 resources/core/<os>-<arch>/、GEO 数据到 resources/geo/，打包时随应用一起发布
// （首次启动不用再联网下载 GEO 数据，jsDelivr 访问不了时也能直接用）
//   node scripts/fetch-core.mjs [--platform win32|darwin|linux] [--arch x64|arm64] [--version v1.19.33] [--mirror https://ghfast.top/]
// 网络需要代理时：NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7897 node scripts/fetch-core.mjs
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { coreFileName, downloadCore, downloadGeo, GEO_FILES } from "../src/main/core-download.js";

const { values } = parseArgs({
  options: {
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
    version: { type: "string", default: "" },
    mirror: { type: "string", default: process.env.GITHUB_MIRROR || "" },
  },
});

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
// 目录名与 electron-builder 的 ${os}-${arch} 一致
const os = { win32: "win", darwin: "mac", linux: "linux" }[values.platform];
const dir = join(resources, "core", `${os}-${values.arch}`);
const { version, binary } = await downloadCore(values);
mkdirSync(dir, { recursive: true });
const file = join(dir, coreFileName(values.platform));
writeFileSync(file, binary);
chmodSync(file, 0o755);
writeFileSync(join(dir, "version.txt"), version);
console.log(`mihomo ${version} → ${file}`);

const geoDir = join(resources, "geo");
mkdirSync(geoDir, { recursive: true });
for (const name of GEO_FILES) {
  if (existsSync(join(geoDir, name))) continue;
  writeFileSync(join(geoDir, name), await downloadGeo(name, values));
  console.log(`${name} → ${geoDir}`);
}
