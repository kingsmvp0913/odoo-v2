# 盤點：layout 類 inline style 待遷移清單

> 由 `app/rwd/inventory/scan.js` 產生（`cd app && npm run rwd:inventory` 可重跑）。
> 對應規格 `RWD-C-SPEC.md` Block 2／3。遷移完重跑一次，剩餘處數即進度。

## 總計

**82 處 inline style / 18 檔**（分類命中 89 次——同一處可同時屬多類）

| 類別 | 命中 |
|---|---|
| flex/grid | 52 |
| 固定寬 | 26 |
| grid-template | 6 |
| nowrap | 5 |

## 分批

| 批次 | 處數 | 範圍 |
|---|---|---|
| Block 3 | 82 | 其餘全部 |

依「處數平衡」分批，不是依檔案大小：`TaskDetail.js`／`TokenReport.js` 的 127 處是**全部** inline style，
layout 類其實只有 14／17 處，照檔案大小分會讓兩批相差三倍。

## 遷移規則（規格 §2.2，不可放寬）

抽出的 class 內容**與原 inline style 逐字相同**：不順手改值、不合併相似規則、不改順序。
想調整的值一律留到後續 Block、在 media query 內處理。
驗收是像素級的——桌機截圖 diff 必須為 0。

---

## Block 3

### `js/views/PipelineFlow.js` — 9 處

| 行 | 類別 | inline style |
|---|---|---|
| 791 | flex/grid | `style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:center;margin-bottom:v…` |
| 792 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none"` |
| 800 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none"` |
| 809 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none"` |
| 819 | flex/grid | `style="display:flex;gap:var(--space-4);align-items:flex-start;flex-wrap:wrap"` |
| 900 | flex/grid | `style="display:flex;gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-3);font-siz…` |
| 913 | 固定寬 | `style="flex:0 1 340px;min-width:280px;position:sticky;top:var(--space-3)"` |
| 920 | flex/grid, grid-template | `style="margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px var(--space-2);font-…` |
| 922 | nowrap | `style="color:var(--text-muted);white-space:nowrap"` |

### `js/views/ProjectDbQuery.js` — 8 處

| 行 | 類別 | inline style |
|---|---|---|
| 145 | flex/grid, grid-template | `style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3)"` |
| 171 | flex/grid | `style="display:flex;gap:6px"` |
| 184 | flex/grid, grid-template | `style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(-…` |
| 204 | flex/grid | `style="margin:0;display:flex;align-items:center;gap:8px"` |
| 208 | flex/grid | `style="margin-bottom:var(--space-3);display:flex;align-items:center;gap:var(--space-2)"` |
| 212 | flex/grid | `style="display:flex;gap:8px"` |
| 221 | flex/grid | `style="display:flex;gap:var(--space-2);align-items:center;margin-bottom:var(--space-2)"` |
| 222 | 固定寬 | `style="max-width:280px"` |

### `js/views/AdminPromptLogs.js` — 7 處

| 行 | 類別 | inline style |
|---|---|---|
| 36 | flex/grid | `style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(-…` |
| 46 | 固定寬 | `style="width:150px"` |
| 47 | 固定寬 | `style="width:110px"` |
| 48 | 固定寬 | `style="width:110px"` |
| 65 | flex/grid | `style="margin-top:4px;display:flex;gap:var(--space-3)"` |
| 67 | nowrap | `style="cursor:pointer;color:var(--sidebar-accent);white-space:nowrap"` |
| 70 | nowrap | `style="cursor:pointer;color:var(--sidebar-accent);white-space:nowrap"` |

### `js/views/AdminClassifySamples.js` — 6 處

| 行 | 類別 | inline style |
|---|---|---|
| 35 | 固定寬 | `style="max-width:1000px"` |
| 37 | flex/grid | `style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(-…` |
| 59 | 固定寬 | `style="width:140px"` |
| 77 | 固定寬 | `style="width:150px"` |
| 93 | 固定寬 | `style="width:150px"` |
| 93 | 固定寬 | `style="width:110px"` |

### `js/views/ProjectList.js` — 6 處

| 行 | 類別 | inline style |
|---|---|---|
| 122 | flex/grid, grid-template | `style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(-…` |
| 147 | flex/grid | `style="display:flex;gap:var(--space-2)"` |
| 154 | 固定寬 | `style="max-width:320px"` |
| 162 | flex/grid | `style="margin-top:10px;display:flex;gap:6px"` |
| 179 | flex/grid | `style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap"` |
| 191 | flex/grid | `style="display:flex;gap:var(--space-1);flex-shrink:0;align-self:flex-start"` |

### `js/views/WikiView.js` — 6 處

| 行 | 類別 | inline style |
|---|---|---|
| 8 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-1);padding:6px 8px;border-radius:…` |
| 12 | nowrap | `style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"` |
| 227 | flex/grid | `style="display:flex;justify-content:space-between;font-size:var(--fs-sm);color:var(--tex…` |
| 234 | flex/grid | `style="display:flex;height:calc(100% - 56px);overflow:hidden"` |
| 235 | 固定寬 | `style="width:220px;border-right:1px solid var(--border);overflow-y:auto;padding:var(--sp…` |
| 248 | flex/grid | `style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(-…` |

### `js/views/AdminAgents.js` — 5 處

| 行 | 類別 | inline style |
|---|---|---|
| 79 | flex/grid, grid-template | `style="display:grid;grid-template-columns:280px 1fr;gap:var(--space-4);align-items:start"` |
| 91 | flex/grid | `style="font-size:var(--fs-base);display:flex;justify-content:space-between;align-items:c…` |
| 102 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-1)"` |
| 110 | 固定寬 | `style="width:160px;height:32px;font-size:var(--fs-base);margin-bottom:var(--space-4)"` |
| 119 | flex/grid | `style="margin-top:var(--space-3);display:flex;gap:var(--space-2);align-items:center"` |

### `js/views/AdminRejections.js` — 5 處

| 行 | 類別 | inline style |
|---|---|---|
| 64 | flex/grid | `style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(-…` |
| 76 | 固定寬 | `style="width:150px"` |
| 97 | nowrap | `style="cursor:pointer;color:var(--sidebar-accent);margin-left:6px;white-space:nowrap"` |
| 107 | flex/grid | `style="display:flex;gap:var(--space-2);align-items:baseline;padding:2px 0"` |
| 116 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-3);margin-top:var(--space-3)"` |

### `js/views/AdminUsers.js` — 5 處

| 行 | 類別 | inline style |
|---|---|---|
| 74 | 固定寬 | `style="max-width:900px"` |
| 93 | 固定寬 | `style="max-width:900px"` |
| 97 | 固定寬 | `style="max-width:320px"` |
| 128 | flex/grid | `style="display:flex;gap:6px"` |
| 148 | flex/grid, grid-template | `style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(-…` |

### `js/views/AdminEnterprise.js` — 4 處

| 行 | 類別 | inline style |
|---|---|---|
| 111 | flex/grid | `style="display:flex;align-items:center;justify-content:space-between"` |
| 122 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-3) 0;borde…` |
| 124 | 固定寬 | `style="min-width:110px;font-size:var(--fs-sm);color:var(--text)"` |
| 125 | 固定寬 | `style="flex:1;min-width:220px;font-size:var(--fs-sm);color:var(--text-muted);word-break:…` |

### `js/views/Login.js` — 4 處

| 行 | 類別 | inline style |
|---|---|---|
| 181 | flex/grid | `style="display:flex;justify-content:space-between;margin-top:12px"` |
| 196 | flex/grid | `style="display:flex;justify-content:space-between;margin-top:12px"` |
| 210 | flex/grid | `style="display:flex;justify-content:space-between;margin-top:12px"` |
| 224 | flex/grid | `style="display:flex;justify-content:space-between;margin-top:12px"` |

### `js/views/Admin.js` — 3 處

| 行 | 類別 | inline style |
|---|---|---|
| 301 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none"` |
| 381 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none"` |
| 402 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none"` |

### `js/views/AdminHealthCheck.js` — 3 處

| 行 | 類別 | inline style |
|---|---|---|
| 57 | 固定寬 | `style="max-width:1000px"` |
| 58 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-5)"` |
| 72 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:6px"` |

### `js/views/AdminPortPool.js` — 3 處

| 行 | 類別 | inline style |
|---|---|---|
| 93 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-2) 0;borde…` |
| 94 | 固定寬 | `style="min-width:220px;color:var(--text);font-size:var(--fs-sm)"` |
| 98 | 固定寬 | `style="min-width:120px;font-size:var(--fs-sm);color:var(--text)"` |

### `js/views/Terminal.js` — 3 處

| 行 | 類別 | inline style |
|---|---|---|
| 81 | flex/grid | `style="padding:0;display:flex;flex-direction:column;overflow:hidden"` |
| 83 | flex/grid | `style="flex:1;display:flex;flex-direction:column;min-height:0"` |
| 84 | flex/grid | `style="padding:var(--space-2) var(--space-4);background:var(--sidebar-bg);font-size:var(…` |

### `js/release-modal.js` — 2 處

| 行 | 類別 | inline style |
|---|---|---|
| 41 | 固定寬 | `style="width:600px"` |
| 55 | flex/grid | `style="display:flex;gap:var(--space-2);align-items:baseline;padding:6px 0;border-bottom:…` |

### `js/views/AdminPipelines.js` — 2 處

| 行 | 類別 | inline style |
|---|---|---|
| 61 | 固定寬 | `style="max-width:1000px"` |
| 81 | 固定寬 | `style="max-width:1000px"` |

### `js/views/SearchableSelect.js` — 1 處

| 行 | 類別 | inline style |
|---|---|---|
| 34 | flex/grid, 固定寬 | `style="height:32px;font-size:var(--fs-base);padding:5px 10px;min-width:140px;text-align:…` |

