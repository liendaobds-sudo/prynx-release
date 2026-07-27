"""Hồi quy endpoint Overprint Preview sau khi rời Ghostscript."""

from __future__ import annotations

import asyncio

import pikepdf
import pytest

from app.api.routes import preflight


def _blank_pdf(tmp_path) -> str:
    pdf = pikepdf.Pdf.new()
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 20, 20],
        Resources=pikepdf.Dictionary(),
        Contents=pdf.make_indirect(pikepdf.Stream(pdf, b"")),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    path = tmp_path / "blank.pdf"
    pdf.save(str(path))
    pdf.close()
    return str(path)


def test_endpoint_uses_ppe_pair_and_returns_real_diff(tmp_path, monkeypatch):
    source = _blank_pdf(tmp_path)
    calls: list[bool] = []

    def fake_softproof(_path, _page, *, dpi, simulate_overprint):
        assert dpi == 72
        calls.append(simulate_overprint)
        value = 0 if simulate_overprint else 255
        return {
            "width": 2,
            "height": 2,
            "rgb": bytes([value, value, value] * 4),
            "ink_unsound": False,
        }

    monkeypatch.setattr(preflight, "_get_file_path", lambda _file_id: source)
    monkeypatch.setattr(preflight, "ppe_softproof", fake_softproof)
    monkeypatch.setattr(
        preflight,
        "run_hidden",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("không được gọi GS")),
    )
    result = asyncio.run(
        preflight.render_overprint_preview(
            preflight.OverprintPreviewRequest(file_id="fixture", page=1, dpi=72)
        )
    )
    assert result["success"] is True
    assert result["engine"] == "ppe"
    assert result["has_differences"] is True
    assert result["diff_pixel_count"] == 4
    assert calls == [False, True]
    assert result["diff_overlay"].startswith("data:image/png;base64,")


def _spot_overprint_pdf(tmp_path) -> str:
    """Nền Yellow process, phủ lên một ô mực pha khai `/OP true`.

    Đây là hình dạng file thật của bao bì: overprint nằm trên Pantone, không phải
    trên mực process. Ghostscript 10.04 với `-sOverprint=disable|simulate` cho
    43.681 pixel khác nhau trên chính fixture này.
    """
    pdf = pikepdf.Pdf.new()
    tint = pikepdf.Dictionary(
        FunctionType=2, Domain=[0, 1],
        C0=[0, 0, 0, 0], C1=[0.0, 0.9, 0.9, 0.0], N=1,
    )
    sep = pdf.make_indirect(pikepdf.Array([
        pikepdf.Name("/Separation"),
        pikepdf.Name("/PANTONE_877"),
        pikepdf.Name("/DeviceCMYK"),
        tint,
    ]))
    page = pikepdf.Dictionary(
        Type=pikepdf.Name("/Page"),
        MediaBox=[0, 0, 60, 60],
        Resources=pikepdf.Dictionary(
            ColorSpace=pikepdf.Dictionary(CS0=sep),
            ExtGState=pikepdf.Dictionary(
                Knock=pikepdf.Dictionary(OP=False, op=False, OPM=0),
                Over=pikepdf.Dictionary(OP=True, op=True, OPM=0),
            ),
        ),
        Contents=pdf.make_indirect(pikepdf.Stream(
            pdf,
            b"q /Knock gs 0 0 1 0 k 0 0 60 60 re f Q\n"
            b"q /Over gs /CS0 cs 1 scn 15 15 30 30 re f Q\n",
        )),
    )
    pdf.pages.append(pikepdf.Page(pdf.make_indirect(page)))
    path = tmp_path / "spot_overprint.pdf"
    pdf.save(str(path))
    pdf.close()
    return str(path)


def test_spot_overprint_is_detected_by_real_ppe_render(tmp_path, monkeypatch):
    """Hồi quy §A.1 (audit 2026-07-27) — KHÔNG mock engine.

    Trước bản sửa, đường xem quy mực pha về CMYK ngay lúc dựng mực, nên hai ảnh
    knockout/overprint giống hệt nhau và endpoint trả `has_differences=False` trên
    file có overprint thật. Hai test mock ở trên không bắt được vì chúng không
    render gì. Test này cố ý đi qua PPE thật.
    """
    native = pytest.importorskip(
        "pdfcompare_native",
        reason="cần build native: maturin develop --release --manifest-path native/Cargo.toml",
    )
    if not hasattr(native, "ppe_softproof"):
        pytest.skip("native chưa có ppe_softproof — cần rebuild")

    source = _spot_overprint_pdf(tmp_path)
    monkeypatch.setattr(preflight, "_get_file_path", lambda _file_id: source)
    monkeypatch.setattr(
        preflight,
        "run_hidden",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("không được gọi GS")),
    )
    result = asyncio.run(
        preflight.render_overprint_preview(
            preflight.OverprintPreviewRequest(file_id="fixture", page=1, dpi=72)
        )
    )
    assert result["success"] is True, result.get("error")
    assert result["engine"] == "ppe"
    assert result["has_differences"] is True, (
        "overprint trên mực pha phải hiện ra khác biệt; 0 pixel nghĩa là kẽm spot "
        "đã bị gộp về CMYK trước khi tính overprint"
    )
    # Ô phủ chiếm 1/4 diện tích trang; chấp nhận sai số viền chứ không chấp nhận
    # một con số nhỏ do vài pixel nhiễu.
    total = result["width"] * result["height"]
    assert result["diff_pixel_count"] > total * 0.2, result["diff_pixel_count"]


def test_endpoint_fails_loud_when_ppe_is_untrusted(tmp_path, monkeypatch):
    source = _blank_pdf(tmp_path)
    monkeypatch.setattr(preflight, "_get_file_path", lambda _file_id: source)
    monkeypatch.setattr(
        preflight,
        "ppe_softproof",
        lambda *_args, **_kwargs: {
            "width": 2,
            "height": 2,
            "rgb": bytes(12),
            "ink_unsound": True,
        },
    )
    result = asyncio.run(
        preflight.render_overprint_preview(
            preflight.OverprintPreviewRequest(file_id="fixture", page=1, dpi=72)
        )
    )
    assert result["success"] is False
    assert result["has_differences"] is False
    assert result["engine"] == "ppe"
    assert "tin cậy" in result["error"]
