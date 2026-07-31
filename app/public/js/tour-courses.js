// 教程的仿製畫面與文案。
// ⚠ 這支是「會漂移」的那一支：改了 Settings.js／ProjectDetail.js 等版面或文案，
//   要回來同步。漂移沒有任何自動訊號（測試不紅、console 不叫、教程照跑），只會教到舊介面。
window.TOUR_COURSES = [
  {
    id: 'setup',
    name: '初始設定',
    desc: '補回註冊時略過的設定',
    screenTitle: '個人設定',
    screen: `
      <div class="tour-block" data-step="appearance">
        <div class="tour-block-title">外觀與通知</div>
        <div class="tour-block-desc">深色模式、桌面通知</div>
        <label class="tour-check" data-step="dark" style="margin-bottom:var(--space-3)">
          <input type="checkbox" class="tour-checkbox" /><span>深色模式</span>
        </label>
        <div data-step="notify">
          <label class="tour-check">
            <input type="checkbox" class="tour-checkbox" /><span>桌面通知（有任務需要你處理時提醒）</span>
          </label>
          <div class="tour-sub">開啟後瀏覽器會請求通知權限；需保持至少一個分頁開著才能收到。</div>
        </div>
      </div>

      <div class="tour-block">
        <div class="tour-block-title">帳號與密碼</div>
        <div class="tour-block-desc">顯示名稱、變更密碼</div>
        <div class="tour-cols">
          <div class="tour-field">
            <label class="tour-label">帳號</label>
            <input class="tour-input" value="your-account" disabled />
          </div>
          <div class="tour-field">
            <label class="tour-label">顯示名稱</label>
            <input class="tour-input" placeholder="你的名字" />
          </div>
        </div>
      </div>

      <div class="tour-block" data-step="github">
        <div class="tour-block-title">GitHub 認證</div>
        <div class="tour-block-desc">個人 GitHub Personal Access Token，供你的任務推送程式碼使用。</div>
        <div class="tour-alert">尚未設定個人 GitHub PAT——你的任務將被擋下，請先設定。</div>
        <div class="tour-guide">
          <b>如何取得 PAT：</b>
          <ol class="tour-guide-list">
            <li>GitHub → 右上頭像 → <b>Settings</b> → 左側最底 <b>Developer settings</b></li>
            <li><b>Personal access tokens → Tokens (classic) → Generate new token</b></li>
            <li><b>Scopes</b> 勾 <code>repo</code>，<b>Expiration</b> 建議 90 天以上</li>
            <li>複製那串 <code>ghp_...</code>（<b>只會顯示一次</b>）</li>
          </ol>
          <a class="tour-guide-link" href="https://github.com/settings/tokens/new?scopes=repo&description=aidev-platform" target="_blank" rel="noopener">↗ 開啟 GitHub 建立權杖頁（已預帶 repo 權限與名稱）</a>
        </div>
        <div class="tour-field">
          <input class="tour-input" type="password" placeholder="貼上 GitHub Personal Access Token" />
        </div>
        <button class="tour-save" type="button">儲存 PAT</button>
      </div>

      <div class="tour-block" data-step="odoo">
        <div class="tour-block-title">Odoo 帳號</div>
        <div class="tour-block-desc">Odoo 伺服器位址由管理員統一設定，此處填寫你的個人登入憑證。</div>
        <div class="tour-cols">
          <div class="tour-field">
            <label class="tour-label">登入帳號</label>
            <input class="tour-input" placeholder="admin" />
          </div>
          <div class="tour-field">
            <label class="tour-label">密碼</label>
            <input class="tour-input" type="password" placeholder="••••••" />
          </div>
        </div>
        <div class="tour-field" style="max-width:330px">
          <label class="tour-label">使用者 ID（任務負責人篩選）</label>
          <div style="display:flex;gap:var(--space-2)">
            <input class="tour-input" placeholder="點擊驗證自動取得" />
            <button class="tour-save is-outline" type="button" style="white-space:nowrap">驗證取得</button>
          </div>
        </div>
      </div>

      <div class="tour-block">
        <div class="tour-block-title">eService 帳號</div>
        <div class="tour-block-desc">客服系統帳號，用於同步你負責的客服工單。</div>
        <div class="tour-cols">
          <div class="tour-field">
            <label class="tour-label">登入帳號</label>
            <input class="tour-input" placeholder="你的 eService 帳號" />
          </div>
          <div class="tour-field">
            <label class="tour-label">密碼</label>
            <input class="tour-input" type="password" placeholder="••••••" />
          </div>
        </div>
      </div>
    `,
    steps: [
      {
        target: null,
        title: '把註冊時略過的補完',
        text: '註冊精靈那幾步都可以按「略過」，多數人也真的略過了。<strong>這一課帶你把它們補上，大概一分鐘。</strong><br><br>下面是練習用的設定頁，怎麼點都不會真的存檔。',
        next: '開始'
      },
      {
        target: '[data-step="github"]',
        title: '這一項不設，任務會卡住',
        text: 'AI 寫完程式要<strong>用你的身分</strong>推上 GitHub。沒給權杖，任務就停在這裡不動。<br><br>照卡片裡四個步驟做，或直接點<strong>「↗ 開啟 GitHub 建立權杖頁」</strong>——網址已經預帶好 <strong>repo</strong> 權限。',
        next: '下一項'
      },
      {
        target: '[data-step="odoo"]',
        title: 'Odoo 與 eService 帳號',
        text: '這兩組是拿來<strong>把你負責的工單自動同步進來</strong>的，任務列表才認得出哪些該歸你。<br><br>填完按「驗證取得」，使用者 ID 會自動帶出來。<strong>沒在用這兩個系統就跳過。</strong>',
        next: '下一項'
      },
      {
        target: '[data-step="notify"]',
        title: '桌面通知 — 最值得開的一個',
        text: '任務走到<strong>要你回答、要你審核</strong>的關卡會停下來等你。沒開通知，你只能自己回來看輪到你沒。<br><br><strong>現在就可以勾勾看</strong>，蓋板不會擋住你的點擊。',
        warn: '兩個容易踩的坑：<strong>分頁要留著</strong>（整個瀏覽器關掉就收不到），而且這設定<strong>只記在這台電腦的這個瀏覽器</strong>，換一台要再開一次。',
        next: '最後一項'
      },
      {
        target: '[data-step="dark"]',
        title: '深色模式',
        text: '純看個人喜好，勾了立刻換，隨時改回來。<br><br>初始設定就這些。下一課帶你建立第一個專案。',
        next: '完成這一課'
      }
    ]
  },

  {
    id: 'project',
    name: '專案設定與工具',
    desc: '從無到有把專案跑起來，以及專案頁上的工具',
    screenTitle: '專案設定',
    screen: `
      <div class="tour-block" data-step="create">
        <div class="tour-block-title">新增專案</div>
        <div class="tour-block-desc">專案是一切的容器：repo、測試環境、任務都掛在它底下。</div>
        <div class="tour-cols">
          <div class="tour-field">
            <label class="tour-label">專案名稱</label>
            <input class="tour-input" value="鴻久維修" />
          </div>
          <div class="tour-field">
            <label class="tour-label">Odoo 版本</label>
            <input class="tour-input" value="17.0" />
          </div>
        </div>
        <div class="tour-field">
          <label class="tour-label">英文資料夾名稱</label>
          <input class="tour-input" value="hongjiu" />
          <div class="tour-sub">專案名稱是中文時<b>必填</b>，資料夾與測試資料庫都用它命名。</div>
        </div>
      </div>

      <div class="tour-block" data-step="repo">
        <div class="tour-block-title">Git Repositories</div>
        <div class="tour-block-desc">AI 要改的程式碼從這裡來。</div>
        <div style="display:flex;align-items:center;gap:var(--space-2);margin-bottom:var(--space-3)">
          <b style="font-size:var(--fs-base)">主要 addons</b>
          <span class="tour-sub" style="margin:0">github.com/your-org/odoo-addons</span>
          <span class="tour-save is-outline" style="cursor:default">✓ 已同步</span>
        </div>
        <div class="tour-cols">
          <div class="tour-field">
            <label class="tour-label">標籤</label>
            <input class="tour-input" placeholder="例如 addons" />
          </div>
          <div class="tour-field">
            <label class="tour-label">Git URL</label>
            <input class="tour-input" placeholder="https://github.com/..." />
          </div>
        </div>
        <button class="tour-save" type="button">+ 新增 Repo</button>
      </div>

      <div class="tour-block" data-step="mapping">
        <div class="tour-block-title">同步來源對應</div>
        <div class="tour-block-desc">一行一個名稱，可綁定多個來源。</div>
        <div class="tour-field">
          <label class="tour-label">Odoo 專案名稱（同步時自動綁定）</label>
          <input class="tour-input" placeholder="與 Odoo ERP 的專案名稱完全一致" />
        </div>
        <div class="tour-field">
          <label class="tour-label">客服來源名稱（Service 同步時自動綁定）</label>
          <input class="tour-input" placeholder="與 eService 的 respondent 名稱完全一致" />
        </div>
        <button class="tour-save" type="button">儲存對應</button>
      </div>

      <div class="tour-block" data-step="env">
        <div class="tour-block-title">Odoo 測試環境</div>
        <div class="tour-block-desc">AI 改完的東西會先裝在這裡給你驗收。</div>
        <div class="tour-sub" style="margin:0 0 var(--space-3)">狀態：尚未建立</div>
        <button class="tour-save" type="button">一鍵建立環境</button>
      </div>

      <div class="tour-block" data-step="wiki">
        <div class="tour-block-title">📖 Wiki</div>
        <div class="tour-block-desc">AI 讀完整個 repo 後整理的專案知識庫。</div>
        <div class="tour-sub" style="margin:0">🏠 專案概論　📁 模組頁　📝 筆記　🔧 排障結論</div>
      </div>

      <div class="tour-block" data-step="chat">
        <div class="tour-block-title">💬 Chat</div>
        <div class="tour-block-desc">專案排障助理，會自己去翻 wiki、程式碼、log 和正式區資料庫。</div>
        <div class="tour-field">
          <input class="tour-input" placeholder="例如：為什麼維修單的成本沒有帶出來？" />
        </div>
        <button class="tour-save is-outline" type="button">把這段對話變成一張任務</button>
      </div>
    `,
    steps: [
      {
        target: '[data-step="create"]',
        title: '先建一個專案',
        text: '專案是容器，repo、測試環境、任務全掛在它底下。<br><br><strong>專案名稱用中文時，英文資料夾名稱是必填的</strong>——這是最多人卡住的地方。',
        next: '下一步'
      },
      {
        target: '[data-step="repo"]',
        title: '接上程式碼來源',
        text: '貼上 Git URL 後平台會去 clone，<strong>要等狀態變成「✓ 已同步」</strong>才算好。<br><br>這一步是硬前置：沒同步完成，初始化 Wiki 和「上正式」都會是灰的。',
        next: '下一步'
      },
      {
        target: '[data-step="mapping"]',
        title: '這一步不做，任務永遠不會進來',
        text: '平台靠這裡的名稱，判斷 Odoo 和客服系統來的工單該歸到哪個專案。<br><br><strong>名稱要跟來源系統寫的一模一樣</strong>，一行一個，可以綁多個。',
        warn: '同一個來源名稱<strong>不能同時綁在兩個專案</strong>上，撞名會擋下來並告訴你被誰用走了。',
        next: '下一步'
      },
      {
        target: '[data-step="env"]',
        title: '建一個測試環境',
        text: 'AI 改完的東西會先裝進這個環境，讓你在真的畫面上驗收，確認沒問題才上正式。<br><br>建立要跑一陣子，狀態變成執行中之後就會出現「開啟測試區」。',
        next: '下一步'
      },
      {
        target: '[data-step="wiki"]',
        title: '📖 Wiki：專案的說明書',
        text: 'AI 讀完整個 repo 幫你整理的知識庫，分成概論、各模組、筆記，還有<strong>排障結論</strong>——踩過的坑會累積在那裡。<br><br>單頁可以按 ⟳ 重新生成；專案還沒有的話按「🔄 初始化 Wiki」。',
        next: '最後一項'
      },
      {
        target: '[data-step="chat"]',
        title: '💬 Chat：問問題的地方',
        text: '不確定該不該開任務、想先搞懂狀況時用這個。它會自己去翻 wiki、程式碼、log 和正式區資料庫。<br><br><strong>聊出結論後可以直接把對話變成一張任務</strong>，不用自己重寫一遍需求。<br><br>專案頁最右邊還有「🚀 上正式」，下一課會講。',
        next: '完成這一課'
      }
    ]
  }

  ,{
    id: 'ui',
    name: '任務介面',
    desc: '認得畫面上的東西，尤其「怎麼看出輪到我」',
    screenTitle: '任務列表',
    screen: `
      <div class="tour-block" data-step="tabs" style="display:flex;gap:var(--space-2);align-items:center">
        <span class="tour-save" style="cursor:default">需回覆 <b>2</b></span>
        <span class="tour-save is-outline" style="cursor:default">待處理 5</span>
        <span class="tour-save is-outline" style="cursor:default">暫停中 0</span>
        <span class="tour-save is-outline" style="cursor:default">全部 31</span>
      </div>

      <div class="tour-block" data-step="card-wait" style="border-left:3px solid var(--warning)">
        <div style="display:flex;align-items:center;gap:var(--space-2)">
          <span class="tour-block-title">維修單新增備註欄位</span>
          <span style="width:8px;height:8px;border-radius:50%;background:var(--warning);display:inline-block"></span>
        </div>
        <div data-step="badges" style="margin:var(--space-2) 0">
          <span class="tour-save" style="cursor:default">等待確認</span>
          <span class="tour-sub" style="margin:0 0 0 var(--space-2)">輪到你回答</span>
        </div>
        <div data-step="stepper" class="tour-sub" style="margin:0">
          分析 ●──● 確認 ──○ 開發 ──○ QA ──○ 部署 ──○ 測試 ──○ 審核 ──○ 完成
        </div>
        <div data-step="chips" style="margin-top:var(--space-2)">
          <span class="tour-save is-outline" style="cursor:default">Odoo 工單</span>
          <span class="tour-save is-outline" style="cursor:default">鴻久維修</span>
          <span class="tour-save is-outline" style="cursor:default">🖥 測試機</span>
        </div>
      </div>

      <div class="tour-block">
        <div class="tour-block-title">銷售報表加上月份篩選</div>
        <div class="tour-sub" style="margin:var(--space-2) 0 0">
          <span class="tour-save is-outline" style="cursor:default">開發中</span>　AI 正在做，不用管
        </div>
      </div>

      <div class="tour-block" data-step="detail">
        <div class="tour-block-title">點進任務之後</div>
        <div class="tour-block-desc">由上往下固定是這四段。</div>
        <div class="tour-sub" style="margin:0;line-height:2">
          ① 需求內容　→　② 對話紀錄　→　<b style="color:var(--primary)">③ 要你動手的區域</b>　→　④ 即時歷程
        </div>
      </div>

      <div class="tour-block" data-step="pipeline">
        <div class="tour-block-title">🚦 進行中 Pipeline</div>
        <div class="tour-block-desc">側邊欄第三個連結。</div>
        <div class="tour-sub" style="margin:0">
          維修單新增備註欄位　·　開發中　·　已跑 4m 12s　　<span class="tour-save is-outline" style="cursor:default">暫停</span>
        </div>
      </div>
    `,
    steps: [
      {
        target: '[data-step="tabs"]',
        title: '預設就幫你篩好了',
        text: '一進來停在<strong>「需回覆」</strong>分頁，列出來的都是<strong>在等你的</strong>。<br><br>數字就是還有幾件事等你處理。想看全部再切「全部」。',
        next: '下一個'
      },
      {
        target: '[data-step="card-wait"]',
        title: '黃色 ＝ 輪到你',
        text: '<strong>左邊一條黃線加上一顆會呼吸的黃點</strong>，就是在等你。整份清單只要掃黃色就好。<br><br>這是最該記住的一個訊號。',
        next: '下一個'
      },
      {
        target: '[data-step="badges"]',
        title: '狀態標籤',
        text: '狀態總共三十幾種，但<strong>你只要認得會停下來等人的那幾個</strong>：等待確認、等待規格確認、待你裁決、等待審核、失敗待確認。<br><br>其餘都是 AI 在跑，看看就好。',
        next: '下一個'
      },
      {
        target: '[data-step="stepper"]',
        title: '流程走到哪一格',
        text: '八格從分析走到完成，實心的是走過的，空心的還沒。<br><br>不用記每一格在幹嘛，<strong>看它有沒有在動</strong>就夠了。',
        next: '下一個'
      },
      {
        target: '[data-step="detail"]',
        title: '任務詳情的四段',
        text: '點進任務後由上往下固定是這四段。<br><br><strong>第三段是會變的</strong>——輪到你回答問題、確認規格、或驗收的時候，該做的事就出現在那裡。其他時候那裡是留言框。',
        next: '下一個'
      },
      {
        target: '[data-step="chips"]',
        title: '卡片上的其他標記',
        text: '<strong>來源</strong>（從 Odoo 或客服系統來的，點了開原單）、<strong>專案</strong>（點了跳專案頁）、<strong>🖥 測試機</strong>（點了直接開測試環境，驗收時最常用）。',
        next: '最後一個'
      },
      {
        target: '[data-step="pipeline"]',
        title: '🚦 想知道現在跑到哪',
        text: '側邊欄的「進行中 Pipeline」列出<strong>你自己</strong>正在跑的任務，看得到目前在哪一關、已經跑多久，每三秒更新。<br><br>某張卡太久沒動時，可以在這裡按「暫停」把它停下來。',
        warn: '只看得到也只能暫停<strong>自己的</strong>任務，不會影響別人。',
        next: '完成這一課'
      }
    ]
  },

  {
    id: 'flow',
    name: '實際流程',
    desc: '輪到你時做什麼，從建任務到上正式',
    screenTitle: '一條任務的一生',
    screen: `
      <div class="tour-block" data-step="create">
        <div class="tour-block-title">① 新增任務</div>
        <div class="tour-field">
          <label class="tour-label">專案</label>
          <input class="tour-input" value="鴻久維修" />
        </div>
        <div class="tour-field">
          <label class="tour-label">標題</label>
          <input class="tour-input" value="維修單要能填備註" />
        </div>
        <div class="tour-field">
          <label class="tour-label">內容</label>
          <input class="tour-input" value="維修單填不了備註，師傅回來要另外用紙條交代，常常漏掉。" />
        </div>
      </div>

      <div class="tour-block" data-step="clarify">
        <div class="tour-block-title">② AI 反問你</div>
        <div class="tour-block-desc">分析完覺得有不確定的地方，會停下來問。</div>
        <div class="tour-sub" style="margin:0 0 var(--space-2)">備註要讓誰看得到？</div>
        <div class="tour-cols">
          <span class="tour-save is-outline" style="cursor:default">只有內部</span>
          <span class="tour-save is-outline" style="cursor:default">客戶也看得到</span>
          <span class="tour-save is-outline" style="cursor:default">都不合適</span>
        </div>
      </div>

      <div class="tour-block" data-step="spec">
        <div class="tour-block-title">③ 確認規格</div>
        <div class="tour-block-desc">AI 把要做的事寫成規格給你過目。</div>
        <div class="tour-sub" style="margin:0 0 var(--space-3)">在維修單加一個備註欄，僅內部可見，列印時不帶出。</div>
        <button class="tour-save is-outline" type="button">送出意見</button>
        <button class="tour-save" type="button">✓ 確認沒問題，開始實作</button>
      </div>

      <div class="tour-block" data-step="waiting">
        <div class="tour-block-title">④ 開發 → QA → 部署 → 測試</div>
        <div class="tour-block-desc">這四關不用你出手。</div>
        <div class="tour-sub" style="margin:0">出錯的話它會自己重試，真的過不了才會停下來找你。</div>
      </div>

      <div class="tour-block" data-step="review">
        <div class="tour-block-title">⑤ 驗收</div>
        <div class="tour-block-desc">東西做好了，裝在測試環境等你看。</div>
        <div class="tour-sub" style="margin:0 0 var(--space-3)">先點卡片上的 <b>🖥 測試機</b> 進去實際操作看看。</div>
        <div class="tour-field">
          <input class="tour-input" placeholder="不滿意的話，寫下哪裡要改" />
        </div>
        <button class="tour-save is-outline" type="button">確認退回，回開發依原因修正</button>
        <button class="tour-save" type="button">✓ 審核通過，納入待上正式</button>
      </div>

      <div class="tour-block" data-step="release">
        <div class="tour-block-title">⑥ 上正式</div>
        <div class="tour-alert">審核通過 ≠ 已經上線。</div>
        <div class="tour-sub" style="margin:0">要到<b>專案頁</b>按「🚀 上正式」，才會真的進到正式區。</div>
      </div>

      <div class="tour-block" data-step="stopped">
        <div class="tour-block-title">⑦ 失敗待確認</div>
        <div class="tour-alert">連續失敗，需要人工介入。</div>
        <div class="tour-field">
          <input class="tour-input" placeholder="寫下你的判斷或補充資訊" />
        </div>
        <button class="tour-save" type="button">↺ 送出並從中斷處繼續</button>
      </div>

      <div class="tour-block" data-step="conflict">
        <div class="tour-block-title">⑧ 合併衝突（少見）</div>
        <div class="tour-block-desc">同一個檔案兩邊都改了，要你決定用哪一邊。</div>
        <div class="tour-sub" style="margin:0 0 var(--space-2)">sale_order.py — 兩邊都動了同一段</div>
        <div class="tour-cols">
          <span class="tour-save is-outline" style="cursor:default">用這次的</span>
          <span class="tour-save is-outline" style="cursor:default">用原本的</span>
          <span class="tour-save is-outline" style="cursor:default">我自己處理</span>
        </div>
      </div>
    `,
    steps: [
      {
        target: null,
        title: '一條任務會經過的關卡',
        text: '大部分時間 AI 自己跑，只有幾個路口需要你決定。<br><br>下面把這些路口<strong>全部排在一頁</strong>方便你認得它們——<strong>實際上同一時間只會出現其中一個</strong>，就在任務詳情頁的中間那一段。',
        next: '開始'
      },
      {
        target: '[data-step="create"]',
        title: '① 用你自己的話寫',
        text: '不用寫得像規格書。<strong>把「現在什麼情況、為什麼困擾」講清楚就好</strong>，怎麼做是 AI 的事。<br><br>寫得越具體，後面反問你的次數越少。',
        next: '下一關'
      },
      {
        target: '[data-step="clarify"]',
        title: '② 回答 AI 的問題',
        text: '分析完有不確定的地方，它會停下來問你，多半是選擇題。<br><br>選項都不對就用<strong>「都不合適」</strong>自己補充。反過來你也可以先問它問題再回答。',
        next: '下一關'
      },
      {
        target: '[data-step="spec"]',
        title: '③ 看懂再按確認',
        text: '這是動工前<strong>最後一次改方向的機會</strong>，按下去就開始寫程式了。<br><br>看不懂或覺得不對，寫在意見欄送回去，它會改完再問一次。',
        next: '下一關'
      },
      {
        target: '[data-step="waiting"]',
        title: '④ 這段可以去忙別的',
        text: '開發、QA、部署到測試環境、跑自動測試，四關都不用你出手。<br><br>失敗它會自己重試，真的過不了才會停下來找你（那就是第 ⑦ 關）。',
        next: '下一關'
      },
      {
        target: '[data-step="review"]',
        title: '⑤ 一定要實際點過再核准',
        text: '先點卡片上的 <strong>🖥 測試機</strong> 進去真的操作看看，別只看程式碼變更。<br><br>不滿意就填原因退回，它會照你寫的去修；滿意才按核准。',
        next: '下一關'
      },
      {
        target: '[data-step="release"]',
        title: '⑥ 核准了還沒上線',
        text: '這是最多人誤會的地方。<strong>審核通過只是「排進待上正式」</strong>，東西還在測試區。<br><br>要真的生效，得到<strong>專案頁</strong>按「🚀 上正式」，那時才會合併到正式區。',
        warn: '一按會把該專案<strong>所有已核准的任務一起</strong>送上去，不能只挑其中幾張。',
        next: '下一關'
      },
      {
        target: '[data-step="stopped"]',
        title: '⑦ 卡住了怎麼辦',
        text: '連續失敗它會停下來，把卡在哪裡寫給你看。<br><br>你不用會修程式，<strong>把你知道的補充上去</strong>（例如「那個欄位其實叫別的名字」），送出後它會從中斷的地方接著跑。',
        next: '最後一關'
      },
      {
        target: '[data-step="conflict"]',
        title: '⑧ 合併衝突（不常遇到）',
        text: '同一個檔案，這張任務和別人都改到同一段，系統不敢自己決定。<br><br>每個檔案挑一邊即可。<strong>看不懂就先用旁邊的追問功能問清楚再選</strong>，不用硬猜。',
        next: '完成這一課'
      }
    ]
  }
];
