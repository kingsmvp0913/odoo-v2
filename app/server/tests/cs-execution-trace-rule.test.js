// 意圖：chat／cs 讀到一段「能解釋現象」的碼，就把它當成本次現象的原因。實測 chat 113 第一輪完全
// 照【先查證，再回答】第一條做了（讀碼、附行號），結論仍然錯——因為它只證明「這段程式做得到」，
// 沒查「這次有沒有跑」。第二輪一查同步紀錄 0 筆就推翻了。代價不只多一輪：第一輪已經在提議開任務
// 去修，使用者若點頭，整條 pipeline 會去修一個不存在的 bug。本檔釘住那條缺口規則：它被刪或被
// 稀釋掉「查不到痕跡就不准提議開任務」時，這裡要紅。
const { loadAgent } = require('../pipeline/agent-loader');

const renderChat = () => loadAgent('chat').render({
  project_name: '鴻久', project_slug: 'odoo17_hungjou', repo_paths: '- /repos/hj/idx_sale',
  odoo_core_src: '（略）', history: '', user_message: '為什麼供應商資料沒有更新？'
});
const renderCs = () => loadAgent('cs').render({
  title: 'T', original_text: 'x', answers: '（尚無）',
  project_name: '鴻久', project_slug: 'odoo17_hungjou', repo_paths: '- /repos/hj/idx_sale',
  odoo_core_src: '（略）'
});

describe('指認「本次現象的原因」前要先查執行痕跡', () => {
  // cs-capability 是 chat／cs 的共用真相來源；只有一邊拿得到＝另一邊靜默照舊自由發揮。
  test.each([['chat', renderChat], ['cs', renderCs]])('%s 拿得到這條規則', (_name, render) => {
    expect(render()).toMatch(/確實執行過的痕跡/);
  });

  // 兩個關鍵半段各自對應一個真實後果：只講「可以產生」就定罪（多一輪對話）、
  // 查無痕跡仍提議開任務（pipeline 去修不存在的 bug）。
  test.each([
    ['要求另外查痕跡，而非只證明程式做得到', /不等於「這次就是它做的」/],
    ['查不到痕跡不得下 bug 結論、不得提議開任務', /查不到痕跡就不准下「這是程式 bug」的結論，也不准提議開任務去修/],
  ])('規則涵蓋：%s', (_label, re) => {
    expect(renderChat()).toMatch(re);
  });

  // 這條是既有三條之外的第四條；前言寫死「下面三條」會讓新規則看起來不在清單內。
  test('前言的條數與實際條數一致', () => {
    const out = renderChat();
    expect(out).toContain('下面四條逐項可檢查');
    expect(out).not.toContain('下面三條逐項可檢查');
  });
});
