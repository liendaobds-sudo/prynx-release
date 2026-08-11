"""
Application configuration loaded from environment variables.

KIENTRUC (audit 2026-07-29 §D.2): file này CHỈ giữ các field cấu hình đi qua
`pydantic_settings`. Phần lớn núm điều chỉnh của backend (trần đồng thời, ngân sách RAM,
cờ chẩn đoán) được đọc trực tiếp bằng `os.environ` ở gần chỗ dùng — cố ý, để trần nằm
cạnh code áp trần. Danh mục ĐẦY ĐỦ kèm mặc định và "khi nào nên đụng tới":
`docs/CAU_HINH_ENV.md`. Thêm biến môi trường mới thì thêm dòng vào tài liệu đó trong
CÙNG PR, dù biến đó không khai ở đây.
"""
import os
from pathlib import Path
from pydantic_settings import BaseSettings


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
    # None = tự chọn theo RAM máy; số dương = quyền ghi đè của người vận hành.
    # PERF (audit 2026-07-27 §4.4): không hard-cap máy >=16 GB ở 512 MiB.
    PRYNX_PPE_MEMORY_BUDGET_MB: int | None = None
    ICC_PROFILE_DIR: str = str((Path(__file__).resolve().parent / "assets" / "icc").resolve())
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
