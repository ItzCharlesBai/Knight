// 连接：活动 / 已关闭，搜索、断开、详情
import { bytes, confirm, delegate, duration, html, icon, modal, patch, raw, speed } from "../lib.js";

export default function connections(root, ctx) {
  root.innerHTML = html`
    <header class="page-head">
      <h1>连接</h1>
      <div class="head-actions">
        <div class="segmented" id="c-tabs"></div>
        <div class="search">${icon("search", 16)}<input data-key="q" placeholder="搜索主机、进程、规则、节点" /></div>
        <button class="icon-btn" data-action="pause" id="c-pause" title="暂停刷新"></button>
        <button class="btn danger-text" data-action="close-all">${icon("x", 16)}全部断开</button>
      </div>
    </header>
    <div class="conn-summary muted small" id="c-sum"></div>
    <div class="card table-card"><div class="table-wrap" id="c-table"></div></div>`.s;

  const $ = (id) => root.querySelector("#" + id);
  let tab = "active";
  let query = "";
  let paused = false;
  let active = [];
  let closed = [];
  let totals = { up: 0, down: 0 };
  let prev = new Map(); // id → 上一次的累计流量，用来算速度

  const host = (c) => {
    const m = c.metadata;
    return (m.host || m.sniffHost || m.destinationIP) + ":" + m.destinationPort;
  };
  const chain = (c) => (c.chains || []).slice().reverse().join(" → ");
  const rule = (c) => c.rule + (c.rulePayload ? " · " + c.rulePayload : "");
  const proc = (c) => (c.metadata.process || "").replace(/\.exe$/i, "");

  function onData(d) {
    if (paused) return;
    const list = d.connections || [];
    const seen = new Set();
    const now = list.map((c) => {
      seen.add(c.id);
      const p = prev.get(c.id);
      return Object.assign(c, { upSpeed: p ? c.upload - p.upload : 0, downSpeed: p ? c.download - p.download : 0 });
    });
    for (const c of active) {
      if (!seen.has(c.id)) closed.unshift(Object.assign({}, c, { upSpeed: 0, downSpeed: 0, closedAt: Date.now() }));
    }
    closed = closed.slice(0, 300);
    prev = new Map(now.map((c) => [c.id, { upload: c.upload, download: c.download }]));
    active = now;
    totals = { up: d.uploadTotal || 0, down: d.downloadTotal || 0 };
    render();
  }

  function render() {
    patch($("c-tabs"), html`<button class="${tab === "active" ? "active" : ""}" data-action="tab" data-tab="active">活动 ${active.length}</button><button class="${tab === "closed" ? "active" : ""}" data-action="tab" data-tab="closed">已关闭 ${closed.length}</button>`);
    patch($("c-pause"), paused ? icon("play", 16) : icon("pause", 16));
    patch($("c-sum"), html`共上传 ${bytes(totals.up)} · 下载 ${bytes(totals.down)}${paused ? " · 已暂停刷新" : ""}`);
    const q = query;
    const rows = (tab === "active" ? active : closed)
      .filter((c) => !q || [host(c), proc(c), rule(c), chain(c), c.metadata.network, c.metadata.sourceIP].join(" ").toLowerCase().includes(q))
      .sort((a, b) => (tab === "active" ? b.downSpeed + b.upSpeed - (a.downSpeed + a.upSpeed) || new Date(b.start) - new Date(a.start) : b.closedAt - a.closedAt))
      .slice(0, 500);
    if (!rows.length) return patch($("c-table"), html`<div class="empty">${ctx.coreRunning() ? "没有连接" : "内核未运行"}</div>`);
    patch(
      $("c-table"),
      html`<table class="table">
        <thead><tr><th>主机</th><th>进程</th><th>规则</th><th>代理链</th><th class="num">速度</th><th class="num">流量</th><th class="num">时长</th><th></th></tr></thead>
        <tbody>${rows.map(
          (c) => html`<tr data-action="detail" data-id="${c.id}">
            <td class="host"><span class="net">${c.metadata.network}</span>${host(c)}</td>
            <td class="ellipsis">${proc(c) || raw('<span class="muted">-</span>')}</td>
            <td class="ellipsis">${rule(c)}</td>
            <td class="ellipsis">${chain(c)}</td>
            <td class="num">${c.downSpeed || c.upSpeed ? html`↓${speed(c.downSpeed)}<br />↑${speed(c.upSpeed)}` : raw('<span class="muted">-</span>')}</td>
            <td class="num">${bytes(c.download)}<br /><span class="muted">${bytes(c.upload)}</span></td>
            <td class="num muted">${duration(c.start)}</td>
            <td>${tab === "active" ? html`<button class="icon-btn" data-action="close" data-id="${c.id}" title="断开">${icon("x", 14)}</button>` : ""}</td>
          </tr>`
        )}</tbody></table>`
    );
  }

  const stop = ctx.api.stream("/connections?interval=1000", onData);

  delegate(root, "click", {
    tab: (el) => {
      tab = el.dataset.tab;
      render();
    },
    pause: () => {
      paused = !paused;
      render();
    },
    close: (el, e) => {
      e.stopPropagation();
      ctx.api.closeConnection(el.dataset.id).catch((err) => ctx.toast(err.message, "error"));
    },
    "close-all": async () => {
      if (await confirm("全部断开", "断开所有活动连接？正在进行的下载和通话会中断，软件会自动重连。", { danger: true, ok: "断开" })) {
        ctx.api.closeAll().catch((err) => ctx.toast(err.message, "error"));
      }
    },
    detail: (el) => {
      const c = active.find((x) => x.id === el.dataset.id) || closed.find((x) => x.id === el.dataset.id);
      if (!c) return;
      const m = c.metadata;
      const rows = [
        ["主机", m.host || "-"],
        ["嗅探域名", m.sniffHost || "-"],
        ["目标地址", (m.destinationIP || "-") + ":" + m.destinationPort],
        ["来源", (m.sourceIP || "-") + ":" + m.sourcePort],
        ["入站", (m.type || "") + (m.inboundName ? " · " + m.inboundName : "")],
        ["网络", m.network],
        ["进程", m.processPath || m.process || "-"],
        ["DNS 模式", m.dnsMode || "-"],
        ["规则", rule(c)],
        ["代理链", chain(c)],
        ["远程地址", m.remoteDestination || "-"],
        ["上传 / 下载", bytes(c.upload) + " / " + bytes(c.download)],
        ["开始时间", new Date(c.start).toLocaleString()],
      ];
      modal({
        title: "连接详情",
        body: html`<dl class="kv">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`,
        actions: tab === "active" ? [{ label: "断开连接", kind: "danger", onClick: () => ctx.api.closeConnection(c.id) }] : [],
      });
    },
  });

  root.querySelector("[data-key='q']").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });

  render();
  return { unmount: stop };
}
