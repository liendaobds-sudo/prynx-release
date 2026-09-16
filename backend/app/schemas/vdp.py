from pydantic import BaseModel
from typing import List, Dict, Any, Optional, Literal

# Toán tử so sánh hỗ trợ cho điều kiện ẩn/hiện và bảng rule (Req 2.9)
VdpOperator = Literal['eq', 'ne', 'contains', 'empty', 'not_empty']


class VdpFieldCondition(BaseModel):
    """Điều kiện ẩn/hiện field dựa trên giá trị một cột (Req 2.1, 2.2)."""
    column: str
    operator: VdpOperator
    value: str = ''
    action: Literal['show_if', 'hide_if'] = 'show_if'


class VdpRule(BaseModel):
    """Một dòng trong bảng rule: nếu cột thoả điều kiện thì đặt nội dung/ảnh = result (Req 2.5, 2.6)."""
    column: str
    operator: VdpOperator
    value: str = ''
    result: str


class VdpField(BaseModel):
    id: str
    name: str
    type: str # 'qrcode', 'barcode', 'text', 'image'
    x: float
    y: float
    width: float
    height: float
    # Additional generic settings
    rotation: Optional[int] = 0
    fontFamily: Optional[str] = None
    fontName: Optional[str] = None
    fontFile: Optional[str] = None
    fontSize: Optional[float] = 10
    fontColor: Optional[str] = '#000000'
    fontStyle: Optional[str] = 'regular'  # regular | bold | italic | bolditalic
    lineHeight: Optional[float] = 1.0
    textAlign: Optional[str] = 'left'
    alignment: Optional[str] = 'left'
    autoFit: Optional[bool] = True  # tự bóp cỡ chữ để vừa khung (không tràn)
    # Barcode/QR specific
    barType: Optional[str] = 'code128'
    # tên frontend gửi (ưu tiên hơn barType); ngoài các loại 1D/qr hiện có,
    # nhận thêm 'datamatrix' | 'gs1-128' | 'gs1-datamatrix' (Req 3.1, 3.2, 3.3)
    barcodeType: Optional[str] = None
    gs1HumanReadable: Optional[bool] = False  # in chuỗi (AI)dữ_liệu cho GS1 (Req 3.10)
    barColor: Optional[str] = '#000000'
    bgColor: Optional[str] = '#FFFFFF'
    transparentBg: Optional[bool] = False
    showText: Optional[bool] = True
    quietZone: Optional[float] = 2  # Lề trắng quanh QR/mã vạch (mm)
    barHeight: Optional[float] = None
    errorCorrection: Optional[str] = 'M'
    qrStyle: Optional[Dict[str, Any]] = None  # { dotColor, bgColor, transparentBg, dotType }
    textContent: Optional[str] = None
    # Image specific (#3 variable image)
    imageFit: Optional[str] = 'cover'        # cover | fill | contain
    imageShape: Optional[str] = 'rectangle'  # rectangle | rounded | circle | polygon | star
    imageBaseDir: Optional[str] = None       # thư mục gốc khi cột chứa TÊN file ảnh
    imagePath: Optional[str] = None           # ảnh tĩnh (dùng khi cột rỗng/không map)
    # Quỹ đạo vòm (Type on a Path / Text on Arc)
    curveMode: Optional[str] = 'none'         # 'none' | 'arc_top' | 'arc_bottom' | 'wave'
    curveRadius: Optional[float] = None       # Bán kính cong (mm)
    curveOrientation: Optional[str] = 'outward' # 'outward' | 'inward'
    curveTracking: Optional[float] = 0.0      # Độ giãn ký tự trên cung tròn (pt)
    # Logic điều kiện (Req 2) — mặc định None để bảo toàn hành vi cũ (Req 7.2, 7.3)
    conditions: Optional[List[VdpFieldCondition]] = None  # điều kiện ẩn/hiện (Req 2.1, 2.2)
    rules: Optional[List[VdpRule]] = None                 # bảng rule first-match (Req 2.5, 2.6)

class VdpRequest(BaseModel):
    file_id: str
    fields: List[VdpField]
    data: List[Dict[str, str]]


# ── Response contract ────────────────────────────────────────────────────────
# KIENTRUC (audit 2026-07-29 §A.2): desktop ↔ backend không có codegen chung nên bỏ một
# field khỏi response là lỗi im lặng. Cùng nguyên tắc với `schemas/imposition.py`: model
# MÔ TẢ hiện trạng (field lỏng để Optional), không siết — đừng biến dữ liệu lệch nhẹ
# thành 500 trên máy khách. Mỗi model ghi rõ ai đọc field đó ở phía desktop.


class VdpJobStartResponse(BaseModel):
    """Kết quả `POST /api/vdp/generate`. Desktop đọc `data.job_id` (`lib/api.ts`)."""

    job_id: str


class VdpJobStatusResponse(BaseModel):
    """Kết quả `GET /api/vdp/status/{job_id}`.

    Desktop đọc (`lib/api.ts` → vòng poll VDP): `status`, `processed`, `total`, `result`
    (đường dẫn file kết quả khi xong), `artifact_lease`, `error`.
    `cancel_requested` chưa ai đọc nhưng vẫn trả — bỏ đi là đổi hợp đồng mà không
    được gì.
    """

    status: Optional[str] = None
    processed: int = 0
    total: int = 0
    result: Optional[str] = None
    artifact_lease: Optional[str] = None
    error: Optional[str] = None
    cancel_requested: bool = False


class VdpJobCancelResponse(BaseModel):
    """Kết quả `POST /api/vdp/vdp-cancel/{job_id}` (và alias `/cancel/{job_id}`).

    Ba nhánh như bên N-Up: không tồn tại / đã ở trạng thái cuối / hủy thành công. Riêng
    VDP có thêm `cancelled_before_start` — hủy được khi job còn trong hàng đợi thì file
    tạm được dọn ngay và slot hàng đợi được nhả.
    """

    job_id: str
    status: str
    cancelled: bool
    message: Optional[str] = None
    already_cancelled: Optional[bool] = None
    cancelled_before_start: Optional[bool] = None


class VdpUploadResponse(BaseModel):
    """Kết quả `POST /api/vdp/upload` — desktop dùng `path` làm `source_path` cho job."""

    path: str
