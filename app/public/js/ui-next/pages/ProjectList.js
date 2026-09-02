(function () {
  // 專案清單只共用 API、UnreadStore 與確認視窗；不再委派 Legacy View 的生命週期或方法。
  window.UiNextProjectListView = Vue.defineComponent({
    name: "UiNextProjectListView",
    components: { ReleaseModal: window.ReleaseModal, UiNextIcon: window.UiNextIcon },
    data() { return { projects: [], loading: true, loadError: "", search: "", showAddForm: false, newProject: { name: "", folder_name: "", odoo_version: "", description: "", edition: "community" }, folderNameTouched: false, formError: "", saving: false, releaseId: null, moreProjectId: null }; },
    computed: {
      // 新手教程要有一張專案卡可以指，但新帳號一個專案都沒有 → 教程開著時插一張示範專案
      // （只在畫面上，不進 this.projects，也不會被送出或刪除）。刪掉 tour-demo.js 即自動消失。
      allProjects() { const sorted = [...this.projects].sort((a, b) => (b.is_favorite ? 1 : 0) - (a.is_favorite ? 1 : 0)); const demo = window.TourDemo; return demo && demo.active ? [demo.project(), ...sorted] : sorted; },
      filteredProjects() { const query = this.search.toLowerCase(); return !query ? this.allProjects : this.allProjects.filter((project) => project.name.toLowerCase().includes(query) || (project.description || "").toLowerCase().includes(query) || (project.odoo_version || "").toLowerCase().includes(query)); },
      folderNameError() { const folder = this.newProject.folder_name.trim(); return !folder ? "請填寫英文資料夾名稱。" : !/^[a-zA-Z0-9_-]+$/.test(folder) ? "只能使用英文、數字、底線或連字號。" : ""; },
    },
    async created() { await this.load(); },
    mounted() { this._onProjectMoreOutside = (event) => { if (!event.target.closest('.ui-next-project-more')) this.moreProjectId = null; }; document.addEventListener('pointerdown', this._onProjectMoreOutside); },
    beforeUnmount() { document.removeEventListener('pointerdown', this._onProjectMoreOutside); },
    methods: {
      async load() { this.loading = true; this.loadError = ""; try { this.projects = await Api.get("projects"); this.projects.forEach((project) => { window.UnreadStore.byProject[String(project.id)] = project.unread_count || 0; }); } catch (error) { this.loadError = error.message || "無法載入專案"; showToast(this.loadError, "error", 0); } finally { this.loading = false; } },
      onAddFormKeydown(event) {
        if (event.key === "Escape") { this.closeAddForm(); return; }
        if (event.key !== "Tab") return;
        const box = this.$refs.projectCreateModal;
        const items = box ? [...box.querySelectorAll('a[href], input, select, textarea, button:not([disabled])')].filter((el) => el.offsetParent !== null) : [];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      },
      openAddForm() { this.formError = ""; this.folderNameTouched = false; this.showAddForm = true; this.$nextTick(() => this.$refs.projectNameInput?.focus()); },
      closeAddForm() { this.showAddForm = false; this.formError = ""; this.newProject = { name: "", folder_name: "", odoo_version: "", description: "", edition: "community" }; },
      async add() { if (!this.newProject.name.trim() || !this.newProject.odoo_version.trim()) { this.formError = "請填寫專案名稱和 Odoo 版本。"; return; } if (this.folderNameError) { this.formError = this.folderNameError; return; } this.saving = true; this.formError = ""; try { await Api.post("projects", { ...this.newProject, name: this.newProject.name.trim(), folder_name: this.newProject.folder_name.trim(), odoo_version: this.newProject.odoo_version.trim() }); this.closeAddForm(); await this.load(); showToast("已新增專案", "success"); } catch (error) { this.formError = error.message || "無法新增專案，請重試。"; } finally { this.saving = false; } },
      // requireText 打字確認是刻意的：這個動作會連本機 clone 的程式碼一起刪掉且無法復原。
      async remove(project) { if (!await confirmDialog({ title: "刪除專案", message: `此動作會連帶刪除「${project.name}」下所有 repo 的本機程式碼，且無法復原。`, danger: true, requireText: project.name, confirmText: "刪除專案" })) return; try { await Api.delete(`projects/${project.id}`); await this.load(); showToast("已刪除", "success"); } catch (error) { showToast(error.message || "刪除專案失敗", "error", 0); } },
      async toggleFavorite(project) { const next = !project.is_favorite; project.is_favorite = next; try { if (next) await Api.post(`projects/${project.id}/favorite`, {}); else await Api.delete(`projects/${project.id}/favorite`); } catch (error) { project.is_favorite = !next; showToast(error.message || "更新我的最愛失敗", "error", 0); } },
      unread(id) { return window.UnreadStore.byProject[String(id)] || 0; }, go(id) { this.$router.push(`/projects/${id}`); }, goTab(id, tab) { this.moreProjectId = null; this.$router.push(`/projects/${id}?tab=${tab}`); },
      isAdmin() { return window.UserStore.role === "admin"; },
      async initWiki(id) { try { await Api.post(`projects/${id}/wiki/init`, {}); await this.load(); showToast("Wiki 初始化完成", "success"); } catch (error) { showToast(error.message || "Wiki 初始化失敗", "error", 6000); } },
      async openEnv(id) { const popup = window.open("about:blank", "_blank"); try { const url = await pollEnvSso(id); if (popup) popup.location = url; else window.location.href = url; } catch (error) { if (popup) popup.close(); showToast(error.message || "無法開啟測試區", "error", 0); } },
    },
    template: `
      <section class="ui-next-page ui-next-project-page">
<header class="ui-next-page-head">
<div>
<h1>專案</h1>
<p>管理程式庫、測試環境、對話與交付流程。</p>
</div>
<button v-if="!showAddForm" class="ui-next-primary" data-tour="proj-add" @click="openAddForm">新增專案</button>
</header>
<div v-if="showAddForm" class="ui-next-task-modal-backdrop" @mousedown.self="closeAddForm" @keydown="onAddFormKeydown">
<section ref="projectCreateModal" class="ui-next-task-modal ui-next-form-modal" data-tour="proj-form" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
<header>
<h2 id="project-create-title">新增專案</h2>
<button type="button" class="ui-next-modal-close" @click="closeAddForm" aria-label="關閉"><ui-next-icon name="close"/></button>
</header>
<div class="ui-next-form-modal-grid">
<label>專案名稱<input ref="projectNameInput" v-model="newProject.name" autocomplete="off"></label>
<label>Odoo 版本<input v-model="newProject.odoo_version" placeholder="例如 17.0"></label>
<label>英文資料夾名稱<input v-model="newProject.folder_name" autocomplete="off" aria-describedby="project-folder-help" @blur="folderNameTouched=true">
<small id="project-folder-help" :class="{error:folderNameTouched&&folderNameError}">{{ (folderNameTouched&&folderNameError) || '只能使用英文、數字、底線或連字號。' }}</small>
</label>
<label>版本類型<select v-model="newProject.edition">
<option value="community">Community</option>
<option value="enterprise">Enterprise</option>
</select></label>
<label class="ui-next-form-modal-wide">專案描述（選填）<textarea v-model="newProject.description"></textarea></label>
</div>
<p v-if="formError" class="ui-next-inline-error" role="alert">{{ formError }}</p>
<footer><button type="button" @click="closeAddForm">取消</button><button class="ui-next-primary" @click="add" :disabled="saving">{{ saving?'建立中…':'建立專案' }}</button></footer>
</section>
</div>
<div class="ui-next-project-search">
<input v-model="search" placeholder="搜尋專案名稱、版本或說明…">
<span>{{ filteredProjects.length }} 個專案</span>
</div>
<div v-if="loading" class="ui-next-project-grid ui-next-project-grid-rich">
<article v-for="i in 3" :key="i" class="ui-next-project-skeleton">
<header>
<Skeleton width="18px" height="18px" radius="50%" />
<Skeleton width="120px" height="12px" />
</header>
<Skeleton width="180px" height="18px" />
<Skeleton width="90%" height="13px" />
<div class="ui-next-project-facts">
<Skeleton width="70px" height="12px" />
<Skeleton width="90px" height="12px" />
<Skeleton width="80px" height="12px" />
</div>
<footer>
<Skeleton width="64px" height="28px" radius="7px" />
<Skeleton width="64px" height="28px" radius="7px" />
<Skeleton width="64px" height="28px" radius="7px" />
</footer>
</article>
</div>
<div v-else-if="loadError" class="ui-next-loading-card ui-next-error-text">{{ loadError }} <button type="button" @click="load">重試</button></div>
<template v-else>
<div class="ui-next-project-grid ui-next-project-grid-rich">
<article v-for="project in filteredProjects" :key="project.id">
<header class="ui-next-project-card-title">
<button class="ui-next-project-title-open" @click="go(project.id)"><h2>{{ project.name }} <small>Odoo {{ project.odoo_version }} · {{ project.edition==='enterprise'?'企業版':'社群版' }}</small></h2></button>
<div class="ui-next-project-more"><button type="button" :aria-expanded="moreProjectId===project.id" :aria-label="'專案「'+project.name+'」更多操作'" @click="moreProjectId=moreProjectId===project.id?null:project.id"><ui-next-icon name="dots"/></button><div v-if="moreProjectId===project.id" class="ui-next-project-more-menu"><button type="button" @click="openEnv(project.id);moreProjectId=null">測試區</button><button type="button" @click="releaseId=project.id;moreProjectId=null" :disabled="!project.repo_count">上正式</button><button type="button" @click="goTab(project.id,'repos')">REPO</button><button type="button" @click="goTab(project.id,'db')">連線設定</button><button type="button" @click="go(project.id);moreProjectId=null">專案設定</button><button type="button" @click="goTab(project.id,'chat')">問答</button><button type="button" @click="goTab(project.id,'wiki')">Wiki</button><button type="button" @click="goTab(project.id,'sop')">部署 SOP</button><button v-if="!project.has_wiki" type="button" @click="initWiki(project.id);moreProjectId=null">初始化 Wiki</button><button v-if="isAdmin()" type="button" class="danger" @click="remove(project);moreProjectId=null">刪除專案</button></div></div>
<button v-if="project.id!=='demo'" @click="toggleFavorite(project)" :class="{active:project.is_favorite}" :aria-label="project.is_favorite?'取消我的最愛':'加入我的最愛'"><ui-next-icon :name="project.is_favorite?'star-filled':'star'"/></button>
</header>
<div class="ui-next-project-facts">
<span>{{ project.repo_count || 0 }} 個 Repo</span>
<span>未讀 Chat <b v-if="unread(project.id)" class="ui-next-unread-badge">{{ unread(project.id) }}</b><template v-else>：無</template></span>
<span>{{ project.folder_name || '尚未設定資料夾' }}</span>
</div>
<button v-if="project.description" class="ui-next-project-open ui-next-project-note" @click="go(project.id)">
<p>{{ project.description }}</p>
</button>
<div v-else class="ui-next-project-note is-empty" aria-hidden="true"></div>

</article>
<p v-if="!filteredProjects.length" class="ui-next-empty-state">{{ search ? '找不到符合的專案。' : '尚無專案。' }} <button v-if="search" type="button" @click="search=''">清除搜尋</button></p>
</div>
</template>
<ReleaseModal v-if="releaseId" :key="releaseId" :project-id="releaseId" @close="releaseId=null" />
</section>`,
  });

})();
