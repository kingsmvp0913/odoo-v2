(function () {
  const { UiNextStatusBar } = window.UiNextShared;

  window.UiNextTaskListView = Vue.defineComponent({
    name: "UiNextTaskListView",
    components: { StatusBar: UiNextStatusBar, UiNextIcon: window.UiNextIcon },
    data() { return { tasks: [], archivedTasks: [], filter: "needs_action", releaseFilter: "all", search: "", sort: "updated_desc", loading: true, loadError: "", syncing: false, batchMode: false, selectedIds: [], batchWorking: false, showAdd: false, adding: false, addError: "", addTrigger: null, projects: [], newTask: { title: "", original_text: "", project_id: "" }, newFiles: [], projectFilter: "", statusFilter: "", sourceFilter: "", filtersOpen: false, moreTaskId: null, showAllUsers: false, ownerFilter: "", users: [], maintenance: false }; },
    computed: {
      isAdmin() { return window.UserStore.role === "admin"; },
      // ownerFilter 與 showAllUsers 都刻意不進網址列：它們是「這次看別人任務」的臨時狀態，
      // 一旦被記住，下次進來會是「showAllUsers 關著、ownerFilter 還開著」＝看不見的篩選把列表清空。
      ownerOptions() { return this.users.map((user) => ({ value: user.id, label: user.display_name || user.username })); },
      // Vue template 不會把全域 window 暴露到 component scope；在此注入 registry，
      // 避免開啟篩選時讀取 undefined 而卸載整個任務頁。
      statusOptions() {
        return Object.entries(window.STATUS_LABELS || {}).map(([value, label]) => ({ value, label }));
      },
      realFilteredTasks() { let list = this.filter === "archived" ? this.archivedTasks : this.filter === "paused" ? this.tasks.filter((task) => task.is_paused) : this.filter === "needs_action" ? this.tasks.filter((task) => this.needsAction(task) && (task.status === "stopped" || !task.is_paused)) : this.filter === "pending" ? this.tasks.filter((task) => !task.is_paused && task.status !== "done") : this.tasks; return this.applySort(list.filter((task) => this.matchAll(task))); },
      filteredTasks() { return this.realFilteredTasks; },
      needsActionCount() { return this.tasks.filter((task) => this.needsAction(task) && (task.status === "stopped" || !task.is_paused)).length; },
      needsActionShown() { return this.tasks.filter((task) => this.needsAction(task) && (task.status === "stopped" || !task.is_paused) && this.matchAll(task)).length; },
      pendingShown() { return this.tasks.filter((task) => !task.is_paused && task.status !== "done" && this.matchAll(task)).length; },
      pausedShown() { return this.tasks.filter((task) => task.is_paused && this.matchAll(task)).length; },
      allShown() { return this.tasks.filter((task) => this.matchAll(task)).length; },
      allSelected() { return this.filteredTasks.length > 0 && this.filteredTasks.every((task) => this.selectedIds.includes(task.id)); },
      activeFilterCount() { return [this.projectFilter, this.ownerFilter, this.statusFilter, this.sourceFilter, this.search].filter(Boolean).length + (this.releaseFilter !== "all" ? 1 : 0); },
    },
    watch: {
      filter() { this.selectedIds = []; this.batchMode = false; this.syncQuery(); this.load(); },
      projectFilter() { this.syncQuery(); }, statusFilter() { this.syncQuery(); }, sourceFilter() { this.syncQuery(); },
      search() { this.syncQuery(); }, sort() { this.syncQuery(); }, releaseFilter() { this.syncQuery(); },
      "$route.query": {
        deep: true,
        handler(query) {
          const tab = ["needs_action", "pending", "paused", "all", "archived"].includes(query.tab) ? query.tab : "needs_action";
          if (this.filter !== tab) this.filter = tab;
          const values = { projectFilter: query.project || "", statusFilter: query.status || "", sourceFilter: query.source || "", search: query.q || "", sort: query.sort || "updated_desc", releaseFilter: query.release || "all" };
          Object.entries(values).forEach(([key, value]) => { if (this[key] !== value) this[key] = value; });
        },
      },
    },
    async created() {
      const tab = this.$route.query.tab, query = this.$route.query;
      if (["needs_action", "pending", "paused", "all", "archived"].includes(tab)) this.filter = tab;
      this.projectFilter = query.project || ""; this.statusFilter = query.status || ""; this.sourceFilter = query.source || "";
      this.search = query.q || ""; this.sort = query.sort || "updated_desc"; this.releaseFilter = query.release || "all";
      await Promise.all([this.load(), Api.get("projects").then((projects) => { this.projects = projects || []; }).catch(() => {}), Api.get("maintenance").then((r) => { this.maintenance = r.maintenance; }).catch(() => {})]);
    },
    // SocketManager 只留得住一個 callback：離開頁面沒解除的話，下一頁的即時事件仍會打這一頁的 refresh。
    mounted() { SocketManager.setRefreshCallback(this.refresh.bind(this)); },
    beforeUnmount() { SocketManager.setRefreshCallback(null); },
    methods: {
      matchAll(task) { const query = this.search.toLowerCase().trim(); const matchesSearch = !query || [task.title, task.task_id, task.source, task.module, task.project_name].some((value) => (value || "").toLowerCase().includes(query)); const matchesRelease = this.releaseFilter === "released" ? !!task.merged_to_main_at : this.releaseFilter === "pending_release" ? !!task.approved_at && !task.merged_to_main_at : true; return matchesSearch && matchesRelease && (!this.projectFilter || String(task.project_id) === String(this.projectFilter)) && (!this.ownerFilter || String(task.owner_id) === String(this.ownerFilter)) && (!this.statusFilter || task.status === this.statusFilter) && (!this.sourceFilter || task.source === this.sourceFilter); },
      // 一定要重新取資料：showAllUsers 決定打的是 tasks 還是 tasks?all=true。
      // users 在這裡才抓不在 created()：UserStore.role 由 router.afterEach 非同步填，
      // created() 當下 isAdmin 還是 false，那時抓就永遠抓不到，使用者下拉會是空的。
      async toggleAllUsers() { this.showAllUsers = !this.showAllUsers; if (!this.showAllUsers) this.ownerFilter = ""; else if (!this.users.length) Api.get("admin/users").then((users) => { this.users = users || []; }).catch(() => {}); await this.load(); },
      refresh() { Api.get(this.showAllUsers ? "tasks?all=true" : "tasks").then((data) => { this.tasks = data.tasks || data; if (!this.showAllUsers) window.needsActionCount.value = this.needsActionCount; }).catch(() => {}); if (this.filter === "archived") Api.get("tasks?archived=true").then((data) => { this.archivedTasks = data.tasks || data; }).catch(() => {}); Api.get("maintenance").then((r) => { this.maintenance = r.maintenance; }).catch(() => {}); },
      syncQuery() {
        const query = { ...this.$route.query, tab: this.filter };
        const values = { project: this.projectFilter, status: this.statusFilter, source: this.sourceFilter, q: this.search, sort: this.sort === "updated_desc" ? "" : this.sort, release: this.releaseFilter === "all" ? "" : this.releaseFilter };
        Object.entries(values).forEach(([key, value]) => { if (value) query[key] = value; else delete query[key]; });
        if (JSON.stringify(query) !== JSON.stringify(this.$route.query)) this.$router.replace({ query });
      },
      clearFilters() { this.search = ""; this.releaseFilter = "all"; this.projectFilter = ""; this.ownerFilter = ""; this.statusFilter = ""; this.sourceFilter = ""; },
      applySort(list) { const timestamp = (value) => new Date(value || 0).getTime(); return list.slice().sort((a, b) => this.sort === "created_desc" ? timestamp(b.created_at) - timestamp(a.created_at) : this.sort === "title_asc" ? (a.title || a.task_id || "").localeCompare(b.title || b.task_id || "", "zh-Hant") : this.sort === "status_asc" ? (a.status || "").localeCompare(b.status || "") : timestamp(b.updated_at || b.created_at) - timestamp(a.updated_at || a.created_at)); },
      needsAction(task) { return (window.HUMAN_STATUSES || []).includes(task.status); }, isRunning(task) { return (window.RUNNABLE_STATUSES || []).includes(task.status); }, isStopped(task) { return task.status === "stopped" || task.status === "merge_conflict"; }, statusLabel(status) { return (window.STATUS_LABELS || {})[status] || status; }, sourceLabel(source) { return source === "odoo" ? "Odoo" : source === "service" ? "eService" : source === "manual" ? "手動增加" : source; }, timeAgo(value) { const delta = Date.now() - new Date(value).getTime(); return delta < 60000 ? "剛剛" : delta < 3600000 ? `${Math.floor(delta / 60000)} 分鐘前` : delta < 86400000 ? `${Math.floor(delta / 3600000)} 小時前` : `${Math.floor(delta / 86400000)} 天前`; },
      async load() { this.loading = true; this.loadError = ""; try { const data = await Api.get(this.filter === "archived" ? "tasks?archived=true" : this.showAllUsers ? "tasks?all=true" : "tasks"); if (this.filter === "archived") this.archivedTasks = data.tasks || data; else { this.tasks = data.tasks || data; if (!this.showAllUsers) window.needsActionCount.value = this.needsActionCount; } } catch (error) { this.loadError = error.message || "無法載入任務"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      taskPath(task) { return { path: `/task/${task.id}`, query: { from: this.filter } }; }, openTask(task) { this.$router.push(this.taskPath(task)); }, onTaskKeydown(task, event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.openTask(task); } }, toggleBatchMode() { this.batchMode = !this.batchMode; if (!this.batchMode) this.selectedIds = []; }, toggleSelect(id, event) { event.stopPropagation(); const index = this.selectedIds.indexOf(id); if (index < 0) this.selectedIds.push(id); else this.selectedIds.splice(index, 1); }, toggleSelectAll() { this.selectedIds = this.allSelected ? [] : this.filteredTasks.map((task) => task.id); },
      openAdd(event) { this.newTask = { title: "", original_text: "", project_id: "" }; this.newFiles = []; this.addError = ""; this.addTrigger = event?.currentTarget || null; this.showAdd = true; this.$nextTick(() => this.$refs.newTaskTitle?.focus()); }, closeAdd() { this.showAdd = false; this.$nextTick(() => this.addTrigger?.focus()); }, onAddFilesSelected(event) { const files = Array.from(event.target.files || []); this.addError = files.length > 5 ? "最多上傳 5 個附件，請重新選擇。" : ""; this.newFiles = files.slice(0, 5); event.target.value = ""; }, removeAddFile(index) { this.newFiles.splice(index, 1); }, trapAddFocus(event) { if (event.key === "Escape") return this.closeAdd(); if (event.key !== "Tab") return; const items = Array.from(this.$refs.taskCreateModal?.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])") || []); if (!items.length) return; const first = items[0], last = items[items.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }, async submitAdd() { if (!this.newTask.project_id || !this.newTask.title.trim() || !this.newTask.original_text.trim()) { this.addError = "請完整填寫專案、標題與內容。"; return; } this.adding = true; this.addError = ""; try { const form = new FormData(); form.append("title", this.newTask.title.trim()); form.append("original_text", this.newTask.original_text); form.append("project_id", this.newTask.project_id); this.newFiles.forEach((file) => form.append("files", file)); await Api.postForm("tasks", form); this.showAdd = false; this.filter = "all"; showToast("已新增任務", "success"); } catch (error) { this.addError = error.message || "新增任務失敗"; showToast(this.addError, "error", 0); } finally { this.adding = false; } },
      async syncNow() { this.syncing = true; try { await Api.post("sync/now", {}); await this.load(); showToast("同步完成", "success"); } catch (error) { showToast(error.message || "同步失敗", "error", 0); } finally { this.syncing = false; } }, async togglePause(task, event) { event.stopPropagation(); try { const result = await Api.put(`tasks/${task.id}/pause`, {}); task.is_paused = result.is_paused; showToast(result.is_paused ? "任務已暫停" : "任務已恢復", "success"); } catch (error) { showToast(error.message || "更新失敗", "error", 0); } },
      async batchPause() { await this.batch("pause"); }, async batchArchive() { await this.batch("archive"); }, async batchUnarchive() { await this.batch("unarchive"); }, async batchDelete() { if (!this.selectedIds.length || !await confirmDialog({ title: "永久刪除任務", message: `確定永久刪除選取的 ${this.selectedIds.length} 筆任務？`, danger: true, confirmText: "刪除" })) return; await this.batch("delete"); }, async batch(action) { if (!this.selectedIds.length) return; this.batchWorking = true; try { await Api.post(`tasks/batch/${action}`, action === "pause" ? { ids: this.selectedIds, paused: true } : { ids: this.selectedIds }); this.selectedIds = []; await this.load(); showToast("批次操作完成", "success"); } catch (error) { showToast(error.message || "批次操作失敗", "error", 0); } finally { this.batchWorking = false; } },
      async archiveTask(task) { if (!await confirmDialog({ title: "封存任務", message: `確定要封存任務「${task.title || task.task_id}」？`, confirmText: "封存" })) return; try { await Api.post(`tasks/${task.id}/archive`, {}); this.tasks = this.tasks.filter((item) => item.id !== task.id); this.moreTaskId = null; showToast("任務已封存", "success"); } catch (error) { showToast(error.message || "封存失敗", "error", 0); } },
      async unarchiveTask(task) { try { await Api.post(`tasks/${task.id}/unarchive`, {}); this.archivedTasks = this.archivedTasks.filter((item) => item.id !== task.id); this.moreTaskId = null; showToast("任務已解除封存", "success"); } catch (error) { showToast(error.message || "解除封存失敗", "error", 0); } },
      async deleteTask(task) { if (!await confirmDialog({ title: "永久刪除任務", message: `確定要永久刪除任務「${task.title || task.task_id}」？`, danger: true, confirmText: "刪除" })) return; try { await Api.delete(`tasks/${task.id}`); this.tasks = this.tasks.filter((item) => item.id !== task.id); this.archivedTasks = this.archivedTasks.filter((item) => item.id !== task.id); this.moreTaskId = null; showToast("任務已刪除", "success"); } catch (error) { showToast(error.message || "刪除失敗", "error", 0); } },
    },
    template: `
      <section class="ui-next-page ui-next-task-page ui-next-task-page-rich">
<header class="ui-next-page-head">
<div>
<h1>任務列表</h1>
<p>跨專案追蹤開發、澄清與交付進度。</p>
</div>
<div class="ui-next-head-tools">
<button @click="toggleBatchMode">{{ batchMode?'取消批次':'批次' }}</button>
<button @click="syncNow" :disabled="syncing">{{ syncing?'同步中…':'同步' }}</button>
<button class="ui-next-primary ui-next-cta" @click="openAdd($event)"><ui-next-icon name="plus"/>建立任務</button>
</div>
</header>
<div v-if="maintenance" class="ui-next-maintenance-banner">系統維護中，任務暫停推進</div>
<div v-if="showAdd" class="ui-next-task-modal-backdrop" @click.self="closeAdd" @keydown="trapAddFocus">
<section ref="taskCreateModal" class="ui-next-task-modal ui-next-form-modal" role="dialog" aria-modal="true" aria-labelledby="ui-next-task-create-title">
<header><h2 id="ui-next-task-create-title">建立任務</h2><button type="button" class="ui-next-modal-close" aria-label="關閉建立任務視窗" @click="closeAdd"><ui-next-icon name="close"/></button></header>
<div class="ui-next-form-modal-grid">
<label class="ui-next-form-modal-wide">專案
<select v-model="newTask.project_id">
<option value="">選擇專案</option>
<option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
</select></label>
<label class="ui-next-form-modal-wide">任務標題<input ref="newTaskTitle" v-model="newTask.title" required></label>
<label class="ui-next-form-modal-wide">需求描述<textarea v-model="newTask.original_text" required></textarea></label>
<label class="ui-next-form-modal-wide ui-next-upload">附件（最多 5 個）
<input type="file" multiple @change="onAddFilesSelected">
<span class="ui-next-upload-drop"><ui-next-icon name="paperclip"/><b>點此選擇檔案</b><small>最多 5 個</small></span>
</label>
<div v-if="newFiles.length" class="ui-next-form-modal-wide ui-next-upload-list">
<span v-for="(file,index) in newFiles" :key="file.name+file.size+index" class="ui-next-file-preview"><ui-next-icon name="paperclip"/><em>{{ file.name }}</em><button type="button" :aria-label="'移除附件：'+file.name" @click="removeAddFile(index)"><ui-next-icon name="close"/></button></span>
</div>
</div>
<p v-if="addError" class="ui-next-inline-error" role="alert">{{ addError }}</p>
<footer><button type="button" @click="closeAdd">取消</button><button class="ui-next-primary" @click="submitAdd" :disabled="adding">{{ adding?'建立中…':'建立任務' }}</button></footer>
</section></div>
<div class="ui-next-task-tabs" role="group" aria-label="任務篩選">
<button v-for="item in [['needs_action','需回覆',needsActionShown],['pending','待處理',pendingShown],['paused','暫停中',pausedShown],['all','全部',allShown],['archived','已封存','']]" :key="item[0]" :class="{active:filter===item[0]}" :aria-pressed="filter===item[0] ? 'true' : 'false'" @click="filter=item[0]">{{ item[1] }} <b v-if="item[2]!==''">{{ item[2] }}</b>
</button>
</div>
<div class="ui-next-task-toolbar">
<input v-model="search" placeholder="搜尋標題、任務 ID、專案或來源…">
<button @click="filtersOpen=!filtersOpen">篩選 <b v-if="activeFilterCount">{{ activeFilterCount }}</b>
</button>
<select v-model="sort">
<option value="updated_desc">最近更新</option>
<option value="created_desc">最新建立</option>
<option value="title_asc">標題 A→Z</option>
<option value="status_asc">依狀態</option>
</select>
</div>
<div v-if="filtersOpen" class="ui-next-task-filters">
<button v-if="isAdmin" :class="{active:showAllUsers}" @click="toggleAllUsers" :title="showAllUsers?'目前顯示全部使用者的任務，點一下改回只顯示自己的':'目前只顯示自己的任務，點一下顯示全部使用者的'">顯示全部使用者</button>
<select v-if="isAdmin&&showAllUsers" v-model="ownerFilter">
<option value="">全部使用者</option>
<option v-for="owner in ownerOptions" :key="owner.value" :value="owner.value">{{ owner.label }}</option>
</select>
<select v-model="projectFilter">
<option value="">全部專案</option>
<option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
</select>
<select v-model="statusFilter">
<option value="">全部狀態</option>
<option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
</select>
<select v-model="sourceFilter">
<option value="">全部來源</option>
<option value="odoo">Odoo</option>
<option value="service">eService</option>
<option value="manual">手動增加</option>
</select>
<select v-model="releaseFilter">
<option value="all">全部（上正式）</option>
<option value="released">已上正式</option>
<option value="pending_release">待上正式</option>
</select>
<button @click="clearFilters">清除篩選</button>
</div>
<div v-if="batchMode" class="ui-next-batch-bar">
<label>
<input type="checkbox" :checked="allSelected" @change="toggleSelectAll"> 全選</label>
<span>已選 {{ selectedIds.length }} 筆</span>
<button @click="batchPause" :disabled="batchWorking||!selectedIds.length">暫停</button>
<button v-if="filter!=='archived'" @click="batchArchive" :disabled="batchWorking||!selectedIds.length">封存</button>
<button v-else @click="batchUnarchive" :disabled="batchWorking||!selectedIds.length">解除封存</button>
<button class="danger" @click="batchDelete" :disabled="batchWorking||!selectedIds.length">刪除</button>
</div>
<div v-if="loading" class="ui-next-loading-card">載入任務中…</div>
<div v-else-if="loadError" class="ui-next-loading-card"><p>{{ loadError }}</p><button class="ui-next-primary" @click="load">重試</button></div>
<div v-else class="ui-next-task-rich-list">
<article v-for="task in filteredTasks" :key="task.id" :class="{selected:selectedIds.includes(task.id),need:needsAction(task)&&!task.is_paused,running:isRunning(task)&&!task.is_paused}" :tabindex="batchMode?-1:0" @click="batchMode?toggleSelect(task.id,$event):openTask(task)" @keydown="!batchMode&&onTaskKeydown(task,$event)">
<div class="ui-next-task-rich-head">
<label v-if="batchMode">
<input type="checkbox" :aria-label="'選取任務：'+(task.title||task.task_id)" :checked="selectedIds.includes(task.id)" @click.stop="toggleSelect(task.id,$event)">
</label>
<div>
<h2><router-link :to="taskPath(task)" @click.stop>{{ task.title||task.task_id }}</router-link></h2>
<p>{{ statusLabel(task.status) }} · {{ task.project_name||'未分類專案' }} · {{ timeAgo(task.updated_at||task.created_at) }}</p>
</div>
<div class="ui-next-task-card-actions">
<button v-if="!batchMode&&!isStopped(task)&&task.status!=='done'" class="ui-next-pause-toggle" :title="task.is_paused?'繼續執行':'暫停'" :aria-label="(task.is_paused?'繼續執行':'暫停')+'：'+(task.title||task.task_id)" @click.stop="togglePause(task,$event)"><ui-next-icon :name="task.is_paused?'play':'pause'"/></button>
<button v-if="!batchMode" type="button" @click.stop="moreTaskId=moreTaskId===task.id?null:task.id" :aria-label="'更多操作：'+(task.title||task.task_id)" :aria-expanded="moreTaskId===task.id">更多</button>
<div v-if="moreTaskId===task.id" class="ui-next-task-more" @click.stop><button v-if="filter!=='archived'" type="button" @click="archiveTask(task)">封存</button><button v-else type="button" @click="unarchiveTask(task)">解除封存</button><button type="button" class="danger" @click="deleteTask(task)">刪除</button></div>
</div>
</div>
<div class="ui-next-task-rich-meta">
<span>{{ sourceLabel(task.source) }}</span>
<span v-if="task.env_status">測試機</span>
<span v-if="task.merged_to_main_at">已上正式</span>
<span v-if="showAllUsers&&task.owner_name">{{ task.owner_name }}</span>
<span v-if="task.module">{{ task.module }}</span>
</div>
<StatusBar :status="task.status" :source="task.source" :git-branch="task.git_branch" :e2e-disabled="task.e2e_disabled" />
</article>
<p v-if="!filteredTasks.length" class="ui-next-empty-state">{{ activeFilterCount ? '找不到符合篩選條件的任務。' : '目前沒有任務。' }} <button v-if="activeFilterCount" type="button" @click="clearFilters">清除篩選</button></p>
</div>
</section>`,
  });

})();
