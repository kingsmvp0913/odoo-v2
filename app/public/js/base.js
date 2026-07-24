// 全站唯一的 URL 前綴來源。平台在本地跑於根路徑（'/'），在伺服器上掛於子路徑（'/odooAiDev/'），
// 兩者共用同一份程式碼。前綴由瀏覽器當下的網址推導、而非由設定檔指定——後者會讓兩台機器各填
// 一個值，填錯的症狀（資產 404、socket 連不上）只在對方的機器上出現，此地重現不了。
// hash routing 不改變 URL 的 path 部分，故此值在整個 SPA 生命週期內恆定。
function basePathFrom(documentURI) {
  return new URL('.', documentURI).pathname;
}

if (typeof window !== 'undefined') window.BASE_PATH = basePathFrom(document.baseURI);
if (typeof module !== 'undefined') module.exports = { basePathFrom };
