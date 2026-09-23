---
name: exam-system-into-platform
description: Odoo 認證考試系統併入平台——第 0-3 期完成（對立審查 30/30、資料層、信心度、題庫介面），碼在 master；**server 未重啟所以 API 還是 404、前端未經瀏覽器實測**
metadata: 
  node_type: memory
  type: project
  originSessionId: e6eef38b-6ce5-4471-b4ea-8776dd19ee60
---

2026-09-04：第 0～3 期完成，**15 個 commit 已在 master**（`fae18884`→`29c71e13`）。

- 規格：`docs/superpowers/specs/2026-09-04-odoo-exam-platform-design.md`
- 計畫：`docs/superpowers/plans/2026-09-04-odoo-exam-platform.md`
- 驗證報告：`docs/superpowers/specs/2026-09-04-adversary-bench-result.md`
- `/solve` 要貼的段落：`docs/superpowers/specs/solve-md-patch.md`（那個檔在使用者 Windows 那台，這裡改不到）
- ⚠ 全在 `docs/` 底下＝**不進版控**，只在這台機器上

## ⚠ 兩件擋住驗收的事

1. **server 未重啟** ⇒ `/api/exam/*` 全部 404（實測 `/api/inbox` 回 401 但 `/api/exam/banks` 回 404）。
   容器內 kill node 會連 postgres 一起收掉，**要請使用者在主機 `docker restart`**。
2. **前端一次都沒在瀏覽器開過**。此 repo 沒有 playwright／puppeteer，前端本來就沒有自動化測試
   （`rules/frontend.md` 第 30 條），**深色模式也沒看過**。

## 使用者拍板的五個決定（不是我選的，不要擅自改）

1. **全部併進平台**，入口在「更多工具」→ 認證題庫（`/exam-bank`）
2. **只有官方確認全對的題能走捷徑**——`/api/exam/lookup` 在 server 端就濾掉非 100%
3. **不留盲判，直接對立審查**；信心 < 90 才強制取證
4. **中譯：術語表優先**；翻譯綁在「讀截圖」那一步不綁審查
5. **題庫列表按章節分組**，英文一行、中文點開才看

## 第 0 期結論：對立審查完勝盲判（實測 30 題）

分數 **30/30**（盲判 28/30）、假陽性 **0/27**、每題 10.4s。

**別把 30/30 當成比它更強的證據**：判題陷阱是從那批題的錯題反推寫的（事後諸葛）；
0/27 用 Rule of Three 的 95% 上界是 **11%** 不是 0%；只有 3 個錯題推論不出召回率。

## 實跑 19 頁抓到的缺陷（測試全都抓不到）

- **術語表塞的是虛詞**：`the→於`／`can→罐`／`g→克`／`A→A`。加嚴（長度≥3、首字大寫、
  譯文含中文、譯文≠原文）後 32,288 → **25,015**，真術語一個沒掉
- **`lookupTerms` 無上限**，一頁命中 75 個塞爆 prompt → 上限 25、長的優先
- **譯文檢查比錯對象**：拿整頁術語比單題譯文，每題吐十幾條假警報 → 加 `termsIn` 逐題篩，降到 1 條
- **單頁逾時炸掉整批**：跑到第 10 頁逾時 exit 1，後面 10 頁沒跑，而前 9 頁已寫 DB
  ⇒ 從結果看不出少了一半。已改成單頁失敗只跳過該頁＋已審查的自動跳過（可續跑）
- 8–12 題的頁 180s 逾時不夠，用 `EXAM_JUDGE_TIMEOUT_MS=300000`

## 安全：agent 拿得到 Read/Grep，而官方答案在同一個 repo

- **prompt 不給絕對路徑**：截圖複製進每次呼叫獨立的暫存目錄，只給檔名 `shot.jpg`。
  給絕對路徑等於告訴 agent repo 在哪，它可以自己去讀 `answer-key.json`
- **取證用 symlink 縮視野**：cwd 是 tmpdir 空目錄，底下只放 `src/` → `data/odoo-core/<ver>/`；
  父目錄鏈只有 `/tmp` 與 `/`，沒有任何我們的 CLAUDE.md
- **Node 端硬驗 ref 落在 `src/` 內**否則丟棄——prompt 裡的限制是 soft instruction，這一關才硬
- 殘留風險：`--dangerously-skip-permissions` 是無人監督自動化的必要條件，真正的隔離要靠容器

## 19 頁全跑完的結果（120/120 題）

| 項目 | 數字 |
|---|---|
| 審查 | 120/120 題，推翻 8 題 |
| 證據 | 150 筆原始碼行號 |
| **選項中譯** | **120/120**（需求 2 完成） |
| 已校準 | 70 題，風險總和 **15.03** vs 官方 15（誤差 0.03，驗收 §15 #4 通過） |
| 未校準 3 題 | 正好對應官方說的 3 題未作答，**本來就不該算**（沒作答 ≠ 答錯） |

信心度分布：100 官方確定 **47**／85-99 **41**／70-84 **14**／50-69 **10**／<50 **8**。

**盲區約 7 題**：官方說錯 15 題，審查只推翻 8 題 ⇒ 剩下 7 題是審查與作答者一起錯的，
交叉驗證看不見。信心最低的兩題都是 Accounting（4%）。

實跑成本：**約 24 秒/題**（審查 15.6s + 58% 的題要取證）。**題數越多的頁每題越慢**
（5 題 9.4s/題、12 題 24.3s/題），因為一次呼叫要抄完整頁的題幹與所有選項再翻譯。

## 還沒做

- **`exam_jobs` 的佇列與併行**（Task 2.6）：表建了但沒有程式用它。目前上傳只會落
  `exam_uploads` 標 pending，**沒有 worker 去跑**。併行上限建議 3（原專案實測 2→3，
  再高會排擠平台自己的 pipeline，Claude 帳號全平台共用）
- **前端沒有版本切換 UI**：`/api/exam/versions` 端點做了但沒接；選題庫等於選版本
- **前端沒有上傳畫面**：端點有了（`POST /api/exam/submit`／`/batch`），但沒有頁面
- **`data/exam/upload-token.txt` 還沒建**，不建的話外部上傳一律 503

實作時會撞到 [[pgmem-on-conflict-returning-lies]]（三個 pg-mem 相容性坑都在那）。
