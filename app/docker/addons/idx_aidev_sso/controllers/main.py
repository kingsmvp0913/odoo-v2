import base64
import hashlib
import hmac
import json
import time
from datetime import datetime

import werkzeug.utils
from psycopg2 import IntegrityError

from odoo import fields, http
from odoo.http import request


# 16x16 灰底 PNG，作為 JIT 建帳號的佔位頭像（見 sso() 內註解：避開 hr_attendance 空集合核心 bug）。
_PLACEHOLDER_AVATAR = (
    b'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGUlEQVR4nGOsqKhgIAUwkaR6VMOohiGlAQB//AGI+wtSTgAAAABJRU5ErkJggg=='
)


def _b64url_decode(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


# 帶狀態碼的純文字回應。不用 make_response(..., status=)：那個參數 17.0 起才有，14/15 傳了會
# TypeError，把每一條「拒絕」都變成 500——使用者看到的不是「token 過期」而是一頁 traceback，
# 且 traceback 指向 http.py 完全看不出真因。改為拿回應物件再設 status_code（13→19 皆可）。
def _err(msg, code):
    resp = request.make_response(msg)
    resp.status_code = code
    return resp


# 免密建立目前 request 的已認證 web session（跨 Odoo 13→19/master）。
# 原理：security.check_session()（odoo/service/security.py，13→19/master 邏輯一致）只驗
# session.uid + session.session_token == user._compute_session_token(session.sid)，完全不經
# authenticate()/密碼；_compute_session_token(self, sid) 簽名跨版本穩定。唯一逐版差異是 rotate
# 屬性名（16.0 起 rotate→should_rotate），以 hasattr 分流（比照 seed_odoo_users.py 的版本容錯慣例）。
def _login_as(user):
    session = request.session
    session.db = request.db
    session.uid = user.id
    session.login = user.login
    session.session_token = user._compute_session_token(session.sid)
    if hasattr(session, 'should_rotate'):   # 16.0+ 改名；13/14/15 為 rotate
        session.should_rotate = True
    else:
        session.rotate = True


class AidevSso(http.Controller):
    # 平台簽發一次性 token 導向此端點：驗 HMAC 章 + 驗 exp → 佔用 jti（防重放）→ JIT 建 user →
    # 免密建 session → 導 /web（13-16 僅 /web，17+ 會自動轉 /odoo）。save_session 維持預設 True（否則新建的 session 不寫回 store、
    # 登入不生效，見 Task 2 spike）。
    @http.route('/aidev/sso', type='http', auth='public', csrf=False)
    def sso(self, token=None, **kw):
        if not token or token.count('.') != 1:
            return _err('bad token', 403)
        payload_b64, sig_b64 = token.split('.')

        # fail-closed：secret 未設定或過短即拒（平台端 secret = randomBytes(32).hex = 64 字元）。
        # 若放行空/短金鑰，空金鑰 HMAC 可被任意偽造 → 驗證繞過；故在做任何 HMAC 比對之前擋掉。
        secret = request.env['ir.config_parameter'].sudo().get_param('aidev.sso_secret') or ''
        if not secret or len(secret) < 32:
            return _err('sso not configured', 503)

        # 畸形 base64／JSON 一律當壞 token（403），不要讓 binascii/json 例外冒成 500。
        try:
            sig = _b64url_decode(sig_b64)
            data = json.loads(_b64url_decode(payload_b64))
        except Exception:
            return _err('bad token', 403)

        # 簽章對象是 payload_b64url 字串本身（非原始 JSON），與平台 Task 5 mintSsoToken 逐字一致。
        expected = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, sig):
            return _err('bad sig', 403)
        if data.get('exp', 0) < time.time():
            return _err('expired', 403)

        # 一次性 jti 防重放：驗章（sig+exp）通過後、建立 session 之前強制佔用 jti。
        # 先 prune 過期紀錄，再以 unique(jti) 約束原子性地佔用（savepoint 隔離 create，撞約束
        # → IntegrityError = 重放 → 403，且不污染外層 transaction）。establish session 前必須
        # 確定 jti 已佔用成功。
        jti = data.get('jti')
        if not jti:
            return _err('bad token', 403)
        UsedToken = request.env['aidev.sso.used_token'].sudo()
        UsedToken.search([('expires_at', '<', fields.Datetime.now())]).unlink()
        try:
            with request.env.cr.savepoint():
                UsedToken.create({'jti': jti, 'expires_at': datetime.utcfromtimestamp(data['exp'])})
        except IntegrityError:
            return _err('replay', 403)

        Users = request.env['res.users'].sudo()
        gfield = 'group_ids' if 'group_ids' in Users._fields else 'groups_id'  # 19+ 改名，比照 seed
        user = Users.search([('login', '=', data['login'])], limit=1)
        if not user:
            # group_user（內部使用者）必須明確給，不能只給 group_system 靠隱含群組推導：15/16 的隱含鏈
            # 到 base.group_erp_manager 就停了，不含 group_user（17+ 才補上這一段），JIT 建出來的帳號
            # 於是 share=True ＝外部使用者。後果是 web 的 session_info 只在 has_group('base.group_user')
            # 成立時才塞 load_menus／qweb／user_companies（web/models/ir_http.py），三者皆缺 → webclient
            # 開機讀不到 user_companies 即死、抓 template 的網址變成 /web/webclient/qweb/undefined →
            # 後台整片空白，且畫面與 log 都沒有任何錯誤訊息可循。
            gids = [request.env.ref('base.group_user').id, request.env.ref('base.group_system').id]
            # image_1920 必須在 create 當下就給值：內部使用者若無頭像，base res_users.create 會在
            # create 後自動補一張 initials 頭像（`user.image_1920 = ...`），這個「後寫」會打進
            # hr.res_users.write 的 image 分支，對「此新 user 還沒有的 hr.employee 空集合」做 write，
            # 一路觸發 Odoo 19 hr_attendance._clean_attendance_officers 在空 recordset 上的核心 bug
            # （TypeError: inconsistent models res.users() - hr.employee()）→ 只要 login 是尚未 seed 的
            # 真人使用者、且環境裝了 hr_attendance（如 odoo19_HRM），JIT 建帳號就 500。預先給一張
            # 佔位頭像讓 `not user.image_1920` 為 False，跳過那個後寫即繞開崩潰。
            user = Users.create({
                'login': data['login'],
                'name': data.get('name') or data['login'],
                'image_1920': _PLACEHOLDER_AVATAR,
                gfield: [(4, g) for g in gids],
            })
        _login_as(user)
        # werkzeug 的 redirect，不是 request.redirect：後者 15.0 起才有，14 會 AttributeError
        # （'HttpRequest' object has no attribute 'redirect'）——SSO 在 14 環境連成功路徑都當場 500，
        # 整個測試區進不去。session cookie 由 Odoo 的 root.dispatch 統一寫回，回裸 Response 一樣帶得到。
        return werkzeug.utils.redirect('/web', code=303)
