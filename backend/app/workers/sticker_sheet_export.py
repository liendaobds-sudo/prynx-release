"""Áp Mask Quick Fix và xuất từng tem thành PNG/PDF có CutContour."""

from __future__ import annotations

from dataclasses import dataclass
import gc
import logging
from pathlib import Path
import shutil
import uuid
import zipfile

import cv2
import numpy as np
from PIL import Image, ImageOps

from app.core.sticker_sheet_session import StickerSheetSession
from app.workers.sticker_engine import StickerEngine


STICKER_PAGE_PADDING_MM = 0.25

logger = logging.getLogger(__name__)


class StickerSheetExportError(RuntimeError):
    """Lỗi nghiệp vụ khi mask đã sửa không thể tạo artifact."""


@dataclass(frozen=True)
class StickerSheetExportResult:
    path: Path
    filename: str
    media_type: str
    sticker_count: int


def _paint_stroke(
    labels: np.ndarray,
    edit: dict[str, object],
    valid_ids: set[int],
) -> None:
    height, width = labels.shape
    tool = str(edit.get("tool", ""))
    instance_id = int(edit.get("instance_id", 0))
    if instance_id not in valid_ids:
        raise StickerSheetExportError("Nét sửa tham chiếu tem không tồn tại.")
    radius = float(edit.get("radius", 0.0))
    radius_px = max(1, round(radius * max(width, height)))
    value = instance_id if tool == "restore" else 0
    raw_points = edit.get("points") or []
    points = [
        (
            max(0, min(width - 1, round(float(point["x"]) * width))),
            max(0, min(height - 1, round(float(point["y"]) * height))),
        )
        for point in raw_points
    ]
    if not points:
        return
    thickness = radius_px * 2 + 1
    for start, end in zip(points, points[1:]):
        cv2.line(labels, start, end, color=value, thickness=thickness, lineType=cv2.LINE_8)
    for point in (points[0], points[-1]):
        cv2.circle(labels, point, radius_px, color=value, thickness=-1, lineType=cv2.LINE_8)


def apply_export_edits(
    original_labels: np.ndarray,
    edits: list[dict[str, object]],
    valid_ids: set[int],
) -> np.ndarray:
    labels = original_labels.astype(np.uint32, copy=True)
    for edit in edits:
        kind = str(edit.get("kind", ""))
        if kind == "stroke":
            _paint_stroke(labels, edit, valid_ids)
            continue
        if kind != "merge":
            raise StickerSheetExportError("Lệnh sửa mask không được hỗ trợ.")
        source_id = int(edit.get("source_id", 0))
        target_id = int(edit.get("target_id", 0))
        if source_id not in valid_ids or target_id not in valid_ids or source_id == target_id:
            raise StickerSheetExportError("Lệnh gộp tem không hợp lệ.")
        labels[labels == source_id] = target_id
    return labels


def _load_source_rgb(session: StickerSheetSession, target_size: tuple[int, int]) -> np.ndarray:
    with Image.open(session.source_path) as opened:
        opened.load()
        source = ImageOps.exif_transpose(opened).convert("RGB")
    if source.size != target_size:
        source = source.resize(target_size, Image.Resampling.LANCZOS)
    return np.asarray(source, dtype=np.uint8)


def _build_edited_rgba(
    session: StickerSheetSession,
    original_labels: np.ndarray,
    labels: np.ndarray,
) -> np.ndarray:
    with Image.open(session.directory / "rgba.png") as opened:
        rgba = np.asarray(opened.convert("RGBA"), dtype=np.uint8).copy()
    if rgba.shape[:2] != labels.shape:
        raise StickerSheetExportError("Mask và ảnh session không cùng kích thước.")

    source_rgb = _load_source_rgb(session, (rgba.shape[1], rgba.shape[0]))
    restored = (labels > 0) & (original_labels == 0)
    rgba[restored, :3] = source_rgb[restored]
    rgba[labels == 0, 3] = 0
    rgba[restored, 3] = 255
    return rgba


def _extract_stickers(
    directory: Path,
    rgba: np.ndarray,
    labels: np.ndarray,
    dpi: float,
    dpi_y: float | None = None,
) -> list[Path]:
    output_paths: list[Path] = []
    height, width = labels.shape
    resolved_dpi_y = float(dpi_y if dpi_y is not None else dpi)
    padding_x_px = max(1, round(STICKER_PAGE_PADDING_MM * float(dpi) / 25.4))
    padding_y_px = max(1, round(STICKER_PAGE_PADDING_MM * resolved_dpi_y / 25.4))
    for sequence, instance_id in enumerate(sorted(int(value) for value in np.unique(labels) if value > 0), start=1):
        ys, xs = np.where(labels == instance_id)
        if xs.size == 0:
            continue
        left = max(0, int(xs.min()) - padding_x_px)
        top = max(0, int(ys.min()) - padding_y_px)
        right = min(width, int(xs.max()) + padding_x_px + 1)
        bottom = min(height, int(ys.max()) + padding_y_px + 1)
        crop = rgba[top:bottom, left:right].copy()
        local_mask = labels[top:bottom, left:right] == instance_id
        crop[~local_mask, 3] = 0
        path = directory / f"tem_{sequence:03d}.png"
        Image.fromarray(crop, "RGBA").save(
            path,
            format="PNG",
            dpi=(dpi, resolved_dpi_y),
            optimize=True,
        )
        output_paths.append(path)
    if not output_paths:
        raise StickerSheetExportError("Mọi tem đã bị xóa khỏi mask; không có gì để xuất.")
    return output_paths


def white_boundary_ratio(rgba: np.ndarray, labels: np.ndarray) -> float:
    """Đo tỷ lệ pixel gần-trắng ở mép trong để chọn bleed trắng sạch."""
    occupied = np.where(labels > 0, 255, 0).astype(np.uint8)
    try:
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        inner = cv2.erode(occupied, kernel, iterations=1)
        boundary = (occupied > 0) & (inner == 0)
    except cv2.error:
        # STABILITY (audit 2026-08-05 §AI2.EXPORT3): đây chỉ là phép đo màu mép,
        # không được phép làm hỏng cả export khi OpenCV lỗi cấp phát nhất thời.
        # Erode boolean 5×5 tương đương được thực hiện tuần tự để giữ peak RAM thấp.
        logger.warning("OpenCV lỗi khi đo mép trắng; dùng fallback NumPy", exc_info=True)
        source = occupied > 0
        height, width = source.shape
        padded = np.pad(source, 2, mode="constant", constant_values=False)
        inner_bool = np.ones_like(source, dtype=bool)
        for row, column in (
            (0, 2),
            (1, 0), (1, 1), (1, 2), (1, 3), (1, 4),
            (2, 0), (2, 1), (2, 2), (2, 3), (2, 4),
            (3, 0), (3, 1), (3, 2), (3, 3), (3, 4),
            (4, 2),
        ):
            inner_bool &= padded[row:row + height, column:column + width]
        boundary = source & ~inner_bool
    colors = rgba[:, :, :3][boundary]
    if colors.size == 0:
        return 0.0
    minimum = colors.min(axis=1)
    chroma = colors.max(axis=1) - minimum
    white = (minimum >= 225) & (chroma <= 25)
    return float(np.count_nonzero(white)) / float(len(colors))


def _png_pages_to_pdf(
    png_paths: list[Path],
    output_path: Path,
    dpi: float,
    dpi_y: float | None = None,
) -> None:
    from reportlab.lib.utils import ImageReader
    from reportlab.pdfgen import canvas

    resolved_dpi_y = float(dpi_y if dpi_y is not None else dpi)
    first_size = Image.open(png_paths[0]).size
    writer = canvas.Canvas(
        str(output_path),
        pagesize=(first_size[0] / dpi * 72.0, first_size[1] / resolved_dpi_y * 72.0),
        pageCompression=1,
    )
    for path in png_paths:
        with Image.open(path) as image:
            width_px, height_px = image.size
        width_pt = width_px / dpi * 72.0
        height_pt = height_px / resolved_dpi_y * 72.0
        writer.setPageSize((width_pt, height_pt))
        writer.drawImage(
            ImageReader(str(path)),
            0,
            0,
            width=width_pt,
            height=height_pt,
            preserveAspectRatio=False,
            mask="auto",
        )
        writer.showPage()
    writer.save()


def _zip_pngs(png_paths: list[Path], output_path: Path) -> None:
    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in png_paths:
            archive.write(path, arcname=path.name)


def export_sticker_sheet(
    session: StickerSheetSession,
    *,
    edits: list[dict[str, object]],
    dpi: float,
    dpi_y: float | None = None,
    offset_mm: float,
    bleed_mm: float,
    output_format: str,
) -> StickerSheetExportResult:
    """Xuất artifact vào session; caller chịu trách nhiệm phục vụ file."""
    original_labels = np.load(session.directory / "labels.npy", allow_pickle=False)
    valid_ids = {
        int(instance["id"])
        for instance in session.manifest.get("instances", [])
    }
    labels = apply_export_edits(original_labels, edits, valid_ids)
    rgba = _build_edited_rgba(session, original_labels, labels)
    use_white_bleed = white_boundary_ratio(rgba, labels) >= 0.70

    export_dir = session.directory / f"export_{uuid.uuid4().hex[:12]}"
    export_dir.mkdir(parents=True, exist_ok=False)
    try:
        resolved_dpi_y = float(dpi_y if dpi_y is not None else dpi)
        png_paths = _extract_stickers(export_dir, rgba, labels, dpi, resolved_dpi_y)
        if output_format == "png_zip":
            output_path = session.directory / f"tem_tach_{uuid.uuid4().hex[:8]}.zip"
            _zip_pngs(png_paths, output_path)
            return StickerSheetExportResult(
                path=output_path,
                filename="tem_tach.png.zip",
                media_type="application/zip",
                sticker_count=len(png_paths),
            )

        source_pdf = export_dir / "tem_alpha.pdf"
        output_path = session.directory / f"tem_cutcontour_{uuid.uuid4().hex[:8]}.pdf"
        _png_pages_to_pdf(png_paths, source_pdf, dpi, resolved_dpi_y)
        def _process_cutline() -> tuple[bool, dict]:
            return StickerEngine(dpi=300).process_pdf(
                input_path=str(source_pdf),
                output_path=str(output_path),
                cut_mode="alpha",
                offset_mm=offset_mm,
                corner_style="preserve",
                bleed_mm=bleed_mm,
                fill_holes=True,
                remove_white_bg=False,
                # STICKER-SHEET (audit 2026-08-05 §SS.EXPORT): viền tem trắng không
                # được kéo màu xám antialias thành tia ở vùng bleed; tem màu vẫn dùng
                # smart bleed hiện có để tránh lộ mép trắng sau bế.
                bleed_color_type="solid" if use_white_bleed else "image",
                solid_bleed_color=(255, 255, 255),
                draw_cut_contour=True,
                rectangle_mode=False,
                shape_mode="contour",
                # QUALITY (audit 2026-08-05 §AI2.CUT1): ảnh AI cần giữ đỉnh sao/notch
                # nhưng vẫn fit riêng các span trơn để giảm node dao.
                alpha_corner_policy="adaptive",
                # QUALITY (audit 2026-08-05 §AI2.CUT2): ngưỡng làm mượt không được
                # nhỏ hơn chi tiết một pixel nguồn, nhất là ảnh không DPI đang giữ 72 DPI.
                alpha_source_pixel_mm=max(25.4 / float(dpi), 25.4 / resolved_dpi_y),
            )

        try:
            success, meta = _process_cutline()
        except cv2.error:
            # STABILITY (audit 2026-08-05 §AI2.EXPORT2): cv2 có thể lỗi cấp phát nhất
            # thời khi worker vừa giải phóng raster. Dọn artifact dở và thử đúng một lần;
            # lần hai vẫn lỗi thì trả thông báo nghiệp vụ thay vì HTTP 500 `(error)`.
            logger.warning("OpenCV lỗi khi xuất tem; dọn bộ nhớ và thử lại một lần", exc_info=True)
            output_path.unlink(missing_ok=True)
            gc.collect()
            try:
                success, meta = _process_cutline()
            except cv2.error as retry_error:
                raise StickerSheetExportError(
                    "Không tạo được đường cắt vì bộ nhớ xử lý đang bận. "
                    "Hãy đóng bớt tài liệu lớn rồi thử lại."
                ) from retry_error
        if not success or not output_path.is_file():
            detail = meta.get("error") if isinstance(meta, dict) else None
            raise StickerSheetExportError(str(detail or "Không tạo được PDF CutContour."))
        return StickerSheetExportResult(
            path=output_path,
            filename="tem_tach_cutcontour.pdf",
            media_type="application/pdf",
            sticker_count=len(png_paths),
        )
    except BaseException:
        # Chỉ dọn thư mục trung gian của lần export; session và artifact cũ vẫn giữ.
        if export_dir.exists():
            shutil.rmtree(export_dir)
        raise
    finally:
        if export_dir.exists():
            shutil.rmtree(export_dir)
