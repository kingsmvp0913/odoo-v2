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
for i in $(seq 1 30); do
  if ip link show tun0 >/dev/null 2>&1; then break; fi
  sleep 1
done

exec socat TCP-LISTEN:9999,fork,reuseaddr TCP:"${TARGET_HOST}":"${TARGET_PORT}"
