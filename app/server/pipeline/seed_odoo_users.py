# 由 env-agent.js 透過 `odoo-bin shell` 以 pipe 執行（exec(sys.stdin.read())）。
# 從環境變數 SEED_USERS 讀取本系統 users（JSON），在 Odoo 建立/更新對應的
# res.users，全部設為管理員（base.group_system）。password 欄位直接寫入本系統
# 的 pbkdf2_sha512 hash（與 Odoo passlib 相容），達成密碼互通。
import os
import json

users = json.loads(os.environ.get('SEED_USERS', '[]'))
gid = env.ref('base.group_system').id
Users = env['res.users'].with_context(no_reset_password=True)

# Odoo 19 起 res.users 的群組 many2many 由 groups_id 改名為 group_ids（無相容別名）→ 舊寫法會
# 丟 Invalid field 'groups_id' 讓整支 seed 中止＝同步使用者失敗。以「模型上實際存在哪個欄位」決定，
# 同時相容 ≤18（groups_id）與 19+（group_ids）。
group_field = 'group_ids' if 'group_ids' in Users._fields else 'groups_id'

# 確保繁體中文已啟用（載入語言包後才能將 user 語言設為 zh_TW）。_activate_lang 為 Odoo 14+ API；
# Odoo 13 沒有，會丟 AttributeError 讓整支 seed 中止＝同步使用者失敗。13 建置時已 --load-language=zh_TW
# 載入，只需確保該語言 active（沒載過才走安裝精靈）；失敗不致命，不阻斷後續 user 建立。
Lang = env['res.lang']
if hasattr(Lang, '_activate_lang'):
    Lang._activate_lang('zh_TW')
else:
    try:
        existing = Lang.with_context(active_test=False).search([('code', '=', 'zh_TW')], limit=1)
        if existing:
            existing.active = True
        else:
            env['base.language.install'].create({'lang': 'zh_TW', 'overwrite': False}).lang_install()
    except Exception as e:
        print('SEED_LANG_WARN', e)

seeded = 0
for u in users:
    login = u['login']
    name = u.get('name') or login
    vals = {'name': name, 'lang': 'zh_TW'}
    rec = Users.search([('login', '=', login)], limit=1)
    if rec:
        rec.write(vals)
    else:
        rec = Users.create({'login': login, **vals})
    rec.write({group_field: [(4, gid)]})
    if u.get('password_plain'):
        # 明文密碼：交由 Odoo ORM 以 passlib 正確雜湊（固定 E2E 測試帳號用）
        rec.write({'password': u['password_plain']})
    elif u.get('password'):
        env.cr.execute("UPDATE res_users SET password=%s WHERE id=%s", (u['password'], rec.id))
    seeded += 1

# 寫入該環境的 SSO 簽章 secret，供 idx_aidev_sso 讀 ir.config_parameter('aidev.sso_secret') 驗章免密登入。
# 每環境獨立、由平台於建環境時隨機產生並存 odoo_envs；無值時（相容舊契約）略過不寫。
secret = os.environ.get('AIDEV_SSO_SECRET')
if secret:
    env['ir.config_parameter'].sudo().set_param('aidev.sso_secret', secret)

# 企業版到期日：Odoo 建 DB 時把 database.expiration_date 設成一個月後的試用期，期滿後企業版後台
# 就開始擋操作，得有人手動來改。測試區不是正式訂閱，故建置時直接推到 50 年後（值由平台端算好
# 傳入；社群版不傳，也就不寫）。
#
# 順帶停用「更新通知」cron（mail.ir_cron_module_update_notification）：它每週去 odoo.com 驗訂閱，
# 回應帶 enterprise_info 時就把上面這行寫的到期日覆寫回試用期（mail/models/update.py）——症狀是
# 「明明設過了，過陣子又到期」，而且完全不指向這支排程。測試區本來就不需要回報用量給 odoo.com。
#
# 首次建置時多半停不到：那時只裝了 base／web／idx_aidev_sso，mail 還沒進來、cron 也就還不存在，
# 會走到底下那行警告。這不是 bug——seed 每次啟動測試區都會重跑（見 env-agent 的 _runEnvSetupDocker），
# 等專案模組把 mail 帶進來之後的下一次啟動就會停用它；而到期日本身每次啟動都重寫成 50 年後，
# 就算中間真的被 cron 改回試用期也會被蓋回來，不會累積漂移。
# xmlid 隨版本搬過家，找不到就用它的 model 兜底；兩條都撲空只印警告不中斷（到期日已寫成功，
# 不該讓整支 seed 失敗、連帶讓環境建不起來）。
expiration = os.environ.get('AIDEV_EXPIRATION_DATE')
if expiration:
    env['ir.config_parameter'].sudo().set_param('database.expiration_date', expiration)
    cron = env.ref('mail.ir_cron_module_update_notification', raise_if_not_found=False)
    if not cron:
        cron = env['ir.cron'].sudo().with_context(active_test=False).search(
            [('model_id.model', '=', 'publisher_warranty.contract')])
    if cron:
        cron.sudo().write({'active': False})
    else:
        print('SEED_CRON_WARN 更新通知 cron 尚不存在（mail 未安裝），待下次啟動再停用')

env.cr.commit()
print('SEED_DONE', seeded)
