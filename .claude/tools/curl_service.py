#!/usr/bin/env python3
"""
Odoo Service 任務同步腳本
從 Odoo 獲取 service.question.feedback 指派任務，建立目錄結構和 original.txt
"""

import sys
from pathlib import Path
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent))
from _image_utils import save_task_images

try:
    import requests
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
    import requests

STATE_LABELS = {
    'draft': '未處理',
    'open':  '處理中',
}


def clean_message_body(html_str):
    if not html_str or not isinstance(html_str, str):
        return ""
    soup = BeautifulSoup(html_str, "html.parser")
    for img in soup.find_all("img"):
        img.decompose()
    return soup.get_text(separator="\n", strip=True)


def main():
    if len(sys.argv) < 8:
        print("[ERROR] 參數不足。用法: python curl_service.py <URL> <DB> <USER> <PWD> <USER_ID> <START_DIR> <PREFIX> [SKIP_IDS]")
        sys.exit(1)

    ODOO_URL = sys.argv[1]
    DB_NAME = sys.argv[2]
    USERNAME = sys.argv[3]
    PASSWORD = sys.argv[4]
    USER_ID = int(sys.argv[5])
    START_DIR = sys.argv[6]
    PREFIX = sys.argv[7]
    SKIP_IDS = set(sys.argv[8].split(",")) if len(sys.argv) > 8 and sys.argv[8] else set()
    STOP_IDS = set(sys.argv[9].split(",")) if len(sys.argv) > 9 and sys.argv[9] else set()

    CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    session = requests.Session()
    session.headers.update({"User-Agent": CHROME_UA})

    # 登入
    auth_url = f"{ODOO_URL}/web/session/authenticate"
    auth_payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {"db": DB_NAME, "login": USERNAME, "password": PASSWORD}
    }

    try:
        auth_resp = session.post(auth_url, json=auth_payload).json()
        if "error" in auth_resp:
            print(f"[ERROR] Odoo 登入失敗: {auth_resp['error']}")
            sys.exit(1)
    except Exception as e:
        print(f"[ERROR] 連線失敗: {e}")
        sys.exit(1)

    # 獲取任務列表
    call_url = f"{ODOO_URL}/web/dataset/call_kw"
    task_payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {
            "model": "service.question.feedback",
            "method": "search_read",
            "args": [],
            "kwargs": {
                "domain": [
                    ["processing_staff", "in", [USER_ID]],
                    ["state", "in", ["draft", "open"]]
                ],
                "fields": ["id", "name_seq", "subject", "system", "state", "question_description", "classification", "respondent", "file"],
                "limit": 30
            }
        }
    }

    task_resp = session.post(call_url, json=task_payload).json()
    if "error" in task_resp:
        print(f"[ERROR] 任務查詢失敗: {task_resp['error']}")
        sys.exit(1)
    tasks = task_resp.get("result", [])

    if not tasks:
        print("[INFO] 當前沒有指派的 Service 任務。")
        sys.exit(0)

    start_path = Path(START_DIR)
    start_path.mkdir(parents=True, exist_ok=True)

    for task in tasks:
        task_id = task.get("id")
        if task_id is None:
            continue
        name_seq = task.get("name_seq", "")
        subject = task.get("subject", "未命名任務")
        task_title = f"{name_seq}: {subject}" if name_seq else subject

        if str(task_id) in STOP_IDS:
            print(f"[SKIP] {PREFIX}{task_id} 已在 stop 中（不重新同步）")
            continue
        if str(task_id) in SKIP_IDS:
            print(f"[SKIP] {PREFIX}{task_id} 已在 pipeline 中")
            continue

        task_dir = start_path / f"{PREFIX}{task_id}"
        if task_dir.exists():
            print(f"[SKIP] {task_dir} 已存在")
            continue

        # 建立任務目錄
        task_dir.mkdir(parents=True, exist_ok=True)

        # 處理欄位
        system_name = task["system"][1] if task.get("system") else "未知系統"
        respondent_name = task["respondent"][1] if task.get("respondent") else "未知帳號"
        state_raw = task.get("state", "")
        stage_name = STATE_LABELS.get(state_raw, state_raw)
        classification_name = task["classification"][1] if task.get("classification") else "未分類"
        question_description_raw = task.get("question_description") or ""
        question_description = clean_message_body(question_description_raw)

        # 獲取訊息歷史
        message_payload = {
            "jsonrpc": "2.0",
            "method": "call",
            "params": {
                "model": "mail.message",
                "method": "search_read",
                "args": [],
                "kwargs": {
                    "domain": [["model", "=", "service.question.feedback"], ["res_id", "=", task_id]],
                    "fields": ["date", "body", "attachment_ids"],
                    "order": "date desc",
                    "limit": 20
                }
            }
        }

        msg_resp = session.post(call_url, json=message_payload).json()
        if "error" in msg_resp:
            print(f"[WARN] 訊息歷史查詢失敗: {msg_resp['error']}")
            messages_data = []
        else:
            messages_data = msg_resp.get("result", [])

        message_lines = []
        for msg in messages_data:
            clean_body = clean_message_body(msg.get("body"))
            if clean_body:
                message_lines.append(f"[{msg.get('date', '')}] {clean_body}")

        all_messages_text = "\n".join(message_lines) if message_lines else "無訊息內容"

        # 下載圖片（含 file M2M 附件 + chatter 附件）
        msg_bodies = [msg.get("body", "") for msg in messages_data]
        msg_att_ids = []
        for msg in messages_data:
            msg_att_ids.extend(msg.get("attachment_ids") or [])
        file_att_ids = (task.get("file") or []) + msg_att_ids
        image_files = save_task_images(
            session, ODOO_URL, call_url,
            "service.question.feedback", task_id, task_dir,
            question_description_raw, msg_bodies,
            extra_attachment_ids=file_att_ids,
        )
        images_section = "\n".join(image_files) if image_files else "無圖片"

        # 寫入 original.txt
        original_content = f"""---id---
{task_id}
---title---
{task_title}
---project---
{respondent_name}
---stage---
{stage_name}
---classification---
{classification_name}
---description---
{question_description}
---message---
{all_messages_text}
---images---
{images_section}"""

        original_file = task_dir / "original.txt"
        original_file.write_text(original_content, encoding="utf-8")

        img_count = len(image_files)
        print(f"[TASK] 建立 {task_dir}/original.txt: {task_title}（圖片: {img_count} 張）")

if __name__ == "__main__":
    main()
