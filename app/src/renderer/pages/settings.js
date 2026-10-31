// 设置：代理端口、系统代理、虚拟网卡、防泄露（script.js 参数）、自定义规则与脚本、应用、内核
import { confirm, delegate, html, icon, modal, patch, raw, toggle } from "../lib.js";

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
// "tun.stack" + 值 → { tun: { stack: 值 } }
const patchOf = (path, value) => path.split(".").reduceRight((v, k) => ({ [k]: v }), value);

const LOG_LEVELS = [
  ["silent", "不输出"],
  ["error", "错误"],
  ["warning", "警告"],
  ["info", "信息"],
  ["debug", "调试"],
];

export default function settings(root, ctx) {
  root.innerHTML = html`<header class="page-head"><h1>设置</h1></header><div id="st-body"></div>`.s;
  const body = root.querySelector("#st-body");
  let coreBusy = "";
  let moreOpen = false;
  // 没保存的自定义规则 / 脚本：状态推送重绘时不能丢
  const drafts = {};

  // ---------------- 控件 ----------------
  const row = (label, desc, control, extra = "") =>
    html`<div class="set-row ${extra}"><div class="set-text"><span>${label}</span>${desc ? html`<small>${desc}</small>` : ""}</div><div class="set-control">${control}</div></div>`;
  const sw = (path, label, desc, disabled = false) =>
    row(label, desc, toggle(path, !!get(ctx.state.settings, path), disabled ? "disabled" : ""));
  const select = (path, label, desc, options) => {
    const value = String(get(ctx.state.settings, path));
    return row(label, desc, html`<select data-key="${path}">${options.map(([v, t]) => html`<option value="${v}" ${raw(String(v) === value ? "selected" : "")}>${t}</option>`)}</select>`);
  };
  const number = (path, label, desc, min, max) =>
    row(label, desc, html`<input type="number" data-key="${path}" data-type="number" min="${min}" max="${max}" value="${get(ctx.state.settings, path)}" />`);
  const text = (path, label, desc, placeholder = "") =>
    row(label, desc, html`<input data-key="${path}" value="${get(ctx.state.settings, path)}" placeholder="${placeholder}" />`, "wide-input");
  const section = (id, title, rows, note = "") =>
    html`<section class="set-section" id="${id}"><h2 class="section-title">${title}</h2>${note}<div class="card">${rows}</div></section>`;

  function render() {
    const st = ctx.state;
    const s = st.settings;
    const lg = s.leakGuard;
    const win = st.platform === "win32";
    const groups = [["", "跟随订阅兜底规则（推荐）"], ...st.groups.map((g) => [g, g])];
    const caps = st.core.caps || {};

    patch(
      body,
      html`
      ${section(
        "core",
        "内核",
        html`
        ${st.cores.map((c) => {
          const using = st.core.id === c.id;
          const paired = st.sidecar && st.sidecar.id === c.id;
          return html`<div class="core-row">
            <input type="radio" name="core" data-key="core" value="${c.id}" ${raw(using ? "checked" : "")} ${raw(c.installed ? "" : "disabled")} title="${c.installed ? "使用这个内核" : "先下载"}" />
            <div class="set-text"><span>${c.label}${using ? html`<span class="badge">使用中</span>` : ""}${paired ? html`<span class="badge">搭配</span>` : ""}<small>${c.installed ? c.version || "" : "未下载"}</small></span><small>${c.desc}</small></div>
            <button class="btn sm" data-action="install-core" data-id="${c.id}" ${raw(c.downloading ? "disabled" : "")}>${icon(c.installed ? "refresh" : "down", 14)}${c.downloading ? "下载中…" : c.installed ? "更新" : "下载"}</button>
          </div>`;
        })}
        ${sw("combine", "搭配使用", "当前内核不支持的节点交给另一个已下载的内核运行：mihomo 下的 NaiveProxy 交给 sing-box，sing-box 下的 SSR、Snell、Mieru 交给 mihomo")}
        ${s.combine ? number("sidecarPort", "搭配端口", "另一个内核在本机开的 SOCKS 入口从这个端口起依次使用", 1024, 65000) : ""}
        ${st.core.id === "mihomo-smart" ? sw("smartGroups", "Smart 分组", "把订阅里的自动选择（url-test）分组换成 Smart 分组") : ""}
        ${row(
          "运行状态",
          st.core.installed ? `${st.core.label} ${st.core.version} · ${{ running: "运行中", starting: "启动中", stopped: "已停止", error: "出错" }[st.core.status]}${st.sidecar ? ` ；搭配 ${st.sidecar.label} · ${st.sidecar.status === "running" ? "运行中" : st.sidecar.status}` : ""}` : "还没有内核，请先下载",
          html`<button class="btn sm" data-action="restart" ${raw(coreBusy ? "disabled" : "")}>${icon("refresh", 14)}${coreBusy === "restart" ? "重启中…" : "重启内核"}</button>`
        )}
        ${st.core.error ? html`<div class="notice bad inset">${st.core.error}</div>` : ""}
        ${caps.geo ? row("GEO 数据", "更新 geoip / geosite 数据库", html`<button class="btn sm" data-action="geo">${icon("refresh", 14)}更新</button>`) : ""}
        ${row(
          "缓存",
          "切换节点或规则后解析异常时清空",
          html`<div class="btn-group">${caps.fakeipFlush ? html`<button class="btn sm" data-action="flush-fakeip">清空 Fake-IP</button>` : ""}${caps.dnsFlush ? html`<button class="btn sm" data-action="flush-dns">清空 DNS 缓存</button>` : ""}</div>`
        )}
        ${row("内核输出", "启动失败时查看", html`<button class="btn sm" data-action="core-log">${icon("terminal", 14)}查看</button>`)}`,
        html`<p class="muted small section-note">${st.core.kind === "singbox"
          ? "sing-box 读不了 Clash 配置：订阅、分组、规则和防泄露设置由 Knight 自动转换，修改设置后会重启 sing-box。"
          : "可以同时下载几个内核，随时切换，订阅和设置不用重新导入。"}</p>`
      )}

      ${section(
        "proxy",
        "代理",
        html`
        ${number("mixedPort", "代理端口", "HTTP 和 SOCKS5 共用（mixed-port）", 1, 65535)}
        ${sw("allowLan", "允许局域网连接", "让同一局域网的手机、电脑使用本机代理")}
        ${sw("ipv6", "IPv6", "建议开启：虚拟网卡会一并接管 IPv6，防泄露脚本会让境外域名只用 IPv4")}
        ${sw("unifiedDelay", "统一延迟", "测速时去掉握手耗时，结果更接近实际")}
        ${sw("findProcess", "识别进程", "连接页显示进程名，规则可用 PROCESS-NAME")}
        ${select("logLevel", "日志级别", "", LOG_LEVELS)}
        ${text("delayUrl", "测速地址", "", "https://www.gstatic.com/generate_204")}
        ${number("delayTimeout", "测速超时（毫秒）", "", 1000, 30000)}`
      )}

      ${section(
        "sysproxy",
        "系统代理",
        html`
        ${sw("systemProxy", "开启系统代理", st.sysproxyOn ? `已设置为 127.0.0.1:${s.mixedPort}` : s.systemProxy ? "等待内核启动" : "浏览器和大多数软件会经过代理；WebRTC 和不读系统代理的软件不会")}
        ${row("例外地址", "这些地址不走代理，用分号分隔", html`<input data-key="proxyBypass" value="${s.proxyBypass}" />`, "wide-input")}
        ${row("终端代理", "复制设置命令行代理的命令", html`<button class="btn sm" data-action="copy-cmd">${icon("copy", 14)}复制</button>`)}`
      )}

      ${section(
        "tun",
        "虚拟网卡（TUN）",
        html`
        ${row(
          "授权",
          st.tunPermission ? "已授权，可以开启虚拟网卡" : win ? "Windows 需要以管理员身份运行本软件" : "需要管理员授权一次，内核才能创建虚拟网卡",
          st.tunPermission
            ? html`<span class="pill ok"><i></i>已授权</span>`
            : html`<button class="btn sm primary" data-action="grant">${icon("shield", 14)}${win ? "以管理员身份重启" : "授权"}</button>`
        )}
        ${sw("tun.enable", "开启虚拟网卡", "接管所有应用的流量；防 WebRTC 泄露必须开启", !st.tunPermission && !s.tun.enable)}
        ${sw("tun.strictRoute", "严格路由", "阻止 Windows 绕过虚拟网卡发出 DNS 查询（最常见的残留 DNS 泄露）。WSL、虚拟机异常时再关闭")}
        ${select("tun.stack", "协议栈", "Mixed 兼容性和性能最均衡", [
          ["mixed", "Mixed"],
          ["gvisor", "gVisor"],
          ["system", "System"],
        ])}
        ${row("DNS 劫持", "逗号分隔，默认 any:53", html`<input data-key="tun.dnsHijack" data-type="list" value="${s.tun.dnsHijack.join(", ")}" />`, "wide-input")}
        ${number("tun.mtu", "MTU", "", 576, 9000)}
        ${st.platform === "linux" ? sw("tun.autoRedirect", "auto-redirect", "Linux 下用 nftables 提升 TCP 性能") : ""}`
      )}

      ${section(
        "leak",
        "防泄露",
        html`
        ${sw("leakGuard.enabled", "启用防泄露", st.extensions.script ? "使用仓库里的 clash-verge-rev/script.js：防 DNS / WebRTC / IPv6 泄露" : "没有找到 script.js")}
        ${lg.enabled
          ? html`
          ${select("leakGuard.webrtc", "WebRTC", "需要开启虚拟网卡", [
            ["follow", "跟随分流（默认）：国外走代理、国内直连"],
            ["strict", "严格：发往国内的 STUN 也走代理"],
            ["reject", "全部拦截：网页音视频通话可能失败"],
            ["off", "不处理"],
          ])}
          ${select("leakGuard.proxyGroup", "境外 DNS 出口", "境外域名的 DNS 查询走哪个分组", groups)}
          ${select("leakGuard.dnsIPv6", "DNS 返回 IPv6", "", [
            ["cn", "只有国内域名（默认）"],
            ["all", "所有域名"],
            ["off", "全部只用 IPv4"],
          ])}
          ${sw("leakGuard.realIPForCN", "国内域名用真实 IP", "国内域名不使用 Fake-IP")}
          ${sw("leakGuard.udpLeakGuard", "UDP 防泄露", "节点不支持 UDP 时拦截会悄悄直连的 QUIC，浏览器自动改走 TCP")}
          ${sw("leakGuard.blockDNSBypass", "拦截国内加密 DNS", "浏览器 / 系统里设置的阿里、腾讯、360 DoH 会绕过代理，拦截后自动回落")}
          ${text("leakGuard.dnsECS", "ECS 网段", "境外 DNS 附带的通用国内网段（不是你的 IP），留空关闭", "223.5.5.0/24")}
          ${text("leakGuard.lanDNS", "局域网 DNS", "解析 router.lan、nas.local 等主机名，填路由器 IP", "192.168.1.1")}
          ${sw("leakGuard.removeInfoNodes", "删除信息节点", "去掉「剩余流量 / 到期时间」这类假节点")}
          <details class="more" ${raw(moreOpen ? "open" : "")}><summary>更多优化（默认关闭，会改变流量走法）</summary>
            ${sw("leakGuard.blockQUIC", "拦截境外 QUIC", "让浏览器回落到 TCP")}
            ${sw("leakGuard.forceUDP", "节点强制开启 UDP", "为 ss / vmess / vless / trojan 等补上 udp: true")}
            ${select("leakGuard.clientFingerprint", "TLS 指纹", "TLS 类节点没有指纹时补上", [
              ["", "不处理"],
              ["chrome", "chrome"],
              ["firefox", "firefox"],
              ["safari", "safari"],
              ["edge", "edge"],
              ["random", "random"],
            ])}
            ${sw("leakGuard.sniffer", "域名嗅探", "应用直接用 IP 连接时也能按域名分流")}
            ${sw("leakGuard.tuneHealthCheck", "统一测速参数", "会改变「自动选择」挑中的节点")}
            ${sw("useMerge", "同时启用 merge.yaml", "一般不需要，script.js 已包含全部功能")}
          </details>`
          : ""}`,
        html`<p class="muted small section-note">参数说明见仓库 README 第六节。${st.core.kind === "singbox" ? "sing-box 下同样生效（由 Knight 转换成等价的规则和 DNS），修改后会重启内核。" : "修改后会重新生成配置并热重载，不会断开内核。"}</p>`
      )}

      ${section(
        "custom",
        "自定义",
        html`
        <div class="set-block">
          <div class="set-text"><span>自定义规则</span><small>每行一条，排在所有规则最前面，例如 DOMAIN-SUFFIX,example.com,DIRECT</small></div>
          <textarea class="code small-code" data-key="customRules" spellcheck="false" placeholder="PROCESS-NAME,Game.exe,DIRECT">${drafts.customRules ?? s.customRules.join("\n")}</textarea>
          <div class="row-actions"><button class="btn sm primary" data-action="save-rules">保存规则</button></div>
        </div>
        <div class="set-block">
          ${row("自定义脚本", "在防泄露脚本之后执行，写法与 Clash Verge Rev 的扩展脚本相同", toggle("customScript.enabled", s.customScript.enabled))}
          ${s.customScript.enabled
            ? html`<textarea class="code" data-key="customScript.code" spellcheck="false">${drafts["customScript.code"] ?? s.customScript.code}</textarea>
              <div class="row-actions"><button class="btn sm primary" data-action="save-script">保存脚本</button></div>`
            : ""}
        </div>
        ${row("运行配置", "查看最终交给内核的配置", html`<button class="btn sm" data-action="runtime">${icon("file", 14)}查看</button>`)}`
      )}

      ${section(
        "app",
        "应用",
        html`
        ${sw("autoLaunch", "开机启动", "")}
        ${sw("silentStart", "静默启动", "启动时不打开窗口，只在托盘显示")}
        ${sw("closeToTray", "关闭窗口时留在托盘", "关闭后内核继续运行；从托盘菜单退出")}
        ${select("theme", "外观", "", [
          ["system", "跟随系统"],
          ["light", "浅色"],
          ["dark", "深色"],
        ])}
        ${sw("updateViaProxy", "订阅经代理更新", "关闭时先直连，失败后自动改走代理")}
        ${text("githubMirror", "GitHub 加速", "下载内核时使用的前缀，例如 https://ghfast.top/，留空直连", "")}
        ${row("数据目录", st.paths.userDir, html`<button class="btn sm" data-action="open-dir">${icon("folder", 14)}打开</button>`)}`
      )}

      <p class="muted small about">Knight ${st.version} · 内核 mihomo（MetaCubeX）与 sing-box（SagerNet）· 防泄露规则来自本仓库 clash-verge-rev/</p>`
    );
  }

  // ---------------- 修改设置 ----------------
  body.addEventListener("change", (e) => {
    const el = e.target;
    const key = el.dataset.key;
    if (!key || key === "customRules" || key === "customScript.code") return;
    let value;
    if (el.type === "checkbox") value = el.checked;
    else if (el.type === "radio") value = el.value;
    else if (el.dataset.type === "number") value = Number(el.value);
    else if (el.dataset.type === "list") value = el.value.split(/[,，\s]+/).filter(Boolean);
    else value = el.value.trim();
    ctx.set(patchOf(key, value)).then(
      () => ctx.toast("已保存", "success"),
      () => render()
    );
  });

  body.addEventListener("input", (e) => {
    const key = e.target.dataset.key;
    if (key === "customRules" || key === "customScript.code") drafts[key] = e.target.value;
  });
  body.addEventListener("toggle", (e) => e.target.matches("details.more") && (moreOpen = e.target.open), true);

  const run = async (label, fn, ok) => {
    try {
      const r = await fn();
      if (ok) ctx.toast(typeof ok === "function" ? ok(r) : ok, "success");
      return r;
    } catch (err) {
      ctx.toast((label ? label + "：" : "") + err.message, "error");
    }
  };

  delegate(body, "click", {
    "copy-cmd": async () => {
      await ctx.invoke("copy", await ctx.invoke("proxyCommand"));
      ctx.toast("已复制到剪贴板", "success");
    },
    grant: async () => {
      if (ctx.state.platform === "win32" && !(await confirm("以管理员身份重启", "Knight 会关闭并以管理员身份重新打开，期间网络会短暂中断。", { ok: "重启" }))) return;
      const ok = await run("授权失败", () => ctx.invoke("grantTun"));
      if (ok) ctx.toast("授权成功，现在可以开启虚拟网卡", "success");
    },
    "save-rules": () => {
      const rules = body.querySelector("[data-key='customRules']").value.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      run("", () => ctx.set({ customRules: rules }).then(() => delete drafts.customRules), "规则已保存并生效");
    },
    "save-script": () =>
      run("", () => ctx.set({ customScript: { code: body.querySelector("[data-key='customScript.code']").value } }).then(() => delete drafts["customScript.code"]), "脚本已保存并生效"),
    runtime: async () => {
      const textValue = await ctx.invoke("runtimeConfig");
      modal({
        title: "运行配置",
        wide: true,
        body: html`<textarea class="code" readonly spellcheck="false">${textValue}</textarea>`,
        actions: [{ label: "复制", onClick: () => ctx.invoke("copy", textValue).then(() => ctx.toast("已复制", "success")) }, { label: "关闭", kind: "primary" }],
      });
    },
    "open-dir": () => ctx.invoke("openPath", "user"),
    restart: async () => {
      coreBusy = "restart";
      render();
      await run("重启失败", () => ctx.invoke("restartCore"), "内核已重启");
      coreBusy = "";
      render();
    },
    "install-core": (el) => {
      const c = ctx.state.cores.find((x) => x.id === el.dataset.id);
      run(`${c.label} 下载失败`, () => ctx.invoke("installCore", c.id), (r) => (r.updated ? `${c.label} 已更新到 ${r.version}` : `${c.label} 已是最新版本 ${r.version}`));
    },
    geo: () => run("更新失败", () => ctx.api.updateGeo(), "GEO 数据已更新"),
    "flush-fakeip": () => run("", () => ctx.api.flushFakeIP(), "已清空 Fake-IP 缓存"),
    "flush-dns": () => run("", () => ctx.api.flushDNS(), "已清空 DNS 缓存"),
    "core-log": async () => {
      const lines = await ctx.invoke("coreLog");
      modal({ title: "内核输出", wide: true, body: html`<textarea class="code" readonly spellcheck="false">${lines.join("\n")}</textarea>`, actions: [{ label: "关闭", kind: "primary" }] });
    },
  });

  const off = ctx.on("state", render);
  render();
  return { unmount: off };
}
