// 图标：一只猫的侧脸，几笔橄榄色的线勾出来，里面一层淡淡的黄色，往脖子下面慢慢淡掉；没有底色，没有边框，像 Clash 系的图标一样简单。
// 托盘用同一个侧脸的实心剪影。生成 resources/icons/ 下的 PNG（需要本机装有 playwright）：node scripts/icons.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons");
const OLIVE = "#6a7044";

// 侧脸朝左：后颈 → 后脑 → 耳朵 → 额头 → 鼻梁 → 鼻尖是一笔；鼻尖 → 嘴 → 下巴 → 喉咙 → 胸口是一笔
const BACK = "M344 396 C340 356 328 314 314 286 C304 264 300 244 300 222 C300 196 288 176 266 164 L234 84 C226 108 216 134 204 158 C186 168 168 184 160 198 C155 206 152 214 146 222 C140 230 134 236 130 240";
const FRONT = "M130 240 C132 248 138 252 146 252 C148 258 150 262 148 268 C160 282 178 292 198 300 C214 314 222 340 226 368 C228 378 228 388 228 396";
const FAR_EAR = "M198 160 C200 136 204 112 208 92 C214 108 220 122 226 134";
const HEAD = "M228 396 C228 388 228 378 226 368 C222 340 214 314 198 300 C178 292 160 282 148 268 C150 262 148 258 146 252 C138 252 132 248 130 240 C134 236 140 230 146 222 C152 214 155 206 160 198 C168 184 186 168 204 158 C216 134 226 108 234 84 L266 164 C288 176 300 196 300 222 C300 244 304 264 314 286 C328 314 340 356 344 396 Z";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="46 58 340 340">
<defs>
  <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.62" stop-color="#fff"/><stop offset="0.95" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512"><rect x="0" y="60" width="512" height="340" fill="url(#fade)"/></mask>
  <filter id="soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2.5"/></filter>
</defs>
<g mask="url(#m)">
  <path d="${HEAD}" fill="#f3e3a3" fill-opacity="0.75" transform="translate(6 5)" filter="url(#soft)"/>
  <g fill="none" stroke="${OLIVE}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${FAR_EAR}" stroke-width="5" stroke-opacity="0.55"/>
    <path d="${BACK}" stroke-width="7.5"/>
    <path d="${FRONT}" stroke-width="7.5"/>
  </g>
</g>
<g fill="none" stroke="${OLIVE}" stroke-linecap="round" stroke-linejoin="round">
  <path d="M236 108 C244 126 248 146 246 162" stroke-width="3.5" stroke-opacity="0.6"/>
  <path d="M160 210 C168 200 182 196 194 200 C186 210 172 214 160 210 Z" stroke-width="4"/>
  <path d="M174 204 C172 207 172 210 174 212" stroke-width="5.5"/>
  <path d="M129 236 L139 233 L136 242 Z" fill="${OLIVE}" stroke-width="2.5"/>
  <path d="M150 250 C120 238 92 234 60 236 M152 256 C122 254 94 258 64 270 M154 262 C130 268 108 282 92 300" stroke-width="2.2" stroke-opacity="0.7"/>
  <path d="M196 232 C206 240 212 250 214 262" stroke-width="3" stroke-opacity="0.45"/>
</g>
</svg>
`;

// 托盘：侧脸的实心剪影（只要头和一点脖子），眼睛镂空。彩色版淡黄填充 + 橄榄描边，深浅任务栏都看得清；macOS 用黑色模板图
const tray = (fill, stroke) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="112 74 216 216">
<defs><clipPath id="c"><rect x="0" y="0" width="512" height="300"/></clipPath>
<mask id="e"><rect x="0" y="0" width="512" height="512" fill="#fff"/><path d="M160 210 C168 200 182 196 194 200 C186 210 172 214 160 210 Z" fill="#000"/></mask></defs>
<g clip-path="url(#c)" mask="url(#e)"><path d="${HEAD}" fill="${fill}" ${stroke ? `stroke="${stroke}" stroke-width="14" stroke-linejoin="round" paint-order="stroke"` : ""}/></g></svg>`;

const outputs = [
  ["icon.png", ICON, 1024],
  ["tray.png", tray("#f3e3a3", OLIVE), 32],
  ["tray-off.png", tray("#dedbd2", "#7d8084"), 32],
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
