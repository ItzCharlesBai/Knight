// 订阅转换：多个来源（链接 / 已有订阅 / 粘贴的内容）→ 筛选、重命名、去重、分组模板 → 各种格式。全部在本机完成
import { convertFields, DEFAULT_OPTIONS, readConvert } from "../convert-form.js";
import { delegate, html, icon, modal, patch, raw } from "../lib.js";

// 切到别的页面再回来时保留填过的内容
const draft = { urls: "", profiles: [], text: "", options: Object.assign({}, DEFAULT_OPTIONS, { template: "region", dropInfo: true }), target: "clash", leakGuard: false };
let last = null;

export default function convert(root, ctx) {
  root.innerHTML = html`
    <header class="page-head"><h1>转换</h1></header>
    <p class="muted small lede">订阅链接只在本机下载和转换，不会交给任何在线转换服务。</p>
    <div class="convert-grid">
      <form class="card" id="cv-form"></form>
      <div class="card preview" id="cv-preview"></div>
    </div>`.s;
  const $ = (id) => root.querySelector("#" + id);

  function renderForm() {
    const s = ctx.state;
    patch(
      $("cv-form"),
      html`<div class="card-title" data-en="Sources">来源与处理</div>
        <label class="field"><span>订阅链接</span><textarea name="urls" spellcheck="false" placeholder="每行一个 http(s):// 链接">${draft.urls}</textarea></label>
        ${s.profiles.length
          ? html`<div class="field"><span>已有订阅</span><div class="chips">${s.profiles.map(
              (p) => html`<label class="chip"><input type="checkbox" name="profile" value="${p.id}" ${raw(draft.profiles.includes(p.id) ? "checked" : "")} />${p.name}</label>`
            )}</div></div>`
          : ""}
        <label class="field"><span>粘贴内容</span><textarea name="text" spellcheck="false" placeholder="Clash / mihomo YAML、分享链接（vless:// vmess:// trojan:// hy2:// tuic:// ss:// 等，可以是 Base64）、sing-box 配置、SIP008">${draft.text}</textarea></label>
        ${convertFields(draft.options, s.convert.templates)}
        <div class="field-row">
          <label class="field"><span>输出格式</span><select name="target">${s.convert.targets.map(([id, label]) => html`<option value="${id}" ${raw(draft.target === id ? "selected" : "")}>${label}</option>`)}</select></label>
          <div class="field"><span>附加</span><div class="checks-inline"><label><input type="checkbox" name="leakGuard" ${raw(draft.leakGuard ? "checked" : "")} />带上防泄露设置</label></div></div>
        </div>
        <div class="row-actions">
          <button class="btn primary" type="submit">${icon("refresh", 15)}转换</button>
          <button class="btn" type="button" data-action="save">${icon("plus", 15)}保存为订阅</button>
        </div>`
    );
  }

  function renderPreview(busy = false) {
    if (busy) return patch($("cv-preview"), html`<div class="card-title" data-en="Result">结果</div><div class="empty">转换中…</div>`);
    if (!last) return patch($("cv-preview"), html`<div class="card-title" data-en="Result">结果</div><div class="empty">填好来源后点「转换」</div>`);
    patch(
      $("cv-preview"),
      html`<div class="card-title" data-en="Result">结果</div>
        <div class="preview-meta"><span><b>${last.count}</b> 个节点</span>${last.providers ? html`<span><b>${last.providers}</b> 个代理集合</span>` : ""}<span><b>${last.groups}</b> 个分组</span>${last.regions.map(([name, n]) => html`<span>${name} <b>${n}</b></span>`)}</div>
        <dl class="stat-grid">
          <dt>协议</dt><dd>${last.stats.protocols.map(([name, n]) => html`<span class="tag">${name} ${n}</span>`)}</dd>
          ${last.stats.features.length ? html`<dt>特性</dt><dd>${last.stats.features.map(([name, n]) => html`<span class="tag">${name} ${n}</span>`)}</dd>` : ""}
          <dt>内核</dt><dd>${last.stats.cores.map(([name, n]) => html`<span class="tag ${n < last.count ? "warn-tag" : ""}">${name} 能跑 ${n}/${last.count}</span>`)}</dd>
        </dl>
        ${last.skipped.length || last.warnings.length
          ? html`<ul class="warn-list">${last.skipped.length ? html`<li>${last.skipped.length} 个节点无法写成分享链接：${last.skipped.slice(0, 5).join("、")}</li>` : ""}${last.warnings.map((w) => html`<li>${w}</li>`)}</ul>`
          : ""}
        <textarea readonly spellcheck="false">${last.text}</textarea>
        <div class="row-actions">
          <button class="btn" data-action="copy">${icon("copy", 15)}复制</button>
          <button class="btn" data-action="export">${icon("file", 15)}导出文件</button>
        </div>`
    );
  }

  // 表单 → draft
  function collect() {
    const form = $("cv-form");
    draft.urls = form.urls.value;
    draft.text = form.text.value;
    draft.profiles = [...form.querySelectorAll("[name=profile]:checked")].map((x) => x.value);
    draft.options = readConvert(form);
    draft.target = form.target.value;
    draft.leakGuard = form.leakGuard.checked;
    return {
      sources: { urls: draft.urls.split(/\s+/).filter(Boolean), profiles: draft.profiles, text: draft.text },
      options: draft.options,
      target: draft.target,
      leakGuard: draft.leakGuard,
    };
  }

  $("cv-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const job = collect();
    renderPreview(true);
    try {
      last = await ctx.invoke("convertPreview", job);
    } catch (err) {
      last = null;
      ctx.toast(err.message, "error");
    }
    renderPreview();
  });

  delegate(root, "click", {
    copy: async () => {
      await ctx.invoke("copy", last.text);
      ctx.toast("已复制到剪贴板", "success");
    },
    export: async () => {
      try {
        const file = await ctx.invoke("convertExport", Object.assign(collect(), { name: "knight-" + draft.target }));
        if (file) ctx.toast("已导出到 " + file, "success");
      } catch (err) {
        ctx.toast(err.message, "error");
      }
    },
    save: () => {
      const job = collect();
      modal({
        title: "保存为订阅",
        body: html`<div class="form"><label>名称<input name="name" placeholder="转换后的订阅" /></label>
          <p class="muted small">保存后和普通订阅一样定时更新：每次更新都会重新拉取这些来源，再按现在的选项转换。</p></div>`,
        actions: [
          { label: "取消" },
          {
            label: "保存",
            kind: "primary",
            onClick: async (m) => {
              const item = await ctx.invoke("convertSave", Object.assign(job, { name: m.find("[name=name]").value.trim() || "转换后的订阅" }));
              ctx.toast(`已保存为订阅「${item.name}」`, "success");
              ctx.navigate("profiles");
            },
          },
        ],
      });
    },
  });

  // 订阅列表变了（增删）才重绘表单，避免打断输入
  let profileKey = "";
  const off = ctx.on("state", () => {
    const key = ctx.state.profiles.map((p) => p.id + p.name).join();
    if (key !== profileKey) {
      collect();
      profileKey = key;
      renderForm();
    }
  });
  profileKey = ctx.state.profiles.map((p) => p.id + p.name).join();
  renderForm();
  renderPreview();
  return {
    unmount() {
      collect();
      off();
    },
  };
}
