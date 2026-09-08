// 部署指令模板。純函式、不碰 SSH——好測，而且「指令長什麼樣」與「怎麼送出去」分開，
// 改指令時不必動執行器。
//
// 每一個進指令的值都過白名單，不合法就 throw、不產出半套指令：這是唯一擋在
// 「使用者可編輯的欄位」與「客戶正式機的 shell」之間的東西。
const { sudoPrefix, requireIdent, validatePath } = require('./ssh-exec');

const LOG = '/tmp/aidev-deploy.log';

function path_(v, name) {
  if (!validatePath(v)) throw new Error(`${name} 不是合法的絕對路徑：${v}`);
  return v;
}
function modsArg(modules) {
  if (!Array.isArray(modules) || !modules.length) throw new Error('模組清單不可為空');
  return modules.map(m => requireIdent(m, 'module')).join(',');
}
function port_(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`http_port 不合法：${v}`);
  return n;
}

// 沒有 lastSha ＝ 第一次部署，全部模組都送。
// 有 lastSha ＝ 只送這次 diff 碰到、且確實屬於這個 target 的模組。
// 交集的另一半意義是安全：遠端獨有的模組（鴻久那台的 web_responsive 等）永遠不會進清單。
function pickModules(changedPaths, targetModules, lastSha) {
  const mods = Array.isArray(targetModules) ? targetModules : [];
  if (!lastSha) return [...mods];
  const tops = new Set((changedPaths || []).map(p => String(p).split('/')[0]));
  return mods.filter(m => tops.has(m));
}

function buildUpgradeCmd(target, conn, modules) {
  const S = sudoPrefix(conn);
  const mods = modsArg(modules);
  const db = requireIdent(target.db_name, 'db_name');
  const conf = path_(target.conf_path, 'conf_path');

  // exit code 落檔再讀：odoo -u 失敗時仍會印一堆看似正常的啟動訊息，靠關鍵字判斷會誤判；
  // 而 exit code 一旦經過管線或尾隨指令就不是這條的碼（此 repo 已誤判三次）。
  if (target.runtime === 'docker') {
    if (target.compose_dir && target.compose_service) {
      const dir = path_(target.compose_dir, 'compose_dir');
      const svc = requireIdent(target.compose_service, 'compose_service');
      // 停掉 web 再用 run --rm 起臨時容器升級：run 不發布 port，不會與停掉的 web 撞埠，
      // 升級期間只有一個進程碰 DB。*-runner 刻意不動（使用者裁決，見設計文件 §11）。
      return [
        `cd ${dir}`,
        `${S}docker compose stop ${svc}`,
        `${S}docker compose run --rm ${svc} odoo -c ${conf} -d ${db} -u ${mods} --stop-after-init > ${LOG} 2>&1`,
        `echo "EXITCODE=$?" >> ${LOG}`,
        `${S}docker compose start ${svc}`,
        `cat ${LOG}`,
      ].join('\n');
    }
    // 退路：沒有 compose context 時只能在跑著的容器裡 exec（兩個進程碰同一個 DB）
    const c = requireIdent(target.container_name, 'container_name');
    return [
      `${S}docker exec ${c} odoo -c ${conf} -d ${db} -u ${mods} --stop-after-init > ${LOG} 2>&1`,
      `echo "EXITCODE=$?" >> ${LOG}`,
      `${S}docker restart ${c}`,
      `cat ${LOG}`,
    ].join('\n');
  }

  const svc = requireIdent(target.service_name, 'service_name');
  // 以 odoo 帳號執行，不是以 SSH 登入的帳號：filestore 與 data_dir 的 owner 是 odoo，
  // 用別的帳號跑會產生 root 擁有的檔案，之後 Odoo 自己寫不進去。
  return [
    `${S}systemctl stop ${svc}`,
    `${S}-u odoo odoo-bin -c ${conf} -d ${db} -u ${mods} --stop-after-init > ${LOG} 2>&1`,
    `echo "EXITCODE=$?" >> ${LOG}`,
    `${S}systemctl start ${svc}`,
    `cat ${LOG}`,
  ].join('\n');
}

function buildRestartCmd(target, conn) {
  const S = sudoPrefix(conn);
  if (target.runtime === 'docker') {
    if (target.compose_dir && target.compose_service) {
      return `cd ${path_(target.compose_dir, 'compose_dir')}\n${S}docker compose restart ${requireIdent(target.compose_service, 'compose_service')}`;
    }
    return `${S}docker restart ${requireIdent(target.container_name, 'container_name')}`;
  }
  return `${S}systemctl restart ${requireIdent(target.service_name, 'service_name')}`;
}

// 印可判讀的標記而不是靠 exit code：這條會經過重試迴圈，迴圈本身的 exit code 沒有意義。
function buildHealthCmd(target) {
  const port = port_(target.http_port);
  return `for i in $(seq 1 12); do curl -sf http://localhost:${port}/web/login > /dev/null && { echo HEALTH_OK; exit 0; }; sleep 5; done; echo HEALTH_FAIL; exit 1`;
}

// 原子替換：先把舊的搬進 .deploy-bak-<ts>，再把新的搬進去。
// 整包 mv 而不是同步檔案——這樣才處理得掉「這次刪掉的檔案」，而且慈雲那台沒有 rsync。
// 只碰 modules 列到的目錄，遠端獨有的模組（鴻久那台混著的 OCA 模組）完全不會出現在指令裡。
function buildSwapCmd(target, modules, ts) {
  const dir = path_(target.addons_dir, 'addons_dir');
  const stamp = requireIdent(ts, 'ts');
  const bak = `${dir}/.deploy-bak-${stamp}`;
  const lines = [`mkdir -p ${bak}`];
  for (const m of modules) {
    const mod = requireIdent(m, 'module');
    lines.push(`tar -xzf ${dir}/.deploy-staging/${mod}.tgz -C ${dir}/.deploy-staging`);
    lines.push(`[ -d ${dir}/${mod} ] && mv ${dir}/${mod} ${bak}/${mod} || true`);
    lines.push(`mv ${dir}/.deploy-staging/${mod} ${dir}/${mod}`);
  }
  return lines.join('\n');
}

function buildRollbackCmd(target, modules, ts) {
  const dir = path_(target.addons_dir, 'addons_dir');
  const stamp = requireIdent(ts, 'ts');
  const bak = `${dir}/.deploy-bak-${stamp}`;
  const lines = [];
  for (const m of modules) {
    const mod = requireIdent(m, 'module');
    lines.push(`rm -rf ${dir}/${mod}`);
    lines.push(`[ -d ${bak}/${mod} ] && mv ${bak}/${mod} ${dir}/${mod} || true`);
  }
  return lines.join('\n');
}

module.exports = { pickModules, buildUpgradeCmd, buildRestartCmd, buildHealthCmd, buildSwapCmd, buildRollbackCmd };
