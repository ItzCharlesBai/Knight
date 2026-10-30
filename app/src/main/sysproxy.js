// 系统代理：Windows 写注册表并通知 WinINet 刷新；macOS 用 networksetup；Linux 支持 GNOME 与 KDE
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const quiet = (p) => p.catch(() => null);

export async function setSystemProxy(enable, { host = "127.0.0.1", port, bypass = "" } = {}) {
  if (process.platform === "win32") return windows(enable, host, port, bypass);
  if (process.platform === "darwin") return mac(enable, host, port, bypass);
  return linux(enable, host, port, bypass);
}

// 当前系统代理是不是指向我们（用于检测被其他软件改掉）
export async function getSystemProxy() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("reg", ["query", WIN_KEY], { windowsHide: true });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout);
      const server = (/ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout) || [])[1] || "";
      return { enabled, server };
    }
    if (process.platform === "darwin") {
      const service = (await macServices())[0];
      if (!service) return { enabled: false, server: "" };
      const { stdout } = await run("networksetup", ["-getwebproxy", service]);
      const enabled = /Enabled:\s*Yes/i.test(stdout);
      const server = ((/Server:\s*(\S+)/.exec(stdout) || [])[1] || "") + ":" + ((/Port:\s*(\d+)/.exec(stdout) || [])[1] || "");
      return { enabled, server };
    }
    const { stdout } = await run("gsettings", ["get", "org.gnome.system.proxy", "mode"]);
    const { stdout: host } = await run("gsettings", ["get", "org.gnome.system.proxy.http", "host"]);
    const { stdout: port } = await run("gsettings", ["get", "org.gnome.system.proxy.http", "port"]);
    return { enabled: /manual/.test(stdout), server: host.trim().replace(/'/g, "") + ":" + port.trim() };
  } catch {
    return { enabled: false, server: "" };
  }
}

const WIN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

async function windows(enable, host, port, bypass) {
  // 写完注册表后调用 InternetSetOption，让浏览器和系统立刻生效
  const ps = `
$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
Set-ItemProperty -Path $k -Name ProxyEnable -Value ${enable ? 1 : 0}
${enable ? `Set-ItemProperty -Path $k -Name ProxyServer -Value '${host}:${port}'\nSet-ItemProperty -Path $k -Name ProxyOverride -Value '${bypass.replace(/'/g, "''")}'` : ""}
$sig = '[DllImport("wininet.dll", SetLastError = true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'
$t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace Knight -PassThru
$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });
}

async function macServices() {
  const { stdout } = await run("networksetup", ["-listallnetworkservices"]);
  // 第一行是说明文字；带 * 的是已停用的网络服务
  return stdout.split("\n").slice(1).map((s) => s.trim()).filter((s) => s && !s.startsWith("*"));
}

async function mac(enable, host, port, bypass) {
  const domains = bypass.split(/[;,]/).map((s) => s.trim()).filter((s) => s && s !== "<local>");
  for (const service of await macServices()) {
    if (enable) {
      await run("networksetup", ["-setwebproxy", service, host, String(port)]);
      await run("networksetup", ["-setsecurewebproxy", service, host, String(port)]);
      await run("networksetup", ["-setsocksfirewallproxy", service, host, String(port)]);
      if (domains.length) await quiet(run("networksetup", ["-setproxybypassdomains", service, ...domains]));
    } else {
      await quiet(run("networksetup", ["-setwebproxystate", service, "off"]));
      await quiet(run("networksetup", ["-setsecurewebproxystate", service, "off"]));
      await quiet(run("networksetup", ["-setsocksfirewallproxystate", service, "off"]));
    }
  }
}

async function linux(enable, host, port, bypass) {
  const ignore = "[" + bypass.split(/[;,]/).map((s) => s.trim()).filter((s) => s && s !== "<local>").map((s) => `'${s}'`).join(", ") + "]";
  const results = [];
  // GNOME 系（含 Ubuntu、Deepin、Cinnamon 等用 gsettings 的桌面）
  if (enable) {
    for (const scheme of ["http", "https", "socks"]) {
      results.push(await quiet(run("gsettings", ["set", `org.gnome.system.proxy.${scheme}`, "host", host])));
      results.push(await quiet(run("gsettings", ["set", `org.gnome.system.proxy.${scheme}`, "port", String(port)])));
    }
    await quiet(run("gsettings", ["set", "org.gnome.system.proxy", "ignore-hosts", ignore]));
  }
  results.push(await quiet(run("gsettings", ["set", "org.gnome.system.proxy", "mode", enable ? "manual" : "none"])));

  // KDE Plasma 5 / 6
  for (const tool of ["kwriteconfig6", "kwriteconfig5"]) {
    const kw = (key, value) => run(tool, ["--file", "kioslaverc", "--group", "Proxy Settings", "--key", key, value]);
    const ok = await quiet(kw("ProxyType", enable ? "1" : "0"));
    if (!ok) continue;
    if (enable) {
      for (const key of ["httpProxy", "httpsProxy"]) await quiet(kw(key, `http://${host} ${port}`));
      await quiet(kw("socksProxy", `socks://${host} ${port}`));
      await quiet(kw("NoProxyFor", bypass.replace(/;/g, ",")));
    }
    results.push(ok);
    break;
  }
  if (!results.some(Boolean)) throw new Error("没有找到可设置的桌面环境（支持 GNOME / KDE），请在系统设置里手动填写代理 " + host + ":" + port);
}
