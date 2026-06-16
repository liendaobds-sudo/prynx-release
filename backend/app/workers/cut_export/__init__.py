"""
cut_export — Module xuất dữ liệu cắt cho máy bế (Send to Cutter).

Module ĐỘC LẬP, không sửa file có sẵn. Đường ống:
    Bình bài → CutModel → Registration → Emitter → Transport → máy bế.

Spec: .kiro/specs/gui-may-be/ (requirements.md, design.md, tasks.md).

Nguyên tắc:
- Lõi sinh đường cắt ở hệ mét tuyệt đối (mm); khác biệt máy dồn vào Emitter/Profile.
- Đọc thẳng toạ độ đường cắt (không phụ thuộc spot-color).
- Tuân thủ tên nhóm/ô từ cài đặt ốc (PontConfig).
"""

from app.workers.cut_export.cut_model import (
    CutPath,
    RegMark,
    CutModel,
    SendResult,
)

__all__ = ["CutPath", "RegMark", "CutModel", "SendResult"]
