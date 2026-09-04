  // Odoo 認證題庫。設計文件：docs/superpowers/specs/2026-09-04-odoo-exam-platform-design.md
  //
  // 這一頁的核心是「把六七個標籤收斂成一個數字」。原本一題同時掛著 confirmed／
  // 🔒官方保證正確／推薦度 87%／🕳盲區候選／🙈判題自己錯／低信心，看不出重點。
  // 現在只有一個信心度、一個顏色、一句白話，其餘全部收進點開後的詳情。
  window.UiNextExamBankView = Vue.defineComponent({
    name: "UiNextExamBankView",
    data() {
      return {
        banks: [],
        bankId: null,
        groups: [],
        bank: null,
        loading: true,
        // 篩選收斂成三個。原本六七個篩選裡，正式核對時真正會用的只有這三種。
        filter: localStorage.getItem('examFilter') || 'all',
        keyword: '',
        lang: localStorage.getItem('examLang') || 'en',
        collapsed: {},      // { [章節名]: true }
        openId: null,       // 展開中的題目 id
        detail: null,
        detailLoading: false
      };
    },
    async created() {
      try {
        this.banks = await Api.get('exam/banks');
        if (this.banks.length) {
          this.bankId = this.banks[0].id;
          await this.loadBank();
        }
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    computed: {
      // 搜尋用「每個詞都要出現」而不是連續子字串。考試時是看螢幕打關鍵字，
      // 不是複製貼上——includes 對 "sub-tasks false" 這種不連續組合會完全找不到。
      filteredGroups() {
        const words = this.keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
        const match = (it) => {
          if (this.filter === 'risky'
              && !(!this.isUnanswered(it) && it.confidence != null && it.confidence < 70)) return false;
          if (this.filter === 'sure' && it.confidence !== 100) return false;
          if (!words.length) return true;
          const hay = `${it.question_en || ''} ${it.question_zh || ''}`.toLowerCase();
          return words.every(w => hay.includes(w));
        };
        return this.groups
          .map(g => ({ ...g, items: g.items.filter(match) }))
          .filter(g => g.items.length);
      },
      // 未作答的題不進「要注意」——它沒有作答可以檢討，列進去只會讓那個
       // 「該花時間看幾題」的數字失準。它自己單獨一個計數。
      totals() {
        let n = 0, sure = 0, risky = 0, pending = 0, unanswered = 0;
        for (const g of this.groups) for (const it of g.items) {
          n++;
          if (this.isUnanswered(it)) { unanswered++; continue; }
          if (it.confidence === 100) sure++;
          else if (it.confidence == null) pending++;
          else if (it.confidence < 70) risky++;
        }
        return { n, sure, risky, pending, unanswered };
      },

      // 官方確定的題只擺答案，不擺審查意見——答案已經是硬事實，再列出
      // 「審查覺得應該選 X」只會製造「那要聽誰的」的疑慮。實測那 47 題
      // 確定的題目上，審查自己還錯過 2 次。
      isSure() {
        const it = this.detail && this.detail.item;
        return !!(it && it.answer_official && it.answer_official.length);
      },

      // 展開後只有三種狀態，對應三種「我該不該花時間看這題」：
      //   official — 官方確定，不用看
      //   agreed   — 審查沒異議且有把握，也不用看
      //   review   — 有異議或沒把握，這才是要看的
      //
      // 把 agreed 併進「不用看」是刻意的：原本它會吐出「作答 A／審查推不翻，
      // 但沒找證據／審查與作答一致，沒有異議」三行，三行在講同一件事，
      // 而那件事就是「沒問題」。沒問題的題不需要三行字來說明它沒問題。
      detailState() {
        if (this.isSure) return 'official';
        const it = this.openItem;
        const conf = it && it.confidence;
        // 門檻與列表的「要注意」同一條線（<70），兩邊的判準不該各說各話
        if (!this.disagreeing.length && Number.isFinite(conf) && conf >= 70) return 'agreed';
        return 'review';
      },

      // 展開後選項旁的圖示（沿用列表那一行的判準，兩處不會各說各話）
      finalMark() { return this.detailState === 'official' ? '🔒' : '✓'; },

      // 展開中的那一題（列表資料，含 confidence）
      openItem() {
        for (const g of this.groups) for (const it of g.items) if (it.id === this.openId) return it;
        return null;
      },

      // 詳細區只顯示「列表那行沒顯示的那個語言」。跟著 EN／中 開關走，
      // 兩邊各印一種，同一句話不會出現兩次。
      altText() {
        const it = this.detail && this.detail.item;
        if (!it) return '';
        return this.lang === 'zh' ? (it.question_en || '') : (it.question_zh || '');
      },

      // 各次考試的作答取最新一筆有填的。不逐筆列出——歷史本身不是要看的東西。
      finalAnswer() {
        const list = (this.detail && this.detail.attempts) || [];
        for (let i = list.length - 1; i >= 0; i--) {
          const a = list[i].answer_final || list[i].answer_their;
          if (a && a.length) return a;
        }
        return null;
      },

      seenTimes() { return ((this.detail && this.detail.attempts) || []).length; },

      // 只留「與作答不一樣」的審查。一致的沒有資訊量，列出來只是佔版面；
      // 有異議的才是要花時間看的東西，而且要看得到理由。
      // 舊的 blind_r1/blind_r2 一律不顯示——那是退役流程的歷史資料。
      disagreeing() {
        const vs = (this.detail && this.detail.verdicts) || [];
        return vs.filter(v => v.kind === 'adversary' && v.refuted);
      }
    },
    methods: {
      async loadBank() {
        this.openId = null; this.detail = null;
        try {
          const res = await Api.get(`exam/sections?bank=${this.bankId}`);
          this.bank = res.bank;
          this.groups = res.groups;
        } catch (e) { showToast(e.message, 'error'); }
      },
      setFilter(f) { this.filter = f; localStorage.setItem('examFilter', f); },
      setLang(l) { this.lang = l; localStorage.setItem('examLang', l); },
      toggleGroup(t) { this.collapsed = { ...this.collapsed, [t]: !this.collapsed[t] }; },
      async toggleItem(it) {
        if (this.openId === it.id) { this.openId = null; this.detail = null; return; }
        this.openId = it.id; this.detail = null; this.detailLoading = true;
        try { this.detail = await Api.get(`exam/items/${it.id}`); }
        catch (e) { showToast(e.message, 'error'); }
        finally { this.detailLoading = false; }
      },
      // 一個數字、一個顏色、一句白話。100 專屬官方確認。
      confClass(c, it) {
        if (it && this.isUnanswered(it)) return 'ui-next-exam-conf-none';
        if (c == null) return 'ui-next-exam-conf-none';
        if (c === 100) return 'ui-next-exam-conf-sure';
        if (c >= 85) return 'ui-next-exam-conf-high';
        if (c >= 70) return 'ui-next-exam-conf-mid';
        if (c >= 50) return 'ui-next-exam-conf-low';
        return 'ui-next-exam-conf-bad';
      },
      // 信心度的定義是「最終作答是正確的機率」。沒有最終作答就沒有這個東西——
      // 顯示 60% 會讓人以為「有六成機會答對」，但那題根本沒答。
      // 這幾題也正是官方章節結果裡的「未作答」，校準時本來就排除在外。
      isUnanswered(it) { return !(it.answer_final && it.answer_final.length); },

      // 列表那一行的標記。三種狀態對應「我該不該花時間看這題」，
      // 與展開後的 detailState 同一套判準：
      //   🔒 官方確定  ✓ 審查沒異議且有把握  （空白）要看
      // refuted 由後端給（列表本身查不到 verdicts）。null＝還沒審查過。
      rowMark(it) {
        if (this.isUnanswered(it)) return '';
        if (it.confidence === 100) return '🔒';
        if (it.refuted === false && Number.isFinite(it.confidence) && it.confidence >= 70) return '✓';
        return '';
      },

      // 只回數字。鎖頭在同一格由 template 畫。
      confText(it) {
        if (this.isUnanswered(it)) return '未答';
        return it.confidence == null ? '—' : `${it.confidence}%`;
      },
      qText(it) {
        const en = it.question_en || '';
        const zh = it.question_zh || '';
        return this.lang === 'zh' ? (zh || en) : en;
      },
      // incorrect === 0 **不等於**「官方全對」——沒作答的題不算錯，但也不算對。
      // POS 是 3 題答對 2、未答 1，寫「官方全對 · 未答 1」自己打自己的臉。
      sectionNote(g) {
        if (!g.official) return `${g.items.length} 題`;
        const o = g.official;
        const bits = [`${o.n} 題`];
        if (o.incorrect) bits.push(`官方錯 ${o.incorrect}`);
        else if (o.unanswered) bits.push('答的都對');
        else bits.push('官方全對');
        if (o.unanswered) bits.push(`未答 ${o.unanswered}`);
        return bits.join(' · ');
      },
      answerOf(arr) { return Array.isArray(arr) && arr.length ? arr.join('、') : '—'; },

      // 官方確定的題把那個選項本身標出來（focus 樣式），比在別處寫一次
      // 「答案是 B」更直接——眼睛不必在兩個地方之間對照。
      isFinal(letter) {
        const it = this.detail && this.detail.item;
        const src = (it && it.answer_official) || this.finalAnswer;
        return Array.isArray(src) && src.includes(letter);
      },

      evidenceOf(verdictId) {
        return ((this.detail && this.detail.evidence) || []).filter(e => e.verdict_id === verdictId);
      }
    },
    template: `
      <div class="topbar ui-next-admin-head">
        <h1>認證題庫</h1>
        <div class="ui-next-admin-head-actions">
          <!-- 只有一份題庫時 select 不顯示，但版本仍要看得見：同一題在 Odoo 17
               與 19 的答案可能不同，不知道自己在看哪個版本會誤用。 -->
          <span v-if="bank && banks.length <= 1" class="ui-next-exam-ver">
            {{ bank.label }} · Odoo {{ bank.odoo_version }}
          </span>
          <select v-if="banks.length > 1" v-model="bankId" @change="loadBank" class="ui-next-exam-bank-pick">
            <option v-for="b in banks" :key="b.id" :value="b.id">{{ b.label }}（Odoo {{ b.odoo_version }}）</option>
          </select>
        </div>
      </div>
      <div class="content">
        <div v-if="loading" class="ui-next-exam-empty">載入中…</div>
        <div v-else-if="!banks.length" class="ui-next-exam-empty">還沒有任何題庫。用 tools/exam-import.js 匯入一份。</div>
        <div v-else>
          <div class="ui-next-exam-toolbar">
            <input v-model="keyword" class="ui-next-exam-search" placeholder="搜尋（打多個詞，每個詞都要出現）" />
            <div class="ui-next-exam-filters">
              <button :class="['ui-next-exam-chip', filter==='all' && 'is-on']" @click="setFilter('all')">
                全部 {{ totals.n }}
              </button>
              <button :class="['ui-next-exam-chip', filter==='risky' && 'is-on']" @click="setFilter('risky')">
                要注意 {{ totals.risky }}
              </button>
              <button :class="['ui-next-exam-chip', filter==='sure' && 'is-on']" @click="setFilter('sure')">
                🔒 官方確定 {{ totals.sure }}
              </button>
            </div>
            <div class="ui-next-exam-lang">
              <button :class="['ui-next-exam-chip', lang==='en' && 'is-on']" @click="setLang('en')">EN</button>
              <button :class="['ui-next-exam-chip', lang==='zh' && 'is-on']" @click="setLang('zh')">中</button>
            </div>
          </div>
          <div v-if="totals.pending" class="ui-next-exam-hint">
            還有 {{ totals.pending }} 題沒跑過審查，沒有信心度可看。
          </div>

          <div v-for="g in filteredGroups" :key="g.title" class="ui-next-exam-group">
            <div class="ui-next-exam-group-head" @click="toggleGroup(g.title)">
              <span class="ui-next-exam-caret">{{ collapsed[g.title] ? '▶' : '▼' }}</span>
              <span class="ui-next-exam-group-title">{{ g.title }}</span>
              <span class="ui-next-exam-group-note">{{ sectionNote(g) }}</span>
            </div>
            <div v-if="!collapsed[g.title]">
              <div v-for="it in g.items" :key="it.id">
                <div class="ui-next-exam-row" @click="toggleItem(it)">
                  <!-- 鎖頭與數字同一格、靠右貼齊，整組再貼近題幹。
                       原本鎖頭獨立一欄，結果它孤零零留在最左邊，中間空一大段才接到
                       題幹（實際畫面確認）。grid 的欄寬是固定的，所以放在同一格也
                       不會把題幹的起點推開。 -->
                  <!-- 標記放在標題這一行而不是展開後的選項裡：不展開就要看得出
                       「這題要不要花時間看」，那正是這一頁存在的理由。 -->
                  <span :class="['ui-next-exam-conf', confClass(it.confidence, it)]">
                    <span v-if="rowMark(it)" class="ui-next-exam-lock">{{ rowMark(it) }}</span>{{ confText(it) }}
                  </span>
                  <!-- 展開時這一行自己攤開成完整題幹，詳細區就不必再寫一次。
                       原本兩邊都印題幹，英文等於出現兩次。 -->
                  <span :class="['ui-next-exam-q', openId === it.id && 'is-open']"
                        :title="it.confidence_why || ''">{{ qText(it) }}</span>
                  <!-- 「估」只用在真正的未校準：有作答、有信心度，但這份題庫還沒有
                       官方章節結果可以對。未作答的題不掛這個標記——它沒被校準的原因
                       是「沒有作答」而不是「沒有官方結果」，掛同一個標記會誤導。 -->
                  <span v-if="!it.calibrated && !isUnanswered(it) && it.confidence != null && it.confidence !== 100"
                        class="ui-next-exam-uncal" title="這份題庫還沒有官方章節結果可校準，這個數字只是估計">估</span>
                </div>

                <div v-if="openId === it.id" class="ui-next-exam-detail">
                  <div v-if="detailLoading" class="ui-next-exam-empty">載入中…</div>
                  <div v-else-if="detail">
                    <!-- 只放「上面那行沒顯示的那個語言」。題幹本身已經在列表那行
                         攤開了，這裡再印一次等於同一句話出現兩次。 -->
                    <div v-if="altText" class="ui-next-exam-qfull-zh">{{ altText }}</div>

                    <div class="ui-next-exam-opts">
                      <div v-for="o in (detail.item.options || [])" :key="o.letter"
                           :class="['ui-next-exam-opt', isFinal(o.letter) && 'is-final']">
                        <!-- 字母與文字同一行，長了才自然換行（不是 flex 換行） -->
                        <div class="ui-next-exam-opt-en">
                          <b>{{ o.letter }}.</b> {{ o.text }}
                          <span v-if="isFinal(o.letter) && detailState !== 'review'"
                                class="ui-next-exam-mark">{{ finalMark }}</span>
                        </div>
                        <div v-if="o.text_zh" class="ui-next-exam-opt-zh">{{ o.text_zh }}</div>
                      </div>
                    </div>

                    <!-- 沒問題的題到選項為止，下方什麼都不放。
                         正解已經標在選項上，再用三行字說明「它沒問題」是多餘的。 -->
                    <template v-if="detailState === 'review'">
                      <!-- 不列每一次歷史，只給一行總結。
                           不寫「審查與作答一致」——confidence_why 已經把狀況說完了，
                           再加一句是同一件事講兩次。 -->
                      <div class="ui-next-exam-sum">
                        <span>作答 <b>{{ answerOf(finalAnswer) }}</b></span>
                        <span class="ui-next-exam-sum-conf">{{ it.confidence_why || '尚未審查' }}</span>
                        <span v-if="seenTimes > 1" class="ui-next-exam-sum-seen">考過 {{ seenTimes }} 次</span>
                      </div>

                      <!-- 只列「與作答不一樣」的審查，因為那才是要看的東西 -->
                      <div v-for="v in disagreeing" :key="v.id" class="ui-next-exam-verdict">
                        <div class="ui-next-exam-vhead">
                          <span class="ui-next-exam-vrefute">審查認為應該選 {{ answerOf(v.correct_answer) }}</span>
                          <span class="ui-next-exam-vconf">自評 {{ v.confidence == null ? '—' : v.confidence }}</span>
                        </div>
                        <div class="ui-next-exam-vreason">{{ v.reason || '（沒有寫理由）' }}</div>
                        <div v-for="e in evidenceOf(v.id)" :key="e.ref" class="ui-next-exam-evidence">
                          <code>{{ e.ref }}</code>
                          <span v-if="e.excerpt" class="ui-next-exam-excerpt">{{ e.excerpt }}</span>
                        </div>
                      </div>
                      <div v-if="it.confidence != null && it.confidence < 70" class="ui-next-exam-warn">
                        值得重讀，但不要直接照審查的答案改——它在官方確定的題上也錯過。
                      </div>
                    </template>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!filteredGroups.length" class="ui-next-exam-empty">沒有符合的題目。</div>
        </div>
      </div>
    `
  });
