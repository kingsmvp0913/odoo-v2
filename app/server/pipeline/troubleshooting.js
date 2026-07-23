const { query } = require('../db');
const { stripFence } = require('./agent-result');

// 排障／客服「釐清後的結論」寫回 wiki 的共用模組。chat 與 cs 兩關會用到，抽出避免各寫一份。
// 設計：這兩關是知識的破口——chat 純 Q&A 從不寫 wiki、cs 判 operation（只回覆不改程式）也不會進 library
// agent，結論若不落地就埋在對話裡。其餘關卡都跟著任務走、最後由 library agent 收進功能頁，故不接。
// 儲存：wiki_pages 新增一種 node_type='troubleshooting'，容器節點（slug='troubleshooting'）下掛各則結論。
// 讀回不在此處——agent 透過既有 /ai/wiki curl 端點自行查（見 cs-capability.md），省 token 且不隨筆數膨脹。

const CONTAINER_SLUG = 'troubleshooting';
const MEM_OPEN = '<memory>';
const MEM_CLOSE = '</memory>';

// 從 agent 輸出取出選用的 <memory>…</memory> 側通道（與主要輸出契約獨立：chat 的自然語言回覆、cs 的
// <result> JSON 皆不受影響）。回 { entry, cleaned }：entry 為解析後的結論物件或 null；cleaned 為移除
// 該區塊後的文字（供 chat 顯示回覆時剝掉，不讓使用者看到側通道）。缺／解析失敗＝沒有結論，靜默略過。
function extractMemoryBlock(text) {
  const raw = String(text || '');
  const end = raw.lastIndexOf(MEM_CLOSE);
  if (end === -1) return { entry: null, cleaned: raw.trim() };
  const start = raw.lastIndexOf(MEM_OPEN, end);
  if (start === -1) return { entry: null, cleaned: raw.trim() };
  const cleaned = (raw.slice(0, start) + raw.slice(end + MEM_CLOSE.length)).trim();
  let entry = null;
  try {
    const obj = JSON.parse(stripFence(raw.slice(start + MEM_OPEN.length, end)));
    if (obj && obj.title && obj.content) entry = obj;
  } catch { /* 側通道格式壞掉不影響主回覆，當作沒帶 */ }
  return { entry, cleaned };
}

async function _ensureContainer(projectId) {
  await query(
    `INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content)
     VALUES ($1, NULL, 'troubleshooting', $2, '疑難排解', $3)
     ON CONFLICT (project_id, slug) DO NOTHING`,
    [projectId, CONTAINER_SLUG, '# 疑難排解\n\n此處收錄排障／客服釐清後的結論，供 AI 與人員日後查詢確認。']
  );
  const { rows: [row] } = await query(
    'SELECT id FROM wiki_pages WHERE project_id=$1 AND slug=$2', [projectId, CONTAINER_SLUG]
  );
  return row.id;
}

// 寫入一則排障結論。entry：{ slug, title, content }。slug 一律正規化並加 ts- 前綴，避免撞保留節點
// （overview／module-*／project-notes／troubleshooting 容器）；掛在容器下 upsert（同 slug 視為更新同一主題）。
// 回寫入的 slug，或 null（缺專案／缺必要欄位）。呼叫端須自行 try/catch，wiki 寫入失敗不得中斷對話回覆。
async function recordTroubleshooting(projectId, entry) {
  if (!projectId || !entry || !entry.title || !entry.content) return null;
  let slug = String(entry.slug || '').trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug === 'troubleshooting') slug = 'note';
  if (!slug.startsWith('ts-')) slug = 'ts-' + slug;

  const containerId = await _ensureContainer(projectId);
  await query(
    `INSERT INTO wiki_pages (project_id, parent_id, node_type, slug, title, content, updated_at)
     VALUES ($1,$2,'troubleshooting',$3,$4,$5,NOW())
     ON CONFLICT (project_id, slug)
     DO UPDATE SET parent_id=$2, node_type='troubleshooting', title=$4, content=$5, updated_at=NOW()`,
    [projectId, containerId, slug, entry.title, entry.content]
  );
  return slug;
}

module.exports = { recordTroubleshooting, extractMemoryBlock, CONTAINER_SLUG };
