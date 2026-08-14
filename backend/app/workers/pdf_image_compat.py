"""Chuẩn hóa image XObject để PDF bình tương thích với thao tác Embed của Adobe."""

from __future__ import annotations

import logging
import zlib

import pikepdf


logger = logging.getLogger(__name__)

_REVERSED_CMYK_DECODE = (1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0)


def _object_key(obj):
    try:
        marker = tuple(obj.objgen)
        if marker != (0, 0):
            return marker
    except Exception:
        pass
    return ("direct", id(obj))


def _filter_names(image_xobject) -> tuple[str, ...]:
    value = image_xobject.get("/Filter")
    if value is None:
        value = image_xobject.get("/F")
    if value is None:
        return ()
    if isinstance(value, pikepdf.Array):
        return tuple(str(item) for item in value)
    return (str(value),)


def _has_reversed_cmyk_decode(image_xobject) -> bool:
    value = image_xobject.get("/Decode")
    if value is None:
        value = image_xobject.get("/D")
    if value is None:
        return False
    try:
        if len(value) != len(_REVERSED_CMYK_DECODE):
            return False
        actual = tuple(float(item) for item in value)
    except (AttributeError, TypeError, ValueError):
        return False
    return all(
        abs(item - expected) <= 1e-9
        for item, expected in zip(actual, _REVERSED_CMYK_DECODE)
    )


def _is_problematic_cmyk_jpeg(image_xobject) -> bool:
    """Nhận diện đúng cặp DCT-CMYK + Decode đảo kênh gây Adobe Embed sai màu."""
    if str(image_xobject.get("/Subtype", "")) != "/Image":
        return False
    if "/DCTDecode" not in _filter_names(image_xobject):
        return False
    if str(image_xobject.get("/ColorSpace", "")) != "/DeviceCMYK":
        return False
    if bool(image_xobject.get("/ImageMask", False)):
        return False
    try:
        if int(image_xobject.get("/BitsPerComponent", 8)) != 8:
            return False
    except (TypeError, ValueError):
        return False
    return _has_reversed_cmyk_decode(image_xobject)


def _normalize_one_image(image_xobject) -> bool:
    """Đổi JPEG-CMYK đảo kênh sang mẫu CMYK Flate, giữ nguyên từng pixel."""
    raster = None
    try:
        if not _is_problematic_cmyk_jpeg(image_xobject):
            return False
        raster = pikepdf.PdfImage(image_xobject).as_pil_image()
        if raster.mode != "CMYK":
            logger.warning(
                "Bỏ qua chuẩn hóa JPEG-CMYK vì Pillow trả mode %s.",
                raster.mode,
            )
            return False
        width = int(image_xobject.get("/Width", 0))
        height = int(image_xobject.get("/Height", 0))
        raw = raster.tobytes()
        if width <= 0 or height <= 0 or len(raw) != width * height * 4:
            logger.warning(
                "Bỏ qua chuẩn hóa JPEG-CMYK vì kích thước mẫu không khớp %sx%s.",
                width,
                height,
            )
            return False

        image_xobject.write(
            zlib.compress(raw),
            filter=pikepdf.Name("/FlateDecode"),
        )
        # Các khóa này mô tả JPEG đảo kênh cũ; giữ lại sẽ khiến Adobe áp phép
        # đảo thêm lần nữa sau khi Embed và biến nền ảnh thành gần đen.
        for key in ("/Decode", "/D", "/DecodeParms", "/DP", "/F"):
            if key in image_xobject:
                del image_xobject[key]
        return True
    except Exception as exc:
        # Fail-safe: PDF nguồn vẫn hợp lệ để render; không được làm hỏng cả job
        # chỉ vì một image XObject lạ không thể giải mã.
        logger.warning("Không chuẩn hóa được JPEG-CMYK đảo kênh: %s", exc)
        return False
    finally:
        if raster is not None:
            raster.close()


def normalize_adobe_embed_images(form_xobject) -> int:
    """Chuẩn hóa ảnh lỗi trong toàn bộ cây Form; trả số image đã thay đổi."""
    changed = 0
    visited = set()
    stack = [form_xobject]
    while stack:
        node = stack.pop()
        node_key = _object_key(node)
        if node_key in visited:
            continue
        visited.add(node_key)

        try:
            resources = node.get("/Resources")
            xobjects = resources.get("/XObject") if resources is not None else None
        except Exception as exc:
            logger.debug("Không đọc được cây XObject khi chuẩn hóa ảnh: %s", exc)
            continue
        if xobjects is None:
            continue

        try:
            entries = list(xobjects.items())
        except Exception as exc:
            logger.debug("Không đọc được /XObject khi chuẩn hóa ảnh: %s", exc)
            continue
        for _name, xobject in entries:
            try:
                subtype = str(xobject.get("/Subtype", ""))
                if subtype == "/Form":
                    stack.append(xobject)
                elif subtype == "/Image" and _normalize_one_image(xobject):
                    changed += 1
            except Exception as exc:
                logger.warning("Bỏ qua XObject lỗi khi chuẩn hóa ảnh: %s", exc)
    return changed
