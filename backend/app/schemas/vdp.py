from pydantic import BaseModel
from typing import List, Dict, Any, Optional

class VdpField(BaseModel):
    id: str
    name: str
    type: str # 'qrcode', 'barcode', 'text'
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
    textAlign: Optional[str] = 'left'
    alignment: Optional[str] = 'left'
    autoFit: Optional[bool] = True  # tự bóp cỡ chữ để vừa khung (không tràn)
    # Barcode/QR specific
    barType: Optional[str] = 'code128'
    barcodeType: Optional[str] = None  # tên frontend gửi (ưu tiên hơn barType)
    barColor: Optional[str] = '#000000'
    bgColor: Optional[str] = '#FFFFFF'
    transparentBg: Optional[bool] = False
    showText: Optional[bool] = True
    errorCorrection: Optional[str] = 'M'
    qrStyle: Optional[Dict[str, Any]] = None  # { dotColor, bgColor, transparentBg, dotType }
    textContent: Optional[str] = None

class VdpRequest(BaseModel):
    file_id: str
    fields: List[VdpField]
    data: List[Dict[str, str]]
