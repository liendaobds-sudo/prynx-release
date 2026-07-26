"""Kiểm tra lớp binding PPE (PrynX Print Engine) trong pdfcompare_native.

Test ở đây KHÔNG lặp lại phần prepress đã được `cargo test` phủ (trộn mực,
overprint, spot). Nó chỉ chứng minh ba điều thuộc trách nhiệm của lớp binding:

1. Contract trả về đúng dạng mà `separations.py` cần (plate `bytes`, 255 = đầy mực).
2. Cờ `degraded` nói thật — điều kiện để không bao giờ báo "sạch TAC" oan.
3. Lỗi được nâng thành exception Python thay vì trả buffer trắng im lặng.
"""

from pathlib import Path

import pytest

pdfcompare_native = pytest.importorskip(
    "pdfcompare_native",
    reason="cần build native: maturin develop --release --manifest-path native/Cargo.toml",
)

if not hasattr(pdfcompare_native, "ppe_separations"):
    pytest.skip("native chưa có PPE — cần rebuild", allow_module_level=True)

FIXTURES = Path(__file__).parent / "preflight_fixtures" / "pdfs"
TAC_HEAVY = FIXTURES / "17_tac_heavy_cmyk.pdf"
BLANK = FIXTURES / "01_clean_blank.pdf"
# Font thay thế do caller cấp (engine không hardcode đường dẫn assets).
FALLBACK_FONT = Path(__file__).parent.parent / "app" / "assets" / "fonts" / "DejaVuSans.ttf"


@pytest.fixture(scope="module")
def tac_result():
    if not TAC_HEAVY.is_file():
        pytest.skip(f"thiếu fixture {TAC_HEAVY}")
    return pdfcompare_native.ppe_separations(
        str(TAC_HEAVY), page=1, dpi=100.0, ink_accurate=True
    )


def test_returns_four_process_plates_in_fixed_order(tac_result):
    names = [p["name"] for p in tac_result["plates"]]
    assert names[:4] == ["Cyan", "Magenta", "Yellow", "Black"]


def test_plate_payload_matches_separations_contract(tac_result):
    """`ink` phải là bytes dài width*height — đúng thứ zlib+base64 ở lớp Python."""
    expected = tac_result["width"] * tac_result["height"]
    for plate in tac_result["plates"]:
        assert isinstance(plate["ink"], bytes)
        assert len(plate["ink"]) == expected, plate["name"]


def test_full_ink_is_255_not_inverted(tac_result):
    """255 = 100% mực.

    Ngược chiều là bug âm thầm chết người: TAC sẽ đọc thành 400% trên vùng
    TRẮNG và 0% trên vùng đặc.
    """
    assert max(tac_result["plates"][3]["ink"]) == 255


def test_solid_cmyk_measures_exactly_400_percent(tac_result):
    # Khớp đúng con số Ghostscript tiffsep trả về trên cùng fixture.
    assert abs(tac_result["max_tac_pct"] - 400.0) < 0.5


def test_ink_accurate_page_is_not_flagged_degraded(tac_result):
    """Trang CMYK vector thuần phải được coi là tin được.

    Nếu test này đỏ, nghĩa là engine đang tự hạ độ tin cậy quá tay và mọi báo cáo
    TAC sẽ mang cảnh báo vô nghĩa — người dùng sẽ học cách bỏ qua cảnh báo.

    Fixture này có một nhãn chữ dùng font không nhúng nhưng **không có `Tj` nào**
    dùng nó, nên không mất nội dung nào và đỉnh 400% là chắc. Một cờ gộp sẽ bật ở
    đây và làm hỏng chính mục đích của nó.
    """
    assert tac_result["ink_unsound"] is False
    assert tac_result["dropped_objects"] == 0


def test_blank_page_has_no_ink():
    if not BLANK.is_file():
        pytest.skip("thiếu fixture trang trắng")
    r = pdfcompare_native.ppe_separations(str(BLANK), page=1, dpi=72.0, ink_accurate=True)
    assert r["max_tac_pct"] == 0.0
    assert all(max(p["ink"]) == 0 for p in r["plates"])


def test_text_without_fallback_font_is_reported_not_silently_dropped():
    """Font KHÔNG nhúng + caller không cấp font thay ⇒ chữ không vẽ được, PHẢI khai.

    Đây là chiều sai nguy hiểm: trang toàn chữ mà báo 0% mực là báo **thiếu** mực.
    Nên `ink_unsound` phải bật để lớp trên không kết luận "đạt ngưỡng mực".
    """
    text_pdf = FIXTURES / "03_live_text.pdf"
    if not text_pdf.is_file():
        pytest.skip("thiếu fixture text")
    r = pdfcompare_native.ppe_separations(str(text_pdf), page=1, dpi=72.0, ink_accurate=True)
    assert r["ink_unsound"] is True
    assert r["dropped_objects"] > 0
    assert any("font không nhúng" in op["op"] for op in r["skipped_ops"])


def test_fallback_font_makes_text_paint_ink_but_flags_geometry_only():
    """Cấp font thay ⇒ chữ lên mực thật, và cờ phải nói đúng *kiểu* xấp xỉ.

    Hai trục tách nhau có lý do: hình glyph khác bản gốc nên **diện tích phủ** là
    xấp xỉ (`geometry_approximate`), nhưng lượng mực không còn bị hụt nên
    `ink_unsound` phải TẮT. Gộp hai thứ này vào một cờ sẽ khiến gần như mọi file
    xưởng thật bị hạ tin cậy và người dùng học cách bỏ qua cảnh báo.
    """
    text_pdf = FIXTURES / "03_live_text.pdf"
    if not text_pdf.is_file():
        pytest.skip("thiếu fixture text")
    if not FALLBACK_FONT.is_file():
        pytest.skip("thiếu DejaVuSans.ttf")
    r = pdfcompare_native.ppe_separations(
        str(text_pdf), page=1, dpi=72.0, ink_accurate=True, fallback_font=str(FALLBACK_FONT)
    )
    assert r["max_tac_pct"] > 0.0, "chữ phải lên mực khi đã có font thay"
    assert r["dropped_objects"] == 0
    assert r["ink_unsound"] is False
    assert r["geometry_approximate"] is True
    assert r["substituted_fonts"], "phải nêu tên font đã bị thay"


def test_missing_fallback_font_path_raises_instead_of_running_unsubstituted():
    """Đường dẫn font sai phải nổ, không được lặng lẽ chạy chế độ không-thay.

    Bỏ qua âm thầm sẽ cho ra trang chữ báo 0% mực mà caller vẫn tưởng đã cấp font.
    """
    if not BLANK.is_file():
        pytest.skip("thiếu fixture")
    with pytest.raises(RuntimeError):
        pdfcompare_native.ppe_separations(
            str(BLANK), page=1, dpi=72.0, fallback_font="khong_ton_tai.ttf"
        )


def test_dpi_controls_raster_size():
    if not BLANK.is_file():
        pytest.skip("thiếu fixture")
    low = pdfcompare_native.ppe_separations(str(BLANK), page=1, dpi=72.0)
    high = pdfcompare_native.ppe_separations(str(BLANK), page=1, dpi=144.0)
    assert high["width"] == pytest.approx(low["width"] * 2, abs=2)


def test_missing_file_raises_instead_of_returning_blank():
    with pytest.raises(RuntimeError):
        pdfcompare_native.ppe_separations("khong_ton_tai_12345.pdf", page=1, dpi=72.0)


def test_page_zero_is_rejected():
    if not BLANK.is_file():
        pytest.skip("thiếu fixture")
    with pytest.raises(ValueError):
        pdfcompare_native.ppe_separations(str(BLANK), page=0, dpi=72.0)


def test_out_of_range_page_raises():
    if not BLANK.is_file():
        pytest.skip("thiếu fixture")
    with pytest.raises(RuntimeError):
        pdfcompare_native.ppe_separations(str(BLANK), page=999, dpi=72.0)


def test_invalid_page_box_is_rejected():
    if not BLANK.is_file():
        pytest.skip("thiếu fixture")
    with pytest.raises(ValueError):
        pdfcompare_native.ppe_separations(str(BLANK), page=1, dpi=72.0, page_box="khong_hop_le")

def test_zero_memory_budget_is_rejected():
    if not BLANK.is_file():
        pytest.skip("missing fixture")
    with pytest.raises(ValueError, match="memory_budget_mb"):
        pdfcompare_native.ppe_separations(
            str(BLANK), page=1, dpi=72.0, memory_budget_mb=0
        )


def test_render_fails_loudly_when_memory_budget_is_exceeded():
    if not BLANK.is_file():
        pytest.skip("missing fixture")
    with pytest.raises(RuntimeError, match="MiB"):
        pdfcompare_native.ppe_separations(
            str(BLANK), page=1, dpi=100.0, memory_budget_mb=1
        )
    assert pdfcompare_native.ppe_capabilities()["memory_budget_default_mb"] == 512



ICC_DIR = Path(__file__).parent.parent / "app" / "assets" / "icc"
FOGRA39 = ICC_DIR / "FOGRA39.icc"
SRGB = ICC_DIR / "sRGB.icc"


def _needs_icc():
    if not FOGRA39.is_file():
        pytest.skip("thiếu FOGRA39.icc")


def test_icc_does_not_change_device_cmyk_ink():
    """Bất biến quan trọng nhất của quản lý màu trong PPE.

    Giá trị CMYK trong file CHÍNH LÀ lượng mực. Nếu nạp profile làm đổi con số
    này, một file 400% sẽ bị nén xuống ~292% và được báo là đạt ngưỡng 300% —
    kiểu sai đắt nhất trong xưởng in.
    """
    _needs_icc()
    if not TAC_HEAVY.is_file():
        pytest.skip("thiếu fixture TAC")
    plain = pdfcompare_native.ppe_separations(str(TAC_HEAVY), page=1, dpi=100.0, ink_accurate=True)
    managed = pdfcompare_native.ppe_separations(
        str(TAC_HEAVY), page=1, dpi=100.0, ink_accurate=True, cmyk_profile=str(FOGRA39)
    )
    assert abs(managed["max_tac_pct"] - 400.0) < 0.5
    assert managed["max_tac_pct"] == plain["max_tac_pct"]
    assert managed["color_managed"] is True


def test_icc_removes_approximation_flag_for_rgb():
    _needs_icc()
    img = FIXTURES / "09_high_dpi_image.pdf"
    if not img.is_file():
        pytest.skip("thiếu fixture ảnh RGB")
    plain = pdfcompare_native.ppe_separations(str(img), page=1, dpi=72.0, ink_accurate=True)
    managed = pdfcompare_native.ppe_separations(
        str(img),
        page=1,
        dpi=72.0,
        ink_accurate=True,
        cmyk_profile=str(FOGRA39),
        rgb_profile=str(SRGB) if SRGB.is_file() else None,
    )
    assert plain["ink_unsound"] is True
    # ICC khử hết xấp xỉ MÀU. Dùng `ink_unsound`, không dùng cờ gộp: cờ gộp còn
    # mang cả xấp xỉ hình học (font thay thế) — thứ ICC không liên quan.
    assert managed["ink_unsound"] is False, managed["approximated_colorspaces"]
    assert managed["approximated_colorspaces"] == []


def test_colorspaces_used_is_reported():
    """Lớp UI cần biết trang dùng họ colorspace nào để giải thích accuracy."""
    if not TAC_HEAVY.is_file():
        pytest.skip("thiếu fixture")
    r = pdfcompare_native.ppe_separations(str(TAC_HEAVY), page=1, dpi=72.0, ink_accurate=True)
    assert "DeviceCMYK" in r["colorspaces_used"]


def test_invalid_icc_path_raises():
    """Profile sai đường dẫn phải nổ, không được lặng lẽ chạy không-ICC.

    Nếu bỏ qua âm thầm, người dùng tưởng đang xem kẽm color-managed trong khi
    thực tế là công thức xấp xỉ.
    """
    with pytest.raises(RuntimeError):
        pdfcompare_native.ppe_separations(
            str(BLANK), page=1, dpi=72.0, cmyk_profile="khong_ton_tai.icc"
        )


def test_render_intent_is_accepted_and_changes_result():
    """Intent phải thực sự đi vào phép biến đổi, không bị bỏ qua."""
    _needs_icc()
    img = FIXTURES / "09_high_dpi_image.pdf"
    if not img.is_file():
        pytest.skip("thiếu fixture ảnh RGB")
    rel = pdfcompare_native.ppe_separations(
        str(img), page=1, dpi=72.0, ink_accurate=True, cmyk_profile=str(FOGRA39), render_intent=1
    )
    sat = pdfcompare_native.ppe_separations(
        str(img), page=1, dpi=72.0, ink_accurate=True, cmyk_profile=str(FOGRA39), render_intent=2
    )
    assert rel["max_tac_pct"] != sat["max_tac_pct"]


def test_capabilities_do_not_overclaim():
    """Capability matrix phải nói đúng những gì CHƯA làm được.

    Đây là hợp đồng với lớp UI: badge engine dựa vào đây. Khai khống một tính
    năng chưa xong sẽ khiến người dùng chốt kẽm trên dữ liệu sai.
    """
    caps = pdfcompare_native.ppe_capabilities()
    assert caps["process_separations"] is True
    assert caps["spot_separations"] is True
    assert caps["overprint"] is True
    assert caps["tac"] is True
    assert caps["images"] is True
    assert caps["icc_color_management"] is True
    # ICC chỉ áp cho nội dung chưa phải mực — khai rõ để lớp trên không hiểu sai.
    assert "DeviceRGB" in caps["icc_applies_to"]
    assert "DeviceCMYK" in caps["icc_never_applies_to"]
    # Text đã vẽ được (Type1/CFF/TrueType/Type0-CID/Type3).
    assert caps["text"] is True
    # Nhưng font KHÔNG nhúng chỉ vẽ được khi caller cấp asset — khai rõ để lớp
    # trên biết vì sao một trang chữ có thể vẫn báo thiếu mực.
    assert caps["text_substitute_font_requires_caller_asset"] is True
    # Đã xong sau Milestone H: ảnh nội tuyến, tiling pattern, lưới shading 4–7,
    # optional content, CCITT.
    assert caps["inline_images"] is True
    assert caps["optional_content"] is True
    assert caps["tiling_pattern"] is True
    # `/OC` được đọc theo cấu hình **in**, không theo cấu hình xem: một lớp hiện trên
    # màn hình nhưng khai `/PrintState /OFF` thì tuyệt đối không được tính mực.
    assert caps["optional_content_config"] == "print"
    # Còn thiếu — và mỗi khoảng trống khai riêng, không gộp vào một cờ.
    assert caps["transparency_knockout_groups"] is False
    assert set(caps["image_filters_missing"]) == {"JPXDecode", "JBIG2Decode"}


def test_softproof_is_declared_as_a_view_path_not_a_measurement_path():
    """Soft-proof có cấu hình **đối nghịch** với đo mực, nên phải khai riêng.

    Nó khử răng cưa và quy mực pha về CMYK — hai điều mà đường đo tuyệt đối không
    được làm. Nếu lớp trên tưởng đây cũng là một chế độ của tách kẽm, nó sẽ kết luận
    lượng mực trên một ảnh đã bị làm mượt cạnh và đã mất kẽm spot.
    """
    caps = pdfcompare_native.ppe_capabilities()
    assert caps["softproof"] is True
    assert caps["softproof_requires_icc"] is True
    assert hasattr(pdfcompare_native, "ppe_softproof")


def test_transparency_gaps_are_declared_separately():
    """`transparency_groups = True` KHÔNG được hiểu là mọi group đều đo đúng.

    Ba đường group đã dựng (đục / không cách ly / cách ly) nhưng **knockout group**
    thì chưa: trong knockout, mỗi phần tử composite với nền ban đầu của group chứ
    không với phần tử vẽ trước nó, nên vùng chồng lấn của engine sẽ đọc ra nhiều
    mực hơn thực tế. Gộp một cờ sẽ che mất đúng chỗ đó.

    Tương tự với blend mode: mười một mode tách kênh đúng tuyệt đối kể cả trên kẽm
    spot; bốn mode không tách kênh (Hue/Saturation/Color/Luminosity) phải đi qua
    xấp xỉ RGB và không chạm kênh spot.
    """
    caps = pdfcompare_native.ppe_capabilities()
    assert caps["transparency_groups"] is True
    assert caps["transparency_knockout_groups"] is False
    assert caps["soft_mask"] is True
    assert set(caps["soft_mask_types"]) == {"Luminosity", "Alpha"}
    assert caps["blend_modes"] is True
    separable = set(caps["blend_modes_separable"])
    approximated = set(caps["blend_modes_approximated"])
    assert "Multiply" in separable
    assert approximated == {"Hue", "Saturation", "Color", "Luminosity"}
    assert not (separable & approximated), "một mode không thể vừa đúng vừa xấp xỉ"


def test_shading_type_gaps_are_declared_separately():
    """`shading = True` KHÔNG được hiểu là mọi gradient đều đo được.

    Kiểu 1/2/3 đã dựng; lưới Gouraud/Coons/tensor (4–7) thì chưa. Gộp thành một cờ
    sẽ khiến lớp trên tin rằng một trang dùng lưới Coons đã được vẽ, trong khi thực
    tế nó bị bỏ và báo cáo TAC của trang đó vô nghĩa.
    """
    caps = pdfcompare_native.ppe_capabilities()
    assert caps["shading"] is True
    assert set(caps["shading_types"]) == {1, 2, 3, 4, 5, 6, 7}
    assert caps["shading_types_missing"] == []
    assert caps["shading_pattern"] is True
    # Tiling pattern vẽ thật (lặp ô mẫu) nhưng có **trần số ô**: vượt trần thì báo
    # thiếu tính năng chứ không vẽ một phần — vẽ một phần cho lượng mực thấp hơn
    # thực tế, đúng chiều sai nguy hiểm.
    assert caps["tiling_pattern"] is True
    assert caps["tiling_pattern_max_tiles"] > 0


def test_image_codec_gaps_are_declared_separately():
    """`images = True` KHÔNG được hiểu là mọi ảnh đều đọc được.

    Nếu gộp chung, lớp trên sẽ tin rằng một trang ảnh JPEG 2000 đã được vẽ trong
    khi thực tế nó bị bỏ — và báo cáo TAC của trang đó là vô nghĩa.
    """
    caps = pdfcompare_native.ppe_capabilities()
    assert "DCTDecode" in caps["image_filters"]
    assert "FlateDecode" in caps["image_filters"]
    # CCITT (ảnh scan đen trắng) đã dựng ở Milestone H; JPX và JBIG2 thì chưa.
    assert "CCITTFaxDecode" in caps["image_filters"]
    assert "JPXDecode" in caps["image_filters_missing"]
    assert "JBIG2Decode" in caps["image_filters_missing"]
    assert not set(caps["image_filters"]) & set(caps["image_filters_missing"])


def test_image_page_now_renders_ink():
    """Ảnh phải thực sự lên mực — trước milestone này trang ảnh ra trắng."""
    img_pdf = FIXTURES / "09_high_dpi_image.pdf"
    if not img_pdf.is_file():
        pytest.skip("thiếu fixture ảnh")
    r = pdfcompare_native.ppe_separations(str(img_pdf), page=1, dpi=100.0, ink_accurate=True)
    assert r["max_tac_pct"] > 50.0, "trang ảnh không được ra trắng"
    assert r["dropped_objects"] == 0, "ảnh phải được vẽ, không bị bỏ"


def test_rgb_image_is_flagged_as_approximate_colorspace():
    """Ảnh RGB không có ICC ⇒ phải khai là xấp xỉ.

    Đây là điều kiện để lớp Python không gắn nhãn `rip_separations` cho một
    trang mà lượng mực còn phụ thuộc phép quy đổi tuỳ tiện.
    """
    img_pdf = FIXTURES / "09_high_dpi_image.pdf"
    if not img_pdf.is_file():
        pytest.skip("thiếu fixture ảnh")
    r = pdfcompare_native.ppe_separations(str(img_pdf), page=1, dpi=72.0, ink_accurate=True)
    assert r["degraded"] is True
    assert any("RGB" in cs for cs in r["approximated_colorspaces"]), r["approximated_colorspaces"]
