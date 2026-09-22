// 意圖：更版機制的失敗**只在畫面上通知**（已拍板：這台機器沒有 webhook、也沒有 Teams）。
// 所以「畫面上有沒有那一條」不是美觀問題，是這條通知管道存不存在的問題——它斷掉的樣子就是
// 「一切看起來都正常」，沒有紅燈、沒有例外、沒有人被叫起來。這一支守的就是那幾個顯示點：
//   (1) 測試區重開失敗要出現在更版頁。那份紀錄（release_last_result.envRevive）本來就寫進 DB 了，
//       但在這之前**沒有任何一頁讀它**：客戶的測試區「開著但什麼都不動」正是本子專案要防的事故，
//       而它被記錄在一個沒有人看得到的地方等於沒記。
//   (2) 管理員首頁要有「平台更版」這張卡，以及上一次更版的狀態列。裁決的原文是
//       「更版頁標紅『上週未成功』＋管理員首頁掛一條」，而首頁那一條是唯一「不必事先知道
//       要去哪裡看」的入口——週一早上進來的人落在首頁，不會自己去翻下拉選單。
const fs = require('fs');
const path = require('path');

const pagesDir = path.join(__dirname, '..', '..', 'public', 'js', 'ui-next', 'pages');
const RELEASE = fs.readFileSync(path.join(pagesDir, 'Release.js'), 'utf8');
const ADMIN = fs.readFileSync(path.join(pagesDir, 'Admin.js'), 'utf8');

describe('更版頁：測試區沒救回來這件事要看得到', () => {
  test('讀得到 release_last_result 裡的 envRevive，而不只是把它寫進 DB', () => {
    expect(`Release.js 讀 envRevive: ${/last\.envRevive/.test(RELEASE)}`).toBe('Release.js 讀 envRevive: true');
  });

  test('說得出「哪幾台」與「要做什麼」：光說失敗了，看到的人不知道下一步', () => {
    expect(`列出是哪幾台: ${/envRevive\.failures/.test(RELEASE)}`).toBe('列出是哪幾台: true');
    // 那幾台的症狀是「開著但什麼都不動」，客戶不會來反映，所以畫面得把要做的事講完
    expect(RELEASE).toMatch(/手動重啟|人工重啟/);
  });

  test('失敗與成功用不同顏色，而且顏色一律取自 CSS 變數（深色模式是硬規則）', () => {
    expect(`有 envReviveFailed 這個判準: ${/envReviveFailed/.test(RELEASE)}`).toBe('有 envReviveFailed 這個判準: true');
    expect(RELEASE.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
  });
});

describe('管理員首頁：更版狀態唯一的入口', () => {
  test('有「平台更版」這張卡——其他每一個管理頁都有，只有它沒有', () => {
    expect(`卡片連到更版頁: ${/to:\s*"\/admin\/release"/.test(ADMIN)}`).toBe('卡片連到更版頁: true');
    expect(ADMIN).toContain('平台更版');
  });

  test('掛得出「上一次更版沒有成功」那一條，且可以點進更版頁', () => {
    expect(ADMIN).toMatch(/上一次更版沒有成功/);
    expect(ADMIN).toMatch(/還跑著舊碼/);
    expect(`狀態列本身可點: ${/to="\/admin\/release"/.test(ADMIN)}`).toBe('狀態列本身可點: true');
  });

  test('判準是 restarted 不是 testsPassed：後者是三態，null 不是通過（release.js 的契約）', () => {
    expect(`用 restarted 判: ${/restarted !== true/.test(ADMIN)}`).toBe('用 restarted 判: true');
    // 把判準寫成 `last.testsPassed` 之類的 falsy 判斷才是真正的倒退（「跳過全跑但有重啟」會被
    // 誤報成失敗、「根本沒跑起來」會被誤報成沒事），所以釘的是「沒有人拿它當條件」。
    expect(`沒拿 testsPassed 當條件: ${/(if|\?|&&|\|\|)[^\n]*testsPassed/.test(ADMIN)}`)
      .toBe('沒拿 testsPassed 當條件: false');
  });

  test('測試區沒救回來也算「沒完全成功」，首頁同樣掛一條——那是客戶要好幾天才發現的那種壞', () => {
    expect(`首頁看得到 envRevive: ${/envRevive/.test(ADMIN)}`).toBe('首頁看得到 envRevive: true');
  });

  test('顏色一律取自 CSS 變數，不得硬寫十六進位（深色模式是硬規則）', () => {
    expect(ADMIN.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(ADMIN).toMatch(/var\(--danger\)/);
  });
});
