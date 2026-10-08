import sys, base64, gzip, json, re, collections
def decode(path):
    chunks = collections.defaultdict(dict); pages = []
    for line in open(path, errors='replace'):
        line = line.rstrip('\n')
        if line.startswith('DUMP '):
            _, c, i, data = line.split(' ', 3)
            chunks[int(c)][int(i)] = data
    for c in sorted(chunks):
        b = ''.join(chunks[c][i] for i in sorted(chunks[c]))
        try:
            raw = gzip.decompress(base64.b64decode(b)).decode()
            pages += [json.loads(l) for l in raw.split('\n') if l.strip()]
        except Exception as e:
            print('chunk', c, 'failed', e, file=sys.stderr)
    return pages
if __name__ == '__main__':
    pages = decode(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else None
    if out: json.dump(pages, open(out, 'w'), ensure_ascii=False)
    pat = collections.Counter(re.sub(r'/[0-9a-z]{10}(?=/|$|\?)', '/<id>', p['path']) for p in pages)
    for k, v in pat.most_common(80): print(v, k)
    print('pages', len(pages), 'errors', sum(1 for p in pages if p.get('error')))
