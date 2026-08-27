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
//   adminOnly    課程走到的路由有 requiresAdmin（報表、管理員設定）→ 非管理員連選單都不該看到
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
        text: '任務走到<strong>要你回答、要你審核</strong>的關卡會停下來等你。沒開通知，你只能自己回來看輪到你沒。<br><br><strong>現在就可以直接勾勾看</strong>，這一步沒有擋你的點擊。勾起來之後旁邊會出現<strong>「🔔 測試通知」</strong>，按一下就知道有沒有被系統或瀏覽器擋掉。',
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
        text: '貼上 Git URL 後平台會去 clone，<strong>要等狀態變成「✓ 已同步」</strong>才算好。<br><br>網址填完會自動去讀遠端分支，讓你挑<strong>主分支</strong>（讀不到就維持自動偵測）。AI 的 <code>ai-dev</code> 分支就是從這條長出來的。<br><br>這一步是硬前置：沒同步完成，初始化 Wiki 和「上正式」都會是灰的。',
        warn: '主分支「建立後不能再改」——ai-dev 已經長在那條分支上，改設定不會讓它搬家。選錯只能把 repo 移除後重新新增。'
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
        title: '專案頁上的工具列',
        text: '<strong>📖 Wiki</strong>：AI 讀完整個 repo 整理的知識庫，含踩過的坑。<br><strong>💬 Chat</strong>：排障助理，聊出結論可以直接變成一張任務。<br><strong>資料庫查詢</strong>：正式區的唯讀連線，設好之後 AI 也會用它去查。<br><strong>🚀 上正式</strong>：把已核准的任務真的送上正式區。<br><strong>🛠 自動部署 SOP</strong>：想把「上正式」接成推上去就自動部署時照著這頁做，指令已經幫你填好值。<br><br>Wiki、Chat、資料庫查詢各有一課，接下來就是。'
      }
    ]
  },

  {
    id: 'wiki',
    name: 'Wiki 知識庫',
    desc: '專案備註、概論、疑難排解各是什麼',
    steps: [
      {
        route: '/projects/demo/wiki/notes',
        target: '[data-tour="wiki-tree"]',
        placement: 'right',
        title: 'Wiki 是 AI 和你共用的說明書',
        text: '左邊這棵樹分四種頁，圖示就是分類：<br><br>📝 <strong>專案備註</strong>（你自己寫）　🏠 <strong>專案概論</strong>　📁 <strong>模組頁</strong>　🔧 <strong>疑難排解</strong><br><br>除了備註，其餘都是 AI 讀完整個 repo 產出的，單頁可以按 ⟳ 重新生成。'
      },
      {
        route: '/projects/demo/wiki/notes',
        target: '[data-tour="wiki-node-notes"]',
        placement: 'right',
        title: '📝 專案備註 — 最該花時間的一頁',
        text: '整個 Wiki 只有這一頁是<strong>人工維護</strong>的，也只有這一頁不會被 AI 覆寫。<br><br>關鍵在於：<strong>這裡的內容會自動注入每一個開發關卡</strong>，分析、開發、QA 都會先讀它並優先遵循。等於是你對 AI 下的常駐規則。'
      },
      {
        route: '/projects/demo/wiki/notes',
        target: '[data-tour="wiki-content"]',
        placement: 'left',
        title: '備註要寫什麼',
        text: '寫<strong>「AI 自己看程式碼看不出來」</strong>的事：維護時段、不能亂改的欄位格式、客戶的特殊慣例、聯絡窗口。<br><br>踩過一次的雷寫上去，之後每張任務都會自動避開，比每次在需求裡重講一遍有效。',
        warn: '不要把規格寫在這裡。這頁是長期有效的約束，單張任務的需求請寫在任務內容。'
      },
      {
        route: '/projects/demo/wiki/overview',
        target: '[data-tour="wiki-content"]',
        placement: 'left',
        title: '🏠 專案概論 — 先看這頁',
        text: '接手一個不熟的專案時從這頁開始：有哪些模組、跟外部系統怎麼串、資料怎麼流。<br><br>由 AI 讀完整個 repo 產出，程式改很多之後可以按 ⟳ 重新生成。<strong>看到跟程式碼對不上就重生成，不要將就。</strong>'
      },
      {
        route: '/projects/demo/wiki/troubleshooting',
        target: '[data-tour="wiki-content"]',
        placement: 'left',
        title: '🔧 疑難排解 — 會自己長大的一頁',
        text: '這頁不用你寫。<strong>每次在 Chat 裡釐清出一個結論，AI 就會自動把它累積到這裡</strong>，下次遇到同樣症狀就查得到。<br><br>所以在 Chat 問問題不只是當下有答案，是在幫整個團隊存經驗。'
      }
    ]
  },

  {
    id: 'chat',
    name: 'Chat 與轉任務',
    desc: '先問清楚再開單，聊出結論直接變任務',
    steps: [
      {
        route: '/projects/demo/chat/demo',
        target: '[data-tour="chat-list"]',
        placement: 'right',
        title: '不確定該不該開任務時，先來這裡',
        text: 'Chat 是<strong>專案排障助理</strong>，每個專案各自一組對話，左邊可以開很多條、各聊各的。<br><br>問它不會建立任何任務、不會改到程式，純粹查清楚狀況。'
      },
      {
        route: '/projects/demo/chat/demo',
        target: '[data-tour="chat-messages"]',
        placement: 'left',
        title: '它會自己去查，不會叫你回去看',
        text: '回答之前它會依問題性質自己挑來源：<strong>Wiki、專案程式碼、測試區 log、正式區資料庫</strong>。<br><br>所以「是不是我權限不夠？」這種問題它查得出來，不用你先自己判斷。',
        warn: '要它查得到正式區的資料，那個專案得先設好資料庫連線（專案頁的「資料庫查詢」）——「資料庫查詢」那一課會帶你設。'
      },
      {
        route: '/projects/demo/chat/demo',
        target: '[data-tour="chat-input"]',
        placement: 'top',
        title: '用講的就好，畫面問題就貼圖',
        text: '描述<strong>症狀和情境</strong>，不用先想好是哪個模組的問題。<br><br>例如「維修單的成本沒有帶出來，只有部分單有」——它會自己去比對哪幾張不一樣。<br><br>畫面上看到的東西<strong>直接 Ctrl+V 貼上截圖</strong>（或按 📎），一次最多 5 張。在圖上圈起來，比用文字描述位置快得多。'
      },
      {
        route: '/projects/demo/chat/demo',
        target: '[data-tour="chat-totask"]',
        title: '＋ 轉為任務 — 這一課的重點',
        text: '聊到結論是「這個要改程式」時，<strong>不要另外開分頁重打一次需求</strong>。按這顆，AI 會把整段對話摘要成一張任務草稿。<br><br>對話裡釐清過的細節都會被帶進去，AI 後面反問你的次數因此少很多。'
      },
      {
        route: '/projects/demo/chat/demo',
        click: '[data-tour="chat-totask"]',
        target: '[data-tour="chat-modal"]',
        title: '草稿是可以改的，確認才建立',
        text: '摘要出來的<strong>標題和內容都能直接編輯</strong>，按下「建立」之前不會有任何任務產生。<br><br>對話裡貼過的圖也會列在下面，<strong>已勾選的是 AI 判斷後續開發需要看的</strong>，可以自己增減。<br><br>建好的任務會自動掛在這個專案底下，下一輪 pipeline 就會開始分診。'
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
        text: '第一次進來停在<strong>「需回覆」</strong>分頁，列出來的都是<strong>在等你的</strong>，數字就是還有幾件。<br><br>另外四個分頁是<strong>待處理</strong>（AI 正在跑）、<strong>暫停中</strong>、<strong>全部</strong>、<strong>已封存</strong>。',
        warn: '分頁與下一步那排篩選都會記在這台瀏覽器，下次打開停在你上次看的地方——不是每次都回到「需回覆」。覺得列表空空的，先看一眼篩選還開著什麼。'
      },
      {
        route: '/',
        // 手機上這排是 display:none（收在「篩選」鈕後面），不先點開就找不到目標；
        // 桌機恆為可見，引擎的 click 只在目標不可見時才動，故兩邊共用同一步。
        click: '[data-tour="task-filters-toggle"]',
        target: '[data-tour="task-filters-more"]',
        title: '找特定一張時用這排',
        text: '專案、狀態、來源、是否已上正式，加上搜尋與排序。<strong>幾個條件是疊加的</strong>，找不到東西通常是這裡還開著上次的條件。<br><br>常用的組合按<strong>「＋ 存成組合」</strong>取個名字存起來，之後一鍵套用；這個是存在帳號上的，換一台電腦登入也還在。',
        warn: '手機上這一排收在分頁列最右邊的「篩選」鈕後面，鈕上的數字是目前生效幾個條件。'
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
        text: '分析完有不確定的地方，它會停下來問你，多半是選擇題。推導得出依據的題目會標上<strong>「建議」</strong>；標了 <strong>⚠ 選錯難改</strong> 的那幾題請多看一眼，選錯要退回重寫規格與程式。<br><br>選項都不對就用下面那格自己補充，<strong>也可以直接附圖</strong>。反過來你也可以切到<strong>「提問」</strong>先問它，問問題不會讓任務往下跑。<br><br><strong>要你動手的事永遠出現在這一段</strong>——上面是需求與對話，下面是執行紀錄。'
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
        text: '東西做好了，裝在測試環境等你看。先點上面的 <strong>🖥 測試機</strong> 進去真的操作看看，別只看程式碼變更。<br><br>不滿意就填原因退回，它會照你寫的去修；滿意才按核准。',
        warn: '版面、顏色、位置這類畫面問題請附截圖（退回框下方可選，最多 5 張）——下游那幾關只讀得到程式碼 diff，看不到畫面，光用文字描述位置常常修錯地方。'
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
        text: '連續失敗它會停下來，把卡在哪裡寫給你看。<br><br>你不用會修程式，<strong>把你知道的補充上去</strong>（例如「那個欄位其實叫別的名字」），送出後它會從中斷的地方接著跑。<br><br>若情況剛好是<strong>「碼我自己改好了」「環境已排除」「這是誤判」</strong>這三種，直接按上面對應的按鈕——它會把話填成系統聽得懂的句子，你再接著補自己的說明。',
        warn: '這一格不要寫散文。自己打「推進到 QA」會被判成「還要再修」，繞回來白跑一輪。用按鈕填好再補充最省事。'
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
  },

  {
    id: 'track',
    name: '進度與通知',
    desc: '不在電腦前的那段時間，發生過什麼',
    steps: [
      {
        route: '/admin/pipelines',
        target: '[data-tour="nav-pipeline"]',
        placement: 'right',
        title: '🚦 想知道此刻跑到哪',
        text: '「進行中 Pipeline」列出<strong>你自己</strong>正在跑的任務，看得到目前在哪一關、已經跑多久，每三秒更新。<br><br>某張卡太久沒動時，可以在這裡按「暫停」把它停下來。',
        warn: '只看得到也只能暫停自己的任務，不會影響別人。'
      },
      {
        route: '/pipeline-flow',
        target: '[data-tour="flow-diagram"]',
        placement: 'top',
        title: '🗺️ 流程圖 — 一張任務總共會經過哪些關',
        text: '想知道「等待審核」後面還有什麼、被退回會退到哪一關，來這頁看。<strong>滑鼠移到任一關會打亮它與相鄰的路徑</strong>，右側顯示那一關在做什麼。<br><br>下面那排開關是<strong>推演用</strong>的，只改這張圖，不會動到任何專案的設定。',
        warn: '旁邊的「🏗️ 架構圖」畫的是另一件事——哪個東西跑在哪台機器、哪個容器裡，對外介紹時用得到。'
      }
    ]
  },

  {
    id: 'db',
    name: '資料庫查詢',
    desc: 'VPN、連線設定與唯讀查詢',
    steps: [
      {
        route: '/projects/demo/db',
        target: '[data-tour="db-conns"]',
        title: '這一頁設不設，差別很大',
        text: '這裡登記的是<strong>正式區資料庫的唯讀連線</strong>，每個人都能設、也都能用。設好之後有兩個用處：<br><br>① 你自己可以在下面直接下 SQL 查正式區資料，不用去麻煩 MIS。<br>② <strong>更重要的是 — Chat 和客服分診的 AI 會用它去查正式區</strong>。沒設，AI 遇到「這張單的金額為什麼是空的」就只能回你「我查不到資料」。',
        warn: '一個專案可以登記多組連線（正式、備援、不同客戶各一組）。'
      },
      {
        route: '/projects/demo/db',
        target: '[data-tour="db-vpn"]',
        title: '要穿 VPN 才連得到的話，設在這裡',
        text: '很多客戶的資料庫只開在內網。把 <strong>.ovpn 設定檔</strong>連同帳密上傳到這裡就好。<br><br><strong>一個專案共用一組 VPN</strong>：下面每一組連線各自勾「此連線需要 VPN」，它們會共用同一條隧道，只撥號一次，不會每查一次就重連。',
        warn: '部分廠牌的 SSLVPN GUI 會把帳密混淆後藏在設定檔註解裡；上傳時系統會自動還原並代填，存檔前確認一下帳號對不對。'
      },
      {
        route: '/projects/demo/db',
        target: '[data-tour="db-form"]',
        title: '三種連線模式，挑一個',
        text: '<strong>docker</strong>：SSH 進主機、再進 DB 容器下指令（最常見，Odoo 多半這樣裝）。<br><strong>local</strong>：SSH 進主機、用 sudo 切成 DB 使用者。<br><strong>direct</strong>：直接連 TCP 埠（要對方開放，支援 PostgreSQL／MSSQL／MySQL）。<br><br>填完先按<strong>「測試連線」</strong>再存——存了才發現連不上，AI 那邊也會跟著查不到。<br><br>存好之後再按一次<strong>「偵測 log 來源」</strong>：AI 排障時就讀得到那台機器的 Odoo log，錯誤訊息不必你自己貼。',
        warn: 'direct 模式不經 SSH，讀不到主機上的 log，這一項會是空的。'
      },
      {
        route: '/projects/demo/db',
        target: '[data-tour="db-query"]',
        placement: 'top',
        title: '只允許 SELECT',
        text: '選連線、貼 SQL、按執行就好。<strong>後端只放行 SELECT，寫入類語句一律擋下</strong>，所以不用擔心手滑改到正式資料。<br><br>查出來的欄位直接以表格呈現，適合拿來核對「畫面上看到的和資料庫裡存的是不是同一回事」。'
      },
      {
        route: '/projects/demo/chat/demo',
        target: '[data-tour="chat-messages"]',
        placement: 'left',
        title: '設好之後，AI 就變得不一樣',
        text: '回到 Chat：剛才那組連線設好了，AI 在回答之前就會<strong>自己去正式區把資料撈出來核對</strong>，而不是照著程式碼猜。<br><br>同一個問題，有沒有設連線，答案的可信度差很多。<strong>建議每個專案都設一組唯讀連線。</strong>'
      }
    ]
  },

  {
    id: 'admin',
    name: '報表與管理員設定',
    desc: '看用量花在哪，以及全站設定',
    adminOnly: true,
    steps: [
      {
        route: '/token-report',
        target: '[data-tour="tr-filters"]',
        title: '用量報表：先框範圍',
        text: '預設看最近 30 天。可以再依<strong>專案</strong>或<strong>單一任務 ID</strong> 收斂，改完按「查詢」。<br><br>查單一任務 ID 最常用——某張卡花特別多的時候，用它把那張攤開看是哪一關燒掉的。'
      },
      {
        route: '/token-report',
        target: '[data-tour="tr-summary"]',
        title: '七張卡裡最該看的是最後一張',
        text: '「<strong>每張交付成本</strong>」＝期間總花費 ÷ 完成任務數。這是唯一會隨流程好壞變動的數字。<br><br>它變高通常不是模型變貴，是<strong>任務在關卡之間彈跳</strong>（QA 退回、部署失敗重試）。總 Token 數看起來嚇人但沒有意義，要看實際 Token 數與花費。'
      },
      {
        route: '/token-report',
        target: '[data-tour="tr-charts"]',
        title: '花在哪一關、哪個專案',
        text: '三張圓餅分別是 <strong>Agent 類型／專案／使用者</strong>，點一下可以放大。右邊折線是每日趨勢。<br><br>某個 agent 的占比突然變大，通常代表那一關的提示詞該調了——可以到「管理員 → 工作流程健檢」讓 AI 分析。'
      },
      {
        route: '/token-report',
        target: '[data-tour="tr-tasks"]',
        placement: 'top',
        title: '明細：抓出那幾張異常的',
        text: '逐張列出花費，展開可以看到<strong>每一關各花多少</strong>。<br><br>排在最前面的那幾張就是燒最多的，點進去看它彈跳了幾次，多半能找到規格沒寫清楚或環境有問題。'
      },
      {
        route: '/admin',
        target: '[data-tour="admin-conn"]',
        title: '管理員設定：全公司共用的部分',
        text: 'Odoo 與 eService 的<strong>伺服器位址、資料庫名稱、同步間隔</strong>設在這裡，全站共用一份。<br><br>個人的帳號密碼不在這裡——那是每個人自己到「個人設定」填的。同步間隔填 0 就是停用自動同步。'
      },
      {
        route: '/admin',
        target: '[data-tour="admin-gate"]',
        title: '用量閘門 — 別讓額度一次燒光',
        text: '全台共用同一個 Claude 帳號。用量達門檻時，這道閘門會<strong>自動停止 Pipeline 自動推進</strong>，但手動按「繼續」不受影響。<br><br>5 小時視窗或本週任一超標就暫停，兩個門檻可以各自調。',
        warn: '沒有用量資料時採 fail-open（不擋），不會因為讀不到數字就把整條線停掉。'
      },
      {
        route: '/admin',
        target: '[data-tour="admin-token"]',
        title: 'Claude 憑證 — 建議一定要設',
        text: '在任一台裝有 Claude Code 的機器跑 <code>claude setup-token</code>，把產生的長效 token 貼進來即可（綁訂閱、不另計費，效期一年）。<br><br><strong>不設的話會用伺服器本機的登入憑證，多個任務並行時會互相踩到刷新中的憑證，造成任務無故中斷。</strong>換帳號只要貼新的 token，不必重啟伺服器。<br><br>下面還有一格<strong>備用憑證</strong>：主帳號用量撞到上面那道閘門時，開啟開關就改用它繼續跑，主帳號降回門檻下自動切回。',
        warn: '備用 token 務必用另一個帳號產生。同一個帳號的第二把 token 共用同一份用量，切過去照樣是超標狀態。'
      },
      {
        route: '/admin',
        target: '[data-tour="admin-tools"]',
        placement: 'top',
        title: '其他管理工具',
        text: '常用的三個：<strong>使用者管理</strong>（開帳號、給權限）、<strong>Agent 管理</strong>（調各關的模型與提示詞）、<strong>工作流程健檢</strong>（讓 AI 分析近期表現並建議改提示詞）。<br><br>其餘是排查用的：退回原因、失敗分類樣本、Prompt 送出記錄、測試區 port 池、企業版來源。'
      }
    ]
  }
];
