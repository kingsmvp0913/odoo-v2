(function() {
  let _socket = null;
  let _taskListRefresh = null;

  function initSocket(userId) {
    if (_socket) return;
    _socket = io({
      transports: ['websocket', 'polling'],
      auth: { token: Api.getToken() }
    });

    Object.defineProperty(window, '_socket', { get: () => _socket, configurable: true });

    _socket.on('connect', () => {
      console.log('[Socket] connected');
    });

    _socket.on('task:synced', (data) => {
      showToast(`已同步 ${data.count} 個新任務`, 'info');
      if (_taskListRefresh) _taskListRefresh();
    });

    _socket.on('task:updated', (data) => {
      const labels = { coding_running: '開發中', qa_running: 'QA 中', done: '已完成', stopped: '已停止', branch_pending: '準備建立分支' };
      const label = labels[data.status] || data.status;
      showToast(`任務狀態更新：${label}`, 'info');
      if (_taskListRefresh) _taskListRefresh();
    });

    _socket.on('notify:toast', (data) => {
      showToast(data.message || '通知', data.level || 'info');
    });

    _socket.on('notify:action', (data) => {
      const ACTION_LABELS = {
        confirm_pending: '等待確認', final_pending: '等待審核', stopped: '已停止',
        triage_blocked: '分診阻塞', cs_data_needed: '需補資料', cs_reply_pending: '等待回覆確認',
        merge_conflict: '合併衝突', deploy_ready: '可部署'
      };
      const label = ACTION_LABELS[data.status] || data.status;
      const name = data.title || data.task_id || `任務 ${data.taskId}`;
      window.NotifyManager && window.NotifyManager.show(
        `需要處理：${label}`, name, data.taskId,
        () => { if (data.taskId != null) location.hash = `#/task/${data.taskId}`; }
      );
    });

    _socket.on('chat:reply', (data) => {
      const pid = String(data.projectId);
      window.UnreadStore.byProject[pid] = (window.UnreadStore.byProject[pid] || 0) + 1;
    });

  }

  function setRefreshCallback(fn) { _taskListRefresh = fn; }
  function disconnectSocket() { if (_socket) { _socket.disconnect(); _socket = null; } }

  window.SocketManager = { initSocket, setRefreshCallback, disconnectSocket };
})();
