// 意圖：AI 全部在容器裡跑（2026-09-24 拿掉舊的非容器路徑），這裡只剩資源上限。三件事不能錯：
//  1. 上限格式要擋住（容器模式規定必填，格式錯＝全部 AI 執行失敗）
//  2. 只有平台管理員能改；改完不必重啟就生效（rules/infra 122）
//  3. **這個模組不得再提供任何「要不要進容器」的開關**——留一個就是留一條靜默取消隔離的後門，
//     而走那條路的 AI 用平台訂閱跑客戶的工作，不報錯，只出現在月底帳單上
process.env.JWT_SECRET = 'test-agent-sandbox-flag';
const { newDb } = require('pg-mem');
const request = require('supertest');
const f = require('../lib/agent-sandbox-flag');

describe('純邏輯', () => {
  test('validateFlagInput 擋格式錯的上限', () => {
    expect(() => f.validateFlagInput({ memory: '4 GB' })).toThrow();
    expect(() => f.validateFlagInput({ cpus: 'two' })).toThrow();
    expect(() => f.validateFlagInput({ pids: 10 })).toThrow();      // 下限 32
    expect(() => f.validateFlagInput({ pids: 1.5 })).toThrow();     // 必須整數
    expect(f.validateFlagInput({ memory: '4g', cpus: '2', pids: 512, gateway_memory: '256m', gateway_cpus: '0.5', gateway_pids: 128 }))
      .toEqual({ memory: '4g', cpus: '2', pids: 512, gwMemory: '256m', gwCpus: '0.5', gwPids: 128 });
  });

  // 空字串與 null 都代表「沒設」，不可以變成字串 'null' 被寫進 DB
  test('空值一律正規化成 null', () => {
    expect(f.validateFlagInput({ memory: '', cpus: null, pids: undefined }))
      .toMatchObject({ memory: null, cpus: null, pids: null });
  });

  // 這條是上面第 3 點的牙齒：有人為了「緊急退回不隔離」把開關加回來時，這裡會紅。
  // 要真的退回非容器執行，正確做法是改 pipeline/claude-runner.js 並在那裡寫下理由，
  // 不是在這個模組偷偷開一個 getter。
  test('模組不得再輸出任何模式開關', () => {
    for (const gone of ['getSandboxMode', 'sandboxAppliesTo', 'normalizeMode', 'parseProjectIds', 'MODES']) {
      expect(f[gone]).toBeUndefined();
    }
  });
});

describe('DB 載入與管理員端點', () => {
  let dbModule, app, adminToken, userToken;
  beforeAll(async () => {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    dbModule = require('../db');
    dbModule._setPoolForTesting(new Pool());
    await dbModule.migrate();
    const { createApp } = require('../index');
    app = createApp();
    const { hashPassword } = require('../password');
    const pw = await hashPassword('pw');
    await dbModule.query(
      "INSERT INTO users (username, password_hash, display_name, role) VALUES ('sbadm',$1,'A','admin'), ('sbusr',$1,'U','user')", [pw]);
    adminToken = (await request(app).post('/api/auth/login').send({ username: 'sbadm', password: 'pw' })).body.token;
    userToken = (await request(app).post('/api/auth/login').send({ username: 'sbusr', password: 'pw' })).body.token;
  }, 30000);
  afterAll(() => dbModule._setPoolForTesting(null));

  test('新 DB 的上限是空的（缺值由 lib/agent-sandbox.js 硬擋，不是這裡補預設）', async () => {
    await f.loadAgentSandboxFlag();
    expect(f.getSandboxLimits()).toEqual({ memory: null, cpus: null, pids: null });
    expect(f.getGatewayLimits()).toEqual({ memory: null, cpus: null, pids: null });
  });

  test('一般使用者不能改', async () => {
    const res = await request(app).put('/api/admin/agent-sandbox')
      .set('Authorization', `Bearer ${userToken}`).send({ memory: '4g' });
    expect(res.status).toBe(403);
  });

  test('管理員改完立即生效、記下改動時間', async () => {
    const res = await request(app).put('/api/admin/agent-sandbox').set('Authorization', `Bearer ${adminToken}`)
      .send({ memory: '4g', cpus: '2', pids: 512, gateway_memory: '256m', gateway_cpus: '0.5', gateway_pids: 128 });
    expect(res.status).toBe(200);
    expect(f.getSandboxLimits()).toEqual({ memory: '4g', cpus: '2', pids: 512 });
    expect(f.getGatewayLimits()).toEqual({ memory: '256m', cpus: '0.5', pids: 128 });
    const g = await request(app).get('/api/admin/agent-sandbox').set('Authorization', `Bearer ${adminToken}`);
    expect(g.body.limits).toEqual({ memory: '4g', cpus: '2', pids: 512 });
    expect(g.body.changed_at).toBeTruthy();
    // 端點不得再回模式：前端只要看得到它，下一個人就會把選鈕加回來
    expect(g.body.mode).toBeUndefined();
    expect(g.body.project_ids).toBeUndefined();
  });

  // DB 欄位刻意留著不刪（刪欄位要 migration 而換不到任何行為），但程式完全不讀它。
  // 這條驗「手動改那一欄真的沒有任何效果」——沒有後門是被測試釘住的，不是靠註解宣稱。
  test('有人手動改 DB 的 agent_sandbox_mode → 載入後行為完全不變', async () => {
    await dbModule.query("UPDATE teams_settings SET agent_sandbox_mode='off' WHERE id=1");
    await f.loadAgentSandboxFlag();
    expect(f.getSandboxLimits()).toEqual({ memory: '4g', cpus: '2', pids: 512 });
    expect(f.getFlagState().mode).toBeUndefined();
  });
});
