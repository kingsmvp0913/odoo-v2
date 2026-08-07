---
name: pipelineFlow
description: Use when you need to understand or change the task pipeline — what stages exist, how they connect, what enters/exits each one, retry limits, or which agent runs a stage. Read this before touching server/pipeline/*, verdict-router, reject-triage, or the flow diagram. The content source is app/public/js/pipeline-spec.js (pure data, ~350 lines) — read that instead of reverse-engineering the runner.
---

# pipelineFlow — 任務流程的單一內容來源

## 要讀哪個檔

**`app/public/js/pipeline-spec.js`** —— 純資料：有哪些關、彼此怎麼接、每一關的進入條件／做什麼／成功往哪／失敗往哪、上限值、跑哪支 agent。約 350 行，直接 `Read` 就好。

**不要**為了搞懂流程去讀 `server/pipeline/runner.js`＋`verdict-router.js`＋`reject-triage.js`（合計 850 行，轉移邏輯散在各關的 inline 賦值）。spec 就是為了省這一步而存在的。

`app/public/js/views/PipelineFlow.js`（約 930 行）**只負責畫**——泳道排版與曼哈頓路由，跟流程內容無關。要改流程不要動它。

## 資料形狀

```js
const { pipelineNodes, pipelineEdges, pipelineTracks, PF_UNDRAWN_STATUSES } = require('./pipeline-spec.js');
const flags = { e2eEnabled: false, specTour: false, showGit: true };   // 預設＝新專案的實際樣子
pipelineNodes(flags);   // [{ id, track, step, kind, label, status?, ref?, agent?, detail: [[標題, 內容], ...] }]
pipelineEdges(flags);   // [[from, to, 'main'|'alt'|'back'|'link'], ...]
```

- `status` 只放**真的任務狀態**（對得上 `public/js/status-labels.js`）；Git 分支名與「不是狀態」的說明放 `ref`。
- 邊的類型：`main` 主線／`alt` 條件分支／`back` 退回失敗／**`link` 是 Git 對應線，不是流程轉移**（表達「這一關在 Git 上做了什麼」，別讀成任務會走過去）。
- 三個 flag 會實際增刪節點與連線，不是只隱藏。`e2eEnabled`／`specTour` 對應專案設定（`e2e_disabled` 的反面、`spec_tour_enabled`），`showGit` 純顯示。
- `PF_UNDRAWN_STATUSES`：`[[狀態, 不畫的理由], ...]`——真的存在但刻意不畫的過渡態（答完就走，不會停在那裡）。

## 改流程的順序（重要，不要弄反）

spec **不驅動執行**——它是一份人工謄本。真正在跑的狀態機在 `server/pipeline/*`，轉移是各關 inline 賦值，沒有集中的轉移表。

1. 先改 `pipeline-spec.js`，把流程講清楚（這是討論與對焦的載體）
2. 再改 `server/pipeline/` 對應的那幾支
3. `cd app && npx jest server/tests/pipeline-flow.test.js` —— 測試會逼你兩邊同步

## 測試守住什麼（改完一定要跑）

`app/server/tests/pipeline-flow.test.js`，102 支，八種 flag 組合全跑：

- 圖上畫的 status 都是真狀態；`NEEDS_ACTION_STATUSES` 全部畫得到
- **runner 實際會設定的任務狀態，圖上都畫得到**（或已具名列進 `PF_UNDRAWN_STATUSES` 並寫理由）—— 這條擋的是「加了新關卻忘了畫」
- **每個節點都從入口走得到** —— 擋的是「拿掉一條轉移，整段變成走不到的半島」。孤兒檢查擋不住這個（實測過）
- 同泳道不撞 step、id 不重複、連線兩端都存在、link 線一定 git→非 git、每個節點都有 detail
- `index.html` 有載入 spec 且排在 view 之前（漏了是整頁白畫面，而 jest 照樣綠）

## 改到畫圖那一側時

動 `views/PipelineFlow.js` 的路由或版面之前，先讀該檔**檔頭**：三條連線原則、可貼進 Console 的幾何檢查器（交叉／重疊／貼線／穿過方塊／字貼框），以及量測前要先清 hover 的陷阱。

驗證方式是**八組合快照比對**：改動前後把每條線的 `data-edge → d` 字串、節點文字座標、hover 面板文字全部 dump 下來要求逐字元相同。抽資料層那次就是這樣證明版面零變動的。
