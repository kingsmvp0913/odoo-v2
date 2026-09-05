// 意圖：截圖預覽伺服器絕不能在 worktree 起完整的 app server（cron 會被兩份同時啟動，
// 見 pipeline/ui-preview.js 開頭的事故記錄）。這一支釘住「route 為空 → 完全不起任何伺服器」，
// 並驗證有 route 時走的是靜態檔案伺服器（http.createServer），不是 require('../index')。
const fs = require('fs');
const os = require('os');
const path = require('path');

const mockCreateServer = jest.fn();
jest.mock('http', () => {
  const actual = jest.requireActual('http');
  return {
    ...actual,
    createServer: (...args) => mockCreateServer(...args),
  };
});

const mockQuery = jest.fn();
jest.mock('../db', () => ({ query: (...args) => mockQuery(...args) }));

const mockLaunch = jest.fn();
jest.mock('playwright', () => ({ chromium: { launch: (...args) => mockLaunch(...args) } }), { virtual: true });

const { captureBeforeAfter } = require('../pipeline/ui-preview');

beforeEach(() => {
  mockCreateServer.mockReset();
  mockQuery.mockReset();
  mockLaunch.mockReset();
});

describe('route 為空', () => {
  test.each([undefined, null, ''])('route=%p → 回 null 且不起任何伺服器', async (route) => {
    const result = await captureBeforeAfter('/some/worktree', route);
    expect(result).toBeNull();
    expect(mockCreateServer).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// `.fontroot/` 在 .gitignore 內：換機／容器重建後目錄還在、裡面卻空了。此時中文全變豆腐框，
// 而豆腐框會讓 fix-review 判「版面塌掉」→ 一份沒問題的修正被無辜 reject，且零訊號。
// 無截圖好過錯截圖：缺字型一律回 null。
describe('缺中文字型 → 不截圖（無截圖好過錯截圖）', () => {
  test('.fontroot/fonts 空的時候回 null，且不起伺服器', async () => {
    const spy = jest.spyOn(fs, 'readdirSync').mockReturnValue([]);
    try {
      const result = await captureBeforeAfter('/some/worktree', '#/tasks');
      expect(result).toBeNull();
      expect(mockCreateServer).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('目錄整個不存在（readdirSync 拋錯）也一樣回 null，不能當成「有字型」', async () => {
    const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('ENOENT'); });
    try {
      const result = await captureBeforeAfter('/some/worktree', '#/tasks');
      expect(result).toBeNull();
      expect(mockCreateServer).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  test('目錄裡只有非字型檔 → 仍算缺字型', async () => {
    const spy = jest.spyOn(fs, 'readdirSync').mockReturnValue(['README.md', '.gitkeep']);
    try {
      expect(await captureBeforeAfter('/some/worktree', '#/tasks')).toBeNull();
    } finally { spy.mockRestore(); }
  });
});

describe('token 簽發失敗（缺 JWT_SECRET 或 cli_push_user_id）', () => {
  // ⚠ 這一支的價值全在「不起伺服器」那個斷言。只斷言 toBeNull() 近乎恆真——
  // 幾乎每一條失敗路徑都回 null，把實作整個刪掉改成 `return null` 也會綠。
  test('查無 cli_push_user_id → 回 null，且沒有起任何伺服器', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cli_push_user_id: null }] });
    const result = await captureBeforeAfter('/some/worktree', '#/tasks');
    expect(result).toBeNull();
    expect(mockCreateServer).not.toHaveBeenCalled();
  });
});

describe('playwright 載入或啟動失敗 → 走無截圖路徑', () => {
  test('chromium.launch 拋錯時 captureBeforeAfter 回 null（不拋出）', async () => {
    mockQuery.mockResolvedValue({ rows: [{ cli_push_user_id: 1 }] });
    // ⚠ 字型與 data/config.json 都要自己餵，不能靠真檔：兩者都在 .gitignore 內，於是主 clone 有、
    // **worktree 沒有**——而 worktree 正是夜間批次跑自我驗證的地方（finding-fix.js 在 worktree 內
    // 跑全套測試）。少了這兩個 stub，缺字型／缺 JWT_SECRET 的早退會讓流程走不到 launch，這一支在
    // 批次的基線裡就永遠是紅的（實測 2026-09-05：每晚基線都掛著它，靠「改動前後相同」才沒被當成
    // 回歸——等於這一支對批次完全失去把關能力）。
    // ⚠ 正式執行不受影響：批次是在主 clone 的行程裡 require 本模組，REPO_ROOT 指的是主 clone，
    // worktree 只是傳進來的參數。純粹是測試自己被搬進 worktree 才碰得到。
    // 只攔自己這兩個路徑、其餘 fallthrough：無條件攔 fs 會弄壞 jest 自己的檔案讀取。
    const realReaddir = fs.readdirSync;
    const realReadFile = fs.readFileSync;
    const fontSpy = jest.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) =>
      (String(p).includes('.fontroot') ? ['NotoSansTC-Regular.otf'] : realReaddir(p, ...rest)));
    const cfgSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) =>
      (String(p).endsWith(path.join('data', 'config.json'))
        ? JSON.stringify({ JWT_SECRET: 'test-secret' })
        : realReadFile(p, ...rest)));
    try {
      // 讓 createServer 回一個真的 http server，讓流程走到 launch 那一步再炸
      mockCreateServer.mockImplementation((handler) => jest.requireActual('http').createServer(handler));
      mockLaunch.mockRejectedValue(new Error('Executable doesn\'t exist'));
      const result = await captureBeforeAfter(os.tmpdir(), '#/tasks');
      expect(result).toBeNull();
      // 起了才炸：這條路徑上 createServer 應該有被呼叫（與上面那支形成對照，證明
      // 「不起伺服器」的斷言真的分得出兩種情況，不是恆真）
      expect(mockCreateServer).toHaveBeenCalled();
      // launch 真的被走到了才算數：少了這條，缺字型的早退（也回 null、也沒起 server）會讓
      // 這一支在「根本沒進到 playwright」的情況下照樣綠——那正是它原本紅的那個路徑。
      expect(mockLaunch).toHaveBeenCalled();
    } finally { fontSpy.mockRestore(); cfgSpy.mockRestore(); }
  });
});

// ⚠ 本檔的頭號紅線：ui-preview 絕不能起完整的 app server。
// `index.js:303` 的 startCron() 無條件執行、沒有 env 可以關；兩個 cron 共用同一個 DB 會讓
// 同一任務被派兩次、兩支 claude 並行寫同一個工作區（index.js:285-292 記著這起實際事故）。
// 這是靜態守衛：行為測試攔不住「有人日後為了方便直接 require 平台本體」，因為那在單元測試裡
// 會被 mock 掉而看不出來。
describe('不得起完整的 app server（靜態守衛）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'ui-preview.js'), 'utf8');

  test('原始碼不得 require 平台本體（index.js）', () => {
    expect(src).not.toMatch(/require\(\s*['"][./]*\.\.\/index['"]\s*\)/);
    expect(src).not.toMatch(/require\(\s*['"][^'"]*\/index\.js['"]\s*\)/);
  });

  test('原始碼不得出現 startCron', () => {
    // 註解裡講「為什麼不能起 cron」是必要的，所以只擋「真的呼叫」：startCron( 後面接參數或右括號
    expect(src).not.toMatch(/^[^/*]*\bstartCron\s*\(/m);
  });

  // before／after 的 scrollHeight 往往不同（修正本身就會改變內容高度），捲到底再截會讓兩張圖
  // 停在不同位置——**差異來自捲動而不是修正**，直接餵出誤判；而且不帶 fullPage 時只拍最後
  // 900px，多數在頁面上半部的改動 agent 根本看不到。改成拍首屏之後，這行不該再回來。
  // 同 startCron 那支：註解裡必須講得出「為什麼不捲」，所以只擋真的賦值（行首不是註解標記）。
  test('不得在截圖前捲動（scrollTop = scrollHeight）', () => {
    expect(src).not.toMatch(/^[^/*]*\bscrollTop\s*=/m);
  });
});
