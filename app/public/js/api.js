const TOKEN_KEY = 'aidev_token';

const Api = {
  getToken() { return localStorage.getItem(TOKEN_KEY); },
  setToken(t) { localStorage.setItem(TOKEN_KEY, t); },
  clearToken() { localStorage.removeItem(TOKEN_KEY); },
  isLoggedIn() { return !!this.getToken(); },

  async _fetch(method, path, body) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${BASE_PATH}api/${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error('伺服器沒回應');  // 網路層失敗（原生訊息為 Failed to fetch）
    }
    if (res.status === 401) { this.clearToken(); window.location.hash = '/login'; throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  get(path) { return this._fetch('GET', path); },
  post(path, body) { return this._fetch('POST', path, body); },
  put(path, body) { return this._fetch('PUT', path, body); },
  patch(path, body) { return this._fetch('PATCH', path, body); },
  delete(path) { return this._fetch('DELETE', path); },

  async postForm(path, formData) {
    const token = this.getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${BASE_PATH}api/${path}`, { method: 'POST', headers, body: formData });
    } catch (e) {
      throw new Error('伺服器沒回應');
    }
    if (res.status === 401) { this.clearToken(); window.location.hash = '/login'; throw new Error('Unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  // 檔案下載：回應是 binary，不能走 _fetch 的 res.json()。一併回傳 headers，
  // 讓呼叫端讀得到隨檔附帶的中繼資訊（如打包清單）。無法用 <a href> 直接下載——
  // 認證走 Authorization header，瀏覽器的原生下載不會帶上它，只會拿到 401。
  async getBlob(path) {
    const token = this.getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${BASE_PATH}api/${path}`, { headers });
    } catch (e) {
      throw new Error('伺服器沒回應');
    }
    if (res.status === 401) { this.clearToken(); window.location.hash = '/login'; throw new Error('Unauthorized'); }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return { blob: await res.blob(), headers: res.headers };
  },

  async checkSetup() {
    try { return await this.get('auth/status'); }
    catch { return { setup_done: false }; }
  }
};

window.Api = Api;
