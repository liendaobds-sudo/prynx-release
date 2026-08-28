"""
FastAPI application entry point.
"""
import hashlib
import hmac
import logging
import os
import re
import sys
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

# BUILD (audit 2026-08-03 REL.10): run the frozen-artifact self-test before
# FastAPI/database/config imports. The verifier intentionally strips publisher
# credentials, so this path must not need a server token or create/bind a DB.
if __name__ == "__main__" and "--artifact-self-test" in sys.argv[1:]:
    import json as _json

    from app.core.artifact_runtime_self_test import (
        SELF_TEST_MARKER as _SELF_TEST_MARKER,
        run_artifact_runtime_self_test as _run_artifact_runtime_self_test,
    )

    try:
        _payload = _run_artifact_runtime_self_test()
        _exit_code = 0
    except Exception as _exc:  # Khong in detail/path nhay cam tu frozen runtime.
        _payload = {"status": "error", "error": type(_exc).__name__}
        _exit_code = 70
    print(
        _SELF_TEST_MARKER + _json.dumps(_payload, ensure_ascii=True, separators=(",", ":")),
        flush=True,
    )
    raise SystemExit(_exit_code)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import PlainTextResponse

from app.config import settings
from app.database import engine, Base
from app.api.routes import upload, compare, results, ws, qc, logo_rebuild
from app.core.license_guard import verify_result_access

# ── Logging ──
# stdout (dev/console) + file xoay vòng (production: stdout mất khi process die).
_LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
logging.basicConfig(level=logging.INFO, format=_LOG_FORMAT)


def _attach_file_log() -> None:
    """Gắn RotatingFileHandler vào %APPDATA%/PrynX/logs/app.log (best-effort).

    Cùng thư mục với security.log để ops gom 1 chỗ. Lỗi setup KHÔNG được làm
    chết startup → nuốt, vẫn còn stdout.
    """
    try:
        base = os.environ.get("APPDATA") or os.environ.get("HOME") or os.path.expanduser("~")
        log_dir = os.path.join(base, "PrynX", "logs")
        os.makedirs(log_dir, exist_ok=True)
        handler = RotatingFileHandler(
            os.path.join(log_dir, "app.log"),
            maxBytes=5 * 1024 * 1024,  # 5 MB / file
            backupCount=5,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter(_LOG_FORMAT))
        handler.setLevel(logging.INFO)
        logging.getLogger().addHandler(handler)
    except Exception:  # pragma: no cover - best-effort, không chặn startup
        logging.getLogger(__name__).warning("Không gắn được file log, chỉ dùng stdout", exc_info=True)


_attach_file_log()
logger = logging.getLogger(__name__)


# ── Lifespan (replaces deprecated @app.on_event) ──
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application startup and shutdown lifecycle."""
    # Startup
    Base.metadata.create_all(bind=engine)
    logger.info(f"🚀 PrynX Core started")
    logger.info(f"📁 Upload dir: {settings.UPLOAD_DIR}")
    logger.info(f"📁 Results dir: {settings.RESULTS_DIR}")

    # ── SECURITY: cảnh báo trạng thái guard ──
    # DEV_MODE bỏ qua kiểm tra token + chữ ký → CHỈ dùng khi phát triển cục bộ.
    # Bản đóng gói (Tauri) phải spawn sidecar với env DEV_MODE=false.
    # AUDIT 2026-07-26: PHẢI đọc `license_guard._is_dev_mode()`, KHÔNG đọc
    # `settings.DEV_MODE`. Trên BINARY compiled, `_is_dev_mode()` luôn False (cờ Nuitka
    # `__compiled__`) nên guard vẫn cưỡng chế dù .env có DEV_MODE=true — trong khi dòng
    # log cũ lại tuyên bố "checks are DISABLED". Đã tái lập trên bản đã cài: log nói
    # DISABLED nhưng /api/system/gpu-status trả 403. Log sai posture làm lệch hướng
    # điều tra sự cố (§15.6), nên lấy đúng nguồn chân lý mà guard dùng.
    from app.core.license_guard import _is_dev_mode as _guard_is_dev_mode

    if _guard_is_dev_mode():
        logger.warning(
            "⚠️  [SECURITY] DEV_MODE=ON — license token/signature checks are DISABLED. "
            "Do NOT ship a build with DEV_MODE enabled."
        )
    else:
        if settings.DEV_MODE:
            logger.warning(
                "🔒 [SECURITY] DEV_MODE=true trong cấu hình nhưng đang chạy BINARY "
                "compiled → bị BỎ QUA (fail-closed): token/chữ ký VẪN được cưỡng chế."
            )
        from app.core.license_guard import _SIDECAR_TOKEN
        if not _SIDECAR_TOKEN:
            logger.error(
                "⛔ [SECURITY] DEV_MODE=OFF but sidecar token is MISSING — all API requests "
                "will be rejected (403). The Tauri host must pass the token via stdin/PRYNX_TOKEN_FILE."
            )
        else:
            logger.debug("🔒 [SECURITY] DEV_MODE=OFF, sidecar token loaded — guard active.")

    # [PROC-LIFECYCLE FIX 2026-08-28 §UP.11] Dọn tiến trình Office mồ côi từ phiên trước.
    # Word/Excel do COM tạo không phải con của sidecar nên không cây process nào — kể cả Job
    # Object của app — dọn được chúng; nếu sidecar bị taskkill /F giữa job Office thì chúng
    # sống mãi. File *.owned-pids sót lại là dấu vết duy nhất, và sweep chỉ diệt PID có image
    # name trong whitelist Office để không giết oan tiến trình người dùng đang mở.
    try:
        from app.core.office_job_runner import sweep_orphan_office_pids

        orphans_killed = sweep_orphan_office_pids(settings.RESULTS_DIR, settings.UPLOAD_DIR)
        if orphans_killed:
            logger.warning(
                "🧹 Đã dọn %s tiến trình Office mồ côi từ phiên trước.", orphans_killed
            )
    except Exception as exc:  # noqa: BLE001 — dọn rác không được chặn khởi động backend
        logger.warning("Không quét được tiến trình Office mồ côi: %s", exc)

    # Notice: Job recovery is now handled via the POST /api/system/recover-jobs endpoint.
    logger.info("ℹ️ System ready. Use /api/system/recover-jobs to handle stuck jobs.")

    # Start background cleanup task
    import asyncio
    from app.core.cleanup import cleanup_expired_files_loop
    app.state.cleanup_task = asyncio.create_task(cleanup_expired_files_loop())

    # Background sweep dọn Edit_Session quá SESSION_TTL (Yêu cầu 9.4):
    # lazy sweep (get_session) đã dọn khi CÓ truy cập, nhưng nếu người dùng bỏ
    # phiên giữa chừng (không gọi close) thì Live_Document còn treo RAM tới khi có
    # request mới. Vòng nền quét định kỳ mỗi ~5 phút bảo đảm RAM được giải phóng
    # kể cả khi backend nhàn rỗi (file lớn → chống rò RAM).
    from app.core import edit_session

    async def _edit_session_sweep_loop():
        SWEEP_INTERVAL_SECONDS = 300  # ~5 phút
        while True:
            try:
                await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
                swept = await asyncio.to_thread(edit_session.sweep_expired)
                if swept:
                    logger.info("🧹 Background sweep: dọn %d Edit_Session quá hạn TTL.", swept)
            except asyncio.CancelledError:
                logger.info("Edit_Session sweep task cancelled.")
                break
            except Exception as e:  # noqa: BLE001 - không để lỗi 1 vòng giết task
                logger.error(f"Error in Edit_Session sweep task: {e}")

    app.state.edit_session_sweep_task = asyncio.create_task(_edit_session_sweep_loop())

    # PERF (audit 2026-08-09 §L2C): frontend có DELETE khi đóng tab/file;
    # vòng nền này là lưới an toàn cho WebView crash/mất kết nối. Chỉ
    # có một task monotonic, không tạo Timer/thread theo từng lần zoom.
    from app.core.ppe_viewer_session import viewer_session_manager

    async def _ppe_viewer_session_sweep_loop():
        while True:
            try:
                await asyncio.sleep(30)
                swept = await viewer_session_manager.sweep_orphans()
                if swept:
                    logger.info("🧹 Dọn %d owner PPE ViewerSession hết TTL.", swept)
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001 - không để một vòng giết sweeper
                logger.warning("Không quét được PPE ViewerSession: %s", exc)

    app.state.ppe_viewer_session_sweep_task = asyncio.create_task(
        _ppe_viewer_session_sweep_loop()
    )

    # ── Bình lồng ghép tự do: root artifact riêng + sweep định kỳ (kế hoạch 2026-08-26 §12.4) ──
    #
    # Root không an toàn thì **chỉ tính năng này** tắt, KHÔNG làm sập sidecar: mọi tính năng
    # khác không liên quan gì tới root này, và đánh sập cả app vì một biến môi trường sai là
    # phản ứng quá mức.
    from app.core.mixed_nesting_artifacts import ArtifactRootUnsafe, artifact_store

    app.state.mixed_nesting_artifacts_ready = False
    try:
        _mn_store = artifact_store()
        await asyncio.to_thread(_mn_store.ensure_root)
        _mn_orphans = await asyncio.to_thread(_mn_store.sweep_orphan_files)
        app.state.mixed_nesting_artifacts_ready = True
        if _mn_orphans:
            logger.info(
                "🧹 Bình lồng ghép: dọn %d file xuất mồ côi từ lần chạy trước.", _mn_orphans
            )
    except ArtifactRootUnsafe as exc:
        logger.error(
            "⛔ [MIXED-NESTING] Root lưu file xuất không an toàn nên tính năng bị tắt: %s", exc
        )
    except Exception as exc:  # noqa: BLE001 - lỗi I/O không được giết startup
        logger.error("⛔ [MIXED-NESTING] Không dựng được root lưu file xuất: %s", exc)

    async def _mixed_nesting_sweep_loop():
        # 10 phút: TTL artifact là 2 giờ nên quét dày hơn không có ích, còn quét thưa hơn thì
        # file đã hết hạn nằm lại quá lâu trên máy thợ in.
        SWEEP_INTERVAL_SECONDS = 600
        while True:
            try:
                await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
                from app.core.mixed_nesting_artifacts import artifact_store as _store

                swept = await asyncio.to_thread(_store().sweep_now)
                if swept:
                    logger.info("🧹 Bình lồng ghép: dọn %d file xuất hết TTL.", swept)
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001 - không để một vòng giết sweeper
                logger.warning("Không quét được file xuất Bình lồng ghép: %s", exc)

    app.state.mixed_nesting_sweep_task = asyncio.create_task(_mixed_nesting_sweep_loop())

    try:
        yield
    finally:
        # Registry Bình lồng ghép tự do có sweeper thread + executor riêng (kế hoạch
        # 2026-08-26 §12.4). Không đóng tường minh thì thread nền sống qua shutdown và
        # job đang chạy giữ luôn suất whole-machine của scheduler.
        mn_sweep_task = getattr(app.state, "mixed_nesting_sweep_task", None)
        if mn_sweep_task:
            mn_sweep_task.cancel()
            await asyncio.gather(mn_sweep_task, return_exceptions=True)
        try:
            from app.core.mixed_nesting_jobs import mixed_nesting_jobs

            await asyncio.to_thread(mixed_nesting_jobs.close)
        except Exception as exc:  # noqa: BLE001 - shutdown không được vì một lỗi mà treo
            logger.warning("Không đóng được registry Bình lồng ghép: %s", exc)
        try:
            # Khuôn đã nhập chỉ nằm trong RAM (không ghi file, xem P12), nên dọn là xoá dict.
            from app.workers.mixed_nesting_pdf_source import mixed_nesting_sources

            mixed_nesting_sources.clear()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Không dọn được khuôn đã nhập Bình lồng ghép: %s", exc)
        if getattr(app.state, "mixed_nesting_artifacts_ready", False):
            try:
                from app.core.mixed_nesting_artifacts import artifact_store as _store

                await asyncio.to_thread(_store().close)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Không dọn được file xuất Bình lồng ghép: %s", exc)
        # Shutdown phải chạy cả khi lifespan bị exception/cancel; nếu
        # để sau `yield` trần, native session/cache có thể bị bỏ lại.
        if getattr(app.state, "cleanup_task", None):
            app.state.cleanup_task.cancel()  # Application runs here
        if getattr(app.state, "edit_session_sweep_task", None):
            app.state.edit_session_sweep_task.cancel()
        ppe_sweep_task = getattr(app.state, "ppe_viewer_session_sweep_task", None)
        if ppe_sweep_task:
            ppe_sweep_task.cancel()
            await asyncio.gather(ppe_sweep_task, return_exceptions=True)
        # close() native có thể chờ render cuối; manager tự đẩy việc
        # đó ra worker, không chặn event loop shutdown.
        await viewer_session_manager.close_all()

        logger.info(f"👋 {settings.APP_NAME} shutting down")


# ── OpenAPI docs: CHỈ bật khi chạy từ source (dev) ──
# SECURITY (audit 2026-07-25): /docs, /redoc và /openapi.json là các endpoint DUY NHẤT
# dưới quyền app mà license guard KHÔNG che (guard gắn ở router, không gắn cho schema).
# Trên bản đóng gói chúng đưa cho kẻ trinh sát BẢN ĐỒ API đầy đủ (mọi path + schema
# body) — đúng thứ cần để dò tìm endpoint hở. Dev chạy Python thông dịch vẫn có docs
# như cũ; binary compiled (Nuitka `__compiled__` / PyInstaller `sys.frozen`) thì tắt.
# Dùng cùng cờ với license_guard._is_dev_mode để không thể bật lại bằng env.
def _running_as_compiled_binary() -> bool:
    import sys as _sys
    return "__compiled__" in globals() or getattr(_sys, "frozen", False)


_DOCS_ENABLED = not _running_as_compiled_binary()

# ── Create App ──
app = FastAPI(
    title=settings.APP_NAME,
    description="Print made easy!",
    version="1.0.0",
    docs_url="/docs" if _DOCS_ENABLED else None,
    redoc_url="/redoc" if _DOCS_ENABLED else None,
    openapi_url="/openapi.json" if _DOCS_ENABLED else None,
    lifespan=lifespan,
)

# ── CORS (SECURITY: restricted to Tauri webview + dev server only) ──
# LƯU Ý: danh sách dưới đây là NGUỒN CHÂN LÝ cho sidecar desktop (cố ý giới hạn hẹp).
# settings.CORS_ORIGINS (config.py / .env / docker-compose) CHỈ dùng cho deployment web/docker
# cũ — KHÔNG dùng ở đây để tránh vô tình nới rộng origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://tauri.localhost",     # Tauri production webview
        "https://tauri.localhost",    # Tauri production webview (https)
        "http://localhost:5173",      # Vite dev server
        "http://localhost",           # Fallback
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-OCR-Total-Pages", "X-OCR-Pages-With-Text", "X-OCR-Total-Words",
        "X-Original-Size", "X-Output-Size", "X-Compression-Ratio",
        "X-Sticker-Width-MM", "X-Sticker-Height-MM", "X-Sticker-Boxes",
        "X-Sticker-Shape-Type", "X-Sticker-Shape-Params", "X-Sticker-Pages",
        "X-Sticker-Cut-Kind", "X-Sticker-Cut-Confidence", "X-Sticker-Warning",
        "X-Sticker-Output-Path", "X-Sticker-Sheet-Count", "Content-Disposition",
        "X-Upscale-Output-Size", "X-Upscale-Warnings", "X-Upscale-Working-Pdf-Path",
        "X-Upscale-Artifact-Lease",
    ],
)

# ── Hide Server Headers (Security) ──
@app.middleware("http")
async def hide_server_header(request, call_next):
    response = await call_next(request)
    if "server" in response.headers:
        del response.headers["server"]
    if "x-powered-by" in response.headers:
        del response.headers["x-powered-by"]
    return response

@app.middleware("http")
async def protect_result_artifacts(request, call_next):
    path = request.url.path
    if path.startswith("/results/"):
        signature = request.query_params.get("access", "")
        if not verify_result_access(path, signature):
            return PlainTextResponse("Forbidden", status_code=403)
    return await call_next(request)

# ── Static files (serve results images) ──
results_path = Path(settings.RESULTS_DIR)
results_path.mkdir(parents=True, exist_ok=True)
app.mount("/results", StaticFiles(directory=str(results_path)), name="results")

app.include_router(upload.router, prefix="/api", tags=["Upload"])
app.include_router(compare.router, prefix="/api", tags=["Compare"])
app.include_router(results.router, prefix="/api", tags=["Results"])
app.include_router(qc.router, prefix="/api", tags=["QC"])
app.include_router(logo_rebuild.router, prefix="/api", tags=["Logo Rebuild"])
from app.api.routes import system, imposition, document_tools, preflight, vdp, pdf_tools, sticker_sheet, office_convert, edit, export, dieline, document_cleanup, mixed_nesting
app.include_router(system.router, prefix="/api", tags=["System"])
app.include_router(imposition.router, prefix="/api", tags=["Imposition"])
app.include_router(document_tools.router, prefix="/api", tags=["Document Tools"])
app.include_router(preflight.router, prefix="/api", tags=["Preflight"])
app.include_router(vdp.router, prefix="/api/vdp", tags=["VDP"])
app.include_router(pdf_tools.router, prefix="/api", tags=["PDF Tools"])
app.include_router(sticker_sheet.router, prefix="/api", tags=["Sticker Sheet"])
app.include_router(office_convert.router, prefix="/api", tags=["Office Convert"])
app.include_router(edit.router, prefix="/api", tags=["Edit"])
app.include_router(export.router, prefix="/api", tags=["Export"])
app.include_router(dieline.router, prefix="/api", tags=["Dieline"])
app.include_router(document_cleanup.router, prefix="/api", tags=["Document Cleanup"])
# AppTool standalone: CỐ Ý không thuộc họ Imposition, có capability và registry job riêng
# (kế hoạch 2026-08-26 §7). Route chỉ reachable khi cờ PRYNX_MIXED_NESTING_ENABLED bật.
app.include_router(mixed_nesting.router, prefix="/api", tags=["Mixed Nesting"])
app.include_router(ws.router, tags=["WebSocket"])

# Cut Export (spec: gui-may-be) — module độc lập backend/app/workers/cut_export
from app.workers.cut_export.api import router as cut_export_router
app.include_router(cut_export_router, prefix="/api", tags=["Cut Export"])


@app.get("/health")
def health_check(challenge: str = ""):
    response = {"status": "ok", "app": settings.APP_NAME}
    if challenge:
        if not re.fullmatch(r"[0-9a-f]{64}", challenge):
            raise HTTPException(status_code=400, detail="Invalid health challenge")
        from app.core.license_guard import _SIDECAR_TOKEN
        if not _SIDECAR_TOKEN:
            raise HTTPException(status_code=503, detail="Sidecar identity is not initialized")
        response["proof"] = hmac.new(
            _SIDECAR_TOKEN.encode(),
            f"startup:{challenge}".encode(),
            hashlib.sha256,
        ).hexdigest()
    return response


# ── Entry point cho bản đóng gói (Nuitka sidecar) ──
# Dev dùng `python -m uvicorn app.main:app --port 8321` (run_dev.bat) nên không cần
# khối này; nhưng exe Nuitka biên dịch app/main.py PHẢI tự khởi động uvicorn ở đây,
# nếu không sidecar chỉ định nghĩa `app` rồi thoát (backend không phục vụ → app chết).
if __name__ == "__main__":
    import argparse
    import multiprocessing

    # BẮT BUỘC cho multiprocessing dưới Nuitka/onefile trên Windows: tiến trình con
    # (ProcessPoolExecutor cho bình trang/VDP/preflight + multiprocessing.Process)
    # re-launch exe; freeze_support() đảm bảo con chạy worker thay vì khởi động lại server.
    multiprocessing.freeze_support()

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8321)
    parser.add_argument("--host", default="127.0.0.1")
    args, _ = parser.parse_known_args()

    import uvicorn

    # ── Lưới an toàn: port đã bị chiếm (zombie sidecar phiên trước) ──
    # Tauri host (lib.rs) đã kill zombie theo tên + chờ port free TRƯỚC khi spawn
    # con này. Đây là lớp phòng hờ khi kill đó thất bại (AV chặn taskkill / port
    # chưa nhả kịp): thử bind vài lần cho zombie thêm thời gian nhả, nếu vẫn kẹt
    # thì LOG RÕ + exit 48 (không crash câm như `uvicorn.run` trần trước đây —
    # bind fail raise sâu trong event loop, _rx bị vứt nên không để lại dấu vết,
    # khiến sự cố "invalid sidecar token" khó điều tra). exit 48 gợi EADDRINUSE.
    import errno
    import socket as _socket
    import sys as _sys
    import time as _time

    _bind_ok = False
    for _attempt in range(3):
        _test = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        try:
            _test.bind((args.host, args.port))
            _bind_ok = True
            break
        except OSError as _e:
            _in_use = getattr(_e, "winerror", None) == 10048 or _e.errno == errno.EADDRINUSE
            if not _in_use:
                raise  # lỗi OSError khác (vd host sai) → không nuốt
            _time.sleep(0.5)
        finally:
            _test.close()

    if not _bind_ok:
        logger.critical(
            "[STARTUP] Port %d already in use — likely a zombie sidecar from a "
            "crashed session still holding the port. New sidecar cannot bind and "
            "will exit (code 48).", args.port,
        )
        _sys.exit(48)

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
