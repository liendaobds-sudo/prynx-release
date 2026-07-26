"""Action sửa PDF chạy bằng pikepdf/Pillow/fontTools — không cần Ghostscript.

Vì sao tồn tại: Ghostscript **dựng lại toàn bộ file** cho mọi action. Kể cả khi
chỉ cần hạ độ phân giải một tấm ảnh, `pdfwrite` vẫn viết lại mọi trang, mọi
font, mọi shading — kéo theo hàng loạt thay đổi không ai yêu cầu (subset lại
font, quy đổi colorspace, mất optional content, mất cấu trúc tag). Các action ở
đây đi đường **object-level**: mở file, sửa đúng object cần sửa, ghi lại phần
còn lại nguyên vẹn.

Nguyên tắc chung của module:

* **Không đoán.** Việc gì chưa chắc đúng thì BỎ QUA object đó và ghi cảnh báo,
  để caller fallback Ghostscript. Sửa sai một ảnh in offset đắt hơn nhiều so
  với việc bỏ qua nó.
* **Báo cáo được.** Mỗi hàm trả `dict` có `changed`, `skipped`, `warnings` để
  action log nói được chính xác đã đụng vào cái gì.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import pikepdf

logger = logging.getLogger(__name__)

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
        # sang Ghostscript một cách vô cớ.
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

    obj.write(raw, filter=pikepdf.Name("/FlateDecode"))
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
    smask.write(raw, filter=pikepdf.Name("/FlateDecode"))
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
    caller quyết định (fallback Ghostscript, hoặc outline, hoặc sửa file nguồn).
    """
    result = {
        "embedded": [],
        "base14": [],
        "missing": [],
        "warnings": [],
    }
    try:
        pdf = pikepdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001
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

# Colorspace mà việc chuyển sang CMYK là **mất mát không phục hồi được** hoặc
# vượt tầm object-level. Gặp là trả `supported=False` để caller fallback GS.
_UNCONVERTIBLE_HINTS = ("/Lab", "/CalRGB")


class _CmykTransform:
    """RGB 0..1 → CMYK 0..1 qua ICC, có cache theo giá trị.

    Một trang thật dùng vài chục màu nhưng gọi tới hàng nghìn lần; ImageCms
    dựng ảnh 1×1 cho mỗi lần gọi nên cache là bắt buộc, không phải tối ưu sớm.
    """

    def __init__(self, rgb_profile: str, cmyk_profile: str):
        from PIL import Image, ImageCms

        self._Image = Image
        self._ImageCms = ImageCms
        self._tf = ImageCms.buildTransform(
            ImageCms.getOpenProfile(rgb_profile),
            ImageCms.getOpenProfile(cmyk_profile),
            "RGB",
            "CMYK",
            renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        )
        self._cache: dict[tuple[int, int, int], tuple[float, float, float, float]] = {}

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
        dst = self._ImageCms.applyTransform(src, self._tf)
        c, m, y, k = dst.getpixel((0, 0))
        out = (c / 255.0, m / 255.0, y / 255.0, k / 255.0)
        self._cache[key] = out
        return out

    def image(self, pil):
        return self._ImageCms.applyTransform(pil.convert("RGB"), self._tf)


def _cs_is_device_rgb(cs) -> bool:
    """`True` khi colorspace là RGB **thiết bị hoặc ICC 3 kênh**.

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
            if str(_deref(cs[0])) == "/ICCBased":
                stream = _deref(cs[1])
                return int(stream.get("/N", 0)) == 3
    except Exception:  # noqa: BLE001
        return False
    return False


def _scan_convertibility(pdf: pikepdf.Pdf) -> list[str]:
    """Lý do KHÔNG chuyển được bằng đường object-level (rỗng = chuyển được).

    Quét trước rồi mới sửa, vì chuyển nửa chừng rồi bỏ cuộc sẽ để lại file lai
    tệ hơn cả file gốc lẫn file GS.
    """
    blockers: list[str] = []

    def note(msg: str) -> None:
        if msg not in blockers:
            blockers.append(msg)

    for obj in pdf.objects:
        try:
            d = obj if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)) else None
            if d is not None and d.get("/ShadingType") is not None:
                if _cs_is_device_rgb(d.get("/ColorSpace")):
                    # Chuyển shading RGB đòi viết lại hàm nội suy màu. Với
                    # `FunctionType 2` chỉ cần đổi `/C0`,`/C1` — nhưng nội suy
                    # tuyến tính TRONG CMYK không cho cùng dải màu với nội suy
                    # trong RGB rồi mới quy đổi, nên khúc giữa gradient lệch đi
                    # một cách nhìn thấy được. Giao cho Ghostscript.
                    note("shading dùng colorspace RGB")
            if d is not None:
                for hint in _UNCONVERTIBLE_HINTS:
                    if hint in str(d.get("/ColorSpace", "")):
                        note(f"colorspace {hint}")
        except Exception:  # noqa: BLE001
            continue
    return blockers


def _convert_content_stream(
    pdf: pikepdf.Pdf,
    data: bytes,
    resources,
    tf: _CmykTransform,
    stats: dict,
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
    # `cs`/`CS` đặt colorspace cho `sc`/`scn` phía sau, nên phải theo dõi riêng
    # cho fill và stroke — dùng chung một biến sẽ đổi nhầm màu nét thành màu tô.
    fill_rgb = False
    stroke_rgb = False
    changed = False

    for instr in instructions:
        op = str(instr.operator)
        operands = list(instr.operands)

        if op in _RGB_TO_CMYK_OP and len(operands) == 3:
            try:
                c, m, y, k = tf(*(float(v) for v in operands))
            except Exception:  # noqa: BLE001
                out.append(instr)
                continue
            out.append(([c, m, y, k], pikepdf.Operator(_RGB_TO_CMYK_OP[op])))
            stats["ops"] = stats.get("ops", 0) + 1
            changed = True
            continue

        if op in ("cs", "CS") and operands:
            target = operands[0]
            is_rgb = False
            if str(target) in ("/DeviceRGB", "/RGB"):
                is_rgb = True
            else:
                try:
                    cs_dict = _deref(resources.get("/ColorSpace")) if resources else None
                    if cs_dict is not None:
                        is_rgb = _cs_is_device_rgb(cs_dict.get(str(target)))
                except Exception:  # noqa: BLE001
                    is_rgb = False
            if op == "cs":
                fill_rgb = is_rgb
            else:
                stroke_rgb = is_rgb
            if is_rgb:
                out.append(([pikepdf.Name("/DeviceCMYK")], pikepdf.Operator(op)))
                changed = True
                continue

        if op in ("sc", "scn", "SC", "SCN"):
            want = fill_rgb if op in ("sc", "scn") else stroke_rgb
            if want and len(operands) == 3:
                try:
                    vals = tf(*(float(v) for v in operands))
                except Exception:  # noqa: BLE001
                    out.append(instr)
                    continue
                out.append(([*vals], pikepdf.Operator(op)))
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


def _convert_indexed_palette_to_cmyk(pdf: pikepdf.Pdf, obj: pikepdf.Stream, tf) -> bool:
    """Đổi bảng màu của ảnh `Indexed` nền RGB sang nền CMYK.

    Rẻ và an toàn hơn hẳn chuyển ảnh thường: **chỉ số pixel không đổi**, chỉ
    bảng tra được viết lại (mỗi ô 3 byte RGB → 4 byte CMYK). Không giải nén
    ảnh, không nội suy, không mất chi tiết — nên ca này đáng làm chứ không nên
    đẩy sang Ghostscript.
    """
    cs = _deref(obj.get("/ColorSpace"))
    if not isinstance(cs, pikepdf.Array) or len(cs) < 4:
        return False
    if str(_deref(cs[0])) not in ("/Indexed", "/I"):
        return False
    if not _cs_is_device_rgb(cs[1]):
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


def _convert_image_to_cmyk(obj: pikepdf.Stream, tf: _CmykTransform) -> bool:
    """Đổi một image XObject RGB sang DeviceCMYK. `False` = không đụng tới."""
    if not _cs_is_device_rgb(obj.get("/ColorSpace")):
        return False
    if bool(obj.get("/ImageMask", False)):
        return False
    if any(f not in _RESAMPLABLE_FILTERS for f in _filter_names(obj.get("/Filter"))):
        return False
    try:
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
    obj.write(raw, filter=pikepdf.Name("/FlateDecode"))
    obj["/ColorSpace"] = pikepdf.Name("/DeviceCMYK")
    obj["/BitsPerComponent"] = 8
    obj["/Width"] = cmyk.width
    obj["/Height"] = cmyk.height
    for dead in ("/DecodeParms", "/DP", "/Decode", "/D"):
        if dead in obj:
            del obj[dead]
    return True


def convert_to_cmyk(
    input_path: str,
    output_path: str,
    cmyk_profile: str,
    rgb_profile: str,
) -> dict:
    """Chuyển nội dung RGB sang CMYK ở mức **object**, giữ nguyên phần còn lại.

    Khác Ghostscript `ColorConversionStrategy=CMYK` ở hai điểm quan trọng với
    xưởng in:

    * **Spot sống.** `Separation`/`DeviceN` không bị đụng tới nên kẽm Pantone và
      đường bế vẫn còn sau khi chuyển.
    * **Gray vẫn là gray.** `g`/`G` không đổi: xám in bằng K thuần; đẩy nó thành
      4 kênh chỉ làm tăng TAC và bẩn bản mà không được gì.

    Trả dict: `supported` (False ⇒ caller fallback GS), `blockers`, `ops` (số
    toán tử màu đã đổi), `images`, `warnings`.
    """
    result: dict = {
        "supported": True,
        "blockers": [],
        "ops": 0,
        "images": 0,
        "warnings": [],
    }

    try:
        tf = _CmykTransform(rgb_profile, cmyk_profile)
    except Exception as exc:  # noqa: BLE001
        result["supported"] = False
        result["blockers"] = [f"không dựng được transform ICC: {exc}"]
        return result

    with pikepdf.open(input_path) as pdf:
        blockers = _scan_convertibility(pdf)
        if blockers:
            result["supported"] = False
            result["blockers"] = blockers
            return result

        stats: dict = {}

        for obj in pdf.objects:
            try:
                if not isinstance(obj, pikepdf.Stream):
                    continue
                if str(obj.get("/Subtype", "")) != "/Image":
                    continue
            except Exception:  # noqa: BLE001
                continue
            if _convert_image_to_cmyk(obj, tf) or _convert_indexed_palette_to_cmyk(
                pdf, obj, tf
            ):
                result["images"] += 1

        seen: set[tuple[int, int]] = set()

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
            new = _convert_content_stream(pdf, data, resources, tf, stats)
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
            if depth > _MAX_FORM_DEPTH or resources is None:
                return
            try:
                xobjects = _deref(resources.get("/XObject"))
                if xobjects is None:
                    return
                for _name, target in dict(xobjects).items():
                    target = _deref(target)
                    if str(target.get("/Subtype", "")) != "/Form":
                        continue
                    inner_res = target.get("/Resources") or resources
                    convert_stream(target, inner_res)
                    walk_forms(inner_res, depth + 1)
            except Exception:  # noqa: BLE001
                return

        for page in pdf.pages:
            try:
                resources = page.get("/Resources")
                contents = page.get("/Contents")
                if contents is not None:
                    if isinstance(contents, pikepdf.Array):
                        for c in contents:
                            convert_stream(_deref(c), resources)
                    else:
                        convert_stream(_deref(contents), resources)
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
                                convert_stream(st, res)
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
        # Không đổi được gì nghĩa là file vốn không có nội dung RGB — vẫn là
        # thành công, chỉ là không có việc để làm.
        pdf.save(output_path)

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
