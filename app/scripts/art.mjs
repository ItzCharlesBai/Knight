// 生成界面用的光影素材（固定随机种子，结果可重复）：node scripts/art.mjs
//   src/renderer/art/window.svg  一扇文艺复兴式的拱窗投在墙上的光：斜斜的光斑、窗棂的影子，边缘柔和（做 CSS 遮罩，颜色随主题）
//   src/renderer/art/leaves.svg  窗外橄榄枝的影子，落在光斑上（做 CSS 遮罩）
//   src/renderer/art/rain.svg    下雨天：窗上的雨滴把光折到墙上，一颗颗亮边的小影子和几道水痕（只在「雨」主题出现）
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "art");
let seed = 15040415; // 达·芬奇的生日
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const r1 = (v) => Math.round(v * 10) / 10;
const W = 1600;
const H = 1000;
const head = (extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMaxYMin slice">${extra}`;

// ---------------- 拱窗的光 ----------------
// 窗：两列三行的窗格，上面一个半圆拱；整体斜投在墙上（skew），边缘按半影模糊
const win = (x, y, w, h) => {
  const r = w / 2;
  const body = `M${x} ${y + r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h} H${x} Z`;
  const bar = 20; // 窗棂宽度
  const rows = [y + r + (h - r) * 0.34, y + r + (h - r) * 0.67];
  const bars = [
    `<rect x="${x + r - bar / 2}" y="${y}" width="${bar}" height="${h}"/>`,
    `<rect x="${x}" y="${y + r - bar / 2}" width="${w}" height="${bar}"/>`,
    ...rows.map((ry) => `<rect x="${x}" y="${r1(ry)}" width="${w}" height="${bar * 0.8}"/>`),
  ].join("");
  return { body, bars };
};
const a = win(1080, 40, 400, 900);
const windowSvg = `${head(`<defs>
<filter id="pen" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="13"/></filter>
<filter id="bloom" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>
<mask id="panes"><path d="${a.body}" fill="#fff"/><g fill="#000">${a.bars}</g></mask>
</defs>`)}
<g transform="translate(-60 0) skewX(-16)">
<path d="${a.body}" fill="#fff" fill-opacity="0.35" filter="url(#bloom)"/>
<g filter="url(#pen)"><rect x="1060" y="20" width="440" height="940" fill="#fff" mask="url(#panes)"/></g>
</g>
</svg>
`;
writeFileSync(join(out, "window.svg"), windowSvg);

// ---------------- 橄榄枝的影子 ----------------
// 细长的披针形叶子，在小枝两侧对生；离墙越远越模糊
const leaf = (x, y, angle, len, wid) => {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const nx = -dy;
  const ny = dx;
  const tip = [x + dx * len, y + dy * len];
  const c1 = [x + dx * len * 0.35 + nx * wid, y + dy * len * 0.35 + ny * wid];
  const c2 = [x + dx * len * 0.75 + nx * wid * 0.6, y + dy * len * 0.75 + ny * wid * 0.6];
  const c3 = [x + dx * len * 0.75 - nx * wid * 0.6, y + dy * len * 0.75 - ny * wid * 0.6];
  const c4 = [x + dx * len * 0.35 - nx * wid, y + dy * len * 0.35 - ny * wid];
  return `<path d="M${r1(x)} ${r1(y)} C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${r1(tip[0])} ${r1(tip[1])} C${r1(c3[0])} ${r1(c3[1])} ${r1(c4[0])} ${r1(c4[1])} ${r1(x)} ${r1(y)} Z"/>`;
};
function branch(x0, y0, x1, y1, bend, pairs, size) {
  const shapes = [];
  const mx = (x0 + x1) / 2 + bend[0];
  const my = (y0 + y1) / 2 + bend[1];
  shapes.push(`<path d="M${x0} ${y0} Q${r1(mx)} ${r1(my)} ${x1} ${y1}" fill="none" stroke="#000" stroke-width="${r1(size * 0.06 + 1.5)}" stroke-linecap="round"/>`);
  for (let i = 1; i <= pairs; i++) {
    const t = i / (pairs + 0.6);
    const px = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * mx + t * t * x1;
    const py = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * my + t * t * y1;
    const tx = 2 * (1 - t) * (mx - x0) + 2 * t * (x1 - mx);
    const ty = 2 * (1 - t) * (my - y0) + 2 * t * (y1 - my);
    const base = (Math.atan2(ty, tx) * 180) / Math.PI;
    const len = size * (0.85 + rand() * 0.35) * (1 - t * 0.25);
    // 橄榄叶：细长，角度和长短不一，有的往下垂
    for (const side of [-1, 1]) {
      if (rand() < 0.12) continue;
      shapes.push(leaf(px, py, base + side * (26 + rand() * 34) + (rand() - 0.5) * 16, len * (0.8 + rand() * 0.4), len * (0.11 + rand() * 0.05)));
    }
  }
  shapes.push(leaf(x1, y1, (Math.atan2(y1 - my, x1 - mx) * 180) / Math.PI, size * 0.9, size * 0.13));
  return shapes.join("");
}
const near = [branch(1640, 120, 1260, 330, [40, -60], 9, 70), branch(1620, 520, 1300, 600, [20, 50], 7, 64)].join("");
const far = [branch(1660, 760, 1180, 900, [-30, -40], 10, 80), branch(1560, -40, 1380, 180, [60, 10], 6, 74)].join("");
const leavesSvg = `${head(`<defs>
<filter id="near" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.6"/></filter>
<filter id="far" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>`)}
<g transform="translate(-60 0) skewX(-16)">
<g filter="url(#far)" fill="#000" fill-opacity="0.55">${far}</g>
<g filter="url(#near)" fill="#000">${near}</g>
</g>
</svg>
`;
writeFileSync(join(out, "leaves.svg"), leavesSvg);

// ---------------- 雨 ----------------
// 雨滴：暗的小椭圆，一侧有亮边（玻璃上的水珠把光折过来）；几道往下流的水痕
const drops = [];
for (let i = 0; i < 170; i++) {
  const x = 1080 + rand() * 400;
  const y = 40 + rand() * 900;
  const r = 2 + rand() * rand() * 9;
  drops.push(
    `<ellipse cx="${r1(x)}" cy="${r1(y)}" rx="${r1(r)}" ry="${r1(r * 1.18)}" fill="#2c3a40" fill-opacity="${r1(0.12 + rand() * 0.2)}"/>` +
      `<path d="M${r1(x - r * 0.55)} ${r1(y + r * 0.35)} A${r1(r * 0.8)} ${r1(r * 0.9)} 0 0 0 ${r1(x + r * 0.5)} ${r1(y + r * 0.5)}" fill="none" stroke="#ffffff" stroke-opacity="0.7" stroke-width="${r1(Math.max(0.8, r * 0.28))}" stroke-linecap="round"/>`
  );
}
const trails = [];
for (let i = 0; i < 7; i++) {
  let x = 1100 + rand() * 360;
  let y = 60 + rand() * 380;
  let d = `M${r1(x)} ${r1(y)}`;
  for (let k = 0; k < 7; k++) {
    x += (rand() - 0.5) * 10;
    y += 40 + rand() * 60;
    d += ` L${r1(x)} ${r1(y)}`;
  }
  trails.push(`<path d="${d}" fill="none" stroke="#2c3a40" stroke-opacity="0.08" stroke-width="${r1(1.4 + rand() * 1.6)}" stroke-linecap="round" stroke-linejoin="round"/>`);
}
// 只有光照到的地方才看得见雨滴的影子：用窗的形状裁一下
const rainSvg = `${head(`<defs><filter id="wet" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="0.8"/></filter>
<clipPath id="lit"><path d="${a.body}"/></clipPath></defs>`)}
<g transform="translate(-60 0) skewX(-16)"><g clip-path="url(#lit)" filter="url(#wet)">${trails.join("")}${drops.join("")}</g></g>
</svg>
`;
writeFileSync(join(out, "rain.svg"), rainSvg);
console.log("window.svg", windowSvg.length, "leaves.svg", leavesSvg.length, "rain.svg", rainSvg.length);
