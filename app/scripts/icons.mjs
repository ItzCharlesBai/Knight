// 图标：一只侧身坐着的小猫，几乎一笔画出来，尾巴卷在身后；淡淡的金色线条，没有底色，没有边框。
// 小尺寸（任务栏、托盘、Finder 列表）按尺寸加粗线条、去掉胡须，像字体的光学尺寸，缩小了也看得清。
// 生成（需要本机装有 playwright）：node scripts/icons.mjs
//   resources/icons/  运行时用：icon.svg、icon.png、icon.ico（Windows 窗口、exe 和安装包）、托盘图标（带 @1.5x / @2x）
//   build/            只在打包时用：icon.icns（macOS）、icons/<n>x<n>.png（Linux）
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "resources", "icons");
const build = join(root, "build");
const GOLD = "#c9a65f"; // 淡金，不扎眼
const GREY = "#9a9a9a";

// 朝左坐着：背 → 后脑 → 耳朵 → 头顶 → 另一只耳朵 → 额头 → 鼻子 → 下巴 → 胸口 → 前爪 → 地面 → 后腿是一笔
const BODY = "M374 432 C394 420 402 392 396 362 C388 320 354 292 320 276 C304 268 293 256 291 238 C293 214 289 192 277 176 L287 118 L244 145 C230 141 214 141 200 145 L168 114 L168 170 C154 186 146 206 148 226 C143 231 141 238 144 244 C149 251 158 254 166 254 C168 268 174 279 184 287 C176 316 174 352 179 388 C181 404 182 418 181 428 C176 430 172 433 172 437 L374 437";
const LEG = "M234 436 C229 404 230 374 238 346";
const TAIL = "M392 330 C420 300 418 252 392 238 C376 230 364 242 372 254";
const WHISKERS = "M152 240 L120 234 M154 248 L124 256";

export const kitten = (color, width, { whiskers = true, size } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="96 100 352 352"${size ? ` width="${size}" height="${size}"` : ""}>
<g fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">
<path d="${BODY}"/><path d="${LEG}"/><path d="${TAIL}"/>${whiskers ? `<path d="${WHISKERS}" stroke-width="${width * 0.5}"/>` : ""}
</g><circle cx="189" cy="214" r="${Math.max(7, width * 0.58)}" fill="${color}"/></svg>
`;

// 线宽（viewBox 352 里的单位）：大图 12；小图保证屏幕上约 1.6 像素以上
const strokeFor = (size) => Math.max(12, ((1.25 + size * 0.022) * 352) / size);
const appIcon = (size, color = GOLD) => kitten(color, strokeFor(size), { whiskers: size >= 48, size });

const browser = await chromium.launch();
const page = await browser.newPage();
// 用 canvas 把 SVG 画成 size×size：返回 PNG 和 RGBA 像素
const render = async (svg, size) => {
  const { png, rgba } = await page.evaluate(
    async ({ svg, size }) => {
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(svg);
      await img.decode();
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0, size, size);
      return { png: c.toDataURL("image/png").split(",")[1], rgba: Array.from(g.getImageData(0, 0, size, size).data) };
    },
    { svg: svg.replace(/ width="\d+" height="\d+"/, "").replace("<svg ", `<svg width="${size}" height="${size}" `), size }
  );
  return { png: Buffer.from(png, "base64"), rgba };
};

// ICO：256 用 PNG，其余用 32 位 BMP（带 AND 掩码），老工具和 NSIS 都认
const dib = (size, rgba) => {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8);
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  const rowBytes = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = ((size - 1 - y) * size + x) * 4; // BMP 自下而上
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
      if (rgba[s + 3] === 0) and[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  head.writeUInt32LE(xor.length + and.length, 20);
  return Buffer.concat([head, xor, and]);
};
const ico = (entries) => {
  const head = Buffer.alloc(6 + entries.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(([size, data], i) => {
    const o = 6 + i * 16;
    head[o] = head[o + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e[1])]);
};
// ICNS：全部用 PNG
const icns = (entries) => {
  const parts = entries.map(([type, data]) => {
    const h = Buffer.alloc(8);
    h.write(type, 0, "latin1");
    h.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([h, data]);
  });
  const h = Buffer.alloc(8);
  h.write("icns", 0, "latin1");
  h.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4);
  return Buffer.concat([h, ...parts]);
};

mkdirSync(join(build, "icons"), { recursive: true });
writeFileSync(join(icons, "icon.svg"), kitten(GOLD, 12));
const cache = new Map();
const app = async (size) => (cache.has(size) || cache.set(size, await render(appIcon(size), size)), cache.get(size));

writeFileSync(join(icons, "icon.png"), (await app(1024)).png);
const icoEntries = [];
for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
  const r = await app(size);
  icoEntries.push([size, size >= 256 ? r.png : dib(size, r.rgba)]);
}
writeFileSync(join(icons, "icon.ico"), ico(icoEntries));
const icnsTypes = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024], ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512]];
const icnsEntries = [];
for (const [type, size] of icnsTypes) icnsEntries.push([type, (await app(size)).png]);
writeFileSync(join(build, "icon.icns"), icns(icnsEntries));
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) writeFileSync(join(build, "icons", `${size}x${size}.png`), (await app(size)).png);

// 托盘：Windows / Linux 用彩色（16 / 24 / 32 像素），macOS 用黑色模板图（菜单栏自动变色）
const tray = [
  ["tray.png", GOLD, 38, 16],
  ["tray@1.5x.png", GOLD, 30, 24],
  ["tray@2x.png", GOLD, 26, 32],
  ["tray-off.png", GREY, 38, 16],
  ["tray-off@1.5x.png", GREY, 30, 24],
  ["tray-off@2x.png", GREY, 26, 32],
  ["trayTemplate.png", "#000", 30, 22],
  ["trayTemplate@2x.png", "#000", 26, 44],
  ["trayOffTemplate.png", "rgba(0,0,0,0.45)", 30, 22],
  ["trayOffTemplate@2x.png", "rgba(0,0,0,0.45)", 26, 44],
];
for (const [name, color, width, size] of tray) writeFileSync(join(icons, name), (await render(kitten(color, width, { whiskers: size >= 44 }), size)).png);
await browser.close();
console.log("icons ok");
