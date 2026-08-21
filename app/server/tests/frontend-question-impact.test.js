// 意圖（Rule 9）：「這題選錯要不要緊」以前是要求 AI 寫進題目文字的一句話（asking-well Q3），
// 每一題都因此長一截，使用者實際抱怨的正是「文字越來越長」。改成結構化欄位 `impact` + 畫面標記後，
// 這件事拆成三個獨立環節，**任何一環斷掉都是零紅燈的靜默失敗**：
//   ① AI 不知道要填 → 契約沒寫，畫面永遠空著，看起來像功能沒做
//   ② 畫面不渲染 → AI 填了也沒人看得到，資訊憑空消失
//   ③ 守則又叫 AI 寫回文字 → 兩邊都做，題目照樣變長，改了等於沒改
// 這支同時釘住三環。單看任一支原始碼都測不出來，所以刻意跨檔斷言。
const fs = require('fs');
const path = require('path');

const view = fs.readFileSync(path.join(__dirname, '../../public/js/views/TaskDetail.js'), 'utf8');
const contract = fs.readFileSync(path.join(__dirname, '../pipeline/questions-contract.md'), 'utf8');
const askingWell = fs.readFileSync(path.join(__dirname, '../pipeline/asking-well.md'), 'utf8');

describe('題目的「選錯代價」走畫面標記，不走題目文字', () => {
  // ① 契約端：AI 要知道有這個欄位、兩個值分別代表什麼
  test('題目撰寫契約要求 AI 填 impact，且定義了 costly／reversible', () => {
    expect(contract).toContain('`impact`');
    expect(contract).toContain('`costly`');
    expect(contract).toContain('`reversible`');
  });

  // ③ 契約端：明講不要再寫進文字——少了這句，AI 會欄位也填、文字也寫，題目照樣變長
  test('契約明確禁止把同一件事再寫進 text／recommended_why', () => {
    expect(contract).toMatch(/不要再把這件事[\s\S]{0,40}`text`/);
    expect(contract).toContain('recommended_why');
  });

  // ③ 守則端：Q3 原本要求「照實選一種寫法」寫成句子，必須已經改掉
  test('發問守則不再要求把代價寫成句子，而是指向 impact 欄位', () => {
    expect(askingWell).toContain('`impact`');
    expect(askingWell).not.toContain('這裡若選錯，之後隨時能改，不用重做');
    expect(askingWell).not.toContain('這裡若選錯，要退回重寫規格與程式，請多看一眼');
  });

  // ② 畫面端：有渲染，而且掛在題目標題列（跟「選填」同一列），不是另起一行又佔版面
  test('題目標題列會渲染 impact=costly 的標記', () => {
    expect(view).toMatch(/v-if="q\.impact === 'costly'"/);
    const header = view.slice(view.indexOf('<div class="td-q-header">'));
    expect(header.slice(0, header.indexOf('</div>'))).toMatch(/q\.impact === 'costly'/);
  });

  // 兩種都畫＝每題都有標記＝等於沒標。只有需要多看一眼的那種才出現，才有鑑別力。
  test('reversible 不渲染任何標記', () => {
    expect(view).not.toContain("q.impact === 'reversible'");
  });

  // 深色模式硬規則：套用既有 pill class，不得 inline 寫死淺色背景（寫死＝深色模式下文字翻白隱形）
  test('標記套用既有 pill 樣式，沒有 inline 寫死顏色', () => {
    const tag = view.match(/<span v-if="q\.impact === 'costly'"[\s\S]{0,240}?<\/span>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).toMatch(/class="pill pill-\w+"/);
    expect(tag[0]).not.toMatch(/background\s*:\s*#/);
    expect(tag[0]).not.toMatch(/color\s*:\s*#/);
  });

  // 標記本身要短。做這件事的理由就是嫌文字長，標記再長回去就自我否定了。
  test('標記文字維持精簡（含符號 8 字以內）', () => {
    const tag = view.match(/<span v-if="q\.impact === 'costly'"[\s\S]{0,240}?>([^<]+)<\/span>/);
    expect(tag).not.toBeNull();
    expect(tag[1].trim().length).toBeLessThanOrEqual(8);
  });
});
