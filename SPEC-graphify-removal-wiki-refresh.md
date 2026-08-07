# 施工規格書：wiki 重生修補 ＋ graphify 移除

> 產出日期：2026-08-07
> 調查來源：本 repo 實地讀碼（非推測）
> 執行方式：在主機上人工施作
> 順序：**先做案子 B，確認後再做案子 A**。兩批分開 commit。

---

## 目錄

- [施工前準備](#施工前準備)
- [案子 B：修 wiki 重生會弄丟內容](#案子-b修-wiki-重生會弄丟內容)
- [案子 A：移除 graphify](#案子-a移除-graphify)
- [收尾檢查表](#收尾檢查表)

---

## 施工前準備

### 環境確認

```bash
cd <repo 根>
git status --porcelain -uno      # 應為空。有殘留先處理掉
node -v                          # 確認 node 可用
```

### 兩條專案規矩（別忘）

1. **commit 前一律 `git status --porcelain -uno` 逐檔挑選，禁用 `git add -A`**
   這個 repo 常態多股平行工作，盲目 commit 會夾帶別人未完成的變更。

2. **改完 `app/server/**.js` 必須重啟 server**
   常駐 process 載的是舊碼，不重啟會誤判「改了沒效」。

### 測試怎麼跑

```bash
cd app && npm run test:quiet
```

**不要用 `npx jest`**（平行 worker 下 pg-mem 會產生浮動假紅）。

已知的既有紅燈，不要 debug：

| 測試 | 原因 |
|---|---|
| `git-integration.test.js` 的 `ensureWorktreeAtMain` 兩支 | CRLF 行尾差異，Windows checkout 必紅 |
| `vpn-gateway-run.test.js` 的 `defaultTmpFilePath › 容器化…` | 測容器內落點，開發機非容器故必紅 |

除這兩支外的紅燈，**先假設是 flaky**，單獨再跑一次那一支確認。

---

# 案子 B：修 wiki 重生會弄丟內容

## 問題是什麼（白話）

wiki 有三種頁：**概論**、**模組頁**、**功能頁**。每頁都有「⟳ 重新生成」按鈕。

按下去時，系統把資料交給 AI 重寫。問題在**交什麼**：

| 頁面類型 | 交給 AI 的東西 | 結果 |
|---|---|---|
| 功能頁 | 原始碼 ＋ **這頁現在的內容** | ✅ 正常，AI 能「保留對的、補不足的」 |
| 概論頁 | 只有各模組 manifest | ❌ **看不到舊內容，從零重寫** |
| 模組頁 | 只有原始碼節錄 | ❌ **看不到舊內容，從零重寫** |

所以概論頁和模組頁按一次 ⟳，**你手動潤過的字、之前累積上去的內容，全部消失**，而且沒有任何警告。

更矛盾的是，`.claude/agents/library.md` 給 AI 的指示明寫著：

> 保留既有正確內容，只補充與修正，非必要不刪除。

這條規矩對這兩種頁**根本無法執行**——AI 手上沒有舊內容可以保留。這是指示與實作不一致，不是 AI 不聽話。

## 改哪裡

**檔案**：`app/server/pipeline/library-agent.js`
**函式**：`refreshWikiNode`
**位置**：約 132–158 行的 `context` 組裝區

### 改法 1：概論頁（overview）

找到這一段：

```js
  if (node.node_type === 'overview') {
    const manifests = [];
    for (const r of readyRepos) _collectManifests(r.local_path, manifests, 15);
    context = `類型：重建專案概論（overview，200-400 字繁中）
回傳 {"slug":"overview","title":"專案概論","content":"<Markdown>"}
專案「${project.name}」

${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;
  }
```

改成：

```js
  if (node.node_type === 'overview') {
    const manifests = [];
    for (const r of readyRepos) _collectManifests(r.local_path, manifests, 15);
    context = `類型：精修專案概論（overview，200-400 字繁中），保留正確內容、補充與修正
回傳 {"slug":"overview","title":"專案概論","content":"<Markdown>"}
專案「${project.name}」

現有內容：
${node.content || '（空）'}

各模組 manifest：
${manifests.map(m => `=== ${m.module} ===\n${m.content}`).join('\n\n')}`;
  }
```

**兩處要改**，缺一不可：
1. 開頭「重建」改「精修」，並補上「保留正確內容、補充與修正」
2. 資料裡加入 `現有內容：` 段落

> 為什麼措辭也要改：功能頁那支就是寫「精修…保留正確內容、補充與修正」，只餵資料而不改指示，AI 仍會照「重建」二字整份重寫。

### 改法 2：模組頁（module）

找到這一段：

```js
  } else if (node.node_type === 'module') {
    const moduleName = node.slug.replace(/^module-/, '');
    const src = _collectModuleSource(readyRepos, moduleName);
    context = `類型：重建模組頁（module，繁中 Markdown）
回傳 {"slug":"${node.slug}","title":"${moduleName}","content":"<Markdown>"}
模組「${moduleName}」原始碼節錄：
${src || '（無原始碼）'}`;
  }
```

改成：

```js
  } else if (node.node_type === 'module') {
    const moduleName = node.slug.replace(/^module-/, '');
    const src = _collectModuleSource(readyRepos, moduleName);
    context = `類型：精修模組頁（module，繁中 Markdown），保留正確內容、補充與修正
回傳 {"slug":"${node.slug}","title":"${moduleName}","content":"<Markdown>"}
現有內容：
${node.content || '（空）'}

模組「${moduleName}」原始碼節錄：
${src || '（無原始碼）'}`;
  }
```

### 功能頁不要動

`else` 那一支（功能頁）已經是對的，**不要碰**。它是這次修改的參照樣板。

## 要注意的一件事

概論頁的資料包本來就塞了最多 15 個模組的 manifest，再加上舊內容會變長。

施工後**實際重生一次概論頁**，到平台的用量頁看那次 wiki 關的 input token。如果明顯偏高（例如超過同專案模組頁的數倍），把 `_collectManifests(r.local_path, manifests, 15)` 的 `15` 調小到 `10` 再測一次。

不用預先調，先量了再說。

## 測試怎麼加

**檔案**：`app/server/tests/library-agent.test.js`

加兩支測試，斷言「重生概論／模組頁時，送給 AI 的資料裡確實包含現有內容」。

作法是把 `runClaude` mock 掉，攔截它收到的字串，檢查裡面有沒有舊內容的關鍵字：

```js
test('重生概論頁：現有內容必須送進 AI（否則累積的知識會被沖掉）', async () => {
  // 鋪一顆有內容的 overview
  // 呼叫 refreshWikiNode
  // 斷言 runClaude 收到的 prompt 含 'OV-累積內容'
});

test('重生模組頁：現有內容必須送進 AI（否則累積的知識會被沖掉）', async () => {
  // 同上，node_type='module'
});
```

**測試要測意圖，不是測字串長相**：斷言重點是「舊內容有沒有進到 prompt」，不要去斷言整段 context 的完整格式——那種測試改個換行就紅，卻抓不到真正的退化。

參考同檔既有測試的 pg-mem ＋ mock 慣例（第 79–96 行、191–206 行有現成範例）。

## 驗收標準

1. `cd app && npm run test:quiet` — 新加的兩支綠，其餘不變（扣掉上面列的既有紅燈）
2. 重啟 server
3. **實際操作驗證**：
   - 找一個有內容的專案，開概論頁，手動加一句好認的字（例如「這句是人工加的」）
   - 按 ⟳ 重新生成
   - **那句話應該還在**（或至少語意被保留），而不是整頁被換掉
   - 模組頁重複一次同樣驗證

第 3 項是真正的驗收——測試只能證明資料有送進去，證明不了 AI 有照做。

## Commit

```
[Wiki]: 概論與模組頁重生未帶入現有內容，導致累積知識被整份沖掉
```

---

# 案子 A：移除 graphify

## 為什麼要拔（白話）

現在每接一個新 repo，系統會偷偷跑一支 Python，畫一張「程式碼裡誰連到誰」的關係圖，在硬碟留下約 3.3MB 檔案。

四個問題：

1. **沒有人在看。** 整個專案翻過，`graph.json` 和 `GRAPH_REPORT.md` **沒有任何一行程式或 AI 指示在讀**。
2. **AI 拿到的是廢話。** 有兩行指示叫 AI 讀一份索引檔，但因為走的是純 AST 模式（沒開 AI 標記），那份檔案內容長這樣：
   ```
   ## Community 28
   - name [app/package.json]
   - version [app/package.json]
   ```
   完全沒有語意，AI 讀完還是得自己去搜。
3. **圖是化石。** 只在 repo 接進來時畫一次，之後程式天天改，圖永遠停在那天。
4. **唯一成果**是畫面上一顆「✓ 已索引」的綠標籤。

**重點：不是這工具爛，是接的方式從一開始就不對。** 官方設計是讓 AI 用 `graphify query` 或 MCP 即時查圖，不是倒一份檔案叫 AI 自己讀。要接對得重做，還得加增量更新——投入不小，而 Odoo 專案結構本來就有慣例（`models/`、`views/`、`security/`），直接搜就找得到。

## 逐項施工清單

> ⚠️ 有兩處比想像中細，已標紅字，別漏。

### A-1. 後端：拿掉自動觸發（**兩處**）

**檔案**：`app/server/project-routes.js`

⚠️ **`runGraphify` 有兩個呼叫點，不是一個。**

| 行號 | 情境 | 動作 |
|---|---|---|
| 第 6 行 | `const { runGraphify } = require('./pipeline/graphify-runner');` | 刪掉這行 import |
| 第 133 行 | clone 完成後 | 刪掉 `runGraphify(repoId, destPath);` |
| 第 268 行 | `updateMainClone` 更新完成後 | 刪掉 `runGraphify(repoId, destPath);` |

第 268 行很容易漏——它在另一個函式裡，跟 clone 那條路是分開的。

### A-2. 後端：拿掉開機續跑

**檔案**：`app/server/index.js`，約 216–221 行

刪掉整個 try 區塊：

```js
    try {
      const { rows: stuck } = await q(
        "SELECT id, local_path FROM project_repos WHERE graphify_status='running' AND local_path IS NOT NULL"
      );
      const { runGraphify } = require('./pipeline/graphify-runner');
      for (const r of stuck) runGraphify(r.id, r.local_path);
    } catch (e) { console.error('[STARTUP] graphify resume:', e.message); }
```

同時把上面第 209–210 行的註解修掉——它提到 graphify：

```js
    // fire-and-forget 的 running 殘留：可續跑的直接續跑（健檢從中斷點接續、graphify 冪等重建），
    // 不再一律標 error 作廢
```

改成：

```js
    // fire-and-forget 的 running 殘留：可續跑的直接續跑（健檢從中斷點接續），
    // 不再一律標 error 作廢
```

### A-3. 刪除 runner

**刪檔**：`app/server/pipeline/graphify-runner.js`

```bash
git rm app/server/pipeline/graphify-runner.js
```

### A-4. Python 腳本改成手動工具（**不是刪掉**）

**移動**：`app/server/pipeline/graphify_index.py` → `scripts/graphify_index.py`

```bash
git mv app/server/pipeline/graphify_index.py scripts/graphify_index.py
```

**為什麼留**：報告裡的「God Nodes」（例：`showToast()` 被 119 個地方連到）和「意外的關聯」對**人**偶爾有洞察力，適合一季看一次。但那是手動跑的事，不該天天自動跑。

移完後在檔案開頭的 docstring 補一句說明它現在是手動工具，並拿掉那行過時註解：

```python
  <repo_path>/graphify-out/wiki/index.md  (for Get-WikiCache)
```

`Get-WikiCache` 是已退役的舊 PS1 pipeline，這行早就沒意義了。

手動跑法：

```bash
pip install graphifyy networkx
python3 scripts/graphify_index.py <repo 路徑>
```

### A-5. AI 指示：刪掉兩行誤導

| 檔案 | 行號 | 刪掉的內容 |
|---|---|---|
| `.claude/agents/analysis-project.md` | 13 | `- 本專案程式碼：先讀 ./graphify-out/wiki/index.md（有記載則優先參考，不存在則跳過），再用 Glob/Grep/Read 探索。` |
| `.claude/agents/coding-project.md` | 19 | 同上 |

**不要整行刪光**——後半段的 Glob/Grep/Read 指示要留著。改成：

```
- 本專案程式碼：用 Glob/Grep/Read 探索。
```

> 這兩個檔是 AI 的 prompt，改完**靠 mtime 熱載，不用重啟 server**。

### A-6. 安裝腳本：拿掉 Python 套件安裝

| 檔案 | 動作 |
|---|---|
| `scripts/setup.js` 第 12 行 | 刪 `const { ensureGraphify } = require('./lib/graphify');` |
| `scripts/setup.js` 第 49–50 行 | 刪這兩行： |

```js
  const graphifyStep = ensureGraphify();
  console.log(`[OK] graphify 索引相依已就緒（${graphifyStep.status}）`);
```

**刪檔**：`scripts/lib/graphify.js`

```bash
git rm scripts/lib/graphify.js
```

> 順帶效果：全新機器一鍵安裝不再需要裝 `graphifyy` + `networkx`，少一個 PEP 668 踩雷點。

### A-7. 前端：⚠️ 不是單純刪三顆標籤

**檔案**：`app/public/js/views/ProjectDetail.js`

⚠️ **`hasIndexing` 還牽動輪詢邏輯**，只刪標籤會留下壞掉的 watch。四處都要動：

**(1) 第 34 行** — 刪掉 computed：

```js
    hasIndexing() { return this.repos.some(r => r.graphify_status === 'running'); },
```

**(2) 第 42–49 行** — watch 要改。原本是：

```js
    hasCloning(val) {
      if (val || this.hasIndexing) this._startReposPoll();
      else this._stopReposPoll();
    },
    hasIndexing(val) {
      if (val || this.hasCloning) this._startReposPoll();
      else this._stopReposPoll();
    }
```

改成（只留 clone 那條）：

```js
    hasCloning(val) {
      if (val) this._startReposPoll();
      else this._stopReposPoll();
    }
```

注意 `hasCloning` 後面原本的逗號要改成沒有（它變成最後一個屬性了）。

**(3) 第 338–340 行** — 刪掉三顆標籤：

```html
                <span v-if="r.graphify_status === 'running'" class="pill pill-warn">⟳ 索引中...</span>
                <span v-else-if="r.graphify_status === 'done'" class="pill pill-success">✓ 已索引</span>
                <span v-else-if="r.graphify_status === 'error'" class="pill pill-danger" :title="r.graphify_error">✕ 索引失敗</span>
```

**(4)** 全檔再 grep 一次確認沒有殘留：

```bash
grep -n "graphify\|hasIndexing" app/public/js/views/ProjectDetail.js
```

應該一個都不剩。

### A-8. 測試調整

| 檔案 | 行號 | 動作 |
|---|---|---|
| `app/server/tests/project-routes-clone-pat.test.js` | 30 | 刪掉 `jest.mock('../pipeline/graphify-runner', () => ({ runGraphify: jest.fn() }));` |
| `app/server/tests/git.test.js` | 340 | 只是註解提到 graphify 當舉例，**改文字即可，測試本身不要動** |

`git.test.js:340` 的註解原文：

> 產物（graphify 輸出等）會被一併掃進 testing、污染部署產物。此防線失效要立即翻紅。

改成：

> 產物（deploy 輸出等）會被一併掃進 testing、污染部署產物。此防線失效要立即翻紅。

那條防線（禁用 `git add -A`）本身照舊有效，不要動測試邏輯。

### A-9. 前端 demo 資料

**檔案**：`app/public/js/tour-demo.js` 第 142 行

裡面有假資料 `graphify_status: 'done'`，刪掉那個欄位即可（同一行還有 `is_primary`、`clone_status`，留著）。

### A-10. 資料庫：**不要動**

`project_repos` 的 `graphify_status`、`graphify_error` 兩個欄位**留著不管**。

理由：這個 repo 的 migration 慣例是只加不減（見 `db.js` 第 523–524 行的加欄位寫法）。留著沒成本，硬刪要寫 migration、要考慮回滾，風險大於收益。

### A-11. 清掉本機殘留產物（選用）

repo 根目錄的 `graphify-out/`（約 13MB）是先前手動跑完整版留下的，**不在版控內**，可以直接刪：

```bash
rm -rf graphify-out/
```

各專案 clone 目錄底下的 `graphify-out/` 同理，不刪也不影響（`git.js` 本來就會在切分支前清未追蹤殘留）。

## 驗收標準

1. **全檔 grep 乾淨**：

```bash
grep -rn "graphify" --include="*.js" --include="*.md" app/ scripts/ .claude/ | grep -v node_modules
```

預期只剩：
- `scripts/graphify_index.py` 本身（手動工具，保留）
- `app/server/db.js` 第 523–524 行（欄位定義，刻意保留）
- `app/server/pipeline/git.js` 第 513、717 行的註解（提到清未追蹤產物，可留可改）
- `.claude/rules/infra.md` 第 16 行（歷史紀錄，**建議加註「已移除」而不是刪掉**，這是踩過的坑值得留痕）

2. **測試**：`cd app && npm run test:quiet` 全綠（扣掉既有紅燈）

3. **重啟 server**

4. **實際操作驗證**：
   - 新增一個 repo，確認 clone 正常完成
   - 專案詳情頁**不再出現「索引中／已索引」標籤**
   - clone 進行中時，「⟳ Clone 中...」的**自動刷新仍正常運作**（這是 A-7 改壞最容易出事的地方）

5. **安裝腳本**：`node scripts/setup.js` 跑得過，不再嘗試裝 Python 套件

## Commit

```
[Platform]: graphify 索引無任何消費者且產物永不更新，移除自動觸發改為手動工具
```

---

# 收尾檢查表

兩批都做完後：

- [ ] 案子 B 的 commit 獨立於案子 A
- [ ] 每次 commit 前都用 `git status --porcelain -uno` 逐檔挑過，沒有 `git add -A`
- [ ] `cd app && npm run test:quiet` 全綠（扣既有紅燈）
- [ ] server 已重啟
- [ ] 概論頁／模組頁 ⟳ 重生後，人工加的字還在
- [ ] 專案頁沒有索引標籤，但 clone 中的自動刷新正常
- [ ] repo 停在正確分支（**主 clone 常駐 `testing`，切過分支要切回去**）

---

## 沒有納入這次施工的事

**案子 C（wiki 全域體檢 ＋ 矛盾標注）刻意不做。**

- **C1 全域體檢**：找孤兒頁、斷鏈、空白頁。現在只有點狀的 `wiki-drift`（要有人剛好問到才會發現錯誤），缺定期全身檢查。
- **C2 矛盾標注**：現在給 AI 的指示是「保留正確內容、補充與修正」，當新資訊跟舊敘述打架時會被安靜抹掉。在「疑難排解」頁尤其危險——舊結論可能早被推翻，頁面上看起來卻仍很篤定。

擱置理由：價值低於 A、B，且 C2 會影響所有專案的 wiki 產出品質，需要觀察期。等 A、B 落地後看實際狀況再決定。
