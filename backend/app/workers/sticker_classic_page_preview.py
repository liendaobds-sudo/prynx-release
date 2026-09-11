"""Preview toàn trang classic từ lệnh CUT của chính engine xuất PDF.

QUALITY (2026-09-10 §CUTPREVIEW.MULTI): không fit riêng từng instance Alpha,
không sửa nhãn để ép nhiều mảng thành một tem. PDFium chạy trong process riêng.
"""
from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from io import BytesIO
import hashlib
import json
import math
import multiprocessing
from pathlib import Path
from copy import deepcopy
import threading

import pikepdf

from app.core.sticker_sheet_session import StickerSheetSessionConflict
from app.workers.sticker_sheet_export import StickerSheetExportError
from app.workers.cutline_simplify_memo import simplify_memo_scope, current_simplify_memo
from app.workers.cutline_preview_cancel import (
    PreviewCancellation, cancellation_scope, current_cancellation, check_preview_cancelled,
)


_classic_preview_pool_lock = threading.Lock()
_classic_preview_pool = None
_classic_baseline_cache = {}


def _render_cancellation_options():
    """Chỉ truyền tên cờ hủy tin cậy sang process; không đưa vào khóa hình học."""
    check_preview_cancelled()
    token = current_cancellation()
    return {"cancellation_name": token.export_shared_name()} if token is not None else {}


def _new_classic_preview_pool():
    """Tạo pool cách ly PDFium dùng chung cho các lượt preview trong sidecar."""
    return ProcessPoolExecutor(
        max_workers=1, mp_context=multiprocessing.get_context("spawn"),
    )


def _discard_classic_preview_pool(pool):
    try:
        pool.shutdown(wait=False, cancel_futures=True)
    except Exception:  # noqa: BLE001
        pass


def _submit_ephemeral_classic_page_render(source_path, page_number, preview_size, geometry):
    """Fallback khi hệ điều hành không cho sidecar giữ pipe process lâu dài."""
    with ProcessPoolExecutor(
            max_workers=1, mp_context=multiprocessing.get_context("spawn")) as pool:
        return pool.submit(
            _render_classic_page, source_path, page_number, preview_size, geometry, True,
            **_render_cancellation_options(),
        ).result()


def reset_classic_preview_pool():
    """Thu hồi worker preview (dùng khi sidecar tắt hoặc test cần dọn state)."""
    global _classic_preview_pool
    with _classic_preview_pool_lock:
        pool, _classic_preview_pool = _classic_preview_pool, None
    if pool is not None:
        _discard_classic_preview_pool(pool)
    _classic_baseline_cache.clear()


def _pdf_cut_path_groups(page):
    """Đọc CUT đã bake thành các ring cubic local-crop, không đụng artwork."""
    active = False
    rings = []
    current = []
    start = None
    cursor = None
    for operands, operator in pikepdf.parse_content_stream(page):
        op = str(operator)
        if op == "CS":
            active = str(operands[0]) == "/CutContour"
        elif active and op == "m":
            if current:
                rings.append(current)
            start = (float(operands[0]), float(operands[1]))
            cursor = start
            current = []
        elif active and op == "l" and cursor is not None:
            following = (float(operands[0]), float(operands[1]))
            current.append((cursor, cursor, following, following))
            cursor = following
        elif active and op == "c" and cursor is not None:
            following = (float(operands[4]), float(operands[5]))
            current.append((cursor,
                            (float(operands[0]), float(operands[1])),
                            (float(operands[2]), float(operands[3])),
                            following))
            cursor = following
        elif active and op == "h" and current:
            if cursor != start:
                current.append((cursor, cursor, start, start))
            rings.append(current)
            current = []
            cursor = None
        elif active and op in {"S", "s", "Q"}:
            active = False
    if current:
        rings.append(current)
    return [{"exterior": ring} for ring in rings if ring]


def _cut_groups_svg(groups, width_pt, height_pt, preview_width, preview_height):
    """Đổi cubic CUT local-crop thành SVG mà không ghi lại PDF trung gian."""
    sx, sy = preview_width / width_pt, preview_height / height_pt

    def point(x, y):
        return f"{float(x) * sx:.8f} {(height_pt - float(y)) * sy:.8f}"

    commands = []
    count = 0
    for group in groups:
        for ring in [group["exterior"], *(group.get("interiors") or [])]:
            if not ring:
                continue
            commands.append("M " + point(*ring[0][0]))
            for curve in ring:
                commands.append("C " + " ".join(
                    point(*curve[index]) for index in (1, 2, 3)
                ))
                count += 1
            commands.append("Z")
    if not commands or not count:
        raise StickerSheetExportError("Trang không có đường bế để xem trước.")
    return " ".join(commands), count


def _classic_baseline_key(source_path, page_number, geometry, width, height):
    from app.workers.cutline_cubic_simplify import CUTLINE_SIMPLIFY_ALGORITHM
    stat = Path(source_path).stat()
    # PERF/QUALITY (audit 2026-09-11 §SIMPLIFY.BASELINE-CACHE): stat giúp
    # loại nhanh file không đổi; digest vẫn là chốt để không dùng CUT cũ khi
    # file bị thay nội dung nhưng giữ nguyên kích thước/thời gian.
    with open(source_path, "rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    return json.dumps({"source": str(source_path), "digest": digest,
                       "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
                       "page": page_number,
                       "geometry": geometry, "box": [width, height],
                       "pipeline": "canonical-engine-v1", "algorithm": CUTLINE_SIMPLIFY_ALGORITHM},
                      sort_keys=True, allow_nan=False, default=str)


def _submit_classic_page_render(source_path, page_number, preview_size, geometry):
    """Gửi render vào worker giữ sẵn, fallback pool tạm cho test/injection.

    PDFium vẫn nằm trong process riêng; chỉ bỏ chi phí spawn lặp lại giữa các
    trang/lượt preview. Pool chết được thu hồi và dựng lại đúng một lần.
    """
    # Test doubles và caller thay factory vẫn giữ semantics context manager cũ,
    # tránh để worker giả của test lọt vào state dùng chung giữa các test.
    factory_module = getattr(ProcessPoolExecutor, "__module__", "")
    if not factory_module.startswith("concurrent.futures"):
        return _submit_ephemeral_classic_page_render(
            source_path, page_number, preview_size, geometry,
        )

    global _classic_preview_pool
    with _classic_preview_pool_lock:
        if _classic_preview_pool is None:
            try:
                _classic_preview_pool = _new_classic_preview_pool()
            except OSError:
                # Một số môi trường sandbox chặn named pipe; không làm mất
                # preview, chỉ bỏ lợi ích warm-pool ở đúng môi trường đó.
                return _submit_ephemeral_classic_page_render(
                    source_path, page_number, preview_size, geometry,
                )
        pool = _classic_preview_pool
    try:
        return pool.submit(
            _render_classic_page, source_path, page_number, preview_size, geometry, True,
            **_render_cancellation_options(),
        ).result()
    except BrokenProcessPool:
        with _classic_preview_pool_lock:
            if _classic_preview_pool is pool:
                _classic_preview_pool = None
        _discard_classic_preview_pool(pool)
        with _classic_preview_pool_lock:
            try:
                if _classic_preview_pool is None:
                    _classic_preview_pool = _new_classic_preview_pool()
            except OSError:
                return _submit_ephemeral_classic_page_render(
                    source_path, page_number, preview_size, geometry,
                )
            replacement = _classic_preview_pool
        return replacement.submit(
            _render_classic_page, source_path, page_number, preview_size, geometry, True,
            **_render_cancellation_options(),
        ).result()


def _pdf_cut_operations(page):
    """Lệnh CUT local-crop do writer sinh; không lấy artwork/Form làm đường bế.

    Translation bù xén nằm TRƯỚC /CutContour CS và không thuộc tọa độ local.
    SVG về trang nguồn, do đó không cộng translation mở rộng trang xuất.
    """
    active, commands, count, closed = False, [], 0, True
    for operands, operator in pikepdf.parse_content_stream(page):
        op = str(operator)
        if op == "CS":
            active = str(operands[0]) == "/CutContour"
        elif active:
            if op == "m":
                if not closed:
                    raise StickerSheetExportError("Đường bế toàn trang có vòng chưa kín.")
                commands.append(("M", tuple(map(float, operands))))
                closed = False
            elif op == "l":
                commands.append(("L", tuple(map(float, operands))))
                count += 1
            elif op == "c":
                commands.append(("C", tuple(map(float, operands))))
                count += 1
            elif op == "h":
                commands.append(("Z", ()))
                closed = True
            elif op in {"S", "s", "Q"}:
                if op == "s":
                    commands.append(("Z", ()))
                    closed = True
                if not closed:
                    raise StickerSheetExportError("Đường bế toàn trang có vòng chưa kín.")
                active = False
            elif op not in {"SCN", "w", "J", "j", "M", "d"}:
                raise StickerSheetExportError("Không đọc được hệ tọa độ đường bế toàn trang.")
    if not commands or not count or not closed:
        raise StickerSheetExportError("Trang không có đường bế để xem trước.")
    return commands, count


def _cut_operations_svg(operations, width_pt, height_pt, preview_width, preview_height):
    """Chỉ đổi tỉ lệ hiển thị; giữ nguyên lệnh L/C và cấu trúc lỗ của writer."""
    sx, sy = preview_width / width_pt, preview_height / height_pt
    commands = []
    for operator, values in operations:
        points = [f"{values[i]*sx:.8f} {(height_pt-values[i+1])*sy:.8f}"
                  for i in range(0, len(values), 2)]
        commands.append(" ".join([operator, *points]))
    return " ".join(commands)


def _pdf_cut_svg(page, width_pt, height_pt, preview_width, preview_height):
    operations, count = _pdf_cut_operations(page)
    return _cut_operations_svg(operations, width_pt, height_pt, preview_width, preview_height), count


def _render_canonical_classic_page(source_path, page_number, preview_size, geometry):
    """Điểm vào process: cùng tham số/cùng writer với Thực thi classic."""
    check_preview_cancelled()
    from app.workers.sticker_engine import StickerEngine, _page_defines_cut_contour

    with pikepdf.Pdf.open(source_path) as document:
        source = document.pages[page_number-1]
        if _page_defines_cut_contour(source):
            raise StickerSheetExportError("Trang có CutContour sẵn không dùng preview Alpha toàn trang.")
        box = list(map(float, source.cropbox))
        width, height = box[2]-box[0], box[3]-box[1]
    if min(width, height, *preview_size) <= 0 or not all(map(math.isfinite, (width, height))):
        raise StickerSheetExportError("Kích thước trang xem trước không hợp lệ.")
    requested_simplify = float(geometry.get("cutline_simplify_mm", 0.0) or 0.0)
    baseline_key = _classic_baseline_key(
        source_path, page_number, geometry, width, height,
    )
    from app.workers.sticker_cutline_preview import _preview_cache_limit, _remember_preview
    # PERF (audit 2026-09-11 §SIMPLIFY.CACHE): cache chỉ giữ lệnh CUT và memo
    # của tài liệu hiện tại, không giữ artwork/PDF hoặc tích lũy các file đã đóng.
    identity = (str(source_path), source_digest(source_path))
    if _classic_baseline_cache.get("source") != identity:
        _classic_baseline_cache.clear()
        _classic_baseline_cache.update(source=identity, entries={})
    entries = _classic_baseline_cache["entries"]
    baseline = entries.get(baseline_key)
    if baseline is None:
        # CUT đã đọc ngược từ PDF là tọa độ Y-up, .4f; Simplify riêng trên nó
        # không khớp frame/nhánh góc của Execute. Dùng chính engine xuất và thu
        # memo trước writer; cache nóng bỏ solver mà không đổi quỹ đạo.
        with simplify_memo_scope() as memo:
            result = StickerEngine(dpi=300).process_pdf(
                input_path=source_path, output_path="", _page_subset=[page_number-1],
                remove_white_bg=True, draw_cut_contour=True, alpha_corner_policy="adaptive",
                **geometry,
            )
        if not isinstance(result[0], bytes):
            raise StickerSheetExportError("Không dựng được đường bế toàn trang.")
        with pikepdf.Pdf.open(BytesIO(result[0])) as document:
            operations, count = _pdf_cut_operations(document.pages[0])
        quality = {"segment_count": count, "fit_mode": "classic-whole-page"}
        if requested_simplify > 0:
            stats = next((item.get("cutline_simplification") for item in result[1]
                          if isinstance(item, dict) and item.get("cutline_simplification")), None)
            if stats is None:
                summaries = [item["stats"] for item in memo.values()]
                stats = {
                    "before_segments": sum(item["before_segments"] for item in summaries) if summaries else count,
                    "after_segments": count,
                    "maximum_error_bound_mm": max((item["maximum_error_bound_mm"] for item in summaries), default=0.0),
                    "changed": any(item["changed"] for item in summaries),
                }
            quality["simplification"] = deepcopy(stats)
        baseline = {
            "operations": operations, "count": count,
            "quality": quality, "memo": deepcopy(memo),
        }
    check_preview_cancelled()
    _remember_preview(entries, baseline_key, baseline, _preview_cache_limit())
    outer_memo = current_simplify_memo()
    if outer_memo is not None:
        outer_memo.update(deepcopy(baseline["memo"]))
    svg = _cut_operations_svg(baseline["operations"], width, height, *preview_size)
    return svg, baseline["count"], deepcopy(baseline["quality"])


def _render_classic_page(source_path, page_number, preview_size, geometry, collect_memo=False,
                         cancellation_name=None):
    """Worker gắn cùng cờ hủy của job cha, luôn nhả handle trước khi trả kết quả."""
    # PERF (audit 2026-09-11 §PREWARM.CANCEL): không kill pool nóng và không
    # hạ chất lượng. Cancellation là luồng điều khiển, không phải một tùy chọn CUT.
    attached = PreviewCancellation.attach(cancellation_name) if cancellation_name else None
    try:
        with cancellation_scope(attached if attached is not None else current_cancellation()):
            check_preview_cancelled()
            return _render_classic_page_scoped(source_path, page_number, preview_size, geometry, collect_memo)
    finally:
        if attached is not None:
            attached.close()


def _render_classic_page_scoped(source_path, page_number, preview_size, geometry, collect_memo=False):
    """Cùng bước bake Rotate/UserUnit với route Thực thi trước khi dựng CUT."""
    from app.workers.page_space_canonicalization import canonicalize_page_space_file
    canonical, temporary = canonicalize_page_space_file(source_path, "classic-preview")
    try:
        if collect_memo:
            with simplify_memo_scope() as memo:
                result = _render_canonical_classic_page(canonical, page_number, preview_size, geometry)
                return (*result, memo)
        return _render_canonical_classic_page(canonical, page_number, preview_size, geometry)
    finally:
        if temporary:
            Path(canonical).unlink(missing_ok=True)


def source_digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def whole_page_key(digest, page_number, revision, geometry, preview_size):
    from app.workers.cutline_cubic_simplify import CUTLINE_SIMPLIFY_ALGORITHM
    geometry = {key: float(value) if isinstance(value, (int, float)) and not isinstance(value, bool)
                else value for key, value in geometry.items()}
    return hashlib.sha256(json.dumps({"mode": "whole-page-memo-v1", "source": digest,
        "page": page_number, "revision": revision, "geometry": geometry,
        "preview_size": preview_size, "algorithm": CUTLINE_SIMPLIFY_ALGORITHM,
        "pipeline": "canonical-engine-v1"},
        sort_keys=True, allow_nan=False).encode()).hexdigest()


def build_classic_page_preview(session, *, page_number, base_revision, edits,
                               classic_force_contour=False, **options):
    """Không ghi canonical cache từng tem; xuất classic dùng cùng engine này."""
    check_preview_cancelled()
    page = session.pages.get(page_number)
    if page is None or session.source_kind != "pdf":
        raise StickerSheetSessionConflict("Không tìm thấy trang PDF để xem đường bế.")
    with page.operation_lock:
        check_preview_cancelled()
        if (page.stage not in {"mask-review", "mask-ready"}
                or int(page.manifest.get("mask_revision", 0)) != base_revision):
            raise StickerSheetSessionConflict("Trang đã thay đổi; hãy chờ xem trước cập nhật.")
        if page.boundary_source != "alpha" or edits:
            raise StickerSheetExportError("Preview toàn trang chỉ nhận PDF Alpha gốc, chưa sửa mask.")
        keys = ("offset_mm", "bleed_mm", "cut_mode", "corner_style", "fill_holes",
                "cutline_smoothness", "cutline_fidelity", "curve_tension",
                "min_detail_area_mm2", "cutline_denoise", "cutline_simplify_mm")
        geometry = {key: options[key] for key in keys}
        geometry["shape_mode"] = "contour" if classic_force_contour else "auto_safe"
        if geometry["cutline_denoise"] is None:
            geometry["cutline_denoise"] = 0.0
        preview_size = (int(page.preview_width_px), int(page.preview_height_px))
        digest = source_digest(session.source_path)
        key = whole_page_key(digest, page_number, base_revision, geometry, preview_size)
        history = getattr(page, "_classic_preview_history", None)
        identity = (digest, page_number, base_revision)
        if not isinstance(history, dict) or history.get("identity") != identity:
            history = {"identity": identity, "entries": {}}
            page._classic_preview_history = history
        cached = getattr(page, "cutline_export_cache", None)
        if isinstance(cached, dict) and cached.get("kind") == "whole-page-memo-v1" and cached.get("key") == key:
            return deepcopy(cached["preview"])
        cached = history["entries"].get(key)
        if cached is not None:
            page.cutline_export_cache = deepcopy(cached)
            return deepcopy(cached["preview"])
        # Một request chỉ dựng MỘT trang, nên có đúng một công việc process;
        # worker giữ sẵn để không spawn lại khi user lướt sang trang kế tiếp.
        rendered = _submit_classic_page_render(
            str(session.source_path), page_number, preview_size, geometry,
        )
        check_preview_cancelled()
        svg, count, quality = rendered[:3]
        memo = rendered[3] if len(rendered) == 4 else {}
        if source_digest(session.source_path) != digest:
            raise StickerSheetSessionConflict("File nguồn đã đổi trong lúc tạo preview.")
        fingerprint = hashlib.sha256(json.dumps({
            "mode": "classic-whole-page-v1", "page": page_number, "revision": base_revision,
            "geometry": geometry, "path": svg, "key": key,
        }, sort_keys=True, allow_nan=False).encode()).hexdigest()
        result = {
            "classic_whole_page": True,
            "page_number": page_number, "mask_revision": base_revision,
            "preview_width_px": page.preview_width_px, "preview_height_px": page.preview_height_px,
            "paths": [{"instance_id": 1, "d": svg, "segment_count": count, "quality": quality}],
            "fingerprint": fingerprint, "segment_count": count, "quality": quality,
        }
        # PERF (audit 2026-09-10 §SIMPERF.3): một artifact mới nhất/trang,
        # chung lifetime session; gồm cả no-op, không ghi cache geometry ra đĩa.
        page.cutline_export_cache = {"kind": "whole-page-memo-v1", "key": key,
            "source_digest": digest, "geometry": deepcopy(geometry),
            "revision": base_revision, "page_number": page_number,
            "memo": deepcopy(memo), "preview": deepcopy(result)}
        # Artifact còn được UI giữ fingerprint phải sống cùng revision/session.
        # RAM-gating chỉ loại working-set tùy chọn trong process render, không
        # làm mất tham chiếu A khi người dùng đang xem B rồi quay về A.
        history["entries"][key] = deepcopy(page.cutline_export_cache)
        return result
