// 生成界面用的素材（固定随机种子，结果可重复）：node scripts/art.mjs
//   src/renderer/art/komorebi.svg  木漏れ日：树叶间漏下来的光斑和叶影，铺在背景上（夏日的午后）
//   src/renderer/art/lily.svg      细线描的百合：一枝花、一个花苞、两片长叶，淡淡地压在页面角落
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "art");
let seed = 20260621; // 夏至
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const r1 = (v) => Math.round(v * 10) / 10;

// ---------------- 木漏れ日 ----------------
// 叶影：一簇簇的叶子（细长椭圆，带叶柄方向），整体模糊；光斑：叶子之间漏下的圆形亮点
const W = 1400;
const H = 900;
const leaves = [];
const clusters = [
  [1180, 120, 260],
  [1320, 420, 220],
  [980, -20, 200],
  [1250, 760, 200],
  [80, 860, 160],
];
for (const [cx, cy, spread] of clusters) {
  for (let i = 0; i < 26; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * spread;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d * 0.8;
    const len = 34 + rand() * 46;
    const rot = (a * 180) / Math.PI + (rand() - 0.5) * 50;
    leaves.push(`<ellipse cx="${r1(x)}" cy="${r1(y)}" rx="${r1(len)}" ry="${r1(len * (0.32 + rand() * 0.14))}" transform="rotate(${r1(rot)} ${r1(x)} ${r1(y)})" fill-opacity="${r1(0.35 + rand() * 0.45)}"/>`);
  }
}
const spots = [];
for (let i = 0; i < 46; i++) {
  const [cx, cy, spread] = clusters[Math.floor(rand() * 3)];
  const a = rand() * Math.PI * 2;
  const d = Math.sqrt(rand()) * spread * 1.15;
  spots.push(`<circle cx="${r1(cx + Math.cos(a) * d)}" cy="${r1(cy + Math.sin(a) * d * 0.8)}" r="${r1(6 + rand() * 18)}" fill-opacity="${r1(0.35 + rand() * 0.5)}"/>`);
}
const komorebi = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMaxYMin slice">
<defs>
<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>
<g fill="#5b4a2e" filter="url(#soft)">${leaves.join("")}</g>
<g fill="#fff3c9" filter="url(#glow)">${spots.join("")}</g>
</svg>
`;
writeFileSync(join(out, "komorebi.svg"), komorebi);

// ---------------- 百合 ----------------
// 坐标系 420×640：花朝右上开，茎从底部弯上来
const P = (x, y) => `${r1(x)} ${r1(y)}`;
const petal = (cx, cy, angle, len, width, curl) => {
  const a = (angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const nx = -dy;
  const ny = dx;
  const tipX = cx + dx * len + nx * curl;
  const tipY = cy + dy * len + ny * curl;
  const m = (t, side) => [cx + dx * len * t + nx * width * side, cy + dy * len * t + ny * width * side];
  const [l1x, l1y] = m(0.45, 1);
  const [l2x, l2y] = m(0.85, 0.55);
  const [r2x, r2y] = m(0.85, -0.55);
  const [r1x, r1y] = m(0.45, -1);
  // 花瓣轮廓 + 中间一条脉
  return (
    `<path d="M${P(cx, cy)} C${P(l1x, l1y)} ${P(l2x, l2y)} ${P(tipX, tipY)} C${P(r2x, r2y)} ${P(r1x, r1y)} ${P(cx, cy)}"/>` +
    `<path d="M${P(cx + dx * 10, cy + dy * 10)} Q${P(cx + dx * len * 0.55 + nx * curl * 0.3, cy + dy * len * 0.55 + ny * curl * 0.3)} ${P(tipX - dx * 14, tipY - dy * 14)}" stroke-width="0.7"/>`
  );
};
const flowerX = 228;
const flowerY = 214;
// [角度, 长度, 宽度, 尖端翻卷]：前面三瓣大而舒展，后面三瓣只露出一部分
const petals = [
  [-172, 112, 34, -34],
  [-126, 138, 42, -28],
  [-88, 150, 40, -6],
  [-50, 144, 42, 22],
  [-8, 116, 34, 34],
]
  .map(([ang, len, w, curl]) => petal(flowerX, flowerY, ang, len, w, curl))
  .join("");
const stamens = [-118, -100, -84, -68, -52, -36]
  .map((ang, i) => {
    const a = (ang * Math.PI) / 180;
    const len = 104 + (i % 2) * 16;
    const x = flowerX + Math.cos(a) * len;
    const y = flowerY + Math.sin(a) * len;
    return `<path d="M${P(flowerX, flowerY - 6)} Q${P(flowerX + Math.cos(a) * len * 0.5 + 6, flowerY + Math.sin(a) * len * 0.5)} ${P(x, y)}" stroke-width="0.8"/><ellipse cx="${r1(x)}" cy="${r1(y)}" rx="6" ry="2.4" transform="rotate(${r1(ang + 90)} ${r1(x)} ${r1(y)})" stroke-width="0.9"/>`;
  })
  .join("");
const lily = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 640" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round" stroke-linejoin="round">
<path d="M${P(flowerX, flowerY + 6)} C 236 300, 214 420, 178 520 C 162 566, 150 604, 146 640"/>
<path d="M 205 380 C 250 330, 300 300, 352 292 C 312 318, 262 352, 214 396"/>
<path d="M 212 388 C 270 346, 320 316, 350 294" stroke-width="0.6"/>
<path d="M 186 474 C 128 446, 82 400, 56 344 C 98 386, 140 422, 190 452"/>
<path d="M 186 466 C 132 434, 92 392, 58 346" stroke-width="0.6"/>
<path d="M 222 330 C 266 318, 304 296, 330 262"/>
<path d="M 330 262 C 322 230, 332 190, 358 166 C 368 198, 360 236, 330 262 Z"/>
<path d="M 333 256 C 336 226, 344 196, 356 174" stroke-width="0.6"/>
${petals}
${stamens}
</svg>
`;
writeFileSync(join(out, "lily.svg"), lily);
console.log("komorebi.svg", komorebi.length, "lily.svg", lily.length);
