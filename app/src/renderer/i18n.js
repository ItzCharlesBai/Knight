// 繁體：把页面上看得见的字（文本节点和 placeholder / title / aria-label）实时转成繁体。
// 只改显示：data-* 属性、输入框和文本框里的内容、代码、日志都不动，节点名和配置照原样交给内核
import { toTraditional } from "../zh.js";

const SKIP = "textarea, input, code, pre, script, style, .mono, .log, .term-out, .qr-text";
const ATTRS = ["placeholder", "title", "aria-label"];
const skipped = (node) => {
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !el || !!el.closest(SKIP);
};
function fixText(t) {
  const out = toTraditional(t.nodeValue);
  if (out !== t.nodeValue) t.nodeValue = out;
}
function fixAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    const out = v && toTraditional(v);
    if (out && out !== v) el.setAttribute(a, out);
  }
}
function walk(root) {
  if (skipped(root)) return;
  if (root.nodeType === 3) return fixText(root);
  if (root.nodeType !== 1) return;
  fixAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) n.nodeType === 3 ? fixText(n) : fixAttrs(n);
}

let observer = null;
// 打开后一直生效；切回简体时界面会重新载入（原来的字已经被换掉了）
export function useTraditional() {
  if (observer) return;
  walk(document.body);
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "childList") m.addedNodes.forEach(walk);
      else if (!skipped(m.target)) m.type === "characterData" ? fixText(m.target) : fixAttrs(m.target);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
