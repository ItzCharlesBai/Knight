// mihomo 控制接口（RESTful API + WebSocket），地址和密钥由主进程提供
export function createApi(getController) {
  const base = () => getController() || { url: "", secret: "" };

  async function request(method, path, body) {
    const { url, secret } = base();
    const res = await fetch(url + path, {
      method,
      headers: Object.assign({ Authorization: "Bearer " + secret }, body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error((data && data.message) || text || "HTTP " + res.status);
    return data;
  }

  // 断线自动重连；返回关闭函数
  function stream(path, onMessage) {
    let ws = null;
    let closed = false;
    let timer = null;
    const open = () => {
      const { url, secret } = base();
      if (!url) return retry();
      const sep = path.includes("?") ? "&" : "?";
      ws = new WebSocket(url.replace(/^http/, "ws") + path + sep + "token=" + encodeURIComponent(secret));
      ws.onmessage = (e) => {
        try {
          onMessage(JSON.parse(e.data));
        } catch {
          /* 忽略坏消息 */
        }
      };
      ws.onclose = () => retry();
      ws.onerror = () => ws && ws.close();
    };
    const retry = () => {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(open, 1500);
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }

  const enc = encodeURIComponent;
  return {
    request,
    stream,
    version: () => request("GET", "/version"),
    proxies: () => request("GET", "/proxies"),
    select: (group, name) => request("PUT", `/proxies/${enc(group)}`, { name }),
    delay: (name, url, timeout) => request("GET", `/proxies/${enc(name)}/delay?url=${enc(url)}&timeout=${timeout}`),
    groupDelay: (name, url, timeout) => request("GET", `/group/${enc(name)}/delay?url=${enc(url)}&timeout=${timeout}`),
    proxyProviders: () => request("GET", "/providers/proxies"),
    updateProxyProvider: (name) => request("PUT", `/providers/proxies/${enc(name)}`),
    healthcheckProvider: (name) => request("GET", `/providers/proxies/${enc(name)}/healthcheck`),
    rules: () => request("GET", "/rules"),
    ruleProviders: () => request("GET", "/providers/rules"),
    updateRuleProvider: (name) => request("PUT", `/providers/rules/${enc(name)}`),
    connections: () => request("GET", "/connections"),
    closeConnection: (id) => request("DELETE", `/connections/${enc(id)}`),
    closeAll: () => request("DELETE", "/connections"),
    updateGeo: () => request("POST", "/configs/geo", {}),
    flushFakeIP: () => request("POST", "/cache/fakeip/flush"),
    flushDNS: () => request("POST", "/cache/dns/flush"),
  };
}
