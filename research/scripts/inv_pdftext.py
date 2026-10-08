# minimal PDF text extractor for Wrenfield lab-report PDFs (Type0/Identity-H + ToUnicode), in memory
import re, zlib
def _streams(data):
    objs={}
    for num,body in re.findall(rb'(\d+) 0 obj(.*?)endobj', data, re.S):
        m=re.search(rb'stream\r?\n(.*?)\r?\nendstream', body, re.S)
        s=None
        if m:
            s=m.group(1)
            if b'FlateDecode' in body.split(b'stream')[0]:
                try: s=zlib.decompress(s)
                except Exception: pass
        objs[int(num)]=(body.split(b'stream')[0], s)
    return objs
def _cmap(s):
    mp={}
    for blk in re.findall(rb'beginbfchar(.*?)endbfchar', s, re.S):
        for a,b in re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', blk):
            mp[int(a,16)]=bytes.fromhex(b.decode()).decode('utf-16-be')
    for blk in re.findall(rb'beginbfrange(.*?)endbfrange', s, re.S):
        for a,b,c in re.findall(rb'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', blk):
            st=int(c,16)
            for k in range(int(a,16), int(b,16)+1): mp[k]=chr(st+k-int(a,16))
    return mp
def extract(data):
    objs=_streams(data)
    # font name -> cmap via page resources
    fonts={}
    for num,(d,s) in objs.items():
        for name,ref in re.findall(rb'/(F\d+)\s+(\d+) 0 R', d):
            fd=objs.get(int(ref),(b'',None))[0]
            m=re.search(rb'/ToUnicode\s+(\d+) 0 R', fd)
            if m: fonts[name.decode()]=_cmap(objs[int(m.group(1))][1])
    lines=[]
    for num,(d,s) in objs.items():
        if not s or b'BT' not in s: continue
        for bt in re.findall(rb'BT(.*?)ET', s, re.S):
            fm=re.search(rb'/(F\d+)\s+[\d.]+\s+Tf', bt); cm=fonts.get(fm.group(1).decode(),{}) if fm else {}
            pos=re.search(rb'([\d.\-]+)\s+([\d.\-]+)\s+Td', bt)
            txt=""
            for h in re.findall(rb'<([0-9A-Fa-f]+)>\s*Tj', bt):
                h=h.decode(); txt+="".join(cm.get(int(h[i:i+4],16),'?') for i in range(0,len(h),4))
            for t in re.findall(rb'\((.*?)(?<!\\)\)\s*Tj', bt): txt+=t.decode('latin1')
            x,y=(float(pos.group(1)),float(pos.group(2))) if pos else (0,0)
            lines.append((y,x,txt))
    # group by y desc
    lines.sort(key=lambda t:(-round(t[0]),t[1]))
    out=[];cur=None;buf=[]
    for y,x,t in lines:
        if cur is None or abs(y-cur)>2:
            if buf: out.append("  ".join(buf))
            buf=[t];cur=y
        else: buf.append(t)
    if buf: out.append("  ".join(buf))
    return "\n".join(out)
