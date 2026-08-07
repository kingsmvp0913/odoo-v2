(function() {
  let _socket = null;
  let _taskListRefresh = null;

  function initSocket(userId) {
    if (_socket) return;
    _socket = io({
      // socket.io 的 path 只吃絕對路徑，不會跟著頁面前綴走，必須明示；漏掉會握手 404 後
      // 靜默退回 polling——即時通知變慢但不報錯。
      path: BASE_PATH + 'socket.io',
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
      const label = (window.STATUS_LABELS || {})[data.status] || data.status;
      showToast(`任務狀態更新：${label}`, 'info');
      if (_taskListRefresh) _taskListRefresh();
    });

    _socket.on('notify:toast', (data) => {
      showToast(data.message || '通知', data.level || 'info');
    });

    _socket.on('notify:action', (data) => {
      // 後端在派送這則通知時已同步寫了一筆收件匣 action 事件，badge 先樂觀 +1；
      // 真正的數字在進收件匣頁時以後端筆數校正（通知可能沒收到、也可能已在別的分頁讀過）
      if (window.inboxUnread) window.inboxUnread.value += 1;
      const label = (window.STATUS_LABELS || {})[data.status] || data.status;
      const name = data.title || data.task_id || `任務 ${data.taskId}`;
      window.NotifyManager && window.NotifyManager.show(
        `需要處理：${label}`, name, data.taskId,
        () => { if (data.taskId != null) location.hash = `#/task/${data.taskId}`; }
      );
    });

    _socket.on('chat:reply', (data) => {
      const pid = String(data.projectId);
      window.UnreadStore.byProject[pid] = (window.UnreadStore.byProject[pid] || 0) + 1;
      // 桌面通知（受個人設定開關＋瀏覽器授權把關，未開啟則靜默）；tag 依 chatId 收合同串多次回覆
      window.NotifyManager && window.NotifyManager.show(
        '專案聊天有新回覆', '', `chat-${data.chatId}`,
        () => { location.hash = `#/projects/${data.projectId}/chat/${data.chatId}`; }
      );
    });

  }

  function setRefreshCallback(fn) { _taskListRefresh = fn; }
  function disconnectSocket() { if (_socket) { _socket.disconnect(); _socket = null; } }

  window.SocketManager = { initSocket, setRefreshCallback, disconnectSocket };
})();
