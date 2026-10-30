// 规则：当前生效的规则列表（含防泄露规则）与规则集合（rule-providers）
import { ago, delegate, html, icon, patch } from "../lib.js";

export default function rules(root, ctx) {
  root.innerHTML = html`
    <header class="page-head">
      <h1>规则</h1>
      <div class="head-actions">
        <div class="search">${icon("search", 16)}<input data-key="q" placeholder="搜索规则或策略" /></div>
      </div>
    </header>
    <div id="r-providers"></div>
    <div class="muted small" id="r-count"></div>
    <div class="card table-card"><div class="table-wrap" id="r-list"></div></div>`.s;

  const $ = (id) => root.querySelector("#" + id);
  let list = [];
  let providers = [];
  let query = "";

  function render() {
    const rows = list
      .map((r, i) => Object.assign({ index: i + 1 }, r))
      .filter((r) => !query || [r.type, r.payload, r.proxy].join(" ").toLowerCase().includes(query));
    patch($("r-count"), html`共 ${list.length} 条规则${query ? `，匹配 ${rows.length} 条` : ""}，按顺序匹配，第一条命中的生效`);
    patch(
      $("r-list"),
      rows.length
        ? html`<table class="table rules"><thead><tr><th class="num">#</th><th>类型</th><th>内容</th><th>策略</th></tr></thead><tbody>${rows.slice(0, 2000).map(
            (r) => html`<tr><td class="num muted">${r.index}</td><td><span class="tag">${r.type}</span></td><td class="ellipsis wide">${r.payload}</td><td class="ellipsis">${r.proxy}</td></tr>`
          )}</tbody></table>`
        : html`<div class="empty">${ctx.coreRunning() ? "没有规则" : "内核未运行"}</div>`
    );
    patch(
      $("r-providers"),
      providers.length
        ? html`<h2 class="section-title">规则集合<button class="link" data-action="update-all">${icon("refresh", 14)}全部更新</button></h2>
          <div class="card list">${providers.map(
            (p) => html`<div class="list-row"><div class="grow"><b>${p.name}</b><div class="muted small">${p.ruleCount} 条 · ${p.behavior} · ${p.vehicleType} · 更新于 ${ago(new Date(p.updatedAt).getTime())}</div></div>
              ${p.vehicleType === "HTTP" ? html`<button class="btn sm" data-action="update" data-name="${p.name}">${icon("refresh", 14)}更新</button>` : ""}</div>`
          )}</div>`
        : ""
    );
  }

  async function refresh() {
    if (!ctx.coreRunning()) return render();
    try {
      list = (await ctx.api.rules()).rules || [];
      providers = Object.values((await ctx.api.ruleProviders()).providers || {});
    } catch {
      /* 忽略 */
    }
    render();
  }

  const update = async (name) => {
    try {
      await ctx.api.updateRuleProvider(name);
    } catch (err) {
      ctx.toast(name + "：" + err.message, "error");
    }
  };

  delegate(root, "click", {
    update: async (el) => {
      el.disabled = true;
      await update(el.dataset.name);
      refresh();
    },
    "update-all": async () => {
      await Promise.all(providers.filter((p) => p.vehicleType === "HTTP").map((p) => update(p.name)));
      ctx.toast("规则集合已更新", "success");
      refresh();
    },
  });

  root.querySelector("[data-key='q']").addEventListener("input", (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  });

  const off = ctx.on("state", refresh); // 配置重载后规则可能变了
  refresh();
  return { unmount: off };
}
