/**
 * db.test.js — PostgreSQL pool wrapper tests using pg-mem
 *
 * TDD: these tests are written BEFORE the implementation.
 * pg-mem simulates an in-memory PostgreSQL instance.
 */
const { newDb } = require('pg-mem');

// We will inject a pg-mem backed pool into the module.
// The module reads DATABASE_URL but in tests we override via _setPoolForTesting().
let dbModule;

// Build a pg-mem pool-compatible adapter before each test suite
let memPool;

beforeAll(() => {
  // Create an in-memory PG instance
  const db = newDb();
  // Obtain a node-postgres compatible pool adapter
  memPool = db.adapters.createPg().Pool;
  const pool = new memPool();

  // Inject before requiring the module
  dbModule = require('../db');
  dbModule._setPoolForTesting(pool);
});

afterAll(async () => {
  // Nothing to clean up for pg-mem
});

test('getPool() returns the same pool instance (singleton)', () => {
  const a = dbModule.getPool();
  const b = dbModule.getPool();
  expect(a).toBe(b);
});

test('migrate() creates all 7 required tables', async () => {
  await dbModule.migrate();

  const { rows } = await dbModule.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'`
  );
  const tableNames = rows.map(r => r.table_name);

  const required = [
    'users',
    'tasks',
    'task_logs',
    'loop_counter',
    'sessions',
    'project_maps',
    'odoo_version_configs',
  ];
  for (const t of required) {
    expect(tableNames).toContain(t);
  }
});

test('migrate() is idempotent (can be called twice without error)', async () => {
  await expect(dbModule.migrate()).resolves.toBeUndefined();
});

test('query() resolves with { rows } array', async () => {
  const result = await dbModule.query('SELECT 1 AS val');
  expect(result).toHaveProperty('rows');
  expect(Array.isArray(result.rows)).toBe(true);
  expect(result.rows[0].val).toBe(1);
});

test('query() supports $1 parameterised queries', async () => {
  const result = await dbModule.query('SELECT $1::text AS name', ['hello']);
  expect(result.rows[0].name).toBe('hello');
});

test('migrate() creates task_messages table and teams_settings.writeback_odoo_notes column', async () => {
  await dbModule.migrate();

  const { rows: tables } = await dbModule.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  expect(tables.map(r => r.table_name)).toContain('task_messages');

  const { rows: cols } = await dbModule.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'teams_settings'`
  );
  expect(cols.map(r => r.column_name)).toContain('writeback_odoo_notes');
});
