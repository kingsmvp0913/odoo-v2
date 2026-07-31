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
];
