// VPS 一键部署（纯函数，不碰网络）：生成密钥、自签证书、sing-box 服务端配置、部署 / 卸载 / 服务控制脚本，
// 以及客户端节点和分享链接。脚本经 SSH 标准输入交给 sh 执行，不落盘；只用 POSIX sh，Debian / Ubuntu / CentOS / Alpine 通用
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { toLink } from "./links.js";

export const SINGBOX_SERVER_VERSION = "1.14.4"; // 拿不到最新版本号时用这个

// 可部署的协议：net 决定防火墙放行 TCP 还是 UDP
export const PROTOCOLS = [
  { id: "reality", label: "VLESS REALITY", net: ["tcp"], port: 443, desc: "抗封锁首选：外形和访问大网站一样，不需要域名和证书" },
  { id: "hysteria2", label: "Hysteria2", net: ["udp"], port: 8443, desc: "基于 QUIC，丢包多、晚高峰的线路也跑得快" },
  { id: "tuic", label: "TUIC v5", net: ["udp"], port: 9443, desc: "基于 QUIC，延迟低，适合游戏和语音" },
  { id: "anytls", label: "AnyTLS", net: ["tcp"], port: 8444, desc: "普通 TLS 外形，能对付按流量特征识别" },
  { id: "ss2022", label: "Shadowsocks 2022", net: ["tcp", "udp"], port: 0, desc: "简单轻量，适合中转或当备用" },
];
export const REALITY_TARGETS = ["www.microsoft.com", "addons.mozilla.org", "www.apple.com", "gateway.icloud.com", "www.lovelive-anime.jp"];
const TLS_NAME = "www.bing.com";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = (n = 16) => b64url(randomBytes(n));
const randomPort = () => 20000 + (randomBytes(2).readUInt16BE(0) % 40000);

// REALITY 用的 X25519 密钥对（和 sing-box generate reality-keypair 一样是 base64url 原始 32 字节）
export function realityKeypair() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateKey: privateKey.export({ format: "jwk" }).d, publicKey: publicKey.export({ format: "jwk" }).x };
}

// ---------------- 自签证书（ECDSA P-256，DER 手工编码，不依赖服务器上的 openssl）----------------
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const n = body.length;
  const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p) => der(0x30, ...p);
function oid(text) {
  const [a, b, ...rest] = text.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (const v of rest) {
    const chunk = [v & 127];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 127) | 128);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
const utf8 = (s) => der(0x0c, Buffer.from(s, "utf8"));
const utcTime = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const name = (cn) => seq(der(0x31, seq(oid("2.5.4.3"), utf8(cn))));

export function selfSignedCert(host = TLS_NAME, years = 10) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = randomBytes(16);
  serial[0] &= 0x7f; // 正整数
  const algo = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const from = new Date(Date.now() - 86400000);
  const to = new Date(from.getTime() + years * 365 * 86400000);
  const san = seq(oid("2.5.29.17"), der(0x04, seq(der(0x82, Buffer.from(host)))));
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    algo,
    name(host),
    seq(utcTime(from), utcTime(to)),
    name(host),
    publicKey.export({ type: "spki", format: "der" }),
    der(0xa3, seq(san))
  );
  const signature = sign("sha256", tbs, privateKey);
  const cert = seq(tbs, algo, der(0x03, Buffer.from([0]), signature));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }), sha256: createHash("sha256").update(cert).digest("hex") };
}

// ---------------- 部署方案 ----------------
// plan：{ protocols: [{ id, port }], address, tlsName, realityTarget, bbr, firewall }
// previous：上次的部署（重新部署时沿用密钥和证书，已经分发出去的节点不用换）
export function prepare(plan, previous = null) {
  const prev = previous || {};
  const old = prev.secrets || {};
  const list = (plan.protocols || []).filter((p) => PROTOCOLS.some((x) => x.id === p.id));
  if (!list.length) throw new Error("至少选一个协议");
  const used = new Set();
  const protocols = list.map((p) => {
    let port = Number(p.port) || randomPort();
    if (port < 1 || port > 65535) throw new Error(`端口不对：${p.port}`);
    const def = PROTOCOLS.find((x) => x.id === p.id);
    for (const net of def.net) {
      if (used.has(port + "/" + net)) throw new Error(`端口 ${port} 重复了`);
      used.add(port + "/" + net);
    }
    return { id: p.id, port };
  });
  const tlsName = String(plan.tlsName || prev.tlsName || TLS_NAME).trim();
  const needCert = protocols.some((p) => p.id !== "reality" && p.id !== "ss2022");
  const keepCert = prev.cert && prev.tlsName === tlsName;
  const realityTarget = String(plan.realityTarget || (prev.reality || {}).target || REALITY_TARGETS[0]).trim();
  if (!/^[a-z0-9.-]+$/i.test(realityTarget) || !/^[a-z0-9.-]+$/i.test(tlsName)) throw new Error("域名格式不对");
  return {
    address: String(plan.address || "").trim(),
    tlsName,
    bbr: plan.bbr !== false,
    firewall: plan.firewall !== false,
    protocols,
    reality: protocols.some((p) => p.id === "reality")
      ? Object.assign({ target: realityTarget, shortId: (prev.reality || {}).shortId || randomBytes(4).toString("hex") }, prev.reality && prev.reality.privateKey ? { privateKey: prev.reality.privateKey, publicKey: prev.reality.publicKey } : realityKeypair())
      : prev.reality || null,
    cert: needCert ? (keepCert ? prev.cert : selfSignedCert(tlsName)) : prev.cert || null,
    secrets: {
      uuid: old.uuid || randomUUID(),
      hysteria2: old.hysteria2 || token(),
      tuic: old.tuic || token(),
      anytls: old.anytls || token(),
      ss2022: old.ss2022 || randomBytes(16).toString("base64"),
    },
  };
}

// sing-box 服务端配置
export function serverConfig(dep, { certPath = "/etc/ondine/cert.pem", keyPath = "/etc/ondine/key.pem" } = {}) {
  const s = dep.secrets;
  const tls = (alpn) => Object.assign({ enabled: true, server_name: dep.tlsName, certificate_path: certPath, key_path: keyPath }, alpn ? { alpn } : {});
  const inbounds = dep.protocols.map(({ id, port }) => {
    const base = { tag: id, listen: "::", listen_port: port };
    if (id === "reality")
      return Object.assign({ type: "vless" }, base, {
        users: [{ name: "ondine", uuid: s.uuid, flow: "xtls-rprx-vision" }],
        tls: {
          enabled: true,
          server_name: dep.reality.target,
          reality: { enabled: true, handshake: { server: dep.reality.target, server_port: 443 }, private_key: dep.reality.privateKey, short_id: [dep.reality.shortId] },
        },
      });
    if (id === "hysteria2") return Object.assign({ type: "hysteria2" }, base, { users: [{ name: "ondine", password: s.hysteria2 }], masquerade: "https://" + dep.tlsName, tls: tls(["h3"]) });
    if (id === "tuic") return Object.assign({ type: "tuic" }, base, { users: [{ name: "ondine", uuid: s.uuid, password: s.tuic }], congestion_control: "bbr", tls: tls(["h3"]) });
    if (id === "anytls") return Object.assign({ type: "anytls" }, base, { users: [{ name: "ondine", password: s.anytls }], tls: tls() });
    return Object.assign({ type: "shadowsocks" }, base, { method: "2022-blake3-aes-128-gcm", password: s.ss2022 });
  });
  return {
    log: { level: "warn", timestamp: true },
    dns: { servers: [{ type: "local", tag: "local" }] },
    inbounds,
    outbounds: [{ type: "direct", tag: "direct" }],
    // 不让客户端借服务器访问它所在的内网
    route: { rules: [{ ip_is_private: true, action: "reject" }], final: "direct", default_domain_resolver: "local" },
  };
}

// 防火墙要放行的端口：["443/tcp", "8443/udp", …]
export const portList = (dep) => dep.protocols.flatMap((p) => PROTOCOLS.find((x) => x.id === p.id).net.map((n) => `${p.port}/${n}`));

// 客户端节点（mihomo 格式）：自签证书的协议跳过 CA 校验，但固定证书指纹，中间人换不了证书
export function clientNodes(dep, label, host) {
  const server = dep.address || host;
  const s = dep.secrets;
  const fp = dep.cert ? dep.cert.sha256 : undefined;
  const pinned = (n) => Object.assign(n, { "skip-cert-verify": true }, fp ? { fingerprint: fp } : {});
  return dep.protocols.map(({ id, port }) => {
    const name = `${label} · ${PROTOCOLS.find((x) => x.id === id).label}`;
    if (id === "reality")
      return { name, type: "vless", server, port, uuid: s.uuid, udp: true, tls: true, flow: "xtls-rprx-vision", servername: dep.reality.target, "client-fingerprint": "chrome", "reality-opts": { "public-key": dep.reality.publicKey, "short-id": dep.reality.shortId } };
    if (id === "hysteria2") return pinned({ name, type: "hysteria2", server, port, password: s.hysteria2, sni: dep.tlsName, alpn: ["h3"] });
    if (id === "tuic") return pinned({ name, type: "tuic", server, port, uuid: s.uuid, password: s.tuic, sni: dep.tlsName, alpn: ["h3"], "congestion-controller": "bbr", "udp-relay-mode": "native" });
    if (id === "anytls") return pinned({ name, type: "anytls", server, port, password: s.anytls, sni: dep.tlsName, "client-fingerprint": "chrome", udp: true });
    return { name, type: "ss", server, port, cipher: "2022-blake3-aes-128-gcm", password: s.ss2022, udp: true };
  });
}

export const shareLinks = (nodes) => nodes.map((n) => ({ name: n.name, type: n.type, link: toLink(n) })).filter((x) => x.link);

// ---------------- 脚本 ----------------
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// 脚本模板里不用 ${…} 形式的 shell 变量，占位符 __X__ 统一替换
const fill = (text, values) => text.replace(/__([A-Z_]+)__/g, (m, k) => (k in values ? values[k] : m));
const heredoc = (file, text) => `cat > ${file} <<'ONDINE_EOF'\n${String(text).replace(/\n?$/, "\n")}ONDINE_EOF`;

const COMMON = String.raw`PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
say() { printf '@@ONDINE %s\n' "$*"; }
die() { say error "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "需要 root 权限"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then INIT=systemd
elif command -v rc-service >/dev/null 2>&1; then INIT=openrc
else INIT=none; fi`;

const SYSTEMD_UNIT = `[Unit]
Description=Ondine proxy server (sing-box)
After=network-online.target nss-lookup.target
Wants=network-online.target

[Service]
User=ondine
Group=__GROUP__
ExecStart=/usr/local/lib/ondine/sing-box run -c /etc/ondine/config.json -D /var/lib/ondine --disable-color
StateDirectory=ondine
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target`;

// OpenRC（Alpine）：端口都在 1024 以上时用 ondine 用户运行，否则只能用 root 绑定低端口
const openrcScript = (asUser) => `#!/sbin/openrc-run
name="ondine"
description="Ondine proxy server (sing-box)"
command="/usr/local/lib/ondine/sing-box"
command_args="run -c /etc/ondine/config.json -D /var/lib/ondine --disable-color"
${asUser ? 'command_user="ondine"\n' : ""}command_background=true
pidfile="/run/ondine.pid"
output_log="/var/log/ondine.log"
error_log="/var/log/ondine.log"
depend() {
  need net
  after firewall
}
start_pre() {
  checkpath -d -o ondine /var/lib/ondine
  checkpath -f -o ondine /var/log/ondine.log
}`;

// upload：{ path, sha256 } 服务器下载不了 sing-box 时，由客户端先传上去
export function deployScript(dep, { version = SINGBOX_SERVER_VERSION, mirror = "", upload = null } = {}) {
  version = String(version).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) throw new Error("sing-box 版本号不对：" + version);
  if (mirror && !/^https:\/\/[\w.-]+(:\d+)?\/[\w./-]*$/.test(mirror)) throw new Error("GitHub 加速地址不对");
  const ports = portList(dep);
  const lowPort = dep.protocols.some((p) => p.port < 1024);
  const body = String.raw`${COMMON}
[ "$(uname -s)" = Linux ] || die "只支持 Linux 服务器"
[ "$INIT" != none ] || die "没有 systemd 或 OpenRC，装不了系统服务"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv7*) ARCH=armv7 ;;
  i386|i686) ARCH=386 ;;
  s390x) ARCH=s390x ;;
  riscv64) ARCH=riscv64 ;;
  *) die "不支持的处理器架构：$(uname -m)" ;;
esac
say arch "$ARCH"

say step "检查 sing-box"
VER=__VER__
BIN=/usr/local/lib/ondine/sing-box
mkdir -p /usr/local/lib/ondine
if [ -x "$BIN" ] && "$BIN" version 2>/dev/null | head -n 1 | grep -qx "sing-box version $VER"; then
  say step "sing-box $VER 已经装好"
else
  TMP=$(mktemp -d)
  PKG="sing-box-$VER-linux-$ARCH"
  UPLOAD=__UPLOAD__
  if [ -n "$UPLOAD" ] && [ -f "$UPLOAD" ]; then
    if command -v sha256sum >/dev/null 2>&1 && [ "$(sha256sum "$UPLOAD" | cut -d' ' -f1)" != __UPLOAD_SHA__ ]; then rm -f "$UPLOAD"; die "上传的 sing-box 校验不通过"; fi
    mv -f "$UPLOAD" "$TMP/sb.tgz"
  else
    say step "下载 sing-box $VER"
    URL=__MIRROR__"https://github.com/SagerNet/sing-box/releases/download/v$VER/$PKG.tar.gz"
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 15 --retry 2 -o "$TMP/sb.tgz" "$URL" || rm -f "$TMP/sb.tgz"
    elif command -v wget >/dev/null 2>&1; then wget -q -T 30 -O "$TMP/sb.tgz" "$URL" || rm -f "$TMP/sb.tgz"
    fi
  fi
  if [ ! -s "$TMP/sb.tgz" ]; then rm -rf "$TMP"; say need-upload "$ARCH"; exit 3; fi
  tar -xzf "$TMP/sb.tgz" -C "$TMP" || { rm -rf "$TMP"; die "解压 sing-box 失败"; }
  install -m 755 "$TMP/$PKG/sing-box" "$BIN.new" && mv -f "$BIN.new" "$BIN" || { rm -rf "$TMP"; die "安装 sing-box 失败"; }
  rm -rf "$TMP"
fi

say step "写入配置"
if ! id ondine >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir /var/lib/ondine --shell /usr/sbin/nologin ondine 2>/dev/null || useradd -r -M -s /sbin/nologin ondine 2>/dev/null
  else
    addgroup -S ondine 2>/dev/null; adduser -S -D -H -G ondine -s /sbin/nologin ondine 2>/dev/null
  fi
fi
id ondine >/dev/null 2>&1 || die "创建用户 ondine 失败"
GROUP=$(id -gn ondine)
mkdir -p /etc/ondine /var/lib/ondine
chown root:"$GROUP" /etc/ondine && chmod 750 /etc/ondine
chown ondine:"$GROUP" /var/lib/ondine
umask 027
__FILES__
printf '%s\n' __PORTS__ > /etc/ondine/ports
chown root:"$GROUP" /etc/ondine/*
chmod 640 /etc/ondine/*
[ -f /etc/ondine/cert.pem ] && chmod 644 /etc/ondine/cert.pem
OUT=$("$BIN" check -c /etc/ondine/config.json.new 2>&1) || { rm -f /etc/ondine/config.json.new; die "配置校验失败：$OUT"; }

say step "检查端口"
# 端口被别的程序占着（sing-box 自己的不算，重新部署时旧服务还在运行）
listening() {
  if command -v ss >/dev/null 2>&1; then
    if [ "$2" = tcp ]; then ss -Hltnp 2>/dev/null; else ss -Hlunp 2>/dev/null; fi | grep -v '"sing-box"' | awk '{print $4}' | grep -Eq "[:.]$1$"
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lnp 2>/dev/null | grep -i "^$2" | grep -v '/sing-box' | awk '{print $4}' | grep -Eq "[:.]$1$"
  else
    return 1
  fi
}
for P in __PORTS__; do
  N=$(echo "$P" | cut -d/ -f1); T=$(echo "$P" | cut -d/ -f2)
  if listening "$N" "$T"; then rm -f /etc/ondine/config.json.new; die "端口 $N（$T）已经被别的程序占用，换一个端口再试"; fi
done
mv -f /etc/ondine/config.json.new /etc/ondine/config.json

if [ __FIREWALL__ = 1 ]; then
  say step "放行防火墙端口"
  FWR=0; SAVE=0
  for P in __PORTS__; do
    N=$(echo "$P" | cut -d/ -f1); T=$(echo "$P" | cut -d/ -f2)
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow "$N/$T" >/dev/null 2>&1; fi
    if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then firewall-cmd --permanent --add-port="$N/$T" >/dev/null 2>&1; FWR=1; fi
    for IPT in iptables ip6tables; do
      if command -v $IPT >/dev/null 2>&1 && $IPT -S INPUT 2>/dev/null | grep -Eq -- '-P INPUT DROP|-j (REJECT|DROP)'; then
        $IPT -C INPUT -p "$T" --dport "$N" -j ACCEPT 2>/dev/null || $IPT -I INPUT -p "$T" --dport "$N" -j ACCEPT 2>/dev/null
        SAVE=1
      fi
    done
  done
  [ "$FWR" = 1 ] && firewall-cmd --reload >/dev/null 2>&1
  if [ "$SAVE" = 1 ]; then
    if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1
    elif [ -d /etc/iptables ]; then iptables-save > /etc/iptables/rules.v4 2>/dev/null; ip6tables-save > /etc/iptables/rules.v6 2>/dev/null
    fi
  fi
fi

if [ __BBR__ = 1 ]; then
  say step "开启 BBR"
  if [ "$(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null)" = bbr ]; then
    say bbr on
  elif grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control 2>/dev/null || modprobe tcp_bbr 2>/dev/null; then
    printf 'net.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n' > /etc/sysctl.d/99-ondine-bbr.conf
    sysctl -p /etc/sysctl.d/99-ondine-bbr.conf >/dev/null 2>&1
    if [ "$(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null)" = bbr ]; then say bbr on; else say warn "BBR 没能开启（容器类 VPS 通常不允许改内核参数）"; fi
  else
    say warn "这台服务器的内核不支持 BBR"
  fi
fi

say step "启动服务"
if [ "$INIT" = systemd ]; then
__SYSTEMD__
  sed -i "s/__GROUP__/$GROUP/" /etc/systemd/system/ondine.service
  systemctl daemon-reload && systemctl enable ondine >/dev/null 2>&1 && systemctl restart ondine || die "启动服务失败"
  sleep 2
  systemctl is-active --quiet ondine || die "服务没有跑起来：$(journalctl -u ondine -n 8 --no-pager 2>/dev/null | tail -n 4)"
else
__OPENRC__
  chmod 755 /etc/init.d/ondine
  rc-update add ondine default >/dev/null 2>&1
  rc-service ondine restart >/dev/null 2>&1 || die "启动服务失败：$(tail -n 4 /var/log/ondine.log 2>/dev/null)"
fi
say done "$("$BIN" version 2>/dev/null | head -n 1)"
`;
  const files = [heredoc("/etc/ondine/config.json.new", JSON.stringify(serverConfig(dep), null, 2))];
  if (dep.cert) files.push(heredoc("/etc/ondine/cert.pem", dep.cert.cert), heredoc("/etc/ondine/key.pem", dep.cert.key));
  return fill(body, {
    VER: version,
    UPLOAD: upload ? q(upload.path) : "''",
    UPLOAD_SHA: upload ? q(upload.sha256) : "''",
    MIRROR: q(mirror || ""),
    FILES: files.join("\n"),
    PORTS: ports.join(" "),
    FIREWALL: dep.firewall ? "1" : "0",
    BBR: dep.bbr ? "1" : "0",
    SYSTEMD: heredoc("/etc/systemd/system/ondine.service", SYSTEMD_UNIT),
    OPENRC: heredoc("/etc/init.d/ondine", openrcScript(!lowPort)),
  });
}

// 卸载：停服务、删文件和用户、收回放行的端口（BBR 设置保留，对别的程序也有好处）
export const uninstallScript = () => String.raw`${COMMON}
say step "停止服务"
if [ "$INIT" = systemd ]; then
  systemctl disable --now ondine >/dev/null 2>&1; rm -f /etc/systemd/system/ondine.service; systemctl daemon-reload
elif [ "$INIT" = openrc ]; then
  rc-service ondine stop >/dev/null 2>&1; rc-update del ondine default >/dev/null 2>&1; rm -f /etc/init.d/ondine
fi
if [ -f /etc/ondine/ports ]; then
  say step "收回防火墙端口"
  for P in $(cat /etc/ondine/ports); do
    N=$(echo "$P" | cut -d/ -f1); T=$(echo "$P" | cut -d/ -f2)
    command -v ufw >/dev/null 2>&1 && ufw delete allow "$N/$T" >/dev/null 2>&1
    command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --permanent --remove-port="$N/$T" >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1
    for IPT in iptables ip6tables; do command -v $IPT >/dev/null 2>&1 && $IPT -D INPUT -p "$T" --dport "$N" -j ACCEPT >/dev/null 2>&1; done
  done
fi
say step "删除文件"
rm -rf /etc/ondine /var/lib/ondine /usr/local/lib/ondine /var/log/ondine.log
userdel ondine >/dev/null 2>&1 || deluser ondine >/dev/null 2>&1
say done "已卸载"
`;

// 服务控制：start | stop | restart | status | logs
export function serviceScript(action) {
  if (!["start", "stop", "restart", "status", "logs"].includes(action)) throw new Error("未知操作");
  const run =
    action === "logs"
      ? `if [ "$INIT" = systemd ]; then journalctl -u ondine -n 200 --no-pager -o short-iso 2>&1; else tail -n 200 /var/log/ondine.log 2>&1; fi`
      : action === "status"
        ? `if [ "$INIT" = systemd ]; then printf 'active=%s\\nsince=%s\\n' "$(systemctl is-active ondine 2>/dev/null)" "$(systemctl show -p ActiveEnterTimestamp --value ondine 2>/dev/null)"; else rc-service ondine status >/dev/null 2>&1 && echo active=active || echo active=inactive; fi`
        : `if [ "$INIT" = systemd ]; then systemctl ${action} ondine 2>&1 || die "操作失败"; else rc-service ondine ${action} 2>&1 || die "操作失败"; fi
say done ${action}`;
  return `${COMMON}\n${run}\n`;
}

// 服务器概况：不需要 root；每行 key=value
export const INFO_SCRIPT = String.raw`export LC_ALL=C
printf 'hostname=%s\n' "$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release; printf 'os=%s\n' "$PRETTY_NAME"; fi
printf 'kernel=%s\n' "$(uname -r)"
printf 'arch=%s\n' "$(uname -m)"
printf 'uptime=%s\n' "$(cut -d. -f1 /proc/uptime 2>/dev/null)"
printf 'load=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
printf 'cpus=%s\n' "$(grep -c ^processor /proc/cpuinfo 2>/dev/null)"
awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{printf "mem=%.0f %.0f\n", t*1024, a*1024}' /proc/meminfo 2>/dev/null
df -Pk / 2>/dev/null | awk 'NR==2{printf "disk=%.0f %.0f\n", $2*1024, $4*1024}'
awk 'NR>2{sub(":", " "); split($0, f, " "); if (f[1] != "lo") {rx += f[2]; tx += f[10]}} END{printf "net=%.0f %.0f\n", rx, tx}' /proc/net/dev 2>/dev/null
printf 'cc=%s\n' "$(cat /proc/sys/net/ipv4/tcp_congestion_control 2>/dev/null)"
printf 'virt=%s\n' "$(systemd-detect-virt 2>/dev/null)"
printf 'user=%s\n' "$(id -un)"
printf 'uid=%s\n' "$(id -u)"
if [ -x /usr/local/lib/ondine/sing-box ]; then
  printf 'singbox=%s\n' "$(/usr/local/lib/ondine/sing-box version 2>/dev/null | head -n 1 | awk '{print $3}')"
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then printf 'service=%s\n' "$(systemctl is-active ondine 2>/dev/null)"
  elif command -v rc-service >/dev/null 2>&1; then rc-service ondine status >/dev/null 2>&1 && echo service=active || echo service=inactive
  fi
fi
`;

export function parseInfo(text) {
  const kv = {};
  for (const line of String(text).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const pair = (v) => String(v || "").split(/\s+/).map(Number);
  const [memTotal, memFree] = pair(kv.mem);
  const [diskTotal, diskFree] = pair(kv.disk);
  const [rx, tx] = pair(kv.net);
  return {
    hostname: kv.hostname || "",
    os: kv.os || "",
    kernel: kv.kernel || "",
    arch: kv.arch || "",
    uptime: Number(kv.uptime) || 0,
    load: (kv.load || "").split(/\s+/).filter(Boolean).map(Number),
    cpus: Number(kv.cpus) || 0,
    mem: { total: memTotal || 0, free: memFree || 0 },
    disk: { total: diskTotal || 0, free: diskFree || 0 },
    net: { rx: rx || 0, tx: tx || 0 },
    bbr: kv.cc === "bbr",
    cc: kv.cc || "",
    virt: kv.virt && kv.virt !== "none" ? kv.virt : "",
    user: kv.user || "",
    root: kv.uid === "0",
    singbox: kv.singbox || "",
    service: kv.service || (kv.singbox ? "inactive" : ""),
  };
}

// 脚本输出里的进度标记：@@ONDINE step 写入配置 / @@ONDINE error … / @@ONDINE done …
export function parseMarker(line) {
  const m = /^@@ONDINE (\S+)\s?(.*)$/.exec(String(line).trim());
  return m ? { kind: m[1], text: m[2] } : null;
}
