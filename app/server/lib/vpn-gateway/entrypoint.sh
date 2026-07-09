#!/usr/bin/env bash
set -e

# Windows 上 Docker Desktop 的 bind mount 對主機剛寫入的檔案偶爾有短暫的可見性延遲，
# 容器啟動太快可能讀到還沒同步好（甚至空的）的設定檔；開 openvpn 前先確認檔案已存在且非空。
for i in $(seq 1 10); do
  if [ -s /config/client.ovpn ]; then break; fi
  sleep 0.5
done

# --tls-cert-profile insecure：部分老牌廠商 VPN 伺服器的 CA 憑證用 SHA1 簽章（金鑰長度本身正常，
# 如鴻久這份是 2048-bit RSA），現代 OpenSSL 3.x 預設會拒絕驗證；桌面版 GUI 因為內附舊版 OpenSSL
# 1.1.x 沒有這層限制才連得上。實測過改用較窄的 --tls-cert-profile legacy 仍會被同一個
# 「CA signature digest algorithm too weak」擋下（OpenVPN 2.6 的 legacy profile 在這個
# OpenSSL 3.x 組合下並未涵蓋 SHA1 簽章驗證），只有 insecure 能通過，故維持使用 insecure；
# 不影響 VPN 通道本身的加密（.ovpn 內指定的 cipher 不受影響）。
if [ -n "$VPN_USER" ] && [ -n "$VPN_PASS" ]; then
  printf '%s\n%s\n' "$VPN_USER" "$VPN_PASS" > /tmp/vpn-auth.txt
  chmod 600 /tmp/vpn-auth.txt
  openvpn --config /config/client.ovpn --tls-cert-profile insecure --auth-user-pass /tmp/vpn-auth.txt --daemon --log /tmp/openvpn.log
else
  openvpn --config /config/client.ovpn --tls-cert-profile insecure --daemon --log /tmp/openvpn.log
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
