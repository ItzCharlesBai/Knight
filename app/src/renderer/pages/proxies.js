// 代理：分组与节点，点选切换、测速、排序；底部是代理集合（proxy-providers）
import { ago, delayClass, delayText, delegate, html, icon, patch, raw } from "../lib.js";
import { delayOf, isGroup, loadProxies } from "../proxy-data.js";

const TYPE_LABEL = { Selector: "手动选择", URLTest: "自动选择", Fallback: "故障转移", LoadBalance: "负载均衡", Relay: "链式代理" };
const SORTS = [
  ["default", "默认顺序"],
  ["delay", "按延迟"],
  ["name", "按名称"],
];

const store = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem("lily.proxies." + key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem("lily.proxies." + key, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
};

export default function proxies(root, ctx) {
  root.innerHTML = html`
    <header class="page-head">
      <h1>代理</h1>
      <div class="head-actions">
        <div class="search">${icon("search", 16)}<input data-key="q" placeholder="搜索节点" /></div>
        <button class="btn" data-action="sort" title="排序">${icon("sort", 16)}<span id="p-sort"></span></button>
      </div>
    </header>
    <div id="p-notice"></div>
    <div id="p-groups" class="groups"></div>
    <div id="p-providers"></div>`.s;

  const $ = (id) => root.querySelector("#" + id);
  let data = null;
  let providers = [];
  let query = "";
  let sort = store("sort", "default");
  const open = new Set(store("open", []));
  const testing = new Set();

  function sortedMembers(group) {
    const testUrl = group.testUrl;
    let names = (group.all || []).filter((n) => !query || n.toLowerCase().includes(query));
    if (sort === "name") names = names.slice().sort((a, b) => a.localeCompare(b, "zh"));
    if (sort === "delay") {
      const d = (n) => delayOf(data.all, n, testUrl) || 1e9;
      names = names.slice().sort((a, b) => d(a) - d(b));
    }
    return names;
  }

  function render() {
    patch($("p-sort"), SORTS.find((s) => s[0] === sort)[1]);
    const mode = ctx.state.settings.mode;
    if (!ctx.coreRunning()) {
      patch($("p-notice"), html`<div class="notice">内核未运行，请到「设置 → 内核」查看原因</div>`);
      patch($("p-groups"), "");
      return;
    }
    patch($("p-notice"), mode === "direct" ? html`<div class="notice">当前是直连模式，所有流量都不走代理。切换节点后需要改回「规则」或「全局」模式才会生效。</div>` : "");
    if (!data) return patch($("p-groups"), html`<div class="empty">加载中…</div>`);
    const groups = mode === "global" && data.global ? [data.global, ...data.groups] : data.groups;
    if (!groups.length) return patch($("p-groups"), html`<div class="empty">当前订阅没有代理分组</div>`);
    patch($("p-groups"), html`${groups.map(renderGroup)}`);
    renderProviders();
  }

  function renderGroup(g) {
    const members = sortedMembers(g);
    const isOpen = open.has(g.name) || !!query;
    const nowDelay = delayOf(data.all, g.name, g.testUrl);
    const selectable = g.type === "Selector";
    if (query && !members.length) return "";
    return html`<div class="group card ${isOpen ? "open" : ""}">
      <div class="group-head" data-action="toggle" data-name="${g.name}">
        <span class="chev">${icon("chevron", 16)}</span>
        <div class="group-title">
          <b>${g.name === "GLOBAL" ? "GLOBAL（全局模式）" : g.name}</b>
          <span class="muted small">${TYPE_LABEL[g.type] || g.type} · ${(g.all || []).length} 个</span>
        </div>
        <div class="group-now" title="${g.now || ""}">${g.now || ""}</div>
        <span class="delay ${delayClass(nowDelay)}">${delayText(nowDelay)}</span>
        <button class="icon-btn ${testing.has(g.name) ? "spin" : ""}" data-action="test" data-name="${g.name}" title="测速">${icon("bolt", 16)}</button>
      </div>
      ${isOpen
        ? html`<div class="nodes">${members.map((n) => {
            const p = data.all[n] || {};
            const d = delayOf(data.all, n, g.testUrl);
            return html`<button class="node ${n === g.now ? "active" : ""} ${selectable ? "" : "readonly"}" data-action="select" data-group="${g.name}" data-name="${n}" title="${n}">
              <span class="node-name">${n}</span>
              <span class="node-meta"><span class="muted">${isGroup(p) ? "分组" : (p.type || "").toLowerCase()}${p.udp ? " · UDP" : ""}</span>
              <span class="delay ${delayClass(d)}" data-action="test-one" data-name="${n}" data-group="${g.name}">${delayText(d) || raw('<span class="muted">测速</span>')}</span></span>
            </button>`;
          })}</div>`
        : ""}
    </div>`;
  }

  function renderProviders() {
    const list = providers.filter((p) => p.vehicleType !== "Compatible");
    if (!list.length) return patch($("p-providers"), "");
    patch(
      $("p-providers"),
      html`<h2 class="section-title">代理集合</h2>
        <div class="card list">${list.map((p) => {
          const info = p.subscriptionInfo || {};
          const used = (info.Upload || 0) + (info.Download || 0);
          return html`<div class="list-row">
            <div class="grow"><b>${p.name}</b><div class="muted small">${(p.proxies || []).length} 个节点 · ${p.vehicleType} · 更新于 ${ago(new Date(p.updatedAt).getTime())}${info.Total ? ` · 已用 ${(used / 1073741824).toFixed(1)} / ${(info.Total / 1073741824).toFixed(0)} GB` : ""}</div></div>
            <button class="btn sm" data-action="hc" data-name="${p.name}">${icon("bolt", 14)}测速</button>
            ${p.vehicleType === "HTTP" ? html`<button class="btn sm" data-action="update-provider" data-name="${p.name}">${icon("refresh", 14)}更新</button>` : ""}
          </div>`;
        })}</div>`
    );
  }

  async function refresh() {
    if (!ctx.coreRunning()) return render();
    try {
      data = await loadProxies(ctx.api);
      providers = Object.values((await ctx.api.proxyProviders()).providers || {});
    } catch {
      /* 内核重载中，下次再取 */
    }
    render();
  }

  async function testGroup(name) {
    if (testing.has(name)) return;
    testing.add(name);
    render();
    const s = ctx.state.settings;
    const g = data && data.all[name];
    try {
      if (name === "GLOBAL") {
        // GLOBAL 没有测速接口：逐个测，最多同时 8 个
        const queue = (g.all || []).filter((n) => !isGroup(data.all[n]));
        await Promise.all(Array.from({ length: 8 }, async () => {
          while (queue.length) await ctx.api.delay(queue.shift(), s.delayUrl, s.delayTimeout).catch(() => {});
        }));
      } else {
        await ctx.api.groupDelay(name, (g && g.testUrl) || s.delayUrl, s.delayTimeout);
      }
    } catch {
      /* 全部超时时接口会报错，结果照样记在历史里 */
    }
    testing.delete(name);
    open.add(name);
    await refresh();
  }

  const off = [ctx.on("state", refresh)];

  delegate(root, "click", {
    toggle: (el, e) => {
      if (e.target.closest("[data-action='test']")) return;
      const name = el.dataset.name;
      open.has(name) ? open.delete(name) : open.add(name);
      save("open", [...open]);
      render();
    },
    test: (el) => testGroup(el.dataset.name),
    "test-one": async (el, e) => {
      e.stopPropagation();
      const s = ctx.state.settings;
      const g = data.all[el.dataset.group];
      el.textContent = "…";
      await ctx.api.delay(el.dataset.name, (g && g.testUrl) || s.delayUrl, s.delayTimeout).catch(() => {});
      refresh();
    },
    select: async (el) => {
      const g = data.all[el.dataset.group];
      if (!g || g.type !== "Selector") return ctx.toast(`「${g ? TYPE_LABEL[g.type] : ""}」分组由内核自动选择节点`, "info");
      try {
        await ctx.api.select(el.dataset.group, el.dataset.name);
        // 切换后断开该分组上的旧连接，新节点立即生效
        const conns = (await ctx.api.connections()).connections || [];
        await Promise.all(conns.filter((c) => (c.chains || []).includes(el.dataset.group)).map((c) => ctx.api.closeConnection(c.id).catch(() => {})));
      } catch (err) {
        ctx.toast(err.message, "error");
      }
      refresh();
    },
    sort: () => {
      sort = SORTS[(SORTS.findIndex((s) => s[0] === sort) + 1) % SORTS.length][0];
      save("sort", sort);
      render();
    },
    hc: async (el) => {
      el.disabled = true;
      await ctx.api.healthcheckProvider(el.dataset.name).catch(() => {});
      refresh();
    },
    "update-provider": async (el) => {
      el.disabled = true;
      try {
        await ctx.api.updateProxyProvider(el.dataset.name);
        ctx.toast("已更新 " + el.dataset.name, "success");
      } catch (err) {
        ctx.toast(err.message, "error");
      }
      refresh();
    },
  });

  root.querySelector("[data-key='q']").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });

  const timer = setInterval(() => !ctx.hidden() && refresh(), 5000);
  render();
  refresh();
  return {
    unmount() {
      clearInterval(timer);
      off.forEach((f) => f());
    },
  };
}
