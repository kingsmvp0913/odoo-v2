// 教程的示範資料。
// 教程改成「在真實畫面上打光」之後，剩下的問題只有一個：新帳號沒有任務、沒有專案，
// 更不會剛好有一張停在「等待確認」的卡片可以指。這支就是補那個洞——提供一張假任務與
// 一個假專案，交給既有的 TaskList／TaskDetail／ProjectList／ProjectDetail 自己渲染。
// 因此教程不再自帶任何仿製 HTML：畫面永遠等於真的畫面，改版面也不會漂移。
//
// 接線點只有五處，全部以 `window.TourDemo &&` 守著，刪掉本檔＝功能自動退化成「只教真資料」。
(function () {
  const HOUR = 3600 * 1000;
  const ago = (h) => new Date(Date.now() - h * HOUR).toISOString();

  const CONFLICT = {
    repos: [{
      repo: 'odoo-addons',
      files: ['idx_hj/models/repair_order.py'],
      details: {
        'idx_hj/models/repair_order.py': {
          classification: '同一段程式兩邊都改了',
          reason: '這張任務加了 note 欄位，同一時間工程師也在同一個 method 加了檢查。',
          recommendation: 'take_theirs',
          rationale: '兩邊的改動不衝突，取這次的版本再把原本的檢查補回來最完整。',
          qa: []
        }
      }
    }]
  };

  window.TourDemo = Vue.reactive({
    active: false,
    status: 'confirm_pending',
    ID: 'demo',

    // 教程開著、且看的正好是示範 id 時才接管；其餘一律走真的 API
    isTask(id) { return this.active && String(id) === this.ID; },
    isProject(id) { return this.active && String(id) === this.ID; },

    task() {
      return {
        id: this.ID,
        // 結尾刻意不留數字：來源連結是從 task_id 尾端的數字組出來的，留數字會變成一條指向
        // 不存在工單的死連結
        task_id: 'TOUR-DEMO',
        title: '維修單要能填備註',
        status: this.status,
        source: 'odoo',
        source_id: null,
        project_id: this.ID,
        project_name: '鴻久維修',
        module: 'idx_hj',
        original_text: '維修單填不了備註，師傅回來要另外用紙條交代，常常漏掉。',
        env_status: 'running',
        git_branch: 'task/demo-001',
        e2e_disabled: false,
        is_paused: false,
        has_attachment: false,
        approved_at: null,
        merged_to_main_at: null,
        created_at: ago(26),
        updated_at: ago(1),
        blocker_type: this.status === 'stopped' ? 'coding' : null,
        blocker_content: this.status === 'stopped'
          ? '連續 3 次安裝失敗：\n  ParseError: Field `note_internal` does not exist in model `repair.order`'
          : null,
        merge_conflict_data: this.status === 'merge_conflict' ? CONFLICT : null,
        cs_question: null,
        cs_reply: null
      };
    },

    logs() {
      return [
        { id: 1, role: 'user', content: '維修單填不了備註，師傅回來要另外用紙條交代，常常漏掉。', created_at: ago(26) },
        { id: 2, role: 'assistant', content: '收到，我先讀一下維修單這個模組現在的欄位有哪些。', created_at: ago(25) },
        { id: 3, role: 'assistant', content: '看完了。備註要放在維修單本身，我有一個地方需要你決定。', created_at: ago(24) }
      ];
    },
    messages() { return []; },
    events() {
      return [{ id: 1, content: '[分析] 讀取 idx_hj 模組…\n[分析] 產出規格草稿\n[確認] 等待使用者回覆\n' }];
    },

    clarification() {
      return {
        summary: '',
        intro: '這張任務大致清楚，只有一件事我不敢自己決定。',
        questions: [{
          id: 'q1',
          text: '這個備註要讓誰看得到？',
          type: 'choice',
          required: true,
          options: [
            { key: '只有內部員工', label: '只有內部員工看得到' },
            { key: '客戶也看得到', label: '客戶在維修單報表上也看得到' }
          ]
        }]
      };
    },

    spec() {
      return {
        summary: '在維修單（repair.order）新增一個「內部備註」欄位，僅內部員工可見，列印報表時不帶出。',
        module: 'idx_hj',
        requirements: [
          '於 repair.order 以 _inherit 新增 note_internal（Text）',
          '維修單表單視圖以 xpath 掛在「維修明細」頁籤之後',
          '報表樣板不引用此欄位'
        ],
        acceptance: [
          '維修單可以輸入並儲存備註內容',
          '列印維修單時看不到備註內容'
        ],
        permissions: '維修人員可讀寫；客戶入口看不到此欄位。'
      };
    },

    detail() {
      return {
        task: this.task(),
        logs: this.logs(),
        attachments: [],
        clarification: this.clarification(),
        spec: this.spec()
      };
    },

    project() {
      return {
        id: this.ID,
        name: '鴻久維修',
        folder_name: 'hongjiu',
        odoo_version: '17.0',
        edition: 'community',
        description: '示範專案，教程用。',
        repo_count: 1,
        has_wiki: true,
        unread_count: 0,
        e2e_disabled: false,
        odoo_project_name: '鴻久維修',
        service_respondent_name: '鴻久',
        repos: [{
          id: 1, label: 'addons', repo_url: 'https://github.com/your-org/odoo-addons',
          is_primary: true, clone_status: 'done', graphify_status: 'done',
          local_path: 'repos/hongjiu/addons'
        }]
      };
    },

    env() {
      return { status: 'running', built: true, external_slot: null, setup_log: '', error_msg: '' };
    }
  });
})();
