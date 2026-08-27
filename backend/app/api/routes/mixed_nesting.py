"""API "Bình lồng ghép tự do" — phase P7a (Technical MVP).

Kế hoạch: ``docs/KE_HOACH_MIXED_TRUE_SHAPE_NESTING_DOC_LAP_2026-08-26.md`` §8, §12.1.

```text
GET    /api/mixed-nesting/capabilities
POST   /api/mixed-nesting/jobs                  -> 202
GET    /api/mixed-nesting/jobs/{job_id}
GET    /api/mixed-nesting/jobs/{job_id}/result
POST   /api/mixed-nesting/jobs/{job_id}/cancel
DELETE /api/mixed-nesting/jobs/{job_id}
```

Bốn quyết định đáng nêu:

1. **Cờ rollout chỉ chặn TẠO job.** ``PRYNX_MIXED_NESTING_ENABLED`` mặc định ``"false"``
   (HOLD) và trả **404** trước khi chạm native. Nhưng Status/Result/Cancel/Delete của job
   **đã tồn tại** vẫn hoạt động khi cờ vừa bị tắt (§8 quy tắc 3) — nếu chặn hết thì job
   đang chạy sẽ không hủy được, và ta rò thread, suất scheduler lẫn native handle.
2. **Owner isolation trả 404, không 403.** 403 tiết lộ "job này có thật nhưng không phải
   của bạn"; 404 không tiết lộ gì.
3. **Body được chặn theo byte TRƯỚC khi parse JSON.** Đọc từng chunk có ngân sách; không
   đợi Pydantic parse xong mới biết payload quá lớn (§9.2.5).
4. **Không có endpoint nào trả layout dở dang.** ``/result`` chỉ trả manifest đã validate
   khi job ở trạng thái terminal có kết quả; chưa xong thì **409**.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import sys
from typing import Any, Sequence

from fastapi import APIRouter, Depends, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.core.license_guard import require_feature
from app.core.mixed_nesting_jobs import (
    MixedNestingQueueFull,
    derive_owner,
    mixed_nesting_jobs,
)
from app.core.mixed_nesting_artifacts import artifact_store
from app.core.mixed_nesting_service import EngineUnavailableError, engine_capabilities
from app.schemas.mixed_nesting import (
    MAX_REQUEST_BYTES,
    CapabilitiesResponse,
    CreateJobRequest,
    ExportJobRequest,
    ExportResponse,
    JobAcceptedResponse,
    JobCancelResponse,
    JobDeleteResponse,
    JobProgress,
    JobStatusResponse,
)
from app.schemas.mixed_nesting_source import (
    AcceptPageBoxRequest,
    ContourCandidateOut,
    SelectCandidateRequest,
    SourceDeleteResponse,
    SourceOut,
    SourcePageOut,
)
from app.workers.mixed_nesting_pdf_export import (
    EXPORT_RULE_VERSION,
    ExportError,
    PartGeometry,
    export_manifest_to_pdf,
)
from app.workers.mixed_nesting_pdf_source import (
    FLATTEN_RULE_VERSION,
    MAX_SOURCE_BYTES,
    SourceError,
    SourceRecord,
    mixed_nesting_sources,
    parse_source,
)

logger = logging.getLogger(__name__)

#: Cờ rollout của bản phát hành. Mặc định HOLD (§8 quy tắc 7).
_RELEASE_FLAG_NAME = "PRYNX_MIXED_NESTING_ENABLED"

#: Capability RIÊNG của tool. Không dùng `impo.diecut`/`packaging.dieline` (§8 quy tắc 6).
FEATURE_ID = "impo.mixed_nesting"

router = APIRouter(
    prefix="/mixed-nesting",
    tags=["Mixed Nesting"],
    # License + entitlement cho MỌI endpoint. Cờ rollout là lớp khác, xử lý riêng bên dưới.
    dependencies=[Depends(require_feature("impo.mixed_nesting"))],
)


# ─────────────────────────────────────────────────────────────────────────────
#  Cờ rollout
# ─────────────────────────────────────────────────────────────────────────────


def _runtime_enabled(
    *,
    is_development: bool | None = None,
    is_compiled: bool | None = None,
    release_flag: str | None = None,
) -> bool:
    """Mở ở dev thông dịch, hoặc khi bản phát hành bật cờ có chủ ý."""
    compiled = (
        "__compiled__" in globals() or getattr(sys, "frozen", False)
        if is_compiled is None
        else is_compiled
    )
    development = settings.DEV_MODE if is_development is None else is_development
    if development and not compiled:
        return True

    raw_flag = (
        os.getenv(_RELEASE_FLAG_NAME, "false") if release_flag is None else release_flag
    )
    return raw_flag.strip().lower() == "true"


def require_runtime_enabled() -> None:
    """Fail-closed TRƯỚC cả bước dò native. Frontend không phải enforcement boundary."""
    if not _runtime_enabled():
        raise HTTPException(
            status_code=404,
            detail="Tính năng Bình lồng ghép tự do chưa được mở trong bản phát hành này.",
        )


# ─────────────────────────────────────────────────────────────────────────────
#  Đọc body có ngân sách byte
# ─────────────────────────────────────────────────────────────────────────────


async def _read_bounded_body(request: Request) -> bytes:
    """Đọc body theo byte budget. Vượt trần thì 413 **trước** khi parse JSON."""
    declared = request.headers.get("content-length")
    if declared:
        try:
            declared_bytes = int(declared)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="Content-Length không hợp lệ.")
        if declared_bytes > MAX_REQUEST_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"Dữ liệu lồng ghép quá lớn (trần {MAX_REQUEST_BYTES} byte).",
            )

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_REQUEST_BYTES:
            # Chunked encoding không khai Content-Length: phải đếm thật khi đọc.
            raise HTTPException(
                status_code=413,
                detail=f"Dữ liệu lồng ghép quá lớn (trần {MAX_REQUEST_BYTES} byte).",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _parse_create_request(raw: bytes) -> CreateJobRequest:
    if not raw:
        raise HTTPException(status_code=422, detail="Thiếu dữ liệu lệnh lồng ghép.")
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail="Dữ liệu lệnh lồng ghép không phải JSON hợp lệ."
        ) from exc
    if not isinstance(payload, dict):
        raise HTTPException(
            status_code=422, detail="Dữ liệu lệnh lồng ghép phải là một object JSON."
        )
    try:
        return CreateJobRequest.model_validate(payload)
    except ValidationError as exc:
        # Chỉ trả đường dẫn trường + thông báo; KHÔNG echo toạ độ contour của khách hàng.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "MIXED_NESTING_INVALID_REQUEST",
                "message": "Dữ liệu lệnh lồng ghép không đúng hợp đồng.",
                "errors": [
                    {
                        "field": ".".join(str(part) for part in error["loc"]),
                        "message": error["msg"],
                    }
                    for error in exc.errors()[:32]
                ],
            },
        ) from exc


def _owner(license_info: dict[str, Any]) -> str:
    return derive_owner(license_info)


def _status_response(snapshot) -> JobStatusResponse:
    progress = None
    if snapshot.progress:
        raw = snapshot.progress
        progress = JobProgress(
            phase=str(raw.get("phase") or "queued"),
            progress=float(raw.get("progress") or 0.0),
            attempt=int(raw.get("attempt") or 0),
            elapsed_ms=int(raw.get("elapsedMs") or 0),
            best_sheet_count=raw.get("bestSheetCount"),
            best_utilization=raw.get("bestUtilization"),
            message_code=raw.get("messageCode"),
        )
    return JobStatusResponse(
        job_id=snapshot.job_id,
        status=snapshot.status,
        terminal=snapshot.terminal,
        cancel_requested=snapshot.cancel_requested,
        created_at=snapshot.created_at,
        started_at=snapshot.started_at,
        completed_at=snapshot.completed_at,
        progress=progress,
        error_code=snapshot.error_code,
        message=snapshot.message,
    )


# ─────────────────────────────────────────────────────────────────────────────
#  Endpoint
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/capabilities", response_model=CapabilitiesResponse)
def get_capabilities(_gate: None = Depends(require_runtime_enabled)):
    """Năng lực engine. 503 nếu native thiếu hoặc wheel lệch protocol."""
    try:
        capabilities = engine_capabilities()
    except EngineUnavailableError as exc:
        raise HTTPException(
            status_code=exc.status, detail=exc.to_payload()
        ) from exc
    return CapabilitiesResponse(
        protocol_version=capabilities.protocol_version,
        engine_version=capabilities.engine_version,
        reflection="forbidden",
        default_rotation="free",
        continuous_translation=capabilities.continuous_translation,
        profiles=list(capabilities.profiles),
        max_request_bytes=MAX_REQUEST_BYTES,
    )


@router.post("/jobs", response_model=JobAcceptedResponse, status_code=202)
async def create_job(
    request: Request,
    license_info: dict = Depends(require_feature("impo.mixed_nesting")),
    _gate: None = Depends(require_runtime_enabled),
):
    """Nhận job và trả 202 ngay. Kết quả lấy bằng polling ``GET /jobs/{id}``."""
    raw = await _read_bounded_body(request)
    body = _parse_create_request(raw)

    # `jobId` là server-owned: registry sinh bằng CSPRNG rồi gọi builder này, nên request
    # nội bộ chưa bao giờ tồn tại với một mã tạm.
    try:
        snapshot = mixed_nesting_jobs.submit(
            owner=_owner(license_info),
            build_request=lambda job_id: body.to_engine_request(job_id=job_id),
        )
    except MixedNestingQueueFull as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc

    return JobAcceptedResponse(job_id=snapshot.job_id, status=snapshot.status)


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
def get_job(job_id: str, license_info: dict = Depends(require_feature("impo.mixed_nesting"))):
    """Trạng thái job. Vẫn phục vụ khi cờ rollout vừa bị tắt (§8 quy tắc 3)."""
    snapshot = mixed_nesting_jobs.get(job_id, _owner(license_info))
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job lồng ghép.")
    return _status_response(snapshot)


@router.get("/jobs/{job_id}/result")
def get_job_result(
    job_id: str, license_info: dict = Depends(require_feature("impo.mixed_nesting"))
):
    """Placement manifest **đã validate**. Chưa xong thì 409, không trả layout dở dang."""
    owner = _owner(license_info)
    snapshot = mixed_nesting_jobs.get(job_id, owner)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job lồng ghép.")
    if not snapshot.terminal:
        raise HTTPException(
            status_code=409,
            detail=f"Job lồng ghép chưa hoàn tất (trạng thái: {snapshot.status}).",
        )
    manifest = mixed_nesting_jobs.get_result(job_id, owner)
    if manifest is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": snapshot.error_code or "MIXED_NESTING_NO_RESULT",
                "message": snapshot.message or "Job lồng ghép không có kết quả.",
                "status": snapshot.status,
            },
        )
    return manifest


@router.post("/jobs/{job_id}/cancel", response_model=JobCancelResponse)
def cancel_job(
    job_id: str, license_info: dict = Depends(require_feature("impo.mixed_nesting"))
):
    """Hủy job. Idempotent; hủy job terminal là no-op."""
    outcome = mixed_nesting_jobs.cancel(job_id, _owner(license_info))
    if outcome is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job lồng ghép.")
    return JobCancelResponse(
        job_id=outcome.job_id,
        status=outcome.status,
        cancelled=outcome.cancelled,
        already_cancelled=outcome.already_cancelled,
        terminal=outcome.terminal,
    )


@router.delete("/jobs/{job_id}", response_model=JobDeleteResponse)
def delete_job(
    job_id: str, license_info: dict = Depends(require_feature("impo.mixed_nesting"))
):
    """Xóa job khỏi registry. Job chưa terminal bị hủy trước khi xóa."""
    deleted = mixed_nesting_jobs.delete(job_id, _owner(license_info))
    if not deleted:
        raise HTTPException(status_code=404, detail="Không tìm thấy job lồng ghép.")
    return JobDeleteResponse(job_id=job_id, deleted=True)


# ─────────────────────────────────────────────────────────────────────────────
#  Nguồn PDF — phase P12
# ─────────────────────────────────────────────────────────────────────────────


def _source_payload(record: SourceRecord) -> SourceOut:
    return SourceOut(
        source_id=record.source_id,
        status=record.status,
        file_name=record.file_name,
        candidates=[
            ContourCandidateOut(
                candidate_id=item.candidate_id,
                page_number=item.page_number,
                outer=[[x, y] for x, y in item.outer],
                holes=[[[x, y] for x, y in hole] for hole in item.holes],
                area_mm2=item.area_mm2,
                width_mm=item.width_mm,
                height_mm=item.height_mm,
                vertex_count=len(item.outer),
                rejected_reason=item.rejected_reason,
            )
            for item in record.candidates
        ],
        pages=[
            SourcePageOut(
                page_number=page["pageNumber"],
                width_mm=page["widthMm"],
                height_mm=page["heightMm"],
            )
            for page in record.pages
        ],
        selected_candidate_id=record.selected_candidate_id,
        source_revision=record.revision(),
        flatten_rule_version=FLATTEN_RULE_VERSION,
        created_at=record.created_at,
    )


async def _read_bounded_upload(upload: UploadFile) -> bytes:
    """Đọc file với ngân sách byte. Đọc **trần + 1** để biết vượt mà không nạp cả file."""
    data = await upload.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File PDF vượt trần {MAX_SOURCE_BYTES // (1024 * 1024)} MB.",
        )
    return data


@router.post("/sources", response_model=SourceOut, status_code=201)
async def create_source(
    file: UploadFile = File(...),
    license_info: dict = Depends(require_feature("impo.mixed_nesting")),
    _gate: None = Depends(require_runtime_enabled),
):
    """Nhận **bytes** PDF khuôn bế và trả danh sách đường bế ứng viên.

    Không nhận đường dẫn cục bộ (§10.1). Không giữ file: chỉ giữ polygon trong RAM.
    """
    raw = await _read_bounded_upload(file)
    file_name = (file.filename or 'khuon.pdf')[:200]
    try:
        # Phân tích content stream là việc CPU thuần; đẩy ra threadpool để event loop
        # còn phục vụ Status/Cancel của job đang chạy.
        record = await run_in_threadpool(
            parse_source,
            owner=_owner(license_info),
            file_name=file_name,
            pdf_bytes=raw,
            registry=mixed_nesting_sources,
        )
    except SourceError as exc:
        raise HTTPException(
            status_code=exc.status, detail={"code": exc.code, "message": exc.message}
        ) from exc
    return _source_payload(record)


@router.get("/sources/{source_id}", response_model=SourceOut)
def get_source(
    source_id: str, license_info: dict = Depends(require_feature("impo.mixed_nesting"))
):
    record = mixed_nesting_sources.get(source_id, _owner(license_info))
    if record is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy khuôn đã nhập.")
    return _source_payload(record)


@router.post("/sources/{source_id}/select", response_model=SourceOut)
def select_source_candidate(
    source_id: str,
    body: SelectCandidateRequest,
    license_info: dict = Depends(require_feature("impo.mixed_nesting")),
):
    """Chọn đường bế khi file có nhiều vòng kín. Engine không tự đoán (§10.5)."""
    try:
        record = mixed_nesting_sources.select(
            source_id, _owner(license_info), body.candidate_id
        )
    except SourceError as exc:
        raise HTTPException(
            status_code=exc.status, detail={"code": exc.code, "message": exc.message}
        ) from exc
    if record is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy khuôn đã nhập.")
    return _source_payload(record)


@router.post("/sources/{source_id}/page-box", response_model=SourceOut)
def accept_source_page_box(
    source_id: str,
    body: AcceptPageBoxRequest,
    license_info: dict = Depends(require_feature("impo.mixed_nesting")),
):
    """Dùng khổ trang làm hình chữ nhật — chỉ khi người dùng xác nhận rõ (§10.6)."""
    try:
        record = mixed_nesting_sources.accept_page_box(
            source_id, _owner(license_info), body.page_number
        )
    except SourceError as exc:
        raise HTTPException(
            status_code=exc.status, detail={"code": exc.code, "message": exc.message}
        ) from exc
    if record is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy khuôn đã nhập.")
    return _source_payload(record)


@router.delete("/sources/{source_id}", response_model=SourceDeleteResponse)
def delete_source(
    source_id: str, license_info: dict = Depends(require_feature("impo.mixed_nesting"))
):
    if not mixed_nesting_sources.delete(source_id, _owner(license_info)):
        raise HTTPException(status_code=404, detail="Không tìm thấy khuôn đã nhập.")
    return SourceDeleteResponse(source_id=source_id, deleted=True)


# ─────────────────────────────────────────────────────────────────────────────
#  Xuất PDF — phase P14a
# ─────────────────────────────────────────────────────────────────────────────


def _validated_request_of(job_id: str, owner: str) -> dict[str, Any]:
    """Bản request **đã validate** của job — nguồn chân lý duy nhất cho lệnh xuất.

    Cả khổ tờ lẫn hình học đều lấy từ đây, không từ body của lần gọi xuất: nhận lại ở lần
    xuất là mở đường xuất trên khổ khác, hoặc xuất hình khác, so với thứ đã nesting — và khi
    đó mọi kết luận của validator thành vô nghĩa.
    """
    request = mixed_nesting_jobs.request_of(job_id, owner)
    if request is None or not isinstance(request.get("sheet"), dict):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "MIXED_NESTING_EXPORT_NO_REQUEST",
                "message": "Không còn dữ liệu lệnh của job nên không xuất được.",
            },
        )
    return request


def _part_geometry_for(
    manifest: dict[str, Any], request: dict[str, Any]
) -> tuple[list[PartGeometry], str]:
    """Hình học của mọi ``partId`` trong manifest, lấy từ **request đã validate** của job.

    Xuất **không** nhận contour ở body lần gọi xuất: nhận thì client xuất được một hình khác
    với hình đã nesting và mọi kết luận của validator thành vô nghĩa. Nhưng nguồn chân lý
    đúng là ``mixed_nesting_jobs.request_of`` — chính bản request server đã kiểm và đã đưa
    cho engine — không phải registry nguồn PDF.

    Vì sao **không** tra registry nguồn: ``candidate_id`` chỉ duy nhất *trong một file*
    (``mixed_nesting_pdf_source.py:402`` sinh ``p{trang}-c{n}``). Khớp ``partId`` theo đuôi
    chuỗi vì thế sai ngay ở ca dùng chính của tool: thả hai PDF một trang thì cả hai đều ra
    ``p1-c1``, hai ``partId`` khác nhau cùng khớp record đầu tiên, và **một con lấy hình của
    con kia** — xuất ra đường bế sai cho thợ bế. Trong khi đó ``partId`` trong request đã
    được schema kiểm **duy nhất** (``schemas/mixed_nesting.py:280``), nên tra theo nó là
    chính xác theo cấu trúc, không phải nhờ đặt tên may mắn.

    Kèm lợi ích: không còn phụ thuộc TTL 1 giờ của registry nguồn, nên xuất lại sau khi khuôn
    đã hết hạn vẫn đúng.
    """
    parts_by_id: dict[str, dict[str, Any]] = {}
    for item in request.get("parts", []):
        if isinstance(item, dict) and "partId" in item:
            parts_by_id[str(item["partId"])] = item

    needed = sorted({str(item["partId"]) for item in manifest.get("placements", [])})
    missing = [part_id for part_id in needed if part_id not in parts_by_id]
    if missing:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "MIXED_NESTING_EXPORT_MISSING_SOURCE",
                "message": (
                    "Dữ liệu lệnh của job không còn hình học của khuôn nên không xuất được: "
                    + ", ".join(missing)
                ),
            },
        )

    geometry: list[PartGeometry] = []
    for part_id in needed:
        part = parts_by_id[part_id]
        geometry.append(
            PartGeometry(
                part_id=part_id,
                outer=[(float(x), float(y)) for x, y in part.get("outer", [])],
                holes=[
                    [(float(x), float(y)) for x, y in hole]
                    for hole in part.get("holes", []) or []
                ],
            )
        )
    return geometry, _geometry_revision(geometry)


def _geometry_revision(geometry: Sequence[PartGeometry]) -> str:
    """Băm hình học **thực sự đã nesting**, để chốt "đổi khuôn nhưng giữ file cũ".

    Băm ngay trên hình đã dùng chứ không cộng chuỗi ``revision()`` của các nguồn: nguồn có
    thể đã hết hạn hoặc bị xoá, và khi đó băm sẽ đổi dù khuôn không đổi — cảnh báo sai.
    """
    digest = hashlib.sha256()
    digest.update(f"export-v{EXPORT_RULE_VERSION}|".encode())
    for part in geometry:
        digest.update(f"P{part.part_id}|".encode())
        for ring in [part.outer, *part.holes]:
            digest.update(b"R")
            for x, y in ring:
                # 6 chữ số thập phân mm = 1 nanomet, dưới mọi tolerance của ngành in.
                digest.update(f"{x:.6f},{y:.6f};".encode())
    return digest.hexdigest()


@router.post("/jobs/{job_id}/export", response_model=ExportResponse)
async def export_job(
    job_id: str,
    _body: ExportJobRequest | None = None,
    license_info: dict = Depends(require_feature("impo.mixed_nesting")),
    _gate: None = Depends(require_runtime_enabled),
):
    """Xuất PDF tờ đã lồng ghép, 1:1 theo mm, từ phương án **đã validate**."""
    owner = _owner(license_info)
    snapshot = mixed_nesting_jobs.get(job_id, owner)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job lồng ghép.")
    manifest = mixed_nesting_jobs.get_result(job_id, owner)
    if manifest is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": snapshot.error_code or "MIXED_NESTING_NO_RESULT",
                "message": "Job chưa có phương án để xuất.",
            },
        )

    request = _validated_request_of(job_id, owner)
    parts, source_revision = _part_geometry_for(manifest, request)
    sheet = request["sheet"]
    try:
        payload = await run_in_threadpool(
            export_manifest_to_pdf, manifest=manifest, sheet=sheet, parts=parts
        )
    except ExportError as exc:
        raise HTTPException(
            status_code=exc.status, detail={"code": exc.code, "message": exc.message}
        ) from exc

    store = artifact_store()
    record = await run_in_threadpool(
        store.publish,
        artifact_id=secrets.token_hex(16),
        owner=owner,
        job_id=job_id,
        source_revision=source_revision or "unknown",
        payload=payload,
        sheet_count=int(manifest["stats"]["sheetCount"]),
    )
    return ExportResponse(
        artifact_id=record.artifact_id,
        job_id=job_id,
        sheet_count=record.sheet_count,
        size_bytes=record.size_bytes,
        source_revision=record.source_revision,
        export_rule_version=EXPORT_RULE_VERSION,
        file_name=f"long-ghep-{job_id[:8]}.pdf",
    )


@router.get("/jobs/{job_id}/artifact")
def download_job_artifact(
    job_id: str, license_info: dict = Depends(require_feature("impo.mixed_nesting"))
):
    """Tải PDF đã xuất. Kiểm license + owner rồi stream; **không** công khai qua ``/results``."""
    owner = _owner(license_info)
    store = artifact_store()
    record = store.for_job(job_id, owner)
    if record is None:
        raise HTTPException(status_code=404, detail="Chưa có file xuất cho job này.")
    return StreamingResponse(
        store.open_for_read(record.artifact_id, owner),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="long-ghep-{job_id[:8]}.pdf"',
            "Content-Length": str(record.size_bytes),
            "Cache-Control": "no-store",
        },
    )


@router.get("/jobs/{job_id}/progress", include_in_schema=False)
def get_job_progress(
    job_id: str,
    response: Response,
    license_info: dict = Depends(require_feature("impo.mixed_nesting")),
):
    """Chỉ tiến độ, cho vòng polling 300–500 ms. Rẻ hơn ``/jobs/{id}`` một chút."""
    snapshot = mixed_nesting_jobs.get(job_id, _owner(license_info))
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy job lồng ghép.")
    response.headers["Cache-Control"] = "no-store"
    return {
        "jobId": snapshot.job_id,
        "status": snapshot.status,
        "terminal": snapshot.terminal,
        "progress": snapshot.progress,
    }
