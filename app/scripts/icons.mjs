// 由 resources/icons/icon.svg 生成各尺寸 PNG（需要本机装有 playwright）：node scripts/icons.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons");
const svg = readFileSync(join(dir, "icon.svg"), "utf8");
// 托盘：只有盾牌和 K，彩色（开启）/ 灰色（关闭）；macOS 用黑色模板图，系统自动适配深浅色菜单栏
const glyph = (color, width = 40) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 72 320 380"><path d="M256 92 L388 140 V252 C388 336 330 396 256 424 C182 396 124 336 124 252 V140 Z" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/><path d="M212 188 V332 M300 188 L222 262 L304 332" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const outputs = [
  ["icon.png", svg, 512],
  ["tray.png", glyph("#4b5cf0", 44), 32],
  ["tray-off.png", glyph("#8a8f98", 44), 32],
  ["trayTemplate.png", glyph("#000", 44), 22],
  ["trayTemplate@2x.png", glyph("#000", 44), 44],
  ["trayOffTemplate.png", glyph("rgba(0,0,0,0.45)", 44), 22],
  ["trayOffTemplate@2x.png", glyph("rgba(0,0,0,0.45)", 44), 44],
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
