"""Protected packaging dieline engine routes."""
from __future__ import annotations

import asyncio
import base64
import binascii
from concurrent.futures import ThreadPoolExecutor
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.core.license_guard import require_feature
from app.api.routes.dieline_validation import validate_dieline_body

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/dieline")

_MAX_REQUEST_BYTES = 128 * 1024
# A single native thread keeps Boa's thread-local JS context warm between requests.
_DIELINE_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="prynx-dieline")

# [DIELINE-ERROR-CLASS 2026-08-26] Phân loại lỗi từ sidecar native.
#
# Vì sao cần: trước đây MỌI `RuntimeError` từ `pdfcompare_native` đều bị gộp thành
# 422 "Không thể tạo khuôn với thông số này." Trong khi đó nguồn lỗi hay gặp nhất
# lại KHÔNG liên quan gì tới thông số: engine dieline được mã hoá theo bản phát hành
# và chỉ mở được bằng khoá `rk` nằm trong token license. Token thiếu `rk` (server
# chưa cấp khoá cho bản này, hoặc chạm trần chống thu gom khoá) ⇒ Rust trả
# "Dieline engine is locked: a valid license token is required" ⇒ người dùng thấy
# thông báo bảo sai thông số và sẽ ngồi sửa số đo vô ích, còn log thì phải mở tay
# mới biết. Đo thật trên bản 1.0.0-rc.9: token hợp lệ, plan=pro, KHÔNG có claim `rk`
# ⇒ mọi request khuôn bế đều 422 với thông báo sai hướng.
#
# Tiền tố dưới đây là hợp đồng với `native/src/dieline_license.rs` +
# `native/src/dieline_engine.rs`. Đổi thông điệp bên Rust phải sửa cả đây
# (test `test_dieline_error_classification.py` khoá điều này).
_ENGINE_LOCKED_PREFIXES = (
    "Dieline engine is locked",
    "Dieline engine could not be unlocked",
    "Dieline engine key is invalid",
)
_ENTITLEMENT_PREFIXES = (
    "Dieline entitlement credentials are required",
    "Malformed license token",
    "Invalid license token signature",
    "License signature has invalid length",
    "License token",
    "Embedded license key",
    "Feature 'packaging.dieline'",
    "Malformed resource key",
    "Resource key has invalid length",
    "System clock is invalid",
)
# Payload engine bị hỏng/sai định dạng = lỗi ĐÓNG GÓI, không phải thông số cũng
# không phải bản quyền. Trả 500 để ops thấy đúng bản chất thay vì đổ cho người dùng.
_PAYLOAD_BROKEN_PREFIXES = (
    "Dieline engine payload",
)
_TOO_LARGE_PREFIXES = (
    "Dieline request is too large",
    "Dieline result is too large",
)


def _classify_native_failure(message: str) -> HTTPException:
    """Ánh xạ thông điệp lỗi của sidecar native sang HTTP status + câu tiếng Việt.

    Nguyên tắc: chỉ lỗi THẬT SỰ do thông số mới được trả 422. Lỗi bản quyền /
    mở khoá engine phải trả 403 kèm hướng xử lý, vì bấm "Thử lại" hay sửa số đo
    đều không bao giờ giải quyết được.
    """
    if message.startswith(_ENGINE_LOCKED_PREFIXES):
        logger.error("Dieline engine could not be unlocked for this license")
        return HTTPException(
            status_code=403,
            detail=(
                "Bản quyền hiện tại chưa mở được bộ máy khuôn bế. "
                "Hãy đăng xuất rồi đăng nhập lại để làm mới bản quyền; "
                "nếu vẫn lỗi, liên hệ hỗ trợ kèm phiên bản đang dùng."
            ),
        )
    if message.startswith(_ENTITLEMENT_PREFIXES):
        logger.error("Dieline entitlement rejected by the native engine")
        return HTTPException(
            status_code=403,
            detail=(
                "Bản quyền khuôn bế không hợp lệ hoặc đã hết hạn. "
                "Hãy đăng nhập lại để cấp lại bản quyền."
            ),
        )
    if message.startswith(_PAYLOAD_BROKEN_PREFIXES):
        logger.error("Dieline engine payload is not usable in this build")
        return HTTPException(
            status_code=500,
            detail="Bộ máy khuôn bế trong bản này bị lỗi đóng gói. Hãy cài lại phiên bản mới nhất.",
        )
    if message.startswith(_TOO_LARGE_PREFIXES):
        return HTTPException(status_code=413, detail="Khuôn vượt giới hạn dữ liệu cho phép.")
    logger.exception("Native dieline generation failed")
    return HTTPException(status_code=422, detail="Không thể tạo khuôn với thông số này.")


def _generate_native(request_json: str, license_token: str, hwid: str, license_key: str) -> str:
    try:
        import pdfcompare_native  # type: ignore
    except ImportError as exc:
        raise RuntimeError("native_engine_unavailable") from exc
    return pdfcompare_native.generate_dieline_json(request_json, license_token, hwid, license_key)


def _warm_native_engine() -> None:
    """Warm only the parser/runtime; generation remains license-gated."""
    try:
        import pdfcompare_native  # type: ignore
        pdfcompare_native.warm_dieline_engine()
    except ImportError:
        # Source-only backend tests and unbuilt dev environments have no native module.
        return
    except Exception:
        logger.warning("Could not warm the native dieline engine", exc_info=True)


# Queue warmup on the same thread used for all later engine calls.
_DIELINE_EXECUTOR.submit(_warm_native_engine)


# [DIELINE-ENGINE-STATUS 2026-08-26 §G] Phát hiện sớm engine bị khoá.
#
# Vì sao cần: `warm_dieline_engine` CỐ Ý no-op ở bản đã khoá (chưa có token thì chưa
# có khoá, và warmup không được log lỗi mỗi lần khởi động), nên trước đây trạng thái
# "engine bị khoá" chỉ lộ ra khi người dùng đã bấm tạo khuôn rồi nhận 403. Endpoint
# dưới đây là đường CHỈ-ĐỌC để công cụ khuôn bế biết trước và hiện banner đúng bản
# chất. Nó KHÔNG bao giờ thử giải mã và KHÔNG đụng `warm_dieline_engine`.
#
# Ranh giới bí mật (Property 4 của spec): chỉ trả về hai boolean. Không giá trị khoá
# `rk`, không token, không license key — kể cả trong log.
_RESOURCE_KEY_CLAIM = "rk"


def _engine_status_native() -> dict[str, Any]:
    """Đọc trạng thái payload engine từ sidecar native.

    Không nhận credentials, không giải mã. Ném `ImportError` khi chưa build native và
    `AttributeError` với wheel cũ chưa có hàm trạng thái — cả hai được `_engine_locked()`
    xử lý thành "không xác định".
    """
    import pdfcompare_native  # type: ignore

    return dict(pdfcompare_native.dieline_engine_status())


def _engine_locked() -> bool:
    """`True` khi bản này cần khoá `rk` mới nạp được engine khuôn bế.

    Không xác định được (native chưa build trong vòng dev, hoặc wheel cũ chưa có hàm
    trạng thái) ⇒ trả `False`: banner phát hiện sớm chỉ được hiện khi CHẮC CHẮN engine
    đã khoá, để không báo động sai.
    """
    try:
        return bool(_engine_status_native().get("locked", False))
    except (ImportError, AttributeError, TypeError, ValueError):
        return False


def _token_has_resource_key(license_token: str) -> bool:
    """Token của CHÍNH request này có claim `rk` hay không — chỉ trạng thái có/không.

    Token đã qua verify chữ ký Ed25519 + `exp` + `m` + `k` + `p` ở `require_license`
    trước khi tới đây, nên ở đây chỉ đọc TÊN claim. Không bao giờ trả, log hay so sánh
    GIÁ TRỊ khoá.
    """
    if not license_token or "." not in license_token:
        return False
    payload_b64 = license_token.split(".", 1)[0]
    try:
        raw = base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4))
        payload = json.loads(raw)
    except (ValueError, TypeError, binascii.Error, UnicodeDecodeError):
        return False
    if not isinstance(payload, dict):
        return False
    resource_key = payload.get(_RESOURCE_KEY_CLAIM)
    return isinstance(resource_key, str) and bool(resource_key)


@router.get("/engine-status")
async def get_dieline_engine_status(
    license_info: dict = Depends(require_feature("packaging.dieline")),
) -> dict[str, bool]:
    """Trạng thái bộ máy khuôn bế: đã khoá chưa, và token hiện tại có khoá mở chưa.

    LUÔN trả 200 — đây là truy vấn trạng thái, không phải tính năng bị gate, nên không
    bao giờ trả 403 vì lý do engine bị khoá. Endpoint nằm CÙNG router nên vẫn thừa hưởng
    `require_feature("packaging.dieline")`: người dùng Free vẫn bị từ chối ở tầng
    entitlement như cũ và không cần banner này.

    Chạy thẳng trên event loop, KHÔNG qua `_DIELINE_EXECUTOR`: hàm native chỉ đọc header
    payload đã nhúng (không giải mã, không chạm Boa, không chạm PDFium nên không cần
    `pdfium_guard()`). Đưa vào executor một-worker sẽ khiến truy vấn trạng thái phải xếp
    hàng sau một lượt tạo khuôn dài — mất đúng mục đích "biết sớm".
    """
    return {
        "locked": _engine_locked(),
        "license_key_present": _token_has_resource_key(
            str(license_info.get("license_token") or "")
        ),
    }


@router.post("/generate")
async def generate_dieline(body: dict[str, Any], license_info: dict = Depends(require_feature("packaging.dieline"))) -> dict[str, Any]:
    """Generate preview and nesting in the native sidecar.

    The route is the authority for both preview and export data. The WebView
    never imports the generator implementation in the production bundle.
    """
    validate_dieline_body(body)

    request_json = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    if len(request_json.encode("utf-8")) > _MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="Dữ liệu tạo khuôn quá lớn.")

    try:
        loop = asyncio.get_running_loop()
        raw_result = await loop.run_in_executor(
            _DIELINE_EXECUTOR,
            _generate_native,
            request_json,
            str(license_info.get("license_token") or ""),
            str(license_info.get("hwid") or ""),
            str(license_info.get("license_key") or ""),
        )
        result = json.loads(raw_result)
    except RuntimeError as exc:
        message = str(exc)
        if message == "native_engine_unavailable":
            logger.error("Native dieline engine is not installed")
            raise HTTPException(status_code=503, detail="Bộ máy tạo khuôn chưa sẵn sàng.") from exc
        raise _classify_native_failure(message) from exc
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.exception("Native dieline engine returned invalid data")
        raise HTTPException(status_code=500, detail="Kết quả tạo khuôn không hợp lệ.") from exc

    if not isinstance(result, dict) or not isinstance(result.get("dieline"), dict):
        raise HTTPException(status_code=500, detail="Kết quả tạo khuôn không đầy đủ.")
    return result
