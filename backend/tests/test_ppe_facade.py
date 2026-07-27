"""Test cho `app/core/print_engine/facade.py`.

# Vì sao facade cần test riêng dù đã có test native và test SeparationEngine

Facade không render gì, nhưng nó giữ **cổng tin cậy**: quyết định kết quả nào của
PPE được phép dùng để kết luận về lượng mực. Một hồi quy ở đây không làm test nào
khác đỏ — nó chỉ khiến hệ thống trả một con số TAC **thấp hơn thực tế** mà vẫn
mang nhãn `rip_separations`. Đó đúng là chiều sai làm hỏng lô in, và là loại lỗi
không ai phát hiện bằng mắt.

Test đi trực tiếp vào facade thay vì qua `SeparationEngine`, vì qua engine thì
nhánh fallback Ghostscript sẽ che mất hành vi của cổng.
"""

from __future__ import annotations

import base64
import zlib
from pathlib import Path

import pytest

pdfcompare_native = pytest.importorskip(
    "pdfcompare_native",
    reason="cần build native: maturin develop --release --manifest-path native/Cargo.toml",
)
if not hasattr(pdfcompare_native, "ppe_separations"):
    pytest.skip("native chưa có PPE — cần rebuild", allow_module_level=True)

from app.core.print_engine import (  # noqa: E402
    ACCURACY_RIP,
    ACCURACY_RIP_APPROX_GEOMETRY,
    PpeResultUntrusted,
    capabilities,
    is_available,
    separations,
    softproof,
)

PAGE = 100


# ─────────────────────────────────────────────────────────────────────────────
#  Dựng PDF tối giản
# ─────────────────────────────────────────────────────────────────────────────
#
# Viết tay thay vì dùng thư viện: fixture phải chứa **đúng** những gì ta khai, và
# mọi thư viện ghi PDF đều có quyền tự thêm metadata hoặc đổi colorspace. Với test
# về độ tin cậy màu/mực thì "gần đúng" là không dùng được.


def _pdf(content: str, resources: str = "", extra_objects: list[bytes] | None = None) -> bytes:
    stream = content.encode("latin-1")
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE} {PAGE}] "
            f"/Contents 4 0 R /Resources << {resources} >> >>"
        ).encode("latin-1"),
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
    ]
    objects.extend(extra_objects or [])

    out = bytearray(b"%PDF-1.7\n")
    offsets: list[int] = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode("latin-1") + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    ).encode("latin-1")
    return bytes(out)


def _write(tmp_path: Path, name: str, data: bytes) -> str:
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


@pytest.fixture
def solid_cmyk(tmp_path) -> str:
    """Trang CMYK vector thuần, 4 kênh đặc ⇒ TAC 400%."""
    return _write(
        tmp_path,
        "solid_cmyk.pdf",
        _pdf(f"1 1 1 1 k 0 0 {PAGE} {PAGE} re f"),
    )


@pytest.fixture
def broken_xref_page(tmp_path) -> str:
    """PDF có `startxref` trỏ ra ngoài file; qpdf phục hồi được, lopdf từ chối."""
    data = _pdf(f"0 0 0 1 k 0 0 {PAGE} {PAGE} re f")
    head, tail = data.rsplit(b"startxref\n", 1)
    _old_offset, eof = tail.split(b"\n", 1)
    broken = head + b"startxref\n999999999\n" + eof
    return _write(tmp_path, "broken_xref.pdf", broken)


@pytest.fixture
def shading_page(tmp_path) -> str:
    """Trang có `sh` — PPE chưa dựng shading nên phải tự khai `ink_unsound`."""
    return _write(tmp_path, "shading.pdf", _pdf("/Sh0 sh"))


@pytest.fixture
def unembedded_text(tmp_path) -> str:
    """Trang chữ dùng font KHÔNG nhúng ⇒ phải thay font ⇒ geometry xấp xỉ."""
    font = b"<< /Type /Font /Subtype /TrueType /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    return _write(
        tmp_path,
        "unembedded_text.pdf",
        _pdf(
            "BT /F1 36 Tf 0 0 0 1 k 5 40 Td (Prynx) Tj ET",
            resources="/Font << /F1 5 0 R >>",
            extra_objects=[font],
        ),
    )


@pytest.fixture
def spot_page(tmp_path) -> str:
    tint = (
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>"
    )
    return _write(
        tmp_path,
        "spot.pdf",
        _pdf(
            f"/CS0 cs 1 scn 0 0 {PAGE} {PAGE} re f",
            resources=(
                "/ColorSpace << /CS0 [/Separation /PANTONE#20485#20C /DeviceCMYK "
                f"{tint}] >>"
            ),
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Khả dụng và capability
# ─────────────────────────────────────────────────────────────────────────────


def test_is_available_reports_true_when_native_has_ppe():
    assert is_available() is True


def test_capabilities_come_from_rust_not_hardcoded():
    """Nguồn duy nhất là code Rust; hardcode ở Python sẽ lạc hậu âm thầm."""
    caps = capabilities()
    assert caps["process_separations"] is True
    assert caps["spot_separations"] is True
    assert caps["icc_color_management"] is True
    # Khai rõ ICC KHÔNG áp cho dữ liệu đã là mực — đây là bất biến sản phẩm.
    assert "DeviceCMYK" in caps["icc_never_applies_to"]
    assert "DeviceRGB" in caps["icc_applies_to"]


# ─────────────────────────────────────────────────────────────────────────────
#  Contract plate
# ─────────────────────────────────────────────────────────────────────────────


def test_returns_four_process_plates_in_fixed_order(solid_cmyk):
    r = separations(solid_cmyk, 1, dpi=72, ink_accurate=True)
    assert [p["name"] for p in r["plates"][:4]] == ["Cyan", "Magenta", "Yellow", "Black"]


def test_alpha_data_decodes_to_exactly_one_byte_per_pixel(solid_cmyk):
    """`alpha_data` = zlib + base64 của mảng `u8` dài `width*height`.

    Frontend dựng lại ảnh RGBA từ `color` + `alpha_data`, nên lệch độ dài một byte
    là ảnh bị xé chéo. Không có test nào khác chốt độ dài này.
    """
    r = separations(solid_cmyk, 1, dpi=72, ink_accurate=True)
    expected = r["width"] * r["height"]
    for plate in r["plates"]:
        raw = zlib.decompress(base64.b64decode(plate["alpha_data"]))
        assert len(raw) == expected, plate["name"]


def test_full_ink_is_255_not_inverted(solid_cmyk):
    """255 = 100% mực.

    Ngược chiều là bug âm thầm chết người: TAC sẽ đọc 400% ở vùng TRẮNG và 0% ở
    vùng đặc — báo cáo vẫn "hợp lý" nên không ai soi lại.
    """
    r = separations(solid_cmyk, 1, dpi=72, ink_accurate=True)
    black = next(p for p in r["plates"] if p["name"] == "Black")
    raw = zlib.decompress(base64.b64decode(black["alpha_data"]))
    assert max(raw) == 255


def test_plate_colours_match_separation_engine_table(solid_cmyk):
    """Màu hiển thị phải dùng CHUNG bảng với `SeparationEngine`.

    Hai bảng song song sẽ lệch khi một bên đổi, và preview đổi màu theo engine là
    bug người dùng thấy ngay.
    """
    from app.core.separations import SeparationEngine

    table = SeparationEngine().PLATE_COLORS
    r = separations(solid_cmyk, 1, dpi=72, ink_accurate=True)
    for plate in r["plates"]:
        if not plate["is_spot"]:
            assert plate["color"] == table[plate["name"]], plate["name"]


def test_solid_cmyk_measures_exactly_400_percent(solid_cmyk):
    r = separations(solid_cmyk, 1, dpi=72, ink_accurate=True)
    assert abs(r["max_tac_pct"] - 400.0) < 0.5


def test_icc_profile_does_not_compress_device_cmyk(solid_cmyk):
    """Bất biến trung tâm: dữ liệu đã là mực không đi qua ICC.

    Facade nạp profile ở CẢ chế độ đo mực. Nếu profile ảnh hưởng tới DeviceCMYK,
    vùng đặc tụt xuống ~292% và một file 400% được báo là đạt ngưỡng 300%.
    """
    with_icc = separations(solid_cmyk, 1, dpi=72, ink_accurate=True, cmyk_profile_id="fogra39")
    without = separations(solid_cmyk, 1, dpi=72, ink_accurate=True, cmyk_profile_id=None)
    assert abs(with_icc["max_tac_pct"] - 400.0) < 0.5
    assert with_icc["max_tac_pct"] == without["max_tac_pct"]


def test_spot_plate_survives_and_is_marked(spot_page):
    r = separations(spot_page, 1, dpi=72, ink_accurate=True)
    spots = [p for p in r["plates"] if p["is_spot"]]
    assert [p["name"] for p in spots] == ["PANTONE 485 C"], [p["name"] for p in r["plates"]]
    assert r["has_spot_colors"] is True
    assert r["detected_spots"] == ["PANTONE 485 C"]
    # Mực pha KHÔNG được rơi sang kẽm process.
    for plate in r["plates"]:
        if not plate["is_spot"]:
            raw = zlib.decompress(base64.b64decode(plate["alpha_data"]))
            assert max(raw) == 0, plate["name"]


# ─────────────────────────────────────────────────────────────────────────────
#  Cổng tin cậy — phần quan trọng nhất
# ─────────────────────────────────────────────────────────────────────────────


def test_clean_page_is_labelled_rip(solid_cmyk):
    r = separations(solid_cmyk, 1, dpi=72, ink_accurate=True)
    assert r["accuracy"] == ACCURACY_RIP
    assert r["engine"] == "ppe"
    assert r["ppe_pdf_recovered"] is False


def test_ink_unsound_page_is_rejected_not_returned(shading_page):
    """Trang có nội dung chưa vẽ được PHẢI bị loại, không được trả plate.

    Nếu trả plate, caller sẽ tính TAC trên một trang thiếu mực và kết luận "đạt
    ngưỡng". Loại thẳng là cách duy nhất khiến kết luận sai không thể xảy ra.
    """
    with pytest.raises(PpeResultUntrusted):
        separations(shading_page, 1, dpi=72, ink_accurate=True)


def test_rejection_reason_is_human_readable(shading_page):
    """Cờ boolean không đủ: người vận hành phải biết vì sao trang bị loại."""
    with pytest.raises(PpeResultUntrusted) as exc:
        separations(shading_page, 1, dpi=72, ink_accurate=True)
    assert "chưa vẽ được" in str(exc.value)
    assert exc.value.detail.get("dropped_objects", 0) > 0
    assert exc.value.detail.get("skipped_ops")


def test_substituted_font_downgrades_accuracy_but_still_returns(unembedded_text):
    """Font thay thế là trục *geometry*, không phải trục *ink*.

    Chữ đã lên mực nên đỉnh TAC vẫn tin được ⇒ vẫn trả kết quả, chỉ hạ nhãn. Loại
    cả trang ở đây sẽ khiến gần như mọi file xưởng bị loại (file thật hầu như luôn
    có một nhãn chữ font không nhúng) và PPE không bao giờ được dùng.
    """
    r = separations(unembedded_text, 1, dpi=72, ink_accurate=True)
    assert r["accuracy"] == ACCURACY_RIP_APPROX_GEOMETRY
    assert r["ppe_substituted_fonts"], "phải khai font nào đã bị thay"
    assert r["max_tac_pct"] > 0.0, "chữ phải thực sự lên mực"


def test_geometry_gate_can_be_tightened_when_area_must_be_exact(unembedded_text):
    """Caller cần diện tích phủ chính xác (vd báo giá mực) loại được trang này."""
    with pytest.raises(PpeResultUntrusted):
        separations(
            unembedded_text,
            1,
            dpi=72,
            ink_accurate=True,
            allow_geometry_approximation=False,
        )


def test_quality_note_names_the_substituted_font(unembedded_text):
    r = separations(unembedded_text, 1, dpi=72, ink_accurate=True)
    assert "Helvetica" in r["quality_note"]
    assert "xấp xỉ" in r["quality_note"]


def test_diagnostic_trace_is_present(solid_cmyk):
    """UI cần giải thích được vì sao accuracy bị hạ, nên vết phải đi kèm."""
    r = separations(solid_cmyk, 1, dpi=72, ink_accurate=True)
    assert "DeviceCMYK" in r["ppe_colorspaces_used"]
    assert isinstance(r["ppe_skipped_ops"], list)


# ─────────────────────────────────────────────────────────────────────────────
#  Lỗi đầu vào
# ─────────────────────────────────────────────────────────────────────────────


def test_broken_xref_is_recovered_without_touching_the_original(broken_xref_page):
    before = Path(broken_xref_page).read_bytes()
    r = separations(broken_xref_page, 1, dpi=72, ink_accurate=True)
    assert r["ppe_pdf_recovered"] is True
    assert "xref/trailer" in r["quality_note"]
    assert r["max_tac_pct"] == pytest.approx(100.0, abs=0.5)
    assert Path(broken_xref_page).read_bytes() == before


def test_missing_file_raises(tmp_path):
    with pytest.raises(RuntimeError):
        separations(str(tmp_path / "khong_ton_tai.pdf"), 1, dpi=72)


def test_page_out_of_range_raises(solid_cmyk):
    with pytest.raises(RuntimeError):
        separations(solid_cmyk, 99, dpi=72)


def test_preview_mode_differs_from_ink_mode_on_edges(tmp_path):
    """Chế độ xem trước bật khử răng cưa, chế độ đo mực thì không.

    Trộn hai chế độ làm cạnh mềm lẫn vào vùng đặc và TAC vùng đặc không còn đọc
    đúng 100% mỗi kênh.
    """
    path = _write(tmp_path, "half.pdf", _pdf(f"0 0 0 1 k 0 0 50.5 {PAGE} re f"))
    ink = separations(path, 1, dpi=72, ink_accurate=True)
    preview = separations(path, 1, dpi=72, ink_accurate=False)

    def has_partial(result):
        black = next(p for p in result["plates"] if p["name"] == "Black")
        raw = zlib.decompress(base64.b64decode(black["alpha_data"]))
        return any(0 < v < 255 for v in raw)

    assert has_partial(preview), "xem trước phải có pixel phủ một phần"
    assert not has_partial(ink), "đo mực phải nhị phân"


# ─────────────────────────────────────────────────────────────────────────────
#  Soft-proof — đường XEM, không phải đường ĐO
# ─────────────────────────────────────────────────────────────────────────────
#
# Cấu hình của soft-proof đối nghịch với đo mực ở hai điểm (khử răng cưa bật, mực pha
# quy về CMYK). Test ở đây chốt đúng hai điểm đó, vì nếu một ngày ai gộp hai đường
# thành một hàm thì cái mất là kẽm spot và độ chính xác của TAC.


def _solid_cmyk_pdf(tmp_path: Path) -> str:
    return _write(
        tmp_path, "sp_solid.pdf", _pdf(f"1 1 1 1 k 0 0 {PAGE} {PAGE} re f\n")
    )


def _spot_pdf(tmp_path: Path) -> str:
    """Trang chỉ dùng một mực pha, không có kênh process nào."""
    resources = (
        "/ColorSpace << /CS0 [/Separation /PANTONE#20485#20C /DeviceCMYK "
        "<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0.91 0.76 0] "
        "/N 1 /Range [0 1 0 1 0 1 0 1] >>] >>"
    )
    return _write(
        tmp_path,
        "sp_spot.pdf",
        _pdf(f"/CS0 cs 1 scn 0 0 {PAGE} {PAGE} re f\n", resources),
    )


def _overprint_pdf(tmp_path: Path) -> str:
    """Nền Cyan, chữ nhật K overprint: bật/tắt mô phỏng phải khác ảnh."""
    return _write(
        tmp_path,
        "sp_overprint.pdf",
        _pdf(
            "1 0 0 0 k 0 0 100 100 re f /GSop gs 0 0 0 1 k 0 0 100 100 re f",
            resources="/ExtGState << /GSop 5 0 R >>",
            extra_objects=[
                b"<< /Type /ExtGState /op true /OP true /OPM 1 >>",
            ],
        ),
    )


def test_softproof_returns_an_rgb_image_of_the_expected_size(tmp_path):
    r = softproof(_solid_cmyk_pdf(tmp_path), 1, dpi=36)
    assert r["width"] == 50 and r["height"] == 50
    assert len(bytes(r["rgb"])) == r["width"] * r["height"] * 3


def test_softproof_of_solid_cmyk_is_near_black(tmp_path):
    # 400% mực qua FOGRA39 phải ra gần đen trên màn hình. Nếu đường quy đổi bị đảo
    # chiều thì nó ra gần trắng — lỗi nhìn thấy ngay nhưng chỉ khi có test.
    r = softproof(_solid_cmyk_pdf(tmp_path), 1, dpi=36)
    rgb = bytes(r["rgb"])[:3]
    assert max(rgb) < 60, f"phải gần đen: {list(rgb)}"


def test_softproof_flattens_spot_ink_so_it_is_visible(tmp_path):
    """Trang chỉ dùng Pantone **không được** hiện ra trắng.

    Đây là khác biệt cốt lõi giữa hai đường: đường đo giữ mực pha ở kẽm riêng (bắt
    buộc, nếu không thì mất kẽm), còn màn hình không có mực pha nên đường xem phải
    quy nó về CMYK qua tint transform. Cài thiếu bước này cho ra một bản proof trắng
    tinh cho một trang in đầy màu.
    """
    r = softproof(_spot_pdf(tmp_path), 1, dpi=36)
    rgb = list(bytes(r["rgb"])[:3])
    assert rgb != [255, 255, 255], "mực pha phải hiện ra"
    # PANTONE 485 C là đỏ: kênh R phải trội hơn hẳn G và B.
    assert rgb[0] > rgb[1] + 60 and rgb[0] > rgb[2] + 60, f"phải là đỏ: {rgb}"


def test_measurement_path_still_keeps_the_spot_plate(tmp_path):
    # Bảo hiểm cho bất biến quan trọng nhất: cấu hình soft-proof KHÔNG được rò sang
    # đường đo. Nếu rò, kẽm Pantone biến mất mà báo cáo vẫn nói trang sạch.
    r = separations(_spot_pdf(tmp_path), 1, dpi=36, ink_accurate=True)
    names = [p["name"] for p in r["plates"]]
    assert "PANTONE 485 C" in names, names


def test_softproof_can_render_overprint_and_knockout_from_same_pdf(tmp_path):
    source = _overprint_pdf(tmp_path)
    simulated = softproof(source, 1, dpi=36, simulate_overprint=True)
    knockout = softproof(source, 1, dpi=36, simulate_overprint=False)
    assert simulated["width"] == knockout["width"]
    assert simulated["height"] == knockout["height"]
    assert bytes(simulated["rgb"]) != bytes(knockout["rgb"])


def test_softproof_without_a_usable_profile_raises(tmp_path):
    # Không có profile thì không có soft-proof. Trả về một ảnh đoán rồi gọi đó là
    # soft-proof là hứa một thứ không tồn tại.
    with pytest.raises(RuntimeError):
        softproof(_solid_cmyk_pdf(tmp_path), 1, dpi=36, cmyk_profile_id="khong-ton-tai")
