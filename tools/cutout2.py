"""cutout2.py <in_dir> <out_dir> [model] [--face-box x,y,w,h]  — background removal for sprites on a flat background.

Sprites are rendered on a flat, near-white background, so the background colour B is KNOWN. That lets us fix
the two defects isnet-anime + alpha matting left (reported by the owner on the first character):
  * white "pockets": background enclosed by hair / hand / wing that the segmenter kept as opaque;
  * halos: semi-transparent edge pixels still carrying the white background, which show as a light or grey
    rim on dark scenes.

Steps per image:
 1. alpha from a segmenter (default BiRefNet-general; 'isnet-anime' also works), no alpha matting;
 2. pockets: background-coloured blobs inside the figure whose surrounding ring is mostly dark (line art,
    hair, wing, tail), or partly dark and touching the outside but not ringed by skin -> transparent.
    Skin highlights are bordered by skin and are kept;
 3. alpha in a thin band at every edge is solved from the known background: with F = the figure colour
    beside the pixel, a = <C-B, F-B> / |F-B|^2 (a plain distance key where F is too close to B), so
    anti-aliased grey edge pixels become a dark edge at partial alpha instead of a light rim;
 4. alpha < 0.15 -> 0, alpha > 0.94 -> 1;
 5. edge colour: semi-transparent pixels take the figure colour beside them (no background left in them).
"""
import sys, pathlib, time
from rembg import new_session, remove
import numpy as np
from PIL import Image



def background_colour(src):
    border = np.concatenate([src[:12].reshape(-1, 3), src[-12:].reshape(-1, 3), src[:, :12].reshape(-1, 3), src[:, -12:].reshape(-1, 3)])
    return np.median(border, 0)


def clean(src_rgb, alpha, face_box=None):
    from scipy import ndimage
    src = src_rgb.astype(np.float32)
    seg = alpha.astype(np.float32) / 255.0
    B = background_colour(src)
    diff = np.abs(src - B).max(-1)                      # distance from the background colour
    luma = src.mean(-1)
    inside = seg > 0.5

    # 1. pockets: background-coloured blobs the segmenter kept. A real pocket is bordered by line art or
    #    dark parts (hair, wing, tail, outline); a skin highlight is bordered by more skin, so the share of
    #    dark pixels in the ring around the blob tells them apart.
    cand = inside & (diff <= 9)
    lab, n = ndimage.label(cand)
    pockets = np.zeros_like(inside)
    removed = 0
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        if sl is None:
            continue
        ys, xs = sl
        y0, y1, x0, x1 = max(ys.start - 4, 0), ys.stop + 4, max(xs.start - 4, 0), xs.stop + 4
        comp = lab[y0:y1, x0:x1] == i
        if comp.sum() < 12:
            continue
        if face_box is not None:
            fx, fy, fw, fh = face_box
            if xs.start < fx + fw * 1.15 and xs.stop > fx - fw * 0.15 and ys.start < fy + fh * 1.1 and ys.stop > fy - fh * 0.1:
                continue                                 # never touch the face (eye whites, teeth, shine)
        ring = ndimage.binary_dilation(comp, iterations=3) & ~comp & inside[y0:y1, x0:x1]   # figure pixels only
        if not ring.any():
            continue
        rpx = src[y0:y1, x0:x1][ring]
        dark_share = (rpx.mean(-1) < 150).mean()
        skin_share = ((rpx[:, 0] > 200) & (rpx[:, 1] > 160) & (rpx[:, 2] > 140) & (rpx[:, 0] - rpx[:, 2] > 12)).mean()
        touches_outside = (ndimage.binary_dilation(comp, iterations=5) & ~inside[y0:y1, x0:x1]).any()
        thick = comp.sum() >= 25 and ndimage.binary_erosion(comp, iterations=1).any()
        # thick blobs: dark-ringed, or touching the outside; thin slivers (1-2 px, e.g. between a horn and
        # the hair) only when they are dark on (almost) every side
        is_pocket = (thick and (dark_share >= 0.35 or (touches_outside and dark_share >= 0.15 and skin_share <= 0.6))) \
            or (not thick and dark_share >= 0.55)
        if not is_pocket:
            continue                                     # bordered by skin: a highlight, keep it
        pockets[y0:y1, x0:x1] |= comp
        removed += 1
    inside &= ~pockets

    # 2. alpha: hard inside / outside, keyed against the known background in a thin band at every edge
    #    (outer outline and pocket rims). Line art differs strongly from the near-white background, so the
    #    edge stays crisp and background-coloured fringe pixels drop to 0.
    band = ndimage.binary_dilation(inside, iterations=3) & ~ndimage.binary_erosion(inside, iterations=2)
    # The segmenter often runs 3-6 px past the line art into the background (a white rim along the top of
    # the hair). Background-coloured pixels that deep, unless they sit on skin (a shine near the outline),
    # join the band so they get solved too.
    skin = (src[..., 0] > 200) & (src[..., 1] > 160) & (src[..., 2] > 140) & (src[..., 0] - src[..., 2] > 12) & (diff > 9)
    near_skin = ndimage.uniform_filter(skin.astype(np.float32), 15) > 0.08   # a shine sits next to skin
    deep_rim = inside & ~ndimage.binary_erosion(inside, iterations=7) & (diff <= 12) & ~near_skin
    band |= deep_rim
    core = inside & ~band
    # foreground colour next to each edge pixel: average of the solid figure pixels around it
    w = ndimage.uniform_filter(core.astype(np.float32), 9)
    F = np.stack([ndimage.uniform_filter(src[..., c] * core, 9) for c in range(3)], -1) / np.maximum(w, 1e-4)[..., None]
    has_f = w > 0.02
    # a pixel C = a*F + (1-a)*B  ->  a = <C-B, F-B> / |F-B|^2  (projection on the background->figure line)
    FB = F - B
    num = ((src - B) * FB).sum(-1)
    den = (FB ** 2).sum(-1)
    a_proj = np.clip(num / np.maximum(den, 1.0), 0, 1)
    # thin strands (hair) have no solid core nearby: take the darkest colour around them as the strand colour
    Fd = np.stack([ndimage.minimum_filter(src[..., c], 5) for c in range(3)], -1)
    FBd = Fd - B
    den_d = (FBd ** 2).sum(-1)
    a_thin = np.clip(((src - B) * FBd).sum(-1) / np.maximum(den_d, 1.0), 0, 1)
    a_key = np.clip(diff / 48.0, 0, 1)
    a = inside.astype(np.float32)
    use_proj = band & has_f & (den > 900)            # figure colour clearly different from the background
    use_thin = band & ~use_proj & (den_d > 900)
    a[use_proj] = a_proj[use_proj]
    a[use_thin] = a_thin[use_thin]
    F[use_thin] = Fd[use_thin]
    has_f = has_f | use_thin
    rest_band = band & ~use_proj & ~use_thin
    a[rest_band] = a_key[rest_band]                  # pale figure next to the background: plain key
    a[band & ~ndimage.binary_dilation(seg > 0.02, iterations=3)] = 0

    # 3. tidy alpha: faint edge pixels are background noise, near-solid ones are solid, and tiny fragments
    #    floating free of the figure (stray hair-edge specks) are dropped
    a[a < 0.15] = 0
    a[a > 0.94] = 1
    lab2, n2 = ndimage.label(a > 0)
    if n2 > 1:
        sizes = ndimage.sum(np.ones_like(a), lab2, range(1, n2 + 1))
        small = np.isin(lab2, np.where(sizes < 60)[0] + 1)
        a[small] = 0

    # 4. decontaminate partially transparent pixels. Next to solid figure pixels, take the figure colour
    #    beside them (stable); elsewhere invert the composite. Inverting near-background pixels alone
    #    amplifies noise into white wisps, which is why it is only the fallback.
    semi = (a > 0) & (a < 1)
    out = src.copy()
    near = semi & has_f
    out[near] = F[near]
    rest = semi & ~has_f
    aa = np.maximum(a[rest], 1e-3)[:, None]
    out[rest] = np.clip((src[rest] - (1 - aa) * B) / aa, 0, 255)
    rgba = np.dstack([out, a * 255]).round().clip(0, 255).astype(np.uint8)
    return Image.fromarray(rgba, 'RGBA'), removed


def main():
    args = [a for a in sys.argv[1:]]
    face_box = None
    if '--face-box' in args:
        i = args.index('--face-box')
        face_box = tuple(int(v) for v in args[i + 1].split(','))   # x, y, w, h: never touched (eye whites, teeth)
        del args[i:i + 2]
    src_dir, dst = pathlib.Path(args[0]), pathlib.Path(args[1])
    model = args[2] if len(args) > 2 else 'birefnet-general'
    dst.mkdir(parents=True, exist_ok=True)
    # CPU only: on macOS the CoreML provider of onnxruntime can hang forever while creating the session.
    sess = new_session(model, providers=['CPUExecutionProvider'])
    t0 = time.time()
    for p in sorted(src_dir.glob('*.png')):
        im = Image.open(p).convert('RGB')
        mask = remove(im, session=sess, only_mask=True)
        out, pockets = clean(np.array(im), np.array(mask), face_box)
        out.save(dst / p.name, optimize=True)
        print(f'{p.name:22s} pockets={pockets}', flush=True)
    print(f'done in {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
