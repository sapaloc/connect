/* Connect API client — links frontend to Express backend, falls back to localStorage demo when offline.
   Backend: same-origin /api/* (served by backend/server.js). Token in localStorage connect_token. */
(function (g) {
  const LS_TOKEN = 'connect_token';
  let reachable = false;

  async function health() {
    try {
      const r = await fetch('api/health', { cache: 'no-store' });
      // when served over file:// fetch fails → stay local
      reachable = r.ok;
    } catch (e) { reachable = false; }
    return reachable;
  }
  function token() { return localStorage.getItem(LS_TOKEN) || ''; }
  function setToken(t) { if (t) localStorage.setItem(LS_TOKEN, t); else localStorage.removeItem(LS_TOKEN); }
  async function req(method, path, body) {
    const h = { 'Content-Type': 'application/json' };
    const t = token(); if (t) h.Authorization = 'Bearer ' + t;
    const r = await fetch('api' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }
  const api = {
    reachable: () => reachable,
    health, token, setToken,
    login: (email, pass, role, supportReason) => req('POST', '/auth/login', { email, pass, role, supportReason }),
    logout: () => req('POST', '/auth/logout').finally(() => setToken('')),
    snapshot: () => req('GET', '/db'),
    funnel: () => req('GET', '/reports/funnel'),
    activateVoucher: (code, deviceId, force) => req('POST', '/vouchers/activate', { code, deviceId, force }),
    validate: (code) => req('POST', '/counter/validate', { code }),
    redeem: (code, gross) => req('POST', '/counter/redeem', { code, gross }),
    // best-effort mirrors so data.json stays in sync (failures are swallowed — local remains source for UI speed)
    mirror: async (method, path, body) => { if (!reachable) return null; try { return await req(method, path, body); } catch (e) { return null; } }
  };
  g.ConnectAPI = api;
  // probe early; topbar badge updated by app.js
  health();
})(window);
