"""
Application configuration loaded from environment variables.
"""
import os
import shutil
from pathlib import Path
from pydantic_settings import BaseSettings


def _find_ghostscript() -> str:
    """Dò Ghostscript. Chuỗi rỗng nghĩa là **không có** — và đó là câu trả lời hợp lệ.

    Thứ tự:
    1. `GHOSTSCRIPT_PATH` — quyền ghi đè của người vận hành, luôn thắng.
    2. Bản build no-GS: **dừng dò**. Xem `app.core.gs_availability`.
    3. Ghostscript đóng kèm payload.
    4. PATH hệ thống, rồi các thư mục cài phổ biến.

    GS-SUNSET (audit 2026-07-27 §A.4): trước đây hàm này kết thúc bằng một đường dẫn
    **gõ cứng** khi không tìm thấy gì, nên `GHOSTSCRIPT_PATH` không bao giờ rỗng. Mọi
    chỗ kiểm `if gs_path:` vì thế luôn đúng và lỗi chỉ lộ ra ở tận `FileNotFoundError`
    của subprocess — người dùng nhận `Ghostscript failed: ...` thay vì lời giải thích.
    """
    # 1. Người vận hành chỉ định tường minh.
    env_gs = os.environ.get("GHOSTSCRIPT_PATH", "")
    if env_gs and os.path.isfile(env_gs):
        return env_gs

    from app.core.gs_availability import bundled_ghostscript, is_no_gs_build

    # 2. Artifact tự khai là bản không có Ghostscript ⇒ không đi tìm GS của máy khách.
    #    Một bản phát hành phải chạy MỘT đường engine xác định ở mọi máy.
    if is_no_gs_build():
        return ""

    # 3. Ghostscript đóng kèm (Tauri resource).
    bundled = bundled_ghostscript()
    if bundled:
        return bundled

    # 4. PATH hệ thống, rồi thư mục cài phổ biến (bản mới nhất trước).
    found = shutil.which("gswin64c") or shutil.which("gswin32c") or shutil.which("gs")
    if found:
        return found
    gs_base = Path(r"C:\Program Files\gs")
    if gs_base.is_dir():
        candidates = sorted(gs_base.glob("gs*/bin/gswin64c.exe"), reverse=True)
        if candidates:
            return str(candidates[0])

    return ""


def _default_allow_gs_fallback() -> bool:
    """Bản no-GS mặc định **không** rơi về Ghostscript.

    Cờ này là chính sách sản phẩm, không phải tinh chỉnh hiệu năng: cho phép fallback
    trên bản không đóng gói GS nghĩa là hành vi phụ thuộc việc máy khách có cài GS hay
    không. `.env` / biến môi trường vẫn ghi đè được khi cần đối chiếu có chủ đích.
    """
    from app.core.gs_availability import is_no_gs_build

    return not is_no_gs_build()


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
    # GS-SUNSET (audit 2026-07-28 §3.7): đây là chính sách sản phẩm cố định,
    # không phải cấu hình môi trường. Giá trị được khóa lại sau khi BaseSettings
    # đọc .env để dev/test/release không thể vô tình chạy hai engine khác nhau.
    GHOSTSCRIPT_PATH: str = ""
    # None = tự chọn theo RAM máy; số dương = quyền ghi đè của người vận hành.
    # PERF (audit 2026-07-27 §4.4): không hard-cap máy >=16 GB ở 512 MiB.
    PRYNX_PPE_MEMORY_BUDGET_MB: int | None = None
    ICC_PROFILE_DIR: str = str((Path(__file__).resolve().parent / "assets" / "icc").resolve())
    DEFAULT_CMYK_PROFILE: str = "FOGRA39.icc"

    # CORS
    CORS_ORIGINS: list[str] = ["http://localhost:3000", "http://localhost:80"]

    def model_post_init(self, __context) -> None:
        """Khóa chính sách no-GS sau khi đã đọc mọi nguồn cấu hình."""
        object.__setattr__(self, "GHOSTSCRIPT_PATH", "")

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
