// 自動部署 SOP：把「push 到 ai-dev/main 就自動 pull＋upgrade」這件事，整理成使用者照著做得完的步驟。
//
// 後端零改動是刻意的：SOP 需要的伺服器事實有一半已經在 db_connections（ssh_host／ssh_user／db_name／
// log_unit），剩下的（addons 路徑、conf 路徑、port、service 名稱）不入庫——第 1 步教使用者自己去查，
// 填在頁面上只是為了讓後面幾步的指令能長出真值可以複製。重新整理就沒了，這是刻意的：這些值會隨伺服器
// 改動而過期，存起來反而會讓人照著錯的指令跑。
//
// 哪個連線是正式、哪個是測試由使用者指認——db_connections 沒有這個語意欄位，猜錯的代價是把測試區的
// 指令貼到正式區。
window.DeploySopView = Vue.defineComponent({
  name: 'DeploySopView',
  data() {
    return {
      loading: true,
      project: null,
      repos: [],
      conns: [],
      // 使用者填的伺服器事實。connId 決定 SSH／DB 名稱從哪個連線帶，其餘四欄是第 1 步查出來的。
      prod: { connId: '', service: '', conf: '', addons: '', port: '8069' },
      test: { connId: '', service: '', conf: '', addons: '', port: '8070' },
      repoUrl: '',
      addon: '',
      branchTest: 'ai-dev',
      branchProd: 'main'
    };
  },
  async created() { await this.load(); },
  computed: {
    // 兩區的表單長得一樣，用同一段 template 跑兩次；帶的是 data 物件本身的參照，
    // 不是 'prod'／'test' 字串——template 裡沒有 this，用字串索引取不到東西。
    sides() {
      return [
        { key: 'prod', label: '正式區', d: this.prod, conn: this.prodConn, ssh: this.sshProd },
        { key: 'test', label: '測試區', d: this.test, conn: this.testConn, ssh: this.sshTest }
      ];
    },
    prodConn() { return this.conns.find(c => String(c.id) === String(this.prod.connId)) || null; },
    testConn() { return this.conns.find(c => String(c.id) === String(this.test.connId)) || null; },
    // 兩區指到同一個連線＝八成是還沒指認完，後面每一段指令都會把正式區的值填進測試區
    sameConn() {
      return !!this.prod.connId && String(this.prod.connId) === String(this.test.connId);
    },
    sshProd() { return this.sshLine(this.prodConn); },
    sshTest() { return this.sshLine(this.testConn); },
    cmdInspect() {
      return [
        '# 1) 有哪些 Odoo 服務、各自吃哪個設定檔',
        'systemctl list-units --type=service | grep -i odoo',
        'systemctl cat <服務名> | grep -E "ExecStart|Environment"',
        '',
        '# 2) 設定檔裡的 addons 路徑、port、資料庫',
        'grep -nE "addons_path|http_port|db_name|db_user" <設定檔路徑>',
        '',
        '# 3) 自訂模組在哪、屬於誰（權限決定 runner 帳號能不能寫）',
        'ls -l <addons 路徑>'
      ].join('\n');
    },
    cmdBackup() {
      const p = this.v(this.prod.addons, '<正式 addons 路徑>');
      return [
        '# 先備份整包 addons（切換前唯一的退路）',
        `sudo tar czf ~/addons-backup-$(date +%F).tar.gz ${p}`,
        '',
        '# 再把伺服器上的現況跟 repo 逐檔比對——這一步不能跳過：',
        '# 伺服器上若有人手改過而 repo 沒有，切換過去就靜默弄丟，且沒有任何錯誤訊息。',
        `git clone ${this.v(this.repoUrl, '<repo URL>')} ~/repo-check`,
        `diff -r ${p} ~/repo-check/${this.v(this.addon, '<模組名>')} | head -50`
      ].join('\n');
    },
    cmdAttachGit() {
      const conf = this.v(this.test.conf, '<測試設定檔路徑>');
      const dir = this.newAddonsDir(this.test.addons);
      return [
        '# 不在原地 git init 硬蓋既有目錄——那樣要復原只能靠備份。',
        '# 改成另 clone 一份、把設定檔的 addons_path 指過去，舊目錄原封不動留著當退路。',
        `git clone -b ${this.branchTest} ${this.v(this.repoUrl, '<repo URL>')} ${dir}`,
        '',
        '# 設定檔改 addons_path（先備份設定檔本身）',
        `sudo cp ${conf} ${conf}.bak`,
        `sudo sed -i "s#${this.v(this.test.addons, '<舊 addons 路徑>')}#${dir}#" ${conf}`,
        `grep -n addons_path ${conf}`,
        '',
        '# 重啟並確認服務起得來',
        `sudo systemctl restart ${this.v(this.test.service, '<測試服務名>')}`,
        `systemctl status ${this.v(this.test.service, '<測試服務名>')} --no-pager`,
        '',
        '# 正式區同樣做一次（確認測試區沒問題之後再做）'
      ].join('\n');
    },
    cmdRunner() {
      return [
        '# GitHub → repo → Settings → Actions → Runners → New self-hosted runner（Linux x64）',
        '# 照該頁給的 token 執行，以下是形狀，token 請用它產的那一串',
        'mkdir ~/actions-runner && cd ~/actions-runner',
        'curl -o actions-runner-linux-x64.tar.gz -L <該頁給的下載網址>',
        'tar xzf actions-runner-linux-x64.tar.gz',
        './config.sh --url <repo 網址> --token <該頁給的 token> --labels odoo-tower',
        '',
        '# 裝成開機自動啟動的服務（不要用 ./run.sh，斷線就停）',
        'sudo ./svc.sh install',
        'sudo ./svc.sh start',
        'sudo ./svc.sh status'
      ].join('\n');
    },
    cmdSudoers() {
      const u = (this.prodConn && this.prodConn.ssh_user) || '<登入帳號>';
      const sp = this.v(this.prod.service, '<正式服務名>');
      const st = this.v(this.test.service, '<測試服務名>');
      return [
        '# runner 是非互動執行，sudo 不能停下來問密碼。只開這幾條、不要給整個 NOPASSWD:ALL。',
        'sudo visudo -f /etc/sudoers.d/odoo-deploy',
        '',
        '# 貼入：',
        `${u} ALL=(ALL) NOPASSWD: /bin/systemctl start ${sp}, /bin/systemctl stop ${sp}, /bin/systemctl restart ${sp}, /bin/systemctl status ${sp}`,
        `${u} ALL=(ALL) NOPASSWD: /bin/systemctl start ${st}, /bin/systemctl stop ${st}, /bin/systemctl restart ${st}, /bin/systemctl status ${st}`
      ].join('\n');
    },
    // deploy.yml：兩個分支各自對應一區。用 ${{ }} 的地方一律走單引號字串，避免被 JS 樣板字串吃掉。
    deployYaml() {
      const L = [];
      L.push('name: deploy');
      L.push('');
      L.push('on:');
      L.push('  push:');
      L.push('    branches: [' + this.branchTest + ', ' + this.branchProd + ']');
      L.push('');
      L.push('jobs:');
      L.push('  deploy:');
      L.push('    runs-on: [self-hosted, odoo-tower]');
      L.push('    steps:');
      L.push('      - uses: actions/checkout@v4');
      L.push('');
      L.push('      - name: 決定要部署哪一區');
      L.push('        id: target');
      L.push('        run: |');
      L.push("          if [ \"${{ github.ref_name }}\" = \"" + this.branchProd + '" ]; then');
      L.push('            echo "dir=' + this.newAddonsDir(this.prod.addons) + '" >> $GITHUB_OUTPUT');
      L.push('            echo "svc=' + this.v(this.prod.service, '<正式服務名>') + '" >> $GITHUB_OUTPUT');
      L.push('            echo "conf=' + this.v(this.prod.conf, '<正式設定檔>') + '" >> $GITHUB_OUTPUT');
      L.push('            echo "db=' + this.dbOf(this.prodConn) + '" >> $GITHUB_OUTPUT');
      L.push('            echo "port=' + this.v(this.prod.port, '8069') + '" >> $GITHUB_OUTPUT');
      L.push('            echo "prod=1" >> $GITHUB_OUTPUT');
      L.push('          else');
      L.push('            echo "dir=' + this.newAddonsDir(this.test.addons) + '" >> $GITHUB_OUTPUT');
      L.push('            echo "svc=' + this.v(this.test.service, '<測試服務名>') + '" >> $GITHUB_OUTPUT');
      L.push('            echo "conf=' + this.v(this.test.conf, '<測試設定檔>') + '" >> $GITHUB_OUTPUT');
      L.push('            echo "db=' + this.dbOf(this.testConn) + '" >> $GITHUB_OUTPUT');
      L.push('            echo "port=' + this.v(this.test.port, '8070') + '" >> $GITHUB_OUTPUT');
      L.push('            echo "prod=0" >> $GITHUB_OUTPUT');
      L.push('          fi');
      L.push('');
      L.push('      - name: 拉最新程式碼');
      L.push('        run: |');
      L.push('          cd ${{ steps.target.outputs.dir }}');
      L.push('          git fetch --all');
      L.push('          git reset --hard origin/${{ github.ref_name }}');
      L.push('');
      L.push('      - name: 依這次改動的檔案推算要升級哪些模組');
      L.push('        id: mods');
      L.push('        run: |');
      L.push('          BEFORE="${{ github.event.before }}"');
      L.push('          case "$BEFORE" in 0000000*|"") BEFORE="HEAD~1" ;; esac');
      L.push('          MODS=$(git diff --name-only "$BEFORE" "${{ github.sha }}" \\');
      L.push("            | cut -d/ -f1 | sort -u | grep -v '^\\.' | paste -sd, -)");
      L.push('          echo "list=${MODS}" >> $GITHUB_OUTPUT');
      L.push('          echo "要升級：${MODS:-（無，跳過）}"');
      L.push('');
      L.push('      - name: 正式區升級前先備份資料庫');
      L.push("        if: steps.target.outputs.prod == '1' && steps.mods.outputs.list != ''");
      L.push('        run: |');
      L.push('          pg_dump -Fc -d ${{ steps.target.outputs.db }} \\');
      L.push('            -f ~/db-backup-${{ steps.target.outputs.db }}-$(date +%F-%H%M).dump');
      L.push('');
      L.push('      - name: 停服務 → 升級 → 起服務');
      L.push("        if: steps.mods.outputs.list != ''");
      L.push('        run: |');
      L.push('          sudo systemctl stop ${{ steps.target.outputs.svc }}');
      L.push('          odoo-bin -c ${{ steps.target.outputs.conf }} \\');
      L.push('            -d ${{ steps.target.outputs.db }} \\');
      L.push('            -u ${{ steps.mods.outputs.list }} --stop-after-init');
      L.push('          sudo systemctl start ${{ steps.target.outputs.svc }}');
      L.push('');
      L.push('      - name: 起得來才算成功');
      L.push('        run: |');
      L.push('          for i in $(seq 1 30); do');
      L.push('            curl -sf http://localhost:${{ steps.target.outputs.port }}/web/login > /dev/null && exit 0');
      L.push('            sleep 2');
      L.push('          done');
      L.push('          echo "服務沒起來"; sudo journalctl -u ${{ steps.target.outputs.svc }} -n 80 --no-pager; exit 1');
      return L.join('\n');
    },
    cmdVerify() {
      return [
        '# 1) 推一個無害的改動到測試分支，到 GitHub → Actions 看那一輪跑完是綠的',
        `git commit --allow-empty -m "test: 驗證自動部署" && git push origin ${this.branchTest}`,
        '',
        '# 2) 伺服器上確認碼真的換了（不是 workflow 綠但沒動到）',
        `cd ${this.newAddonsDir(this.test.addons)} && git log -1 --oneline`,
        '',
        '# 3) 確認模組真的升級過，而不是只重啟',
        `sudo journalctl -u ${this.v(this.test.service, '<測試服務名>')} -n 50 --no-pager | grep -i "module .* loaded"`
      ].join('\n');
    }
  },
  methods: {
    pid() { return this.$route.params.id; },
    async load() {
      this.loading = true;
      try {
        const [proj, conns] = await Promise.all([
          Api.get(`projects/${this.pid()}`),
          Api.get(`projects/${this.pid()}/db-connections`).catch(() => [])
        ]);
        this.project = proj;
        this.repos = proj.repos || [];
        this.conns = conns || [];
        const primary = this.repos.find(r => r.is_primary) || this.repos[0];
        if (primary) this.repoUrl = primary.repo_url || '';
      } catch (e) { showToast(e.message, 'error'); }
      finally { this.loading = false; }
    },
    // 未填的欄位不要靜默留空——留空會生出看似完整、實際會刪錯目錄的指令。
    v(val, placeholder) { return (val || '').trim() || placeholder; },
    dbOf(conn) { return (conn && conn.db_name) || '<資料庫名稱>'; },
    // direct 模式的連線（DBeaver 式直連 TCP）沒有 SSH 欄位，硬組會生出 `ssh @` 這種東西。
    // 缺就回空、由 template 不顯示那一行——這頁後面的指令都要 SSH 進機器才做得了，
    // 選到這種連線本來就得換一個。
    sshLine(conn) {
      if (!conn || !conn.ssh_host || !conn.ssh_user) return '';
      const port = conn.ssh_port && conn.ssh_port !== 22 ? ` -p ${conn.ssh_port}` : '';
      return `ssh${port} ${conn.ssh_user}@${conn.ssh_host}`;
    },
    // 舊目錄留著當備份，新的 clone 到隔壁：<原路徑>_git
    newAddonsDir(oldPath) {
      const p = (oldPath || '').trim();
      return p ? `${p}_git` : '<新的 addons 路徑>';
    },
    onConnPick(side) {
      const conn = side === 'prod' ? this.prodConn : this.testConn;
      if (!conn) return;
      // log_unit 存的就是 journalctl 要跟的那個 systemd unit——同一個值，不必再問一次
      if (conn.log_unit && !this[side].service) this[side].service = conn.log_unit;
    },
    async copy(text) {
      try { await navigator.clipboard.writeText(text || ''); showToast('已複製', 'success'); }
      catch (_) { showToast('複製失敗，請手動選取', 'error'); }
    }
  },
  template: `
    <div class="topbar">
      <button class="btn btn-outline btn-sm" @click="$router.push('/projects/'+pid())" style="margin-right:var(--space-3)">← 返回專案</button>
      <h1>自動部署 SOP</h1>
      <span v-if="project" style="font-size:var(--fs-base);color:var(--text-muted);margin-left:var(--space-3)">{{ project.name }}</span>
    </div>

    <div class="content" v-if="loading">載入中...</div>
    <div class="content" v-else>

      <div class="settings-section" style="margin-bottom:var(--space-5)">
        <h2 class="section-title">這頁在做什麼</h2>
        <p style="color:var(--text-secondary);line-height:1.9;margin:0">
          做完之後，程式碼推上
          <code class="sop-code">{{ branchTest }}</code> 會自動部署到測試區、推上
          <code class="sop-code">{{ branchProd }}</code> 會自動部署到正式區——拉最新碼、升級有改動的模組、重啟服務、確認起得來。
          觸發走 GitHub self-hosted runner（伺服器主動連外，不必開任何對外埠），部署歷史留在 repo 的 Actions 頁。
        </p>
        <div class="sop-warn" style="margin-top:var(--space-3)">
          <b>先知道代價：</b>正式區是全自動、沒有人工關卡。任何人把東西併進
          <code class="sop-code">{{ branchProd }}</code>，正式區就會在數十秒內重啟一次，不分上下班時段。
          不接受這件事就別接正式區那條，只接測試區。
        </div>
      </div>

      <div v-if="!conns.length" class="settings-section" style="margin-bottom:var(--space-5)">
        <h2 class="section-title">先設定這個專案的資料庫連線</h2>
        <p style="color:var(--text-secondary);line-height:1.9">
          這頁要用到 SSH 位址與資料庫名稱，都放在「資料庫查詢」的連線設定裡。設好之後回到這頁，下面的指令就會自動填入真值。
        </p>
        <button class="btn btn-primary btn-sm" @click="$router.push('/projects/'+pid()+'/db')">前往設定連線</button>
      </div>

      <div class="settings-section" style="margin-bottom:var(--space-5)">
        <h2 class="section-title">你的環境</h2>
        <p style="color:var(--text-muted);font-size:var(--fs-sm);line-height:1.8;margin-top:0">
          填在這裡的值只會用來把下面的指令填成真值，<b>不會存起來</b>——重新整理就沒了。
          伺服器上的路徑會隨時間變動，存下來反而會讓人照著過期的指令跑。
        </p>

        <div class="sop-grid">
          <div v-for="s in sides" :key="s.key" class="sop-env-card">
            <div class="sop-env-title">{{ s.label }}</div>

            <div class="form-group" style="margin-bottom:var(--space-2)">
              <label>對應的連線</label>
              <select v-model="s.d.connId" class="form-control" @change="onConnPick(s.key)">
                <option value="">— 請指認 —</option>
                <option v-for="c in conns" :key="c.id" :value="c.id">{{ c.name }}（{{ c.db_name }}）</option>
              </select>
            </div>

            <div v-if="s.conn" class="sop-facts">
              <div v-if="s.ssh"><span>SSH</span><code class="sop-code">{{ s.ssh }}</code></div>
              <div v-else><span>SSH</span><span style="color:var(--warning)">這個連線是直連模式、沒有 SSH 資訊，下面的指令要自己找機器登入</span></div>
              <div><span>資料庫</span><code class="sop-code">{{ dbOf(s.conn) }}</code></div>
            </div>

            <div class="form-group" style="margin-bottom:var(--space-2)">
              <label>systemd 服務名</label>
              <input v-model="s.d.service" class="form-control" placeholder="例：odoo-server.service" />
            </div>
            <div class="form-group" style="margin-bottom:var(--space-2)">
              <label>設定檔路徑</label>
              <input v-model="s.d.conf" class="form-control" placeholder="例：/etc/odoo-server.conf" />
            </div>
            <div class="form-group" style="margin-bottom:var(--space-2)">
              <label>目前的 addons 路徑</label>
              <input v-model="s.d.addons" class="form-control" placeholder="例：/odoo/custom/addons" />
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label>HTTP port</label>
              <input v-model="s.d.port" class="form-control" placeholder="例：8069" />
            </div>
          </div>
        </div>

        <div v-if="sameConn" class="error-msg" style="margin-top:var(--space-3)">
          正式區與測試區指到同一個連線。下面每一段指令都會把同一個資料庫名稱填進兩區——先分開指認再往下做。
        </div>

        <div class="sop-grid" style="margin-top:var(--space-3)">
          <div class="form-group" style="margin:0">
            <label>repo URL</label>
            <input v-model="repoUrl" class="form-control" placeholder="git@github.com:org/repo.git" />
          </div>
          <div class="form-group" style="margin:0">
            <label>自訂模組名（用來跟伺服器現況比對）</label>
            <input v-model="addon" class="form-control" placeholder="例：idx_xxx" />
          </div>
          <div class="form-group" style="margin:0">
            <label>測試區對應分支</label>
            <input v-model="branchTest" class="form-control" />
          </div>
          <div class="form-group" style="margin:0">
            <label>正式區對應分支</label>
            <input v-model="branchProd" class="form-control" />
          </div>
        </div>
      </div>

      <div class="settings-section sop-step">
        <h2 class="section-title"><span class="sop-num">1</span>查出伺服器現況</h2>
        <p class="sop-desc">
          SSH 進伺服器，把上面那四欄查出來填好。正式與測試常在同一台機器上、只是不同 service 與不同設定檔，
          所以每一項都要分別確認，不要用一區的值推另一區。
        </p>
        <div class="sop-cmd-box">
          <button class="btn btn-outline btn-sm sop-copy" @click="copy(cmdInspect)">複製</button>
          <pre class="sop-cmd">{{ cmdInspect }}</pre>
        </div>
        <div class="sop-note">
          設定檔裡若<b>沒有</b> <code class="sop-code">db_name</code>，代表是多資料庫模式——後面的升級指令一定要明確帶
          <code class="sop-code">-d</code>，否則 Odoo 不知道要升級哪個庫。
        </div>
      </div>

      <div class="settings-section sop-step">
        <h2 class="section-title"><span class="sop-num">2</span>備份，並比對伺服器與 repo 的差異</h2>
        <p class="sop-desc">
          自動部署會用 repo 的內容覆蓋伺服器上的模組。若伺服器上曾有人直接改檔而沒進 repo，切換過去的那一刻就會靜默弄丟。
          <b>比對出差異就先停下來，把它補進 repo 再繼續。</b>
        </p>
        <div class="sop-cmd-box">
          <button class="btn btn-outline btn-sm sop-copy" @click="copy(cmdBackup)">複製</button>
          <pre class="sop-cmd">{{ cmdBackup }}</pre>
        </div>
      </div>

      <div class="settings-section sop-step">
        <h2 class="section-title"><span class="sop-num">3</span>把 addons 目錄接上 git</h2>
        <p class="sop-desc">
          伺服器上的 addons 目錄通常不是 git repo，這是整件事真正的工作量。
          作法是<b>另 clone 一份到隔壁</b>、把設定檔的 <code class="sop-code">addons_path</code> 指過去，舊目錄原封不動留著——
          要復原只要把設定檔改回來、重啟即可。先做測試區，確認服務起得來、頁面正常，再對正式區做同一件事。
        </p>
        <div class="sop-cmd-box">
          <button class="btn btn-outline btn-sm sop-copy" @click="copy(cmdAttachGit)">複製</button>
          <pre class="sop-cmd">{{ cmdAttachGit }}</pre>
        </div>
        <div class="sop-note">
          新目錄的擁有者要讓 runner 的執行帳號寫得進去（<code class="sop-code">chown</code> 給登入帳號、群組留給 odoo），
          否則自動部署會停在 <code class="sop-code">Permission denied</code>。
        </div>
      </div>

      <div class="settings-section sop-step">
        <h2 class="section-title"><span class="sop-num">4</span>在伺服器上裝 GitHub self-hosted runner</h2>
        <p class="sop-desc">
          runner 由伺服器主動連去 GitHub 取工作，不需要對外開任何埠，也不必讓 GitHub 連得到你的機器。
        </p>
        <div class="sop-cmd-box">
          <button class="btn btn-outline btn-sm sop-copy" @click="copy(cmdRunner)">複製</button>
          <pre class="sop-cmd">{{ cmdRunner }}</pre>
        </div>
        <p class="sop-desc" style="margin-top:var(--space-3)">
          runner 是非互動執行，<code class="sop-code">sudo</code> 停下來問密碼就等於卡死。只開需要的那幾條：
        </p>
        <div class="sop-cmd-box">
          <button class="btn btn-outline btn-sm sop-copy" @click="copy(cmdSudoers)">複製</button>
          <pre class="sop-cmd">{{ cmdSudoers }}</pre>
        </div>
        <div class="sop-warn">
          重啟服務時若出現 <code class="sop-code">unit file changed on disk</code> 警告，代表有人改過 unit 檔但沒 reload——
          <b>先看清楚被改了什麼</b>再 <code class="sop-code">sudo systemctl daemon-reload</code>。
          放著不管的話，之後每次自動部署都會套用舊定義。
        </div>
      </div>

      <div class="settings-section sop-step">
        <h2 class="section-title"><span class="sop-num">5</span>放入 deploy.yml</h2>
        <p class="sop-desc">
          存成 repo 的 <code class="sop-code">.github/workflows/deploy.yml</code>（放在客戶的 addons repo，不是平台 repo）。
          兩個分支各對應一區，流程是<b>停服務 → 升級 → 起服務 → curl 驗證</b>：不在服務運行中對同一個資料庫再跑第二個
          odoo-bin。
        </p>
        <div class="sop-cmd-box">
          <button class="btn btn-outline btn-sm sop-copy" @click="copy(deployYaml)">複製</button>
          <pre class="sop-cmd">{{ deployYaml }}</pre>
        </div>
        <div class="sop-warn">
          <b>刻意不做的兩件事：</b><br />
          1. <b>不自動 <code class="sop-code">pip install</code></b>——正式與測試若共用同一份 site-packages，這是唯一「動測試區會弄壞正式區」的路徑。缺套件就讓它紅燈，人工處理。<br />
          2. <b>失敗不自動回滾</b>——回滾一個已經改過 schema 的升級比停在壞掉的狀態更危險。失敗就讓 workflow 紅燈，人去看。
        </div>
      </div>

      <div class="settings-section sop-step">
        <h2 class="section-title"><span class="sop-num">6</span>驗證它真的有跑</h2>
        <p class="sop-desc">
          workflow 綠燈只代表指令沒有回傳錯誤，不代表碼換了、模組升級了。三件事都確認過才算接完。
        </p>
        <div class="sop-cmd-box">
          <button class="btn btn-outline btn-sm sop-copy" @click="copy(cmdVerify)">複製</button>
          <pre class="sop-cmd">{{ cmdVerify }}</pre>
        </div>
        <div class="sop-note">
          測試區跑順了再把正式區接上去。正式區第一次上線建議挑離峰時段，並在旁邊看完整輪。
        </div>
      </div>

    </div>
  `
});
