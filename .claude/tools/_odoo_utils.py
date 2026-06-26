#!/usr/bin/env python3
import json
import os
import sys
import requests
from bs4 import BeautifulSoup
from pathlib import Path

CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

_CONFIG_PATH = Path(__file__).parent / "config.json"


def load_config(section="odoo", optional=False):
    """從 config.json 讀取指定區塊設定，密碼從對應 env var 取得。
    optional=True 時若密碼未設定回傳 None 而非結束程式。"""
    with open(_CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)[section]
    password = os.environ.get(cfg["password_env"], "")
    if not password:
        if optional:
            return None
        print(f"[ERROR] 環境變數 {cfg['password_env']} 未設定")
        sys.exit(1)
    return {
        "url": cfg["url"],
        "db": cfg["db"],
        "username": cfg["username"],
        "user_id": cfg["user_id"],
        "password": password,
    }


def remove_images_only(html_str):
    if not html_str or not isinstance(html_str, str):
        return ""
    soup = BeautifulSoup(html_str, "html.parser")
    for img in soup.find_all("img"):
        img.decompose()
    return str(soup)


def clean_message_body(html_str):
    if not html_str or not isinstance(html_str, str):
        return ""
    soup = BeautifulSoup(html_str, "html.parser")
    for img in soup.find_all("img"):
        img.decompose()
    return soup.get_text(separator="\n", strip=True)


def parse_args(script_name):
    """給 pipeline 腳本（curl.py / curl_service.py）用，由 PS1 傳入完整參數。"""
    if len(sys.argv) < 8:
        print(f"[ERROR] 參數不足。用法: python {script_name} <URL> <DB> <USER> <PWD> <USER_ID> <START_DIR> <PREFIX> [SKIP_IDS]")
        sys.exit(1)
    return (
        sys.argv[1],
        sys.argv[2],
        sys.argv[3],
        sys.argv[4],
        int(sys.argv[5]),
        sys.argv[6],
        sys.argv[7],
        set(sys.argv[8].split(",")) if len(sys.argv) > 8 and sys.argv[8] else set(),
    )


def create_odoo_session(odoo_url, db_name, username, password):
    session = requests.Session()
    session.headers.update({"User-Agent": CHROME_UA})
    auth_payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {"db": db_name, "login": username, "password": password},
    }
    try:
        auth_resp = session.post(f"{odoo_url}/web/session/authenticate", json=auth_payload).json()
        if "error" in auth_resp:
            print(f"[ERROR] Odoo 登入失敗: {auth_resp['error']}")
            sys.exit(1)
    except Exception as e:
        print(f"[ERROR] 連線失敗: {e}")
        sys.exit(1)
    return session
