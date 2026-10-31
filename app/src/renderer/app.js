// 界面入口：导航、全局状态、实时流量与日志；各页面在 pages/ 下
import { createApi } from "./api.js";
import { html, icon, patch, speed, toast } from "./lib.js";
import home from "./pages/home.js";
import proxies from "./pages/proxies.js";
import profiles from "./pages/profiles.js";
import convert from "./pages/convert.js";
import connections from "./pages/connections.js";
import rules from "./pages/rules.js";
import logs from "./pages/logs.js";
import settings from "./pages/settings.js";

// [名字, 中文, 图标, 页面, 英文（页头小字）]
const PAGES = [
  ["home", "概览", "home", home, "Overview"],
  ["proxies", "代理", "globe", proxies, "Proxies"],
  ["profiles", "订阅", "layers", profiles, "Subscriptions"],
  ["convert", "转换", "shuffle", convert, "Conversion"],
  ["connections", "连接", "link", connections, "Connections"],
  ["rules", "规则", "list", rules, "Rules"],
  ["logs", "日志", "terminal", logs, "Journal"],
  ["settings", "设置", "settings", settings, "Preferences"],
];

const listeners = { state: new Set(), traffic: new Set(), log: new Set(), visible: new Set() };
const ctx = {
  state: null,
  traffic: { up: 0, down: 0, history: [] }, // 最近 60 秒
  memory: 0,
  logs: [], // 内核日志，最多 1000 条
  api: createApi(() => ctx.state && ctx.state.controller),
  invoke: (method, ...args) => window.knight.invoke(method, ...args),
  toast,
  navigate: (page, anchor) => go(page, anchor),
  // type："state"（参数 coreUp 表示内核刚启动）、"traffic"、"log"、"visible"（窗口重新显示）；返回取消订阅函数
  on: (type, fn) => {
    listeners[type].add(fn);
    return () => listeners[type].delete(fn);
  },
  emit: (type, arg) => listeners[type].forEach((fn) => fn(arg)),
  coreRunning: () => !!ctx.state && ctx.state.core.status === "running",
  caps: () => (ctx.state ? ctx.state.core.caps : {}),
  // 窗口藏到托盘时不必刷新：定时任务先问一下
  hidden: () => document.hidden,
  // 统一处理设置修改：需要 TUN 授权时引导到设置页
  set: async (patchObj) => {
    try {
      await ctx.invoke("setSettings", patchObj);
    } catch (err) {
      if (err.message === "NEED_TUN_PERMISSION") {
        toast("开启虚拟网卡需要先授权，请在「设置 → 虚拟网卡」里点「授权」", "error");
        go("settings", "tun");
      } else toast(err.message, "error");
      throw err;
    }
  },
};

let current = null;
let currentName = "";

function renderNav() {
  patch(
    document.getElementById("nav"),
    html`${PAGES.map(([name, label, ic]) => html`<button class="nav-item ${name === currentName ? "active" : ""}" data-page="${name}">${icon(ic)}<span>${label}</span></button>`)}`
  );
}

function go(name, anchor) {
  const entry = PAGES.find((p) => p[0] === name) || PAGES[0];
  if (current && current.unmount) current.unmount();
  currentName = entry[0];
  // 每个页面一个新的容器，旧页面挂的事件监听随旧容器一起丢弃
  const old = document.getElementById("page");
  const root = old.cloneNode(false);
  old.replaceWith(root);
  current = entry[3](root, ctx) || {};
  addKicker(root, PAGES.indexOf(entry) + 1, entry[4]);
  renderNav();
  if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }), 50);
  try {
    localStorage.setItem("knight.page", currentName);
  } catch {
    /* 存储不可用时忽略 */
  }
}

// 页头标题上方的小字：No.01 — OVERVIEW（海报式编号）
function addKicker(root, index, english) {
  const h1 = root.querySelector(".page-head h1");
  if (!h1) return;
  const block = document.createElement("div");
  block.className = "title-block";
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = `No.${String(index).padStart(2, "0")} — ${english}`;
  h1.replaceWith(block);
  block.append(kicker, h1);
}

function renderTraffic() {
  const el = document.getElementById("side-traffic");
  const s = ctx.state;
  const running = ctx.coreRunning();
  patch(
    el,
    html`<div class="core-name">${s ? [s.core.label].concat(s.sidecars.map((x) => x.label)).join(" + ") : ""}</div>
      ${running
        ? html`<div class="row">${icon("up", 14)}<span>${speed(ctx.traffic.up)}</span></div><div class="row">${icon("down", 14)}<span>${speed(ctx.traffic.down)}</span></div>`
        : html`<div class="row">内核未运行</div>`}`
  );
}

document.getElementById("nav").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (btn) go(btn.dataset.page);
});

// 实时流量、内存、日志：全局只连一次；窗口隐藏时断开，显示时重连
let streams = [];
function startStreams() {
  streams = [
    ctx.api.stream("/traffic", (d) => {
      ctx.traffic.up = d.up || 0;
      ctx.traffic.down = d.down || 0;
      ctx.traffic.history.push([d.up || 0, d.down || 0]);
      if (ctx.traffic.history.length > 60) ctx.traffic.history.shift();
      renderTraffic();
      ctx.emit("traffic");
    }),
    ctx.api.stream("/memory", (d) => {
      ctx.memory = d.inuse || 0;
    }),
    // 级别过滤在日志页里做
    ctx.api.stream("/logs?level=debug", (d) => {
      ctx.logs.push({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), type: d.type, payload: d.payload });
      if (ctx.logs.length > 1000) ctx.logs.splice(0, ctx.logs.length - 1000);
      ctx.emit("log");
    }),
  ];
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    streams.forEach((stop) => stop());
    streams = [];
  } else {
    startStreams();
    ctx.emit("visible");
  }
});

window.knight.onState((state) => {
  const wasRunning = ctx.coreRunning();
  ctx.state = state;
  applyTheme();
  renderTraffic();
  ctx.emit("state", !wasRunning && ctx.coreRunning());
});
window.knight.onNavigate((page) => go(page));
window.knight.onToast(({ message, type }) => toast(message, type));

// 深浅色：跟随系统时交给 prefers-color-scheme，指定时直接写在根元素上
function applyTheme() {
  const theme = ctx.state.settings.theme;
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

ctx.state = await ctx.invoke("state");
applyTheme();
renderTraffic();
if (!document.hidden) startStreams();
let start = "home";
try {
  start = localStorage.getItem("knight.page") || "home";
} catch {
  /* 忽略 */
}
go(start);
