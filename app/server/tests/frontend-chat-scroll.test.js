// 意圖：對話開著等 AI 回覆，回覆進來了畫面卻不跟下去——使用者要自己往下滾很久才找得到。
// 成因是兩件事疊起來的（2026-09-08 實測，playwright 量 .ui-next-main）：
//   ① 貼底只做一次，但 markdown／圖片／字型晚幾幀才把高度撐開 → 捲完仍差 351px（量兩次都一樣）
//   ② isMessagesNearBottom 的門檻是固定 80px，351 > 80 → 之後每次背景輪詢都判成「使用者自己
//      捲上去了」→ 新回覆一律不跟隨。實測回覆進來後 scrollTop 一動也不動、離底部 1057px。
// 修法要同時擋住這兩件，所以兩個都要有測試釘住。
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '../../public/js/ui-next/pages/ProjectChat.js');

// 瀏覽器腳本（掛全域、無 module.exports），只把 methods 物件切出來跑。
// 用要測的 method 名反查所在區塊，不用行號或字元位移——這個檔常被改，寫死位置會靜默切到別處。
function loadMethods(anchor, deps) {
  const src = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  const at = src.search(new RegExp(`\\n\\s+(async\\s+)?${anchor}\\s*\\(`));
  expect(at).toBeGreaterThan(-1);
  const from = src.lastIndexOf('    methods: {', at);
  // 收尾找 4 空格縮排的 `},`，不指定後面接什麼——methods 之後不一定是 template（這支接的是 watch）。
  const to = src.indexOf('\n    },\n', at);
  expect(from).toBeGreaterThan(-1);
  const body = src.slice(src.indexOf('{', from), to + '\n    }'.length);
  const names = Object.keys(deps);
  return new Function(...names, `return (${body});`)(...names.map(n => deps[n]));
}

// 假的捲動容器：scrollTop 被設超過可捲範圍時比照瀏覽器夾住，才量得出「有沒有真的貼到底」。
function makeElement({ scrollHeight = 10000, clientHeight = 800, scrollTop = 0 } = {}) {
  return {
    clientHeight,
    scrollHeight,
    _top: scrollTop,
    get scrollTop() { return this._top; },
    set scrollTop(v) { this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
  };
}

function withDom(element, anchor) {
  const frames = [];
  const deps = {
    document: { querySelector: () => element },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: () => {},
    Api: {}, showToast: () => {}, window: {}, Vue: {}, URL: {}, sessionStorage: {},
  };
  const vm = Object.assign({}, loadMethods(anchor, deps));
  // 手動推進動畫幀，順便讓呼叫端可以在中途改變 scrollHeight（模擬圖片載入撐開）
  // 時間流逝與「有沒有排到動畫幀」要分開：內容長高是瀏覽器在做的事，跟這支有沒有繼續貼底無關。
  // 綁在一起的話，修法被拆掉（不再排新幀）時連帶讓內容也不長，測試就驗不出差別了。
  vm._runFrames = (n, onFrame) => {
    for (let i = 0; i < n; i++) {
      if (onFrame) onFrame(i);
      const fn = frames.shift();
      if (fn) fn();
    }
    return frames.length;
  };
  return vm;
}

describe('scrollToBottom 要撐到內容不再長高', () => {
  test('貼底之後內容才長高 → 仍然停在底部（只貼一次會差 351px）', () => {
    const el = makeElement({ scrollHeight: 10000 });
    const vm = withDom(el, 'scrollToBottom');
    vm.scrollToBottom();
    expect(el.scrollTop).toBe(9200);        // 第一次就貼到當下的底
    // 第 5 幀時圖片／字型撐開 351px——這正是實測到的情形
    vm._runFrames(10, (i) => { if (i === 5) el.scrollHeight = 10351; });
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(0);
  });

  test('中間有好幾幀高度不動也不能收手（文字先渲染完、圖片後到）', () => {
    const el = makeElement({ scrollHeight: 10000 });
    const vm = withDom(el, 'scrollToBottom');
    vm.scrollToBottom();
    vm._runFrames(20, (i) => { if (i === 18) el.scrollHeight = 12000; });  // 靜止 18 幀後才長
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(0);
  });

  test('會停下來，不是永遠貼著（否則使用者往上捲會被一直拉回去）', () => {
    const el = makeElement({ scrollHeight: 10000 });
    const vm = withDom(el, 'scrollToBottom');
    vm.scrollToBottom();
    expect(vm._runFrames(200)).toBe(0);   // 排空後不再排新的幀
  });

  test('找不到容器 → 不炸', () => {
    const vm = Object.assign({}, loadMethods('scrollToBottom', {
      document: { querySelector: () => null }, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
      Api: {}, showToast: () => {}, window: {}, Vue: {}, URL: {}, sessionStorage: {},
    }));
    expect(() => vm.scrollToBottom()).not.toThrow();
  });
});

describe('isMessagesNearBottom 的門檻要容得下撐開誤差', () => {
  const near = (fromBottom, clientHeight = 800) => {
    const el = makeElement({ scrollHeight: 10000, clientHeight });
    el.scrollTop = 10000 - clientHeight - fromBottom;
    return withDom(el, 'isMessagesNearBottom').isMessagesNearBottom();
  };

  test('離底部 351px（實測的撐開誤差）仍算「在底部」——固定 80px 門檻就是在這裡誤判', () => {
    expect(near(351)).toBe(true);
  });

  test('使用者真的往上翻（超過半頁）→ 不算在底部，不得把畫面搶回去', () => {
    expect(near(3000)).toBe(false);
    expect(near(401)).toBe(false);
  });

  test('門檻跟著視窗高度走，不是寫死的數字', () => {
    expect(near(351, 500)).toBe(false);   // 小視窗：351 > 半頁 250
    expect(near(351, 1200)).toBe(true);   // 大視窗：351 < 半頁 600
  });
});
