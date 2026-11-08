// 界面入口：导航、全局状态、实时流量与日志；各页面在 pages/ 下
import { createApi } from "./api.js";
import { createBurst, createScene } from "./fx.js";
import { html, icon, patch, speed, toast } from "./lib.js";
import home from "./pages/home.js";
import proxies from "./pages/proxies.js";
import profiles from "./pages/profiles.js";
import convert from "./pages/convert.js";
import servers from "./pages/servers.js";
import connections from "./pages/connections.js";
import rules from "./pages/rules.js";
import logs from "./pages/logs.js";
import settings from "./pages/settings.js";

// [名字, 中文, 图标, 页面, 英文（页头小字）, 页头背后的大字, 右边竖排的短诗]
const PAGES = [
  ["home", "概览", "home", home, "Overview", "风", "今天的风，从哪里吹来"],
  ["proxies", "代理", "globe", proxies, "Proxies", "路", "选一条路，去看远方"],
  ["profiles", "订阅", "layers", profiles, "Subscriptions", "集", "把远方的地址，收在一起"],
  ["convert", "转换", "shuffle", convert, "Conversion", "译", "换一种说法，说同一件事"],
  ["servers", "服务器", "server", servers, "Servers", "灯", "在远方，留一盏自己的灯"],
  ["connections", "连接", "link", connections, "Connections", "流", "此刻，正在路上的每一句话"],
  ["rules", "规则", "list", rules, "Rules", "界", "去哪里，交给规则安排"],
  ["logs", "日志", "terminal", logs, "Journal", "记", "安静地，记下每一件小事"],
  ["settings", "设置", "settings", settings, "Preferences", "随", "一切，随你的心意"],
];

const listeners = { state: new Set(), traffic: new Set(), log: new Set(), visible: new Set(), vps: new Set() };
const ctx = {
  state: null,
  traffic: { up: 0, down: 0, history: [] }, // 最近 60 秒
  memory: 0,
  logs: [], // 内核日志，最多 1000 条
  api: createApi(() => ctx.state && ctx.state.controller),
  invoke: (method, ...args) => window.ondine.invoke(method, ...args),
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
    html`${PAGES.map(([name, label, ic, , en]) => html`<button class="nav-item ${name === currentName ? "active" : ""}" data-page="${name}">${icon(ic)}<span>${label}</span><em>${en}</em></button>`)}`
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
  posterHead(root, PAGES.indexOf(entry) + 1, entry);
  renderNav();
  if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: "start" }), 50);
  try {
    localStorage.setItem("ondine.page", currentName);
  } catch {
    /* 存储不可用时忽略 */
  }
}

// 页头像一张小海报：编号小字（Nº 01 · OVERVIEW）、片名、右边留白里一行竖排的短诗、背后一个很淡的大字
function posterHead(root, index, [, , , , english, mark, poem]) {
  const head = root.querySelector(".page-head");
  const h1 = head && head.querySelector("h1");
  if (!h1) return;
  const block = document.createElement("div");
  block.className = "title-block";
  const kicker = document.createElement("div");
  kicker.className = "kicker";
  kicker.textContent = `Nº ${String(index).padStart(2, "0")} · ${english}`;
  h1.replaceWith(block);
  block.append(kicker, h1);
  const big = document.createElement("div");
  big.className = "poster-mark";
  big.setAttribute("aria-hidden", "true");
  big.textContent = mark;
  const verse = document.createElement("p");
  verse.className = "poem";
  verse.setAttribute("aria-hidden", "true");
  verse.textContent = poem;
  head.prepend(big);
  head.append(verse);
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

window.ondine.onState((state) => {
  const wasRunning = ctx.coreRunning();
  ctx.state = state;
  applyTheme();
  renderTraffic();
  ctx.emit("state", !wasRunning && ctx.coreRunning());
});
window.ondine.onNavigate((page) => go(page));
window.ondine.onToast(({ message, type }) => toast(message, type));
window.ondine.onVps((msg) => ctx.emit("vps", msg));

// ---------------- 光影与粒子 ----------------
const scene = createScene(document.getElementById("scene"));
const burst = createBurst(document.getElementById("burst"));
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
let lastLook = "";
// 天气写在根元素上；动态效果关掉、系统要求减少动画、窗口藏起来时都停下
function applyTheme() {
  const { theme, motion, font } = ctx.state.settings;
  const moving = motion && !reduced.matches;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.font = font;
  document.documentElement.classList.toggle("still", !moving);
  burst.enabled = moving;
  const look = theme + moving + document.hidden;
  if (look === lastLook) return;
  lastLook = look;
  scene.setWeather(theme);
  if (moving && !document.hidden) scene.start();
  else scene.stop();
}
document.addEventListener("visibilitychange", () => ctx.state && applyTheme());
// 点按钮、导航、节点时冒一小簇光点；开关打开时多一点
document.addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".btn, .icon-btn, .nav-item, .segmented button, .chip, .node, .profile, .share-row button");
  if (!el || el.disabled) return;
  burst.burst(e.clientX, e.clientY, el.classList.contains("primary") ? "big" : "tap");
});
document.addEventListener("change", (e) => {
  const sw = e.target.closest(".switch");
  if (!sw || !e.target.checked) return;
  const r = sw.getBoundingClientRect();
  burst.burst(r.left + r.width * 0.75, r.top + r.height / 2, "on");
});
// 成功的提示冒光点，失败的轻轻一抖（样式里）再冒一点暗红的
window.addEventListener("ondine:toast", (e) => {
  const { el, type } = e.detail;
  if (type !== "success" && type !== "error") return;
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    burst.burst(r.left + 14, r.top + r.height / 2, type);
  });
});

ctx.state = await ctx.invoke("state");
applyTheme();
renderTraffic();
if (!document.hidden) startStreams();
let start = "home";
try {
  start = localStorage.getItem("ondine.page") || "home";
} catch {
  /* 忽略 */
}
go(start);
