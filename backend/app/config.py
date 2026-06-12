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
    
    # 2. System PATH
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
    DEV_MODE: bool = True  # True = SQLite + sync processing (no Docker needed)

    # Database
    DATABASE_URL: str = "postgresql://pdfuser:pdfpass@localhost:5432/pdfcompare"

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
    ICC_PROFILE_DIR: str = str(Path("./app/assets/icc").resolve())
    DEFAULT_CMYK_PROFILE: str = "FOGRA39.icc"

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:80"]

    class Config:
        env_file = ".env"
        extra = "allow"


settings = Settings()

# DEV_MODE: override DB to SQLite
if settings.DEV_MODE:
    db_path = Path("./data").resolve()
    db_path.mkdir(parents=True, exist_ok=True)
    settings.DATABASE_URL = f"sqlite:///{db_path / 'pdfcompare.db'}"

# Ensure directories exist
os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
os.makedirs(settings.RESULTS_DIR, exist_ok=True)
