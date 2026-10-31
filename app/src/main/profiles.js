// 订阅管理：远程订阅（URL，定时更新）、本地配置、组合订阅（多个来源合成一份），原文保存在 userData/profiles/<id>.yaml
// 每个订阅可以带转换选项（筛选、重命名、国旗、去重、排序、分组模板），加载时应用，原文不变
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { filenameFromDisposition, parseSubscription, parseUserinfo } from "./convert.js";
import { applyConvert, DEFAULT_CONVERT, processNodes } from "./nodes.js";

export const USER_AGENT = "clash.meta/knight";
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const dump = (v) => yaml.dump(v, { lineWidth: -1, noRefs: true });

export class Profiles {
  // fetch(url, { headers, viaProxy, signal }) → Response，由主进程提供（可以走自身代理）
  constructor(dir, fetchFn) {
    this.dir = dir;
    this.fetch = fetchFn;
    this.indexFile = join(dir, "profiles.json");
    this.cache = new Map(); // id → { key, parsed, loaded }
    mkdirSync(dir, { recursive: true });
    try {
      this.items = JSON.parse(readFileSync(this.indexFile, "utf8"));
      if (!Array.isArray(this.items)) this.items = [];
    } catch {
      this.items = [];
    }
  }

  list() {
    return this.items;
  }

  get(id) {
    return this.items.find((p) => p.id === id) || null;
  }

  file(id) {
    return join(this.dir, id + ".yaml");
  }

  providersFile(id) {
    return join(this.dir, id + ".providers.json");
  }

  exists(id) {
    return !!this.get(id) && existsSync(this.file(id));
  }

  read(id) {
    return readFileSync(this.file(id), "utf8");
  }

  // 解析结果按文件修改时间和转换选项缓存：状态推送、生成配置时不必反复解析大文件
  entry(id) {
    const item = this.get(id);
    const mtime = statSync(this.file(id)).mtimeMs;
    const key = mtime + ":" + JSON.stringify((item && item.convert) || null);
    let e = this.cache.get(id);
    if (!e || e.mtime !== mtime) e = { mtime, parsed: parseSubscription(this.read(id)) };
    if (e.key !== key) {
      const providerNames = Object.values(this.providerCache(id).proxy || {}).flatMap((text) => namesIn(text));
      e.loaded = item && item.convert ? applyConvert(e.parsed.config, item.convert, providerNames) : e.parsed.config;
      e.key = key;
    }
    this.cache.set(id, e);
    return e;
  }

  // 应用了转换选项的配置（分享链接已转换成节点）。返回的是缓存对象，调用方不要修改
  load(id) {
    return this.entry(id).loaded;
  }

  // 订阅原样的解析结果（不应用转换选项）
  parsed(id) {
    return this.entry(id).parsed.config;
  }

  // 手动编辑原文：先校验能解析，再保存
  write(id, text) {
    const item = this.get(id);
    if (!item) throw new Error("订阅不存在");
    const { config } = parseSubscription(text);
    this.writeFile(id, text);
    this.touch(id, { updatedAt: Date.now(), nodes: countNodes(config) });
  }

  async add({ url, name = "", interval = 0, convert = null }) {
    url = String(url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("请输入 http:// 或 https:// 开头的订阅链接");
    const item = { id: newId(), type: "remote", name: name.trim(), url, interval: Number(interval) || 0, createdAt: Date.now() };
    if (convert) item.convert = checkConvert(convert);
    await this.download(item);
    this.items.push(item);
    this.saveIndex();
    return item;
  }

  // 组合订阅：sources = [{ type: "url", url } | { type: "profile", id } | { type: "text", text }]
  async addCombo({ name = "", sources = [], interval = 0, convert = null }) {
    if (!sources.length) throw new Error("至少要有一个来源");
    const item = {
      id: newId(),
      type: "combo",
      name: String(name).trim() || "组合订阅",
      sources: sources.map(cleanSource),
      interval: Number(interval) || 24 * 60,
      createdAt: Date.now(),
      convert: checkConvert(convert || { template: "region" }),
    };
    await this.buildCombo(item);
    this.items.push(item);
    this.saveIndex();
    return item;
  }

  import({ name, text, convert = null }) {
    const { config } = parseSubscription(text);
    const item = { id: newId(), type: "local", name: String(name || "本地配置").replace(/\.(ya?ml|txt|json|conf)$/i, ""), createdAt: Date.now(), updatedAt: Date.now(), nodes: countNodes(config) };
    if (convert) item.convert = checkConvert(convert);
    this.writeFile(item.id, text);
    this.items.push(item);
    this.saveIndex();
    return item;
  }

  async update(id, { viaProxy = false, providers = false } = {}) {
    const item = this.get(id);
    if (!item) throw new Error("订阅不存在");
    if (item.type === "remote") await this.download(item, viaProxy);
    else if (item.type === "combo") await this.buildCombo(item, viaProxy);
    this.saveIndex();
    if (providers) await this.cacheProviders(id, viaProxy).catch(() => {});
    return item;
  }

  async fetchText(url, userAgent, viaProxy) {
    const res = await this.fetch(url, { headers: { "User-Agent": userAgent || USER_AGENT }, viaProxy, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    return { res, text: await res.text() };
  }

  async download(item, viaProxy = false) {
    const { res, text } = await this.fetchText(item.url, item.userAgent, viaProxy);
    const { converted, config } = parseSubscription(text); // 不能用的内容不覆盖已有的
    this.writeFile(item.id, text);
    const header = (k) => res.headers.get(k);
    item.updatedAt = Date.now();
    item.converted = converted;
    item.nodes = countNodes(config);
    item.userinfo = parseUserinfo(header("subscription-userinfo"));
    const hours = Number(header("profile-update-interval"));
    if (!item.interval && hours > 0) item.interval = Math.round(hours * 60);
    if (!item.interval) item.interval = 24 * 60;
    if (header("profile-web-page-url")) item.home = header("profile-web-page-url");
    if (!item.name) item.name = filenameFromDisposition(header("content-disposition")) || hostName(item.url);
    item.error = "";
  }

  // 依次取每个来源，节点合到一起；重名的节点后面加上来源名
  async buildCombo(item, viaProxy = false) {
    const parts = [];
    let userinfo = null;
    for (const [i, src] of item.sources.entries()) {
      if (src.type === "url") {
        const { res, text } = await this.fetchText(src.url, item.userAgent, viaProxy);
        parts.push({ label: hostName(src.url), config: parseSubscription(text).config });
        userinfo = userinfo || parseUserinfo(res.headers.get("subscription-userinfo"));
      } else if (src.type === "profile") {
        const p = this.get(src.id);
        if (!p || !this.exists(src.id)) throw new Error(`来源 ${i + 1} 引用的订阅已被删除`);
        parts.push({ label: p.name, config: this.parsed(src.id) });
      } else {
        parts.push({ label: "粘贴", config: parseSubscription(src.text).config });
      }
    }
    const merged = mergeParts(parts, item.id);
    this.writeFile(item.id, dump(merged));
    item.updatedAt = Date.now();
    item.nodes = countNodes(merged);
    item.userinfo = userinfo;
    item.error = "";
  }

  // 代理集合、规则集合的内容（sing-box 不认 Clash 的 providers，转换时需要原文）
  providerCache(id) {
    try {
      return JSON.parse(readFileSync(this.providersFile(id), "utf8"));
    } catch {
      return {};
    }
  }

  async cacheProviders(id, viaProxy = false) {
    const config = this.parsed(id);
    const item = this.get(id);
    const jobs = [];
    for (const [kind, key] of [["proxy", "proxy-providers"], ["rule", "rule-providers"]]) {
      for (const [name, p] of Object.entries(config[key] || {})) {
        if (isMap(p) && p.type === "http" && /^https?:\/\//.test(p.url || "")) jobs.push({ kind, name, url: p.url });
      }
    }
    if (!jobs.length) return this.providerCache(id);
    const out = { proxy: {}, rule: {}, at: Date.now() };
    const queue = jobs.slice(0, 40);
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (queue.length) {
          const job = queue.shift();
          try {
            const { text } = await this.fetchText(job.url, job.kind === "proxy" ? item && item.userAgent : USER_AGENT, viaProxy);
            // 代理集合统一存成 proxies: 列表（订阅可能是 Base64 链接）
            out[job.kind][job.name] = job.kind === "proxy" ? dump({ proxies: parseSubscription(text).config.proxies || [] }) : text;
          } catch {
            /* 单个集合下载失败不影响其他的 */
          }
        }
      })
    );
    writeFileSync(this.providersFile(id), JSON.stringify(out));
    this.cache.delete(id);
    return out;
  }

  edit(id, patch) {
    const item = this.get(id);
    if (!item) throw new Error("订阅不存在");
    if (typeof patch.name === "string" && patch.name.trim()) item.name = patch.name.trim();
    if (item.type === "remote" && typeof patch.url === "string" && /^https?:\/\//i.test(patch.url.trim())) item.url = patch.url.trim();
    if (patch.interval !== undefined && Number(patch.interval) >= 0) item.interval = Math.round(Number(patch.interval));
    if (typeof patch.userAgent === "string") item.userAgent = patch.userAgent.trim();
    if (patch.convert !== undefined) item.convert = patch.convert ? checkConvert(patch.convert) : undefined;
    if (item.type === "combo" && Array.isArray(patch.sources) && patch.sources.length) item.sources = patch.sources.map(cleanSource);
    this.cache.delete(id);
    this.saveIndex();
    return item;
  }

  touch(id, patch) {
    const item = this.get(id);
    if (item) Object.assign(item, patch);
    this.saveIndex();
  }

  remove(id) {
    this.items = this.items.filter((p) => p.id !== id);
    rmSync(this.file(id), { force: true });
    rmSync(this.providersFile(id), { force: true });
    this.cache.delete(id);
    this.saveIndex();
  }

  // 到了更新时间的远程 / 组合订阅（interval 为 0 表示不自动更新）
  due(now = Date.now()) {
    return this.items.filter((p) => (p.type === "remote" || p.type === "combo") && p.interval > 0 && now - (p.updatedAt || 0) >= p.interval * 60000);
  }

  // 订阅里有哪些分组：给设置页「境外 DNS 出口」选择用
  groups(id) {
    try {
      return (this.load(id)["proxy-groups"] || []).map((g) => g && g.name).filter((n) => typeof n === "string");
    } catch {
      return [];
    }
  }

  writeFile(id, text) {
    const tmp = this.file(id) + ".tmp";
    writeFileSync(tmp, text);
    renameSync(tmp, this.file(id));
    this.cache.delete(id);
  }

  saveIndex() {
    const tmp = this.indexFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    renameSync(tmp, this.indexFile);
  }
}

// 多个来源合成一份：节点重名时加上来源名；代理集合改名并各用各的缓存路径。只有一个来源时原样保留它的分组和规则
export function mergeParts(parts, id = "merged") {
  if (parts.length === 1) return Object.assign({}, parts[0].config);
  const merged = { proxies: [], "proxy-providers": {} };
  const names = new Set();
  parts.forEach(({ label, config }, i) => {
    for (const p of config.proxies || []) {
      if (!isMap(p) || !p.name) continue;
      let name = names.has(p.name) ? `${p.name} · ${label}` : p.name;
      for (let n = 2; names.has(name); n++) name = `${p.name} · ${label} #${n}`;
      names.add(name);
      merged.proxies.push(Object.assign({}, p, { name }));
    }
    for (const [key, provider] of Object.entries(config["proxy-providers"] || {})) {
      const k = key in merged["proxy-providers"] ? `${key}-${i + 1}` : key;
      merged["proxy-providers"][k] = Object.assign({}, provider, { path: `./providers/${id}-${k}.yaml` });
    }
  });
  if (!Object.keys(merged["proxy-providers"]).length) delete merged["proxy-providers"];
  if (!countNodes(merged) && !merged["proxy-providers"]) throw new Error("所有来源里都没有节点");
  return merged;
}

// 只保留认识的选项；正则写错时直接报错
export function checkConvert(convert) {
  const out = {};
  for (const key of Object.keys(DEFAULT_CONVERT)) {
    const v = convert && convert[key];
    out[key] = typeof v === typeof DEFAULT_CONVERT[key] ? v : DEFAULT_CONVERT[key];
  }
  processNodes([], out);
  return out;
}

function cleanSource(src) {
  if (src && src.type === "url" && /^https?:\/\//i.test(String(src.url).trim())) return { type: "url", url: String(src.url).trim() };
  if (src && src.type === "profile" && src.id) return { type: "profile", id: String(src.id) };
  if (src && src.type === "text" && String(src.text || "").trim()) {
    parseSubscription(src.text);
    return { type: "text", text: String(src.text) };
  }
  throw new Error("来源格式不对");
}

const countNodes = (config) => (Array.isArray(config.proxies) ? config.proxies.length : 0);

function namesIn(text) {
  try {
    const doc = yaml.load(text);
    return isMap(doc) && Array.isArray(doc.proxies) ? doc.proxies.map((p) => p && p.name).filter(Boolean) : [];
  } catch {
    return [];
  }
}

const newId = () => Date.now().toString(36) + randomBytes(3).toString("hex");

function hostName(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "订阅";
  }
}
