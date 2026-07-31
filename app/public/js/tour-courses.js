// 教程課程定義。
// 每一步只宣告「去哪一頁、指哪個元素、說什麼」，畫面由平台自己渲染——
// 因此這支不再有仿製 HTML，版面改版不會讓教程教到舊介面。
//
// 欄位：
//   route        要停在哪個路由（不同才導頁）
//   target       要打光的元素選擇器，一律用 view 上的 data-tour 錨點，不要挑 class
//   click        目標藏在收合區時，先點這顆把它打開（目標已存在則不點，避免又關回去）
//   demoStatus   示範任務要擺在哪個狀態（tour-demo.js），用來走完整條任務流程
//   placement    說明框方位偏好；塞不下時引擎會自己換邊
//   interactive  允許使用者真的點光圈裡的東西（預設擋住，避免在示範資料上打真 API）
//   warn         補充提醒，會渲染成說明框底部的提示區塊
window.TOUR_COURSES = [
  {
    id: 'setup',
    name: '初始設定',
    desc: '補回註冊時略過的設定',
    steps: [
      {
        route: '/settings',
        target: '[data-tour="nav-settings"]',
        placement: 'right',
        title: '把註冊時略過的補完',
        text: '註冊精靈那幾步都可以按「略過」，多數人也真的略過了。<strong>這一課帶你把它們補上，大概一分鐘。</strong><br><br>入口就在左邊選單的「⚙️ 設定」，隨時可以自己回來。'
      },
      {
        route: '/settings',
        target: '[data-tour="set-github"]',
        title: '這一項不設，任務會卡住',
        text: 'AI 寫完程式要<strong>用你的身分</strong>推上 GitHub。沒給權杖，任務就停在這裡不動。<br><br>照卡片裡四個步驟做，或直接點<strong>「↗ 開啟 GitHub 建立權杖頁」</strong>——網址已經預帶好 <strong>repo</strong> 權限。'
      },
      {
        route: '/settings',
        target: '[data-tour="set-odoo"]',
        title: 'Odoo 帳號',
        text: '這組是拿來<strong>把你負責的 Odoo 工單自動同步進來</strong>的，任務列表才認得出哪些該歸你。<br><br>填完按「驗證取得」，使用者 ID 會自動帶出來。<strong>沒在用就跳過。</strong>'
      },
      {
        route: '/settings',
        target: '[data-tour="set-eservice"]',
        title: 'eService 帳號',
        text: '同上，客服系統那邊的工單靠這組認人。<br><br>兩邊都沒在用的話，這兩塊留白不影響其他功能。'
      },
      {
        route: '/settings',
        target: '[data-tour="set-notify"]',
        interactive: true,
        title: '桌面通知 — 最值得開的一個',
        text: '任務走到<strong>要你回答、要你審核</strong>的關卡會停下來等你。沒開通知，你只能自己回來看輪到你沒。<br><br><strong>現在就可以直接勾勾看</strong>，這一步沒有擋你的點擊。',
        warn: '分頁要留著（整個瀏覽器關掉就收不到），而且這設定只記在這台電腦的這個瀏覽器，換一台要再開一次。'
      },
      {
        route: '/settings',
        target: '[data-tour="set-dark"]',
        interactive: true,
        title: '深色模式',
        text: '純看個人喜好，勾了立刻換，隨時改回來。<br><br>初始設定就這些。下一課帶你把專案跑起來。'
      }
    ]
  },

  {
    id: 'project',
    name: '專案設定與工具',
    desc: '從無到有把專案跑起來，以及專案頁上的工具',
    steps: [
      {
        route: '/projects',
        target: '[data-tour="nav-projects"]',
        placement: 'right',
        title: '一切都掛在專案底下',
        text: '專案是容器：repo、測試環境、任務全掛在它底下。<br><br>接下來幾步用一個<strong>示範專案</strong>帶你看，你自己的資料不會被動到。'
      },
      {
        route: '/projects',
        click: '[data-tour="proj-add"]',
        target: '[data-tour="proj-form"]',
        title: '先建一個專案',
        text: '按右上角「+ 新增專案」就會展開這張表單。<br><br><strong>專案名稱用中文時，英文資料夾名稱是必填的</strong>——這是最多人卡住的地方，資料夾與測試資料庫都用它命名。'
      },
      {
        route: '/projects/demo',
        target: '[data-tour="pd-repos"]',
        title: '接上程式碼來源',
        text: '貼上 Git URL 後平台會去 clone，<strong>要等狀態變成「✓ 已同步」</strong>才算好。<br><br>這一步是硬前置：沒同步完成，初始化 Wiki 和「上正式」都會是灰的。'
      },
      {
        route: '/projects/demo',
        target: '[data-tour="pd-mapping"]',
        title: '這一步不做，任務永遠不會進來',
        text: '平台靠這裡的名稱，判斷 Odoo 和客服系統來的工單該歸到哪個專案。<br><br><strong>名稱要跟來源系統寫的一模一樣</strong>，一行一個，可以綁多個。',
        warn: '同一個來源名稱不能同時綁在兩個專案上，撞名會被擋下來並告訴你被誰用走了。'
      },
      {
        route: '/projects/demo',
        target: '[data-tour="pd-env"]',
        title: '建一個測試環境',
        text: 'AI 改完的東西會先裝進這個環境，讓你在真的畫面上驗收，確認沒問題才上正式。<br><br>建立要跑一陣子，狀態變成「運行中」之後就會出現「開啟測試區」。'
      },
      {
        route: '/projects/demo',
        target: '[data-tour="pd-tools"]',
        placement: 'bottom',
        title: '專案頁上的三個工具',
        text: '<strong>📖 Wiki</strong>：AI 讀完整個 repo 整理的知識庫，含踩過的坑（排障結論）。<br><strong>💬 Chat</strong>：排障助理，會自己去翻 wiki、程式碼、log 和正式區資料庫，聊出結論可以直接變成一張任務。<br><strong>🚀 上正式</strong>：把已核准的任務真的送上正式區，下一課會再講一次。'
      }
    ]
  },

  {
    id: 'ui',
    name: '任務介面',
    desc: '認得畫面上的東西，尤其「怎麼看出輪到我」',
    steps: [
      {
        route: '/',
        target: '[data-tour="nav-tasks"]',
        placement: 'right',
        title: '每天從這裡開始',
        text: '任務列表是預設首頁，右邊那顆數字就是<strong>還有幾件事在等你</strong>。<br><br>下面幾步用一張<strong>示範任務</strong>帶你認畫面上的訊號。'
      },
      {
        route: '/',
        target: '[data-tour="task-filters"]',
        title: '預設就幫你篩好了',
        text: '一進來停在<strong>「需回覆」</strong>分頁，列出來的都是<strong>在等你的</strong>。<br><br>數字就是還有幾件事等你處理。想看全部再切「全部」。'
      },
      {
        route: '/',
        target: '[data-tour="task-card"]',
        title: '黃色 ＝ 輪到你',
        text: '<strong>左邊一條黃線加上一顆會呼吸的黃點</strong>，就是在等你。整份清單只要掃黃色就好。<br><br>這是最該記住的一個訊號。'
      },
      {
        route: '/',
        target: '[data-tour="task-status"]',
        title: '狀態標籤',
        text: '狀態總共三十幾種，但<strong>你只要認得會停下來等人的那幾個</strong>：等待確認、等待規格確認、待你裁決、等待審核、失敗待確認。<br><br>其餘都是 AI 在跑，看看就好。'
      },
      {
        route: '/',
        target: '[data-tour="task-stepper"]',
        title: '流程走到哪一格',
        text: '從分析走到完成，打勾的是走過的，數字的還沒。<br><br>不用記每一格在幹嘛，<strong>看它有沒有在動</strong>就夠了。'
      },
      {
        route: '/',
        target: '[data-tour="task-chips"]',
        title: '卡片上的其他標記',
        text: '<strong>來源</strong>（從 Odoo 或客服系統來的，點了開原單）、<strong>專案</strong>（點了跳專案頁）、<strong>🖥 測試機</strong>（點了直接開測試環境，驗收時最常用）。'
      },
      {
        route: '/',
        target: '[data-tour="nav-pipeline"]',
        placement: 'right',
        title: '🚦 想知道現在跑到哪',
        text: '「進行中 Pipeline」列出<strong>你自己</strong>正在跑的任務，看得到目前在哪一關、已經跑多久，每三秒更新。<br><br>某張卡太久沒動時，可以在這裡按「暫停」把它停下來。',
        warn: '只看得到也只能暫停自己的任務，不會影響別人。'
      }
    ]
  },

  {
    id: 'flow',
    name: '實際流程',
    desc: '輪到你時做什麼，從建任務到上正式',
    steps: [
      {
        route: '/',
        target: '[data-tour="task-add"]',
        title: '① 任務從這裡開',
        text: 'Odoo 和客服系統的工單會自動同步進來，<strong>自己想開的就按這顆</strong>。<br><br>要填的只有三格：專案、標題、內容。',
        warn: '沒有專案可選的話，先回上一課把專案建起來。'
      },
      {
        route: '/task/demo',
        demoStatus: 'confirm_pending',
        target: '[data-tour="td-content"]',
        title: '② 用你自己的話寫',
        text: '不用寫得像規格書。<strong>把「現在什麼情況、為什麼困擾」講清楚就好</strong>，怎麼做是 AI 的事。<br><br>寫得越具體，後面反問你的次數越少。<br><br>以下都在<strong>任務詳情頁</strong>發生，這張是示範任務，怎麼看都不會影響真的資料。'
      },
      {
        route: '/task/demo',
        demoStatus: 'confirm_pending',
        target: '[data-tour="td-action"]',
        placement: 'left',
        title: '③ 回答 AI 的問題',
        text: '分析完有不確定的地方，它會停下來問你，多半是選擇題。<br><br>選項都不對就用下面那格自己補充。反過來你也可以切到<strong>「提問」</strong>先問它，問問題不會讓任務往下跑。<br><br><strong>要你動手的事永遠出現在這一段</strong>——上面是需求與對話，下面是執行紀錄。'
      },
      {
        route: '/task/demo',
        demoStatus: 'spec_review',
        target: '[data-tour="td-action"]',
        placement: 'left',
        title: '④ 看懂再按確認',
        text: '同一個位置換成了規格審核。這是動工前<strong>最後一次改方向的機會</strong>，按下去就開始寫程式了。<br><br>看不懂或覺得不對，寫在意見欄送回去，它會改完再問一次。'
      },
      {
        route: '/task/demo',
        demoStatus: 'coding_running',
        target: '[data-tour="td-events"]',
        placement: 'top',
        title: '⑤ 這段可以去忙別的',
        text: '開發、QA、部署到測試環境、跑自動測試，四關都不用你出手，動作區也換回一般留言框。<br><br>想看它在幹嘛就看這塊即時歷程。失敗它會自己重試，真的過不了才會停下來找你。'
      },
      {
        route: '/task/demo',
        demoStatus: 'review_pending',
        target: '[data-tour="td-action"]',
        placement: 'left',
        title: '⑥ 一定要實際點過再核准',
        text: '東西做好了，裝在測試環境等你看。先點上面的 <strong>🖥 測試機</strong> 進去真的操作看看，別只看程式碼變更。<br><br>不滿意就填原因退回，它會照你寫的去修；滿意才按核准。'
      },
      {
        route: '/projects',
        target: '[data-tour="proj-release"]',
        title: '⑦ 核准了還沒上線',
        text: '這是最多人誤會的地方。<strong>審核通過只是「排進待上正式」</strong>，東西還在測試區。<br><br>要真的生效，得回到<strong>專案</strong>按這顆「🚀 上正式」，那時才會合併到正式區。',
        warn: '一按會把該專案所有已核准的任務一起送上去，不能只挑其中幾張。'
      },
      {
        route: '/task/demo',
        demoStatus: 'stopped',
        target: '[data-tour="td-action"]',
        placement: 'left',
        title: '⑧ 卡住了怎麼辦',
        text: '連續失敗它會停下來，把卡在哪裡寫給你看。<br><br>你不用會修程式，<strong>把你知道的補充上去</strong>（例如「那個欄位其實叫別的名字」），送出後它會從中斷的地方接著跑。'
      },
      {
        route: '/task/demo',
        demoStatus: 'merge_conflict',
        target: '[data-tour="td-action"]',
        placement: 'left',
        title: '⑨ 合併衝突（不常遇到）',
        text: '同一個檔案，這張任務和別人都改到同一段，系統不敢自己決定。<br><br>每個檔案挑一邊即可，預設已經停在 AI 的建議上。<strong>看不懂就先用下面的追問問清楚再選</strong>，不用硬猜。'
      }
    ]
  }
];
