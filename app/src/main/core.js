// 内核进程管理（mihomo 系与 sing-box 通用）：启动 / 停止 / 配置校验 / 残留进程清理 / TUN 授权
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { binName, CORES, GEO_FILES } from "./core-download.js";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Core extends EventEmitter {
  // id：CORES 里的内核；bundledDir：随应用发布的内核目录（只有 mihomo 有）；
  // coreDir：用户目录下实际运行的副本（授权 TUN 需要改它的权限）
  constructor({ id = "mihomo", bundledDir = "", geoDir = "", coreDir, workDir }) {
    super();
    this.id = id;
    this.spec = CORES[id];
    this.kind = this.spec.kind;
    this.bundledDir = bundledDir;
    this.geoDir = geoDir;
    this.coreDir = coreDir;
    this.workDir = workDir;
    this.bin = join(coreDir, binName(id));
    this.configFile = join(workDir, this.kind === "singbox" ? "config.json" : "config.yaml");
    this.pidFile = join(workDir, "core.pid");
    this.proc = null;
    this.status = "stopped"; // stopped | starting | running | error
    this.error = "";
    this.output = [];
    this.wantRunning = false;
    this.restarts = 0;
    mkdirSync(coreDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
  }

  // 首次运行或随应用更新了更新的内核时，把内核复制到用户目录；GEO 数据缺了就用随应用发布的
  install() {
    if (this.kind === "clash" && this.geoDir) {
      for (const name of GEO_FILES) {
        const src = join(this.geoDir, name);
        if (existsSync(src) && !existsSync(join(this.workDir, name))) copyFileSync(src, join(this.workDir, name));
      }
    }
    if (!this.bundledDir) return;
    const bundled = join(this.bundledDir, binName(this.id));
    if (!existsSync(bundled)) return;
    const bundledVersion = readText(join(this.bundledDir, "version.txt"));
    const current = readText(join(this.coreDir, "version.txt"));
    if (existsSync(this.bin) && current && compareVersion(current, bundledVersion) >= 0) return;
    this.replaceBinary([{ name: binName(this.id), data: readFileSync(bundled) }], bundledVersion);
  }

  // files[0] 是内核本身，其余是它需要的动态库（sing-box 的 libcronet）
  replaceBinary(files, version) {
    for (const file of files) {
      const target = join(this.coreDir, file.name);
      const tmp = target + ".new";
      writeFileSync(tmp, file.data);
      chmodSync(tmp, 0o755);
      renameSync(tmp, target);
    }
    writeFileSync(join(this.coreDir, "version.txt"), version || "");
  }

  version() {
    return readText(join(this.coreDir, "version.txt")) || (existsSync(this.bin) ? "未知" : "");
  }

  installed() {
    return existsSync(this.bin);
  }

  runArgs(file = this.configFile) {
    if (this.kind === "singbox") return ["run", "-c", file, "-D", this.workDir, "--disable-color"];
    if (this.kind === "xray") return ["run", "-c", file];
    return ["-d", this.workDir, "-f", file];
  }

  // 校验配置：返回错误信息，没问题返回空字符串
  async test(file) {
    const args =
      this.kind === "singbox" ? ["check", "-c", file, "-D", this.workDir, "--disable-color"] : this.kind === "xray" ? ["run", "-test", "-c", file] : ["-t", "-d", this.workDir, "-f", file];
    const isError = (l) => (this.kind === "singbox" ? /\b(FATAL|ERROR)\b/.test(l) : this.kind === "xray" ? /fail|error|panic/i.test(l) : /level=(error|fatal)/.test(l));
    try {
      const { stdout, stderr } = await run(this.bin, args, { timeout: 60000, windowsHide: true });
      return (stdout + "\n" + stderr).split("\n").filter(isError).map(cleanLog).join("\n");
    } catch (err) {
      const out = String(err.stdout || "") + "\n" + String(err.stderr || "");
      const errors = out.split("\n").filter(isError);
      return (errors.length ? errors : out.split("\n").filter((l) => /error|fatal|failed/i.test(l))).map(cleanLog).join("\n").trim() || err.message;
    }
  }

  async start() {
    if (this.proc) return;
    if (!this.installed()) throw new Error(`没有找到 ${this.spec.label} 内核，请在 设置 → 内核 里下载`);
    this.wantRunning = true;
    this.setStatus("starting");
    await this.killStale();
    const proc = spawn(this.bin, this.runArgs(), { cwd: this.workDir, windowsHide: true });
    this.proc = proc;
    if (proc.pid) writeFileSync(this.pidFile, String(proc.pid));
    const onData = (chunk) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.output.push(line);
        if (this.output.length > 500) this.output.shift();
        if (this.kind === "singbox" ? /\bFATAL\b/.test(line) : this.kind === "xray" ? /Failed to start|panic/.test(line) : /level=fatal/.test(line)) this.error = cleanLog(line);
      }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (err) => {
      this.error = err.message;
    });
    proc.on("exit", (code) => {
      if (readText(this.pidFile) === String(proc.pid)) rmSync(this.pidFile, { force: true });
      if (this.proc !== proc) return;
      this.proc = null;
      if (!this.wantRunning) return this.setStatus("stopped");
      this.error = this.error || `内核意外退出（代码 ${code}）`;
      this.setStatus("error");
      // 意外退出：短时间内最多自动重启 3 次
      if (this.restarts++ < 3) setTimeout(() => this.wantRunning && !this.proc && this.start().catch(() => {}), 1500 * this.restarts);
    });
  }

  async stop() {
    this.wantRunning = false;
    const proc = this.proc;
    if (!proc) return this.setStatus("stopped");
    this.proc = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.kill();
    });
    this.setStatus("stopped");
  }

  async restart() {
    await this.stop();
    this.error = "";
    this.restarts = 0;
    await this.start();
  }

  // 上次没正常退出（应用被强制结束、崩溃）留下的内核会占着端口，启动前先结束它
  async killStale() {
    const pid = Number(readText(this.pidFile));
    rmSync(this.pidFile, { force: true });
    if (!pid || pid === process.pid) return;
    try {
      process.kill(pid, 0);
    } catch {
      return; // 已经不在了
    }
    if (!(await this.isCoreProcess(pid))) return; // PID 被别的程序复用了，不动它
    try {
      process.kill(pid);
    } catch {
      return;
    }
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await sleep(100);
    }
  }

  async isCoreProcess(pid) {
    try {
      if (process.platform === "linux") return readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "") === this.bin;
      if (process.platform === "win32") {
        const { stdout } = await run("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { windowsHide: true });
        return stdout.toLowerCase().includes(binName(this.id, "win32"));
      }
      const { stdout } = await run("ps", ["-p", String(pid), "-o", "comm="]);
      return stdout.includes(binName(this.id));
    } catch {
      return false;
    }
  }

  // 内核起来后控制接口可用才算 running
  async waitReady(api, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (!this.proc) break;
      try {
        await api("GET", "/version");
        this.error = "";
        this.restarts = 0;
        this.setStatus("running");
        return true;
      } catch {
        await sleep(250);
      }
    }
    if (this.proc) this.error = this.error || "内核启动超时：" + (this.output.slice(-3).map(cleanLog).join(" ") || "没有输出");
    this.setStatus("error");
    return false;
  }

  setStatus(status) {
    this.status = status;
    this.emit("status", status);
  }

  // ---------------- TUN 权限 ----------------
  // Windows：应用本身以管理员身份运行；macOS：内核 setuid root；Linux：内核带 cap_net_admin
  async hasTunPermission() {
    try {
      if (process.platform === "win32") {
        await run("net", ["session"], { windowsHide: true });
        return true;
      }
      if (process.platform === "darwin") {
        const st = statSync(this.bin);
        return st.uid === 0 && (st.mode & 0o4000) !== 0;
      }
      if (process.getuid && process.getuid() === 0) return true;
      const { stdout } = await run("getcap", [this.bin]);
      return /cap_net_admin/.test(stdout);
    } catch {
      return false;
    }
  }

  // 弹出系统的管理员授权；Windows 需要以管理员身份重启应用，由调用方处理
  async grantTunPermission() {
    const bin = this.bin.replace(/"/g, '\\"');
    if (process.platform === "darwin") {
      const shell = `chown root:admin \\"${bin}\\" && chmod +sx \\"${bin}\\"`;
      await run("osascript", ["-e", `do shell script "${shell}" with administrator privileges`]);
    } else if (process.platform === "linux") {
      await run("pkexec", ["setcap", "cap_net_admin,cap_net_bind_service,cap_net_raw=+ep", this.bin]);
    } else {
      throw new Error("Windows 需要以管理员身份运行");
    }
  }
}

function readText(file) {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export function compareVersion(a, b) {
  const pa = String(a).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// mihomo：time="..." level=error msg="xxx" → xxx；sing-box：+0800 2026-10-31 12:00:00 FATAL[0000] xxx → xxx
export const cleanLog = (line) => {
  const m = /msg="((?:[^"\\]|\\.)*)"/.exec(line);
  if (m) return m[1].replace(/\\"/g, '"').trim();
  return line.replace(/^(?:[+-]\d{4} [\d-]+ [\d:.]+ )?(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL|PANIC)\[\d+\]\s*/, "").trim();
};
