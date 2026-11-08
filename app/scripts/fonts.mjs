// 字体：思源宋体（Noto Serif SC，明朝体 / 宋体风格的简体中文，可变字重 200–900）+ EB Garamond（英文和数字，可变字重 400–800，含斜体）
// 都是 SIL Open Font License 1.1。从 npm 上的 @fontsource-variable 包取按 Unicode 分片的 woff2：界面用到哪些字，才加载哪些片
//   node scripts/fonts.mjs   → 重新生成 src/renderer/fonts/
// 宋体里有一些 emoji 码位（旗帜、符号）的单色字形，会盖掉彩色 emoji：从 unicode-range 里去掉这些码位，让它们落到系统的 emoji 字体上
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "fonts");
const tmp = mkdtempSync(join(tmpdir(), "ondine-fonts-"));

function unpack(spec) {
  const file = execFileSync("npm", ["pack", spec, "--silent"], { cwd: tmp, encoding: "utf8" }).trim().split("\n").pop();
  const dir = join(tmp, file.replace(/\.tgz$/, ""));
  mkdirSync(dir);
  execFileSync("tar", ["xzf", join(tmp, file), "-C", dir]);
  return join(dir, "package");
}

const faces = (css) =>
  [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
    style: body.match(/font-style:\s*([^;]+);/)[1].trim(),
    weight: body.match(/font-weight:\s*([^;]+);/)[1].trim(),
    file: body.match(/url\(\.\/files\/([^)]+)\)/)[1],
    ranges: body
      .match(/unicode-range:\s*([^;]+);/)[1]
      .split(",")
      .map((r) => r.trim().replace(/^U\+/i, ""))
      .map((r) => (r.includes("-") ? r.split("-").map((x) => parseInt(x, 16)) : [parseInt(r, 16), parseInt(r, 16)])),
  }));

// 交给系统 emoji 字体的码位：杂项技术符号、杂项符号与装饰符号、箭头与星、〰〽㊗㊙、变体选择符、U+1F000 以后的全部
const EMOJI = [[0x2300, 0x23ff], [0x2600, 0x27bf], [0x2b00, 0x2bff], [0x3030, 0x3030], [0x303d, 0x303d], [0x3297, 0x3297], [0x3299, 0x3299], [0xfe0e, 0xfe0f], [0x1f000, 0x10ffff]];
function withoutEmoji(ranges) {
  let rest = ranges;
  for (const [a, b] of EMOJI)
    rest = rest.flatMap(([x, y]) => {
      if (y < a || x > b) return [[x, y]];
      return [x < a && [x, a - 1], y > b && [b + 1, y]].filter(Boolean);
    });
  return rest;
}
const hex = (n) => n.toString(16);
const rangeText = (ranges) => ranges.map(([a, b]) => (a === b ? `U+${hex(a)}` : `U+${hex(a)}-${hex(b)}`)).join(",");

function build(pkg, family, dir, pick, filter = (r) => r) {
  rmSync(join(out, dir), { recursive: true, force: true });
  mkdirSync(join(out, dir), { recursive: true });
  copyFileSync(join(pkg, "LICENSE"), join(out, dir, "OFL.txt"));
  return faces(readFileSync(join(pkg, "index.css"), "utf8") + (pick.italic ? readFileSync(join(pkg, "wght-italic.css"), "utf8") : ""))
    .filter((f) => pick.file(f.file))
    .map((f) => ({ ...f, ranges: filter(f.ranges) }))
    .filter((f) => f.ranges.length)
    .map((f) => {
      copyFileSync(join(pkg, "files", f.file), join(out, dir, f.file));
      return `@font-face{font-family:"${family}";font-style:${f.style};font-weight:${f.weight};font-display:swap;src:url(./${dir}/${f.file}) format("woff2-variations");unicode-range:${rangeText(f.ranges)}}`;
    });
}

const garamond = build(unpack("@fontsource-variable/eb-garamond@5.3.0"), "EB Garamond Variable", "eb-garamond", { italic: true, file: (f) => /-latin(-ext)?-wght-/.test(f) });
const serif = build(unpack("@fontsource-variable/noto-serif-sc@5.3.1"), "Noto Serif SC Variable", "noto-serif-sc", { file: () => true }, withoutEmoji);
writeFileSync(
  join(out, "fonts.css"),
  `/* 字体：EB Garamond（英文、数字）和思源宋体 Noto Serif SC（中文，明朝体风格），均为 SIL Open Font License 1.1，见各目录的 OFL.txt。
   由 scripts/fonts.mjs 生成；宋体去掉了 emoji 码位，让旗帜和符号用系统的彩色 emoji */
${[...garamond, ...serif].join("\n")}
`
);
rmSync(tmp, { recursive: true, force: true });
console.log(`fonts: ${garamond.length} Garamond faces, ${serif.length} serif faces`);
