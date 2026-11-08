// 简体 → 繁體（台湾用字，例如 设置→設定、搜索→搜尋、服务器→伺服器），主进程和界面共用
// 界面文字都用简体写，选了繁体时在显示的那一刻转换；词库来自 OpenCC（opencc-js，MIT / Apache-2.0）
import { Converter } from "../node_modules/opencc-js/dist/esm/cn2t.js";

const convert = Converter({ from: "cn", to: "twp" });
// 词库转得不对的词
const FIX = [["網絡卡", "網卡"], ["全域性", "全域"], ["指令碼", "腳本"], ["預釋出", "預發行"]];
const cache = new Map();

export function toTraditional(text) {
  if (!text || !/[㐀-鿿]/.test(text)) return text;
  let out = cache.get(text);
  if (out === undefined) {
    out = convert(text);
    for (const [from, to] of FIX) out = out.split(from).join(to);
    if (cache.size > 5000) cache.clear();
    cache.set(text, out);
  }
  return out;
}
