"""
pdf_source.py — Dựng CutModel TỪ FILE PDF ĐÃ BÌNH (nguồn hình học thật).

Đây là mảnh nối để nút "Gửi Máy Bế" có dữ liệu cắt thật:
  output PDF (mỗi trang = 1 tờ) → extract_page_die_cut_polygon (Shapely, pt)
  → đổi pt→mm (gốc dưới-trái) → CutModel.

CHỈ ĐỌC `nup_diecut.extract_page_die_cut_polygon` và `pdf_wrapper` — không sửa.
Requirements: 1.1, 1.4 (giữ vị trí), 6.3 (cùng hệ toạ độ với bản in).
"""

from __future__ import annotations

import hashlib
import os
from typing import Optional

from app.workers.cut_export.cut_model import CutModel
from app.workers.cut_export.cut_model_builder import build_cut_model

PT_TO_MM = 25.4 / 72.0
_HASH_CHUNK_BYTES = 1024 * 1024


def _hash_open_stream(source) -> tuple[str, int]:
    """Băm toàn bộ stream đang mở và trả ``(sha256, số byte)``."""
    source.seek(0)
    digest = hashlib.sha256()
    hashed_size = 0
    while True:
        chunk = source.read(_HASH_CHUNK_BYTES)
        if not chunk:
            break
        digest.update(chunk)
        hashed_size += len(chunk)
    return digest.hexdigest(), hashed_size


def _polygon_to_mm_geometries(poly) -> list[list[tuple[float, float]]]:
    """Shapely Polygon/MultiPolygon (pt) → danh sách polyline (mm, gốc dưới-trái).

    Toạ độ content-stream PDF đã là gốc dưới-trái, Y lên → chỉ scale pt→mm.
    """
    rings: list[list[tuple[float, float]]] = []
    geoms = getattr(poly, "geoms", None)
    if geoms is not None:  # MultiPolygon
        for g in geoms:
            rings.extend(_polygon_to_mm_geometries(g))
        return rings
    ext = getattr(poly, "exterior", None)
    if ext is not None:
        rings.append([(x * PT_TO_MM, y * PT_TO_MM) for x, y in list(ext.coords)])
        for interior in getattr(poly, "interiors", []):
            rings.append([(x * PT_TO_MM, y * PT_TO_MM) for x, y in list(interior.coords)])
    return rings


def cut_model_from_polygon(
    poly,
    sheet_w_pt: float,
    sheet_h_pt: float,
    pont_config: Optional[dict] = None,
) -> CutModel:
    """Dựng CutModel từ một Shapely polygon (pt) + khổ trang (pt). Thuần, test được."""
    geoms = _polygon_to_mm_geometries(poly)
    return build_cut_model(
        geoms,
        marks=[],  # TODO: trích ốc từ layer pont (giai đoạn sau) — hiện FSIZE theo khổ
        sheet_w_mm=sheet_w_pt * PT_TO_MM,
        sheet_h_mm=sheet_h_pt * PT_TO_MM,
        pont_config=pont_config,
    )


def _page_size_mm_from_pdf(pdf, page_idx: int) -> tuple[float, float]:
    """Lấy khổ trang từ PDF đang mở, không parse lại tài liệu."""
    pg = pdf.pages[page_idx]
    mb = pg.get("/MediaBox", [0, 0, 612, 792])
    w = abs(float(mb[2]) - float(mb[0])) * PT_TO_MM
    h = abs(float(mb[3]) - float(mb[1])) * PT_TO_MM
    return w, h


def _page_size_mm(path: str, page_idx: int) -> tuple[float, float]:
    """Wrapper đường dẫn giữ tương thích cho caller cũ."""
    import pikepdf
    pdf = pikepdf.open(path)
    try:
        return _page_size_mm_from_pdf(pdf, page_idx)
    finally:
        pdf.close()


def _missing_cut_error(page_idx: int, result) -> ValueError:
    """Tạo lỗi nhất quán khi trang không có nét cắt nhận diện được."""
    seen = sorted(result.layers_seen)
    hint = f" Các lớp thấy được: {', '.join(seen)}." if seen else ""
    return ValueError(
        f"Trang {page_idx}: không tìm thấy lớp/đường cắt (CutContour/Cutline...).{hint} "
        "Hãy chọn lớp cắt thủ công hoặc kiểm tra file."
    )


def _build_cut_model_from_result(pdf, page_idx: int, result, pont_config: Optional[dict]) -> CutModel:
    """Dựng CutModel từ kết quả đã trích trong cùng phiên mở PDF."""
    if not result.contours:
        raise _missing_cut_error(page_idx, result)
    geoms = [
        [(x * PT_TO_MM, y * PT_TO_MM) for (x, y) in contour.points]
        for contour in result.contours
    ]
    sheet_w_mm, sheet_h_mm = _page_size_mm_from_pdf(pdf, page_idx)
    return build_cut_model(
        geoms,
        marks=[],
        sheet_w_mm=sheet_w_mm,
        sheet_h_mm=sheet_h_mm,
        pont_config=pont_config,
    )


def _stat_revision(stat_result: os.stat_result) -> tuple[int, int, int | None, int | None]:
    """Identity nhẹ dùng để fail-closed nếu file đổi giữa lượt inspect."""
    return (
        int(stat_result.st_size),
        int(stat_result.st_mtime_ns),
        int(stat_result.st_dev) if getattr(stat_result, "st_dev", None) is not None else None,
        int(stat_result.st_ino) if getattr(stat_result, "st_ino", None) is not None else None,
    )


def inspect_cut_pdf(
    path: str,
    page_idx: int = 0,
    force_layer: Optional[str] = None,
    *,
    include_model: bool = False,
    include_models: bool = False,
) -> dict:
    """Inspect CUT hợp nhất trong đúng một lần mở/parse PDF.

    Trả fingerprint nội dung, danh sách trang CUT, trang được chọn,
    candidate lớp/spot và SVG preview. Trang user yêu cầu được giữ nếu
    có CUT; nếu không thì chọn trang CUT đầu tiên. ``include_models`` chỉ
    dành cho route nội bộ cần cấp proof cho toàn bộ trang CUT cùng revision.
    """
    import pikepdf
    from app.workers.cut_export.cut_layer_extractor import (
        ExtractConfig,
        cut_candidates_from_result,
        extract_cut_contours_from_pdf,
    )
    from app.workers.cut_export.emitters.svg import SvgEmitter

    with open(path, "rb") as source:
        before = os.fstat(source.fileno())
        digest_hex, hashed_size = _hash_open_stream(source)
        source.seek(0)

        # PERF (audit 2026-09-02 §PERF-NEST-07): hash, quét trang, candidate
        # và preview cùng dùng descriptor/PDF này; không BytesIO/read_bytes.
        pdf = pikepdf.open(source)
        try:
            num_pages = len(pdf.pages)
            requested_page_idx = min(max(int(page_idx), 0), max(num_pages - 1, 0))
            config = ExtractConfig(force_layer=force_layer) if force_layer else None
            cut_pages: list[int] = []
            cut_models: dict[int, CutModel] = {}
            requested_result = None
            first_cut: tuple[int, object] | None = None

            for current_page_idx in range(num_pages):
                result = extract_cut_contours_from_pdf(pdf, current_page_idx, config)
                if current_page_idx == requested_page_idx:
                    requested_result = result
                if result.contours:
                    cut_pages.append(current_page_idx)
                    if include_models:
                        cut_models[current_page_idx] = _build_cut_model_from_result(
                            pdf,
                            current_page_idx,
                            result,
                            pont_config=None,
                        )
                    if first_cut is None:
                        first_cut = (current_page_idx, result)

            if requested_result is not None and requested_result.contours:
                selected_page_idx: int | None = requested_page_idx
                selected_result = requested_result
            elif first_cut is not None:
                selected_page_idx, selected_result = first_cut
            else:
                selected_page_idx = None
                selected_result = requested_result

            candidates = (
                cut_candidates_from_result(selected_result)
                if selected_result is not None
                else {"layers": [], "spots": [], "auto_matched": []}
            )
            preview = None
            selected_model = None
            if selected_page_idx is not None and selected_result is not None:
                selected_model = cut_models.get(selected_page_idx)
                if selected_model is None:
                    selected_model = _build_cut_model_from_result(
                        pdf, selected_page_idx, selected_result, pont_config=None
                    )
                emitter = SvgEmitter(
                    stroke="#e11d48",
                    stroke_width_mm=0.8,
                    draw_marks=True,
                    draw_frame=True,
                )
                preview = {
                    "svg": emitter.emit(selected_model).decode("utf-8"),
                    "total_items": len([item for item in selected_model.paths if not item.is_empty]),
                    "sheet_w_mm": selected_model.sheet_w_mm,
                    "sheet_h_mm": selected_model.sheet_h_mm,
                    "page_idx": selected_page_idx,
                }
        finally:
            pdf.close()

        # PERF (audit 2026-09-02 §PERF-NEST-07): stat size/mtime không bắt được
        # ghi đè cùng kích thước rồi khôi phục timestamp. Băm hậu kiểm trên chính
        # descriptor đã parse để fingerprint không thể lệch revision với preview.
        verified_digest_hex, verified_size = _hash_open_stream(source)
        after = os.fstat(source.fileno())
        path_after = os.stat(path)
        if (
            _stat_revision(before) != _stat_revision(after)
            or _stat_revision(before) != _stat_revision(path_after)
            or hashed_size != int(before.st_size)
            or verified_size != hashed_size
            or verified_digest_hex != digest_hex
        ):
            raise ValueError(
                "File PDF đã thay đổi trong lúc kiểm tra. Hãy thử lại."
            )

    result = {
        "fingerprint": {
            "algorithm": "sha256",
            "sha256": digest_hex,
            "size_bytes": hashed_size,
            "mtime_ns": int(before.st_mtime_ns),
        },
        "cut_pages": cut_pages,
        "num_pages": num_pages,
        "selected_page_idx": selected_page_idx,
        "candidates": candidates,
        "preview": preview,
    }
    if include_model:
        # PERF (audit 2026-09-02 §PERF-NEST-07): chỉ caller nội bộ nhận model;
        # route không serialize contour mà dùng nó để tạo proof HMAC opaque.
        result["_model"] = selected_model
    if include_models:
        # Model của mọi trang đều được dựng trước hậu kiểm SHA-256 trên cùng
        # descriptor; map này không bao giờ được serialize ra response.
        result["_models"] = cut_models
    return result


def build_cut_model_from_pdf(
    path: str,
    page_idx: int = 0,
    pont_config: Optional[dict] = None,
    force_layer: Optional[str] = None,
) -> CutModel:
    """Mở PDF đã bình (bất kỳ nguồn nào) → trích đường cắt trang `page_idx` → CutModel.

    Ưu tiên bộ trích MẠNH theo lớp cắt/spot (cut_layer_extractor, Req 10). `force_layer`
    cho phép người dùng chọn lớp thủ công khi tên lớp lạ (Req 10.6). Nếu không nhận diện
    được → báo lỗi kèm danh sách lớp.
    """
    import pikepdf
    from app.workers.cut_export.cut_layer_extractor import (
        ExtractConfig,
        extract_cut_contours_from_pdf,
    )

    cfg = ExtractConfig(force_layer=force_layer) if force_layer else None
    pdf = pikepdf.open(path)
    try:
        result = extract_cut_contours_from_pdf(pdf, page_idx, cfg)
        return _build_cut_model_from_result(pdf, page_idx, result, pont_config)
    finally:
        pdf.close()


def _legacy_build_from_die_polygon(
    path: str,
    page_idx: int = 0,
    pont_config: Optional[dict] = None,
) -> CutModel:
    """(Cũ) Dựng từ extract_page_die_cut_polygon — chỉ dùng cho file 1-shape đơn giản.
    Giữ lại để tham chiếu; KHÔNG dùng cho output đã bình (đếm nhầm ốc)."""
    from app.workers import pdf_wrapper as pdf_lib
    from app.workers.nup_diecut import extract_page_die_cut_polygon

    doc = pdf_lib.open(path)
    try:
        page = doc[page_idx]
        poly = extract_page_die_cut_polygon(page)
        if poly is None or getattr(poly, "is_empty", False):
            raise ValueError(f"Trang {page_idx} không tìm thấy đường cắt hợp lệ.")
        rect = page.rect
        return cut_model_from_polygon(poly, float(rect.width), float(rect.height), pont_config)
    finally:
        try:
            doc.close()
        except Exception:
            pass


def pdf_page_count(path: str) -> int:
    """Số trang PDF (mỗi trang = 1 tờ bình). Trả 0 nếu lỗi."""
    from app.workers import pdf_wrapper as pdf_lib
    doc = pdf_lib.open(path)
    try:
        try:
            return len(doc)
        except TypeError:
            n = 0
            while True:
                try:
                    _ = doc[n]
                    n += 1
                except Exception:
                    break
            return n
    finally:
        try:
            doc.close()
        except Exception:
            pass


def list_cut_pages(path: str) -> list[int]:
    """Quét toàn bộ file, trả danh sách chỉ số trang CÓ đường cắt (trang khuôn).

    Output bình tem bế thường xen kẽ [trang in, trang khuôn, trang in, trang khuôn...].
    Modal chỉ nên làm việc với các trang khuôn này — bỏ qua trang in (Layer 1, 0 nét cắt).
    """
    from app.workers.cut_export.cut_layer_extractor import extract_cut_contours

    n = pdf_page_count(path)
    out: list[int] = []
    for i in range(n):
        try:
            res = extract_cut_contours(path, i)
            if res.contours:
                out.append(i)
        except Exception:
            continue
    return out


def auto_find_cut_page(path: str, prefer_page: int = 0) -> int:
    """Quét các trang, trả chỉ số trang ĐẦU TIÊN có đường cắt thật.

    Vì sao cần: output bình tem bế thường tách 'trang khuôn' riêng (vd CNC xuất
    [Trước, Sau, Khuôn]). Trang in chỉ có nội dung (Layer 1) — không có đường cắt.
    Ưu tiên kiểm tra `prefer_page` trước (nếu chính nó đã là trang khuôn thì giữ
    nguyên), sau đó quét các trang còn lại. Trả -1 nếu không trang nào có đường cắt.
    """
    from app.workers.cut_export.cut_layer_extractor import extract_cut_contours

    n = pdf_page_count(path)
    if n <= 0:
        return -1
    order = [prefer_page] + [i for i in range(n) if i != prefer_page]
    for i in order:
        if i < 0 or i >= n:
            continue
        try:
            res = extract_cut_contours(path, i)
            if res.contours:
                return i
        except Exception:
            continue
    return -1


def preview_svg_from_pdf(path: str, page_idx: int = 0, pont_config: Optional[dict] = None,
                         force_layer: Optional[str] = None, auto_page: bool = False) -> dict:
    """Dựng CutModel từ trang PDF + render SVG để xem trước trong UI (Req 8.1).

    Khi `auto_page=True` (và không ép lớp thủ công): tự dò trang khuôn (trang có
    đường cắt) thay vì dùng đúng trang in đang xem. Trả thêm `page_idx` đã chốt để
    UI đồng bộ thanh chuyển tờ.

    Trả dict: { svg, total_items, sheet_w_mm, sheet_h_mm, num_pages, page_idx }.
    Ném ValueError nếu không có đường cắt.
    """
    from app.workers.cut_export.emitters.svg import SvgEmitter

    resolved = page_idx
    if auto_page and not force_layer:
        found = auto_find_cut_page(path, prefer_page=page_idx)
        if found >= 0:
            resolved = found

    model = build_cut_model_from_pdf(path, resolved, pont_config, force_layer=force_layer)
    # Preview: nét đậm + khung tờ để nhìn rõ (không dùng cho xuất thật).
    em = SvgEmitter(stroke="#e11d48", stroke_width_mm=0.8, draw_marks=True, draw_frame=True)
    svg = em.emit(model).decode("utf-8")
    return {
        "svg": svg,
        "total_items": len([p for p in model.paths if not p.is_empty]),
        "sheet_w_mm": model.sheet_w_mm,
        "sheet_h_mm": model.sheet_h_mm,
        "num_pages": pdf_page_count(path),
        "page_idx": resolved,
    }


def list_cut_layers(path: str, page_idx: int = 0) -> dict:
    """Liệt kê lớp OCG + spot-color của trang để người dùng chọn thủ công (Req 10.6)."""
    from app.workers.cut_export.cut_layer_extractor import list_cut_candidates
    return list_cut_candidates(path, page_idx)
