"""Flatten phải NÓI khi nó raster hoá — không được im lặng trả success.

GS-SUNSET (audit 2026-08-08 §GS.3): `LayerEngine.flatten_visible` đi thẳng qua
PDFium và dựng lại file từ ảnh 300 DPI RGB. Đường này mất vector, mất chữ chọn được,
đổi CMYK sang RGB và MẤT màu pha — tức mất Pantone và kênh bế.

Trước đây chỗ đó chỉ `logger.warning` rồi trả success=True, thợ không hề biết. Tệ hơn:
hộp thoại xác nhận trên UI đã HỨA "PrynX sẽ cảnh báo trong kết quả".

Test này khoá hợp đồng: raster hoá thì `last_flatten_warning` phải có, và phải nêu
đúng những thứ bị mất bằng thuật ngữ ngành in.
"""
from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace

import pikepdf
import pytest

from app.core.layer_engine import LayerEngine


@pytest.fixture
def pdf_with_layer(tmp_path):
    """PDF một trang có OCG, đủ để flatten chạy thật."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    ocg = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name("/OCG"), Name=pikepdf.String("Lop in"))
    )
    page[pikepdf.Name("/Contents")] = pdf.make_stream(
        b"/OC /MC0 BDC\n1 0 0 rg 20 20 100 100 re f\nEMC\n"
    )
    page[pikepdf.Name("/Resources")] = pikepdf.Dictionary(
        Properties=pikepdf.Dictionary(MC0=ocg)
    )
    pdf.Root[pikepdf.Name("/OCProperties")] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([ocg]),
        D=pikepdf.Dictionary(Order=pikepdf.Array([ocg]), ON=pikepdf.Array([ocg])),
    )
    path = tmp_path / "co_layer.pdf"
    pdf.save(str(path))
    pdf.close()
    return str(path)


def test_engine_moi_khong_co_canh_bao():
    """Chưa chạy gì thì không được có cảnh báo cũ dính lại."""
    assert LayerEngine().last_flatten_warning is None


def test_flatten_raster_dat_canh_bao(pdf_with_layer):
    """Raster hoá trực tiếp ⇒ PHẢI có cảnh báo."""
    engine = LayerEngine()
    output = engine.flatten_visible(pdf_with_layer)

    assert output, "flatten vẫn phải ra file — đây là fail-safe, không phải fail-stop"
    warning = engine.last_flatten_warning
    assert warning, (
        "flatten đã raster hoá mà last_flatten_warning rỗng ⇒ UI im lặng ⇒ thợ ra kẽm "
        "bằng file đã mất Pantone/kênh bế mà không biết"
    )

    # Nêu đúng thứ bị mất, bằng thuật ngữ thợ hiểu. "Mất vector" một mình là chưa đủ:
    # thứ làm hỏng bản kẽm và khuôn bế là màu pha.
    lowered = warning.lower()
    for tu_khoa in ("raster", "vector", "pantone"):
        assert tu_khoa in lowered, f"cảnh báo thiếu ý '{tu_khoa}': {warning!r}"


def test_canh_bao_duoc_dat_lai_moi_lan_goi(pdf_with_layer):
    """Cảnh báo là của LẦN GẦN NHẤT, không được tích luỹ qua nhiều lần gọi."""
    engine = LayerEngine()
    engine.flatten_visible(pdf_with_layer)
    assert engine.last_flatten_warning

    engine.last_flatten_warning = "rác từ lần trước"
    engine.flatten_visible(pdf_with_layer)
    assert engine.last_flatten_warning != "rác từ lần trước", (
        "flatten_visible phải reset cảnh báo ở đầu mỗi lần gọi"
    )


def test_edit_session_route_giu_canh_bao_raster(monkeypatch):
    """Route phải giữ cảnh báo trong response_model thay vì âm thầm loại bỏ."""
    from app.api.routes import edit as edit_route

    warning = "Đã raster hoá 300 DPI RGB; mất vector, Pantone và kênh bế."
    session = SimpleNamespace(
        source_fid="fid-nguon",
        lock=threading.RLock(),
        dirty=True,
        last_commit_path=None,
    )
    result = {
        "success": True,
        "output_filename": "flattened.pdf",
        "output_url": "/results/flattened.pdf",
        "output_path": "C:/tmp/flattened.pdf",
        "output_fid": "fid-moi",
        "warning": warning,
    }
    monkeypatch.setattr(edit_route.edit_session, "get_session", lambda _sid: session)
    monkeypatch.setattr(edit_route.edit_session, "flatten", lambda _session: result)
    monkeypatch.setattr(
        edit_route,
        "_lease_registered_working_file",
        lambda _path, _fid: "lease-flatten-test",
    )
    monkeypatch.setattr(edit_route, "_invalidate_object_cache", lambda _fid: None)

    response = asyncio.run(
        edit_route.session_flatten(
            edit_route.SessionCommitReq(session_id="session-test"),
            license_info={},
        )
    )

    assert response.warning == warning
    assert response.artifact_lease == "lease-flatten-test"
    assert response.model_dump()["warning"] == warning
