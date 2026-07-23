const { spawn } = require('child_process');
const path = require('path');
const { query } = require('../db');

const SCRIPT = path.join(__dirname, 'graphify_index.py');

function runGraphify(repoId, localPath) {
  query(
    "UPDATE project_repos SET graphify_status='running', graphify_error=NULL WHERE id=$1",
    [repoId]
  ).catch(() => {});

  // Windows 慣用 python、Linux 常只有 python3（比照 checks.js／merge-agent），尊重 PYTHON_BIN 覆寫。
  const interpreter = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const child = spawn(interpreter, [SCRIPT, localPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000
  });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  child.on('close', code => {
    if (code !== 0) {
      const msg = stderr.slice(0, 500) || `exit code ${code}`;
      query(
        "UPDATE project_repos SET graphify_status='error', graphify_error=$2 WHERE id=$1",
        [repoId, msg]
      ).catch(() => {});
      console.error(`[GRAPHIFY] repo ${repoId} failed:`, msg);
    } else {
      query(
        "UPDATE project_repos SET graphify_status='done', graphify_error=NULL WHERE id=$1",
        [repoId]
      ).catch(() => {});
      console.log(`[GRAPHIFY] repo ${repoId} done (${localPath})`);
    }
  });

  child.on('error', err => {
    query(
      "UPDATE project_repos SET graphify_status='error', graphify_error=$2 WHERE id=$1",
      [repoId, err.message.slice(0, 500)]
    ).catch(() => {});
    console.error(`[GRAPHIFY] repo ${repoId} spawn error:`, err.message);
  });
}

module.exports = { runGraphify };
