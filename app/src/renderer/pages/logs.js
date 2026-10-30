// 日志：内核实时日志（按级别过滤、搜索、暂停）与配置脚本输出
import { delegate, html, icon, patch } from "../lib.js";

const LEVELS = [
  ["debug", "调试"],
  ["info", "信息"],
  ["warning", "警告"],
  ["error", "错误"],
];

export default function logs(root, ctx) {
  root.innerHTML = html`
    <header class="page-head">
      <h1>日志</h1>
      <div class="head-actions">
        <div class="segmented" id="l-tabs"></div>
        <select data-key="level" id="l-level">${LEVELS.map(([v, t]) => html`<option value="${v}">${t}及以上</option>`)}</select>
        <div class="search">${icon("search", 16)}<input data-key="q" placeholder="搜索日志" /></div>
        <button class="icon-btn" data-action="pause" id="l-pause" title="暂停"></button>
        <button class="icon-btn" data-action="clear" title="清空">${icon("trash", 16)}</button>
      </div>
    </header>
    <div class="card log-card"><div class="log" id="l-list"></div></div>`.s;

  const $ = (id) => root.querySelector("#" + id);
  let tab = "core";
  let level = "info";
  let query = "";
  let paused = null; // 暂停时冻结的日志快照
  const rank = (t) => Math.max(0, LEVELS.findIndex(([v]) => v === t));

  function renderList() {
    const el = $("l-list");
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    let rows;
    if (tab === "core") {
      rows = (paused || ctx.logs).filter((l) => rank(l.type) >= rank(level) && (!query || l.payload.toLowerCase().includes(query)));
      patch(el, rows.length ? html`${rows.map((l) => html`<div class="log-line ${l.type}"><span class="t">${l.time}</span><span class="lv">${l.type}</span><span class="msg">${l.payload}</span></div>`)}` : html`<div class="empty">${ctx.coreRunning() ? "暂无日志" : "内核未运行"}</div>`);
    } else {
      const apply = ctx.state.apply;
      rows = (apply.logs || []).filter((l) => !query || l.message.toLowerCase().includes(query));
      patch(
        el,
        html`${apply.error ? html`<div class="log-line error"><span class="lv">error</span><span class="msg">${apply.error}</span></div>` : ""}
          ${rows.length || apply.error
            ? rows.map((l) => html`<div class="log-line ${l.level === "warn" ? "warning" : l.level}"><span class="t">${l.source}</span><span class="lv">${l.level}</span><span class="msg">${l.message}</span></div>`)
            : html`<div class="empty">生成配置时脚本没有输出</div>`}`
      );
    }
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  function render() {
    patch($("l-tabs"), html`<button class="${tab === "core" ? "active" : ""}" data-action="tab" data-tab="core">内核</button><button class="${tab === "script" ? "active" : ""}" data-action="tab" data-tab="script">脚本</button>`);
    patch($("l-pause"), paused ? icon("play", 16) : icon("pause", 16));
    $("l-level").value = level;
    $("l-level").style.display = tab === "core" ? "" : "none";
    renderList();
  }

  delegate(root, "click", {
    tab: (el) => {
      tab = el.dataset.tab;
      render();
    },
    pause: () => {
      paused = paused ? null : ctx.logs.slice();
      render();
    },
    clear: () => {
      ctx.logs.length = 0;
      if (paused) paused = [];
      renderList();
    },
  });
  $("l-level").addEventListener("change", (e) => {
    level = e.target.value;
    renderList();
  });
  root.querySelector("[data-key='q']").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    renderList();
  });

  // 日志多的时候合并重绘
  let pending = null;
  const schedule = () => {
    if (!pending) pending = setTimeout(() => ((pending = null), renderList()), 200);
  };
  const off = [ctx.on("state", () => tab === "script" && renderList()), ctx.on("log", () => tab === "core" && !paused && schedule())];
  render();
  return {
    unmount() {
      clearTimeout(pending);
      off.forEach((f) => f());
    },
  };
}
