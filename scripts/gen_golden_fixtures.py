"""Sinh bộ PDF golden cho PrynX Print Engine.

Vì sao cần bộ fixture riêng: fixture preflight có sẵn là ảnh và văn bản trộn lẫn,
nên khi PPE lệch Ghostscript ta **không biết** lệch ở đâu — quy đổi màu, lấy mẫu
ảnh, hay hình học. Mỗi file ở đây cố ý chỉ chứa **một** biến số, phủ kín trang,
để hiệu số đo được chỉ có duy nhất một nguyên nhân.

Chạy:

    backend/venv/Scripts/python.exe scripts/gen_golden_fixtures.py
"""

from __future__ import annotations

import sys
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "print_engine" / "golden" / "fixtures"

PAGE_W = 200
PAGE_H = 200


def build_pdf(
    content: str,
    extra_resources: str = "",
    extra_objects: tuple[bytes, ...] = (),
    oc_properties: str = "",
) -> bytes:
    """Dựng PDF một trang tối giản, không nén, không phụ thuộc thư viện ngoài.

    Viết tay để fixture golden **không** đi qua thư viện nào có thể tự ý thêm
    metadata hay đổi colorspace — nội dung file phải đúng như ta viết ra.
    """
    stream = content.encode("latin-1")
    objects: list[bytes] = []

    oc = f" /OCProperties {oc_properties}" if oc_properties else ""
    objects.append(f"<< /Type /Catalog /Pages 2 0 R{oc} >>".encode("latin-1"))
    objects.append(
        f"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".encode("latin-1")
    )
    objects.append(
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Contents 4 0 R /Resources << {extra_resources} >> >>"
        ).encode("latin-1")
    )
    objects.append(
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"
    )
    # Object phụ (Form XObject cho transparency group / soft mask) bắt đầu từ 5 0 R.
    objects.extend(extra_objects)

    out = bytearray(b"%PDF-1.7\n")
    offsets = [0]
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"

    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")
    return bytes(out)


def full_page(ops: str) -> str:
    return f"{ops} 0 0 {PAGE_W} {PAGE_H} re f\n"


def form_object(
    content: str,
    bbox: tuple[int, int, int, int] = (0, 0, PAGE_W, PAGE_H),
    group: str = "",
) -> bytes:
    """Form XObject dạng thô.

    `group` là dict `/Group` nếu form là transparency group. Ghostscript **bắt
    buộc** phải có `/Group` để nhận form làm nguồn soft mask, nên fixture soft mask
    luôn khai nó — thiếu thì GS lặng lẽ bỏ mặt nạ và phép so sẽ so hai thứ khác nhau.
    """
    data = content.encode("latin-1")
    extra = f" /Group {group}" if group else ""
    head = (
        f"<< /Type /XObject /Subtype /Form "
        f"/BBox [{bbox[0]} {bbox[1]} {bbox[2]} {bbox[3]}]{extra} /Length {len(data)} >>"
    ).encode("latin-1")
    return head + b"\nstream\n" + data + b"\nendstream"


def tiling_object(
    content: str,
    bbox: tuple[int, int, int, int],
    paint_type: int = 1,
    xstep: int | None = None,
    ystep: int | None = None,
) -> bytes:
    """Tiling pattern (`/PatternType 1`) dạng thô.

    `paint_type = 2` là **uncoloured**: ô mẫu không khai màu, màu tới từ `scn` bên
    ngoài. Đó là dạng dễ cài sai nhất — nếu operator màu trong ô không bị bỏ qua thì
    mẫu ra đen thay vì màu mà file yêu cầu.
    """
    data = content.encode("latin-1")
    xs = xstep if xstep is not None else bbox[2] - bbox[0]
    ys = ystep if ystep is not None else bbox[3] - bbox[1]
    head = (
        f"<< /Type /Pattern /PatternType 1 /PaintType {paint_type} /TilingType 1 "
        f"/BBox [{bbox[0]} {bbox[1]} {bbox[2]} {bbox[3]}] /XStep {xs} /YStep {ys} "
        f"/Resources << >> /Length {len(data)} >>"
    ).encode("latin-1")
    return head + b"\nstream\n" + data + b"\nendstream"


_GROUP_CMYK = "<< /S /Transparency /CS /DeviceCMYK >>"
_GROUP_GRAY = "<< /S /Transparency /CS /DeviceGray >>"


# ── Shading dictionary dùng lại ──────────────────────────────────────────────
#
# Viết dạng chuỗi PDF thô cùng lý do như phần còn lại của file: fixture phải chứa
# đúng những gì ta khai.

_CMYK_RANGE = "/Range [0 1 0 1 0 1 0 1]"

# K từ 0% tới 100% — cô lập đúng một kênh nên lệch đo được quy về một nguyên nhân.
_FN_K_RAMP = (
    "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 1] /N 1 "
    f"{_CMYK_RANGE} >>"
)
# Chuyển sang rich black: cả 4 kênh cùng tăng ⇒ đỉnh TAC ở cuối trục lên 340%.
# Đây là dạng gradient hay làm vượt giới hạn mực trong thực tế.
_FN_RICH = (
    "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0.6 0.5 0.5 1] /N 1 "
    f"{_CMYK_RANGE} >>"
)

_AXIAL_K = (
    "<< /ShadingType 2 /ColorSpace /DeviceCMYK "
    f"/Coords [0 0 {PAGE_W} 0] /Function {_FN_K_RAMP} >>"
)
_AXIAL_RICH = (
    "<< /ShadingType 2 /ColorSpace /DeviceCMYK "
    f"/Coords [0 0 {PAGE_W} 0] /Function {_FN_RICH} >>"
)
_AXIAL_K_EXTEND = (
    "<< /ShadingType 2 /ColorSpace /DeviceCMYK "
    f"/Coords [0 0 {PAGE_W} 0] /Extend [true true] /Function {_FN_K_RAMP} >>"
)
# Trục chỉ dài nửa trang + extend: kiểm đúng phần `/Extend` mà nếu bỏ qua sẽ làm
# dải chuyển kết thúc đột ngột và sai diện tích phủ mực.
_AXIAL_K_HALF_EXTEND = (
    "<< /ShadingType 2 /ColorSpace /DeviceCMYK "
    f"/Coords [0 0 {PAGE_W // 2} 0] /Extend [true true] /Function {_FN_K_RAMP} >>"
)
_RADIAL_K = (
    "<< /ShadingType 3 /ColorSpace /DeviceCMYK "
    f"/Coords [{PAGE_W // 2} {PAGE_H // 2} 0 {PAGE_W // 2} {PAGE_H // 2} {PAGE_W // 2}] "
    f"/Extend [false true] /Function {_FN_K_RAMP} >>"
)


# ── Bộ fixture ───────────────────────────────────────────────────────────────
# Mỗi file = MỘT biến số. Tên file nói rõ đang đo cái gì.

FIXTURES: dict[str, tuple[str, str]] = {
    # Quy đổi RGB→CMYK: mỗi file một màu nguồn duy nhất, phủ kín trang.
    "rgb_black.pdf": (full_page("0 0 0 rg"), ""),
    "rgb_white.pdf": (full_page("1 1 1 rg"), ""),
    "rgb_mid_gray.pdf": (full_page("0.5 0.5 0.5 rg"), ""),
    "rgb_red.pdf": (full_page("1 0 0 rg"), ""),
    "rgb_green.pdf": (full_page("0 1 0 rg"), ""),
    "rgb_blue.pdf": (full_page("0 0 1 rg"), ""),
    "rgb_dark_brown.pdf": (full_page("0.25 0.15 0.05 rg"), ""),
    # Mực thật: KHÔNG được đi qua ICC ở bất kỳ chế độ nào của PPE.
    "cmyk_solid_400.pdf": (full_page("1 1 1 1 k"), ""),
    "cmyk_k_only.pdf": (full_page("0 0 0 1 k"), ""),
    "cmyk_rich_black.pdf": (full_page("0.6 0.4 0.4 1 k"), ""),
    # DeviceGray phải ra K thuần, không phải rich black.
    "gray_black.pdf": (full_page("0 g"), ""),
    "gray_mid.pdf": (full_page("0.5 g"), ""),
    # Spot: kẽm riêng phải sống.
    "spot_solid.pdf": (
        full_page("/CS0 cs 1 scn"),
        "/ColorSpace << /CS0 [/Separation /PANTONE#20485#20C /DeviceCMYK "
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>] >>",
    ),
    "spot_half_tint.pdf": (
        full_page("/CS0 cs 0.5 scn"),
        "/ColorSpace << /CS0 [/Separation /PANTONE#20485#20C /DeviceCMYK "
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>] >>",
    ),
    # Overprint: nền Cyan + đen overprint. Tổng mực phải là 200%.
    "overprint_black_on_cyan.pdf": (
        f"1 0 0 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"/GSop gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSop << /op true /OP true /OPM 1 >> >>",
    ),
    # Knockout: cùng nội dung nhưng không overprint. Tổng mực phải là 100%.
    "knockout_black_on_cyan.pdf": (
        f"1 0 0 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "",
    ),
    # Overprint trên MỰC PHA — audit 2026-07-27 §A.1.
    #
    # Cặp fixture này tồn tại vì overprint của mực pha đi một đường code khác với
    # overprint của mực process: colorant `Separation` khai đúng MỘT kênh, nên nền
    # process phải còn nguyên kể cả với `OPM 0`. Bản `flatten` sớm của đường xem
    # từng quy Pantone về CMYK trước khi tính overprint, làm hai file dưới đây cho
    # kết quả giống nhau — và Overprint Preview báo "không có vùng thay đổi" trên
    # file có overprint thật. Tổng mực: overprint 200%, knockout 100%.
    "overprint_spot_on_yellow.pdf": (
        f"0 0 1 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"/GSop gs /CS0 cs 1 scn 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ColorSpace << /CS0 [/Separation /PANTONE#20877#20C /DeviceCMYK "
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.9 0.9 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>] >> "
        "/ExtGState << /GSop << /op true /OP true /OPM 0 >> >>",
    ),
    "knockout_spot_on_yellow.pdf": (
        f"0 0 1 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"/CS0 cs 1 scn 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ColorSpace << /CS0 [/Separation /PANTONE#20877#20C /DeviceCMYK "
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.9 0.9 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>] >>",
    ),
    # Gradient. Đây là lớp file mà đỉnh TAC dễ vượt ngưỡng nhất mà mắt không thấy:
    # vùng tối của một dải chuyển sang đen có thể lên rất cao trong khi phần còn
    # lại của trang rất nhẹ.
    "shading_axial_k.pdf": (
        "/Sh0 sh\n",
        "/Shading << /Sh0 " + _AXIAL_K + " >>",
    ),
    "shading_axial_k_extend.pdf": (
        "/Sh0 sh\n",
        "/Shading << /Sh0 " + _AXIAL_K_HALF_EXTEND + " >>",
    ),
    "shading_radial_k.pdf": (
        "/Sh0 sh\n",
        "/Shading << /Sh0 " + _RADIAL_K + " >>",
    ),
    "shading_axial_rich.pdf": (
        "/Sh0 sh\n",
        "/Shading << /Sh0 " + _AXIAL_RICH + " >>",
    ),
    # Shading pattern: cùng gradient nhưng bị giới hạn bởi đường dẫn, không phải
    # bởi clip. Hai đường này dễ lẫn nhau.
    "shading_pattern_half.pdf": (
        f"/Pattern cs /P0 scn 0 0 {PAGE_W // 2} {PAGE_H} re f\n",
        "/Pattern << /P0 << /Type /Pattern /PatternType 2 /Shading "
        + _AXIAL_K_EXTEND
        + " >> >>",
    ),
    # Blend mode. Cùng một nội dung (Cyan đặc + đen K-only), chỉ đổi `/BM`, nên số
    # đo được chỉ có thể lệch vì công thức blend. `Multiply` phải cho 200% (giữ nền)
    # còn `Normal` cho 100% (khoét nền) — nếu quên bù không gian trừ thì hai con số
    # đổi chỗ nhau và đây là chỗ phát hiện.
    "blend_multiply_black_on_cyan.pdf": (
        f"1 0 0 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"/GSbm gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSbm << /BM /Multiply >> >>",
    ),
    "blend_screen_black_on_cyan.pdf": (
        f"1 0 0 0 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"/GSbm gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSbm << /BM /Screen >> >>",
    ),
    "blend_darken_k40_k80.pdf": (
        f"0 0 0 0.4 k 0 0 {PAGE_W} {PAGE_H} re f\n"
        f"/GSbm gs 0 0 0 0.8 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSbm << /BM /Darken >> >>",
    ),
    # Alpha hằng không có group: đường đơn giản nhất của trong suốt, dùng làm mốc
    # để tách lỗi "alpha sai" khỏi lỗi "group sai".
    "alpha_half_k.pdf": (
        f"/GSa gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSa << /ca 0.5 /CA 0.5 >> >>",
    ),
}


# ── Fixture cần object phụ (Form XObject) ────────────────────────────────────

FIXTURES_MULTI: dict[str, tuple] = {
    # Group đục: phải bằng đúng việc vẽ trực tiếp ⇒ 100% K.
    "group_opaque_k.pdf": (
        "/Fm0 Do\n",
        "/XObject << /Fm0 5 0 R >>",
        (form_object(full_page("0 0 0 1 k"), group=_GROUP_CMYK),),
    ),
    # Group alpha 0.5 trên K đặc ⇒ 50%.
    "group_alpha_half_k.pdf": (
        "/GSa gs /Fm0 Do\n",
        "/XObject << /Fm0 5 0 R >> /ExtGState << /GSa << /ca 0.5 /CA 0.5 >> >>",
        (form_object(full_page("0 0 0 1 k"), group=_GROUP_CMYK),),
    ),
    # HAI hình K đặc chồng nhau trong cùng group, alpha 0.5.
    #
    # Đây là fixture quan trọng nhất của nhóm này: alpha của group phải áp MỘT lần
    # cho cả group (⇒ 50%), không áp cho từng phần tử (⇒ 75%). Sai kiểu này báo
    # **thừa** mực nên không làm hỏng lô in, nhưng nó cảnh báo oan hàng loạt file
    # có bóng mờ và làm người dùng bỏ qua cảnh báo.
    "group_alpha_overlap.pdf": (
        "/GSa gs /Fm0 Do\n",
        "/XObject << /Fm0 5 0 R >> /ExtGState << /GSa << /ca 0.5 /CA 0.5 >> >>",
        (
            form_object(
                full_page("0 0 0 1 k") + full_page("0 0 0 1 k"),
                group=_GROUP_CMYK,
            ),
        ),
    ),
    # Group cách ly: đường tính khác hẳn (chia lại alpha) nhưng kết quả phải trùng.
    "group_isolated_alpha_half_k.pdf": (
        "/GSa gs /Fm0 Do\n",
        "/XObject << /Fm0 5 0 R >> /ExtGState << /GSa << /ca 0.5 /CA 0.5 >> >>",
        (
            form_object(
                full_page("0 0 0 1 k"),
                group="<< /S /Transparency /CS /DeviceCMYK /I true >>",
            ),
        ),
    ),
    # Soft mask luminosity: nền xám 50% ⇒ mực còn một nửa.
    "smask_luminosity_half.pdf": (
        f"/GSm gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSm << /SMask << /S /Luminosity /G 5 0 R >> >> >>",
        (form_object(full_page("0.5 g"), group=_GROUP_GRAY),),
    ),
    # Mặt nạ chỉ phủ nửa trang. Ngoài `/BBox`, nền mặc định là ĐEN ⇒ nửa phải không
    # được in. Nếu cài sai (nền trắng) thì mực tràn ra cả trang và GS sẽ khác hẳn.
    "smask_luminosity_bbox_half.pdf": (
        f"/GSm gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSm << /SMask << /S /Luminosity /G 5 0 R >> >> >>",
        (
            form_object(
                f"1 g 0 0 {PAGE_W // 2} {PAGE_H} re f\n",
                bbox=(0, 0, PAGE_W // 2, PAGE_H),
                group=_GROUP_GRAY,
            ),
        ),
    ),
    # Mặt nạ kiểu Alpha: chỉ vùng group đã vẽ mới cho mực qua, màu không liên quan.
    "smask_alpha_half.pdf": (
        f"/GSm gs 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/ExtGState << /GSm << /SMask << /S /Alpha /G 5 0 R >> >> >>",
        (
            form_object(
                f"0 g 0 0 {PAGE_W // 2} {PAGE_H} re f\n",
                group=_GROUP_GRAY,
            ),
        ),
    ),
    # Tiling pattern. Lượng mực phụ thuộc **diện tích nét** của ô mẫu, nên đây là lớp
    # file mà mọi cách xấp xỉ đều cho số bịa: ô tô nửa ⇒ đúng 50% diện tích phủ, còn
    # đỉnh mực ở chỗ có nét vẫn phải là 100%.
    "tiling_half_cell.pdf": (
        f"/Pattern cs /P0 scn 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/Pattern << /P0 5 0 R >>",
        (
            tiling_object(
                f"0 0 0 1 k 0 0 {PAGE_W // 20} {PAGE_H // 10} re f\n",
                bbox=(0, 0, PAGE_W // 10, PAGE_H // 10),
            ),
        ),
    ),
    # Uncoloured pattern: màu do `scn` bên ngoài quyết định, mọi operator màu trong ô
    # bị bỏ qua. Cài sai cho ra mẫu ĐEN thay vì Cyan — sai cả kẽm lẫn lượng mực.
    "tiling_uncoloured_cyan.pdf": (
        f"/CS0 cs 1 0 0 0 /P0 scn 0 0 {PAGE_W} {PAGE_H} re f\n",
        "/Pattern << /P0 5 0 R >> /ColorSpace << /CS0 [/Pattern /DeviceCMYK] >>",
        (
            tiling_object(
                f"0 0 0 1 k 0 0 {PAGE_W // 10} {PAGE_H // 10} re f\n",
                bbox=(0, 0, PAGE_W // 10, PAGE_H // 10),
                paint_type=2,
            ),
        ),
    ),
    # Optional content: lớp TẮT tuyệt đối không được lên kẽm. Đây là chiều sai **ngược**
    # với mọi fixture khác — đo *thừa* mực, không phải thiếu.
    "oc_layer_off.pdf": (
        f"/OC /MC0 BDC 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f EMC\n",
        "/Properties << /MC0 5 0 R >>",
        (b"<< /Type /OCG /Name (Lop tat) >>",),
        "<< /OCGs [5 0 R] /D << /OFF [5 0 R] >> >>",
    ),
    # Cùng nội dung nhưng lớp BẬT — mốc đối chiếu, để chắc fixture trên không trắng
    # chỉ vì engine bỏ cả trang.
    "oc_layer_on.pdf": (
        f"/OC /MC0 BDC 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f EMC\n",
        "/Properties << /MC0 5 0 R >>",
        (b"<< /Type /OCG /Name (Lop bat) >>",),
        "<< /OCGs [5 0 R] /D << >> >>",
    ),
    # Lớp hiện trên màn hình nhưng khai KHÔNG IN. Engine đo mực phải coi là tắt; một
    # renderer xem-trước thì không. Ghostscript cũng đọc cấu hình in nên so được.
    "oc_print_state_off.pdf": (
        f"/OC /MC0 BDC 0 0 0 1 k 0 0 {PAGE_W} {PAGE_H} re f EMC\n",
        "/Properties << /MC0 5 0 R >>",
        (
            b"<< /Type /OCG /Name (Watermark) "
            b"/Usage << /Print << /PrintState /OFF >> >> >>",
        ),
        "<< /OCGs [5 0 R] /D << /AS [ << /Event /Print /Category [/Print] "
        "/OCGs [5 0 R] >> ] >> >>",
    ),
}


def _q(v: float) -> int:
    """Lượng hoá toạ độ về byte theo `/Decode [0 PAGE_W 0 PAGE_H]`."""
    return max(0, min(255, round(v / PAGE_W * 255)))


def _mesh_stream(body: bytes, shading_type: int, extra: str = "") -> bytes:
    head = (
        f"<< /ShadingType {shading_type} /ColorSpace /DeviceCMYK "
        f"/BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 "
        f"/Decode [0 {PAGE_W} 0 {PAGE_H} 0 1 0 1 0 1 0 1]{extra} "
        f"/Length {len(body)} >>"
    ).encode("latin-1")
    return head + b"\nstream\n" + body + b"\nendstream"


def write_mesh_fixtures() -> int:
    """Shading lưới kiểu 4 và 6, tô K đặc phủ kín trang.

    Chọn màu **đặc một kênh** thay vì một dải chuyển đẹp: mục đích là chốt *hình học*
    của lưới (có phủ kín không, các patch có nối liền không), và một dải chuyển sẽ làm
    con số phụ thuộc cả phép nội suy nên không tách được nguyên nhân khi lệch.
    """
    black = bytes([0, 0, 0, 255])  # C=0 M=0 Y=0 K=1

    # Kiểu 4: hai tam giác nối bằng cờ 1 ⇒ phủ kín trang.
    t4 = bytearray()
    for flag, x, y in [
        (0, 0, 0),
        (0, PAGE_W, 0),
        (0, 0, PAGE_H),
        (1, PAGE_W, PAGE_H),
    ]:
        t4 += bytes([flag, _q(x), _q(y)]) + black
    (OUT_DIR / "mesh_type4_solid.pdf").write_bytes(
        build_pdf("/Sh0 sh\n", "/Shading << /Sh0 5 0 R >>", (_mesh_stream(bytes(t4), 4),))
    )

    # Kiểu 6: một Coons patch là hình chữ nhật phủ kín trang.
    def edge(t: float, x0: float, y0: float, x1: float, y1: float) -> tuple[float, float]:
        return (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)

    pts = [
        (0, 0),
        edge(1 / 3, 0, 0, PAGE_W, 0),
        edge(2 / 3, 0, 0, PAGE_W, 0),
        (PAGE_W, 0),
        edge(1 / 3, PAGE_W, 0, PAGE_W, PAGE_H),
        edge(2 / 3, PAGE_W, 0, PAGE_W, PAGE_H),
        (PAGE_W, PAGE_H),
        edge(1 / 3, PAGE_W, PAGE_H, 0, PAGE_H),
        edge(2 / 3, PAGE_W, PAGE_H, 0, PAGE_H),
        (0, PAGE_H),
        edge(1 / 3, 0, PAGE_H, 0, 0),
        edge(2 / 3, 0, PAGE_H, 0, 0),
    ]
    t6 = bytearray([0])
    for x, y in pts:
        t6 += bytes([_q(x), _q(y)])
    t6 += black * 4
    (OUT_DIR / "mesh_type6_solid.pdf").write_bytes(
        build_pdf("/Sh0 sh\n", "/Shading << /Sh0 5 0 R >>", (_mesh_stream(bytes(t6), 6),))
    )
    return 2


def write_ccitt_fixture() -> int:
    """Ảnh scan G4 thật, mã hoá bởi libtiff — không phải bởi chính PPE.

    Dùng encoder ngoài là điểm quan trọng: nếu fixture do PPE tự sinh thì một mã sai
    trong bảng T.4 vẫn khớp với chính nó và test sẽ xanh trên dữ liệu sai.

    Chiều bit: libtiff coi **bit 0 là run trắng**, còn Pillow chế độ `'1'` lưu trắng
    bằng bit 1 — nên bitmap nguồn bị đảo để chiều stream khớp quy ước fax, cũng là quy
    ước PDF dùng khi `/BlackIs1` là `false`.
    """
    try:
        from PIL import Image
    except ImportError:
        print("  bỏ qua fixture CCITT: thiếu Pillow")
        return 0

    import tempfile

    w = h = 200
    img = Image.new("1", (w, h), 0)
    px = img.load()
    for y in range(50, 150):
        for x in range(50, 150):
            px[x, y] = 1  # vùng sẽ là ĐEN sau khi giải mã

    with tempfile.TemporaryDirectory() as td:
        tif = Path(td) / "src.tif"
        img.save(tif, compression="group4")
        with Image.open(tif) as opened:
            offsets = opened.tag_v2[273]
            counts = opened.tag_v2[279]
        raw = tif.read_bytes()
        data = b"".join(raw[o : o + c] for o, c in zip(offsets, counts))

    image_obj = (
        f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} "
        f"/BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode "
        f"/DecodeParms << /K -1 /Columns {w} /Rows {h} >> /Length {len(data)} >>"
    ).encode("latin-1") + b"\nstream\n" + data + b"\nendstream"

    (OUT_DIR / "ccitt_group4.pdf").write_bytes(
        build_pdf(
            f"q {PAGE_W} 0 0 {PAGE_H} 0 0 cm /Im0 Do Q\n",
            "/XObject << /Im0 5 0 R >>",
            (image_obj,),
        )
    )
    return 1


def write_image_fixture(path: Path, colorspace: str, n_comps: int, sample: list[int]) -> None:
    """Ảnh 1x1 phủ kín trang — tách phần lấy mẫu ảnh khỏi phần quy đổi màu."""
    data = bytes(sample)
    compressed = zlib.compress(data)
    img = (
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
        b"/BitsPerComponent 8 /ColorSpace " + colorspace.encode("latin-1") +
        b" /Filter /FlateDecode /Length " + str(len(compressed)).encode() + b" >>\nstream\n"
        + compressed + b"\nendstream"
    )
    stream = f"q {PAGE_W} 0 0 {PAGE_H} 0 0 cm /Im0 Do Q\n".encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>"
        ).encode("latin-1"),
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        img,
    ]
    _ = n_comps

    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")
    path.write_bytes(bytes(out))


def _flate_image_obj(
    colorspace: str,
    w: int,
    h: int,
    data: bytes,
    smask_ref: str = "",
) -> bytes:
    """Image XObject 8-bit nén Flate, tuỳ chọn tham chiếu `/SMask`."""
    compressed = zlib.compress(data)
    smask = f" /SMask {smask_ref}" if smask_ref else ""
    head = (
        f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} "
        f"/BitsPerComponent 8 /ColorSpace {colorspace}{smask} "
        f"/Filter /FlateDecode /Length {len(compressed)} >>"
    ).encode("latin-1")
    return head + b"\nstream\n" + compressed + b"\nendstream"


def write_downscale_fixtures() -> int:
    """Fixture một-biến cho hành vi downscale ảnh (decimation).

    Vì sao tồn tại: residual 72 DPI (`tra gung`, `banner`, `túi nước mắm`) đều là
    ảnh đặt thu nhỏ với tỷ lệ texel/pixel ≥ 3, nơi Ghostscript cho ra nội dung
    "béo" hơn phép lấy mẫu tâm pixel. File thật trộn quá nhiều biến; các fixture
    này cô lập đúng MỘT biến — vị trí sọc 1-texel so với lưới pixel thiết bị —
    để đo được ngữ nghĩa lấy mẫu của GS bằng số.

    Hình học chung: ảnh 576 texel ngang × 8 hàng (mọi hàng giống nhau — biến số
    chỉ nằm theo X), đặt vào khung 180 pt. Tỷ lệ texel/pixel theo DPI:
    72 → 3.2 (vùng "béo hoá"), 100 → 2.304 (GS trùng nearest từng pixel),
    150 → 1.536. Cùng một fixture đo được cả ba chế độ; muốn quét ratio khác
    chỉ cần đổi DPI khi đo, không cần thêm file.

    Offset đặt 10.203 pt chứ KHÔNG phải 10: với offset nguyên + ratio 16/5,
    mọi biên sọc rơi đúng nửa-pixel (tie của phép làm tròn fixed-point) — đo
    được mỗi luật xử lý tie chứ không đo được ngữ nghĩa lấy mẫu. 0.203 đẩy
    các pha ra khỏi tie ở cả ba DPI gate.
    """
    w, h = 576, 8
    span = 180  # pt, trong trang 200×200
    off = 10.203
    place = f"q {span} 0 0 {span} {off} {off} cm /Im0 Do Q\n"

    def stems_cmyk(stripe_cols: set[int]) -> bytes:
        row = bytearray()
        for x in range(w):
            row += b"\x00\x00\x00\xff" if x in stripe_cols else b"\x00\x00\x00\x00"
        return bytes(row) * h

    def stems_gray(stripe_cols: set[int], value: int) -> bytes:
        row = bytes(value if x in stripe_cols else 0 for x in range(w))
        return row * h

    period4 = set(range(0, w, 4))
    # 8 sọc cô lập, bước 37 texel: 37/3.2 = 11.5625 px thiết bị ⇒ mỗi sọc rơi ở
    # một pha khác nhau so với lưới pixel — đo được sọc nào GS giữ, sọc nào rơi.
    isolated = set(range(37, 37 + 8 * 37, 37))

    # 1. Sọc đen K 1-texel chu kỳ 4: nội dung "dày" mà GS béo hoá khi ratio ≥ 3.
    (OUT_DIR / "image_stems_p4.pdf").write_bytes(
        build_pdf(
            place,
            "/XObject << /Im0 5 0 R >>",
            (_flate_image_obj("/DeviceCMYK", w, h, stems_cmyk(period4)),),
        )
    )

    # 2. Cùng sọc chu kỳ 4 nhưng nằm trong /SMask giá trị THẤP (64/255) trên nền
    # K đặc: cô lập đường downscale của mặt nạ khỏi đường downscale của mẫu màu.
    (OUT_DIR / "image_stems_p4_smask_low.pdf").write_bytes(
        build_pdf(
            place,
            "/XObject << /Im0 5 0 R >>",
            (
                _flate_image_obj(
                    "/DeviceCMYK", w, h, b"\x00\x00\x00\xff" * (w * h), smask_ref="6 0 R"
                ),
                _flate_image_obj("/DeviceGray", w, h, stems_gray(period4, 64)),
            ),
        )
    )

    # 3. Sọc cô lập: kiểm chiều NGƯỢC — GS không union toàn footprint, sọc lẻ
    # phần lớn bị rơi. Mô hình nào giữ hết sọc lẻ là phồng mực so với GS.
    (OUT_DIR / "image_stems_isolated37.pdf").write_bytes(
        build_pdf(
            place,
            "/XObject << /Im0 5 0 R >>",
            (_flate_image_obj("/DeviceCMYK", w, h, stems_cmyk(isolated)),),
        )
    )
    written = 3

    # 4. Đảo cực: nền K đặc, KHE TRẮNG 1-texel chu kỳ 4 — chiều nguy hiểm thật
    # của tra gung/banner (nội dung dày, PPE giữ khe trắng mà GS làm rơi thì PPE
    # báo THIẾU mực). Cùng hình học với (1), chỉ đổi cực tính.
    gaps = set(x for x in range(w) if x % 4 != 0)
    (OUT_DIR / "image_gaps_p4.pdf").write_bytes(
        build_pdf(
            place,
            "/XObject << /Im0 5 0 R >>",
            (_flate_image_obj("/DeviceCMYK", w, h, stems_cmyk(gaps)),),
        )
    )
    written += 1

    # 5+6. Cùng sọc/khe nhưng mã hoá DCT (JPEG): tra gung/banner đều là ảnh JPEG
    # — nếu hành vi "béo hoá" của GS nằm ở đường decode DCT (decode thu nhỏ theo
    # block) thì fixture Flate không bao giờ kích hoạt được nó. Biến số duy nhất
    # so với (1)/(4) là codec.
    #
    # LƯU Ý CỰC TÍNH: Pillow ghi JPEG CMYK với APP14 nhưng KHÔNG theo quy ước
    # đảo của Adobe, nên GS (và PPE khớp GS) render các file này thành ÂM BẢN
    # của pattern đã vẽ. Vì thế fixture vẽ ở vùng mực THẤP quanh nền xám: sau
    # khi đảo, nền thành ~120% TAC — dưới ngưỡng 300% của footprint-max, để
    # fixture đo ĐÚNG một biến (codec + lưới nearest) chứ không đo cơ chế
    # bảo thủ TAC (nền 400% sau đảo từng nuốt sạch khe K của pattern).
    try:
        from PIL import Image
        import io

        def dct_bytes(stripe_cols: set[int]) -> bytes:
            img = Image.new("CMYK", (w, h))
            px = img.load()
            for y in range(h):
                for x in range(w):
                    px[x, y] = (180, 180, 180, 230) if x in stripe_cols else (180, 180, 180, 180)
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=95)
            return buf.getvalue()

        def dct_image_obj(data: bytes) -> bytes:
            head = (
                f"<< /Type /XObject /Subtype /Image /Width {w} /Height {h} "
                f"/BitsPerComponent 8 /ColorSpace /DeviceCMYK "
                f"/Filter /DCTDecode /Length {len(data)} >>"
            ).encode("latin-1")
            return head + b"\nstream\n" + data + b"\nendstream"

        for name, cols in (
            ("image_stems_p4_dct.pdf", period4),
            ("image_gaps_p4_dct.pdf", gaps),
        ):
            (OUT_DIR / name).write_bytes(
                build_pdf(place, "/XObject << /Im0 5 0 R >>", (dct_image_obj(dct_bytes(cols)),))
            )
            written += 1
    except ImportError:
        print("  bỏ qua fixture DCT downscale: thiếu Pillow")

    # 7. Trục Y: ảnh chuyển vị (8×576), sọc NGANG — đường xử lý hàng của
    # rasterizer khác đường xử lý run trong hàng; nếu hai trục cùng ngữ nghĩa
    # thì fixture này khớp (1), lệch là bằng chứng phải mô phỏng riêng từng trục.
    row_black = b"\x00\x00\x00\xff" * 8
    row_white = b"\x00\x00\x00\x00" * 8
    y_data = b"".join(
        row_black if y % 4 == 0 else row_white for y in range(w)
    )
    (OUT_DIR / "image_stems_p4_yaxis.pdf").write_bytes(
        build_pdf(
            place,
            "/XObject << /Im0 5 0 R >>",
            (_flate_image_obj("/DeviceCMYK", 8, w, y_data),),
        )
    )
    written += 1
    return written


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0

    for name, (content, resources) in FIXTURES.items():
        (OUT_DIR / name).write_bytes(build_pdf(content, resources))
        written += 1

    for name, entry in FIXTURES_MULTI.items():
        content, resources, extra = entry[0], entry[1], entry[2]
        oc_props = entry[3] if len(entry) > 3 else ""
        (OUT_DIR / name).write_bytes(build_pdf(content, resources, extra, oc_props))
        written += 1

    written += write_mesh_fixtures()
    written += write_ccitt_fixture()
    written += write_downscale_fixtures()

    # Ảnh: cùng màu với các fixture vector tương ứng để so chéo được hai đường.
    write_image_fixture(OUT_DIR / "image_rgb_black.pdf", "/DeviceRGB", 3, [0, 0, 0])
    write_image_fixture(OUT_DIR / "image_rgb_mid_gray.pdf", "/DeviceRGB", 3, [128, 128, 128])
    write_image_fixture(OUT_DIR / "image_cmyk_solid_400.pdf", "/DeviceCMYK", 4, [255, 255, 255, 255])
    write_image_fixture(OUT_DIR / "image_gray_black.pdf", "/DeviceGray", 1, [0])
    written += 4

    print(f"Đã ghi {written} fixture vào {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
