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
          if (this.filter === 'risky' && !(it.confidence != null && it.confidence < 70)) return false;
          if (this.filter === 'sure' && it.confidence !== 100) return false;
          if (!words.length) return true;
          const hay = `${it.question_en || ''} ${it.question_zh || ''}`.toLowerCase();
          return words.every(w => hay.includes(w));
        };
        return this.groups
          .map(g => ({ ...g, items: g.items.filter(match) }))
          .filter(g => g.items.length);
      },
      totals() {
        let n = 0, sure = 0, risky = 0, pending = 0;
        for (const g of this.groups) for (const it of g.items) {
          n++;
          if (it.confidence === 100) sure++;
          else if (it.confidence == null) pending++;
          else if (it.confidence < 70) risky++;
        }
        return { n, sure, risky, pending };
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
      confClass(c) {
        if (c == null) return 'ui-next-exam-conf-none';
        if (c === 100) return 'ui-next-exam-conf-sure';
        if (c >= 85) return 'ui-next-exam-conf-high';
        if (c >= 70) return 'ui-next-exam-conf-mid';
        if (c >= 50) return 'ui-next-exam-conf-low';
        return 'ui-next-exam-conf-bad';
      },
      confText(it) {
        if (it.confidence == null) return '—';
        return it.confidence === 100 ? '🔒100%' : `${it.confidence}%`;
      },
      qText(it) {
        const en = it.question_en || '';
        const zh = it.question_zh || '';
        return this.lang === 'zh' ? (zh || en) : en;
      },
      sectionNote(g) {
        if (!g.official) return `${g.items.length} 題`;
        const o = g.official;
        const bits = [`${o.n} 題`];
        if (o.incorrect) bits.push(`官方錯 ${o.incorrect}`);
        else bits.push('官方全對');
        if (o.unanswered) bits.push(`未答 ${o.unanswered}`);
        return bits.join(' · ');
      },
      answerOf(arr) { return Array.isArray(arr) && arr.length ? arr.join('、') : '—'; }
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
                  <span :class="['ui-next-exam-conf', confClass(it.confidence)]">{{ confText(it) }}</span>
                  <span class="ui-next-exam-q" :title="it.confidence_why || ''">{{ qText(it) }}</span>
                  <span v-if="!it.calibrated && it.confidence != null && it.confidence !== 100"
                        class="ui-next-exam-uncal" title="還沒有官方章節結果可校準，這個數字只是估計">估</span>
                </div>

                <div v-if="openId === it.id" class="ui-next-exam-detail">
                  <div v-if="detailLoading" class="ui-next-exam-empty">載入中…</div>
                  <div v-else-if="detail">
                    <div class="ui-next-exam-why">{{ it.confidence_why || '尚未審查' }}</div>
                    <div class="ui-next-exam-qfull">{{ detail.item.question_en }}</div>
                    <div v-if="detail.item.question_zh" class="ui-next-exam-qfull-zh">{{ detail.item.question_zh }}</div>
                    <div class="ui-next-exam-opts">
                      <div v-for="o in (detail.item.options || [])" :key="o.letter" class="ui-next-exam-opt">
                        <b>{{ o.letter }}.</b>
                        <span>{{ o.text }}</span>
                        <span v-if="o.text_zh" class="ui-next-exam-opt-zh">{{ o.text_zh }}</span>
                      </div>
                    </div>
                    <div class="ui-next-exam-facts">
                      <span v-if="detail.item.answer_official">
                        官方正解 <b>{{ answerOf(detail.item.answer_official) }}</b>
                        <template v-if="detail.item.official_from === 'section-all-correct'">（該章官方全對推得）</template>
                      </span>
                      <span v-for="a in detail.attempts" :key="a.bank_label + a.page + a.no">
                        {{ a.bank_label }} P{{ a.page }}-{{ a.no }} 作答 {{ answerOf(a.answer_final || a.answer_their) }}
                      </span>
                    </div>
                    <div v-for="v in detail.verdicts" :key="v.id" class="ui-next-exam-verdict">
                      <span class="ui-next-exam-vkind">{{ v.kind === 'adversary' ? '對立審查' : '舊盲判' }}</span>
                      <span v-if="v.refuted" class="ui-next-exam-vrefute">認為應該選 {{ answerOf(v.correct_answer) }}</span>
                      <span v-else class="ui-next-exam-vok">推不翻</span>
                      <span class="ui-next-exam-vconf">自評 {{ v.confidence == null ? '—' : v.confidence }}</span>
                      <div class="ui-next-exam-vreason">{{ v.reason }}</div>
                      <div v-for="e in detail.evidence.filter(x => x.verdict_id === v.id)" :key="e.id"
                           class="ui-next-exam-evidence">
                        <code>{{ e.ref }}</code>
                        <span v-if="e.excerpt" class="ui-next-exam-excerpt">{{ e.excerpt }}</span>
                      </div>
                    </div>
                    <div v-if="it.confidence != null && it.confidence < 70" class="ui-next-exam-warn">
                      值得重讀，但**不要**直接照審查的答案改——它在官方確定的題上也錯過。
                    </div>
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
