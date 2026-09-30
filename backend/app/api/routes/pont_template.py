import os
import re
import shutil
import tempfile
import logging
import asyncio
from fastapi import APIRouter, File, UploadFile, Form, HTTPException, Depends
from app.core.license_guard import require_license
from app.utils.errors import raise_http
from app.workers.pont_template_inspector import inspect_pont_template

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/imposition", tags=["Imposition"], dependencies=[Depends(require_license)])


def _validate_template_path(path: str | None, must_exist: bool = True) -> str:
    """Kiểm tra đường dẫn file mẫu PDF hoặc SVG, ngăn chặn directory traversal."""
    if not path:
        raise HTTPException(status_code=400, detail="Thiếu đường dẫn file mẫu.")
    parts = re.split(r"[\\/]+", path)
    if any(part == ".." for part in parts):
        raise HTTPException(status_code=400, detail="Đường dẫn không hợp lệ.")
    resolved = os.path.abspath(path)
    if os.path.islink(resolved):
        raise HTTPException(status_code=400, detail="Không hỗ trợ symbolic link.")
    lower_name = resolved.lower()
    if not (lower_name.endswith(".pdf") or lower_name.endswith(".svg")):
        raise HTTPException(status_code=400, detail="Chỉ hỗ trợ file mẫu PDF (.pdf) hoặc SVG (.svg).")
    if must_exist and not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail="File không tồn tại trên hệ thống.")
    return resolved


@router.post("/inspect-pont-template")
async def api_inspect_pont_template(
    file: UploadFile | None = File(None),
    path: str | None = Form(None),
):
    """Trích xuất tự động thông số boong/ốc định vị từ file mẫu PDF hoặc SVG.

    Tự động nhận diện:
    - Khổ giấy (sheet width, height mm)
    - Dấu ốc 4 góc (hình dạng: tròn, L thường, L ngược; kích thước; độ dày)
    - 4 khoảng cách lề (trái, phải, trên, dưới mm)
    - Thanh canh giấy (paper guides)
    - Layer OCG Graphtec / Mimaki
    """
    temp_path = None
    target_path = None
    original_filename = None

    try:
        if file is not None and file.filename:
            original_filename = file.filename
            ext = os.path.splitext(original_filename)[1].lower()
            if ext not in (".pdf", ".svg"):
                raise HTTPException(status_code=400, detail="Chỉ hỗ trợ file PDF (.pdf) hoặc SVG (.svg).")
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                temp_path = tmp.name
                shutil.copyfileobj(file.file, tmp)
            target_path = temp_path
        elif path:
            target_path = _validate_template_path(path)
            original_filename = os.path.basename(target_path)
        else:
            raise HTTPException(status_code=400, detail="Vui lòng cung cấp file hoặc đường dẫn file mẫu PDF/SVG.")

        result = await asyncio.to_thread(inspect_pont_template, target_path, original_filename)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Lỗi nhận diện boong định vị từ file mẫu: %s", e)
        raise_http(e, "Không thể trích xuất thông số boong từ file mẫu.")
    finally:
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception:
                pass
