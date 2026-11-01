// 导入时自动转换、共享订阅（局域网订阅地址）、二维码
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { Profiles } from "../src/main/profiles.js";
import { qrPath, ShareServer } from "../src/main/share.js";

const here = dirname(fileURLToPath(import.meta.url));
const SUB = yaml.load(readFileSync(join(here, "..", "..", "test", "fixtures", "subscription.yaml"), "utf8"));
const LINKS = ["trojan://pw@hk.example.com:443#香港 01", "hysteria2://pw@jp.example.com:443#日本 02", "vless://0b0c1d2e-3f40-4a5b-8c6d-7e8f90a1b2c3@sg.example.com:443?security=tls&sni=sg.example.com#SG 03", "trojan://pw@x.example.com:443#剩余流量 10G"].join("\n");

test("导入时自动转换：分享链接订阅按地区分组，Clash 配置原样使用，改过选项后不再自动套用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ondine-auto-"));
  let body = Buffer.from(LINKS).toString("base64");
  const profiles = new Profiles(dir, async () => new Response(body));
  const item = await profiles.add({ url: "https://sub.example.com/links" });
  assert.equal(item.format, "links");
  assert.equal(item.auto, true);
  assert.equal(item.convert.template, "region");
  const loaded = profiles.load(item.id);
  const names = loaded.proxies.map((p) => p.name);
  assert.ok(names.includes("🇭🇰 香港 01"), names.join());
  assert.ok(!names.some((n) => /剩余流量/.test(n)), "信息节点去掉了");
  assert.ok(loaded["proxy-groups"].some((g) => /香港/.test(g.name)), "有按地区的分组");
  // 机场换成了完整的 Clash 配置：用它自带的分组和规则
  body = yaml.dump(SUB);
  await profiles.update(item.id);
  assert.equal(profiles.get(item.id).format, "clash");
  assert.equal(profiles.get(item.id).convert, undefined);
  assert.ok(profiles.groups(item.id).includes("🚀 节点选择"));
  // 又变回分享链接：重新自动转换
  body = LINKS;
  await profiles.update(item.id);
  assert.equal(profiles.get(item.id).auto, true);
  // 用户自己关掉转换后，更新也不再自动套用
  profiles.edit(item.id, { convert: null });
  await profiles.update(item.id);
  assert.equal(profiles.get(item.id).auto, false);
  assert.equal(profiles.get(item.id).convert, undefined);
  // 打开设置原样保存不算改过
  const other = await profiles.add({ url: "https://sub.example.com/other" });
  profiles.edit(other.id, { name: "B", convert: other.convert });
  assert.equal(profiles.get(other.id).auto, true);
  // 本地导入同样识别
  const local = profiles.import({ name: "nodes.txt", text: LINKS });
  assert.equal(local.auto, true);
  const clash = profiles.import({ name: "clash.yaml", text: yaml.dump(SUB) });
  assert.equal(clash.auto, undefined);
  assert.equal(clash.format, "clash");
});

test("共享订阅：带密钥的地址返回转换结果，别的请求一律 404", async () => {
  const token = "0123456789abcdef0123456789abcdef";
  const server = new ShareServer((target) => ({ text: "T:" + target, userinfo: { upload: 1, download: 2, total: 30, expire: 1798732800 }, name: "机场" }));
  await server.start(0, token);
  const port = server.server.address().port;
  const get = (path, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, { method });
  try {
    const ok = await get(`/sub/${token}/surge`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "T:surge");
    assert.equal(ok.headers.get("subscription-userinfo"), "upload=1; download=2; total=30; expire=1798732800");
    assert.match(ok.headers.get("content-disposition"), /%E6%9C%BA%E5%9C%BA/);
    for (const bad of [`/sub/${token.replace("0", "1")}/surge`, `/sub/${token}/nope`, "/", `/sub/${token}`]) assert.equal((await get(bad)).status, 404, bad);
    assert.equal((await get(`/sub/${token}/clash`, "POST")).status, 404);
    assert.equal(server.hits, 1);
  } finally {
    await server.stop();
  }
  assert.equal(server.running, false);
});

test("二维码：路径只含绘图指令", () => {
  const { size, d } = qrPath("vless://uuid@1.2.3.4:443?security=reality#Ondine");
  assert.ok(size >= 21);
  assert.match(d, /^(M\d+ \d+h\d+v1h-\d+z)+$/);
});
