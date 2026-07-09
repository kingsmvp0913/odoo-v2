window.TerminalView = Vue.defineComponent({
  name: 'TerminalView',
  data() {
    return {
      taskId: null,
      taskTitle: '',
      exitCode: null,
      running: false,
      error: ''
    };
  },
  async created() {
    this.taskId = parseInt(this.$route.params.id, 10);
    try {
      const data = await Api.get(`tasks/${this.taskId}`);
      this.taskTitle = data.task?.title || data.task?.task_id || `Task ${this.taskId}`;
      const status = data.task?.status;
      const ACTIVE = ['analysis_running','cs_running','coding_running','qa_running','merge_running','deploy_testing','playwright_running','wiki_updating'];
      this.running = ACTIVE.includes(status);
    } catch (e) {
      this.error = e.message;
    }
  },
  async mounted() {
    const term = new Terminal({
      theme: { background: '#1a1a1a', foreground: '#f0f0f0' },
      fontSize: 13,
      fontFamily: 'Consolas, monospace',
      convertEol: true,
      scrollback: 5000
    });
    term.open(this.$refs.termContainer);
    this._term = term;

    const taskId = this.taskId;

    // 先載入持久化歷史（事後回放），再掛 socket 續播即時輸出
    try {
      const events = await Api.get(`tasks/${taskId}/events`);
      if (Array.isArray(events) && events.length) {
        for (const ev of events) term.write(ev.content);
      } else {
        term.writeln('\x1b[90m（尚無執行紀錄）\x1b[0m');
      }
    } catch (e) { /* best-effort：載入失敗仍可看即時串流 */ }

    this._outputHandler = (data) => {
      if (data.taskId === taskId) term.write(data.data);
    };
    this._doneHandler = (data) => {
      if (data.taskId === taskId) {
        this.exitCode = data.exitCode;
        this.running = false;
        const color = data.exitCode === 0 ? '32' : '31';
        term.writeln(`\r\n\x1b[${color}m[Process exited with code ${data.exitCode}]\x1b[0m`);
      }
    };

    const sock = window._socket;
    if (sock) {
      sock.on('terminal:output', this._outputHandler);
      sock.on('terminal:done', this._doneHandler);
    }
  },
  beforeUnmount() {
    const sock = window._socket;
    if (sock && sock.off) {
      sock.off('terminal:output', this._outputHandler);
      sock.off('terminal:done', this._doneHandler);
    }
    this._term?.dispose();
  },
  methods: {
    goBack() { this.$router.push(`/task/${this.taskId}`); }
  },
  template: `
    <div class="topbar">
      <h1>執行歷程 <span style="font-weight:var(--fw-normal);font-size:var(--fs-md)">{{ taskTitle }}</span></h1>
      <button class="btn btn-outline btn-sm" @click="goBack">← 返回</button>
    </div>
    <div class="content" style="padding:0;display:flex;flex-direction:column;overflow:hidden">
      <div v-if="error" style="padding:var(--space-4);color:var(--error)">{{ error }}</div>
      <div v-else style="flex:1;display:flex;flex-direction:column;min-height:0">
        <div style="padding:var(--space-2) var(--space-4);background:var(--sidebar-bg);font-size:var(--fs-sm);color:var(--text-muted);display:flex;gap:var(--space-4);flex:none">
          <span>{{ running ? '⏳ 執行中...' : (exitCode === 0 ? '✅ 成功' : exitCode !== null ? '❌ 失敗 (code ' + exitCode + ')' : '⏸ 待機') }}</span>
          <span v-if="!running && exitCode === null" style="color:var(--text-muted)">等待 pipeline 啟動...</span>
        </div>
        <div ref="termContainer" style="flex:1;min-height:0;padding:var(--space-2)"></div>
      </div>
    </div>
  `
});
