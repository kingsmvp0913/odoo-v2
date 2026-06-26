"""
graphify_index.py — headless code indexer for a cloned repo.

Usage: python graphify_index.py <repo_path>

Runs AST-only extraction (no LLM), builds graph, generates:
  <repo_path>/graphify-out/graph.json
  <repo_path>/graphify-out/GRAPH_REPORT.md
  <repo_path>/graphify-out/wiki/index.md  (for Get-WikiCache)
"""
import sys
import json
from pathlib import Path

def main(input_path_str):
    input_path = Path(input_path_str).resolve()
    out_dir = input_path / 'graphify-out'
    out_dir.mkdir(parents=True, exist_ok=True)

    from graphify.detect import detect
    from graphify.extract import collect_files, extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.report import generate
    from graphify.export import to_json

    result = detect(input_path)
    total = result.get('total_files', 0)
    if total == 0:
        print('No supported files found.', flush=True)
        sys.exit(0)

    code_files = []
    for f in result.get('files', {}).get('code', []):
        p = Path(f)
        code_files.extend(collect_files(p) if p.is_dir() else [p])

    if code_files:
        extraction = extract(code_files)
        print(f'AST: {len(extraction["nodes"])} nodes, {len(extraction["edges"])} edges', flush=True)
    else:
        extraction = {'nodes': [], 'edges': [], 'hyperedges': [], 'input_tokens': 0, 'output_tokens': 0}

    G = build_from_json(extraction)
    if G.number_of_nodes() == 0:
        print('Graph is empty, skipping outputs.', flush=True)
        sys.exit(0)

    communities = cluster(G)
    cohesion = score_all(G, communities)
    labels = {cid: f'Community {cid}' for cid in communities}
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    questions = suggest_questions(G, communities, labels)

    report = generate(
        G, communities, cohesion, labels, gods, surprises, result,
        {'input': 0, 'output': 0}, str(input_path), suggested_questions=questions
    )
    (out_dir / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
    to_json(G, communities, str(out_dir / 'graph.json'))

    _write_wiki_index(G, communities, labels, out_dir)

    print(
        f'Done: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, '
        f'{len(communities)} communities',
        flush=True
    )

def _write_wiki_index(G, communities, labels, out_dir):
    wiki_dir = out_dir / 'wiki'
    wiki_dir.mkdir(exist_ok=True)

    # community_id → list of node ids
    comm_nodes = {}
    for node_id in G.nodes():
        cid = communities.get(node_id, 0)
        comm_nodes.setdefault(cid, []).append(node_id)

    lines = ['# Code Index', '']
    for cid, node_ids in sorted(comm_nodes.items()):
        label = labels.get(cid, f'Community {cid}')
        lines.append(f'## {label}')
        for nid in node_ids:
            data = G.nodes[nid]
            name = data.get('label', nid)
            src = data.get('source_file', '')
            lines.append(f'- {name} [{src}]')
        lines.append('')

    (wiki_dir / 'index.md').write_text('\n'.join(lines), encoding='utf-8')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python graphify_index.py <repo_path>', file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1])
