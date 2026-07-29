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

test('前端不得再引用 env_url（改判 env_status === "running"）', () => {
  const offenders = walk(VIEW_DIR).filter(p => /\benv_url\b/.test(fs.readFileSync(p, 'utf8')));
  expect(offenders.map(p => path.relative(VIEW_DIR, p))).toEqual([]);
});

test('前端不得把內部埠印在畫面上（內部埠不對外，印了會誤導使用者去連）', () => {
  const offenders = walk(VIEW_DIR).filter(p => /port \{\{ *env\.port *\}\}/.test(fs.readFileSync(p, 'utf8')));
  expect(offenders.map(p => path.relative(VIEW_DIR, p))).toEqual([]);
});
