// 服务器（VPS 管理）：连接自己的 VPS，看运行状况；一键部署 sing-box 服务端，节点自动加进订阅；
// 分享链接和二维码给手机；服务的启停、日志、卸载；简单的终端
import { ago, bytes, confirm, delegate, html, icon, modal, patch, raw } from "../lib.js";
import { qrModal } from "./convert.js";

const SERVICE = { active: ["运行中", "ok"], inactive: ["已停止", ""], failed: ["出错", "bad"], activating: ["启动中", ""] };
const NET = { reality: "TCP", hysteria2: "UDP", tuic: "UDP", anytls: "TCP", ss2022: "TCP+UDP" };

function uptime(s) {
  if (!s) return "";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${Math.floor((s % 3600) / 60)} 分` : `${Math.floor(s / 60)} 分钟`;
}

export default function servers(root, ctx) {
  root.innerHTML = html`
    <header class="page-head"><h1>服务器</h1>
      <div class="head-actions"><button class="btn primary" data-action="add">${icon("plus", 16)}添加服务器</button></div>
    </header>
    <p class="muted small lede">有自己的 VPS？连上就能看运行状况，一键部署 sing-box 服务端（REALITY、Hysteria2、TUIC、AnyTLS、Shadowsocks 2022）。部署好的节点自动加进订阅、和机场一起用，也能生成分享链接和二维码给手机。</p>
    <div id="sv-notice"></div>
    <div class="server-list" id="sv-list"></div>`.s;
  const $ = (id) => root.querySelector("#" + id);
  const find = (id) => ctx.state.servers.find((x) => x.id === id);
  let logView = null; // 正在部署的弹窗：{ id, el }

  function render() {
    const s = ctx.state;
    patch($("sv-notice"), s.vps.secure ? "" : html`<div class="notice">这台电脑的系统钥匙串不可用：服务器密码只在这次运行期间记住，重启 Lily 后要重新输入（私钥文件、SSH agent 不受影响）。</div>`);
    if (!s.servers.length) {
      return patch(
        $("sv-list"),
        html`<div class="empty-art card">
          <div class="empty-title">还没有服务器</div>
          <p class="muted small">需要一台能 SSH 登录的 Linux VPS（Debian、Ubuntu、CentOS、Alpine 都行），用 root 或者有 sudo 权限的用户。</p>
          <button class="btn primary" data-action="add">${icon("plus", 16)}添加服务器</button>
        </div>`
      );
    }
    patch($("sv-list"), html`${s.servers.map(card)}`);
  }

  function card(sv) {
    const i = sv.info;
    const dep = sv.deployment;
    const [label, cls] = SERVICE[i && i.service] || (dep ? ["未知", ""] : ["未部署", "muted-pill"]);
    const used = (t, f) => (t ? Math.min(100, ((t - f) / t) * 100) : 0);
    const gauge = (name, pct, text) =>
      html`<div class="gauge"><span>${name}</span><div class="bar"><i style="width:${pct.toFixed(1)}%" class="${pct > 90 ? "bad" : ""}"></i></div><small>${text}</small></div>`;
    return html`<div class="card server ${sv.busy ? "busy" : ""}" data-id="${sv.id}">
      <div class="server-head">
        <div class="server-title"><b>${sv.name}</b><span class="muted small mono">${sv.username}@${sv.host}${sv.port !== 22 ? ":" + sv.port : ""}</span></div>
        <span class="pill ${cls}"><i></i>${sv.busy ? sv.busy + "中…" : label}</span>
      </div>
      ${i
        ? html`<div class="server-meta">${[i.os || "Linux", i.arch, i.cpus ? i.cpus + " 核" : "", i.virt, i.uptime ? "已运行 " + uptime(i.uptime) : ""].filter(Boolean).join(" · ")}</div>
          <div class="gauges">
            <div class="gauge"><span>负载</span><b>${(i.load || []).map((x) => x.toFixed(2)).join(" ")}</b></div>
            ${gauge("内存", used(i.mem.total, i.mem.free), `${bytes(i.mem.total - i.mem.free)} / ${bytes(i.mem.total)}`)}
            ${gauge("硬盘", used(i.disk.total, i.disk.free), `${bytes(i.disk.total - i.disk.free)} / ${bytes(i.disk.total)}`)}
            <div class="gauge"><span>开机以来流量</span><b>↓ ${bytes(i.net.rx)}　↑ ${bytes(i.net.tx)}</b></div>
            <div class="gauge"><span>拥塞控制</span><b class="${i.bbr ? "good-text" : ""}">${i.bbr ? "BBR" : i.cc || "—"}</b></div>
          </div>
          <div class="muted small">更新于 ${ago(sv.infoAt)}${i.root ? "" : i.sudo === "none" ? " · 这个用户没有 sudo 权限，不能部署" : " · 通过 sudo 管理"}</div>`
        : html`<div class="muted small">还没连接过，点「连接」看看服务器状况。</div>`}
      ${dep
        ? html`<div class="deploy-line">${icon("rocket", 14)}<span>已部署 ${dep.protocols.map((p) => `${(ctx.state.vps.protocols.find((x) => x.id === p.id) || {}).label || p.id} :${p.port}`).join(" · ")}</span><span class="muted small">sing-box ${dep.version || ""} · ${ago(dep.at)}</span></div>`
        : ""}
      ${sv.error ? html`<div class="notice bad small">${sv.error}</div>` : ""}
      <div class="row-actions">
        <button class="btn sm" data-action="refresh" ${raw(sv.busy ? "disabled" : "")}>${icon("refresh", 14)}${i ? "刷新" : "连接"}</button>
        <button class="btn sm primary" data-action="deploy" ${raw(sv.busy ? "disabled" : "")}>${icon("rocket", 14)}${dep ? "重新部署" : "一键部署"}</button>
        ${dep ? html`<button class="btn sm" data-action="nodes">${icon("qr", 14)}节点与二维码</button>` : ""}
        ${dep ? html`<button class="btn sm" data-action="service" ${raw(sv.busy ? "disabled" : "")}>${icon("power", 14)}服务</button>` : ""}
        <button class="btn sm" data-action="terminal" ${raw(sv.busy ? "disabled" : "")}>${icon("terminal", 14)}终端</button>
        <span class="spacer"></span>
        <button class="icon-btn" data-action="edit" title="编辑">${icon("edit", 16)}</button>
        <button class="icon-btn danger" data-action="remove" title="删除">${icon("trash", 16)}</button>
      </div>
    </div>`;
  }

  // 统一处理：指纹变了要用户确认，钥匙串不可用时补密码
  async function call(id, method, ...args) {
    try {
      return await ctx.invoke(method, id, ...args);
    } catch (err) {
      const sv = find(id);
      if (err.message.startsWith("HOSTKEY_CHANGED:")) {
        const fp = err.message.slice("HOSTKEY_CHANGED:".length);
        const ok = await confirm(
          "服务器指纹变了",
          `「${sv.name}」的主机指纹和第一次连接时不一样（现在是 ${fp}）。如果你刚重装过系统或者换了机器，这是正常的；否则可能有人在中间冒充你的服务器，请不要继续。`,
          { danger: true, ok: "我重装过，信任新指纹" }
        );
        if (!ok) throw new Error("已取消：没有信任新指纹");
        await ctx.invoke("vpsTrust", id, fp);
        return ctx.invoke(method, id, ...args);
      }
      if (err.message === "NEED_PASSWORD") {
        const password = await askPassword(sv);
        if (!password) throw new Error("已取消");
        await ctx.invoke("vpsEdit", id, { password });
        return ctx.invoke(method, id, ...args);
      }
      throw err;
    }
  }

  function askPassword(sv) {
    return new Promise((resolve) => {
      modal({
        title: "输入密码",
        body: html`<div class="form"><p class="muted small">${sv.username}@${sv.host} 的登录密码（这次运行期间记住）</p><label>密码<input type="password" name="pw" autocomplete="off" /></label></div>`,
        actions: [
          { label: "取消", onClick: () => resolve("") },
          { label: "连接", kind: "primary", onClick: (m) => resolve(m.find("[name=pw]").value) },
        ],
        onClose: () => resolve(""),
      });
    });
  }

  const run = async (fn, ok) => {
    try {
      const r = await fn();
      if (ok) ctx.toast(typeof ok === "function" ? ok(r) : ok, "success");
      return r;
    } catch (err) {
      if (err.message !== "已取消") ctx.toast(err.message, "error");
      return undefined;
    }
  };

  // ---------------- 添加 / 编辑 ----------------
  function editor(sv) {
    const v = sv || { name: "", host: "", port: 22, username: "root", auth: "password", keyFile: "", viaProxy: false };
    const m = modal({
      title: sv ? "编辑服务器" : "添加服务器",
      wide: true,
      body: html`<div class="form">
        <div class="field-row">
          <label>名称<input name="name" value="${v.name}" placeholder="比如 东京 · 搬瓦工" /></label>
          <label>地址（IP 或域名）<input name="host" value="${v.host}" placeholder="203.0.113.7" autocomplete="off" /></label>
        </div>
        <div class="field-row">
          <label>SSH 端口<input name="port" type="number" min="1" max="65535" value="${v.port}" /></label>
          <label>用户名<input name="username" value="${v.username}" autocomplete="off" /></label>
          <label>登录方式<select name="auth">${[
            ["password", "密码"],
            ["key", "私钥"],
            ["agent", "SSH agent"],
          ].map(([id, t]) => html`<option value="${id}" ${raw(v.auth === id ? "selected" : "")}>${t}</option>`)}</select></label>
        </div>
        <div class="auth-password"><label>密码<input name="password" type="password" autocomplete="off" placeholder="${sv && sv.hasSecret ? "不改就留空" : ""}" /></label></div>
        <div class="auth-key">
          <label>私钥（粘贴，或者选一个私钥文件）<textarea name="privateKey" class="code small-code" spellcheck="false" placeholder="${sv && sv.hasSecret ? "不改就留空" : "-----BEGIN OPENSSH PRIVATE KEY-----"}"></textarea></label>
          <div class="field-row">
            <label>私钥文件<span class="input-with-btn"><input name="keyFile" value="${v.keyFile || ""}" placeholder="~/.ssh/id_ed25519" /><button type="button" class="btn sm" data-pick>选择</button></span></label>
            <label>私钥口令（没有就留空）<input name="passphrase" type="password" autocomplete="off" /></label>
          </div>
        </div>
        <label class="checks-inline"><span><input type="checkbox" name="viaProxy" ${raw(v.viaProxy ? "checked" : "")} /> 经本机代理连接（直连 SSH 被阻断时打开，需要内核在运行）</span></label>
        <p class="muted small">第一次连接时会记住服务器的指纹，之后指纹变了会提醒你。密码和私钥用系统钥匙串加密保存在本机。</p>
      </div>`,
      actions: [
        { label: "取消" },
        {
          label: sv ? "保存" : "添加并连接",
          kind: "primary",
          onClick: async (mm) => {
            const val = (n) => (mm.find(`[name=${n}]`) || {}).value;
            const input = { name: val("name"), host: val("host"), port: Number(val("port")), username: val("username"), auth: val("auth"), password: val("password"), privateKey: val("privateKey"), keyFile: val("keyFile"), passphrase: val("passphrase"), viaProxy: mm.find("[name=viaProxy]").checked };
            if (sv) {
              await ctx.invoke("vpsEdit", sv.id, input);
              ctx.toast("已保存", "success");
            } else {
              const { id } = await ctx.invoke("vpsAdd", input);
              ctx.toast("已添加，正在连接…", "success");
              run(() => call(id, "vpsRefresh"), "连接成功，已记住服务器指纹");
            }
          },
        },
      ],
    });
    const sync = () => {
      const auth = m.find("[name=auth]").value;
      m.find(".auth-password").hidden = auth !== "password";
      m.find(".auth-key").hidden = auth !== "key";
    };
    m.find("[name=auth]").addEventListener("change", sync);
    m.find("[data-pick]").addEventListener("click", async () => {
      const file = await ctx.invoke("pickKeyFile");
      if (file) m.find("[name=keyFile]").value = file;
    });
    sync();
  }

  // ---------------- 部署 ----------------
  function deployDialog(sv) {
    const old = sv.deployment;
    const vps = ctx.state.vps;
    const chosen = (id) => (old ? old.protocols.some((p) => p.id === id) : id !== "ss2022");
    const portOf = (p) => (old && (old.protocols.find((x) => x.id === p.id) || {}).port) || p.port || "";
    const m = modal({
      title: (old ? "重新部署 · " : "一键部署 · ") + sv.name,
      wide: true,
      body: html`<div class="form deploy-form">
        <div class="proto-list">${vps.protocols.map(
          (p) => html`<label class="proto-row"><input type="checkbox" name="p-${p.id}" ${raw(chosen(p.id) ? "checked" : "")} />
            <span class="proto-text"><b>${p.label}</b><small>${p.desc}</small></span>
            <span class="proto-port"><input type="number" name="port-${p.id}" min="1" max="65535" value="${portOf(p)}" placeholder="随机" /><small>${NET[p.id]}</small></span></label>`
        )}</div>
        <div class="field-row">
          <label>REALITY 伪装网站<select name="target">${vps.targets.map((t) => html`<option ${raw(((old && old.reality && old.reality.target) || vps.targets[0]) === t ? "selected" : "")}>${t}</option>`)}</select></label>
          <label>节点地址（默认就是服务器地址；有域名可以填域名）<input name="address" value="${(old && old.address) || ""}" placeholder="${sv.host}" /></label>
        </div>
        <div class="checks-inline">
          <label><input type="checkbox" name="bbr" ${raw(!old || old.bbr !== false ? "checked" : "")} />开启 BBR 加速</label>
          <label><input type="checkbox" name="firewall" checked />放行服务器防火墙端口</label>
          <label><input type="checkbox" name="addProfile" checked />节点加进订阅，和其他订阅一起用</label>
        </div>
        <p class="muted small">${old ? "重新部署会沿用原来的密钥和证书，已经分发出去的节点不用换。" : "密钥和证书在本机生成，经 SSH 写到服务器上。"}云服务商控制台里的安全组（阿里云、腾讯云、AWS、Oracle 等）要你自己放行这些端口。</p>
        <ol class="deploy-log" hidden></ol>
      </div>`,
      actions: [
        { label: "关闭" },
        {
          label: old ? "重新部署" : "开始部署",
          kind: "primary",
          onClick: async (mm) => {
            const protocols = vps.protocols.filter((p) => mm.find(`[name=p-${p.id}]`).checked).map((p) => ({ id: p.id, port: Number(mm.find(`[name=port-${p.id}]`).value) || 0 }));
            const plan = {
              protocols,
              realityTarget: mm.find("[name=target]").value,
              address: mm.find("[name=address]").value.trim(),
              bbr: mm.find("[name=bbr]").checked,
              firewall: mm.find("[name=firewall]").checked,
              addProfile: mm.find("[name=addProfile]").checked,
            };
            const list = mm.find(".deploy-log");
            list.hidden = false;
            list.innerHTML = "";
            logView = { id: sv.id, el: list };
            mm.el.querySelectorAll(".deploy-form input, .deploy-form select").forEach((x) => (x.disabled = true));
            try {
              const result = await call(sv.id, "vpsDeploy", plan);
              ctx.toast("部署完成", "success");
              mm.close();
              nodesDialog(find(sv.id) || sv, result);
            } finally {
              logView = null;
              mm.el.querySelectorAll(".deploy-form input, .deploy-form select").forEach((x) => (x.disabled = false));
            }
            return false;
          },
        },
      ],
    });
    return m;
  }

  // 部署进度
  const offVps = ctx.on("vps", (msg) => {
    if (!logView || msg.id !== logView.id) return;
    const li = document.createElement("li");
    li.className = msg.kind;
    li.textContent = msg.text;
    logView.el.appendChild(li);
    logView.el.scrollTop = logView.el.scrollHeight;
  });

  // ---------------- 节点与二维码 ----------------
  async function nodesDialog(sv, data) {
    const { links, profileId } = data || (await ctx.invoke("vpsNodes", sv.id));
    const qrs = await Promise.all(links.map((l) => ctx.invoke("qr", l.link)));
    const all = links.map((l) => l.link).join("\n");
    modal({
      title: "节点 · " + sv.name,
      wide: true,
      body: html`<p class="muted small">手机上的 Shadowrocket、v2rayNG、NekoBox、Clash Meta 等扫码就能添加；${profileId ? "这些节点已经在 Lily 的订阅里。" : "也可以点「加进订阅」在 Lily 里直接用。"}</p>
        <div class="node-qr-grid">${links.map(
          (l, i) => html`<figure class="node-qr">
            <svg viewBox="-2 -2 ${qrs[i].size + 4} ${qrs[i].size + 4}" shape-rendering="crispEdges"><rect x="-2" y="-2" width="${qrs[i].size + 4}" height="${qrs[i].size + 4}" class="qr-bg" /><path d="${qrs[i].d}" class="qr-ink" /></svg>
            <figcaption><b>${l.name}</b><span class="row-actions"><button class="btn sm" data-copy="${i}">${icon("copy", 13)}复制链接</button><button class="btn sm" data-big="${i}">${icon("qr", 13)}放大</button></span></figcaption>
          </figure>`
        )}</div>`,
      actions: [
        ...(profileId ? [] : [{ label: "加进订阅", onClick: () => ctx.invoke("vpsProfile", sv.id).then(() => ctx.toast("已加进订阅并同时使用", "success")) }]),
        { label: "复制全部链接", onClick: () => ctx.invoke("copy", all).then(() => (ctx.toast("已复制 " + links.length + " 条链接", "success"), false)) },
        { label: "关闭", kind: "primary" },
      ],
      onMount: (mm) =>
        mm.el.addEventListener("click", (e) => {
          const c = e.target.closest("[data-copy]");
          const b = e.target.closest("[data-big]");
          if (c) ctx.invoke("copy", links[Number(c.dataset.copy)].link).then(() => ctx.toast("已复制", "success"));
          if (b) qrModal(ctx, links[Number(b.dataset.big)].name, links[Number(b.dataset.big)].link);
        }),
    });
  }

  // ---------------- 服务 ----------------
  function serviceDialog(sv) {
    const m = modal({
      title: "服务 · " + sv.name,
      wide: true,
      body: html`<div class="row-actions">
          <button class="btn sm" data-svc="restart">${icon("refresh", 14)}重启</button>
          <button class="btn sm" data-svc="stop">${icon("pause", 14)}停止</button>
          <button class="btn sm" data-svc="start">${icon("play", 14)}启动</button>
          <button class="btn sm" data-svc="logs">${icon("terminal", 14)}查看日志</button>
          <span class="spacer"></span>
          <button class="btn sm danger" data-svc="uninstall">${icon("trash", 14)}卸载</button>
        </div>
        <textarea class="code" readonly spellcheck="false" placeholder="服务运行在 systemd（或 Alpine 的 OpenRC）下，名字是 lily；日志会显示在这里"></textarea>`,
      actions: [{ label: "关闭", kind: "primary" }],
      onMount: (mm) =>
        mm.el.addEventListener("click", async (e) => {
          const btn = e.target.closest("[data-svc]");
          if (!btn) return;
          const action = btn.dataset.svc;
          if (action === "uninstall") {
            const ok = await confirm("卸载服务端", `从「${sv.name}」上删掉 Lily 部署的 sing-box、配置和服务，收回放行的端口。已经分发出去的节点会失效。`, { danger: true, ok: "卸载" });
            if (!ok) return;
          }
          btn.disabled = true;
          const out = await run(() => call(sv.id, "vpsService", action), { start: "已启动", stop: "已停止", restart: "已重启", uninstall: "已卸载" }[action]);
          btn.disabled = false;
          if (out !== undefined) mm.find("textarea").value = out || "（没有输出）";
          if (action === "uninstall" && out !== undefined) mm.close();
        }),
    });
    return m;
  }

  // ---------------- 终端 ----------------
  function terminalDialog(sv) {
    const QUICK = [
      ["系统负载", "uptime"],
      ["监听端口", "ss -lntup 2>/dev/null || netstat -lntup"],
      ["连接统计", "ss -s 2>/dev/null || netstat -s | head -n 30"],
      ["磁盘", "df -h"],
      ["内存", "free -h"],
      ["服务状态", "systemctl status lily --no-pager 2>/dev/null || rc-service lily status"],
    ];
    const m = modal({
      title: "终端 · " + sv.name,
      wide: true,
      body: html`<div class="chips quick">${QUICK.map(([t, c]) => html`<button class="chip" data-cmd="${c}">${t}</button>`)}</div>
        <form class="term-line"><span class="mono muted">${sv.username}@${sv.host} $</span><input name="cmd" spellcheck="false" autocomplete="off" placeholder="输入命令后回车（以登录用户执行，120 秒超时）" /></form>
        <pre class="term-out"></pre>`,
      actions: [{ label: "关闭", kind: "primary" }],
      onMount: (mm) => {
        const out = mm.find(".term-out");
        const exec = async (cmd) => {
          const head = document.createElement("div");
          head.className = "term-cmd";
          head.textContent = "$ " + cmd;
          out.appendChild(head);
          const r = await run(() => call(sv.id, "vpsRun", cmd));
          const body = document.createElement("div");
          body.textContent = r ? (r.out + r.err).replace(/\s+$/, "") + (r.code ? `\n（退出码 ${r.code}）` : "") : "（失败）";
          if (r && r.code) body.className = "bad-text";
          out.appendChild(body);
          out.scrollTop = out.scrollHeight;
        };
        mm.find(".term-line").addEventListener("submit", (e) => {
          e.preventDefault();
          const input = mm.find("[name=cmd]");
          const cmd = input.value.trim();
          if (cmd) exec(cmd);
          input.value = "";
        });
        mm.el.addEventListener("click", (e) => {
          const b = e.target.closest("[data-cmd]");
          if (b) exec(b.dataset.cmd);
        });
      },
    });
    return m;
  }

  delegate(root, "click", {
    add: () => editor(null),
    refresh: (el) => {
      const id = el.closest("[data-id]").dataset.id;
      run(() => call(id, "vpsRefresh"));
    },
    deploy: (el) => {
      const sv = find(el.closest("[data-id]").dataset.id);
      if (sv.info && !sv.info.root && sv.info.sudo === "none") return ctx.toast("这个用户没有 sudo 权限，请改用 root 登录", "error");
      deployDialog(sv);
    },
    nodes: (el) => nodesDialog(find(el.closest("[data-id]").dataset.id)).catch((err) => ctx.toast(err.message, "error")),
    service: (el) => serviceDialog(find(el.closest("[data-id]").dataset.id)),
    terminal: (el) => terminalDialog(find(el.closest("[data-id]").dataset.id)),
    edit: (el) => editor(find(el.closest("[data-id]").dataset.id)),
    remove: async (el) => {
      const sv = find(el.closest("[data-id]").dataset.id);
      const withProfile = !!sv.profileId;
      const ok = await confirm("删除服务器", `从 Lily 里删掉「${sv.name}」${withProfile ? "，连同它的订阅" : ""}？服务器上已经部署的服务不受影响（要停用请先在「服务」里卸载）。`, { danger: true, ok: "删除" });
      if (ok) run(() => ctx.invoke("vpsRemove", sv.id, { profile: withProfile }), "已删除");
    },
  });

  const off = ctx.on("state", render);
  render();
  // 打开页面时顺便刷新一下连过的服务器（只在有凭据时）
  for (const sv of ctx.state.servers) if (sv.info && (sv.hasSecret || sv.auth !== "password") && Date.now() - (sv.infoAt || 0) > 60000) ctx.invoke("vpsRefresh", sv.id).catch(() => {});
  return {
    unmount() {
      off();
      offVps();
    },
  };
}
