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
