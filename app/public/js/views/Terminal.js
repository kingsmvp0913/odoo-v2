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
  mounted() {
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
      <h1>終端機 <span style="font-weight:400;font-size:14px">{{ taskTitle }}</span></h1>
      <button class="btn btn-outline btn-sm" @click="goBack">← 返回</button>
    </div>
    <div class="content" style="padding:0">
      <div v-if="error" style="padding:16px;color:var(--error)">{{ error }}</div>
      <div v-else>
        <div style="padding:8px 16px;background:var(--sidebar-bg);font-size:12px;color:var(--text-muted);display:flex;gap:16px">
          <span>{{ running ? '⏳ 執行中...' : (exitCode === 0 ? '✅ 成功' : exitCode !== null ? '❌ 失敗 (code ' + exitCode + ')' : '⏸ 待機') }}</span>
          <span v-if="!running && exitCode === null" style="color:var(--text-muted)">等待 pipeline 啟動...</span>
        </div>
        <div ref="termContainer" style="height:calc(100vh - 120px);padding:8px"></div>
      </div>
    </div>
  `
});
