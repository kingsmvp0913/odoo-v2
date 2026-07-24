// 意圖：測試區的「實際綁定位址」與「使用者點的網址」必須能各自設定，因為掛在公司網域下時
// 兩者不再相同——容器綁在宿主某個位址，瀏覽器走的是反向代理後的網域。合成一個值的話，
// 症狀是連結看起來正常、點了卻連不上（127.0.0.x 在使用者的電腦上指向他自己），
// 而本機開發（瀏覽器就在宿主上）永遠重現不了。故未設定時必須逐字維持原行為。

const ENV_KEYS = ['ENV_BIND_HOST', 'ENV_PUBLIC_URL_TEMPLATE'];

function withEnv(env, fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try { return fn(require('../port-alloc')); }
  finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('envBindHost', () => {
  test('未設定＝每專案一個 127.0.0.x（cookie 依 host 隔離的既有行為）', () => {
    withEnv({}, (m) => {
      expect(m.envBindHost(8069)).toBe('127.0.0.2');
      expect(m.envBindHost(8070)).toBe('127.0.0.3');
    });
  });

  test('ENV_BIND_HOST 可整台改綁橋接閘道，讓另一個容器內的 nginx 反代得到', () => {
    withEnv({ ENV_BIND_HOST: '172.17.0.1' }, (m) => {
      expect(m.envBindHost(8069)).toBe('172.17.0.1');
      expect(m.envBindHost(9999)).toBe('172.17.0.1');
    });
  });
});

describe('envPublicUrl', () => {
  test('未設樣板＝直連綁定位址，與未反代時逐字相同', () => {
    withEnv({}, (m) => {
      expect(m.envPublicUrl(8069, 'demo')).toBe('http://127.0.0.2:8069');
    });
  });

  test('未設樣板但改了綁定位址時，網址跟著綁定位址走（不會留在舊的 loopback）', () => {
    withEnv({ ENV_BIND_HOST: '172.17.0.1' }, (m) => {
      expect(m.envPublicUrl(8069, 'demo')).toBe('http://172.17.0.1:8069');
    });
  });

  test('樣板以專案目錄名組出子網域——每專案不同網域即取回 cookie 隔離', () => {
    withEnv({ ENV_PUBLIC_URL_TEMPLATE: 'https://{folder}.aidev.example.com' }, (m) => {
      expect(m.envPublicUrl(8069, 'demo')).toBe('https://demo.aidev.example.com');
      expect(m.envPublicUrl(8070, 'other')).toBe('https://other.aidev.example.com');
    });
  });

  test('{port}／{host} 亦可用，供「反代到同一網域不同埠」的機器', () => {
    withEnv({ ENV_BIND_HOST: '172.17.0.1', ENV_PUBLIC_URL_TEMPLATE: 'https://aidev.example.com/{port}/{host}' }, (m) => {
      expect(m.envPublicUrl(8069, 'demo')).toBe('https://aidev.example.com/8069/172.17.0.1');
    });
  });

  test('同一佔位符出現多次全部替換（用 replace 而非 replaceAll 時只換頭一個）', () => {
    withEnv({ ENV_PUBLIC_URL_TEMPLATE: 'https://{folder}.example.com/{folder}' }, (m) => {
      expect(m.envPublicUrl(8069, 'demo')).toBe('https://demo.example.com/demo');
    });
  });

  test('無 folder（專案未設 folder_name 且名稱為空）時不炸，只是留空', () => {
    withEnv({ ENV_PUBLIC_URL_TEMPLATE: 'https://{folder}.example.com' }, (m) => {
      expect(m.envPublicUrl(8069, undefined)).toBe('https://.example.com');
    });
  });
});
