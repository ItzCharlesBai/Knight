// 订阅转换选项的表单：转换页和「订阅设置」共用
import { html, raw } from "./lib.js";

export const DEFAULT_OPTIONS = { template: "keep", include: "", exclude: "", rename: "", emoji: false, dedupe: false, sort: "none", udp: false, skipCert: false };
const SORTS = [
  ["none", "保持原顺序"],
  ["region", "按地区"],
  ["name", "按名称"],
];

export function convertFields(options, templates) {
  const o = Object.assign({}, DEFAULT_OPTIONS, options);
  const check = (key, label) => html`<label><input type="checkbox" name="cv-${key}" ${raw(o[key] ? "checked" : "")} />${label}</label>`;
  return html`
    <label class="field"><span>分组模板</span>
      <select name="cv-template">${templates.map(([id, label, desc]) => html`<option value="${id}" title="${desc}" ${raw(o.template === id ? "selected" : "")}>${label} — ${desc}</option>`)}</select>
    </label>
    <div class="field-row">
      <label class="field"><span>只保留</span><input name="cv-include" value="${o.include}" placeholder="正则，例如 香港|日本|新加坡" /></label>
      <label class="field"><span>排除</span><input name="cv-exclude" value="${o.exclude}" placeholder="正则，例如 剩余|到期|官网|倍率" /></label>
    </div>
    <label class="field"><span>重命名</span>
      <textarea name="cv-rename" spellcheck="false" placeholder="每行一条：原文 => 替换，原文按正则处理&#10;IPLC => 专线&#10;\\s*\\[.*?\\]\\s* =>">${o.rename}</textarea>
    </label>
    <div class="field-row">
      <label class="field"><span>排序</span><select name="cv-sort">${SORTS.map(([v, t]) => html`<option value="${v}" ${raw(o.sort === v ? "selected" : "")}>${t}</option>`)}</select></label>
      <div class="field"><span>处理</span><div class="checks-inline">${check("emoji", "加国旗")}${check("dedupe", "去重")}${check("udp", "开启 UDP")}${check("skipCert", "跳过证书验证")}</div></div>
    </div>`;
}

export function readConvert(root) {
  const v = (n) => root.querySelector(`[name="cv-${n}"]`);
  return {
    template: v("template").value,
    include: v("include").value.trim(),
    exclude: v("exclude").value.trim(),
    rename: v("rename").value,
    emoji: v("emoji").checked,
    dedupe: v("dedupe").checked,
    sort: v("sort").value,
    udp: v("udp").checked,
    skipCert: v("skipCert").checked,
  };
}
