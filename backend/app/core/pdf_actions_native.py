"""Action sửa PDF chạy bằng pikepdf/Pillow/fontTools — không cần Ghostscript.

Vì sao tồn tại: Ghostscript **dựng lại toàn bộ file** cho mọi action. Kể cả khi
chỉ cần hạ độ phân giải một tấm ảnh, `pdfwrite` vẫn viết lại mọi trang, mọi
font, mọi shading — kéo theo hàng loạt thay đổi không ai yêu cầu (subset lại
font, quy đổi colorspace, mất optional content, mất cấu trúc tag). Các action ở
đây đi đường **object-level**: mở file, sửa đúng object cần sửa, ghi lại phần
còn lại nguyên vẹn.

Nguyên tắc chung của module:

* **Không đoán.** Việc gì chưa chắc đúng thì BỎ QUA object đó và ghi cảnh báo,
  để caller từ chối an toàn. Sửa sai một ảnh in offset đắt hơn nhiều so
  với việc bỏ qua nó.
* **Báo cáo được.** Mỗi hàm trả `dict` có `changed`, `skipped`, `warnings` để
  action log nói được chính xác đã đụng vào cái gì.
"""

from __future__ import annotations

import logging
import math
import os
import struct
import zlib
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

import pikepdf

logger = logging.getLogger(__name__)


def _raise_if_cancelled(cancel_check) -> None:
    """Checkpoint nhẹ cho các action sync đang chạy trong threadpool."""
    if cancel_check is not None and cancel_check():
        raise InterruptedError("Tác vụ PDF đã bị hủy.")

# Chỉ hạ những codec mà việc giải-nén-rồi-nén-lại là **không mất thêm chất
# lượng ngoài dự tính**. JPX (JPEG2000) và JBIG2 bị loại: Pillow không ghi lại
# được đúng dạng, nên hạ chúng đồng nghĩa đổi codec — thay đổi lớn hơn nhiều so
# với điều người dùng yêu cầu.
_RESAMPLABLE_FILTERS = {
    "/FlateDecode",
    "/LZWDecode",
    "/DCTDecode",
    "/RunLengthDecode",
    None,  # ảnh không nén
}

# Ảnh 1-bit (ImageMask, CCITT, nét scan) KHÔNG hạ: hạ một stencil bằng phép nội
# suy sẽ biến nét đen-trắng thành xám lem, và ở kênh spot/đường bế thì đó là
# hỏng bản. Ngưỡng DPI cho ảnh 1-bit trong thực tế cũng cao hơn hẳn (1200+).
_MIN_BPC_TO_RESAMPLE = 2


@dataclass
class _Placement:
    """Kích thước đặt lớn nhất (point) của một image XObject trên toàn tài liệu."""

    width_pt: float = 0.0
    height_pt: float = 0.0
    count: int = 0

    def observe(self, w: float, h: float) -> None:
        # Lấy LỚN NHẤT chứ không phải trung bình: một ảnh dùng lại ở nhiều chỗ
        # (logo trong tem lặp) phải giữ đủ pixel cho chỗ đặt to nhất, nếu không
        # chính chỗ đó bị mờ.
        self.width_pt = max(self.width_pt, w)
        self.height_pt = max(self.height_pt, h)
        self.count += 1


@dataclass
class _Ctm:
    """Ma trận PDF `[a b c d e f]`."""

    a: float = 1.0
    b: float = 0.0
    c: float = 0.0
    d: float = 1.0
    e: float = 0.0
    f: float = 0.0

    def then(self, outer: "_Ctm") -> "_Ctm":
        return _Ctm(
            self.a * outer.a + self.b * outer.c,
            self.a * outer.b + self.b * outer.d,
            self.c * outer.a + self.d * outer.c,
            self.c * outer.b + self.d * outer.d,
            self.e * outer.a + self.f * outer.c + outer.e,
            self.e * outer.b + self.f * outer.d + outer.f,
        )

    def placed_size(self) -> tuple[float, float]:
        """Kích thước ảnh đơn vị 1×1 sau biến đổi, đúng cả khi xoay/nghiêng.

        Cùng công thức với `preflight_rules.images._placed_size_from_matrix` —
        action sửa PHẢI đo cùng thước đo với rule phát hiện, nếu không sẽ có
        file "sửa xong vẫn báo lỗi".
        """
        return (math.hypot(self.a, self.b), math.hypot(self.c, self.d))


@dataclass
class _Scan:
    placements: dict[str, _Placement] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


_MAX_FORM_DEPTH = 12


def _scan_placements(
    pdf: pikepdf.Pdf,
    resources: pikepdf.Object,
    content: bytes,
    ctm: _Ctm,
    scan: _Scan,
    depth: int,
    seen_forms: frozenset[int],
) -> None:
    """Duyệt content stream, tích luỹ CTM để biết mỗi ảnh được đặt to cỡ nào.

    Khoá của `scan.placements` là `objgen` của image XObject, KHÔNG phải tên
    resource: cùng một ảnh thường mang tên khác nhau ở mỗi trang, còn hai ảnh
    khác nhau lại có thể trùng tên `/Im0`. Khoá theo object mới gộp đúng.
    """
    if depth > _MAX_FORM_DEPTH:
        scan.warnings.append("Form XObject lồng quá sâu — bỏ qua nhánh này.")
        return

    try:
        instructions = pikepdf.parse_content_stream(
            pikepdf.Stream(pdf, content), "q Q cm Do"
        )
    except Exception as exc:  # noqa: BLE001 — content hỏng: bỏ nhánh, không chết
        scan.warnings.append(f"Không đọc được content stream: {exc}")
        return

    stack: list[_Ctm] = []
    cur = ctm
    xobjects = None
    try:
        xobjects = resources.get("/XObject")
    except Exception:  # noqa: BLE001
        xobjects = None

    for instr in instructions:
        op = str(instr.operator)
        if op == "q":
            stack.append(cur)
        elif op == "Q":
            cur = stack.pop() if stack else ctm
        elif op == "cm":
            try:
                vals = [float(v) for v in instr.operands]
                if len(vals) == 6:
                    cur = _Ctm(*vals).then(cur)
            except Exception:  # noqa: BLE001
                continue
        elif op == "Do" and xobjects is not None:
            try:
                name = str(instr.operands[0])
                target = xobjects.get(name)
                if target is None:
                    continue
                subtype = str(target.get("/Subtype", ""))
            except Exception:  # noqa: BLE001
                continue

            if subtype == "/Image":
                key = _objkey(target)
                if key is None:
                    continue
                w, h = cur.placed_size()
                scan.placements.setdefault(key, _Placement()).observe(w, h)
            elif subtype == "/Form":
                form_key = _objkey(target)
                # Form tự tham chiếu (file hỏng hoặc cố ý) sẽ đệ quy vô hạn.
                if form_key is not None and form_key in seen_forms:
                    continue
                try:
                    inner_ctm = cur
                    matrix = target.get("/Matrix")
                    if matrix is not None:
                        vals = [float(v) for v in matrix]
                        if len(vals) == 6:
                            inner_ctm = _Ctm(*vals).then(cur)
                    inner_res = target.get("/Resources")
                    if inner_res is None:
                        inner_res = resources  # kế thừa theo §8.10.1
                    _scan_placements(
                        pdf,
                        inner_res,
                        target.read_bytes(),
                        inner_ctm,
                        scan,
                        depth + 1,
                        seen_forms | ({form_key} if form_key is not None else frozenset()),
                    )
                except Exception as exc:  # noqa: BLE001
                    scan.warnings.append(f"Bỏ qua Form XObject {name}: {exc}")


def _objkey(obj: pikepdf.Object) -> tuple[int, int] | None:
    """Danh tính object để gộp các placement của cùng một ảnh."""
    try:
        og = obj.objgen
    except Exception:  # noqa: BLE001
        return None
    # objgen (0, 0) nghĩa là object trực tiếp (không phải indirect) — mỗi lần
    # xuất hiện là một object riêng, không gộp được.
    return None if og == (0, 0) else tuple(og)


def scan_image_placements(pdf: pikepdf.Pdf) -> _Scan:
    """Kích thước đặt lớn nhất của mọi image XObject trong tài liệu."""
    scan = _Scan()
    for page in pdf.pages:
        try:
            resources = page.get("/Resources")
            if resources is None:
                continue
            base = _page_base_ctm(page)
            _scan_placements(
                pdf, resources, _page_content_bytes(page), base, scan, 0, frozenset()
            )
        except Exception as exc:  # noqa: BLE001
            scan.warnings.append(f"Bỏ qua một trang khi quét ảnh: {exc}")
    return scan


def _page_base_ctm(page: pikepdf.Object) -> _Ctm:
    """CTM khởi đầu của trang.

    Chỉ `/UserUnit` mới đổi tỉ lệ point→thiết bị; `/Rotate` xoay trang nhưng
    KHÔNG đổi độ dài cạnh nên không ảnh hưởng DPI hiệu dụng.
    """
    try:
        unit = float(page.get("/UserUnit", 1))
    except Exception:  # noqa: BLE001
        unit = 1.0
    if unit <= 0 or not math.isfinite(unit):
        unit = 1.0
    return _Ctm(unit, 0.0, 0.0, unit, 0.0, 0.0)


def _page_content_bytes(page: pikepdf.Object) -> bytes:
    contents = page.get("/Contents")
    if contents is None:
        return b""
    try:
        if isinstance(contents, pikepdf.Array):
            # Mảng content stream nối lại PHẢI chèn khoảng trắng: token cuối của
            # stream này và token đầu của stream sau có thể dính vào nhau.
            return b"\n".join(bytes(c.read_bytes()) for c in contents)
        return bytes(contents.read_bytes())
    except Exception:  # noqa: BLE001
        return b""


def downscale_images(
    input_path: str,
    output_path: str,
    target_dpi: float = 300.0,
    max_dpi: float = 600.0,
) -> dict:
    """Hạ ảnh vượt `max_dpi` xuống `target_dpi`, giữ nguyên phần còn lại của file.

    Chỉ đụng vào ảnh hội đủ điều kiện an toàn; mọi trường hợp còn lại được đếm
    vào `skipped` kèm lý do. Ảnh và `/SMask` của nó được hạ **cùng tỉ lệ** để
    mặt nạ không lệch khỏi nội dung.

    Trả dict: `changed`, `skipped`, `warnings`, `details`.
    """
    changed = 0
    skipped: dict[str, int] = {}
    warnings: list[str] = []
    details: list[str] = []

    def skip(reason: str) -> None:
        skipped[reason] = skipped.get(reason, 0) + 1

    with pikepdf.open(input_path) as pdf:
        scan = scan_image_placements(pdf)
        warnings.extend(scan.warnings[:5])
        # Ảnh dùng làm mặt nạ (`/SMask`, `/Mask`) KHÔNG bao giờ xuất hiện sau
        # một `Do` nên không có kích thước đặt riêng. Chúng được hạ kèm ảnh cha
        # trong `_resample_image_stream`; ở vòng lặp này phải loại hẳn ra, nếu
        # không mỗi mặt nạ lại thành một "ảnh không xử lý được" và đẩy cả file
        # làm cả file bị từ chối một cách vô cớ.
        mask_keys = _collect_mask_keys(pdf)

        for obj in pdf.objects:
            try:
                if not isinstance(obj, pikepdf.Stream):
                    continue
                if str(obj.get("/Subtype", "")) != "/Image":
                    continue
            except Exception:  # noqa: BLE001
                continue

            key = _objkey(obj)
            if key is not None and key in mask_keys:
                continue
            placement = scan.placements.get(key) if key is not None else None
            if placement is None or placement.width_pt <= 0 or placement.height_pt <= 0:
                # Không thấy ảnh được vẽ ở đâu (chỉ nằm trong resource, hoặc
                # được vẽ từ nhánh mà parser đã bỏ). Không biết nó to cỡ nào
                # thì không có cơ sở nào để hạ.
                skip("không xác định được kích thước đặt")
                continue

            try:
                pixel_w = int(obj.get("/Width", 0))
                pixel_h = int(obj.get("/Height", 0))
                bpc = int(obj.get("/BitsPerComponent", 8))
            except Exception:  # noqa: BLE001
                skip("thiếu Width/Height")
                continue
            if pixel_w < 1 or pixel_h < 1:
                skip("thiếu Width/Height")
                continue

            if bool(obj.get("/ImageMask", False)) or bpc < _MIN_BPC_TO_RESAMPLE:
                skip("ảnh 1-bit / ImageMask")
                continue

            filt = obj.get("/Filter")
            filt_names = _filter_names(filt)
            if any(f not in _RESAMPLABLE_FILTERS for f in filt_names):
                skip(f"codec không hạ được ({','.join(f or '?' for f in filt_names)})")
                continue

            dpi_x = pixel_w / (placement.width_pt / 72.0)
            dpi_y = pixel_h / (placement.height_pt / 72.0)
            effective = min(dpi_x, dpi_y)
            if effective <= max_dpi:
                skip("đã dưới ngưỡng")
                continue

            scale = target_dpi / effective
            new_w = max(1, int(round(pixel_w * scale)))
            new_h = max(1, int(round(pixel_h * scale)))
            if new_w >= pixel_w and new_h >= pixel_h:
                skip("đã dưới ngưỡng")
                continue

            try:
                ok = _resample_image_stream(pdf, obj, new_w, new_h)
            except Exception as exc:  # noqa: BLE001
                logger.debug("downscale ảnh thất bại: %s", exc)
                skip("giải mã ảnh thất bại")
                continue
            if not ok:
                skip("giải mã ảnh thất bại")
                continue

            changed += 1
            if len(details) < 20:
                details.append(
                    f"{pixel_w}×{pixel_h}px @{effective:.0f}DPI → "
                    f"{new_w}×{new_h}px @~{target_dpi:.0f}DPI"
                )

        if changed:
            # Ảnh đã hạ nhưng object cũ vẫn còn trong file thì dung lượng không
            # giảm — đúng thứ người dùng bấm nút để có.
            pdf.remove_unreferenced_resources()
        pdf.save(output_path)

    return {
        "changed": changed,
        "skipped": skipped,
        "warnings": warnings,
        "details": details,
    }


def _collect_mask_keys(pdf: pikepdf.Pdf) -> set[tuple[int, int]]:
    """Danh tính mọi image XObject đang đóng vai mặt nạ cho một ảnh khác."""
    keys: set[tuple[int, int]] = set()
    for obj in pdf.objects:
        try:
            if not isinstance(obj, pikepdf.Stream):
                continue
            if str(obj.get("/Subtype", "")) != "/Image":
                continue
            for slot in ("/SMask", "/Mask"):
                ref = obj.get(slot)
                if ref is None:
                    continue
                # `/Mask` cũng có thể là mảng color-key (không phải stream).
                target = _deref(ref)
                if not isinstance(target, pikepdf.Stream):
                    continue
                k = _objkey(target)
                if k is not None:
                    keys.add(k)
        except Exception:  # noqa: BLE001
            continue
    return keys


def _filter_names(filt) -> list[str | None]:
    if filt is None:
        return [None]
    try:
        if isinstance(filt, pikepdf.Array):
            return [str(f) for f in filt]
        return [str(filt)]
    except Exception:  # noqa: BLE001
        return ["?"]


def _image_decode_is_default(image, components: int) -> bool:
    """`True` khi `/Decode` không đổi ý nghĩa mẫu màu/alpha.

    `pikepdf.PdfImage.as_pil_image()` trả mẫu đã giải filter nhưng không áp
    `/Decode` đảo/thay thang kênh. Writer sau đó xóa `/Decode`; nếu vẫn chuyển
    các ảnh này thì artifact có thể sạch RGB nhưng màu hoặc alpha đã sai. Lane
    object-level hiện chỉ chấp nhận mapping mặc định `[0 1]` cho mỗi kênh.
    """
    try:
        decode = image.get("/Decode")
        if decode is None:
            decode = image.get("/D")
        if decode is None:
            return True
        values = [float(value) for value in _deref(decode)]
    except Exception:  # noqa: BLE001
        return False
    expected = [value for _ in range(components) for value in (0.0, 1.0)]
    return len(values) == len(expected) and all(
        math.isfinite(actual) and abs(actual - wanted) <= 1.0e-9
        for actual, wanted in zip(values, expected)
    )


def _resample_image_stream(
    pdf: pikepdf.Pdf, obj: pikepdf.Stream, new_w: int, new_h: int
) -> bool:
    """Thay nội dung một image XObject bằng bản thu nhỏ. `False` = không đụng tới.

    Ghi lại bằng **Flate + mẫu thô**: giữ nguyên `/ColorSpace` gốc (kể cả ICCBased
    và Separation/DeviceN) thay vì để Pillow tự quy sang RGB/CMYK của nó. Với
    prepress, quy đổi colorspace ngoài ý muốn là lỗi nặng hơn hẳn dung lượng.
    """
    from PIL import Image

    pdf_image = pikepdf.PdfImage(obj)
    try:
        pil = pdf_image.as_pil_image()
    except Exception as exc:  # noqa: BLE001
        logger.debug("as_pil_image thất bại: %s", exc)
        return False

    n_comps = _colorspace_components(obj)
    if n_comps is None:
        return False
    # Ảnh Indexed: mẫu là CHỈ SỐ bảng màu. Nội suy chỉ số cho ra chỉ số vô
    # nghĩa (giữa đỏ và xanh không phải là màu ở giữa) — Pillow đã trả bản
    # RGB đã tra bảng, và ghi lại RGB sẽ đổi cấu trúc ảnh. Bỏ qua cho an toàn.
    if _is_indexed(obj):
        return False

    expected_mode = {1: ("L",), 3: ("RGB",), 4: ("CMYK",)}.get(n_comps)
    if expected_mode is None or pil.mode not in expected_mode:
        # Mode Pillow không khớp số thành phần khai trong PDF: ghi lại sẽ lệch
        # số kênh so với /ColorSpace.
        return False

    resized = pil.resize((new_w, new_h), Image.LANCZOS)
    raw = resized.tobytes()
    if len(raw) != new_w * new_h * n_comps:
        return False

    smask = obj.get("/SMask")
    if smask is not None:
        # Mặt nạ phải theo cùng lưới với ảnh, nếu không vùng trong suốt lệch
        # khỏi nội dung. Không hạ được mặt nạ thì KHÔNG hạ ảnh.
        if not _resample_smask(pdf, smask, new_w, new_h):
            return False

    obj.write(zlib.compress(raw), filter=pikepdf.Name("/FlateDecode"))
    obj["/Width"] = new_w
    obj["/Height"] = new_h
    obj["/BitsPerComponent"] = 8
    # `/Decode` và `/DecodeParms` mô tả dữ liệu CŨ (thang bit khác, predictor
    # của filter cũ). Giữ lại là mô tả sai dữ liệu mới.
    for dead in ("/DecodeParms", "/DP", "/Decode", "/D"):
        if dead in obj:
            del obj[dead]
    return True


def _resample_smask(pdf: pikepdf.Pdf, smask, new_w: int, new_h: int) -> bool:
    from PIL import Image

    try:
        mask_img = pikepdf.PdfImage(smask).as_pil_image()
    except Exception as exc:  # noqa: BLE001
        logger.debug("SMask as_pil_image thất bại: %s", exc)
        return False
    if mask_img.mode != "L":
        try:
            mask_img = mask_img.convert("L")
        except Exception:  # noqa: BLE001
            return False
    resized = mask_img.resize((new_w, new_h), Image.LANCZOS)
    raw = resized.tobytes()
    if len(raw) != new_w * new_h:
        return False
    smask.write(zlib.compress(raw), filter=pikepdf.Name("/FlateDecode"))
    smask["/Width"] = new_w
    smask["/Height"] = new_h
    smask["/BitsPerComponent"] = 8
    smask["/ColorSpace"] = pikepdf.Name("/DeviceGray")
    for dead in ("/DecodeParms", "/DP", "/Decode", "/D"):
        if dead in smask:
            del smask[dead]
    return True


def _deref(obj):
    """Giải tham chiếu gián tiếp, trả nguyên object nếu nó vốn đã trực tiếp.

    Mọi `pikepdf.Object` đều CÓ thuộc tính `resolve`, nhưng gọi nó trên object
    trực tiếp (Name, Array…) ném `ValueError`. Kiểm bằng `hasattr` như phần còn
    lại của repo vẫn làm sẽ nuốt trọn nhánh đúng vào `except` — biến ảnh
    `/DeviceRGB` thường thành "không đọc được colorspace" và không hạ được gì.
    """
    try:
        return obj.resolve() if getattr(obj, "is_indirect", False) else obj
    except Exception:  # noqa: BLE001
        return obj


def _is_indexed(obj: pikepdf.Stream) -> bool:
    cs = _deref(obj.get("/ColorSpace"))
    try:
        if isinstance(cs, pikepdf.Array) and len(cs) > 0:
            return str(_deref(cs[0])) in ("/Indexed", "/I")
    except Exception:  # noqa: BLE001
        return True  # không đọc được ⇒ coi như rủi ro, bỏ qua ảnh
    return False


def _colorspace_components(obj: pikepdf.Stream) -> int | None:
    """Số thành phần màu của ảnh, `None` khi không chắc."""
    cs = _deref(obj.get("/ColorSpace"))
    if cs is None:
        return None

    name = str(cs)
    simple = {
        "/DeviceGray": 1,
        "/G": 1,
        "/CalGray": 1,
        "/DeviceRGB": 3,
        "/RGB": 3,
        "/CalRGB": 3,
        "/DeviceCMYK": 4,
        "/CMYK": 4,
    }
    if name in simple:
        return simple[name]

    try:
        if isinstance(cs, pikepdf.Array) and len(cs) > 0:
            family = str(_deref(cs[0]))
            if family == "/ICCBased" and len(cs) > 1:
                stream = _deref(cs[1])
                n = int(stream.get("/N", 0))
                return n if n in (1, 3, 4) else None
            if family in ("/CalGray",):
                return 1
            if family in ("/CalRGB", "/Lab"):
                return 3 if family == "/CalRGB" else None
            if family in ("/DeviceN", "/Separation"):
                # Kênh spot: Pillow không biểu diễn được đúng, và hạ sai một
                # kênh spot là hỏng bản in.
                return None
    except Exception:  # noqa: BLE001
        return None
    return None


# ─────────────────────────────────────────────────────────────────────────────
#  EMBED_FONTS
# ─────────────────────────────────────────────────────────────────────────────

# Base-14: theo §9.6.2.2 mọi consumer PDF phải có sẵn, không cần nhúng. Nhúng
# chúng bằng một font thay thế chỉ làm đổi mặt chữ mà không giải quyết gì.
_BASE14_STEMS = {
    "courier", "courier-bold", "courier-oblique", "courier-boldoblique",
    "helvetica", "helvetica-bold", "helvetica-oblique", "helvetica-boldoblique",
    "times-roman", "times-bold", "times-italic", "times-bolditalic",
    "symbol", "zapfdingbats",
    "arial", "arial-bold", "arialmt", "arial-boldmt",
}


def analyze_font_embedding(pdf_path: str) -> dict:
    """Phân loại font trong file: đã nhúng / base-14 / thiếu thật sự.

    Vì sao chỉ phân tích mà không tự nhúng: nhúng một font CHƯA có trong file
    đòi hỏi tìm đúng file font ngoài hệ thống rồi dựng lại `/Widths`, `/Encoding`
    và (với Type0) cả `/CIDToGIDMap`. Thay bằng một font khác mặt chữ sẽ làm
    **chạy chữ** — sai vị trí ngắt dòng, tràn khung, lệch khoảng — mà người dùng
    không thấy cho tới lúc in. Trung thực hơn là chỉ ra file thiếu font gì để
    caller quyết định (outline bằng engine nội bộ hoặc yêu cầu sửa file nguồn).
    """
    result = {
        "embedded": [],
        "base14": [],
        "missing": [],
        "warnings": [],
        "readable": True,
    }
    try:
        pdf = pikepdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001
        # KHÔNG được để "không đọc được" trông giống "không thiếu font": caller
        # đọc `missing == []` rồi kết luận file đủ font và bỏ qua bước nhúng.
        result["readable"] = False
        result["warnings"].append(f"Không mở được PDF: {exc}")
        return result

    seen: set[str] = set()
    with pdf:
        for page in pdf.pages:
            try:
                fonts = page.get("/Resources", {}).get("/Font")
            except Exception:  # noqa: BLE001
                continue
            if not fonts:
                continue
            for font_name, font_ref in dict(fonts).items():
                font_obj = _deref(font_ref)
                base = str(font_obj.get("/BaseFont", font_name)).lstrip("/")
                if base in seen:
                    continue
                seen.add(base)

                if _font_is_embedded(font_obj):
                    result["embedded"].append(base)
                    continue

                # Tên subset có tiền tố 6 chữ hoa + '+' (§9.6.4). Bỏ tiền tố
                # trước khi so base-14, nếu không "ABCDEF+Helvetica" bị xếp
                # nhầm vào nhóm thiếu.
                stem = base.split("+", 1)[-1].split(",", 1)[0].lower()
                if stem in _BASE14_STEMS:
                    result["base14"].append(base)
                else:
                    result["missing"].append(base)
    return result


def _font_is_embedded(font_obj) -> bool:
    targets = []
    try:
        descendants = font_obj.get("/DescendantFonts")
        if descendants is not None:
            for d in descendants:
                targets.append(_deref(d))
        else:
            targets = [font_obj]
    except Exception:  # noqa: BLE001
        targets = [font_obj]

    for tgt in targets:
        try:
            desc = _deref(tgt.get("/FontDescriptor"))
            if desc is None:
                continue
            for key in ("/FontFile", "/FontFile2", "/FontFile3"):
                if desc.get(key) is not None:
                    return True
        except Exception:  # noqa: BLE001
            continue
    return False


# ─────────────────────────────────────────────────────────────────────────────
#  CONVERT_TO_CMYK
# ─────────────────────────────────────────────────────────────────────────────

# Toán tử màu RGB và cặp CMYK tương ứng (§8.6.8). `g`/`G` (DeviceGray) KHÔNG
# nằm ở đây: xám in bằng K thuần, đổi nó thành 4 kênh chỉ làm bẩn bản và tăng
# TAC mà không được gì. Ghostscript `ColorConversionStrategy=CMYK` cũng giữ
# đường gray.
_RGB_TO_CMYK_OP = {"rg": "k", "RG": "K"}


def _CMS_FLAGS(*, black_point_compensation: bool = True):
    """Cờ Little CMS phải khớp cấu hình đo mực của phần còn lại trong app.

    Đo đối chứng Ghostscript (`-dRenderIntent=1 -dBlackPtComp=1`) trên một màu
    Pantone Lab: mặc định của `ImageCms` lệch **13–14/255** ở Cyan/Magenta; bật
    `BLACKPOINTCOMPENSATION` kéo về 1; thêm `NOOPTIMIZE` thì khớp **chính xác
    từng byte**. `NOOPTIMIZE` tắt bảng tra rút gọn của lcms — chậm hơn nhưng ở
    đây mỗi tài liệu chỉ quy đổi vài chục màu và kết quả đã có cache.

    Không thống nhất cờ với đường đo mực thì cùng một file sẽ có màu khác nhau
    tuỳ đi qua action nào — sai lệch không bao giờ hiện ra trên UI.
    """
    from PIL import ImageCms

    flags = ImageCms.Flags.NOOPTIMIZE
    if black_point_compensation:
        flags |= ImageCms.Flags.BLACKPOINTCOMPENSATION
    return flags

# Colorspace mà việc chuyển sang CMYK là **mất mát không phục hồi được** hoặc
# vượt tầm object-level. Gặp là trả `supported=False` để caller dừng an toàn.
_UNCONVERTIBLE_HINTS = ("/Lab",)


_RENDERING_INTENTS = {
    "perceptual": "PERCEPTUAL",
    "relative": "RELATIVE_COLORIMETRIC",
    "relative_colorimetric": "RELATIVE_COLORIMETRIC",
    "saturation": "SATURATION",
    "absolute": "ABSOLUTE_COLORIMETRIC",
    "absolute_colorimetric": "ABSOLUTE_COLORIMETRIC",
}


def _normalize_rendering_intent(value: str | None):
    """Đổi key API/UI sang hằng số LittleCMS, từ chối key lạ thay vì đoán."""
    from PIL import ImageCms

    key = str(value or "relative").strip().lower().replace("-", "_")
    attr = _RENDERING_INTENTS.get(key)
    if attr is None:
        raise ValueError(
            "rendering_intent không hợp lệ; dùng relative, perceptual, saturation hoặc absolute"
        )
    return getattr(ImageCms.Intent, attr)


_DEFAULT_ICC_RGB_RANGE = (0.0, 1.0, 0.0, 1.0, 0.0, 1.0)


def _icc_rgb_component_range(
    colorspace,
) -> tuple[tuple[float, float, float, float, float, float] | None, str | None]:
    """Chỉ nhận `/Range` canonical của ICCBased RGB; trả `(range, lỗi)`.

    Với ICCBased image, `/Range` đồng thời là `/Decode` mặc định. Một range tùy
    biến cần decode ảnh, clip vector và xử lý `/Matte` trong đúng domain profile;
    lane LittleCMS 8-bit hiện chưa chứng minh được đủ ba bước nên phải fail-closed.
    """
    colorspace = _deref(colorspace)
    try:
        if not isinstance(colorspace, pikepdf.Array) or len(colorspace) < 2:
            return None, None
        if str(_deref(colorspace[0])) != "/ICCBased":
            return None, None
        profile = _deref(colorspace[1])
        if int(profile.get("/N", 0)) != 3:
            return None, None
        declared = profile.get("/Range")
        if declared is None:
            return _DEFAULT_ICC_RGB_RANGE, None
        values = tuple(float(value) for value in _deref(declared))
    except Exception as exc:  # noqa: BLE001
        return None, f"ICCBased RGB /Range không đọc được: {exc}"
    if len(values) != 6:
        return None, f"ICCBased RGB /Range cần 6 số, nhận {len(values)}"
    if not all(math.isfinite(value) for value in values):
        return None, "ICCBased RGB /Range chứa số không hữu hạn"
    if any(values[index] > values[index + 1] for index in range(0, 6, 2)):
        return None, "ICCBased RGB /Range có cận dưới lớn hơn cận trên"
    if any(
        abs(actual - expected) > 1.0e-9
        for actual, expected in zip(values, _DEFAULT_ICC_RGB_RANGE)
    ):
        return None, (
            "ICCBased RGB /Range tùy biến chưa được hỗ trợ; "
            "cần mapping canonical [0 1] cho ba kênh"
        )
    return _DEFAULT_ICC_RGB_RANGE, None


def _icc_rgb_range_blocker_code(error: str) -> str:
    return (
        "UNSUPPORTED_ICC_RANGE"
        if "chưa được hỗ trợ" in error
        else "INVALID_ICC_RANGE"
    )


_CALRGB_D50 = (0.9642, 1.0, 0.8249)
_CALRGB_BRADFORD = (
    (0.8951, 0.2664, -0.1614),
    (-0.7502, 1.7135, 0.0367),
    (0.0389, -0.0685, 1.0296),
)
_CALRGB_BRADFORD_INVERSE = (
    (0.9869929, -0.1470543, 0.1599627),
    (0.4323053, 0.5183603, 0.0492912),
    (-0.0085287, 0.0400428, 0.9684867),
)


def _calrgb_is_colorspace(colorspace) -> bool:
    colorspace = _deref(colorspace)
    try:
        return (
            isinstance(colorspace, pikepdf.Array)
            and len(colorspace) > 1
            and str(_deref(colorspace[0])) == "/CalRGB"
        )
    except Exception:  # noqa: BLE001
        return False


def _calrgb_matvec(matrix, vector) -> tuple[float, float, float]:
    return tuple(
        sum(float(row[index]) * float(vector[index]) for index in range(3))
        for row in matrix
    )


def _calrgb_fixed(value: float) -> int:
    encoded = int(round(float(value) * 65536.0))
    if not -(2**31) <= encoded < 2**31:
        raise ValueError("giá trị vượt miền s15Fixed16")
    return encoded


def _calrgb_xyz_tag(values) -> bytes:
    return b"XYZ " + bytes(4) + b"".join(
        struct.pack(">i", _calrgb_fixed(value)) for value in values
    )


def _calrgb_gamma_tag(gamma: float) -> bytes:
    # ICC v4 parametricCurve type 0 biểu diễn chính xác y=x^gamma với độ phân
    # giải s15Fixed16; không ép gamma PDF về đường cong sRGB.
    return struct.pack(">4sIHHi", b"para", 0, 0, 0, _calrgb_fixed(gamma))


def _calrgb_profile_bytes(colorspace) -> tuple[bytes | None, str | None]:
    """Dựng ICC matrix-shaper từ CalRGB đủ calibration, hoặc trả lý do chặn.

    Lane hẹp yêu cầu matrix tự nhất quán với WhitePoint và BlackPoint bằng 0.
    BlackPoint khác 0 cần đúng gamut mapping CIE của PDF, không thể giả bằng
    BPC của profile đích; trường hợp đó tiếp tục fail-closed.
    """
    # COLOR (audit 2026-08-20 §COLOR.20): chỉ mở CalRGB khi có thể chứng minh
    # cùng một mapping XYZ; không hạ toàn bộ CalRGB thành sRGB như PPE cũ.
    colorspace = _deref(colorspace)
    if not _calrgb_is_colorspace(colorspace):
        return None, None
    try:
        params = _deref(colorspace[1])
        if not isinstance(params, pikepdf.Dictionary):
            return None, "CalRGB thiếu dictionary calibration"

        def numbers(key: str, count: int, default=None):
            raw = params.get(key)
            if raw is None:
                if default is None:
                    raise ValueError(f"thiếu {key}")
                return tuple(float(value) for value in default)
            values = tuple(float(value) for value in _deref(raw))
            if len(values) != count:
                raise ValueError(f"{key} cần {count} số, nhận {len(values)}")
            if not all(math.isfinite(value) for value in values):
                raise ValueError(f"{key} chứa số không hữu hạn")
            return values

        white = numbers("/WhitePoint", 3)
        black = numbers("/BlackPoint", 3, (0.0, 0.0, 0.0))
        gamma = numbers("/Gamma", 3, (1.0, 1.0, 1.0))
        matrix_values = numbers(
            "/Matrix",
            9,
            (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0),
        )
    except Exception as exc:  # noqa: BLE001
        return None, f"CalRGB không hợp lệ: {exc}"

    if white[0] <= 0.0 or white[2] <= 0.0 or abs(white[1] - 1.0) > 1.0e-6:
        return None, "CalRGB không hợp lệ: WhitePoint cần X/Z > 0 và Y = 1"
    if any(value < 0.0 for value in black):
        return None, "CalRGB không hợp lệ: BlackPoint không được âm"
    if any(value > 1.0e-9 for value in black):
        return None, "CalRGB BlackPoint khác 0 chưa được hỗ trợ"
    if any(value <= 0.0 or value >= 32768.0 for value in gamma):
        return None, "CalRGB không hợp lệ: Gamma phải dương và hữu hạn"

    # PDF lưu Matrix theo ba cột [XA YA ZA XB YB ZB XC YC ZC].
    matrix = (
        (matrix_values[0], matrix_values[3], matrix_values[6]),
        (matrix_values[1], matrix_values[4], matrix_values[7]),
        (matrix_values[2], matrix_values[5], matrix_values[8]),
    )
    determinant = (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )
    if abs(determinant) <= 1.0e-12:
        return None, "CalRGB không hợp lệ: Matrix suy biến"
    matrix_white = tuple(sum(row) for row in matrix)
    if any(
        abs(actual - expected) > max(0.002, abs(expected) * 0.005)
        for actual, expected in zip(matrix_white, white)
    ):
        return None, (
            "CalRGB Matrix không khớp WhitePoint chưa được hỗ trợ; "
            "không thể chứng minh gamut mapping"
        )

    try:
        source_cone = _calrgb_matvec(_CALRGB_BRADFORD, white)
        target_cone = _calrgb_matvec(_CALRGB_BRADFORD, _CALRGB_D50)
        if any(abs(value) <= 1.0e-12 for value in source_cone):
            raise ValueError("WhitePoint không thể chromatic-adapt")
        scale = tuple(target / source for target, source in zip(target_cone, source_cone))
        adapted_columns = []
        for column in zip(*matrix):
            cone = _calrgb_matvec(_CALRGB_BRADFORD, column)
            adapted_columns.append(
                _calrgb_matvec(
                    _CALRGB_BRADFORD_INVERSE,
                    tuple(value * factor for value, factor in zip(cone, scale)),
                )
            )
        if not all(
            math.isfinite(value) and -32768.0 <= value < 32768.0
            for column in adapted_columns
            for value in column
        ):
            raise ValueError("Matrix sau chromatic adaptation vượt miền ICC")

        template_path = Path(__file__).resolve().parents[1] / "assets" / "icc" / "sRGB.icc"
        template = template_path.read_bytes()
        tag_count = struct.unpack_from(">I", template, 128)[0]
        tags: list[tuple[str, bytes]] = []
        replacements = {
            "rXYZ": _calrgb_xyz_tag(adapted_columns[0]),
            "gXYZ": _calrgb_xyz_tag(adapted_columns[1]),
            "bXYZ": _calrgb_xyz_tag(adapted_columns[2]),
            "rTRC": _calrgb_gamma_tag(gamma[0]),
            "gTRC": _calrgb_gamma_tag(gamma[1]),
            "bTRC": _calrgb_gamma_tag(gamma[2]),
        }
        for index in range(tag_count):
            entry = 132 + index * 12
            signature = template[entry : entry + 4].decode("ascii")
            offset, size = struct.unpack_from(">II", template, entry + 4)
            tags.append(
                (signature, replacements.get(signature, template[offset : offset + size]))
            )

        table_size = 4 + len(tags) * 12
        table = bytearray(struct.pack(">I", len(tags)))
        payload = bytearray()
        for signature, data in tags:
            offset = 128 + table_size + len(payload)
            aligned = (offset + 3) & ~3
            payload.extend(bytes(aligned - offset))
            table.extend(signature.encode("ascii"))
            table.extend(struct.pack(">II", aligned, len(data)))
            payload.extend(data)
            payload.extend(bytes((-len(payload)) % 4))

        header = bytearray(template[:128])
        header[84:100] = bytes(16)  # profile ID cũ không còn đúng.
        profile = header + table + payload
        struct.pack_into(">I", profile, 0, len(profile))
        return bytes(profile), None
    except Exception as exc:  # noqa: BLE001
        return None, f"CalRGB không thể dựng profile ICC nội bộ: {exc}"


def _calrgb_blocker_code(error: str) -> str:
    return "UNSUPPORTED_CALRGB" if "chưa được hỗ trợ" in error else "INVALID_CALRGB"


_COLOR_ADJUSTMENT_LIMITS = {
    "brightness_lstar": (-10.0, 10.0),
    "contrast_percent": (-20.0, 20.0),
    "vibrance_percent": (-20.0, 20.0),
}
_COLOR_ADJUSTMENT_STAGES = {"pre_icc", "post_cmyk"}


def _normalize_color_adjustment_stage(value: str | None) -> str:
    stage = str(value or "pre_icc").strip().lower()
    if stage not in _COLOR_ADJUSTMENT_STAGES:
        raise ValueError("adjustment_stage phải là pre_icc hoặc post_cmyk")
    return stage


def _normalize_color_adjustments(
    *,
    brightness_lstar: float = 0,
    contrast_percent: float = 0,
    vibrance_percent: float = 0,
) -> tuple[float, float, float]:
    """Kiểm tra và chuẩn hóa ba nút tinh chỉnh màu.

    Các giới hạn này là giới hạn nghiệp vụ, không phải giới hạn của Pillow:
    bù L* quá lớn dễ cắt trắng, còn kéo tương phản/độ rực quá tay làm tăng
    sai khác proof và TAC. Không tự động ``clamp`` vì người gọi cần biết request
    của mình không hợp lệ thay vì tưởng đã áp dụng đủ.
    """
    values = {
        "brightness_lstar": brightness_lstar,
        "contrast_percent": contrast_percent,
        "vibrance_percent": vibrance_percent,
    }
    normalized: dict[str, float] = {}
    for name, value in values.items():
        if isinstance(value, bool):
            raise ValueError(f"{name} phải là số hữu hạn")
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} phải là số hữu hạn") from exc
        if not math.isfinite(number):
            raise ValueError(f"{name} phải là số hữu hạn")
        low, high = _COLOR_ADJUSTMENT_LIMITS[name]
        if number < low or number > high:
            raise ValueError(f"{name} phải nằm trong khoảng {low:g}..{high:g}")
        normalized[name] = number
    return (
        normalized["brightness_lstar"],
        normalized["contrast_percent"],
        normalized["vibrance_percent"],
    )


class _CmykTransform:
    """RGB 0..1 → CMYK 0..1 qua ICC, có cache theo giá trị.

    Khi ``adjustment_stage=post_cmyk`` (mặc định ở UI), engine đổi sang CMYK
    trước rồi đưa mẫu CMYK qua Lab của chính profile đích để bù sáng/tương
    phản/độ rực — tương đương thao tác ``Convert to Profile`` rồi chỉnh proof.
    ``pre_icc`` vẫn có cho recipe/API cũ cần giữ gamut nguồn. Cả hai lane đều
    không sửa trực tiếp từng kênh mực.

    Một trang thật dùng vài chục màu nhưng gọi tới hàng nghìn lần; ImageCms
    dựng ảnh 1×1 cho mỗi lần gọi nên cache là bắt buộc, không phải tối ưu sớm.
    """

    def __init__(
        self,
        rgb_profile: str | bytes,
        cmyk_profile: str,
        *,
        rendering_intent: str = "relative",
        black_point_compensation: bool = True,
        brightness_lstar: float = 0,
        contrast_percent: float = 0,
        vibrance_percent: float = 0,
        adjustment_stage: str = "pre_icc",
    ):
        from PIL import Image, ImageCms

        self._Image = Image
        self._ImageCms = ImageCms
        (
            self._brightness_lstar,
            self._contrast_percent,
            self._vibrance_percent,
        ) = _normalize_color_adjustments(
            brightness_lstar=brightness_lstar,
            contrast_percent=contrast_percent,
            vibrance_percent=vibrance_percent,
        )
        self._adjustment_stage = _normalize_color_adjustment_stage(adjustment_stage)
        if isinstance(rgb_profile, (bytes, bytearray)):
            self._rgb_profile_handle = ImageCms.getOpenProfile(BytesIO(bytes(rgb_profile)))
        else:
            self._rgb_profile_handle = ImageCms.getOpenProfile(rgb_profile)
        self._cmyk_profile_handle = ImageCms.getOpenProfile(cmyk_profile)
        self._adjustment_enabled = any(
            abs(value) > 1.0e-12
            for value in (
                self._brightness_lstar,
                self._contrast_percent,
                self._vibrance_percent,
            )
        )
        self._rgb_to_lab = None
        self._cmyk_to_lab = None
        self._lab_to_cmyk = None
        if self._adjustment_enabled:
            # Cả hai thứ tự đều dùng Lab, không kéo trực tiếp C/M/Y/K. Với
            # ``post_cmyk`` (mặc định ở UI), đổi profile trước rồi tinh chỉnh
            # theo proof — đúng workflow Photoshop/Acrobat. ``pre_icc`` giữ
            # gamut nguồn trước khi đổi profile cho recipe cũ. Đường mặc định
            # 0,0,0 không đi qua vòng Lab để giữ byte-parity.
            lab_profile = ImageCms.createProfile("LAB")
            intent = _normalize_rendering_intent(rendering_intent)
            flags = _CMS_FLAGS(black_point_compensation=black_point_compensation)
            self._rgb_to_lab = ImageCms.buildTransform(
                self._rgb_profile_handle,
                lab_profile,
                "RGB",
                "LAB",
                renderingIntent=intent,
                flags=flags,
            )
            self._cmyk_to_lab = ImageCms.buildTransform(
                self._cmyk_profile_handle,
                lab_profile,
                "CMYK",
                "LAB",
                renderingIntent=intent,
                flags=flags,
            )
            self._lab_to_cmyk = ImageCms.buildTransform(
                lab_profile,
                self._cmyk_profile_handle,
                "LAB",
                "CMYK",
                renderingIntent=intent,
                flags=flags,
            )
        self._tf = ImageCms.buildTransform(
            self._rgb_profile_handle,
            self._cmyk_profile_handle,
            "RGB",
            "CMYK",
            renderingIntent=_normalize_rendering_intent(rendering_intent),
            flags=_CMS_FLAGS(black_point_compensation=black_point_compensation),
        )
        self._cache: dict[tuple[int, int, int], tuple[float, float, float, float]] = {}

    def _adjust_lab_image(self, lab_image):
        """Áp bù L*, tương phản và độ rực trên ảnh Pillow mode ``LAB``."""
        if not self._adjustment_enabled:
            return lab_image
        try:
            import numpy as np

            values = np.asarray(lab_image, dtype=np.float32)
            lightness = values[..., 0] * (100.0 / 255.0)
            lightness = (
                (lightness - 50.0) * (1.0 + self._contrast_percent / 100.0)
                + 50.0
                + self._brightness_lstar
            )
            chroma = values[..., 1:3] - 128.0
            if abs(self._vibrance_percent) > 1.0e-12:
                # Ưu tiên vùng ít bão hòa (vibrance) để không đẩy màu đã rực
                # vào clipping nhanh như Saturation tuyến tính.
                magnitude = np.sqrt(np.sum(chroma * chroma, axis=-1))
                weight = np.clip(1.0 - magnitude / 128.0, 0.0, 1.0)
                factor = 1.0 + (self._vibrance_percent / 100.0) * weight
                chroma = chroma * factor[..., None]
            values[..., 0] = np.clip(lightness * (255.0 / 100.0), 0.0, 255.0)
            values[..., 1:3] = np.clip(chroma + 128.0, 0.0, 255.0)
            return self._Image.fromarray(
                np.rint(values).astype(np.uint8),
                "LAB",
            )
        except Exception:  # noqa: BLE001
            # Numpy có trong bundle desktop; fallback này giữ sidecar tối giản
            # chạy được nếu môi trường kiểm tra chỉ có Pillow.
            adjusted = bytearray()
            for lightness_byte, a_byte, b_byte in lab_image.getdata():
                lightness = lightness_byte * (100.0 / 255.0)
                lightness = (
                    (lightness - 50.0) * (1.0 + self._contrast_percent / 100.0)
                    + 50.0
                    + self._brightness_lstar
                )
                a_value = float(a_byte) - 128.0
                b_value = float(b_byte) - 128.0
                if abs(self._vibrance_percent) > 1.0e-12:
                    magnitude = math.sqrt(a_value * a_value + b_value * b_value)
                    weight = max(0.0, min(1.0, 1.0 - magnitude / 128.0))
                    factor = 1.0 + (self._vibrance_percent / 100.0) * weight
                    a_value *= factor
                    b_value *= factor
                adjusted.extend(
                    (
                        int(round(max(0.0, min(255.0, lightness * 255.0 / 100.0)))),
                        int(round(max(0.0, min(255.0, a_value + 128.0)))),
                        int(round(max(0.0, min(255.0, b_value + 128.0)))),
                    )
                )
            return self._Image.frombytes("LAB", lab_image.size, bytes(adjusted))

    def _apply(self, pil):
        rgb = pil.convert("RGB")
        cmyk = self._ImageCms.applyTransform(rgb, self._tf)
        if not self._adjustment_enabled:
            return cmyk
        if self._adjustment_stage == "pre_icc":
            lab = self._ImageCms.applyTransform(rgb, self._rgb_to_lab)
        else:
            lab = self._ImageCms.applyTransform(cmyk, self._cmyk_to_lab)
        adjusted_lab = self._adjust_lab_image(lab)
        return self._ImageCms.applyTransform(adjusted_lab, self._lab_to_cmyk)

    def __call__(self, r: float, g: float, b: float) -> tuple[float, float, float, float]:
        key = (
            int(round(max(0.0, min(1.0, r)) * 255)),
            int(round(max(0.0, min(1.0, g)) * 255)),
            int(round(max(0.0, min(1.0, b)) * 255)),
        )
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        src = self._Image.new("RGB", (1, 1), key)
        dst = self._apply(src)
        c, m, y, k = dst.getpixel((0, 0))
        out = (c / 255.0, m / 255.0, y / 255.0, k / 255.0)
        self._cache[key] = out
        return out

    def image(self, pil):
        return self._apply(pil)


@dataclass
class _ProcessColorState:
    """Trạng thái màu PDF cần sống xuyên `/Contents` và stack `q/Q`.

    `*_components=None` nghĩa là trạng thái được kế thừa nhưng caller không
    chứng minh được. Form XObject bắt đầu ở trạng thái này vì màu hiện hành đi
    vào Form từ toán tử `Do`; đoán DeviceGray có thể biến một `scn` hợp lệ thành
    màu khác mà hậu kiểm không nhìn thấy.
    """

    fill_tf: _CmykTransform | None = None
    stroke_tf: _CmykTransform | None = None
    fill_components: int | None = 1
    stroke_components: int | None = 1
    stack: list[tuple[_CmykTransform | None, _CmykTransform | None, int | None, int | None]] = field(
        default_factory=list
    )

    @classmethod
    def inherited_unknown(cls) -> "_ProcessColorState":
        return cls(fill_components=None, stroke_components=None)

    def push(self) -> None:
        self.stack.append(
            (self.fill_tf, self.stroke_tf, self.fill_components, self.stroke_components)
        )

    def pop(self) -> bool:
        if not self.stack:
            return False
        (
            self.fill_tf,
            self.stroke_tf,
            self.fill_components,
            self.stroke_components,
        ) = self.stack.pop()
        return True


def _process_colorspace_components(colorspace, resources=None) -> int | None:
    """Số toán hạng process của `sc[n]`; `None` khi không thể kết luận an toàn."""
    colorspace = _resolve_resource_colorspace(resources, colorspace)
    colorspace = _deref(colorspace)
    name = str(colorspace)
    if name in ("/DeviceGray", "/G", "/CalGray"):
        return 1
    if name in ("/DeviceRGB", "/RGB"):
        return 3
    if name in ("/DeviceCMYK", "/CMYK"):
        return 4
    if not isinstance(colorspace, pikepdf.Array) or not colorspace:
        return None
    family = str(_deref(colorspace[0]))
    if family == "/CalRGB":
        return 3
    if family == "/ICCBased" and len(colorspace) > 1:
        try:
            return int(_deref(colorspace[1]).get("/N", 0)) or None
        except Exception:  # noqa: BLE001
            return None
    if family in ("/Indexed", "/I", "/Separation"):
        return 1
    if family == "/DeviceN" and len(colorspace) > 1:
        try:
            names = _deref(colorspace[1])
            return len(names) if isinstance(names, pikepdf.Array) else None
        except Exception:  # noqa: BLE001
            return None
    # `Pattern scn` có thêm tên pattern nên không áp quy tắc đếm process.
    return None


def _cs_is_device_rgb(cs) -> bool:
    """`True` khi colorspace là RGB thiết bị, CalRGB hoặc ICC 3 kênh.

    ICCBased N=3 gộp chung vì mục tiêu là bỏ mọi thứ không phải mực; giữ lại
    một ICC RGB thì file vẫn không phải CMYK-only và rule preflight vẫn báo.
    """
    cs = _deref(cs)
    if cs is None:
        return False
    if str(cs) in ("/DeviceRGB", "/RGB"):
        return True
    try:
        if isinstance(cs, pikepdf.Array) and len(cs) > 1:
            family = str(_deref(cs[0]))
            if family == "/CalRGB":
                return True
            if family == "/ICCBased":
                stream = _deref(cs[1])
                return int(stream.get("/N", 0)) == 3
    except Exception:  # noqa: BLE001
        return False
    return False


def _resolve_resource_colorspace(resources, target):
    """Resolve tên ColorSpace trong đúng resource scope của content stream."""
    target = _deref(target)
    if target is None:
        return None
    if isinstance(target, pikepdf.Name):
        name = str(target)
        if name in ("/DeviceRGB", "/RGB", "/DeviceGray", "/G", "/DeviceCMYK", "/CMYK"):
            return target
        try:
            color_dict = _deref(resources.get("/ColorSpace")) if resources else None
            return _deref(color_dict.get(name)) if isinstance(color_dict, pikepdf.Dictionary) else None
        except Exception:  # noqa: BLE001
            return None
    return target


def _resource_scope(owner, inherited):
    """Giữ `/Resources <<>>` rỗng là scope hợp lệ, chỉ kế thừa khi thiếu key."""
    try:
        own = owner.get("/Resources")
    except Exception:  # noqa: BLE001
        own = None
    return inherited if own is None else own


def _embedded_rgb_profile(colorspace) -> bytes | None:
    """Lấy ICC RGB nhúng của ICCBased, không thay bằng profile mặc định."""
    colorspace = _deref(colorspace)
    try:
        if not isinstance(colorspace, pikepdf.Array) or len(colorspace) < 2:
            return None
        if str(_deref(colorspace[0])) != "/ICCBased":
            return None
        profile = _deref(colorspace[1])
        if int(profile.get("/N", 0)) != 3:
            return None
        raw = bytes(profile.read_bytes())
        return raw or None
    except Exception:  # noqa: BLE001
        return None


def _validate_icc_profile(colorspace) -> tuple[bool, str]:
    """Đối chiếu `/N` với chữ ký thật trong ICC, không tin metadata PDF.

    PDF chỉ cho ICCBased 1/3/4 thành phần ở các lane Gray/RGB/CMYK mà writer
    hiện hiểu. Một profile RGB bị khai `/N=4` từng lọt hậu kiểm như CMYK và làm
    artifact sai vẫn được công bố; vì vậy cả parse lỗi lẫn mismatch đều là
    blocker, tuyệt đối không fallback sang sRGB.
    """
    colorspace = _deref(colorspace)
    try:
        if not isinstance(colorspace, pikepdf.Array) or len(colorspace) < 2:
            return False, "ICCBased thiếu profile"
        profile = _deref(colorspace[1])
        declared = int(profile.get("/N", 0))
        raw = bytes(profile.read_bytes())
        if not raw:
            return False, "ICC rỗng"
    except Exception as exc:  # noqa: BLE001
        return False, f"không đọc được ICC: {exc}"

    expected = {1: "GRAY", 3: "RGB", 4: "CMYK"}.get(declared)
    if expected is None:
        return False, f"ICCBased /N={declared or '?'} chưa được hỗ trợ"
    if declared == 3:
        _component_range, range_error = _icc_rgb_component_range(colorspace)
        if range_error is not None:
            return False, range_error
    try:
        from PIL import ImageCms

        opened = ImageCms.getOpenProfile(BytesIO(raw))
        actual = str(opened.profile.xcolor_space).strip().upper()
    except Exception as exc:  # noqa: BLE001
        return False, f"ICC không hợp lệ: {exc}"
    if actual != expected:
        return False, f"ICCBased /N={declared} nhưng profile thật là {actual or '?'}"
    return True, actual


def _transform_for_colorspace(
    colorspace,
    default_tf: _CmykTransform,
    cmyk_profile: str,
    *,
    rendering_intent: str,
    black_point_compensation: bool,
    brightness_lstar: float = 0,
    contrast_percent: float = 0,
    vibrance_percent: float = 0,
    adjustment_stage: str = "pre_icc",
    cache: dict[bytes, _CmykTransform],
) -> _CmykTransform | None:
    """Chọn đúng source ICC cho object; thiếu/không hợp lệ thì fail-closed."""
    colorspace = _deref(colorspace)
    if colorspace is None or str(colorspace) in ("/DeviceRGB", "/RGB"):
        return default_tf
    if isinstance(colorspace, pikepdf.Array):
        family = str(_deref(colorspace[0])) if len(colorspace) else ""
        if family in ("/Indexed", "/I") and len(colorspace) > 1:
            return _transform_for_colorspace(
                colorspace[1],
                default_tf,
                cmyk_profile,
                rendering_intent=rendering_intent,
                black_point_compensation=black_point_compensation,
                brightness_lstar=brightness_lstar,
                contrast_percent=contrast_percent,
                vibrance_percent=vibrance_percent,
                adjustment_stage=adjustment_stage,
                cache=cache,
            )
        if family == "/CalRGB":
            raw, calrgb_error = _calrgb_profile_bytes(colorspace)
            if calrgb_error is not None or raw is None:
                return None
        elif family == "/ICCBased":
            raw = _embedded_rgb_profile(colorspace)
            if raw is None:
                return None
            component_range, range_error = _icc_rgb_component_range(colorspace)
            if range_error is not None or component_range is None:
                return None
        else:
            return default_tf
        hit = cache.get(raw)
        if hit is not None:
            return hit
        try:
            hit = _CmykTransform(
                raw,
                cmyk_profile,
                rendering_intent=rendering_intent,
                black_point_compensation=black_point_compensation,
                brightness_lstar=brightness_lstar,
                contrast_percent=contrast_percent,
                vibrance_percent=vibrance_percent,
                adjustment_stage=adjustment_stage,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("ICC RGB nhúng không hợp lệ: %s", exc)
            return None
        cache[raw] = hit
        return hit
    return default_tf


_ISOLATED_FLATTEN_OPS = frozenset({"q", "Q", "cm", "Do"})


def _nested_form_image_uses(
    form: pikepdf.Stream,
    resources,
    seen_forms: frozenset[tuple[int, int]] = frozenset(),
) -> list[tuple[tuple[int, int], pikepdf.Stream, bool]]:
    """Thu image nằm trong Form để không flatten nhầm object dùng chung.

    Form luôn được đánh dấu ``safe=False``: dù nội dung bên trong chỉ là một
    ảnh, backdrop/graphics state vẫn có thể đến từ caller. Hàm này chỉ phục vụ
    đếm reference toàn tài liệu, không phải lane chuyển đổi Form.
    """
    form_key = _objkey(form)
    if form_key is not None and form_key in seen_forms:
        return []
    next_seen = seen_forms | ({form_key} if form_key is not None else frozenset())
    resources = _resource_scope(form, resources)
    resources = _deref(resources)
    if not isinstance(resources, pikepdf.Dictionary):
        return []
    xobjects = _deref(resources.get("/XObject"))
    if not isinstance(xobjects, pikepdf.Dictionary):
        return []
    try:
        instructions = pikepdf.parse_content_stream(form)
    except Exception:  # noqa: BLE001
        # Không parse được Form thì mọi image trong resource scope đều bị coi
        # là có thể được dùng; thà bỏ qua flatten còn hơn làm sai object dùng
        # chung.
        out: list[tuple[tuple[int, int], pikepdf.Stream, bool]] = []
        for value in dict(xobjects).values():
            target = _deref(value)
            key = _objkey(target)
            if key is not None and isinstance(target, pikepdf.Stream):
                if str(target.get("/Subtype", "")) == "/Image":
                    out.append((key, target, False))
        return out

    out: list[tuple[tuple[int, int], pikepdf.Stream, bool]] = []
    for instruction in instructions:
        if str(instruction.operator) != "Do" or len(instruction.operands) != 1:
            continue
        target = _deref(xobjects.get(str(instruction.operands[0])))
        if not isinstance(target, pikepdf.Stream):
            continue
        subtype = str(target.get("/Subtype", ""))
        key = _objkey(target)
        if subtype == "/Image" and key is not None:
            out.append((key, target, False))
        elif subtype == "/Form":
            out.extend(_nested_form_image_uses(target, resources, next_seen))
    return out


def _page_image_uses(page) -> list[tuple[tuple[int, int], pikepdf.Stream, bool]]:
    """Liệt kê image `Do` trực tiếp trên một trang và mức an toàn của trang.

    Lô J chỉ flatten một ảnh khi biết chắc trang không có nền/đối tượng khác.
    Vì vậy parser này cố ý bảo thủ: chỉ cho `q/Q`, `cm` và đúng một `Do` ảnh;
    mọi toán tử khác (kể cả Form, `gs`, inline image hoặc path) làm trang không
    đủ điều kiện. Vẫn thu các image `Do` đã gặp trên trang không an toàn để
    ngăn việc một object dùng lại ở cả ngữ cảnh an toàn lẫn không an toàn.
    """
    resources = _deref(page.get("/Resources"))
    if not isinstance(resources, pikepdf.Dictionary):
        return []
    if page.get("/Group") is not None:
        page_safe = False
    else:
        page_safe = True
    try:
        annots = _deref(page.get("/Annots"))
        if isinstance(annots, pikepdf.Array) and len(annots):
            page_safe = False
    except Exception:  # noqa: BLE001
        page_safe = False

    contents = page.get("/Contents")
    if contents is None:
        return []
    streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
    xobjects = _deref(resources.get("/XObject"))
    if not isinstance(xobjects, pikepdf.Dictionary):
        return []

    uses: list[tuple[tuple[int, int], pikepdf.Stream, bool]] = []
    depth = 0
    try:
        for content in streams:
            stream = _deref(content)
            if not isinstance(stream, pikepdf.Stream):
                return []
            instructions = pikepdf.parse_content_stream(stream)
            for instruction in instructions:
                op = str(instruction.operator)
                operands = list(instruction.operands)
                if op == "q":
                    depth += 1
                    continue
                if op == "Q":
                    if depth <= 0:
                        page_safe = False
                    else:
                        depth -= 1
                    continue
                if op == "cm":
                    if len(operands) != 6 or not all(
                        math.isfinite(float(value)) for value in operands
                    ):
                        page_safe = False
                    continue
                if op == "Do":
                    if len(operands) != 1:
                        page_safe = False
                        continue
                    target = _deref(xobjects.get(str(operands[0])))
                    if not isinstance(target, pikepdf.Stream):
                        page_safe = False
                        continue
                    if str(target.get("/Subtype", "")) != "/Image":
                        # Form XObject may contain an image, but its inherited
                        # graphics state is not local enough for this lane.
                        page_safe = False
                        if str(target.get("/Subtype", "")) == "/Form":
                            uses.extend(
                                _nested_form_image_uses(
                                    target,
                                    _resource_scope(target, resources),
                                )
                            )
                        continue
                    key = _objkey(target)
                    if key is None:
                        page_safe = False
                        continue
                    uses.append((key, target, page_safe))
                    continue
                # `INLINE IMAGE`, path painting, text, `gs`, blend and clipping
                # all make the page backdrop-dependent.
                if op not in _ISOLATED_FLATTEN_OPS:
                    page_safe = False
            if depth != 0:
                page_safe = False
                depth = 0
    except Exception:  # noqa: BLE001
        return []

    if len(uses) != 1:
        return [(key, target, False) for key, target, _safe in uses]
    key, target, _safe = uses[0]
    return [(key, target, page_safe)]


def _page_nested_resource_image_uses(
    page,
) -> list[tuple[tuple[int, int], pikepdf.Stream, bool]]:
    """Thu image trong annotation appearance/pattern của trang.

    Các stream này không xuất hiện như `Do` trực tiếp của page nhưng vẫn được
    render. Nếu chúng dùng lại ảnh có alpha, flatten object toàn tài liệu sẽ
    làm thay đổi backdrop của chúng nên phải loại candidate.
    """
    resources = _deref(page.get("/Resources"))
    if not isinstance(resources, pikepdf.Dictionary):
        return []
    out: list[tuple[tuple[int, int], pikepdf.Stream, bool]] = []
    try:
        patterns = _deref(resources.get("/Pattern"))
        if isinstance(patterns, pikepdf.Dictionary):
            for value in dict(patterns).values():
                pattern = _deref(value)
                if isinstance(pattern, pikepdf.Stream):
                    out.extend(_nested_form_image_uses(pattern, resources))

        annots = _deref(page.get("/Annots"))
        if isinstance(annots, pikepdf.Array):
            for annot in annots:
                ap = _deref(_deref(annot).get("/AP"))
                if not isinstance(ap, pikepdf.Dictionary):
                    continue
                for value in dict(ap).values():
                    value = _deref(value)
                    streams = (
                        [value]
                        if isinstance(value, pikepdf.Stream)
                        else [_deref(item) for item in dict(value).values()]
                        if isinstance(value, pikepdf.Dictionary)
                        else []
                    )
                    for stream in streams:
                        if isinstance(stream, pikepdf.Stream):
                            out.extend(
                                _nested_form_image_uses(
                                    stream,
                                    _resource_scope(stream, resources),
                                )
                            )
    except Exception:  # noqa: BLE001
        # Không chứng minh được nhánh phụ ⇒ caller không nên flatten object
        # dùng chung; trả một sentinel rỗng ở đây vẫn để direct page tự fail khi
        # có annotation/pattern, còn reference ngoài scope sẽ được scanner bắt.
        return out
    return out


def _isolated_smask_candidates(pdf: pikepdf.Pdf) -> list[pikepdf.Stream]:
    """Tìm ảnh RGB có SMask xuất hiện đúng một lần trong trang trắng cô lập."""
    uses: dict[tuple[int, int], list[tuple[pikepdf.Stream, bool]]] = {}
    for page in pdf.pages:
        page_uses = _page_image_uses(page)
        page_uses.extend(_page_nested_resource_image_uses(page))
        for key, image, page_safe in page_uses:
            uses.setdefault(key, []).append((image, page_safe))

    candidates: list[pikepdf.Stream] = []
    for entries in uses.values():
        # Dùng lại cùng ảnh ở một trang khác (hoặc cả ngữ cảnh an toàn và
        # không an toàn) thì không được flatten object dùng chung.
        if len(entries) != 1 or not entries[0][1]:
            continue
        image = entries[0][0]
        if not _cs_is_device_rgb(image.get("/ColorSpace")):
            continue
        # Lô N chỉ mở CalRGB phẳng. Alpha cần chuyển CalRGB → blend DeviceRGB
        # trước composite và một oracle riêng; giữ fail-closed ở lane này.
        if _calrgb_is_colorspace(image.get("/ColorSpace")):
            continue
        _component_range, range_error = _icc_rgb_component_range(
            image.get("/ColorSpace")
        )
        if range_error is not None:
            continue
        if not _image_decode_is_default(image, 3):
            continue
        if image.get("/Mask") is not None:
            continue
        smask = _deref(image.get("/SMask"))
        if not isinstance(smask, pikepdf.Stream):
            continue
        if smask.get("/Matte") is not None:
            try:
                matte = [float(value) for value in smask.get("/Matte")]
                if len(matte) != 3 or not all(
                    math.isfinite(value) and 0.0 <= value <= 1.0 for value in matte
                ):
                    continue
            except Exception:  # noqa: BLE001
                continue
        try:
            if bool(smask.get("/ImageMask", False)):
                continue
            if str(_deref(smask.get("/ColorSpace"))) not in ("/DeviceGray", "/G"):
                continue
            if int(smask.get("/BitsPerComponent", 0)) != 8:
                continue
            if not _image_decode_is_default(smask, 1):
                continue
            if int(smask.get("/Width", 0)) != int(image.get("/Width", 0)):
                continue
            if int(smask.get("/Height", 0)) != int(image.get("/Height", 0)):
                continue
            if any(f not in _RESAMPLABLE_FILTERS for f in _filter_names(image.get("/Filter"))):
                continue
            if any(f not in _RESAMPLABLE_FILTERS for f in _filter_names(smask.get("/Filter"))):
                continue
        except Exception:  # noqa: BLE001
            continue
        candidates.append(image)
    return candidates


def _flatten_isolated_rgb_image(
    image: pikepdf.Stream,
    rgb_profile: str,
    *,
    rendering_intent: str,
    black_point_compensation: bool,
) -> bool:
    """Composite một ảnh RGB+SMask lên giấy trắng trước khi chạy ICC.

    Chỉ gọi sau khi `_isolated_smask_candidates` đã chứng minh ảnh là paint duy
    nhất trên trang. `/Matte` được khử trước khi composite; ICCBased RGB được
    đổi sang blend DeviceRGB trước alpha (blend mặc định của PDF). Mọi lỗi trả
    `False` để scanner phía sau tiếp tục từ chối, không giao artifact nửa vời.
    """
    from PIL import Image, ImageCms

    smask = _deref(image.get("/SMask"))
    if not isinstance(smask, pikepdf.Stream):
        return False
    _component_range, range_error = _icc_rgb_component_range(
        image.get("/ColorSpace")
    )
    if range_error is not None:
        return False
    try:
        source = pikepdf.PdfImage(image).as_pil_image().convert("RGB")
        alpha = pikepdf.PdfImage(smask).as_pil_image().convert("L")
    except Exception as exc:  # noqa: BLE001
        logger.debug("flatten ảnh RGB có SMask thất bại: %s", exc)
        return False
    if source.size != alpha.size:
        return False

    matte_values: list[float] | None = None
    if smask.get("/Matte") is not None:
        try:
            matte_values = [float(value) for value in smask.get("/Matte")]
        except Exception:  # noqa: BLE001
            return False
        if len(matte_values) != 3 or not all(
            math.isfinite(value) and 0.0 <= value <= 1.0 for value in matte_values
        ):
            return False

    # Khử `/Matte` trên mẫu source trước khi đổi profile. Numpy là tuỳ chọn
    # (đã có trong môi trường desktop), fallback vòng byte giữ đúng semantics
    # cho bản sidecar tối giản không kèm numpy.
    unassociated = source
    if matte_values is not None:
        try:
            import numpy as np

            pixels = np.asarray(source, dtype=np.float32) / 255.0
            alpha_plane = np.asarray(alpha, dtype=np.float32)[..., None] / 255.0
            matte = np.asarray(matte_values, dtype=np.float32).reshape(1, 1, 3)
            pixels = np.divide(
                pixels - (1.0 - alpha_plane) * matte,
                alpha_plane,
                out=np.zeros_like(pixels),
                where=alpha_plane > 1.0e-9,
            )
            pixels = np.clip(pixels, 0.0, 1.0)
            unassociated = Image.fromarray(
                np.rint(pixels * 255.0).astype(np.uint8), "RGB"
            )
        except Exception:  # noqa: BLE001
            src = source.tobytes()
            mask = alpha.tobytes()
            raw = bytearray(len(src))
            for offset, mask_value in zip(range(0, len(src), 3), mask):
                a = mask_value / 255.0
                if a <= 1.0e-9:
                    continue
                for channel in range(3):
                    stored = src[offset + channel] / 255.0
                    value = (stored - (1.0 - a) * matte_values[channel]) / a
                    raw[offset + channel] = int(
                        round(max(0.0, min(1.0, value)) * 255.0)
                    )
            unassociated = Image.frombytes("RGB", source.size, bytes(raw))

    # ICCBased image samples are in their embedded profile, while PDF's default
    # transparency blending space is DeviceRGB. Convert the *unassociated*
    # source first, then apply alpha against paper white. DeviceRGB keeps the
    # original fast path and does not invent a second profile conversion.
    colorspace = _deref(image.get("/ColorSpace"))
    if isinstance(colorspace, pikepdf.Array):
        raw_profile = _embedded_rgb_profile(colorspace)
        if raw_profile is None:
            return False
        try:
            source_handle = ImageCms.getOpenProfile(BytesIO(raw_profile))
            blend_handle = ImageCms.getOpenProfile(rgb_profile)
            to_blend = ImageCms.buildTransform(
                source_handle,
                blend_handle,
                "RGB",
                "RGB",
                renderingIntent=_normalize_rendering_intent(rendering_intent),
                flags=_CMS_FLAGS(black_point_compensation=black_point_compensation),
            )
            unassociated = ImageCms.applyTransform(unassociated, to_blend).convert("RGB")
        except Exception as exc:  # noqa: BLE001
            logger.debug("đổi ICC RGB sang blend DeviceRGB thất bại: %s", exc)
            return False

    composite = Image.composite(unassociated, Image.new("RGB", source.size, (255, 255, 255)), alpha)
    out = composite.tobytes()

    image.write(zlib.compress(bytes(out), 6), filter=pikepdf.Name("/FlateDecode"))
    image["/Width"] = source.width
    image["/Height"] = source.height
    image["/BitsPerComponent"] = 8
    image["/Filter"] = pikepdf.Name("/FlateDecode")
    if isinstance(colorspace, pikepdf.Array):
        # Samples đã được đưa về blend DeviceRGB; giữ ICCBased khai báo sẽ làm
        # consumer diễn giải lại lần nữa và lệch alpha/color.
        image["/ColorSpace"] = pikepdf.Name("/DeviceRGB")
    for dead in ("/DecodeParms", "/DP", "/Decode", "/D", "/SMask", "/Mask"):
        if dead in image:
            del image[dead]
    return True


def _flatten_isolated_rgb_images(
    pdf: pikepdf.Pdf,
    rgb_profile: str,
    *,
    rendering_intent: str,
    black_point_compensation: bool,
) -> int:
    """Flatten các ảnh RGB+SMask đủ điều kiện; trả số ảnh đã đổi."""
    # Fast path cho phần lớn PDF phẳng: không parse content của từng trang nếu
    # object graph không hề có RGB+SMask. Đây là preflight nhẹ, không thay thế
    # hậu kiểm (ảnh orphan vẫn chỉ làm tốn một lần quét, không được publish).
    try:
        if not any(
            isinstance(obj, pikepdf.Stream)
            and str(obj.get("/Subtype", "")) == "/Image"
            and _cs_is_device_rgb(obj.get("/ColorSpace"))
            and obj.get("/SMask") is not None
            for obj in pdf.objects
        ):
            return 0
    except Exception:  # noqa: BLE001
        return 0
    changed = 0
    for image in _isolated_smask_candidates(pdf):
        if _flatten_isolated_rgb_image(
            image,
            rgb_profile,
            rendering_intent=rendering_intent,
            black_point_compensation=black_point_compensation,
        ):
            changed += 1
    return changed


# COLOR (audit 2026-08-20 §COLOR.21): một số PDF từ Illustrator/InDesign dùng
# alpha sống cho đúng *một* mảng vector RGB trên nền giấy trắng.  Không thể mở
# chung lane cho mọi ExtGState (blend mode, group, soft-mask và thứ tự nhiều
# paint đều phụ thuộc backdrop), nhưng từ chối cả ca hẹp này khiến người dùng
# phải raster hóa thủ công.  Helper dưới đây chỉ mở đúng mẫu có thể chứng minh
# bằng object graph + content stream: một ExtGState dùng một lần, chỉ alpha
# thường, một màu `rg` và một lệnh fill. Mọi hình thức mơ hồ tiếp tục
# fail-closed ở `_scan_convertibility`.
_SIMPLE_VECTOR_ALPHA_PATH_OPS = frozenset(
    {"q", "Q", "m", "l", "c", "v", "y", "h", "re", "n"}
)
_SIMPLE_VECTOR_ALPHA_PAINT_OPS = frozenset({"f", "F", "f*"})
_SIMPLE_VECTOR_ALPHA_GS_KEYS = frozenset(
    {"/Type", "/ca", "/CA", "/BM", "/SMask"}
)


def _simple_vector_alpha_candidate(pdf: pikepdf.Pdf, page):
    """Trả candidate `(stream, resources, gs_dict, name, rewritten)` hoặc None.

    Đây là predicate bảo thủ trước mutation. Không dùng regex/raw bytes vì
    operand của `gs`/`rg` cần được parser PDF hiểu đúng; cũng không đoán
    resource scope kế thừa của Form/Pattern.
    """
    try:
        if page.get("/Group") is not None or _deref(page.get("/Annots")):
            return None
        contents = page.get("/Contents")
        # Giữ lane hẹp: một stream duy nhất để không phải suy diễn state giữa
        # các stream khi còn ExtGState sống.
        if isinstance(contents, pikepdf.Array) or contents is None:
            return None
        stream = _deref(contents)
        if not isinstance(stream, pikepdf.Stream):
            return None
        resources = _deref(page.get("/Resources"))
        if not isinstance(resources, pikepdf.Dictionary):
            return None
        # Không có object/resource phụ nào có thể tạo backdrop khác nền trắng.
        for key in ("/XObject", "/Pattern", "/Shading"):
            if resources.get(key) is not None:
                return None
        extgstates = _deref(resources.get("/ExtGState"))
        if not isinstance(extgstates, pikepdf.Dictionary) or len(extgstates) != 1:
            return None
        name, gs_ref = next(iter(dict(extgstates).items()))
        name = str(name)
        gs = _deref(gs_ref)
        if not isinstance(gs, pikepdf.Dictionary):
            return None
        if not set(str(key) for key in gs.keys()).issubset(_SIMPLE_VECTOR_ALPHA_GS_KEYS):
            return None
        gs_key = _objkey(gs)
        # Resource value phải là object gián tiếp để có thể chứng minh nó
        # không bị dùng chung ở một scope khác trước khi sửa alpha.
        if gs_key is None:
            return None
        ca = float(gs.get("/ca", 1.0))
        ca_stroke = float(gs.get("/CA", 1.0))
        if not all(math.isfinite(value) and 0.0 <= value <= 1.0 for value in (ca, ca_stroke)):
            return None
        if ca >= 1.0:
            return None
        bm = _deref(gs.get("/BM"))
        if bm is not None and str(bm) not in ("/Normal", "[/Normal]"):
            return None
        smask = _deref(gs.get("/SMask"))
        if smask is not None and str(smask) not in ("/None",):
            return None

        # ExtGState object và tên gs phải chỉ xuất hiện một lần trong toàn PDF.
        # Nếu không, xóa/sửa alpha ở đây có thể làm đổi một placement khác.
        gs_resource_refs = 0
        gs_operator_refs = 0
        # Page dictionaries/resources thường được inline và không xuất hiện
        # trong `pdf.objects`; đưa chúng vào cùng phép đếm để không bỏ sót
        # chính resource của candidate.
        resource_holders = [page.get("/Resources") for page in pdf.pages]
        resource_holders.extend(
            obj.get("/Resources")
            for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream)
            and str(obj.get("/Subtype", "")) in ("/Form", "/Pattern")
        )
        seen_resource_holders: set[tuple[int, int] | int] = set()
        for holder in resource_holders:
            holder_obj = _deref(holder)
            holder_key = _objkey(holder_obj)
            marker = holder_key if holder_key is not None else id(holder_obj)
            if marker in seen_resource_holders:
                continue
            seen_resource_holders.add(marker)
            try:
                obj_ext = _deref(holder_obj.get("/ExtGState"))
                if isinstance(obj_ext, pikepdf.Dictionary):
                    gs_resource_refs += sum(
                        _objkey(_deref(value)) == gs_key
                        for value in dict(obj_ext).values()
                    )
            except Exception:  # noqa: BLE001
                return None
        for obj in pdf.objects:
            if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
                try:
                    obj_ext = _deref(obj.get("/ExtGState"))
                    if isinstance(obj_ext, pikepdf.Dictionary):
                        gs_resource_refs += sum(
                            _objkey(_deref(value)) == gs_key
                            for value in dict(obj_ext).values()
                        )
                except Exception:  # noqa: BLE001
                    return None
            if not isinstance(obj, pikepdf.Stream) or str(obj.get("/Subtype", "")) == "/Image":
                continue
            try:
                for other in pikepdf.parse_content_stream(obj):
                    if str(other.operator) == "gs" and other.operands:
                        if str(other.operands[0]) == name:
                            gs_operator_refs += 1
            except Exception:  # noqa: BLE001
                # Một stream không parse được sẽ bị hậu kiểm từ chối nếu nó
                # chứa màu; candidate này không được phép đoán resource scope.
                continue
        if gs_resource_refs != 1 or gs_operator_refs != 1:
            return None

        try:
            instructions = pikepdf.parse_content_stream(stream)
        except Exception:  # noqa: BLE001
            return None
        rewritten = []
        seen_gs = seen_rgb = seen_paint = 0
        gs_index = rgb_index = paint_index = -1
        depth = 0
        alpha_active = False
        alpha_stack: list[bool] = []
        for index, instruction in enumerate(instructions):
            op = str(instruction.operator)
            operands = list(instruction.operands)
            if op == "q":
                depth += 1
                alpha_stack.append(alpha_active)
                rewritten.append(instruction)
                continue
            if op == "Q":
                if depth <= 0:
                    return None
                depth -= 1
                alpha_active = alpha_stack.pop()
                rewritten.append(instruction)
                continue
            if op == "gs":
                if len(operands) != 1 or str(operands[0]) != name or seen_gs:
                    return None
                seen_gs += 1
                gs_index = index
                alpha_active = True
                # Bỏ lệnh gs; resource sẽ được gỡ sau khi stream mới được tạo.
                continue
            if op == "rg":
                if seen_rgb or seen_paint or len(operands) != 3:
                    return None
                try:
                    values = tuple(float(value) for value in operands)
                except Exception:  # noqa: BLE001
                    return None
                if not all(math.isfinite(value) and 0.0 <= value <= 1.0 for value in values):
                    return None
                # Source-over lên giấy trắng trong blending space DeviceRGB.
                composed = [ca * value + (1.0 - ca) for value in values]
                rewritten.append((composed, pikepdf.Operator("rg")))
                seen_rgb += 1
                rgb_index = index
                continue
            if op in _SIMPLE_VECTOR_ALPHA_PAINT_OPS:
                # `/gs` chỉ có hiệu lực trong graphics state hiện tại. Kiểm
                # tra này ngăn false-success ở mẫu `gs q Q ... f`, nơi Q đã
                # khôi phục alpha trước khi mảng được paint.
                if not seen_rgb or seen_paint or not alpha_active:
                    return None
                seen_paint += 1
                paint_index = index
                rewritten.append(instruction)
                continue
            if op not in _SIMPLE_VECTOR_ALPHA_PATH_OPS:
                return None
            rewritten.append(instruction)
        if depth or seen_gs != 1 or seen_rgb != 1 or seen_paint != 1:
            return None
        if not (gs_index < rgb_index < paint_index):
            return None
        return stream, resources, extgstates, name, rewritten
    except Exception:  # noqa: BLE001
        return None


def _flatten_isolated_rgb_vector_alpha(pdf: pikepdf.Pdf) -> int:
    """Flatten đúng một vector RGB alpha đơn giản lên nền trắng.

    Hàm chỉ sửa sau khi predicate đã kiểm tra toàn bộ stream/resource. Nếu
    candidate không đạt, không có mutation nào xảy ra và scanner hiện hữu sẽ
    trả `[LIVE_TRANSPARENCY_RGB]` như trước.
    """
    changed = 0
    for page in pdf.pages:
        candidate = _simple_vector_alpha_candidate(pdf, page)
        if candidate is None:
            continue
        stream, _resources, extgstates, name, rewritten = candidate
        try:
            stream.write(pikepdf.unparse_content_stream(rewritten))
            # Không để resource alpha sống sót và làm scanner báo blocker; gs
            # đã bị gỡ khỏi content nên xóa đúng entry là đủ, không đụng entry
            # ExtGState khác của tài liệu.
            if name in extgstates:
                del extgstates[name]
            if not extgstates:
                resources = _deref(page.get("/Resources"))
                if isinstance(resources, pikepdf.Dictionary):
                    if "/ExtGState" in resources:
                        del resources["/ExtGState"]
            changed += 1
        except Exception:  # noqa: BLE001
            # Stream/resource mutation có thể fail trên PDF owner password hoặc
            # object hỏng; bỏ qua để hậu kiểm giữ fail-closed.
            continue
    return changed


def _scan_convertibility(pdf: pikepdf.Pdf) -> list[str]:
    """Lý do KHÔNG chuyển được bằng đường object-level (rỗng = chuyển được).

    Quét trước rồi mới sửa, vì chuyển nửa chừng rồi bỏ cuộc sẽ để lại file lai
    tệ hơn cả file gốc lẫn file GS.
    """
    blockers: list[str] = []

    def note(msg: str) -> None:
        if msg not in blockers:
            blockers.append(msg)

    # Transparency phải được composite trong blending space nguồn rồi mới qua
    # ICC. `convert_to_cmyk` đã flatten trước một số ảnh cô lập trên nền giấy
    # trắng; mọi trường hợp không chứng minh được backdrop vẫn bị từ chối.
    try:
        source_scan = _scan_cmyk_postcondition(pdf)
        # COLOR (audit 2026-08-20 §COLOR.19): `/Range` của ICCBased ảnh là
        # Decode mặc định. Chặn trước mọi writer; nếu chỉ chờ postflight thì
        # alpha lane có thể đã flatten và xóa metadata ICC/Range mất rồi.
        for finding in source_scan.get("residuals", []):
            code = str(finding.get("code", ""))
            if code in {
                "UNSUPPORTED_ICC_RANGE",
                "INVALID_ICC_RANGE",
                "UNSUPPORTED_CALRGB",
                "INVALID_CALRGB",
            }:
                note(f"[{code}] {finding.get('message', 'colorspace RGB lỗi')}")
        has_rgb_process = any(
            str(item.get("code", "")).startswith("RESIDUAL_")
            and "RGB" in str(item.get("code", ""))
            for item in source_scan.get("residuals", [])
        )
    except Exception:  # noqa: BLE001
        has_rgb_process = True

    def extgstate_is_live(gs) -> bool:
        gs = _deref(gs)
        try:
            if float(gs.get("/ca", 1.0)) < 1.0 or float(gs.get("/CA", 1.0)) < 1.0:
                return True
            smask = _deref(gs.get("/SMask"))
            if smask is not None and str(smask) != "/None":
                return True
            blend = _deref(gs.get("/BM"))
            return blend is not None and str(blend) not in ("/Normal", "[/Normal]")
        except Exception:  # noqa: BLE001
            return True

    seen_transparency_resources: set[tuple[int, int]] = set()

    def scan_transparency_resources(resources, depth: int = 0) -> None:
        if not has_rgb_process or resources is None or depth > 12:
            return
        resources = _deref(resources)
        if not isinstance(resources, pikepdf.Dictionary):
            return
        key = _objkey(resources)
        if key is not None:
            if key in seen_transparency_resources:
                return
            seen_transparency_resources.add(key)
        try:
            extgstates = _deref(resources.get("/ExtGState"))
            if isinstance(extgstates, pikepdf.Dictionary) and any(
                extgstate_is_live(value) for value in dict(extgstates).values()
            ):
                note(
                    "[LIVE_TRANSPARENCY_RGB] Nội dung RGB dùng alpha/soft-mask/"
                    "blend mode sống; cần flatten-before-ICC."
                )
            xobjects = _deref(resources.get("/XObject"))
            if isinstance(xobjects, pikepdf.Dictionary):
                for value in dict(xobjects).values():
                    target = _deref(value)
                    if str(target.get("/Subtype", "")) == "/Form":
                        scan_transparency_resources(
                            _resource_scope(target, resources), depth + 1
                        )
            patterns = _deref(resources.get("/Pattern"))
            if isinstance(patterns, pikepdf.Dictionary):
                for value in dict(patterns).values():
                    pattern = _deref(value)
                    if isinstance(pattern, pikepdf.Stream):
                        scan_transparency_resources(
                            _resource_scope(pattern, resources), depth + 1
                        )
        except Exception:  # noqa: BLE001
            # Hậu kiểm parser vẫn chịu trách nhiệm fail-closed nếu resource hỏng.
            return

    for obj in pdf.objects:
        try:
            d = obj if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)) else None
            if d is None:
                continue
            if (
                str(d.get("/Subtype", "")) == "/Image"
                and _cs_is_device_rgb(d.get("/ColorSpace"))
            ):
                # COLOR (audit 2026-08-20 §COLOR.18): Pillow/pikepdf không áp
                # `/Decode` tùy biến trước khi writer xóa metadata này. Dừng
                # an toàn thay vì công bố artifact đúng colorspace nhưng sai màu.
                if not _image_decode_is_default(d, 3):
                    note(
                        "[UNSUPPORTED_IMAGE_DECODE] Ảnh RGB dùng /Decode không mặc định; "
                        "writer chưa thể bảo toàn mapping mẫu màu."
                    )
                smask = _deref(d.get("/SMask"))
                if isinstance(smask, pikepdf.Stream) and not _image_decode_is_default(
                    smask, 1
                ):
                    note(
                        "[UNSUPPORTED_IMAGE_DECODE] SMask dùng /Decode không mặc định; "
                        "writer chưa thể bảo toàn alpha."
                    )
                if d.get("/SMask") is not None or d.get("/Mask") is not None:
                    note(
                        "[LIVE_TRANSPARENCY_RGB] Ảnh RGB có SMask/Mask phải được flatten "
                        "trong blending space nguồn trước khi chuyển CMYK."
                    )
            group = _deref(d.get("/Group"))
            if (
                isinstance(group, pikepdf.Dictionary)
                and str(group.get("/S", "")) == "/Transparency"
                and _cs_is_device_rgb(group.get("/CS"))
            ):
                note(
                    "[LIVE_TRANSPARENCY_RGB] Transparency group dùng RGB chưa thể "
                    "đổi object-level mà vẫn bảo toàn phép blend."
                )
            if has_rgb_process:
                extgstates = _deref(d.get("/ExtGState"))
                if isinstance(extgstates, pikepdf.Dictionary) and any(
                    extgstate_is_live(value) for value in dict(extgstates).values()
                ):
                    note(
                        "[LIVE_TRANSPARENCY_RGB] Nội dung RGB dùng alpha/soft-mask/"
                        "blend mode sống; cần flatten-before-ICC."
                    )
            if d is not None and d.get("/ShadingType") is not None:
                if _cs_is_device_rgb(d.get("/ColorSpace")):
                    # Chuyển shading RGB đòi viết lại hàm nội suy màu. Với
                    # `FunctionType 2` chỉ cần đổi `/C0`,`/C1` — nhưng nội suy
                    # tuyến tính TRONG CMYK không cho cùng dải màu với nội suy
                    # trong RGB rồi mới quy đổi, nên khúc giữa gradient lệch đi
                    # một cách nhìn thấy được. Đánh dấu blocker để từ chối an toàn.
                    note("shading dùng colorspace RGB")
            for hint in _UNCONVERTIBLE_HINTS:
                if hint in str(d.get("/ColorSpace", "")):
                    note(f"colorspace {hint}")
        except Exception:  # noqa: BLE001
            continue
    for page in pdf.pages:
        scan_transparency_resources(page.get("/Resources"))
    return blockers


# COLOR (audit 2026-08-20 §COLOR.04): hậu điều kiện không được suy từ số
# object đã sửa. Một ảnh JPX/inline hoặc named CalRGB bị bỏ qua vẫn có thể làm
# file lai màu dù `ops == images == 0` là giá trị hợp lệ với file vốn đã CMYK.
_POSTFLIGHT_MAX_DEPTH = 12
_POSTFLIGHT_MAX_RESIDUALS = 50


def _postflight_object_key(obj) -> tuple | None:
    """Khoá chống thăm lặp cho stream/resource gián tiếp."""
    try:
        objgen = tuple(obj.objgen)
    except Exception:  # noqa: BLE001
        return None
    return objgen if objgen != (0, 0) else None


def _postflight_colorspace_family(
    colorspace,
    resources,
    *,
    seen: frozenset[tuple] = frozenset(),
    depth: int = 0,
) -> tuple[str, str]:
    """Phân loại colorspace đầu ra: ``allowed``/``residual``/``unknown``.

    Chỉ đi theo base của Indexed/Pattern. Tuyệt đối không đi vào
    alternate của Separation/DeviceN: đó là cách PDF mô tả màu pha,
    không phải nội dung process còn sót lại.
    """
    if depth > _POSTFLIGHT_MAX_DEPTH:
        return "unknown", "colorspace lồng quá sâu"

    colorspace = _deref(colorspace)
    if colorspace is None:
        return "unknown", "không khai ColorSpace"

    key = _postflight_object_key(colorspace)
    if key is not None:
        if key in seen:
            return "unknown", "colorspace tham chiếu vòng"
        seen = seen | {key}

    name = str(colorspace)
    allowed_names = {
        "/DeviceGray",
        "/G",
        "/CalGray",
        "/DeviceCMYK",
        "/CMYK",
        "/Pattern",  # pattern tô màu được quét trong stream riêng
    }
    if name in allowed_names:
        return "allowed", name.lstrip("/")
    if name in ("/DeviceRGB", "/RGB"):
        return "residual", "RGB"

    if isinstance(colorspace, pikepdf.Array):
        if len(colorspace) == 0:
            return "unknown", "mảng ColorSpace rỗng"
        family = str(_deref(colorspace[0]))
        if family in ("/Separation", "/DeviceN"):
            return "allowed", family.lstrip("/")
        if family == "/CalGray":
            return "allowed", "CalGray"
        if family == "/CalRGB":
            _profile, calrgb_error = _calrgb_profile_bytes(colorspace)
            if calrgb_error is not None:
                return "invalid", calrgb_error
            return "residual", "CalRGB"
        if family == "/Lab":
            return "residual", "Lab"
        if family == "/ICCBased":
            if len(colorspace) < 2:
                return "invalid", "ICCBased thiếu profile"
            try:
                channels = int(_deref(colorspace[1]).get("/N", 0))
            except Exception:  # noqa: BLE001
                channels = 0
            valid, identity = _validate_icc_profile(colorspace)
            if not valid:
                return "invalid", identity
            if channels == 3:
                return "residual", "ICC RGB"
            if channels in (1, 4):
                return "allowed", f"ICC {channels} kênh"
            return "invalid", f"ICCBased /N={channels or '?'}"
        if family in ("/Indexed", "/I"):
            if len(colorspace) < 2:
                return "unknown", "Indexed thiếu base ColorSpace"
            return _postflight_colorspace_family(
                colorspace[1], resources, seen=seen, depth=depth + 1
            )
        if family == "/Pattern":
            if len(colorspace) == 1:
                return "allowed", "Pattern"
            return _postflight_colorspace_family(
                colorspace[1], resources, seen=seen, depth=depth + 1
            )
        return "unknown", family or "ColorSpace array không xác định"

    # Tên tuỳ biến (/CS0...) chỉ có nghĩa trong resource scope của
    # chính content stream. Resolve đúng scope tránh coi /SpotLab là Lab.
    if name.startswith("/") and resources is not None:
        try:
            color_dict = _deref(resources.get("/ColorSpace"))
            target = color_dict.get(name) if isinstance(color_dict, pikepdf.Dictionary) else None
        except Exception:  # noqa: BLE001
            target = None
        if target is not None:
            return _postflight_colorspace_family(
                target, resources, seen=seen, depth=depth + 1
            )

    return "unknown", name or "ColorSpace không xác định"


def _postflight_residual_code(family: str, carrier: str) -> str:
    slug = {
        "RGB": "RGB",
        "ICC RGB": "ICC_RGB",
        "CalRGB": "CALRGB",
        "Lab": "LAB",
    }.get(family, "COLORSPACE")
    if carrier == "jpx" and family in ("RGB", "ICC RGB"):
        return "RESIDUAL_JPX_RGB"
    if carrier == "inline":
        return f"RESIDUAL_INLINE_{slug}"
    return f"RESIDUAL_{slug}"


def _scan_cmyk_postcondition(pdf: pikepdf.Pdf) -> dict:
    """Hậu kiểm: nội dung process có thể in phải không còn RGB/Lab.

    Parser pikepdf tách inline image khỏi string/comment/binary nên không dùng
    regex trên byte thô. Mọi nhánh không đọc/chứng minh được đều là
    blocker: cảnh báo nhưng vẫn giao file sẽ tái tạo false-success.
    """
    residuals: list[dict] = []
    warnings: list[str] = []
    seen_findings: set[tuple] = set()
    seen_streams: set[tuple] = set()
    seen_resources: set[tuple] = set()

    def note(code: str, page: int, object_ref: str, message: str) -> None:
        marker = (code, page, object_ref)
        if marker in seen_findings:
            return
        seen_findings.add(marker)
        if len(residuals) >= _POSTFLIGHT_MAX_RESIDUALS:
            return
        residuals.append(
            {
                "code": code,
                "page": page,
                "object_ref": object_ref,
                "message": message,
            }
        )

    def check_colorspace(colorspace, resources, page: int, object_ref: str, carrier: str) -> tuple[str, str]:
        status, family = _postflight_colorspace_family(colorspace, resources)
        if status == "allowed":
            return status, family
        if status == "residual":
            code = _postflight_residual_code(family, carrier)
            note(
                code,
                page,
                object_ref,
                f"Trang {page}, {object_ref} còn colorspace {family} sau chuyển CMYK.",
            )
            return status, family
        if status == "invalid":
            if "ICCBased RGB /Range" in family:
                code = _icc_rgb_range_blocker_code(family)
            elif "CalRGB" in family:
                code = _calrgb_blocker_code(family)
            else:
                code = "INVALID_ICC_PROFILE"
            note(
                code,
                page,
                object_ref,
                f"Trang {page}, {object_ref}: {family}.",
            )
            return status, family
        code = "UNVERIFIED_JPX_COLORSPACE" if carrier == "jpx" else "UNVERIFIED_COLORSPACE"
        note(
            code,
            page,
            object_ref,
            f"Trang {page}, {object_ref}: không chứng minh được colorspace ({family}).",
        )
        return status, family

    def scan_image(image, resources, page: int, object_ref: str) -> None:
        try:
            if bool(image.get("/ImageMask", False)):
                return
            filters = _filter_names(image.get("/Filter"))
            carrier = "jpx" if "/JPXDecode" in filters else "image"
            check_colorspace(image.get("/ColorSpace"), resources, page, object_ref, carrier)
        except Exception as exc:  # noqa: BLE001
            note(
                "POSTFLIGHT_UNREADABLE",
                page,
                object_ref,
                f"Trang {page}, không đọc được {object_ref}: {exc}",
            )

    def scan_stream(
        stream,
        resources,
        page: int,
        object_ref: str,
        state: _ProcessColorState | None = None,
    ) -> None:
        state = state or _ProcessColorState.inherited_unknown()
        if not isinstance(stream, pikepdf.Stream):
            note(
                "POSTFLIGHT_UNREADABLE",
                page,
                object_ref,
                f"Trang {page}, {object_ref} không phải content stream hợp lệ.",
            )
            return
        key = _postflight_object_key(stream)
        if key is not None:
            if key in seen_streams:
                return
            seen_streams.add(key)
        try:
            instructions = pikepdf.parse_content_stream(stream)
        except Exception as exc:  # noqa: BLE001
            note(
                "POSTFLIGHT_UNREADABLE",
                page,
                object_ref,
                f"Trang {page}, không parse được {object_ref}: {exc}",
            )
            return

        for instruction in instructions:
            op = str(instruction.operator)
            operands = list(instruction.operands)
            if op == "q":
                state.push()
                continue
            if op == "Q":
                if not state.pop():
                    note(
                        "INVALID_COLOR_STATE",
                        page,
                        object_ref,
                        f"Trang {page}, {object_ref} có Q không cân bằng.",
                    )
                continue
            if op in ("rg", "RG"):
                note(
                    "RESIDUAL_RGB",
                    page,
                    object_ref,
                    f"Trang {page}, {object_ref} còn toán tử {op} (DeviceRGB).",
                )
                if op == "rg":
                    state.fill_components = 3
                else:
                    state.stroke_components = 3
            elif op in ("g", "G"):
                if op == "g":
                    state.fill_components = 1
                else:
                    state.stroke_components = 1
            elif op in ("k", "K"):
                if op == "k":
                    state.fill_components = 4
                else:
                    state.stroke_components = 4
            elif op in ("cs", "CS") and operands:
                check_colorspace(operands[0], resources, page, object_ref, "vector")
                components = _process_colorspace_components(operands[0], resources)
                if op == "cs":
                    state.fill_components = components
                else:
                    state.stroke_components = components
            elif op in ("sc", "scn", "SC", "SCN"):
                components = (
                    state.fill_components if op in ("sc", "scn") else state.stroke_components
                )
                if components is None:
                    note(
                        "UNVERIFIED_COLOR_STATE",
                        page,
                        object_ref,
                        f"Trang {page}, {object_ref}: không chứng minh được color state trước {op}.",
                    )
                elif len(operands) != components:
                    note(
                        "INVALID_COLOR_OPERANDS",
                        page,
                        object_ref,
                        f"Trang {page}, {object_ref}: {op} có {len(operands)} toán hạng, "
                        f"colorspace hiện hành cần {components}.",
                    )
            elif op == "INLINE IMAGE":
                inline = operands[0] if operands else None
                try:
                    inline_obj = getattr(inline, "obj", None)
                    image_mask = bool(inline_obj.get("/ImageMask", False)) if inline_obj else False
                    if image_mask:
                        continue
                    colorspace = inline_obj.get("/ColorSpace") if inline_obj else None
                    if colorspace is None:
                        colorspace = getattr(inline, "colorspace", None)
                    check_colorspace(
                        colorspace,
                        resources,
                        page,
                        f"{object_ref} inline image",
                        "inline",
                    )
                except Exception as exc:  # noqa: BLE001
                    note(
                        "POSTFLIGHT_UNREADABLE",
                        page,
                        f"{object_ref} inline image",
                        f"Trang {page}, không đọc được inline image: {exc}",
                    )

    def scan_resources(resources, page: int, depth: int, scope: str) -> None:
        if resources is None:
            return
        if depth > _POSTFLIGHT_MAX_DEPTH:
            note(
                "POSTFLIGHT_UNREADABLE",
                page,
                scope,
                f"Trang {page}, resource lồng quá {_POSTFLIGHT_MAX_DEPTH} cấp.",
            )
            return
        resources = _deref(resources)
        if not isinstance(resources, pikepdf.Dictionary):
            note(
                "POSTFLIGHT_UNREADABLE",
                page,
                scope,
                f"Trang {page}, resource của {scope} không hợp lệ.",
            )
            return
        key = _postflight_object_key(resources)
        if key is not None:
            if key in seen_resources:
                return
            seen_resources.add(key)

        try:
            xobjects = _deref(resources.get("/XObject"))
            if isinstance(xobjects, pikepdf.Dictionary):
                for name, ref in dict(xobjects).items():
                    target = _deref(ref)
                    subtype = str(target.get("/Subtype", ""))
                    object_ref = f"XObject {name}"
                    if subtype == "/Image":
                        scan_image(target, resources, page, object_ref)
                    elif subtype == "/Form":
                        inner_resources = _resource_scope(target, resources)
                        scan_stream(
                            target,
                            inner_resources,
                            page,
                            object_ref,
                            _ProcessColorState.inherited_unknown(),
                        )
                        try:
                            group = _deref(target.get("/Group"))
                            if group is not None and group.get("/CS") is not None:
                                check_colorspace(
                                    group.get("/CS"), inner_resources, page, f"{object_ref} /Group", "vector"
                                )
                        except Exception as exc:  # noqa: BLE001
                            note(
                                "POSTFLIGHT_UNREADABLE",
                                page,
                                f"{object_ref} /Group",
                                f"Trang {page}, không đọc được transparency group: {exc}",
                            )
                        if inner_resources is not resources:
                            scan_resources(inner_resources, page, depth + 1, object_ref)

            # Shading RGB đã là blocker pre-scan; quét lại để khóa
            # hậu điều kiện nếu producer/resource walker thay đổi sau này.
            shadings = _deref(resources.get("/Shading"))
            if isinstance(shadings, pikepdf.Dictionary):
                for name, ref in dict(shadings).items():
                    shading = _deref(ref)
                    check_colorspace(
                        shading.get("/ColorSpace"), resources, page, f"Shading {name}", "vector"
                    )

            # Colored tiling pattern có content stream riêng; bỏ qua nó sẽ
            # cho phép `rg` sống sót ngoài page/Form/AP.
            patterns = _deref(resources.get("/Pattern"))
            if isinstance(patterns, pikepdf.Dictionary):
                for name, ref in dict(patterns).items():
                    pattern = _deref(ref)
                    if not isinstance(pattern, pikepdf.Stream):
                        continue
                    pattern_resources = _resource_scope(pattern, resources)
                    object_ref = f"Pattern {name}"
                    scan_stream(
                        pattern,
                        pattern_resources,
                        page,
                        object_ref,
                        _ProcessColorState.inherited_unknown(),
                    )
                    if pattern_resources is not resources:
                        scan_resources(pattern_resources, page, depth + 1, object_ref)
        except Exception as exc:  # noqa: BLE001
            note(
                "POSTFLIGHT_UNREADABLE",
                page,
                scope,
                f"Trang {page}, không duyệt được resource của {scope}: {exc}",
            )

    for page_index, page in enumerate(pdf.pages, start=1):
        resources = page.get("/Resources")
        contents = page.get("/Contents")
        page_color_state = _ProcessColorState()
        if contents is not None:
            try:
                if isinstance(contents, pikepdf.Array):
                    for index, stream in enumerate(contents, start=1):
                        scan_stream(
                            _deref(stream),
                            resources,
                            page_index,
                            f"page content #{index}",
                            page_color_state,
                        )
                else:
                    scan_stream(
                        _deref(contents), resources, page_index, "page content", page_color_state
                    )
            except Exception as exc:  # noqa: BLE001
                note(
                    "POSTFLIGHT_UNREADABLE",
                    page_index,
                    "page content",
                    f"Trang {page_index}, không duyệt được content: {exc}",
                )
        scan_resources(resources, page_index, 0, "page resources")

        try:
            group = _deref(page.get("/Group"))
            if group is not None and group.get("/CS") is not None:
                check_colorspace(
                    group.get("/CS"), resources, page_index, "page /Group", "vector"
                )
        except Exception as exc:  # noqa: BLE001
            note(
                "POSTFLIGHT_UNREADABLE",
                page_index,
                "page /Group",
                f"Trang {page_index}, không đọc được transparency group: {exc}",
            )

        # Appearance stream có thể lên bản in như content trang, nhưng
        # dùng resource scope riêng nên phải quét từng state /N,/D,/R.
        try:
            annots = _deref(page.get("/Annots"))
            if isinstance(annots, pikepdf.Array):
                for annot_index, annot in enumerate(annots, start=1):
                    ap = _deref(_deref(annot).get("/AP"))
                    if not isinstance(ap, pikepdf.Dictionary):
                        continue
                    for slot, value in dict(ap).items():
                        value = _deref(value)
                        if isinstance(value, pikepdf.Stream):
                            streams = [(str(slot), value)]
                        elif isinstance(value, pikepdf.Dictionary):
                            streams = [(str(state), _deref(stream)) for state, stream in dict(value).items()]
                        else:
                            continue
                        for state, stream in streams:
                            object_ref = f"annotation #{annot_index} AP {state}"
                            # Appearance stream kế thừa resource của page khi
                            # không khai riêng (§7.5.5); thiếu fallback sẽ biến
                            # colorspace tên hợp lệ thành blocker giả.
                            ap_resources = (
                                _resource_scope(stream, resources)
                                if isinstance(stream, pikepdf.Stream)
                                else resources
                            )
                            scan_stream(
                                stream,
                                ap_resources,
                                page_index,
                                object_ref,
                                _ProcessColorState.inherited_unknown(),
                            )
                            if ap_resources is not resources:
                                scan_resources(ap_resources, page_index, 0, object_ref)
        except Exception as exc:  # noqa: BLE001
            note(
                "POSTFLIGHT_UNREADABLE",
                page_index,
                "annotation appearance",
                f"Trang {page_index}, không duyệt được appearance stream: {exc}",
            )

    blockers = [f"[{item['code']}] {item['message']}" for item in residuals]
    return {
        "passed": not blockers,
        "blockers": blockers,
        "warnings": warnings,
        "residuals": residuals,
    }


def _convert_content_stream(
    pdf: pikepdf.Pdf,
    data: bytes,
    resources,
    tf: _CmykTransform,
    stats: dict,
    *,
    cmyk_profile: str,
    rendering_intent: str,
    black_point_compensation: bool,
    preserve_black: bool,
    brightness_lstar: float = 0,
    contrast_percent: float = 0,
    vibrance_percent: float = 0,
    adjustment_stage: str = "pre_icc",
    transform_cache: dict[bytes, _CmykTransform],
    color_state: _ProcessColorState | None = None,
) -> bytes | None:
    """Đổi mọi toán tử màu RGB trong một content stream sang CMYK.

    Trả `None` khi không parse được (caller giữ nguyên stream đó).

    `pdf` phải là tài liệu ĐANG MỞ, không phải `Pdf.new()` dựng tại chỗ: object
    tạm đó bị thu hồi ngay khi hết biểu thức và `Stream` trỏ vào nó thành vô
    hiệu — `parse_content_stream` ném "không phải Dictionary hoặc Stream" và
    toàn bộ đường đổi màu im lặng không làm gì.
    """
    try:
        instructions = pikepdf.parse_content_stream(pikepdf.Stream(pdf, data))
    except Exception:  # noqa: BLE001
        return None

    out = []
    # COLOR (audit 2026-08-20 §COLOR.14): một mảng `/Contents` tương đương
    # chuỗi nối các stream; graphics state không reset ở ranh giới stream.
    color_state = color_state or _ProcessColorState.inherited_unknown()
    changed = False

    for instr in instructions:
        op = str(instr.operator)
        operands = list(instr.operands)

        if op == "q":
            color_state.push()
            out.append(instr)
            continue
        if op == "Q":
            if not color_state.pop():
                stats.setdefault("blockers", []).append(
                    "[INVALID_COLOR_STATE] Toán tử Q không có q tương ứng."
                )
            out.append(instr)
            continue

        if op in ("g", "G"):
            if op == "g":
                color_state.fill_tf = None
                color_state.fill_components = 1
            else:
                color_state.stroke_tf = None
                color_state.stroke_components = 1
            out.append(instr)
            continue

        if op in ("k", "K"):
            if op == "k":
                color_state.fill_tf = None
                color_state.fill_components = 4
            else:
                color_state.stroke_tf = None
                color_state.stroke_components = 4
            out.append(instr)
            continue

        if op in _RGB_TO_CMYK_OP and len(operands) == 3:
            if op == "rg":
                color_state.fill_tf = tf
                color_state.fill_components = 3
            else:
                color_state.stroke_tf = tf
                color_state.stroke_components = 3
            try:
                vals = tuple(float(v) for v in operands)
                if preserve_black and all(abs(v) <= 1e-9 for v in vals):
                    c, m, y, k = 0.0, 0.0, 0.0, 1.0
                else:
                    c, m, y, k = tf(*vals)
            except Exception:  # noqa: BLE001
                out.append(instr)
                continue
            out.append(([c, m, y, k], pikepdf.Operator(_RGB_TO_CMYK_OP[op])))
            stats["ops"] = stats.get("ops", 0) + 1
            changed = True
            continue

        if op in ("cs", "CS") and operands:
            target = operands[0]
            resolved = _resolve_resource_colorspace(resources, target)
            is_rgb = _cs_is_device_rgb(resolved)
            components = _process_colorspace_components(resolved)
            selected_tf = (
                _transform_for_colorspace(
                    resolved,
                    tf,
                    cmyk_profile,
                    rendering_intent=rendering_intent,
                    black_point_compensation=black_point_compensation,
                    brightness_lstar=brightness_lstar,
                    contrast_percent=contrast_percent,
                    vibrance_percent=vibrance_percent,
                    adjustment_stage=adjustment_stage,
                    cache=transform_cache,
                )
                if is_rgb
                else None
            )
            if op == "cs":
                color_state.fill_tf = selected_tf if is_rgb else None
                color_state.fill_components = 3 if is_rgb else components
            else:
                color_state.stroke_tf = selected_tf if is_rgb else None
                color_state.stroke_components = 3 if is_rgb else components
            if is_rgb and selected_tf is not None:
                out.append(([pikepdf.Name("/DeviceCMYK")], pikepdf.Operator(op)))
                changed = True
                continue

        if op in ("sc", "scn", "SC", "SCN"):
            is_fill = op in ("sc", "scn")
            selected_tf = color_state.fill_tf if is_fill else color_state.stroke_tf
            expected_components = (
                color_state.fill_components if is_fill else color_state.stroke_components
            )
            if selected_tf is not None and len(operands) == 3:
                try:
                    vals = tuple(float(v) for v in operands)
                    vals = (
                        (0.0, 0.0, 0.0, 1.0)
                        if preserve_black and all(abs(v) <= 1e-9 for v in vals)
                        else selected_tf(*vals)
                    )
                except Exception:  # noqa: BLE001
                    out.append(instr)
                    continue
                out.append(([*vals], pikepdf.Operator(op)))
                stats["ops"] = stats.get("ops", 0) + 1
                changed = True
                continue
            if expected_components is not None and len(operands) != expected_components:
                stats.setdefault("blockers", []).append(
                    f"[INVALID_COLOR_OPERANDS] {op} có {len(operands)} toán hạng, "
                    f"colorspace hiện hành cần {expected_components}."
                )

        out.append(instr)

    if not changed:
        return None
    try:
        return pikepdf.unparse_content_stream(out)
    except Exception:  # noqa: BLE001
        return None


def _convert_indexed_palette_to_cmyk(pdf: pikepdf.Pdf, obj: pikepdf.Stream, tf) -> bool:
    """Đổi bảng màu của ảnh `Indexed` nền RGB sang nền CMYK.

    Rẻ và an toàn hơn hẳn chuyển ảnh thường: **chỉ số pixel không đổi**, chỉ
    bảng tra được viết lại (mỗi ô 3 byte RGB → 4 byte CMYK). Không giải nén
    ảnh, không nội suy, không mất chi tiết — nên ca này đáng xử lý trực tiếp thay
    vì từ chối cả file.
    """
    if tf is None:
        return False
    cs = _deref(obj.get("/ColorSpace"))
    if not isinstance(cs, pikepdf.Array) or len(cs) < 4:
        return False
    if str(_deref(cs[0])) not in ("/Indexed", "/I"):
        return False
    if not _cs_is_device_rgb(cs[1]):
        return False
    # COLOR (audit 2026-08-20 §COLOR.04): JPX có thể chứa color spec riêng
    # trong codestream; đổi palette PDF mà không giải mã JPX sẽ không chứng
    # minh được màu pixel. Để hậu kiểm bắt và từ chối thay vì báo thành công.
    if "/JPXDecode" in _filter_names(obj.get("/Filter")):
        return False

    try:
        hival = int(_deref(cs[2]))
        lookup_obj = _deref(cs[3])
        if isinstance(lookup_obj, pikepdf.Stream):
            table = bytes(lookup_obj.read_bytes())
        else:
            table = bytes(lookup_obj)
    except Exception as exc:  # noqa: BLE001
        logger.debug("đọc bảng màu Indexed thất bại: %s", exc)
        return False

    n_entries = hival + 1
    if len(table) < n_entries * 3:
        return False

    out = bytearray()
    for i in range(n_entries):
        r, g, b = table[i * 3], table[i * 3 + 1], table[i * 3 + 2]
        c, m, y, k = tf(r / 255.0, g / 255.0, b / 255.0)
        out += bytes(
            (
                int(round(c * 255)),
                int(round(m * 255)),
                int(round(y * 255)),
                int(round(k * 255)),
            )
        )

    obj["/ColorSpace"] = pikepdf.Array(
        [
            pikepdf.Name("/Indexed"),
            pikepdf.Name("/DeviceCMYK"),
            hival,
            pdf.make_stream(bytes(out)),
        ]
    )
    return True


def _convert_image_to_cmyk(obj: pikepdf.Stream, tf: _CmykTransform | None) -> bool:
    """Đổi một image XObject RGB sang DeviceCMYK. `False` = không đụng tới."""
    if tf is None or not _cs_is_device_rgb(obj.get("/ColorSpace")):
        return False
    if bool(obj.get("/ImageMask", False)):
        return False
    # COLOR (audit 2026-08-20 §COLOR.11): color-key `/Mask` và `/SMask /Matte`
    # dùng component RGB của ảnh cha. Đổi cha sang CMYK mà không đổi metadata
    # mask sẽ pha alpha sai; giữ RGB để postflight từ chối artifact thay vì giao
    # một ảnh nhìn gần đúng nhưng viền đã đổi màu.
    mask = _deref(obj.get("/Mask"))
    if isinstance(mask, pikepdf.Array):
        return False
    smask = _deref(obj.get("/SMask"))
    if isinstance(smask, pikepdf.Stream) and smask.get("/Matte") is not None:
        return False
    if any(f not in _RESAMPLABLE_FILTERS for f in _filter_names(obj.get("/Filter"))):
        return False
    try:
        if _calrgb_is_colorspace(obj.get("/ColorSpace")):
            # PdfImage không nhận CalRGB dù mẫu sau Flate/LZW/RunLength vẫn là
            # RGB 8-bit thẳng. Chỉ mở đúng lane lossless có độ dài chứng minh
            # được; DCT/JPX và BPC khác 8 tiếp tục để postflight từ chối.
            from PIL import Image

            if any(
                value not in {None, "/FlateDecode", "/LZWDecode", "/RunLengthDecode"}
                for value in _filter_names(obj.get("/Filter"))
            ):
                return False
            width = int(obj.get("/Width", 0))
            height = int(obj.get("/Height", 0))
            if width <= 0 or height <= 0 or int(obj.get("/BitsPerComponent", 0)) != 8:
                return False
            source = bytes(obj.read_bytes())
            if len(source) != width * height * 3:
                return False
            pil = Image.frombytes("RGB", (width, height), source)
        else:
            pil = pikepdf.PdfImage(obj).as_pil_image()
            if pil.mode != "RGB":
                pil = pil.convert("RGB")
        cmyk = tf.image(pil)
    except Exception as exc:  # noqa: BLE001
        logger.debug("convert ảnh RGB→CMYK thất bại: %s", exc)
        return False

    raw = cmyk.tobytes()
    if len(raw) != cmyk.width * cmyk.height * 4:
        return False
    # COLOR (audit 2026-08-20 §COLOR.01): pikepdf không tự nén khi truyền
    # `/FlateDecode`; byte thô làm consumer giải mã thất bại và render trắng.
    obj.write(zlib.compress(raw), filter=pikepdf.Name("/FlateDecode"))
    obj["/ColorSpace"] = pikepdf.Name("/DeviceCMYK")
    obj["/BitsPerComponent"] = 8
    obj["/Width"] = cmyk.width
    obj["/Height"] = cmyk.height
    for dead in ("/DecodeParms", "/DP", "/Decode", "/D"):
        if dead in obj:
            del obj[dead]
    return True


# DPI đích theo preset, khớp ý nghĩa `-dPDFSETTINGS` của Ghostscript.
_OPTIMIZE_PRESET_DPI = {
    "screen": 72.0,
    "ebook": 150.0,
    "printer": 300.0,
    "prepress": 300.0,
}


def optimize_pdf(
    input_path: str,
    output_path: str,
    preset: str = "ebook",
    image_dpi: float | None = None,
    grayscale: bool = False,
) -> dict:
    """Giảm dung lượng file: hạ ảnh + (tuỳ chọn) đen trắng + nén lại cấu trúc.

    Lắp từ các mảnh đã có thay vì gọi `pdfwrite`: hạ ảnh dùng chung
    `downscale_images` (cùng cách tính DPI hiệu dụng với rule preflight), đen
    trắng dùng `convert_to_grayscale` (giữ spot). Phần còn lại là nén lại cấu
    trúc bằng qpdf qua pikepdf — object stream + nén stream.

    Khác Ghostscript ở một điểm quan trọng với xưởng in: `pdfwrite` **subset lại
    font và quy đổi colorspace** kể cả khi người dùng chỉ muốn giảm dung lượng.
    Đường này không đụng tới font và chỉ đổi màu khi được yêu cầu.

    Trả dict: `supported`, `images_downscaled`, `grayscale_ops`, `warnings`.
    """
    import os
    import shutil
    import tempfile

    result: dict = {
        "supported": True,
        "images_downscaled": 0,
        "grayscale_ops": 0,
        "warnings": [],
    }

    target_dpi = float(image_dpi) if image_dpi else _OPTIMIZE_PRESET_DPI.get(preset, 150.0)
    stage_in = input_path
    temps: list[str] = []

    try:
        down = tempfile.mktemp(suffix="_down.pdf")
        temps.append(down)
        # Ngưỡng 1.5× như pdfwrite: hạ ảnh chỉ hơn mức đích một chút chỉ làm mờ
        # mà gần như không giảm dung lượng.
        res = downscale_images(stage_in, down, target_dpi, target_dpi * 1.5)
        result["images_downscaled"] = res.get("changed", 0)
        result["warnings"].extend(res.get("warnings", []))
        stage_in = down

        if grayscale:
            gray = tempfile.mktemp(suffix="_gray.pdf")
            temps.append(gray)
            gres = convert_to_grayscale(stage_in, gray)
            if not gres.get("supported"):
                result["supported"] = False
                result["warnings"].extend(gres.get("blockers", []))
                return result
            result["grayscale_ops"] = gres.get("ops", 0)
            stage_in = gray

        with pikepdf.open(stage_in) as pdf:
            pdf.remove_unreferenced_resources()
            pdf.save(
                output_path,
                compress_streams=True,
                object_stream_mode=pikepdf.ObjectStreamMode.generate,
                linearize=False,
            )

        # Nén xong mà file PHÌNH ra thì giữ bản gốc: người dùng bấm "tối ưu" để
        # nhẹ hơn, trả về bản nặng hơn là phản tác dụng.
        if os.path.getsize(output_path) >= os.path.getsize(input_path):
            shutil.copyfile(input_path, output_path)
            result["warnings"].append(
                "Không giảm được dung lượng — giữ nguyên file gốc."
            )
    except Exception as exc:  # noqa: BLE001
        result["supported"] = False
        result["warnings"].append(f"tối ưu thất bại: {exc}")
    finally:
        for path in temps:
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError:
                    pass
    return result


def convert_to_grayscale(input_path: str, output_path: str) -> dict:
    """Chuyển nội dung sang thang xám ở mức object.

    Dùng công thức độ sáng của PDF cho `DeviceCMYK` (§10.4): mực càng dày thì
    xám càng tối, và K cộng thẳng vào cả ba kênh. Với `DeviceRGB` dùng trọng số
    Rec.601 — cùng trọng số mà mọi công cụ prepress dùng, nên bản xám khớp với
    thứ người dùng đã xem ở chỗ khác.

    Spot/`DeviceN` **không bị đụng**: chuyển một kênh pha thành xám là mất hẳn
    khả năng in bằng mực pha, và đó không phải điều nút "chuyển sang đen trắng"
    hứa hẹn. Ai muốn gộp spot thì chạy `convert_spot_to_cmyk` trước.

    Trả dict: `supported`, `ops`, `images`, `blockers`, `warnings`.
    """
    result: dict = {"supported": True, "ops": 0, "images": 0, "blockers": [], "warnings": []}

    with pikepdf.open(input_path) as pdf:
        blockers = _scan_convertibility(pdf)
        if blockers:
            result["supported"] = False
            result["blockers"] = blockers
            return result

        stats: dict = {}
        seen: set[tuple[int, int]] = set()

        for obj in pdf.objects:
            try:
                if not isinstance(obj, pikepdf.Stream):
                    continue
                if str(obj.get("/Subtype", "")) != "/Image":
                    continue
            except Exception:  # noqa: BLE001
                continue
            if _image_to_grayscale(obj):
                result["images"] += 1

        def convert_stream(stream, resources) -> None:
            if not isinstance(stream, pikepdf.Stream):
                return
            key = _objkey(stream)
            if key is not None:
                if key in seen:
                    return
                seen.add(key)
            try:
                data = bytes(stream.read_bytes())
            except Exception:  # noqa: BLE001
                return
            new = _grayscale_content_stream(pdf, data, resources, stats)
            if new is not None:
                stream.write(new)
            try:
                group = stream.get("/Group")
                if group is not None and group.get("/CS") is not None:
                    group["/CS"] = pikepdf.Name("/DeviceGray")
            except Exception:  # noqa: BLE001
                pass

        def walk_forms(resources, depth: int) -> None:
            if depth > _MAX_FORM_DEPTH or resources is None:
                return
            try:
                xobjects = _deref(resources.get("/XObject"))
                if xobjects is None:
                    return
                for _n, target in dict(xobjects).items():
                    target = _deref(target)
                    if str(target.get("/Subtype", "")) != "/Form":
                        continue
                    inner = target.get("/Resources") or resources
                    convert_stream(target, inner)
                    walk_forms(inner, depth + 1)
            except Exception:  # noqa: BLE001
                return

        for page in pdf.pages:
            resources = page.get("/Resources")
            contents = page.get("/Contents")
            if contents is not None:
                if isinstance(contents, pikepdf.Array):
                    for c in contents:
                        convert_stream(_deref(c), resources)
                else:
                    convert_stream(_deref(contents), resources)
            walk_forms(resources, 0)
            try:
                group = page.get("/Group")
                if group is not None and group.get("/CS") is not None:
                    group["/CS"] = pikepdf.Name("/DeviceGray")
            except Exception:  # noqa: BLE001
                pass

        result["ops"] = stats.get("ops", 0)
        pdf.save(output_path)
    return result


def _cmyk_to_gray(c: float, m: float, y: float, k: float) -> float:
    """CMYK → mức xám 0..1 (1 = trắng), theo §10.4."""
    return max(0.0, min(1.0, 1.0 - min(1.0, c * 0.3 + m * 0.59 + y * 0.11 + k)))


def _rgb_to_gray(r: float, g: float, b: float) -> float:
    return max(0.0, min(1.0, 0.299 * r + 0.587 * g + 0.114 * b))


def _grayscale_content_stream(pdf, data: bytes, resources, stats: dict) -> bytes | None:
    """Đổi toán tử màu sang `g`/`G`. Spot (`scn` qua `cs`) giữ nguyên."""
    try:
        instructions = pikepdf.parse_content_stream(pikepdf.Stream(pdf, data))
    except Exception:  # noqa: BLE001
        return None

    out = []
    changed = False
    for instr in instructions:
        op = str(instr.operator)
        operands = list(instr.operands)
        try:
            if op in ("rg", "RG") and len(operands) == 3:
                v = _rgb_to_gray(*(float(x) for x in operands))
                out.append(([v], pikepdf.Operator("g" if op == "rg" else "G")))
                stats["ops"] = stats.get("ops", 0) + 1
                changed = True
                continue
            if op in ("k", "K") and len(operands) == 4:
                v = _cmyk_to_gray(*(float(x) for x in operands))
                out.append(([v], pikepdf.Operator("g" if op == "k" else "G")))
                stats["ops"] = stats.get("ops", 0) + 1
                changed = True
                continue
        except Exception:  # noqa: BLE001
            pass
        out.append(instr)

    if not changed:
        return None
    try:
        return pikepdf.unparse_content_stream(out)
    except Exception:  # noqa: BLE001
        return None


def _image_to_grayscale(obj: pikepdf.Stream) -> bool:
    """Đổi một image XObject sang DeviceGray. `False` = không đụng tới."""
    cs = _deref(obj.get("/ColorSpace"))
    if cs is None or bool(obj.get("/ImageMask", False)):
        return False
    if str(cs) in ("/DeviceGray", "/G", "/CalGray"):
        return False
    n = _colorspace_components(obj)
    if n is None or _is_indexed(obj):
        return False  # spot/DeviceN/Indexed: giữ nguyên, xem docstring
    if any(f not in _RESAMPLABLE_FILTERS for f in _filter_names(obj.get("/Filter"))):
        return False
    try:
        from PIL import Image

        pil = pikepdf.PdfImage(obj).as_pil_image()
        gray = pil.convert("L")
    except Exception as exc:  # noqa: BLE001
        logger.debug("không chuyển được ảnh sang xám: %s", exc)
        return False
    raw = gray.tobytes()
    if len(raw) != gray.width * gray.height:
        return False
    # COLOR (audit 2026-08-20 §COLOR.01): dữ liệu phải khớp filter đã khai;
    # nếu ghi byte thô, ảnh xám đầu ra trở thành stream không giải mã được.
    obj.write(zlib.compress(raw), filter=pikepdf.Name("/FlateDecode"))
    obj["/ColorSpace"] = pikepdf.Name("/DeviceGray")
    obj["/BitsPerComponent"] = 8
    obj["/Width"] = gray.width
    obj["/Height"] = gray.height
    for dead in ("/DecodeParms", "/DP", "/Decode", "/D"):
        if dead in obj:
            del obj[dead]
    return True


def _attach_cmyk_output_intent(pdf: pikepdf.Pdf, cmyk_profile: str) -> None:
    """Gắn OutputIntent đúng profile đích mà engine vừa dùng.

    Convert Colors là artifact in được, không chỉ là vài số CMYK trong stream.
    Xoá intent cũ rồi thay bằng profile đích ngăn tình trạng số FOGRA nhưng khai
    SWOP (hoặc ngược lại), vốn làm RIP/soft-proof diễn giải sai độ sáng.
    """
    with open(cmyk_profile, "rb") as fh:
        profile_bytes = fh.read()
    profile_name = os.path.basename(cmyk_profile)
    icc_stream = pdf.make_stream(profile_bytes)
    icc_stream["/N"] = 4
    intent = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/OutputIntent"),
            S=pikepdf.Name("/GTS_PDFX"),
            OutputCondition=pikepdf.String(profile_name),
            OutputConditionIdentifier=pikepdf.String(profile_name),
            RegistryName=pikepdf.String("http://www.color.org"),
            Info=pikepdf.String(profile_name),
            DestOutputProfile=icc_stream,
        )
    )
    pdf.Root["/OutputIntents"] = pikepdf.Array([intent])


def _verify_cmyk_output_intent(pdf: pikepdf.Pdf, cmyk_profile: str) -> str | None:
    """Trả blocker nếu artifact không còn mang đúng ICC đích sau serialize."""
    try:
        intents = _deref(pdf.Root.get("/OutputIntents"))
        if not isinstance(intents, pikepdf.Array) or len(intents) != 1:
            return "[OUTPUT_INTENT_MISMATCH] Artifact CMYK thiếu OutputIntent duy nhất."
        profile = _deref(_deref(intents[0]).get("/DestOutputProfile"))
        if profile is None or int(profile.get("/N", 0)) != 4:
            return "[OUTPUT_INTENT_MISMATCH] OutputIntent không chứa ICC CMYK 4 kênh."
        with open(cmyk_profile, "rb") as fh:
            expected = fh.read()
        if bytes(profile.read_bytes()) != expected:
            return "[OUTPUT_INTENT_MISMATCH] ICC nhúng không khớp profile CMYK đã chọn."
    except Exception as exc:  # noqa: BLE001
        return f"[OUTPUT_INTENT_UNREADABLE] Không xác minh được OutputIntent: {exc}"
    return None


def convert_to_cmyk(
    input_path: str,
    output_path: str,
    cmyk_profile: str,
    rgb_profile: str,
    *,
    cancel_check=None,
    rendering_intent: str = "relative",
    preserve_black: bool = True,
    black_point_compensation: bool = True,
    brightness_lstar: float = 0,
    contrast_percent: float = 0,
    vibrance_percent: float = 0,
    adjustment_stage: str = "pre_icc",
) -> dict:
    """Chuyển nội dung RGB sang CMYK ở mức **object**, giữ nguyên phần còn lại.

    Khác Ghostscript `ColorConversionStrategy=CMYK` ở hai điểm quan trọng với
    xưởng in:

    * **Spot sống.** `Separation`/`DeviceN` không bị đụng tới nên kẽm Pantone và
      đường bế vẫn còn sau khi chuyển.
    * **Gray vẫn là gray.** `g`/`G` không đổi: xám in bằng K thuần; đẩy nó thành
      4 kênh chỉ làm tăng TAC và bẩn bản mà không được gì.

    Trả dict: `supported` (False ⇒ caller dừng an toàn), `blockers`, `ops` (số
    toán tử màu đã đổi), `images`, `warnings`.
    """
    result: dict = {
        "supported": True,
        "blockers": [],
        "ops": 0,
        "images": 0,
        "flattened_images": 0,
        "flattened_vectors": 0,
        "warnings": [],
        "adjustments": {
            "brightness_lstar": brightness_lstar,
            "contrast_percent": contrast_percent,
            "vibrance_percent": vibrance_percent,
            "stage": adjustment_stage,
        },
    }
    _raise_if_cancelled(cancel_check)

    try:
        (
            brightness_lstar,
            contrast_percent,
            vibrance_percent,
        ) = _normalize_color_adjustments(
            brightness_lstar=brightness_lstar,
            contrast_percent=contrast_percent,
            vibrance_percent=vibrance_percent,
        )
    except ValueError as exc:
        result["supported"] = False
        result["blockers"] = [f"[INVALID_COLOR_ADJUSTMENT] {exc}"]
        return result
    try:
        adjustment_stage = _normalize_color_adjustment_stage(adjustment_stage)
    except ValueError as exc:
        result["supported"] = False
        result["blockers"] = [f"[INVALID_COLOR_ADJUSTMENT] {exc}"]
        return result
    result["adjustments"] = {
        "brightness_lstar": brightness_lstar,
        "contrast_percent": contrast_percent,
        "vibrance_percent": vibrance_percent,
        "stage": adjustment_stage,
    }

    try:
        tf = _CmykTransform(
            rgb_profile,
            cmyk_profile,
            rendering_intent=rendering_intent,
            black_point_compensation=black_point_compensation,
            brightness_lstar=brightness_lstar,
            contrast_percent=contrast_percent,
            vibrance_percent=vibrance_percent,
            adjustment_stage=adjustment_stage,
        )
    except Exception as exc:  # noqa: BLE001
        result["supported"] = False
        result["blockers"] = [f"không dựng được transform ICC: {exc}"]
        return result

    with pikepdf.open(input_path) as pdf:
        _raise_if_cancelled(cancel_check)
        # COLOR (audit 2026-08-20 §COLOR.21): mở đúng lane vector alpha cô
        # lập, đã chứng minh source-over trên nền trắng; transparency phức tạp
        # vẫn bị scanner từ chối trước khi bất kỳ artifact nào được ghi.
        flattened_vectors = _flatten_isolated_rgb_vector_alpha(pdf)
        result["flattened_vectors"] = flattened_vectors
        if flattened_vectors:
            result["warnings"].append(
                f"Đã flatten {flattened_vectors} đối tượng vector RGB có alpha "
                "trên nền giấy trắng trước khi đổi CMYK."
            )
        # COLOR (audit 2026-08-20 §COLOR.17): ảnh PNG alpha cô lập trên trang
        # trắng có thể composite đúng trong RGB trước ICC mà không raster hóa
        # chữ/vector. Chỉ lane hẹp này được tự động mở; group, nền, Form, ảnh
        # dùng lại và color-key mask vẫn đi qua fail-closed scanner bên dưới.
        flattened_images = _flatten_isolated_rgb_images(
            pdf,
            rgb_profile,
            rendering_intent=rendering_intent,
            black_point_compensation=black_point_compensation,
        )
        result["flattened_images"] = flattened_images
        if flattened_images:
            result["warnings"].append(
                f"Đã flatten {flattened_images} ảnh RGB có SMask trên nền giấy trắng "
                "trước khi đổi CMYK."
            )
        blockers = _scan_convertibility(pdf)
        _raise_if_cancelled(cancel_check)
        if blockers:
            result["supported"] = False
            result["blockers"] = blockers
            return result

        stats: dict = {}
        transform_cache: dict[bytes, _CmykTransform] = {}

        for obj in pdf.objects:
            _raise_if_cancelled(cancel_check)
            try:
                if not isinstance(obj, pikepdf.Stream):
                    continue
                if str(obj.get("/Subtype", "")) != "/Image":
                    continue
            except Exception:  # noqa: BLE001
                continue
            object_tf = _transform_for_colorspace(
                obj.get("/ColorSpace"),
                tf,
                cmyk_profile,
                rendering_intent=rendering_intent,
                black_point_compensation=black_point_compensation,
                brightness_lstar=brightness_lstar,
                contrast_percent=contrast_percent,
                vibrance_percent=vibrance_percent,
                adjustment_stage=adjustment_stage,
                cache=transform_cache,
            )
            if _convert_image_to_cmyk(obj, object_tf) or _convert_indexed_palette_to_cmyk(
                pdf, obj, object_tf
            ):
                result["images"] += 1

        seen: set[tuple[int, int]] = set()

        def convert_stream(
            stream,
            resources,
            color_state: _ProcessColorState | None = None,
        ) -> None:
            _raise_if_cancelled(cancel_check)
            if not isinstance(stream, pikepdf.Stream):
                return
            key = _objkey(stream)
            if key is not None:
                if key in seen:
                    return
                seen.add(key)
            try:
                data = bytes(stream.read_bytes())
            except Exception:  # noqa: BLE001
                return
            new = _convert_content_stream(
                pdf,
                data,
                resources,
                tf,
                stats,
                cmyk_profile=cmyk_profile,
                rendering_intent=rendering_intent,
                black_point_compensation=black_point_compensation,
                preserve_black=preserve_black,
                brightness_lstar=brightness_lstar,
                contrast_percent=contrast_percent,
                vibrance_percent=vibrance_percent,
                adjustment_stage=adjustment_stage,
                transform_cache=transform_cache,
                color_state=color_state,
            )
            if new is not None:
                stream.write(new)
            # Transparency group khai colorspace riêng; bỏ sót nó thì nền blend
            # vẫn được tính trong RGB dù nội dung đã sang CMYK.
            try:
                group = stream.get("/Group")
                if group is not None and _cs_is_device_rgb(group.get("/CS")):
                    group["/CS"] = pikepdf.Name("/DeviceCMYK")
            except Exception:  # noqa: BLE001
                pass

        def walk_forms(resources, depth: int) -> None:
            _raise_if_cancelled(cancel_check)
            if depth > _MAX_FORM_DEPTH or resources is None:
                return
            try:
                xobjects = _deref(resources.get("/XObject"))
                if xobjects is None:
                    return
                for _name, target in dict(xobjects).items():
                    _raise_if_cancelled(cancel_check)
                    target = _deref(target)
                    if str(target.get("/Subtype", "")) != "/Form":
                        continue
                    inner_res = _resource_scope(target, resources)
                    convert_stream(
                        target,
                        inner_res,
                        _ProcessColorState.inherited_unknown(),
                    )
                    if inner_res is not resources:
                        walk_forms(inner_res, depth + 1)
            except Exception:  # noqa: BLE001
                return

        for page in pdf.pages:
            _raise_if_cancelled(cancel_check)
            try:
                resources = page.get("/Resources")
                contents = page.get("/Contents")
                page_color_state = _ProcessColorState()
                if contents is not None:
                    if isinstance(contents, pikepdf.Array):
                        for c in contents:
                            convert_stream(_deref(c), resources, page_color_state)
                    else:
                        convert_stream(_deref(contents), resources, page_color_state)
                walk_forms(resources, 0)

                # Appearance stream của annotation dùng resources RIÊNG và vẫn
                # lên bản in (chữ ký, tem, form field đã flatten).
                annots = _deref(page.get("/Annots"))
                if annots is not None:
                    for annot in annots:
                        ap = _deref(_deref(annot).get("/AP"))
                        if ap is None:
                            continue
                        for _slot, val in dict(ap).items():
                            val = _deref(val)
                            if isinstance(val, pikepdf.Stream):
                                candidates = [val]
                            elif isinstance(val, pikepdf.Dictionary):
                                candidates = [_deref(v) for v in dict(val).values()]
                            else:
                                continue
                            for st in candidates:
                                if not isinstance(st, pikepdf.Stream):
                                    continue
                                res = st.get("/Resources")
                                convert_stream(
                                    st,
                                    res,
                                    _ProcessColorState.inherited_unknown(),
                                )
                                walk_forms(res, 0)
            except Exception as exc:  # noqa: BLE001
                result["warnings"].append(f"Bỏ qua một trang: {exc}")

            try:
                group = page.get("/Group")
                if group is not None and _cs_is_device_rgb(group.get("/CS")):
                    group["/CS"] = pikepdf.Name("/DeviceCMYK")
            except Exception:  # noqa: BLE001
                pass

        result["ops"] = stats.get("ops", 0)
        if stats.get("blockers"):
            result["supported"] = False
            result["blockers"] = list(dict.fromkeys(stats["blockers"]))[:50]
            return result
        _attach_cmyk_output_intent(pdf, cmyk_profile)
        # COLOR (audit 2026-08-20 §COLOR.04): số ops/images bằng 0 không chứng
        # minh file sạch. Hậu kiểm parser phải đạt trước khi ghi artifact.
        _raise_if_cancelled(cancel_check)
        postflight = _scan_cmyk_postcondition(pdf)
        result["postflight"] = postflight
        if not postflight.get("passed"):
            result["supported"] = False
            result["blockers"] = list(postflight.get("blockers", []))[:50]
            return result
        pdf.save(output_path)
        _raise_if_cancelled(cancel_check)

    # Kiểm lại chính artifact đã serialize: không công bố file nếu quá trình
    # ghi PDF làm mất resource hoặc để residual lọt qua bản trong bộ nhớ.
    try:
        with pikepdf.open(output_path) as saved_pdf:
            saved_postflight = _scan_cmyk_postcondition(saved_pdf)
            output_intent_blocker = _verify_cmyk_output_intent(saved_pdf, cmyk_profile)
    except Exception as exc:  # noqa: BLE001
        result["supported"] = False
        result["blockers"] = [
            f"[POSTFLIGHT_UNREADABLE] Không mở lại được artifact CMYK: {exc}"
        ]
        if os.path.abspath(output_path) != os.path.abspath(input_path):
            try:
                os.remove(output_path)
            except OSError:
                pass
        return result

    result["postflight"] = saved_postflight
    if output_intent_blocker:
        result["supported"] = False
        result["blockers"] = [output_intent_blocker]
        if os.path.abspath(output_path) != os.path.abspath(input_path):
            try:
                os.remove(output_path)
            except OSError:
                pass
        return result
    if not saved_postflight.get("passed"):
        result["supported"] = False
        result["blockers"] = list(saved_postflight.get("blockers", []))[:50]
        if os.path.abspath(output_path) != os.path.abspath(input_path):
            try:
                os.remove(output_path)
            except OSError:
                pass
        return result

    return result


def _eval_tint_transform(fn, tint: float) -> list[float] | None:
    """Chạy hàm tint transform của `Separation` tại một giá trị tint.

    Chỉ nhận `FunctionType 2` (mũ) và `FunctionType 3` (ghép các hàm con kiểu
    2). Đó là dạng mà mọi trình dàn trang sinh ra cho màu pha. Type 0 (bảng
    mẫu) và Type 4 (chương trình PostScript) trả `None` để caller từ chối
    thay vì đoán.
    """
    fn = _deref(fn)
    if fn is None:
        return None
    try:
        ftype = int(fn.get("/FunctionType", -1))
    except Exception:  # noqa: BLE001
        return None

    if ftype == 2:
        try:
            n = float(fn.get("/N", 1))
            c0 = [float(v) for v in (fn.get("/C0") or [0.0])]
            c1 = [float(v) for v in (fn.get("/C1") or [1.0])]
        except Exception:  # noqa: BLE001
            return None
        if len(c0) != len(c1):
            return None
        t = max(0.0, min(1.0, tint)) ** n
        return [a + t * (b - a) for a, b in zip(c0, c1)]

    if ftype == 3:
        try:
            fns = [_deref(f) for f in fn.get("/Functions")]
            bounds = [float(b) for b in (fn.get("/Bounds") or [])]
            encode = [float(e) for e in (fn.get("/Encode") or [])]
            domain = [float(d) for d in (fn.get("/Domain") or [0.0, 1.0])]
        except Exception:  # noqa: BLE001
            return None
        if not fns:
            return None
        d0, d1 = domain[0], domain[1]
        x = max(d0, min(d1, tint))
        # Tìm khoảng con chứa x, rồi ánh xạ x về miền của hàm con đó (§7.10.4).
        i = 0
        while i < len(bounds) and x >= bounds[i]:
            i += 1
        low = d0 if i == 0 else bounds[i - 1]
        high = d1 if i >= len(bounds) else bounds[i]
        e0, e1 = (encode[2 * i], encode[2 * i + 1]) if len(encode) > 2 * i + 1 else (0.0, 1.0)
        sub = e0 if high == low else e0 + (x - low) * (e1 - e0) / (high - low)
        return _eval_tint_transform(fns[i], sub)

    return None


class _LabToCmyk:
    """Lab (thang PDF) → CMYK 0..1 qua ICC, có cache.

    Thang là chỗ duy nhất dễ sai và sai thì không ai thấy cho tới lúc in:
    PDF khai Lab với L trong 0..100 và a/b trong `/Range` (mặc định −100..100,
    thực tế thường −128..127), còn chế độ `LAB` của Pillow là 8-bit — L nén về
    0..255 và a/b cộng offset 128. Nhầm một trong hai là màu pha lệch hẳn, mà
    màu pha lại đúng thứ khách đặt tên riêng để đòi cho chính xác.

    Profile Lab của Little CMS dùng điểm trắng D50, khớp `/WhitePoint` D50 mà
    trình dàn trang ghi cho Pantone.
    """

    def __init__(self, cmyk_profile: str):
        from PIL import Image, ImageCms

        self._Image = Image
        self._tf = ImageCms.buildTransform(
            ImageCms.createProfile("LAB"),
            ImageCms.getOpenProfile(cmyk_profile),
            "LAB",
            "CMYK",
            renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
            flags=_CMS_FLAGS(),
        )
        self._ImageCms = ImageCms
        self._cache: dict[tuple[int, int, int], list[float]] = {}

    def __call__(self, lab: list[float]) -> list[float] | None:
        if len(lab) < 3:
            return None
        l_val = max(0.0, min(100.0, lab[0]))
        a_val = max(-128.0, min(127.0, lab[1]))
        b_val = max(-128.0, min(127.0, lab[2]))
        key = (
            int(round(l_val * 255.0 / 100.0)),
            int(round(a_val + 128.0)),
            int(round(b_val + 128.0)),
        )
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        src = self._Image.new("LAB", (1, 1), key)
        dst = self._ImageCms.applyTransform(src, self._tf)
        c, m, y, k = dst.getpixel((0, 0))
        out = [c / 255.0, m / 255.0, y / 255.0, k / 255.0]
        self._cache[key] = out
        return out


def _separation_to_cmyk(cs, tint: float, lab_tf: "_LabToCmyk | None" = None) -> list[float] | None:
    """Màu CMYK tương đương của một `Separation` tại tint cho trước.

    Theo §8.6.6.4, khi thiết bị không có kênh riêng cho màu pha thì nó phải
    render qua `alternateSpace` + `tintTransform` — nên đây không phải xấp xỉ
    tự nghĩ ra mà đúng đường mà spec đã định nghĩa.
    """
    cs = _deref(cs)
    if not isinstance(cs, pikepdf.Array) or len(cs) < 4:
        return None
    if str(_deref(cs[0])) != "/Separation":
        return None
    kind = _alternate_kind(cs[2])
    out = _eval_tint_transform(cs[3], tint)
    if out is None:
        return None
    if kind == "cmyk":
        if len(out) != 4:
            return None
        return [max(0.0, min(1.0, v)) for v in out]
    if kind == "lab" and lab_tf is not None:
        if len(out) != 3:
            return None
        return lab_tf(out)
    return None


def _alternate_kind(alternate) -> str:
    """Phân loại alternate space của một `Separation`: `cmyk` | `lab` | `khác`."""
    alternate = _deref(alternate)
    name = str(alternate)
    if name in ("/DeviceCMYK", "/CMYK"):
        return "cmyk"
    try:
        if isinstance(alternate, pikepdf.Array) and len(alternate) > 0:
            family = str(_deref(alternate[0]))
            if family == "/Lab":
                return "lab"
            if family == "/ICCBased" and len(alternate) > 1:
                stream = _deref(alternate[1])
                if int(stream.get("/N", 0)) == 4:
                    return "cmyk"
    except Exception:  # noqa: BLE001
        return "khác"
    return "khác"


def convert_spot_to_cmyk(
    input_path: str,
    output_path: str,
    spot_name: str | None = None,
    cmyk_profile: str | None = None,
) -> dict:
    """Thay màu pha bằng CMYK tương đương, giữ nguyên phần còn lại của file.

    `spot_name = None` chuyển mọi spot; đưa tên thì chỉ chuyển đúng kênh đó
    (so sánh không phân biệt hoa/thường, có giải mã `#20` trong tên PDF).

    `cmyk_profile` cần cho spot có alternate **Lab** (dạng Adobe dùng cho
    Pantone hiện đại). Không truyền thì nhóm đó được báo là chưa hỗ trợ.

    Trả dict: `supported` (False ⇒ caller dừng an toàn), `converted` (tên spot đã
    chuyển), `blockers`, `ops`.
    """
    result: dict = {"supported": True, "converted": [], "blockers": [], "ops": 0}
    want = _normalize_colorant(spot_name) if spot_name else None

    lab_tf = None
    if cmyk_profile:
        try:
            lab_tf = _LabToCmyk(cmyk_profile)
        except Exception as exc:  # noqa: BLE001
            logger.warning("spot: không dựng được transform Lab→CMYK: %s", exc)

    with pikepdf.open(input_path) as pdf:
        # ── Lập danh sách spot chuyển được, theo tên resource của từng trang ──
        # Cùng một tên `/CS0` ở hai trang có thể trỏ hai spot khác nhau, nên
        # bản đồ phải dựng theo từng bộ resources chứ không phải toàn cục.
        blockers: list[str] = []
        converted: set[str] = set()

        def spot_map_for(resources) -> dict[str, list[float] | None]:
            """{tên resource → None (không đụng) hoặc hàm tint đã kiểm}"""
            out: dict[str, list[float] | None] = {}
            try:
                cs_dict = _deref(resources.get("/ColorSpace")) if resources else None
            except Exception:  # noqa: BLE001
                return out
            if cs_dict is None:
                return out
            for name, cs in dict(cs_dict).items():
                cs = _deref(cs)
                if not isinstance(cs, pikepdf.Array) or len(cs) < 4:
                    continue
                if str(_deref(cs[0])) != "/Separation":
                    continue
                colorant = _normalize_colorant(str(_deref(cs[1])))
                # `/None` và `/All` là colorant đặc biệt (§8.6.6.4), không phải
                # màu pha thật — đụng vào chúng là đổi ngữ nghĩa trang.
                if colorant in ("none", "all"):
                    continue
                if want is not None and colorant != want:
                    continue
                if _separation_to_cmyk(cs, 1.0, lab_tf) is None:
                    kind = _alternate_kind(cs[2])
                    if kind == "lab":
                        # Adobe mô tả Pantone hiện đại bằng alternate Lab vì nó
                        # chính xác hơn CMYK. Chuyển được, nhưng phải qua ICC
                        # với đúng thang Lab (L 0..100, a/b −128..127) — sai
                        # thang là sai màu pha, thứ khách hàng đặt tên riêng để
                        # đòi cho đúng. Đánh dấu blocker cho tới khi đo được.
                        blockers.append(f"alternate space Lab: {colorant}")
                    else:
                        blockers.append(
                            f"tint transform hoặc alternate không đọc được: {colorant}"
                        )
                    continue
                out[str(name)] = cs
                converted.add(_decode_pdf_name(str(_deref(cs[1]))))
            return out

        stats: dict = {}
        seen: set[tuple[int, int]] = set()

        def convert_stream(stream, resources) -> None:
            if not isinstance(stream, pikepdf.Stream):
                return
            key = _objkey(stream)
            if key is not None:
                if key in seen:
                    return
                seen.add(key)
            mapping = spot_map_for(resources)
            if not mapping:
                return
            try:
                data = bytes(stream.read_bytes())
            except Exception:  # noqa: BLE001
                return
            new = _replace_spot_ops(pdf, data, mapping, stats, lab_tf)
            if new is not None:
                stream.write(new)

        for page in pdf.pages:
            try:
                resources = page.get("/Resources")
                contents = page.get("/Contents")
                if contents is None:
                    continue
                if isinstance(contents, pikepdf.Array):
                    for c in contents:
                        convert_stream(_deref(c), resources)
                else:
                    convert_stream(_deref(contents), resources)

                xobjects = _deref(resources.get("/XObject")) if resources else None
                if xobjects is not None:
                    for _n, target in dict(xobjects).items():
                        target = _deref(target)
                        if str(target.get("/Subtype", "")) == "/Form":
                            convert_stream(target, target.get("/Resources") or resources)
            except Exception as exc:  # noqa: BLE001
                blockers.append(f"bỏ qua một trang: {exc}")

        if blockers:
            result["supported"] = False
            result["blockers"] = blockers
            return result

        result["ops"] = stats.get("ops", 0)
        result["converted"] = sorted(converted)
        pdf.save(output_path)
    return result


def _decode_pdf_name(name: str) -> str:
    """Tên PDF về dạng người đọc được: bỏ `/`, giải chuỗi thoát `#20` (§7.3.5)."""
    s = str(name).lstrip("/")
    out = []
    i = 0
    while i < len(s):
        if s[i] == "#" and i + 2 < len(s):
            try:
                out.append(chr(int(s[i + 1 : i + 3], 16)))
                i += 3
                continue
            except ValueError:
                pass
        out.append(s[i])
        i += 1
    return "".join(out)


def _normalize_colorant(name: str) -> str:
    """Tên colorant về dạng so sánh được (đã giải mã, hạ chữ thường)."""
    return _decode_pdf_name(name).strip().lower()


def _replace_spot_ops(
    pdf: pikepdf.Pdf, data: bytes, mapping: dict, stats: dict, lab_tf=None
) -> bytes | None:
    """Đổi `/CSx cs <tint> scn` của spot thành `<c m y k> k` trong content stream."""
    try:
        instructions = pikepdf.parse_content_stream(pikepdf.Stream(pdf, data))
    except Exception:  # noqa: BLE001
        return None

    out = []
    fill_cs = None
    stroke_cs = None
    changed = False

    for instr in instructions:
        op = str(instr.operator)
        operands = list(instr.operands)

        if op in ("cs", "CS") and operands:
            name = str(operands[0])
            target = mapping.get(name)
            if op == "cs":
                fill_cs = target
            else:
                stroke_cs = target
            if target is not None:
                # Bỏ hẳn lệnh `cs`: `k`/`K` phía sau đã tự khai DeviceCMYK.
                changed = True
                continue

        if op in ("sc", "scn", "SC", "SCN"):
            target = fill_cs if op in ("sc", "scn") else stroke_cs
            if target is not None and len(operands) == 1:
                try:
                    cmyk = _separation_to_cmyk(target, float(operands[0]), lab_tf)
                except Exception:  # noqa: BLE001
                    cmyk = None
                if cmyk is not None:
                    out.append(
                        (cmyk, pikepdf.Operator("k" if op in ("sc", "scn") else "K"))
                    )
                    stats["ops"] = stats.get("ops", 0) + 1
                    changed = True
                    continue

        out.append(instr)

    if not changed:
        return None
    try:
        return pikepdf.unparse_content_stream(out)
    except Exception:  # noqa: BLE001
        return None


def _detect_transparency_by_page(
    pdf_path: str, cancel_check=None
) -> dict[int, list[str]]:
    """Trả dấu hiệu transparency theo số trang 1-based trong cây nội dung thật."""
    found_by_page: dict[int, list[str]] = {}

    # RESIZE (audit 2026-08-03 §TR.5): duyệt từ CÂY TRANG, không quét
    # `pdf.objects`; object mồ côi không được phép làm UI báo nhầm trang còn alpha.
    try:
        _raise_if_cancelled(cancel_check)
        with pikepdf.open(pdf_path) as pdf:
            for page_number, page in enumerate(pdf.pages, start=1):
                _raise_if_cancelled(cancel_check)
                found: list[str] = []
                seen: set[tuple[int, int]] = set()

                def note(msg: str) -> None:
                    if msg not in found:
                        found.append(msg)

                # COLOR (audit 2026-08-20 §COLOR.22): transparency không chỉ
                # nằm trong ExtGState/XObject. Inline image và CharProc của
                # Type3 có thể mang /Mask hoặc /SMask ngay trong content stream;
                # bỏ qua chúng khiến flatten chỉ copy file rồi báo thành công.
                seen_streams: set[tuple[int, int]] = set()

                def scan_content_stream(stream) -> None:
                    stream = _deref(stream)
                    if not isinstance(stream, pikepdf.Stream):
                        return
                    key = _objkey(stream)
                    if key is not None:
                        if key in seen_streams:
                            return
                        seen_streams.add(key)
                    try:
                        instructions = pikepdf.parse_content_stream(stream)
                    except Exception:  # noqa: BLE001
                        # Content lỗi mà có dấu hiệu inline image thì không
                        # được phép coi là file đục an toàn; caller sẽ raster
                        # hoặc dừng thay vì copy mù.
                        try:
                            raw = bytes(stream.read_bytes())
                        except Exception:  # noqa: BLE001
                            raw = b""
                        if b"BI" in raw and (b"/Mask" in raw or b"/SMask" in raw):
                            note("inline image không đọc được có mặt nạ")
                        return
                    for instruction in instructions:
                        if str(instruction.operator) != "INLINE IMAGE":
                            continue
                        operands = list(instruction.operands)
                        if not operands:
                            continue
                        image = operands[0]
                        image_obj = getattr(image, "obj", None)
                        if image_obj is None:
                            continue
                        if image_obj.get("/SMask") is not None:
                            note("inline image có /SMask")
                        if image_obj.get("/Mask") is not None:
                            note("inline image có /Mask")

                def visit_resources(resources, depth: int) -> None:
                    if resources is None or depth > _MAX_FORM_DEPTH:
                        return
                    resources = _deref(resources)
                    try:
                        gs_dict = _deref(resources.get("/ExtGState"))
                        if gs_dict is not None:
                            for _name, gs in dict(gs_dict).items():
                                gs = _deref(gs)
                                smask = gs.get("/SMask")
                                if smask is not None and str(_deref(smask)) != "/None":
                                    note("soft mask trong ExtGState")
                                for key in ("/ca", "/CA"):
                                    value = gs.get(key)
                                    if value is not None and float(value) < 1.0:
                                        note("alpha hằng < 1")
                                blend_mode = gs.get("/BM")
                                if blend_mode is not None:
                                    names = (
                                        [str(item) for item in blend_mode]
                                        if isinstance(blend_mode, pikepdf.Array)
                                        else [str(blend_mode)]
                                    )
                                    if any(
                                        name not in ("/Normal", "/Compatible")
                                        for name in names
                                    ):
                                        note("blend mode khác Normal")
                    except Exception:  # noqa: BLE001
                        pass

                    try:
                        # Type3 CharProcs là content stream độc lập, không
                        # xuất hiện trong /XObject; phải quét cả resources của
                        # font và từng glyph stream.
                        fonts = _deref(resources.get("/Font"))
                        if fonts is not None:
                            for _font_name, font in dict(fonts).items():
                                font = _deref(font)
                                if str(font.get("/Subtype", "")) != "/Type3":
                                    continue
                                visit_resources(font.get("/Resources"), depth + 1)
                                charprocs = _deref(font.get("/CharProcs"))
                                if charprocs is not None:
                                    for charproc in dict(charprocs).values():
                                        scan_content_stream(charproc)
                    except Exception:  # noqa: BLE001
                        pass

                    try:
                        xobjects = _deref(resources.get("/XObject"))
                        if xobjects is None:
                            return
                        for _name, xobject in dict(xobjects).items():
                            xobject = _deref(xobject)
                            object_key = _objkey(xobject)
                            if object_key is not None:
                                if object_key in seen:
                                    continue
                                seen.add(object_key)
                            subtype = str(xobject.get("/Subtype", ""))
                            if subtype == "/Image":
                                if xobject.get("/SMask") is not None:
                                    note("ảnh có /SMask")
                                if xobject.get("/Mask") is not None:
                                    note("ảnh có /Mask")
                                continue
                            scan_content_stream(xobject)
                            group = _deref(xobject.get("/Group"))
                            if (
                                group is not None
                                and str(group.get("/S", "")) == "/Transparency"
                            ):
                                note("transparency group")
                            visit_resources(xobject.get("/Resources"), depth + 1)
                    except Exception:  # noqa: BLE001
                        pass

                try:
                    group = _deref(page.get("/Group"))
                    if group is not None and str(group.get("/S", "")) == "/Transparency":
                        note("transparency group")
                    visit_resources(page.get("/Resources"), 0)
                    contents = _deref(page.get("/Contents"))
                    if isinstance(contents, pikepdf.Array):
                        for content in contents:
                            scan_content_stream(content)
                    else:
                        scan_content_stream(contents)
                    annots = _deref(page.get("/Annots"))
                    if annots is not None:
                        for annot in annots:
                            appearance = _deref(_deref(annot).get("/AP"))
                            if appearance is None:
                                continue
                            for _slot, value in dict(appearance).items():
                                value = _deref(value)
                                streams = (
                                    [value]
                                    if isinstance(value, pikepdf.Stream)
                                    else [_deref(item) for item in dict(value).values()]
                                    if isinstance(value, pikepdf.Dictionary)
                                    else []
                                )
                                for stream in streams:
                                    if not isinstance(stream, pikepdf.Stream):
                                        continue
                                    stream_group = _deref(stream.get("/Group"))
                                    if (
                                        stream_group is not None
                                        and str(stream_group.get("/S", ""))
                                        == "/Transparency"
                                    ):
                                        note("transparency group")
                                    scan_content_stream(stream)
                                    visit_resources(stream.get("/Resources"), 1)
                except Exception:  # noqa: BLE001
                    pass

                if found:
                    found_by_page[page_number] = found
    except InterruptedError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.debug("detect_transparency lỗi: %s", exc)
    return found_by_page


def detect_transparent_pages(pdf_path: str, *, cancel_check=None) -> list[int]:
    """Liệt kê trang 1-based còn transparency trong object graph đang được dùng."""
    return list(_detect_transparency_by_page(pdf_path, cancel_check))


def detect_transparency(pdf_path: str, *, cancel_check=None) -> list[str]:
    """Liệt kê dấu hiệu trong suốt toàn file (rỗng = không có gì để flatten)."""
    found: list[str] = []
    for page_signs in _detect_transparency_by_page(pdf_path, cancel_check).values():
        _raise_if_cancelled(cancel_check)
        for sign in page_signs:
            if sign not in found:
                found.append(sign)
    return found


def flatten_transparency(
    input_path: str,
    output_path: str,
    dpi: float = 300.0,
    *,
    cancel_check=None,
) -> dict:
    """Xoá trong suốt. Không có gì trong suốt thì chỉ sao chép.

    Trang CÓ trong suốt được **rasterize qua PPE** rồi thay bằng một ảnh CMYK.
    Đây là bản MVP mà kế hoạch §5 cho phép, và nó **mất vector** — với tem bế
    hay đường CutContour thì đó là mất mát nghiêm trọng, nên hàm luôn trả cảnh
    báo và caller phải hiển thị.

    So với Ghostscript (`-dCompatibilityLevel=1.3`): GS cũng phá — nó gộp/mất
    OCG và có thể chuyển spot sang process ở vùng chồng lấp — nhưng phá **âm
    thầm** và không nói rõ trang nào. Ở đây mất mát được liệt kê ra.

    Trả dict: `flattened` (số trang đã raster), `warnings`, `supported`.
    """
    result: dict = {
        "supported": True,
        "flattened": 0,
        "warnings": [],
        "blockers": [],
    }
    _raise_if_cancelled(cancel_check)

    def reject(code: str, message: str, *, blocker: str | None = None) -> dict:
        """Từ chối fail-closed và dọn artifact dở dang (nếu có)."""
        result["supported"] = False
        result["blockers"] = [blocker or f"[{code}] {message}"]
        result["warnings"].append(message)
        if os.path.abspath(output_path) != os.path.abspath(input_path):
            try:
                os.remove(output_path)
            except OSError:
                pass
        return result

    # CORRECTNESS (audit 2026-08-10 §PPE.REAUDIT.2): detector trả dấu hiệu theo
    # trang; dùng đúng tập này làm kế hoạch raster. Chỉ cần một trang có alpha
    # không có nghĩa mọi trang còn lại được phép mất chữ/path vector.
    signs_by_page = _detect_transparency_by_page(input_path, cancel_check)
    if not signs_by_page:
        # Không có gì trong suốt: dựng lại file là phá hoại vô cớ.
        import shutil

        _raise_if_cancelled(cancel_check)
        shutil.copyfile(input_path, output_path)
        _raise_if_cancelled(cancel_check)
        return result

    signs: list[str] = []
    for page_signs in signs_by_page.values():
        for sign in page_signs:
            if sign not in signs:
                signs.append(sign)
    transparent_pages = set(signs_by_page)

    try:
        import base64
        import zlib

        import numpy as np

        from app.core.print_engine import facade
    except Exception as exc:  # noqa: BLE001
        return reject("PPE_UNAVAILABLE", f"không nạp được PPE: {exc}")

    # COLOR (audit 2026-08-20 §COLOR.26): PPE đã dựng số CMYK theo profile
    # FOGRA39 mặc định, nên artifact flatten phải khai đúng OutputIntent tương
    # ứng. Không tìm thấy/đọc được profile thì dừng trước khi ghi PDF, không
    # phát hành một file CMYK không có provenance.
    try:
        from app.core.icc_profiles import resolve_cmyk_profile_path
        from PIL import ImageCms

        cmyk_profile_path = resolve_cmyk_profile_path("fogra39")
        if not cmyk_profile_path:
            return reject(
                "PPE_PROFILE_UNAVAILABLE",
                "Không tìm thấy profile CMYK FOGRA39 cho flatten.",
            )
        profile = ImageCms.getOpenProfile(cmyk_profile_path)
        profile_space = str(profile.profile.xcolor_space).strip().upper()
        if profile_space != "CMYK":
            return reject(
                "PPE_PROFILE_INVALID",
                f"Profile FOGRA39 không phải CMYK (xcolor_space={profile_space or '?'}).",
            )
        if not Path(cmyk_profile_path).is_file() or not Path(cmyk_profile_path).read_bytes():
            return reject(
                "PPE_PROFILE_INVALID",
                "Profile CMYK FOGRA39 rỗng hoặc không đọc được.",
            )
    except Exception as exc:  # noqa: BLE001
        return reject("PPE_PROFILE_INVALID", f"Không xác minh được profile FOGRA39: {exc}")

    result["output_intent_profile"] = Path(cmyk_profile_path).name
    result["rendering_intent"] = "relative"
    result["black_point_compensation"] = True

    # Flatten chỉ raster các trang có transparency; các trang đục còn lại có
    # thể đang mang số CMYK theo OutputIntent khác. Không được thay SWOP/
    # GRACoL bằng FOGRA39 một cách âm thầm khi những trang đó vẫn giữ nguyên.
    source_oi_state = "absent"
    source_oi_bytes: bytes | None = None
    try:
        with pikepdf.open(input_path) as source_pdf:
            source_intents = _deref(source_pdf.Root.get("/OutputIntents"))
            if source_intents is not None:
                if not isinstance(source_intents, pikepdf.Array) or len(source_intents) != 1:
                    source_oi_state = "invalid"
                else:
                    source_intent = _deref(source_intents[0])
                    source_profile = (
                        _deref(source_intent.get("/DestOutputProfile"))
                        if isinstance(source_intent, pikepdf.Dictionary)
                        else None
                    )
                    source_oi_bytes = (
                        bytes(source_profile.read_bytes())
                        if isinstance(source_profile, pikepdf.Stream)
                        else b""
                    )
                    # Một ICC stream có byte nhưng thiếu/khai sai /N vẫn là
                    # OutputIntent hỏng. Nếu trang đục còn nguyên, không được
                    # dùng việc "bytes giống FOGRA" để che channel mismatch.
                    source_n = int(source_profile.get("/N", 0)) if source_profile is not None else 0
                    source_oi_state = (
                        "valid" if source_oi_bytes and source_n == 4 else "invalid"
                    )
    except Exception:
        source_oi_state = "invalid"

    source_profile_bytes = Path(cmyk_profile_path).read_bytes()
    with pikepdf.open(input_path) as source_pdf:
        source_page_count = len(source_pdf.pages)
    all_pages_rasterized = len(transparent_pages) == source_page_count
    source_oi_matches = source_oi_state == "valid" and source_oi_bytes == source_profile_bytes
    attach_output_intent = all_pages_rasterized or source_oi_matches
    if not all_pages_rasterized and source_oi_state == "invalid":
        return reject(
            "OUTPUT_INTENT_MISMATCH",
            "File có OutputIntent hỏng trong khi vẫn còn trang không raster; không thể đổi profile an toàn.",
        )
    if not all_pages_rasterized and source_oi_state == "valid" and not source_oi_matches:
        return reject(
            "OUTPUT_INTENT_MISMATCH",
            "Trang đục còn giữ số màu theo OutputIntent khác FOGRA39; flatten không được đổi profile toàn tài liệu.",
        )
    if not attach_output_intent:
        result["output_intent_profile"] = None
        # Có trang raster theo FOGRA nhưng trang đục không có OI chứng minh
        # profile. Đây không phải artifact print-ready; giữ trạng thái explicit
        # để UI/recipe không diễn giải warning như một file đã chuẩn hóa.
        result["profile_mixed_unmanaged"] = True

    # PPE fail-loud khi trang vượt ngân sách bộ nhớ raster — đúng cho việc ĐO
    # mực (thà không có số còn hơn số sai), nhưng ở đây ta chỉ raster hoá, nên
    # bỏ cuộc là để người dùng tay trắng. Hạ DPI dần và NÓI RÕ mức thực dùng.
    dpi_ladder = [d for d in (dpi, 200.0, 150.0, 100.0) if d <= dpi] or [dpi]
    used_dpi = dpi

    with pikepdf.open(input_path) as pdf:
        n_pages = len(pdf.pages)
        for index in range(n_pages):
            _raise_if_cancelled(cancel_check)
            page_number = index + 1
            if page_number not in transparent_pages:
                continue
            sep = None
            last_error = ""
            for candidate in dpi_ladder:
                _raise_if_cancelled(cancel_check)
                try:
                    sep = facade.separations(
                        input_path,
                        page_number,
                        int(candidate),
                        ink_accurate=False,
                        cmyk_profile_id="fogra39",
                        render_intent=1,
                    )
                    used_dpi = min(used_dpi, candidate)
                    break
                except Exception as exc:  # noqa: BLE001
                    last_error = str(exc)
                    continue
            _raise_if_cancelled(cancel_check)
            if sep is None:
                return reject(
                    "PPE_RENDER_FAILED",
                    f"PPE không render được trang {page_number}: {last_error}",
                )
            # Native phải xác nhận rõ CMM đã dùng profile RGB→CMYK. Thiếu cờ
            # cũng là không chứng minh được (đặc biệt với sidecar cũ/fake PPE),
            # không được coi là thành công rồi gắn OutputIntent.
            if sep.get("color_managed") is not True:
                return reject(
                    "PPE_PROFILE_UNAVAILABLE",
                    f"PPE không xác nhận quản lý màu FOGRA39 ở trang {page_number}.",
                )

            plates = sep.get("plates")
            if not isinstance(plates, list):
                return reject(
                    "PPE_PLATE_INVALID",
                    f"PPE trả bộ plate process không đầy đủ/không duy nhất ở trang {page_number}.",
                )

            spot_plates = [
                str(plate.get("name", "?"))
                for plate in plates
                if isinstance(plate, dict) and plate.get("is_spot")
            ]
            if spot_plates:
                # `plate["color"]` là RGB dùng cho display preview, không phải
                # CMYK weights. Dùng nhầm nó sẽ đổi Pantone/CutContour thành
                # màu process sai nhưng PDF vẫn mở được — fail-closed thay vì
                # phát hành artifact có màu pha bị hỏng.
                return reject(
                    "SPOT_FLATTEN_UNSUPPORTED",
                    "Flatten transparency chưa có oracle tint Spot/DeviceN an toàn: "
                    + ", ".join(spot_plates[:3])
                    + ". Giữ bản gốc hoặc chuyển Spot riêng trước khi flatten.",
                )

            expected_process = {"Cyan", "Magenta", "Yellow", "Black"}
            plate_names = [str(plate.get("name", "?")) for plate in plates if isinstance(plate, dict)]
            if (
                len(plate_names) != 4
                or set(plate_names) != expected_process
                or any(not isinstance(plate, dict) for plate in plates)
            ):
                return reject(
                    "PPE_PLATE_INVALID",
                    f"PPE trả bộ plate process không đầy đủ/không duy nhất ở trang {page_number}.",
                )

            width, height = int(sep["width"]), int(sep["height"])
            if width <= 0 or height <= 0:
                return reject(
                    "PPE_PLATE_INVALID",
                    f"PPE trả kích thước không hợp lệ ở trang {page_number}.",
                )
            planes: dict[str, "np.ndarray"] = {}
            for plate in plates:
                _raise_if_cancelled(cancel_check)
                try:
                    raw = zlib.decompress(base64.b64decode(plate["alpha_data"]))
                except Exception as exc:  # noqa: BLE001
                    return reject(
                        "PPE_PLATE_INVALID",
                        f"PPE trả plate '{plate.get('name', '?')}' không giải mã được "
                        f"ở trang {page_number}: {exc}",
                    )
                arr = np.frombuffer(raw, dtype=np.uint8)
                if arr.size != width * height:
                    # Không lặp/cắt byte để “vá” plate: file vẫn mở được nhưng
                    # lượng mực lệch trên toàn vùng sai lưới.
                    return reject(
                        "PPE_PLATE_INVALID",
                        f"PPE trả plate '{plate.get('name', '?')}' sai kích thước "
                        f"ở trang {page_number} ({arr.size} thay vì {width * height}).",
                    )
                planes[plate["name"]] = arr.reshape(height, width)

            cmyk = [
                planes.get(name, np.zeros((height, width), dtype=np.uint8)).astype(np.uint16)
                for name in ("Cyan", "Magenta", "Yellow", "Black")
            ]

            interleaved = np.stack([c.astype(np.uint8) for c in cmyk], axis=-1).tobytes()

            page = pdf.pages[index]
            box = page.get("/CropBox") or page.get("/MediaBox")
            x0, y0, x1, y1 = (float(v) for v in box)
            img = pikepdf.Stream(
                pdf,
                zlib.compress(interleaved, 6),
                Type=pikepdf.Name("/XObject"),
                Subtype=pikepdf.Name("/Image"),
                Width=width,
                Height=height,
                BitsPerComponent=8,
                ColorSpace=pikepdf.Name("/DeviceCMYK"),
                Filter=pikepdf.Name("/FlateDecode"),
            )
            content = (
                f"q {x1 - x0:.4f} 0 0 {y1 - y0:.4f} {x0:.4f} {y0:.4f} cm /FlatIm Do Q\n"
            ).encode("latin-1")
            page["/Resources"] = pikepdf.Dictionary(
                XObject=pikepdf.Dictionary(FlatIm=pdf.make_indirect(img))
            )
            page["/Contents"] = pdf.make_indirect(pikepdf.Stream(pdf, content))
            # `/Group` còn lại sẽ khiến consumer vẫn coi trang là trong suốt.
            if "/Group" in page:
                del page["/Group"]
            result["flattened"] += 1

        _raise_if_cancelled(cancel_check)
        # Số plate process ở trên được PPE dựng với FOGRA39 + Relative+BPC;
        # gắn cùng profile vào OutputIntent trước serialize để RIP/soft-proof
        # không diễn giải các số CMYK bằng SWOP hay profile mặc định khác.
        # Với tài liệu mixed-page không có OI, giữ nguyên provenance nguồn thay
        # vì gắn FOGRA39 lên các trang đục chưa được raster.
        if attach_output_intent:
            try:
                _attach_cmyk_output_intent(pdf, cmyk_profile_path)
            except Exception as exc:  # noqa: BLE001
                return reject(
                    "PPE_PROFILE_INVALID",
                    f"Không gắn được OutputIntent FOGRA39: {exc}",
                )
        pdf.remove_unreferenced_resources()
        pdf.save(output_path)
        _raise_if_cancelled(cancel_check)

    # COLOR (audit 2026-08-20 §COLOR.22): thay page content chưa đủ —
    # annotation appearance, Type3 CharProc hoặc inline image có thể vẫn giữ
    # transparency. Chỉ công bố flatten thành công sau khi mở lại artifact và
    # detector xác nhận không còn dấu hiệu; nếu còn thì xoá artifact.
    remaining = _detect_transparency_by_page(output_path, cancel_check)
    if remaining:
        details = "; ".join(
            f"trang {page}: {', '.join(page_signs[:3])}"
            for page, page_signs in list(remaining.items())[:3]
        )
        return reject(
            "TRANSPARENCY_REMAINS",
            f"Artifact sau flatten vẫn còn transparency ({details}).",
        )

    if attach_output_intent:
        try:
            with pikepdf.open(output_path) as artifact:
                intent_blocker = _verify_cmyk_output_intent(artifact, cmyk_profile_path)
        except Exception as exc:  # noqa: BLE001
            intent_blocker = f"[OUTPUT_INTENT_UNREADABLE] Không mở lại được OutputIntent: {exc}"
        if intent_blocker:
            return reject(
                "PPE_PROFILE_INVALID",
                intent_blocker,
                blocker=intent_blocker,
            )

    result["dpi_used"] = used_dpi
    result["warnings"].append(
        f"Đã raster hoá {result['flattened']} trang ở {int(used_dpi)} DPI để xoá trong suốt "
        f"({', '.join(signs[:3])}). Trang MẤT VECTOR: chữ và đường nét không còn "
        "chỉnh sửa được và sẽ in theo độ phân giải này."
    )
    if attach_output_intent:
        result["warnings"].append(
            f"OutputIntent {result['output_intent_profile']} · Relative + BPC đã được gắn và hậu kiểm."
        )
    else:
        result["warnings"].append(
            "Tài liệu còn trang đục chưa raster nên OutputIntent nguồn được giữ nguyên; "
            "không tự đổi toàn file sang FOGRA39."
        )
    return result


def has_rgb_content(pdf_path: str) -> bool:
    """Dò nhanh file có nội dung RGB không, để khỏi chạy chuyển đổi vô ích."""
    try:
        with pikepdf.open(pdf_path) as pdf:
            for obj in pdf.objects:
                try:
                    if isinstance(obj, pikepdf.Stream) and str(
                        obj.get("/Subtype", "")
                    ) == "/Image" and _cs_is_device_rgb(obj.get("/ColorSpace")):
                        return True
                except Exception:  # noqa: BLE001
                    continue
            for page in pdf.pages:
                data = _page_content_bytes(page)
                for token in (b" rg", b" RG", b"\nrg", b"\nRG"):
                    if token in data:
                        return True
    except Exception:  # noqa: BLE001
        return False
    return False
