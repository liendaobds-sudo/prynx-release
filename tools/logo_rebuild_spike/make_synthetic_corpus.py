"""Sinh corpus synthetic có ground truth CHÍNH XÁC cho spike vector hóa logo.

Vì sao cần corpus synthetic dù đã có ảnh thật: ảnh chụp áo không kèm file vector
gốc thì không có ground truth, nên chỉ đo được "SVG render lại giống ảnh đầu vào
đến đâu" — chỉ số đó vẫn cao khi engine bịa sai nét chữ. Ở đây ta đi ngược:

    SVG gốc (biết chính xác)
      → raster sạch                     ← đây là GROUND TRUTH để so
      → warp phối cảnh (ma trận biết trước)
      → trường sáng không đều
      → texture vải / nhăn nhẹ
      → nhòe + giảm phân giải + JPEG
      → ảnh đầu vào của corpus

Nhờ vậy đo được cả sai số hiệu chỉnh bốn góc, boundary F-score và ΔE00 thật.

Ảnh sinh ra đi vào `private_test_corpus/logo_rebuild/` (đã nằm trong .gitignore).
Chỉ script này và lược đồ metadata vào git — corpus tái sinh được bất cứ lúc nào,
và cùng seed cho cùng byte đầu ra.

Chạy:

    backend\\venv\\Scripts\\python.exe tools\\logo_rebuild_spike\\make_synthetic_corpus.py
    ... make_synthetic_corpus.py --out <thu_muc> --seed 20260729
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))

from corpus_spec import CorpusCase, to_json, summarize  # noqa: E402
from svg_raster import render_svg_to_png  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "private_test_corpus" / "logo_rebuild" / "synthetic"
DEFAULT_SEED = 20260729
GT_PX = 1400                 # cạnh dài bản raster ground truth
CANVAS = (2000, 1500)        # khung ảnh "chụp áo" (rộng, cao)

# Bảng màu logo thực tế ngành in: đủ tương phản, không phải màu random.
PALETTE_12 = [
    "#1b365d", "#e03a3e", "#f5a623", "#2e7d32", "#7b1fa2", "#00838f",
    "#c2185b", "#5d4037", "#455a64", "#fbc02d", "#0288d1", "#689f38",
]
FABRIC_COLORS = [(238, 238, 236), (44, 48, 54), (188, 196, 205), (222, 210, 190)]


# ── Sinh logo ground truth ───────────────────────────────────────────────────

def _svg(body: str, w: int = 1000, h: int = 1000) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w / 10:.1f}mm" '
        f'height="{h / 10:.1f}mm" viewBox="0 0 {w} {h}">{body}</svg>'
    )


def _rect(x, y, w, h, color) -> str:
    return (f'<path d="M {x} {y} L {x + w} {y} L {x + w} {y + h} L {x} {y + h} Z" '
            f'fill="{color}"/>')


def _ring(cx, cy, r_out, r_in, color) -> str:
    """Vành khuyên: biên ngoài thuận chiều, biên trong ngược chiều (nonzero)."""
    k = 0.5522847498307936

    def circle(r: float, reverse: bool) -> str:
        pts = [
            (cx + r, cy), (cx + r, cy + r * k), (cx + r * k, cy + r), (cx, cy + r),
            (cx - r * k, cy + r), (cx - r, cy + r * k), (cx - r, cy),
            (cx - r, cy - r * k), (cx - r * k, cy - r), (cx, cy - r),
            (cx + r * k, cy - r), (cx + r, cy - r * k), (cx + r, cy),
        ]
        if reverse:
            pts = pts[::-1]
        d = [f"M {pts[0][0]:.3f} {pts[0][1]:.3f}"]
        for i in range(1, 13, 3):
            c1, c2, p = pts[i], pts[i + 1], pts[i + 2]
            d.append(f"C {c1[0]:.3f} {c1[1]:.3f} {c2[0]:.3f} {c2[1]:.3f} "
                     f"{p[0]:.3f} {p[1]:.3f}")
        return " ".join(d) + " Z"

    return f'<path d="{circle(r_out, False)} {circle(r_in, True)}" fill="{color}"/>'


def _poly(points, color) -> str:
    d = " ".join(f"{'M' if i == 0 else 'L'} {x} {y}" for i, (x, y) in enumerate(points))
    return f'<path d="{d} Z" fill="{color}"/>'


def _star(cx, cy, r_out, r_in, n, color) -> str:
    pts = []
    for i in range(n * 2):
        r = r_out if i % 2 == 0 else r_in
        a = -math.pi / 2 + i * math.pi / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return _poly([(round(x, 2), round(y, 2)) for x, y in pts], color)


def logo_flat(n_colors: int, include_background: bool = True) -> str:
    """Logo phẳng n màu, hình học rõ ràng — nhóm dễ nhất, ngưỡng đạt cao nhất.

    `include_background=False` tạo artwork có nền trong suốt để ca alpha thật sự
    kiểm được bảo toàn alpha, thay vì chỉ đổi đuôi file sang PNG.
    """
    colors = PALETTE_12[:n_colors]
    body = ([_rect(0, 0, 1000, 1000, colors[0])] if include_background else
            [_rect(160, 160, 240, 240, colors[0])])
    if n_colors >= 2:
        body.append(_ring(500, 420, 260, 150, colors[1 % n_colors]))
    if n_colors >= 3:
        body.append(_poly([(240, 760), (760, 760), (500, 940)], colors[2]))
    if n_colors >= 4:
        body.append(_rect(120, 120, 160, 160, colors[3]))
    # Các màu còn lại xếp thành dải — kiểm khả năng giữ đúng số màu.
    for i in range(4, n_colors):
        x = 120 + (i - 4) * 95
        body.append(_rect(x, 1000 - 130, 80, 80, colors[i]))
    return _svg("".join(body))


def logo_bw() -> str:
    """Dấu đơn sắc: vành khuyên + sao + thanh. Kiểm nhánh nhị phân."""
    body = [
        _rect(0, 0, 1000, 1000, "#ffffff"),
        _ring(500, 500, 380, 300, "#000000"),
        _star(500, 500, 250, 105, 5, "#000000"),
        _rect(180, 860, 640, 46, "#000000"),
    ]
    return _svg("".join(body))


def logo_line_art() -> str:
    """Nét mảnh: các vành khuyên rất mỏng + thanh 6px.

    Nhóm này bắt được lỗi despeckle ăn mất nét: nét 6/1000 khung, nếu engine coi
    là nhiễu thì logo mất hẳn chi tiết chứ không chỉ méo.
    """
    body = [_rect(0, 0, 1000, 1000, "#ffffff")]
    for r in (400, 330, 260):
        body.append(_ring(500, 500, r, r - 7, "#12355b"))
    for i in range(9):
        body.append(_rect(180 + i * 72, 640, 6, 220, "#12355b"))
    body.append(_poly([(300, 200), (700, 200), (700, 206), (300, 206)], "#12355b"))
    return _svg("".join(body))


def logo_holdout_flat3() -> str:
    """Hình học holdout 3 màu, không dùng trong vòng chọn preset."""
    body = [
        _rect(0, 0, 1000, 1000, "#ffffff"),
        _poly([(120, 720), (500, 120), (880, 720), (500, 900)], PALETTE_12[0]),
        _ring(500, 520, 190, 115, PALETTE_12[1]),
    ]
    return _svg("".join(body))


def logo_holdout_flat6() -> str:
    """Hình học holdout 6 màu: bố cục lệch tâm và không lặp logo_flat."""
    body = [_rect(0, 0, 1000, 1000, "#ffffff")]
    body.extend([
        _poly([(90, 160), (420, 90), (350, 430), (120, 500)], PALETTE_12[0]),
        _poly([(510, 110), (900, 210), (760, 470), (480, 390)], PALETTE_12[1]),
        _rect(110, 610, 230, 240, PALETTE_12[2]),
        _ring(560, 690, 170, 90, PALETTE_12[3]),
        _star(820, 720, 125, 55, 6, PALETTE_12[4]),
    ])
    return _svg("".join(body))


def logo_holdout_bw() -> str:
    body = [
        _rect(0, 0, 1000, 1000, "#ffffff"),
        _poly([(500, 90), (850, 230), (780, 710), (500, 920),
               (220, 710), (150, 230)], "#000000"),
        _star(500, 485, 210, 92, 8, "#ffffff"),
    ]
    return _svg("".join(body))


def logo_holdout_lineart() -> str:
    body = [_rect(0, 0, 1000, 1000, "#ffffff")]
    for i in range(7):
        body.append(_ring(500, 500, 410 - i * 48, 404 - i * 48, "#12355b"))
    for y in (210, 790):
        body.append(_rect(230, y, 540, 7, "#12355b"))
    return _svg("".join(body))


# ── Chữ: outline thật từ font hệ thống ───────────────────────────────────────

_FONT_CANDIDATES = {
    "sans": ["segoeui.ttf", "arial.ttf", "tahoma.ttf", "calibri.ttf"],
    "serif": ["times.ttf", "georgia.ttf", "constan.ttf"],
    "bold": ["arialbd.ttf", "segoeuib.ttf", "calibrib.ttf"],
}


def _find_font(kind: str) -> Path | None:
    root = Path(r"C:\Windows\Fonts")
    for name in _FONT_CANDIDATES[kind]:
        p = root / name
        if p.is_file():
            return p
    return None


def text_to_paths(text: str, font_path: Path, font_size: float,
                  origin_x: float, baseline_y: float, color: str) -> tuple[str, float]:
    """Chuyển chuỗi thành path SVG tuyệt đối bằng outline THẬT của font.

    Không dùng font đoán, không vẽ chữ bằng hình khối: ground truth phải là đúng
    outline chữ để đo được engine có làm méo nét hay không. Trả (svg, chiều rộng).

    Phép biến đổi áp ở tầng pen (`TransformPen`) chứ không parse lại chuỗi `d`:
    `SVGPathPen` LƯỢC BỎ chữ lệnh khi lặp (emit `L 1 2 3 4` thay vì `L 1 2 L 3 4`),
    nên mọi bộ parse chuỗi tự viết đều sẽ vỡ ở đó.
    """
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont

    font = TTFont(str(font_path), fontNumber=0, lazy=True)
    try:
        upem = font["head"].unitsPerEm
        scale = font_size / upem
        cmap = font.getBestCmap()
        glyph_set = font.getGlyphSet()
        hmtx = font["hmtx"]

        parts: list[str] = []
        pen_x = 0.0
        for ch in text:
            glyph_name = cmap.get(ord(ch))
            if glyph_name is None:
                # Thiếu glyph: bỏ qua nhưng PHẢI nói ra. Vẽ ô vuông tofu rồi coi đó
                # là ground truth thì mọi số đo sau đều vô nghĩa.
                print(f"    [cảnh báo] font thiếu glyph cho {ch!r} (U+{ord(ch):04X})")
                pen_x += upem * 0.5
                continue
            svg_pen = SVGPathPen(glyph_set, ntos=lambda v: f"{v:.3f}")
            # Font y hướng lên, gốc tại baseline; SVG y hướng xuống ⇒ yy = -scale.
            transform = (scale, 0, 0, -scale, origin_x + pen_x * scale, baseline_y)
            glyph_set[glyph_name].draw(TransformPen(svg_pen, transform))
            d = svg_pen.getCommands()
            if d:
                parts.append(f'<path d="{d}" fill="{color}"/>')
            pen_x += hmtx[glyph_name][0]

        return "".join(parts), pen_x * scale
    finally:
        font.close()


def _text_width(text: str, font_path: Path, font_size: float) -> float:
    """Bề rộng chuỗi (không dựng path) để căn giữa trước khi vẽ."""
    from fontTools.ttLib import TTFont

    font = TTFont(str(font_path), fontNumber=0, lazy=True)
    try:
        upem = font["head"].unitsPerEm
        cmap = font.getBestCmap()
        hmtx = font["hmtx"]
        total = 0.0
        for ch in text:
            name = cmap.get(ord(ch))
            total += hmtx[name][0] if name else upem * 0.5
        return total * font_size / upem
    finally:
        font.close()


def logo_text(text: str, kind: str, font_size: float, second_line: str = "") -> str | None:
    """Logo chữ. Dùng chữ Việt có dấu để kiểm dấu mũ/dấu thanh không bị ăn mất."""
    font = _find_font(kind)
    if font is None:
        print(f"    [bỏ qua] không tìm thấy font {kind} trong C:\\Windows\\Fonts")
        return None
    body = [_rect(0, 0, 1000, 1000, "#ffffff")]
    width = _text_width(text, font, font_size)
    baseline = 520 if second_line else 560
    body.append(text_to_paths(text, font, font_size, (1000 - width) / 2,
                              baseline, "#0f2e57")[0])
    if second_line:
        small = font_size * 0.42
        w2 = _text_width(second_line, font, small)
        body.append(text_to_paths(second_line, font, small, (1000 - w2) / 2,
                                  680, "#c0392b")[0])
    return _svg("".join(body))


# ── Làm suy giảm ảnh ─────────────────────────────────────────────────────────

def _quad_for(kind: str, w: int, h: int, rng: random.Random) -> np.ndarray:
    """Bốn góc đích của logo trên khung ảnh. Trả float32 (4,2) theo TL,TR,BR,BL."""
    cx, cy = w * 0.5, h * 0.48
    size = min(w, h) * 0.46
    base = np.array([
        [cx - size, cy - size], [cx + size, cy - size],
        [cx + size, cy + size], [cx - size, cy + size],
    ], dtype=np.float32)
    if kind == "none":
        return base
    amp = {"mild": 0.06, "strong": 0.18}[kind]
    jitter = np.array([
        [rng.uniform(0, amp), rng.uniform(0, amp)],
        [rng.uniform(-amp, 0), rng.uniform(0, amp)],
        [rng.uniform(-amp, 0), rng.uniform(-amp, 0)],
        [rng.uniform(0, amp), rng.uniform(-amp, 0)],
    ], dtype=np.float32) * size * 2
    return base + jitter


def _place_logo(logo_rgba: np.ndarray, quad: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Warp logo (RGBA) theo phối cảnh rồi ghép lên nền."""
    lh, lw = logo_rgba.shape[:2]
    src = np.array([[0, 0], [lw, 0], [lw, lh], [0, lh]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(src, quad)
    h, w = bg.shape[:2]
    warped = cv2.warpPerspective(
        logo_rgba, m, (w, h), flags=cv2.INTER_AREA,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0),
    )
    alpha = (warped[..., 3:4].astype(np.float32) / 255.0)
    return (warped[..., :3].astype(np.float32) * alpha
            + bg.astype(np.float32) * (1 - alpha)).astype(np.uint8)


def _fabric(shape: tuple[int, int], color: tuple[int, int, int],
            rng: np.random.Generator, strength: float) -> np.ndarray:
    """Nền vải dệt: lưới sin hai chiều + nhiễu hạt."""
    h, w = shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    weave = (np.sin(xx * 0.9) + np.sin(yy * 0.9)) * 0.5
    grain = rng.normal(0.0, 1.0, size=(h, w)).astype(np.float32)
    grain = cv2.GaussianBlur(grain, (0, 0), 0.7)
    field = (weave * 0.6 + grain * 0.8) * strength
    base = np.zeros((h, w, 3), dtype=np.float32)
    base[..., :] = color
    return np.clip(base + field[..., None] * 255.0 / 8.0, 0, 255).astype(np.uint8)


def _illumination(img: np.ndarray, rng: random.Random, strength: float) -> np.ndarray:
    """Trường sáng tần số thấp: mô phỏng đèn lệch một phía + bóng mềm."""
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    ax, ay = rng.uniform(-1, 1), rng.uniform(-1, 1)
    ramp = (xx / w - 0.5) * ax + (yy / h - 0.5) * ay
    blob_x, blob_y = rng.uniform(0.2, 0.8) * w, rng.uniform(0.2, 0.8) * h
    r = np.sqrt((xx - blob_x) ** 2 + (yy - blob_y) ** 2) / (0.5 * max(w, h))
    blob = np.exp(-r * r * 1.6)
    field = 1.0 + (ramp * 1.6 + (blob - 0.4) * 1.2) * strength
    return np.clip(img.astype(np.float32) * field[..., None], 0, 255).astype(np.uint8)


def _wrinkle(img: np.ndarray, rng: random.Random, amp_px: float) -> np.ndarray:
    """Nhăn nhẹ: remap phi tuyến biên độ nhỏ. Nhăn MẠNH ngoài phạm vi bản này."""
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    fx = rng.uniform(1.5, 3.0)
    fy = rng.uniform(1.5, 3.0)
    ph = rng.uniform(0, math.tau)
    dx = np.sin(yy / h * math.tau * fy + ph) * amp_px
    dy = np.sin(xx / w * math.tau * fx + ph) * amp_px * 0.6
    return cv2.remap(img, (xx + dx).astype(np.float32), (yy + dy).astype(np.float32),
                     interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def _jpeg(img: np.ndarray, quality: int) -> np.ndarray:
    ok, buf = cv2.imencode(".jpg", img[..., ::-1], [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("Không nén được JPEG")
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)[..., ::-1]


# ── Hồ sơ suy giảm ───────────────────────────────────────────────────────────

PROFILES: dict[str, dict] = {
    "clean":            dict(persp="none",   fabric=0.0, light=0.0, wrinkle=0.0, blur=0.0, scale=1.0,  jpeg=0),
    "persp_mild":       dict(persp="mild",   fabric=0.0, light=0.0, wrinkle=0.0, blur=0.6, scale=1.0,  jpeg=95),
    "persp_strong":     dict(persp="strong", fabric=0.0, light=0.0, wrinkle=0.0, blur=0.6, scale=1.0,  jpeg=95),
    "fabric_light":     dict(persp="mild",   fabric=1.0, light=0.10, wrinkle=0.0, blur=0.8, scale=0.8, jpeg=90),
    "fabric_uneven":    dict(persp="mild",   fabric=1.4, light=0.34, wrinkle=0.0, blur=1.0, scale=0.8, jpeg=85),
    "wrinkle_light":    dict(persp="mild",   fabric=1.0, light=0.20, wrinkle=3.0, blur=1.0, scale=0.8, jpeg=88),
    "lowres_jpeg":      dict(persp="mild",   fabric=1.0, light=0.18, wrinkle=0.0, blur=1.4, scale=0.33, jpeg=62),
    "alpha":            dict(persp="none",   fabric=None, light=0.0, wrinkle=0.0, blur=0.0, scale=1.0, jpeg=0),
}


def degrade(logo_rgba: np.ndarray, profile: str, rng: random.Random,
            nrng: np.random.Generator) -> tuple[Image.Image, list[tuple[float, float]] | None, list[str]]:
    """Áp hồ sơ suy giảm. Trả (ảnh, bốn góc chuẩn hoá, danh sách phép đã áp)."""
    cfg = PROFILES[profile]
    applied: list[str] = []

    if cfg["fabric"] is None:
        # Giữ nền trong suốt: chỉ đổi kích thước, không ghép nền.
        img = Image.fromarray(logo_rgba, "RGBA")
        return img, [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)], ["alpha"]

    w, h = CANVAS
    fabric_color = FABRIC_COLORS[rng.randrange(len(FABRIC_COLORS))]
    if cfg["fabric"] > 0:
        bg = _fabric((h, w), fabric_color, nrng, cfg["fabric"])
        applied.append("fabric")
    else:
        bg = np.zeros((h, w, 3), dtype=np.uint8)
        bg[..., :] = fabric_color

    quad = _quad_for(cfg["persp"], w, h, rng)
    if cfg["persp"] != "none":
        applied.append("perspective")
    img = _place_logo(logo_rgba, quad, bg)

    if cfg["light"] > 0:
        img = _illumination(img, rng, cfg["light"])
        applied.append("illumination")
    if cfg["wrinkle"] > 0:
        img = _wrinkle(img, rng, cfg["wrinkle"])
        applied.append("wrinkle")
    if cfg["blur"] > 0:
        img = cv2.GaussianBlur(img, (0, 0), cfg["blur"])
        applied.append("blur")
    if cfg["scale"] != 1.0:
        nh, nw = int(h * cfg["scale"]), int(w * cfg["scale"])
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
        quad = quad * cfg["scale"]
        applied.append("downscale")
        w, h = nw, nh
    if cfg["jpeg"]:
        img = _jpeg(img, cfg["jpeg"])
        applied.append("jpeg")

    quad_norm = [(float(x / w), float(y / h)) for x, y in quad]
    return Image.fromarray(img, "RGB"), quad_norm, applied


# ── Ca "không nên vector hóa" ────────────────────────────────────────────────

def gradient_photo(nrng: np.random.Generator) -> Image.Image:
    """Ảnh chuyển sắc mượt nhiều nghìn màu — phải bị PHÁT HIỆN và từ chối."""
    h, w = 900, 900
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = 128 + 110 * np.sin(xx / w * 3.1)
    g = 128 + 110 * np.sin(yy / h * 2.3 + 1.0)
    b = 128 + 110 * np.sin((xx + yy) / (w + h) * 5.0 + 2.0)
    img = np.stack([r, g, b], axis=-1)
    img += nrng.normal(0, 3.0, img.shape)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


def embroidery_like(nrng: np.random.Generator, rng: random.Random) -> Image.Image:
    """Mô phỏng thêu: nét bị cắt thành sợi rời — ngoài phạm vi, phải cảnh báo."""
    base = np.asarray(render_svg_to_png(logo_bw(), 700).convert("RGB")).copy()
    h, w = base.shape[:2]
    for _ in range(2600):
        x, y = rng.randrange(w), rng.randrange(h)
        ln = rng.randrange(4, 11)
        ang = rng.uniform(0, math.pi)
        x2 = int(x + ln * math.cos(ang))
        y2 = int(y + ln * math.sin(ang))
        col = tuple(int(c) for c in nrng.integers(90, 220, 3))
        cv2.line(base, (x, y), (x2, y2), col, 1, cv2.LINE_AA)
    base = cv2.GaussianBlur(base, (0, 0), 0.9)
    return Image.fromarray(base, "RGB")


def occluded(nrng: np.random.Generator, rng: random.Random) -> Image.Image:
    """Logo bị che mất phần lớn hình học — phải từ chối, không được 'đoán nốt'."""
    base = np.asarray(render_svg_to_png(logo_flat(4), 800).convert("RGB")).copy()
    h, w = base.shape[:2]
    cv2.rectangle(base, (0, int(h * 0.42)), (w, int(h * 0.95)),
                  (235, 235, 232), thickness=-1)
    for _ in range(400):
        x, y = rng.randrange(w), rng.randrange(int(h * 0.42), h)
        cv2.circle(base, (x, y), rng.randrange(1, 4),
                   tuple(int(c) for c in nrng.integers(200, 245, 3)), -1)
    return Image.fromarray(base, "RGB")


# ── Xây corpus ───────────────────────────────────────────────────────────────

def build(out_dir: Path, seed: int) -> list[CorpusCase]:
    rng = random.Random(seed)
    nrng = np.random.default_rng(seed)
    img_dir = out_dir / "images"
    gt_dir = out_dir / "ground_truth"
    img_dir.mkdir(parents=True, exist_ok=True)
    gt_dir.mkdir(parents=True, exist_ok=True)

    # (tên, hàm sinh SVG, loại, số màu kỳ vọng, các hồ sơ suy giảm)
    train_designs: list[tuple[str, object, str, int | None, list[str]]] = [
        ("flat2", lambda: logo_flat(2), "flat_1_4", 2,
         ["clean", "persp_mild", "fabric_light", "alpha"]),
        ("flat4", lambda: logo_flat(4), "flat_1_4", 4,
         ["clean", "persp_strong", "fabric_uneven", "wrinkle_light"]),
        ("flat8", lambda: logo_flat(8), "flat_5_12", 8,
         ["clean", "persp_mild", "fabric_light", "lowres_jpeg"]),
        ("flat12", lambda: logo_flat(12), "flat_5_12", 12,
         ["clean", "fabric_uneven", "wrinkle_light"]),
        ("bw", logo_bw, "bw", 2,
         ["clean", "persp_mild", "fabric_uneven"]),
        ("lineart", logo_line_art, "line_art", 2,
         ["clean", "fabric_light", "lowres_jpeg"]),
        # 3 màu: nền trắng + navy dòng chính + đỏ dòng phụ.
        ("text_vn_lg", lambda: logo_text("HỘP GIẤY ĐỨC THẮNG", "bold", 96,
                                         "BAO BÌ CAO CẤP"), "text", 3,
         ["clean", "persp_mild", "fabric_uneven"]),
        ("text_vn_sm", lambda: logo_text("CÔNG TY TNHH IN ẤN PHƯƠNG NAM", "sans", 44),
         "text", 2, ["clean", "fabric_light", "lowres_jpeg"]),
        ("text_serif", lambda: logo_text("PRYNX Đặc Biệt", "serif", 104), "text", 2,
         ["clean", "wrinkle_light"]),
    ]
    holdout_designs: list[tuple[str, object, str, int | None, list[str]]] = [
        ("hold_flat3", logo_holdout_flat3, "flat_1_4", 3, ["clean", "fabric_light"]),
        ("hold_flat6", logo_holdout_flat6, "flat_5_12", 6, ["clean", "fabric_light"]),
        ("hold_bw", logo_holdout_bw, "bw", 2, ["clean", "fabric_light"]),
        ("hold_lineart", logo_holdout_lineart, "line_art", 2, ["clean", "fabric_light"]),
        ("hold_text", lambda: logo_text("IN BAO BÌ VIỆT", "bold", 82,
                                         "MÀU SẮC BỀN ĐẸP"), "text", 3,
         ["clean", "fabric_light"]),
    ]
    designs = ([(*design, "train") for design in train_designs] +
               [(*design, "holdout") for design in holdout_designs])

    cases: list[CorpusCase] = []
    for name, make_svg, logo_type, n_colors, profiles, split in designs:
        base_svg = make_svg()
        if base_svg is None:
            continue
        gt_svg_rel = f"ground_truth/{name}.svg"
        gt_png_rel = f"ground_truth/{name}.png"
        (out_dir / gt_svg_rel).write_text(base_svg, encoding="utf-8")
        gt_img = render_svg_to_png(base_svg, GT_PX, transparent=True)
        gt_img.save(out_dir / gt_png_rel)
        # logo_rgba được chọn theo từng profile bên dưới.

        for profile in profiles:
            case_id = f"{name}__{profile}"
            # Chỉ ca flat2__alpha dùng artwork không có nền. Các profile khác
            # vẫn giữ ground truth cũ để thay đổi này không làm lệch baseline
            # của các phép suy giảm nền vải.
            if profile == "alpha" and name == "flat2":
                svg = logo_flat(n_colors, include_background=False)
                gt_svg_rel_case = f"ground_truth/{name}__alpha.svg"
                gt_png_rel_case = f"ground_truth/{name}__alpha.png"
                (out_dir / gt_svg_rel_case).write_text(svg, encoding="utf-8")
                gt_img_case = render_svg_to_png(svg, GT_PX, transparent=True)
                gt_img_case.save(out_dir / gt_png_rel_case)
            else:
                gt_svg_rel_case = gt_svg_rel
                gt_png_rel_case = gt_png_rel
                gt_img_case = gt_img
            logo_rgba = np.asarray(gt_img_case)
            img, quad, applied = degrade(logo_rgba, profile, rng, nrng)
            ext = "png" if profile == "alpha" else "jpg"
            rel = f"images/{case_id}.{ext}"
            if ext == "png":
                img.save(out_dir / rel)
            else:
                img.save(out_dir / rel, quality=94, subsampling=0)

            expectation = "pass"
            reason = None
            if profile == "lowres_jpeg" and logo_type in ("text", "line_art"):
                expectation = "review"
                reason = ("chữ/nét mảnh sau khi giảm còn 1/3 độ phân giải và nén JPEG "
                          "62 — phải cảnh báo độ nét không đủ, không im lặng trả kết quả")
            elif profile == "wrinkle_light":
                expectation = "review"
                reason = ("nhăn nhẹ gây biến dạng phi tuyến mà homography không sửa "
                          "được hết — phải cảnh báo")
            elif profile == "fabric_uneven" and logo_type == "line_art":
                expectation = "review"
                reason = "nét mảnh trên texture vải dễ bị despeckle ăn mất"

            cases.append(CorpusCase(
                case_id=case_id,
                image=rel,
                rights="synthetic",
                source="Sinh bằng tools/logo_rebuild_spike/make_synthetic_corpus.py",
                logo_type=logo_type,  # type: ignore[arg-type]
                expectation=expectation,  # type: ignore[arg-type]
                width_px=img.width,
                height_px=img.height,
                split=split,
                expected_colors=n_colors,
                physical_size_mm=(100.0, 100.0),
                ground_truth_svg=gt_svg_rel_case,
                ground_truth_png=gt_png_rel_case,
                quad_normalized=quad,
                degradations=applied,  # type: ignore[arg-type]
                expectation_reason=reason,
                notes=f"hồ sơ suy giảm: {profile}",
            ))

    # Ba ca hard-fail: phải bị phát hiện, không phải phải làm đúng.
    hard: list[tuple[str, Image.Image, str, str]] = [
        ("gradient_photo", gradient_photo(nrng), "photo_gradient",
         "ảnh chuyển sắc mượt hàng nghìn màu — vector hóa sẽ sinh rất nhiều path, "
         "phải phân loại đúng và cảnh báo thay vì trả SVG khổng lồ"),
        ("embroidery", embroidery_like(nrng, rng), "embroidery",
         "hình thêu cần tái dựng cấu trúc sợi — ngoài phạm vi bản này, phải nói rõ"),
        ("occluded", occluded(nrng, rng), "occluded",
         "logo bị che mất hơn nửa hình học — không được tự suy đoán phần thiếu"),
    ]
    for case_id, img, logo_type, reason in hard:
        rel = f"images/{case_id}.png"
        img.save(out_dir / rel)
        cases.append(CorpusCase(
            case_id=case_id,
            image=rel,
            rights="synthetic",
            source="Sinh bằng tools/logo_rebuild_spike/make_synthetic_corpus.py",
            logo_type=logo_type,  # type: ignore[arg-type]
            expectation="reject",
            width_px=img.width,
            height_px=img.height,
            split="reject",
            expectation_reason=reason,
            notes="ca hard-fail: tính vào cột 'phát hiện đúng', không phải cột 'đạt'",
        ))

    return cases


# ── Kiểm chứng corpus + đo baseline ──────────────────────────────────────────

def background_color(img: Image.Image, frame_px: int = 12) -> np.ndarray:
    """Màu nền thiết kế, lấy median viền ngoài ảnh.

    KHÔNG dùng "màu chiếm nhiều diện tích nhất sau lượng tử hoá": phép lượng tử
    làm một vùng màu bị tách thành nhiều bin do nhiễu/resample, khiến vùng hình
    có thể thắng vùng nền và mặt nạ bị ĐẢO. Đã mắc đúng lỗi đó: trần boundary F
    nhảy 0.42–1.00 giữa các ca đáng ra tương đương. Median viền ổn định vì mọi
    thiết kế trong corpus đều đặt nền ở rìa khung.
    """
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    border = np.concatenate([
        a[:frame_px].reshape(-1, 3), a[-frame_px:].reshape(-1, 3),
        a[:, :frame_px].reshape(-1, 3), a[:, -frame_px:].reshape(-1, 3),
    ])
    return np.median(border, axis=0).astype(np.int16)


def ink_mask(img: Image.Image, bg: np.ndarray, delta: int = 60) -> np.ndarray:
    """Vùng "có mực": pixel lệch khỏi `bg` quá `delta` (tổng lệch 3 kênh).

    Màu nền phải TRUYỀN VÀO chứ không tự suy từng ảnh: hai ảnh đang so nhau nếu
    mỗi bên tự chọn nền khác nhau thì boundary F so hai thứ không cùng nghĩa.
    """
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    return np.abs(a - bg).sum(axis=-1) > delta


def rectify(img: Image.Image, quad_norm: list[tuple[float, float]],
            size: int) -> Image.Image:
    """Dựng lại vùng logo về hình vuông `size` bằng đúng bốn góc đã lưu."""
    source = img if img.mode in ("RGB", "RGBA") else img.convert("RGB")
    a = np.asarray(source)
    h, w = a.shape[:2]
    src = np.array([[x * w, y * h] for x, y in quad_norm], dtype=np.float32)
    dst = np.array([[0, 0], [size, 0], [size, size], [0, size]], dtype=np.float32)
    m = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(a, m, (size, size), flags=cv2.INTER_AREA)
    return Image.fromarray(out, "RGBA" if source.mode == "RGBA" else "RGB")


def verify(out_dir: Path) -> int:
    """Kiểm corpus tự nhất quán và in MỐC NGƯỠNG THÔ theo hồ sơ suy giảm.

    Vì sao cần: nếu dựng lại bằng đúng ma trận đã dùng để làm méo mà vẫn không
    khớp ground truth thì lỗi nằm ở chính bộ sinh corpus, và mọi kết luận GO/NO-GO
    dựa trên nó đều vô giá trị.

    Cách đọc con số — quan trọng, đừng gọi nó là "trần":

    * `clean` là **trần thật**. Ảnh không suy giảm, chỉ đi qua một phép warp đồng
      nhất, nên bF phải = 1.000. Vectorizer tụt dưới mốc này ở nhóm clean là lỗi
      của engine, không có lý do biện hộ.
    * Các hồ sơ còn lại là **mốc ngưỡng thô**: kết quả của việc phân ngưỡng thẳng
      ảnh đã dựng lại, không lọc gì. Hạt vải và nhiễu JPEG bị tính là mực nên mốc
      này bị kéo xuống. Một engine có despeckle CÓ THỂ và NÊN vượt mốc này. Vượt
      là dấu hiệu tốt; tụt sâu dưới mốc nghĩa là engine còn tệ hơn phép ngưỡng.
    """
    from corpus_spec import from_json
    from metrics import boundary_f_score, delta_e_stats, ssim_score

    meta = out_dir / "corpus.json"
    if not meta.is_file():
        print(f"Chưa có {meta} — sinh corpus trước.")
        return 1
    cases = from_json(meta)

    print("Kiểm chứng: dựng lại phối cảnh bằng bốn góc đã lưu, so với ground truth.")
    print("bF = boundary F-score vùng có mực (sai số 0,75% đường chéo).")
    print()
    hdr = f'{"ca":30} {"hồ sơ":16} {"bF":>6} {"SSIM":>6} {"ΔE50":>6} {"ΔE95":>6}'
    print(hdr)
    print("-" * len(hdr))

    by_profile: dict[str, list[tuple[float, float, float]]] = {}
    problems: list[str] = []

    for case in cases:
        if not case.has_ground_truth or case.quad_normalized is None:
            continue
        profile = case.notes.replace("hồ sơ suy giảm: ", "")
        gt = Image.open(out_dir / case.ground_truth_png)  # type: ignore[arg-type]
        img = Image.open(out_dir / case.image)
        size = gt.width
        rect = rectify(img, case.quad_normalized, size)
        # Ghép GT lên nền trắng để so cùng điều kiện với ảnh đã dựng lại.
        bg = Image.new("RGBA", gt.size, (255, 255, 255, 255))
        gt_flat = Image.alpha_composite(bg, gt.convert("RGBA")).convert("RGB")
        rect_flat = Image.alpha_composite(bg, rect.convert("RGBA")).convert("RGB")

        tol = max(1, int(round(math.hypot(size, size) * 0.0075)))
        # Cùng một màu nền tham chiếu (lấy từ ground truth) cho CẢ HAI mặt nạ.
        bg_ref = background_color(gt_flat)
        bf, _, _ = boundary_f_score(
            ink_mask(gt_flat, bg_ref), ink_mask(rect_flat, bg_ref), tol
        )
        ssim = ssim_score(gt_flat, rect_flat)
        de50, de95 = delta_e_stats(gt_flat, rect_flat)
        print(f'{case.case_id:30} {profile:16} {bf:6.3f} {ssim:6.3f} '
              f'{de50:6.2f} {de95:6.2f}')
        by_profile.setdefault(profile, []).append((bf, ssim, de50))
        # Ca 'clean' đi qua đúng một phép warp đồng nhất ⇒ phải gần như trùng khít.
        if profile == "clean" and ssim < 0.95:
            problems.append(
                f"{case.case_id}: hồ sơ 'clean' chỉ đạt SSIM {ssim:.3f} — bộ sinh "
                "corpus hoặc phép dựng lại đang sai, không phải do suy giảm"
            )
        if profile == "clean" and bf < 0.90:
            problems.append(
                f"{case.case_id}: hồ sơ 'clean' chỉ đạt boundary F {bf:.3f} — "
                "đường biên đã lệch trước khi có bất kỳ suy giảm nào"
            )

    print()
    print("MỐC THAM CHIẾU theo hồ sơ suy giảm (trung bình) — dùng để so ở G1.")
    print("  clean = TRẦN THẬT: engine tụt dưới 1.000 ở nhóm này là lỗi engine.")
    print("  còn lại = mốc NGƯỠNG THÔ (không lọc gì). Engine có despeckle nên VƯỢT;")
    print("  tụt sâu dưới mốc nghĩa là engine còn kém hơn phép phân ngưỡng đơn giản.")
    print(f'  {"hồ sơ":16} {"ca":>3} {"bF":>6} {"SSIM":>6} {"ΔE50":>6}')
    for profile in sorted(by_profile):
        vals = by_profile[profile]
        n = len(vals)
        print(f'  {profile:16} {n:3} {sum(v[0] for v in vals) / n:6.3f} '
              f'{sum(v[1] for v in vals) / n:6.3f} {sum(v[2] for v in vals) / n:6.2f}')

    # Số màu trong ground truth phải khớp expected_colors, nếu không thì nhóm
    # "5–12 màu" thực chất không kiểm được điều nó nói là kiểm.
    print()
    print("Số màu trong ground truth so với kỳ vọng:")
    seen: set[str] = set()
    for case in cases:
        if not case.ground_truth_png or case.ground_truth_png in seen:
            continue
        seen.add(case.ground_truth_png)
        gt = Image.open(out_dir / case.ground_truth_png).convert("RGBA")
        a = np.asarray(gt)
        opaque = a[a[..., 3] > 200][:, :3]
        # Lượng tử nhẹ để bỏ viền răng cưa khi đếm màu thiết kế.
        uniq, counts = np.unique((opaque // 24) * 24, axis=0, return_counts=True)
        # Chỉ tính màu chiếm >0,3% diện tích — phần còn lại là pixel biên.
        major = int((counts / counts.sum() > 0.003).sum())
        name = Path(case.ground_truth_png).stem
        flag = ""
        # Lệch theo CẢ HAI chiều đều là vấn đề: ít hơn nghĩa là thiết kế không đủ
        # màu như nhãn, nhiều hơn nghĩa là nhóm "n màu" đang dán nhãn sai.
        if case.expected_colors is not None and major != case.expected_colors:
            flag = f"  <-- LỆCH kỳ vọng {case.expected_colors}"
            problems.append(f"{name}: đếm {major} màu chính, kỳ vọng {case.expected_colors}")
        print(f'  {name:14} {major:3} màu chính (kỳ vọng {case.expected_colors}){flag}')

    print()
    if problems:
        print(f"CORPUS CÓ VẤN ĐỀ — {len(problems)} mục:")
        for p in problems:
            print(f"  - {p}")
        return 1
    print("Corpus tự nhất quán. Số ở bảng trần là mốc để so ở G1.")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Sinh corpus synthetic cho spike logo_rebuild")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--verify", action="store_true",
                    help="chỉ kiểm corpus đã sinh và in trần chất lượng, không sinh lại")
    args = ap.parse_args(argv[1:])

    out_dir = Path(args.out)
    if args.verify:
        return verify(out_dir)
    print(f"Sinh corpus synthetic → {out_dir}")
    print(f"  seed={args.seed} (cùng seed ⇒ cùng kết quả)")
    cases = build(out_dir, args.seed)

    meta = out_dir / "corpus.json"
    to_json(cases, meta, description=(
        "Corpus synthetic cho spike Phục hồi & Vector hóa Logo (G0). Ground truth "
        "là SVG do script sinh nên chính xác tuyệt đối. Ảnh KHÔNG commit vào git."
    ))

    errors: list[str] = []
    for c in cases:
        errors.extend(c.validate(out_dir))
    print()
    print(summarize(cases))
    print()
    if errors:
        print(f"CORPUS KHÔNG HỢP LỆ — {len(errors)} lỗi:")
        for e in errors[:20]:
            print(f"  - {e}")
        return 1
    print(f"Đã ghi {len(cases)} ca + metadata: {meta}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
