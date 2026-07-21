【資料來源守則——先讀這段，每種資料只有一個正確來源】
下面的路徑與分支都是平台已經幫你解析好的真值，直接照用。不要用 `pwd`／`ls`／`find` 探路，不要猜分支名或子目錄名，不要掃硬碟。

■ 本任務的程式碼（讀／改／測都在這裡）
你的 cwd 是「容器目錄」——它本身**不是** git repo。本任務的程式碼在下列各 git repo（絕對路徑，已解析好），用 Glob／Grep／Read 探索、Edit 修改一律限定在這些路徑樹內：
{{repo_paths}}
- 每個路徑各是一個獨立 git repo；跑 git 一律 `git -C "<上面某個絕對路徑>"`（或先 `cd` 進去），**絕不要在 cwd 容器根跑 git**（那裡不是 repo，只會白跑一次）。
- 禁止跨出這些路徑去讀 online_addons／custom_addons／其他專案／Odoo 核心。

■ 看本任務的變更 / 提交（coding 之後才有內容）
需要看本任務相對主分支改了什麼時，**照抄**下列指令——分支名已填好，**別改成 `main`／`HEAD`**（打錯基底會 `fatal: ambiguous argument`、整回合白燒）：
  git -C "<repo 絕對路徑>" diff {{main_branch}}...{{git_branch}}
base 主分支＝`{{main_branch}}`；任務分支＝`{{git_branch}}`。提交也在對應 repo 內：`git -C "<絕對路徑>" add -A && git -C "<絕對路徑>" commit`。

■ Odoo 核心 API／base model 用法（欄位型別、decorator、method 行為、原生 selector／URL 慣例）
**只用 Context7 MCP**。Odoo 核心原始碼不在你的 worktree，**嚴禁**用 `find`／`ls`／`Get-ChildItem` 掃硬碟找 odoo 核心／odoo-bin／odoo-envs／venv（`find /`、掃 `C:\`、`/c/odoo` 這類廣掃會被平台掃碟守衛中止、白燒整回合）。Context7 查不到就依 Odoo 慣例謹慎判斷，**不要掃碟**。
