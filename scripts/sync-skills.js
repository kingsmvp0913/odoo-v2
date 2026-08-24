#!/usr/bin/env node
// `.claude/skills/`（來源）→ `.agents/skills/`（副本）的同步器。
//
// 為什麼需要這支：Claude Code 只讀 `.claude/skills/`，Codex 只讀 `.agents/skills/`，
// 兩邊的 SKILL.md 格式相同、目錄不同。副本刻意做成實體檔案而非 symlink——symlink 在
// 這個 repo 存不進版控（core.symlinks=false），別台 clone 下來會是空的，而「skill 靜默
// 消失」正是最難察覺的失敗。代價是兩份會漂移，且漂了沒有任何訊號：直到 Codex 某天照著
// 過期的 SKILL.md 給出錯誤指示，才會有人發現。
//
// 因此 `skills-sync.test.js` 呼叫本檔的 diff() 當紅燈，本檔負責一鍵修好。
//
// 用法：
//   node scripts/sync-skills.js           把來源同步到副本（新增／覆寫／刪除多餘檔）
//   node scripts/sync-skills.js --check    只比對，不一致時列出檔案並 exit 1
//
// 唯一的合法差異：檔案內文的 `.claude/skills` 會改寫成 `.agents/skills`
// （那些都是執行指令的路徑，例：`node .claude/skills/debugTask/gather.js`）。

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SRC = path.join(REPO_ROOT, '.claude', 'skills');
const DEST = path.join(REPO_ROOT, '.agents', 'skills');

// 遞迴列出相對路徑；一律用 POSIX 分隔符，讓比對與訊息在兩個平台上長得一樣
function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

// 副本該有的內容
function transform(content) {
  return content.split('.claude/skills').join('.agents/skills');
}

// 比對前正規化換行：core.autocrlf 會讓兩邊的 CRLF／LF 不同，那不是漂移，
// 不正規化的話這支測試會恆紅，然後就被當噪音忽略掉。
function normalize(content) {
  return content.replace(/\r\n/g, '\n');
}

// 回傳不一致的清單（空陣列＝兩邊同步）
function diff() {
  const srcFiles = listFiles(SRC);
  const problems = [];

  for (const rel of srcFiles) {
    const destPath = path.join(DEST, rel);
    if (!fs.existsSync(destPath)) {
      problems.push(`副本缺少：${rel}`);
      continue;
    }
    const expected = normalize(transform(fs.readFileSync(path.join(SRC, rel), 'utf8')));
    if (normalize(fs.readFileSync(destPath, 'utf8')) !== expected) {
      problems.push(`內容不一致：${rel}`);
    }
  }

  for (const rel of listFiles(DEST)) {
    if (!srcFiles.includes(rel)) problems.push(`來源已無此檔，副本應刪除：${rel}`);
  }

  return problems;
}

function sync() {
  const srcFiles = listFiles(SRC);
  let written = 0;
  let removed = 0;

  for (const rel of srcFiles) {
    const destPath = path.join(DEST, rel);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const expected = transform(fs.readFileSync(path.join(SRC, rel), 'utf8'));
    // 只在內容真的不同時才寫，避免每次執行都刷 mtime
    if (!fs.existsSync(destPath) || normalize(fs.readFileSync(destPath, 'utf8')) !== normalize(expected)) {
      fs.writeFileSync(destPath, expected);
      written++;
    }
  }

  for (const rel of listFiles(DEST)) {
    if (!srcFiles.includes(rel)) {
      fs.unlinkSync(path.join(DEST, rel));
      removed++;
    }
  }

  return { written, removed };
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const problems = diff();
    if (problems.length === 0) {
      console.log('.claude/skills 與 .agents/skills 同步中。');
      process.exit(0);
    }
    console.error('skill 副本與來源不同步：');
    problems.forEach((p) => console.error(`  ${p}`));
    console.error('\n修法：node scripts/sync-skills.js');
    process.exit(1);
  }

  const { written, removed } = sync();
  console.log(`同步完成：寫入 ${written} 檔、刪除 ${removed} 檔。`);
}

module.exports = { diff, sync, transform, listFiles, SRC, DEST };
