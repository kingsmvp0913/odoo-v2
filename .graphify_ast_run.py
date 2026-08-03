import json
from pathlib import Path
from graphify.extract import extract

d = json.load(open('.graphify_detect.json', encoding='utf-8'))
code = [Path(f) for f in d['files'].get('code', []) if Path(f).exists()]
res = extract(code)
Path('.graphify_ast.json').write_text(json.dumps(res, indent=2), encoding='utf-8')
print('AST: %d nodes, %d edges from %d files' % (len(res['nodes']), len(res['edges']), len(code)))
