// 手刻可搜尋下拉：專案／使用者這類長清單用。無第三方相依（不引 jQuery/select2）。
window.SearchableSelect = Vue.defineComponent({
  name: 'SearchableSelect',
  props: {
    modelValue: { type: [String, Number], default: '' },
    options: { type: Array, default: () => [] },        // [{value, label}]
    placeholder: { type: String, default: '請選擇' },
    allLabel: { type: String, default: '全部' }
  },
  emits: ['update:modelValue'],
  data() { return { open: false, q: '', hi: 0 }; },
  computed: {
    selectedLabel() {
      const hit = this.options.find(o => String(o.value) === String(this.modelValue));
      return hit ? hit.label : '';
    },
    filtered() {
      const q = this.q.toLowerCase().trim();
      const base = [{ value: '', label: this.allLabel }, ...this.options];
      if (!q) return base;
      return base.filter(o => o.label.toLowerCase().includes(q));
    }
  },
  methods: {
    toggle() { this.open = !this.open; if (this.open) { this.q = ''; this.hi = 0; this.$nextTick(() => this.$refs.input && this.$refs.input.focus()); } },
    pick(o) { this.$emit('update:modelValue', o.value); this.open = false; this.q = ''; },
    move(d) { const n = this.filtered.length; if (!n) return; this.hi = (this.hi + d + n) % n; },
    enter() { const o = this.filtered[this.hi]; if (o) this.pick(o); },
    close() { this.open = false; }
  },
  template: `
    <div class="ss-wrap" style="position:relative;display:inline-block" v-click-outside-ss="close">
      <button type="button" class="form-control ss-trigger ss-trigger-btn"
        @click="toggle">
        <span :style="{ color: selectedLabel ? 'var(--text)' : 'var(--text-muted)' }">{{ selectedLabel || placeholder }}</span>
        <span style="color:var(--text-muted);font-size:10px">▼</span>
      </button>
      <div v-if="open" class="ss-panel"
        style="position:absolute;z-index:300;top:calc(100% + 4px);left:0;min-width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sm);box-shadow:0 6px 24px rgba(0,0,0,0.25);padding:6px">
        <input ref="input" v-model="q" class="form-control" placeholder="輸入關鍵字…"
          style="width:100%;height:30px;font-size:var(--fs-sm);padding:4px 8px;margin-bottom:6px"
          @keydown.down.prevent="move(1)" @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="enter" @keydown.esc.prevent="close" />
        <div style="max-height:240px;overflow:auto">
          <div v-for="(o, i) in filtered" :key="o.value"
            class="ss-opt"
            :style="{ padding:'6px 8px', borderRadius:'var(--radius-sm)', cursor:'pointer', fontSize:'var(--fs-base)', color:'var(--text)', background: i === hi ? 'var(--bg)' : 'transparent' }"
            @mouseenter="hi = i" @click="pick(o)">
            {{ o.label }}
          </div>
          <div v-if="filtered.length === 0" style="padding:6px 8px;color:var(--text-muted);font-size:var(--fs-sm)">無符合項目</div>
        </div>
      </div>
    </div>
  `
});

// 點外面收合：輕量 directive，僅本元件用
window.SearchableSelect.directives = {
  'click-outside-ss': {
    mounted(el, binding) {
      el.__ssOutside = e => { if (!el.contains(e.target)) binding.value(); };
      document.addEventListener('mousedown', el.__ssOutside);
    },
    unmounted(el) { document.removeEventListener('mousedown', el.__ssOutside); }
  }
};
