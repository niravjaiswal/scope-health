"""Decode an agent run log (arena logs) into per-task records: item, route, answer, context."""
import sys, json, gzip, base64, re
def decode(path):
    items, closes, ctxs = {}, {}, {}
    order = []
    for line in open(path, errors='replace'):
        line = line.rstrip('\n')
        if line.startswith('ITEM '):
            d = json.loads(line[5:]); items[d['n']] = d; order.append(d['n'])
        elif line.startswith('CLOSE '):
            d = json.loads(line[6:]); closes[d['n']] = d
        elif line.startswith('CTX '):
            try:
                d = json.loads(gzip.decompress(base64.b64decode(line[4:])).decode())
                ctxs[d['id']] = d
            except Exception as e:
                print('ctx err', e, file=sys.stderr)
    out = []
    for n in order:
        it = items[n]
        rec = {**it, 'close': closes.get(n), 'ctx': ctxs.get(it['id'])}
        out.append(rec)
    return out
if __name__ == '__main__':
    recs = decode(sys.argv[1])
    if len(sys.argv) > 2: json.dump(recs, open(sys.argv[2], 'w'), ensure_ascii=False, indent=1)
    for r in recs:
        if r['kind'] != 'task': continue
        c = r.get('close') or {}
        print(r['n'], 'ANS' if 'answer' in c else 'SKIP', c.get('answer', ''), '|', c.get('dt'), '|', r['text'][:110])
