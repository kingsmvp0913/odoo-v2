import base64
import hashlib
import hmac
import json
import time
from datetime import datetime

from psycopg2 import IntegrityError

from odoo import fields, http
from odoo.http import request


def _b64url_decode(s):
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


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
    # 免密建 session → 導 /odoo。save_session 維持預設 True（否則新建的 session 不寫回 store、
    # 登入不生效，見 Task 2 spike）。
    @http.route('/aidev/sso', type='http', auth='public', csrf=False)
    def sso(self, token=None, **kw):
        if not token or token.count('.') != 1:
            return request.make_response('bad token', status=403)
        payload_b64, sig_b64 = token.split('.')

        # fail-closed：secret 未設定或過短即拒（平台端 secret = randomBytes(32).hex = 64 字元）。
        # 若放行空/短金鑰，空金鑰 HMAC 可被任意偽造 → 驗證繞過；故在做任何 HMAC 比對之前擋掉。
        secret = request.env['ir.config_parameter'].sudo().get_param('aidev.sso_secret') or ''
        if not secret or len(secret) < 32:
            return request.make_response('sso not configured', status=503)

        # 畸形 base64／JSON 一律當壞 token（403），不要讓 binascii/json 例外冒成 500。
        try:
            sig = _b64url_decode(sig_b64)
            data = json.loads(_b64url_decode(payload_b64))
        except Exception:
            return request.make_response('bad token', status=403)

        # 簽章對象是 payload_b64url 字串本身（非原始 JSON），與平台 Task 5 mintSsoToken 逐字一致。
        expected = hmac.new(secret.encode(), payload_b64.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, sig):
            return request.make_response('bad sig', status=403)
        if data.get('exp', 0) < time.time():
            return request.make_response('expired', status=403)

        # 一次性 jti 防重放：驗章（sig+exp）通過後、建立 session 之前強制佔用 jti。
        # 先 prune 過期紀錄，再以 unique(jti) 約束原子性地佔用（savepoint 隔離 create，撞約束
        # → IntegrityError = 重放 → 403，且不污染外層 transaction）。establish session 前必須
        # 確定 jti 已佔用成功。
        jti = data.get('jti')
        if not jti:
            return request.make_response('bad token', status=403)
        UsedToken = request.env['aidev.sso.used_token'].sudo()
        UsedToken.search([('expires_at', '<', fields.Datetime.now())]).unlink()
        try:
            with request.env.cr.savepoint():
                UsedToken.create({'jti': jti, 'expires_at': datetime.fromtimestamp(data['exp'])})
        except IntegrityError:
            return request.make_response('replay', status=403)

        Users = request.env['res.users'].sudo()
        gfield = 'group_ids' if 'group_ids' in Users._fields else 'groups_id'  # 19+ 改名，比照 seed
        user = Users.search([('login', '=', data['login'])], limit=1)
        if not user:
            gid = request.env.ref('base.group_system').id
            user = Users.create({
                'login': data['login'],
                'name': data.get('name') or data['login'],
                gfield: [(4, gid)],
            })
        _login_as(user)
        return request.redirect('/odoo')
