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

env.cr.commit()
print('SEED_DONE', seeded)
