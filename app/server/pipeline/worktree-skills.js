const fs = require('fs');
const path = require('path');

/**
 * worktree-skills.js — 把平台的 project skill 佈進任務 worktree
 *
 * 為什麼要複製而不是讓 agent 去讀平台目錄：headless claude **只認 cwd 底下的 project skill、
 * 不會往上層目錄找**（2026-08-21 實測：在模擬 worktree 裡放一支探針 skill，用與正式 pipeline
 * 完全相同的參數跑，stream-json 出現 `tool_use: Skill` 且答出只存在該檔的驗證碼；同一份 prompt
 * 在沒有該 skill 的目錄則明確回「載不到」）。而 pipeline 開發各關的 cwd 是任務 worktree，
 * 不是平台 repo，所以平台的 `.claude/skills` 對它們天生不可見。
 *
 * 為什麼佈在 worktree 的「父目錄」是安全的：cwd＝`<專案根>/.worktrees/<task_id>/`，各 repo 的
 * worktree 是它底下的子目錄——父目錄本身不是 git repo，所以佈進去的 `.claude/` 不可能被
 * coding agent `git add` 進客戶的 repo。
 *
 * ⚠ 白名單是刻意的：平台自己的 skill（platformDB／pushRepo／healthCheck…）教的是平台內部操作，
 * 佈給在客戶 repo 裡作業的 agent 等於把不該有的能力交出去。要新增一定要先問「這關該不該會這件事」。
 */

const DEPLOYED = ['odooDev'];

const SRC_ROOT = path.join(__dirname, '..', '..', '..', '.claude', 'skills');

// 來源目錄裡最新的檔案時間。整包比對而非只看 SKILL.md：skill 可以有 references/ 等附檔，
// 只看主檔會讓「只改了附檔」的更新永遠佈不出去。
function newestMtime(dir) {
  let newest = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    const t = ent.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs;
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * 把白名單內的 skill 佈到 worktree（冪等，已是最新就不動）。
 * 失敗一律吞掉只記 log：skill 是加值資訊，佈不出去不該讓整關報錯。
 * @returns {string[]} 這次確認可用的 skill 名稱
 */
function ensureWorktreeSkills(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return [];
  const ready = [];
  for (const name of DEPLOYED) {
    const src = path.join(SRC_ROOT, name);
    const dest = path.join(cwd, '.claude', 'skills', name);
    try {
      if (!fs.existsSync(src)) continue;                  // 來源不在（精簡部署）→ 靜默略過
      // 目的地不存在，或來源比佈出去的那份新 → 重佈。cpSync 不保留時間戳，所以目的地的時間
      // 一定是「佈署當下」，拿它跟來源比就是「佈完之後有沒有再改過來源」。
      const stale = !fs.existsSync(dest) || newestMtime(src) > newestMtime(dest);
      if (stale) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.rmSync(dest, { recursive: true, force: true });
        fs.cpSync(src, dest, { recursive: true });
      }
      ready.push(name);
    } catch (err) {
      console.error('[SKILLS] 佈署失敗', name, err.message);
    }
  }
  return ready;
}

module.exports = { ensureWorktreeSkills, DEPLOYED };
