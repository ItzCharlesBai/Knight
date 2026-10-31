// 由 resources/icons/icon.svg 生成各尺寸 PNG（需要本机装有 playwright）：node scripts/icons.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons");
const svg = readFileSync(join(dir, "icon.svg"), "utf8");
// 托盘：只有骑士的外轮廓和底座，线条加粗；开启时金色、关闭时灰色；macOS 用黑色模板图，系统自动适配深浅色菜单栏
const knight = (color) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="118 96 268 318"><g fill="none" stroke="${color}" stroke-width="26" stroke-linejoin="miter" stroke-miterlimit="10" stroke-linecap="square">` +
  `<polygon points="190,372 218,304 176,296 134,268 138,236 202,168 216,118 250,152 306,158 356,212 370,300 356,372"/><path d="M158,398 H368 M176,372 H352"/></g></svg>`;

const outputs = [
  ["icon.png", svg, 512],
  ["tray.png", knight("#c9a961"), 32],
  ["tray-off.png", knight("#8d8a84"), 32],
  ["trayTemplate.png", knight("#000"), 22],
  ["trayTemplate@2x.png", knight("#000"), 44],
  ["trayOffTemplate.png", knight("rgba(0,0,0,0.45)"), 22],
  ["trayOffTemplate@2x.png", knight("rgba(0,0,0,0.45)"), 44],
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
