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

  }

  function setRefreshCallback(fn) { _taskListRefresh = fn; }
  function disconnectSocket() { if (_socket) { _socket.disconnect(); _socket = null; } }

  window.SocketManager = { initSocket, setRefreshCallback, disconnectSocket };
})();
