#!/usr/bin/env python3
"""
查詢 Odoo task 是否有新人工訊息（比 last_known_ts 更新）
用法: python check_new_messages.py <URL> <DB> <USER> <PWD> <MODEL> <TASK_ID> <LAST_TS>
輸出: [NEW_MSG] [date] body（每條一行），無新訊息則無輸出
"""

import sys
import requests
from bs4 import BeautifulSoup


def clean_body(html_str):
    if not html_str or not isinstance(html_str, str):
        return ""
    soup = BeautifulSoup(html_str, "html.parser")
    for img in soup.find_all("img"):
        img.decompose()
    return soup.get_text(separator=" ", strip=True).strip()


def main():
    if len(sys.argv) < 8:
        print("[ERROR] 參數不足。用法: python check_new_messages.py <URL> <DB> <USER> <PWD> <MODEL> <TASK_ID> <LAST_TS>")
        sys.exit(1)

    ODOO_URL  = sys.argv[1]
    DB_NAME   = sys.argv[2]
    USERNAME  = sys.argv[3]
    PASSWORD  = sys.argv[4]
    MODEL     = sys.argv[5]
    TASK_ID   = int(sys.argv[6])
    LAST_TS   = sys.argv[7]  # "YYYY-MM-DD HH:MM:SS"

    session = requests.Session()
    session.headers.update({"User-Agent": "Mozilla/5.0"})

    auth_resp = session.post(
        f"{ODOO_URL}/web/session/authenticate",
        json={"jsonrpc": "2.0", "method": "call", "params": {
            "db": DB_NAME, "login": USERNAME, "password": PASSWORD
        }}
    ).json()
    if "error" in auth_resp:
        sys.exit(0)  # 登入失敗不阻斷流程

    msg_resp = session.post(
        f"{ODOO_URL}/web/dataset/call_kw",
        json={"jsonrpc": "2.0", "method": "call", "params": {
            "model": "mail.message",
            "method": "search_read",
            "args": [],
            "kwargs": {
                "domain": [
                    ["model",        "=",  MODEL],
                    ["res_id",       "=",  TASK_ID],
                    ["message_type", "in", ["comment", "email"]],
                    ["author_id",    "!=", False],
                    ["date",         ">",  LAST_TS],
                ],
                "fields": ["date", "body", "author_id"],
                "order":  "date asc",
                "limit":  20,
            }
        }}
    ).json()

    if "error" in msg_resp:
        sys.exit(0)

    for msg in msg_resp.get("result", []):
        body = clean_body(msg.get("body", ""))
        if body:
            author = msg["author_id"][1] if msg.get("author_id") else "unknown"
            print(f"[NEW_MSG] [{msg.get('date', '')}] {author}: {body}")


if __name__ == "__main__":
    main()
