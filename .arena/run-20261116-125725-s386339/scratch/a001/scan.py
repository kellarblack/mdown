import sys
from pngcrop import read
p=sys.argv[1]; ys=[int(v) for v in sys.argv[2].split(',')]
x0=int(sys.argv[3]); x1=int(sys.argv[4]) if len(sys.argv)>4 else None
thr=90
w,h,nch,px=read(p)
x1=x1 or w
for y in ys:
    runs=[];inrun=False;st=0
    for x in range(x0,x1):
        i=(y*w+x)*nch
        bright = px[i]>thr
        if bright and not inrun: inrun=True; st=x
        elif not bright and inrun:
            inrun=False; runs.append((st-x0,x-1-x0,x-st))
    if inrun: runs.append((st-x0,x1-1-x0,x1-st))
    print('y=%d  %s' % (y, '  '.join('%d..%d(w%d)'%r for r in runs)))
