/**
 * figma-routes.js — `GET /ai/figma`：把 Figma 設計稿／FigJam 白板壓成 agent 讀得動的扁平清單
 *
 * 為什麼是自家端點而不是掛 Figma MCP：見 lib/figma-auth 的抬頭（OAuth 跑不了 headless、
 * MCP 讀取要 edit access 而我們只有 View seat）。多一個好處是**回傳量由我們決定**：
 * 一份 135 節點的 FigJam 原始 JSON 是 120KB，扁平化後約 1 成——MCP 吐多少我們控不了。
 *
 * 為什麼是扁平清單而不是還原成階層／分群：實測（2026-08-14，順坤居查詢流程線稿）發現
 * FigJam 的畫面邊界根本不在 GROUP 裡——同一個畫面的元素有的在 GROUP、有的直接掛在 CANVAS 上，
 * 靠座標才分得出來。與其在這裡猜分群規則（猜錯就是系統性誤導下游規格），不如把座標與尺寸
 * 原樣交給 agent 自己判讀：它本來就擅長這個，而且少一層我們的臆測。
 */
const { getFigmaApiKey } = require('./lib/figma-auth');
const { aiEndpointGuard } = require('./lib/ai-token');

const FIGMA_API = 'https://api.figma.com/v1';

// 單次回傳的節點上限。超過就截斷並在回應裡標明——靜默截斷會讓 agent 以為自己看完了整份設計，
// 然後照著殘缺的版面寫規格，而且完全無訊號（規則：No silent caps）。
const MAX_NODES = 1500;

// https://www.figma.com/{design|board|file|slides}/{fileKey}/{名稱}?node-id=1-2
// fileKey 是網址裡第一段 22~128 碼的英數；node-id 用連字號，Figma API 要冒號。
function parseFigmaUrl(raw) {
  const url = String(raw || '').trim();
  const key = url.match(/(?:figma\.com)\/(?:design|board|file|slides|proto)\/([0-9a-zA-Z]{22,128})/);
  if (!key) return null;
  const node = url.match(/[?&]node-id=(\d+)[:-](\d+)/);
  return { fileKey: key[1], nodeId: node ? `${node[1]}:${node[2]}` : null };
}

// Figma 的顏色是 0~1 浮點，CSS 要 0~255
function toHex(color) {
  if (!color) return null;
  const ch = v => Math.round(Math.max(0, Math.min(1, v || 0)) * 255).toString(16).padStart(2, '0');
  const hex = `#${ch(color.r)}${ch(color.g)}${ch(color.b)}`;
  // alpha 只在真的半透明時才寫出來，免得每個節點都拖一段 ff
  return color.a != null && color.a < 1 ? `${hex}${ch(color.a)}` : hex;
}

// 比對圖層名與型別是否只是同一件事的兩種寫法："Shape with text" ↔ SHAPE_WITH_TEXT
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function firstSolidFill(node) {
  const f = (node.fills || []).find(x => x.visible !== false && x.type === 'SOLID');
  return f ? toHex(f.color) : null;
}

// 攤平成一維：每筆只留「寫得進規格」的欄位（型別／文字／座標尺寸／顏色／字型／圓角）。
// 保留 id 是為了讓 connector 的端點指得回來——那是流程圖唯一的連線資訊來源。
function extractNodes(root) {
  const out = [];
  let total = 0;
  (function walk(node) {
    total += 1;
    if (total > MAX_NODES) return;
    const b = node.absoluteBoundingBox;
    const item = { id: node.id, type: node.type };
    // Figma 的預設圖層名就是型別的人話版（SHAPE_WITH_TEXT → "Shape with text"），留著等於每個節點
    // 都把型別寫兩次。正規化後相同就丟掉，只保留設計師真的取過的名字。
    if (node.name && norm(node.name) !== norm(node.type)) item.name = node.name;
    const text = (node.characters || '').trim();
    if (text) item.text = text.replace(/\s+/g, ' ');
    if (b) {
      item.x = Math.round(b.x); item.y = Math.round(b.y);
      item.w = Math.round(b.width); item.h = Math.round(b.height);
    }
    const fill = firstSolidFill(node);
    if (fill) item.fill = fill;
    // Figma 的圓角是浮點（實測有 6.400000095367432 這種），原樣吐出去只是拿浮點誤差灌版面
    if (node.cornerRadius != null) item.radius = Math.round(node.cornerRadius * 10) / 10;
    const s = node.style;
    if (s && (s.fontFamily || s.fontSize)) {
      item.font = [s.fontFamily, s.fontSize && `${Math.round(s.fontSize)}px`, s.fontWeight]
        .filter(Boolean).join(' ');
    }
    if (node.connectorStart?.endpointNodeId || node.connectorEnd?.endpointNodeId) {
      item.from = node.connectorStart?.endpointNodeId || null;
      item.to = node.connectorEnd?.endpointNodeId || null;
      const label = (node.connectorText?.characters || '').trim();
      if (label) item.label = label;
    }
    out.push(item);
    for (const c of (node.children || [])) walk(c);
  })(root);
  return { nodes: out, total };
}

function registerRoutes(app) {
  // 供 agent 讀設計稿：GET /ai/figma?url=<Figma 連結>
  // 網址帶 node-id 就只取該節點（省下整份檔案），沒帶就整份。
  app.get('/ai/figma', aiEndpointGuard, async (req, res) => {
    const parsed = parseFigmaUrl(req.query.url);
    if (!parsed) {
      return res.status(400).json({
        ok: false,
        error: '請帶 url=<Figma 連結>，格式如 https://www.figma.com/design/<fileKey>/<名稱>?node-id=1-2',
      });
    }
    const token = getFigmaApiKey();
    if (!token) {
      // Figma 沒有匿名額度，這裡回空結果等於騙 agent「這份設計稿是空的」（見 lib/figma-auth）
      return res.status(503).json({
        ok: false,
        error: 'Figma API token 未設定，請管理員到設定頁貼上 personal access token（scope: file_content:read）',
      });
    }
    const { fileKey, nodeId } = parsed;
    const target = nodeId
      ? `${FIGMA_API}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
      : `${FIGMA_API}/files/${fileKey}`;
    try {
      const r = await fetch(target, { headers: { 'X-Figma-Token': token } });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        // Figma 的錯誤訊息本身就講得清楚（403 沒權限／404 檔案不存在／429 限流），原樣帶出來
        return res.status(r.status === 429 ? 429 : 502).json({
          ok: false,
          error: `Figma API ${r.status}：${body?.err || body?.message || '未知錯誤'}`,
        });
      }
      // 兩種端點的外形不同：整份檔案是 document，單節點是 nodes[<id>].document
      const roots = nodeId
        ? Object.values(body?.nodes || {}).map(n => n?.document).filter(Boolean)
        : [body?.document].filter(Boolean);
      if (!roots.length) {
        return res.status(404).json({ ok: false, error: `Figma 回應中找不到節點 ${nodeId || '(整份檔案)'}` });
      }
      const nodes = [];
      let total = 0;
      for (const root of roots) {
        const r2 = extractNodes(root);
        nodes.push(...r2.nodes);
        total += r2.total;
      }
      res.json({
        ok: true,
        name: body?.name || null,
        editorType: body?.editorType || null,
        role: body?.role || null,
        lastModified: body?.lastModified || null,
        nodeCount: nodes.length,
        // 截斷要說出來，否則 agent 會拿殘缺版面當完整規格
        truncated: total > nodes.length ? { total, returned: nodes.length, limit: MAX_NODES } : null,
        nodes,
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: `連線 Figma API 失敗：${err.message}` });
    }
  });
}

module.exports = { registerRoutes, parseFigmaUrl, extractNodes, toHex, MAX_NODES };
