// 意圖：開關決定 AI 在不在容器裡跑。三件事不能錯：
//  1. 認不得的值要落到最嚴格（全開），不能默默變成「關」而繞過隔離（rules/pipeline 59）
//  2. internal 只影響健檢／夜間改善，客戶 agent 照舊；projects 只影響清單內的測試專案
//  3. 只有平台管理員能改；改完不必重啟就生效（rules/infra 122）
process.env.JWT_SECRET = 'test-agent-sandbox-flag';
const { newDb } = require('pg-mem');
const request = require('supertest');
const f = require('../lib/agent-sandbox-flag');
const { profileFor } = require('../lib/agent-profiles');

describe('純邏輯', () => {
  test('未知 mode → all（最嚴格），合法值原樣', () => {
    expect(f.normalizeMode('of')).toBe('all');
    expect(f.normalizeMode(null)).toBe('all');
    expect(f.normalizeMode('internal')).toBe('internal');
  });
  test('parseProjectIds 只收正整數', () => {
    expect([...f.parseProjectIds('3, 12,x,-1,0')]).toEqual([3, 12]);
    expect(f.parseProjectIds(null).size).toBe(0);
  });
  test('off：誰都不進容器', () => {
    f._setFlagStateForTesting({ mode: 'off', projectIds: new Set([1]) });
    expect(f.sandboxAppliesTo(profileFor('workflow_health'), null)).toBe(false);
    expect(f.sandboxAppliesTo(profileFor('coding'), 1)).toBe(false);
  });
  test('internal：只有內部 agent 進容器', () => {
    f._setFlagStateForTesting({ mode: 'internal', projectIds: new Set([1]) });
    expect(f.sandboxAppliesTo(profileFor('platform_fix'), null)).toBe(true);
    expect(f.sandboxAppliesTo(profileFor('coding'), 1)).toBe(false);
    expect(f.sandboxAppliesTo(profileFor('deploy_fix'), 1)).toBe(false);
  });
  // 用「清單內 1、清單外 2」兩個專案，才分得出「看清單」與「全開」
  test('projects：內部＋清單內專案進容器，清單外照舊', () => {
    f._setFlagStateForTesting({ mode: 'projects', projectIds: new Set([1]) });
    expect(f.sandboxAppliesTo(profileFor('workflow_health'), null)).toBe(true);
    expect(f.sandboxAppliesTo(profileFor('coding'), 1)).toBe(true);
    expect(f.sandboxAppliesTo(profileFor('coding'), 2)).toBe(false);
    expect(f.sandboxAppliesTo(profileFor('chat-title'), null)).toBe(false);
  });
  test('all：全部進容器', () => {
    f._setFlagStateForTesting({ mode: 'all', projectIds: new Set() });
    expect(f.sandboxAppliesTo(profileFor('chat-title'), null)).toBe(true);
  });
  test('validateFlagInput 擋格式錯的上限與 mode', () => {
    expect(() => f.validateFlagInput({ mode: 'maybe' })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'off', memory: '4 GB' })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'off', cpus: 'two' })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'off', pids: 10 })).toThrow();
    expect(() => f.validateFlagInput({ mode: 'projects', project_ids: ['a'] })).toThrow();
    expect(f.validateFlagInput({ mode: 'projects', project_ids: [3], memory: '4g', cpus: '2', pids: 512 }))
      .toMatchObject({ mode: 'projects', projectIds: [3], memory: '4g', cpus: '2', pids: 512 });
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

  test('新 DB 預設 off（合併進 master 不改變行為）', async () => {
    await f.loadAgentSandboxFlag();
    expect(f.getSandboxMode()).toBe('off');
    expect(f.getSandboxLimits()).toEqual({ memory: null, cpus: null, pids: null });
  });

  test('一般使用者不能改', async () => {
    const res = await request(app).put('/api/admin/agent-sandbox')
      .set('Authorization', `Bearer ${userToken}`).send({ mode: 'all' });
    expect(res.status).toBe(403);
  });

  test('管理員改完立即生效、記下改動時間', async () => {
    const res = await request(app).put('/api/admin/agent-sandbox').set('Authorization', `Bearer ${adminToken}`)
      .send({ mode: 'projects', project_ids: [9], memory: '4g', cpus: '2', pids: 512, gateway_memory: '256m', gateway_cpus: '0.5', gateway_pids: 128 });
    expect(res.status).toBe(200);
    expect(f.getSandboxMode()).toBe('projects');
    expect(f.sandboxAppliesTo(profileFor('qa'), 9)).toBe(true);
    expect(f.getSandboxLimits()).toEqual({ memory: '4g', cpus: '2', pids: 512 });
    expect(f.getGatewayLimits()).toEqual({ memory: '256m', cpus: '0.5', pids: 128 });
    const g = await request(app).get('/api/admin/agent-sandbox').set('Authorization', `Bearer ${adminToken}`);
    expect(g.body).toMatchObject({ mode: 'projects', project_ids: [9] });
    expect(g.body.changed_at).toBeTruthy();
  });

  test('DB 裡被寫進怪值 → 載入後是 all', async () => {
    await dbModule.query("UPDATE teams_settings SET agent_sandbox_mode='typo' WHERE id=1");
    await f.loadAgentSandboxFlag();
    expect(f.getSandboxMode()).toBe('all');
    await dbModule.query("UPDATE teams_settings SET agent_sandbox_mode='off' WHERE id=1");
    await f.loadAgentSandboxFlag();
  });
});
