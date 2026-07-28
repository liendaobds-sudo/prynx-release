---
name: prynx-audit-workflow
description: "Workflow audit chuẩn của PrynX cho MỌI đợt rà soát lớn (hiệu năng, UI/UX, bảo mật, hình học khuôn bế): khảo sát → phát hiện có bằng chứng → báo cáo docs/ → CHỜ DUYỆT → sửa theo lô nhỏ có verify. Dùng ngay khi user yêu cầu 'audit', 'kiểm tra toàn bộ', 'rà soát', 'tối ưu toàn dự án', hoặc khi một đợt sửa chạm >5 file. Use when auditing, large-scale review, batch fixing, code review campaign, systematic refactor."
---

# Workflow audit & sửa theo lô

Dự án đã chạy các đợt audit lớn (hiệu năng ~60 phát hiện, chống crack, khuôn bế). Kinh nghiệm rút ra thành quy trình 2 chốt dưới đây — làm tắt từng gây hồi quy máy mạnh và hỏng file hàng loạt.

## Giai đoạn 1 — Khảo sát & phát hiện

1. Chốt phạm vi + tiêu chí với user trước (module nào, tiêu chí gì, mức thay đổi cho phép).
2. Đọc tài liệu nội bộ liên quan trước khi phán: `audit-rules.md`, `docs/BAO_CAO_AUDIT_*.md`, `docs/*_FIXES_*.md` — tránh phát hiện lại điều đã biết hoặc "fix" thứ đã xác định là chủ đích.
3. Mỗi phát hiện ghi theo mẫu:
   - **Mã số** `§<nhóm>.<số>` — dùng lại trong comment tag khi sửa.
   - **Bằng chứng** `file:dòng` + trích code, hoặc số đo/ảnh. Không có bằng chứng = không đưa vào báo cáo.
   - **Mức** P0 (hỏng/sai kết quả) → P3 (đánh bóng); **effort** S/M/L.
4. **Xác minh chéo phát hiện quan trọng trước khi kết luận** — đọc ngữ cảnh đủ rộng, chạy thử nếu được. Bài học: §3.16 (overlay "thừa") là false positive, code đó cần cho spotlight GIF.

## Giai đoạn 2 — Báo cáo & CHỐT DUYỆT

Viết `docs/BAO_CAO_AUDIT_<CHUDE>_<YYYY-MM-DD>.md`: tóm tắt điều hành → bảng phát hiện theo nhóm → top quick-win → đề xuất thứ tự sửa theo lô. **Dừng lại chờ user duyệt danh sách** — không tự sửa trước khi duyệt.

## Giai đoạn 3 — Sửa theo lô có kiểm soát

1. Lô nhỏ ≤5 file, nhóm theo tầng, thứ tự an toàn: backend thuần → desktop UI → Rust native (cần maturin rebuild) → Tauri shell. Cặp file phụ thuộc (vd `pdf_processor` ↔ `rust_bridge`) đi cùng một lô.
2. Mỗi chỗ sửa gắn tag `<LOẠI> (audit <ngày> §x.y)` để truy vết/revert lẻ.
3. Hết mỗi lô: verify theo `prynx-testing` (typecheck/test/py_compile/cargo check phạm vi liên quan). Agent phiên cloud: ghi file theo `prynx-safe-write-cowork` + md5. User xác nhận chạy thật OK rồi mới sang lô kế.
4. Ghi log tiến độ vào `docs/<CHUDE>_FIXES_<ngày>.md`: mỗi fix — file, thay đổi, lý do, cách kiểm tra.
5. Có hồi quy user báo (chậm đi, sai kết quả): **dừng cả đợt**, khoanh vùng lô gây ra, sửa hoặc revert lẻ theo tag, rồi mới tiếp tục.

## Giới hạn phạm vi

Audit chủ đề nào chỉ sửa chủ đề đó — thấy vấn đề ngoài phạm vi thì GHI vào mục "phát hiện thêm" của báo cáo, không tiện tay sửa. Không đổi hành vi nghiệp vụ/format file xuất trong đợt audit phi chức năng (perf/UI) trừ khi user duyệt riêng.
