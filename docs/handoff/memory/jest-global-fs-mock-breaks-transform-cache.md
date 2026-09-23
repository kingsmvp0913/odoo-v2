---
name: jest-global-fs-mock-breaks-transform-cache
description: 全域 mock fs.statSync／readFileSync 會弄壞 jest 自己的 transform cache，整支套件連環爆且錯誤完全不指向成因
metadata: 
  node_type: memory
  type: project
  originSessionId: 48f8d709-6943-4fe4-85e3-a514a0aade9f
---

在 `app/server/tests/` 裡 `jest.spyOn(fs, 'statSync').mockReturnValue(...)` 這種**無條件全域 mock**，會連 jest／babel 自己讀寫 transform cache 的呼叫一起攔掉。

2026-08-27 實測症狀：`claude-usage-lib.test.js` 8 支測試同時爆，錯誤是

```
TypeError: jest: failed to cache transform results in: /tmp/jest_rw/jest-transform-cache-.../claudeusage_....map
Failure message: The "uid" argument must be of type number. Received undefined
```

**錯誤完全不指向 mock**，看起來像 lib 壞了。`readFileSync` 全攔則會爆成 `SyntaxError: Unexpected token ':'`（jest 讀自己的檔案吃到假 JSON），同樣不指向成因。

**正確做法**（該檔開頭註解早就寫了這件事，我還是踩了）：留住真實實作，只攔自己的路徑，其餘放行。

```js
const realStatSync = fs.statSync;
jest.spyOn(fs, 'statSync').mockImplementation((p, ...rest) =>
  String(p).endsWith('claude-usage-calibration.jsonl') ? { size: 1 } : realStatSync(p, ...rest));
```

`writeFileSync`／`mkdirSync`／`appendFileSync` 全域 mock 實測無害（jest 內部不走這幾支），會炸的是 **`statSync` 與 `readFileSync`**。

**Why**：錯誤訊息把人引去查受測模組，實際成因在 `beforeEach` 的 mock，不知道這件事會查很久。
**How to apply**：mock fs 讀取類 API 一律寫成「認得的路徑才攔、其餘 fallthrough 到 real 實作」。相關 [[claude-usage-widget-stale]]。
