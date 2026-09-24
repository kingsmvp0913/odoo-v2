// scripts/lib/handoff.js — 換機接手包還原：把 docs/handoff/ 內的開發記憶與 Claude 全域設定
// 裝回這台機器的 ~/.claude。一律「只補不覆蓋」，因為新機器上後來寫的記憶比 repo 內的快照新。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync: realExecFileSync } = require('child_process');

// Claude Code 依工作目錄分存記憶：~/.claude/projects/<slug>/memory，
// slug＝該目錄絕對路徑把分隔符換成 "-"（/home/odoo/odoo-v2 → -home-odoo-odoo-v2）。
// 故 clone 路徑不同的機器會自動落在不同 slug，不需要手動改目錄名。
function memorySlug(root) {
  return root.replace(/[\\/:]/g, '-');
}

function hasCommand(name, deps = {}) {
  const execFileSync = deps.execFileSync || realExecFileSync;
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// 回傳實際複製的檔數。已存在的檔一概不動——覆蓋會把新機器上更新過的記憶打回快照當時的版本。
function copyMissing(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(destDir, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyMissing(src, dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
      copied += 1;
    }
  }
  return copied;
}

// 只補頂層缺鍵。使用者既有的 settings.json 可能有本機專屬設定（model、theme），
// 整份覆蓋會把它們洗掉。
function mergeSettings(incoming, destPath) {
  let current = {};
  if (fs.existsSync(destPath)) {
    try {
      current = JSON.parse(fs.readFileSync(destPath, 'utf8'));
    } catch {
      return { added: [], error: `${destPath} 不是合法 JSON，未合併` };
    }
  }
  const added = Object.keys(incoming).filter((k) => !(k in current));
  if (added.length) {
    for (const k of added) current[k] = incoming[k];
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, JSON.stringify(current, null, 2) + '\n');
  }
  return { added };
}


// 客戶專案專屬的記憶不進接手包：換機接手的是「平台開發」這件事，客戶單號複審結論對新機器
// 沒有用，而這個 repo 是公開的，客戶名少一份是一份。新增客戶時把代號加進這份清單。
const PROJECT_MEMORY_PREFIXES = ['hungjou', 'raifong', 'kangyue', 'ucpt'];

function isProjectMemory(name, prefixes = PROJECT_MEMORY_PREFIXES) {
  return prefixes.some((p) => name.startsWith(p));
}

// 把本機的活記憶刷進 docs/handoff/memory/（換機前在舊機器上跑）。與還原相反，這裡要覆蓋，
// 因為 repo 內的是快照、本機的才是最新。MEMORY.md 是索引，指向被排除檔案的那幾行要一起拿掉，
// 否則新機器的 AI 會照著索引去找不存在的記憶。
function snapshotMemory({ root, home = os.homedir(), prefixes = PROJECT_MEMORY_PREFIXES } = {}) {
  const src = path.join(home, '.claude', 'projects', memorySlug(root), 'memory');
  const dest = path.join(root, 'docs', 'handoff', 'memory');
  if (!fs.existsSync(src)) return { copied: 0, skipped: [], removed: [], error: `找不到本機記憶目錄 ${src}` };

  fs.mkdirSync(dest, { recursive: true });
  const names = fs.readdirSync(src).filter((n) => n.endsWith('.md'));
  const skipped = names.filter((n) => isProjectMemory(n, prefixes));
  const keep = names.filter((n) => !isProjectMemory(n, prefixes));

  for (const name of keep) {
    if (name === 'MEMORY.md') {
      const lines = fs.readFileSync(path.join(src, name), 'utf8').split('\n');
      const filtered = lines.filter((line) => !skipped.some((s) => line.includes(`](${s})`)));
      fs.writeFileSync(path.join(dest, name), filtered.join('\n'));
    } else {
      fs.copyFileSync(path.join(src, name), path.join(dest, name));
    }
  }

  // 本機已刪掉的記憶，快照也要跟著刪——留著就是把已被推翻的事實繼續傳給下一台機器。
  const removed = fs.readdirSync(dest).filter((n) => n.endsWith('.md') && !keep.includes(n));
  for (const name of removed) fs.unlinkSync(path.join(dest, name));

  return { copied: keep.length, skipped, removed };
}

function restoreHandoff({ root, home = os.homedir(), deps = {} } = {}) {
  const steps = [];
  const handoffDir = path.join(root, 'docs', 'handoff');
  if (!fs.existsSync(handoffDir)) {
    return { steps: [{ name: '接手包', status: 'skipped', detail: `找不到 ${handoffDir}` }] };
  }

  const memoryDest = path.join(home, '.claude', 'projects', memorySlug(root), 'memory');
  const memoryCopied = copyMissing(path.join(handoffDir, 'memory'), memoryDest);
  steps.push({
    name: '開發記憶',
    status: memoryCopied ? 'done' : 'skipped',
    detail: memoryCopied ? `補上 ${memoryCopied} 則 → ${memoryDest}` : `已存在，未覆蓋 → ${memoryDest}`,
  });

  const claudeHome = path.join(handoffDir, 'claude-home');
  const claudeDest = path.join(home, '.claude');
  for (const file of ['CLAUDE.md', 'RTK.md']) {
    const src = path.join(claudeHome, file);
    const dest = path.join(claudeDest, file);
    if (!fs.existsSync(src)) continue;
    if (fs.existsSync(dest)) {
      steps.push({ name: file, status: 'skipped', detail: '已存在，未覆蓋' });
    } else {
      fs.mkdirSync(claudeDest, { recursive: true });
      fs.copyFileSync(src, dest);
      steps.push({ name: file, status: 'done', detail: dest });
    }
  }

  const skillsCopied = copyMissing(path.join(claudeHome, 'skills'), path.join(claudeDest, 'skills'));
  if (skillsCopied) steps.push({ name: '全域 skills', status: 'done', detail: `補上 ${skillsCopied} 檔` });

  const settingsSrc = path.join(claudeHome, 'settings.json');
  if (fs.existsSync(settingsSrc)) {
    const incoming = JSON.parse(fs.readFileSync(settingsSrc, 'utf8'));
    // rtk 是獨立安裝的二進位（不在本 repo）。它不在時留著 hook，會讓之後「每一次」Bash
    // 呼叫都跑一個不存在的指令——所以寧可不裝這條 hook，並明講怎麼補。
    if (incoming.hooks && !hasCommand('rtk', deps)) {
      delete incoming.hooks;
      steps.push({ name: 'rtk hook', status: 'skipped', detail: '本機無 rtk，未寫入 hook；裝好 rtk 後重跑本步驟即可補上' });
    }
    const { added, error } = mergeSettings(incoming, path.join(claudeDest, 'settings.json'));
    steps.push({
      name: 'Claude 全域設定',
      status: added.length ? 'done' : 'skipped',
      detail: error || (added.length ? `補上缺鍵：${added.join('、')}` : '既有設定已涵蓋，未更動'),
    });
  }

  return { steps };
}

module.exports = { restoreHandoff, snapshotMemory, isProjectMemory, memorySlug, copyMissing, mergeSettings, hasCommand };

// 換機前在舊機器上跑：node scripts/lib/handoff.js --snapshot
if (require.main === module && process.argv.includes('--snapshot')) {
  const r = snapshotMemory({ root: path.resolve(__dirname, '..', '..') });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  console.log(`[OK] 快照 ${r.copied} 則記憶；排除客戶專案 ${r.skipped.length} 則；刪除已不存在的 ${r.removed.length} 則`);
  console.log('    記得 git add -f docs/handoff（docs/ 在 .gitignore 內）');
}
