// 意圖：健檢兩表隨 migrate 建立（工作流程健檢子專案 2）。
const { newDb } = require('pg-mem');
let dbModule;

beforeAll(async () => {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  dbModule = require('../db');
  dbModule._setPoolForTesting(new Pool());
  await dbModule.migrate();
});
afterAll(() => dbModule._setPoolForTesting(null));

test('migrate 建立 health_check_runs / health_check_findings 兩表', async () => {
  await dbModule.query(
    "INSERT INTO health_check_runs (status, window_days) VALUES ('running', 30)"
  );
  const { rows } = await dbModule.query('SELECT status, window_days FROM health_check_runs');
  expect(rows[0].status).toBe('running');
  const { rows: [run] } = await dbModule.query('SELECT id FROM health_check_runs LIMIT 1');
  await dbModule.query(
    "INSERT INTO health_check_findings (run_id, agent_name, diagnosis, severity) VALUES ($1,'coding-project','ok','ok')",
    [run.id]
  );
  const { rows: f } = await dbModule.query('SELECT severity FROM health_check_findings');
  expect(f[0].severity).toBe('ok');
});

const { buildAgentSummary, buildTaskSummary, buildWindowSummary } = require('../pipeline/health-data');

test('buildAgentSummary 聚合 token / tasks / rejections（僅視窗內）', async () => {
  // 準備：coding 階段兩筆 token_usage（1 成功 1 失敗）＋窗外 1 筆不計
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hd','h','HD') RETURNING id");
  await dbModule.query(
    "INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, cache_read_tokens, duration_ms, status, recorded_at) VALUES ('T1',$1,'coding',100,50,20,1000,'completed',NOW())",
    [u.id]);
  await dbModule.query(
    "INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, duration_ms, status, recorded_at) VALUES ('T1',$1,'coding',0,0,500,'error',NOW())",
    [u.id]);
  await dbModule.query(
    "INSERT INTO token_usage (task_id, user_id, agent_type, input_tokens, output_tokens, status, recorded_at) VALUES ('T9',$1,'coding',999,999,'completed',NOW() - INTERVAL '60 days')",
    [u.id]);
  // 對應任務（含 blocker 與 reentry）＋一筆退回分類
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status, reentry_count, blocker_content) VALUES ($1,'T1','manual','stopped',2,'缺套件')",
    [u.id]);
  const { rows: [r] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, user_id, reason, status) VALUES ('T1',$1,'x','classified') RETURNING id",[u.id]);
  await dbModule.query(
    "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,'欄位型別錯','實作錯誤')",[r.id]);

  const s = await buildAgentSummary({ name: 'coding-project', stage: 'coding', label: '開發' }, { windowDays: 30 });
  expect(s.token.calls).toBe(2);              // 窗外那筆不計
  expect(s.token.failed_calls).toBe(1);
  expect(s.token.input_tokens).toBe(100);
  expect(s.tasks.total).toBe(1);
  expect(s.tasks.stopped_rate).toBe(1);
  expect(s.tasks.reentry.max).toBe(2);
  expect(s.tasks.blocker_samples).toContain('缺套件');
  expect(s.rejections.by_category['實作錯誤']).toBe(1);
});

test('非 coding/analysis 的 agent → rejections 為 null', async () => {
  const s = await buildAgentSummary({ name: 'qa', stage: 'qa', label: 'QA' }, { windowDays: 30 });
  expect(s.rejections).toBeNull();
  expect(s.token.calls).toBe(0);
  expect(s.token.failed_calls).toBe(0);
});

test('buildAgentSummary：coding 只看 QA impl_miss + env_flaky_count；human by_category 不含 qa', async () => {
  // 造一筆 QA 退回（source=qa）：impl_miss x2, spec_unclear x1, env_flaky x1
  const { rows: [qr] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, reason, status, source) VALUES ('tq','s','classified','qa') RETURNING id");
  for (const c of ['impl_miss', 'impl_miss', 'spec_unclear', 'env_flaky']) {
    await dbModule.query(
      'INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,$2,$3)', [qr.id, 'd', c]);
  }
  // 一筆人工退回：category '實作錯誤'
  const { rows: [hr] } = await dbModule.query(
    "INSERT INTO task_rejections (task_id, reason, status, source) VALUES ('th','s','classified','human') RETURNING id");
  await dbModule.query(
    "INSERT INTO rejection_items (rejection_id, description, category) VALUES ($1,'d','實作錯誤')", [hr.id]);

  const { buildAgentSummary, buildTaskSummary, buildWindowSummary } = require('../pipeline/health-data');
  const coding = await buildAgentSummary({ name: 'coding-project', stage: 'coding' });
  expect(coding.qa_rejections).toEqual({ relevant_category: 'impl_miss', count: 2, env_flaky_count: 1 });
  expect(coding.rejections.by_category).toEqual({ '實作錯誤': 2 }); // 不含 qa 的分類（累加前一個既有案例的 1 筆 human）

  const analysis = await buildAgentSummary({ name: 'analysis-project', stage: 'analysis' });
  expect(analysis.qa_rejections).toEqual({ relevant_category: 'spec_unclear', count: 1, env_flaky_count: 1 });
});

// --- 成本、cache 拆解、空轉訊號 ---
// 意圖：健檢原本完全看不到成本，於是 30 天最大單項支出的 agent（chat $36.1）被判「表現正常」。
// 成本是本平台最該被觀測的訊號，不能不在健檢視野內。
test('buildAgentSummary 帶出 cost_usd 與 cache_create（原本兩者皆不存在）', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hd2','h','HD2') RETURNING id");
  // sonnet：1M input 單價 3.0；加權 = input + output*5 + cache_read*0.1 + cache_create*1.25
  await dbModule.query(
    `INSERT INTO token_usage (task_id,user_id,agent_type,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,duration_ms,status,recorded_at)
     VALUES ('C1',$1,'library','claude-sonnet-5',1000000,0,0,0,100,'completed',NOW())`, [u.id]);
  const s = await buildAgentSummary({ name: 'library', stage: 'library', label: 'wiki' }, { windowDays: 30 });
  expect(s.token.cost_usd).toBe(3);          // 1M input × $3/1M
  expect(s.token.cache_create).toBe(0);
  expect(s.token.cache_read).toBe(0);
});

// 意圖：cache_hit_rate 的分母原本只有 input+cache_read，漏掉 cache_create——而後者單價是
// cache_read 的 12.5 倍。漏掉最貴的那一項會讓這個比率結構上不可能低（實測 chat 顯示 0.99，
// 看似完美，實際上重寫快取吃掉近半成本），健檢因此拿到「一切良好」的假訊號。
test('cache_hit_rate 分母含 cache_create（否則永遠接近 1）', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hd3','h','HD3') RETURNING id");
  // 全部都是「重寫快取」：命中 0、重寫 900、input 100 → 正確答案是 0，舊算法會給 0
  await dbModule.query(
    `INSERT INTO token_usage (task_id,user_id,agent_type,model,input_tokens,output_tokens,cache_read_tokens,cache_create_tokens,status,recorded_at)
     VALUES ('M1',$1,'merge','claude-sonnet-5',100,0,100,800,'completed',NOW())`, [u.id]);
  const s = await buildAgentSummary({ name: 'merge', stage: 'merge', label: '合併' }, { windowDays: 30 });
  // 舊算法：100/(100+100)=0.5（看起來還行）；新算法：100/(100+100+800)=0.1（看得出在狂寫快取）
  expect(s.token.cache_hit_rate).toBe(0.1);
});

// 意圖：本平台的失敗不是崩潰（那些都記 completed），是「跑完但沒用」——空轉一輪、產出與上輪
// 相同、下游照樣失敗。failed_calls 對此完全無感（30 天幾乎全 0）。repeat_calls 由 token_usage
// 列數推算，不讀 *_retry_count（那些會在分診放行時被歸零，是「本次嘗試」的計數器）。
test('repeat_calls 反映同一任務在同一關重跑幾次（failed_calls 測不到的失敗）', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hd4','h','HD4') RETURNING id");
  // R1 跑 3 次、R2 跑 1 次，全部 completed（＝failed_calls 會是 0，但明顯有反覆重跑）
  for (let i = 0; i < 3; i++) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id,user_id,agent_type,model,input_tokens,status,recorded_at)
       VALUES ('R1',$1,'playwright','claude-sonnet-5',10,'completed',NOW())`, [u.id]);
  }
  await dbModule.query(
    `INSERT INTO token_usage (task_id,user_id,agent_type,model,input_tokens,status,recorded_at)
     VALUES ('R2',$1,'playwright','claude-sonnet-5',10,'completed',NOW())`, [u.id]);

  const s = await buildAgentSummary({ name: 'playwright', stage: 'playwright', label: 'E2E' }, { windowDays: 30 });
  expect(s.token.failed_calls).toBe(0);        // 崩潰指標看不出任何問題
  expect(s.repeat_calls.tasks_with_calls).toBe(2);
  expect(s.repeat_calls.max).toBe(3);          // 但確實有一張跑了 3 次
  expect(s.repeat_calls.avg).toBe(2);
  expect(s.repeat_calls.tasks_over_2).toBe(1);
});

// 意圖：merge-clarify／merge-explain 的 stage 是 merge，但它們用自己的名字記帳。只比對 stage 的話
// 這兩支的用量與失敗永遠是 0，健檢看它們「零呼叫」也就永遠不會檢討到——而且是靜默的。
test('buildAgentSummary 把 merge 家族用自己名字記的帳一併算進來', async () => {
  const now = new Date().toISOString();
  // 表在測試間不清空（pg-mem），先清掉別支留下的 merge 列，否則計數會被污染
  await dbModule.query("DELETE FROM token_usage WHERE agent_type IN ('merge','merge-explain','merge-clarify')");
  for (const [tid, type] of [['m1', 'merge'], ['m2', 'merge-explain'], ['m3', 'merge-clarify']]) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, output_tokens,
                                cache_read_tokens, cache_create_tokens, duration_ms, status, recorded_at)
       VALUES ($1,$2,'sonnet',100,10,0,0,1000,'completed',$3)`,
      [tid, type, now]
    );
  }
  const s = await buildAgentSummary({ name: 'merge-explain', stage: 'merge', label: '合併' }, { windowDays: 30 });
  expect(s.token.calls).toBe(3);                    // 只比對 stage 的話會是 1
  expect(s.repeat_calls.tasks_with_calls).toBe(3);
});

// 意圖：respec 這個 stage 底下是三個不同閘門的 agent（clarify-chat／spec-review／respec-patch），
// 各跑一次就記成 3。不標註的話健檢會把它讀成「這一關空轉三輪」而開出錯誤的檢討。
test('buildAgentSummary 對多閘門共用的 stage 標註「次數含跨閘門呼叫」', async () => {
  const s = await buildAgentSummary({ name: 'respec-patch', stage: 'respec', label: '規格' }, { windowDays: 30 });
  expect(s.repeat_calls.note).toMatch(/不等於本關重跑/);
  const c = await buildAgentSummary({ name: 'coding-project', stage: 'coding', label: '開發' }, { windowDays: 30 });
  expect(c.repeat_calls.note).toBeUndefined();      // 單一閘門的就不要加噪音
});


// 意圖：wall-clock 只能對已完成的任務算。tasks 沒有 completed_at，只有隨狀態變更寫入的 updated_at；
// 把進行中的任務混進來，updated_at 是「最後一次動」而非完成時刻，數字會失去意義。
// 另外用 p50/p90 而非 avg：一張卡很久的任務會把平均整個洗掉，而那正是最該被看見的尾巴。
test('wall_clock 只算 done 的任務，且以 p50/p90 呈現分佈尾巴', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hdw','h','HDW') RETURNING id");
  // 三張 done：1h / 2h / 100h（第三張是卡很久那種），一張進行中（不該被算）
  const mk = async (tid, status, hours) => {
    await dbModule.query(
      `INSERT INTO tasks (user_id, task_id, source, status, created_at, updated_at)
       VALUES ($1,$2,'manual',$3, NOW() - ($4 || ' hours')::interval, NOW())`,
      [u.id, tid, status, String(hours)]);
    await dbModule.query(
      `INSERT INTO token_usage (task_id,user_id,agent_type,input_tokens,status,recorded_at)
       VALUES ($1,$2,'wiki',1,'completed',NOW())`, [tid, u.id]);
  };
  await mk('W1', 'done', 1); await mk('W2', 'done', 2); await mk('W3', 'done', 100);
  await mk('W4', 'coding_running', 500);

  const s = await buildAgentSummary({ name: 'wiki', stage: 'wiki', label: 'Wiki' }, { windowDays: 30 });
  expect(s.tasks.wall_clock.done_tasks).toBe(3);            // 進行中那張沒混進來
  expect(s.tasks.wall_clock.p90_hours).toBeGreaterThan(50); // 尾巴看得見
  expect(s.tasks.wall_clock.p50_hours).toBeLessThan(5);     // 中位數沒被尾巴拉走
});

// 意圖：repeat_calls 只是個數字，看不出重跑的「形狀」。coding↔qa 來回震盪與 qa 自己空轉，
// 在 repeat_calls 上長得一模一樣，但成因與處置完全不同——序列是唯一能分辨的東西。
test('sequences 呈現關卡間的震盪形狀，repeat_calls 的數字看不出來', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hds','h','HDS') RETURNING id");
  await dbModule.query(
    "INSERT INTO tasks (user_id, task_id, source, status) VALUES ($1,'S1','manual','stopped')", [u.id]);
  const stages = ['analysis', 'cs', 'cs', 'analysis', 'cs'];   // cs↔analysis 之間來回
  for (let i = 0; i < stages.length; i++) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id,user_id,agent_type,input_tokens,status,recorded_at)
       VALUES ('S1',$1,$2,1,'completed', NOW() - ($3 || ' minutes')::interval)`,
      [u.id, stages[i], String(100 - i * 10)]);
  }

  const s = await buildAgentSummary({ name: 'cs', stage: 'cs', label: '客服' }, { windowDays: 30 });
  const seq = s.tasks.sequences.find(x => x.task_id === 'S1');
  expect(seq).toBeTruthy();
  // 連續同關折疊成一格：看的是關卡之間的來回，不是同關重跑幾次
  expect(seq.seq).toBe('analysis→cs→analysis→cs');
});

// 意圖：scope=task 與 scope=platform 是同一批資料的兩個投影。單張任務要看得到「走過哪些關、
// 每關花多少」，否則「拉一張任務出來按健檢」根本沒有素材，只剩最終 blocker 文字。
test('buildTaskSummary 把單張任務展開成序列與每關花費', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hdt','h','HDT') RETURNING id");
  const { rows: [t] } = await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, source, status, reentry_count, qa_retry_count, blocker_content)
     VALUES ($1,'X1','manual','stopped',2,3,'升級失敗') RETURNING id`, [u.id]);
  for (const [stage, ms] of [['analysis', 1000], ['coding', 5000], ['qa', 2000], ['coding', 4000]]) {
    await dbModule.query(
      `INSERT INTO token_usage (task_id,user_id,agent_type,input_tokens,output_tokens,duration_ms,status,recorded_at)
       VALUES ('X1',$1,$2,10,20,$3,'completed',NOW())`, [u.id, stage, ms]);
  }

  const s = await buildTaskSummary(t.id);
  expect(s.scope).toBe(`task:${t.id}`);
  expect(s.task.qa_retry_count).toBe(3);
  expect(s.task.blocker).toBe('升級失敗');
  expect(s.sequence).toContain('coding');
  expect(s.per_stage.coding.calls).toBe(2);            // 這關在這張任務上重跑了
  expect(s.per_stage.coding.duration_ms).toBe(9000);
  expect(s.per_stage.qa.calls).toBe(1);
});

test('buildTaskSummary 對不存在的任務回 null（不得丟例外中斷健檢）', async () => {
  expect(await buildTaskSummary(999999)).toBeNull();
});


// 意圖：健檢看到的 30 天指標，多數可能是舊版 prompt 產生的——改完 prompt 隔天就分析，29 天的
// 資料都與現版無關。prompt_version 給出「這版何時上線／上線後累積幾筆」，讓判準能擋掉
// 「拿舊版資料判新版好壞」。刻意不篩掉舊資料：改完當天必然 0 筆，硬篩健檢就整個瞎掉。
test('prompt_version 記錄本版上線時間與上線後樣本數（真 agent 才追）', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('hdp','h','HDP') RETURNING id");
  await dbModule.query(
    `INSERT INTO token_usage (task_id,user_id,agent_type,input_tokens,status,recorded_at)
     VALUES ('P1',$1,'reject_classify',1,'completed',NOW())`, [u.id]);

  const s1 = await buildAgentSummary(
    { name: 'reject-classifier', stage: 'reject_classify', label: '退回分類' }, { windowDays: 30 });
  expect(s1.prompt_version).toBeTruthy();
  expect(typeof s1.prompt_version.version).toBe('string');
  expect(s1.prompt_version.calls_since).toBe(1);
  // 首次記錄用 .md mtime 回填而非 NOW()——用 NOW() 的話首輪每一關都是 0 筆，判準會全面判「樣本不足」
  expect(s1.prompt_version.seeded).toBe(true);

  // 版本沒變就不該再插一列，否則窗口起點每跑一次健檢就被重設成「剛剛」
  await buildAgentSummary(
    { name: 'reject-classifier', stage: 'reject_classify', label: '退回分類' }, { windowDays: 30 });
  const { rows } = await dbModule.query(
    "SELECT COUNT(*)::int AS n FROM agent_prompt_versions WHERE agent_name='reject-classifier'");
  expect(rows[0].n).toBe(1);
});

// 意圖：測試與健檢都會傳進不存在的 agent 名（假 agent、被刪掉的 .md）。追不到版本必須靜靜略過，
// 不能讓整份摘要連帶失敗——健檢是 best-effort，一個 agent 追不到不該拖垮其他 20 個。
test('prompt_version：載不到該 agent 檔時回 null，不丟例外', async () => {
  const s2 = await buildAgentSummary({ name: '不存在的agent', stage: 'wiki', label: 'X' }, { windowDays: 30 });
  expect(s2.prompt_version).toBeNull();
});

// --- 增量視窗的起手包（主導型健檢用）---
// 意圖：固定 30 天視窗量到的指標多半由已被取代的舊版提示詞產生，判讀時整批要打折；改成
// 「上一輪之後」的增量，量到的正好是上次改動之後的表現。這裡釘住「窗外的資料不得混進來」——
// 混進來的症狀是「改動看起來沒效果」，而那是最會誤導人的一種假訊號。
test('buildWindowSummary：只涵蓋視窗內的呼叫與任務，窗外的不計', async () => {
  // 本檔前面的測試已在同一個 DB 塞過 token_usage（recorded_at=NOW()），會落在本測試的視窗內。
  // 這一支要驗的是「窗內／窗外」的界線，故先清空用量表——它是本檔最後一支測試，清掉不影響其他人。
  await dbModule.query('DELETE FROM token_usage');
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('wnd','h','W') RETURNING id");
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, title, original_text, status, source, updated_at)
     VALUES ($1,'T-WND-新','窗內','x','done','web',NOW())`, [u.id]);
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, title, original_text, status, source, updated_at)
     VALUES ($1,'T-WND-舊','窗外','x','done','web',NOW() - INTERVAL '10 days')`, [u.id]);
  await dbModule.query(
    `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, output_tokens, duration_ms, status, recorded_at)
     VALUES ('T-WND-新','coding','claude-opus-5',1,1,1000,'completed',NOW())`);
  await dbModule.query(
    `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, output_tokens, duration_ms, status, recorded_at)
     VALUES ('T-WND-新','qa','claude-opus-5',1,1,2000,'error',NOW())`);
  await dbModule.query(
    `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, output_tokens, duration_ms, status, recorded_at)
     VALUES ('T-WND-舊','coding','claude-opus-5',1,1,1000,'completed',NOW() - INTERVAL '10 days')`);

  const since = new Date(Date.now() - 86400000);
  const w = await buildWindowSummary(since);

  expect(w.volume.agent_calls).toBe(2);                       // 窗外那筆不計
  expect(w.per_stage.coding.calls).toBe(1);
  expect(w.per_stage.qa.failed_calls).toBe(1);                // 失敗要看得見，否則崩潰會被當成沒事
  const ids = w.tasks.map(t => t.task_id);
  expect(ids).toContain('T-WND-新');
  expect(ids).not.toContain('T-WND-舊');
  // 關卡序列是判斷震盪（coding→qa→coding→qa）的依據，純次數看不出形狀
  expect(w.tasks.find(t => t.task_id === 'T-WND-新').sequence).toBe('coding→qa');
});

// 30 天大健檢要拿「上一期」跟本期對照。沒有上界的話上一期會一路涵蓋到現在、把本期整段吃進去，
// 兩期的差恆為 0——比出來像「指標非常穩定」，正好是最會誤導人的那種假訊號。
test('buildWindowSummary：帶上界時只取那一段，且 window.until 回上界而不是「現在」', async () => {
  const { rows: [u] } = await dbModule.query(
    "INSERT INTO users (username,password_hash,display_name) VALUES ('wnd2','h','W2') RETURNING id");
  await dbModule.query(
    `INSERT INTO tasks (user_id, task_id, title, original_text, status, source, updated_at)
     VALUES ($1,'T-WND-上期','上一期','x','done','web',NOW() - INTERVAL '15 days')`, [u.id]);
  await dbModule.query(
    `INSERT INTO token_usage (task_id, agent_type, model, input_tokens, output_tokens, duration_ms, status, recorded_at)
     VALUES ('T-WND-上期','coding','claude-opus-5',1,1,1000,'completed',NOW() - INTERVAL '15 days')`);

  const untilAt = new Date(Date.now() - 14 * 86400000);
  const prev = await buildWindowSummary(new Date(Date.now() - 16 * 86400000), untilAt);

  expect(prev.volume.agent_calls).toBe(1);                    // 上界之後的呼叫（含本期那些）不得混進來
  expect(prev.tasks.map(t => t.task_id)).toEqual(['T-WND-上期']);
  expect(prev.window.until).toBe(untilAt.toISOString());
});

// ── chat_quality ──
// 意圖：健檢原本對 chat 只收 token／耗時／呼叫數，全是成本面。使用者實際感受到的
// 「鬼打牆、廢話太多」（2026-09-05 回報）在指標上完全沒有訊號，健檢一律報平安。
// 這幾支釘住那兩個品質數字算得對，以及「沒樣本」不得被講成「都很好」。

// 建一場對話：aiLens／userLens 是各輪的字數，corrections 是要塞進 AI 回覆開頭的更正措辭。
async function seedChat(title, aiLens, userLens, corrections = []) {
  const { rows: [p] } = await dbModule.query(
    `INSERT INTO projects (name, odoo_version) VALUES ($1,'17.0') RETURNING id`, ['P-' + title]);
  const { rows: [c] } = await dbModule.query(
    `INSERT INTO project_chats (project_id, title) VALUES ($1,$2) RETURNING id`, [p.id, title]);
  for (let i = 0; i < Math.max(aiLens.length, userLens.length); i++) {
    if (userLens[i] != null) {
      await dbModule.query(
        `INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'user',$2)`,
        [c.id, 'u'.repeat(userLens[i])]);
    }
    if (aiLens[i] != null) {
      const head = corrections[i] || '';
      await dbModule.query(
        `INSERT INTO project_chat_messages (chat_id, role, content) VALUES ($1,'ai',$2)`,
        [c.id, head + 'a'.repeat(Math.max(1, aiLens[i] - head.length))]);
    }
  }
  return c.id;
}

test('chat_quality：冗長比＝AI 回覆長度 ÷ 使用者提問長度', async () => {
  // AI 每輪 100 字、使用者每輪 10 字 → 10 倍。用兩輪：一輪的話「平均」與「單筆」看不出差別
  await seedChat('冗長比', [100, 100], [10, 10]);
  const w = await buildWindowSummary(new Date(Date.now() - 86400000));
  const hit = w.chat_quality.worst.find(c => c.title === '冗長比');
  expect(hit.ratio).toBe(10);
  expect(hit.ai_turns).toBe(2);
});

test('chat_quality：AI 承認上一輪判斷錯會被記成 self_correct', async () => {
  await seedChat('鬼打牆', [80, 80, 80], [10, 10, 10],
    ['', '你說的對，我上一輪的結論錯了。', '我要更正上一輪的說法。']);
  const w = await buildWindowSummary(new Date(Date.now() - 86400000));
  const hit = w.chat_quality.worst.find(c => c.title === '鬼打牆');
  // 第一輪沒有更正措辭，只有後兩輪算數——全部都算的話這個指標無法分辨「有沒有在繞」
  expect(hit.self_correct).toBe(2);
  expect(w.chat_quality.self_correcting_chats).toBeGreaterThanOrEqual(1);
});

// 一問一答的單輪對話沒有「鬼打牆」可言，混進來只會把中位數洗淡、讓真正在繞的那幾場被稀釋掉。
test('chat_quality：只算來回兩輪以上的對話，單輪的不列入', async () => {
  await seedChat('單輪不算', [500], [5]);   // 比值 100 倍，若被算進去 max 會被它主導
  const w = await buildWindowSummary(new Date(Date.now() - 86400000));
  expect(w.chat_quality.worst.some(c => c.title === '單輪不算')).toBe(false);
  expect(w.chat_quality.verbosity_ratio_max).toBeLessThan(100);
});

// 零樣本不得長得像「都很好」——這是這個 repo 踩過的健檢通病（零樣本記成 ok）。
test('chat_quality：窗內沒有夠長的對話時回 chats:0 並明說不成立，不得靜默回好看的數字', async () => {
  const w = await buildWindowSummary(new Date(Date.now() + 86400000));   // 未來視窗＝必定零樣本
  expect(w.chat_quality.chats).toBe(0);
  expect(w.chat_quality.note).toMatch(/不是/);
  expect(w.chat_quality.verbosity_ratio_p50).toBeUndefined();
});
