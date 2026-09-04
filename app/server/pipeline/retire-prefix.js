/**
 * retire-prefix.js — 葉節點模組，只 export `MACHINE_RETIRE_PREFIX`，不 require 任何東西。
 *
 * ⚠ 這個常數原本定義在 nightly-fix.js，被 health-check-runner.js require。Task 7.3 要在
 * cron 串接 runNightlyFix（nightly-fix.js 反向 require health-check-runner），屆時會形成循環——
 * Node 對循環 require 的處理方式是「先給一個當下已執行到的（可能是空的）exports」，先被
 * require 的那一邊會拿到 undefined。undefined 之下 `startsWith(undefined)` 被強制轉成
 * `startsWith('undefined')`，恆為 false，且不拋、不紅：N9 的機器退場判斷會靜默失效。
 * 抽成獨立葉節點，nightly-fix.js 與 health-check-runner.js 各自直接 require 它，
 * 兩邊都不再互相依賴，循環風險從結構上消失。
 */

// 機器退場寫進 note 的標記前綴。前端用 `startsWith` 判斷（不是 SQL LIKE），所以不受
// pg-mem 把 `[...]` 當字元類別那個坑影響；但這裡選不含方括號的字面詞，避免以後有人
// 改成 SQL LIKE 查詢又踩一次。
const MACHINE_RETIRE_PREFIX = '自動退場：';

module.exports = { MACHINE_RETIRE_PREFIX };
