// 多个订阅同时使用：主订阅提供分组和规则，其余订阅的节点各自成为一个分组（手动选择 + 自动选择），
// 插进主订阅里能选代理的分组（「节点选择」、各个服务分组），不用来回切换订阅。
// 原配置不会被修改；重名的节点、分组和代理集合自动加上订阅名
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const BUILTIN = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"]);

// 规则里引用到的分组名（最后一段是目标；no-resolve 之类的参数跳过）
function ruleTargets(rules) {
  const out = new Set();
  for (const r of Array.isArray(rules) ? rules : []) {
    if (typeof r !== "string") continue;
    const parts = r.split(",").map((s) => s.trim());
    if (parts[0] === "MATCH" || parts[0] === "FINAL") out.add(parts[1]);
    else {
      let last = parts.length - 1;
      while (last > 0 && /^(no-resolve|src)$/i.test(parts[last])) last--;
      out.add(parts[last]);
    }
  }
  return out;
}

const fileSafe = (s) => String(s).replace(/[^\w.-]+/g, "_").slice(0, 60) || "p";

function unique(name, taken) {
  let out = name;
  for (let i = 2; taken.has(out); i++) out = `${name} ${i}`;
  taken.add(out);
  return out;
}

// primary：主订阅的配置；extras：[{ id, name, config }]，config 已按各自的转换选项处理
// 返回 { config, groups: [新增分组名], providers: [{ id, key, as }]（代理集合改名对照，sing-box 转换时找缓存用） }
export function stackProfiles(primary, extras, { testUrl = "https://www.gstatic.com/generate_204" } = {}) {
  if (!extras.length) return { config: primary, groups: [], providers: [] };
  const config = Object.assign({}, primary);
  const proxies = (Array.isArray(primary.proxies) ? primary.proxies : []).slice();
  const own = (Array.isArray(primary["proxy-groups"]) ? primary["proxy-groups"] : []).map((g) => (isMap(g) ? Object.assign({}, g) : g));
  const groupNames = new Set(own.map((g) => isMap(g) && g.name).filter(Boolean));
  const providers = Object.assign({}, isMap(primary["proxy-providers"]) ? primary["proxy-providers"] : {});
  const taken = new Set([...BUILTIN, ...groupNames, ...proxies.map((p) => isMap(p) && p.name).filter(Boolean)]);
  const added = [];
  const renamed = [];
  const extraGroups = [];

  for (const { id, name, config: extra } of extras) {
    const label = String(name || "订阅").trim() || "订阅";
    const names = [];
    for (const p of Array.isArray(extra.proxies) ? extra.proxies : []) {
      if (!isMap(p) || !p.name) continue;
      let n = p.name;
      if (taken.has(n)) n = `${p.name} · ${label}`;
      n = unique(n, taken);
      proxies.push(n === p.name ? p : Object.assign({}, p, { name: n }));
      names.push(n);
    }
    const use = [];
    for (const [key, prov] of Object.entries(isMap(extra["proxy-providers"]) ? extra["proxy-providers"] : {})) {
      if (!isMap(prov)) continue;
      let as = key in providers ? `${key} · ${label}` : key;
      for (let i = 2; as in providers; i++) as = `${key} · ${label} ${i}`;
      providers[as] = Object.assign({}, prov, prov.type === "http" || prov.path ? { path: `./providers/${fileSafe(id)}-${fileSafe(key)}.yaml` } : {});
      use.push(as);
      renamed.push({ id, key, as });
    }
    if (!names.length && !use.length) continue;
    const groupName = unique(label, taken);
    const many = names.length + use.length > 1;
    const autoName = many ? unique(`${label} · 自动`, taken) : "";
    const select = { name: groupName, type: "select", proxies: (many ? [autoName] : []).concat(names) };
    if (use.length) select.use = use;
    extraGroups.push(select);
    if (many) {
      const auto = { name: autoName, type: "url-test", url: testUrl, interval: 300, tolerance: 50, lazy: true };
      if (names.length) auto.proxies = names;
      if (use.length) auto.use = use;
      extraGroups.push(auto);
    }
    added.push(groupName);
  }
  if (!added.length) return { config: primary, groups: [], providers: [] };

  // 插到哪些分组：手动选择类的分组，且引用了别的分组或被规则直接使用；按地区自动收集节点的分组（filter / include-all）不动
  const targets = ruleTargets(primary.rules);
  let inserted = 0;
  for (const g of own) {
    if (!isMap(g) || g.type !== "select" || !Array.isArray(g.proxies)) continue;
    if (g.filter || g["exclude-filter"] || g["include-all"] || g["include-all-proxies"] || g["include-all-providers"]) continue;
    const members = g.proxies;
    const refsGroup = members.some((m) => groupNames.has(m));
    if (!refsGroup && !targets.has(g.name)) continue;
    if (!members.some((m) => !BUILTIN.has(m)) && !(g.use && g.use.length)) continue;
    // 放在开头的分组 / 内置策略之后、具体节点之前
    let at = 0;
    while (at < members.length && (groupNames.has(members[at]) || BUILTIN.has(members[at]))) at++;
    g.proxies = members.slice(0, at).concat(added, members.slice(at));
    inserted++;
  }
  // 主订阅里没有合适的分组（比如只有直连规则）：加一个总的选择分组，兜底规则指向它
  if (!inserted) {
    const all = unique("多订阅", taken);
    extraGroups.unshift({ name: all, type: "select", proxies: added.concat("DIRECT") });
    const rules = (Array.isArray(primary.rules) ? primary.rules : []).filter((r) => !/^MATCH,/.test(String(r)));
    config.rules = rules.concat(`MATCH,${all}`);
    added.unshift(all);
  }

  config.proxies = proxies;
  config["proxy-groups"] = own.concat(extraGroups);
  if (Object.keys(providers).length) config["proxy-providers"] = providers;
  return { config, groups: added, providers: renamed };
}

// 代理集合缓存按改名后的名字合并（sing-box 需要集合的内容）
export function stackProviderCache(primaryCache, renamed, cacheOf) {
  const proxy = Object.assign({}, (primaryCache && primaryCache.proxy) || {});
  for (const { id, key, as } of renamed) {
    const text = ((cacheOf(id) || {}).proxy || {})[key];
    if (text) proxy[as] = text;
  }
  return Object.assign({}, primaryCache || {}, { proxy });
}
