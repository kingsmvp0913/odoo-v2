#!/usr/bin/env python3
"""
Odoo 任務留言腳本
向指定 project.task 發送內部訊息（Pipeline 進度通知用）
"""

import sys
import requests


def main():
    if len(sys.argv) < 7:
        print("[ERROR] 用法: python send_message.py <URL> <DB> <USER> <PWD> <TASK_ID> <MESSAGE>")
        sys.exit(1)

    ODOO_URL = sys.argv[1]
    DB_NAME  = sys.argv[2]
    USERNAME = sys.argv[3]
    PASSWORD = sys.argv[4]
    TASK_ID  = int(sys.argv[5])
    MESSAGE  = sys.argv[6]

    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0 (Pipeline-Bot)"})

    # 登入
    auth_url = f"{ODOO_URL}/web/session/authenticate"
    auth_payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {"db": DB_NAME, "login": USERNAME, "password": PASSWORD},
    }
    try:
        auth_resp = session.post(auth_url, json=auth_payload).json()
        if "error" in auth_resp:
            print(f"[ERROR] Odoo 登入失敗: {auth_resp['error']}")
            sys.exit(1)
    except Exception as e:
        print(f"[ERROR] 連線失敗: {e}")
        sys.exit(1)

    # 使用 message_post 發送留言（標準 Odoo Chatter API）
    call_url = f"{ODOO_URL}/web/dataset/call_kw"
    msg_payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {
            "model": "project.task",
            "method": "message_post",
            "args": [[TASK_ID]],
            "kwargs": {
                "body": MESSAGE,
                "message_type": "comment",
                "subtype_xmlid": "mail.mt_comment",
            },
        },
    }
    try:
        resp = session.post(call_url, json=msg_payload).json()
        if "error" in resp:
            print(f"[ERROR] 訊息發送失敗: {resp['error']}")
            sys.exit(1)
        print(f"[OK] 訊息已發送至 task_{TASK_ID}")
    except Exception as e:
        print(f"[ERROR] 訊息發送例外: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
