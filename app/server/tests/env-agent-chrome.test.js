// 意圖：tour(browser_js) 需 chrome；建環境時要能偵測，缺則擋下（否則 Odoo SkipTest → exit 0 假綠燈）。
const fs = require('fs');
const path = require('path');
const { findChrome } = require('../pipeline/env-agent');

const isWin = process.platform === 'win32';
const winIt = isWin ? test : test.skip; // 目標平台為 Windows；chrome 路徑邏輯僅在 win32 分支

winIt('findChrome：命中 %ProgramFiles% 路徑', () => {
  process.env.ProgramFiles = 'C:\\Program Files';
  const expected = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
  const spy = jest.spyOn(fs, 'existsSync').mockImplementation(p => p === expected);
  expect(findChrome()).toBe(expected);
  spy.mockRestore();
});

winIt('findChrome：三路徑皆不存在時回 null', () => {
  const spy = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  expect(findChrome()).toBeNull();
  spy.mockRestore();
});
