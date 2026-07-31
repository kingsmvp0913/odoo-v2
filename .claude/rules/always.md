# 平台開發：常駐規則

> 抽自 2026-07-29 的記憶整併。完整清單與來源見 `docs/rules-extraction-2026-07-29.md`。

不分改哪個檔都該知道的。

1. **全跑測試一律 `cd app && npm run test:quiet`（含 `--runInBand`），不要 `npx jest`** — 平行 worker 下 pg-mem 產生浮動假紅，每次紅的套件都不同。`npm test` 同樣正確但輸出 127K（實測 2026-08-01：色碼佔 27%、console 堆疊佔 25%、152 行 PASS，對判斷紅綠全無資訊量）；`test:quiet` 壓到 9K，接 `| grep -vE '^PASS |^$'` 再壓到 3K。**紅了之後**才對那一支單獨跑不帶 `--silent` 的完整輸出——console log 在全綠時是噪音，在除錯時是線索。
2. **`git-integration.test.js:106` 的 CRLF 紅燈與 pgPass flake 是既有問題，乾淨 HEAD 也紅，不要 debug** — 真正結果看 `Tests: X passed` 那行。
3. **改 `app/server/**.js` 後必須重啟 server；只改 agent `.md` prompt 靠 mtime 熱載免重啟** — 常駐進程載的是舊碼，不重啟會誤判修法無效。
4. **commit 前一律 `git status --porcelain -uno` 逐檔挑選，禁用 `git add -A`** — 此 repo 常態是多股平行工作，盲目 commit 會夾帶或蓋掉他人未完成的變更。單一檔案混了他人 hunk 時，用 `git diff -U3` 定位後 `git apply --cached` 只暫存自己的。
5. **多 session 平行工作各自開 git worktree，禁止共用同一個 checkout** — 對方切分支會讓你的 commit 落到錯的分支，甚至被連帶 push 到 origin（已實際發生過）。
6. **找不到某功能時先 `git branch --all --contains` / `git log --all --grep` 查未 merge 分支** — 部分完成的功能常擱在未 merge 分支，只看 master 會重造輪子。
7. **在 GitHub 上把 `ai-dev` 合併回 `main` 只能用一般 merge，禁用 Squash** — squash 產生血緣無關的 commit，下次 main 回同步進 ai-dev 時每個檔案都衝突。此規則無任何 UI／文件落地。
8. **`docs/` 與 `docs/superpowers/` 在 `.gitignore` 內** — spec／plan 不進版控、無法靠 git 傳到別台機器。不要 `git add -f` 硬加。
9. **平台主 clone 常駐 `testing` 分支（測試環境 addons 來源），任何切分支操作結束必須切回** — 停在別的分支會讓下次 deploy 部署到錯分支。切不回去要回報，但不可回滾已完成的 push。
10. **平台目標優先序固定：穩定 > 準確 > 省 token** — 取捨衝突時據此裁決。實測為省 token 而犧牲穩定，反而在失敗迴圈上多花更多。
11. **此 repo 沒有 `project_members` 表，12 個 project 端點裡 11 個只有 `verifyToken`——專案共享是既有設計** — 新增 project 端點不能假設有專案層級授權；高風險動作必須自行加權限檢查。
12. **取指令的 exit code 不要經過管線或尾隨指令** — `cmd | tail`、`cmd; echo "exit=$?"` 拿到的都不是 `cmd` 的碼（背景任務通知回報的也是整串的碼）。此 repo 已因此誤判三次：把失敗的 `docker build` 報成成功、把有紅燈的 `npm test` 讀成 exit 0。**先落檔再統計**，要 exit code 就 `cmd > out 2>&1; echo "EXITCODE=$?" >> out`。

