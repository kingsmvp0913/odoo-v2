import json
from pathlib import Path

SKIP = ('/vendor/', 'jest_output.txt', '.min.js', 'settings.local.json')
d = json.load(open('.graphify_detect.json', encoding='utf-8'))
docs = d['files'].get('document', [])
code = [f for f in d['files'].get('code', []) if '/tests/' not in f]
files = sorted(f for f in set(docs + code) if not any(s in f for s in SKIP))
CH = 22
chunks = [files[i:i + CH] for i in range(0, len(files), CH)]
Path('.graphify_chunklist.json').write_text(json.dumps(chunks, indent=1), encoding='utf-8')
print('files=%d chunks=%d' % (len(files), len(chunks)))
