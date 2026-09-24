"""Bóc tách object PDF thành trường VDP QR/mã vạch.

PDF xuất từ Illustrator/Corel không giữ ngữ nghĩa QR hay barcode. Worker này vì
vậy chỉ nhận object mà người dùng đã chọn (ảnh, vector hoặc text), giữ nguyên
khung hình học của chúng rồi chuyển thành field VDP. Việc xoá placeholder đi qua
``stream_editor.delete_objects`` để giữ màu in và fail-closed khi mapping stream
không xác định được.
"""
from __future__ import annotations

import math
import os
import uuid
from typing import Any, Iterable, Optional

import pikepdf

from app.core import geometry_reader, stream_editor
from app.schemas.edit import ObjMeta, normalize_bbox


_FIELD_TYPES = {"qrcode", "barcode"}
# Text đã có picker riêng. Endpoint này chỉ nhận ảnh/vector để tránh việc kéo
# vùng mã vô tình gom cả chữ trong thiết kế rồi xoá theo cùng một thao tác.
_SELECTABLE_TYPES = {"image", "vector"}
_BARCODE_TYPES = {
    "code128", "code39", "ean13", "ean8", "upca", "upc", "itf", "i2of5", "itf14", "codabar",
    "interleaved2of5", "datamatrix", "gs1-128", "gs1128", "gs1_128",
    "gs1-datamatrix", "gs1datamatrix", "gs1_datamatrix", "gs1-dm",
}
# Hệ mm này phải khớp với VDP text picker và ReportLab overlay hiện tại.
_PT_TO_VDP_MM = (96.0 / 72.0) * (25.4 / 72.0)


def _finite_bbox(value: Iterable[float]) -> list[float]:
    """Chuẩn hóa bbox và từ chối số NaN/inf trước khi thao tác PDF."""
    values = list(value)
    if len(values) != 4 or not all(math.isfinite(float(item)) for item in values):
        raise ValueError("selectionBbox phải gồm 4 số hữu hạn")
    return normalize_bbox([float(item) for item in values])


def _bbox_intersection_area(left: list[float], right: list[float]) -> float:
    return max(0.0, min(left[2], right[2]) - max(left[0], right[0])) * max(
        0.0, min(left[3], right[3]) - max(left[1], right[1])
    )


def _bbox_area(value: list[float]) -> float:
    return max(0.0, value[2] - value[0]) * max(0.0, value[3] - value[1])


def _bbox_selected(obj_bbox: list[float], selection_bbox: list[float]) -> bool:
    """Chọn object nằm trong vùng kéo, tránh nuốt ảnh nền lớn.

    Vùng kéo phải chứa toàn bộ object. Kiểm theo tâm hoặc diện tích giao có thể
    vô tình xoá ảnh toàn trang khi người dùng khoanh QR nằm giữa thiết kế.
    """
    obj = normalize_bbox(list(obj_bbox))
    return (
        _bbox_area(obj) > 0.0
        and obj[0] >= selection_bbox[0]
        and obj[1] >= selection_bbox[1]
        and obj[2] <= selection_bbox[2]
        and obj[3] <= selection_bbox[3]
    )


def _rotation_from_matrix(matrix: Optional[list[float]]) -> float:
    """Lấy góc quay của CTM PDF theo độ, chuẩn hóa về [0, 360)."""
    if not matrix or len(matrix) < 2:
        return 0.0
    a, b = float(matrix[0]), float(matrix[1])
    if abs(a) <= 1e-9 and abs(b) <= 1e-9:
        return 0.0
    angle = math.degrees(math.atan2(b, a)) % 360.0
    # QR/barcode thường quay theo 0/90/180/270; giữ góc lẻ nếu PDF có xoay tự do.
    return round(angle, 2)


def _group_rotation(objects: list[ObjMeta]) -> int:
    """Giữ góc vuông của placeholder; không gửi góc lẻ engine chưa hỗ trợ."""
    vectors: list[tuple[float, float]] = []
    for obj in objects:
        angle = math.radians(_rotation_from_matrix(obj.matrix))
        vectors.append((math.cos(angle), math.sin(angle)))
    if not vectors:
        return 0.0
    sx = sum(item[0] for item in vectors)
    sy = sum(item[1] for item in vectors)
    if abs(sx) <= 1e-9 and abs(sy) <= 1e-9:
        return 0.0
    angle = math.degrees(math.atan2(sy, sx)) % 360.0
    quarter = round(angle / 90.0) * 90 % 360
    delta = abs((angle - quarter + 180.0) % 360.0 - 180.0)
    if delta > 0.5:
        raise ValueError(
            "Mã đang xoay góc lẻ chưa được hỗ trợ. Hãy xoay mã về 0°, 90°, 180° hoặc 270° trước khi chọn."
        )
    return int(quarter)


def _page_geometry(pdf_path: str, page_index: int) -> tuple[list[float], int]:
    with pikepdf.open(pdf_path) as pdf:
        if page_index < 0 or page_index >= len(pdf.pages):
            raise IndexError(f"Trang {page_index} ngoài phạm vi tài liệu")
        page = pdf.pages[page_index]
        try:
            box = page.cropbox
        except Exception:
            box = page.mediabox
        return [float(box[0]), float(box[1]), float(box[2]), float(box[3])], int(page.get("/Rotate", 0) or 0) % 360


def _display_bbox(bbox: list[float], cropbox: list[float], rotation: int) -> list[float]:
    """Đổi bbox PDF sang khung hiển thị đã crop/xoay, gốc trên-trái."""
    cx0, cy0, cx1, cy1 = cropbox
    width, height = cx1 - cx0, cy1 - cy0
    left, bottom, right, top = (
        bbox[0] - cx0, bbox[1] - cy0, bbox[2] - cx0, bbox[3] - cy0
    )
    if rotation == 90:
        return [bottom, left, top, right]
    if rotation == 180:
        return [width - right, bottom, width - left, top]
    if rotation == 270:
        return [height - top, width - right, height - bottom, width - left]
    if rotation != 0:
        raise ValueError("Trang PDF có góc xoay không được hỗ trợ.")
    return [left, height - top, right, height - bottom]


def _field_name(field_type: str, page_index: int, draw_indices: list[int]) -> str:
    prefix = "QR" if field_type == "qrcode" else "Barcode"
    # Tên chỉ là gợi ý để người dùng map cột dữ liệu; id ngẫu nhiên đảm bảo
    # nhiều trường cùng loại trên một trang không bị gộp ở frontend.
    return f"{prefix}_{page_index + 1}_{(min(draw_indices) + 1) if draw_indices else 1}"


def _select_objects(
    all_objects: list[ObjMeta],
    draw_indices: Iterable[int],
    selection_bbox: Optional[Iterable[float]],
) -> tuple[list[ObjMeta], list[int]]:
    explicit = list(draw_indices or [])
    if any(not isinstance(index, int) or isinstance(index, bool) or index < 0 for index in explicit):
        raise ValueError("drawIndices phải là số nguyên không âm")
    if len(set(explicit)) != len(explicit):
        raise ValueError("drawIndices không được trùng")
    selection = _finite_bbox(selection_bbox) if selection_bbox is not None else None
    by_index = {obj.drawIndex: obj for obj in all_objects}
    selected: dict[int, ObjMeta] = {}

    for index in explicit:
        obj = by_index.get(index)
        if obj is None:
            raise ValueError(f"Không tìm thấy object tại drawIndex {index}")
        if obj.type not in _SELECTABLE_TYPES:
            raise ValueError(f"Object tại drawIndex {index} không hỗ trợ cho VDP")
        selected[index] = obj

    if selection is not None:
        for obj in all_objects:
            if obj.type in _SELECTABLE_TYPES and _bbox_selected(obj.bbox, selection):
                selected[obj.drawIndex] = obj

    if not selected:
        raise ValueError("Cần chọn ít nhất một object ảnh/vector hoặc một vùng hợp lệ")
    ordered = [selected[index] for index in sorted(selected)]
    return ordered, [obj.drawIndex for obj in ordered]


def pick_objects_to_vdp_field(
    pdf_path: str,
    page_index: int,
    draw_indices: Iterable[int] = (),
    field_type: str = "qrcode",
    barcode_type: Optional[str] = None,
    selection_bbox: Optional[Iterable[float]] = None,
    remove_original: bool = True,
    output_path: Optional[str] = None,
) -> dict[str, Any]:
    """Chuyển object đã chọn thành field QR/barcode và tùy chọn xoá placeholder."""
    if not os.path.isfile(pdf_path):
        raise FileNotFoundError(f"File PDF không tồn tại: {pdf_path}")
    field_type = str(field_type or "").strip().lower()
    if field_type not in _FIELD_TYPES:
        raise ValueError("fieldType chỉ nhận 'qrcode' hoặc 'barcode'")
    normalized_barcode = str(barcode_type or "code128").strip().lower() or "code128"
    if field_type == "barcode" and normalized_barcode not in _BARCODE_TYPES:
        raise ValueError("Loại mã vạch chưa được hỗ trợ. Hãy chọn lại loại mã trong danh sách.")
    if remove_original and not output_path:
        raise ValueError("Xoá placeholder yêu cầu output_path")

    all_objects = geometry_reader.list_objects(pdf_path, page_index, include_text_props=False)
    selected_objects, selected_indices = _select_objects(
        all_objects, draw_indices, selection_bbox
    )
    # BBox union của các path/bar ảnh giữ nguyên kích thước thiết kế.
    bbox = normalize_bbox([
        min(obj.bbox[0] for obj in selected_objects),
        min(obj.bbox[1] for obj in selected_objects),
        max(obj.bbox[2] for obj in selected_objects),
        max(obj.bbox[3] for obj in selected_objects),
    ])
    cropbox, page_rotation = _page_geometry(pdf_path, page_index)
    if not _bbox_selected(bbox, cropbox):
        raise ValueError("Đối tượng nằm ngoài vùng trang đang hiển thị. Hãy chỉnh lại vùng cắt trang trước khi chọn.")
    shown = _display_bbox(bbox, cropbox, page_rotation)
    pt_left, pt_top = shown[0], shown[1]
    pt_width = shown[2] - shown[0]
    pt_height = shown[3] - shown[1]
    rotation = (_group_rotation(selected_objects) - page_rotation) % 360
    field_id = f"vdp_pick_{field_type}_{uuid.uuid4().hex[:8]}"
    field: dict[str, Any] = {
        "id": field_id,
        "name": _field_name(field_type, page_index, selected_indices),
        "type": field_type,
        "pageNum": page_index + 1,
        "x": round(pt_left * _PT_TO_VDP_MM, 2),
        "y": round(pt_top * _PT_TO_VDP_MM, 2),
        "width": round(pt_width * _PT_TO_VDP_MM, 2),
        "height": round(pt_height * _PT_TO_VDP_MM, 2),
        "rotation": rotation,
        "textContent": None,
        "autoFit": True,
        "drawIndices": selected_indices,
    }
    if field_type == "barcode":
        field["barcodeType"] = normalized_barcode
        field["barType"] = normalized_barcode

    cleaned_path: Optional[str] = None
    if remove_original and output_path:
        destination = os.path.abspath(output_path)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        temporary = f"{destination}.tmp-{uuid.uuid4().hex}"
        try:
            # map_object_spans thực hiện toàn bộ kiểm tra trước khi save. Nếu một
            # path/image mơ hồ, ObjectMapError dừng và file đầu ra không xuất hiện.
            with pikepdf.open(pdf_path) as pdf:
                if page_index < 0 or page_index >= len(pdf.pages):
                    raise IndexError(f"Trang {page_index} ngoài phạm vi tài liệu")
                page = pdf.pages[page_index]
                delete_result = stream_editor.delete_objects(
                    page,
                    selected_objects,
                    pdf,
                    all_obj_metas=all_objects,
                )
                if not delete_result.changed:
                    raise ValueError("Không xoá được placeholder. File mẫu được giữ nguyên.")
                from app.workers.vdp_engine import _clean_template_dead_text_ops_and_fonts

                _clean_template_dead_text_ops_and_fonts(page, pdf)
                pdf.save(temporary)
            os.replace(temporary, destination)
            cleaned_path = destination
        except Exception:
            try:
                if os.path.exists(temporary):
                    os.remove(temporary)
            except OSError:
                pass
            # Không trả field thành công nếu file sạch chưa được ghi nguyên vẹn.
            raise

    return {
        "success": True,
        "field": field,
        "cleanedPdfPath": cleaned_path,
        "removedDrawIndices": selected_indices if remove_original else [],
    }


def _vector_barcode_hint(objects: list[ObjMeta]) -> bool:
    """Nhận diện hình học tối thiểu cho nhóm thanh barcode vector.

    Hỗ trợ cả thanh dọc lẫn thanh ngang (mã vạch xoay 90°). Đây là gợi ý
    hình học dự phòng khi raster/decoder không đọc được dữ liệu số thật.
    """
    bars = [obj for obj in objects if obj.type == "vector"]
    if len(bars) < 3:
        return False
    widths = [max(0.0, obj.bbox[2] - obj.bbox[0]) for obj in bars]
    heights = [max(0.0, obj.bbox[3] - obj.bbox[1]) for obj in bars]
    if not widths or any(width <= 0 or height <= 0 for width, height in zip(widths, heights)):
        return False
    is_vertical = sum(width <= height * 0.55 for width, height in zip(widths, heights)) >= max(3, len(bars) * 0.6)
    is_horizontal = sum(height <= width * 0.55 for width, height in zip(widths, heights)) >= max(3, len(bars) * 0.6)
    if not (is_vertical or is_horizontal):
        return False
    if is_vertical:
        overlap_bottom = max(obj.bbox[1] for obj in bars)
        overlap_top = min(obj.bbox[3] for obj in bars)
        return overlap_top > overlap_bottom
    else:
        overlap_left = max(obj.bbox[0] for obj in bars)
        overlap_right = min(obj.bbox[2] for obj in bars)
        return overlap_right > overlap_left


def detect_vdp_object_type(
    pdf_path: str,
    page_index: int,
    draw_indices: Iterable[int],
) -> dict[str, Any]:
    """Gợi ý QR/barcode từ object đã chọn, không chặn thao tác thủ công.

    Thử raster và giải mã bằng OpenCV QRCodeDetector + BarcodeDetector (EAN-13,
    Code-128...). Nếu không đọc được số thật, dùng heuristic hình học cho nhóm
    thanh vector.
    """
    if not os.path.isfile(pdf_path):
        raise FileNotFoundError(f"File PDF không tồn tại: {pdf_path}")
    all_objects = geometry_reader.list_objects(pdf_path, page_index, include_text_props=False)
    selected_objects, selected_indices = _select_objects(all_objects, draw_indices, None)
    bbox = normalize_bbox([
        min(obj.bbox[0] for obj in selected_objects),
        min(obj.bbox[1] for obj in selected_objects),
        max(obj.bbox[2] for obj in selected_objects),
        max(obj.bbox[3] for obj in selected_objects),
    ])

    # Thử giải mã trực tiếp bằng OpenCV (hỗ trợ cả ảnh raster lẫn vector kết xuất)
    cropbox, _page_rotation = _page_geometry(pdf_path, page_index)
    cx0, cy0, cx1, cy1 = cropbox
    region_w = max(1.0, bbox[2] - bbox[0])
    region_h = max(1.0, bbox[3] - bbox[1])
    pad = min(16.0, max(2.0, min(region_w, region_h) * 0.08))
    left = max(0.0, bbox[0] - cx0 - pad)
    bottom = max(0.0, bbox[1] - cy0 - pad)
    right = min(cx1 - cx0, bbox[2] - cx0 + pad)
    top = min(cy1 - cy0, bbox[3] - cy0 + pad)

    if right > left and top > bottom:
        try:
            import cv2
            import numpy as np
            import pypdfium2 as pdfium
            from app.core.pdfium_lock import pdfium_guard

            with pdfium_guard("vdp_code_detect_render"):
                document = pdfium.PdfDocument(pdf_path)
                try:
                    page = document[page_index]
                    page_width, page_height = page.get_size()
                    left_c = min(max(0.0, left), float(page_width))
                    bottom_c = min(max(0.0, bottom), float(page_height))
                    right_c = min(max(left_c, right), float(page_width))
                    top_c = min(max(bottom_c, top), float(page_height))
                    longest = max(right_c - left_c, top_c - bottom_c)
                    scale = min(3.0, 1800.0 / longest) if longest > 0 else 1.0
                    bitmap = page.render(
                        scale=scale,
                        crop=(left_c, bottom_c, float(page_width) - right_c, float(page_height) - top_c),
                    )
                    image = np.asarray(bitmap.to_pil().convert("RGB"))
                finally:
                    document.close()

            # 1. Thử nhận diện QR code
            detector = cv2.QRCodeDetector()
            decoded, points, _ = detector.detectAndDecode(image)
            if points is not None and len(points) > 0 and (decoded or len(points) >= 4):
                return {
                    "decoded": True,
                    "fieldType": "qrcode",
                    "barcodeType": None,
                    "payload": str(decoded or "")[:256] or None,
                    "drawIndices": selected_indices,
                }

            # 2. Thử nhận diện mã vạch chuẩn (EAN-13, Code 128...)
            try:
                barcode_detector = cv2.barcode.BarcodeDetector()
                ok, decoded_info, decoded_type, _ = barcode_detector.detectAndDecodeWithType(image)
                if ok and decoded_type and len(decoded_type) > 0:
                    raw_type = str(decoded_type[0]).strip().upper()
                    type_map = {
                        "EAN-13": "ean13",
                        "EAN-8": "ean8",
                        "UPC-A": "upca",
                        "UPC-E": "upce",
                        "CODE-128": "code128",
                        "CODE-39": "code39",
                        "CODE-93": "code93",
                        "ITF": "itf",
                    }
                    detected_bar_type = type_map.get(raw_type, "code128")
                    payload = decoded_info[0] if (decoded_info and len(decoded_info) > 0) else None
                    return {
                        "decoded": True,
                        "fieldType": "barcode",
                        "barcodeType": detected_bar_type,
                        "payload": str(payload or "")[:256] or None,
                        "drawIndices": selected_indices,
                    }
            except Exception:
                pass
        except Exception:
            pass

    # 3. Fallback hình học cho nhóm thanh vector
    if _vector_barcode_hint(selected_objects):
        return {
            "decoded": True,
            "fieldType": "barcode",
            "barcodeType": "code128",
            "drawIndices": selected_indices,
        }

    return {
        "decoded": False,
        "fieldType": None,
        "barcodeType": None,
        "drawIndices": selected_indices,
    }


__all__ = ["detect_vdp_object_type", "pick_objects_to_vdp_field"]
