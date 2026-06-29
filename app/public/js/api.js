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
    const res = await fetch(`/api/${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
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

  async checkSetup() {
    try { return await this.get('auth/status'); }
    catch { return { setup_done: false }; }
  }
};

window.Api = Api;
