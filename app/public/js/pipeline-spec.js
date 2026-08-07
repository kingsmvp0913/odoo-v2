// Pipeline 流程的**內容單一來源**：有哪些關、彼此怎麼接、每一關的進入條件與去向。
//
// 這裡刻意只有資料，沒有任何座標、顏色、SVG 或 Vue——那些全在 views/PipelineFlow.js。
// 分開的理由是「誰要讀它」：畫圖只是用途之一，AI agent 要搞懂這條 pipeline 時，
// 需要的是這 300 行，不是那 1000 行的曼哈頓路由。混在一起等於每次都要付五倍的 token。
//
// ── 它與程式碼的關係（重要，不要弄反）────────────────────────
// 真正在跑的狀態機在 server/pipeline/runner.js、verdict-router.js、reject-triage.js，
// 轉移邏輯散在各關的 inline 賦值，沒有集中的轉移表。所以**這份 spec 不驅動執行**，
// 它是一份人工謄本，由 server/tests/pipeline-flow.test.js 守著不要跟狀態機漂移。
// 改流程的順序：先在 status-labels.js 的 registry 加狀態（label／actor）→ 再改這裡談清楚接法
// → 再改 runner 那幾支 → 測試會逼三邊同步。順序不能顛倒：「誰要等人、誰能派工」那幾份名單全部
// 由 registry 的 actor 推導，registry 沒有的狀態在這裡寫了也只會讓測試翻紅。
// 本檔的 kind 另有一條反向守衛：畫成 gate／stop 的格子，registry 必須真的標成 actor:'human'
// （畫成閘門卻標成 system，畫面看起來正常，但那張任務會被 cron 自動推走）。
//
// status 與 ref 分兩個欄位：status 只放**真的任務狀態**（測試逐一比對 STATUS_LABELS），
// Git 分支名與「不是狀態」的說明一律放 ref。混用一個欄位的話，測試無從分辨 'testing'
// （分支名）與 'cs_running'（狀態），也就擋不住把不存在的狀態畫成一關。
//
// flags = { e2eEnabled, specTour, showGit }：前兩個對應專案設定（e2e_disabled 的反面、
// spec_tour_enabled），第三個純顯示。三個都會實際改變節點與連線，不只是隱藏。

// 泳道定義。順序＝由左到右；沒有 flag 的一律顯示，有 flag 的由對應的開關控制。
// 擴充：加一條泳道就是加一筆（例：{ id: 'eservice', label: 'eService', flag: 'showEservice',
// toggleLabel: '顯示 eService' }），再讓節點帶 track: 'eservice' 即可，版面與開關列會自動跟上。
const PF_TRACKS = [
  { id: 'git',   label: 'Git 分支',      flag: 'showGit', toggleLabel: '顯示 Git 分支流' },
  { id: 'task',  label: '任務主線' },
  { id: 'human', label: '人工介入' },
  // 分診與規格層重做是 analysis-reject／respec-patch 兩支 agent 在跑，不是人工介入；但它們也
  // 不在主線上（異常才會走到），塞進主線泳道會逼得 QA→併入測試 繞開兩格。獨立一條旁支泳道。
  //
  // 為什麼擺最右而不是緊鄰主線：兩種都試過，實測交叉數 11 vs 20。緊鄰主線雖然讓這兩關回開發
  // 的線變短，但客服／澄清／審核與主線之間的來回線更多，那些全部得改為橫跨一整欄。
  { id: 'aside', label: 'AI 旁支' }
];

function pipelineTracks(flags) {
  return PF_TRACKS.filter((t) => !t.flag || flags[t.flag]);
}

// 真的存在、但**刻意不畫成一格**的任務狀態：它們是閘門的出入口標記或閘門內部的過渡態，
// 任務只會瞬間經過，畫上去等於多三個沒人會停在那裡的框。
// pipeline-flow.test.js 會拿 runner 實際會設定的狀態來對：不在圖上、也不在這份名單裡就紅——
// 那正是「加了新關卡卻忘了畫」的警報。新增狀態若也屬於過渡態，補進來並寫明理由。
// 刻意用 [狀態, 理由] 的陣列而不是物件：寫成 `狀態: '中文'` 的形狀會被
// frontend-status-labels.test.js 判成「又抄了一份狀態標籤表」——那個守衛抓過真實漂移
// （socket.js 的第二份表叫 labels，cs_reply_pending 在它那裡是「等待回覆確認」），不該為這裡放寬。
const PF_UNDRAWN_STATUSES = [
  ['confirm_answered',     '等待確認的出口標記，答完立刻回分析關完整重跑'],
  ['clarify_answered',     '待你裁決的出口標記，答完立刻依 resume_status 導回原關'],
  ['clarify_chat_running', '等待確認／待你裁決閘門內部：使用者反問時 clarify-chat 正在跑']
];

// 節點定義。track＝泳道，step＝由上而下的垂直序（同一泳道內不得重複）。
// step 是手寫的且刻意留有空號——畫圖那端會把完全空的列收掉，所以搬動節點不必重編後面所有的號。
// detail 是「進入條件／做什麼／成功往哪／失敗往哪」，每一列 [標題, 內容]。
function pipelineNodes(flags) {
  const { e2eEnabled, specTour } = flags;
  const tracks = pipelineTracks(flags);
  const n = [];
  const push = (o) => { if (tracks.some((t) => t.id === o.track)) n.push(o); };

  // ── 任務主線 ──────────────────────────────────────────
  push({
    id: 'new', track: 'task', step: 0, kind: 'start', label: '待分類',
    status: 'new',
    detail: [
      ['進入', '任務建立（手動、eService／Odoo 同步）'],
      ['做什麼', '判斷要不要先走客服分流'],
      ['往下', '需釐清 → 客服處理；否則直接進分析']
    ]
  });
  push({
    id: 'cs', track: 'task', step: 1, kind: 'agent', label: '客服處理',
    status: 'cs_running', agent: 'cs',
    detail: [
      ['進入', '來源單需要先判斷問題性質'],
      ['做什麼', '自選來源（wiki／code／log／正式區 DB）查出初步定因，三分類'],
      ['往下', '判 code_change_clear → 分析（cs_findings 一併帶下去，標「待驗證」）'],
      ['分支', '判 operation → 等待確認回覆；判 code_change_vague → 需補資料']
    ]
  });
  push({
    id: 'csdata', track: 'human', step: 1, kind: 'gate', label: '需補資料',
    status: 'cs_data_needed',
    detail: [
      ['進入', '客服判定要改程式，但需求還不夠清楚'],
      ['做什麼', '把問題丟給使用者補答'],
      ['往下', '補完 → 回客服關重跑（帶著先前所有回答，避免重複問）']
    ]
  });
  push({
    id: 'csreply', track: 'human', step: 2, kind: 'gate', label: '等待確認回覆',
    status: 'cs_reply_pending',
    detail: [
      ['進入', '客服判定這是操作問題、不需改程式，已寫好回覆草稿'],
      ['做什麼', '人看過草稿：確認送出、或追問要它改寫'],
      ['往下', '確認 → 直接結案（不經開發與 Wiki）'],
      ['分支', '追問 → 回客服關重跑，依「原問題＋前一版草稿＋這次追問」重判']
    ]
  });
  push({
    id: 'csdone', track: 'human', step: 3, kind: 'end', label: '結案',
    status: 'done',
    detail: [
      ['說明', '與主線最底的「完成」是同一個狀態，畫兩次只是避免拉一條貫穿全圖的線'],
      ['注意', '客服路徑不產生任何程式碼，也不進 Git 泳道']
    ]
  });
  push({
    id: 'analysis', track: 'task', step: 4, kind: 'agent', label: '分析',
    status: 'analysis_running', agent: 'analysis-project',
    detail: [
      ['進入', '待分類直接進，或客服判定需要改程式'],
      ['做什麼', '讀專案碼產出 analysis.yaml（含 acceptance 與 permissions）'],
      ['往下', 'determineNextStatus 三選一：夠有信心 → 建立分支；有問題要問 → 等待確認；要人看過 → 等待規格確認'],
      ['注意', '澄清答完會「完整重跑」這一關，不是接著上次跑']
    ]
  });
  push({
    id: 'confirm', track: 'human', step: 4, kind: 'gate', label: '等待確認',
    status: 'confirm_pending',
    detail: [
      ['進入', '分析 agent 自己提了待答問題，或信心不足'],
      ['做什麼', '把問題丟給人回答；使用者也可以在這裡反問（跑 clarify-chat）'],
      ['往下', '答完 → 回分析關完整重跑（規格會整份重產）'],
      ['注意', '與「待你裁決」共用同一支對話 agent，但推進與否由 mode 在結構上限定']
    ]
  });
  push({
    id: 'specreview', track: 'human', step: 5, kind: 'gate', label: '等待規格確認',
    status: 'spec_review',
    detail: [
      ['進入', '規格需人工過目才開工'],
      ['做什麼', '人看規格：核准、或提修改意見'],
      ['往下', '核准 → 建立分支（**不重跑分析**）'],
      ['分支', '提意見 → spec-review agent 就地改 analysis.yaml，不重入分析關']
    ]
  });
  push({
    id: 'branch', track: 'task', step: 6, kind: 'sys', label: '建立分支',
    status: 'branch_pending',
    detail: [
      ['進入', '規格已定稿（上面三條路的共同出口）'],
      ['做什麼', '每個 repo 建任務 worktree（切點 ai-dev）並跟上最新 ai-dev'],
      ['往下', specTour ? '先寫 E2E 考題 → 開發' : '開發'],
      ['注意', '持專案鎖，與 merge／deploy／analysis 序列化']
    ]
  });

  if (specTour) {
    push({
      id: 'spectour', track: 'task', step: 7, kind: 'inline', label: '先寫 E2E 考題',
      ref: '（不是獨立狀態）', agent: 'playwright-spec',
      detail: [
        ['注意', '**這不是一關**——沒有對應的任務狀態，任務不會停在這裡。它是建立分支關內部的一步（runSpecTourGate），只在記帳上獨立成 spec_tour'],
        ['進入', '規格 tour 模式開啟，且任務剛進入建立分支'],
        ['做什麼', '依定稿的 acceptance 先寫 Odoo tour（實作之前定稿），無狀態、不續接分析 session'],
        ['失敗', 'best-effort：產不出來不擋推進，但會在時間軸留下原因，E2E 關屆時自行產生']
      ]
    });
  }

  push({
    id: 'coding', track: 'task', step: 8, kind: 'agent', label: '開發',
    status: 'coding_running', agent: 'coding-project',
    detail: [
      ['進入', '分支建好，或被 QA／部署' + (e2eEnabled ? '／E2E' : '') + '／分診／裁決退回'],
      ['做什麼', '無狀態：每輪 fresh 重送規格，讀 worktree 既有碼做增量修'],
      ['往下', 'QA 審查'],
      ['守衛', '帶著失敗回饋卻一個 commit 都沒產生 → 直接停下（放行只會重現同一個失敗）'],
      specTour
        ? ['本模式', 'worktree 內已有 tour＝驗收標準；考題寫錯要指出，不得逕自改測試檔']
        : ['注意', 'retry_feedback（上一輪失敗訊息）會餵進 prompt，推進成功才消費']
    ]
  });
  push({
    id: 'qa', track: 'task', step: 9, kind: 'agent', label: 'QA 審查',
    status: 'qa_running', agent: 'qa',
    detail: [
      ['進入', '開發完成'],
      ['做什麼', '對照 analysis.yaml 審查 diff（基底是 ai-dev，不是 main）'],
      ['往下', 'pass → 併入測試；整組計數器歸零並寫下未解清單的分界'],
      ['失敗', 'fail → 退開發，qa_retry_count+1，滿 5 次停下'],
      ['分支', '判規格歧義 → 待你裁決（同一輪最多裁決 2 次，再問下去就停）'],
      ['熔斷', '自上輪 QA 後分支沒有新 commit → 判僵局，停下交人工']
    ]
  });
  push({
    id: 'clarify', track: 'human', step: 9, kind: 'gate', label: '待你裁決',
    status: 'clarify_pending',
    detail: [
      ['進入', '**所有「停下來問人」的統一閘門**（enterClarifyGate）：QA 判規格歧義、分診判退回原因含糊都走這裡'],
      ['做什麼', '批次列出全部疑點供一次回答；使用者也可以反問，由 clarify-chat 判 answer／proceed／revise'],
      ['往下', '答完 → 依 resume_status 導回原關（QA 來的回開發、分診來的回分診）'],
      ['注意', '不加該關的失敗計數——這不是自動失敗輪。進閘門會清掉舊 session，每次都是全新對話']
    ]
  });
  push({
    id: 'respec', track: 'aside', step: 7, kind: 'agent', label: '規格層重做',
    status: 'respec_running', agent: 'respec-patch',
    detail: [
      ['進入', '途中追加需求，或分診判定要動規格'],
      ['做什麼', '增量 patch 進 analysis.yaml（不重讀整包碼），維持單一規格來源'],
      ['往下', '開發（需求同時寫進 retry_feedback，coding 每輪都讀）']
    ]
  });
  push({
    id: 'triage', track: 'aside', step: 8, kind: 'agent', label: '分診',
    status: 'reject_triage / resolve_triage', agent: 'analysis-reject',
    detail: [
      ['進入', '**兩個入口**：reject_triage＝人工審核退回；resolve_triage＝任務停下後人填了修正指示'],
      ['做什麼', '把原因拆成獨立錯誤項並分類，讀 diff／log 決定往哪走'],
      ['往下', 'fix → 開發（帶著分診結論）／resume → 回原關／advance → 放行推進／respec → 規格層重做'],
      ['分支', '判退回原因太含糊 → 待你裁決，答完回到本關'],
      ['注意', '這一關刻意不吃彈跳額度——每一輪都是人主動退回換來的，帶著新資訊']
    ]
  });
  push({
    id: 'stopped', track: 'human', step: 12, kind: 'stop', label: '失敗待確認',
    status: 'stopped',
    detail: [
      ['進入', '任一關觸頂、環境錯誤、或 agent 沒吐出有效結果'],
      ['做什麼', '停下等人工，blocker_content 說明原因'],
      ['往下', '人工填修正指示 → 轉 resolve_triage 交分診決定下一步（不會盲目續跑原關）'],
      ['彈跳上限', '跨關總彈跳 MAX_REENTRY=2，跌倒即停不硬撐']
    ]
  });
  push({
    id: 'merge', track: 'task', step: 13, kind: 'sys', label: '併入測試',
    status: 'merge_running',
    detail: [
      ['進入', 'QA 通過'],
      ['做什麼', '把任務分支併進 testing（測試區 addons 來源）'],
      ['往下', '部署測試區'],
      ['分支', '撞衝突 → 合併衝突（全程停在該狀態，不退回重做）']
    ]
  });
  push({
    id: 'conflict', track: 'human', step: 13, kind: 'gate', label: '合併衝突',
    status: 'merge_conflict',
    detail: [
      ['進入', '併入 testing 時兩段碼撞同幾行'],
      ['做什麼', 'merge → merge-explain → merge-clarify 三支各司其職，人做最後裁決'],
      ['往下', '解完 → 部署測試區'],
      ['注意', '流程刻意不分叉：退回重做不會消除衝突，所以全程停在這個狀態']
    ]
  });
  push({
    id: 'deploy', track: 'task', step: 14, kind: 'sys', label: '部署測試區',
    status: 'deploy_testing',
    detail: [
      ['進入', '已併入 testing'],
      ['做什麼', '在測試區安裝／升級模組——語法錯、invalid field、view 繼承錯、缺 depends 都在這裡把關'],
      ['往下', e2eEnabled ? 'E2E 測試' : '等待審核（E2E 已停用）'],
      ['失敗', '判 code → 退開發，deploy_retry_count+1，滿 3 次停下；判 env → 直接停下不退開發'],
      ['診斷', 'asset 編不出來時附上容器 log 尾端的真 traceback 給開發關']
    ]
  });

  if (e2eEnabled) {
    push({
      id: 'e2e', track: 'task', step: 15, kind: 'agent', label: 'E2E 測試',
      status: 'playwright_running', agent: specTour ? '（不產生，只執行）' : 'playwright',
      detail: [
        ['進入', '部署成功，且專案未停用 E2E'],
        ['做什麼', specTour
          ? '不重產 tour（重產等於照著完成的實作重寫考題），併入 testing 後直接跑 odoo-bin --test-enable'
          : '產生 tour 測試檔 → 併入 testing → 跑 odoo-bin --test-enable'],
        ['往下', '通過 → 等待審核'],
        ['失敗', '退開發，pw_retry_count+1，滿 3 次停下'],
        ['防假綠燈', 'log 內沒有 odoo.tests 命名空間＝匹配 0 個測試，一律當失敗'],
        specTour
          ? ['守衛', '模式開著但 worktree 內查無 tour 檔 → 降級由本關自行產生，並在時間軸留下原因']
          : ['注意', 'tour 是照著已完成的實作寫的，測試容易遷就實作']
      ]
    });
  }

  push({
    id: 'review', track: 'human', step: 16, kind: 'gate', label: '等待審核',
    status: 'review_pending',
    detail: [
      ['進入', 'E2E 通過，或 E2E 已停用時部署成功即到'],
      ['做什麼', '人工驗收「有沒有做到真正想要的事」——這是驗真意的最終防線'],
      ['往下', '核准 → 併進 ai-dev → 更新 Wiki → 完成'],
      ['分支', '退回 → 分診'],
      ['注意', '核准只是「排進待上正式」，東西還在測試區——真正上線要另外按「🚀 上正式」']
    ]
  });
  push({
    id: 'wiki', track: 'task', step: 17, kind: 'agent', label: '更新 Wiki',
    status: 'wiki_updating', agent: 'library',
    detail: [
      ['進入', '人工審核核准、且已併進 ai-dev'],
      ['做什麼', '產出／更新功能頁，必要時往上補模組頁與總覽'],
      ['往下', '完成']
    ]
  });
  push({
    id: 'done', track: 'task', step: 18, kind: 'end', label: '完成',
    status: 'done',
    detail: [
      ['進入', 'Wiki 更新完畢'],
      ['做什麼', '任務結案，成果留在 ai-dev'],
      ['往下', '等待專案層的「🚀 上正式」才會進正式區——完成 ≠ 上線']
    ]
  });
  push({
    id: 'release', track: 'human', step: 19, kind: 'gate', label: '🚀 上正式',
    ref: '（專案層動作，非任務狀態）',
    detail: [
      ['進入', '任務已核准併進 ai-dev（待上正式＝已核准但尚未推上 main 的任務）'],
      ['做什麼', '在**專案頁**按「🚀 上正式」，確認清單後整條 ai-dev 一起併進 main'],
      ['粒度', '**專案層級、批次**——一次把所有待上正式的任務一起上線，不是一張一張'],
      ['注意', '這是最多人誤會的一步：審核通過只是排進清單，不按這顆按鈕東西不會進正式區']
    ]
  });

  // ── Git 泳道（與左邊對應的任務關同一 step 對齊）─────────
  push({
    id: 'gitwt', track: 'git', step: 6, kind: 'git', label: '建 worktree',
    ref: 'task/<taskId>',
    detail: [
      ['對應', '建立分支這一關'],
      ['做什麼', '每個 repo 開一個 worktree，分支名 task/<taskId>'],
      ['切點', '**ai-dev**，不是 main——AI 的成果全部長在 ai-dev 這條線上'],
      ['注意', '建完會先跟上最新的 ai-dev，避免基底落後']
    ]
  });
  push({
    id: 'gitcommit', track: 'git', step: 8, kind: 'git', label: '產生 commit',
    ref: 'task/<taskId>',
    detail: [
      ['對應', '開發這一關'],
      ['做什麼', '改動 commit 進任務分支，每輪重試都是接著加 commit'],
      ['守衛', '帶著失敗回饋卻零 commit＝僵局，開發關會直接停下'],
      ['隔離', '各任務各自 worktree，所以開發／QA 可以跨任務平行不持鎖']
    ]
  });
  push({
    id: 'gittesting', track: 'git', step: 13, kind: 'git', label: '併入 testing',
    ref: 'testing',
    detail: [
      ['對應', '併入測試這一關'],
      ['做什麼', 'mergeInto(testing, task/<taskId>)——testing 是測試區 addons 的來源分支'],
      e2eEnabled && ['再一次', 'E2E 產出的 tour 檔會再併一次 testing'],
      ['獨佔', 'merge → deploy' + (e2eEnabled ? ' → E2E' : '') + ' 這條尾巴每專案獨佔：別的任務中途併進 testing 會打破一致性，讓正確的碼被判失敗']
    ]
  });
  push({
    id: 'gitaidev', track: 'git', step: 16, kind: 'git', label: '併入 ai-dev',
    ref: 'ai-dev',
    detail: [
      ['對應', '等待審核關的「核准」'],
      ['做什麼', 'mergeToAiBranch 把任務分支併進 ai-dev 並推遠端，接著刪掉本機分支與 worktree'],
      ['隔離', 'AI 只推 ai-dev，永遠不直接推 main'],
      ['注意', '此時只寫 approved_at；released_at 要等上正式才寫，兩者的差集＝待上正式']
    ]
  });
  push({
    id: 'gitmain', track: 'git', step: 19, kind: 'git', label: 'main + push',
    ref: 'main',
    detail: [
      ['對應', '專案頁的「🚀 上正式」'],
      ['做什麼', 'releaseAiToMain：把整條 ai-dev 併進 main 並 push，寫入 released_at'],
      ['失敗', 'main 有平台以外的改動時會撞衝突，此時要改到 GitHub 手動處理']
    ]
  });
  push({
    id: 'gitgh', track: 'git', step: 20, kind: 'ext', label: 'GitHub 手動合併',
    ref: '（平台外）',
    detail: [
      ['進入', '上正式撞衝突，或有人直接在 GitHub 上操作'],
      ['硬規則', '**只能用一般 merge，禁用 Squash**——squash 產生血緣無關的 commit，下次 main 回同步進 ai-dev 時每個檔案都衝突'],
      ['代價', '手動合併不會寫入 released_at，平台的「待上正式」數字會失準'],
      ['注意', '這條規則沒有任何 UI 或文件擋著，只能靠人記得——這張圖是目前唯一寫下它的地方']
    ]
  });

  return n;
}

// 連線：[from, to, 類型]。main＝主線／alt＝條件分支／back＝退回失敗／link＝Git 對應（不是流程轉移）
function pipelineEdges(flags) {
  const e = [
    ['new', 'cs', 'alt'], ['new', 'analysis', 'main'], ['cs', 'analysis', 'main'],
    ['cs', 'csdata', 'alt'], ['csdata', 'cs', 'back'],
    ['cs', 'csreply', 'alt'], ['csreply', 'cs', 'back'], ['csreply', 'csdone', 'main'],
    ['analysis', 'confirm', 'alt'], ['analysis', 'specreview', 'alt'], ['analysis', 'branch', 'main'],
    ['confirm', 'analysis', 'back'], ['specreview', 'branch', 'main'],
    ['coding', 'qa', 'main'], ['qa', 'merge', 'main'], ['qa', 'coding', 'back'],
    ['qa', 'clarify', 'alt'], ['clarify', 'coding', 'back'],
    ['qa', 'stopped', 'back'],
    ['merge', 'deploy', 'main'], ['merge', 'conflict', 'alt'], ['conflict', 'deploy', 'main'],
    ['deploy', 'coding', 'back'], ['deploy', 'stopped', 'back'],
    ['review', 'triage', 'back'], ['stopped', 'triage', 'back'],
    ['triage', 'coding', 'back'], ['triage', 'respec', 'back'], ['triage', 'clarify', 'alt'],
    ['clarify', 'triage', 'back'],
    ['respec', 'coding', 'main'],
    ['review', 'wiki', 'main'], ['wiki', 'done', 'main'], ['done', 'release', 'alt']
  ];
  if (flags.specTour) { e.push(['branch', 'spectour', 'main'], ['spectour', 'coding', 'main']); }
  else { e.push(['branch', 'coding', 'main']); }
  if (flags.e2eEnabled) { e.push(['deploy', 'e2e', 'main'], ['e2e', 'review', 'main'], ['e2e', 'coding', 'back']); }
  else { e.push(['deploy', 'review', 'main']); }
  if (flags.showGit) {
    e.push(
      ['gitwt', 'gitcommit', 'main'], ['gitcommit', 'gittesting', 'main'],
      ['gittesting', 'gitaidev', 'main'], ['gitaidev', 'gitmain', 'main'],
      ['gitmain', 'gitgh', 'alt'],
      // 橫向對應：這一關在 Git 上做了什麼
      ['gitwt', 'branch', 'link'], ['gitcommit', 'coding', 'link'],
      ['gittesting', 'merge', 'link'], ['gitaidev', 'review', 'link'],
      ['gitmain', 'release', 'link'],
      // 併入 testing 這格會被踩兩次：併入測試關一次，E2E 產出 tour 檔後再一次。
      // 只畫前者的話，圖上看不出 E2E 也會動到 testing 分支（兩端都在時才留，見下方 filter）。
      ['gittesting', 'e2e', 'link']
    );
  }
  // 兩端都存在的線才留（關掉 E2E／Git 時對應的線一併消失）
  const ids = new Set(pipelineNodes(flags).map((n) => n.id));
  return e.filter(([a, b]) => ids.has(a) && ids.has(b));
}

const PF_API = { PF_TRACKS, PF_UNDRAWN_STATUSES, pipelineTracks, pipelineNodes, pipelineEdges };
if (typeof window !== 'undefined') Object.assign(window, PF_API);
if (typeof module !== 'undefined') module.exports = PF_API;
