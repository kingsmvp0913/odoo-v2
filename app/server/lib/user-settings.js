/**
 * user-settings.js — users.odoo_settings 裡的密碼欄位加解密
 *
 * 背景：這個 jsonb 欄位存的是每位使用者的 Odoo／eService 帳密，原本是明碼——任何能讀 DB 或
 * 拿到備份的人都直接看得到，而同一張表的 github_pat_enc 早就用 APP_SECRET 加密了，兩套標準。
 * 這裡把那兩個欄位收斂到與 github_pat_enc 同一套作法。
 *
 * 刻意不改 API 形狀：GET 照樣回明碼、PUT 照樣收明碼，只在「進出 DB 的那一刻」轉換。理由是
 * settings 頁是「載入整包 → 存檔時原樣鋪回」的設計，一旦 GET 不回密碼，使用者存一次設定就會
 * 把密碼清空——那要連 PUT 的語意一起改，是另一件事（風險高得多）。本模組只解決「DB 裡是明碼」。
 *
 * 相容既有明碼資料：解密失敗一律視為明碼原樣回傳。所以舊資料照常可用，寫入時自然轉成密文。
 */
const { encrypt, decrypt } = require('./crypto');

// 只有這兩個是祕密；其餘（url／db／username／user_id／theme／saved_views）維持明文
const SECRET_KEYS = ['odoo_password', 'service_password'];

// 以「decrypt 成功」判定是否已加密，而不是比對 `a:b:c` 字面格式——密碼本身可能剛好含兩個冒號。
// AES-GCM 帶驗證標籤，解錯必然 throw，判斷是可靠的。
function isEncrypted(value) {
  if (typeof value !== 'string' || !value) return false;
  try { decrypt(value); return true; } catch { return false; }
}

// 寫入 DB 前：把明碼欄位轉密文。已是密文的不重複加密（read-modify-write 的呼叫端會帶密文回來）。
// APP_SECRET 未設定時原樣保留明碼並告警——加密設施缺失不該讓「存設定」這個核心功能直接壞掉，
// 那只會把安全性問題換成可用性故障，而行為與現況（明碼）相同。
function encryptSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    if (typeof v !== 'string' || !v || isEncrypted(v)) continue;
    try {
      out[key] = encrypt(v);
    } catch (err) {
      console.warn(`[USER-SETTINGS] ${key} 無法加密，維持明碼：${err.message}`);
    }
  }
  return out;
}

// 讀出 DB 後：把密文轉回明碼。解不開的一律當成舊明碼原樣回，既有資料不會壞。
// （APP_SECRET 被換掉時也走這條——結果是拿密文去登入而失敗，見 rules/infra #121：搬 DB 要一起搬 APP_SECRET）
function decryptSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const out = { ...settings };
  for (const key of SECRET_KEYS) {
    const v = out[key];
    if (typeof v !== 'string' || !v) continue;
    try { out[key] = decrypt(v); } catch { /* 舊明碼資料：原樣保留 */ }
  }
  return out;
}

module.exports = { encryptSettings, decryptSettings, isEncrypted, SECRET_KEYS };
