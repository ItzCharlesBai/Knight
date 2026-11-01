// 共享订阅：在局域网里开一个只读的订阅地址，手机、平板上的客户端（Shadowrocket、v2rayNG、Surge、Clash 等）直接订阅，
// 内容就是 Ondine 里的订阅按转换选项处理后的结果，Ondine 这边订阅更新了，那边下次更新时自动同步，不用复制粘贴。
// 地址里带随机令牌，不知道令牌的请求一律 404；只在用户打开后监听
import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { networkInterfaces } from "node:os";
import qrcode from "qrcode-generator";

// 地址后缀 → 转换目标和返回类型
export const SHARE_TARGETS = [
  ["clash", "Clash / mihomo", "text/yaml"],
  ["singbox", "sing-box", "application/json"],
  ["base64", "v2rayN · v2rayNG · Shadowrocket", "text/plain"],
  ["surge", "Surge", "text/plain"],
  ["quanx", "Quantumult X", "text/plain"],
  ["loon", "Loon", "text/plain"],
];

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// 本机的局域网 IPv4 地址，私有网段排前面
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (a.internal || a.address.startsWith("169.254.") || a.address.startsWith("198.18.")) continue;
      out.push(a.address);
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b));
}

export class ShareServer {
  // build(target) → { text, userinfo, name }，每次请求现场生成（读本机已下载的订阅，不联网）
  constructor(build) {
    this.build = build;
    this.server = null;
    this.port = 0;
    this.token = "";
    this.error = "";
    this.hits = 0;
  }

  get running() {
    return !!this.server;
  }

  async start(port, token) {
    this.token = token;
    if (this.server && this.port === port) return;
    await this.stop();
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((err) => {
      this.error = err.code === "EADDRINUSE" ? `端口 ${port} 已被占用` : err.message;
      throw new Error(this.error);
    });
    this.server = server;
    this.port = port;
    this.error = "";
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  handle(req, res) {
    const fail = (code) => {
      res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(code === 404 ? "Not Found" : "Error");
    };
    try {
      const m = /^\/sub\/([0-9a-f]{16,64})\/([a-z0-9]+)\/?$/.exec(new URL(req.url, "http://x").pathname);
      if (req.method !== "GET" || !m || !this.token || !same(m[1], this.token)) return fail(404);
      const target = SHARE_TARGETS.find((t) => t[0] === m[2]);
      if (!target) return fail(404);
      const { text, userinfo, name } = this.build(target[0]);
      this.hits++;
      const headers = {
        "Content-Type": target[2] + "; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(name || "Ondine")}`,
        "profile-update-interval": "6",
      };
      if (userinfo) headers["subscription-userinfo"] = ["upload", "download", "total", "expire"].filter((k) => userinfo[k] !== undefined).map((k) => `${k}=${Math.round(userinfo[k])}`).join("; ");
      res.writeHead(200, headers);
      res.end(text);
    } catch {
      fail(500);
    }
  }
}

// 二维码：返回模块数和一条 SVG 路径（相邻的暗块合成一段，体积小），颜色由界面决定
export function qrPath(text) {
  const qr = qrcode(0, "M");
  // 库按单字节读字符串：先换成 UTF-8 字节，中文、表情也能扫出来
  qr.addData(Buffer.from(String(text), "utf8").toString("latin1"), "Byte");
  qr.make();
  const size = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!qr.isDark(r, c)) continue;
      let len = 1;
      while (c + len < size && qr.isDark(r, c + len)) len++;
      d += `M${c} ${r}h${len}v1h-${len}z`;
      c += len - 1;
    }
  }
  return { size, d };
}
