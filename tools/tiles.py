# Tile finishing: a picture enlarged 2x by having it redrawn in overlapping tiles, then joined without
# seams. No model runs in this file: it only cuts, lines up and blends. The redraw of every tile is done
# by a rendering backend (src/render/finish.ts):
#   gpt  the GPT image tool (Codex CLI or the OpenAI API) redraws each enlarged, soft tile sharp;
#   sd   SDXL img2img with the character's LoRA (ComfyUI) at low denoise, plus a face tile at higher
#        resolution. This is the local route, and the only one for NSFW.
#
#   python -I tools/tiles.py cut  <picture> <work dir> --mode gpt|sd [--scale 2] [--face x,y,w,h]
#   (the backend redraws every tN.png in the work dir as oN.png)
#   python -I tools/tiles.py join <picture> <work dir> <out.png>
#   python -I tools/tiles.py face <picture>     (the face box, for the local renders' face pass)
#
# Needs numpy, pillow and opencv-python-headless (tools/requirements.txt). Python 3.9+.
#
# The method is Siren Siege's decision D-037, which the owner compared and approved. Joins hold
# because of four things:
# - Tiles overlap, and one extra tile is centred on the face, so the eyes and mouth come from a
#   single redraw. That tile wins wherever it reaches.
# - Every redrawn tile is lined up with the part of the picture it redraws (ECC, affine).
# - A tile keeps its fine detail and takes its overall colour and brightness from the approved
#   picture, so tiles agree with each other and skin and hair keep the approved colours.
# - For a cut-out picture the outline (alpha) is GPT's own when the tiles come back transparent:
#   clean, and it fits the redraw. It is only trusted near the approved outline: well inside, the
#   figure is solid, and well outside nothing is there, whatever a tile says. Tiles without
#   transparency get the approved outline, enlarged. The colours under the outline spread outwards
#   from inside the figure, so no background colour shows at the edge.
import argparse
import json
import math
import os
import sys

import cv2
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
DARK = (46, 40, 56)
# What GPT may see behind a cut-out figure: whichever is farthest from the colours along the figure's
# outline (pick_back). On a backdrop close to a part's colour (black horns on a dark backdrop) GPT's
# transparency eats into that part.
BACKS_GPT = [(128, 128, 128), (230, 230, 230), DARK]
BACK_SD = (255, 255, 255)  # SDXL masters are rendered on flat white
GPT_SIZES = [(1024, 1536), (1536, 1024), (1024, 1024)]  # what the GPT image tool returns


def load(path):
    picture = Image.open(path)
    picture.load()
    rgba = picture.convert('RGBA')
    alpha = np.asarray(rgba)[..., 3]
    return rgba, bool((alpha < 250).mean() > 0.001)


def flat(rgba, back):
    canvas = Image.new('RGBA', rgba.size, tuple(back) + (255,))
    canvas.alpha_composite(rgba)
    return canvas.convert('RGB')


def detect_face(rgba, min_weight=0.0):
    """The most confident anime face in the upper 60% of the picture, as [x, y, w, h], or None.

    The cascade misses faces behind a hand or on some backgrounds, so a cut-out is tried on several
    backgrounds, with and without histogram equalisation, before giving up. Among the candidates the most
    confident wins, not the largest: in a ballroom render the largest was a chandelier (confidence 1.3)
    and the real face (2.7) lost. `min_weight` drops weak candidates (real faces measured 2.5-4.3)."""
    cascade = cv2.CascadeClassifier(os.path.join(HERE, 'lbpcascade_animeface.xml'))
    smallest = max(24, rgba.width // 24)
    for back in [(128, 128, 128), (255, 255, 255), DARK]:
        gray = cv2.cvtColor(np.asarray(flat(rgba, back)), cv2.COLOR_RGB2GRAY)
        for picture in (cv2.equalizeHist(gray), gray):
            boxes, _, weights = cascade.detectMultiScale3(picture, 1.05, 4, minSize=(smallest, smallest), outputRejectLevels=True)
            found = [(float(w), b) for b, w in zip(boxes, np.ravel(weights)) if b[1] + b[3] / 2 < rgba.height * 0.6 and float(w) >= min_weight]
            if found:
                x, y, w, h = max(found, key=lambda f: f[0])[1]
                return [int(x), int(y), int(w), int(h)]
    return None


def pick_back(rgba):
    """The candidate backdrop with the fewest outline pixels near its colour (ties keep the earlier one)."""
    a = np.asarray(rgba).astype(np.float32)
    solid = (a[..., 3] > 200).astype(np.uint8)
    band = solid.astype(bool) & ~cv2.erode(solid, np.ones((3, 3), np.uint8), iterations=2).astype(bool)  # the contour
    colours = a[..., :3][band]
    if len(colours) < 50:
        return BACKS_GPT[0]
    if len(colours) > 20000:
        colours = colours[np.random.default_rng(0).choice(len(colours), 20000, replace=False)]
    return min(BACKS_GPT, key=lambda back: float((np.linalg.norm(colours - np.array(back, np.float32), axis=1) < 60).mean()))


def place(middle, size, limit):
    """A span of `size` around `middle`, moved inside 0..limit when it fits, centred on it when it does not."""
    start = (limit - size) / 2 if size >= limit else min(max(middle - size / 2, 0), limit - size)
    return int(round(start)), int(round(start + size))


def fit(box, aspect, width, height):
    """Grow a box to the shape `aspect` (width / height) of the redraw, so the tile is never stretched.
    Past the picture's edge the tile shows the backdrop."""
    l, t, r, b = box
    w, h = r - l, b - t
    w, h = max(w, h * aspect), max(h, w / aspect)
    l, r = place((l + r) / 2, w, width)
    t, b = place((t + b) / 2, h, height)
    return [l, t, r, b]


def spans(length, count, overlap):
    """`count` equal spans covering 0..length, each overlapping its neighbour by `overlap` of its size."""
    if count == 1:
        return [(0, length)]
    size = length / (count - (count - 1) * overlap)
    starts = [round(i * (length - size) / (count - 1)) for i in range(count)]
    return [(s, min(length, round(s + size))) for s in starts]


def gpt_grid(width, height, scale, density, overlap=0.2):
    """Fewest tiles whose GPT redraw has at least `density` pixels per output pixel on both axes."""
    best = None
    for columns in range(1, 6):
        for rows in range(1, 8):
            region_w = width / (columns - (columns - 1) * overlap) if columns > 1 else width
            region_h = height / (rows - (rows - 1) * overlap) if rows > 1 else height
            size = min(GPT_SIZES, key=lambda s: abs(math.log((s[0] / s[1]) / (region_w / region_h))))
            aspect = size[0] / size[1]
            # the region grows to the redraw's shape (fit), which is what the redraw has to cover
            reach = size[0] / (scale * max(region_w, region_h * aspect))
            if reach < density:
                continue
            key = (columns * rows, -reach)
            if best is None or key < best[0]:
                best = (key, columns, rows, size)
    if best is None:
        raise SystemExit(f'no grid reaches density {density} for {width}x{height} at {scale}x; lower --density')
    _, columns, rows, size = best
    return [(l, t, r, b, size) for (t, b) in spans(height, rows, overlap) for (l, r) in spans(width, columns, overlap)]


def round8(v):
    return max(64, int(round(v / 8.0)) * 8)


def sd_grid(width, height, scale, tile=1024, overlap=0.125):
    """Tiles whose redraw is exactly `scale` times the region (SDXL works best near 1 MP)."""
    limit = tile / scale
    count = lambda length: next(c for c in range(1, 40) if length / (c - (c - 1) * overlap if c > 1 else 1) <= limit)
    out = []
    for t, b in spans(height, count(height), overlap):
        for l, r in spans(width, count(width), overlap):
            out.append((l, t, r, b, (round8((r - l) * scale), round8((b - t) * scale))))
    return out


def cut(args):
    rgba, has_alpha = load(args.picture)
    width, height = rgba.size
    os.makedirs(args.work, exist_ok=True)
    back = (pick_back(rgba) if has_alpha else BACKS_GPT[0]) if args.mode == 'gpt' else BACK_SD
    face = [int(v) for v in args.face.split(",")] if args.face else detect_face(rgba)
    if args.mode == 'gpt':
        grid = gpt_grid(width, height, args.scale, args.density)
    else:
        grid = sd_grid(width, height, args.scale)
    if args.mode == 'gpt':
        grid = [tuple(fit((l, t, r, b), size[0] / size[1], width, height)) + (size,) for (l, t, r, b, size) in grid]
    tiles = [{'box': [l, t, r, b], 'size': list(size), 'face': False, 'denoise': args.denoise} for (l, t, r, b, size) in grid]
    if face:
        fx, fy, fw, fh = face
        cx, cy = fx + fw / 2, fy + fh / 2
        if args.mode == 'gpt':
            # the size of a grid tile, with the face's middle a fifth of the way down (Siren Siege)
            l, t, r, b = tiles[0]['box']
            w, h = r - l, b - t
            left, right = place(cx, w, width)
            top, bottom = place(cy + 0.28 * h, h, height)
            box, size = [left, top, right, bottom], tiles[0]['size']
        else:
            # a square around the face and its hair, redrawn at 1024 px or more
            side = int(min(width, height, max(fw, fh) * 2.2))
            left = int(np.clip(cx - side / 2, 0, width - side))
            top = int(np.clip(cy - side * 0.45, 0, height - side))
            box = [left, top, left + side, top + side]
            px = round8(min(1536, max(1024, side * args.scale)))
            size = [px, px]
        tiles.append({'box': box, 'size': size, 'face': True, 'denoise': args.face_denoise})
    else:
        print('no face found: no face tile (pass --face x,y,w,h)', file=sys.stderr)
    for index, tile in enumerate(tiles):
        flat(rgba.crop(tuple(tile['box'])), back).resize(tuple(tile['size']), Image.LANCZOS).save(os.path.join(args.work, f't{index}.png'))
    plan = {'mode': args.mode, 'scale': args.scale, 'size': [width, height], 'alpha': has_alpha, 'back': list(back), 'face': face, 'tiles': tiles}
    with open(os.path.join(args.work, 'tiles.json'), 'w') as f:
        json.dump(plan, f, indent=1)
    print(json.dumps({'tiles': len(tiles), 'face': face, 'alpha': has_alpha}))


def spread(rgb, known, rounds):
    """Fill the pixels that are not `known` with the colours next to them, working outwards."""
    rgb = rgb.copy()
    known = known.copy()
    kernel = np.ones((3, 3), np.float32)
    for _ in range(rounds):
        if known.all():
            break
        k = known.astype(np.float32)
        total = cv2.filter2D(rgb * k[..., None], -1, kernel, borderType=cv2.BORDER_REPLICATE)
        count = cv2.filter2D(k, -1, kernel, borderType=cv2.BORDER_REPLICATE)
        new = (~known) & (count > 0.5)
        rgb[new] = total[new] / count[new][:, None]
        known |= new
    return rgb


def ramp(n, at_start, at_end):
    """1 in the middle, easing to 0 over the outer fifth; a picture edge has no neighbour and stays 1."""
    x = np.arange(n) + 0.5
    a = np.ones(n) if at_start else np.clip(x / (0.2 * n), 0, 1)
    z = np.ones(n) if at_end else np.clip((n - x) / (0.2 * n), 0, 1)
    m = np.minimum(a, z)
    return m * m * (3 - 2 * m)


def join(args):
    with open(os.path.join(args.work, 'tiles.json')) as f:
        plan = json.load(f)
    scale, back = plan['scale'], np.array(plan['back'], np.float32)
    rgba_img, _ = load(args.picture)
    picture = np.asarray(rgba_img).astype(np.float32)
    rows, columns = picture.shape[:2]
    high, across = int(round(rows * scale)), int(round(columns * scale))
    size = (across, high)
    cut_out_picture = plan['alpha']
    if cut_out_picture:
        # the approved outline, enlarged, its pixel steps smoothed away and its edge made crisp
        alpha = cv2.resize(picture[..., 3] / 255, size, interpolation=cv2.INTER_CUBIC).clip(0, 1)
        alpha = np.clip((cv2.GaussianBlur(alpha, (0, 0), 0.65 * scale) - 0.5) * 2.0 + 0.5, 0, 1)
        inner = cv2.erode((alpha > 0.9).astype(np.uint8), np.ones((3, 3), np.uint8), iterations=2).astype(bool)
    else:
        alpha = np.ones((high, across), np.float32)
        inner = np.ones((high, across), bool)
    base = np.asarray(flat(Image.fromarray(picture.astype(np.uint8)), plan['back']).resize(size, Image.LANCZOS)).astype(np.float32)

    def gray(image, blur):
        return cv2.GaussianBlur(cv2.cvtColor(image.clip(0, 255).astype(np.uint8), cv2.COLOR_RGB2GRAY), (0, 0), blur).astype(np.float32)

    def pull(image, matrix, border):
        return cv2.warpAffine(image, matrix[:2].astype(np.float32), size, flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP, borderMode=border)

    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-7)
    coarse = 10.0 * scale  # colour and brightness are compared over this many output pixels
    total = np.zeros((high, across, 3), np.float32)
    weight = np.zeros((high, across, 1), np.float32)
    solid = np.zeros((high, across, 1), np.float32)
    own_outline = cut_out_picture
    report = []
    for index, tile_plan in enumerate(plan['tiles']):
        l, t, r, b = tile_plan['box']
        path = os.path.join(args.work, f'o{index}.png')
        if not os.path.exists(path):
            print(f'tile {index}: missing {path}', file=sys.stderr)
            continue
        rgba = np.asarray(Image.open(path).convert('RGBA')).astype(np.float32)
        tile_alpha = rgba[..., 3:] / 255
        cut_out = float((tile_alpha < 0.04).mean()) > 0.005
        tile = rgba[..., :3] * tile_alpha + back * (1 - tile_alpha)
        tile_high, tile_across = tile.shape[:2]
        sent = np.asarray(Image.open(os.path.join(args.work, f't{index}.png')).convert('RGB').resize((tile_across, tile_high), Image.LANCZOS)).astype(np.float32)
        shift = np.eye(2, 3, dtype=np.float32)
        try:
            match, found = cv2.findTransformECC(gray(sent, 3), gray(tile, 3), shift.copy(), cv2.MOTION_AFFINE, criteria, None, 5)
            fits = (match > 0.6 and abs(found[0, 0] - 1) < 0.08 and abs(found[1, 1] - 1) < 0.08 and abs(found[0, 1]) < 0.03 and abs(found[1, 0]) < 0.03
                    and abs(found[0, 2]) < tile_across * 0.06 and abs(found[1, 2]) < tile_high * 0.06)
        except cv2.error:
            match, found, fits = 0.0, shift, False
        if fits:
            shift = found
        elif float(gray(sent, 3).std()) < 6:
            match = 0.0  # a nearly empty tile has nothing to line up: it goes where it was cut from
        else:
            # The redraw does not line up with what was sent: wrong picture, or moved and reframed.
            # Placing it anyway puts the wrong thing there, so it is left out and redrawn again.
            report.append({'tile': index, 'match': round(float(match), 3), 'dropped': True})
            print(f'tile {index}: does not line up with what was sent (match {match:.3f}): left out', file=sys.stderr)
            continue
        own_outline = own_outline and cut_out
        fx, fy = tile_across / ((r - l) * scale), tile_high / ((b - t) * scale)
        out_to_sent = np.array([[fx, 0, (0.5 - l * scale) * fx - 0.5], [0, fy, (0.5 - t * scale) * fy - 0.5], [0, 0, 1]])
        out_to_tile = np.vstack([shift, [0, 0, 1]]).astype(np.float64) @ out_to_sent
        colours = spread(rgba[..., :3], tile_alpha[..., 0] > 0.3, 16) if cut_out else tile
        placed = pull(colours, out_to_tile, cv2.BORDER_REPLICATE)
        feather = np.outer(ramp(tile_high, t <= 0, b >= rows), ramp(tile_across, l <= 0, r >= columns)).astype(np.float32) + 1e-3
        if tile_plan.get('face'):
            feather = feather * 60  # the face tile wins wherever it reaches
        share = pull(feather, out_to_tile, cv2.BORDER_CONSTANT)[:, :, None]
        inside = (share[..., 0] > 0).astype(np.float32) * inner

        def low(image):
            return cv2.GaussianBlur(image * inside[..., None], (0, 0), coarse) / np.maximum(cv2.GaussianBlur(inside, (0, 0), coarse), 1e-4)[:, :, None]

        tied = placed - low(placed) + low(base)
        there = pull(tile_alpha[..., 0], out_to_tile, cv2.BORDER_CONSTANT)[:, :, None].clip(0, 1) if cut_out else 1.0
        total += tied * share
        weight += share
        solid += there * share
        report.append({'tile': index, 'match': round(float(match), 3), 'dx': round(float(shift[0, 2]), 1), 'dy': round(float(shift[1, 2]), 1)})

    if not any(not t.get('dropped') for t in report):
        raise SystemExit('no usable redrawn tile (oN.png) in the work dir')
    rgb = np.where(weight > 0, total / np.maximum(weight, 1e-6), base).clip(0, 255)
    approved = alpha
    if cut_out_picture and own_outline:
        drawn = (solid / np.maximum(weight, 1e-6))[..., 0]
        near = np.ones((3, 3), np.uint8)
        # GPT may move the outline inwards by 2 px at most: deeper, the approved figure is solid
        surely_in = cv2.erode((alpha > 0.95).astype(np.uint8), near, iterations=2).astype(np.float32)
        # wide and soft: GPT draws loose hairs a little past the approved outline
        maybe_in = cv2.GaussianBlur(cv2.dilate((alpha > 0.05).astype(np.uint8), near, iterations=18).astype(np.float32), (0, 0), 5)
        alpha = np.clip(np.maximum(drawn, surely_in) * maybe_in, 0, 1)
        rgb = spread(rgb, (drawn > 0.3) | (alpha < 0.01), 40)
    elif cut_out_picture:
        rgb = spread(rgb, inner, 40)
    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    if cut_out_picture:
        Image.fromarray(np.dstack([rgb, alpha * 255]).round().astype(np.uint8)).save(out)
    else:
        Image.fromarray(rgb.round().astype(np.uint8)).save(out)
    outline = ("the redraw's" if own_outline else "the approved picture's") if cut_out_picture else 'none (opaque)'
    result = {'out': out, 'size': [across, high], 'outline': outline, 'tiles': report}
    if cut_out_picture:
        # solid in the approved picture, see-through in the result, per outline pixel (~0.12 on a clean GPT finish)
        edge = (approved > 0.5) & ~cv2.erode((approved > 0.5).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
        result['edge_loss'] = round(float(((approved > 0.98) & (alpha < 0.9)).sum() / max(int(edge.sum()), 1)), 4)
    print(json.dumps(result))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    c = sub.add_parser('cut')
    c.add_argument('picture')
    c.add_argument('work')
    c.add_argument('--mode', choices=['gpt', 'sd'], required=True)
    c.add_argument('--scale', type=float, default=2.0)
    c.add_argument('--face', help='x,y,w,h of the face in the picture (found automatically when left out)')
    c.add_argument('--density', type=float, default=0.8, help='gpt: least redraw pixels per output pixel')
    c.add_argument('--denoise', type=float, default=0.25, help='sd: denoise of the grid tiles')
    c.add_argument('--face-denoise', type=float, default=0.2, help='sd: denoise of the face tile (higher changes the eyes)')
    f = sub.add_parser('face', help='print the largest anime face as {"face": [x, y, w, h]} (or null)')
    f.add_argument('picture')
    f.add_argument('--min-weight', type=float, default=1.8, help='least detector confidence (real faces measured 2.5-4.3)')
    j = sub.add_parser('join')
    j.add_argument('picture')
    j.add_argument('work')
    j.add_argument('out')
    args = p.parse_args()
    if args.command == 'face':
        print(json.dumps({'face': detect_face(load(args.picture)[0], args.min_weight)}))
    else:
        cut(args) if args.command == 'cut' else join(args)


if __name__ == '__main__':
    main()
