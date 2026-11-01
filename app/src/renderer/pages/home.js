// 概览：开关、模式、当前节点、实时流量、防泄露状态、订阅用量
import { bytes, date, delayClass, delayText, delegate, html, icon, patch, raw, speed, toggle } from "../lib.js";
import { explain } from "../explain.js";
import { chainOf, delayOf, loadProxies, mainGroup } from "../proxy-data.js";

const MODES = [
  ["rule", "规则", "按订阅规则分流"],
  ["global", "全局", "全部走代理"],
  ["direct", "直连", "全部不走代理"],
];

export default function home(root, ctx) {
  root.innerHTML = html`
    <header class="page-head"><h1>概览</h1><div class="head-actions" id="h-status"></div></header>
    <section class="grid two" id="h-switches"></section>
    <section class="card" id="h-mode"></section>
    <section class="grid two">
      <div class="card" id="h-node"></div>
      <div class="card" id="h-traffic"></div>
    </section>
    <section class="grid two">
      <div class="card" id="h-leak"></div>
      <div class="card" id="h-sub"></div>
    </section>`.s;

  const $ = (id) => root.querySelector("#" + id);
  let proxyData = null;
  let connections = { total: 0, up: 0, down: 0 };

  function renderStatus() {
    const s = ctx.state;
    const st = s.core.status;
    const label = { running: "运行中", starting: "启动中", stopped: "已停止", error: "出错" }[st];
    patch(
      $("h-status"),
      html`<span class="pill ${st === "running" ? "ok" : st === "error" ? "bad" : ""}"><i></i>${s.core.label} ${s.core.version || ""} · ${label}</span>
        ${s.sidecars.map((x) => html`<span class="pill ${x.status === "running" ? "ok" : x.status === "error" ? "bad" : ""}"><i></i>搭配 ${x.label}</span>`)}`
    );
  }

  function renderSwitches() {
    const s = ctx.state.settings;
    const port = s.mixedPort;
    patch(
      $("h-switches"),
      html`
        <div class="card switch-tile ${s.systemProxy ? "on" : ""}">
          <div class="tile-icon">${icon("monitor", 22)}</div>
          <div class="tile-text"><b>系统代理</b><span>浏览器和大多数软件经 127.0.0.1:${port} 代理</span></div>
          ${toggle("systemProxy", s.systemProxy)}
        </div>
        <div class="card switch-tile ${s.tun.enable ? "on" : ""}">
          <div class="tile-icon">${icon("shield", 22)}</div>
          <div class="tile-text"><b>虚拟网卡（TUN）</b><span>接管所有应用的流量，防 WebRTC / DNS 泄露必开</span></div>
          ${toggle("tun", s.tun.enable)}
        </div>`
    );
  }

  function renderMode() {
    const mode = ctx.state.settings.mode;
    patch(
      $("h-mode"),
      html`<div class="mode-row">
        <div><b>代理模式</b><div class="muted small">${MODES.find((m) => m[0] === mode)[2]}</div></div>
        <div class="segmented">${MODES.map(([m, label]) => html`<button class="${m === mode ? "active" : ""}" data-action="mode" data-mode="${m}">${label}</button>`)}</div>
      </div>`
    );
  }

  function renderNode() {
    const s = ctx.state;
    const el = $("h-node");
    if (!s.active.length) {
      return patch(el, html`<div class="card-title" data-en="Current node">当前节点</div><div class="empty small">还没有订阅<button class="btn primary sm" data-action="go" data-page="profiles">${icon("plus", 16)}添加订阅</button></div>`);
    }
    if (s.settings.mode === "direct") return patch(el, html`<div class="card-title" data-en="Current node">当前节点</div><div class="big-name">直连</div><div class="muted small">直连模式下所有流量都不走代理</div>`);
    if (!proxyData) return patch(el, html`<div class="card-title" data-en="Current node">当前节点</div><div class="muted small">${ctx.coreRunning() ? "加载中…" : "内核未运行"}</div>`);
    const group = mainGroup(proxyData, s.settings.mode);
    if (!group) return patch(el, html`<div class="card-title" data-en="Current node">当前节点</div><div class="muted small">订阅里没有代理分组</div>`);
    const chain = chainOf(proxyData.all, group.name);
    const leaf = chain[chain.length - 1];
    const d = delayOf(proxyData.all, group.name, group.testUrl);
    patch(
      el,
      html`<div class="card-title" data-en="Current node">当前节点<button class="link" data-action="go" data-page="proxies">切换${icon("chevron", 14)}</button></div>
        <div class="big-name" title="${leaf}">${leaf}</div>
        <div class="chain">${chain.slice(0, -1).map((n) => html`<span>${n}</span>${icon("chevron", 12)}`)}<span>${leaf}</span></div>
        <div class="node-meta">
          <span class="delay ${delayClass(d)}">${delayText(d) || "未测速"}</span>
          <button class="btn sm" data-action="test" data-group="${group.name}">${icon("bolt", 14)}测速</button>
        </div>`
    );
  }

  function renderTraffic() {
    const t = ctx.traffic;
    const hist = t.history.length ? t.history : [[0, 0]];
    const max = Math.max(1024, ...hist.map(([u, d]) => Math.max(u, d)));
    const w = 300;
    const hgt = 70;
    const points = (idx) =>
      hist.map((v, i) => `${((i + 60 - hist.length) / 59) * w},${hgt - (v[idx] / max) * (hgt - 4)}`).join(" ");
    patch(
      $("h-traffic"),
      html`<div class="card-title" data-en="Traffic">实时流量</div>
        <div class="speeds">
          <div><span class="dot up"></span>上传<b>${speed(t.up)}</b></div>
          <div><span class="dot down"></span>下载<b>${speed(t.down)}</b></div>
        </div>
        <svg class="spark" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="none">
          <polyline class="down" points="${points(1)}" />
          <polyline class="up" points="${points(0)}" />
        </svg>
        <div class="stats">
          <span>连接 <b>${connections.total}</b></span>
          <span>已上传 <b>${bytes(connections.up)}</b></span>
          <span>已下载 <b>${bytes(connections.down)}</b></span>
          <span>内存 <b>${bytes(ctx.memory)}</b></span>
        </div>`
    );
  }

  function renderLeak() {
    const s = ctx.state;
    const lg = s.settings.leakGuard;
    // 脚本关于 TUN / 严格路由的提醒和下面自己的检查重复，不再列出
    const warns = (s.apply.logs || []).filter((l) => (l.level === "warn" || l.level === "error") && !/未开启 TUN|未开启「严格路由」/.test(l.message));
    const item = (ok, text, hint) =>
      html`<li class="${ok ? "ok" : "warn"}">${icon(ok ? "check" : "alert", 16)}<div><span>${text}</span>${hint ? html`<small>${hint}</small>` : ""}</div></li>`;
    const webrtcText = { follow: "跟随分流", strict: "严格", reject: "全部拦截", off: "不处理" }[lg.webrtc] || lg.webrtc;
    patch(
      $("h-leak"),
      html`<div class="card-title" data-en="Privacy">防泄露<button class="link" data-action="go" data-page="settings" data-anchor="leak">设置${icon("chevron", 14)}</button></div>
        <ul class="checks">
          ${item(lg.enabled, lg.enabled ? "DNS 防泄露已启用：境外域名经代理解析" : "防泄露脚本已关闭", lg.enabled ? "" : "DNS 可能经运营商解析境外域名")}
          ${item(s.settings.tun.enable, s.settings.tun.enable ? `WebRTC 已受保护（${webrtcText}）` : "未开启虚拟网卡", s.settings.tun.enable ? "" : "系统代理模式下 WebRTC 不经过代理，会暴露真实 IP")}
          ${s.settings.tun.enable ? item(s.settings.tun.strictRoute, s.settings.tun.strictRoute ? "严格路由已开启" : "严格路由未开启", s.settings.tun.strictRoute ? "" : "Windows 可能绕过虚拟网卡发出 DNS 查询") : ""}
          ${warns.map((w) => item(false, w.message))}
          ${s.apply.error ? item(false, explain(s.apply.error).title, explain(s.apply.error).why) : ""}
        </ul>
        <div class="row-actions">
          <button class="btn sm" data-action="open" data-url="https://browserleaks.com/webrtc">${icon("external", 14)}WebRTC 检测</button>
          <button class="btn sm" data-action="open" data-url="https://browserleaks.com/dns">${icon("external", 14)}DNS 检测</button>
          <button class="btn sm" data-action="open" data-url="https://ipleak.net">${icon("external", 14)}ipleak</button>
        </div>`
    );
  }

  // 在用的订阅：主订阅在前，每个一行（名字、用量、更新）
  function renderSub() {
    const s = ctx.state;
    const list = s.active.map((id) => s.profiles.find((x) => x.id === id)).filter(Boolean);
    const head = html`<div class="card-title" data-en="Subscriptions">订阅<button class="link" data-action="go" data-page="profiles">管理${icon("chevron", 14)}</button></div>`;
    if (!list.length) return patch($("h-sub"), html`${head}<div class="muted small">${s.profiles.length ? "没有在用的订阅，打开订阅的开关即可使用" : "还没有订阅"}</div>`);
    const row = (p, i) => {
      const u = p.userinfo || {};
      const used = (u.upload || 0) + (u.download || 0);
      const pct = u.total ? Math.min(100, (used / u.total) * 100) : 0;
      return html`<div class="sub-row">
        <div class="sub-line"><b class="sub-name" title="${p.name}">${i === 0 && list.length > 1 ? html`<span class="star">★</span>` : ""}${p.name}</b>
          ${p.type !== "local" ? html`<button class="icon-btn sm ${p.updating ? "spin" : ""}" data-action="update" data-id="${p.id}" title="更新" ${raw(p.updating ? "disabled" : "")}>${icon("refresh", 14)}</button>` : ""}</div>
        ${u.total
          ? html`<div class="bar"><i style="width:${pct.toFixed(1)}%" class="${pct > 90 ? "bad" : ""}"></i></div>
              <div class="muted small">${bytes(used)} / ${bytes(u.total)}${u.expire ? " · " + date(u.expire * 1000) + " 到期" : ""}</div>`
          : html`<div class="muted small">${p.type === "local" ? "本地配置" : p.type === "combo" ? "组合订阅" : "订阅没有提供流量信息"}${p.nodes ? ` · ${p.nodes} 个节点` : ""}</div>`}
      </div>`;
    };
    patch(
      $("h-sub"),
      html`${head}${list.length > 1 ? html`<div class="muted small sub-note">${list.length} 个订阅同时使用 · ★ 主订阅提供分组和规则</div>` : ""}
        <div class="sub-list">${list.slice(0, 4).map(row)}</div>
        ${list.length > 4 ? html`<div class="muted small">还有 ${list.length - 4} 个……</div>` : ""}`
    );
  }

  function renderAll() {
    renderStatus();
    renderSwitches();
    renderMode();
    renderNode();
    renderTraffic();
    renderLeak();
    renderSub();
  }

  async function refreshProxies() {
    if (!ctx.coreRunning()) return;
    try {
      proxyData = await loadProxies(ctx.api);
      renderNode();
    } catch {
      /* 内核重载中 */
    }
  }

  async function refreshConnections() {
    if (!ctx.coreRunning()) return;
    try {
      const c = await ctx.api.connections();
      connections = { total: (c.connections || []).length, up: c.uploadTotal || 0, down: c.downloadTotal || 0 };
    } catch {
      /* 忽略 */
    }
  }

  const off = [
    ctx.on("traffic", renderTraffic),
    ctx.on("state", (coreUp) => {
      if (coreUp) refreshProxies();
      renderAll();
    }),
    delegate(root, "click", {
      mode: (el) => ctx.set({ mode: el.dataset.mode }).catch(() => {}),
      go: (el) => ctx.navigate(el.dataset.page, el.dataset.anchor),
      open: (el) => ctx.invoke("openExternal", el.dataset.url),
      update: (el) => ctx.invoke("updateProfile", el.dataset.id).then(() => ctx.toast("订阅已更新", "success"), (err) => ctx.toast(err.message, "error")),
      test: async (el) => {
        el.disabled = true;
        try {
          await ctx.api.groupDelay(el.dataset.group, ctx.state.settings.delayUrl, ctx.state.settings.delayTimeout);
        } catch {
          /* 全部超时时接口会报错，结果照样写进了历史 */
        }
        await refreshProxies();
      },
    }),
  ];

  root.addEventListener("change", (e) => {
    const key = e.target.dataset.key;
    if (key === "systemProxy") ctx.set({ systemProxy: e.target.checked }).catch(() => renderSwitches());
    if (key === "tun") ctx.set({ tun: { enable: e.target.checked } }).catch(() => renderSwitches());
  });

  const timer = setInterval(() => {
    if (ctx.hidden()) return;
    refreshProxies();
    refreshConnections();
  }, 3000);
  renderAll();
  refreshProxies();
  refreshConnections();

  return {
    unmount() {
      clearInterval(timer);
      off.forEach((f) => f());
    },
  };
}
