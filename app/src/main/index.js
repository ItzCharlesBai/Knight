// Ondine 主进程：窗口、托盘、设置、订阅、内核（多内核 + 搭配使用）与系统代理
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, session, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseSubscription, wrapProxies } from "./convert.js";
import { Core } from "./core.js";
import { binName, CORE_IDS, CORES, downloadCore, downloadRuleSet, latestVersion, withMirror } from "./core-download.js";
import { clientNodes, PROTOCOLS, prepare, REALITY_TARGETS, serviceScript, shareLinks, SINGBOX_SERVER_VERSION, uninstallScript } from "./deploy.js";
import { convert, TARGETS } from "./converter.js";
import { coreKind, generate } from "./enhance.js";
import { TEMPLATES } from "./nodes.js";
import { Profiles, USER_AGENT } from "./profiles.js";
import { SINGBOX_MODES } from "./singbox.js";
import { lanAddresses, qrPath, SHARE_TARGETS, ShareServer } from "./share.js";
import { stackProfiles, stackProviderCache } from "./stack.js";
import { Store } from "./store.js";
import { getSystemProxy, setSystemProxy } from "./sysproxy.js";
import { deploy as deployServer, exec as sshExec, runRoot, serverInfo, Servers, SSHPool } from "./vps.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..", "..");
const isDev = !app.isPackaged;
const OS = { win32: "win", darwin: "mac", linux: "linux" }[process.platform];

// 随应用发布的资源：打包后在 resources/ 下，开发时用仓库里的文件
const resourcesDir = isDev ? join(appRoot, "resources") : process.resourcesPath;
const bundledCoreDir = isDev ? join(appRoot, "resources", "core", `${OS}-${process.arch}`) : join(process.resourcesPath, "core");
const bundledGeoDir = join(resourcesDir, "geo");
const extensionsDir = isDev ? join(appRoot, "..", "clash-verge-rev") : join(process.resourcesPath, "extensions");

if (process.env.ONDINE_USER_DATA) app.setPath("userData", process.env.ONDINE_USER_DATA);
const userDir = app.getPath("userData");

// 应用以前叫 Knight、Lily、Chelle：第一次以 Ondine 启动时把旧的设置、订阅、服务器和内核搬过来（找最近用过的那个）
function migrateOldData() {
  if (process.env.ONDINE_USER_DATA || existsSync(join(userDir, "settings.json"))) return;
  const old = ["Chelle", "Lily", "Knight"].map((name) => join(app.getPath("appData"), name)).find((dir) => existsSync(join(dir, "settings.json")));
  if (!old) return;
  for (const name of ["settings.json", "profiles", "servers.json", "cores"]) {
    try {
      if (existsSync(join(old, name))) cpSync(join(old, name), join(userDir, name), { recursive: true });
    } catch {
      /* 搬不过来就当新用户 */
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  mkdirSync(userDir, { recursive: true });
  migrateOldData();
  // 旧版本把 mihomo 放在 userData/core，搬到 userData/cores/mihomo
  if (existsSync(join(userDir, "core")) && !existsSync(join(userDir, "cores", "mihomo"))) {
    mkdirSync(join(userDir, "cores"), { recursive: true });
    renameSync(join(userDir, "core"), join(userDir, "cores", "mihomo"));
  }
  const store = new Store(join(userDir, "settings.json"));
  const settings = () => store.get();
  // 旧版本的主题（深色、跟随系统等）换成默认的晨雾
  if (!["mist", "rain", "sun"].includes(settings().theme)) store.set({ theme: settings().theme === "rain" ? "rain" : "mist" });
  if (!CORES[settings().core] || CORES[settings().core].sidecarOnly) store.set({ core: "mihomo" });
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
  const sides = new Map(); // 搭配内核：key（一般就是内核 id，Juicity 是 juicity-1、juicity-2…）→ Core
  const sideTexts = new Map(); // key → 上次应用的配置，没变就不重启

  function useCore(id) {
    if (core) core.removeAllListeners("status");
    core = makeCore(id, mainWorkDir(id));
    core.on("status", onCoreStatus);
    return core;
  }
  // 可以搭配的内核（已下载的），按优先顺序：另一种内核里已下载的第一个，再加上 Xray
  function sidecarCandidates() {
    const other = core.kind === "singbox" ? ["mihomo", "mihomo-alpha"] : ["sing-box", "sing-box-beta"];
    return [other.find((x) => existsSync(binPath(x))), ...["xray", "juicity"].filter((x) => existsSync(binPath(x)))]
      .filter(Boolean)
      .map((id) => ({ id, kind: coreKind(id), bin: binPath(id), label: CORES[id].label }));
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
      const ses = session.fromPartition("ondine-" + key);
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

  // 正在使用的订阅：主订阅在前，其余同时使用（删掉的、重复的去掉）
  function activeIds() {
    const s = settings();
    return [s.currentProfile, ...s.extraProfiles].filter((id, i, all) => id && all.indexOf(id) === i && profiles.exists(id));
  }
  // 主订阅 + 同时使用的订阅合成一份；订阅内容和名字都没变时直接用上次的结果（状态推送时也要用到分组名）
  let stackMemo = null;
  function stacked() {
    const [primaryId, ...extraIds] = activeIds();
    if (!primaryId) return null;
    const parts = [primaryId, ...extraIds].map((id) => ({ id, name: profiles.get(id).name, config: profiles.load(id) }));
    const testUrl = settings().delayUrl;
    const same = stackMemo && stackMemo.testUrl === testUrl && stackMemo.parts.length === parts.length && stackMemo.parts.every((x, i) => x.id === parts[i].id && x.name === parts[i].name && x.config === parts[i].config);
    if (!same) stackMemo = { parts, testUrl, result: stackProfiles(parts[0].config, parts.slice(1), { testUrl }) };
    return Object.assign({ primary: profiles.get(primaryId) }, stackMemo.result);
  }

  function buildConfig() {
    const s = settings();
    const st = stacked();
    // 还没有订阅时也让内核跑起来（全部直连），方便先看日志、测试端口
    const profile = st ? st.config : { proxies: [], "proxy-groups": [], rules: ["MATCH,DIRECT"] };
    return generate({
      profile,
      settings: s,
      scriptSource: readExtension("script.js"),
      mergeSource: readExtension("merge.yaml"),
      profileName: st ? st.primary.name : "",
      core: { id: core.id, kind: core.kind },
      sidecars: sidecarCandidates(),
      singbox: {
        providers: st ? stackProviderCache(profiles.providerCache(st.primary.id), st.providers, (id) => profiles.providerCache(id)) : {},
        ruleSetPath: (tag) => (existsSync(ruleSetFile(tag)) ? ruleSetFile(tag) : ""),
        version: installedVersion(core.id),
      },
    });
  }

  // sing-box 用到的规则集由 Ondine 下载到本地（失败时自动改走代理），内核启动时不必联网
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
        // 第一次用 sing-box：先把各订阅的代理集合、规则集合缓存下来，再下载规则集，然后重新生成
        let again = false;
        for (const id of activeIds()) {
          const config = profiles.parsed(id);
          const hasProviders = Object.values(Object.assign({}, config["proxy-providers"], config["rule-providers"])).some((p) => p && p.type === "http");
          if (hasProviders && !profiles.providerCache(id).at) {
            await profiles.cacheProviders(id).catch(() => {});
            again = true;
          }
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
    await applySidecars(result.sidecars);
    pushState();
  }

  // 按计划启动 / 重启 / 停止搭配内核；某个启动失败不影响其他的，错误写进日志
  async function applySidecars(plans) {
    const keyOf = (p) => p.key || p.id;
    const wanted = new Set(plans.map(keyOf));
    for (const [key, sc] of sides) {
      if (wanted.has(key)) continue;
      await sc.stop();
      sides.delete(key);
      sideTexts.delete(key);
    }
    for (const plan of plans) {
      const key = keyOf(plan);
      try {
        let sc = sides.get(key);
        if (!sc) {
          sc = makeCore(plan.id, join(userDir, "sidecar-" + key));
          sc.on("status", () => pushState());
          sides.set(key, sc);
        }
        if (sideTexts.get(key) === plan.text && sc.proc) continue;
        const next = sc.configFile.replace(/\.(yaml|json)$/, ".next.$1");
        writeFileSync(next, plan.text);
        const error = await sc.test(next);
        if (error) {
          rmSync(next, { force: true });
          throw new Error(error);
        }
        renameSync(next, sc.configFile);
        sideTexts.set(key, plan.text);
        await sc.restart();
        // 搭配内核没有控制接口：进程活着就算运行中
        setTimeout(() => sc.proc && sc.setStatus("running"), 800);
      } catch (err) {
        lastApply.logs = lastApply.logs.concat({ source: "Ondine", level: "error", message: `搭配内核 ${CORES[plan.id].label} 启动失败：${err.message}` });
      }
    }
  }

  // ---------------- 共享订阅（局域网订阅地址）----------------
  // 每次请求现场生成：读本机已下载的订阅原文，按共享设置的选项转换
  const share = new ShareServer((target) => {
    const sh = settings().share;
    const ids = (sh.profiles.length ? sh.profiles : activeIds()).filter((id) => profiles.exists(id));
    if (!ids.length) throw new Error("没有可共享的订阅");
    const parts = ids.map((id) => ({ label: profiles.get(id).name, config: profiles.parsed(id) }));
    const r = convert(parts, { options: sh.options, target, leakGuard: sh.leakGuard, scriptSource: readExtension("script.js") });
    const first = profiles.get(ids[0]);
    return { text: r.text, userinfo: ids.length === 1 ? first.userinfo : null, name: ids.length === 1 ? first.name : "Ondine" };
  });
  async function syncShare() {
    const sh = settings().share;
    if (!sh.enabled) return share.stop();
    let token = sh.token;
    if (!/^[0-9a-f]{32}$/.test(token)) {
      token = randomBytes(16).toString("hex");
      store.set({ share: { token } });
    }
    await share.start(sh.port, token);
  }

  // ---------------- VPS 管理 ----------------
  // 登录凭据用系统钥匙串加密（Linux 没有钥匙串时 Electron 只能明文，那种情况只记在内存里）
  const vault = {
    secure: () => {
      try {
        return safeStorage.isEncryptionAvailable() && !(process.platform === "linux" && safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend() === "basic_text");
      } catch {
        return false;
      }
    },
    encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data, "base64")),
  };
  const servers = new Servers(join(userDir, "servers.json"), vault);
  const pool = new SSHPool(servers, {
    proxyPort: () => (core.status === "running" ? settings().mixedPort : 0),
    onHostKey: (id, fp) => {
      servers.touch(id, { hostKey: fp });
      pushState();
    },
  });
  const vpsBusy = new Map(); // id → 正在做的事
  const vpsLog = (id, entry) => win && !win.isDestroyed() && win.webContents.send("vps", Object.assign({ id }, entry));

  async function vpsSession(id) {
    try {
      return await pool.session(id);
    } catch (err) {
      if (err.message === "HOSTKEY_CHANGED") throw new Error("HOSTKEY_CHANGED:" + err.hostKey);
      throw err;
    }
  }
  async function vpsTask(id, label, fn) {
    if (vpsBusy.has(id)) throw new Error(`正在${vpsBusy.get(id)}，请稍等`);
    vpsBusy.set(id, label);
    pushState();
    try {
      return await fn();
    } catch (err) {
      if (!/^(HOSTKEY_CHANGED|NEED_PASSWORD)/.test(err.message)) servers.touch(id, { error: err.message });
      throw err;
    } finally {
      vpsBusy.delete(id);
      pushState();
    }
  }
  async function refreshServer(id) {
    const info = await serverInfo(await vpsSession(id));
    servers.touch(id, { info, infoAt: Date.now(), error: "" });
    pushState();
    return info;
  }
  // 部署出来的节点存成一份本地订阅（重新部署时更新同一份），默认和其他订阅一起使用
  async function serverProfile(id, use = true) {
    const sv = servers.get(id);
    if (!sv || !sv.deployment) throw new Error("这台服务器还没有部署");
    const nodes = clientNodes(sv.deployment, sv.name, sv.host);
    const text = `# Ondine 部署在 ${sv.name}（${sv.host}）上的节点\n` + yaml.dump(wrapProxies(nodes), { lineWidth: -1, noRefs: true });
    let pid = sv.profileId;
    if (pid && profiles.get(pid)) profiles.write(pid, text);
    else {
      pid = profiles.import({ name: "VPS · " + sv.name, text }).id;
      servers.touch(id, { profileId: pid });
    }
    if (use && !activeIds().includes(pid)) await useProfile(pid, true);
    else if (activeIds().includes(pid)) await applyConfig().catch(() => {});
    pushState();
    return pid;
  }
  function serverNodes(id) {
    const sv = servers.get(id);
    if (!sv || !sv.deployment) return { links: [], profileId: "" };
    return { links: shareLinks(clientNodes(sv.deployment, sv.name, sv.host)), profileId: sv.profileId || "" };
  }
  async function deployTo(id, plan) {
    return vpsTask(id, "部署", async () => {
      const sv = servers.get(id);
      if (!sv) throw new Error("服务器不存在");
      const dep = prepare(plan, sv.deployment);
      const log = (e) => vpsLog(id, e);
      const s = await vpsSession(id);
      log({ kind: "step", text: `已连接 ${sv.username}@${sv.host}` + (s.root ? "" : s.sudo ? "（通过 sudo）" : "") });
      const mirror = settings().githubMirror;
      const fetchFn = (url) => httpFetch(url, { viaProxy: core.status === "running", signal: AbortSignal.timeout(300000) });
      let version = SINGBOX_SERVER_VERSION;
      try {
        // 只是顺便查一下最新版本：试一次、最多等 15 秒，GitHub 不通就直接用内置的版本号
        const quick = (url) => httpFetch(url, { viaProxy: core.status === "running", signal: AbortSignal.timeout(15000) });
        version = (await latestVersion({ id: "sing-box", fetch: quick, mirror, tries: 1 })).replace(/^v/, "");
      } catch {
        /* 拿不到最新版本号就用内置的 */
      }
      const fetchTarball = async (ver, arch) => {
        const res = await fetchFn(withMirror(`https://github.com/SagerNet/sing-box/releases/download/v${ver}/sing-box-${ver}-linux-${arch}.tar.gz`, mirror));
        if (!res.ok) throw new Error(`本机下载 sing-box 也失败了（HTTP ${res.status}）`);
        return Buffer.from(await res.arrayBuffer());
      };
      const r = await deployServer(s, dep, { version, mirror, fetchTarball, log });
      servers.touch(id, { deployment: Object.assign(dep, { at: Date.now(), version: r.version }), error: "" });
      if (plan.addProfile !== false) {
        await serverProfile(id, true);
        log({ kind: "step", text: "节点已加进订阅，和其他订阅一起使用" });
      }
      refreshServer(id).catch(() => {});
      log({ kind: "done", text: "部署完成：sing-box " + r.version });
      return serverNodes(id);
    });
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
      const file = join(dir, "ondine.desktop");
      if (!enable) return rmSync(file, { force: true });
      mkdirSync(dir, { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Ondine\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
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
      active: activeIds(),
      groups: groupNames(),
      core: { id: core.id, kind: core.kind, label: core.spec.label, status: core.status, error: core.error, version: core.version(), installed: core.installed(), caps: CAPS[core.kind] },
      cores: CORE_IDS.map((id) => ({ id, label: CORES[id].label, desc: CORES[id].desc, kind: CORES[id].kind, sidecarOnly: !!CORES[id].sidecarOnly, version: installedVersion(id), installed: existsSync(binPath(id)), downloading: downloading.has(id) })),
      sidecars: [...sides.entries()].map(([key, sc]) => ({ id: sc.id, key, label: sc.spec.label + (key !== sc.id ? " " + key.slice(sc.id.length + 1) : ""), status: sc.status, error: sc.error })),
      controller: controller(),
      apply: lastApply,
      tunPermission,
      sysproxyOn,
      platform: process.platform,
      version: app.getVersion(),
      paths: { userDir, workDir: core.workDir },
      extensions: { script: !!readExtension("script.js"), merge: !!readExtension("merge.yaml") },
      convert: { templates: TEMPLATES, targets: TARGETS.map(([id, label]) => [id, label]) },
      servers: servers.list().map((x) => Object.assign(x, { busy: vpsBusy.get(x.id) || "" })),
      vps: { secure: vault.secure(), protocols: PROTOCOLS, targets: REALITY_TARGETS },
      share: { running: share.running, error: share.error, hits: share.hits, addresses: share.running ? lanAddresses() : [], targets: SHARE_TARGETS.map(([id, label]) => [id, label]) },
    };
  }

  // 「境外 DNS 出口」可选的分组：主订阅的分组加上同时使用的订阅生成的分组
  function groupNames() {
    try {
      const st = stacked();
      return st ? (st.config["proxy-groups"] || []).map((g) => g && g.name).filter((n) => typeof n === "string") : [];
    } catch {
      return [];
    }
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
  const RELOAD_KEYS = ["core", "combine", "sidecarPort", "xrayFor", "mixedPort", "controllerPort", "allowLan", "ipv6", "unifiedDelay", "findProcess", "tun", "leakGuard", "useMerge", "customRules", "customScript", "currentProfile", "extraProfiles", "delayUrl"];

  async function setSettings(patch) {
    const before = settings();
    if (patch.extraProfiles) patch = Object.assign({}, patch, { extraProfiles: [...new Set(patch.extraProfiles.filter((x) => typeof x === "string" && x))] });
    if (patch.core && patch.core !== before.core) {
      if (!CORES[patch.core]) throw new Error("未知内核");
      if (CORES[patch.core].sidecarOnly) throw new Error(`${CORES[patch.core].label} 没有控制接口，只能搭配使用`);
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
    if (before.theme !== after.theme) nativeTheme.themeSource = nativeThemeOf(after.theme);
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
    if (changed("share")) {
      try {
        await syncShare();
      } catch (err) {
        store.set({ share: { enabled: false } });
        await share.stop();
        pushState();
        throw new Error("共享订阅没有打开：" + err.message);
      }
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
      await profiles.update(id, Object.assign({ providers: core.kind === "singbox" && activeIds().includes(id) }, opts));
      if (activeIds().includes(id)) await applyConfig();
    } catch (err) {
      profiles.touch(id, { error: err.message, checkedAt: Date.now() });
      throw err;
    } finally {
      busy.delete(id);
      pushState();
    }
  }

  // 新导入的订阅直接和已有的一起使用（没有主订阅时成为主订阅）；引用了其他订阅的组合订阅不自动启用，免得节点重复
  async function adopt(item, { use = true } = {}) {
    const s = settings();
    if (!activeIds().length) await setSettings({ currentProfile: item.id, extraProfiles: [] });
    else if (use && !(item.type === "combo" && item.sources.some((x) => x.type === "profile"))) await setSettings({ extraProfiles: s.extraProfiles.concat(item.id) });
    pushState();
    return item;
  }

  // 同时使用 / 停用某个订阅；停用主订阅时下一个变成主订阅
  function useProfile(id, on) {
    if (!profiles.get(id)) throw new Error("订阅不存在");
    const ids = activeIds();
    const next = on ? (ids.includes(id) ? ids : ids.concat(id)) : ids.filter((x) => x !== id);
    return setSettings({ currentProfile: next[0] || "", extraProfiles: next.slice(1) });
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
      if (!/^(clash|mihomo|ondine):$/.test(url.protocol)) return;
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
      // 同一个内核可能有好几个搭配进程（Juicity 每个节点一个）
      const running = [...sides.entries()].filter(([, sc]) => sc.id === id);
      if (isMain) await core.stop();
      for (const [, sc] of running) await sc.stop();
      (isMain ? core : running.length ? running[0][1] : makeCore(id, mainWorkDir(id))).replaceBinary(files, version);
      if (isMain) {
        tunPermission = await core.hasTunPermission();
        if (settings().tun.enable && !tunPermission) store.set({ tun: { enable: false } }); // 新内核需要重新授权
      }
      for (const [key] of running) sideTexts.delete(key);
      if (isMain || running.length || settings().combine) await applyConfig().catch(() => {});
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
      if (activeIds().includes(id) && (patch.convert !== undefined || patch.sources || patch.name)) {
        if (patch.sources) await profiles.update(id);
        await applyConfig();
      }
      pushState();
    },
    readProfile: (id) => profiles.read(id),
    saveProfile: async (id, text) => {
      profiles.write(id, text);
      if (activeIds().includes(id)) await applyConfig();
      pushState();
    },
    removeProfile: async (id) => {
      const s = settings();
      const wasActive = activeIds().includes(id);
      profiles.remove(id);
      const rest = activeIds();
      // 删掉的是唯一在用的订阅：换成剩下的第一个
      if (wasActive) await setSettings({ currentProfile: rest[0] || (s.currentProfile === id && (profiles.list()[0] || {}).id) || "", extraProfiles: rest.slice(1) });
      pushState();
    },
    useProfile: (id, on) => useProfile(id, on),
    // 设为主订阅：分组和规则以它为准，其余照旧同时使用
    setPrimary: (id) => {
      if (!profiles.get(id)) throw new Error("订阅不存在");
      return setSettings({ currentProfile: id, extraProfiles: activeIds().filter((x) => x !== id) });
    },
    // 只用这一个
    onlyProfile: (id) => setSettings({ currentProfile: id, extraProfiles: [] }),
    convertPreview: async ({ sources, options, target, leakGuard }) => convert(await convertSources(sources), { options, target, leakGuard, scriptSource: readExtension("script.js") }),
    convertExport: async ({ sources, options, target, leakGuard, name }) => {
      const r = convert(await convertSources(sources), { options, target, leakGuard, scriptSource: readExtension("script.js") });
      const res = await dialog.showSaveDialog(win, { defaultPath: `${name || "ondine"}.${r.ext}` });
      if (res.canceled || !res.filePath) return null;
      writeFileSync(res.filePath, r.text);
      return res.filePath;
    },
    // 只有一个订阅链接时存成带转换选项的普通订阅，否则存成组合订阅
    convertSave: async ({ sources, options, name }) => {
      const urls = (sources.urls || []).map((u) => String(u).trim()).filter(Boolean);
      const ids = sources.profiles || [];
      const text = String(sources.text || "").trim();
      if (urls.length === 1 && !ids.length && !text) return adopt(await profiles.add({ url: urls[0], name, convert: options }), { use: false });
      const list = urls.map((url) => ({ type: "url", url })).concat(ids.map((id) => ({ type: "profile", id })), text ? [{ type: "text", text }] : []);
      return adopt(await profiles.addCombo({ name, sources: list, convert: options }), { use: false });
    },
    runtimeConfig: () => (existsSync(core.configFile) ? readFileSync(core.configFile, "utf8") : ""),
    coreLog: () => core.output.slice(-200).concat(...[...sides.values()].map((sc) => ["", `—— 搭配内核 ${sc.spec.label} ——`, ...sc.output.slice(-80)])),
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
    qr: (text) => qrPath(text),
    vpsAdd: (input) => {
      const item = servers.add(input);
      pushState();
      return { id: item.id };
    },
    vpsEdit: (id, patch) => {
      servers.edit(id, patch);
      pool.close(id);
      pushState();
    },
    vpsRemove: async (id, { profile = false } = {}) => {
      const sv = servers.get(id);
      pool.close(id);
      servers.remove(id);
      if (profile && sv && sv.profileId && profiles.get(sv.profileId)) await methods.removeProfile(sv.profileId);
      pushState();
    },
    vpsRefresh: (id) => vpsTask(id, "连接", () => refreshServer(id)),
    // 指纹变了、用户确认是自己重装过系统：换成新指纹
    vpsTrust: (id, hostKey) => {
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey)) throw new Error("指纹格式不对");
      servers.touch(id, { hostKey });
      pool.close(id);
      pushState();
    },
    vpsDeploy: (id, plan) => deployTo(id, plan),
    vpsNodes: (id) => serverNodes(id),
    vpsProfile: (id) => serverProfile(id, true),
    vpsService: (id, action) =>
      vpsTask(id, { logs: "读取日志", status: "查询状态", uninstall: "卸载" }[action] || "操作服务", async () => {
        const r = await runRoot(await vpsSession(id), action === "uninstall" ? uninstallScript() : serviceScript(action), { timeout: 180000 });
        const failure = /@@ONDINE error (.*)/.exec(r.out);
        if (failure) throw new Error(failure[1]);
        if (action === "uninstall") servers.touch(id, { deployment: null });
        refreshServer(id).catch(() => {});
        return (r.out.replace(/^@@ONDINE.*\n?/gm, "") + r.err).trim();
      }),
    // 终端：以登录用户执行一条命令
    vpsRun: (id, command) =>
      vpsTask(id, "执行命令", async () => {
        const cmd = String(command || "").trim();
        if (!cmd) throw new Error("请输入命令");
        const r = await sshExec((await vpsSession(id)).client, cmd, { timeout: 120000, maxBytes: 512 << 10 });
        return { code: r.code, out: r.out, err: r.err };
      }),
    pickKeyFile: async () => {
      const res = await dialog.showOpenDialog(win, { properties: ["openFile", "showHiddenFiles"], defaultPath: join(homedir(), ".ssh") });
      return res.canceled || !res.filePaths[0] ? "" : res.filePaths[0];
    },
    resetShareToken: () => setSettings({ share: { token: randomBytes(16).toString("hex") } }),
    openPath: (which) => shell.openPath(which === "work" ? core.workDir : userDir),
    openExternal: (url) => /^https?:\/\//.test(url) && shell.openExternal(url),
    copy: (text) => clipboard.writeText(String(text)),
    proxyCommand: () => proxyCommand(),
    quit: () => quit(),
  };

  ipcMain.handle("ondine", async (_e, method, ...args) => {
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
      title: "Ondine",
      icon: join(resourcesDir, "icons", process.platform === "win32" ? "icon.ico" : "icon.png"),
      autoHideMenuBar: true,
      backgroundColor: { rain: "#f6f6f3", sun: "#fcfaf4" }[settings().theme] || "#faf8f3",
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
    const proxying = core.status === "running" && (sysproxyOn || s.tun.enable);
    tray.setImage(trayIcon(proxying));
    tray.setToolTip(`Ondine · ${core.spec.label} · ${MODES[s.mode]}模式` + (sysproxyOn ? " · 系统代理" : "") + (s.tun.enable ? " · 虚拟网卡" : "") + (core.status === "running" ? "" : " · 内核未运行"));
    const toggle = (patch) => setSettings(patch).catch((err) => (err.message === "NEED_TUN_PERMISSION" ? showWindow("settings") : toast(err.message, "error")));
    const active = activeIds();
    const current = profiles.get(active[0]);
    const installed = CORE_IDS.filter((id) => !CORES[id].sidecarOnly && existsSync(binPath(id)));
    const menu = Menu.buildFromTemplate([
      { label: "打开 Ondine", click: () => showWindow() },
      { type: "separator" },
      ...Object.entries(MODES).map(([mode, label]) => ({ label: label + "模式", type: "radio", checked: s.mode === mode, click: () => toggle({ mode }) })),
      { type: "separator" },
      { label: "系统代理", type: "checkbox", checked: s.systemProxy, click: () => toggle({ systemProxy: !s.systemProxy }) },
      { label: "虚拟网卡（TUN）", type: "checkbox", checked: s.tun.enable, click: () => toggle({ tun: { enable: !s.tun.enable } }) },
      { type: "separator" },
      {
        label: "订阅" + (active.length > 1 ? `：${active.length} 个同时使用` : current ? "：" + current.name : ""),
        submenu: profiles.list().length
          ? profiles.list().map((p) => ({
              label: p.name + (active.length > 1 && p.id === active[0] ? "（主）" : ""),
              type: "checkbox",
              checked: active.includes(p.id),
              click: () => useProfile(p.id, !active.includes(p.id)).catch((err) => toast(err.message, "error")),
            }))
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
    pool.closeAll();
    await share.stop().catch(() => {});
    if (sysproxyOn) await setSystemProxy(false, {}).catch(() => {});
    sysproxyOn = false;
    await Promise.all([core.stop().catch(() => {}), ...[...sides.values()].map((sc) => sc.stop().catch(() => {}))]);
  }

  async function quit() {
    if (quitting) return;
    quitting = true;
    await cleanup();
    app.exit(0);
  }

  for (const scheme of ["clash", "mihomo", "ondine"]) {
    if (isDev && process.platform === "win32") app.setAsDefaultProtocolClient(scheme, process.execPath, [appRoot]);
    else if (!isDev) app.setAsDefaultProtocolClient(scheme);
  }
  const linkIn = (argv) => argv.find((a) => /^(clash|mihomo|ondine):\/\//i.test(a));

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
    nativeTheme.themeSource = nativeThemeOf(settings().theme);
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
    await syncShare().catch((err) => toast("共享订阅没有打开：" + err.message, "error"));
    pushState();
    const link = linkIn(process.argv);
    if (link) handleDeepLink(link);
  });
}

// 界面只有浅色（三种天气），系统控件也用浅色
const nativeThemeOf = () => "light";

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}
