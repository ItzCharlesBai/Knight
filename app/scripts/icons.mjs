// 由 resources/icons/icon.svg 生成各尺寸 PNG（需要本机装有 playwright）：node scripts/icons.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons");
const svg = readFileSync(join(dir, "icon.svg"), "utf8");
const KNIGHT = "M196 388 C206 336 222 306 240 288 C214 292 186 300 166 296 C146 292 132 276 136 256 C140 236 162 218 190 206 C210 176 222 150 230 120 C238 132 246 144 254 150 C304 150 352 190 362 252 C370 306 362 352 352 388 Z";
// 托盘：实心骑士剪影 + 底座；开启时右上角一个朱红太阳，关闭时整体灰色。macOS 用黑色模板图，系统自动适配深浅色菜单栏
const tray = (color, sun) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="112 96 288 336">` +
  (sun ? `<circle cx="340" cy="170" r="58" fill="${sun}"/>` : "") +
  `<path d="${KNIGHT}" fill="${color}"/><rect x="150" y="390" width="220" height="34" rx="17" fill="${color}"/></svg>`;

const outputs = [
  ["icon.png", svg, 512],
  ["tray.png", tray("#13213C", "#E3492E"), 32],
  ["tray-off.png", tray("#8d8a84"), 32],
  ["trayTemplate.png", tray("#000"), 22],
  ["trayTemplate@2x.png", tray("#000"), 44],
  ["trayOffTemplate.png", tray("rgba(0,0,0,0.45)"), 22],
  ["trayOffTemplate@2x.png", tray("rgba(0,0,0,0.45)"), 44],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, markup, size] of outputs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${markup.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.locator("svg").screenshot({ path: join(dir, name), omitBackground: true });
  console.log(name);
}
await browser.close();
