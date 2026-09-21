// 意圖：規格的 module 欄位是「這張任務動到哪些模組」的唯一來源。部署要拿到完整清單（漏一個＝那個
// 模組的 view 與 migration 靜默不執行），而 tour／wiki 這類「一張任務歸屬一個模組」的關卡只能拿一個。
const { specModules, primaryModule } = require('../pipeline/spec-modules');

describe('specModules', () => {
  test('單一模組 → 單元素陣列', () => {
    expect(specModules('module: idx_project')).toEqual(['idx_project']);
  });

  test('逗號分隔 → 全部拆開，並去除空白', () => {
    expect(specModules('module: idx_project, idx_purchase')).toEqual(['idx_project', 'idx_purchase']);
  });

  test('三個以上也要全拿到', () => {
    expect(specModules('module: a,b,c')).toEqual(['a', 'b', 'c']);
  });

  test('尾隨逗號與連續逗號不得產生空字串元素', () => {
    // 空字串會讓 upgradeModules 組出 `-u a,,b`，Odoo 直接報找不到模組
    expect(specModules('module: a,,b,')).toEqual(['a', 'b']);
  });

  test('沒有 module 欄位 → 空陣列（部署據此降級成升級全部）', () => {
    expect(specModules('summary: 沒寫模組')).toEqual([]);
  });

  test('YAML 壞掉 → 空陣列，不可拋例外', () => {
    // 規格解析失敗不該讓整個部署流程炸掉，維持原本的降級行為
    expect(specModules('module: [unclosed')).toEqual([]);
    expect(specModules(null)).toEqual([]);
  });
});

describe('primaryModule', () => {
  test('多模組時取第一個', () => {
    // tour 用它組 regex 比對 <module>/tests/*.py、wiki 用它當頁面 slug，都只能吃一個
    expect(primaryModule('module: idx_project, idx_purchase')).toBe('idx_project');
  });

  test('單一模組時就是它自己', () => {
    expect(primaryModule('module: idx_project')).toBe('idx_project');
  });

  test('取不到 → 空字串（呼叫端各自決定要停下還是套預設值）', () => {
    expect(primaryModule('summary: 沒寫模組')).toBe('');
    expect(primaryModule('module: [unclosed')).toBe('');
  });
});

// 「不動任何模組」是 2026-09-21 才有出口的第三種情形（task 282：改的是 repo 根目錄的主機端備份
// 腳本與 markdown，全庫第一張不含任何 addon 的任務）。它與「忘了填」在資料上長得一樣，所以只認
// 明確寫出的保留字 none；留空與解析失敗仍歸「不知道」，部署維持既有的 -u all 降級行為。
describe('isNoModule：明確宣告「不動任何模組」', () => {
  const { isNoModule, NO_MODULE } = require('../pipeline/spec-modules');

  test('寫 none → true', () => {
    expect(isNoModule('module: none')).toBe(true);
    expect(isNoModule('module: "none"')).toBe(true);
  });

  test('大小寫與前後空白不影響判定（模型輸出的大小寫本來就不穩定）', () => {
    expect(isNoModule('module: "  None  "')).toBe(true);
    expect(isNoModule('module: NONE')).toBe(true);
  });

  test('留空 → false：骨架本來就長 module: ""，跟「忘了填」分不開，不能當成宣告', () => {
    expect(isNoModule('module: ""')).toBe(false);
    expect(isNoModule('summary: 沒寫模組')).toBe(false);
  });

  test('YAML 壞掉 → false，不可拋例外（那是「不知道」，不是「沒有」）', () => {
    expect(isNoModule('module: [unclosed')).toBe(false);
    expect(isNoModule(null)).toBe(false);
  });

  test('真的有模組 → false', () => {
    expect(isNoModule('module: idx_project')).toBe(false);
    expect(isNoModule('module: none_of_your_business')).toBe(false);  // 前綴相同但不是保留字
  });

  test('none 不得被當成模組名送去升級（-u none 會讓 Odoo 報找不到模組）', () => {
    expect(specModules('module: none')).toEqual([]);
    expect(primaryModule('module: none')).toBe('');
  });

  test('保留字本體對外公開，呼叫端與 prompt 不各寫一份字面值', () => {
    expect(NO_MODULE).toBe('none');
  });
});
