#!/usr/bin/env bash
# 容器啟動流程：起 PostgreSQL → 等就緒 → 交棒 start.sh。
# 首次啟動（尚未跑過 setup、無 data/config.json）時不交棒——start.sh 在缺設定檔時會 exit 1，
# 直接交棒會讓容器在使用者有機會進來安裝之前就 crash loop。
set -e
export LANG=C.UTF-8
export LC_ALL=C.UTF-8

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGPORT_APP="${PGPORT_APP:-8772}"
APP_DIR="${APP_DIR:-$(pwd)}"

# 首次啟動：初始化叢集。superuser 用 odoo（容器全程以 odoo 身分執行，initdb 拒絕 root）。
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  echo "[entrypoint] 初始化 PostgreSQL 叢集於 $PGDATA ..."
  "$PGBIN/initdb" -D "$PGDATA" -U odoo \
      --auth-local=trust --auth-host=scram-sha-256 \
      --encoding=UTF8 --locale=C.UTF-8
fi

# docker0 閘道位址：測試區 sibling 容器以 --add-host host.docker.internal:host-gateway 連進來，
# 該名稱解析到的就是宿主 docker0 的 IP。各機 daemon 的 bip 設定不同（docker 預設 172.17.0.1，
# 本機為 10.0.0.1），寫死必然在某台機器上綁不起來，故一律偵測；容器走 host 網路，看得到宿主介面。
# 偵測不到（或想指定）時可用 PG_BRIDGE_ADDR／PG_BRIDGE_NET 覆寫。
BRIDGE_CIDR="$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | head -1)"
BRIDGE_ADDR="${PG_BRIDGE_ADDR:-${BRIDGE_CIDR%%/*}}"
BRIDGE_NET="${PG_BRIDGE_NET:-$(python3 -c "import ipaddress,sys; print(ipaddress.ip_network(sys.argv[1], strict=False))" "$BRIDGE_CIDR" 2>/dev/null)}"
if [ -z "$BRIDGE_ADDR" ]; then
  echo "[entrypoint] 警告：偵測不到 docker0 位址，測試區容器將連不到平台資料庫（可設 PG_BRIDGE_ADDR 指定）"
fi

# 埠與監聽位址每次啟動都重寫：docker daemon 重啟後 bridge 位址可能改變，只在 initdb 當下寫死會
# 讓叢集在下次啟動綁到不存在的位址（PG 只給 WARNING 後照常啟動，測試區卻連不進來，極難聯想）。
# 只聽 loopback 與 docker0：容器走 host 網路，若聽 '*' 會連公司區網介面一起把資料庫暴露出去。
mkdir -p "$PGDATA/conf.d"
cat > "$PGDATA/conf.d/odoo-v2.conf" <<EOF
port = ${PGPORT_APP}
listen_addresses = 'localhost${BRIDGE_ADDR:+,$BRIDGE_ADDR}'
EOF
grep -q "^include_dir = 'conf.d'" "$PGDATA/postgresql.conf" \
  || echo "include_dir = 'conf.d'" >> "$PGDATA/postgresql.conf"

# 本機 trust 讓 ensurePostgres 的 admin 連線免密碼；測試區容器來自 docker 橋接網段，走密碼驗證。
# 整份重寫而非附加：pg_hba 是「先匹配先贏」，附在檔尾會被發行版預設的
# 「host all all 127.0.0.1/32 scram-sha-256」先攔截，trust 永遠不會生效。
# 叢集為本容器專用，故完整掌控這份檔案；每次啟動重寫以套用最新的橋接網段。
{
  echo "# 本檔由 odoo-v2 entrypoint 於每次啟動產生，手改會被覆蓋。"
  echo "local   all    all                    trust"
  echo "host    all    all    127.0.0.1/32    trust"
  echo "host    all    all    ::1/128         trust"
  if [ -n "$BRIDGE_NET" ]; then echo "host    all    all    ${BRIDGE_NET}    scram-sha-256"; fi
} > "$PGDATA/pg_hba.conf"

echo "[entrypoint] 啟動 PostgreSQL（port ${PGPORT_APP}）..."
"$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/postgresql.log" -w -t 60 start

# initdb 不會給 superuser 設密碼，而本機走 trust（見上）＝平台自己怎麼連都通，密碼從未被驗證。
# 但測試區容器來自橋接網段、走 scram-sha-256，role 無密碼必然驗證失敗——症狀要到「建測試區」
# 才浮現，且錯誤訊息只說密碼錯，不會指向「密碼根本沒設過」。故每次啟動同步一次，讓 role 密碼
# 與 config.json 的 DATABASE_URL 永遠一致（使用者日後改設定檔的密碼也會自動跟上）。
sync_db_password() {
  local pw
  pw="$(python3 - "$APP_DIR/data/config.json" <<'PY' 2>/dev/null
import json, sys, urllib.parse
try:
    url = json.load(open(sys.argv[1])).get('DATABASE_URL', '')
except Exception:
    sys.exit(0)
print(urllib.parse.unquote(urllib.parse.urlparse(url).password or ''))
PY
)"
  [ -n "$pw" ] || return 0
  # SQL 字串字面值只需跳脫單引號（standard_conforming_strings 預設 on，反斜線不特殊）。
  if "$PGBIN/psql" -p "$PGPORT_APP" -U odoo -d postgres -qtAc \
       "ALTER ROLE odoo PASSWORD '$(printf '%s' "$pw" | sed "s/'/''/g")'" >/dev/null; then
    echo "[entrypoint] 已同步 odoo role 密碼（與 config.json 一致）"
  else
    echo "[entrypoint] 警告：同步 odoo role 密碼失敗，測試區容器將連不到平台資料庫"
  fi
}
sync_db_password

# 本腳本自己留下來當 PID 1 監工，不用 exec 交棒——exec 之後這支腳本就不存在了，容器被停時
# 沒有任何行程能在結束前 pg_ctl stop，postmaster 直接吃 SIGKILL，下次啟動得走 crash recovery
# 並留下「another server might be running」的假警報，會蓋掉真正的異常。
APP_PID=""

stop_postgres() {
  echo "[entrypoint] 關閉 PostgreSQL ..."
  "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w -t 60 stop || true
}

# docker stop 的 SIGTERM 只送給 PID 1，故由這裡轉發給平台，等它收工再關資料庫。
on_term() {
  trap - TERM INT
  if [ -n "$APP_PID" ] && kill -0 "$APP_PID" 2>/dev/null; then
    echo "[entrypoint] 收到停止訊號，通知平台結束 ..."
    kill -TERM "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  stop_postgres
  exit 0
}
trap on_term TERM INT

if [ ! -f "$APP_DIR/data/config.json" ]; then
  echo ""
  echo "=============================================================="
  echo " 平台尚未安裝（找不到 data/config.json）。"
  echo " 請執行以下兩道指令完成安裝："
  echo "   docker exec -it odoo-v2 node scripts/setup.js --skip-start"
  echo "   docker exec -it odoo-v2 claude"
  echo " 完成後：docker restart odoo-v2"
  echo "=============================================================="
  echo ""
  echo "[entrypoint] 保持容器存活等待安裝..."
  tail -f /dev/null &
else
  "$APP_DIR/start.sh" &
fi
APP_PID=$!

# 平台自己結束（crash 或被 kill）時也要正常關資料庫，再以同一個 exit code 退出，
# 讓 compose 的 restart policy 決定是否重來。
RC=0
wait "$APP_PID" || RC=$?
stop_postgres
exit "$RC"
