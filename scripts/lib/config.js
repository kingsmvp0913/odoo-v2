// scripts/lib/config.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function randomSecret() {
  return crypto.randomBytes(32).toString('base64');
}

async function ensureConfig(configPath, ask) {
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    let changed = false;
    if (!cfg.APP_SECRET) { cfg.APP_SECRET = randomSecret(); changed = true; }
    if (!cfg.JWT_SECRET) { cfg.JWT_SECRET = randomSecret(); changed = true; }
    if (changed) fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    return cfg;
  }

  const pgHost = await ask('PG_HOST', 'localhost');
  const pgPort = await ask('PG_PORT', '5432');
  const pgDb = await ask('PG_DB', 'aidev');
  const pgUser = await ask('PG_USER', '');
  const pgPassword = await ask('PG_PASSWORD', '');
  const apiKey = await ask('ANTHROPIC_API_KEY', '');

  const cfg = {
    DATABASE_URL: `postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${pgDb}`,
    JWT_SECRET: randomSecret(),
    APP_SECRET: randomSecret(),
    PORT: 3939,
  };
  if (apiKey) cfg.ANTHROPIC_API_KEY = apiKey;

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return cfg;
}

module.exports = { ensureConfig, randomSecret };
