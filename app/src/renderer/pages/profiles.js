// 订阅：添加（链接 / 本地文件 / 拖入）、切换、更新、编辑、删除
import { ago, bytes, confirm, date, delegate, html, icon, modal, patch, raw } from "../lib.js";

export default function profiles(root, ctx) {
  root.innerHTML = html`
    <header class="page-head">
      <h1>订阅</h1>
      <div class="head-actions">
        <button class="btn" data-action="update-all">${icon("refresh", 16)}全部更新</button>
      </div>
    </header>
    <form class="card add-bar" id="s-add">
      <input data-key="url" name="url" placeholder="粘贴订阅链接（Clash / mihomo 订阅，或 ss:// vmess:// 等节点链接的订阅）" autocomplete="off" />
      <button class="btn primary" type="submit">${icon("plus", 16)}导入</button>
      <button class="btn" type="button" data-action="file">${icon("file", 16)}本地文件</button>
    </form>
    <div id="s-error"></div>
    <div class="profile-grid" id="s-list"></div>
    <p class="muted small hint">也可以把配置文件直接拖进窗口；机场的「一键导入 Clash」链接会自动导入到这里。</p>`.s;

  const $ = (id) => root.querySelector("#" + id);

  function render() {
    const s = ctx.state;
    patch($("s-error"), s.apply.error ? html`<div class="notice bad">${s.apply.error}</div>` : "");
    if (!s.profiles.length) {
      return patch($("s-list"), html`<div class="empty">还没有订阅，粘贴机场提供的订阅链接后点「导入」</div>`);
    }
    patch($("s-list"), html`${s.profiles.map((p) => card(p, p.id === s.settings.currentProfile))}`);
  }

  function card(p, active) {
    const u = p.userinfo || {};
    const used = (u.upload || 0) + (u.download || 0);
    const pct = u.total ? Math.min(100, (used / u.total) * 100) : 0;
    const expired = u.expire && u.expire * 1000 < Date.now();
    return html`<div class="card profile ${active ? "active" : ""}" data-action="select" data-id="${p.id}">
      <div class="profile-head">
        <b class="profile-name" title="${p.name}">${p.name}</b>
        ${active ? html`<span class="badge">使用中</span>` : ""}
      </div>
      <div class="muted small">${p.type === "remote" ? "远程订阅" : "本地配置"}${p.converted ? " · 节点链接" : ""} · 更新于 ${ago(p.updatedAt)}</div>
      ${u.total
        ? html`<div class="usage"><div class="bar"><i style="width:${pct.toFixed(1)}%" class="${pct > 90 ? "bad" : ""}"></i></div>
            <div class="muted small">${bytes(used)} / ${bytes(u.total)}${u.expire ? html` · <span class="${expired ? "bad-text" : ""}">${date(u.expire * 1000)} ${expired ? "已过期" : "到期"}</span>` : ""}</div></div>`
        : ""}
      ${p.error ? html`<div class="bad-text small">上次更新失败：${p.error}</div>` : ""}
      <div class="profile-actions">
        ${p.type === "remote"
          ? html`<button class="icon-btn ${p.updating ? "spin" : ""}" data-action="update" data-id="${p.id}" title="更新" ${raw(p.updating ? "disabled" : "")}>${icon("refresh", 16)}</button>`
          : ""}
        <button class="icon-btn" data-action="edit" data-id="${p.id}" title="设置">${icon("settings", 16)}</button>
        <button class="icon-btn" data-action="content" data-id="${p.id}" title="编辑配置">${icon("edit", 16)}</button>
        ${p.home ? html`<button class="icon-btn" data-action="home" data-url="${p.home}" title="打开官网">${icon("external", 16)}</button>` : ""}
        <button class="icon-btn danger" data-action="remove" data-id="${p.id}" title="删除">${icon("trash", 16)}</button>
      </div>
    </div>`;
  }

  const find = (id) => ctx.state.profiles.find((p) => p.id === id);
  const run = async (fn, ok) => {
    try {
      const r = await fn();
      if (ok) ctx.toast(typeof ok === "function" ? ok(r) : ok, "success");
      return r;
    } catch (err) {
      ctx.toast(err.message, "error");
    }
  };

  $("s-add").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = e.target.url;
    const url = input.value.trim();
    if (!url) return;
    const btn = e.target.querySelector("[type=submit]");
    btn.disabled = true;
    btn.textContent = "导入中…";
    const item = await run(() => ctx.invoke("addProfile", { url }), (p) => `已导入「${p.name}」`);
    btn.disabled = false;
    btn.innerHTML = html`${icon("plus", 16)}导入`.s;
    if (item) input.value = "";
  });

  delegate(root, "click", {
    select: (el, e) => {
      if (e.target.closest("button")) return;
      if (el.dataset.id !== ctx.state.settings.currentProfile) ctx.set({ currentProfile: el.dataset.id }).catch(() => {});
    },
    update: (el) => run(() => ctx.invoke("updateProfile", el.dataset.id), "订阅已更新"),
    "update-all": (el) => {
      el.disabled = true;
      run(() => ctx.invoke("updateAllProfiles"), (failed) => (failed ? `${failed} 个订阅更新失败` : "全部订阅已更新")).finally(() => (el.disabled = false));
    },
    file: () => run(() => ctx.invoke("importProfileFile")),
    home: (el) => ctx.invoke("openExternal", el.dataset.url),
    remove: async (el) => {
      const p = find(el.dataset.id);
      if (await confirm("删除订阅", `确定删除「${p.name}」吗？`, { danger: true, ok: "删除" })) run(() => ctx.invoke("removeProfile", p.id), "已删除");
    },
    edit: (el) => {
      const p = find(el.dataset.id);
      modal({
        title: "订阅设置",
        body: html`<div class="form">
          <label>名称<input name="name" value="${p.name}" /></label>
          ${p.type === "remote"
            ? html`<label>订阅链接<input name="url" value="${p.url}" /></label>
                <label>自动更新间隔（分钟，0 为不自动更新）<input name="interval" type="number" min="0" value="${p.interval || 0}" /></label>
                <label>User-Agent（留空使用默认）<input name="ua" value="${p.userAgent || ""}" placeholder="clash.meta/knight" /></label>`
            : ""}
        </div>`,
        actions: [
          { label: "取消" },
          {
            label: "保存",
            kind: "primary",
            onClick: async (m) => {
              const v = (n) => (m.find(`[name=${n}]`) || {}).value;
              await ctx.invoke("editProfile", p.id, { name: v("name"), url: v("url"), interval: v("interval"), userAgent: v("ua") });
            },
          },
        ],
      });
    },
    content: async (el) => {
      const p = find(el.dataset.id);
      const text = await ctx.invoke("readProfile", p.id);
      modal({
        title: "编辑配置 · " + p.name,
        wide: true,
        body: html`${p.type === "remote" ? html`<p class="muted small">远程订阅更新时会覆盖这里的修改。想长期保留的改动请写在「设置 → 自定义」。</p>` : ""}
          <textarea class="code" name="text" spellcheck="false">${text}</textarea>`,
        actions: [
          { label: "取消" },
          {
            label: "保存并应用",
            kind: "primary",
            onClick: async (m) => {
              await ctx.invoke("saveProfile", p.id, m.find("[name=text]").value);
              ctx.toast("已保存", "success");
            },
          },
        ],
      });
    },
  });

  // 拖入配置文件导入
  root.addEventListener("dragover", (e) => {
    e.preventDefault();
    root.classList.add("dragging");
  });
  root.addEventListener("dragleave", (e) => {
    if (e.target === root) root.classList.remove("dragging");
  });
  root.addEventListener("drop", async (e) => {
    e.preventDefault();
    root.classList.remove("dragging");
    for (const file of e.dataTransfer.files) {
      await run(async () => ctx.invoke("importProfile", { name: file.name, text: await file.text() }), `已导入「${file.name}」`);
    }
  });

  const off = ctx.on("state", render);
  render();
  return { unmount: off };
}
