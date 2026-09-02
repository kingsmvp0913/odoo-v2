(function () {
  const { elapsed } = window.UiNextShared;

  window.UiNextPipelineView = Vue.defineComponent({
    name: "UiNextPipelineView",
    components: { UiNextIcon: window.UiNextIcon },
    data() {
      return {
        rows: [],
        chats: [],
        loading: true,
        rowsError: false,
        chatsError: false,
        refreshing: false,
        lastUpdated: null,
        pausingId: null,
        timer: null,
      };
    },
    computed: {
      offline() { return this.rowsError || this.chatsError; },
      lastUpdatedText() { return this.lastUpdated ? new Date(this.lastUpdated).toLocaleTimeString() : "—"; },
    },
    async mounted() {
      await this.load();
      this._onVisibility = () => {
        if (document.hidden) this.stopPolling();
        else { this.load(); this.startPolling(); }
      };
      document.addEventListener("visibilitychange", this._onVisibility);
      this.startPolling();
    },
    beforeUnmount() {
      this.stopPolling();
      document.removeEventListener("visibilitychange", this._onVisibility);
    },
    methods: {
      elapsed,
      statusLabel(status) {
        return window.STATUS_LABELS[status] || status;
      },
      startPolling() {
        if (!document.hidden && !this.timer) this.timer = setInterval(() => this.load(), 3000);
      },
      stopPolling() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      },
      // 兩區各自吞自己的錯，不共用一個 try：常駐 server 若還沒載入某個端點（部署到重啟之間就是
      // 這個狀態），共用的話那支失敗會連帶讓另一區停止更新。但「吞掉」不等於「不講」——
      // 端點掛掉時畫面若只寫「目前沒有執行中的 Pipeline」，就與真的沒任務完全無法分辨。
      // 單次失敗一律保留上一批避免閃爍；只有首次載入與手動重試才 toast，否則每 3 秒跳一次。
      async load(manual) {
        const notify = this.loading || manual;
        const [rows, chats] = await Promise.all([
          Api.get("admin/pipeline/active").catch((error) => { if (notify) showToast(error.message || "無法讀取執行中的任務", "error", 6000); return null; }),
          Api.get("admin/chat/active").catch((error) => { if (notify) showToast(error.message || "無法讀取進行中的問答", "error", 6000); return null; }),
        ]);
        if (rows) this.rows = rows.sort((a, b) => b.elapsed_ms - a.elapsed_ms);
        if (chats) this.chats = chats;
        this.rowsError = rows === null;
        this.chatsError = chats === null;
        if (rows || chats) this.lastUpdated = Date.now();
        this.loading = false;
      },
      async retry() { this.refreshing = true; try { await this.load(true); } finally { this.refreshing = false; } },
      async pause(row) {
        if (
          !(await confirmDialog({
            title: "暫停行程",
            message: `確定暫停並中止「${row.title || row.task_id}」？`,
            danger: true,
            confirmText: "暫停並中止",
          }))
        )
          return;
        this.pausingId = row.id;
        try {
          await Api.post(`admin/pipeline/tasks/${row.id}/pause`);
          await this.load();
          showToast("已暫停行程", "success");
        } catch (error) {
          showToast(error.message, "error");
        } finally {
          this.pausingId = null;
        }
      },
    },
    template: `
      <section class="ui-next-page ui-next-pipeline-page">
<header class="ui-next-page-head">
<div>
<button class="ui-next-back" @click="$router.push('/admin')"><ui-next-icon name="arrow-left"/>返回</button>
<p class="ui-next-eyebrow">即時監控</p>
<h1>進行中 Pipeline</h1>
<p>僅顯示真正執行中的任務與等待 AI 回覆的問答；每 3 秒更新一次。</p>
</div>
<div class="ui-next-pipeline-head-actions">
<span class="ui-next-live">
<i :class="{'is-down':offline}">
</i>{{ offline ? '連線異常' : '即時更新' }}<em>· 最後更新 {{ lastUpdatedText }}</em></span>
<button class="ui-next-pipeline-retry" @click="retry" :disabled="refreshing">{{ refreshing?'重試中…':'重新整理' }}</button>
</div>
</header>
<div v-if="loading" class="ui-next-pipeline-grid">
<section class="ui-next-panel" v-for="panel in 2" :key="panel">
<div class="ui-next-card-title">
<div>
<Skeleton width="120px" height="16px" />
<div style="margin-top:6px"><Skeleton width="70px" height="12px" /></div>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="i in 3" :key="i">
<div class="ui-next-run-stage"><Skeleton width="58px" height="11px" /></div>
<div>
<Skeleton width="160px" height="14px" />
<div style="margin-top:6px"><Skeleton width="120px" height="12px" /></div>
</div>
<Skeleton width="42px" height="12px" />
<Skeleton width="52px" height="30px" radius="7px" />
</article>
</div>
</section>
</div>
<template v-else>
<div class="ui-next-pipeline-grid">
<section class="ui-next-panel">
<div class="ui-next-card-title">
<div>
<h2>執行中的任務</h2>
<p>{{ rows.length }} 個行程</p>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="row in rows" :key="row.id">
<div class="ui-next-run-stage">
<i>
</i>
<span>{{ statusLabel(row.status) }}</span>
</div>
<div>
<b><router-link class="ui-next-run-title" :to="'/task/'+row.id">{{ row.title || row.task_id }}</router-link></b>
<span>{{ row.project_name || '未分類專案' }} · {{ row.display_name || row.username || '—' }}</span>
</div>
<time>{{ elapsed(row.elapsed_ms) }}</time>
<div>
<router-link :to="'/task/'+row.id">查看</router-link>
<button @click="pause(row)" :disabled="pausingId===row.id">{{ pausingId===row.id ? '處理中…' : '暫停' }}</button>
</div>
</article>
<p v-if="!rows.length" class="ui-next-empty-state">{{ rowsError ? '暫時無法讀取執行狀態（端點可能尚未載入），畫面顯示的是上一次成功取得的資料。' : '目前沒有執行中的 Pipeline。' }}</p>
</div>
</section>
<section class="ui-next-panel">
<div class="ui-next-card-title">
<div>
<h2>進行中的 AI 問答／互動</h2>
<p>{{ chats.length }} 段對話</p>
</div>
</div>
<div class="ui-next-run-list">
<article v-for="chat in chats" :key="chat.id">
<div class="ui-next-run-stage is-chat">
<i>
</i>
<span>AI 回覆中</span>
</div>
<div>
<b><router-link class="ui-next-run-title" :to="'/projects/'+chat.project_id+'/chat/'+chat.id">{{ chat.title || '未命名對話' }}</router-link></b>
<span>{{ chat.project_name || '未分類專案' }} · {{ chat.display_name || chat.username || '—' }}</span>
</div>
<time>{{ elapsed(chat.waited_ms) }}</time>
<div>
<router-link :to="'/projects/'+chat.project_id+'/chat/'+chat.id">查看</router-link>
</div>
</article>
<p v-if="!chats.length" class="ui-next-empty-state">{{ chatsError ? '暫時無法讀取問答狀態（端點可能尚未載入），畫面顯示的是上一次成功取得的資料。' : '目前沒有等待 AI 回覆的問答。' }}</p>
</div>
</section>
</div>
</template>
</section>`,
  });

})();
