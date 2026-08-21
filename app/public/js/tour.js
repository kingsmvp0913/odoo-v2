// 新手教程引擎（driver.js 式）：在**真實畫面**上挖洞打光，不再自帶任何仿製畫面。
// 舊版把整頁換成手寫的仿製 HTML，代價是版面漂移、左側選單消失、框對不準；現在改成：
//   1. 每一步宣告 route ＋ target selector，引擎負責導頁 → 等元素出現 → 捲進畫面 → 量位置。
//   2. 量測一律 getBoundingClientRect()，再換算回覆蓋層自己的座標系。
//      app.css 有 `body { zoom: 1.1 }`，rect 是視窗座標、覆蓋層在 zoom 內 → 不換算就整片偏移，
//      這正是舊版「框沒對齊」的主因。換算比例用覆蓋層自己量（rect.width / offsetWidth），
//      不讀 zoom 屬性，瀏覽器支援度不影響。
//   3. 目標元素會動（捲動、非同步渲染、視窗縮放）→ 開著時每一幀比對 rect，變了才重畫。
//   4. 新帳號沒有任務／專案可指 → tour-demo.js 提供示範資料，由既有 view 自己渲染。
// 全域元件慣例比照 showToast：全域函式 ＋ reactive state ＋ App template 掛 host。
(function () {
  const KEY = 'tourDone';
  const PAD = 6;          // 光圈比元素本身外擴多少
  const GAP = 12;         // 說明框與光圈的距離
  const EDGE = 10;        // 說明框離視窗邊緣的最小距離
  const WAIT_MS = 4000;   // 等目標元素出現的上限（導頁 ＋ 首次載入資料）

  // 「在畫面上」比「在 DOM 裡」嚴格：收合區可能還掛著但高度為 0，指過去會量到一條線
  function visible(selector) {
    const el = document.querySelector(selector);
    return el && el.getBoundingClientRect().height > 0 ? el : null;
  }

  function doneCourses() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
  }
  function markDone(id) {
    const done = doneCourses();
    if (!done.includes(id)) {
      done.push(id);
      localStorage.setItem(KEY, JSON.stringify(done));
    }
    state.doneVersion++;   // 觸發入口按鈕的未完成數重算
  }
  // 管理員限定的課程（報表、管理員設定、資料庫查詢）對一般使用者連選單都不該出現——
  // 那幾頁的路由本來就有 requiresAdmin，教程帶過去只會被導回首頁。
  // 讀 UserStore.role（reactive）→ 呼叫端的 computed 會在角色載入後自動重算。
  function visibleCourses() {
    const all = window.TOUR_COURSES || [];
    const isAdmin = !!(window.UserStore && window.UserStore.role === 'admin');
    return isAdmin ? all : all.filter(c => !c.adminOnly);
  }
  function remainingCount() {
    void state.doneVersion; // 建立 reactive 依賴
    const done = doneCourses();
    return visibleCourses().filter(c => !done.includes(c.id)).length;
  }

  // open=選單或課程都算開著；courseId 為 null 代表停在選單
  const state = Vue.reactive({ open: false, courseId: null, stepIdx: 0, doneVersion: 0 });

  function open(courseId) {
    state.courseId = courseId || null;
    state.stepIdx = 0;
    state.open = true;
    if (window.TourDemo) { window.TourDemo.active = true; window.TourDemo.reset(); }
  }
  function close() { state.open = false; state.courseId = null; }

  window.TourManager = { open, close, doneCourses, markDone, remainingCount, state };

  window.TourHost = {
    name: 'TourHost',
    setup() { return { state }; },
    data() {
      return {
        box: null,          // 光圈位置（覆蓋層座標系）；null＝沒有目標，說明框置中
        pop: null,          // 說明框位置
        place: 'bottom',    // 說明框相對光圈的方位
        arrow: 0            // 箭頭沿邊的位移
      };
    },
    // 每一步一個流水號，導頁／等元素這些非同步工作回來時用它判斷自己是不是已經過期。
    // 放在 data 外（非 reactive），但一定要先給初值——undefined 時 ++ 會得到 NaN，
    // 而 NaN !== NaN 恆真，每一步都會被自己的過期檢查擋掉，畫面永遠只剩說明框沒有光圈。
    created() { this._token = 0; },
    computed: {
      courses() { return visibleCourses(); },
      course() { return this.courses.find(c => c.id === this.state.courseId) || null; },
      step() { return this.course ? this.course.steps[this.state.stepIdx] : null; },
      lastIdx() { return this.course ? this.course.steps.length - 1 : 0; },
      centered() { return !this.box; },
      // 沒特別開放時，光圈裡也蓋一層透明擋板：示範資料上的按鈕按下去會真的打 API
      blockHole() { return !(this.step && this.step.interactive); },
      // 四片遮罩把光圈以外都蓋住；沒有光圈時退化成整片
      masks() {
        const b = this.box;
        if (!b) return [{ top: 0, left: 0, right: 0, bottom: 0 }];
        return [
          { top: 0, left: 0, right: 0, height: Math.max(0, b.top) + 'px' },
          { top: (b.top + b.height) + 'px', left: 0, right: 0, bottom: 0 },
          { top: b.top + 'px', left: 0, width: Math.max(0, b.left) + 'px', height: b.height + 'px' },
          { top: b.top + 'px', left: (b.left + b.width) + 'px', right: 0, height: b.height + 'px' }
        ];
      }
    },
    watch: {
      'state.stepIdx'() { this.runStep(); },
      'state.courseId'() { this.box = null; this.pop = null; this.runStep(); },
      'state.open'(isOpen) {
        if (!isOpen) { this.stopTrack(); this.box = null; this.pop = null; this.leaveDemo(); return; }
        this.runStep();
        // 焦點收進覆蓋層，否則剛才被點的「新手教程」按鈕仍持有焦點，Enter／Space 會摸回它
        this.$nextTick(() => {
          const el = this.$refs.layer && this.$refs.layer.querySelector('button');
          if (el) el.focus();
        });
      }
    },
    mounted() {
      this._onKey = (e) => {
        if (!this.state.open) return;
        if (e.key === 'Escape') { this.quit(); return; }
        if (e.key === 'Tab') { this.trapTab(e); return; }
        if (!this.course) return;
        const t = e.target;
        const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        if (editable) return;                  // 開放互動的步驟裡是真的輸入框，打字用的鍵不能被搶走
        if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); this.next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); this.back(); }
      };
      document.addEventListener('keydown', this._onKey);
    },
    unmounted() {
      document.removeEventListener('keydown', this._onKey);
      this.stopTrack();
    },
    methods: {
      pickCourse(id) { open(id); },
      next() {
        if (this.state.stepIdx < this.lastIdx) { this.state.stepIdx++; }
        else { markDone(this.course.id); close(); }
      },
      back() { if (this.state.stepIdx > 0) this.state.stepIdx--; },
      quit() { close(); },
      isDone(id) { void this.state.doneVersion; return doneCourses().includes(id); },

      // 點遮罩離開只給課程選單用。課程進行中不關：那時遮罩佔滿整個畫面，
      // 讀到一半想把說明框推開而點一下背景是很自然的動作，關掉會讓人得從頭再點一次。
      onMaskClick() { if (!this.course) this.quit(); },

      // 教程收掉時人可能還停在示範頁（/task/demo），示範資料一撤那頁會變成 404，先帶回任務列表
      leaveDemo() {
        const demo = window.TourDemo;
        if (!demo) return;
        const onDemoPage = /\/(task|projects)\/demo/.test(this.$route.path);
        demo.active = false;
        if (onDemoPage) this.$router.push('/').catch(() => {});
      },

      // 一步的完整流程：切示範狀態 → 導頁 → 必要時先點開收合區 → 等元素 → 捲進畫面 → 追蹤
      async runStep() {
        const token = ++this._token;
        this.stopTrack();
        const step = this.step;
        if (!this.state.open || !step) { this.box = null; this.pop = null; return; }

        if (window.TourDemo && step.demoStatus) window.TourDemo.status = step.demoStatus;

        if (step.route && this.$route.path !== step.route) {
          await this.$router.push(step.route).catch(() => {});
          if (token !== this._token) return;
        }

        // 目標還沒在畫面上（導頁、資料還在載、收合著）→ 先把舊光圈收掉。
        // 留著上一步的框配這一步的說明，就是「框的地方跟教學講的不一樣」。
        if (!step.target || !visible(step.target)) { this.box = null; this.pop = null; }
        if (!step.target) { this.placePop(); return; }

        // 收合區（新增表單之類）先點開才有東西可指；已經開著就不要再點一次把它關掉
        if (step.click && !visible(step.target)) {
          const opener = await this.waitFor(step.click, 1500, token);
          if (token !== this._token) return;
          if (opener) opener.click();
        }

        const el = await this.waitFor(step.target, WAIT_MS, token);
        if (token !== this._token) return;
        if (!el) {
          // 選字漂移的既知代價：不留在舊座標，退回置中呈現＋在 console 點名，別無聲吞掉
          console.warn(`[tour] 課程「${this.course.id}」第 ${this.state.stepIdx + 1} 步的 target「${step.target}」找不到，改用置中呈現`);
          this.box = null; this.pop = null;
          this.placePop();
          return;
        }
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        this.track(el, token);
      },

      // 元素可能還在載入／還在 v-if 後面 → 輪詢到出現為止
      waitFor(selector, ms, token) {
        return new Promise(resolve => {
          const deadline = Date.now() + ms;
          const tick = () => {
            if (token !== this._token || !this.state.open) return resolve(null);
            const el = visible(selector);
            if (el) return resolve(el);
            if (Date.now() > deadline) return resolve(null);
            requestAnimationFrame(tick);
          };
          tick();
        });
      },

      // 目標會動（平滑捲動、非同步渲染、視窗縮放），每一幀比對，位置變了才重畫
      track(el, token) {
        const loop = () => {
          if (token !== this._token || !this.state.open) return;
          this._raf = requestAnimationFrame(loop);
          const layer = this.$refs.layer;
          if (!layer || !el.isConnected) return;
          const lr = layer.getBoundingClientRect();
          const scale = layer.offsetWidth ? (lr.width / layer.offsetWidth) : 1;   // body zoom 的換算比例
          const r = el.getBoundingClientRect();
          const box = {
            top: (r.top - lr.top) / scale - PAD,
            left: (r.left - lr.left) / scale - PAD,
            width: r.width / scale + PAD * 2,
            height: r.height / scale + PAD * 2
          };
          const prev = this.box;
          if (prev && Math.abs(prev.top - box.top) < 0.5 && Math.abs(prev.left - box.left) < 0.5 &&
              Math.abs(prev.width - box.width) < 0.5 && Math.abs(prev.height - box.height) < 0.5) return;
          this.box = box;
          this.placePop();
        };
        this._raf = requestAnimationFrame(loop);
      },
      stopTrack() { if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; } },

      // 說明框定位：優先順序 = 步驟指定 → 下 → 上 → 右 → 左，都塞不下就置中
      placePop() {
        this.$nextTick(() => {
          const layer = this.$refs.layer;
          const pop = this.$refs.pop;
          if (!layer || !pop) return;
          const b = this.box;
          if (!b) { this.pop = null; return; }
          const V = { w: layer.offsetWidth, h: layer.offsetHeight };
          const pw = pop.offsetWidth, ph = pop.offsetHeight;
          const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
          const fits = {
            bottom: b.top + b.height + GAP + ph <= V.h - EDGE,
            top: b.top - GAP - ph >= EDGE,
            right: b.left + b.width + GAP + pw <= V.w - EDGE,
            left: b.left - GAP - pw >= EDGE
          };
          const order = [this.step && this.step.placement, 'bottom', 'top', 'right', 'left'].filter(Boolean);
          const side = order.find(s => fits[s]);
          if (!side) { this.pop = null; return; }   // 塞不下 → 置中（centered）
          let top, left;
          if (side === 'bottom' || side === 'top') {
            left = clamp(b.left + b.width / 2 - pw / 2, EDGE, V.w - pw - EDGE);
            top = side === 'bottom' ? b.top + b.height + GAP : b.top - GAP - ph;
            this.arrow = clamp(b.left + b.width / 2 - left, 16, pw - 16);
          } else {
            top = clamp(b.top + b.height / 2 - ph / 2, EDGE, V.h - ph - EDGE);
            left = side === 'right' ? b.left + b.width + GAP : b.left - GAP - pw;
            this.arrow = clamp(b.top + b.height / 2 - top, 16, ph - 16);
          }
          this.place = side;
          this.pop = { top: top + 'px', left: left + 'px' };
        });
      },

      trapTab(e) {
        const layer = this.$refs.layer;
        if (!layer) return;
        const focusables = Array.from(layer.querySelectorAll('button, a[href], input, select, textarea, [tabindex]'))
          .filter(el => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !layer.contains(active)) { e.preventDefault(); last.focus(); }
        } else if (active === last || !layer.contains(active)) {
          e.preventDefault(); first.focus();
        }
      }
    },
    template: `
      <div v-if="state.open" class="tour-layer" :class="{ 'is-menu': !course }" ref="layer">
        <div v-for="(m, i) in masks" :key="i" class="tour-mask" :style="m" @click="onMaskClick"></div>
        <div v-if="blockHole && box" class="tour-mask tour-mask-hole" :style="{
          top: box.top + 'px', left: box.left + 'px', width: box.width + 'px', height: box.height + 'px' }"></div>
        <div v-if="box" class="tour-ring" :style="{
          top: box.top + 'px', left: box.left + 'px', width: box.width + 'px', height: box.height + 'px' }"></div>

        <!-- 課程選單 -->
        <div v-if="!course" class="tour-menu">
          <div class="tour-menu-title">新手教學</div>
          <div class="tour-menu-sub">{{ courses.length }} 門短課，不用照順序，隨時可以關掉。教學會直接帶你走真的畫面。</div>
          <div class="tour-menu-list">
            <button v-for="(c, i) in courses" :key="c.id" type="button"
              class="tour-menu-item" :class="{ 'is-done': isDone(c.id) }"
              @click="pickCourse(c.id)">
              <span class="tour-menu-num">{{ isDone(c.id) ? '✓' : i + 1 }}</span>
              <span class="tour-menu-body">
                <span class="tour-menu-name">{{ c.name }}</span>
                <span class="tour-menu-desc">{{ c.desc }}</span>
              </span>
              <span class="tour-menu-steps">{{ c.steps.length }} 步</span>
            </button>
          </div>
          <div class="tour-menu-foot">
            <button class="tour-btn tour-btn-ghost" type="button" @click="quit">關閉</button>
          </div>
        </div>

        <!-- 課程：說明框 -->
        <div v-else class="tour-pop" ref="pop"
          :class="{ 'is-center': centered }"
          :data-side="centered ? null : place"
          :style="centered ? null : (pop || null)"
          role="dialog" aria-modal="true">
          <span class="tour-arrow" :style="centered ? null : (
            place === 'left' || place === 'right' ? { top: arrow + 'px' } : { left: arrow + 'px' })"></span>
          <template v-if="step">
            <div class="tour-pop-head">
              <span class="tour-tag">🎓 {{ course.name }}</span>
              <span class="tour-count">{{ state.stepIdx + 1 }} / {{ course.steps.length }}</span>
            </div>
            <div class="tour-title">{{ step.title }}</div>
            <div class="tour-body">
              <span v-html="step.text"></span>
              <span v-if="step.warn" class="tour-note"><b>注意</b>{{ step.warn }}</span>
            </div>
            <div class="tour-progress" aria-hidden="true">
              <span :style="{ width: ((state.stepIdx + 1) / course.steps.length * 100) + '%' }"></span>
            </div>
            <div class="tour-foot">
              <button class="tour-quit" type="button" @click="quit">結束教學</button>
              <button v-if="state.stepIdx > 0" class="tour-btn tour-btn-ghost" type="button" @click="back">上一步</button>
              <button class="tour-btn tour-btn-primary" type="button" @click="next">
                {{ state.stepIdx === lastIdx ? '完成' : '下一步' }}
              </button>
            </div>
          </template>
        </div>
      </div>
    `
  };
})();
