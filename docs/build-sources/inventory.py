import os, re, json
os.chdir(r"C:\Users\satri\OneDrive\Dokumen\Claude Set\VierStation")
D = r"C:\Users\satri\AppData\Local\Temp\claude\7f6d85dfeffc2f4c\521ec0ea-9b6d-4944-b29b-8b92aca1366f\scratchpad\doc"
out = []
skip = {'node_modules', 'dist', 'data', 'runs', '.tmp', 'out', 'fixtures'}
for base in ['server', 'shared', 'src', 'scripts', 'tests']:
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if d not in skip]
        for f in sorted(fn):
            if not f.endswith(('.ts', '.tsx', '.py')) and f != 'world-110m.json':
                continue
            p = os.path.join(dp, f).replace(chr(92), '/')
            txt = open(p, encoding='utf8', errors='replace').read()
            lines = txt.count(chr(10)) + 1
            first = ''
            for l in txt.split(chr(10))[:6]:
                m = re.match(r'\s*(?://+|#|/\*+)\s*(.*)', l)
                if m and m.group(1).strip():
                    first = m.group(1).strip().rstrip('*/').strip()
                    break
                if l.startswith('"""'):
                    first = l.strip('"').strip()
                    break
            out.append({'path': p, 'lines': lines, 'what': first})
json.dump(out, open(os.path.join(D, 'files.json'), 'w', encoding='utf8'), ensure_ascii=False, indent=0)
print(len(out), 'files', sum(o['lines'] for o in out), 'lines')
routes = []
for f in sorted(os.listdir('server/routes')):
    t = open('server/routes/' + f, encoding='utf8').read()
    for m in re.finditer(r"route\('(GET|POST|PUT|PATCH|DELETE)',\s*'([^']+)'", t):
        routes.append((f, m.group(1), m.group(2)))
json.dump(routes, open(os.path.join(D, 'routes.json'), 'w'), indent=0)
print(len(routes), 'routes')
noc = [o['path'] for o in out if not o['what']]
print('no header comment:', len(noc), noc[:15])
