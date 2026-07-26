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
