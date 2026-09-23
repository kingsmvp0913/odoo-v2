const { newDb } = require('pg-mem');

let db, remainingTaskBudget;
beforeAll(async () => {
  const { Pool } = newDb().adapters.createPg();
  db = require('../db');
  db._setPoolForTesting(new Pool());
  await db.migrate();
  ({ remainingTaskBudget } = require('../lib/task-budget'));
});
afterAll(() => db._setPoolForTesting(null));

async function makeTask(name, { internal = false, budget = null } = {}) {
  const { rows: [co] } = await db.query(
    'INSERT INTO companies (name, is_internal, task_budget_usd) VALUES ($1,$2,$3) RETURNING id',
    [name, internal, budget]
  );
  const { rows: [user] } = await db.query(
    "INSERT INTO users (username, password_hash, display_name, company_id) VALUES ($1,'hash',$1,$2) RETURNING id",
    [name, co.id]
  );
  const { rows: [task] } = await db.query(
    "INSERT INTO tasks (user_id, task_id, source) VALUES ($1,$2,'manual') RETURNING id, task_id",
    [user.id, `task_${name}`]
  );
  return task;
}

test('客戶任務以建立者公司的上限扣除實際金額，達上限時不准再派工', async () => {
  const task = await makeTask('budget-customer', { budget: 5 });
  await db.query("INSERT INTO token_usage (task_id, agent_type, cost_usd) VALUES ($1,'coding',1.25)", [task.task_id]);
  expect(await remainingTaskBudget(task.id)).toBeCloseTo(3.75);
  await db.query("INSERT INTO token_usage (task_id, agent_type, cost_usd) VALUES ($1,'qa',3.75)", [task.task_id]);
  await expect(remainingTaskBudget(task.id)).rejects.toMatchObject({ code: 'TASK_BUDGET_EXCEEDED' });
});

test('舊資料沒有實際金額時仍以 token 估算；內部公司與未設定上限的客戶不受限', async () => {
  const estimated = await makeTask('budget-estimated', { budget: 5 });
  await db.query(
    "INSERT INTO token_usage (task_id, agent_type, model, input_tokens) VALUES ($1,'coding','sonnet',1000000)",
    [estimated.task_id]
  );
  expect(await remainingTaskBudget(estimated.id)).toBeCloseTo(2);
  const internal = await makeTask('budget-internal', { internal: true, budget: 1 });
  const unset = await makeTask('budget-unset');
  expect(await remainingTaskBudget(internal.id)).toBeNull();
  expect(await remainingTaskBudget(unset.id)).toBeNull();
});
