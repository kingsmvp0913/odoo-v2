// 測試進程會繼承容器的環境變數，其中 NGINX_SYNC_CONF_FILE／NGINX_CONTAINER 指向「真的」那台
// 與多個正式站共用的 nginx。任何沒 mock 掉 nginx-map 的測試（env-routes 打 /env/sso 即是）都會
// 據此寫真檔並 reload 真 nginx——而測試用的是 pg-mem 空資料庫，算出來的內容是空的，於是：
//   真的 conf 被寫成 0 bytes → 測試區網域失去自己的 server 區塊 → 掉到載入順序第一個站
//   → 拿到不涵蓋該網域的憑證 → 真人使用者的瀏覽器整個連不上。
// 2026-09-10 實測：跑一次全套就重現，客戶端當場「連接中斷，正在嘗試重新連接」。
// 要驗這條路徑的測試自行設假路徑（見 nginx-map.test.js 的 setAll）。
delete process.env.NGINX_SYNC_CONF_FILE;
delete process.env.NGINX_CONTAINER;
