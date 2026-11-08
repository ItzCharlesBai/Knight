// 繁体界面：简体文字转成台湾用字
import assert from "node:assert/strict";
import test from "node:test";
import { toTraditional } from "../src/zh.js";

test("简体转繁体：台湾用字、修正过的词、没有中文时原样返回", () => {
  assert.equal(toTraditional("设置"), "設定");
  assert.equal(toTraditional("搜索节点"), "搜尋節點");
  assert.equal(toTraditional("服务器"), "伺服器");
  assert.equal(toTraditional("虚拟网卡（TUN）"), "虛擬網卡（TUN）");
  assert.equal(toTraditional("全局"), "全域");
  assert.equal(toTraditional("防泄露脚本"), "防洩露腳本");
  assert.equal(toTraditional("今天的风，从哪里吹来"), "今天的風，從哪裡吹來");
  assert.equal(toTraditional("mihomo v1.19.33 · 127.0.0.1:7897"), "mihomo v1.19.33 · 127.0.0.1:7897");
  assert.equal(toTraditional(""), "");
  assert.equal(toTraditional(toTraditional("订阅被拒绝访问")), toTraditional("订阅被拒绝访问"), "转两次结果不变（界面里会重复转换）");
});
