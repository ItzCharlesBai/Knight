// 生成界面用的背景素材（固定随机种子，结果可重复）：node scripts/art.mjs
//   src/renderer/art/moon.svg   月球：明暗渐变、月海、环形山、表面颗粒
//   src/renderer/art/stars.svg  星空平铺图
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "art");
let seed = 20260401; // Artemis II
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const r2 = (v) => Math.round(v * 100) / 100;

// ---------------- 月球 ----------------
// 月海的大致位置参照正面：雨海、风暴洋在左上，澄海、静海在右上和中间，云海、湿海在下方
const maria = [
  [222, 196, 84, 58, -20, 0.62],
  [150, 282, 46, 92, 10, 0.55],
  [176, 360, 40, 46, 0, 0.45],
  [338, 196, 44, 38, 15, 0.66],
  [380, 282, 58, 44, -10, 0.68],
  [312, 282, 28, 24, 0, 0.5],
  [282, 382, 60, 34, 6, 0.42],
  [430, 362, 32, 24, -25, 0.45],
  [212, 430, 34, 24, 20, 0.36],
  [440, 220, 22, 18, 0, 0.5],
]
  .map(([cx, cy, rx, ry, rot, o]) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill-opacity="${o}" transform="rotate(${rot} ${cx} ${cy})"/>`)
  .join("");
const craters = [];
for (let i = 0; i < 70; i++) {
  const a = rand() * Math.PI * 2;
  const d = Math.sqrt(rand()) * 262;
  const cx = 300 + Math.cos(a) * d;
  const cy = 300 + Math.sin(a) * d;
  const r = 1.5 + Math.pow(rand(), 3) * 16;
  craters.push(
    `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="#2a2b30" fill-opacity="${r2(0.07 + rand() * 0.1)}"/>` +
      (r > 5 ? `<circle cx="${r2(cx - r * 0.15)}" cy="${r2(cy - r * 0.15)}" r="${r2(r * 0.95)}" fill="none" stroke="#fffdf6" stroke-opacity="${r2(0.05 + rand() * 0.06)}" stroke-width="${r2(r * 0.14)}"/>` : "")
  );
}
// 第谷：一个亮的小环形山
const tycho = `<circle cx="248" cy="452" r="7" fill="#fbf8f1" fill-opacity=".55"/><circle cx="248" cy="452" r="22" fill="#fbf8f1" fill-opacity=".08"/>`;

// 第谷的辐射纹
const rays = Array.from({ length: 22 }, (_, i) => {
  const a = (i / 22) * Math.PI * 2 + rand() * 0.25;
  const len = 70 + rand() * 170;
  return `<line x1="248" y1="452" x2="${r2(248 + Math.cos(a) * len)}" y2="${r2(452 + Math.sin(a) * len)}" stroke-width="${r2(2 + rand() * 4)}"/>`;
}).join("");

writeFileSync(
  join(out, "moon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
<defs>
<radialGradient id="lit" cx="44%" cy="40%" r="66%"><stop offset="0" stop-color="#f2f1ec"/><stop offset=".6" stop-color="#dddbd5"/><stop offset=".88" stop-color="#b9b7b2"/><stop offset="1" stop-color="#8c8b8b"/></radialGradient>
<radialGradient id="shade" cx="30%" cy="26%" r="96%"><stop offset=".62" stop-color="#05070c" stop-opacity="0"/><stop offset=".86" stop-color="#05070c" stop-opacity=".28"/><stop offset="1" stop-color="#05070c" stop-opacity=".66"/></radialGradient>
<filter id="rough" x="-25%" y="-25%" width="150%" height="150%"><feTurbulence type="fractalNoise" baseFrequency=".045" numOctaves="3" seed="9" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="46" xChannelSelector="R" yChannelSelector="G" result="d"/><feGaussianBlur in="d" stdDeviation="4"/></filter>
<filter id="speck"><feTurbulence type="fractalNoise" baseFrequency=".55" numOctaves="1" seed="4"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 10 -6.6"/></filter>
<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="11"/><feColorMatrix values="0 0 0 0 .45 0 0 0 0 .45 0 0 0 0 .46 0 0 0 .6 0"/></filter>
<filter id="blur2"><feGaussianBlur stdDeviation="2"/></filter>
<clipPath id="disc"><circle cx="300" cy="300" r="280"/></clipPath>
</defs>
<g clip-path="url(#disc)">
<circle cx="300" cy="300" r="280" fill="url(#lit)"/>
<g fill="#7a7b80" filter="url(#rough)">${maria}</g>
<g stroke="#fbf8f1" stroke-opacity=".06" stroke-linecap="round" filter="url(#blur2)">${rays}</g>
<rect width="600" height="600" filter="url(#speck)" opacity=".28"/>
${craters.join("")}
${tycho}
<rect width="600" height="600" filter="url(#grain)" opacity=".16"/>
<circle cx="300" cy="300" r="280" fill="url(#shade)"/>
</g>
</svg>
`
);

// ---------------- 星空 ----------------
const stars = [];
for (let i = 0; i < 170; i++) {
  const x = r2(rand() * 600);
  const y = r2(rand() * 600);
  const big = rand() > 0.94;
  const r = big ? 1.1 + rand() * 0.7 : 0.35 + rand() * 0.6;
  const o = r2(big ? 0.75 + rand() * 0.25 : 0.18 + rand() * 0.5);
  const tint = rand() > 0.85 ? "#cfe0ff" : rand() > 0.9 ? "#ffe2c4" : "#ffffff";
  stars.push(`<circle cx="${x}" cy="${y}" r="${r2(r)}" fill="${tint}" fill-opacity="${o}"/>`);
  if (big) stars.push(`<circle cx="${x}" cy="${y}" r="${r2(r * 3.2)}" fill="${tint}" fill-opacity=".08"/>`);
}
writeFileSync(join(out, "stars.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">${stars.join("")}</svg>\n`);
console.log("moon.svg, stars.svg →", out);
