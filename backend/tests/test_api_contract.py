"""Hợp đồng API nhóm bình bản — KIENTRUC (audit 2026-07-29 §A.2).

Vì sao cần test này: desktop và backend KHÔNG có codegen chung. Bỏ một field khỏi
response là lỗi im lặng — frontend chỉ nhận `undefined` và người dùng thấy "bình xong
nhưng không mở được file". Test dưới đây khoá lại đúng tập field mà
`desktop/src/lib/api.ts` + `desktop/src/lib/processHandlers.ts` đang đọc.

Nếu một field ở đây thực sự cần bỏ: sửa phía desktop TRƯỚC, rồi sửa test này trong cùng PR.
"""

import pytest

from app.api.routes import imposition as imposition_routes
from app.schemas.imposition import (
    ImposeJobStartResponse,
    NupJobCancelResponse,
    NupJobStatusResponse,
)

# Field desktop đang đọc — nguồn: lib/api.ts (startNupJobBackend) và
# lib/processHandlers.ts (vòng poll job N-Up).
FIELD_DESKTOP_DOC = {
    NupJobStatusResponse: {"status", "progress", "report", "error", "output_path"},
    ImposeJobStartResponse: {"job_id"},
    NupJobCancelResponse: {"job_id", "status", "cancelled"},
}


@pytest.mark.parametrize("model,fields", list(FIELD_DESKTOP_DOC.items()))
def test_model_giu_du_field_desktop_doc(model, fields):
    thieu = fields - set(model.model_fields)
    assert not thieu, f"{model.__name__} thiếu field desktop đang đọc: {sorted(thieu)}"


def _response_model_of(path: str, method: str):
    """Tra `response_model` theo hậu tố path.

    Router này có prefix riêng (`/imposition`) nên `route.path` là
    `/imposition/nup-status/{job_id}`; so bằng hậu tố để test không phải gõ cứng prefix.
    """
    for route in imposition_routes.router.routes:
        route_path = getattr(route, "path", None)
        if route_path and route_path.endswith(path) and method in getattr(route, "methods", set()):
            return getattr(route, "response_model", None)
    raise AssertionError(f"Không tìm thấy route {method} *{path}")


@pytest.mark.parametrize(
    "path,method,expected",
    [
        ("/impose-start", "POST", ImposeJobStartResponse),
        ("/nup-start", "POST", ImposeJobStartResponse),
        ("/sticker-start", "POST", ImposeJobStartResponse),
        ("/nup-status/{job_id}", "GET", NupJobStatusResponse),
        ("/nup-cancel/{job_id}", "POST", NupJobCancelResponse),
    ],
)
def test_endpoint_khai_response_model(path, method, expected):
    assert _response_model_of(path, method) is expected


def test_status_chap_nhan_job_vua_tao():
    """Hình dạng job lúc mới queued (xem `_launch_impose_job`) phải validate được."""
    payload = {
        "status": "queued",
        "progress": "0/0",
        "report": "",
        "error": None,
        "created_at": 1.0,
        "started_at": None,
        "completed_at": None,
        "output_path": None,
    }
    assert NupJobStatusResponse(**payload).status == "queued"


def test_status_khong_bien_du_lieu_lech_thanh_500():
    """Model là MÔ TẢ, không phải cái siết: thiếu field lỏng vẫn phải qua.

    Chốt này có chủ đích — thêm `response_model` cho endpoint đã chạy mà bắt kiểu chặt
    thì một dữ liệu lệch nhẹ sẽ biến response 200 thành 500 ngay trên máy khách.
    """
    ok = NupJobStatusResponse(status="running")
    assert ok.progress is None and ok.report is None

    # progress đôi khi là thông điệp giai đoạn (không phải 'x/y') — vẫn hợp lệ.
    assert NupJobStatusResponse(status="running", progress="Đang dựng tờ in").progress


def test_cancel_bao_phu_ca_ba_nhanh():
    """Endpoint hủy trả 3 hình dạng khác nhau; model phải nhận hết."""
    khong_ton_tai = NupJobCancelResponse(
        job_id="a1", status="not_found", cancelled=False, message="Job not found"
    )
    assert khong_ton_tai.already_cancelled is None

    da_xong = NupJobCancelResponse(
        job_id="a1", status="completed", cancelled=False, message="Job is already completed"
    )
    assert da_xong.cancelled is False

    da_huy = NupJobCancelResponse(
        job_id="a1",
        status="cancelled",
        cancelled=True,
        already_cancelled=False,
        process_stopped=True,
    )
    assert da_huy.process_stopped is True


def test_model_pdfcpu_cu_da_bi_xoa():
    """Model thời pdfcpu đã bỏ — có lại nghĩa là ai đó khôi phục engine deprecated."""
    import app.schemas.imposition as schema_module

    for ten in ("ImpositionConfig", "ImpositionRequest", "ImpositionResponse"):
        assert not hasattr(schema_module, ten), (
            f"{ten} đã được xoá ở audit 2026-07-29 §A.2 (engine pdfcpu deprecated)"
        )


# ── VDP (audit 2026-07-29 §A.2, lô 8b) ───────────────────────────────────────
from app.api.routes import vdp as vdp_routes  # noqa: E402
from app.schemas.vdp import (  # noqa: E402
    VdpJobCancelResponse,
    VdpJobStartResponse,
    VdpJobStatusResponse,
    VdpUploadResponse,
)

# Nguồn: lib/api.ts — vòng poll VDP đọc status/processed/total/result/error.
FIELD_DESKTOP_DOC_VDP = {
    VdpJobStatusResponse: {"status", "processed", "total", "result", "error"},
    VdpJobStartResponse: {"job_id"},
    VdpJobCancelResponse: {"job_id", "status", "cancelled"},
    VdpUploadResponse: {"path"},
}


@pytest.mark.parametrize("model,fields", list(FIELD_DESKTOP_DOC_VDP.items()))
def test_model_vdp_giu_du_field_desktop_doc(model, fields):
    thieu = fields - set(model.model_fields)
    assert not thieu, f"{model.__name__} thiếu field desktop đang đọc: {sorted(thieu)}"


def _vdp_response_model_of(path: str, method: str):
    for route in vdp_routes.router.routes:
        route_path = getattr(route, "path", None)
        if route_path and route_path.endswith(path) and method in getattr(route, "methods", set()):
            return getattr(route, "response_model", None)
    raise AssertionError(f"Không tìm thấy route {method} *{path}")


@pytest.mark.parametrize(
    "path,method,expected",
    [
        ("/generate", "POST", VdpJobStartResponse),
        ("/status/{job_id}", "GET", VdpJobStatusResponse),
        ("/vdp-cancel/{job_id}", "POST", VdpJobCancelResponse),
        ("/cancel/{job_id}", "POST", VdpJobCancelResponse),
        ("/upload", "POST", VdpUploadResponse),
    ],
)
def test_endpoint_vdp_khai_response_model(path, method, expected):
    assert _vdp_response_model_of(path, method) is expected


def test_vdp_status_chap_nhan_moi_giai_doan():
    """Các giai đoạn desktop phân biệt: processing → saving → completed/failed/cancelled."""
    for trang_thai in ("queued", "processing", "saving", "completed", "failed", "cancelled"):
        assert VdpJobStatusResponse(status=trang_thai).status == trang_thai

    dang_chay = VdpJobStatusResponse(status="processing", processed=37, total=120)
    assert (dang_chay.processed, dang_chay.total) == (37, 120)

    xong = VdpJobStatusResponse(status="completed", result="D:/out/vdp_ab12.pdf")
    assert xong.result and xong.error is None


def test_vdp_cancel_bao_phu_ca_ba_nhanh():
    assert VdpJobCancelResponse(
        job_id="x", status="not_found", cancelled=False, message="Job not found"
    ).cancelled is False
    assert VdpJobCancelResponse(
        job_id="x", status="failed", cancelled=False, message="Job is already failed"
    ).already_cancelled is None
    huy = VdpJobCancelResponse(
        job_id="x",
        status="cancelled",
        cancelled=True,
        already_cancelled=False,
        cancelled_before_start=True,
    )
    assert huy.cancelled_before_start is True


# ── preflight / system / pdf_tools (audit 2026-07-29 §A.2, lô 8 đợt 2) ────────
from app.api.routes import pdf_tools as pdf_tools_routes  # noqa: E402
from app.api.routes import preflight as preflight_routes  # noqa: E402
from app.api.routes import system as system_routes  # noqa: E402
from app.schemas.preflight import (  # noqa: E402
    CropRegionsResponse,
    FixFileResponse,
    FlattenLayersResponse,
    IccProfilesResponse,
    InksResponse,
    OverprintPreviewResponse,
    PageObjectsResponse,
    PreviewImageResponse,
)
from app.schemas.system import GpuStatusResponse, RecoverJobsResponse  # noqa: E402


def _model_of(router, path: str, method: str):
    for route in router.routes:
        route_path = getattr(route, "path", None)
        if route_path and route_path.endswith(path) and method in getattr(route, "methods", set()):
            return getattr(route, "response_model", None)
    raise AssertionError(f"Không tìm thấy route {method} *{path}")


# Nhóm "sửa file rồi trả tên file kết quả" — desktop đọc success + output_filename rồi
# gọi /preflight/download/{output_filename}. Đứt một trong hai là đứt cả luồng.
PREFLIGHT_FIX_FILE_PATHS = [
    "/preflight/delete-object",
    "/preflight/layers/rename",
    "/preflight/layers/toggle-lock",
    "/preflight/layers/set-visibility",
    "/preflight/layers/delete",
    "/preflight/layers/reorder",
    "/preflight/set-page-boxes",
    "/preflight/auto-trim",
    "/preflight/add-bleed",
    "/preflight/mirror-bleed",
    "/preflight/convert-spot",
]


@pytest.mark.parametrize("path", PREFLIGHT_FIX_FILE_PATHS)
def test_preflight_nhom_sua_file_dung_chung_mot_model(path):
    assert _model_of(preflight_routes.router, path, "POST") is FixFileResponse


@pytest.mark.parametrize(
    "path,method,expected",
    [
        ("/preflight/layers/flatten", "POST", FlattenLayersResponse),
        ("/preflight/crop-regions", "POST", CropRegionsResponse),
        ("/preflight/preview-hide", "POST", PreviewImageResponse),
        ("/preflight/objects/{file_id}/{page}", "GET", PageObjectsResponse),
        ("/preflight/inks/{file_id}", "GET", InksResponse),
        ("/preflight/icc-profiles", "GET", IccProfilesResponse),
        ("/preflight/overprint-preview", "POST", OverprintPreviewResponse),
    ],
)
def test_preflight_endpoint_rieng_khai_dung_model(path, method, expected):
    assert _model_of(preflight_routes.router, path, method) is expected


def test_preflight_bo_qua_co_y_van_khong_co_model():
    """Hai endpoint CỐ TÌNH chưa gắn model — nếu ai gắn thì phải sửa nhánh return trước.

    `/preview-layers` có nhánh trả chuỗi base64 (không phải dict); `/softproof` trả
    `result` do engine dựng. Gắn model khi chưa chuẩn hoá nhánh return sẽ làm sai kiểu
    response — test này là lời nhắc, không phải cấm vĩnh viễn.
    """
    assert _model_of(preflight_routes.router, "/preflight/preview-layers", "POST") is None
    assert _model_of(preflight_routes.router, "/preflight/softproof", "POST") is None


def test_fix_file_response_khong_siet():
    """Nhánh thất bại vẫn trả `success=False` mà không có tên file → phải hợp lệ."""
    assert FixFileResponse(success=False).output_filename is None
    assert FixFileResponse(success=True, output_filename="fixed_ab12.pdf").output_filename


def test_flatten_giu_canh_bao_raster():
    """`warning` mang cảnh báo mất Pantone + kênh bế khi phải flatten bằng raster."""
    assert "warning" in FlattenLayersResponse.model_fields
    r = FlattenLayersResponse(success=True, output_filename="f.pdf", warning="mất Pantone")
    assert r.warning


def test_overprint_preview_bao_phu_ca_ba_nhanh():
    assert OverprintPreviewResponse(success=False, error="loi").has_differences is None
    assert OverprintPreviewResponse(success=True, has_differences=False, engine="ppe").engine == "ppe"
    du = OverprintPreviewResponse(
        success=True,
        has_differences=True,
        diff_pixel_count=1234,
        diff_overlay="data:image/png;base64,...",
        overprint_image="data:image/png;base64,...",
        width=800,
        height=600,
        engine="ppe",
    )
    assert du.diff_pixel_count == 1234


@pytest.mark.parametrize(
    "path,method",
    [
        ("/system/gpu-status", "GET"),
        ("/system/install-gpu-plugin", "POST"),
        ("/system/recover-jobs", "POST"),
        ("/system/gs-usage", "GET"),
    ],
)
def test_system_moi_endpoint_deu_co_model(path, method):
    assert _model_of(system_routes.router, path, method) is not None


def test_gpu_status_chap_nhan_may_khong_gpu():
    """Máy không có GPU: backend/device_name là None — không được thành 500."""
    r = GpuStatusResponse(is_gpu_available=False)
    assert r.current_backend is None and r.device_name is None
    assert RecoverJobsResponse(status="success", recovered_jobs_count=0).recovered_jobs_count == 0


@pytest.mark.parametrize(
    "path,method",
    [
        ("/encryption-status", "POST"),
        ("/metadata/read", "POST"),
        ("/office-convert/status", "GET"),
        ("/remove-background/warmup", "POST"),
        ("/upscale/warmup", "POST"),
    ],
)
def test_pdf_tools_endpoint_json_co_model(path, method):
    assert _model_of(pdf_tools_routes.router, path, method) is not None


def test_pdf_tools_endpoint_tai_file_khong_gan_model():
    """Endpoint trả `FileResponse` KHÔNG được gắn `response_model`.

    Gắn vào sẽ làm FastAPI cố validate/serialize một `FileResponse` → sai kiểu. Đây là lý
    do con số "22 endpoint / 5 có model" của `pdf_tools.py` là ĐÚNG, không phải thiếu sót.
    """
    for path in ("/merge", "/split", "/resize", "/shuffle", "/optimize", "/encrypt", "/decrypt"):
        assert _model_of(pdf_tools_routes.router, path, "POST") is None
