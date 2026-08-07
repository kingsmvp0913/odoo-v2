// Pipeline 流程圖：把整條任務流程畫成直立泳道圖，滑鼠移上去打亮該節點並帶出它的邏輯摘要。
//
// 泳道＝「誰在動作」（Git／任務流程／人工），不是「好事壞事」——語意分類改由框線顏色承載。
// 這樣未來要接 eService、Teams 只需在 TRACKS 加一筆、節點帶對應的 track，版面自己排。
//
// 開關是**頁面自帶的推演工具**，不讀也不寫任何專案設定——這頁的用途是「這樣設定會跑成怎樣」的
// 對焦與討論，不是某個專案的現況面板。要看某專案實際設定請去專案頁。
//
// ── 連線的三條原則（驗收標準，改版面時照這個判）──────────────
// 1. 線從方塊**中間**接出去；同一側多條就稍微間隔，不要貼到角落。
// 2. 不要多餘的交叉。
// 3. 不要亂彎。會交叉或塞不下時，換一個**最近的方向**接接看（上下緣也是方向），
//    而不是繞遠路硬走原方向。
//
// 這三條是人看圖的判準，量化指標只是輔助。踩過的坑：只驗「線有沒有重疊」與「線有沒有穿過
// 方塊」，兩項都 0 就回報做好了——但交叉一次都沒量過，畫面上滿是打叉的線。下面那段掃描
// 三種都會算，改完請三種都看。
//
// ── 改完怎麼驗 ──────────────────────────────────────────
// 肉眼看不全（改一處、另一處才浮出來，來回好幾輪）。jest 也測不到——路徑是 Vue 算出來的，
// 要有瀏覽器。開 DevTools Console 貼下面這段，**逐一切換三個開關各跑一次**：
//
//   const S=document.querySelector('.page-body svg');
//   const seg=d=>{const t=d.trim().split(/\s+/);let x=0,y=0,i=0,o=[];while(i<t.length){const c=t[i];
//     if(c==='M'){x=+t[i+1];y=+t[i+2];i+=3}else if(c==='H'){const n=+t[i+1];o.push({t:'h',y,a:Math.min(x,n),b:Math.max(x,n)});x=n;i+=2}
//     else if(c==='V'){const n=+t[i+1];o.push({t:'v',x,a:Math.min(y,n),b:Math.max(y,n)});y=n;i+=2}else i++}return o};
//   const A=[],N=[...S.querySelectorAll('g')].filter(g=>g.querySelector('rect')).map(g=>{const r=g.querySelector('rect');
//     return{x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height'),l:g.querySelector('text').textContent}});
//   [...S.querySelectorAll('g > path')].forEach((p,k)=>{const d=p.getAttribute('d')||'';
//     if(d.startsWith('M'))seg(d).forEach(s=>A.push({...s,k,e:p.dataset.edge||'bus'}))});
//   const ov=[],cr=[],th=[],near=[];
//   for(let i=0;i<A.length;i++)for(let j=i+1;j<A.length;j++){const a=A[i],b=A[j];if(a.k===b.k)continue;
//     if(a.t===b.t){const g=a.t==='h'?Math.abs(a.y-b.y):Math.abs(a.x-b.x);
//       const L=Math.min(a.b,b.b)-Math.max(a.a,b.a);
//       if(g<3){if(L>8)ov.push(a.e+' ∥ '+b.e+' ('+Math.round(L)+'px)')}
//       else if(g<12&&L>60)near.push(a.e+' ≈ '+b.e+' (間距'+Math.round(g)+'px, 並行'+Math.round(L)+'px)');continue}
//     const[h,v]=a.t==='h'?[a,b]:[b,a];
//     if(v.x>h.a+2&&v.x<h.b-2&&h.y>v.a+2&&h.y<v.b-2)cr.push(h.e+' × '+v.e)}
//   for(const s of A)for(const n of N){const p=3;
//     if(s.t==='h'){if(s.y<=n.y+p||s.y>=n.y+n.h-p)continue;if(Math.min(s.b,n.x+n.w)-Math.max(s.a,n.x)>12)th.push(s.e+' → '+n.l)}
//     else{if(s.x<=n.x+p||s.x>=n.x+n.w-p)continue;if(Math.min(s.b,n.y+n.h)-Math.max(s.a,n.y)>12)th.push(s.e+' → '+n.l)}}
//   const tight=[...S.querySelectorAll('g')].filter(g=>g.querySelectorAll('text').length>1).map(g=>{
//     const r=g.querySelector('rect'),b=g.querySelectorAll('text')[1].getBBox();if(!r)return null;
//     return g.querySelector('text').textContent+' 留白'+Math.round(Math.min(b.x-+r.getAttribute('x'),
//       +r.getAttribute('x')+ +r.getAttribute('width')-(b.x+b.width)))+'px'}).filter(t=>t&&+t.match(/(-?\d+)px/)[1]<18);
//   const HH=A.filter(s=>s.t==='h');
//   console.log({交叉:cr.length,重疊:ov.length,貼線:near.length,穿過方塊:th.length,字貼框:tight.length,
//     長線:HH.filter(s=>s.b-s.a>=250).length,總長:Math.round(A.reduce((n,s)=>n+s.b-s.a,0))},{cr,ov,near,th,tight});
//
// 量測前先把 hover 清掉：`[...S.querySelectorAll('g')].forEach(g=>g.dispatchEvent(new MouseEvent('mouseleave')))`。
// 滑鼠指標只要停在圖上，切開關重繪時瀏覽器就會補發 mouseenter，打亮的主幹被算成額外線段——
// 實際踩過：同一個版面量出 重疊 1／總長 9877，清掉 hover 後其實是 重疊 0／總長 9635。
//
// 每條線上有 data-edge（形如 `qa>stopped`），所以上面印出的是**哪兩條線**出事，不是一堆座標。
// 這很重要：這頁的路由規則彼此牽動，改 A 常常連帶動到 B，只看總數會以為「數字變好了」而
// 漏掉另一處壞掉。改完務必比對清單內容，不是只比數字。
// 重疊門檻取 8px（不是 20）：客服處理↔需補資料 曾經疊成一個 13px 的 Z 字，用 20px 完全測不到。
//
// 重疊、貼線、穿過方塊、字貼框期望恆為 0。交叉不可能歸零（匯流排接頭跨主線是拓樸必然）。
//
// 「貼線」與「字貼框」是後來補的，補的理由都一樣：**掃描只驗得到我想得到的失敗方式**。
//   貼線——重疊門檻 3px，兩條線相距 6.5px 並行 164px 完全測不到，畫面上卻是一條粗雙線
//     （關掉 E2E 後 部署測試區→等待審核 就這樣夾在另外兩條之間）。
//   字貼框——狀態名壓寬到只離框緣 9px，而線正好接在框緣，看起來就是字壓在線上（分診那格）。
// 兩個都是使用者用肉眼指出來、而當下所有指標都是 0 的時候。加新規則前先想：這次的問題，
// 現有的哪一項**應該**要抓到卻沒抓到？
//
// **不要只看交叉數**。實際踩過：為「失敗待確認」立匯流排讓交叉 6→5，看起來是進步，但兩條
// 接頭因此變成 340px 的橫跨線，畫面明顯更亂。改版面後至少要一起看這三個：
//   交叉數、250px 以上的長橫線條數、所有線段的總長度。
// 後兩個接在上面那段之後量：
//   const HH=A.filter(s=>s.t==='h');
//   console.log({長線:HH.filter(s=>s.b-s.a>=250).length, 總長:Math.round(A.reduce((n,s)=>n+s.b-s.a,0))});
//
// 內容以程式碼為準（截至 2026-08-07）：狀態名對齊 status-labels.js（由 pipeline-flow.test.js 守住），
// 上限值對齊各關的常數（QA_LIMIT=5、DEPLOY_LIMIT=3、PW_LIMIT=3、MAX_REENTRY=2、QA_SPEC_LIMIT=2）。
// 改了那些常數或流程請一併更新這裡——這頁是拿來對焦的，講錯比沒有更糟。

// 泳道定義。順序＝由左到右；沒有 flag 的一律顯示，有 flag 的由對應的 data 開關控制。
// 擴充：加一條泳道就是加一筆（例：{ id: 'eservice', label: 'eService', flag: 'showEservice',
// toggleLabel: '顯示 eService' }），再讓節點帶 track: 'eservice' 即可，layout 與開關列會自動跟上。
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

// 匯流排：好幾條線指向同一個匯聚點時，合併成一條主幹＋各關的短接頭。
// 圖上有兩個這種匯聚點，而且都是「多對一」：跌倒了回開發重做、停下來了回分診判斷。
// 各畫各的話，光這兩處就有九條長線要穿越大半張圖，是整張圖最大的噪音來源。
// side＝主幹擺在目標節點的哪一側（開發在任務泳道，往左；分診在最右泳道，只能往右）。
// 擺法是**枚舉量出來的**，不是挑順眼的。開發放右側 → 交叉 10 ＋2 個重疊；分診放側邊 → 接頭
// 得先橫到它旁邊，跟它送出去的線打叉。
//
// 「失敗待確認」刻意**不立**匯流排，雖然那樣交叉會少 1（6→5）：它的兩條來源都在任務主線，
// 主幹卻只能擺到人工介入泳道旁，兩條接頭因此各變成 340px 的橫跨線，250px+ 長線 5→7、
// 總線長 +534px。**交叉數不是唯一指標**——只看它就會選到這種「數字漂亮、看起來更亂」的解。
//
// exclude 各有理由：branch／spectour 是主線入口不是退回；分診與開發同一列、規格層重做只差
// 一列，直接連過去就好——併進匯流排反而要先往下繞到間隙、再橫 364px 過來（原則 3：不要亂彎）。
const PF_BUSES = [
  // 開發的匯流排放**左側**：右邊已經擠了規格層重做、分診來的線；左邊只有 Git 對應線。
  // 待你裁決只在開發的下一列，從自己頂部往上、往左就接到了——併進匯流排反而要先往下繞到
  // 間隙、再橫 372px 到左側，沿路穿過主線與 QA→失敗待確認（原則 3：能直連就別繞）。
  { target: 'coding', side: 'left', exclude: ['branch', 'spectour', 'respec', 'triage', 'clarify'] },
  // 分診的走**正下方**：匯入它的三關全在它下面，從側邊進來的話那三條接頭得先橫到分診旁邊，
  // 正好和分診送出去的線打叉。
  { target: 'triage', side: 'bottom', exclude: [] }
];

// kind → 框線顏色。泳道讓出了語意軸之後，「這是什麼性質的關」全靠這裡表達。
const PF_KIND_COLOR = {
  start:  'var(--success)',
  end:    'var(--success)',
  agent:  'var(--primary)',
  // 不用 --border-strong：它是給「分隔線」用的，當框線在兩種主題下都淡到看不出有框，
  // 而系統自動關卡（建分支／併入測試／部署）是主線的一部分，不該看起來像被停用。
  sys:    'var(--text-muted)',
  gate:   'var(--warning)',
  stop:   'var(--danger)',
  git:    'var(--info)',
  inline: 'var(--primary)',
  ext:    'var(--text-muted)'
};

window.PipelineFlowView = Vue.defineComponent({
  name: 'PipelineFlowView',
  data() {
    return {
      // 兩個開關的預設值都對齊「新專案剛建好時的實際樣子」：e2e_disabled 預設停用、
      // spec_tour_enabled 預設 false。這頁一打開看到的就該是多數專案真正在跑的流程，
      // 要看開啟後長怎樣再自己撥開關。
      e2eEnabled: false,     // 專案層 e2e_disabled 的反面
      specTour: false,       // 專案層 spec_tour_enabled
      showGit: true,         // 純顯示開關，與專案設定無關
      hovered: null
    };
  },
  computed: {
    tracks() { return PF_TRACKS.filter(t => !t.flag || this[t.flag]); },
    trackToggles() { return PF_TRACKS.filter(t => t.flag); },

    // 節點定義。track＝泳道，step＝由上而下的垂直序（同一泳道內不得重複）。
    // detail 是「進入條件／做什麼／成功往哪／失敗往哪」。
    //
    // status 與 ref 刻意分兩個欄位：status 只放**真的任務狀態**（pipeline-flow.test.js 逐一比對
    // STATUS_LABELS），Git 分支名與「不是狀態」的說明一律放 ref。混用一個欄位的話，測試無從分辨
    // 'testing'（分支名）與 'cs_running'（狀態），也就擋不住把不存在的狀態畫成一關——那正是這次
    // 修掉的 spec_tour。
    nodes() {
      const n = [];
      const push = (o) => { if (this.tracks.some(t => t.id === o.track)) n.push(o); };

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
          ['往下', this.specTour ? '先寫 E2E 考題 → 開發' : '開發'],
          ['注意', '持專案鎖，與 merge／deploy／analysis 序列化']
        ]
      });

      if (this.specTour) {
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
          ['進入', '分支建好，或被 QA／部署' + (this.e2eEnabled ? '／E2E' : '') + '／分診／裁決退回'],
          ['做什麼', '無狀態：每輪 fresh 重送規格，讀 worktree 既有碼做增量修'],
          ['往下', 'QA 審查'],
          ['守衛', '帶著失敗回饋卻一個 commit 都沒產生 → 直接停下（放行只會重現同一個失敗）'],
          this.specTour
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
          ['往下', this.e2eEnabled ? 'E2E 測試' : '等待審核（E2E 已停用）'],
          ['失敗', '判 code → 退開發，deploy_retry_count+1，滿 3 次停下；判 env → 直接停下不退開發'],
          ['診斷', 'asset 編不出來時附上容器 log 尾端的真 traceback 給開發關']
        ]
      });

      if (this.e2eEnabled) {
        push({
          id: 'e2e', track: 'task', step: 15, kind: 'agent', label: 'E2E 測試',
          status: 'playwright_running', agent: this.specTour ? '（不產生，只執行）' : 'playwright',
          detail: [
            ['進入', '部署成功，且專案未停用 E2E'],
            ['做什麼', this.specTour
              ? '不重產 tour（重產等於照著完成的實作重寫考題），併入 testing 後直接跑 odoo-bin --test-enable'
              : '產生 tour 測試檔 → 併入 testing → 跑 odoo-bin --test-enable'],
            ['往下', '通過 → 等待審核'],
            ['失敗', '退開發，pw_retry_count+1，滿 3 次停下'],
            ['防假綠燈', 'log 內沒有 odoo.tests 命名空間＝匹配 0 個測試，一律當失敗'],
            this.specTour
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
          this.e2eEnabled && ['再一次', 'E2E 產出的 tour 檔會再併一次 testing'],
          ['獨佔', 'merge → deploy' + (this.e2eEnabled ? ' → E2E' : '') + ' 這條尾巴每專案獨佔：別的任務中途併進 testing 會打破一致性，讓正確的碼被判失敗']
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

      // 收合完全空的列。step 是手寫的，節點搬家後（例如分診／規格層重做移到旁支泳道）
      // 原本佔的那幾列就空著，圖上留一大塊空白。這裡按實際用到的列重新編號，
      // 空列自動消失——不必每次搬完節點再手動把後面的 step 全部往上挪一次。
      const usedSteps = [...new Set(n.map((x) => x.step))].sort((p, q) => p - q);
      const remap = {};
      usedSteps.forEach((s, i) => { remap[s] = i; });
      return n.map((x) => ({ ...x, step: remap[x.step] }));
    },

    // 連線：[from, to, 類型]。main＝主線實線／alt＝條件分支／back＝退回失敗／link＝Git 對應（細虛線無箭頭）
    edges() {
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
      if (this.specTour) { e.push(['branch', 'spectour', 'main'], ['spectour', 'coding', 'main']); }
      else { e.push(['branch', 'coding', 'main']); }
      if (this.e2eEnabled) { e.push(['deploy', 'e2e', 'main'], ['e2e', 'review', 'main'], ['e2e', 'coding', 'back']); }
      else { e.push(['deploy', 'review', 'main']); }
      if (this.showGit) {
        e.push(
          ['gitwt', 'gitcommit', 'main'], ['gitcommit', 'gittesting', 'main'],
          ['gittesting', 'gitaidev', 'main'], ['gitaidev', 'gitmain', 'main'],
          ['gitmain', 'gitgh', 'alt'],
          // 橫向對應：這一關在 Git 上做了什麼
          ['gitwt', 'branch', 'link'], ['gitcommit', 'coding', 'link'],
          ['gittesting', 'merge', 'link'], ['gitaidev', 'review', 'link'],
          ['gitmain', 'release', 'link']
        );
      }
      // 兩端都存在的線才畫（關掉 E2E／Git 時對應的線一併消失）
      const ids = new Set(this.nodes.map(n => n.id));
      return e.filter(([a, b]) => ids.has(a) && ids.has(b));
    },

    nodeById() { return Object.fromEntries(this.nodes.map(n => [n.id, n])); },

    // 版面：泳道等寬由左至右，step 等距由上至下。SVG 尺寸由節點數推導。
    layout() {
      const LANE = 240, STEP = 112, W = 152, H = 54;
      // 走廊寬度＝LANE-W＝88，垂直間隙＝STEP-H＝58：兩者都要容得下好幾條線並排。
      // 早期版本各取 34／32，結果是跨泳道的線全擠進同一條走廊，疊成一條看不出起訖的長線。
      // 左側 PAD_X 要留給退回匯流排（見 busX），右側 SIDE 留給最右泳道往右的繞行線。
      // SIDE 要容得下最外側那一軌繞行線：最右泳道的退回線往右繞，重疊越多讓出的軌道越外面
      // （目前最多 4 軌＝節點中心右方 152px）。留不夠不會報錯，只會把線裁掉一截。
      // SIDE 要容得下最外側那一軌：分診匯流排停在最外泳道外緣 +40，繞外側的線從 +56 起算、
      // 每多讓一軌再 +22。留不夠不會報錯，只會把線裁掉一截。
      const PAD_X = 64, PAD_TOP = 34, SIDE = 100, BOTTOM = 24;
      const laneX = {};
      this.tracks.forEach((t, i) => { laneX[t.id] = PAD_X + i * LANE; });
      const pos = {};
      for (const n of this.nodes) {
        pos[n.id] = { x: laneX[n.track], y: PAD_TOP + n.step * STEP, w: W, h: H };
      }
      const maxStep = Math.max(...this.nodes.map(n => n.step));
      return {
        pos, laneX,
        w: PAD_X + (this.tracks.length - 1) * LANE + W + SIDE,
        h: PAD_TOP + maxStep * STEP + H + BOTTOM,
        W, H, STEP, PAD_TOP, GAP: LANE - W
      };
    },

    // 一個關的某一側若已經被「同列的橫線」佔住，同方向再往下的線就別跟它擠——改從**底部**
    // 出發（inner），貼著自己泳道往下，到目標高度才橫出去；回程走更靠內一點往上（innerBack）。
    // 這就是原則 3「會擠就換最近的方向」，圖上有兩處是這個形狀：
    //   客服處理 → 需補資料（同列橫線，佔住右側）＋ → 等待確認回覆（改走底部）
    //   分診    → 開發    （同列橫線，佔住左側）＋ → 待你裁決      （改走底部）
    branchRoutes() {
      const out = {};
      const sideOf = (from, to) => (this.layout.pos[to].x > this.layout.pos[from].x ? 'R' : 'L');
      for (const [a, b] of this.edges) {
        const na = this.nodeById[a], nb = this.nodeById[b];
        if (!na || !nb || na.track === nb.track) continue;
        if (nb.step <= na.step) continue;                  // 只看往下的
        if (this.busSourceMap[a + '>' + b]) continue;      // 匯流排接頭另有走法
        const dir = sideOf(a, b);
        // 同一個關、同一側、同一列的橫線＝那一側已經被佔住
        const sideTaken = this.edges.some(([x, y]) => {
          const ny = this.nodeById[y];
          return x === a && ny && ny.track !== na.track && ny.step === na.step && sideOf(a, y) === dir;
        });
        if (sideTaken) {
          out[a + '>' + b] = 'inner';
          if (this.edges.some(([x, y]) => x === b && y === a)) out[b + '>' + a] = 'innerBack';
          continue;
        }
        // 反過來看目標端：目標的這一側若也被同列橫線佔住，就別從側邊硬擠進去，
        // 橫到它正上方再往下進頂部（規格層重做→開發：開發右側已被 分診→開發 佔住）。
        // 注意是「線**進入**目標的哪一側」，不是「目標在對方的哪一側」——兩者相反。
        // 寫反的話 等待規格確認→建立分支 會被誤判成要橫過去進頂部，跟別的線疊 148px。
        const enterSide = (x, y) => (this.layout.pos[y].x > this.layout.pos[x].x ? 'L' : 'R');
        const myEnter = enterSide(a, b);
        const enterTaken = this.edges.some(([x, y]) => {
          const nx = this.nodeById[x];
          return y === b && x !== a && nx && nx.track !== nb.track
            && nx.step === nb.step && enterSide(x, b) === myEnter;
        });
        if (enterTaken) out[a + '>' + b] = 'over';
      }
      return out;
    },

    // 哪些線併進哪條匯流排——純邏輯、不碰座標。刻意與 buses（算幾何）分開：portOffsets 需要
    // 知道「這條線是不是接頭」，而 buses 又需要 portOffsets 才知道主幹該從哪個高度進入目標，
    // 合在一起就是循環依賴。
    busSourceMap() {
      const m = {};
      for (const cfg of PF_BUSES) {
        if (!this.nodeById[cfg.target]) continue;
        // 只收「回頭路」：link 是 Git 泳道的橫向對應線，雖然也指向開發關，但它表達的是
        // 「這一關在 Git 上做了什麼」，被吞進退回匯流排會被畫成紅色退回線，語意完全相反。
        const sources = this.edges
          .filter(([a, b, kind]) => b === cfg.target && kind !== 'link'
            && !cfg.exclude.includes(a) && this.nodeById[a])
          .map(([a]) => a);
        if (sources.length < 2) continue;          // 只有一條線就不必立一條主幹
        for (const s of sources) m[s + '>' + cfg.target] = cfg;
      }
      return m;
    },

    // 每條匯流排的幾何：主幹涵蓋所有匯入點與目標，最後一段水平接進目標（箭頭在那裡）。
    // 匯入點可能同時在目標的上方與下方（分診就是：裁決在上、停下與審核在下），所以主幹用
    // 「涵蓋全部的垂直線」＋「另一段進入線」兩個 subpath，不是單純從一端拉到另一端。
    buses() {
      const p = this.layout.pos, out = [];
      for (const cfg of PF_BUSES) {
        const tgt = this.nodeById[cfg.target], tp = p[cfg.target];
        if (!tgt || !tp) continue;
        const sources = Object.keys(this.busSourceMap)
          .filter(k => k.endsWith('>' + cfg.target)).map(k => k.split('>')[0]);
        if (!sources.length) continue;
        // side='bottom'：主幹走目標正下方，從底部進來。匯入的關全在目標下方時用這個——
        // 從側邊進來的話，那些接頭得先橫到目標旁邊，正好和目標往外送出的線打叉。
        const bottom = cfg.side === 'bottom';
        const x = bottom ? tp.x + tp.w / 2
          : cfg.side === 'left' ? tp.x - 40 : tp.x + tp.w + 40;
        const ys = sources.map(id => {
          const n = this.nodeById[id], q = p[id];
          // 同泳道的接頭走節點中線（含接口分軌）；跨泳道的走節點下方的間隙（見 edgePath）
          return n.track === tgt.track
            ? q.y + q.h / 2 + ((this.portOffsets[id + '>' + cfg.target] || {}).out || 0)
            : this.gapY(q, id + '>' + cfg.target, true);
        });
        // 主幹進入目標的高度也要參與接口分軌，否則會和其他進入同一側的線（Git 對應線）重疊
        const endY = bottom ? tp.y + tp.h
          : tp.y + tp.h / 2 + ((this.portOffsets['bus:' + cfg.target] || {}).in || 0);
        const lo = Math.min(...ys, endY), hi = Math.max(...ys, endY);
        const enter = bottom ? null : (cfg.side === 'left' ? tp.x : tp.x + tp.w);
        const sourceY = {};
        sources.forEach((id, i) => { sourceY[id] = ys[i]; });
        out.push({
          id: cfg.target, side: cfg.side, x, sources, sourceY, endY, enter, bottom,
          // 從底部進來時主幹本身就通到目標底緣，不需要另一段水平進入線
          path: bottom ? `M ${x} ${hi} V ${endY}` : `M ${x} ${lo} V ${hi} M ${x} ${endY} H ${enter}`
        });
      }
      return out;
    },
    // edgeKey → 它屬於哪條匯流排（該邊只畫接頭，不畫完整路徑）
    busEdgeMap() {
      const m = {};
      for (const b of this.buses) for (const s of b.sources) m[s + '>' + b.id] = b;
      return m;
    },
    // 用純邏輯版當來源，配色／線型／分軌就不必經過幾何鏈（少一層依賴，也少一個循環的機會）
    busEdges() { return new Set(Object.keys(this.busSourceMap)); },

    // 上下緣的接點分配。只接一條就**置中**，多條才依序讓開——早期一律偏 16px，單獨一條的
    // 節點看起來也是歪的；後來只數「有幾條」卻不分配位置，同一個底部的兩條匯流排接頭又都
    // 走正中間疊在一起（待你裁決→開發 與 →分診）。所以這裡要算到「第幾條」，不只是「幾條」。
    // 主線（直上直下那條）優先佔中心，其他往兩側讓。
    vertPortSlots() {
      const byPort = {};
      const add = (id, edge, key, isMain, dirX) => {
        (byPort[id + ':' + edge] = byPort[id + ':' + edge] || []).push({ key, isMain: !!isMain, dirX: dirX || 0 });
      };
      const xdir = (from, to) => Math.sign(this.layout.pos[to].x - this.layout.pos[from].x);
      for (const [a, b] of this.edges) {
        const na = this.nodeById[a], nb = this.nodeById[b];
        if (!na || !nb) continue;
        const r = this.routeKind(a, b);
        if (!r) continue;
        const k = a + '>' + b;
        if (r.mode === 'straight') {
          if (nb.step > na.step) { add(a, 'B', k, true); add(b, 'T', k, true); }
          else { add(a, 'T', k, true); add(b, 'B', k, true); }
        } else if (r.mode === 'inner') add(a, 'B', k, false, xdir(a, b));
        else if (r.mode === 'innerUp') add(a, 'T', k, false, xdir(a, b));
        else if (r.mode === 'innerBack') add(b, 'B', k, false, xdir(b, a));
        else if (r.mode === 'over') { add(a, 'B', k, false, xdir(a, b)); add(b, 'T', k, false, xdir(b, a)); }
        else if (r.mode === 'bus' && !r.sameTrack) {
          const tp = this.layout.pos[r.bus.target];
          add(a, 'B', k, false, Math.sign(this.busXOf(r.bus) - (this.layout.pos[a].x + this.layout.pos[a].w / 2)));
        }
      }
      // 走正下方的匯流排主幹也是從目標底部接進去的，一樣佔一個位——漏算的話，
      // 從那個底部出去的線會以為那裡是空的，直接疊在主幹上。
      for (const cfg of PF_BUSES) {
        if (cfg.side !== 'bottom' || !this.nodeById[cfg.target]) continue;
        if (Object.keys(this.busSourceMap).some((k) => k.endsWith('>' + cfg.target))) {
          add(cfg.target, 'B', 'bus:' + cfg.target, true);   // 主幹佔中心
        }
      }
      const out = {};
      for (const gk of Object.keys(byPort)) {
        const list = byPort[gk];
        if (list.length < 2) continue;                       // 單獨一條 → 置中（查不到就是 0）
        // 按線要往哪邊走來分位置：往左的靠左、往右的靠右，主線（直上直下）留中間。
        // 不看方向的話，往左的線可能被排到右邊，一出去就得先往回繞（等待審核→更新 Wiki 就這樣）。
        const mid = list.filter((it) => it.isMain || !it.dirX);
        const left = list.filter((it) => !it.isMain && it.dirX < 0);
        const right = list.filter((it) => !it.isMain && it.dirX > 0);
        mid.forEach((it, i) => { out[it.key + '@' + gk] = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 16; });
        left.forEach((it, i) => { out[it.key + '@' + gk] = -16 * (i + 1); });
        right.forEach((it, i) => { out[it.key + '@' + gk] = 16 * (i + 1); });
      }
      return out;
    },

    // 接口分軌：把「接在某個關的某一側」的線全部收在一起排開，**不分進出**。
    // routeTracks 管的是走廊上的平行段，管不到端點；而只分軌出線口也不夠——一條線進來、
    // 一條線出去，兩條都走節點中線照樣完全重疊（合併衝突的左側就是這樣疊了 44px）。
    // 回傳 { edgeKey: { out: dy, in: dy } }：一條線的兩端各有自己的偏移。
    portOffsets() {
      const byPort = {};
      // dir＝這條線在這個接口是往上還是往下延伸。排序時往上的擺上面、往下的擺下面，
      // 去程與回程就天生不會打叉——回程從上面橫走時，去程的垂直段還沒開始往下。
      let seq = 0;
      const add = (nodeId, side, key, end, dir, isLevel) => {
        if (!side) return;
        const gk = nodeId + ':' + side;
        (byPort[gk] = byPort[gk] || []).push({ key, end, dir: dir || 0, isLevel: !!isLevel, idx: seq });
      };
      const lastTrack = this.tracks[this.tracks.length - 1].id;
      // 匯流排主幹先在目標節點的接口佔一個位——它的路徑是獨立畫的，不在下面的 edges 迴圈裡，
      // 不佔位的話別的線會以為那個高度是空的（Git 對應線就這樣和主幹疊了 40px）。
      for (const cfg of PF_BUSES) {
        const tgt = this.nodeById[cfg.target];
        if (!tgt) continue;
        const srcSteps = Object.keys(this.busSourceMap)
          .filter((k) => k.endsWith('>' + cfg.target))
          .map((k) => (this.nodeById[k.split('>')[0]] || {}).step);
        if (!srcSteps.length) continue;
        // 主幹算「從哪個方向進來」：匯入的關全在下面就是 +1。標對了才會排到該去的那一格——
        // 開發關的匯入點全在下方，主幹卻被排到上面，於是 Git 對應線（產生 commit→開發）
        // 橫過來時正好穿過主幹。
        const dir = srcSteps.every((s) => s > tgt.step) ? 1
          : srcSteps.every((s) => s < tgt.step) ? -1 : 0;
        add(cfg.target, cfg.side === 'left' ? 'L' : 'R', 'bus:' + cfg.target, 'in', dir);
      }
      for (const [a, b] of this.edges) {
        const key = a + '>' + b;
        seq += 1;
        const na = this.nodeById[a], nb = this.nodeById[b];
        const pa = this.layout.pos[a], pb = this.layout.pos[b];
        if (!na || !nb || !pa || !pb) continue;
        const r = this.routeKind(a, b);
        if (!r) continue;
        if (r.mode === 'straight') continue;                 // 直上直下走頂／底，不佔側邊
        // 接點的上下順序＝**這條線是從哪個方向來的**：從上面來就接上面的點、從下面來就接下面的。
        // 這樣線不必為了接到點而回頭繞。QA（在上）與 部署（在下）都指向失敗待確認，兩條接點
        // 因此自然一上一下，不再互相交錯。
        const dOut = Math.sign(nb.step - na.step);   // 出去：往上的關在上面 → -1
        const dIn = -dOut;                           // 進來：從上面來 → -1
        if (r.mode === 'bus') {
          // 接頭的另一端落在主幹上，不佔目標節點的接口；跨泳道的接頭從底部出發也不佔側邊
          // 主幹在正下方時，接頭一律從節點底部走，不佔側邊接口
          if (r.sameTrack && r.bus.side !== 'bottom') add(a, r.bus.side === 'left' ? 'L' : 'R', key, 'out', dOut);
        } else if (r.mode === 'inner') {
          // 起點端在自己泳道底下用固定偏移錯開；目標端仍是側邊接口，要分軌——
          // 去程的終點與回程的起點都落在目標同一側，不分軌就整段疊在一起。
          add(b, r.side === 'R' ? 'L' : 'R', key, 'in', dIn);
        } else if (r.mode === 'innerUp') {
          add(b, r.side === 'R' ? 'L' : 'R', key, 'in', dIn);
        } else if (r.mode === 'innerBack') {
          // r.side 就是「往哪一邊走」，所以線從同名的那一側出去。寫成反的話，去程的終點與
          // 回程的起點會被登記到節點的不同側，分軌就不會把這兩條算在一起（它們其實都接左側）。
          add(a, r.side, key, 'out', dOut);
        } else if (r.mode === 'over') {
          // 目標端進頂部，不佔側邊；但起點端**不一定**從底部走——edgePath 會先試「從側邊
          // 直接橫過去」的捷徑（原則 3：能直連就別繞），只有那條橫線會撞到別的關才改走間隙。
          // 這裡原本整條跳過，於是走捷徑的線落在節點正中線、完全不參與該側分軌：關掉 E2E 後
          // 部署測試區→等待審核 就這樣夾在 部署→失敗待確認 與 合併衝突→部署測試區 中間，
          // 左右各差 6.5px，並行 164px——看起來是一條粗雙線，而重疊掃描（門檻 3px）測不到。
          add(a, r.side, key, 'out', dOut);
        } else if (r.mode === 'sidestep') {
          add(a, r.side, key, 'out', dOut); add(b, r.side, key, 'in', dIn);
        } else {                                             // level／corridor
          const isLevel = r.mode === 'level';
          add(a, r.side, key, 'out', dOut, isLevel);
          add(b, r.side === 'R' ? 'L' : 'R', key, 'in', dIn, isLevel);
        }
      }
      const out = {};
      for (const gk of Object.keys(byPort)) {
        const list = byPort[gk];
        if (list.length < 2) continue;                    // 只有一條就走中線
        // 先按來向排（從上面來的擺上面）；同一個來向時，**出去的擺上面**——
        // 「從上面下來進入某關」與「從該關往上出去」在接口處都算「上」，不再分就會擠成一點，
        // 兩條線在那裡打叉（合併衝突→部署測試區 撞 部署→失敗待確認）。
        // 同 step 的橫線與其他線分開排：
        //   兩條都是同 step 橫線 → 按**定義順序**。這種線的兩端各屬於不同的接口群組，用 out/in
        //   當排序鍵的話，同一對節點的往返會在兩端都拿到對稱位置，兩條疊成 Z 字（客服處理↔需補資料）。
        //   其他 → **出去的擺上面**：「從上面下來進入某關」與「從該關往上出去」在接口處都算「上」，
        //   不再分就會擠成一點（合併衝突→部署測試區 撞 部署→失敗待確認）。
        list.sort((p, q) => (p.dir - q.dir)
          || (p.isLevel && q.isLevel
            ? p.idx - q.idx
            : (p.end === 'out' ? 0 : 1) - (q.end === 'out' ? 0 : 1))
          || (p.idx - q.idx));
        list.forEach((it, i) => {
          const dy = (i - (list.length - 1) / 2) * 13;
          (out[it.key] = out[it.key] || {})[it.end] = dy;
        });
      }
      return out;
    },

    // 間隙分軌：走「關與關之間那條橫向間隙」的線（匯流排接頭、繞外側的線）如果都取間隙中線，
    // 同一格的兩條就會整段疊在一起（裁決→開發 的接頭與 QA→失敗待確認 疊了 206px）。
    // 這裡按水平區間分軌——不重疊的線仍可共用同一個高度，只有真的交疊才往下讓。
    gapTracks() {
      const groups = {};
      for (const [a, b] of this.edges) {
        const r = this.routeKind(a, b);
        if (!r) continue;
        const na = this.nodeById[a], nb = this.nodeById[b];
        const pa = this.layout.pos[a], pb = this.layout.pos[b];
        if (!na || !nb || !pa || !pb) continue;
        const cx = pa.x + pa.w / 2;
        let step, x0, x1;
        if (r.mode === 'bus' && !r.sameTrack) {
          step = na.step;
          const bx = this.busXOf(r.bus);
          x0 = Math.min(cx, bx); x1 = Math.max(cx, bx);
        } else if (r.mode === 'over') {
          step = na.step;                          // 橫過去那一段也走這條間隙
          const bx = pb.x + pb.w / 2 + 16;
          x0 = Math.min(cx, bx); x1 = Math.max(cx, bx);
        } else continue;
        (groups[step] = groups[step] || []).push({ k: a + '>' + b, x0, x1 });
      }
      const out = {};
      for (const gk of Object.keys(groups)) {
        const ends = [];
        for (const it of groups[gk].sort((p, q) => p.x0 - q.x0)) {
          let t = ends.findIndex((e) => e <= it.x0);
          if (t === -1) t = ends.length;
          ends[t] = it.x1;
          out[it.k] = t;
        }
      }
      return out;
    },

    // 走廊分軌：同一條走廊（或同一側的繞行）上，只有「垂直範圍真的重疊」的線才需要錯開。
    // 早期版本用雜湊決定每條線的偏移量，結果是每條線都被推歪一點、彼此不平行——而其中絕大多數
    // 根本不與任何線重疊，等於為了少數幾處衝突把整張圖弄斜。這裡改成區間著色：先按起點排序，
    // 依序塞進第一條「已經空出來」的軌道，不重疊的線自然全部落在軌道 0（＝走中線、對齊）。
    routeTracks() {
      const groups = {};
      for (const [a, b] of this.edges) {
        const k = a + '>' + b;
        if (this.busEdges.has(k)) continue;              // 匯流排的位置是固定的，不參與分軌
        const na = this.nodeById[a], nb = this.nodeById[b];
        const pa = this.layout.pos[a], pb = this.layout.pos[b];
        if (!na || !nb || !pa || !pb) continue;
        const y0 = Math.min(pa.y, pb.y), y1 = Math.max(pa.y + pa.h, pb.y + pb.h);
        const r = this.routeKind(a, b);
        if (!r || r.mode === 'straight' || r.mode === 'level') continue;        // 這兩種不佔走廊
        if (r.mode.startsWith('inner') || r.mode === 'over') continue;         // 各有專屬通道
        let gk;
        if (r.mode === 'sidestep') gk = 'side:' + na.track;
        // 必須與 edgePath 算出**同一個值**，否則同一條走廊的來回線會被分到兩組、各自以為
        // 自己獨佔那條走廊，然後疊在一起（客服處理↔等待確認回覆 疊了 99px）。
        else gk = 'gap:' + (pb.x > pa.x
          ? pa.x + pa.w + this.layout.GAP / 2
          : pa.x - this.layout.GAP / 2);
        (groups[gk] = groups[gk] || []).push({ k, y0, y1 });
      }
      const out = {};
      for (const gk of Object.keys(groups)) {
        const lanes = [];                                 // 每條軌道上已佔用的區間
        // 跨得短的先分配，才會拿到內側軌道。反過來的話，短程線被擠到外側，它從節點橫出去的
        // 那一小段就會穿過長程線的垂直段（分診→規格層重做 與 分診→待你裁決 就是這樣打叉的）。
        // 因為不再按起點排序，判「這一軌塞不塞得下」必須逐一比對該軌所有區間，
        // 不能只看最後一個區間的結束點——那是按起點排序才成立的簡化。
        for (const it of groups[gk].sort((p, q) => (p.y1 - p.y0) - (q.y1 - q.y0))) {
          let t = lanes.findIndex((iv) => iv.every(([s, e]) => it.y1 <= s || it.y0 >= e));
          if (t === -1) { t = lanes.length; lanes.push([]); }
          lanes[t].push([it.y0, it.y1]);
          out[it.k] = t;
        }
      }
      return out;
    },

    // hover 時主幹只亮「這一關的接頭 → 目標」那一段。整條主幹一起亮的話，接頭以外的部分
    // 亮著卻沒接到任何亮起的東西，看起來就是一截斷在半空中的線。
    // hover 的是目標關本身時才整條亮——那時每一條接頭確實都通到它。
    busHighlight() {
      if (!this.hovered) return [];
      const out = [];
      for (const b of this.buses) {
        if (this.hovered === b.id) { out.push({ key: b.id, d: b.path }); continue; }
        if (!b.sources.includes(this.hovered)) continue;
        out.push({ key: b.id, d: b.bottom
          ? `M ${b.x} ${b.sourceY[this.hovered]} V ${b.endY}`
          : `M ${b.x} ${b.sourceY[this.hovered]} V ${b.endY} H ${b.enter}` });
      }
      return out;
    },

    // 匯流排主幹縱跨 780px 以上，比視窗還高——hover 某一關時，接頭往主幹一接就跑出畫面，
    // 看不到它接去哪，感覺像少了一段。在接頭末端標出目標名稱，就不必追著線捲畫面。
    // 只在 hover 時出現，平常不佔版面。
    busStubLabels() {
      if (!this.hovered) return [];
      const q = this.layout.pos[this.hovered], n = this.nodeById[this.hovered];
      if (!q || !n) return [];
      return this.buses.filter(b => b.sources.includes(this.hovered)).map(b => {
        const tgt = this.nodeById[b.id];
        const y = n.track === tgt.track
          ? q.y + q.h / 2 + ((this.portOffsets[this.hovered + '>' + b.id] || {}).out || 0)
          : q.y + q.h + (this.layout.STEP - q.h) / 2;
        return {
          key: b.id, x: b.x + (b.side === 'left' ? 6 : -6), y: y - 7,
          anchor: b.side === 'left' ? 'start' : 'end',
          text: '↩ ' + tgt.label
        };
      });
    },

    active() { return this.hovered ? this.nodeById[this.hovered] : null; },
    activeEdges() {
      if (!this.hovered) return new Set();
      return new Set(this.edges
        .filter(([a, b]) => a === this.hovered || b === this.hovered)
        .map(([a, b]) => a + '>' + b));
    },
    activeNeighbours() {
      const s = new Set();
      if (!this.hovered) return s;
      for (const [a, b] of this.edges) {
        if (a === this.hovered) s.add(b);
        if (b === this.hovered) s.add(a);
      }
      return s;
    }
  },
  methods: {
    kindColor(n) { return PF_KIND_COLOR[n.kind] || 'var(--border-strong)'; },

    // 狀態名太長時折成兩行。原本是壓成 134px 塞進 152px 的框，左右只剩 9px——而線正好接在
    // 框的左右邊緣，字與線之間等於沒有留白，看起來就是字壓在線上（分診那格畫的是
    // 「reject_triage / resolve_triage」兩個入口狀態）。折行後每行只剩十來個字元，
    // 自然寬度約 80px、左右各留 35px，跟「開發」那種短狀態名的留白一致。
    statusLines(n) {
      const s = n.status || n.ref || '';
      const i = s.indexOf(' / ');
      return i > 0 && s.length > 24 ? [s.slice(0, i + 2), s.slice(i + 3)] : [s];
    },


    // 一條水平線會不會壓過某個方塊的內部。用來決定「直接橫過去」還不還得通。
    horizontalHitsNode(y, x0, x1) {
      const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      return this.nodes.some((n) => {
        const p = this.layout.pos[n.id];
        return p && y > p.y + 2 && y < p.y + p.h - 2 && hi > p.x + 2 && lo < p.x + p.w - 2;
      });
    },

    // 同泳道且兩點之間夾著別的節點 → 直線會穿過那個節點，必須繞。
    blockedBetween(a, b) {
      const lo = Math.min(a.step, b.step), hi = Math.max(a.step, b.step);
      return this.nodes.some(n => n.track === a.track && n.step > lo && n.step < hi);
    },

    // 一條線該怎麼走——**單一判斷來源**。portOffsets（決定接在節點的哪一側）與 edgePath（畫路徑）
    // 都問這裡；兩邊各判一次的話，加一種新走法就會不同步，接口分軌算在左邊、線卻從右邊出去。
    routeKind(from, to) {
      const na = this.nodeById[from], nb = this.nodeById[to];
      const pa = this.layout.pos[from], pb = this.layout.pos[to];
      if (!na || !nb || !pa || !pb) return null;
      const bus = this.busSourceMap[from + '>' + to];
      if (bus) return { mode: 'bus', bus, sameTrack: na.track === nb.track };
      if (na.track === nb.track) {
        // 往上也可以直走——只要中間沒夾著別的關，而且沒有反向的線會跟它重疊。
        // 分診→規格層重做 就是這種：同泳道、上一格、中間沒東西，繞到側邊反而多兩個彎。
        if (!this.blockedBetween(na, nb)
          && (nb.step > na.step || !this.edges.some(([x, y]) => x === to && y === from))) {
          return { mode: 'straight' };
        }
        return { mode: 'sidestep', side: this.tracks[this.tracks.length - 1].id === na.track ? 'R' : 'L' };
      }
      if (Math.abs(pa.y - pb.y) < 1) return { mode: 'level', side: pb.x > pa.x ? 'R' : 'L' };
      // 往哪一側走，看的是**目標在起點的左邊還是右邊**。早期用「起點是不是最左那條泳道」來判，
      // 關掉 Git 泳道後任務主線變成最左，判斷整個反過來，線就往左鑽出去、直接穿過目標節點。
      const outSide = pb.x > pa.x ? 'R' : 'L';
      const br = this.branchRoutes[from + '>' + to];
      if (br) return { mode: br, side: outSide };
      // 跨泳道往下：從**底部**出發，先往下再橫過去（兩段）。從側邊出發的話是「橫→下→橫」
      // 三段，多繞一個彎（原則 3）。前提是自己泳道在中間那幾列沒有別的關擋著垂直段。
      if (nb.step > na.step
        && !this.nodes.some((n) => n.track === na.track && n.step > na.step && n.step <= nb.step)) {
        return { mode: 'inner', side: outSide };
      }
      // 往上的對稱做法：從**頂部**出發。少了這一條，往上的線只能從側邊擠出去，就會和「從上面
      // 下來進入同一關」的線在那一側打叉（部署→失敗待確認 撞 合併衝突→部署、QA→失敗待確認）。
      if (nb.step < na.step
        && !this.nodes.some((n) => n.track === na.track && n.step < na.step && n.step >= nb.step)) {
        return { mode: 'innerUp', side: outSide };
      }
      // 曾經讓「跨兩格以上」的線繞外側，想解掉 部署→失敗待確認 撞 併入測試↔合併衝突 那兩個
      // 交叉。實測反而從 11 個變成 13 個：繞外側要橫跨整條人工泳道與分診匯流排，沿途製造的
      // 交叉比省下的多。那兩個交叉在目前的節點排列下無解，留著。
      return { mode: 'corridor', side: pb.x > pa.x ? 'R' : 'L' };
    },

    // 匯流排主幹的 x——buses（算幾何）與 gapTracks／edgePath（算接頭）都問這裡，各自重算就會
    // 在加第三種 side 時漏掉某一處。
    busXOf(cfg) {
      const tp = this.layout.pos[cfg.target];
      if (!tp) return 0;
      return cfg.side === 'bottom' ? tp.x + tp.w / 2
        : cfg.side === 'left' ? tp.x - 40 : tp.x + tp.w + 40;
    },

    // 走間隙的線落在哪個高度：從節點邊緣算起 18px，每讓一軌再 13px（間隙共 58px，容得下 3 軌）。
    // buses 算主幹範圍時也要問這裡，否則接頭停在 A 高度、主幹只涵蓋到 B 高度，接頭就懸空了。
    gapY(pos, key, down) {
      const off = 18 + (this.gapTracks[key] || 0) * 13;
      return down ? pos.y + pos.h + off : pos.y - off;
    },

    // 連線路徑（曼哈頓路由）。跨泳道的垂直段一律走「兩條泳道之間的走廊」，
    // 不走泳道中線——走中線會穿過該泳道上其他關的方框。
    edgePath(from, to) {
      const p = this.layout.pos, a = p[from], b = p[to];
      const na = this.nodeById[from], nb = this.nodeById[to];
      if (!a || !b || !na || !nb) return '';
      const key = from + '>' + to;
      const acx = a.x + a.w / 2, bcx = b.x + b.w / 2;
      // 接口分軌（見 portOffsets）：兩端各自讓開，否則同一側的線會疊在一起
      const port = this.portOffsets[key] || {};
      const acy = a.y + a.h / 2 + (port.out || 0);
      const bcy = b.y + b.h / 2 + (port.in || 0);

      const r = this.routeKind(from, to);
      if (!r) return '';
      const t = this.routeTracks[key] || 0;
      // 上下緣的偏移：查這條線在該接口分到第幾個位置（只接一條就是 0＝置中，見 vertPortSlots）
      const vOff = (id, edge) => this.vertPortSlots[key + '@' + id + ':' + edge] || 0;

      // 併進匯流排的線只畫「接頭」，主幹由 buses 單獨畫一次（每條各畫一次會疊在一起，
      // hover 打亮時更是整條主幹粗細不一致）。
      if (r.mode === 'bus') {
        const bus = this.busEdgeMap[key];
        // 與目標同泳道 → 從節點側邊直接橫出去；跨泳道 → 先下到該關底下的間隙再橫越，
        // 那條間隙保證沒有方框，不會穿過中間泳道的任何一關。
        if (r.sameTrack && !bus.bottom) {
          return bus.side === 'left' ? `M ${a.x} ${acy} H ${bus.x}` : `M ${a.x + a.w} ${acy} H ${bus.x}`;
        }
        return `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${this.gapY(a, key, true)} H ${bus.x}`;
      }

      // 同泳道、中間沒東西擋 → 直線（往上就從頂部出、接到目標底部）
      if (r.mode === 'straight') {
        return nb.step > na.step
          ? `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${b.y}`
          : `M ${acx + vOff(from, 'T')} ${a.y} V ${b.y + b.h}`;
      }

      // 同泳道但要繞開夾在中間的節點
      if (r.mode === 'sidestep') {
        const isR = r.side === 'R';
        const off = a.w / 2 + 16 + t * 15;
        const sx = isR ? acx + off : acx - off;
        return `M ${isR ? a.x + a.w : a.x} ${acy} H ${sx} V ${bcy} H ${isR ? b.x + b.w : b.x}`;
      }

      // 側邊被同列橫線佔住時改走的通道（見 branchRoutes）。去程與回程的內外是**刻意相反**的，
      // 否則兩條會交叉——交叉不是重疊，掃描重疊那一關完全看不出來，畫面上卻是兩條線打叉。
      if (r.mode === 'inner') {
        // 貼著自己泳道的主線旁邊往下，到目標高度才橫出去。垂直段走的是泳道底下那片空白。
        const isR = r.side === 'R';
        return `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${bcy} H ${isR ? b.x : b.x + b.w}`;
      }
      // 往上：從頂部出發，先往上再橫過去
      if (r.mode === 'innerUp') {
        const isR = r.side === 'R';
        return `M ${acx + vOff(from, 'T')} ${a.y} V ${bcy} H ${isR ? b.x : b.x + b.w}`;
      }
      if (r.mode === 'innerBack') {
        // 從**朝著目標的那一側**出發。早期把方向判反，線從自己節點的另一側出來，等於先橫穿
        // 過自己一遍（等待確認回覆→客服處理 穿過自己 152px）。
        //
        // 垂直段跟去程放**同一側**、再往外一格：一左一右的話，回程的橫段必須跨過中間那條
        // 主線才回得來，白白多一個交叉。同側就只是兩條平行線，主線留在中間不受打擾。
        const goLeft = r.side === 'L';
        const sx = goLeft ? a.x : a.x + a.w;
        return `M ${sx} ${acy} H ${bcx + (goLeft ? 32 : -32)} V ${b.y + b.h}`;
      }
      // 目標的側邊被同列橫線佔住 → 橫到它正上方再往下進頂部（進來的方向換掉，見 branchRoutes）。
      // 先試從側邊直接橫過去（原則 3：優先直連）；只有那條水平線會撞到別的關時才退而求其次，
      // 從底部出來走關與關之間的間隙——開啟「依規格先寫測試」時，任務主線那一格就多出
      // 「先寫 E2E 考題」，直橫過去會穿過它。
      if (r.mode === 'over') {
        const ax0 = r.side === 'R' ? a.x + a.w : a.x;
        const tx = bcx + vOff(to, 'T');          // 目標頂部只接這一條就走正中間
        if (!this.horizontalHitsNode(acy, ax0, tx)) return `M ${ax0} ${acy} H ${tx} V ${b.y}`;
        return `M ${acx + vOff(from, 'B')} ${a.y + a.h} V ${this.gapY(a, key, true)} H ${tx} V ${b.y}`;
      }
      const goRight = b.x > a.x;
      // 同一 step 的橫線：兩端都照接口分軌讓開，高度一致就是直線，不一致就在起點旁折一小段。
      // 一度改成「往右走上方、往左走下方」的固定偏移，但那樣它不參與分軌，會和同一個接口上
      // 別條線算出幾乎相同的高度（差 0.5px，等於疊在一起）。接口分軌現在有上下排序，
      // 同一對節點的來回兩條線本來就會被分到不同軌，不需要另一套固定偏移。
      if (Math.abs(a.y - b.y) < 1) {
        const ax0 = goRight ? a.x + a.w : a.x;
        const bx0 = goRight ? b.x : b.x + b.w;
        if (Math.abs(acy - bcy) < 1) return `M ${ax0} ${acy} H ${bx0}`;
        const mx = goRight ? ax0 + this.layout.GAP / 2 : ax0 - this.layout.GAP / 2;
        return `M ${ax0} ${acy} H ${mx} V ${bcy} H ${bx0}`;
      }
      // 走廊取「起點泳道旁邊那條」，不是起訖的幾何中點——跨兩條泳道時，中點會落在中間那條
      // 泳道的節點上，線就直接穿過去了（QA→失敗待確認 穿過「規格層重做」）。
      const mid = goRight ? a.x + a.w + this.layout.GAP / 2 : a.x - this.layout.GAP / 2;
      const gapX = mid + (t === 0 ? 0 : (t % 2 ? 1 : -1) * Math.ceil(t / 2) * 15);
      const ax = goRight ? a.x + a.w : a.x;
      const bx = goRight ? b.x : b.x + b.w;
      return `M ${ax} ${acy} H ${gapX} V ${bcy} H ${bx}`;
    },

    // 併進匯流排的接頭一律跟主幹同色同線型。接頭一種顏色、主幹另一種的話，同一條路徑看起來
    // 像是斷成兩截、後半沒被打亮（規格層重做→開發 是 main 類，原本畫成灰白實線接上紅色虛線主幹）。
    edgeColor(kind, key) {
      if (this.busEdges.has(key) || kind === 'back') return 'var(--danger)';
      if (kind === 'link') return 'var(--info)';
      return 'var(--text-muted)';
    },
    edgeDash(kind, key) {
      if (this.busEdges.has(key)) return '5 4';
      if (kind === 'main') return '';
      if (kind === 'link') return '3 5';
      return '5 4';
    },
    // 箭頭要跟線同色，否則紅線末端接一個灰箭頭，看起來像兩條不同的線交會
    edgeMarker(kind, key) {
      if (kind === 'link' || this.busEdges.has(key)) return '';       // 接頭的箭頭在主幹末端
      return kind === 'back' ? 'url(#pf-arrow-danger)' : 'url(#pf-arrow)';
    },
    dim(id) { return this.hovered && id !== this.hovered && !this.activeNeighbours.has(id); },
    edgeDim(a, b) { return this.hovered && !this.activeEdges.has(a + '>' + b); }
  },
  template: `
    <div class="page-header">
      <div class="page-header-inner">
        <h1 class="page-title">Pipeline 流程圖</h1>
        <p style="color:var(--text-muted);font-size:var(--fs-sm);margin-top:var(--space-1)">
          泳道由左到右是{{ tracks.map(t => t.label).join('、') }}。滑鼠移到節點上會打亮它與相鄰的路徑，並在右側顯示這一關的邏輯。
          下方開關是<strong>推演用</strong>——只改這張圖，不會動到任何專案的設定。
        </p>
      </div>
    </div>

    <div class="page-body">
      <div style="display:flex;gap:var(--space-4);flex-wrap:wrap;align-items:center;margin-bottom:var(--space-4)">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
          <div class="switch">
            <input type="checkbox" v-model="e2eEnabled" />
            <div class="switch-track"></div>
            <div class="switch-knob"></div>
          </div>
          <span style="font-size:var(--fs-md);color:var(--text)">E2E 測試{{ e2eEnabled ? '啟用' : '停用' }}</span>
        </label>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
          <div class="switch">
            <input type="checkbox" v-model="specTour" />
            <div class="switch-track"></div>
            <div class="switch-knob"></div>
          </div>
          <span style="font-size:var(--fs-md);color:var(--text)">依規格先寫測試{{ specTour ? '（啟用）' : '（停用）' }}</span>
        </label>
        <label v-for="t in trackToggles" :key="t.id"
               style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none">
          <div class="switch">
            <input type="checkbox" v-model="$data[t.flag]" />
            <div class="switch-track"></div>
            <div class="switch-knob"></div>
          </div>
          <span style="font-size:var(--fs-md);color:var(--text)">{{ t.toggleLabel }}</span>
        </label>
      </div>

      <div style="display:flex;gap:var(--space-4);align-items:flex-start;flex-wrap:wrap">
        <div style="flex:1 1 620px;min-width:0;overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-3)">
          <svg :width="layout.w" :height="layout.h" :viewBox="'0 0 ' + layout.w + ' ' + layout.h"
               style="display:block;max-width:none">
            <defs>
              <marker id="pf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" />
              </marker>
              <marker id="pf-arrow-danger" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--danger)" />
              </marker>
            </defs>

            <!-- 泳道標題 -->
            <g v-for="t in tracks" :key="'lane-' + t.id">
              <text :x="layout.laneX[t.id] + layout.W / 2" :y="16" text-anchor="middle"
                    fill="var(--text-muted)"
                    style="font-size:11px;font-weight:600;letter-spacing:.5px">{{ t.label }}</text>
            </g>

            <g>
              <!-- 匯流排主幹（退回開發／回分診）：各關的接頭由 edgePath 畫 -->
              <path v-for="bus in buses" :key="'bus-' + bus.id"
                    :d="bus.path" fill="none" stroke="var(--danger)"
                    stroke-width="1.6" stroke-dasharray="5 4"
                    :opacity="hovered ? 0.12 : 0.6"
                    marker-end="url(#pf-arrow-danger)"
                    style="transition:opacity .15s" />
              <!-- hover 時只亮主幹上「這一關通到目標」的那一段，其餘維持淡色 -->
              <path v-for="hl in busHighlight" :key="'hl-' + hl.key"
                    :d="hl.d" fill="none" stroke="var(--danger)"
                    stroke-width="2.5" stroke-dasharray="5 4" opacity="1"
                    marker-end="url(#pf-arrow-danger)" />
              <!-- data-edge 是給檢查用的：改完版面後可以逐條 diff，看出「修 A 卻連帶動到 B」 -->
              <path v-for="[a,b,kind] in edges" :key="a+'>'+b" :data-edge="a+'>'+b"
                    :d="edgePath(a,b)" fill="none"
                    :stroke="edgeColor(kind, a+'>'+b)"
                    :stroke-width="activeEdges.has(a+'>'+b) ? 2.5 : 1.4"
                    :stroke-dasharray="edgeDash(kind, a+'>'+b)"
                    :opacity="edgeDim(a,b) ? 0.12 : (activeEdges.has(a+'>'+b) ? 1 : (kind === 'link' ? 0.4 : 0.55))"
                    :marker-end="edgeMarker(kind, a+'>'+b)"
                    style="transition:opacity .15s, stroke-width .15s" />
            </g>

            <!-- 接頭末端標出「這條回頭路通到哪」，免得追著主幹捲出畫面 -->
            <text v-for="s in busStubLabels" :key="'stub-' + s.key"
                  :x="s.x" :y="s.y" :text-anchor="s.anchor" fill="var(--danger)"
                  style="font-size:10px;font-weight:600;pointer-events:none">{{ s.text }}</text>

            <g v-for="n in nodes" :key="n.id"
               @mouseenter="hovered = n.id" @mouseleave="hovered = null"
               :opacity="dim(n.id) ? 0.25 : 1"
               style="cursor:pointer;transition:opacity .15s">
              <!-- hover 效果刻意**不動顏色**：框線顏色是這張圖表達「這是什麼性質的關」的
                   唯一管道（見 PF_KIND_COLOR），原本 hover 會把框線與底色換成 primary，
                   等於把「要人動手」的橘框臨時說成「AI agent」的藍框，指著問的當下最容易誤導。
                   改用不帶語意的維度：框線加粗＋以**它自己的顏色**外暈。 -->
              <rect :x="layout.pos[n.id].x" :y="layout.pos[n.id].y"
                    :width="layout.pos[n.id].w" :height="layout.pos[n.id].h" rx="8"
                    fill="var(--card-bg)" :stroke="kindColor(n)"
                    :stroke-width="hovered === n.id ? 2.8 : 1.4"
                    :stroke-dasharray="n.kind === 'inline' || n.kind === 'ext' ? '5 3' : ''"
                    :style="{ transition: 'stroke-width .15s, filter .15s',
                              filter: hovered === n.id ? 'drop-shadow(0 0 6px ' + kindColor(n) + ')' : 'none' }" />
              <!-- 折成兩行的那一格，標題往上讓 4px，否則第二行會頂到下緣 -->
              <text :x="layout.pos[n.id].x + layout.pos[n.id].w/2"
                    :y="layout.pos[n.id].y + (statusLines(n).length > 1 ? 19 : 23)"
                    text-anchor="middle" fill="var(--text)"
                    style="font-size:13px;font-weight:600">{{ n.label }}</text>
              <!-- 過長的狀態名折行（見 statusLines）；折不了的（單一長字串）才退回壓寬度 -->
              <text :x="layout.pos[n.id].x + layout.pos[n.id].w/2"
                    :y="layout.pos[n.id].y + (statusLines(n).length > 1 ? 33 : 40)"
                    text-anchor="middle" fill="var(--text-muted)"
                    :textLength="statusLines(n).length === 1 && statusLines(n)[0].length > 24 ? layout.W - 18 : null"
                    lengthAdjust="spacingAndGlyphs"
                    style="font-size:9.5px;font-family:var(--font-mono, monospace)"><tspan
                      v-for="(s, i) in statusLines(n)" :key="i"
                      :x="layout.pos[n.id].x + layout.pos[n.id].w/2" :dy="i ? 12 : 0">{{ s }}</tspan></text>
            </g>
          </svg>

          <div style="display:flex;gap:var(--space-3);flex-wrap:wrap;margin-top:var(--space-3);font-size:var(--fs-xs);color:var(--text-muted)">
            <span>—— 主線</span>
            <span>- - - 分支／條件</span>
            <span style="color:var(--danger)">- - - 回頭路（兩條主幹＝各關「退回開發」與「回分診」的匯流排）</span>
            <span style="color:var(--info)">- - - Git 對應</span>
            <span style="color:var(--warning)">▢ 要人動手</span>
            <span style="color:var(--primary)">▢ AI agent</span>
            <span>▢ 系統自動</span>
            <span style="color:var(--info)">▢ Git</span>
            <span>⬚ 虛線框＝不是獨立狀態（任務不會停在那裡）</span>
          </div>
        </div>

        <div style="flex:0 1 340px;min-width:280px;position:sticky;top:var(--space-3)">
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);padding:var(--space-3);min-height:220px">
            <template v-if="active">
              <h3 style="font-size:var(--fs-md);font-weight:var(--fw-semibold);margin-bottom:var(--space-1)">{{ active.label }}</h3>
              <div style="font-size:var(--fs-xs);color:var(--text-muted);font-family:var(--font-mono, monospace);margin-bottom:var(--space-2)">
                {{ active.status || active.ref }}<template v-if="active.agent"> · agent: {{ active.agent }}</template>
              </div>
              <dl style="margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px var(--space-2);font-size:var(--fs-sm)">
                <template v-for="(row, i) in active.detail.filter(Boolean)" :key="i">
                  <dt style="color:var(--text-muted);white-space:nowrap">{{ row[0] }}</dt>
                  <dd style="margin:0;color:var(--text)">{{ row[1] }}</dd>
                </template>
              </dl>
            </template>
            <div v-else style="color:var(--text-muted);font-size:var(--fs-sm)">
              把滑鼠移到左邊任一個節點上，這裡會顯示那一關的進入條件、做什麼、成功與失敗各往哪走。
            </div>
          </div>
        </div>
      </div>
    </div>
  `
});
