# 由 env-agent.js uninstallModule() 透過 `odoo-bin shell` 以 stdin 餵入執行。
# 在 shell context 內 `env` 已就緒。module 名由環境變數 UNINSTALL_MODULE 帶入。
# 只印一行 `RESULT:<...>` 供 Node 端解析；不整庫重建，只卸載單一 module。
import os

name = os.environ['UNINSTALL_MODULE']
mod = env['ir.module.module'].search([('name', '=', name)])

if not mod or mod.state != 'installed':
    # 沒裝過 / 已不是 installed → 無事可做
    print('RESULT:skipped_not_installed')
else:
    # 已安裝且 depends 這個 module 的下游 module：button_immediate_uninstall 會連帶把它們一起卸掉，
    # 因此有下游依存時一律不卸、回報依存清單交由人工處理（exclude 掉本來就非安裝狀態者）。
    deps = mod.downstream_dependencies(exclude_states=('uninstalled', 'uninstallable', 'to remove'))
    if deps:
        print('RESULT:skipped_dependents:' + ','.join(sorted(deps.mapped('name'))))
    else:
        mod.button_immediate_uninstall()  # 內部自行 commit + reload registry
        env.cr.commit()
        print('RESULT:uninstalled')
