#!/usr/bin/env bash
set -e

if [ -n "$VPN_USER" ] && [ -n "$VPN_PASS" ]; then
  printf '%s\n%s\n' "$VPN_USER" "$VPN_PASS" > /tmp/vpn-auth.txt
  chmod 600 /tmp/vpn-auth.txt
  openvpn --config /config/client.ovpn --auth-user-pass /tmp/vpn-auth.txt --daemon --log /tmp/openvpn.log
else
  openvpn --config /config/client.ovpn --daemon --log /tmp/openvpn.log
fi

# 等 tun0 介面出現（VPN 撥通）再起轉發，避免 socat 搶跑連到還沒建好的路由
tun_ready=false
for i in $(seq 1 30); do
  if ip link show tun0 >/dev/null 2>&1; then tun_ready=true; break; fi
  sleep 1
done

# tun0 逾時未出現代表 VPN 撥號失敗，容器應直接失敗退出，不可讓 socat 帶病上線
if [ "$tun_ready" != "true" ]; then
  echo "VPN 撥號逾時，tun0 介面未出現，請確認 VPN 帳號密碼與設定檔是否正確" >&2
  cat /tmp/openvpn.log >&2 2>/dev/null || true
  exit 1
fi

exec socat TCP-LISTEN:9999,fork,reuseaddr TCP:"${TARGET_HOST}":"${TARGET_PORT}"
