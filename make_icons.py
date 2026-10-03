from PIL import Image, ImageDraw, ImageFont
import glob, os, sys
out = sys.argv[1] if len(sys.argv) > 1 else 'icons'
os.makedirs(out, exist_ok=True)
fonts = glob.glob('/usr/share/fonts/**/DejaVuSans-Bold.ttf', recursive=True)
for s, name, rad in [(512,'icon-512.png',0.22),(192,'icon-192.png',0.22),(180,'apple-touch-icon.png',0),(512,'maskable-512.png',0)]:
    im = Image.new('RGBA', (s, s), (0,0,0,0)); d = ImageDraw.Draw(im); col = (22,163,74,255)
    if rad: d.rounded_rectangle([0,0,s-1,s-1], radius=int(s*rad), fill=col)
    else: d.rectangle([0,0,s,s], fill=col)
    f = ImageFont.truetype(fonts[0], int(s*0.38)) if fonts else ImageFont.load_default(size=int(s*0.38))
    b = d.textbbox((0,0), 'zł', font=f)
    d.text(((s-(b[2]-b[0]))/2-b[0], (s-(b[3]-b[1]))/2-b[1]), 'zł', font=f, fill='white')
    im.save(os.path.join(out, name))
