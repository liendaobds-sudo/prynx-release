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
import zlib
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
    caller quyết định (fallback Ghostscript, hoặc outline, hoặc sửa file nguồn).
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


def _CMS_FLAGS():
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

    return ImageCms.Flags.BLACKPOINTCOMPENSATION | ImageCms.Flags.NOOPTIMIZE

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
            flags=_CMS_FLAGS(),
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
    obj.write(raw, filter=pikepdf.Name("/FlateDecode"))
    obj["/ColorSpace"] = pikepdf.Name("/DeviceGray")
    obj["/BitsPerComponent"] = 8
    obj["/Width"] = gray.width
    obj["/Height"] = gray.height
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


def _eval_tint_transform(fn, tint: float) -> list[float] | None:
    """Chạy hàm tint transform của `Separation` tại một giá trị tint.

    Chỉ nhận `FunctionType 2` (mũ) và `FunctionType 3` (ghép các hàm con kiểu
    2). Đó là dạng mà mọi trình dàn trang sinh ra cho màu pha. Type 0 (bảng
    mẫu) và Type 4 (chương trình PostScript) trả `None` để caller fallback
    Ghostscript thay vì đoán.
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
    Pantone hiện đại). Không truyền thì nhóm đó rơi về Ghostscript.

    Trả dict: `supported` (False ⇒ fallback GS), `converted` (tên spot đã
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
                        # đòi cho đúng. Giao Ghostscript cho tới khi đo được.
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


def detect_transparency(pdf_path: str) -> list[str]:
    """Liệt kê dấu hiệu trong suốt trong file (rỗng = không có gì để flatten).

    Bốn dấu hiệu theo §11: transparency group (`/Group /S /Transparency`), soft
    mask trong gstate (`/SMask` khác `/None`), alpha hằng (`/ca`,`/CA` < 1), và
    blend mode khác `/Normal`. Ảnh có `/SMask` cũng tính — nó là alpha per-pixel.
    """
    found: list[str] = []

    def note(msg: str) -> None:
        if msg not in found:
            found.append(msg)

    # Duyệt từ CÂY TRANG, không quét `pdf.objects`: một file đã flatten vẫn còn
    # object mồ côi mang `/Group` nằm lại trong xref, và quét thô sẽ báo "vẫn
    # còn trong suốt" cho chính file mình vừa làm sạch. Câu hỏi cần trả lời là
    # "nội dung SẼ RENDER có trong suốt không".
    seen: set[tuple[int, int]] = set()

    def visit_resources(resources, depth: int) -> None:
        if resources is None or depth > _MAX_FORM_DEPTH:
            return
        resources = _deref(resources)
        try:
            gs_dict = _deref(resources.get("/ExtGState"))
            if gs_dict is not None:
                for _n, gs in dict(gs_dict).items():
                    gs = _deref(gs)
                    sm = gs.get("/SMask")
                    if sm is not None and str(_deref(sm)) != "/None":
                        note("soft mask trong ExtGState")
                    for key in ("/ca", "/CA"):
                        val = gs.get(key)
                        if val is not None and float(val) < 1.0:
                            note("alpha hằng < 1")
                    bm = gs.get("/BM")
                    if bm is not None:
                        names = (
                            [str(b) for b in bm]
                            if isinstance(bm, pikepdf.Array)
                            else [str(bm)]
                        )
                        if any(n not in ("/Normal", "/Compatible") for n in names):
                            note("blend mode khác Normal")
        except Exception:  # noqa: BLE001
            pass
        try:
            xobjects = _deref(resources.get("/XObject"))
            if xobjects is None:
                return
            for _n, xo in dict(xobjects).items():
                xo = _deref(xo)
                key = _objkey(xo)
                if key is not None:
                    if key in seen:
                        continue
                    seen.add(key)
                subtype = str(xo.get("/Subtype", ""))
                if subtype == "/Image":
                    if xo.get("/SMask") is not None:
                        note("ảnh có /SMask")
                    continue
                group = _deref(xo.get("/Group"))
                if group is not None and str(group.get("/S", "")) == "/Transparency":
                    note("transparency group")
                visit_resources(xo.get("/Resources"), depth + 1)
        except Exception:  # noqa: BLE001
            pass

    try:
        with pikepdf.open(pdf_path) as pdf:
            for page in pdf.pages:
                try:
                    group = _deref(page.get("/Group"))
                    if group is not None and str(group.get("/S", "")) == "/Transparency":
                        note("transparency group")
                    visit_resources(page.get("/Resources"), 0)
                    annots = _deref(page.get("/Annots"))
                    if annots is not None:
                        for annot in annots:
                            ap = _deref(_deref(annot).get("/AP"))
                            if ap is None:
                                continue
                            for _slot, val in dict(ap).items():
                                val = _deref(val)
                                streams = (
                                    [val]
                                    if isinstance(val, pikepdf.Stream)
                                    else [_deref(v) for v in dict(val).values()]
                                    if isinstance(val, pikepdf.Dictionary)
                                    else []
                                )
                                for st in streams:
                                    if not isinstance(st, pikepdf.Stream):
                                        continue
                                    g = _deref(st.get("/Group"))
                                    if g is not None and str(g.get("/S", "")) == "/Transparency":
                                        note("transparency group")
                                    visit_resources(st.get("/Resources"), 1)
                except Exception:  # noqa: BLE001
                    continue
    except Exception as exc:  # noqa: BLE001
        logger.debug("detect_transparency lỗi: %s", exc)
    return found


def flatten_transparency(input_path: str, output_path: str, dpi: float = 300.0) -> dict:
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
    result: dict = {"supported": True, "flattened": 0, "warnings": []}

    signs = detect_transparency(input_path)
    if not signs:
        # Không có gì trong suốt: dựng lại file là phá hoại vô cớ.
        import shutil

        shutil.copyfile(input_path, output_path)
        return result

    try:
        import base64
        import zlib

        import numpy as np

        from app.core.print_engine import facade
    except Exception as exc:  # noqa: BLE001
        result["supported"] = False
        result["warnings"].append(f"không nạp được PPE: {exc}")
        return result

    spot_lost: set[str] = set()

    # PPE fail-loud khi trang vượt ngân sách bộ nhớ raster — đúng cho việc ĐO
    # mực (thà không có số còn hơn số sai), nhưng ở đây ta chỉ raster hoá, nên
    # bỏ cuộc là để người dùng tay trắng. Hạ DPI dần và NÓI RÕ mức thực dùng.
    dpi_ladder = [d for d in (dpi, 200.0, 150.0, 100.0) if d <= dpi] or [dpi]
    used_dpi = dpi

    with pikepdf.open(input_path) as pdf:
        n_pages = len(pdf.pages)
        for index in range(n_pages):
            sep = None
            last_error = ""
            for candidate in dpi_ladder:
                try:
                    sep = facade.separations(
                        input_path, index + 1, int(candidate), ink_accurate=False
                    )
                    used_dpi = min(used_dpi, candidate)
                    break
                except Exception as exc:  # noqa: BLE001
                    last_error = str(exc)
                    continue
            if sep is None:
                result["supported"] = False
                result["warnings"].append(
                    f"PPE không render được trang {index + 1}: {last_error}"
                )
                return result

            width, height = int(sep["width"]), int(sep["height"])
            planes: dict[str, "np.ndarray"] = {}
            for plate in sep["plates"]:
                raw = zlib.decompress(base64.b64decode(plate["alpha_data"]))
                arr = np.frombuffer(raw, dtype=np.uint8)
                if arr.size != width * height:
                    arr = np.resize(arr, width * height)
                planes[plate["name"]] = arr.reshape(height, width)
                if plate.get("is_spot"):
                    spot_lost.add(plate["name"])

            # Spot phải được GỘP vào process, không được bỏ: bỏ đi là mất hẳn
            # nội dung khỏi bản in. Gộp bằng cộng bão hoà theo màu process gần
            # nhất mà PPE đã tính cho kẽm đó.
            cmyk = [
                planes.get(name, np.zeros((height, width), dtype=np.uint8)).astype(np.uint16)
                for name in ("Cyan", "Magenta", "Yellow", "Black")
            ]
            for plate in sep["plates"]:
                if not plate.get("is_spot"):
                    continue
                spot = planes[plate["name"]].astype(np.uint16)
                colour = plate.get("color") or [0, 0, 0, 255]
                for ch in range(4):
                    weight = (colour[ch] if ch < len(colour) else 0) / 255.0
                    if weight > 0:
                        cmyk[ch] = np.minimum(cmyk[ch] + (spot * weight).astype(np.uint16), 255)

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

        pdf.remove_unreferenced_resources()
        pdf.save(output_path)

    result["dpi_used"] = used_dpi
    result["warnings"].append(
        f"Đã raster hoá {result['flattened']} trang ở {int(used_dpi)} DPI để xoá trong suốt "
        f"({', '.join(signs[:3])}). Trang MẤT VECTOR: chữ và đường nét không còn "
        "chỉnh sửa được và sẽ in theo độ phân giải này."
    )
    if spot_lost:
        result["warnings"].append(
            "Kênh Spot đã được GỘP vào CMYK: "
            + ", ".join(sorted(spot_lost))
            + ". Nếu cần in bằng mực pha (Pantone) hoặc giữ kênh bế, ĐỪNG dùng bản này."
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
