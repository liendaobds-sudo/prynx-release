"""
api.py — FastAPI router cho cut_export.

Requirements: 6.2, 7.1. Router ĐÃ được đăng ký vào app tại
backend/app/main.py:

    from app.workers.cut_export.api import router as cut_export_router
    app.include_router(cut_export_router, prefix="/api", tags=["Cut Export"])

⟹ Các endpoint sống dưới tiền tố /api/imposition/* (vd /api/imposition/cut-export).
Mọi route yêu cầu license qua Depends(require_license).
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.core.license_guard import require_feature, require_license
from app.workers.cut_export.cut_model_builder import build_cut_model, NamingContractError
from app.workers.cut_export.profile import (
    load_builtin_profiles, load_all_profiles, builtin_profile_ids,
    user_profiles_dir, ProfileError,
)
from app.workers.cut_export import profile_store
from app.workers.cut_export import service
from app.workers.cut_export.pdf_source import (
    build_cut_model_from_pdf,
    inspect_cut_pdf,
    list_cut_layers,
    list_cut_pages,
    preview_svg_from_pdf,
)
from app.workers.cut_export.transport.tcp import probe_tcp
from app.workers.cut_export.inspect_proof import (
    CUT_INSPECT_PROOF_MAX_LENGTH,
    CutInspectProofError,
    issue_cut_inspect_proofs,
    verify_cut_inspect_proof,
)

# SEC (audit 2026-08-28 §SEC.01): router này TỪNG chỉ có `require_license` nên một
# license FREE hợp lệ gọi được toàn bộ 10 endpoint bình bế rớt/CNC — gồm xuất luồng cắt
# và ĐẨY TRỰC TIẾP tới máy bế qua TCP/serial. `impo.cnc` khai là quyền PRO ở cả ba nơi
# (`core/feature_entitlements.py` PRO_FEATURES, `desktop/src/lib/license/features.ts`,
# `desktop/src/lib/toolRegistry.ts`) nhưng chỉ được cưỡng chế thật ở `routes/imposition.py`
# (`_launch_impose_job`); module này bỏ trắng ⇒ leo quyền Free→Pro không cần crack.
#
# Gate ở CẤP ROUTER, không phải từng decorator: thêm endpoint mới vào đây thì tự động có
# quyền, không phụ thuộc việc người viết có nhớ gắn dependency hay không.
# `require_feature` đã `Depends(require_license)` bên trong nên license vẫn được kiểm; giữ
# thêm `require_license` tường minh để lỗi thiếu credential vẫn là 401 (không thành 403).
router = APIRouter(
    prefix="/imposition",
    tags=["cut-export"],
    dependencies=[Depends(require_license), Depends(require_feature("impo.cnc"))],
)


class PointModel(BaseModel):
    x: float
    y: float


class CutExportRequest(BaseModel):
    profile_id: str
    sheet_w_mm: float
    sheet_h_mm: float
    paths: list[list[tuple[float, float]]] = Field(default_factory=list)
    marks: list[tuple[float, float]] = Field(default_factory=list)
    emitter_kind: Optional[str] = None         # dxf | svg | pdf | command_stream
    transport_kind: Optional[str] = None        # file | tcp | serial
    dest_dir: Optional[str] = None
    name: str = "cut"
    tcp_host: Optional[str] = None
    tcp_port: int = 9100
    serial_port: Optional[str] = None
    serial_baud: int = 9600
    reg_mode: Optional[str] = None
    design_pts: Optional[list[tuple[float, float]]] = None
    measured_pts: Optional[list[tuple[float, float]]] = None
    pont_config: Optional[dict] = None
    ignore_limits: bool = False
    copies: int = 1


class CutConnectionTestRequest(BaseModel):
    host: str
    port: int = 9100
    timeout: float = Field(default=3.0, ge=0.2, le=10.0)


@router.post("/cut-connection-test")
def cut_connection_test(req: CutConnectionTestRequest):
    """Kiểm tra máy có mở cổng TCP; không gửi dữ liệu và không khởi động dao."""
    try:
        return probe_tcp(req.host, req.port, req.timeout)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/cut-profiles")
def list_cut_profiles():
    """Liệt kê profile máy (có sẵn + người dùng tạo) — Req 7.1."""
    profs = load_all_profiles()
    builtin = builtin_profile_ids()
    return {
        "profiles": [
            {
                "id": p.id, "vendor": p.vendor, "model": p.model,
                "emitter": p.emitter, "dialect": p.dialect,
                "reg_mode": p.reg_mode,
                "transport_default": (p.transport or {}).get("default", "file"),
                "builtin": p.id in builtin,
            }
            for p in profs.values()
        ]
    }


@router.post("/cut-export")
def cut_export(req: CutExportRequest):
    """Dựng CutModel từ payload → khớp dấu → emit → transport (Req 6.2)."""
    profs = load_all_profiles()
    profile = profs.get(req.profile_id)
    if profile is None:
        return {"ok": False, "error": f"Không tìm thấy profile '{req.profile_id}'"}

    try:
        model = build_cut_model(
            req.paths,
            marks=req.marks,
            sheet_w_mm=req.sheet_w_mm,
            sheet_h_mm=req.sheet_h_mm,
            pont_config=req.pont_config,
        )
    except (NamingContractError, ValueError) as e:
        return {"ok": False, "error": str(e)}

    tparams: dict = {}
    tkind = req.transport_kind or (profile.transport or {}).get("default", "file")
    if tkind == "tcp":
        tparams = {"host": req.tcp_host, "port": req.tcp_port}
    elif tkind == "serial":
        tparams = {"port": req.serial_port, "baud": req.serial_baud}

    try:
        result = service.export_cut(
            model, profile,
            emitter_kind=req.emitter_kind,
            transport_kind=tkind,
            transport_params=tparams,
            reg_mode=req.reg_mode,
            design_pts=req.design_pts,
            measured_pts=req.measured_pts,
            dest_dir=req.dest_dir,
            name=req.name,
            ignore_limits=req.ignore_limits,
            copies=req.copies,
        )
    except (ProfileError, ValueError) as e:
        return {"ok": False, "error": str(e)}

    return {
        "ok": result.ok,
        "channel": result.channel,
        "detail": result.detail,
        "bytes_sent": result.bytes_sent,
        "total_items": len([p for p in model.paths if not p.is_empty]),
    }


class CutExportFromFileRequest(BaseModel):
    path: str                       # đường dẫn file PDF đã bình (server-accessible)
    profile_id: str
    page_idx: int = 0
    force_layer: Optional[str] = None
    emitter_kind: Optional[str] = None
    transport_kind: Optional[str] = None
    dest_dir: Optional[str] = None
    name: str = "cut"
    tcp_host: Optional[str] = None
    tcp_port: int = 9100
    serial_port: Optional[str] = None
    serial_baud: int = 9600
    reg_mode: Optional[str] = None
    design_pts: Optional[list[tuple[float, float]]] = None
    measured_pts: Optional[list[tuple[float, float]]] = None
    pont_config: Optional[dict] = None
    ignore_limits: bool = False
    copies: int = 1
    inspect_proof: Optional[str] = Field(
        default=None,
        max_length=CUT_INSPECT_PROOF_MAX_LENGTH,
    )


@router.post("/cut-export-from-file")
def cut_export_from_file(req: CutExportFromFileRequest):
    """Dựng CutModel TỪ file PDF đã bình (trích đường cắt) → khớp dấu → emit → transport.

    Đây là đường để nút 'Gửi Máy Bế' lấy hình học cắt thật từ output bình.
    """
    import os

    if not req.path or not os.path.isfile(req.path):
        return {"ok": False, "error": f"Không tìm thấy file: {req.path}"}
    if not req.path.lower().endswith(".pdf"):
        return {"ok": False, "error": "Chỉ hỗ trợ file PDF đã bình."}

    profs = load_all_profiles()
    profile = profs.get(req.profile_id)
    if profile is None:
        return {"ok": False, "error": f"Không tìm thấy profile '{req.profile_id}'"}

    try:
        if req.inspect_proof is not None:
            # PERF (audit 2026-09-02 §PERF-NEST-07): proof hợp lệ tái dùng
            # CutModel server-built; chỉ băm source hiện tại, không parse/extract lại.
            model = verify_cut_inspect_proof(
                req.inspect_proof,
                path=req.path,
                page_idx=req.page_idx,
                force_layer=req.force_layer,
                pont_config=req.pont_config,
            )
        else:
            # Tương thích caller/sidecar cũ: thiếu proof mới dùng đường parse legacy.
            model = build_cut_model_from_pdf(
                req.path,
                req.page_idx,
                req.pont_config,
                force_layer=req.force_layer,
            )
    except CutInspectProofError as exc:
        # Có proof mà sai/stale thì fail-closed, tuyệt đối không parse fallback.
        return {
            "ok": False,
            "error": "Bằng chứng inspect không hợp lệ hoặc đã hết hạn. Hãy xem trước lại file.",
            "proof_error": exc.code,
        }
    except (NamingContractError, ValueError) as e:
        try:
            cands = list_cut_layers(req.path, req.page_idx)
        except Exception:
            cands = {"layers": [], "spots": []}
        return {"ok": False, "error": str(e), "candidates": cands}

    tkind = req.transport_kind or (profile.transport or {}).get("default", "file")
    tparams: dict = {}
    if tkind == "tcp":
        tparams = {"host": req.tcp_host, "port": req.tcp_port}
    elif tkind == "serial":
        tparams = {"port": req.serial_port, "baud": req.serial_baud}

    try:
        result = service.export_cut(
            model, profile,
            emitter_kind=req.emitter_kind,
            transport_kind=tkind,
            transport_params=tparams,
            reg_mode=req.reg_mode,
            design_pts=req.design_pts,
            measured_pts=req.measured_pts,
            dest_dir=req.dest_dir,
            name=req.name,
            ignore_limits=req.ignore_limits,
            copies=req.copies,
        )
    except (ProfileError, ValueError) as e:
        return {"ok": False, "error": str(e)}

    return {
        "ok": result.ok,
        "channel": result.channel,
        "detail": result.detail,
        "bytes_sent": result.bytes_sent,
        "total_items": len([p for p in model.paths if not p.is_empty]),
    }


class CutPreviewRequest(BaseModel):
    path: str
    page_idx: int = 0
    pont_config: Optional[dict] = None
    force_layer: Optional[str] = None
    auto_page: bool = False


class CutInspectRequest(BaseModel):
    path: str
    page_idx: int = 0
    force_layer: Optional[str] = None


@router.post("/cut-inspect")
def cut_inspect(req: CutInspectRequest):
    """Quét trang CUT, candidate và preview trong một lần mở PDF."""
    import os

    if not req.path or not os.path.isfile(req.path):
        return {"ok": False, "error": f"Không tìm thấy file: {req.path}"}
    if not req.path.lower().endswith(".pdf"):
        return {"ok": False, "error": "Chỉ hỗ trợ file PDF đã bình."}
    try:
        # PERF (audit 2026-09-02 §PERF-NEST-07): endpoint hợp nhất thay
        # ba lượt cold-open cut-pages/cut-layers/cut-preview của modal.
        data = inspect_cut_pdf(
            req.path,
            req.page_idx,
            req.force_layer,
            include_models=True,
        )
        models = data.pop("_models", {})
        cut_pages = data.get("cut_pages", [])
        if set(models) != set(cut_pages):
            raise CutInspectProofError("model-set-mismatch")

        # PERF (audit 2026-09-02 §PERF-NEST-07): cấp proof cho MỌI trang CUT
        # từ đúng bộ model/fingerprint vừa dựng. Send All không phải quét lại toàn
        # PDF theo từng trang; client vẫn nhận alias selected để tương thích.
        proofs_by_page = issue_cut_inspect_proofs(
            path=req.path,
            fingerprint=data["fingerprint"],
            force_layer=req.force_layer,
            models=models,
        )
        selected_page_idx = data.get("selected_page_idx")
        selected_proof = proofs_by_page.get(selected_page_idx)
        inspect_proofs = {
            str(page): proof
            for page, proof in proofs_by_page.items()
        }
        return {
            "ok": True,
            **data,
            "inspect_proof": selected_proof,
            "inspect_proofs": inspect_proofs,
        }
    except CutInspectProofError as exc:
        if exc.code == "capacity":
            error = (
                "Không đủ RAM khả dụng để giữ trọn bộ dữ liệu cắt cho tất cả tờ. "
                "Hãy đóng bớt tác vụ nặng hoặc chia PDF thành lô nhỏ hơn rồi xem trước lại."
            )
        else:
            error = "Không thể cấp bằng chứng inspect cho dữ liệu cắt hiện tại."
        return {"ok": False, "error": error, "proof_error": exc.code}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.post("/cut-preview-from-file")
def cut_preview_from_file(req: CutPreviewRequest):
    """Xem trước bố cục đường cắt (SVG) từ file đã bình (Req 8.1).

    `auto_page=True`: tự dò trang khuôn (trang có đường cắt) thay vì trang in đang xem.
    """
    import os

    if not req.path or not os.path.isfile(req.path):
        return {"ok": False, "error": f"Không tìm thấy file: {req.path}"}
    if not req.path.lower().endswith(".pdf"):
        return {"ok": False, "error": "Chỉ hỗ trợ file PDF đã bình."}
    try:
        data = preview_svg_from_pdf(
            req.path, req.page_idx, req.pont_config,
            force_layer=req.force_layer, auto_page=req.auto_page,
        )
    except (NamingContractError, ValueError) as e:
        # Kèm danh sách lớp để UI cho chọn thủ công (Req 10.6).
        try:
            cands = list_cut_layers(req.path, req.page_idx)
        except Exception:
            cands = {"layers": [], "spots": []}
        return {"ok": False, "error": str(e), "candidates": cands}
    return {"ok": True, **data}


@router.post("/cut-layers")
def cut_layers(req: CutPreviewRequest):
    """Liệt kê lớp OCG + spot-color của trang (cho dropdown chọn lớp thủ công, Req 10.6)."""
    import os
    if not req.path or not os.path.isfile(req.path):
        return {"ok": False, "error": f"Không tìm thấy file: {req.path}"}
    try:
        return {"ok": True, **list_cut_layers(req.path, req.page_idx)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class CutPagesRequest(BaseModel):
    path: str


@router.post("/cut-pages")
def cut_pages(req: CutPagesRequest):
    """Liệt kê chỉ số các trang KHUÔN (có đường cắt) — bỏ qua trang in.

    Modal dùng để chỉ điều hướng/gửi trên trang khuôn, không đụng trang in.
    """
    import os
    if not req.path or not os.path.isfile(req.path):
        return {"ok": False, "error": f"Không tìm thấy file: {req.path}"}
    if not req.path.lower().endswith(".pdf"):
        return {"ok": False, "error": "Chỉ hỗ trợ file PDF đã bình."}
    try:
        pages = list_cut_pages(req.path)
        return {"ok": True, "pages": pages, "num_pages": len(pages)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Quản lý máy bế (thêm/sửa/xóa profile người dùng) — Req 7.1, 7.3 ──

@router.get("/cut-profile")
def get_cut_profile(id: str):
    """Lấy toàn bộ cấu hình của một máy (để chỉnh sửa). Kèm cờ `builtin`."""
    from dataclasses import asdict
    profs = load_all_profiles()
    p = profs.get(id)
    if p is None:
        return {"ok": False, "error": f"Không tìm thấy máy '{id}'"}
    data = asdict(p)
    return {"ok": True, "profile": data, "builtin": id in builtin_profile_ids()}


class CutProfileSaveRequest(BaseModel):
    profile: dict


@router.post("/cut-profile-save")
def save_cut_profile(req: CutProfileSaveRequest):
    """Tạo mới / cập nhật một máy do người dùng quản lý (lưu JSON, có validate).

    Không cho ghi đè trực tiếp lên máy CÓ SẴN (builtin) — muốn tùy biến thì đặt id khác.
    """
    data = dict(req.profile or {})
    pid = str(data.get("id", "")).strip()
    if not pid:
        return {"ok": False, "error": "Thiếu 'id' (mã máy)."}
    if pid in builtin_profile_ids():
        return {"ok": False, "error": f"'{pid}' trùng máy có sẵn — hãy đặt mã (id) khác."}
    try:
        path = profile_store.save_profile(data, user_profiles_dir())
    except ProfileError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"Lưu thất bại: {e}"}
    return {"ok": True, "path": path, "id": pid}


class CutProfileDeleteRequest(BaseModel):
    id: str


@router.post("/cut-profile-delete")
def delete_cut_profile(req: CutProfileDeleteRequest):
    """Xóa máy do người dùng tạo. KHÔNG cho xóa máy có sẵn."""
    if req.id in builtin_profile_ids():
        return {"ok": False, "error": "Không thể xóa máy có sẵn."}
    ok = profile_store.delete_profile(req.id, user_profiles_dir())
    return {"ok": ok, "id": req.id}
