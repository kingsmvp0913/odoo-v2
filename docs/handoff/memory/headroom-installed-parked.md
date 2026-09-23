---
name: headroom-installed-parked
description: headroom 已裝好可用但刻意沒接上；預設模式會把表格旁邊的指令整段刪掉（實測 74 行→1 行 JSON），要接只能用 --compressor 限制成安全模式
metadata:
  node_type: memory
  type: project
---

2026-09-10 裝好並實測，**刻意停在「裝好但沒接」**。

`uv tool install "headroom-ai[all]"` → `~/.local/bin/headroom`（0.37.0，跟 `rtk` 同目錄）。
`[all]` 會拉 torch／CUDA，`~/.cache/uv` 因此漲到 6GB 以上。

## 為什麼不接：預設模式會刪掉指令，不是壓縮

`headroom proxy --log-messages` ＋ `headroom inspect` 實測，`router:text_block:tabular` 這個 transform
看到文字區塊裡有 markdown 表格，就**把整個區塊換成表格的 JSON，表格以外的字全丟**：

```
@@ -1,74 +1,4 @@      74 行 → 1 行 JSON
-（規則、優先序、「使用者指令優先」等散文段落全部消失）
+[{"Thought":"...","Reality":"..."}, ...]
```

任何一關吃到含表格的內容（使用者貼的、log、報表）都會中。`.claude/agents/` 裡目前只有
`analysis-project.md` 自帶表格，但**執行期餵進去的內容管不住**。

## 要接就只能用安全模式

`headroom proxy --port 8787 --compressor image` → 文字壓縮器全關。實測：

- 訊息內容**一個字都沒改**（`inspect` 沒有任何 message diff）
- `router:tool_search_deferral` 仍在，仍省 **19,101 tokens/請求**（九成的省量來自這裡，不是壓文字）
- 工具照樣叫得動（測 Glob 找檔案回 31，正確）

四輪對照（直連 ×2 / proxy ×2，同一 prompt、多輪＋工具）：**cache_create 沒有變大**
（73,456 vs 72,778），品質相當、延遲沒惡化，加權成本省 **4–7.5%**。

## 為什麼還是先擱著

1. 只測過 haiku ＋唯讀工具 ＋6 輪；沒測過 opus 長 coding session、寫檔、context7 MCP 那幾關。
2. **proxy 掛掉沒有 fallback** ——容器一重啟 proxy 就沒了，pipeline 會直接連不上 8787 整關失敗。
3. 同一時間發現 TTL 那條省更多、且不用在關鍵路徑塞一個常駐行程（見 [[prompt-cache-ttl-5m-for-pipeline]]）。
   兩者可疊加（一個砍前綴大小、一個砍寫入單價），但先做便宜的那個。

要接的話接點已經現成：`claude-runner.js` 的 spawn `env` 最後是 `...(env || {})`，而 `opts` 帶 `agentType`，
加一個白名單就能只對特定關卡塞 `ANTHROPIC_BASE_URL`。

## 一個會反覆踩的小坑

`pkill -f "headroom proxy"` **會殺掉自己那個 shell**（exit 144）——因為 bash -c 的整串指令裡就有
「headroom proxy」這幾個字，pkill 比對得到自己。要嘛把 kill 跟 start 拆成兩次呼叫，
要嘛把樣式打斷（`hea""droom proxy`）。

相關：[[prompt-cache-ttl-5m-for-pipeline]]、[[container-no-root-no-apt]]
