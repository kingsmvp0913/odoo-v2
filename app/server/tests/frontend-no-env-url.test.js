// 意圖：子網域模式下對外網址是「點下去的當下才算得出來」，開機時 odoo_envs.url 存 NULL。
// 任何前端還在用 env_url 當顯示條件的地方，畫面上會整個消失且沒有錯誤訊息。
// 這是掃全樹的靜態守衛——列死檔案清單的話，之後新增的 view 一律漏掃、防線形同虛設。
const fs = require('fs');
const path = require('path');

const VIEW_DIR = path.join(__dirname, '../../public/js');

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

test('前端不得再引用 env_url（改判 env_status）', () => {
  const offenders = walk(VIEW_DIR).filter(p => /\benv_url\b/.test(fs.readFileSync(p, 'utf8')));
  expect(offenders.map(p => path.relative(VIEW_DIR, p))).toEqual([]);
});

test('前端不得把內部埠印在畫面上（內部埠不對外，印了會誤導使用者去連）', () => {
  const offenders = walk(VIEW_DIR).filter(p => /port \{\{ *env\.port *\}\}/.test(fs.readFileSync(p, 'utf8')));
  expect(offenders.map(p => path.relative(VIEW_DIR, p))).toEqual([]);
});

// 意圖：子網域模式下內部埠只走 nginx 的 proxy_pass，不 publish、不需 NAT 放行。埠池頁那句
// 「改範圍要請維運 publish／放行 NAT」是 port 模式時代的遺物，而那個畫面正是上線步驟要求操作員
// 把上限從 21012 拉到 21019 的地方——留著會讓他以為得先等 IT 放行，直接卡住上線。
test('埠池設定頁不得再要求 publish 埠段／放行 NAT（內部埠已不對外）', () => {
  const src = fs.readFileSync(path.join(VIEW_DIR, 'views/AdminPortPool.js'), 'utf8');
  expect(src).not.toMatch(/publish/i);
  expect(src).not.toMatch(/NAT/);
});

// 意圖：真人「關掉分頁」偵測不到，所以歸還檢視名額只有兩條路——閒置逾時與明確按鈕。
// 後端 POST /env/external/release 若沒有任何前端入口，就只剩閒置那一條，10 個名額的池子
// 體感會小得多（別人得等前一個人閒置滿 20 分鐘才借得到）。
test('前端必須有歸還對外名額的入口（否則名額只能等閒置逾時）', () => {
  const callers = walk(VIEW_DIR).filter(p => /env\/external\/release/.test(fs.readFileSync(p, 'utf8')));
  expect(callers.length).toBeGreaterThan(0);
});
