"""
FastAPI application entry point.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import engine, Base
from app.api.routes import upload, compare, results, ws, qc

# ── Logging ──
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
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

    yield

    # Shutdown
    if getattr(app.state, "cleanup_task", None):
        app.state.cleanup_task.cancel()  # Application runs here

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
from app.api.routes import system, imposition, preflight, vdp, pdf_tools
app.include_router(system.router, prefix="/api", tags=["System"])
app.include_router(imposition.router, prefix="/api", tags=["Imposition"])
app.include_router(preflight.router, prefix="/api", tags=["Preflight"])
app.include_router(vdp.router, prefix="/api/vdp", tags=["VDP"])
app.include_router(pdf_tools.router, prefix="/api", tags=["PDF Tools"])
app.include_router(ws.router, tags=["WebSocket"])


@app.get("/health")
def health_check():
    return {"status": "ok", "app": settings.APP_NAME}
