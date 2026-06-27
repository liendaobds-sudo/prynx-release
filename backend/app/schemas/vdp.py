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
    # Logic điều kiện (Req 2) — mặc định None để bảo toàn hành vi cũ (Req 7.2, 7.3)
    conditions: Optional[List[VdpFieldCondition]] = None  # điều kiện ẩn/hiện (Req 2.1, 2.2)
    rules: Optional[List[VdpRule]] = None                 # bảng rule first-match (Req 2.5, 2.6)

class VdpRequest(BaseModel):
    file_id: str
    fields: List[VdpField]
    data: List[Dict[str, str]]
