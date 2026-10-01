"""Khử pixel mờ ngoài biên Alpha trước khi tạo đường cắt tem PNG."""

from __future__ import annotations

from io import BytesIO
import zlib

import cv2
import numpy as np
import pikepdf


# QUALITY (feedback 2026-10-01 §PNG.ALPHA-EDGE): ngưỡng độ đục, không phải
# ngưỡng màu. Cùng một Alpha phải được xử lý giống nhau với mọi màu RGB.
OPAQUE_ALPHA_MIN = 248


def clean_alpha_exterior_fringe(alpha: np.ndarray) -> tuple[np.ndarray, int]:
    """Xóa Alpha mờ nối với thân đục ở mép ngoài, giữ các vùng kín và đảo rời.

    Không co pixel đục, không phụ thuộc màu bóng, không lấp lỗ trong suốt.
    Nguồn chỉ gồm nội dung bán trong suốt không có mốc đục thì giữ nguyên.
    """
    alpha = np.asarray(alpha, dtype=np.uint8)
    if alpha.ndim != 2:
        raise ValueError("Alpha phải là ảnh một kênh.")
    solid = alpha >= OPAQUE_ALPHA_MIN
    semi = (alpha > 0) & ~solid
    if not np.any(solid) or not np.any(semi):
        return alpha, 0

    # Đệm để cả khi thân tem chạm cạnh ảnh, mọi đoạn nền ngoài vẫn thông nhau.
    outside = np.pad((~solid).astype(np.uint8), 1, constant_values=1)
    cv2.floodFill(outside, None, (0, 0), 2, flags=4)
    remove = semi & (outside[1:-1, 1:-1] == 2)
    if not np.any(remove):
        return alpha, 0
    count, labels = cv2.connectedComponents((alpha > 0).astype(np.uint8), connectivity=8)
    touches_solid = np.zeros(count, dtype=bool)
    touches_solid[np.unique(labels[solid])] = True
    remove &= touches_solid[labels]
    removed = int(np.count_nonzero(remove))
    if not removed:
        return alpha, 0
    cleaned = alpha.copy()
    cleaned[remove] = 0
    return cleaned, removed


def pad_hidden_color(samples: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Đệm mẫu màu dưới Alpha=0 để nội suy PDF không kéo màu bóng trở lại.

    Chỉ đổi byte vô hình. Mọi pixel còn Alpha và độ đục đều giữ nguyên; đây
    không tạo vùng in mới, không nới kích thước ảnh hay bù xén.
    """
    visible = alpha > 0
    if not np.any(visible) or np.all(visible):
        return samples
    distance, nearest = cv2.distanceTransformWithLabels(
        (~visible).astype(np.uint8), cv2.DIST_L2, 5,
        labelType=cv2.DIST_LABEL_PIXEL,
    )
    del distance
    lookup = np.zeros((int(nearest.max()) + 1, *samples.shape[2:]), dtype=samples.dtype)
    lookup[nearest[visible]] = samples[visible]
    result = samples.copy()
    result[~visible] = lookup[nearest[~visible]]
    return result


def clean_rgba_exterior_fringe(rgba: np.ndarray) -> tuple[np.ndarray, int]:
    """Dùng cùng phép khử Alpha cho PNG xem trước và ảnh đưa vào PDF."""
    alpha, removed = clean_alpha_exterior_fringe(rgba[:, :, 3])
    padded = pad_hidden_color(rgba[:, :, :3], alpha)
    if not removed and np.array_equal(padded, rgba[:, :, :3]):
        return rgba, 0
    return np.dstack((padded, alpha)), removed


def _default_decode(image: pikepdf.Stream, channels: int) -> bool:
    decode = image.get("/Decode")
    return decode is None or list(decode) == [0, 1] * channels


def _channels(image: pikepdf.Stream) -> int | None:
    color = image.get("/ColorSpace")
    if isinstance(color, pikepdf.Array):
        if len(color) == 2 and str(color[0]) == "/ICCBased":
            return int(color[1].get("/N", 0)) or None
        return None
    return {"/DeviceGray": 1, "/DeviceRGB": 3, "/DeviceCMYK": 4}.get(str(color))


def cleaned_alpha_page_bytes(page: pikepdf.Page) -> tuple[bytes | None, int]:
    """Trả bản sao một trang có SMask đã khử mép, không sửa tài liệu đầu vào.

    Giữ hệ tọa độ, mẫu màu nhìn thấy và profile gốc. Dùng bản sao độc lập để
    ảnh/SMask dùng chung với trang không được chọn không bị thay đổi theo.
    """
    removed_total = 0
    changed_any = False
    with pikepdf.Pdf.new() as document:
        document.pages.append(page)
        copied_page = document.pages[0]
        seen: set[tuple[int, int]] = set()
        pending = [copied_page.get("/Resources", {})]
        while pending:
            resources = pending.pop()
            if not hasattr(resources, "get"):
                continue
            xobjects = resources.get("/XObject", {})
            if not hasattr(xobjects, "values"):
                continue
            for image in xobjects.values():
                identity = image.objgen
                if identity in seen:
                    continue
                seen.add(identity)
                if str(image.get("/Subtype")) == "/Form":
                    pending.append(image.get("/Resources", {}))
                    continue
                if str(image.get("/Subtype")) != "/Image":
                    continue
                smask = image.get("/SMask")
                channels = _channels(image)
                if (
                    not isinstance(smask, pikepdf.Stream)
                    or channels not in (1, 3, 4)
                    or smask.get("/Matte") is not None
                    or not _default_decode(image, channels)
                    or not _default_decode(smask, 1)
                ):
                    continue
                with pikepdf.PdfImage(smask).as_pil_image() as mask_image:
                    alpha = np.array(mask_image.convert("L"), dtype=np.uint8)
                cleaned, removed = clean_alpha_exterior_fringe(alpha)
                if not np.any(cleaned == 0):
                    continue
                with pikepdf.PdfImage(image).as_pil_image() as color_image:
                    mode = {1: "L", 3: "RGB", 4: "CMYK"}[channels]
                    # PdfImage có thể ghép SMask thành RGBA/LA; convert bỏ Alpha
                    # mà không composite nền hay đổi profile của mẫu màu gốc.
                    samples = np.array(color_image.convert(mode), dtype=np.uint8)
                if samples.shape[:2] != cleaned.shape:
                    raise ValueError("SMask không khớp kích thước ảnh PNG.")
                padded = pad_hidden_color(samples, cleaned)
                hidden_changed = not np.array_equal(
                    padded[cleaned == 0], samples[cleaned == 0]
                )
                if not removed and not hidden_changed:
                    continue
                changed_any = True
                if removed:
                    new_mask = document.make_stream(zlib.compress(cleaned.tobytes(), 1))
                    new_mask.stream_dict = pikepdf.Dictionary({
                        "/Type": pikepdf.Name.XObject,
                        "/Subtype": pikepdf.Name.Image,
                        "/Width": cleaned.shape[1], "/Height": cleaned.shape[0],
                        "/BitsPerComponent": 8, "/ColorSpace": pikepdf.Name.DeviceGray,
                        "/Filter": pikepdf.Name.FlateDecode,
                        "/Interpolate": bool(smask.get("/Interpolate", False)),
                    })
                    image["/SMask"] = new_mask
                image.write(zlib.compress(padded.tobytes(), 1), filter=pikepdf.Name.FlateDecode)
                image["/BitsPerComponent"] = 8
                for key in ("/DecodeParms", "/Decode"):
                    if key in image:
                        del image[key]
                removed_total += removed
        if not changed_any:
            return None, 0
        encoded = BytesIO()
        document.save(encoded)
        return encoded.getvalue(), removed_total
