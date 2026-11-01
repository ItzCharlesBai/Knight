// 渲染进程只能通过这里访问主进程；内核的控制接口由页面直接请求（127.0.0.1 + 密钥）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ondine", {
  invoke: async (method, ...args) => {
    const res = await ipcRenderer.invoke("ondine", method, ...args);
    if (res && res.error) throw new Error(res.error);
    return res ? res.data : undefined;
  },
  onState: (fn) => {
    const listener = (_e, state) => fn(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  onNavigate: (fn) => ipcRenderer.on("navigate", (_e, page) => fn(page)),
  onToast: (fn) => ipcRenderer.on("toast", (_e, toast) => fn(toast)),
  // VPS 部署进度：{ id, kind, text }
  onVps: (fn) => ipcRenderer.on("vps", (_e, msg) => fn(msg)),
});
