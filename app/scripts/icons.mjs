// 由 resources/icons/icon.svg 生成各尺寸 PNG（需要本机装有 playwright）：node scripts/icons.mjs
// 图标里的月球来自 src/renderer/art/moon.svg（先运行 node scripts/art.mjs）
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "resources", "icons");
const moon = "data:image/svg+xml;base64," + readFileSync(join(root, "src", "renderer", "art", "moon.svg")).toString("base64");
const svg = readFileSync(join(dir, "icon.svg"), "utf8").replace('href="MOON"', `href="${moon}"`);
const KNIGHT = "M196 388 C206 336 222 306 240 288 C214 292 186 300 166 296 C146 292 132 276 136 256 C140 236 162 218 190 206 C210 176 222 150 230 120 C238 132 246 144 254 150 C304 150 352 190 362 252 C370 306 362 352 352 388 Z";
// 托盘：一轮月亮，骑士剪影从月面里镂空出来。开启时月亮是亮的，关闭时是灰的；macOS 用黑色模板图
const tray = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="40 40 432 432"><defs><mask id="m"><rect x="0" y="0" width="512" height="512" fill="#fff"/>` +
  `<path d="${KNIGHT}" fill="#000" transform="translate(6 44)"/></mask></defs><circle cx="256" cy="256" r="210" fill="${color}" mask="url(#m)"/></svg>`;

const outputs = [
  ["icon.png", svg, 512],
  ["tray.png", tray("#e9e4d8"), 32],
  ["tray-off.png", tray("#7d8290"), 32],
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
  await page.waitForTimeout(150);
  await page.locator("svg").screenshot({ path: join(dir, name), omitBackground: true });
  console.log(name);
}
await browser.close();
