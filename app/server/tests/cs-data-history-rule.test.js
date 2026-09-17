// 意圖：chat／cs 對「某欄位過去有沒有被改過／是不是被刪的」下斷言，卻沒先確認該欄位留不留得下
// 變更軌跡。實測 chat 117 對一個明確沒有 tracking 的欄位斷言「不是刪除、不曾被賦值也不曾被清空」，
// 把一個仍在持續刪除客戶資料的同步 bug 判成主檔設定問題，並據此建議客戶去改正式區主檔——那是
// 不可逆的。它甚至自己查到聯絡人在同一秒被整批寫入（誤刪後補回的痕跡）卻解釋掉了。
// 既有的【執行痕跡】那條管的是「程式這次有沒有跑」，管不到資料歷史，所以這是另一條規則。
// 本檔釘住它：整段被刪、或三個半段任一被稀釋掉時，這裡要紅。
const { loadAgent } = require('../pipeline/agent-loader');

const renderChat = () => loadAgent('chat').render({
  project_name: '鴻久', project_slug: 'odoo17_hungjou', repo_paths: '- /repos/hj/idx_sale',
  odoo_core_src: '（略）', history: '', user_message: '客戶的聯絡人資料為什麼不見了？'
});
const renderCs = () => loadAgent('cs').render({
  title: 'T', original_text: 'x', answers: '（尚無）',
  project_name: '鴻久', project_slug: 'odoo17_hungjou', repo_paths: '- /repos/hj/idx_sale',
  odoo_core_src: '（略）'
});

describe('對欄位的過去狀態下斷言前要先確認有無變更軌跡', () => {
  // cs-capability 是 chat／cs 的共用真相來源；只有一邊拿得到＝另一邊靜默照舊自由發揮。
  test.each([['chat', renderChat], ['cs', renderCs]])('%s 拿得到這條規則', (_name, render) => {
    expect(render()).toContain('【資料的過去狀態——沒有軌跡就不准下否定式結論】');
  });

  // 三個半段各自對應一個真實後果：不查軌跡就斷言（把發作中的 bug 判成設定問題）、
  // 據此叫客戶改正式區主檔（不可逆的誤導）、把反證解釋掉（結論不會被自己推翻）。
  test.each([
    ['先確認該欄位有沒有可查的變更軌跡', /先確認這個欄位有沒有可查的變更軌跡/],
    ['指出去哪裡查軌跡（tracking／自建 log／時間戳）', /mail\.tracking\.value[\s\S]*自建的同步／異動 log[\s\S]*write_date/],
    ['查不到軌跡只能說無法判斷', /查不到變更紀錄，無法判斷/],
    ['不得下否定式結論', /不得改寫成「不曾被賦值／不曾被清空／不是刪除／本來就是空的」/],
    ['不得據此叫客戶去改正式區主檔', /不得.*據此把問題導向「這是主檔設定問題，請去正式區改主檔」/],
    ['反證要列出並下修結論，不准解釋掉', /要當成反證列出來並下修結論，不准解釋掉/],
  ])('規則涵蓋：%s', (_label, re) => {
    expect(renderChat()).toMatch(re);
  });

  // 這條與既有【執行痕跡】那條容易被後人當成重複而合併掉；合併會讓「資料歷史」那半邊消失，
  // 所以明寫兩者管的不是同一件事。
  test('明講執行痕跡那條管不到資料歷史', () => {
    expect(renderChat()).toMatch(/執行痕跡管的是「程式這次有沒有跑」，管不到資料歷史/);
  });
});
