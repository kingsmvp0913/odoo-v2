from odoo import fields, models


# 記錄已用過的 SSO jti，供 controller 做一次性防重放（token 走 URL query 會進 access log，
# 僅驗 exp 時 TTL 窗內可重放取得 admin session；平台端 nonce 為單行程記憶體、無法跨行程保護，
# 故防重放落在 Odoo 端）。unique(jti) 以 DB 約束原子性地「佔用」jti。
class AidevSsoUsedToken(models.Model):
    _name = 'aidev.sso.used_token'
    _description = 'idxSSO已用token（一次性jti防重放）'

    jti = fields.Char(required=True, index=True)
    expires_at = fields.Datetime()

    _sql_constraints = [
        ('jti_uniq', 'unique(jti)', 'SSO token 已被使用（重放）'),
    ]
