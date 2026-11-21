"""qa_sprites.py <sprites_root> [--face] [--face-box x0,y0,x1,y1] [--sheet flagged.png] [--accept waivers.json]  — automated half of the sprite gate (docs/PLAYBOOK.md (G5), gate G5).

<sprites_root> is a character's sprite folder (e.g. <SillyTavern>/data/default-user/characters/<Name>). Every PNG set in it
is checked: the root (canonical outfit) and each costume subfolder (nude/, robe/...).

Checks, per set and across sets:
  labels    all 28 SillyTavern expression labels present (fallback 'neutral' at least)
  size      every sprite in every set has the same canvas size
  alpha     RGBA with real transparency
  top       nothing cropped at the top (first opaque row > 4 px)
  bottom    the figure runs off the bottom edge (no floating feet / gap)
  halo      light fringe on the cut-out edge (semi-transparent near-white edge pixels) below 2 %
  rim       mostly opaque pixels on the figure's outermost ring that are light and much lighter than the
            figure just inside: background painted into the edge (a render on white), which halo misses because
            they are opaque. On a dark chat background they read as a cut-out rim. WARN above 0.5 %, FAIL above
            1.5 % of the ring; white hair or clothes with no outline can warn, so judge it at 3x
  pockets   (needs opencv) near-white blobs >= 40 px (alpha > 100) ringed mostly by dark pixels (line art,
            hair, wing), or partly dark and touching the outside without a skin ring: background trapped
            inside the figure (FAIL). Large white blobs ringed by skin can be a pocket or a skin shine:
            listed as WARN for the zoom review, as are small pocket-like slivers. --sheet out.png writes 2x
            crops of every flagged spot for that review. --accept waivers.json skips spots a zoomed review
            judged acceptable (each waiver has a reason and a date). The face region (--face-box x0,y0,x1,y1, default
            from the canvas: upper-middle) is excluded because eye whites look the same
  face      (--face, needs opencv + the anime face cascade) warns if face width/top line differ >15 % across sets
            (the detector jitters, so confirm on the contact sheet)
Exit code 1 if anything fails. Needs Pillow and numpy.
"""
import sys, pathlib
import numpy as np
from PIL import Image

LABELS = ['admiration', 'amusement', 'anger', 'annoyance', 'approval', 'caring', 'confusion', 'curiosity', 'desire',
          'disappointment', 'disapproval', 'disgust', 'embarrassment', 'excitement', 'fear', 'gratitude', 'grief', 'joy',
          'love', 'nervousness', 'neutral', 'optimism', 'pride', 'realization', 'relief', 'remorse', 'sadness', 'surprise']
CASCADE = pathlib.Path(__file__).parent / 'lbpcascade_animeface.xml'


def box_mean(x, r):
    """Mean over a (2r+1)^2 window, edges clamped (integral image)."""
    p = np.pad(x, r + 1, mode='edge').cumsum(0).cumsum(1)
    k = 2 * r + 1
    s = p[k:, k:] - p[:-k, k:] - p[k:, :-k] + p[:-k, :-k]
    return s[:x.shape[0], :x.shape[1]] / (k * k)


def halo_ratio(a):
    """Share of cut-out edge pixels that are much lighter than the opaque figure just inside them:
    a white fringe left by the background. Pale skin next to pale skin is not counted."""
    alpha = a[..., 3].astype(np.float32)
    edge = (alpha > 0) & (alpha < 250)
    if not edge.any():
        return 0.0
    luma = a[..., :3].astype(np.float32).mean(-1)
    opaque = (alpha >= 250).astype(np.float32)
    inner = box_mean(luma * opaque, 3) / np.maximum(box_mean(opaque, 3), 1e-3)
    fringe = edge & (luma > 200) & (luma - inner > 60) & (box_mean(opaque, 3) > 0.15)
    return float(fringe.sum() / edge.sum())


def rim_ratio(a):
    """Share of the figure's outermost ring (pixels touching empty ones) that is light and much lighter than
    the figure just inside it: background painted into the edge. Pale skin next to pale skin is not counted."""
    alpha = a[..., 3]
    out = np.pad(alpha == 0, 1, constant_values=True)
    near = np.zeros_like(alpha, bool)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            near |= out[dy:dy + alpha.shape[0], dx:dx + alpha.shape[1]]
    ring = (alpha > 0) & near
    if not ring.any():
        return 0.0
    luma = a[..., :3].astype(np.float32).mean(-1)
    core = ((alpha >= 250) & ~ring).astype(np.float32)
    inner = box_mean(luma * core, 3) / np.maximum(box_mean(core, 3), 1e-3)
    rim = ring & (alpha >= 128) & (luma > 150) & (luma - inner > 30) & (box_mean(core, 3) > 0.1)
    return float(rim.sum() / ring.sum())


def pockets(a, exclude):
    import cv2
    rgb = a[..., :3].astype(np.int16)
    white = (a[..., 3] > 100) & (rgb.min(-1) >= 240) & ((rgb.max(-1) - rgb.min(-1)) <= 10)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(white.astype(np.uint8), connectivity=8)
    luma = rgb.mean(-1)
    found, suspects = [], []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < 40:
            continue
        cx, cy = x + w / 2, y + h / 2
        if exclude and exclude[0] <= cx <= exclude[2] and exclude[1] <= cy <= exclude[3]:
            continue
        x0, y0, x1, y1 = max(x - 4, 0), max(y - 4, 0), x + w + 4, y + h + 4
        comp = (lab[y0:y1, x0:x1] == i).astype(np.uint8)
        ring = cv2.dilate(comp, np.ones((7, 7), np.uint8)).astype(bool) & ~comp.astype(bool)
        ring &= a[y0:y1, x0:x1, 3] > 128               # judge the ring by the figure, not by empty pixels
        if not ring.any():
            continue
        rpx = rgb[y0:y1, x0:x1][ring]
        dark = (rpx.mean(-1) < 150).mean()
        skin = ((rpx[:, 0] > 200) & (rpx[:, 1] > 160) & (rpx[:, 2] > 140) & (rpx[:, 0] - rpx[:, 2] > 12)).mean()
        near = cv2.dilate(comp, np.ones((11, 11), np.uint8)).astype(bool) & (a[y0:y1, x0:x1, 3] == 0)
        pocket_like = dark >= 0.35 or (near.any() and dark >= 0.15 and skin <= 0.6)
        if pocket_like and area >= 150:
            found.append((int(x), int(y), int(area)))      # big and ringed by the figure: background
        elif pocket_like or area >= 600:
            suspects.append((int(x), int(y), int(area)))   # small sliver, shine or claw tip: look at it
    return found, suspects


def face_box(path):
    import cv2
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img.shape[2] == 4:
        al = img[..., 3:] / 255.0
        img = (img[..., :3] * al + 255 * (1 - al)).astype('uint8')
    g = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    f = cv2.CascadeClassifier(str(CASCADE)).detectMultiScale(g, 1.05, 4, minSize=(80, 80))
    return max(f, key=lambda r: r[2]) if len(f) else None


def main():
    root = pathlib.Path(sys.argv[1])
    use_face = '--face' in sys.argv
    face_ex = None
    accepted = []
    if '--accept' in sys.argv:
        import json
        accepted = json.loads(pathlib.Path(sys.argv[sys.argv.index('--accept') + 1]).read_text())['accepted']
    if '--face-box' in sys.argv:
        face_ex = tuple(float(v) for v in sys.argv[sys.argv.index('--face-box') + 1].split(','))
    sets = {'(root)': root} | {d.name: d for d in sorted(root.iterdir()) if d.is_dir()}
    fails, sizes, faces, suspects_all, spots = [], set(), {}, [], []
    for name, d in sets.items():
        files = {p.stem: p for p in d.glob('*.png')}
        missing = [l for l in LABELS if l not in files]
        if missing:
            fails.append(f'{name}: missing labels {missing}')
        worst_halo, worst_rim, bad = 0.0, 0.0, []
        for stem, p in sorted(files.items()):
            im = Image.open(p)
            sizes.add(im.size)
            if im.mode != 'RGBA':
                bad.append(f'{stem}: not RGBA'); continue
            a = np.array(im)
            rows = np.where((a[..., 3] > 128).any(1))[0]
            if not len(rows):
                bad.append(f'{stem}: empty'); continue
            if rows[0] <= 4:
                bad.append(f'{stem}: cropped at top (first row {rows[0]})')
            if rows[-1] < im.height - 1:
                bad.append(f'{stem}: gap at bottom ({im.height - 1 - rows[-1]} px)')
            h = halo_ratio(a)
            worst_halo = max(worst_halo, h)
            if h > 0.02:
                bad.append(f'{stem}: light halo {h:.1%}')
            rim = rim_ratio(a)
            worst_rim = max(worst_rim, rim)
            if rim > 0.015:
                bad.append(f'{stem}: light rim on {rim:.1%} of the outline')
            elif rim > 0.005:
                suspects_all.append(f'{name}/{stem}: light rim on {rim:.1%} of the outline (white hair or clothes, or a cut-out rim? check at 3x)')
            try:
                pk, sus = pockets(a, face_ex or (im.width * 0.3, im.height * 0.2, im.width * 0.7, im.height * 0.45))
            except ImportError:
                pk, sus = [], []
            waived = [s_ for s_ in pk if any(w['set'] == name and w['label'] == stem and abs(w['x'] - s_[0]) <= 20
                                             and abs(w['y'] - s_[1]) <= 20 for w in accepted)]
            for s_ in waived:
                print(f'ACCEPTED {name}/{stem} {s_}: reviewed waiver')
            pk = [s_ for s_ in pk if s_ not in waived]
            for s_ in pk:
                spots.append((f'FAIL {name}/{stem}', p, s_))
            for s_ in sus:
                spots.append((f'WARN {name}/{stem}', p, s_))
            if pk:
                bad.append(f'{stem}: {len(pk)} background pocket(s) inside the figure (x, y, px): {pk[:4]}')
            if sus:
                suspects_all.append(f'{name}/{stem}: large white blob(s), pocket or skin shine? check in the zoom sheet (x, y, px): {sus[:3]}')
            if use_face and stem in ('neutral', 'joy', 'pride', 'desire', 'anger', 'surprise'):
                fb = face_box(p)
                if fb is not None:
                    faces.setdefault(stem, {})[name] = fb
        fails += [f'{name}: {b}' for b in bad]
        print(f'{name:10s} {len(files):2d} files  worst halo {worst_halo:.2%}  worst rim {worst_rim:.2%}  {"OK" if not bad and not missing else "FAIL"}')
    if len(sizes) > 1:
        fails.append(f'canvas sizes differ: {sorted(sizes)}')
    warns = []
    for stem, per in faces.items():
        if len(per) < 2:
            continue
        ws = [r[2] for r in per.values()]
        ys = [r[1] for r in per.values()]
        # the cascade box itself jitters ~10% between faces, so this is a hint, not a gate
        if max(ws) > min(ws) * 1.15 or max(ys) - min(ys) > 0.15 * np.mean(ws):
            warns.append(f'face scale/line may differ across sets for {stem}: {per}')
    for w in warns + suspects_all:
        print('WARN', w)
    print('sizes:', sorted(sizes))
    if '--sheet' in sys.argv and spots:
        from PIL import ImageDraw
        dst = sys.argv[sys.argv.index('--sheet') + 1]
        tiles = []
        for label, path, (x, y, area) in spots[:60]:
            im = Image.open(path).convert('RGBA')
            box = (max(x - 50, 0), max(y - 50, 0), min(x + 110, im.width), min(y + 110, im.height))
            c = im.crop(box)
            bg = Image.new('RGBA', c.size, (28, 22, 34, 255)); bg.alpha_composite(c)
            tl = bg.convert('RGB').resize((c.width * 2, c.height * 2), Image.NEAREST)
            ImageDraw.Draw(tl).text((3, 3), f'{label} {x},{y} {area}px', fill='yellow')
            tiles.append(tl)
        cols = 5
        tw = max(tl.width for tl in tiles); th = max(tl.height for tl in tiles)
        sheet = Image.new('RGB', (cols * (tw + 4), ((len(tiles) + cols - 1) // cols) * (th + 4)), 'black')
        for i, tl in enumerate(tiles):
            sheet.paste(tl, ((i % cols) * (tw + 4), (i // cols) * (th + 4)))
        sheet.save(dst)
        print(f'flagged spots sheet: {dst} ({len(tiles)} crops)')
    if fails:
        print('\nFAIL'); [print(' -', f) for f in fails]; sys.exit(1)
    print('\nPASS')


if __name__ == '__main__':
    main()
