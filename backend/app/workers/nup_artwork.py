"""
Đặt artwork lên trang output — NGUỒN CHÂN LÝ DUY NHẤT cho việc render 1 ô.

Rút (extract) nguyên văn từ vòng lặp render của `nup_process_chunk.process_chunk`
để cả luồng Bình Tem Bế (process_chunk) lẫn công cụ Bình Bế Rớt CNC (cnc_render)
dùng CHUNG một logic đặt artwork — tránh phân kỳ kết quả về sau.

Hàm `place_one_artwork` xử lý cho MỘT placement:
- Tính trim_rect / bleed_rect / out_clip (bleed mép ngoài, nửa gap mép trong).
- Với die-cut: cache hình học, strip đường bế khỏi trang nguồn (khi tách trang khuôn),
  và đặt theo 4 biến thể xoay.
- Trả về `trim_rect` để caller tự bookkeeping (block_cuts…).
"""

import logging
import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.core.imposition_page_box import effective_imposition_box
from app.workers import pdf_wrapper as pdf_lib
from app.workers.imposition_affine import (
    Affine2D,
    AffineContractError,
    PoseMm,
    compose_render_ctm_mm,
    parse_point_mm,
    parse_pose_mm,
)
from app.workers.imposition_pdf_form import (
    ManifestPageBinding,
    PaintedManifestForm,
    paint_manifest_page_form,
)
from app.workers.nup_clip_shape import (
    build_die_clip_rings,
    build_manifest_clip_rings,
    freeze_manifest_polygon,
    FrozenManifestPolygon,
)

logger = logging.getLogger(__name__)

class ManifestArtworkContractError(ValueError):
    """Placement/bundle không đủ identity để render artwork production."""



def resolve_die_output_clip(trim_rect, bleed_rect, cell_out_clip, cut_type, die_size_mode):
    """Chọn clip mask đích cho artwork die-cut.

    1 Dao theo kích thước trang coi chính hình chữ nhật ô là kích thước tem, nên
    mask phải trùng tuyệt đối với ô ở cả giữa tờ lẫn sát lề. Các chế độ khuôn khác
    vẫn giữ bleed ở mép ngoài block và nửa gap ở mép trong.
    """
    if cut_type == 'one_dao' and die_size_mode == 'page':
        return trim_rect
    return cell_out_clip if cell_out_clip is not None else bleed_rect


def resolve_page_fallback_output_clip(
    trim_rect,
    source_target_rect,
    gap_half_x,
    gap_half_y,
):
    """Giới hạn artwork fallback theo trang logic và nửa khoảng hở.

    Khung trang fallback không có đường bế thật để định nghĩa bleed. Vì vậy không
    được dùng bleed đang lưu ẩn trong UI để lộ thêm phần MediaBox ở riêng mép ngoài
    block. Mask chỉ được phép nằm trong trang logic nguồn và tối đa nửa khoảng hở
    quanh đường cắt, nhờ đó hai tem kề nhau không đè artwork lên nhau.
    """
    safe_gap_clip = pdf_lib.Rect(
        trim_rect.x0 - max(0.0, float(gap_half_x or 0.0)),
        trim_rect.y0 - max(0.0, float(gap_half_y or 0.0)),
        trim_rect.x1 + max(0.0, float(gap_half_x or 0.0)),
        trim_rect.y1 + max(0.0, float(gap_half_y or 0.0)),
    )
    clipped = source_target_rect & safe_gap_clip
    if clipped.is_empty:
        logger.warning(
            "Clip fallback theo trang không giao khung nguồn; giữ khung nguồn để "
            "tránh làm mất artwork."
        )
        return source_target_rect
    return clipped


def _die_channel_names_lower():
    """Tên kênh bế chuẩn (lowercase) — tái dùng cấu hình detection để nhất quán."""
    try:
        from app.workers.die_detection import DetectionConfig
        return frozenset(n.strip().lower() for n in DetectionConfig().die_channel_names)
    except Exception:
        return frozenset({"cutcontour", "dieline", "thru-cut", "kiss", "crease"})


def _spot_key(spot_name):
    """Chuẩn hoá tên spot → khoá so khớp (tập tên lowercase, tách '+' cho DeviceN)."""
    if not spot_name:
        return None
    parts = frozenset(s.strip().lower() for s in str(spot_name).split("+") if s.strip())
    return parts or None


# NEST (audit 2026-08-28 §A1.2): số toạ độ bắt buộc của từng lệnh path.
# 'l' = 2 điểm, 'c' = 4 điểm Bezier, 're' = 2 góc đối. Sai arity nghĩa là dữ
# liệu không đáng tin, phải bỏ qua chứ không đoán bù.
_PATH_ITEM_ARITY = {'l': 4, 'c': 8, 're': 4}


def _path_item_coords(item):
    """Trải một path item về danh sách toạ độ phẳng; None nếu không trải được.

    Chấp nhận CẢ HAI dạng đang tồn tại trong dự án:

    - dạng object của ``pdf_content_parser``: ``('l', Point, Point)``,
      ``('c', Point, Point, Point, Point)``, ``('re', Rect)``;
    - dạng mảng số phẳng của ``strip_color_from_stream`` và của manifest
      production: ``('l', x1, y1, x2, y2)``…

    Trước đây hàm khoá chỉ đọc được dạng object nên khi nhận mảng số nó **ném
    AttributeError**, và caller ở ``nup_artwork`` biến lỗi đó thành
    "Không thể tách đường khuôn bế khỏi trang in N" — hỏng job với thông điệp
    chỉ sai chỗ. Đường manifest bất biến truyền contour dạng số, nên phải trải
    được cả hai dạng trước khi lô A2/A3 nối writer.
    """

    coords = []
    for member in item[1:]:
        # bool là con của int: nhận vào sẽ thành 0.0/1.0 âm thầm.
        if isinstance(member, bool):
            return None
        if isinstance(member, (int, float)):
            coords.append(float(member))
            continue
        if isinstance(member, (str, bytes)):
            return None
        # Point/Rect (và mọi object toạ độ có __iter__) tự trải qua iterable.
        try:
            parts = list(member)
        except TypeError:
            return None
        for part in parts:
            if isinstance(part, bool) or not isinstance(part, (int, float)):
                return None
            coords.append(float(part))
    return coords


def _path_item_key(item, tolerance=0.1):
    """Khoá hình học ổn định theo dung sai cho một path item đã parse.

    Trả ``None`` khi item không mang hình học đáng tin — không bao giờ ném lỗi,
    vì hàm này nằm trong vòng quét content stream của mọi job bình.
    """

    if not item:
        return None
    command = item[0]
    coords = _path_item_coords(item)
    if coords is None or any(not math.isfinite(value) for value in coords):
        return None
    arity = _PATH_ITEM_ARITY.get(command)
    if arity is not None and len(coords) != arity:
        return None
    if command == 're' and len(coords) == 4:
        # Chuẩn hoá về (min, max) để hai nguồn dựng rect theo thứ tự khác nhau
        # vẫn cho cùng khoá.
        x0, y0, x1, y1 = coords
        coords = [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]
    return (command, *(int(round(value / tolerance)) for value in coords))


def _numeric_path_item_key(item, tolerance=0.1):
    """Giữ tên cũ nhưng dùng CHUNG một cách khoá.

    Hai hàm khoá song song từng là gốc của lỗi: bên target đọc dạng object, bên
    candidate đọc dạng số, lệch một dạng là mất khớp toàn bộ.
    """

    return _path_item_key(item, tolerance)


def _path_matches_target_items(current_path, target_items):
    """Mọi nét đang vẽ có thuộc đúng nhóm khuôn đã dò ra hay không.

    NEST (audit 2026-08-28 §A1.2): nét nào KHÔNG khoá được thì trả False ngay.
    Bỏ qua nét lạ sẽ làm candidate trông như tập con của target và xoá mất
    artwork của khách; giữ lại nét bế là lỗi thấy được trên preview, còn xoá mất
    artwork chỉ lộ ra khi đã in.
    """

    from collections import Counter

    if not current_path or not target_items:
        return False
    candidate_keys = []
    for item in current_path:
        key = _path_item_key(item)
        if key is None:
            return False
        candidate_keys.append(key)
    target = Counter(
        key for key in (_path_item_key(item) for item in target_items)
        if key is not None
    )
    candidate = Counter(candidate_keys)
    return bool(candidate) and all(
        candidate[key] <= target.get(key, 0)
        for key in candidate
    )


def strip_color_from_stream(
    page_or_xobj,
    target_color,
    die_names_lower=None,
    target_spot=None,
    *,
    inherited_resources=None,
    strict=False,
    target_items=None,
    page_height=None,
    initial_ctm=None,
    called_forms_out=None,
    dry_run=False,
):
    """Remove only the detected die strokes from one content stream.

    Spot cutlines are matched by their real Separation/DeviceN channel. For
    process-color cutlines, ``target_items`` limits removal to the exact
    geometry selected by die detection, so unrelated artwork with the same
    CMYK/RGB/Gray value is preserved.
    """
    import pikepdf
    from app.workers.pdf_content_parser import _mat_mul, _resolve_spot_name

    try:
        stream = pikepdf.parse_content_stream(page_or_xobj)
    except Exception as exc:
        if strict:
            raise RuntimeError(
                "Không thể đọc content stream để tách đường khuôn bế."
            ) from exc
        logger.debug("[_strip_color] Parse stream error: %s", exc)
        return False

    if die_names_lower is None:
        die_names_lower = _die_channel_names_lower()

    target_spot_key = _spot_key(target_spot)
    try:
        resources = page_or_xobj.get('/Resources')
        if resources is None:
            resources = inherited_resources
    except Exception:
        if strict:
            raise
        resources = inherited_resources

    def _spot_of(cs_token):
        if resources is None or not cs_token:
            return None
        try:
            return _resolve_spot_name(cs_token, resources, None)
        except Exception:
            return None

    def _transform(x, y, matrix):
        a, b, c, d, e, f = matrix
        tx = float(x) * a + float(y) * c + e
        ty = float(x) * b + float(y) * d + f
        if page_height is not None:
            ty = float(page_height) - ty
        return tx, ty

    new_stream = []
    current_stroke_color = None
    current_stroke_spot = None
    current_ctm = list(initial_ctm or (1, 0, 0, 1, 0, 0))
    graphics_stack = []
    current_path = []
    current_point = None
    subpath_start = None
    stripped = False

    for operands, operator in stream:
        op = str(operator)

        if op == 'q':
            graphics_stack.append((
                current_stroke_color,
                current_stroke_spot,
                list(current_ctm),
            ))
        elif op == 'Q':
            if graphics_stack:
                (
                    current_stroke_color,
                    current_stroke_spot,
                    current_ctm,
                ) = graphics_stack.pop()
        elif op == 'cm':
            try:
                matrix = [float(value) for value in operands[-6:]]
                if len(matrix) == 6:
                    current_ctm = _mat_mul(matrix, current_ctm)
            except Exception:
                if strict:
                    raise
        elif op == 'CS':
            if operands:
                cs_name = str(operands[0])
                if cs_name not in (
                    '/DeviceRGB', '/DeviceCMYK', '/DeviceGray',
                    '/Pattern', '/RGB', '/CMYK', '/G',
                ):
                    current_stroke_spot = _spot_of(cs_name)
                    current_stroke_color = None
                else:
                    current_stroke_spot = None
                    current_stroke_color = None
        elif op in ('SCN', 'SC'):
            try:
                values = tuple(round(float(value), 3) for value in operands)
                if len(values) in (1, 3, 4):
                    current_stroke_color = values
            except Exception:
                current_stroke_color = None
        elif op in ('RG', 'K', 'G'):
            try:
                current_stroke_color = tuple(
                    round(float(value), 3) for value in operands
                )
            except Exception:
                current_stroke_color = None
            current_stroke_spot = None

        if op == 'm' and len(operands) >= 2:
            current_point = _transform(operands[-2], operands[-1], current_ctm)
            subpath_start = current_point
        elif op == 'l' and len(operands) >= 2 and current_point is not None:
            next_point = _transform(operands[-2], operands[-1], current_ctm)
            current_path.append((
                'l',
                current_point[0], current_point[1],
                next_point[0], next_point[1],
            ))
            current_point = next_point
        elif op == 'c' and len(operands) >= 6 and current_point is not None:
            cp1 = _transform(operands[-6], operands[-5], current_ctm)
            cp2 = _transform(operands[-4], operands[-3], current_ctm)
            end_point = _transform(operands[-2], operands[-1], current_ctm)
            current_path.append((
                'c',
                current_point[0], current_point[1],
                cp1[0], cp1[1],
                cp2[0], cp2[1],
                end_point[0], end_point[1],
            ))
            current_point = end_point
        elif op == 'v' and len(operands) >= 4 and current_point is not None:
            cp1 = current_point
            cp2 = _transform(operands[-4], operands[-3], current_ctm)
            end_point = _transform(operands[-2], operands[-1], current_ctm)
            current_path.append((
                'c',
                current_point[0], current_point[1],
                cp1[0], cp1[1],
                cp2[0], cp2[1],
                end_point[0], end_point[1],
            ))
            current_point = end_point
        elif op == 'y' and len(operands) >= 4 and current_point is not None:
            cp1 = _transform(operands[-4], operands[-3], current_ctm)
            end_point = _transform(operands[-2], operands[-1], current_ctm)
            cp2 = end_point
            current_path.append((
                'c',
                current_point[0], current_point[1],
                cp1[0], cp1[1],
                cp2[0], cp2[1],
                end_point[0], end_point[1],
            ))
            current_point = end_point
        elif op == 're' and len(operands) >= 4:
            x, y, width, height = (float(value) for value in operands[-4:])
            corners = (
                _transform(x, y, current_ctm),
                _transform(x + width, y, current_ctm),
                _transform(x + width, y + height, current_ctm),
                _transform(x, y + height, current_ctm),
            )
            xs = [point[0] for point in corners]
            ys = [point[1] for point in corners]
            current_path.append((
                're',
                min(xs), min(ys), max(xs), max(ys),
            ))
            current_point = corners[0]
            subpath_start = corners[0]
        elif op == 'h':
            if current_point is not None and subpath_start is not None:
                if (
                    abs(current_point[0] - subpath_start[0]) > 0.01
                    or abs(current_point[1] - subpath_start[1]) > 0.01
                ):
                    current_path.append((
                        'l',
                        current_point[0], current_point[1],
                        subpath_start[0], subpath_start[1],
                    ))
                current_point = subpath_start
        elif op == 'Do' and operands and called_forms_out is not None:
            called_forms_out.append((str(operands[-1]), list(current_ctm)))

        paint_op = op in ('S', 's', 'B', 'B*', 'b', 'b*')
        if paint_op:
            # pdf_content_parser expands the implicit close of `s` into one
            # final line item. Mirror that representation for exact matching.
            if (
                op == 's'
                and current_point is not None
                and subpath_start is not None
                and (
                    abs(current_point[0] - subpath_start[0]) > 0.01
                    or abs(current_point[1] - subpath_start[1]) > 0.01
                )
            ):
                current_path.append((
                    'l',
                    current_point[0], current_point[1],
                    subpath_start[0], subpath_start[1],
                ))

            match = False
            if current_stroke_spot:
                from app.workers.die_detection import _match_die_channel
                if _match_die_channel(current_stroke_spot, die_names_lower):
                    match = True
                if (
                    not match
                    and target_spot_key
                    and _spot_key(current_stroke_spot) == target_spot_key
                ):
                    match = True

            if (
                not match
                and not target_spot_key
                and current_stroke_color
                and target_color
                and len(current_stroke_color) == len(target_color)
            ):
                color_match = all(
                    abs(c1 - c2) <= 0.01
                    for c1, c2 in zip(current_stroke_color, target_color)
                )
                if color_match:
                    match = (
                        _path_matches_target_items(current_path, target_items)
                        if target_items is not None
                        else True
                    )

            if match:
                stripped = True
                if op == 'S':
                    operator = pikepdf.Operator('n')
                elif op == 's':
                    new_stream.append(([], pikepdf.Operator('h')))
                    operator = pikepdf.Operator('n')
                elif op == 'B':
                    operator = pikepdf.Operator('f')
                elif op == 'B*':
                    operator = pikepdf.Operator('f*')
                elif op == 'b':
                    new_stream.append(([], pikepdf.Operator('h')))
                    operator = pikepdf.Operator('f')
                elif op == 'b*':
                    new_stream.append(([], pikepdf.Operator('h')))
                    operator = pikepdf.Operator('f*')

            current_path = []
            current_point = None
            subpath_start = None
        elif op in ('f', 'F', 'f*', 'n'):
            current_path = []
            current_point = None
            subpath_start = None

        new_stream.append((operands, operator))

    if stripped and not dry_run:
        new_contents = pikepdf.unparse_content_stream(new_stream)
        if isinstance(page_or_xobj, pikepdf.Page):
            page_or_xobj.contents_coalesce()
            contents = page_or_xobj.get('/Contents')
            if contents is None:
                if strict:
                    raise RuntimeError(
                        "Trang nguồn không có content stream sau khi chuẩn hóa."
                    )
                return False
            contents.write(new_contents)
        else:
            page_or_xobj.write(new_contents)
    return stripped


def strip_color_from_form_tree(
    page_or_xobj,
    target_color,
    target_spot=None,
    *,
    inherited_resources=None,
    strict=False,
    target_items=None,
    page_height=None,
    owner_pdf=None,
    initial_ctm=None,
    max_depth=10,
):
    """Strip a die channel only through Form XObjects actually invoked by ``Do``.

    Each used Form is cloned before rewriting. This isolates shared Forms and
    inherited resource contexts across source pages while retaining vector
    content, clipping, transparency, OCG membership and all resource objects.
    """
    import pikepdf
    from app.workers.pdf_content_parser import _mat_mul

    changed = False
    resource_cache = {}
    cloned_references = set()
    visited_contexts = set()

    def _object_key(node):
        try:
            objgen = tuple(node.objgen)
        except Exception:
            objgen = (0, 0)
        return ("objgen", objgen) if objgen != (0, 0) else ("id", id(node))

    def _context_key(matrix):
        return tuple(round(float(value), 7) for value in matrix)

    def _copy_dictionary(dictionary):
        copied = pikepdf.Dictionary()
        for key, value in dictionary.items():
            copied[str(key)] = value
        return copied

    def _effective_resources(node, parent_resources):
        node_key = _object_key(node)
        if node_key in resource_cache:
            return resource_cache[node_key]
        try:
            resources = node.get('/Resources')
        except Exception as exc:
            if strict:
                raise
            logger.debug("[STRIP_FORM_TREE] resources error: %s", exc)
            resources = None
        if resources is None:
            resources = parent_resources
        if resources is None:
            resource_cache[node_key] = None
            return None

        # A private shallow dictionary is enough: resource objects themselves
        # remain untouched; only the /XObject references that need cloned Form
        # streams are replaced.
        isolated = _copy_dictionary(resources)
        xobjects = resources.get('/XObject')
        if xobjects is not None:
            isolated['/XObject'] = _copy_dictionary(xobjects)
        if owner_pdf is not None:
            if isinstance(node, pikepdf.Page):
                node.obj['/Resources'] = isolated
            else:
                node['/Resources'] = isolated
        resource_cache[node_key] = isolated
        return isolated

    def _clone_form(form):
        if owner_pdf is None:
            return form
        clone = pikepdf.Stream(owner_pdf, form.read_bytes())
        for key, value in form.items():
            key_name = str(key)
            if key_name in ('/Length', '/Filter', '/DecodeParms'):
                continue
            clone[key_name] = value
        return clone

    def _form_matrix(form):
        matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
        try:
            raw = form.get('/Matrix')
            if raw is not None and len(raw) == 6:
                matrix = [float(value) for value in raw]
        except Exception:
            if strict:
                raise
        return matrix

    def _visit(node, parent_resources, context_ctm, depth):
        nonlocal changed
        visit_key = (_object_key(node), _context_key(context_ctm))
        if visit_key in visited_contexts:
            return
        visited_contexts.add(visit_key)

        resources = _effective_resources(node, parent_resources)
        called_forms = []
        direct_changed = strip_color_from_stream(
            node,
            target_color,
            target_spot=target_spot,
            inherited_resources=resources,
            strict=strict,
            target_items=target_items,
            page_height=page_height,
            initial_ctm=context_ctm,
            called_forms_out=called_forms,
        )
        changed = direct_changed or changed

        if not called_forms:
            return
        if depth >= max_depth:
            if strict:
                raise RuntimeError(
                    "Cây Form XObject vượt quá giới hạn an toàn khi tách khuôn."
                )
            return

        xobjects = resources.get('/XObject') if resources is not None else None
        if xobjects is None:
            if strict:
                raise RuntimeError(
                    "Content stream gọi Form nhưng không có XObject resource."
                )
            return

        calls_by_name = {}
        for name, call_ctm in called_forms:
            calls_by_name.setdefault(name, []).append(call_ctm)

        for name, call_contexts in calls_by_name.items():
            form = xobjects.get(name)
            if form is None or '/Form' not in str(form.get('/Subtype', '')):
                continue

            ref_key = (_object_key(node), name)
            if ref_key not in cloned_references:
                form = _clone_form(form)
                if owner_pdf is not None:
                    xobjects[name] = form
                cloned_references.add(ref_key)
            else:
                form = xobjects.get(name)

            matrix = _form_matrix(form)
            child_contexts = [
                _mat_mul(matrix, call_ctm)
                for call_ctm in call_contexts
            ]

            # One resource name cannot safely point to both a cut instance and
            # a same-colored non-cut instance. Detect that before mutating the
            # shared clone and fail instead of deleting artwork.
            if (
                target_spot is None
                and target_items is not None
                and len(child_contexts) > 1
            ):
                direct_matches = [
                    strip_color_from_stream(
                        form,
                        target_color,
                        target_spot=target_spot,
                        inherited_resources=resources,
                        strict=strict,
                        target_items=target_items,
                        page_height=page_height,
                        initial_ctm=child_ctm,
                        dry_run=True,
                    )
                    for child_ctm in child_contexts
                ]
                if any(direct_matches) and not all(direct_matches):
                    raise RuntimeError(
                        "Một Form XObject được dùng đồng thời cho đường khuôn "
                        "và artwork cùng màu; không thể tách an toàn."
                    )

            for child_ctm in child_contexts:
                _visit(form, resources, child_ctm, depth + 1)

    _visit(
        page_or_xobj,
        inherited_resources,
        list(initial_ctm or (1, 0, 0, 1, 0, 0)),
        0,
    )
    return changed


def compute_block_bbox(placements):
    """Bbox mỗi (cluster, block) theo toạ độ abs để xác định mép ngoài vs trong."""
    block_bbox = {}
    for _p in placements:
        _k = (_p['cluster_idx'], _p['cell'].get('blockId', 0))
        _x0 = _p['abs_x']
        _y0 = _p['original_cell_y']
        _x1 = _x0 + _p['width']
        _y1 = _y0 + _p['height']
        if _k not in block_bbox:
            block_bbox[_k] = [_x0, _y0, _x1, _y1]
        else:
            bb = block_bbox[_k]
            bb[0] = min(bb[0], _x0)
            bb[1] = min(bb[1], _y0)
            bb[2] = max(bb[2], _x1)
            bb[3] = max(bb[3], _y1)
    return block_bbox


_OUTPUT_CLIP_UNSET = object()
# Planner ghi nhiều trường hình học độc lập đến 6 chữ số thập phân; khi cộng lại,
# hai cạnh cùng seam có thể lệch hơn 1e-6 pt. Dung sai 0,01 pt vẫn nhỏ hơn nhiều
# một pixel in nhưng đủ giữ ownership ổn định sau vòng serialize/deserialize.
_CLIP_COORD_EPSILON_PT = 0.01


class _RangeMaxIndex:
    """Chỉ mục đoạn cho phép cập nhật/query max trên một khoảng nén toạ độ."""

    __slots__ = ('_size', '_tree', '_lazy')

    def __init__(self, segment_count):
        size = 1
        while size < segment_count:
            size *= 2
        self._size = size
        self._tree = [-math.inf] * (2 * size)
        self._lazy = [-math.inf] * (2 * size)

    def _apply(self, node, value):
        self._tree[node] = max(self._tree[node], value)
        self._lazy[node] = max(self._lazy[node], value)

    def _push(self, node):
        value = self._lazy[node]
        if value == -math.inf or node >= self._size:
            return
        self._apply(node * 2, value)
        self._apply(node * 2 + 1, value)
        self._lazy[node] = -math.inf

    def update(self, start, stop, value):
        """Ghi max cho khoảng nửa mở ``[start, stop)``."""

        self._update(1, 0, self._size, start, stop, value)

    def _update(self, node, left, right, start, stop, value):
        if stop <= left or right <= start:
            return
        if start <= left and right <= stop:
            self._apply(node, value)
            return
        self._push(node)
        middle = (left + right) // 2
        self._update(node * 2, left, middle, start, stop, value)
        self._update(node * 2 + 1, middle, right, start, stop, value)
        self._tree[node] = max(self._tree[node * 2], self._tree[node * 2 + 1])

    def query(self, start, stop):
        """Đọc max trên khoảng nửa mở ``[start, stop)``."""

        return self._query(1, 0, self._size, start, stop)

    def _query(self, node, left, right, start, stop):
        if stop <= left or right <= start:
            return -math.inf
        if start <= left and right <= stop:
            return self._tree[node]
        self._push(node)
        middle = (left + right) // 2
        return max(
            self._query(node * 2, left, middle, start, stop),
            self._query(node * 2 + 1, middle, right, start, stop),
        )


def _nearest_negative_axis_gaps(bounds, *, axis, reflected, projection_pad):
    """Khoảng tới láng giềng gần nhất ở phía âm của một trục đã chọn."""

    records = []
    for index, (x0, y0, x1, y1) in enumerate(bounds):
        if axis == 'x':
            low, high = x0, x1
            projection_low = y0 - projection_pad
            projection_high = y1 + projection_pad
        else:
            low, high = y0, y1
            projection_low = x0 - projection_pad
            projection_high = x1 + projection_pad
        if reflected:
            low, high = -high, -low
        records.append((index, low, high, projection_low, projection_high))

    coordinates = sorted({
        coordinate
        for record in records
        for coordinate in (record[3], record[4])
    })
    coordinate_index = {
        coordinate: index for index, coordinate in enumerate(coordinates)
    }
    interval_index = _RangeMaxIndex(max(1, len(coordinates) - 1))
    candidates = sorted(records, key=lambda record: record[2])
    queries = sorted(records, key=lambda record: record[1])
    candidate_index = 0
    gaps = [None] * len(records)

    for index, low, _high, projection_low, projection_high in queries:
        # Chỉ epsilon số học được phép nhận một cạnh hơi vượt seam. Khe dương
        # dù rất nhỏ vẫn giữ nguyên giá trị thật để hai phía chia đúng g/2.
        while (
            candidate_index < len(candidates)
            and candidates[candidate_index][2] <= low + _CLIP_COORD_EPSILON_PT
        ):
            candidate = candidates[candidate_index]
            start = coordinate_index[candidate[3]]
            stop = coordinate_index[candidate[4]]
            interval_index.update(start, stop, candidate[2])
            candidate_index += 1

        start = coordinate_index[projection_low]
        stop = coordinate_index[projection_high]
        nearest = interval_index.query(start, stop)
        if nearest != -math.inf:
            gaps[index] = max(0.0, low - nearest)

    return gaps


def compute_output_clips(placements, bleed_pt):
    """Tính clip chữ nhật theo láng giềng hình học trên toàn bộ một tờ.

    Kết quả dùng identity của placement làm key để không phụ thuộc ``blockId`` hay
    ``cluster_idx``. Mỗi seam nhận đúng nửa khe thật; cạnh không có láng giềng giữ
    đủ bleed. Chỉ mục đoạn giữ chi phí O(N log N), không quét từng cặp placement.
    """

    placements = list(placements)
    bleed = max(0.0, float(bleed_pt))
    if bleed == 0.0:
        return {id(placement): None for placement in placements}

    bounds = []
    for placement in placements:
        cell = placement['cell']
        x0 = float(placement['abs_x'])
        y0 = float(placement['original_cell_y'])
        x1 = x0 + float(cell['width'])
        y1 = y0 + float(cell['height'])
        if not all(math.isfinite(value) for value in (x0, y0, x1, y1)):
            raise ValueError("Toạ độ placement bình cắt xén không hữu hạn.")
        if x1 <= x0 or y1 <= y0:
            raise ValueError("Kích thước placement bình cắt xén phải lớn hơn 0.")
        bounds.append((x0, y0, x1, y1))

    if not bounds:
        return {}

    # IMPOSE (audit 2026-09-01 §CLIPOWN.1): nới nửa bleed trên mỗi projection
    # để hai ô chỉ chạm gần góc vẫn được coi là láng giềng. Rect không biểu diễn
    # được notch nên giới hạn bảo thủ cả hai cạnh, tránh bleed góc phủ vào trim kia.
    projection_pad = bleed / 2.0 + _CLIP_COORD_EPSILON_PT
    left_gaps = _nearest_negative_axis_gaps(
        bounds, axis='x', reflected=False, projection_pad=projection_pad,
    )
    right_gaps = _nearest_negative_axis_gaps(
        bounds, axis='x', reflected=True, projection_pad=projection_pad,
    )
    top_gaps = _nearest_negative_axis_gaps(
        bounds, axis='y', reflected=False, projection_pad=projection_pad,
    )
    bottom_gaps = _nearest_negative_axis_gaps(
        bounds, axis='y', reflected=True, projection_pad=projection_pad,
    )

    def _edge_offset(gap):
        return bleed if gap is None else min(bleed, max(0.0, gap / 2.0))

    output_clips = {}
    for index, placement in enumerate(placements):
        x0, y0, x1, y1 = bounds[index]
        output_clips[id(placement)] = pdf_lib.Rect(
            x0 - _edge_offset(left_gaps[index]),
            y0 - _edge_offset(top_gaps[index]),
            x1 + _edge_offset(right_gaps[index]),
            y1 + _edge_offset(bottom_gaps[index]),
        )
    return output_clips


def place_one_artwork(
    out_page,
    src_doc,
    p,
    *,
    bleed_pt,
    is_die_cut,
    cut_type,
    separate_cut_page,
    local_stripped_pages,
    job_id,
    diecut_geom_cache,
    die_items_cache,
    max_geom_cache,
    block_bbox,
    clip_off_x,
    clip_off_y,
    find_largest_die_path,
    output_clip=_OUTPUT_CLIP_UNSET,
    mirror_x=False,
    mirror_y=False,
    homogeneous_clip=None,
    homogeneous_rect=None,
    die_size_mode='die',
    die_offset_mm=0,
    page_sheet_mode=False,
    geometry_doc=None,
    shape_clip=True,
    shape_clip_offset_pt=None,
    guillotine_source_clip=None,
    fallback_gap_half_x=None,
    fallback_gap_half_y=None,
):
    """Đặt MỘT placement `p` lên `out_page`. Trả về (trim_rect, src_page_idx).

    Logic rút nguyên văn từ process_chunk — KHÔNG đổi hành vi.

    mirror_x / mirror_y: lật gương nội dung quanh tâm ô (cho Mặt sau bình bế 2 mặt).

    shape_clip: bật clip THEO HÌNH đường bế cho tem die-cut (tròn/oval/đa giác xếp
    lồng) thay vì chỉ bbox chữ nhật. Vùng clip theo hình luôn được GIAO với rect clip
    cũ nên không bao giờ vẽ rộng hơn trước. Tem chữ nhật tự động bỏ qua (rect đã đủ).
    shape_clip_offset_pt: bù xén cho clip theo hình; None = min(clip_off_x, clip_off_y)
    (nửa gap, kẹp bởi bleed) — mức lớn nhất mà 2 vùng clip chắc chắn không giao nhau.

    fallback_gap_half_x / fallback_gap_half_y: nửa khoảng hở thật trên tờ (pt),
    không kẹp bởi bleed. Chỉ dùng khi ``Mặc định`` phải fallback theo khung trang.

    homogeneous_clip / homogeneous_rect (chế độ ĐỒNG NHẤT — sticker-homogeneous-nup):
    khi ``homogeneous_clip`` ≠ None → đi nhánh REGISTRATION: đặt artwork của trang nội
    dung bằng ``show_pdf_page(rect=khuôn ô, clip=bbox artwork, keep_proportion=True)``
    → bỏ lệch vị trí trên trang gốc + co khít + căn tâm vào khuôn. Khi None (mặc định)
    GIỮ NGUYÊN hành vi cũ.

    guillotine_source_clip: vùng TrimBox/CropBox nguồn theo hệ top-down. Chỉ dùng
    cho bình cắt xén chữ nhật để khổ solver và nội dung render luôn trùng nhau.

    output_clip: override đã giải theo placement cho Bình cắt xén thường. Sentinel
    phân biệt caller cũ không truyền với override tường minh ``None`` khi bleed = 0.
    """
    cell = p['cell']
    cluster_idx = p['cluster_idx']
    src_page_idx = p['src_page_idx']
    src_page = src_doc[src_page_idx]
    cell_x = p['abs_x']
    cell_y = p['original_cell_y']

    # ── [ROT-AUDIT] Sự thật render: vị trí + cờ xoay thật khi đặt từng tem lên trang.
    try:
        from app.workers.rot_audit_log import get_logger as _rot_get_logger
        _rot_get_logger().warning(
            "[ROT-AUDIT][place][src=%d clu=%d] abs_x=%.1f original_cell_y=%.1f w=%.1f h=%.1f "
            "rot90=%d rot180=%d die_cut=%d mirror=(%d,%d)",
            src_page_idx, cluster_idx, cell_x, cell_y, cell['width'], cell['height'],
            int(cell.get('isRotated', False)), int(cell.get('isRotated180', False)),
            int(bool(is_die_cut)), int(bool(mirror_x)), int(bool(mirror_y)),
        )
    except Exception:
        pass

    trim_rect = pdf_lib.Rect(cell_x, cell_y, cell_x + cell['width'], cell_y + cell['height'])
    bleed_rect = pdf_lib.Rect(
        trim_rect.x0 - bleed_pt, trim_rect.y0 - bleed_pt,
        trim_rect.x1 + bleed_pt, trim_rect.y1 + bleed_pt,
    )

    # ── Chế độ ĐỒNG NHẤT: registration (căn-tâm + co-khít) — short-circuit ──
    # PHẢI đọc cờ xoay của ô: nesting có thể xoay tem để lồng khít khuôn (tem ngang
    # vào ô dọc → isRotated). show_pdf_page khi rotate%180≠0 tự HOÁN scale_x/scale_y
    # theo clip (dòng 342-350 pdf_ops) rồi keep_proportion lấy min → VỪA xoay VỪA
    # co-khít căn tâm đúng. Trước đây nhánh này bỏ qua rotate + chỉ keep_proportion
    # → tem ngang bị CO theo bề rộng ô dọc thay vì xoay (regression bình tem chung khuôn).
    #
    # QUAN TRỌNG — strip đường bế TRƯỚC place: trang master (loại đầu) có CẢ artwork
    # + nét khuôn. Nhánh này trước đây return sớm → không strip → khuôn sót trên tờ in
    # loại 1 (các loại khác không có nét bế nên sạch). Khuôn được vẽ lại từ master
    # overlay / trang khuôn riêng — không được dính trong artwork.
    if homogeneous_clip is not None:
        if is_die_cut and src_page_idx not in local_stripped_pages:
            local_stripped_pages.add(src_page_idx)
            try:
                _ck = f"{job_id}_{src_page_idx}"
                _cached = die_items_cache.get(_ck)
                if _cached is None and find_largest_die_path is not None:
                    try:
                        _lp = find_largest_die_path(src_page)
                        if _lp:
                            _cached = {
                                'color': _lp.get('color', (0, 1, 1, 0)),
                                'spot_name': _lp.get('spot_name'),
                            }
                            die_items_cache[_ck] = {
                                'items': _lp.get('items', []),
                                'rect': _lp['rect'],
                                'color': _cached['color'],
                                'width': _lp.get('width', 0.5),
                                'spot_name': _cached.get('spot_name'),
                            }
                    except Exception:
                        _cached = None
                _tcol = _cached.get('color') if _cached else None
                _tspot = _cached.get('spot_name') if _cached else None
                pike_page = src_doc._pdf.pages[src_page_idx]
                pike_page.contents_coalesce()
                contents = pike_page.get('/Contents')
                if contents is not None:
                    try:
                        strip_color_from_stream(pike_page, _tcol, target_spot=_tspot)
                    except Exception as e_c:
                        logger.debug(
                            f"[STRIP_DIECUT/HOM] page={src_page_idx} content strip error: {e_c}",
                            flush=True,
                        )
                try:
                    resources = pike_page.get('/Resources')
                    if resources:
                        xobjects = resources.get('/XObject')
                        if xobjects:
                            for _name, xobj in xobjects.items():
                                try:
                                    subtype = str(xobj.get('/Subtype', ''))
                                    if '/Form' in subtype:
                                        strip_color_from_stream(
                                            xobj, _tcol, target_spot=_tspot)
                                except Exception:
                                    pass
                except Exception as e_xo:
                    logger.debug(
                        f"[STRIP_DIECUT/HOM] page={src_page_idx} XObject scan error: {e_xo}",
                        flush=True,
                    )
            except Exception as e:
                logger.debug(
                    f"[STRIP_DIECUT/HOM] page={src_page_idx} FAILED: {e}", flush=True)

        reg_rect = homogeneous_rect if homogeneous_rect is not None else trim_rect
        if cell.get('isRotated', False) and cell.get('isRotated180', False):
            _reg_rotate = 270
        elif cell.get('isRotated180', False):
            _reg_rotate = 180
        elif cell.get('isRotated', False):
            _reg_rotate = 90
        else:
            _reg_rotate = 0

        # ── Clip THEO HÌNH khuôn MASTER (chế độ ĐỒNG NHẤT) ────────────────────
        # Nhánh này trước đây không truyền out_clip → clip = chính rect ô. Nội dung
        # được co khít vào khuôn nên phần lấn ít hơn nhánh die-cut, nhưng với tem
        # tròn/đa giác xếp lồng, GÓC bbox artwork vẫn rơi vào tem bên cạnh. Dùng
        # khuôn master (đã seed vào die_items_cache) làm clip; bound = reg_rect nên
        # không bao giờ vẽ rộng hơn hành vi cũ.
        _hom_rings = None
        if shape_clip:
            _hom_die = die_items_cache.get(f"{job_id}_{src_page_idx}")
            if _hom_die and _hom_die.get('items'):
                _hom_off = (min(clip_off_x, clip_off_y)
                            if shape_clip_offset_pt is None else float(shape_clip_offset_pt))
                _hom_rings = build_die_clip_rings(
                    _hom_die['items'], _hom_die['rect'],
                    reg_rect.x0, reg_rect.y0,
                    offset_pt=_hom_off,
                    bound_rect=reg_rect,
                    is_rotated=cell.get('isRotated', False),
                    is_rotated_180=cell.get('isRotated180', False),
                    cache_key=f"hom_{job_id}_{src_page_idx}",
                )
        _hom_clip_kw = {'out_clip_path': _hom_rings} if _hom_rings else {}

        out_page.show_pdf_page(
            reg_rect, src_doc, src_page_idx,
            rotate=_reg_rotate,
            clip=homogeneous_clip, keep_proportion=True,
            mirror_x=mirror_x, mirror_y=mirror_y,
            **_hom_clip_kw,
        )
        return trim_rect, src_page_idx

    # out_clip legacy của tem bế: bleed đầy ở mép ngoài block, nửa gap ở mép trong.
    _bb = block_bbox.get((cluster_idx, cell.get('blockId', 0)))
    if output_clip is not _OUTPUT_CLIP_UNSET:
        # IMPOSE (audit 2026-09-01 §CLIPOWN.1): Bình cắt xén thường nhận quyền
        # clip đã giải theo láng giềng toàn tờ; identity block không được nới seam.
        cell_out_clip = output_clip
    elif _bb is not None and bleed_pt > 0:
        _is_left = abs(trim_rect.x0 - _bb[0]) <= 0.5
        _is_right = abs(trim_rect.x1 - _bb[2]) <= 0.5
        _is_top = abs(trim_rect.y0 - _bb[1]) <= 0.5
        _is_bottom = abs(trim_rect.y1 - _bb[3]) <= 0.5
        _cx0 = trim_rect.x0 - (bleed_pt if _is_left else clip_off_x)
        _cx1 = trim_rect.x1 + (bleed_pt if _is_right else clip_off_x)
        _cy0 = trim_rect.y0 - (bleed_pt if _is_top else clip_off_y)
        _cy1 = trim_rect.y1 + (bleed_pt if _is_bottom else clip_off_y)
        cell_out_clip = pdf_lib.Rect(_cx0, _cy0, _cx1, _cy1)
    else:
        cell_out_clip = None

    # Whole-sheet decal keeps rectangular page placement, but its internal
    # CutContour still has to be extracted once and removed from the print
    # artwork when a separate die page is requested. Do not route this mode
    # through the die-cut placement branch below: that branch aligns one
    # sticker by its die bbox, while page-sheet stays aligned by MediaBox.
    if page_sheet_mode and separate_cut_page:
        cache_key = f"{job_id}_{src_page_idx}"
        if cache_key not in die_items_cache:
            geometry_page = (
                geometry_doc[src_page_idx]
                if geometry_doc is not None
                else src_page
            )
            largest_path = find_largest_die_path(geometry_page)
            if largest_path is None:
                # [PAGE-SHEET FIX 2026-08-13] Nguyên tấm decal không bắt buộc
                # file nguồn phải có CutContour. Khi thiếu, trang logic mà người
                # dùng đang thấy chính là khuôn chữ nhật của tấm.
                from app.workers.nup_diecut import resolve_default_page_die
                largest_path = resolve_default_page_die(geometry_page)
            if largest_path:
                die_items_cache[cache_key] = {
                    'items': largest_path.get('items', []),
                    'rect': largest_path['rect'],
                    'color': largest_path.get('color', (0, 0, 0)),
                    'width': largest_path.get('width', 0.5),
                    'spot_name': largest_path.get('spot_name'),
                    'is_page_fallback': bool(largest_path.get('is_page_fallback')),
                }
            else:
                die_items_cache[cache_key] = None

        cached_cut = die_items_cache.get(cache_key)
        if (
            cached_cut
            and not cached_cut.get('is_page_fallback')
            and src_page_idx not in local_stripped_pages
        ):
            target_color = cached_cut.get('color')
            target_spot = cached_cut.get('spot_name')
            try:
                pike_page = src_doc._pdf.pages[src_page_idx]
                pike_page.contents_coalesce()
                media_box = pike_page.mediabox
                did_strip = strip_color_from_form_tree(
                    pike_page,
                    target_color,
                    target_spot=target_spot,
                    strict=True,
                    target_items=cached_cut.get('items'),
                    page_height=float(media_box[3] - media_box[1]),
                    owner_pdf=src_doc._pdf,
                )
                if not did_strip:
                    raise RuntimeError(
                        "Không tìm thấy toán tử vẽ khuôn tương ứng trong cây Form."
                    )
                local_stripped_pages.add(src_page_idx)
            except Exception as exc:
                raise RuntimeError(
                    "Không thể tách đường khuôn bế khỏi trang in "
                    f"{src_page_idx + 1}."
                ) from exc

    if is_die_cut:
        cache_key = f"{job_id}_{src_page_idx}"
        largest_path = None
        if cache_key not in diecut_geom_cache:
            _page_sized_one_dao = (
                cut_type == 'one_dao' and die_size_mode == 'page'
            )
            _off_pt = (
                float(die_offset_mm or 0) * 2.83465
                if _page_sized_one_dao else None
            )
            if _page_sized_one_dao:
                # [PAGEBOX FIX 2026-08-13] Solver 1 Dao theo trang dùng hộp
                # hiệu dụng; renderer phải clip/map đúng cùng hộp đó. Nếu vẫn lấy
                # MediaBox lớn, số tem/tờ đúng nhưng artwork bị co hoặc biến mất.
                try:
                    source_box = effective_imposition_box(src_page)
                except (AttributeError, TypeError, ValueError):
                    source_box = src_page.rect
                sx0, sy0, sx1, sy1 = (
                    float(source_box.x0), float(source_box.y0),
                    float(source_box.x1), float(source_box.y1),
                )
                tx0 = sx0 - _off_pt
                ty0 = sy0 - _off_pt
                tx1 = sx1 + _off_pt
                ty1 = sy1 + _off_pt
                largest_path = None
            else:
                largest_path = find_largest_die_path(src_page)
                if largest_path is None and cut_type == 'default':
                    from app.workers.nup_diecut import resolve_default_page_die
                    largest_path = resolve_default_page_die(
                        src_page, die_offset_mm,
                    )
                if (largest_path or {}).get('is_page_fallback'):
                    # [PAGEBOX FIX 2026-08-13] Fallback PageBox phải map chính
                    # vùng trang logic; lấy MediaBox lớn làm artwork co thành trắng.
                    try:
                        source_box = effective_imposition_box(src_page)
                    except (AttributeError, TypeError, ValueError):
                        source_box = src_page.rect
                    page_height = float(src_page.rect.height)
                    sx0 = float(source_box.x0)
                    sy0 = page_height - float(source_box.y1)
                    sx1 = float(source_box.x1)
                    sy1 = page_height - float(source_box.y0)
                else:
                    sx0, sy0, sx1, sy1 = src_page.rect
                if largest_path:
                    r = largest_path['rect']
                    tx0, ty0, tx1, ty1 = r.x0, r.y0, r.x1, r.y1
                else:
                    tx0, ty0, tx1, ty1 = src_page.trimbox

            if len(diecut_geom_cache) >= max_geom_cache:
                diecut_geom_cache.pop(next(iter(diecut_geom_cache)))
                die_items_cache.pop(next(iter(die_items_cache)), None)

            diecut_geom_cache[cache_key] = (sx0, sy0, sx1, sy1, tx0, ty0, tx1, ty1)
            if largest_path:
                die_items_cache[cache_key] = {
                    'items': largest_path.get('items', []),
                    'rect': largest_path['rect'],
                    'color': largest_path.get('color', (0, 0, 0)),
                    'width': largest_path.get('width', 0.5),
                    # spot bế THẬT của file (tên có thể lạ, ngoài danh sách chuẩn) →
                    # truyền vào strip để gỡ đúng đường bế khi tách trang khuôn.
                    'spot_name': largest_path.get('spot_name'),
                    'is_page_fallback': bool(largest_path.get('is_page_fallback')),
                }
            else:
                die_items_cache[cache_key] = None

        # Strip die-cut paths khỏi trang nguồn (để không in lên artwork khi tách trang khuôn)
        _cached_before_strip = die_items_cache.get(cache_key) or {}
        if (
            (separate_cut_page or cut_type == 'one_dao')
            and src_page_idx not in local_stripped_pages
            and not _cached_before_strip.get('is_page_fallback')
        ):
            local_stripped_pages.add(src_page_idx)
            try:
                pike_page = src_doc._pdf.pages[src_page_idx]
                pike_page.contents_coalesce()
                _cached = die_items_cache.get(cache_key)
                local_target_color = _cached.get('color') if _cached else None
                # Spot bế THẬT của file này (tên có thể lạ, ngoài danh sách chuẩn) →
                # truyền vào strip để xoá đúng đường bế kể cả file tạo sẵn đường cắt.
                local_target_spot = _cached.get('spot_name') if _cached else None
                _stripped = False
                contents = pike_page.get('/Contents')
                if contents is not None:
                    try:
                        # CHỈ dùng parser chính xác (theo màu bế + tên kênh spot chuẩn).
                        # ĐÃ BỎ regex _PAT_A/_PAT_B: chúng xoá mọi khối q..CS..Q nên cắt
                        # nhầm cả họa tiết artwork vẽ trong colorspace đặt tên (ICCBased/
                        # Separation) → mất nét thiết kế (audit bảo toàn nội dung 2026-07-07).
                        if strip_color_from_stream(pike_page, local_target_color, target_spot=local_target_spot):
                            _stripped = True
                    except Exception as e_c:
                        logger.debug(f"[STRIP_DIECUT] page={src_page_idx} content strip error: {e_c}", flush=True)
                try:
                    import pikepdf
                    resources = pike_page.get('/Resources')
                    if resources:
                        xobjects = resources.get('/XObject')
                        if xobjects:
                            for name, xobj in xobjects.items():
                                try:
                                    xobj_resolved = xobj
                                    subtype = str(xobj_resolved.get('/Subtype', ''))
                                    if '/Form' in subtype:
                                        # Chỉ parser chính xác (đã bỏ regex quá rộng — xem trên).
                                        if strip_color_from_stream(xobj_resolved, local_target_color, target_spot=local_target_spot):
                                            _stripped = True
                                except Exception:
                                    pass
                except Exception as e_xo:
                    logger.debug(f"[STRIP_DIECUT] page={src_page_idx} XObject scan error: {e_xo}", flush=True)
            except Exception as e:
                logger.debug(f"[STRIP_DIECUT] page={src_page_idx} FAILED: {e}", flush=True)

        sx0, sy0, sx1, sy1, tx0, ty0, tx1, ty1 = diecut_geom_cache[cache_key]
        vis_w = sx1 - sx0
        vis_h = sy1 - sy0
        rel_tx0 = tx0 - sx0
        rel_ty0 = ty0 - sy0
        rel_tx1 = tx1 - sx0
        rel_ty1 = ty1 - sy0

        # target_rect map CẢ trang nguồn lên (vis = page rect), die box căn vào trim_rect
        # → nội dung NGOÀI đường bế (crop-mark, color-bar, slug ở lề MediaBox) vẽ tràn
        # quanh tem, ĐÈ tem hàng xóm khi xếp lồng sát. Clip vùng vẽ về quanh tem + bleed:
        # cell_out_clip (bleed mép ngoài block, nửa gap mép trong) hoặc bleed_rect (fallback).
        # out_clip chỉ giới hạn vùng trên trang ĐÍCH, KHÔNG đổi scale/vị trí → hình học giữ
        # nguyên (audit bảo toàn nội dung 2026-07-07). GIỚI HẠN: clip là bbox chữ nhật, tem
        # hình lồng phức tạp vẫn có thể chồng nhẹ ở vùng bleed — nhưng marks/slug ở xa bị loại hẳn.
        _die_clip = resolve_die_output_clip(
            trim_rect, bleed_rect, cell_out_clip, cut_type, die_size_mode,
        )

        # ── Clip THEO HÌNH khuôn (tem tròn/oval/đa giác xếp lồng) ──────────────
        # Rect clip ở trên chỉ chặn được chồng lấn theo trục; tem tròn/lồng có bbox
        # giao nhau dù 2 đường bế còn cách đủ gap → vẫn đè. Dựng clip = polygon
        # đường bế nở `shape_clip_offset_pt` rồi GIAO với `_die_clip` (không bao giờ
        # nới rộng hơn hành vi cũ). Trả None (tem chữ nhật / không đọc được hình /
        # PRYNX_SHAPE_CLIP=0) → giữ nguyên rect clip.
        # page_sheet_mode (decal cả tờ) căn theo MediaBox, đường bế bên trong KHÔNG
        # phải biên tem → không được dùng làm clip.
        _cached_source_die = die_items_cache.get(cache_key) or {}
        _is_page_fallback = bool(_cached_source_die.get('is_page_fallback'))
        _clip_rings = None
        if shape_clip and not page_sheet_mode and not _is_page_fallback:
            _cached_die = die_items_cache.get(cache_key)
            if _cached_die and _cached_die.get('items'):
                if shape_clip_offset_pt is None:
                    # Bù xén an toàn: nở đều tối đa NỬA khoảng cách nhỏ nhất giữa 2
                    # khuôn (clip_off_* đã = min(gap/2, bleed)). Nở isotropic nên phải
                    # lấy min 2 trục, nếu không tem lồng vẫn chạm nhau theo đường chéo.
                    _shape_off = min(clip_off_x, clip_off_y)
                else:
                    _shape_off = float(shape_clip_offset_pt)
                _clip_rings = build_die_clip_rings(
                    _cached_die['items'], _cached_die['rect'],
                    trim_rect.x0, trim_rect.y0,
                    offset_pt=_shape_off,
                    bound_rect=_die_clip,
                    block_rect=_bb,
                    is_rotated=cell.get('isRotated', False),
                    is_rotated_180=cell.get('isRotated180', False),
                    cache_key=cache_key,
                )
        # Chỉ truyền kwarg khi thực sự có clip theo hình → luồng cũ bất biến.
        _clip_kw = {'out_clip_path': _clip_rings} if _clip_rings else {}
        _source_clip_kw = {}
        if _is_page_fallback:
            _source_clip_kw = {
                'clip': pdf_lib.Rect(sx0, sy0, sx1, sy1),
            }
        elif cut_type == 'one_dao' and die_size_mode == 'page':
            # ``show_pdf_page`` nhận clip theo hệ top-down của wrapper, trong khi
            # PageBox PDF dùng Y-up. Đổi trục Y giống resolver bình cắt xén.
            _page_h = float(src_page.rect.height)
            _source_clip_kw = {
                'clip': pdf_lib.Rect(
                    sx0, _page_h - sy1,
                    sx1, _page_h - sy0,
                ),
            }

        # [PAGEBOX CLIP FIX 2026-08-14] Fallback theo trang phải dùng cùng khung
        # nguồn logic ở mọi vị trí. Bleed lưu từ công cụ khác đang bị ẩn trên UI
        # không được làm mask của riêng tem mép block nở thêm 2 mm.
        def _resolve_placement_clip(source_target_rect):
            if not _is_page_fallback:
                return _die_clip
            gap_half_x = (
                clip_off_x
                if fallback_gap_half_x is None
                else fallback_gap_half_x
            )
            gap_half_y = (
                clip_off_y
                if fallback_gap_half_y is None
                else fallback_gap_half_y
            )
            return resolve_page_fallback_output_clip(
                trim_rect,
                source_target_rect,
                gap_half_x,
                gap_half_y,
            )

        if cell.get('isRotated', False) and cell.get('isRotated180', False):
            shift_x = trim_rect.x0 - (vis_h - rel_ty1)
            shift_y = trim_rect.y0 - rel_tx0
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_h, shift_y + vis_w)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, rotate=270, out_clip=_resolve_placement_clip(target_rect), mirror_x=mirror_x, mirror_y=mirror_y, **_source_clip_kw, **_clip_kw)
        elif cell.get('isRotated180', False):
            shift_x = trim_rect.x0 - (vis_w - rel_tx1)
            shift_y = trim_rect.y0 - (vis_h - rel_ty1)
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_w, shift_y + vis_h)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, rotate=180, out_clip=_resolve_placement_clip(target_rect), mirror_x=mirror_x, mirror_y=mirror_y, **_source_clip_kw, **_clip_kw)
        elif cell.get('isRotated', False):
            shift_x = trim_rect.x0 - rel_ty0
            shift_y = trim_rect.y0 - (vis_w - rel_tx1)
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_h, shift_y + vis_w)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, rotate=90, out_clip=_resolve_placement_clip(target_rect), mirror_x=mirror_x, mirror_y=mirror_y, **_source_clip_kw, **_clip_kw)
        else:
            shift_x = trim_rect.x0 - rel_tx0
            shift_y = trim_rect.y0 - rel_ty0
            target_rect = pdf_lib.Rect(shift_x, shift_y, shift_x + vis_w, shift_y + vis_h)
            out_page.show_pdf_page(target_rect, src_doc, src_page_idx, out_clip=_resolve_placement_clip(target_rect), mirror_x=mirror_x, mirror_y=mirror_y, **_source_clip_kw, **_clip_kw)
    else:
        if cell.get('isRotated', False) and cell.get('isRotated180', False):
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, rotate=270, clip=guillotine_source_clip, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        elif cell.get('isRotated180', False):
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, rotate=180, clip=guillotine_source_clip, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        elif cell.get('isRotated', False):
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, rotate=90, clip=guillotine_source_clip, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)
        else:
            out_page.show_pdf_page(bleed_rect, src_doc, src_page_idx, clip=guillotine_source_clip, out_clip=cell_out_clip, mirror_x=mirror_x, mirror_y=mirror_y)

    return trim_rect, src_page_idx


@dataclass(frozen=True, slots=True)
class ManifestArtworkPlacement:
    """Input scalar bất biến cho đúng một artwork side của manifest."""

    instance_id: str
    part_id: str
    sheet_index: int
    side: str
    placement_revision: str
    locator_id: str
    source_revision: str
    reference_point_mm: tuple[float, float]
    pose: PoseMm
    sheet_frame: Affine2D
    page_binding: ManifestPageBinding
    artwork_clip_path: FrozenManifestPolygon


@dataclass(frozen=True, slots=True)
class ManifestPlacementIdentity:
    """Phần occurrence của placement, parse một lần trước render hoặc dedup."""

    instance_id: str
    part_id: str
    sheet_index: int
    source_revision: str
    pose: PoseMm


def _identity(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or any(ord(char) < 32 for char in value):
        raise ManifestArtworkContractError(f"{field} không phải định danh hợp lệ.")
    return value


def _index(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ManifestArtworkContractError(f"{field} không phải số nguyên không âm.")
    return value


def parse_manifest_placement_identity(
    placement: Mapping[str, Any], *, render_bundle_hash: str
) -> ManifestPlacementIdentity:
    """Parse exact schema của mọi occurrence trước cả dedup lẫn render.

    FIX/PARITY (audit 2026-08-29 §MAP-NEST-09): placement bị gộp vẫn phải
    qua cùng parser production; field thừa hoặc pose sai không được biến mất cùng
    duplicate và tạo ra artifact tưởng như hợp lệ.
    """

    if not isinstance(placement, Mapping) or set(placement) != {
        "instanceId", "partId", "sheetIndex", "pose", "sourceRevision"
    }:
        raise ManifestArtworkContractError("placement không đúng schema manifest.")
    bundle_hash = _identity(render_bundle_hash, "renderBundleHash")
    source_revision = _identity(
        placement["sourceRevision"], "placement.sourceRevision"
    )
    if source_revision != bundle_hash:
        raise ManifestArtworkContractError(
            "placement.sourceRevision không khớp renderBundleHash."
        )
    try:
        pose = parse_pose_mm(placement["pose"])
    except AffineContractError as exc:
        raise ManifestArtworkContractError(str(exc)) from exc
    return ManifestPlacementIdentity(
        instance_id=_identity(placement["instanceId"], "placement.instanceId"),
        part_id=_identity(placement["partId"], "placement.partId"),
        sheet_index=_index(placement["sheetIndex"], "placement.sheetIndex"),
        source_revision=source_revision,
        pose=pose,
    )


def resolve_manifest_artwork_placement(
    *,
    placement: Mapping[str, Any],
    part: Mapping[str, Any],
    sheet_frame: Sequence[Any],
    side: str,
    render_bundle_hash: str,
) -> ManifestArtworkPlacement:
    """Đóng băng seam manifest → writer và chặn mọi identity mâu thuẫn."""

    if not isinstance(placement, Mapping) or set(placement) != {
        "instanceId", "partId", "sheetIndex", "pose", "sourceRevision"
    }:
        raise ManifestArtworkContractError("placement không đúng schema manifest.")
    if not isinstance(part, Mapping):
        raise ManifestArtworkContractError("part không phải object RenderBundle.")
    expected_part_fields = {
        "partId",
        "referencePointMm",
        "geometryHash",
        "packingFootprint",
        "cutContour",
        "artworkClipPath",
        "source",
        "pages",
    }
    # RenderBundle V2 mới có metadata report server-owned; V2 cũ chưa có vẫn đọc
    # được. Field này không tham gia phép biến đổi artwork.
    if "dieDimensionsMm" in part:
        expected_part_fields.add("dieDimensionsMm")
    if set(part) != expected_part_fields:
        raise ManifestArtworkContractError("part không đúng schema RenderBundle V2.")
    placement_identity = parse_manifest_placement_identity(
        placement,
        render_bundle_hash=render_bundle_hash,
    )
    if placement_identity.part_id != _identity(part["partId"], "part.partId"):
        raise ManifestArtworkContractError("placement.partId không khớp RenderBundle.")
    bundle_hash = placement_identity.source_revision
    if side not in {"front", "back", "cut"}:
        raise ManifestArtworkContractError("side chỉ nhận front/back/cut.")
    pages = part["pages"]
    if not isinstance(pages, Mapping) or set(pages) != {"front", "back", "cut"}:
        raise ManifestArtworkContractError("part.pages không đúng schema V2.")
    raw_binding = pages[side]
    if raw_binding is None:
        raise ManifestArtworkContractError(f"part.pages.{side} không tồn tại.")
    source = part["source"]
    if not isinstance(source, Mapping) or set(source) != {
        "locatorId", "contentHash", "byteSize", "pageCount", "revision"
    }:
        raise ManifestArtworkContractError("part.source không đúng schema V2.")
    if source["revision"] != source["contentHash"]:
        raise ManifestArtworkContractError("source.revision không khớp contentHash.")
    reference_point = parse_point_mm(
        part["referencePointMm"], field="part.referencePointMm"
    )
    clip = part["artworkClipPath"]
    try:
        # Tách mapping mutable khỏi StoredNestingManifest ngay tại seam.
        frozen_clip = freeze_manifest_polygon(clip, field="part.artworkClipPath")
    except ValueError as exc:
        raise ManifestArtworkContractError(str(exc)) from exc
    return ManifestArtworkPlacement(
        instance_id=placement_identity.instance_id,
        part_id=placement_identity.part_id,
        sheet_index=placement_identity.sheet_index,
        side=side,
        placement_revision=bundle_hash,
        locator_id=_identity(source["locatorId"], "source.locatorId"),
        source_revision=_identity(source["revision"], "source.revision"),
        reference_point_mm=reference_point,
        pose=placement_identity.pose,
        sheet_frame=Affine2D.from_sequence(sheet_frame, field="sheetFrame"),
        page_binding=ManifestPageBinding.from_mapping(
            raw_binding, field=f"part.pages.{side}"
        ),
        artwork_clip_path=frozen_clip,
    )


def manifest_artwork_render_ctm_mm(
    placement: ManifestArtworkPlacement,
) -> Affine2D:
    """Dựng đúng ``SheetFrame · G · SourcePageToCanonical`` cho artwork."""

    if not isinstance(placement, ManifestArtworkPlacement):
        raise ManifestArtworkContractError(
            "placement phải là ManifestArtworkPlacement đã resolve."
        )
    return compose_render_ctm_mm(
        sheet_frame=placement.sheet_frame,
        pose=placement.pose,
        reference_point_mm=placement.reference_point_mm,
        source_page_to_canonical=placement.page_binding.source_page_to_canonical,
    )


def render_manifest_artwork(
    destination_pdf,
    destination_page,
    source_path: str,
    placement: ManifestArtworkPlacement,
    *,
    form_variant: str = "artwork-raw",
    die_filter=None,
) -> PaintedManifestForm:
    """Render một placement manifest; không solve/finalize/fallback tại exporter."""

    if placement.side == "cut":
        raise ManifestArtworkContractError(
            "CUT phải đi writer vector riêng, không được paint như artwork."
        )
    clip_rings = build_manifest_clip_rings(
        placement.artwork_clip_path,
        sheet_frame=placement.sheet_frame,
        pose=placement.pose,
        reference_point_mm=placement.reference_point_mm,
    )
    return paint_manifest_page_form(
        destination_pdf,
        destination_page,
        source_path=source_path,
        locator_id=placement.locator_id,
        source_revision=placement.source_revision,
        binding=placement.page_binding,
        form_variant=form_variant,
        render_ctm_mm=manifest_artwork_render_ctm_mm(placement),
        clip_rings_output_mm=clip_rings,
        die_filter=die_filter,
    )


def transform_die_point(px, py, die_rect, abs_x, abs_y, is_rotated=False, is_rotated_180=False):
    """NGUỒN CHÂN LÝ DUY NHẤT cho phép biến đổi 1 điểm đường bế (vị trí + xoay).

    Dùng CHUNG bởi: draw_die_lines_for_placement (render file xuất) và preview
    (/preview-layout) → preview KHÔNG reimplement hình học → không thể lệch output.

    Toạ độ vào (px,py) theo hệ trang nguồn; ra theo hệ trang đích TOP-DOWN mà
    cut_shape/show_pdf_page tiêu thụ (y0 nhỏ = TRÊN).
    """
    if is_rotated and is_rotated_180:
        return (abs_x + (die_rect.y1 - py), abs_y + px - die_rect.x0)
    elif is_rotated_180:
        return (abs_x + (die_rect.x1 - px), abs_y + (die_rect.y1 - py))
    elif is_rotated:
        return (abs_x + (py - die_rect.y0), abs_y + (die_rect.x1 - px))
    else:
        return (abs_x + (px - die_rect.x0), abs_y + (py - die_rect.y0))


def die_polylines_for_placement(die_items, die_rect, abs_x, abs_y,
                                is_rotated=False, is_rotated_180=False, bezier_steps=10):
    """Trả list polyline (mỗi polyline = list điểm [x,y] toạ độ trang đích TOP-DOWN),
    dùng CHÍNH transform_die_point như render file xuất. Bezier được lấy mẫu thành
    đoạn thẳng để frontend chỉ việc vẽ polyline (không cần engine bezier)."""
    def T(px, py):
        return list(transform_die_point(px, py, die_rect, abs_x, abs_y, is_rotated, is_rotated_180))
    out = []
    for item in die_items:
        cmd = item[0]
        if cmd == 'l':
            p1 = pdf_lib.Point(item[1]); p2 = pdf_lib.Point(item[2])
            out.append([T(p1.x, p1.y), T(p2.x, p2.y)])
        elif cmd == 'c':
            pts = [pdf_lib.Point(item[i]) for i in range(1, 5)]
            samp = []
            for k in range(bezier_steps + 1):
                t = k / bezier_steps; mt = 1 - t
                bx = mt**3*pts[0].x + 3*mt*mt*t*pts[1].x + 3*mt*t*t*pts[2].x + t**3*pts[3].x
                by = mt**3*pts[0].y + 3*mt*mt*t*pts[1].y + 3*mt*t*t*pts[2].y + t**3*pts[3].y
                samp.append(T(bx, by))
            out.append(samp)
        elif cmd == 're':
            r = pdf_lib.Rect(item[1])
            out.append([T(r.x0, r.y0), T(r.x1, r.y0), T(r.x1, r.y1), T(r.x0, r.y1), T(r.x0, r.y0)])
        elif cmd == 'qu':
            quad = item[1]
            qp = [pdf_lib.Point(quad.ul), pdf_lib.Point(quad.ur),
                  pdf_lib.Point(quad.lr), pdf_lib.Point(quad.ll)]
            out.append([T(p.x, p.y) for p in qp] + [T(qp[0].x, qp[0].y)])

    # ── [DIE-GEO] Log hình học đường bế PREVIEW (toạ độ cuối) để so với file bế xuất.
    try:
        from app.workers.rot_audit_log import get_logger as _rg
        _pts = [pt for pl in out for pt in pl]
        if _pts:
            _xs = [p[0] for p in _pts]; _ys = [p[1] for p in _pts]
            _rg().warning(
                "[DIE-GEO][PREVIEW] abs=(%.1f,%.1f) die_rect=(%.1f,%.1f,%.1f,%.1f) rot90=%d rot180=%d "
                "n_pl=%d bbox=(%.1f,%.1f,%.1f,%.1f)",
                abs_x, abs_y, die_rect.x0, die_rect.y0, die_rect.x1, die_rect.y1,
                int(is_rotated), int(is_rotated_180), len(out),
                min(_xs), min(_ys), max(_xs), max(_ys),
            )
    except Exception:
        pass
    return out


def draw_die_lines_for_placement(
    cut_shape,
    die_items,
    die_rect,
    abs_x,
    abs_y,
    is_rotated=False,
    is_rotated_180=False,
):
    """Vẽ đường bế của MỘT ô lên `cut_shape`, transform theo vị trí + xoay.

    Dùng CHUNG transform_die_point với preview (/preview-layout) → một nguồn chân lý.
    Caller tự gọi cut_shape.finish/commit.
    """
    def _T(px, py):
        x, y = transform_die_point(px, py, die_rect, abs_x, abs_y, is_rotated, is_rotated_180)
        return pdf_lib.Point(x, y)

    # ── [DIE-GEO] Log hình học đường bế RENDER (file bế xuất) — CÙNG toạ độ với PREVIEW?
    try:
        from app.workers.rot_audit_log import get_logger as _rg
        _pls = die_polylines_for_placement(die_items, die_rect, abs_x, abs_y, is_rotated, is_rotated_180)
        _pts = [pt for pl in _pls for pt in pl]
        if _pts:
            _xs = [p[0] for p in _pts]; _ys = [p[1] for p in _pts]
            _rg().warning(
                "[DIE-GEO][RENDER] abs=(%.1f,%.1f) die_rect=(%.1f,%.1f,%.1f,%.1f) rot90=%d rot180=%d "
                "n_pl=%d bbox=(%.1f,%.1f,%.1f,%.1f)",
                abs_x, abs_y, die_rect.x0, die_rect.y0, die_rect.x1, die_rect.y1,
                int(is_rotated), int(is_rotated_180), len(_pls),
                min(_xs), min(_ys), max(_xs), max(_ys),
            )
    except Exception:
        pass

    for item in die_items:
        cmd = item[0]

        if cmd == 'l':  # line: (cmd, p1, p2)
            p1 = pdf_lib.Point(item[1])
            p2 = pdf_lib.Point(item[2])
            cut_shape.draw_line(_T(p1.x, p1.y), _T(p2.x, p2.y))

        elif cmd == 'c':  # cubic bezier: (cmd, p1, p2, p3, p4)
            pts = [pdf_lib.Point(item[i]) for i in range(1, 5)]
            transformed = [_T(pt.x, pt.y) for pt in pts]
            cut_shape.draw_bezier(transformed[0], transformed[1], transformed[2], transformed[3])

        elif cmd == 're':  # rect: (cmd, rect) — dựng lại từ 4 góc đã transform (bằng KQ cũ)
            r = pdf_lib.Rect(item[1])
            corners = [_T(r.x0, r.y0), _T(r.x1, r.y0), _T(r.x1, r.y1), _T(r.x0, r.y1)]
            xs = [c.x for c in corners]; ys = [c.y for c in corners]
            cut_shape.draw_rect(pdf_lib.Rect(min(xs), min(ys), max(xs), max(ys)))

        elif cmd == 'qu':  # quad: (cmd, Quad(ul, ur, ll, lr))
            quad = item[1]
            quad_pts = [pdf_lib.Point(quad.ul), pdf_lib.Point(quad.ur),
                        pdf_lib.Point(quad.lr), pdf_lib.Point(quad.ll)]
            transformed = [_T(pt.x, pt.y) for pt in quad_pts]
            for qi in range(4):
                cut_shape.draw_line(transformed[qi], transformed[(qi + 1) % 4])
