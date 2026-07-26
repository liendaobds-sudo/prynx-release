"""
Application configuration loaded from environment variables.
"""
import os
import shutil
from pathlib import Path
from pydantic_settings import BaseSettings


def _find_ghostscript() -> str:
    """Auto-discover Ghostscript executable.
    
    Priority:
    1. GHOSTSCRIPT_PATH env var (explicit override)
    2. shutil.which() — finds gswin64c on system PATH
    3. Common install locations (sorted newest-first)
    4. Hardcoded fallback
    """
    # 1. Explicit env var
    env_gs = os.environ.get("GHOSTSCRIPT_PATH", "")
    if env_gs and os.path.isfile(env_gs):
        return env_gs
    
    # 2. Bundled sidecar path (Tauri resource). Tauri bundles under "binaries/",
    #    dev/standalone có thể nằm cạnh exe → thử cả hai.
    import sys
    _exe_dir = Path(sys.executable).parent
    for _cand in (
        _exe_dir / "binaries" / "gs" / "bin" / "gswin64c.exe",
        _exe_dir / "gs" / "bin" / "gswin64c.exe",
    ):
        if _cand.is_file():
            return str(_cand)

    # 3. System PATH
    found = shutil.which("gswin64c") or shutil.which("gswin32c") or shutil.which("gs")
    if found:
        return found
    
    # 3. Scan common install dirs (newest version first)
    gs_base = Path(r"C:\Program Files\gs")
    if gs_base.is_dir():
        candidates = sorted(gs_base.glob("gs*/bin/gswin64c.exe"), reverse=True)
        if candidates:
            return str(candidates[0])
    
    # 4. Hardcoded fallback (original default)
    return r"C:\Program Files\gs\gs10.04.0\bin\gswin64c.exe"


class Settings(BaseSettings):
    # Application
    APP_NAME: str = "PrynX Core"
    DEBUG: bool = False
    # F3 FIX: fail-CLOSED mặc định. DEV_MODE=on tắt token+chữ ký guard nên phải bật
    # CÓ CHỦ Ý (dev đặt qua backend/.env: DEV_MODE=true). Release: lib.rs spawn sidecar
    # với env DEV_MODE=false + _is_dev_mode() trả False khi binary đã compile (__compiled__).
    # DB vẫn dùng SQLite ở release nhờ IS_DESKTOP_APP (PRYNX_TOKEN_SOURCE=stdin), không phụ thuộc cờ này.
    DEV_MODE: bool = False
    IS_DESKTOP_APP: bool = os.environ.get("PRYNX_TOKEN_SOURCE") == "stdin"

    # Database
    DATABASE_URL: str = os.environ.get("DATABASE_URL", "")

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"

    # File storage
    UPLOAD_DIR: str = str(Path("./uploads").resolve())
    RESULTS_DIR: str = str(Path("./results").resolve())
    MAX_FILE_SIZE_MB: int = 500

    # PDF Processing
    DEFAULT_DPI: int = 300
    PREVIEW_DPI: int = 150

    # Preflight & Auto-Fix Engine
    GHOSTSCRIPT_PATH: str = _find_ghostscript()
    PRYNX_PRINT_ENGINE: str = "auto"  # auto | ppe | gs
    PRYNX_ALLOW_GS_FALLBACK: bool = True
    PRYNX_FORCE_GS: bool = False
    PRYNX_PPE_MEMORY_BUDGET_MB: int = 512
    ICC_PROFILE_DIR: str = str(Path("./app/assets/icc").resolve())
    DEFAULT_CMYK_PROFILE: str = "FOGRA39.icc"

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:80"]

    class Config:
        env_file = ".env"
        extra = "allow"


settings = Settings()

# Chuẩn hoá thư mục lưu trữ về đường dẫn TUYỆT ĐỐI.
# LÝ DO: path output trả về frontend được Rust native renderer (tile.localhost /
# get_pdf_metadata) mở, mà tiến trình Rust có cwd KHÁC backend. Nếu path tương đối
# ("./results/...", do .env override) → Rust báo "cannot find path" (os error 3)
# → render hỏng (ảnh vỡ) dù Python vẫn mở được. Ép tuyệt đối ở đây vá cho TẤT CẢ
# tính năng (vdp, imposition, preflight, separations, pdfx, layer, ...).
settings.UPLOAD_DIR = os.path.abspath(settings.UPLOAD_DIR)
settings.RESULTS_DIR = os.path.abspath(settings.RESULTS_DIR)

# DEV_MODE or IS_DESKTOP_APP: override DB to SQLite (Desktop app must use SQLite)
if settings.DEV_MODE or settings.IS_DESKTOP_APP:
    db_path = Path("./data").resolve()
    db_path.mkdir(parents=True, exist_ok=True)
    settings.DATABASE_URL = f"sqlite:///{db_path / 'pdfcompare.db'}"

# Ensure directories exist
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
os.makedirs(settings.RESULTS_DIR, exist_ok=True)
