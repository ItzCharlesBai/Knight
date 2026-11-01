// 图标：百合（鸢尾纹 fleur-de-lis，法国的百合纹章）——一条连续的赤陶色细线、奶油色的花，衬在夏日傍晚的暖色渐变和一轮淡淡的太阳上。
// 生成 resources/icons/icon.svg 和各尺寸 PNG（需要本机装有 playwright）：node scripts/icons.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons");

// 512×512 里的花：中间一瓣、左右两瓣向外翻卷、一道束带、下面三片小瓣
export const FLEUR = [
  "M256 74 C286 122 302 172 298 222 C294 262 278 292 270 314 L242 314 C234 292 218 262 214 222 C210 172 226 122 256 74 Z",
  "M240 304 C210 262 170 236 132 240 C102 243 86 268 98 292 C106 308 126 312 140 302 C122 300 114 284 124 272 C142 252 192 262 230 310 Z",
  "M272 304 C302 262 342 236 380 240 C410 243 426 268 414 292 C406 308 386 312 372 302 C390 300 398 284 388 272 C370 252 320 262 282 310 Z",
  "M206 300 H306 A14 14 0 0 1 306 328 H206 A14 14 0 0 1 206 300 Z",
  "M240 326 C240 360 249 390 256 416 C263 390 272 360 272 326 Z",
  "M228 326 C214 354 192 366 172 356 C188 356 204 344 212 326 Z",
  "M284 326 C298 354 320 366 340 356 C324 356 308 344 300 326 Z",
].join(" ");

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="#fdf3e4"/>
      <stop offset="0.6" stop-color="#f8d9bd"/>
      <stop offset="1" stop-color="#f0a888"/>
    </linearGradient>
    <clipPath id="sq"><rect x="16" y="16" width="480" height="480" rx="112"/></clipPath>
  </defs>
  <g clip-path="url(#sq)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <circle cx="352" cy="176" r="108" fill="#ffd98f" fill-opacity="0.55"/>
    <path d="M16 404 C140 384 300 420 496 392 L496 496 L16 496 Z" fill="#e9906c" fill-opacity="0.18"/>
  </g>
  <path d="${FLEUR}" fill="#8a3e2c" stroke="#8a3e2c" stroke-width="22" stroke-linejoin="round"/>
  <path d="${FLEUR}" fill="#fffaf3"/>
  <path d="M256 118 C251 172 251 236 256 286" fill="none" stroke="#d27a5a" stroke-width="5" stroke-linecap="round"/>
  <path d="M220 314 H292" stroke="#d27a5a" stroke-width="4" stroke-linecap="round"/>
</svg>
`;

// 托盘：实心的花（小尺寸下细线看不清）。开启时赤陶色、关闭时灰色；macOS 用黑色模板图
const tray = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="60 52 392 392"><path d="${FLEUR}" fill="${color}" stroke="${color}" stroke-width="14" stroke-linejoin="round"/></svg>`;

const outputs = [
  ["icon.png", ICON, 512],
  ["tray.png", tray("#e07a52"), 32],
  ["tray-off.png", tray("#8f857c"), 32],
  ["trayTemplate.png", tray("#000"), 22],
  ["trayTemplate@2x.png", tray("#000"), 44],
  ["trayOffTemplate.png", tray("rgba(0,0,0,0.45)"), 22],
  ["trayOffTemplate@2x.png", tray("rgba(0,0,0,0.45)"), 44],
];

writeFileSync(join(dir, "icon.svg"), ICON);
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
