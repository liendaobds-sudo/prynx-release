"""
Chuẩn hoá xử lý lỗi cho route FastAPI.

Trước đây các route bắt lỗi kiểu:

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lỗi hệ thống ({type(e).__name__})")

Cách này có HAI vấn đề:
  1. User chỉ thấy "Lỗi hệ thống (RuntimeError)" — vô nghĩa, không chẩn đoán được;
     dev cũng không có traceback ở server để lần nguyên nhân (đúng lỗi PDF/X đã gặp).
  2. `except Exception` NUỐT LUÔN HTTPException raise bên trong try (404/400/422 đều là
     Exception) → mọi lỗi "không tìm thấy file" biến thành 500 mơ hồ.

`raise_http()` sửa cả hai: HTTPException raise nguyên bản (giữ đúng mã 404/400/422),
còn lỗi thật thì LOG full traceback ở server + trả message CÓ NGHĨA cho user.
Đây là app desktop chạy local nên trả nội dung lỗi thật cho user là chấp nhận được
(không phải web service công khai).
"""
import logging
from typing import NoReturn

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def raise_http(exc: Exception, user_msg: str, status_code: int = 500) -> NoReturn:
    """Dùng trong `except Exception as e:` của route.

    - Nếu `exc` là HTTPException (404/400/422… đã raise có chủ đích trong try) → re-raise
      NGUYÊN BẢN, không nuốt thành 500.
    - Ngược lại: log full traceback (logger.exception tự lấy exc_info hiện tại) rồi raise
      HTTPException với `{user_msg}: {chi tiết lỗi thật}`.
    """
    if isinstance(exc, HTTPException):
        raise exc
    logger.exception(user_msg)
    raise HTTPException(status_code=status_code, detail=f"{user_msg}: {exc}")
