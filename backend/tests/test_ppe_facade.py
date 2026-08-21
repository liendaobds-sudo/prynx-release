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
import pikepdf

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
from app.core.print_engine.facade import (  # noqa: E402
    PpeRequestSuperseded,
    PpeSoftproofSession,
    PpeUnavailable,
    _auto_session_cache_budget_mb,
    compose_separation_subset,
    open_softproof_session,
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
    assert caps["separation_subset_composite"] is True
    assert caps["icc_color_management"] is True
    assert caps["softproof_viewport_clip"] is True
    assert caps["render_session"] is True
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
    # COLOR (audit 2026-08-20 §COLOR.26): caller cần bằng chứng native đã
    # dùng CMM; thiếu field không được suy diễn từ tên profile.
    assert r["color_managed"] is True


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


def _session_image_pdf(tmp_path: Path, name: str = "session_image.pdf") -> str:
    """Ảnh indirect tối giản để cache hit đo được qua DPI/viewport khác nhau."""
    image = (
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 "
        b"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\n"
        b"stream\n\xff\x00\x00\nendstream"
    )
    return _write(
        tmp_path,
        name,
        _pdf(
            f"q {PAGE} 0 0 {PAGE} 0 0 cm /Im0 Do Q",
            resources="/XObject << /Im0 5 0 R >>",
            extra_objects=[image],
        ),
    )


def test_softproof_returns_an_rgb_image_of_the_expected_size(tmp_path):
    r = softproof(_solid_cmyk_pdf(tmp_path), 1, dpi=36)
    assert r["width"] == 50 and r["height"] == 50
    assert len(bytes(r["rgb"])) == r["width"] * r["height"] * 3


def test_softproof_viewport_clip_tra_dung_kich_thuoc(tmp_path):
    r = softproof(_solid_cmyk_pdf(tmp_path), 1, dpi=36, clip=(5, 7, 11, 13))
    assert (r["width"], r["height"]) == (11, 13)
    assert len(bytes(r["rgb"])) == 11 * 13 * 3


def test_softproof_viewport_clip_tu_choi_hinh_hoc_sai(tmp_path):
    source = _solid_cmyk_pdf(tmp_path)
    with pytest.raises(ValueError, match="clip PPE"):
        softproof(source, 1, dpi=36, clip=(-1, 0, 10, 10))


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


# ─────────────────────────────────────────────────────────────────────────────
#  RenderSession PyO3/backend — Lô 2B
# ─────────────────────────────────────────────────────────────────────────────


def test_session_cache_hit_qua_dpi_va_viewport(tmp_path):
    source = _session_image_pdf(tmp_path)
    session = open_softproof_session(
        source,
        owner_id="tab-a",
        resource_cache_budget_mb=4,
    )
    assert session.uses_native_session is True
    request_identity = {
        "pdf_path": source,
        "cmyk_profile_id": "fogra39",
        "render_intent": 1,
    }
    try:
        first = session.render(
            owner_id="tab-a",
            request_generation=1,
            page_num=1,
            dpi=24,
            **request_identity,
        )
        zoomed = session.render(
            owner_id="tab-a",
            request_generation=2,
            page_num=1,
            dpi=36,
            **request_identity,
        )
        viewport = session.render(
            owner_id="tab-a",
            request_generation=3,
            page_num=1,
            dpi=36,
            clip=(3, 5, 11, 13),
            **request_identity,
        )

        assert zoomed["resource_cache_hit"] is True
        assert viewport["resource_cache_hit"] is True
        assert zoomed["cache"]["image_hits"] > first["cache"]["image_hits"]
        assert zoomed["cache"]["image_misses"] == first["cache"]["image_misses"]
        assert viewport["cache"]["image_misses"] == first["cache"]["image_misses"]
        assert (viewport["width"], viewport["height"]) == (11, 13)
        assert set(("open", "parse", "resource", "raster", "color", "encode")) <= set(
            viewport["timings_ms"]
        )
        assert session.open_info["open_timings_ms"]["parse"] >= 0.0
    finally:
        session.close("tab-a")


def test_session_owner_generation_cancel_va_close_duoc_chan(tmp_path):
    source = _solid_cmyk_pdf(tmp_path)
    session = open_softproof_session(
        source,
        owner_id="tab-owner",
        resource_cache_budget_mb=1,
    )
    request_identity = {
        "pdf_path": source,
        "cmyk_profile_id": "fogra39",
        "render_intent": 1,
    }
    try:
        with pytest.raises(ValueError, match="owner_id"):
            session.info("tab-khac")
        with pytest.raises(ValueError, match="owner_id"):
            session.cancel("tab-khac", 1)
        with pytest.raises(ValueError, match="owner_id"):
            session.close("tab-khac")
        with pytest.raises(ValueError, match="owner_id"):
            session.render(
                owner_id="tab-khac",
                request_generation=1,
                page_num=1,
                dpi=24,
                **request_identity,
            )

        session.cancel("tab-owner", 1)
        with pytest.raises(PpeRequestSuperseded):
            session.render(
                owner_id="tab-owner",
                request_generation=1,
                page_num=1,
                dpi=24,
                **request_identity,
            )
        rendered = session.render(
            owner_id="tab-owner",
            request_generation=2,
            page_num=1,
            dpi=24,
            **request_identity,
        )
        assert rendered["request_generation"] == 2
        with pytest.raises(PpeRequestSuperseded):
            session.render(
                owner_id="tab-owner",
                request_generation=2,
                page_num=1,
                dpi=36,
                **request_identity,
            )
    finally:
        assert session.close("tab-owner") is True

    with pytest.raises(PpeRequestSuperseded):
        session.render(
            owner_id="tab-owner",
            request_generation=3,
            page_num=1,
            dpi=24,
            **request_identity,
        )


def test_native_session_tu_chan_owner_va_generation_trung(tmp_path):
    from app.core.icc_profiles import (
        resolve_cmyk_profile_path,
        resolve_srgb_profile_path,
    )

    native_session = pdfcompare_native.PpeRenderSession(
        _solid_cmyk_pdf(tmp_path),
        "native-owner",
        resolve_cmyk_profile_path("fogra39"),
        rgb_profile=resolve_srgb_profile_path(),
        resource_cache_budget_mb=1,
    )
    with pytest.raises(ValueError, match="owner_id"):
        native_session.info("tab-khac")
    native_session.cancel("native-owner", 1)
    with pytest.raises(RuntimeError, match="PPE_STALE_REQUEST"):
        native_session.render_softproof(
            "native-owner", 1, page=1, dpi=24, memory_budget_mb=64
        )
    rendered = native_session.render_softproof(
        "native-owner", 2, page=1, dpi=24, memory_budget_mb=64
    )
    assert rendered["request_generation"] == 2
    with pytest.raises(RuntimeError, match="PPE_STALE_REQUEST"):
        native_session.render_softproof(
            "native-owner", 2, page=1, dpi=24, memory_budget_mb=64
        )
    assert native_session.close("native-owner") is True


def test_session_save_over_tang_generation_va_khong_tra_pixel_cu(tmp_path):
    source = Path(_solid_cmyk_pdf(tmp_path))
    session = open_softproof_session(
        str(source), owner_id="tab-save", resource_cache_budget_mb=1
    )
    try:
        before = session.render(
            owner_id="tab-save",
            request_generation=1,
            pdf_path=str(source),
            cmyk_profile_id="fogra39",
            render_intent=1,
            page_num=1,
            dpi=24,
        )
        source.write_bytes(_pdf(f"0 0 0 0 k 0 0 {PAGE} {PAGE} re f"))
        after = session.render(
            owner_id="tab-save",
            request_generation=2,
            pdf_path=str(source),
            cmyk_profile_id="fogra39",
            render_intent=1,
            page_num=1,
            dpi=24,
        )
        assert after["session_generation"] > before["session_generation"]
        assert bytes(after["rgb"]) != bytes(before["rgb"])
    finally:
        session.close("tab-save")


def test_session_stateless_fallback_giu_tuong_thich_build_cu(monkeypatch, tmp_path):
    import app.core.print_engine.facade as facade

    class OldNative:
        ppe_separations = object()

        @staticmethod
        def ppe_softproof(_path, **_kwargs):
            return {
                "width": 1,
                "height": 1,
                "rgb": bytes((10, 20, 30)),
                "degraded": False,
                "ink_unsound": False,
            }

    monkeypatch.setattr(facade, "_native", lambda: OldNative())
    source = _solid_cmyk_pdf(tmp_path)
    session = open_softproof_session(
        source, owner_id="tab-old", resource_cache_budget_mb=1
    )
    try:
        assert session.uses_native_session is False
        result = session.render(
            owner_id="tab-old",
            request_generation=1,
            pdf_path=source,
            cmyk_profile_id="fogra39",
            render_intent=1,
            page_num=1,
            dpi=24,
        )
        assert result["session_mode"] == "stateless_fallback"
        assert bytes(result["rgb"]) == bytes((10, 20, 30))
    finally:
        session.close("tab-old")


def test_softproof_truyen_show_paper_black_background_vao_native(monkeypatch, tmp_path):
    import app.core.print_engine.facade as facade

    captured = {}

    class NewNative:
        ppe_separations = object()

        @staticmethod
        def ppe_capabilities():
            return {
                "output_preview_filters": ["all", "text"],
                "softproof_paper_color": True,
                "softproof_black_ink": True,
                "softproof_page_background": True,
            }

        @staticmethod
        def ppe_softproof(_path, **kwargs):
            captured.update(kwargs)
            return {
                "width": 1,
                "height": 1,
                "rgb": bytes((10, 20, 30)),
                "degraded": False,
                "ink_unsound": False,
            }

    monkeypatch.setattr(facade, "_native", lambda: NewNative())
    result = facade.softproof(
        _solid_cmyk_pdf(tmp_path),
        1,
        dpi=24,
        output_preview_filter="text",
        simulate_paper_color=True,
        simulate_black_ink=True,
        page_background_rgb=(214, 190, 142),
    )
    assert bytes(result["rgb"]) == bytes((10, 20, 30))
    assert captured["output_preview_filter"] == "text"
    assert captured["simulate_paper_color"] is True
    assert captured["simulate_black_ink"] is True
    assert captured["page_background_rgb"] == (214, 190, 142)


def test_softproof_mac_dinh_khong_doi_hop_dong_native_cu(monkeypatch, tmp_path):
    """`all/false/false/None` không hỏi capability hay gửi keyword Lô G.

    Đây là chốt chống trạng thái Output Preview rò sang Viewer/consumer cũ. Native
    trước Lô G vẫn phải chạy lời gọi mặc định; chỉ lựa chọn mới mới được fail-loud.
    """
    import app.core.print_engine.facade as facade

    captured = {}

    class OldNative:
        ppe_separations = object()

        @staticmethod
        def ppe_capabilities():
            pytest.fail("lời gọi mặc định không được đòi capability Output Preview")

        @staticmethod
        def ppe_softproof(_path, **kwargs):
            captured.update(kwargs)
            return {
                "width": 1,
                "height": 1,
                "rgb": bytes((10, 20, 30)),
                "degraded": False,
                "ink_unsound": False,
            }

    monkeypatch.setattr(facade, "_native", lambda: OldNative())
    result = facade.softproof(_solid_cmyk_pdf(tmp_path), 1, dpi=24)

    assert bytes(result["rgb"]) == bytes((10, 20, 30))
    assert {
        "output_preview_filter",
        "simulate_paper_color",
        "simulate_black_ink",
        "page_background_rgb",
    }.isdisjoint(captured)


def test_softproof_preview_contract_fail_loud_tren_build_cu(monkeypatch, tmp_path):
    import app.core.print_engine.facade as facade

    class OldNative:
        ppe_separations = object()

        @staticmethod
        def ppe_capabilities():
            return {}

        @staticmethod
        def ppe_softproof(_path, **_kwargs):
            pytest.fail("build cũ không được nhận request đã gắn Show")

    monkeypatch.setattr(facade, "_native", lambda: OldNative())
    with pytest.raises(PpeUnavailable, match="Show=text"):
        facade.softproof(
            _solid_cmyk_pdf(tmp_path),
            1,
            output_preview_filter="text",
        )
    with pytest.raises(ValueError, match="ba số nguyên"):
        facade.softproof(
            _solid_cmyk_pdf(tmp_path),
            1,
            page_background_rgb=(1, 2, 999),
        )


def _fake_separation_result():
    return {
        "width": 1,
        "height": 1,
        "plates": [
            {
                "name": "Cyan",
                "ink": bytes((255,)),
                "is_spot": False,
                "coverage_pct": 100.0,
            }
        ],
        "max_tac_pct": 100.0,
        "ink_unsound": False,
        "geometry_approximate": False,
    }


def test_separations_truyen_show_vao_native_co_capability(monkeypatch, tmp_path):
    import app.core.print_engine.facade as facade

    captured = {}

    class NewNative:
        @staticmethod
        def ppe_capabilities():
            return {
                "output_preview_filters": ["all", "device-rgb"],
                "separations_output_preview_filter": True,
            }

        @staticmethod
        def ppe_separations(_path, **kwargs):
            captured.update(kwargs)
            return _fake_separation_result()

    monkeypatch.setattr(facade, "_native", lambda: NewNative())
    result = facade.separations(
        _solid_cmyk_pdf(tmp_path),
        1,
        dpi=24,
        ink_accurate=True,
        cmyk_profile_id=None,
        output_preview_filter="device-rgb",
    )

    assert result["max_tac_pct"] == 100.0
    assert captured["output_preview_filter"] == "device-rgb"


def test_separations_mac_dinh_khong_doi_hop_dong_native_cu(monkeypatch, tmp_path):
    import app.core.print_engine.facade as facade

    captured = {}

    class OldNative:
        @staticmethod
        def ppe_capabilities():
            pytest.fail("Show=All không được đòi capability mới")

        @staticmethod
        def ppe_separations(_path, **kwargs):
            captured.update(kwargs)
            return _fake_separation_result()

    monkeypatch.setattr(facade, "_native", lambda: OldNative())
    facade.separations(
        _solid_cmyk_pdf(tmp_path),
        1,
        dpi=24,
        ink_accurate=True,
        cmyk_profile_id=None,
    )

    assert "output_preview_filter" not in captured


def test_separations_show_fail_loud_tren_native_cu(monkeypatch, tmp_path):
    import app.core.print_engine.facade as facade

    class OldNative:
        @staticmethod
        def ppe_capabilities():
            return {"output_preview_filters": ["all", "device-rgb"]}

        @staticmethod
        def ppe_separations(_path, **_kwargs):
            pytest.fail("native cũ không được nhận request lọc plate")

    monkeypatch.setattr(facade, "_native", lambda: OldNative())
    with pytest.raises(PpeUnavailable, match="Show=device-rgb"):
        facade.separations(
            _solid_cmyk_pdf(tmp_path),
            1,
            dpi=24,
            ink_accurate=True,
            cmyk_profile_id=None,
            output_preview_filter="device-rgb",
        )


@pytest.mark.asyncio
async def test_separation_engine_khong_fallback_unfiltered_khi_show_fail(
    monkeypatch, tmp_path
):
    import app.core.print_engine.facade as facade
    from app.core.separations import SeparationEngine

    def old_native(*_args, **_kwargs):
        raise PpeUnavailable("native cũ chưa lọc được plate")

    monkeypatch.setattr(facade, "separations", old_native)
    with pytest.raises(PpeUnavailable, match="native cũ"):
        await SeparationEngine().extract_separations(
            _solid_cmyk_pdf(tmp_path),
            1,
            dpi=24,
            output_preview_filter="device-rgb",
        )


def test_session_bi_vo_hieu_hoa_chuyen_stateless_o_request_sau(monkeypatch, tmp_path):
    import app.core.print_engine.facade as facade

    class InvalidatedNativeSession:
        def render_softproof(self, *_args, **_kwargs):
            raise RuntimeError("PPE: RenderSession đã bị vô hiệu hóa")

        def close(self, *_args):
            return True

    class StatelessNative:
        ppe_separations = object()

        @staticmethod
        def ppe_softproof(_path, **_kwargs):
            return {
                "width": 1,
                "height": 1,
                "rgb": bytes((1, 2, 3)),
                "degraded": False,
                "ink_unsound": False,
            }

    monkeypatch.setattr(facade, "_native", lambda: StatelessNative())
    source = _solid_cmyk_pdf(tmp_path)
    session = PpeSoftproofSession(
        pdf_path=source,
        owner_id="tab-recover",
        cmyk_profile_id="fogra39",
        render_intent=1,
        native_session=InvalidatedNativeSession(),
        open_info={"valid": True},
    )
    with pytest.raises(RuntimeError, match="vô hiệu hóa"):
        session.render(
            owner_id="tab-recover",
            request_generation=1,
            pdf_path=source,
            cmyk_profile_id="fogra39",
            render_intent=1,
            page_num=1,
            dpi=24,
        )
    recovered = session.render(
        owner_id="tab-recover",
        request_generation=2,
        pdf_path=source,
        cmyk_profile_id="fogra39",
        render_intent=1,
        page_num=1,
        dpi=24,
    )
    assert recovered["session_mode"] == "stateless_fallback"
    assert bytes(recovered["rgb"]) == bytes((1, 2, 3))
    session.close("tab-recover")


def test_session_tu_choi_sai_tai_lieu_profile_va_intent(tmp_path):
    source = _solid_cmyk_pdf(tmp_path)
    other = _write(tmp_path, "other-session.pdf", _pdf("0 0 0 0 k 0 0 10 10 re f"))
    session = open_softproof_session(
        source,
        owner_id="tab-identity",
        resource_cache_budget_mb=1,
    )
    base = {
        "owner_id": "tab-identity",
        "request_generation": 1,
        "pdf_path": source,
        "cmyk_profile_id": "fogra39",
        "render_intent": 1,
        "page_num": 1,
        "dpi": 24,
    }
    try:
        with pytest.raises(ValueError, match="tài liệu"):
            session.render(**{**base, "pdf_path": other})
        with pytest.raises(ValueError, match="profile"):
            session.render(**{**base, "cmyk_profile_id": "swop"})
        with pytest.raises(ValueError, match="intent"):
            session.render(**{**base, "render_intent": 0})

        # Ba request sai không được tiêu thụ generation hợp lệ đầu tiên.
        assert session.render(**base)["request_generation"] == 1
    finally:
        session.close("tab-identity")


def test_session_close_dang_render_duoc_phan_loai_la_response_cu(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    import threading

    source = _solid_cmyk_pdf(tmp_path)
    started = threading.Event()
    released = threading.Event()

    class ClosingNativeSession:
        def __init__(self):
            self.closed = False

        def render_softproof(self, *_args, **_kwargs):
            started.set()
            assert released.wait(timeout=3.0)
            if self.closed:
                raise RuntimeError("PPE RenderSession đã đóng")
            return {
                "width": 1,
                "height": 1,
                "rgb": bytes((1, 2, 3)),
                "degraded": False,
                "ink_unsound": False,
            }

        def close(self, *_args):
            self.closed = True
            released.set()
            return True

    session = PpeSoftproofSession(
        pdf_path=source,
        owner_id="tab-close-race",
        cmyk_profile_id="fogra39",
        render_intent=1,
        native_session=ClosingNativeSession(),
        open_info={"valid": True},
    )
    request = {
        "owner_id": "tab-close-race",
        "request_generation": 1,
        "pdf_path": source,
        "cmyk_profile_id": "fogra39",
        "render_intent": 1,
        "page_num": 1,
        "dpi": 24,
    }
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(session.render, **request)
        assert started.wait(timeout=3.0)
        assert session.close("tab-close-race") is True
        with pytest.raises(PpeRequestSuperseded):
            future.result(timeout=3.0)


def test_session_cache_budget_ram_gate_khong_hard_cap_may_manh():
    assert _auto_session_cache_budget_mb(6 * 1024, 4 * 1024) <= 96
    assert _auto_session_cache_budget_mb(12 * 1024, 8 * 1024) <= 256
    strong_16 = _auto_session_cache_budget_mb(32 * 1024, 16 * 1024)
    strong_32 = _auto_session_cache_budget_mb(64 * 1024, 32 * 1024)
    assert strong_32 > strong_16 >= 256


# ─────────────────────────────────────────────────────────────────────────────
#  Output Preview inventory/metadata — audit 2026-08-10 §OP.2/4/5
# ─────────────────────────────────────────────────────────────────────────────


def _separation_color_space(name: str, cmyk: list[float]) -> pikepdf.Array:
    return pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name(f"/{name}"),
        pikepdf.Name("/DeviceCMYK"),
        pikepdf.Dictionary({
            "/FunctionType": 2,
            "/Domain": pikepdf.Array([0, 1]),
            "/C0": pikepdf.Array([0, 0, 0, 0]),
            "/C1": pikepdf.Array(cmyk),
            "/N": 1,
        }),
    ])


def _multipage_nested_spot_pdf(tmp_path: Path) -> str:
    output = tmp_path / "output_preview_inventory.pdf"
    pdf = pikepdf.Pdf.new()

    page_one = pdf.add_blank_page(page_size=(PAGE, PAGE))
    page_one.obj["/Group"] = pikepdf.Dictionary({
        "/S": pikepdf.Name("/Transparency"),
        "/CS": pikepdf.Name("/DeviceCMYK"),
    })
    page_one.obj["/Resources"] = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({
            "/CSBrand": _separation_color_space("Brand Blue", [1, 0.45, 0, 0.3]),
        }),
    })
    page_one.obj["/Contents"] = pdf.make_stream(
        b"/CSBrand cs 1 scn 0 0 50 50 re f"
    )

    page_two = pdf.add_blank_page(page_size=(PAGE, PAGE))
    cut_form = pdf.make_stream(b"/CSCut cs 1 scn 10 10 80 80 re f")
    cut_form["/Type"] = pikepdf.Name("/XObject")
    cut_form["/Subtype"] = pikepdf.Name("/Form")
    cut_form["/BBox"] = pikepdf.Array([0, 0, PAGE, PAGE])
    cut_form["/Resources"] = pikepdf.Dictionary({
        "/ColorSpace": pikepdf.Dictionary({
            "/CSCut": _separation_color_space("khuon be", [0.65, 0, 1, 0]),
        }),
    })
    page_two.obj["/Resources"] = pikepdf.Dictionary({
        "/XObject": pikepdf.Dictionary({"/FmCut": cut_form}),
    })
    page_two.obj["/Contents"] = pdf.make_stream(b"q /FmCut Do Q")
    pdf.save(output)
    pdf.close()
    return str(output)


def test_inventory_di_qua_form_va_doc_tint_transform(tmp_path):
    from app.core.ink_manager import (
        InkManagerEngine,
        analyze_ink_inventory,
        colorant_rgb_map,
    )

    source = _multipage_nested_spot_pdf(tmp_path)
    inventory = analyze_ink_inventory(source)
    spots = {
        item["name"]: item
        for item in inventory["document_colorants"]
        if item["is_spot"]
    }

    assert list(spots) == ["Brand Blue", "khuon be"]
    assert spots["Brand Blue"]["pages"] == [1]
    assert spots["Brand Blue"]["alternate_cmyk"] == [100.0, 45.0, 0.0, 30.0]
    assert spots["khuon be"]["pages"] == [2]
    assert spots["khuon be"]["alternate_cmyk"] == [65.0, 0.0, 100.0, 0.0]
    assert inventory["pages"][0]["page_has_transparency"] is True
    assert inventory["pages"][0]["blending_color_space"] == "DeviceCMYK"
    assert inventory["pages"][1]["spot_colorants"] == ["khuon be"]

    rgb = colorant_rgb_map(inventory["document_colorants"], "fogra39")
    assert rgb["Brand Blue"]["source"] == "tint_transform_icc"
    assert rgb["Brand Blue"]["rgb"][2] > rgb["Brand Blue"]["rgb"][0]
    assert rgb["khuon be"]["rgb"][1] > rgb["khuon be"]["rgb"][0]

    inks = {item["name"]: item for item in InkManagerEngine().list_inks(source)}
    assert inks["Brand Blue"]["cmyk"] == [100.0, 45.0, 0.0, 30.0]
    assert inks["khuon be"]["pages"] == [2]


def test_spot_swatch_dung_rendering_intent_da_chon(monkeypatch):
    from PIL import ImageCms
    from app.core.ink_manager import colorant_rgb_map

    captured: list[int] = []
    real_builder = ImageCms.buildTransformFromOpenProfiles

    def capture_intent(*args, **kwargs):
        captured.append(int(kwargs["renderingIntent"]))
        return real_builder(*args, **kwargs)

    monkeypatch.setattr(ImageCms, "buildTransformFromOpenProfiles", capture_intent)
    result = colorant_rgb_map(
        [{
            "name": "Brand Blue",
            "is_spot": True,
            "alternate_cmyk": [100.0, 45.0, 0.0, 30.0],
        }],
        "fogra39",
        rendering_intent="perceptual",
    )

    assert result["Brand Blue"]["source"] == "tint_transform_icc"
    assert captured == [int(ImageCms.Intent.PERCEPTUAL)]


def test_facade_giu_inventory_metadata_coverage_va_mau_spot(tmp_path):
    source = _multipage_nested_spot_pdf(tmp_path)
    result = separations(source, 1, dpi=36, cmyk_profile_id="fogra39")
    plate_by_name = {item["name"]: item for item in result["plates"]}
    spot_by_name = {item["name"]: item for item in result["spot_inks"]}

    assert [item["name"] for item in result["document_colorants"]] == [
        "Cyan", "Magenta", "Yellow", "Black", "Brand Blue", "khuon be",
    ]
    assert result["page_spot_colorants"] == ["Brand Blue"]
    assert result["page_has_transparency"] is True
    assert result["blending_color_space"] == "DeviceCMYK"
    assert plate_by_name["Brand Blue"]["coverage_pct"] > 20
    assert plate_by_name["Brand Blue"]["color_source"] == "tint_transform_icc"
    assert spot_by_name["khuon be"]["present_on_page"] is False
    assert spot_by_name["khuon be"]["coverage_pct"] == 0


def test_subset_composite_khop_softproof_va_giu_lut_spot(tmp_path):
    source = _multipage_nested_spot_pdf(tmp_path)
    separated = separations(source, 1, dpi=36, cmyk_profile_id="fogra39")
    brand = next(plate for plate in separated["plates"] if plate["name"] == "Brand Blue")

    assert len(brand["alternate_cmyk_lut"]) == 33
    assert brand["alternate_cmyk_lut"][0] == pytest.approx([0, 0, 0, 0], abs=1e-6)
    assert brand["alternate_cmyk_lut"][-1] == pytest.approx(
        [1, 0.45, 0, 0.3], abs=1e-5
    )

    all_names = [plate["name"] for plate in separated["plates"]]
    composite = compose_separation_subset(
        width=separated["width"],
        height=separated["height"],
        plates=separated["plates"],
        enabled_names=all_names,
        cmyk_profile_id="fogra39",
        render_intent=1,
    )
    proof = softproof(
        source,
        1,
        dpi=36,
        cmyk_profile_id="fogra39",
        render_intent=1,
    )

    assert (composite["width"], composite["height"]) == (
        proof["width"], proof["height"]
    )
    assert composite["missing_spot_alternates"] == []
    differences = [
        abs(left - right)
        for left, right in zip(bytes(composite["rgb"]), bytes(proof["rgb"]), strict=True)
    ]
    # Plate truyền qua contract u8 nên cho phép đúng một bước lượng tử; mọi sai lệch
    # lớn hơn mức này là dấu hiệu subset không còn dùng cùng LUT/CMM với Soft-Proof.
    assert max(differences) <= 2
    assert sum(differences) / len(differences) <= 0.2


def test_subset_composite_tat_het_ra_giay_va_khong_nhan_plate_la(tmp_path):
    source = _multipage_nested_spot_pdf(tmp_path)
    separated = separations(source, 1, dpi=24, cmyk_profile_id="fogra39")
    paper = compose_separation_subset(
        width=separated["width"],
        height=separated["height"],
        plates=separated["plates"],
        enabled_names=[],
        cmyk_profile_id="fogra39",
    )
    brand = compose_separation_subset(
        width=separated["width"],
        height=separated["height"],
        plates=separated["plates"],
        enabled_names=["Brand Blue"],
        cmyk_profile_id="fogra39",
    )

    assert bytes(paper["rgb"]) != bytes(brand["rgb"])
    first = bytes(paper["rgb"][:3])
    assert bytes(paper["rgb"]) == first * (paper["width"] * paper["height"])
    with pytest.raises(ValueError, match="không tồn tại"):
        compose_separation_subset(
            width=separated["width"],
            height=separated["height"],
            plates=separated["plates"],
            enabled_names=["Plate Không Có"],
            cmyk_profile_id="fogra39",
        )


def test_inventory_cache_clone_va_ram_gate(tmp_path):
    from app.core.ink_manager import (
        analyze_ink_inventory,
        inventory_cache_capacity_for_ram,
    )

    source = _multipage_nested_spot_pdf(tmp_path)
    first = analyze_ink_inventory(source)
    first["document_colorants"].clear()
    second = analyze_ink_inventory(source)
    assert len(second["document_colorants"]) == 6
    assert inventory_cache_capacity_for_ram(6 * 1024) == 4
    assert inventory_cache_capacity_for_ram(12 * 1024) == 12
    assert inventory_cache_capacity_for_ram(64 * 1024) > inventory_cache_capacity_for_ram(32 * 1024)
