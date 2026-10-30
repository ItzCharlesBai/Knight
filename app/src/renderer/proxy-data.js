// /proxies 的整理：分组按订阅里的顺序排列，取延迟，沿分组展开当前出口
const GROUP_TYPES = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay"]);

export async function loadProxies(api) {
  const { proxies } = await api.proxies();
  const global = proxies.GLOBAL;
  // GLOBAL.all 的顺序就是配置文件里的顺序
  const order = global && Array.isArray(global.all) ? global.all : Object.keys(proxies);
  const groups = order.map((n) => proxies[n]).filter((p) => p && GROUP_TYPES.has(p.type) && !p.hidden);
  return { all: proxies, groups, global };
}

export const lastDelay = (proxy) => {
  const h = proxy && proxy.history;
  return h && h.length ? h[h.length - 1].delay : undefined;
};

// 节点在某个测速地址下的延迟（mihomo 对每个分组的测速地址分开记录）
export function delayOf(all, name, testUrl) {
  const p = all[name];
  if (!p) return undefined;
  if (GROUP_TYPES.has(p.type) && p.now) return delayOf(all, p.now, testUrl);
  if (testUrl && p.extra && p.extra[testUrl]) {
    const h = p.extra[testUrl].history;
    if (h && h.length) return h[h.length - 1].delay;
  }
  return lastDelay(p);
}

// 当前实际出口：分组 → 选中项 → … → 节点
export function chainOf(all, name) {
  const chain = [];
  const seen = new Set();
  while (name && all[name] && !seen.has(name)) {
    seen.add(name);
    chain.push(name);
    const p = all[name];
    name = GROUP_TYPES.has(p.type) ? p.now : null;
  }
  return chain;
}

export const isGroup = (p) => !!p && GROUP_TYPES.has(p.type);

// 首页展示的主分组：第一个可手动选择的分组（通常就是「节点选择」）
export function mainGroup(data, mode) {
  if (mode === "global") return data.global;
  return data.groups.find((g) => g.type === "Selector") || data.groups[0] || null;
}
