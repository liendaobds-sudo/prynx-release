"""Clip mask theo HÌNH DẠNG đường bế (thay cho bbox chữ nhật).

VẤN ĐỀ: `place_one_artwork` clip artwork mỗi ô bằng một RECTANGLE (`out_clip`).
Với tem chữ nhật thì đủ, nhưng tem tròn/oval/đa giác xếp lồng (staggered, hex,
head-to-tail) có bbox CHỒNG NHAU dù bản thân hai đường bế vẫn cách nhau đủ gap
→ phần artwork ngoài đường bế của tem này đè lên tem bên cạnh.

CÁCH GIẢI: dựng đường clip là chính POLYGON đường bế, nở ra `offset_pt` (bù xén
theo hình), rồi giao với rect clip cũ. Vì polygon nở đều ≤ nửa khoảng cách giữa
2 khuôn, hai vùng clip không thể giao nhau ⇒ hết đè.

NGUỒN CHÂN LÝ: toạ độ được biến đổi bằng CHÍNH `die_polylines_for_placement`
(cùng `transform_die_point` mà file khuôn xuất ra dùng) → clip khớp tuyệt đối
với đường bế được vẽ, không thể lệch.

Trả về: list ring, mỗi ring là list (x, y) theo hệ trang ĐÍCH TOP-DOWN (giống
`Rect` mà `out_clip` dùng). `pdf_ops.show_pdf_page` tự đổi sang y-up khi ghi.
"""

import logging
import math
import os
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.workers.imposition_affine import (
    Affine2D,
    PoseMm,
    compose_render_ctm_mm,
    parse_point_mm,
    parse_pose_mm,
)

logger = logging.getLogger(__name__)

# Dung sai nối đầu-cuối các đoạn path thành ring kín (pt).
_STITCH_TOL = 0.15
# Đơn giản hoá ring để content stream không phình (pt).
_SIMPLIFY_TOL = 0.05
# Trần số điểm: vượt ngưỡng → bỏ shape-clip, quay về rect (an toàn hiệu năng).
_MAX_RING_POINTS = 6000
# Bỏ shape-clip khi polygon gần trùng bbox của nó (tem chữ nhật) — rect clip đã đủ.
_RECT_LIKE_RATIO = 0.995
# Dung sai so bbox (pt) khi quyết định có cần phép boolean hay không.
_EPS = 1e-6


def shape_clip_enabled():
    """Kill-switch: đặt PRYNX_SHAPE_CLIP=0 để quay về clip bbox như trước."""
    return os.environ.get("PRYNX_SHAPE_CLIP", "1").strip() not in ("0", "false", "False")


def _key(pt):
    return (round(pt[0] / _STITCH_TOL), round(pt[1] / _STITCH_TOL))


def _close_enough(a, b):
    return abs(a[0] - b[0]) <= _STITCH_TOL and abs(a[1] - b[1]) <= _STITCH_TOL


def stitch_rings(polylines):
    """Nối các polyline rời (mỗi đoạn path là 1 polyline) thành các ring KÍN.

    Đường bế trong PDF là tập đoạn thẳng/bezier độc lập, không đảm bảo thứ tự.
    Hàm gom theo điểm đầu/cuối (dung sai `_STITCH_TOL`), cho phép đảo chiều đoạn.
    Ring nào không kín được thì bỏ (không đoán bừa).
    """
    segments = [list(pl) for pl in polylines if pl and len(pl) >= 2]
    if not segments:
        return []

    # index: key điểm đầu/cuối → danh sách (chỉ số segment, có đảo chiều hay không)
    index = {}
    for i, seg in enumerate(segments):
        index.setdefault(_key(seg[0]), []).append((i, False))
        index.setdefault(_key(seg[-1]), []).append((i, True))

    used = [False] * len(segments)
    rings = []

    for start in range(len(segments)):
        if used[start]:
            continue
        used[start] = True
        ring = list(segments[start])

        while True:
            tail = ring[-1]
            if len(ring) >= 4 and _close_enough(tail, ring[0]):
                break  # đã kín
            nxt = None
            for cand, reverse in index.get(_key(tail), ()):
                if used[cand]:
                    continue
                seg = segments[cand]
                head = seg[-1] if reverse else seg[0]
                if _close_enough(tail, head):
                    nxt = (cand, reverse)
                    break
            if nxt is None:
                break
            cand, reverse = nxt
            used[cand] = True
            seg = segments[cand]
            ring.extend(reversed(seg[:-1]) if reverse else seg[1:])

        if len(ring) >= 4 and _close_enough(ring[-1], ring[0]):
            ring[-1] = ring[0]
            rings.append(ring)

    return rings


def _polygon_from_rings(rings):
    """Hợp các ring kín thành một Polygon/MultiPolygon hợp lệ (đã lấp lỗ)."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union

    parts = []
    for ring in rings:
        try:
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_valid and not poly.is_empty and poly.area > 1e-6:
                parts.append(poly)
        except Exception:
            continue
    if not parts:
        return None

    merged = unary_union(parts)
    # CHỈ giữ viền ngoài: lỗ trong khuôn (lỗ treo, cửa sổ) KHÔNG được clip mất
    # artwork bên trong — người thiết kế vẫn in đủ, dao mới là thứ cắt.
    outers = []
    for geom in getattr(merged, "geoms", [merged]):
        exterior = getattr(geom, "exterior", None)
        if exterior is None:
            continue
        try:
            outer = Polygon(exterior.coords)
            if not outer.is_valid:
                outer = outer.buffer(0)
            if outer.is_valid and not outer.is_empty:
                outers.append(outer)
        except Exception:
            continue
    if not outers:
        return None
    return unary_union(outers)


_BASE_CACHE = {}
_BASE_CACHE_MAX = 64
_CACHE_MISS = object()


class _Base:
    """Hình khuôn đã nở, dựng tại gốc (0,0): geometry + ring + bbox."""

    __slots__ = ('geom', 'rings', 'bounds')

    def __init__(self, geom, rings, bounds):
        self.geom = geom
        self.rings = rings
        self.bounds = bounds


def _rings_of(geom):
    """Ring viền ngoài của Polygon/MultiPolygon, None nếu quá nhiều điểm."""
    rings = []
    total = 0
    for part in getattr(geom, "geoms", [geom]):
        exterior = getattr(part, "exterior", None)
        if exterior is None:
            continue
        pts = [(float(x), float(y)) for x, y in exterior.coords]
        if len(pts) < 4:
            continue
        total += len(pts)
        rings.append(pts)
    if not rings or total > _MAX_RING_POINTS:
        return None
    return rings


def _base_polygon(die_items, die_rect, offset_pt, is_rotated, is_rotated_180, cache_key):
    """Polygon khuôn (đã nở offset) tại gốc (0,0) — dùng lại cho MỌI ô cùng mẫu.

    `transform_die_point` cộng abs_x/abs_y ở bước cuối cho cả 4 biến thể xoay, nên
    hình tại (0,0) chỉ cần TỊNH TIẾN là ra vị trí từng ô → dựng 1 lần/mẫu thay vì
    1 lần/con tem (mỗi lần ~1.4ms, một tờ có thể hàng trăm con).
    """
    key = None
    if cache_key is not None:
        # Dấu vân hình học đi kèm khoá: cache_key (job_id + trang) một mình KHÔNG đủ
        # định danh — cùng khoá mà hình khác nhau (đổi mẫu, seed master khác) sẽ trả
        # clip của mẫu cũ. Vân tay rẻ: số đoạn path + bbox khuôn.
        key = (
            cache_key,
            len(die_items),
            round(float(die_rect.x0), 2), round(float(die_rect.y0), 2),
            round(float(die_rect.x1), 2), round(float(die_rect.y1), 2),
            bool(is_rotated), bool(is_rotated_180),
            round(float(offset_pt), 3),
        )
        cached = _BASE_CACHE.get(key, _CACHE_MISS)
        if cached is not _CACHE_MISS:
            return cached

    from app.workers.nup_artwork import die_polylines_for_placement

    polylines = die_polylines_for_placement(
        die_items, die_rect, 0.0, 0.0,
        is_rotated=is_rotated, is_rotated_180=is_rotated_180,
    )
    poly = _polygon_from_rings(stitch_rings(polylines))

    if poly is not None and not poly.is_empty:
        # Tem chữ nhật: polygon ≈ bbox → rect clip đã tương đương, khỏi phình stream.
        try:
            env_area = poly.envelope.area
            if env_area > 0 and poly.area / env_area >= _RECT_LIKE_RATIO:
                poly = None
        except Exception:
            pass

    if poly is not None and offset_pt and offset_pt > 1e-6:
        # mitre giữ góc nhọn cho tem đa giác; bo tròn tự nhiên theo mẫu bezier.
        poly = poly.buffer(float(offset_pt), join_style=2, mitre_limit=3.0)

    if poly is not None:
        poly = poly.simplify(_SIMPLIFY_TOL, preserve_topology=True)
        if poly.is_empty:
            poly = None

    base = None
    if poly is not None:
        rings = _rings_of(poly)
        if rings:
            base = _Base(poly, rings, tuple(poly.bounds))

    if key is not None:
        if len(_BASE_CACHE) >= _BASE_CACHE_MAX:
            _BASE_CACHE.pop(next(iter(_BASE_CACHE)), None)
        _BASE_CACHE[key] = base
    return base


def build_die_clip_rings(
    die_items,
    die_rect,
    abs_x,
    abs_y,
    *,
    offset_pt=0.0,
    bound_rect=None,
    block_rect=None,
    is_rotated=False,
    is_rotated_180=False,
    cache_key=None,
):
    """Ring clip theo hình khuôn cho MỘT ô. Trả None → caller dùng rect clip cũ.

    Args:
        die_items / die_rect: hình học đường bế trong hệ trang NGUỒN (từ
            `die_items_cache`, chính dữ liệu vẽ file khuôn).
        abs_x / abs_y: góc trên-trái ô trên tờ (= trim_rect.x0/y0).
        offset_pt: bù xén theo hình. PHẢI ≤ nửa khoảng cách nhỏ nhất giữa 2 khuôn
            để 2 vùng clip không thể giao nhau.
        bound_rect: rect clip cũ — luôn giao với nó nên shape-clip KHÔNG BAO GIỜ
            nới rộng vùng vẽ so với hành vi hiện tại (chỉ thu hẹp).
        block_rect: bbox (x0,y0,x1,y1) của block; phần `bound_rect` nằm NGOÀI block
            được giữ nguyên để tem mép ngoài vẫn đủ bleed tràn ra lề.
    """
    if not die_items or die_rect is None or bound_rect is None:
        return None
    if not shape_clip_enabled():
        return None

    try:
        from shapely.affinity import translate
        from shapely.geometry import box
        from shapely.ops import unary_union

        base = _base_polygon(
            die_items, die_rect, offset_pt, is_rotated, is_rotated_180, cache_key,
        )
        if base is None:
            return None

        dx = float(abs_x)
        dy = float(abs_y)
        minx, miny, maxx, maxy = base.bounds
        minx += dx; maxx += dx
        miny += dy; maxy += dy

        # Có cần nối thêm dải bleed ngoài block? (chỉ ô ở mép block mới cần)
        band_needed = block_rect is not None and (
            bound_rect.x0 < block_rect[0] - _EPS or bound_rect.y0 < block_rect[1] - _EPS
            or bound_rect.x1 > block_rect[2] + _EPS or bound_rect.y1 > block_rect[3] + _EPS
        )
        inside_bound = (
            minx >= bound_rect.x0 - _EPS and miny >= bound_rect.y0 - _EPS
            and maxx <= bound_rect.x1 + _EPS and maxy <= bound_rect.y1 + _EPS
        )

        # ĐƯỜNG NHANH (đa số ô ở giữa tờ): hình đã nằm trong bound và không cần dải
        # bleed ngoài → chỉ tịnh tiến ring đã cache, KHÔNG chạy phép boolean.
        if inside_bound and not band_needed:
            return [[(x + dx, y + dy) for x, y in ring] for ring in base.rings]

        poly = translate(base.geom, xoff=dx, yoff=dy)
        bound = box(bound_rect.x0, bound_rect.y0, bound_rect.x1, bound_rect.y1)
        if band_needed:
            try:
                outer_band = bound.difference(
                    box(block_rect[0], block_rect[1], block_rect[2], block_rect[3])
                )
                if not outer_band.is_empty:
                    poly = unary_union([poly, outer_band])
            except Exception:
                pass

        poly = poly.intersection(bound)
        if poly.is_empty:
            return None
        return _rings_of(poly)

    except Exception as exc:
        logger.debug("[SHAPE-CLIP] không dựng được clip theo hình, dùng bbox: %s", exc)
        return None


class ManifestClipContractError(ValueError):
    """Hình clip/cut canonical không còn đúng RenderBundle V2."""


@dataclass(frozen=True, slots=True)
class FrozenManifestPolygon:
    """Polygon manifest đã tách khỏi cây JSON mutable của render bundle."""

    outer: tuple[tuple[float, float], ...]
    holes: tuple[tuple[tuple[float, float], ...], ...]


def _manifest_ring(
    raw: Any, *, field: str
) -> tuple[tuple[float, float], ...]:
    if not isinstance(raw, (list, tuple)) or len(raw) < 3:
        raise ManifestClipContractError(f"{field} phải có ít nhất ba điểm.")
    points: list[tuple[float, float]] = []
    for index, point in enumerate(raw):
        try:
            x, y = parse_point_mm(point, field=f"{field}[{index}]")
        except ValueError as exc:
            raise ManifestClipContractError(str(exc)) from exc
        if not math.isfinite(x) or not math.isfinite(y):
            raise ManifestClipContractError(f"{field}[{index}] không hữu hạn.")
        points.append((x, y))
    if len(set(points)) < 3:
        raise ManifestClipContractError(
            f"{field} phải còn ít nhất ba đỉnh phân biệt."
        )
    return tuple(points)


def freeze_manifest_polygon(
    polygon: Mapping[str, Any] | FrozenManifestPolygon,
    *,
    field: str = "renderPolygon",
) -> FrozenManifestPolygon:
    """Chuẩn hóa outer/holes thành tuple lồng sâu, không còn alias tới caller."""

    if isinstance(polygon, FrozenManifestPolygon):
        return polygon
    if not isinstance(polygon, Mapping):
        raise ManifestClipContractError(f"{field} phải là object.")
    expected = {"outer", "holes"}
    if set(polygon) != expected:
        missing = expected.difference(polygon)
        unknown = set(polygon).difference(expected)
        details = []
        if missing:
            details.append("thiếu " + ", ".join(sorted(missing)))
        if unknown:
            details.append("có field lạ " + ", ".join(sorted(unknown)))
        raise ManifestClipContractError(f"{field} {'; '.join(details)}.")
    holes = polygon["holes"]
    if not isinstance(holes, (list, tuple)):
        raise ManifestClipContractError(f"{field}.holes phải là mảng.")
    return FrozenManifestPolygon(
        outer=_manifest_ring(polygon["outer"], field=f"{field}.outer"),
        holes=tuple(
            _manifest_ring(hole, field=f"{field}.holes[{index}]")
            for index, hole in enumerate(holes)
        ),
    )


def transform_manifest_polygon_rings(
    polygon: Mapping[str, Any] | FrozenManifestPolygon,
    *,
    sheet_frame: Affine2D | Sequence[Any],
    pose: PoseMm | Mapping[str, Any],
    reference_point_mm: Sequence[Any],
    field: str = "renderPolygon",
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Áp đúng ``H = SheetFrame · G`` cho outer và mọi hole.

    Đây là primitive dùng chung cho artwork clip và CUT. Khác lane legacy, dữ liệu
    manifest sai sẽ ném lỗi; tuyệt đối không quay về rectangle/cardinal fallback.
    """

    frozen = freeze_manifest_polygon(polygon, field=field)

    frame = (
        sheet_frame
        if isinstance(sheet_frame, Affine2D)
        else Affine2D.from_sequence(sheet_frame, field="sheetFrame")
    )
    parsed_pose = pose if isinstance(pose, PoseMm) else parse_pose_mm(pose)
    # Dùng compose helper production với source identity để nhận cùng guard det/scale.
    output_from_part = compose_render_ctm_mm(
        sheet_frame=frame,
        pose=parsed_pose,
        reference_point_mm=reference_point_mm,
        source_page_to_canonical=Affine2D(1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
    )
    source_rings = (frozen.outer, *frozen.holes)
    return tuple(
        tuple(output_from_part.apply(point) for point in ring)
        for ring in source_rings
    )


def build_manifest_clip_rings(
    artwork_clip_path: Mapping[str, Any] | FrozenManifestPolygon,
    *,
    sheet_frame: Affine2D | Sequence[Any],
    pose: PoseMm | Mapping[str, Any],
    reference_point_mm: Sequence[Any],
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Clip artwork canonical sau pose — CHỈ vòng ngoài, cố ý bỏ lỗ.

    NESTING (audit 2026-08-28 §A1c): quyết định sản phẩm ở cổng Chặng 0 là giữ
    hành vi in hiện hữu của xưởng — vùng lỗ (lỗ treo, cửa sổ) **vẫn được in
    mực**, dao mới là thứ cắt. Giống hệt lane legacy ``_polygon_from_rings``.

    Lỗ vẫn phải đi vào lớp CUT, nên chỗ đó dùng
    :func:`transform_manifest_polygon_rings` (giữ outer + holes). Tách hai
    đường ở đây để không ai phải nhớ truyền đúng tập ring cho từng lớp.

    Trả đúng MỘT ring: ``RenderPolygonV1`` chỉ có một ``outer``, nên số ring của
    artwork clip là bất biến cấp cấu trúc — không cần đoán hướng vòng, vốn là
    thứ không dùng được vì SheetFrame của mặt sau CNC có det=-1 làm đảo hướng.
    """

    frozen = freeze_manifest_polygon(artwork_clip_path, field="artworkClipPath")
    rings = transform_manifest_polygon_rings(
        FrozenManifestPolygon(outer=frozen.outer, holes=()),
        sheet_frame=sheet_frame,
        pose=pose,
        reference_point_mm=reference_point_mm,
        field="artworkClipPath",
    )
    if len(rings) != 1:  # pragma: no cover - bất biến nội bộ
        raise ManifestClipContractError(
            "artworkClipPath phải cho đúng một vòng ngoài sau pose."
        )
    return rings
