// Knight 主进程：窗口、托盘、设置、订阅、内核（多内核 + 搭配使用）与系统代理
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSubscription } from "./convert.js";
import { Core } from "./core.js";
import { binName, CORE_IDS, CORES, downloadCore, downloadRuleSet, latestVersion } from "./core-download.js";
import { convert, TARGETS } from "./converter.js";
import { coreKind, generate } from "./enhance.js";
import { TEMPLATES } from "./nodes.js";
import { Profiles, USER_AGENT } from "./profiles.js";
import { SINGBOX_MODES } from "./singbox.js";
import { Store } from "./store.js";
import { getSystemProxy, setSystemProxy } from "./sysproxy.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..");
const isDev = !app.isPackaged;
const OS = { win32: "win", darwin: "mac", linux: "linux" }[process.platform];

// 随应用发布的资源：打包后在 resources/ 下，开发时用仓库里的文件
const resourcesDir = isDev ? join(appRoot, "resources") : process.resourcesPath;
const bundledCoreDir = isDev ? join(appRoot, "resources", "core", `${OS}-${process.arch}`) : join(process.resourcesPath, "core");
const bundledGeoDir = join(resourcesDir, "geo");
const extensionsDir = isDev ? join(appRoot, "..", "clash-verge-rev") : join(process.resourcesPath, "extensions");

if (process.env.KNIGHT_USER_DATA) app.setPath("userData", process.env.KNIGHT_USER_DATA);
const userDir = app.getPath("userData");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  mkdirSync(userDir, { recursive: true });
  // 旧版本把 mihomo 放在 userData/core，搬到 userData/cores/mihomo
  if (existsSync(join(userDir, "core")) && !existsSync(join(userDir, "cores", "mihomo"))) {
    mkdirSync(join(userDir, "cores"), { recursive: true });
    renameSync(join(userDir, "core"), join(userDir, "cores", "mihomo"));
  }
  const store = new Store(join(userDir, "settings.json"));
  const settings = () => store.get();
  if (!CORES[settings().core]) store.set({ core: "mihomo" });
  const profiles = new Profiles(join(userDir, "profiles"), (url, opts) => httpFetch(url, opts));

  // ---------------- 内核实例 ----------------
  // 主内核：mihomo 系共用 userData/mihomo（GEO 数据、缓存通用），sing-box 用 userData/sing-box
  // 搭配内核：另一种内核，单独的工作目录，只开本地 SOCKS 入口
  const coreDir = (id) => join(userDir, "cores", id);
  const binPath = (id) => join(coreDir(id), binName(id));
  const makeCore = (id, workDir) =>
    new Core({ id, coreDir: coreDir(id), workDir, bundledDir: id === "mihomo" ? bundledCoreDir : "", geoDir: coreKind(id) === "clash" ? bundledGeoDir : "" });
  const mainWorkDir = (id) => join(userDir, coreKind(id) === "singbox" ? "sing-box" : "mihomo");
  const ruleSetDir = join(userDir, "sing-box", "rule-sets");
  let core = null;
  let side = null;
  let sideText = "";

  function useCore(id) {
    if (core) core.removeAllListeners("status");
    core = makeCore(id, mainWorkDir(id));
    core.on("status", onCoreStatus);
    return core;
  }
  // 可以搭配的另一种内核（已下载的）：主内核是 mihomo 系 → sing-box；主内核是 sing-box → mihomo 系里已下载的那个
  function sidecarCandidate() {
    const want = core.kind === "singbox" ? ["mihomo", "mihomo-alpha", "mihomo-smart"] : ["sing-box"];
    const id = want.find((x) => existsSync(binPath(x)));
    return id ? { id, kind: coreKind(id), bin: binPath(id) } : null;
  }
  const installedVersion = (id) => {
    try {
      return readFileSync(join(coreDir(id), "version.txt"), "utf8").trim();
    } catch {
      return "";
    }
  };

  let win = null;
  let tray = null;
  let quitting = false;
  let lastApply = { at: 0, error: "", logs: [] };
  let tunPermission = false;
  let sysproxyOn = false; // 我们实际设置过的系统代理状态，退出时据此恢复
  const busy = new Set(); // 正在更新的订阅 id
  const downloading = new Set(); // 正在下载的内核 id

  // ---------------- 网络请求（订阅、内核、规则集下载）----------------
  // 直连和走自身代理各用一个会话，互不影响；都不读系统代理，避免系统代理指向自己但内核没开时卡住
  const sessions = {};
  async function fetchSession(viaProxy) {
    const key = viaProxy ? "proxy" : "direct";
    if (!sessions[key]) {
      const ses = session.fromPartition("knight-" + key);
      await ses.setProxy(viaProxy ? { proxyRules: `http://127.0.0.1:${settings().mixedPort}`, proxyBypassRules: "<local>" } : { mode: "direct" });
      sessions[key] = ses;
    }
    return sessions[key];
  }
  async function httpFetch(url, { headers = {}, viaProxy = settings().updateViaProxy, signal } = {}) {
    const go = async (proxy) => (await fetchSession(proxy)).fetch(url, { headers, redirect: "follow", cache: "no-store", signal });
    if (viaProxy && core.status !== "running") viaProxy = false;
    try {
      return await go(viaProxy);
    } catch (err) {
      // 直连失败且内核在运行时，自动改走代理再试一次
      if (!viaProxy && core.status === "running") return go(true);
      throw err;
    }
  }

  // ---------------- 内核控制接口 ----------------
  const controller = () => ({ url: `http://127.0.0.1:${settings().controllerPort}`, secret: settings().secret });
  async function api(method, path, body) {
    const res = await fetch(controller().url + path, {
      method,
      headers: { Authorization: "Bearer " + settings().secret, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error((await res.text().catch(() => "")) || "HTTP " + res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ---------------- 生成并应用配置 ----------------
  // 扩展脚本只在启动时读一次（打包后不会变；开发时改了重启应用即可）
  const extensions = {};
  const readExtension = (name) => {
    if (!(name in extensions)) {
      try {
        extensions[name] = readFileSync(join(extensionsDir, name), "utf8");
      } catch {
        extensions[name] = "";
      }
    }
    return extensions[name];
  };
  const ruleSetFile = (tag) => join(ruleSetDir, tag + ".srs");

  function buildConfig() {
    const s = settings();
    const current = profiles.exists(s.currentProfile) ? profiles.get(s.currentProfile) : null;
    // 还没有订阅时也让内核跑起来（全部直连），方便先看日志、测试端口
    const profile = current ? profiles.load(current.id) : { proxies: [], "proxy-groups": [], rules: ["MATCH,DIRECT"] };
    return generate({
      profile,
      settings: s,
      scriptSource: readExtension("script.js"),
      mergeSource: readExtension("merge.yaml"),
      profileName: current ? current.name : "",
      core: { id: core.id, kind: core.kind },
      sidecar: s.combine ? sidecarCandidate() : null,
      singbox: {
        providers: current ? profiles.providerCache(current.id) : {},
        ruleSetPath: (tag) => (existsSync(ruleSetFile(tag)) ? ruleSetFile(tag) : ""),
        version: installedVersion(core.id),
      },
    });
  }

  // sing-box 用到的规则集由 Knight 下载到本地（失败时自动改走代理），内核启动时不必联网
  async function ensureRuleSets(tags) {
    mkdirSync(ruleSetDir, { recursive: true });
    const week = 7 * 86400000;
    const todo = tags.filter((t) => !existsSync(ruleSetFile(t)) || Date.now() - statSync(ruleSetFile(t)).mtimeMs > week);
    let fetched = 0;
    await Promise.all(
      todo.map(async (tag) => {
        try {
          const data = await downloadRuleSet(tag, { fetch: (url) => httpFetch(url, { signal: AbortSignal.timeout(30000) }), mirror: settings().githubMirror });
          writeFileSync(ruleSetFile(tag), data);
          fetched++;
        } catch {
          /* 下载失败：已有的旧文件继续用，没有的话相关规则会被跳过并在日志里提示 */
        }
      })
    );
    return fetched;
  }

  let applying = Promise.resolve();
  // reload=false 只写文件（模式、日志级别通过接口即时修改，不必重载）
  function applyConfig({ reload = true } = {}) {
    applying = applying.catch(() => {}).then(() => doApply(reload));
    return applying;
  }

  async function doApply(reload) {
    let result;
    const fail = (error, logs = []) => {
      lastApply = { at: Date.now(), error, logs };
      pushState();
      throw new Error(error);
    };
    try {
      result = buildConfig();
      if (result.kind === "singbox") {
        // 第一次用 sing-box：先把代理集合、规则集合的内容缓存下来，再下载规则集，然后重新生成
        const s = settings();
        const config = profiles.exists(s.currentProfile) ? profiles.parsed(s.currentProfile) : {};
        const hasProviders = Object.values(Object.assign({}, config["proxy-providers"], config["rule-providers"])).some((p) => p && p.type === "http");
        let again = false;
        if (hasProviders && !profiles.providerCache(s.currentProfile).at) {
          await profiles.cacheProviders(s.currentProfile).catch(() => {});
          again = true;
        }
        if ((await ensureRuleSets(result.ruleSets)) > 0) again = true;
        if (again) result = buildConfig();
      }
    } catch (err) {
      fail("生成配置失败：" + err.message);
    }
    const next = core.configFile.replace(/\.(yaml|json)$/, ".next.$1");
    writeFileSync(next, result.text);
    if (!reload) {
      renameSync(next, core.configFile);
      return;
    }
    const error = core.installed() ? await core.test(next) : "";
    if (error) {
      rmSync(next, { force: true });
      fail("配置校验失败：" + error, result.logs);
    }
    renameSync(next, core.configFile);
    lastApply = { at: Date.now(), error: "", logs: result.logs };
    // mihomo 系支持热重载；sing-box 需要重启内核
    if (core.kind === "clash" && core.status === "running" && core.proc) {
      await api("PUT", "/configs?force=true", { path: core.configFile });
    } else {
      await core.restart();
      await core.waitReady(api);
    }
    await applySidecar(result.sidecar).catch((err) => {
      lastApply.logs = lastApply.logs.concat({ source: "Knight", level: "error", message: "搭配内核启动失败：" + err.message });
    });
    pushState();
  }

  async function applySidecar(plan) {
    const candidate = plan ? sidecarCandidate() : null;
    if (!plan || !candidate) {
      sideText = "";
      if (side) await side.stop();
      side = null;
      return;
    }
    if (!side || side.id !== candidate.id) {
      if (side) await side.stop();
      side = makeCore(candidate.id, join(userDir, "sidecar-" + candidate.kind));
      side.on("status", () => pushState());
    }
    if (plan.text === sideText && side.proc) return;
    const next = side.configFile.replace(/\.(yaml|json)$/, ".next.$1");
    writeFileSync(next, plan.text);
    const error = await side.test(next);
    if (error) {
      rmSync(next, { force: true });
      throw new Error(error);
    }
    renameSync(next, side.configFile);
    sideText = plan.text;
    await side.restart();
    // 搭配内核没有控制接口：进程活着就算运行中
    setTimeout(() => side && side.proc && side.setStatus("running"), 800);
  }

  // ---------------- 系统代理 ----------------
  // force：端口或例外列表变了，已开启时按新参数重新设置
  async function syncSystemProxy(force = false) {
    const want = settings().systemProxy && core.status === "running";
    if (want === sysproxyOn && !(force && want)) return;
    await setSystemProxy(want, { port: settings().mixedPort, bypass: settings().proxyBypass });
    sysproxyOn = want;
  }

  // ---------------- 开机启动 ----------------
  function syncAutoLaunch() {
    const enable = settings().autoLaunch;
    if (isDev) return;
    if (process.platform === "linux") {
      const dir = join(homedir(), ".config", "autostart");
      const file = join(dir, "knight.desktop");
      if (!enable) return rmSync(file, { force: true });
      mkdirSync(dir, { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Knight\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      app.setLoginItemSettings({ openAtLogin: enable, args: ["--hidden"] });
    }
  }

  // ---------------- 状态推送 ----------------
  const CAPS = {
    clash: { reload: true, geo: true, providers: true, dnsFlush: true, fakeipFlush: true },
    singbox: { reload: false, geo: false, providers: false, dnsFlush: false, fakeipFlush: true },
  };
  function state() {
    const s = settings();
    return {
      settings: s,
      profiles: profiles.list().map((p) => Object.assign({}, p, { updating: busy.has(p.id), sources: p.type === "combo" ? p.sources.map((x) => (x.type === "text" ? { type: "text" } : x)) : undefined })),
      groups: s.currentProfile ? profiles.groups(s.currentProfile) : [],
      core: { id: core.id, kind: core.kind, label: core.spec.label, status: core.status, error: core.error, version: core.version(), installed: core.installed(), caps: CAPS[core.kind] },
      cores: CORE_IDS.map((id) => ({ id, label: CORES[id].label, desc: CORES[id].desc, kind: CORES[id].kind, version: installedVersion(id), installed: existsSync(binPath(id)), downloading: downloading.has(id) })),
      sidecar: side ? { id: side.id, label: side.spec.label, status: side.status, error: side.error } : null,
      controller: controller(),
      apply: lastApply,
      tunPermission,
      sysproxyOn,
      platform: process.platform,
      version: app.getVersion(),
      paths: { userDir, workDir: core.workDir },
      extensions: { script: !!readExtension("script.js"), merge: !!readExtension("merge.yaml") },
      convert: { templates: TEMPLATES, targets: TARGETS.map(([id, label]) => [id, label]) },
    };
  }

  let pushTimer = null;
  function pushState() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (win && !win.isDestroyed()) win.webContents.send("state", state());
      updateTray();
    }, 30);
  }
  async function onCoreStatus() {
    pushState();
    await syncSystemProxy().catch(() => {});
    pushState();
  }

  const toast = (message, type = "info") => win && !win.isDestroyed() && win.webContents.send("toast", { message, type });

  // ---------------- 设置变更 ----------------
  const RELOAD_KEYS = ["core", "combine", "sidecarPort", "smartGroups", "mixedPort", "controllerPort", "allowLan", "ipv6", "unifiedDelay", "findProcess", "tun", "leakGuard", "useMerge", "customRules", "customScript", "currentProfile", "delayUrl"];

  async function setSettings(patch) {
    const before = settings();
    if (patch.core && patch.core !== before.core) {
      if (!CORES[patch.core]) throw new Error("未知内核");
      if (!existsSync(binPath(patch.core))) throw new Error(`还没有下载 ${CORES[patch.core].label}，请先在内核列表里下载`);
    }
    if (patch.tun && patch.tun.enable && !before.tun.enable) {
      tunPermission = await core.hasTunPermission();
      if (!tunPermission) {
        pushState();
        throw new Error("NEED_TUN_PERMISSION");
      }
    }
    const after = store.set(patch);
    if (before.theme !== after.theme) nativeTheme.themeSource = after.theme;
    if (before.autoLaunch !== after.autoLaunch) syncAutoLaunch();
    if (before.mixedPort !== after.mixedPort) delete sessions.proxy;

    const changed = (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]);
    const switchCore = async (id) => {
      await core.stop();
      useCore(id);
      tunPermission = await core.hasTunPermission();
      if (settings().tun.enable && !tunPermission) store.set({ tun: { enable: false } });
    };
    try {
      if (changed("core")) await switchCore(after.core);
      // sing-box 改日志级别需要重启，归到重载
      if (RELOAD_KEYS.some(changed) || (core.kind === "singbox" && changed("logLevel"))) {
        await applyConfig();
      } else if (changed("mode") || changed("logLevel")) {
        await applyConfig({ reload: false });
        if (core.status === "running") {
          const mode = core.kind === "singbox" ? SINGBOX_MODES[after.mode] : after.mode;
          await api("PATCH", "/configs", { mode, "log-level": after.logLevel });
          // 切换模式后断开旧连接，让新模式立即生效
          if (changed("mode")) await api("DELETE", "/connections").catch(() => {});
        }
      }
    } catch (err) {
      // 新配置用不了：恢复原设置；换内核失败时换回原来的内核
      if (RELOAD_KEYS.some(changed)) store.set(pick(before, RELOAD_KEYS));
      if (changed("core")) {
        await switchCore(before.core).catch(() => {});
        await applyConfig().catch(() => {});
      }
      pushState();
      throw err;
    }
    if (changed("systemProxy") || changed("proxyBypass") || changed("mixedPort")) {
      try {
        await syncSystemProxy(true);
      } catch (err) {
        if (changed("systemProxy")) store.set({ systemProxy: before.systemProxy });
        pushState();
        throw new Error("设置系统代理失败：" + err.message);
      }
    }
    pushState();
    return after;
  }

  // ---------------- 订阅 ----------------
  async function updateProfile(id, opts = {}) {
    if (busy.has(id)) return;
    busy.add(id);
    pushState();
    try {
      await profiles.update(id, Object.assign({ providers: core.kind === "singbox" && id === settings().currentProfile }, opts));
      if (id === settings().currentProfile) await applyConfig();
    } catch (err) {
      profiles.touch(id, { error: err.message, checkedAt: Date.now() });
      throw err;
    } finally {
      busy.delete(id);
      pushState();
    }
  }

  async function adopt(item) {
    if (!profiles.exists(settings().currentProfile)) await setSettings({ currentProfile: item.id });
    pushState();
    return item;
  }

  // 定时更新：每分钟检查一次到期的订阅
  setInterval(() => {
    for (const p of profiles.due()) {
      if (p.checkedAt && Date.now() - p.checkedAt < 10 * 60000) continue; // 失败后 10 分钟内不重试
      updateProfile(p.id).catch(() => {});
    }
  }, 60000);

  // clash://install-config?url=...&name=...（机场「一键导入」）
  async function handleDeepLink(link) {
    try {
      const url = new URL(link);
      if (!/^(clash|mihomo|knight):$/.test(url.protocol)) return;
      const sub = url.searchParams.get("url");
      if (!sub) return;
      showWindow("profiles");
      const item = await adopt(await profiles.add({ url: sub, name: url.searchParams.get("name") || "" }));
      toast(`已导入订阅「${item.name}」`, "success");
    } catch (err) {
      toast("导入订阅失败：" + err.message, "error");
    }
  }

  // ---------------- 订阅转换 ----------------
  // sources：{ urls: [], profiles: [id], text: "" }
  async function convertSources(sources) {
    const parts = [];
    for (const url of (sources.urls || []).map((u) => String(u).trim()).filter(Boolean)) {
      if (!/^https?:\/\//i.test(url)) throw new Error("订阅链接要以 http:// 或 https:// 开头：" + url.slice(0, 40));
      const { text } = await profiles.fetchText(url, USER_AGENT);
      parts.push({ label: new URL(url).hostname, config: parseSubscription(text).config });
    }
    for (const id of sources.profiles || []) {
      if (!profiles.exists(id)) continue;
      parts.push({ label: profiles.get(id).name, config: profiles.parsed(id) });
    }
    if (String(sources.text || "").trim()) parts.push({ label: "粘贴", config: parseSubscription(sources.text).config });
    if (!parts.length) throw new Error("请先填写至少一个来源");
    return parts;
  }

  // ---------------- 内核下载 ----------------
  async function installCore(id) {
    if (!CORES[id]) throw new Error("未知内核");
    if (downloading.has(id)) throw new Error("正在下载");
    downloading.add(id);
    pushState();
    try {
      const mirror = settings().githubMirror;
      const fetchFn = (url) => httpFetch(url, { viaProxy: core.status === "running", signal: AbortSignal.timeout(180000) });
      const latest = await latestVersion({ id, fetch: fetchFn, mirror });
      if (installedVersion(id) === latest && existsSync(binPath(id))) return { version: latest, updated: false };
      const { version, files } = await downloadCore({ id, version: latest, fetch: fetchFn, mirror });
      // 正在用的内核（主内核或搭配内核）要先停下才能替换文件
      const isMain = core.id === id;
      const isSide = side && side.id === id;
      if (isMain) await core.stop();
      if (isSide) await side.stop();
      (isMain ? core : isSide ? side : makeCore(id, mainWorkDir(id))).replaceBinary(files, version);
      if (isMain) {
        tunPermission = await core.hasTunPermission();
        if (settings().tun.enable && !tunPermission) store.set({ tun: { enable: false } }); // 新内核需要重新授权
      }
      sideText = "";
      if (isMain || isSide || settings().combine) await applyConfig().catch(() => {});
      return { version, updated: true };
    } finally {
      downloading.delete(id);
      pushState();
    }
  }

  async function grantTun() {
    if (process.platform === "win32") {
      // 以管理员身份重新启动本应用
      const exe = process.execPath;
      const args = isDev ? [appRoot] : [];
      await cleanup();
      app.releaseSingleInstanceLock();
      const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
      spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process -FilePath '${exe.replace(/'/g, "''")}' ${quoted ? "-ArgumentList " + quoted : ""} -Verb RunAs`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
      app.exit(0);
      return false;
    }
    const running = !!core.proc;
    if (running) await core.stop(); // macOS 改所有者需要内核未运行
    try {
      await core.grantTunPermission();
    } finally {
      if (running) await applyConfig().catch(() => {});
    }
    tunPermission = await core.hasTunPermission();
    pushState();
    return tunPermission;
  }

  // ---------------- IPC ----------------
  const methods = {
    state: () => state(),
    setSettings: (patch) => setSettings(patch),
    applyConfig: () => applyConfig(),
    addProfile: async (input) => adopt(await profiles.add(input)),
    addCombo: async (input) => adopt(await profiles.addCombo(input)),
    importProfile: async (input) => adopt(profiles.import(input)),
    importProfileFile: async () => {
      const res = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "配置文件", extensions: ["yaml", "yml", "txt", "conf", "json"] }] });
      if (res.canceled || !res.filePaths[0]) return null;
      const file = res.filePaths[0];
      return methods.importProfile({ name: file.split(/[\\/]/).pop(), text: readFileSync(file, "utf8") });
    },
    updateProfile: (id, opts) => updateProfile(id, opts),
    updateAllProfiles: async () => {
      const results = await Promise.allSettled(profiles.list().filter((p) => p.type !== "local").map((p) => updateProfile(p.id)));
      return results.filter((r) => r.status === "rejected").length;
    },
    editProfile: async (id, patch) => {
      profiles.edit(id, patch);
      if (id === settings().currentProfile && (patch.convert !== undefined || patch.sources)) {
        if (patch.sources) await profiles.update(id);
        await applyConfig();
      }
      pushState();
    },
    readProfile: (id) => profiles.read(id),
    saveProfile: async (id, text) => {
      profiles.write(id, text);
      if (id === settings().currentProfile) await applyConfig();
      pushState();
    },
    removeProfile: async (id) => {
      profiles.remove(id);
      if (settings().currentProfile === id) await setSettings({ currentProfile: (profiles.list()[0] || {}).id || "" });
      pushState();
    },
    selectProfile: (id) => setSettings({ currentProfile: id }),
    convertPreview: async ({ sources, options, target, leakGuard }) => convert(await convertSources(sources), { options, target, leakGuard, scriptSource: readExtension("script.js") }),
    convertExport: async ({ sources, options, target, leakGuard, name }) => {
      const r = convert(await convertSources(sources), { options, target, leakGuard, scriptSource: readExtension("script.js") });
      const res = await dialog.showSaveDialog(win, { defaultPath: `${name || "knight"}.${r.ext}` });
      if (res.canceled || !res.filePath) return null;
      writeFileSync(res.filePath, r.text);
      return res.filePath;
    },
    // 只有一个订阅链接时存成带转换选项的普通订阅，否则存成组合订阅
    convertSave: async ({ sources, options, name }) => {
      const urls = (sources.urls || []).map((u) => String(u).trim()).filter(Boolean);
      const ids = sources.profiles || [];
      const text = String(sources.text || "").trim();
      if (urls.length === 1 && !ids.length && !text) return adopt(await profiles.add({ url: urls[0], name, convert: options }));
      const list = urls.map((url) => ({ type: "url", url })).concat(ids.map((id) => ({ type: "profile", id })), text ? [{ type: "text", text }] : []);
      return adopt(await profiles.addCombo({ name, sources: list, convert: options }));
    },
    runtimeConfig: () => (existsSync(core.configFile) ? readFileSync(core.configFile, "utf8") : ""),
    coreLog: () => core.output.slice(-200).concat(side ? ["", `—— 搭配内核 ${side.spec.label} ——`, ...side.output.slice(-80)] : []),
    restartCore: async () => {
      await core.restart();
      await core.waitReady(api);
      pushState();
    },
    installCore: (id) => installCore(id),
    upgradeCore: () => installCore(core.id),
    grantTun: () => grantTun(),
    checkTun: async () => {
      tunPermission = await core.hasTunPermission();
      pushState();
      return tunPermission;
    },
    systemProxyStatus: () => getSystemProxy(),
    openPath: (which) => shell.openPath(which === "work" ? core.workDir : userDir),
    openExternal: (url) => /^https?:\/\//.test(url) && shell.openExternal(url),
    copy: (text) => clipboard.writeText(String(text)),
    proxyCommand: () => proxyCommand(),
    quit: () => quit(),
  };

  ipcMain.handle("knight", async (_e, method, ...args) => {
    try {
      if (!methods[method]) throw new Error("未知方法：" + method);
      return { data: await methods[method](...args) };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });

  function proxyCommand() {
    const p = settings().mixedPort;
    if (process.platform === "win32") return `$env:HTTP_PROXY="http://127.0.0.1:${p}"; $env:HTTPS_PROXY="http://127.0.0.1:${p}"; $env:ALL_PROXY="socks5://127.0.0.1:${p}"`;
    return `export https_proxy=http://127.0.0.1:${p} http_proxy=http://127.0.0.1:${p} all_proxy=socks5://127.0.0.1:${p}`;
  }

  // ---------------- 窗口 ----------------
  function createWindow(show) {
    win = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: "Knight",
      icon: join(resourcesDir, "icons", "icon.png"),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#11151c" : "#f4efe4",
      webPreferences: { preload: join(here, "..", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.removeMenu();
    win.loadFile(join(here, "..", "renderer", "index.html"));
    win.once("ready-to-show", () => show && win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.on("close", (e) => {
      if (!quitting && settings().closeToTray && tray) {
        e.preventDefault();
        win.hide();
        if (process.platform === "darwin") app.dock?.hide();
      }
    });
    win.on("closed", () => (win = null));
  }

  function showWindow(page) {
    if (!win) createWindow(true);
    if (process.platform === "darwin") app.dock?.show();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (page) win.webContents.send("navigate", page);
  }

  // ---------------- 托盘 ----------------
  const trayIcon = (active) => {
    if (process.platform === "darwin") {
      const img = nativeImage.createFromPath(join(resourcesDir, "icons", active ? "trayTemplate.png" : "trayOffTemplate.png"));
      img.setTemplateImage(true);
      return img;
    }
    return nativeImage.createFromPath(join(resourcesDir, "icons", active ? "tray.png" : "tray-off.png"));
  };

  function createTray() {
    tray = new Tray(trayIcon(false));
    if (process.platform !== "darwin") tray.on("click", () => showWindow()); // macOS 点击图标直接弹出菜单
    updateTray();
  }

  const MODES = { rule: "规则", global: "全局", direct: "直连" };
  function updateTray() {
    if (!tray) return;
    const s = settings();
    const active = core.status === "running" && (sysproxyOn || s.tun.enable);
    tray.setImage(trayIcon(active));
    tray.setToolTip(`Knight · ${core.spec.label} · ${MODES[s.mode]}模式` + (sysproxyOn ? " · 系统代理" : "") + (s.tun.enable ? " · 虚拟网卡" : "") + (core.status === "running" ? "" : " · 内核未运行"));
    const toggle = (patch) => setSettings(patch).catch((err) => (err.message === "NEED_TUN_PERMISSION" ? showWindow("settings") : toast(err.message, "error")));
    const current = profiles.get(s.currentProfile);
    const installed = CORE_IDS.filter((id) => existsSync(binPath(id)));
    const menu = Menu.buildFromTemplate([
      { label: "打开 Knight", click: () => showWindow() },
      { type: "separator" },
      ...Object.entries(MODES).map(([mode, label]) => ({ label: label + "模式", type: "radio", checked: s.mode === mode, click: () => toggle({ mode }) })),
      { type: "separator" },
      { label: "系统代理", type: "checkbox", checked: s.systemProxy, click: () => toggle({ systemProxy: !s.systemProxy }) },
      { label: "虚拟网卡（TUN）", type: "checkbox", checked: s.tun.enable, click: () => toggle({ tun: { enable: !s.tun.enable } }) },
      { type: "separator" },
      {
        label: "订阅" + (current ? "：" + current.name : ""),
        submenu: profiles.list().length
          ? profiles.list().map((p) => ({ label: p.name, type: "radio", checked: p.id === s.currentProfile, click: () => toggle({ currentProfile: p.id }) }))
          : [{ label: "还没有订阅", enabled: false }],
      },
      {
        label: "内核：" + core.spec.label,
        submenu: installed.map((id) => ({ label: CORES[id].label, type: "radio", checked: id === core.id, click: () => toggle({ core: id }) })),
      },
      { label: "复制终端代理命令", click: () => clipboard.writeText(proxyCommand()) },
      { label: "重启内核", click: () => methods.restartCore().catch((err) => toast(err.message, "error")) },
      { type: "separator" },
      { label: "退出", click: () => quit() },
    ]);
    tray.setContextMenu(menu);
  }

  // ---------------- 生命周期 ----------------
  async function cleanup() {
    if (sysproxyOn) await setSystemProxy(false, {}).catch(() => {});
    sysproxyOn = false;
    await Promise.all([core.stop().catch(() => {}), side ? side.stop().catch(() => {}) : null]);
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    await cleanup();
    app.exit(0);
  }

  for (const scheme of ["clash", "mihomo", "knight"]) {
    if (isDev && process.platform === "win32") app.setAsDefaultProtocolClient(scheme, process.execPath, [appRoot]);
    else if (!isDev) app.setAsDefaultProtocolClient(scheme);
  }
  const linkIn = (argv) => argv.find((a) => /^(clash|mihomo|knight):\/\//i.test(a));

  app.on("second-instance", (_e, argv) => {
    const link = linkIn(argv);
    if (link) handleDeepLink(link);
    else showWindow();
  });
  app.on("open-url", (e, link) => {
    e.preventDefault();
    if (app.isReady()) handleDeepLink(link);
    else app.once("ready", () => handleDeepLink(link));
  });
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    quit();
  });
  app.on("window-all-closed", () => {
    if (!tray) quit();
  });
  app.on("activate", () => showWindow());
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => quit());

  useCore(settings().core);
  // 选中的内核被删掉了：回到自带的 mihomo
  makeCore("mihomo", mainWorkDir("mihomo")).install();
  if (!core.installed() && core.id !== "mihomo") {
    store.set({ core: "mihomo" });
    useCore("mihomo");
  }

  app.whenReady().then(async () => {
    nativeTheme.themeSource = settings().theme;
    const hidden = process.argv.includes("--hidden") || (settings().silentStart && !isDev);
    createWindow(!hidden);
    try {
      createTray();
    } catch {
      tray = null; // 没有系统托盘的桌面环境：关闭窗口即退出
    }
    if (hidden && process.platform === "darwin") app.dock?.hide();

    core.install();
    tunPermission = await core.hasTunPermission();
    if (settings().tun.enable && !tunPermission) store.set({ tun: { enable: false } });
    if (core.installed()) {
      await applyConfig().catch((err) => {
        toast(err.message, "error");
        // 订阅配置有问题时，至少用上次能用的配置把内核跑起来
        if (core.status !== "running" && existsSync(core.configFile)) core.start().then(() => core.waitReady(api)).catch(() => {});
      });
    }
    pushState();
    const link = linkIn(process.argv);
    if (link) handleDeepLink(link);
  });
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
