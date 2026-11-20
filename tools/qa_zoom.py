"""qa_zoom.py <sprites_root> <boxes.json> <out_dir> [--sets root,nude]  — zoom review sheets (QA gate G5, eye half).

For every outfit set and every pose it writes <out_dir>/<set>-<pose>.png: one row per expression, one column
per region in boxes.json (face, each hand...), each crop scaled up 2-3x on a dark background with a magenta
strip under it (light halos show on dark, dark fringes on magenta). Review rules (docs/PLAYBOOK.md (G5) G5):
count the fingers on every hand, look for ghost or merged fingers, nails on the wrong side, asymmetric eyes,
broken accessories, white pockets and rims. Needs Pillow.
"""
import sys, json, pathlib
from PIL import Image, ImageDraw

root, boxes_path, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
cfg = json.loads(boxes_path.read_text())
out.mkdir(parents=True, exist_ok=True)
sets = {'root': root} | {d.name: d for d in sorted(root.iterdir()) if d.is_dir()}
if '--sets' in sys.argv:
    keep = sys.argv[sys.argv.index('--sets') + 1].split(',')
    sets = {k: v for k, v in sets.items() if k in keep}
CELL_H = 600   # hands come out ~3x: big enough to count fingers (QA G5)


def tile(im, box):
    crop = im.crop(box)
    scale = CELL_H / crop.height
    crop = crop.resize((round(crop.width * scale), CELL_H), Image.LANCZOS)
    dark = Image.new('RGBA', crop.size, (28, 22, 34, 255)); dark.alpha_composite(crop)
    mag = Image.new('RGBA', crop.size, (255, 0, 200, 255)); mag.alpha_composite(crop)
    t = Image.new('RGB', (crop.width, CELL_H + 70), (10, 10, 10))
    t.paste(dark.convert('RGB'), (0, 0))
    t.paste(mag.convert('RGB').crop((0, CELL_H // 2, crop.width, CELL_H // 2 + 60)), (0, CELL_H + 8))
    return t, scale


written = []
for sname, sdir in sets.items():
    for pose, spec in cfg['poses'].items():
        rows = []
        for label in spec['labels']:
            p = sdir / f'{label}.png'
            if not p.exists():
                continue
            im = Image.open(p).convert('RGBA')
            cells = [tile(im, b) + (name,) for name, b in spec['boxes'].items()]
            rows.append((label, cells))
        if not rows:
            continue
        W = 150 + max(sum(c[0].width + 10 for c in cells) for _, cells in rows)
        H = sum(CELL_H + 90 for _ in rows) + 10
        sheet = Image.new('RGB', (W, H), (0, 0, 0))
        d = ImageDraw.Draw(sheet)
        y = 10
        for label, cells in rows:
            d.text((8, y + CELL_H // 2), label, fill='white')
            x = 150
            for t, scale, name in cells:
                sheet.paste(t, (x, y))
                d.text((x + 4, y + 4), f'{name} {scale:.1f}x', fill='yellow')
                x += t.width + 10
            y += CELL_H + 90
        dst = out / f'{sname}-{pose}.png'
        sheet.save(dst)
        written.append(dst.name)
print('\n'.join(written))
