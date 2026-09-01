const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// 為什麼要有這一支
//
// `app/public/js/ui-next/UiNextPages.js` 裡有 13 個 View 是從 Legacy 的
// `app/public/js/views/*.js` **逐字複製**過來的，兩邊唯一允許的差異就是元件名稱那一行
// （`window.XxxView = Vue.defineComponent({` 與其下的 `name:`）。這是刻意的：Next 介面要能
// 跟 Legacy 平行存在、各自獨立演進，所以不共用同一個元件物件。
//
// 代價是近四千行重複碼（13 段合計約 3,800 行）。重複碼本身不是問題，**靜默漂移**才是：
// 有人改了 Legacy 的 AdminUsers.js 修一個 bug，Next 那份沒跟上，於是同一個畫面在
// `?ui=next` 下還是壞的——而且沒有任何訊號。程式跑得起來、測試全綠、畫面看起來正常。
//
// 既有的 `frontend-ui-next.test.js` 擋不住這件事。那道門禁禁止的是「委派」寫法，也就是
// `window.XxxView.methods` / `.data` / `.computed` 這種去戳 Legacy 元件內部的程式碼——
// 它守的是「Next 不可以偷改 Legacy 的行為」。**逐字複製完全不觸發那個 pattern**，複製品
// 漂移多遠它都不會紅。所以才需要這一支：直接比對兩份的內容是否仍然一致。
//
// 這一支只管「凍結清單裡的那幾組」。若哪天決定某一組要分家（Next 版要長出 Legacy 沒有的
// 行為），做法是把它從 FROZEN_COPIES 移除並在該處註明理由，而不是放寬比對。
// ---------------------------------------------------------------------------

const publicDir = path.join(__dirname, "../../public");
const read = (file) => fs.readFileSync(path.join(publicDir, file), "utf8");

const NEXT_PAGES = "js/ui-next/UiNextPages.js";

// [Next 元件名, Legacy 來源檔, Legacy 元件名]
//
// 注意：Architecture / PipelineFlow / AdminHealthCheck 的 Legacy 檔在元件定義**之前**還有
// 一段 top-level `const`（AR_KIND_COLOR、PF_BUSES、HC_STATUS…）。那些常數沒有被複製進
// Next——Next 直接吃全域。所以這裡比對的範圍嚴格限定在
// `window.<名稱> = Vue.defineComponent({ … })` 這個賦值本身。
const FROZEN_COPIES = [
  // UiNextDbView 已於 2026-09-01 與 Legacy 分家：Next 把它內嵌成專案頁的「連線設定」頁籤，
  // 因此多了一個 embedded prop（內嵌時不轉址、不畫自己的頁首）。Legacy 沒有頁籤這回事，
  // 那邊仍是獨立頁面，兩邊本來就不該再逐字相同。
  // UiNextAdminSettingsView 已於 2026-09-01 與 Legacy 分家：Next 的 /admin 首頁本來就有
  // 一整組管理工具卡片，這一頁底部又放了同一批（navTools），同樣的十個入口在同一條動線上
  // 出現兩次。Next 這邊移除該區塊，Legacy 的 AdminView 是唯一入口所以保留——兩邊本來就
  // 不該再逐字相同。
  ["UiNextAdminUsersView", "js/views/AdminUsers.js", "AdminUsersView"],
  ["UiNextAdminAgentsView", "js/views/AdminAgents.js", "AdminAgentsView"],
  ["UiNextAdminSchedulesView", "js/views/AdminSchedules.js", "AdminSchedulesView"],
  ["UiNextAdminHealthCheckView", "js/views/AdminHealthCheck.js", "AdminHealthCheckView"],
  ["UiNextAdminRejectionsView", "js/views/AdminRejections.js", "AdminRejectionsView"],
  ["UiNextAdminClassifySamplesView", "js/views/AdminClassifySamples.js", "AdminClassifySamplesView"],
  ["UiNextAdminPromptLogsView", "js/views/AdminPromptLogs.js", "AdminPromptLogsView"],
  ["UiNextAdminPortPoolView", "js/views/AdminPortPool.js", "AdminPortPoolView"],
  ["UiNextAdminEnterpriseView", "js/views/AdminEnterprise.js", "AdminEnterpriseView"],
  ["UiNextArchitectureView", "js/views/Architecture.js", "ArchitectureView"],
  ["UiNextPipelineFlowView", "js/views/PipelineFlow.js", "PipelineFlowView"],
];

// ---------------------------------------------------------------------------
// 括號配對解析。
//
// 不能用 regex：這些 view 內含大量巢狀物件與 template 反引號字串，任何 `\{[\s\S]*\}` 都會
// 貪婪吃到下一個元件，任何非貪婪版本都會在第一個 `}` 就停手。這裡逐字掃描並跳過
// 註解、字串、template literal（含 `${}` 內的巢狀括號），只在真正的程式碼層數括號。
// ---------------------------------------------------------------------------
const extractComponent = (source, componentName) => {
  const marker = `window.${componentName} = Vue.defineComponent(`;
  const start = source.indexOf(marker);
  if (start === -1) return null;

  let depth = 0;
  for (let i = start + marker.length - 1; i < source.length; i++) {
    const pair = source.slice(i, i + 2);
    if (pair === "//") {
      const eol = source.indexOf("\n", i);
      if (eol === -1) return null;
      i = eol;
      continue;
    }
    if (pair === "/*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      i = skipString(source, i);
      if (i === -1) return null;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") depth++;
    else if (char === ")" || char === "}" || char === "]") {
      depth--;
      // depth 歸零＝吃完 defineComponent( … ) 的那個右括號，也就是配對的 `})`。
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
};

// 回傳字串結束引號的 index；找不到回 -1。反引號要一併跳過 `${ … }` 內的巢狀內容，
// 否則 template 裡的 `${ list.map(x => ...) }` 會把外層括號計數帶歪。
const skipString = (source, openIndex) => {
  const quote = source[openIndex];
  let interpolation = 0;
  for (let i = openIndex + 1; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (quote === "`") {
      if (source.slice(i, i + 2) === "${") {
        interpolation++;
        i++;
        continue;
      }
      if (char === "}" && interpolation > 0) {
        interpolation--;
        continue;
      }
      if (interpolation > 0) continue;
    }
    if (char === quote) return i;
  }
  return -1;
};

// 正規化：剝行首行尾空白、去空行、拿掉「元件名稱」那兩行（唯一允許的差異），
// 並把單引號字面值改寫成雙引號——這個 repo 的檔案會走 prettier，同一段碼在兩邊
// 引號風格可能不同（見 tour-isolation.test.js 對 app.js 的同類修正），那是格式假紅。
const COMPONENT_NAME_LINES = [
  /^window\.[A-Za-z]+ = Vue\.defineComponent\(\{$/,
  /^name: ["'][A-Za-z]+["'],?$/,
];

const normalize = (segment) =>
  segment
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !COMPONENT_NAME_LINES.some((re) => re.test(line)))
    .map((line) => line.replace(/'([^'\\"]*)'/g, '"$1"'));

const firstDifference = (nextLines, legacyLines) => {
  for (let i = 0; i < Math.max(nextLines.length, legacyLines.length); i++) {
    if (nextLines[i] !== legacyLines[i]) {
      return {
        index: i,
        next: nextLines[i] === undefined ? "（Next 這裡沒有內容了）" : nextLines[i],
        legacy: legacyLines[i] === undefined ? "（Legacy 這裡沒有內容了）" : legacyLines[i],
      };
    }
  }
  return null;
};

const drift = (nextName, legacyFile, legacyName, diff, nextLines, legacyLines) =>
  [
    "",
    `【凍結複製漂移】${nextName} 與 ${legacyName} 不再一致。`,
    "",
    `這兩段是**刻意逐字複製**的：${legacyFile} 的 ${legacyName} 與 ${NEXT_PAGES} 的 ${nextName}，`,
    "除了元件名稱那一行以外必須完全相同。這條紅燈代表其中一邊被改了、另一邊沒跟上——",
    "也就是同一個畫面在 Legacy 與 ?ui=next 下行為已經分岔，而且平常不會有任何訊號。",
    "",
    `正規化後行數：Next ${nextLines.length} 行 / Legacy ${legacyLines.length} 行`,
    `第一處差異在正規化後第 ${diff.index + 1} 行：`,
    `  Next   (${NEXT_PAGES}): ${diff.next}`,
    `  Legacy (${legacyFile}): ${diff.legacy}`,
    "",
    "修法（擇一）：",
    `  1. 若是 Legacy 改了 → 把同樣的改動原封不動同步到 ${NEXT_PAGES} 裡 ${nextName} 的對應段落。`,
    `  2. 若是 Next 改了   → 把同樣的改動同步回 ${legacyFile}。`,
    "  3. 若是**刻意**要讓兩份分家（Next 版要長出 Legacy 沒有的行為）→ 把這一組從本檔的",
    "     FROZEN_COPIES 移除，並在該處註明分家的理由與日期。不要用放寬比對的方式讓它變綠。",
    "",
  ].join("\n");

describe("ui-next 逐字複製的 View 必須與 Legacy 保持一致", () => {
  const nextSource = read(NEXT_PAGES);
  const legacySources = new Map();
  for (const [, legacyFile] of FROZEN_COPIES) {
    if (!legacySources.has(legacyFile)) legacySources.set(legacyFile, read(legacyFile));
  }

  const segments = FROZEN_COPIES.map(([nextName, legacyFile, legacyName]) => ({
    nextName,
    legacyFile,
    legacyName,
    next: extractComponent(nextSource, nextName),
    legacy: extractComponent(legacySources.get(legacyFile), legacyName),
  }));

  // -------------------------------------------------------------------------
  // 解析健全性：括號配對解析器一旦失效（元件改名、賦值寫法改寫、字串跳脫沒處理好），
  // extractComponent 會回 null 或抓到一小截，接著每一組都「相等」而全數變綠——測試看起來
  // 沒事，實際上什麼都沒測到。這一支就是那道防線，跟 frontend-markdown-xss.test.js
  // 的「掃得到 v-html」同一個用意：先證明工具真的抓到東西，再談比對結果。
  // -------------------------------------------------------------------------
  describe("解析健全性", () => {
    // ⚠ 不寫死組數：分家是這個檔案自己認可的正常操作（見檔頭），每分一組就要回頭改
    // 這裡的數字和上面的註解，改漏了就是假紅——而假紅久了就沒人看。真正要守的是
    // 「清單沒被清空」與「沒有重複登錄」，解析有沒有失效由下面 test.each 負責。
    test("凍結清單沒有被清空，也沒有重複登錄", () => {
      expect(FROZEN_COPIES.length).toBeGreaterThan(0);
      expect(new Set(FROZEN_COPIES.map(([n]) => n)).size).toBe(FROZEN_COPIES.length);
      expect(new Set(FROZEN_COPIES.map(([, , l]) => l)).size).toBe(FROZEN_COPIES.length);
    });

    test.each(FROZEN_COPIES.map((pair, i) => [pair[0], i]))(
      "%s：兩邊都抽得到一段完整、非空、且沒吃到隔壁元件的定義",
      (_name, index) => {
        const seg = segments[index];
        for (const [side, source, file, component] of [
          ["Next", seg.next, NEXT_PAGES, seg.nextName],
          ["Legacy", seg.legacy, seg.legacyFile, seg.legacyName],
        ]) {
          const where = `${side} ${file} 的 ${component}`;
          // 抓不到＝解析器壞了或元件被改名／搬走，不是「兩邊一致」。
          expect(`${where} 抽到內容：${source !== null}`).toBe(`${where} 抽到內容：true`);
          expect(source.startsWith(`window.${component} = Vue.defineComponent({`)).toBe(true);
          // 結尾必須是配對的 `})`：若括號計數被字串帶歪，這裡會是別的字元。
          expect(`${where} 結尾：${source.slice(-2)}`).toBe(`${where} 結尾：})`);
          // 每段都是完整的 Vue 元件，至少有 template；行數下限擋住「只抓到開頭幾行」。
          expect(`${where} 含 template：${source.includes("template:")}`).toBe(
            `${where} 含 template：true`,
          );
          expect(source.split("\n").length).toBeGreaterThan(20);
          // 段內只能有一個 defineComponent——多於一個代表括號配對失守、吃進了下一個元件。
          expect(
            `${where} 內的 defineComponent 個數：${source.split("Vue.defineComponent(").length - 1}`,
          ).toBe(`${where} 內的 defineComponent 個數：1`);
        }
      },
    );
  });

  test.each(FROZEN_COPIES.map((pair, i) => [pair[0], pair[2], i]))(
    "%s 仍是 %s 的逐字複製",
    (_nextName, _legacyName, index) => {
      const seg = segments[index];
      const nextLines = normalize(seg.next);
      const legacyLines = normalize(seg.legacy);
      const diff = firstDifference(nextLines, legacyLines);
      if (diff) {
        throw new Error(
          drift(seg.nextName, seg.legacyFile, seg.legacyName, diff, nextLines, legacyLines),
        );
      }
      expect(nextLines.join("\n")).toBe(legacyLines.join("\n"));
    },
  );
});
