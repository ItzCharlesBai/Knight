// 转换与共享：导入的订阅已经自动转换好、可以直接用；这里把已有的订阅（默认就是在用的那些）转换成别的客户端的格式，
// 或者开一个局域网订阅地址，手机、平板直接订阅。不用粘贴，全部在本机完成
import { convertFields, DEFAULT_OPTIONS, readConvert } from "../convert-form.js";
import { debounce, delegate, html, icon, modal, patch, raw } from "../lib.js";

// 切到别的页面再回来时保留填过的内容；picked 为 null 表示跟随在用的订阅
const draft = { picked: null, urls: "", text: "", options: Object.assign({}, DEFAULT_OPTIONS, { template: "region", dropInfo: true, emoji: true, dedupe: true }), target: "clash", leakGuard: false };
let last = null;
let address = "";

export default function convert(root, ctx) {
  root.innerHTML = html`
    <header class="page-head"><h1>转换</h1></header>
    <p class="muted small lede">导入的订阅会自动识别格式并转换好，直接就能用。这里把它们转成别的客户端的格式，或者共享给手机、平板直接订阅——订阅只在本机下载和转换，不经过任何在线服务。</p>
    <div class="convert-grid">
      <form class="card" id="cv-form"></form>
      <div class="card preview" id="cv-preview"></div>
    </div>
    <section class="card share-card" id="cv-share"></section>`.s;
  const $ = (id) => root.querySelector("#" + id);
  const picked = () => (draft.picked || ctx.state.active).filter((id) => ctx.state.profiles.some((p) => p.id === id));

  function renderForm() {
    const s = ctx.state;
    const ids = picked();
    const extra = !!(draft.urls.trim() || draft.text.trim());
    patch(
      $("cv-form"),
      html`<div class="card-title" data-en="Sources">来源与处理</div>
        ${s.profiles.length
          ? html`<div class="field"><span>订阅</span><div class="chips">${s.profiles.map(
              (p) => html`<label class="chip"><input type="checkbox" name="profile" value="${p.id}" ${raw(ids.includes(p.id) ? "checked" : "")} />${p.name}</label>`
            )}</div><small>${draft.picked ? "" : "默认就是正在使用的订阅"}</small></div>`
          : html`<p class="muted small">还没有订阅：可以先在「订阅」页导入，也可以直接在下面填链接。</p>`}
        <details class="more" ${raw(extra || !s.profiles.length ? "open" : "")}><summary>其他来源（可选）：订阅链接、粘贴的内容</summary>
          <label class="field"><span>订阅链接</span><textarea name="urls" spellcheck="false" placeholder="每行一个 http(s):// 链接">${draft.urls}</textarea></label>
          <label class="field"><span>粘贴内容</span><textarea name="text" spellcheck="false" placeholder="Clash YAML、分享链接（可以是 Base64）、sing-box 配置、SIP008、Surge / Quantumult X / Loon 节点">${draft.text}</textarea></label>
        </details>
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
    const head = html`<div class="card-title" data-en="Result">结果</div>`;
    if (busy && !last) return patch($("cv-preview"), html`${head}<div class="empty">转换中…</div>`);
    if (!last) return patch($("cv-preview"), html`${head}<div class="empty">${ctx.state.profiles.length ? "选好订阅后会自动转换" : "填好来源后点「转换」"}</div>`);
    patch(
      $("cv-preview"),
      html`${head}
        <div class="preview-meta ${busy ? "busy" : ""}"><span><b>${last.count}</b> 个节点</span>${last.providers ? html`<span><b>${last.providers}</b> 个代理集合</span>` : ""}<span><b>${last.groups}</b> 个分组</span>${last.regions.map(([name, n]) => html`<span>${name} <b>${n}</b></span>`)}</div>
        <dl class="stat-grid">
          <dt>协议</dt><dd>${last.stats.protocols.map(([name, n]) => html`<span class="tag">${name} ${n}</span>`)}</dd>
          ${last.stats.features.length ? html`<dt>特性</dt><dd>${last.stats.features.map(([name, n]) => html`<span class="tag">${name} ${n}</span>`)}</dd>` : ""}
          <dt>内核</dt><dd>${last.stats.cores.map(([name, n]) => html`<span class="tag ${n < last.count ? "warn-tag" : ""}">${name} 能跑 ${n}/${last.count}</span>`)}</dd>
        </dl>
        ${last.skipped.length || last.warnings.length
          ? html`<ul class="warn-list">${last.skipped.length ? html`<li>${last.skipped.length} 个节点这个格式写不了：${last.skipped.slice(0, 5).join("、")}</li>` : ""}${last.warnings.map((w) => html`<li>${w}</li>`)}</ul>`
          : ""}
        <textarea readonly spellcheck="false">${last.text}</textarea>
        <div class="row-actions">
          <button class="btn" data-action="copy">${icon("copy", 15)}复制</button>
          <button class="btn" data-action="export">${icon("file", 15)}导出文件</button>
        </div>`
    );
  }

  // ---------------- 共享给其他设备 ----------------
  function renderShare() {
    const s = ctx.state;
    const sh = s.settings.share;
    const info = s.share;
    const names = (sh.profiles.length ? sh.profiles : s.active).map((id) => (s.profiles.find((p) => p.id === id) || {}).name).filter(Boolean);
    const template = (s.convert.templates.find((t) => t[0] === sh.options.template) || [])[1] || sh.options.template;
    if (!info.addresses.includes(address)) address = info.addresses[0] || "";
    const url = (target) => `http://${address || "本机IP"}:${sh.port}/sub/${sh.token}/${target}`;
    patch(
      $("cv-share"),
      html`<div class="card-title" data-en="Share">共享给其他设备
          <label class="switch" title="${sh.enabled ? "关闭共享" : "打开共享"}"><input type="checkbox" data-share-toggle ${raw(sh.enabled ? "checked" : "")} /><span></span></label></div>
        <p class="muted small">打开后，同一局域网里的手机、平板直接订阅下面的地址就行，不用复制粘贴；这边的订阅更新后，那边下次更新时自动同步。地址里有随机密钥，只发给自己的设备。</p>
        ${info.error ? html`<div class="notice bad">${info.error}</div>` : ""}
        ${sh.enabled && info.running
          ? html`<div class="share-meta">
                <span>共享内容：${names.length ? names.join("、") : "（没有订阅）"}${sh.profiles.length ? "" : "（跟随在用的订阅）"} · ${template}${sh.options.emoji ? " · 国旗" : ""}${sh.leakGuard ? " · 防泄露" : ""}</span>
                <button class="link" data-action="share-apply">改成上面的选择和选项${icon("chevron", 14)}</button>
              </div>
              ${info.addresses.length > 1
                ? html`<label class="field inline"><span>本机地址</span><select data-share-address>${info.addresses.map((a) => html`<option value="${a}" ${raw(a === address ? "selected" : "")}>${a}</option>`)}</select></label>`
                : ""}
              ${info.addresses.length
                ? html`<div class="share-list">${info.targets.map(
                    ([id, label]) => html`<div class="share-row"><span class="share-label">${label}</span><code title="${url(id)}">${url(id)}</code>
                      <button class="icon-btn" data-action="share-copy" data-url="${url(id)}" title="复制">${icon("copy", 15)}</button>
                      <button class="icon-btn" data-action="share-qr" data-url="${url(id)}" data-label="${label}" title="二维码">${icon("qr", 15)}</button></div>`
                  )}</div>`
                : html`<div class="notice">没有找到局域网地址：电脑要和手机连在同一个网络里</div>`}
              <div class="row-actions">
                <label class="field inline"><span>端口</span><input type="number" min="1024" max="65535" value="${sh.port}" data-share-port /></label>
                <button class="btn sm" data-action="share-reset">${icon("refresh", 14)}换一个地址</button>
                <span class="muted small">已被订阅 ${info.hits} 次${s.platform === "win32" ? " · Windows 第一次打开时请在防火墙提示里允许专用网络" : ""}</span>
              </div>`
          : ""}`
    );
  }

  // 表单 → draft
  function collect() {
    const form = $("cv-form");
    if (!form.target) return null;
    draft.urls = form.urls.value;
    draft.text = form.text.value;
    const checked = [...form.querySelectorAll("[name=profile]:checked")].map((x) => x.value);
    const active = ctx.state.active.filter((id) => ctx.state.profiles.some((p) => p.id === id));
    draft.picked = checked.length === active.length && checked.every((id) => active.includes(id)) ? null : checked;
    draft.options = readConvert(form);
    draft.target = form.target.value;
    draft.leakGuard = form.leakGuard.checked;
    return {
      sources: { urls: draft.urls.split(/\s+/).filter(Boolean), profiles: checked, text: draft.text },
      options: draft.options,
      target: draft.target,
      leakGuard: draft.leakGuard,
    };
  }

  let seq = 0;
  async function preview() {
    const job = collect();
    if (!job) return;
    const empty = !job.sources.profiles.length && !job.sources.urls.length && !job.sources.text.trim();
    if (empty) {
      last = null;
      return renderPreview();
    }
    const mine = ++seq;
    renderPreview(true);
    try {
      const r = await ctx.invoke("convertPreview", job);
      if (mine === seq) last = r;
    } catch (err) {
      if (mine === seq) last = null;
      ctx.toast(err.message, "error");
    }
    if (mine === seq) renderPreview();
  }
  // 只用已有订阅时改了选项就自动重新转换（本机文件，很快）；填了链接的要点「转换」才去下载
  const auto = debounce(() => {
    if (!draft.urls.trim()) preview();
  }, 350);

  $("cv-form").addEventListener("submit", (e) => {
    e.preventDefault();
    preview();
  });
  $("cv-form").addEventListener("change", (e) => {
    if (e.target.name === "urls" || e.target.name === "text") return;
    collect();
    auto();
  });

  root.addEventListener("change", (e) => {
    const el = e.target;
    if (el.matches("[data-share-toggle]")) {
      const on = el.checked;
      // 第一次打开时用这里现在的选择和选项
      const first = on && !ctx.state.settings.share.token;
      const patchObj = first ? { enabled: true, profiles: draft.picked || [], options: draft.options, leakGuard: draft.leakGuard } : { enabled: on };
      ctx.set({ share: patchObj }).then(() => ctx.toast(on ? "已打开共享" : "已关闭共享", "success"), () => renderShare());
    } else if (el.matches("[data-share-port]")) {
      ctx.set({ share: { port: Number(el.value) } }).catch(() => renderShare());
    } else if (el.matches("[data-share-address]")) {
      address = el.value;
      renderShare();
    }
  });

  delegate(root, "click", {
    copy: async () => {
      await ctx.invoke("copy", last.text);
      ctx.toast("已复制到剪贴板", "success");
    },
    export: async () => {
      try {
        const file = await ctx.invoke("convertExport", Object.assign(collect(), { name: "ondine-" + draft.target }));
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
    "share-apply": () => {
      collect();
      ctx.set({ share: { profiles: draft.picked || [], options: draft.options, leakGuard: draft.leakGuard } }).then(() => ctx.toast("共享内容已更新", "success"), () => {});
    },
    "share-copy": async (el) => {
      await ctx.invoke("copy", el.dataset.url);
      ctx.toast("已复制订阅地址", "success");
    },
    "share-qr": async (el) => qrModal(ctx, el.dataset.label, el.dataset.url),
    "share-reset": () => ctx.invoke("resetShareToken").then(() => ctx.toast("已换成新地址，旧地址失效", "success"), (err) => ctx.toast(err.message, "error")),
  });

  // 订阅列表或在用的订阅变了才重绘表单，避免打断输入
  const keyOf = () => ctx.state.profiles.map((p) => p.id + p.name).join() + "|" + ctx.state.active.join();
  let profileKey = keyOf();
  const off = ctx.on("state", () => {
    renderShare();
    const key = keyOf();
    if (key !== profileKey) {
      collect();
      profileKey = key;
      renderForm();
      auto();
    }
  });
  renderForm();
  renderPreview();
  renderShare();
  if (!last && picked().length) preview();
  return {
    unmount() {
      collect();
      off();
    },
  };
}

// 二维码弹窗：手机扫一下就能添加订阅 / 节点（颜色跟随界面）
export async function qrModal(ctx, title, text) {
  const { size, d } = await ctx.invoke("qr", text);
  modal({
    title: title || "二维码",
    body: html`<div class="qr-box"><svg viewBox="-2 -2 ${size + 4} ${size + 4}" shape-rendering="crispEdges" role="img" aria-label="二维码"><rect x="-2" y="-2" width="${size + 4}" height="${size + 4}" class="qr-bg" /><path d="${d}" class="qr-ink" /></svg>
      <code class="qr-text">${text}</code></div>`,
    actions: [{ label: "复制", onClick: () => ctx.invoke("copy", text).then(() => ctx.toast("已复制", "success")) }, { label: "关闭", kind: "primary" }],
  });
}
