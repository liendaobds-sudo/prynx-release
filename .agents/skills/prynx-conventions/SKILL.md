---
name: prynx-conventions
description: "Quy ước viết code PrynX: tiếng Việt cho comment/UI, bảng thuật ngữ ngành in Việt–Anh, tag comment truy vết, quy ước đặt tên hằng số/panel, i18n, đơn vị mm. Đọc khi viết code mới, đặt tên, viết text hiển thị, viết thông báo lỗi, hoặc review code. Use when writing new code, naming things, UI copy, error messages, comments, code style, coding conventions, thuật ngữ ngành in."
---

# Quy ước code & thuật ngữ PrynX

## Ngôn ngữ

- Comment giải thích logic, docstring, text UI, thông báo lỗi: **tiếng Việt**. Tên biến/hàm/type: tiếng Anh chuẩn ngành. Text hiển thị đi qua `desktop/src/i18n/` — không hardcode chuỗi trong component khi đã có key tương ứng.
- Thông báo lỗi cho user: nói điều user làm được ("File PDF đang mở trong phần mềm khác — đóng lại rồi thử lại"), không dán stacktrace.

## Bảng thuật ngữ ngành in (dùng thống nhất, đừng dịch mới)

| Tiếng Việt | Tiếng Anh trong code |
|---|---|
| bình bản / bình tem | imposition |
| tem bế | die-cut sticker/label |
| khuôn bế | dieline |
| dao cắt / nét cắt | CUT |
| nếp gấp / nét lằn | CREASE |
| tràn lề | BLEED / bleed contour |
| hộp đáy dán (tự động) | auto(-lock) bottom / crash lock |
| tam giác dán | glue tab (`bottom_tab_*`) |
| tai (đáy/bụi) | wing / dust flap |
| đường may / mép dán | glue seam / glue flap |
| chồng mí | overlap |
| nắp cài | tuck / lock tab |
| kệ / vai / khấc | shelf / shoulder / notch |
| bế nesting | nesting (NFP) |
| dữ liệu biến đổi | VDP |

## Tag comment truy vết

Mỗi đợt sửa có chủ đề gắn tag để truy vết và revert lẻ — giữ đúng định dạng đang dùng:

```
# PERF (audit 2026-07 §3.2): ...        ← tối ưu hiệu năng
// [AUTO-BOTTOM FIX 2026-07-26] ...     ← sửa hình học có chiến dịch
// UIUX (audit <ngày> §x.y): ...        ← sửa UI/UX theo đợt audit
```

Comment trả lời "vì sao", không kể lại code. Đặc biệt hình học: ghi rõ căn cứ ("theo mẫu 100010-01", "hDeep = 0.76W") — người sau không đoán lại được từ con số trần.

## Đặt tên & con số

- Hằng số hình học vào `constants.ts`, tiền tố theo loại hộp (`AB_` = auto-bottom…), tên nói rõ là RATIO hay mm. Không rải magic number trong generator.
- Panel đặt tên `snake_case` theo vị trí: `front`, `back`, `left`, `right`, `glue_flap`, `bottom_main_front`, `bottom_tab_back`, `closure_top`… — test và 3D tra theo tên này, đổi tên là đổi hợp đồng.
- Đơn vị mặc định toàn dự án: **mm** (tọa độ model, tham số form). Điểm chuyển đổi pt/px chỉ nằm ở tầng render/export.
- TS strict; tránh `any` mới; warning nghiệp vụ đưa vào `model.warnings`/schema trả về, không `console.log` trong lib.

## Git

Commit message tiếng Việt ngắn gọn "làm gì + vì sao", nhóm theo chiến dịch như tag ở trên. Không commit `node_modules`, `target/`, `backend/venv`, `Ban_Phat_Hanh/`, file tạm `_to_delete/`.
