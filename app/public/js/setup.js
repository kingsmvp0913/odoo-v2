fetch(`${BASE_PATH}api/setup/status`).then(r => r.json()).then(d => {
  if (!d.needsSetup) window.location.replace(BASE_PATH);
}).catch(() => {}); // 網路失敗時頁面仍可操作

async function setup() {
  const errorEl = document.getElementById('error');
  const btn = document.getElementById('btn');
  errorEl.style.display = 'none';

  const body = {
    username: document.getElementById('username').value.trim(),
    password: document.getElementById('password').value,
    display_name: document.getElementById('display_name').value.trim()
  };
  if (!body.username || !body.password || !body.display_name) {
    errorEl.textContent = '請填寫所有欄位'; errorEl.style.display = 'block'; return;
  }
  if (body.password.length < 8) {
    errorEl.textContent = '密碼至少需要 8 個字元'; errorEl.style.display = 'block'; return;
  }

  btn.disabled = true; btn.textContent = '設定中...';
  const res = await fetch(`${BASE_PATH}api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error; errorEl.style.display = 'block';
    btn.disabled = false; btn.textContent = '完成設定'; return;
  }
  sessionStorage.setItem('aidev_token', data.token);
  window.location.replace(BASE_PATH);
}

document.getElementById('btn').addEventListener('click', setup);
