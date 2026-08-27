"""Pipeline nhập PDF khuôn bế — phase P12.

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §10, §16.3.

Fixture được **sinh từ** ``tests/fixtures/mixed_nesting_sources/manifest.json`` thay vì lưu
PDF nhị phân trong repo: mô tả đọc được, sửa được, và diff có nghĩa.

Sáu nhóm, khớp từng câu của gate P12:

1. **Không dùng PDFium.** Kiểm bằng cấu trúc: module không import ``pypdfium2`` và không
   gọi ``pdfium_guard``. Đây là lý do "no PDFium thread race" đúng theo thiết kế, không
   phải nhờ bọc khóa cẩn thận.
2. **Không nhận đường dẫn cục bộ.** Route chỉ có ``UploadFile``; không có tham số path.
3. **Bounded upload** — vượt trần byte thì 413 trước khi mở pikepdf.
4. **``ready`` / ``ambiguous`` / ``no_contour``** đúng theo số vòng kín; nhiều vòng thì
   KHÔNG tự đoán.
5. **Owner isolation** — nguồn của owner khác trả 404.
6. **Hình học đúng chiều**: contour không bị soi gương dù parser dùng hệ Y đã lật.
"""

from __future__ import annotations

import io
import json
import math
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api.routes import mixed_nesting as route
from app.core.license_guard import require_license
from app.main import app
from app.workers import mixed_nesting_pdf_source as source_worker
from app.workers.mixed_nesting_pdf_source import (
    FLATTEN_RULE_VERSION,
    FLATTEN_TOLERANCE_MM,
    MAX_SOURCE_BYTES,
    MixedNestingSourceRegistry,
    SourceError,
    extract_candidates,
    flatten_cubic,
    geometry_hash,
    is_self_intersecting,
    parse_source,
    ring_area_mm2,
    simplify_ring,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_MANIFEST = (
    _REPO_ROOT / "backend" / "tests" / "fixtures" / "mixed_nesting_sources" / "manifest.json"
)
_PT_TO_MM = 25.4 / 72.0

PRO_A = {
    "license_key": "TEST-PRO-SRC-A",
    "hwid": "HWID-A",
    "license_token": "",
    "verified": True,
    "plan": "pro",
    "features": ["*"],
}
PRO_B = {**PRO_A, "license_key": "TEST-PRO-SRC-B", "hwid": "HWID-B"}


# ─────────────────────────────────────────────────────────────────────────────
#  Sinh PDF từ manifest
# ─────────────────────────────────────────────────────────────────────────────


def _manifest() -> dict[str, Any]:
    with open(_MANIFEST, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _case(case_id: str) -> dict[str, Any]:
    for case in _manifest()["cases"]:
        if case["id"] == case_id:
            return case
    raise AssertionError(f"manifest thiếu ca {case_id}")


def _content_stream(paths: list[dict[str, Any]]) -> bytes:
    """Dựng content stream PDF từ mô tả trong manifest."""
    parts: list[str] = ["0.5 w", "0 0 0 RG"]
    for path in paths:
        kind = path["kind"]
        if kind in {"closed_polyline", "open_polyline"}:
            points = path["pointsPt"]
            parts.append(f"{points[0][0]} {points[0][1]} m")
            for x, y in points[1:]:
                parts.append(f"{x} {y} l")
            parts.append("h S" if kind == "closed_polyline" else "S")
        elif kind == "closed_bezier_capsule":
            x0, y0, x1, y1 = path["rectPt"]
            radius = (y1 - y0) / 2.0
            k = radius * 0.5523
            mid_y = (y0 + y1) / 2.0
            parts.append(f"{x0 + radius} {y0} m")
            parts.append(f"{x1 - radius} {y0} l")
            parts.append(
                f"{x1 - radius + k} {y0} {x1} {mid_y - k} {x1} {mid_y} c"
            )
            parts.append(
                f"{x1} {mid_y + k} {x1 - radius + k} {y1} {x1 - radius} {y1} c"
            )
            parts.append(f"{x0 + radius} {y1} l")
            parts.append(
                f"{x0 + radius - k} {y1} {x0} {mid_y + k} {x0} {mid_y} c"
            )
            parts.append(
                f"{x0} {mid_y - k} {x0 + radius - k} {y0} {x0 + radius} {y0} c"
            )
            parts.append("h S")
        else:  # pragma: no cover - manifest sai là lỗi fixture
            raise AssertionError(f"kind lạ trong manifest: {kind}")
    return "\n".join(parts).encode("latin-1")


def build_pdf(case: dict[str, Any]) -> bytes:
    """Sinh PDF một trang theo mô tả. Dùng pikepdf để file luôn hợp lệ."""
    import pikepdf

    width, height = case["pageSizePt"]
    pdf = pikepdf.Pdf.new()
    stream = pdf.make_stream(_content_stream(case["paths"]))
    page = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Page,
            MediaBox=[0, 0, width, height],
            Resources=pikepdf.Dictionary(),
            Contents=stream,
        )
    )
    pdf.pages.append(pikepdf.Page(page))
    buffer = io.BytesIO()
    pdf.save(buffer)
    return buffer.getvalue()


def pdf_of(case_id: str) -> bytes:
    return build_pdf(_case(case_id))


# ─────────────────────────────────────────────────────────────────────────────
#  Fixture
# ─────────────────────────────────────────────────────────────────────────────


@pytest.fixture()
def api(monkeypatch):
    registry = MixedNestingSourceRegistry(ttl_seconds=300.0, max_per_owner=8)
    monkeypatch.setattr(route, "mixed_nesting_sources", registry)
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "true")
    hien_tai: dict[str, Any] = {"license": PRO_A}
    app.dependency_overrides[require_license] = lambda: hien_tai["license"]
    try:
        with TestClient(app) as client:
            yield client, registry, hien_tai
    finally:
        app.dependency_overrides.pop(require_license, None)
        registry.clear()


def _upload(client: TestClient, case_id: str, name: str = "khuon.pdf"):
    return client.post(
        "/api/mixed-nesting/sources",
        files={"file": (name, pdf_of(case_id), "application/pdf")},
    )


# ─────────────────────────────────────────────────────────────────────────────
#  1. Không PDFium, không đường dẫn cục bộ
# ─────────────────────────────────────────────────────────────────────────────


_WORKER_PATH = _REPO_ROOT / "backend" / "app" / "workers" / "mixed_nesting_pdf_source.py"


def _worker_ast():
    import ast

    return ast.parse(_WORKER_PATH.read_text(encoding="utf-8"))


def _imported_modules(tree) -> set[str]:
    import ast

    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def _bare_call_names(tree) -> set[str]:
    """Tên hàm được gọi **trực tiếp** (không qua thuộc tính).

    Dùng AST thay vì tìm chuỗi: ``pikepdf.Pdf.open(...)`` có chứa ``open(`` nhưng nó mở một
    ``BytesIO``, không mở file. Tìm chuỗi ở đây từng làm test đỏ oan.
    """
    import ast

    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            names.add(node.func.id)
    return names


def _attribute_call_names(tree) -> set[str]:
    import ast

    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            names.add(node.func.attr)
    return names


def test_khong_dung_pdfium_theo_cau_truc():
    """Gate "no PDFium thread race" phải đúng vì KHÔNG có PDFium, không phải nhờ bọc khóa."""
    tree = _worker_ast()
    modules = _imported_modules(tree)
    for cam in ("pypdfium2", "app.core.pdfium_lock", "app.core.rust_bridge"):
        assert cam not in modules, f"module import {cam}"
    assert "pikepdf" in modules

    goi = _bare_call_names(tree) | _attribute_call_names(tree)
    for cam in ("pdfium_guard", "PdfDocument"):
        assert cam not in goi, f"module gọi {cam}"


def test_route_khong_nhan_duong_dan_cuc_bo():
    """§10.1: chỉ nhận bytes qua multipart; không nhận và không tin raw path."""
    import inspect

    signature = inspect.signature(route.create_source)
    assert "file" in signature.parameters
    for cam in ("path", "file_path", "source_path", "filePath"):
        assert cam not in signature.parameters

    source = (
        _REPO_ROOT / "backend" / "app" / "api" / "routes" / "mixed_nesting.py"
    ).read_text(encoding="utf-8")
    # Không đọc file từ đĩa theo đường dẫn client gửi.
    assert "open(" not in source
    assert "fetchLocalFileBuffer" not in source


def test_khong_ghi_file_nao():
    """Không có storage root ⇒ không có cả lớp rủi ro path traversal của §12.4."""
    tree = _worker_ast()
    modules = _imported_modules(tree)
    for cam in ("os", "shutil", "tempfile", "pathlib"):
        assert cam not in modules, f"module import {cam}"

    goi = _bare_call_names(tree)
    for cam in ("open", "Path"):
        assert cam not in goi, f"module gọi {cam}() — nghĩa là có chạm đĩa"

    source = _WORKER_PATH.read_text(encoding="utf-8")
    for cam in ("RESULTS_DIR", "UPLOAD_DIR"):
        assert cam not in source, f"module chạm {cam}"


# ─────────────────────────────────────────────────────────────────────────────
#  2. Bounded upload và dữ liệu xấu
# ─────────────────────────────────────────────────────────────────────────────


def test_file_qua_lon_tra_413(api, monkeypatch):
    client, _registry, _license = api
    monkeypatch.setattr(route, "MAX_SOURCE_BYTES", 1024)
    response = client.post(
        "/api/mixed-nesting/sources",
        files={"file": ("to.pdf", b"%PDF-1.7\n" + b"x" * 4096, "application/pdf")},
    )
    assert response.status_code == 413, response.text


def test_file_rong_va_khong_phai_pdf(api):
    client, _registry, _license = api
    rong = client.post(
        "/api/mixed-nesting/sources", files={"file": ("a.pdf", b"", "application/pdf")}
    )
    assert rong.status_code == 422
    assert rong.json()["detail"]["code"] == "MIXED_NESTING_SOURCE_EMPTY"

    la = client.post(
        "/api/mixed-nesting/sources",
        files={"file": ("a.pdf", b"khong phai pdf", "application/pdf")},
    )
    assert la.status_code == 422
    assert la.json()["detail"]["code"] == "MIXED_NESTING_SOURCE_NOT_PDF"


def test_pdf_hong_bao_loi_ro_khong_500(api):
    client, _registry, _license = api
    response = client.post(
        "/api/mixed-nesting/sources",
        files={"file": ("a.pdf", b"%PDF-1.7\nrac hoan toan", "application/pdf")},
    )
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "MIXED_NESTING_SOURCE_UNREADABLE"


def test_tran_byte_kiem_o_ca_tang_worker():
    with pytest.raises(SourceError) as excinfo:
        extract_candidates(b"%PDF-" + b"x" * (MAX_SOURCE_BYTES + 1))
    assert excinfo.value.status == 413


# ─────────────────────────────────────────────────────────────────────────────
#  3. ready / ambiguous / no_contour
# ─────────────────────────────────────────────────────────────────────────────


def test_mot_duong_be_thi_ready(api):
    client, _registry, _license = api
    response = _upload(client, "MOT_DUONG_BE")
    assert response.status_code == 201, response.text
    payload = response.json()

    assert payload["status"] == "ready"
    assert payload["selectedCandidateId"] is not None
    assert payload["sourceRevision"] is not None
    assert payload["flattenRuleVersion"] == FLATTEN_RULE_VERSION
    usable = [item for item in payload["candidates"] if item["rejectedReason"] is None]
    assert len(usable) == 1
    # 90 × 60 mm, sai số dưới 0,1 mm.
    assert usable[0]["widthMm"] == pytest.approx(90.0, abs=0.1)
    assert usable[0]["heightMm"] == pytest.approx(60.0, abs=0.1)
    assert usable[0]["vertexCount"] == 4


def test_co_lo_thi_ghi_nhan_lo(api):
    client, _registry, _license = api
    payload = _upload(client, "CO_LO").json()
    assert payload["status"] == "ready"
    usable = [item for item in payload["candidates"] if item["rejectedReason"] is None]
    assert len(usable) == 1
    assert len(usable[0]["holes"]) == 1
    # Lỗ 30 × 20 mm.
    hole = usable[0]["holes"][0]
    xs = [point[0] for point in hole]
    ys = [point[1] for point in hole]
    assert max(xs) - min(xs) == pytest.approx(30.0, abs=0.1)
    assert max(ys) - min(ys) == pytest.approx(20.0, abs=0.1)


def test_nhieu_duong_be_thi_ambiguous_va_khong_doan(api):
    client, _registry, _license = api
    payload = _upload(client, "NHIEU_DUONG_BE").json()

    assert payload["status"] == "ambiguous"
    assert payload["selectedCandidateId"] is None, "KHÔNG được tự đoán"
    assert payload["sourceRevision"] is None
    usable = [item for item in payload["candidates"] if item["rejectedReason"] is None]
    assert len(usable) == 2


def test_chon_duong_be_thi_thanh_ready_va_co_revision(api):
    client, _registry, _license = api
    created = _upload(client, "NHIEU_DUONG_BE").json()
    source_id = created["sourceId"]
    usable = [item for item in created["candidates"] if item["rejectedReason"] is None]

    response = client.post(
        f"/api/mixed-nesting/sources/{source_id}/select",
        json={"candidateId": usable[0]["candidateId"]},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "ready"
    assert payload["selectedCandidateId"] == usable[0]["candidateId"]
    assert payload["sourceRevision"] is not None

    # Chọn ứng viên khác cho revision KHÁC — revision bám theo hình học.
    khac = client.post(
        f"/api/mixed-nesting/sources/{source_id}/select",
        json={"candidateId": usable[1]["candidateId"]},
    ).json()
    assert khac["sourceRevision"] != payload["sourceRevision"]


def test_chon_ung_vien_khong_ton_tai_hoac_bi_loai(api):
    client, _registry, _license = api
    created = _upload(client, "NHIEU_DUONG_BE").json()
    source_id = created["sourceId"]

    khong_co = client.post(
        f"/api/mixed-nesting/sources/{source_id}/select", json={"candidateId": "khong-co"}
    )
    assert khong_co.status_code == 404
    assert khong_co.json()["detail"]["code"] == "MIXED_NESTING_CANDIDATE_NOT_FOUND"


def test_khong_co_duong_be_thi_no_contour_va_cho_chon_kho_trang(api):
    client, _registry, _license = api
    created = _upload(client, "KHONG_CO_DUONG_BE").json()
    assert created["status"] == "no_contour"
    assert created["selectedCandidateId"] is None

    # §10.6: chỉ dùng khổ trang khi người dùng xác nhận rõ, qua endpoint RIÊNG.
    response = client.post(
        f"/api/mixed-nesting/sources/{created['sourceId']}/page-box",
        json={"pageNumber": 1},
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "ready"
    chon = next(
        item
        for item in payload["candidates"]
        if item["candidateId"] == payload["selectedCandidateId"]
    )
    assert chon["widthMm"] == pytest.approx(100.0, abs=0.1)
    assert chon["heightMm"] == pytest.approx(150.0, abs=0.1)


def test_trang_khong_ton_tai_thi_404(api):
    client, _registry, _license = api
    created = _upload(client, "KHONG_CO_DUONG_BE").json()
    response = client.post(
        f"/api/mixed-nesting/sources/{created['sourceId']}/page-box",
        json={"pageNumber": 9},
    )
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "MIXED_NESTING_PAGE_NOT_FOUND"


def test_vong_tu_cat_bi_loai_kem_ly_do(api):
    client, _registry, _license = api
    payload = _upload(client, "TU_CAT").json()
    assert payload["status"] == "no_contour"
    bi_loai = [item for item in payload["candidates"] if item["rejectedReason"]]
    assert bi_loai, "phải nói ra lý do, không im lặng bỏ"
    assert bi_loai[0]["rejectedReason"] == "RING_SELF_INTERSECTING"


def test_vong_cuc_nho_bi_bo_im_lang(api):
    client, _registry, _license = api
    payload = _upload(client, "VONG_CUC_NHO").json()
    # Nhiễu 0,35 mm² dưới ngưỡng ⇒ bỏ, và vẫn ready với đúng một đường bế thật.
    assert payload["status"] == "ready"
    usable = [item for item in payload["candidates"] if item["rejectedReason"] is None]
    assert len(usable) == 1
    assert usable[0]["widthMm"] == pytest.approx(90.0, abs=0.1)


def test_duong_cong_duoc_lam_phang_theo_tolerance(api):
    client, _registry, _license = api
    payload = _upload(client, "DUONG_CONG").json()
    assert payload["status"] == "ready"
    usable = [item for item in payload["candidates"] if item["rejectedReason"] is None]
    assert len(usable) == 1
    expect = _case("DUONG_CONG")["expect"]
    assert usable[0]["vertexCount"] >= expect["minVertexCount"], (
        f"chỉ {usable[0]['vertexCount']} đỉnh — cung bị làm phẳng quá tay"
    )
    # Viên thuốc 300 × 120 pt ⇒ 105,8 × 42,3 mm.
    assert usable[0]["widthMm"] == pytest.approx(300 * _PT_TO_MM, abs=0.3)
    assert usable[0]["heightMm"] == pytest.approx(120 * _PT_TO_MM, abs=0.3)


# ─────────────────────────────────────────────────────────────────────────────
#  4. Hình học: không soi gương, đúng tỷ lệ
# ─────────────────────────────────────────────────────────────────────────────


def test_contour_khong_bi_soi_guong():
    """Parser dùng hệ Y đã lật; nếu quên lật lại thì contour bị mirror.

    Kiểm bằng một hình **không đối xứng**: tam giác vuông có đỉnh nhọn ở góc trên-phải
    trong hệ PDF. Sau khi nhập, đỉnh nhọn vẫn phải ở trên-phải.
    """
    case = {
        "pageSizePt": [595.276, 841.89],
        "paths": [
            {
                "kind": "closed_polyline",
                # Tam giác: (100,100) → (400,100) → (400,500)
                "pointsPt": [[100, 100], [400, 100], [400, 500]],
            }
        ],
    }
    candidates, _pages = extract_candidates(build_pdf(case))
    usable = [item for item in candidates if item.rejected_reason is None]
    assert len(usable) == 1
    ring = usable[0].outer

    # Đỉnh có Y lớn nhất phải cũng là đỉnh có X lớn nhất — đúng như hình gốc.
    dinh_cao_nhat = max(ring, key=lambda point: point[1])
    x_lon_nhat = max(point[0] for point in ring)
    assert dinh_cao_nhat[0] == pytest.approx(x_lon_nhat, abs=0.01), (
        f"contour bị soi gương: đỉnh cao nhất ở x={dinh_cao_nhat[0]}, x lớn nhất={x_lon_nhat}"
    )


def test_ty_le_mm_dung():
    """72 pt = 25,4 mm. Sai tỷ lệ là bình sai khổ, không phải lỗi hiển thị."""
    case = {
        "pageSizePt": [595.276, 841.89],
        "paths": [
            {
                "kind": "closed_polyline",
                # 144 × 72 pt = 50,8 × 25,4 mm
                "pointsPt": [[0, 0], [144, 0], [144, 72], [0, 72]],
            }
        ],
    }
    candidates, pages = extract_candidates(build_pdf(case))
    usable = [item for item in candidates if item.rejected_reason is None]
    assert usable[0].width_mm == pytest.approx(50.8, abs=0.01)
    assert usable[0].height_mm == pytest.approx(25.4, abs=0.01)
    assert pages[0]["widthMm"] == pytest.approx(210.0, abs=0.1)
    assert pages[0]["heightMm"] == pytest.approx(297.0, abs=0.1)


def test_contour_duoc_dich_ve_goc():
    candidates, _pages = extract_candidates(pdf_of("MOT_DUONG_BE"))
    usable = [item for item in candidates if item.rejected_reason is None]
    xs = [point[0] for point in usable[0].outer]
    ys = [point[1] for point in usable[0].outer]
    assert min(xs) == pytest.approx(0.0, abs=1e-9)
    assert min(ys) == pytest.approx(0.0, abs=1e-9)


# ─────────────────────────────────────────────────────────────────────────────
#  5. Hàm hình học thuần
# ─────────────────────────────────────────────────────────────────────────────


def test_flatten_cubic_ton_trong_tolerance():
    # Đoạn thẳng giả dạng Bézier: không cần chia.
    thang = flatten_cubic((0, 0), (1, 0), (2, 0), (3, 0), FLATTEN_TOLERANCE_MM)
    assert thang == [(3, 0)]

    # Cung thật: phải sinh nhiều điểm, và mọi điểm nằm gần đường cong.
    cung = flatten_cubic((0, 0), (0, 20), (20, 20), (20, 0), FLATTEN_TOLERANCE_MM)
    assert len(cung) > 8
    assert cung[-1] == (20, 0)

    # Tolerance lớn hơn ⇒ ít điểm hơn. Đây là bằng chứng tolerance thực sự có tác dụng.
    tho = flatten_cubic((0, 0), (0, 20), (20, 20), (20, 0), 5.0)
    assert len(tho) < len(cung)


def test_simplify_ring_bo_dinh_lap_va_thang_hang():
    tho = [(0, 0), (0, 0), (40, 0), (80, 0), (80, 40), (40, 40), (0, 40), (0, 0)]
    sach = simplify_ring(tho)
    assert len(sach) == 4
    assert ring_area_mm2(sach) == pytest.approx(3200.0, abs=1e-9)


def test_simplify_ring_khong_lam_bien_dang():
    tam_giac = [(0, 0), (90, 0), (30, 60)]
    assert simplify_ring(tam_giac) == tam_giac


def test_is_self_intersecting():
    vuong = [(0, 0), (10, 0), (10, 10), (0, 10)]
    no = [(0, 0), (10, 10), (10, 0), (0, 10)]
    assert is_self_intersecting(vuong) is False
    assert is_self_intersecting(no) is True
    # Trần kiểm: vòng quá dày thì trả False, và đó KHÔNG phải lời hứa vòng sạch.
    day = [(math.cos(i / 500), math.sin(i / 500)) for i in range(3000)]
    assert is_self_intersecting(day) is False


def test_geometry_hash_bao_ca_version_quy_tac():
    candidates, _pages = extract_candidates(pdf_of("MOT_DUONG_BE"))
    usable = [item for item in candidates if item.rejected_reason is None][0]
    truoc = geometry_hash(usable)
    assert len(truoc) == 64
    # Cùng hình cho cùng hash.
    assert geometry_hash(usable) == truoc
    # Hình khác cho hash khác.
    khac, _ = extract_candidates(pdf_of("CO_LO"))
    khac_usable = [item for item in khac if item.rejected_reason is None][0]
    assert geometry_hash(khac_usable) != truoc


# ─────────────────────────────────────────────────────────────────────────────
#  6. Owner isolation, TTL, xóa
# ─────────────────────────────────────────────────────────────────────────────


def test_owner_khac_tra_404(api):
    client, _registry, hien_tai = api
    created = _upload(client, "MOT_DUONG_BE").json()
    source_id = created["sourceId"]
    assert client.get(f"/api/mixed-nesting/sources/{source_id}").status_code == 200

    hien_tai["license"] = PRO_B
    assert client.get(f"/api/mixed-nesting/sources/{source_id}").status_code == 404
    assert (
        client.post(
            f"/api/mixed-nesting/sources/{source_id}/select", json={"candidateId": "x"}
        ).status_code
        == 404
    )
    assert client.delete(f"/api/mixed-nesting/sources/{source_id}").status_code == 404

    hien_tai["license"] = PRO_A
    assert client.get(f"/api/mixed-nesting/sources/{source_id}").status_code == 200


def test_xoa_nguon(api):
    client, _registry, _license = api
    source_id = _upload(client, "MOT_DUONG_BE").json()["sourceId"]
    response = client.delete(f"/api/mixed-nesting/sources/{source_id}")
    assert response.json() == {"sourceId": source_id, "deleted": True}
    assert client.get(f"/api/mixed-nesting/sources/{source_id}").status_code == 404
    assert client.delete(f"/api/mixed-nesting/sources/{source_id}").status_code == 404


def test_ttl_don_nguon_het_han():
    registry = MixedNestingSourceRegistry(ttl_seconds=0.0)
    record = parse_source(
        owner="owner-a",
        file_name="a.pdf",
        pdf_bytes=pdf_of("MOT_DUONG_BE"),
        registry=registry,
    )
    # TTL 0 ⇒ lần đọc kế tiếp đã quá hạn.
    assert registry.get(record.source_id, "owner-a") is None


def test_tran_so_nguon_moi_owner_bo_cai_cu_nhat():
    registry = MixedNestingSourceRegistry(ttl_seconds=300.0, max_per_owner=2)
    ids = [
        parse_source(
            owner="owner-a",
            file_name=f"{index}.pdf",
            pdf_bytes=pdf_of("MOT_DUONG_BE"),
            registry=registry,
        ).source_id
        for index in range(3)
    ]
    assert registry.count_for_owner("owner-a") == 2
    assert registry.get(ids[0], "owner-a") is None, "nguồn cũ nhất phải bị bỏ"
    assert registry.get(ids[2], "owner-a") is not None


def test_owner_khac_khong_bi_anh_huong_boi_tran():
    registry = MixedNestingSourceRegistry(ttl_seconds=300.0, max_per_owner=1)
    a = parse_source(
        owner="owner-a", file_name="a.pdf", pdf_bytes=pdf_of("MOT_DUONG_BE"), registry=registry
    )
    parse_source(
        owner="owner-b", file_name="b.pdf", pdf_bytes=pdf_of("MOT_DUONG_BE"), registry=registry
    )
    assert registry.get(a.source_id, "owner-a") is not None


def test_hold_chan_tao_nguon_truoc_khi_doc_file(monkeypatch):
    """Cờ rollout tắt ⇒ 404 trước cả bước phân tích PDF."""
    monkeypatch.setenv("PRYNX_MIXED_NESTING_ENABLED", "false")
    monkeypatch.setattr(route.settings, "DEV_MODE", False)

    def _no_dung_goi(**_kwargs):  # pragma: no cover - gọi tới là test đỏ
        pytest.fail("HOLD phải chặn trước khi phân tích PDF")

    monkeypatch.setattr(route, "parse_source", _no_dung_goi)
    app.dependency_overrides[require_license] = lambda: PRO_A
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/mixed-nesting/sources",
                files={"file": ("a.pdf", pdf_of("MOT_DUONG_BE"), "application/pdf")},
            )
            assert response.status_code == 404, response.text
    finally:
        app.dependency_overrides.pop(require_license, None)


def test_manifest_fixture_day_du():
    """Fixture phải phủ đủ các trạng thái mà §10 nêu."""
    manifest = _manifest()
    ids = {case["id"] for case in manifest["cases"]}
    assert {
        "MOT_DUONG_BE",
        "CO_LO",
        "NHIEU_DUONG_BE",
        "KHONG_CO_DUONG_BE",
        "DUONG_CONG",
        "TU_CAT",
        "VONG_CUC_NHO",
    } <= ids
    assert manifest["flattenRuleVersion"] == FLATTEN_RULE_VERSION
    for case in manifest["cases"]:
        assert case["expect"]["status"] in {"ready", "ambiguous", "no_contour"}
        assert case["title"]


def test_worker_khong_import_solver_cu():
    import ast

    tree = ast.parse(
        (
            _REPO_ROOT / "backend" / "app" / "workers" / "mixed_nesting_pdf_source.py"
        ).read_text(encoding="utf-8")
    )
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    for cam in (
        "app.core.imposition",
        "app.workers.sticker_engine",
        "app.workers.nup_engine",
        "app.core.nfp",
    ):
        assert not any(item == cam or item.startswith(cam + ".") for item in modules)
    # Chỉ dùng đúng parser dùng chung, không tự viết tokenizer thứ hai.
    assert "app.workers.pdf_content_parser" in modules


def test_worker_reset_duoc_cho_test():
    source_worker.mixed_nesting_sources.clear()
    assert source_worker.mixed_nesting_sources.count_for_owner("bat-ky") == 0
