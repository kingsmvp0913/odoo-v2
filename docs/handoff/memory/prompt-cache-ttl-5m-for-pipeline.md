---
name: prompt-cache-ttl-5m-for-pipeline
description: Claude Code 沒設定也會走 1h prompt 快取（寫入 2× 而非 5m 的 1.25×）；pipeline 是相反的形狀，已釘 5m 省約 12-14%，而 token-cost.js 的 1.25 係數跟這個釘子綁死
metadata:
  node_type: memory
  type: project
---

2026-09-10 查證＋實測。`648487c6` 已 push。**2026-09-22 回頭驗收：已生效，實測淨省 16.4%**（見末段）。

## 事實一：預設是 1h，而且沒有任何地方寫著

環境變數與 `~/.claude/settings.json`、專案 `.claude/settings.json` **全都沒設**，實測
`usage.cache_creation` 仍然 `{"ephemeral_1h_input_tokens": 31488, "ephemeral_5m_input_tokens": 0}`。
是 Claude Code 自己的預設。可控，鍵名在 CLI 二進位裡（`claude.exe` 用 `grep -a` 撈得到）：

- `CLAUDE_CODE_PROMPT_CACHE_TTL` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`（值只吃 `"5m"` 或 `"1h"`）
- settings.json 的 `promptCacheTtl` / `subagentPromptCacheTtl`
- 優先序（從二進位還原）：`env → settings → agent frontmatter → ENABLE_PROMPT_CACHING_1H → 預設 5m`

官方費率（`claude-api` skill 的 `shared/prompt-caching.md:144`）：**寫入 5m=1.25×、1h=2×，讀取 0.1×**。
且「**cache read 會免費重置計時器**」——所以只要下一次請求在 TTL 內*開始*，快取就一直活著。

## 事實二：pipeline 與互動 session 是相反的形狀

| | 互動 session（CLI 的主場） | 本平台 pipeline |
|---|---|---|
| 行程 | 一個 session 活到尾，前綴累積數十萬 | 每關獨立短命行程，跑完就死 |
| 呼叫間隔 | 人在打字，幾分鐘到幾十分鐘 | 91% 在 1 分鐘內 |
| 跨空檔帶得走的 | 整個 session | **只有開頭 16,808 tokens** |

**1h 的預設是為互動場景調的**，套在 pipeline 上等於六成以上的呼叫付 2× 買不到東西。
所以 **A（pipeline 釘 5m）做、B（`~/.claude/settings.json`）不做**——這場對話本身就是 1h 划算的形狀。

## 事實三：`token-cost.js` 的 1.25 係數跟這個釘子綁死

該檔用 `cache_create * 1.25`，那是 5m 的費率。在釘住之前平台實際跑 1h，**整份成本報表低估 20.5%**，
cache_create 其實是最大宗（正確費率下 45.3%，不是帳面的 34.1%）。現在釘 5m 讓 1.25 變成對的，
並在 `claude-runner.test.js` 加了一支測試把「env 有 5m」與「係數是 1.25」綁在一起——拿掉釘子測試會紅。
⚠ 2026-09-10 之前的歷史成本數字本來就低估，無法回頭修正。

## 怎麼驗這件事（可重跑）

```bash
claude -p --model haiku --output-format stream-json --verbose "只回兩個字：測試" \
  | python3 -c "import json,sys;[print(json.loads(l)['message']['usage']['cache_creation']) for l in sys.stdin if l.strip() and json.loads(l).get('type')=='assistant'][:1]"
```
看 `ephemeral_5m` vs `ephemeral_1h` 哪個有值。

跨空檔帶得走多少：跑 prompt A → `sleep 380` → 跑**不同的** prompt B（同 cwd）→ 看 B 第一輪的
`cache_read_input_tokens`。實測 **16,808**（＝system prompt + tool schemas）。
損益兩平線是 **~144,000**，差一個數量級，所以 5m 穩贏；淨省估 **12-14%**。

## 三個判讀陷阱（都真的絆到我）

1. **只換乘數是錯的算法**。改 5m 之後過期重寫會讓 cache_create 的**token 數變多**，不是只有單價變。
   正確式子：`省 = 0.75 × cache_create − 1.15 × Δ`，Δ＝跨空檔帶得走的前綴。Δ 必須量，不能猜。
2. **`token_usage` 是整關卡加總一筆，沒有 per-API-call 粒度**，所以「帶得走多少」資料庫裡查不到。
   拿平均值反推會被 run 大小汙染——實測 bucket「5-60 分」的 cache_read 是「≤5 分」的三倍，
   那不是快取行為，是「跑比較久的關卡，下一次間隔自然比較長」。這題只能做實驗。
3. **量「一輪多久」不能直接拿 `task_events` 的相鄰時間差**，那裡混了關卡交界與 `review_pending` 等人，
   會灌水到 0.62%。要用 `⚙`（工具呼叫）與 `▶`（關卡切換）切段：以 `▶` 累加成 run_seg，只算同一
   run_seg 內相鄰 `⚙` 的間隔——真值是 **13,607 次裡只有 2 次超過 5 分鐘（0.01%）**。

## 順帶量到的成本結構（正確費率下）

cache_create 45.3% ／ cache_read 33.7% ／ output 18.6% ／ input（全新未快取）**2.4%**。
流量歸屬：task 76.7% ／ chat 14.3% ／ 其他（健檢、platform_fix、意見統整…）9.1%。
**「壓 prompt 省 input」對這個平台幾乎無效**，因為 input 只有 2.4%。

相關：[[token-usage-underreports-cost]]、[[headroom-installed-parked]]、[[health-check-green-is-hollow]]

## 2026-09-22 事後驗收（12 天實際資料）

釘子活著：`CLAUDE_CODE_PROMPT_CACHE_TTL=5m` 實跑回 `ephemeral_5m_input_tokens`、設 `1h` 回
`ephemeral_1h`，CLI 升版沒把鍵名改掉。`claude-runner.js:210`、`sandbox-run.js:158` 兩處都有釘。

`token_usage`（`source='server'`）以 9/10 13:53 切開：

| | cache_create 佔快取 token | 樣本 |
|---|---|---|
| 釘之前（1h） | 6.130% | 1,097 runs |
| 9/11–9/17 | 6.610% | 314 runs |
| 9/18–9/22 | 6.457% | 155 runs |

**過期重寫的代價幾乎沒出現**（+0.4pp），所以省的接近「單價砍 37.5%」的全額。
以 token-cost.js 的 rate 加權算：實際 304.99 vs 反事實 1h 364.89（加權等效顆數/1e6）→ **省 16.4%**，
略優於原估的 12-14%。快取佔總成本 76.8%。

⚠ 反事實是拿「釘之前的 cc 佔比」當 1h 的行為推的，兩段期間任務組成不同；兩個 post 期間數字一致
（6.61 / 6.46）是這個推論站得住的主要理由。
