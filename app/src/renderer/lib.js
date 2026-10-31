// 页面共用的小工具：安全的模板、格式化、图标、弹窗与提示

// ---------------- 模板：插值默认转义（节点名、规则都来自订阅，不能当 HTML 用）----------------
class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));
export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const part = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join("") : v === false || v == null ? "" : esc(v));
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => (out += part(v) + strings[i + 1]));
  return new Raw(out);
}

// 替换内容时保留输入框焦点和光标位置（状态推送会频繁重绘）
export function patch(el, content) {
  const active = document.activeElement;
  const key = active && el.contains(active) && active.dataset && active.dataset.key;
  const sel = key && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;
  const scroll = el.scrollTop;
  el.innerHTML = content instanceof Raw ? content.s : String(content);
  el.scrollTop = scroll;
  if (key) {
    const next = el.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (next) {
      next.focus();
      if (sel) {
        try {
          next.setSelectionRange(sel[0], sel[1]);
        } catch {
          /* 某些输入类型不支持 */
        }
      }
    }
  }
}

// 事件委托：data-action="name" 的元素被点击时调用 handlers[name](el, event)
export function delegate(root, type, handlers) {
  const listener = (e) => {
    const el = e.target.closest("[data-action]");
    if (!el || !root.contains(el)) return;
    const fn = handlers[el.dataset.action];
    if (fn) fn(el, e);
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}

// ---------------- 格式化 ----------------
export function bytes(n, digits = 1) {
  n = Number(n) || 0;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : digits)) + " " + units[i];
}
export const speed = (n) => bytes(n) + "/s";

export function ago(ts) {
  if (!ts) return "从未";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}

export function duration(from) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 1000));
  if (s < 60) return s + " 秒";
  if (s < 3600) return Math.floor(s / 60) + " 分";
  if (s < 86400) return Math.floor(s / 3600) + " 时 " + (Math.floor(s / 60) % 60) + " 分";
  return Math.floor(s / 86400) + " 天";
}

export function date(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 延迟颜色：0 表示超时 / 未测
export function delayClass(ms) {
  if (ms === undefined || ms === null) return "";
  if (!ms) return "bad";
  if (ms < 300) return "good";
  if (ms < 800) return "mid";
  return "slow";
}
export const delayText = (ms) => (ms === undefined || ms === null ? "" : ms ? ms + " ms" : "超时");

// ---------------- 图标（24×24 线框）----------------
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4M12 17.5v.01"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 4v16l13-8L7 4Z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
};
export const icon = (name, size = 18) =>
  raw(`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ""}</svg>`);

// ---------------- 提示与弹窗 ----------------
export function toast(message, type = "info") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.classList.add("leave"), type === "error" ? 6000 : 2800);
  setTimeout(() => el.remove(), type === "error" ? 6400 : 3200);
}

// actions: [{ label, kind: "primary" | "danger" | "", onClick(modal) → 返回 false 不关闭 }]
export function modal({ title, body, actions = [], wide = false, onMount, onClose }) {
  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = html`<div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close title="关闭">${icon("x")}</button></div>
    <div class="modal-body">${body}</div>
    ${actions.length
      ? html`<div class="modal-foot">${actions.map((a, i) => html`<button class="btn ${a.kind || ""}" data-i="${i}">${a.label}</button>`)}</div>`
      : ""}
  </div>`.s;
  document.body.appendChild(wrap);
  const close = () => {
    if (!wrap.isConnected) return;
    wrap.remove();
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("mousedown", (e) => e.target === wrap && close());
  wrap.querySelector("[data-close]").addEventListener("click", close);
  const api = { el: wrap, close, find: (sel) => wrap.querySelector(sel) };
  wrap.querySelectorAll(".modal-foot .btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const a = actions[Number(btn.dataset.i)];
      if (!a.onClick) return close();
      btn.disabled = true;
      try {
        if ((await a.onClick(api)) !== false) close();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    })
  );
  if (onMount) onMount(api);
  const first = wrap.querySelector("input, textarea, select");
  if (first) first.focus();
  return api;
}

export function confirm(title, message, { danger = false, ok = "确定" } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: html`<p class="muted">${message}</p>`,
      actions: [
        { label: "取消", onClick: () => resolve(false) },
        { label: ok, kind: danger ? "danger" : "primary", onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false), // 已经 resolve 过的不受影响
    });
  });
}

// 简单的开关控件
export const toggle = (key, checked, attrs = "") =>
  html`<label class="switch"><input type="checkbox" data-key="${key}" ${raw(checked ? "checked" : "")} ${raw(attrs)} /><span></span></label>`;

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
