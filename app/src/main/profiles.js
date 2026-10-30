// 订阅管理：远程订阅（URL，定时更新）和本地配置，原文保存在 userData/profiles/<id>.yaml
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filenameFromDisposition, parseSubscription, parseUserinfo } from "./convert.js";

export const USER_AGENT = "clash.meta/knight";

export class Profiles {
  // fetch(url, { headers, viaProxy }) → Response，由主进程提供（可以走自身代理）
  constructor(dir, fetchFn) {
    this.dir = dir;
    this.fetch = fetchFn;
    this.indexFile = join(dir, "profiles.json");
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

  // 解析后的配置（分享链接已转换成节点）
  load(id) {
    return parseSubscription(this.read(id)).config;
  }

  read(id) {
    return readFileSync(this.file(id), "utf8");
  }

  // 手动编辑原文：先校验能解析，再保存
  write(id, text) {
    if (!this.get(id)) throw new Error("订阅不存在");
    parseSubscription(text);
    this.writeFile(id, text);
    this.touch(id, { updatedAt: Date.now() });
  }

  async add({ url, name = "", interval = 0 }) {
    url = String(url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("请输入 http:// 或 https:// 开头的订阅链接");
    const id = newId();
    const item = { id, type: "remote", name: name.trim(), url, interval: Number(interval) || 0, createdAt: Date.now() };
    await this.download(item);
    this.items.push(item);
    this.saveIndex();
    return item;
  }

  import({ name, text }) {
    parseSubscription(text);
    const id = newId();
    const item = { id, type: "local", name: String(name || "本地配置").replace(/\.(ya?ml|txt)$/i, ""), createdAt: Date.now(), updatedAt: Date.now() };
    this.writeFile(id, text);
    this.items.push(item);
    this.saveIndex();
    return item;
  }

  async update(id, { viaProxy = false } = {}) {
    const item = this.get(id);
    if (!item) throw new Error("订阅不存在");
    if (item.type !== "remote") return item;
    await this.download(item, viaProxy);
    this.saveIndex();
    return item;
  }

  async download(item, viaProxy = false) {
    const res = await this.fetch(item.url, { headers: { "User-Agent": item.userAgent || USER_AGENT }, viaProxy });
    if (!res.ok) throw new Error(`订阅下载失败：HTTP ${res.status}`);
    const text = await res.text();
    const { converted } = parseSubscription(text); // 不能用的内容不覆盖已有的
    this.writeFile(item.id, text);
    const header = (k) => res.headers.get(k);
    item.updatedAt = Date.now();
    item.converted = converted;
    item.userinfo = parseUserinfo(header("subscription-userinfo"));
    const hours = Number(header("profile-update-interval"));
    if (!item.interval && hours > 0) item.interval = Math.round(hours * 60);
    if (!item.interval) item.interval = 24 * 60;
    if (header("profile-web-page-url")) item.home = header("profile-web-page-url");
    if (!item.name) item.name = filenameFromDisposition(header("content-disposition")) || hostName(item.url);
    item.error = "";
  }

  edit(id, patch) {
    const item = this.get(id);
    if (!item) throw new Error("订阅不存在");
    if (typeof patch.name === "string" && patch.name.trim()) item.name = patch.name.trim();
    if (item.type === "remote" && typeof patch.url === "string" && /^https?:\/\//i.test(patch.url.trim())) item.url = patch.url.trim();
    if (patch.interval !== undefined && Number(patch.interval) >= 0) item.interval = Math.round(Number(patch.interval));
    if (typeof patch.userAgent === "string") item.userAgent = patch.userAgent.trim();
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
    this.saveIndex();
  }

  // 到了更新时间的远程订阅（interval 为 0 表示不自动更新）
  due(now = Date.now()) {
    return this.items.filter((p) => p.type === "remote" && p.interval > 0 && now - (p.updatedAt || 0) >= p.interval * 60000);
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
  }

  saveIndex() {
    const tmp = this.indexFile + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    renameSync(tmp, this.indexFile);
  }

  exists(id) {
    return !!this.get(id) && existsSync(this.file(id));
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
