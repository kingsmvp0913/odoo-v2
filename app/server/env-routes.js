const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { mintSsoToken } = require('./sso');

function registerRoutes(app) {
  app.get('/api/projects/:id/env', verifyToken, async (req, res) => {
    try {
      const { rows } = await query(
        // external_slot：前端據此才知道「現在有沒有借著對外名額」，決定要不要給歸還按鈕
        'SELECT id, status, pid, port, url, external_slot, error_msg, setup_log, updated_at FROM odoo_envs WHERE project_id = $1',
        [req.params.id]
      );
      const env = rows.length ? rows[0] : { status: 'idle' };
      // 若 DB 顯示 running 但容器其實已不在（app 重啟、容器 crash／OOM／被外部 kill／重建中斷後
      // 繞過 stopEnv 消失），自動修正為 idle。docker 是唯一模式、pid 恆為 NULL，不能靠 process.kill——
      // 一律問容器在不在跑（envContainerAlive）。少了這條，孤兒 running 會一路撐到閒置掃描才被清，
      // 期間使用者點「開啟」會拿到指向死容器的網址＝空白畫面。
      if (env.status === 'running') {
        const { envContainerAlive } = require('./pipeline/env-agent');
        const alive = await envContainerAlive(req.params.id);
        if (!alive) {
          await query(
            // external_slot 一併清：環境其實已經沒了，留著等於一個 slot 被幽靈佔住。
            // port 同理且更嚴重：slot 有 20 分鐘閒置掃描兜底，內部埠租約沒有等價的自動回收，
            // 不清就是永久少一個（見 port-alloc.js 的 releasePort 註解）。
            "UPDATE odoo_envs SET status='idle', pid=NULL, url=NULL, port=NULL, external_slot=NULL, updated_at=NOW() WHERE project_id=$1",
            [req.params.id]
          );
          env.status = 'idle';
          env.pid = null;
          env.url = null;
        }
      }
      // built = 環境目錄已完整建置，前端據此顯示「重新啟動」而非「一鍵建立環境」。
      // venv 模式標記為 .ready、docker 模式為 .docker-ready（見 env-agent），任一存在即視為已建置。
      try {
        const fs = require('fs');
        const { ENV_BASE: base } = require('./pipeline/env-agent');
        const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [req.params.id]);
        const dirName = project ? (project.folder_name || project.name) : null;
        env.built = !!(dirName && (
          fs.existsSync(path.join(base, dirName, '.ready')) ||
          fs.existsSync(path.join(base, dirName, '.docker-ready'))
        ));
      } catch { env.built = false; }
      res.json(env);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 平台簽發一次性 SSO token，導向測試區 idx_aidev_sso 模組免密登入。
  //
  // 對外名額（external_slot）在這裡借——不在建環境時配。pipeline 的 deploy/E2E 走 docker exec、
  // 不經對外網址，若在建環境時就配名額，pipeline 併發跑幾十個環境會把 10 個名額瞬間吃光。
  // 這個端點就是「有真人要看」的唯一訊號。
  app.get('/api/projects/:id/env/sso', verifyToken, async (req, res) => {
    try {
      const { rows: [env] } = await query(
        'SELECT status, url, sso_secret, error_msg FROM odoo_envs WHERE project_id=$1', [req.params.id]
      );
      // 環境可能已被閒置回收停掉。回 409 等於要使用者自己去專案頁找「建立環境」再等——
      // 任務頁根本沒有那個按鈕。直接幫他起，回 202 讓前端顯示進度並輪詢。
      // runEnvSetup 內建同專案 in-flight 去重，連按不會 spawn 兩個。
      if (!env || !env.sso_secret) return res.status(409).json({ error: '測試區尚未就緒' });
      // status='error' 不能自動重試：_failEnv 只改 status，不清 sso_secret，所以「曾經建成功、
      // 之後重啟失敗」也會落在這裡——若當一般未就緒自動重試，_setupInflight 在失敗 settle 後
      // 立刻刪 key，下一次輪詢就會重跑一整輪 docker build/pip install/DB init。建置失敗多半
      // 是不會自癒的原因（映像壞掉、埠衝突、磁碟滿），重跑只會放大問題，還讓使用者永遠看到
      // 「建立中」而看不到真正的錯誤——這裡直接把 error_msg 帶出來讓他知道發生了什麼事。
      if (env.status === 'error') {
        return res.status(409).json({ error: env.error_msg || '測試區建立失敗，請到專案頁查看建立記錄' });
      }
      // status='running' 不能當真——容器可能已被 kill／OOM／重建中斷後繞過 stopEnv 消失（孤兒 running）。
      // 若此時照給子網域網址，使用者拿到的是指向死容器的連結＝空白畫面，還白借一個對外名額。
      // docker 是唯一模式、pid 恆為 NULL，只能問容器在不在跑；不活就跟 idle 一樣走自動起。
      const { envContainerAlive } = require('./pipeline/env-agent');
      const alive = env.status === 'running' && await envContainerAlive(req.params.id);
      if (!alive) {
        if (env.status !== 'setting_up') {
          const { runEnvSetup } = require('./pipeline/env-agent');
          const { withProjectLock } = require('./pipeline/project-lock');
          // 持專案鎖與 pipeline deploy/E2E 序列化（見 /env/setup 的說明）；key 必須 coerce 成 Number 才與數字 key 互斥。
          withProjectLock(Number(req.params.id), () => runEnvSetup(req.params.id))
            .catch(e => console.error('[ENV] sso autostart error:', e.message));
        }
        return res.status(202).json({ starting: true, message: '測試區建立中，完成後會自動開啟' });
      }

      let url = env.url;
      if (process.env.ENV_EXTERNAL_URL_TEMPLATE) {
        const { acquireExternalSlot } = require('./lib/external-slot');
        const { envExternalUrl } = require('./port-alloc');
        const { syncNginxMap } = require('./lib/nginx-map');
        const slot = await acquireExternalSlot(req.params.id);
        url = envExternalUrl(slot);
        // 這裡必須 await 真正的同步（不能用 debounced 版）：下一行就要把網址交給瀏覽器開新頁，
        // nginx 還沒 reload 的話使用者當下拿到 502。「還」的路徑才走防抖。
        await syncNginxMap();
      }
      if (!url) return res.status(409).json({ error: '測試區尚未就緒' });

      const { rows: [u] } = await query('SELECT username, display_name FROM users WHERE id=$1', [req.userId]);
      const token = mintSsoToken({ secret: env.sso_secret, login: u.username, name: u.display_name, ttlSec: 30 });
      res.json({ url: `${url.replace(/\/$/, '')}/aidev/sso?token=${encodeURIComponent(token)}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 明確歸還對外名額。真人「關掉分頁」偵測不到，故歸還只有兩條路：這個端點與閒置逾時。
  // 只收名額、不停環境——pipeline 可能還要用這個環境。
  app.post('/api/projects/:id/env/external/release', verifyToken, async (req, res) => {
    try {
      const { releaseExternalSlot } = require('./lib/external-slot');
      const { syncNginxMapDebounced } = require('./lib/nginx-map');
      await releaseExternalSlot(req.params.id);
      syncNginxMapDebounced().catch(() => {});
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/env/setup', verifyToken, async (req, res) => {
    try {
      const { runEnvSetup } = require('./pipeline/env-agent');
      const { withProjectLock } = require('./pipeline/project-lock');
      // _setupInflight 只併「同 tick」的呼叫；手動建立與 pipeline deploy/E2E 不同步觸發時仍會各跑一輪
      // runEnvSetup、互相污染 odoo_envs（爭埠漂移、輸家 _failEnv 蓋掉健康的 running）。持專案鎖與 pipeline
      // 序列化。key 必須 coerce 成 Number——deploy 用 DB 數字 project_id 當 key，Map key 字串 '2'≠數字 2 不互斥。
      withProjectLock(Number(req.params.id), () => runEnvSetup(req.params.id)).catch(err =>
        console.error('[ENV] setup error:', err.message)
      );
      res.json({ ok: true, message: '環境建立已開始' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // 讀取常駐 Odoo server 的 runtime log（尾端），供前端「查看 log」除錯（asset 503／崩潰 traceback 等）。
  app.get('/api/projects/:id/env/log', verifyToken, async (req, res) => {
    try {
      const { dockerCtxFor } = require('./pipeline/env-agent');
      const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [req.params.id]);
      if (!project) return res.status(404).json({ error: 'project not found' });
      // 常駐 server 的 runtime log 在容器內，讀 `docker logs`（尾端 2000 行、再截尾端 256KB）。
      const dockerEnv = require('./lib/docker-env');
      const ctx = await dockerCtxFor(req.params.id);
      if (!ctx || !(await dockerEnv.containerExists(ctx.container))) return res.json({ log: '', exists: false });
      const log = await dockerEnv.containerLogs(ctx.container, { tail: 2000 }).catch(() => '');
      return res.json({ log: log.slice(-256 * 1024), exists: !!log });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/projects/:id/env/stop', verifyToken, async (req, res) => {
    try {
      const { stopEnv } = require('./pipeline/env-agent');
      await stopEnv(req.params.id);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/projects/:id/env', verifyToken, async (req, res) => {
    try {
      // 測試區只有 docker 一種模式，Odoo 跑在容器裡而不是宿主 process——odoo_envs.pid 恆為 NULL
      //（見 env-agent 的 UPDATE ... pid=NULL），原本的 process.kill(pid) 打不到任何東西：目錄砍了、
      // DB 欄位清了，容器照跑而且還綁著下面剛被標成「已歸還」的埠。leasePort 會實測綁定所以不會
      // 配爆，但池子靜默縮水且查不出是誰佔的。stopEnv 才是真正 stop+rm 容器（並收該專案 VPN）的路徑。
      const { stopEnv } = require('./pipeline/env-agent');
      await stopEnv(req.params.id);

      const { rows: [project] } = await query('SELECT name, folder_name FROM projects WHERE id=$1', [req.params.id]);
      if (project) {
        const fs = require('fs');
        const { ENV_BASE: base } = require('./pipeline/env-agent');
        const dirName = project.folder_name || project.name;
        const envDir = path.join(base, dirName);
        const resolved = path.resolve(envDir);
        if (!resolved.startsWith(path.resolve(base) + path.sep)) {
          return res.status(400).json({ error: 'Invalid env path' });
        }
        if (fs.existsSync(envDir)) fs.rmSync(envDir, { recursive: true, force: true });
      }

      await query(
        // external_slot 與 port 一併清：整個環境目錄都刪了，兩者不歸還都會被幽靈佔住。
        // port 尤其不能漏——池子只有 20 個且沒有自動回收，每刪一次環境就永久少一個。
        "UPDATE odoo_envs SET status='idle', pid=NULL, url=NULL, port=NULL, external_slot=NULL, error_msg=NULL, setup_log=NULL, updated_at=NOW() WHERE project_id=$1",
        [req.params.id]
      );
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}

module.exports = { registerRoutes };
