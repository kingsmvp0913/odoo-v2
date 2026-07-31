// 新手教程引擎。覆蓋層自帶仿製畫面（見 tour-courses.js），不指向任何真實 DOM——
// 因為全站零 data-*／零 id，且新帳號沒有「等待審核」等狀態的任務可指。
// 代價是畫面會與真實 UI 漂移，改版面時要一併改 tour-courses.js。
// 全域元件慣例比照 showToast：全域函式 ＋ reactive state ＋ App template 掛 host。
(function () {
  const KEY = 'tourDone';

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
  function remainingCount() {
    void state.doneVersion; // 建立 reactive 依賴
    const all = window.TOUR_COURSES || [];
    const done = doneCourses();
    return all.filter(c => !done.includes(c.id)).length;
  }

  // open=選單或課程都算開著；courseId 為 null 代表停在選單
  const state = Vue.reactive({ open: false, courseId: null, stepIdx: 0, doneVersion: 0 });

  function open(courseId) {
    state.courseId = courseId || null;
    state.stepIdx = 0;
    state.open = true;
  }
  function close() { state.open = false; state.courseId = null; }

  window.TourManager = { open, close, doneCourses, markDone, remainingCount, state };

  const PAD = 8;

  window.TourHost = {
    name: 'TourHost',
    setup() { return { state }; },
    data() { return { holeBox: null, bubblePos: null, side: 'left', targetMissing: false }; },
    computed: {
      courses() { return window.TOUR_COURSES || []; },
      course() { return this.courses.find(c => c.id === this.state.courseId) || null; },
      step() { return this.course ? this.course.steps[this.state.stepIdx] : null; },
      lastIdx() { return this.course ? this.course.steps.length - 1 : 0; },
      isCenter() { return !this.step || !this.step.target || this.targetMissing; }
    },
    watch: {
      // 換課／換步都要重算位置；等 DOM 更新與捲動完成後才量，否則量到舊座標
      'state.stepIdx'() { this.schedulePlace(); },
      'state.courseId'() {
        // 先清掉舊課程的洞／氣泡座標，避免新畫面套用前先閃一下上一課停留的位置
        this.holeBox = null;
        this.bubblePos = null;
        this.schedulePlace();
      },
      'state.open'(isOpen) {
        if (!isOpen) { this.holeBox = null; this.bubblePos = null; return; }
        // 開啟當下把焦點收進遮罩，否則背後真實畫面裡剛才被點的按鈕仍持有焦點，Tab／Space 會摸到它
        this.$nextTick(() => {
          const el = this.$refs.quit;
          if (el) el.focus();
        });
      }
    },
    mounted() {
      this._onKey = (e) => {
        if (!this.state.open) return;
        if (e.key === 'Escape') { this.quit(); return; }   // Esc 任何狀態下都要能離開，優先於下面所有分支
        if (e.key === 'Tab') { this.trapTab(e); return; }  // 焦點困在遮罩內，避免 Tab 漏到背後真實畫面
        if (!this.course) return;              // 停在選單時不接前進後退
        const t = e.target;
        const editable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
        if (editable) return;                  // 仿製畫面裡是真的 <input>，打字用的 Enter／方向鍵不能被搶走
        if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); this.next(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); this.back(); }
      };
      this._onResize = () => { if (this.state.open) this.place(); };
      this._onScroll = () => { if (this.state.open && this.course) this.place(); };
      document.addEventListener('keydown', this._onKey);
      window.addEventListener('resize', this._onResize);
    },
    unmounted() {
      document.removeEventListener('keydown', this._onKey);
      window.removeEventListener('resize', this._onResize);
      if (this._scrollEl) this._scrollEl.removeEventListener('scroll', this._onScroll);
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
      schedulePlace() {
        // 兩層 rAF：第一層等 Vue 套用新 DOM，第二層等捲動（即時捲動，不再是動畫）落定後才量
        this.$nextTick(() => {
          this.bindScroll();
          this.scrollToTarget();
          requestAnimationFrame(() => requestAnimationFrame(() => this.place()));
        });
      },
      bindScroll() {
        // .tour-screen 只在課程模式（v-else）才存在，換課時 Vue 會重建這顆節點；
        // 用「節點是否變了」判斷要不要重綁，同一顆節點只綁一次——這樣才能同時涵蓋
        // 使用者手動捲動仿製畫面（洞要跟著重新量位置）。
        const screen = this.$refs.screen;
        if (screen === this._scrollEl) return;
        if (this._scrollEl) this._scrollEl.removeEventListener('scroll', this._onScroll);
        this._scrollEl = screen || null;
        if (screen) screen.addEventListener('scroll', this._onScroll);
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
      },
      scrollToTarget() {
        const screen = this.$refs.screen;
        if (!screen || !this.step || !this.step.target) return;
        const el = screen.querySelector(this.step.target);
        if (!el) return;
        const sBox = screen.getBoundingClientRect();
        const eBox = el.getBoundingClientRect();
        // 只在目標不在可視範圍時才捲，避免每一步都無謂跳動
        if (eBox.top < sBox.top + PAD || eBox.bottom > sBox.bottom - PAD) {
          screen.scrollTop += (eBox.top - sBox.top) - 16;
        }
      },
      place() {
        if (!this.step || !this.step.target) { this.holeBox = null; this.bubblePos = null; this.targetMissing = false; return; }
        const screen = this.$refs.screen;
        const canvas = this.$refs.canvas;
        const bubble = this.$refs.bubble;
        if (!screen || !canvas) return;
        const el = screen.querySelector(this.step.target);
        if (!el) {
          // 選字漂移的既知代價（見檔頭註解）：不留在舊座標，退回置中呈現＋在 console 點名，別無聲吞掉
          console.warn(`[tour] 課程「${this.course.id}」的 target「${this.step.target}」找不到對應元素，改用置中呈現`);
          this.holeBox = null; this.bubblePos = null; this.targetMissing = true;
          return;
        }
        this.targetMissing = false;

        const cBox = canvas.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const top = box.top - cBox.top - PAD;
        const left = box.left - cBox.left - PAD;
        const w = box.width + PAD * 2;
        const h = box.height + PAD * 2;
        this.holeBox = { top: top + 'px', left: left + 'px', width: w + 'px', height: h + 'px' };

        const bw = (bubble && bubble.offsetWidth) || 292;
        const bh = (bubble && bubble.offsetHeight) || 190;
        // 仿製畫面的區塊都很寬，優先放左側；左邊塞不下才改放下方
        if (left - bw - 12 >= PAD) {
          this.side = 'left';
          this.bubblePos = {
            left: (left - bw - 12) + 'px',
            top: Math.max(PAD, Math.min(top, cBox.height - bh - PAD)) + 'px'
          };
        } else {
          this.side = 'bottom';
          this.bubblePos = {
            left: Math.max(PAD, Math.min(left, cBox.width - bw - PAD)) + 'px',
            top: Math.min(top + h + 12, cBox.height - bh - PAD) + 'px'
          };
        }
      }
    },
    template: `
      <div v-if="state.open" class="tour-layer" ref="layer">
        <div class="tour-ribbon">
          <span class="tour-ribbon-label">🎓 教學模式</span>
          <span class="tour-ribbon-sub" v-if="course">{{ course.name }}（這是練習畫面，不會真的存檔）</span>
          <span class="tour-ribbon-sub" v-else>選一門開始</span>
          <span class="tour-dots" v-if="course" aria-hidden="true">
            <span v-for="(s, i) in course.steps" :key="i" class="tour-dot"
              :class="{ 'is-now': i === state.stepIdx, 'is-done': i < state.stepIdx }"></span>
          </span>
          <button class="tour-quit" type="button" @click="quit" ref="quit">結束教學</button>
        </div>

        <div class="tour-canvas" ref="canvas">
          <!-- 課程選單 -->
          <div v-if="!course" class="tour-menu">
            <div class="tour-menu-title">新手教程</div>
            <div class="tour-menu-sub">四門短課，不用照順序，隨時可以關掉。</div>
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
          </div>

          <!-- 課程：仿製畫面 ＋ 挖洞 ＋ 氣泡 -->
          <template v-else>
            <div class="tour-screen" ref="screen">
              <div class="tour-screen-title">{{ course.screenTitle }}</div>
              <div v-html="course.screen"></div>
            </div>

            <div class="tour-hole" :class="{ 'is-full': !holeBox }" :style="holeBox || null"></div>

            <div class="tour-bubble" ref="bubble"
              :class="{ 'is-center': isCenter }"
              :data-side="isCenter ? null : side"
              :style="isCenter ? null : (bubblePos || null)"
              role="dialog" aria-modal="true">
              <span class="tour-arrow"></span>
              <template v-if="step">
                <div class="tour-title">{{ step.title }}</div>
                <div class="tour-text">
                  <span v-html="step.text"></span>
                  <span v-if="step.warn" class="tour-warn" v-html="step.warn"></span>
                </div>
                <div class="tour-foot">
                  <span class="tour-count">{{ state.stepIdx + 1 }} / {{ course.steps.length }}</span>
                  <button v-if="state.stepIdx > 0" class="tour-btn tour-btn-ghost" type="button" @click="back">上一步</button>
                  <button class="tour-btn tour-btn-primary" type="button" @click="next">{{ step.next }}</button>
                </div>
              </template>
            </div>
          </template>
        </div>
      </div>
    `
  };
})();
