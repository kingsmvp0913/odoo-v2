# 盤點：layout 類 inline style 待遷移清單

> 由 `app/rwd/inventory/scan.js` 產生（`cd app && npm run rwd:inventory` 可重跑）。
> 對應規格 `RWD-C-SPEC.md` Block 2／3。遷移完重跑一次，剩餘處數即進度。

## 總計

**156 處 inline style / 23 檔**（分類命中 166 次——同一處可同時屬多類）

| 類別 | 命中 |
|---|---|
| flex/grid | 106 |
| 固定寬 | 37 |
| nowrap | 15 |
| grid-template | 8 |

## 分批

| 批次 | 處數 | 範圍 |
|---|---|---|
| Block 1 | 3 | shell template，由 drawer 改造一併處理 |
| Block 2 | 83 | 高頻頁 6 檔 |
| Block 3 | 70 | 其餘全部 |

依「處數平衡」分批，不是依檔案大小：`TaskDetail.js`／`TokenReport.js` 的 127 處是**全部** inline style，
layout 類其實只有 14／17 處，照檔案大小分會讓兩批相差三倍。

## 遷移規則（規格 §2.2，不可放寬）

抽出的 class 內容**與原 inline style 逐字相同**：不順手改值、不合併相似規則、不改順序。
想調整的值一律留到後續 Block、在 media query 內處理。
驗收是像素級的——桌機截圖 diff 必須為 0。

---

## Block 1

### `js/app.js` — 3 處

| 行 | 類別 | inline style |
|---|---|---|
| 147 | flex/grid | `style="display:flex;height:100%;flex:1;min-width:0"` |
| 149 | flex/grid | `style="display:flex;align-items:center;gap:6px"` |
| 193 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-3)"` |

## Block 2

### `js/views/TokenReport.js` — 17 處

| 行 | 類別 | inline style |
|---|---|---|
| 221 | flex/grid | `style="display:flex;gap:var(--space-2);flex-wrap:wrap;margin-bottom:var(--space-4);align…` |
| 222 | 固定寬 | `style="width:100px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--spa…` |
| 228 | 固定寬 | `style="width:140px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--spa…` |
| 230 | 固定寬 | `style="width:140px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--spa…` |
| 232 | 固定寬 | `style="width:160px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--spa…` |
| 237 | 固定寬 | `style="width:160px;font-size:var(--fs-base);height:32px;padding:var(--space-1) var(--spa…` |
| 247 | flex/grid, grid-template | `style="display:grid;grid-template-columns:repeat(7,1fr);gap:var(--space-3);margin-bottom…` |
| 279 | flex/grid, grid-template | `style="display:grid;grid-template-columns:180px 180px 180px 1fr;gap:var(--space-4);margi…` |
| 291 | flex/grid | `style="display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);margin-top:var(--s…` |
| 307 | flex/grid | `style="display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);margin-top:var(--s…` |
| 323 | flex/grid | `style="display:flex;align-items:center;gap:6px;font-size:var(--fs-xs);margin-top:var(--s…` |
| 330 | flex/grid | `style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radi…` |
| 447 | nowrap | `style="padding:var(--space-2) var(--space-3);white-space:nowrap;overflow:hidden;text-ove…` |
| 455 | nowrap | `style="padding:var(--space-2) var(--space-3);color:var(--text-muted);white-space:nowrap;…` |
| 458 | nowrap | `style="padding:var(--space-2) var(--space-3);color:var(--text-muted);white-space:nowrap;…` |
| 459 | nowrap | `style="padding:var(--space-2) var(--space-3);color:var(--text-muted);font-size:var(--fs-…` |
| 516 | nowrap | `style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"` |

### `js/views/ProjectDetail.js` — 14 處

| 行 | 類別 | inline style |
|---|---|---|
| 250 | flex/grid | `style="display:flex;gap:6px;margin-left:var(--space-4)"` |
| 271 | flex/grid | `style="display:flex;justify-content:space-between;align-items:flex-start"` |
| 273 | flex/grid | `style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"` |
| 287 | flex/grid | `style="display:flex;gap:6px;margin-left:var(--space-3);flex-shrink:0"` |
| 297 | flex/grid, grid-template | `style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-2);margin-top:var(--sp…` |
| 300 | flex/grid | `style="display:flex;align-items:center;gap:6px;font-size:var(--fs-base)"` |
| 310 | flex/grid | `style="display:flex;flex-direction:column;gap:var(--space-2);font-size:var(--fs-base)"` |
| 323 | flex/grid | `style="display:flex;flex-direction:column;gap:var(--space-2);font-size:var(--fs-base)"` |
| 325 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none"` |
| 338 | flex/grid | `style="display:flex;flex-direction:column;gap:var(--space-2);font-size:var(--fs-base)"` |
| 344 | 固定寬 | `style="max-width:280px"` |
| 353 | flex/grid | `style="font-size:var(--fs-base);margin-bottom:10px;display:flex;align-items:center;gap:v…` |
| 364 | flex/grid | `style="display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap"` |
| 386 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:6px"` |

### `js/views/TaskDetail.js` — 14 處

| 行 | 類別 | inline style |
|---|---|---|
| 797 | flex/grid | `style="display:flex;justify-content:space-between;align-items:center;margin:var(--space-…` |
| 804 | flex/grid | `style="margin-top:var(--space-2);display:flex;gap:var(--space-2)"` |
| 850 | flex/grid | `style="display:flex;gap:4px;border-bottom:1px solid var(--border);margin-bottom:var(--sp…` |
| 865 | flex/grid | `style="font-size:var(--fs-base);font-weight:var(--fw-semibold);margin-bottom:6px;display…` |
| 958 | flex/grid | `style="display:flex;justify-content:flex-end;gap:var(--space-2);margin-top:var(--space-2)"` |
| 992 | flex/grid | `style="display:flex;justify-content:flex-end;gap:var(--space-2);margin-top:var(--space-2)"` |
| 1017 | flex/grid | `style="font-size:var(--fs-base);font-weight:var(--fw-semibold);margin-bottom:6px;display…` |
| 1027 | flex/grid | `style="display:flex;flex-wrap:wrap;gap:14px;margin-left:24px"` |
| 1029 | flex/grid | `style="font-size:var(--fs-sm);display:flex;align-items:center;gap:5px;cursor:pointer"` |
| 1092 | flex/grid | `style="display:flex;justify-content:flex-end;gap:var(--space-2);margin-top:var(--space-2)"` |
| 1107 | flex/grid | `style="font-size:var(--fs-base);font-weight:var(--fw-semibold);margin-bottom:6px;display…` |
| 1163 | flex/grid | `style="display:flex;align-items:center;justify-content:flex-end;gap:var(--space-2);margi…` |
| 1164 | flex/grid | `style="display:flex;align-items:center;gap:4px;font-size:var(--fs-sm);color:var(--text-s…` |
| 1175 | flex/grid | `style="display:flex;justify-content:space-between;align-items:center;margin:var(--space-…` |

### `js/views/ProjectChat.js` — 13 處

| 行 | 類別 | inline style |
|---|---|---|
| 144 | flex/grid | `style="flex:1;display:flex;overflow:hidden;min-width:0"` |
| 145 | flex/grid, 固定寬 | `style="width:220px;min-width:220px;border-right:1px solid var(--border);display:flex;fle…` |
| 152 | flex/grid | `style="padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:fl…` |
| 155 | nowrap | `style="font-size:var(--fs-base);overflow:hidden;text-overflow:ellipsis;white-space:nowra…` |
| 167 | flex/grid | `style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden"` |
| 168 | flex/grid | `style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-mu…` |
| 172 | flex/grid | `style="padding:8px var(--space-4);border-bottom:1px solid var(--border);display:flex;jus…` |
| 173 | nowrap | `style="font-size:var(--fs-base);font-weight:var(--fw-semibold);overflow:hidden;text-over…` |
| 178 | flex/grid | `style="flex:1;overflow-y:auto;padding:var(--space-4);display:flex;flex-direction:column;…` |
| 193 | flex/grid | `style="display:flex;justify-content:flex-start"` |
| 194 | flex/grid | `style="padding:8px 14px;border-radius:10px;background:var(--surface);border:1px solid va…` |
| 201 | flex/grid | `style="padding:var(--space-3);border-top:1px solid var(--border);display:flex;gap:var(--…` |
| 216 | 固定寬 | `style="width:600px"` |

### `js/views/TaskList.js` — 13 處

| 行 | 類別 | inline style |
|---|---|---|
| 437 | flex/grid | `style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);flex-wrap:wrap;align…` |
| 452 | 固定寬 | `style="width:240px;font-size:var(--fs-base);padding:5px 10px;height:32px"` |
| 470 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-2);p…` |
| 480 | flex/grid | `style="display:flex;gap:6px"` |
| 496 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-2)"` |
| 504 | flex/grid | `style="display:flex;align-items:center;gap:6px"` |
| 530 | flex/grid | `style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"` |
| 542 | flex/grid | `style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"` |
| 543 | flex/grid | `style="display:flex;align-items:center;gap:6px"` |
| 558 | flex/grid, nowrap | `style="position:fixed;bottom:20px;left:50%;transform:translateX(-50%);display:flex;align…` |
| 577 | flex/grid | `style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:cente…` |
| 578 | 固定寬 | `style="background:var(--surface);border:1px solid var(--border);border-radius:10px;paddi…` |
| 600 | flex/grid | `style="display:flex;justify-content:flex-end;gap:var(--space-2)"` |

### `js/views/Settings.js` — 12 處

| 行 | 類別 | inline style |
|---|---|---|
| 188 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:var(--fs-md);ma…` |
| 192 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap"` |
| 193 | flex/grid | `style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:var(--fs-md)"` |
| 197 | nowrap | `style="white-space:nowrap"` |
| 256 | 固定寬 | `style="max-width:420px"` |
| 300 | 固定寬 | `style="margin-top:10px;max-width:320px"` |
| 302 | flex/grid | `style="display:flex;gap:var(--space-2)"` |
| 304 | nowrap | `style="white-space:nowrap"` |
| 332 | 固定寬 | `style="margin-top:10px;max-width:320px"` |
| 334 | flex/grid | `style="display:flex;gap:var(--space-2)"` |
| 336 | nowrap | `style="white-space:nowrap"` |
| 354 | 固定寬 | `style="max-width:420px"` |

## Block 3

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

### `js/views/ProjectList.js` — 5 處

| 行 | 類別 | inline style |
|---|---|---|
| 94 | flex/grid, grid-template | `style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(-…` |
| 119 | flex/grid | `style="display:flex;gap:var(--space-2)"` |
| 126 | 固定寬 | `style="max-width:320px"` |
| 134 | flex/grid | `style="margin-top:10px;display:flex;gap:6px"` |
| 151 | flex/grid | `style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap"` |

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

### `js/views/AdminPortPool.js` — 2 處

| 行 | 類別 | inline style |
|---|---|---|
| 89 | flex/grid | `style="display:flex;align-items:center;gap:var(--space-4);padding:var(--space-2) 0;borde…` |
| 91 | 固定寬 | `style="min-width:140px;font-size:var(--fs-sm);color:var(--text)"` |

