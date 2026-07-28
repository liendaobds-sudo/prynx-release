# Bộ skill AI của PrynX

10 skill đóng gói kiến thức dự án cho AI coding agent, theo định dạng SKILL.md chuẩn chung (frontmatter `name` + `description`) — chạy được với cả **Claude Code**, **OpenAI Codex**, và các tool khác đọc được định dạng này (Cursor, OpenCode…).

## Cấu trúc

- **Bản gốc (sửa ở đây):** `.agents/skills/<tên>/SKILL.md` — Codex tự quét thư mục này của repo.
- **Bản sao cho Claude Code:** `.claude/skills/` — sau khi sửa bản gốc, chạy `powershell scripts/sync_ai_skills.ps1` để đồng bộ.
- `AGENTS.md` (gốc repo): quy tắc chung + bảng chỉ mục skill — Codex đọc tự động; `CLAUDE.md` import lại nó cho Claude Code.
- `.claude/commands/`: lệnh tắt `/audit`, `/add-boxtype`, `/verify` (chỉ Claude Code; Codex gọi skill bằng `$prynx-audit-workflow`… hoặc mô tả bằng lời).

## Danh sách skill

| Skill | Nội dung |
|---|---|
| `prynx-architecture` | Bản đồ kiến trúc, thư mục, luồng dữ liệu |
| `prynx-dieline` | Bất biến hình học 2D + hệ gấp 3D + quy trình test khuôn bế |
| `prynx-imposition` | Scheduler/threadpool/khóa PDFium cho bình bản, nup, VDP |
| `prynx-performance` | Nguyên tắc RAM-gating, quy tắc Cargo LTO, hồi quy đã biết |
| `prynx-testing` | Ma trận test + chính sách golden master + verify chuẩn |
| `prynx-build-release` | run_dev, build_production (Nuitka/maturin/tauri), phát hành |
| `prynx-conventions` | Tiếng Việt, thuật ngữ ngành in, tag comment, đặt tên |
| `prynx-safe-write-cowork` | Ghi file an toàn từ phiên Claude cloud (đệm + md5) |
| `prynx-audit-workflow` | Audit 2 chốt: báo cáo → duyệt → sửa theo lô |
| `prynx-add-boxtype` | Checklist thêm loại hộp/khuôn mới end-to-end |

## Bảo trì

- Skill là tài liệu SỐNG: sau mỗi bài học mới (hồi quy, false positive, quy trình mới), cập nhật skill tương ứng ngay trong PR đó.
- Giữ mỗi SKILL.md ngắn (<150 dòng), phần "vì sao" quan trọng hơn phần "phải làm gì".
- Thêm skill mới: tạo thư mục trong `.agents/skills/`, viết frontmatter `name` + `description` (description nêu rõ KHI NÀO dùng, kèm từ khóa Anh–Việt), chạy sync, thêm dòng vào bảng trong `AGENTS.md`.
