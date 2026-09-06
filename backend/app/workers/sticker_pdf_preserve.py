"""Giữ PDF gốc khi xuất vùng tem tự động hoặc chọn/sửa trong workspace chung."""

from __future__ import annotations

import copy
import hashlib
from pathlib import Path

import numpy as np
import pikepdf

from app.core.sticker_sheet_session import StickerSheetPageState
from app.workers.sticker_engine import (
    ALPHA_CONTOUR_THRESHOLD,
    StickerEngine,
)
from app.workers.sticker_sheet_export import (
    StickerCanonicalPreviewConflict,
    StickerSheetExportError,
    _solid_cmyk_to_rgb,
    _sticker_engine_dpi,
)


def copy_preserved_pdf_catalog(source: pikepdf.Pdf, destination: pikepdf.Pdf) -> None:
    """Giữ profile và trạng thái lớp khi copy các trang cùng một nguồn PDF."""
    from app.workers.pdf_ops import copy_output_intents

    if not destination.Root.get("/OutputIntents"):
        copy_output_intents(source, destination)
    source_properties = source.Root.get("/OCProperties")
    if source_properties is None:
        return
    if not source_properties.is_indirect:
        source_properties = source.make_indirect(source_properties)
    copied = destination.copy_foreign(source_properties)
    current = destination.Root.get("/OCProperties")
    if current is None:
        destination.Root["/OCProperties"] = copied
        return
    current_default = current.get("/D", pikepdf.Dictionary())
    copied_default = copied.get("/D", pikepdf.Dictionary())
    if current_default.get("/BaseState", pikepdf.Name.ON) != copied_default.get("/BaseState", pikepdf.Name.ON):
        raise StickerSheetExportError("Các trang nguồn có trạng thái lớp PDF không tương thích.")
    current["/D"] = current_default
    # Mỗi fragment có OCG riêng được copy chung mapping với page.resources.
    # Không bật ON mọi lớp: artwork cố ý ẩn phải vẫn ẩn ở trang thứ hai trở đi.
    for key in ("/OCGs", "/Configs"):
        if copied.get(key) is not None:
            if current.get(key) is None:
                current[key] = pikepdf.Array()
            current[key].extend(copied[key])
    for key in ("/Order", "/ON", "/OFF", "/AS", "/RBGroups", "/Locked"):
        if copied_default.get(key) is not None:
            if current_default.get(key) is None:
                current_default[key] = pikepdf.Array()
            current_default[key].extend(copied_default[key])


def _strip_replaced_cut_channels(document: pikepdf.Pdf, *, allow_remove_all: bool) -> None:
    """Bỏ đúng spot CUT được thay thế; lớp chưa xử lý được phải dừng rõ ràng."""
    from app.workers.cut_export.cut_layer_extractor import (
        ExtractConfig,
        extract_cut_contours_from_pdf,
    )
    from app.workers.nup_artwork import strip_color_from_form_tree

    # Cả đường sát mép trang cũng phải được thay, không bỏ qua như bước dò tem.
    config = ExtractConfig(page_frame_ratio=float("inf"))
    existing = extract_cut_contours_from_pdf(document, 0, config)
    if not existing.contours:
        return
    if not allow_remove_all:
        # Chọn một tem không cấp quyền xóa CUT của tem khác. Chưa có mapping
        # object→CUT đủ chắc thì dừng, không strip toàn bộ spot trên trang.
        raise StickerSheetExportError(
            "Chưa thể thay riêng đường cắt có sẵn bằng lựa chọn đối tượng. "
            "Hãy nhận diện tự động hoặc bỏ đường cắt cũ trong file nguồn."
        )
    page = document.pages[0]
    for channel in {contour.layer for contour in existing.contours}:
        strip_color_from_form_tree(
            page,
            None,
            target_spot=channel,
            strict=True,
            owner_pdf=document,
        )
    if extract_cut_contours_from_pdf(document, 0, config).contours:
        # Không xuất hai lớp dao chồng nhau hoặc xóa cả lớp artwork để giấu lỗi.
        raise StickerSheetExportError(
            "Chưa thay được lớp đường cắt có sẵn trong PDF này. "
            "Hãy giữ đường cắt gốc hoặc bỏ lớp cắt cũ trong file nguồn."
        )


def _selected_artifact_snapshot(
    page: StickerSheetPageState,
    rgba: np.ndarray,
    path_groups: list[dict[str, object]] | None,
    *,
    dpi: float,
    dpi_y: float,
) -> dict[str, object]:
    """Gom Alpha từng tem đúng frame đã duyệt; không detect hoặc fit lần hai."""
    alpha = np.ascontiguousarray(rgba[:, :, 3]).copy()
    cache = page.cutline_export_cache
    if path_groups is not None:
        if not isinstance(cache, dict):
            raise StickerCanonicalPreviewConflict("Bản xem trước đường bế đã hết hạn.")
        quality = cache.get("quality")
        if not isinstance(quality, dict) or quality.get("machine_safe") is not True:
            raise StickerSheetExportError("Đường bế chưa vượt kiểm tra quỹ đạo máy bế.")
        if (
            int(cache.get("analysis_height", 0)) != alpha.shape[0]
            or int(cache.get("analysis_width", 0)) != alpha.shape[1]
        ):
            raise StickerCanonicalPreviewConflict("Alpha xem trước không còn khớp trang nguồn.")
        alpha.fill(0)
        instances = cache.get("instances")
        if not isinstance(instances, list) or not instances:
            raise StickerCanonicalPreviewConflict("Bản xem trước không còn vùng tem đã chọn.")
        for instance in instances:
            if not isinstance(instance, dict):
                raise StickerCanonicalPreviewConflict("Vùng tem xem trước không hợp lệ.")
            local_alpha = instance.get("alpha")
            if not isinstance(local_alpha, np.ndarray) or local_alpha.ndim != 2:
                raise StickerCanonicalPreviewConflict("Bản xem trước thiếu Alpha vùng tem.")
            local_alpha = np.ascontiguousarray(local_alpha, dtype=np.uint8)
            if hashlib.sha256(local_alpha.tobytes()).hexdigest() != instance.get("alpha_sha256"):
                raise StickerCanonicalPreviewConflict("Alpha vùng tem đã thay đổi sau xem trước.")
            try:
                left, top = int(instance["left"]), int(instance["top"])
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                raise StickerCanonicalPreviewConflict("Tọa độ vùng tem xem trước không hợp lệ.") from exc
            right = left + local_alpha.shape[1]
            bottom = top + local_alpha.shape[0]
            if left < 0 or top < 0 or right > alpha.shape[1] or bottom > alpha.shape[0]:
                raise StickerCanonicalPreviewConflict("Alpha vùng tem nằm ngoài trang nguồn.")
            target = alpha[top:bottom, left:right]
            np.maximum(target, local_alpha, out=target)

    selected_rgba = rgba.copy()
    selected_rgba[:, :, 3] = alpha
    return {
        "alpha": alpha,
        "source_rgba": selected_rgba,
        "preserve_original": True,
        "path_groups": copy.deepcopy(path_groups),
        "dpi": (float(dpi), float(dpi_y)),
        "source_pixel_mm": max(25.4 / float(dpi), 25.4 / float(dpi_y)),
        "boundary_source": (
            "page-box" if np.all(alpha >= ALPHA_CONTOUR_THRESHOLD) else "manual"
        ),
        "preview_fingerprint": str((cache or {}).get("fingerprint", "")),
    }


def write_preserved_pdf_page(
    source_path: Path,
    page: StickerSheetPageState,
    output_path: Path,
    *,
    rgba: np.ndarray,
    path_groups: list[dict[str, object]] | None,
    dpi: float,
    dpi_y: float,
    offset_mm: float,
    bleed_mm: float,
    cut_mode: str,
    corner_style: str,
    fill_holes: bool,
    bleed_color_type: str,
    solid_bleed_cmyk: tuple[float, float, float, float],
    draw_cut_contour: bool,
    cutline_smoothness: float,
    cutline_fidelity: float,
    curve_tension: float,
    min_detail_area_mm2: float,
    edge_background_override: dict[str, object],
) -> None:
    """Giữ artwork gốc; chỉ thêm bleed ring và Bézier canonical lên trang.

    UNIFY (audit 2026-09-06 §CUSTOM.4): adapter selection của engine không vẽ
    lại artwork. /Rotate, /UserUnit và gốc MediaBox được bake bằng ma trận trang
    hiện hữu; đường bế dùng point vật lý trong CropBox đã xoay như preview.
    """
    reference = page.manifest.get("vector_geometry_ref") or {}
    object_ids = reference.get("object_ids")
    if reference.get("kind") == "pdf-object-selection":
        if (
            reference.get("source_page") != page.page_number
            or not isinstance(object_ids, list)
            or not object_ids
            or any(not isinstance(item, str) or not item.strip() for item in object_ids)
        ):
            raise StickerCanonicalPreviewConflict("Lựa chọn đối tượng không còn thuộc trang nguồn.")
    else:
        object_ids = None
    approved = _selected_artifact_snapshot(
        page,
        rgba,
        path_groups,
        dpi=dpi,
        dpi_y=dpi_y,
    )
    approved.update(edge_background_override)
    input_path = output_path.with_name(output_path.stem + "_nguon.pdf")
    try:
        # Tách đúng trang nhưng không raster hóa: các Form, text, spot color và
        # object không được chọn còn nguyên trong stream của trang nguồn.
        with pikepdf.Pdf.open(source_path) as document:
            index = page.page_number - 1
            if index < 0 or index >= len(document.pages):
                raise StickerSheetExportError("Trang PDF nguồn không còn tồn tại.")
            del document.pages[index + 1:]
            del document.pages[:index]
            _strip_replaced_cut_channels(document, allow_remove_all=not bool(object_ids))
            document.save(input_path)
        success, metadata = StickerEngine(dpi=_sticker_engine_dpi(dpi, dpi_y)).process_pdf(
            input_path=str(input_path),
            output_path=str(output_path),
            selected_objects_by_page=({0: list(object_ids)} if object_ids else None),
            approved_contour_overrides={0: approved},
            cut_mode=cut_mode,
            offset_mm=offset_mm,
            bleed_mm=bleed_mm,
            corner_style=corner_style,
            fill_holes=fill_holes,
            remove_white_bg=False,
            bleed_color_type=bleed_color_type,
            solid_bleed_color=_solid_cmyk_to_rgb(solid_bleed_cmyk),
            draw_cut_contour=draw_cut_contour,
            shape_mode="contour",
            cutline_smoothness=cutline_smoothness,
            cutline_fidelity=cutline_fidelity,
            curve_tension=curve_tension,
            min_detail_area_mm2=min_detail_area_mm2,
        )
        if not success or not output_path.is_file():
            detail = metadata.get("error") if isinstance(metadata, dict) else None
            raise StickerSheetExportError(str(detail or "Không tạo được PDF từ vùng tem đã chọn."))
    except BaseException:
        output_path.unlink(missing_ok=True)
        raise
    finally:
        input_path.unlink(missing_ok=True)
