"""Protected packaging dieline engine routes."""
from __future__ import annotations

import asyncio
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
        if str(exc) == "native_engine_unavailable":
            logger.error("Native dieline engine is not installed")
            raise HTTPException(status_code=503, detail="Bộ máy tạo khuôn chưa sẵn sàng.") from exc
        logger.exception("Native dieline generation failed")
        raise HTTPException(status_code=422, detail="Không thể tạo khuôn với thông số này.") from exc
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        logger.exception("Native dieline engine returned invalid data")
        raise HTTPException(status_code=500, detail="Kết quả tạo khuôn không hợp lệ.") from exc

    if not isinstance(result, dict) or not isinstance(result.get("dieline"), dict):
        raise HTTPException(status_code=500, detail="Kết quả tạo khuôn không đầy đủ.")
    return result
