// Knight 主进程：窗口、托盘、设置、订阅、内核与系统代理
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, session, shell, Tray } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Core } from "./core.js";
import { downloadCore, latestVersion } from "./core-download.js";
import { generate } from "./enhance.js";
import { Profiles } from "./profiles.js";
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
  const store = new Store(join(userDir, "settings.json"));
  const core = new Core({ bundledDir: bundledCoreDir, geoDir: bundledGeoDir, coreDir: join(userDir, "core"), workDir: join(userDir, "mihomo") });
  const profiles = new Profiles(join(userDir, "profiles"), (url, opts) => httpFetch(url, opts));
  const settings = () => store.get();

  let win = null;
  let tray = null;
  let quitting = false;
  let lastApply = { at: 0, error: "", logs: [] };
  let tunPermission = false;
  let sysproxyOn = false; // 我们实际设置过的系统代理状态，退出时据此恢复
  const busy = new Set(); // 正在更新的订阅 id

  // ---------------- 网络请求（订阅、内核下载）----------------
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
  async function httpFetch(url, { headers = {}, viaProxy = settings().updateViaProxy } = {}) {
    const go = async (proxy) => (await fetchSession(proxy)).fetch(url, { headers, redirect: "follow", cache: "no-store" });
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
  const readExtension = (name) => {
    try {
      return readFileSync(join(extensionsDir, name), "utf8");
    } catch {
      return "";
    }
  };

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
    });
  }

  let applying = Promise.resolve();
  // reload=false 只写文件（模式、日志级别通过接口即时修改，不必重载）
  function applyConfig({ reload = true } = {}) {
    applying = applying.catch(() => {}).then(() => doApply(reload));
    return applying;
  }

  async function doApply(reload) {
    let result;
    try {
      result = buildConfig();
    } catch (err) {
      lastApply = { at: Date.now(), error: "生成配置失败：" + err.message, logs: [] };
      pushState();
      throw new Error(lastApply.error);
    }
    const next = core.configFile.replace(/\.yaml$/, ".next.yaml");
    writeFileSync(next, result.text);
    if (!reload) {
      renameSync(next, core.configFile);
      return;
    }
    const error = core.installed() ? await core.test(next) : "";
    if (error) {
      rmSync(next, { force: true });
      lastApply = { at: Date.now(), error: "配置校验失败：" + error, logs: result.logs };
      pushState();
      throw new Error(lastApply.error);
    }
    renameSync(next, core.configFile);
    lastApply = { at: Date.now(), error: "", logs: result.logs };
    if (core.status === "running" && core.proc) {
      await api("PUT", "/configs?force=true", { path: core.configFile });
    } else {
      await core.restart();
      await core.waitReady(api);
    }
    pushState();
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
  function state() {
    const s = settings();
    return {
      settings: s,
      profiles: profiles.list().map((p) => Object.assign({}, p, { updating: busy.has(p.id) })),
      groups: s.currentProfile ? profiles.groups(s.currentProfile) : [],
      core: { status: core.status, error: core.error, version: core.version(), installed: core.installed() },
      controller: controller(),
      apply: lastApply,
      tunPermission,
      sysproxyOn,
      platform: process.platform,
      version: app.getVersion(),
      paths: { userDir, workDir: core.workDir },
      extensions: { script: !!readExtension("script.js"), merge: !!readExtension("merge.yaml") },
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
  core.on("status", async () => {
    pushState();
    await syncSystemProxy().catch(() => {});
    pushState();
  });

  const toast = (message, type = "info") => win && !win.isDestroyed() && win.webContents.send("toast", { message, type });

  // ---------------- 设置变更 ----------------
  const RELOAD_KEYS = ["mixedPort", "controllerPort", "allowLan", "ipv6", "unifiedDelay", "findProcess", "tun", "leakGuard", "useMerge", "customRules", "customScript", "currentProfile"];

  async function setSettings(patch) {
    const before = settings();
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
    try {
      if (RELOAD_KEYS.some(changed)) {
        await applyConfig();
      } else if (changed("mode") || changed("logLevel")) {
        await applyConfig({ reload: false });
        if (core.status === "running") {
          await api("PATCH", "/configs", { mode: after.mode, "log-level": after.logLevel });
          // 切换模式后断开旧连接，让新模式立即生效
          if (changed("mode")) await api("DELETE", "/connections").catch(() => {});
        }
      }
    } catch (err) {
      // 新配置用不了：恢复原设置，内核保持原样运行
      if (RELOAD_KEYS.some(changed)) store.set(pick(before, RELOAD_KEYS));
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
      await profiles.update(id, opts);
      if (id === settings().currentProfile) await applyConfig();
    } catch (err) {
      profiles.touch(id, { error: err.message, checkedAt: Date.now() });
      throw err;
    } finally {
      busy.delete(id);
      pushState();
    }
  }

  async function addProfile(input) {
    const item = await profiles.add(input);
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
      const item = await addProfile({ url: sub, name: url.searchParams.get("name") || "" });
      toast(`已导入订阅「${item.name}」`, "success");
    } catch (err) {
      toast("导入订阅失败：" + err.message, "error");
    }
  }

  // ---------------- 内核 ----------------
  async function upgradeCore() {
    const mirror = settings().githubMirror;
    const fetchFn = (url) => httpFetch(url, { viaProxy: core.status === "running" });
    const latest = await latestVersion({ fetch: fetchFn, mirror });
    if (core.installed() && core.version() === latest) return { version: latest, updated: false };
    const { version, binary } = await downloadCore({ version: latest, fetch: fetchFn, mirror });
    const running = !!core.proc;
    await core.stop();
    core.replaceBinary(binary, version);
    tunPermission = await core.hasTunPermission();
    if (settings().tun.enable && !tunPermission) store.set({ tun: { enable: false } }); // 新内核需要重新授权
    await applyConfig();
    return { version, updated: true, wasRunning: running };
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
    addProfile: (input) => addProfile(input),
    importProfile: async (input) => {
      const item = profiles.import(input);
      if (!profiles.exists(settings().currentProfile)) await setSettings({ currentProfile: item.id });
      pushState();
      return item;
    },
    importProfileFile: async () => {
      const res = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "配置文件", extensions: ["yaml", "yml", "txt", "conf"] }] });
      if (res.canceled || !res.filePaths[0]) return null;
      const file = res.filePaths[0];
      return methods.importProfile({ name: file.split(/[\\/]/).pop(), text: readFileSync(file, "utf8") });
    },
    updateProfile: (id, opts) => updateProfile(id, opts),
    updateAllProfiles: async () => {
      const results = await Promise.allSettled(profiles.list().filter((p) => p.type === "remote").map((p) => updateProfile(p.id)));
      return results.filter((r) => r.status === "rejected").length;
    },
    editProfile: (id, patch) => {
      profiles.edit(id, patch);
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
    runtimeConfig: () => (existsSync(core.configFile) ? readFileSync(core.configFile, "utf8") : ""),
    coreLog: () => core.output.slice(-200),
    restartCore: async () => {
      await core.restart();
      await core.waitReady(api);
      pushState();
    },
    upgradeCore: () => upgradeCore(),
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
      width: 1040,
      height: 700,
      minWidth: 860,
      minHeight: 580,
      show: false,
      title: "Knight",
      icon: join(resourcesDir, "icons", "icon.png"),
      autoHideMenuBar: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#16171b" : "#f6f7f9",
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
    tray.setToolTip(`Knight · ${MODES[s.mode]}模式` + (sysproxyOn ? " · 系统代理" : "") + (s.tun.enable ? " · 虚拟网卡" : "") + (core.status === "running" ? "" : " · 内核未运行"));
    const toggle = (patch) => setSettings(patch).catch((err) => (err.message === "NEED_TUN_PERMISSION" ? showWindow("settings") : toast(err.message, "error")));
    const current = profiles.get(s.currentProfile);
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
    await core.stop().catch(() => {});
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
        // 订阅配置有问题时，至少用空配置把内核跑起来
        if (core.status !== "running") core.start().then(() => core.waitReady(api)).catch(() => {});
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
