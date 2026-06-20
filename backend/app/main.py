"""
FastAPI application entry point.
"""
import logging
import os
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import engine, Base
from app.api.routes import upload, compare, results, ws, qc

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
    if settings.DEV_MODE:
        logger.warning(
            "⚠️  [SECURITY] DEV_MODE=ON — license token/signature checks are DISABLED. "
            "Do NOT ship a build with DEV_MODE enabled."
        )
    else:
        from app.core.license_guard import _SIDECAR_TOKEN
        if not _SIDECAR_TOKEN:
            logger.error(
                "⛔ [SECURITY] DEV_MODE=OFF but sidecar token is MISSING — all API requests "
                "will be rejected (403). The Tauri host must pass the token via stdin/PRYNX_TOKEN_FILE."
            )
        else:
            logger.info("🔒 [SECURITY] DEV_MODE=OFF, sidecar token loaded — guard active.")

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

    yield

    # Shutdown
    if getattr(app.state, "cleanup_task", None):
        app.state.cleanup_task.cancel()  # Application runs here
    if getattr(app.state, "edit_session_sweep_task", None):
        app.state.edit_session_sweep_task.cancel()

    # Shutdown (cleanup if needed)
    logger.info(f"👋 {settings.APP_NAME} shutting down")


# ── Create App ──
app = FastAPI(
    title=settings.APP_NAME,
    description="Print made easy!",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
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
        "X-Sticker-Shape-Type", "X-Sticker-Shape-Params", "X-Sticker-Pages"
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

# ── Static files (serve results images) ──
results_path = Path(settings.RESULTS_DIR)
results_path.mkdir(parents=True, exist_ok=True)
app.mount("/results", StaticFiles(directory=str(results_path)), name="results")

app.include_router(upload.router, prefix="/api", tags=["Upload"])
app.include_router(compare.router, prefix="/api", tags=["Compare"])
app.include_router(results.router, prefix="/api", tags=["Results"])
app.include_router(qc.router, prefix="/api", tags=["QC"])
from app.api.routes import system, imposition, preflight, vdp, pdf_tools, edit, export
app.include_router(system.router, prefix="/api", tags=["System"])
app.include_router(imposition.router, prefix="/api", tags=["Imposition"])
app.include_router(preflight.router, prefix="/api", tags=["Preflight"])
app.include_router(vdp.router, prefix="/api/vdp", tags=["VDP"])
app.include_router(pdf_tools.router, prefix="/api", tags=["PDF Tools"])
app.include_router(edit.router, prefix="/api", tags=["Edit"])
app.include_router(export.router, prefix="/api", tags=["Export"])
app.include_router(ws.router, tags=["WebSocket"])

# Cut Export (spec: gui-may-be) — module độc lập backend/app/workers/cut_export
from app.workers.cut_export.api import router as cut_export_router
app.include_router(cut_export_router, prefix="/api", tags=["Cut Export"])


@app.get("/health")
def health_check():
    return {"status": "ok", "app": settings.APP_NAME}


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

    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8321)
    parser.add_argument("--host", default="127.0.0.1")
    args, _ = parser.parse_known_args()

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
