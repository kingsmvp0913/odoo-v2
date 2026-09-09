// 對話附件可收的檔型：後端 server/lib/attachments.js 那份清單的前端鏡像。
// 兩份必須一致——漂移的症狀特別難查：檔案挑得到、送出被後端打回，而畫面上只有一句泛用錯誤，
// 完全指不出是格式不合。server/tests/chat-file-types.test.js 會比對兩邊。
//
// ⚠ 包 IIFE 是硬性要求：classic script 的頂層 const 會落在全域，撞名即 SyntaxError 整支不執行，
// 而症狀只是「上傳鈕沒反應」，畫面其餘完全正常。
(function () {
  var TEXT_EXTS = ['.csv', '.tsv', '.txt', '.log', '.xml', '.json', '.po'];
  // .xlsm 的 magic bytes 與 .xlsx 相同，後端驗證那邊不必列，但檔案選擇器不列使用者就挑不到
  var BINARY_EXTS = ['.pdf', '.xlsx', '.xlsm', '.xls', '.docx', '.doc', '.pptx'];
  var EXTS = BINARY_EXTS.concat(TEXT_EXTS);

  window.CHAT_FILE_TYPES = {
    exts: EXTS,
    accept: ['image/*'].concat(EXTS).join(','),
    maxBytes: 25 * 1024 * 1024,
    maxFiles: 5,
    // <input accept> 只是檔案選擇器的提示，拖放與貼上完全不受它限制——每個入口都得再過這一關。
    allows: function (file) {
      if (!file) return false;
      if (String(file.type || '').indexOf('image/') === 0) return true;
      var name = String(file.name || '').toLowerCase();
      return EXTS.some(function (ext) { return name.slice(-ext.length) === ext; });
    },
    // 只有圖片才做縮圖預覽；其餘檔型畫成檔名列。非圖片建 objectURL 只是白佔記憶體，
    // 而且 <img> 拿到它會顯示破圖示。
    isImage: function (file) { return !!file && String(file.type || '').indexOf('image/') === 0; }
  };
})();
