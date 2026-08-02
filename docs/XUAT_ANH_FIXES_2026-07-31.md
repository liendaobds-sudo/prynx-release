# Nhật ký sửa re-audit Xuất ảnh — 2026-07-31

Phạm vi: đóng RA-01…RA-08 trong `BAO_CAO_RE_AUDIT_XUAT_ANH_2026-07-31.md`. Các thay đổi được chia lô không quá 5 file và verify sau từng lô.

## Lô A — page box, CMYK fail-loud, estimate cơ bản

- RGB/Gray render theo MediaBox khi bật bleed, TrimBox khi tắt; CropBox chỉ đổi trong PDF RAM và được khôi phục trước khi đóng page.
- CMYK truyền `media/trim` xuyên facade đến PPE.
- PPE báo `ink_unsound` hoặc `degraded` sẽ dừng và rollback, không giao output “production” thiếu tin cậy.
- Viewer truyền kích thước point thật; estimate CMYK dùng 4 kênh.
- Verify: 29 backend tests; TypeScript đạt.

## Lô B — hủy thật và wording trung thực

- Route theo dõi ASGI disconnect, nối vào `threading.Event` mà worker kiểm tra giữa các trang.
- `finally` luôn dừng watcher; renderer rollback output khi hủy.
- Bỏ progress giả “trang 1/N”; dùng trạng thái chung “Đang xuất”.
- Verify: 30 backend tests; `py_compile`; TypeScript đạt.

## Lô C — snapshot object edit

- Nếu edit session dirty, xuất ảnh commit Live Document trước khi tạo snapshot.
- Snapshot nhận trực tiếp Working File từ kết quả commit để tránh race/closure giữ file cũ.
- Commit thiếu output hoặc tải Working File lỗi sẽ fail-loud, không fallback sang file cũ.
- Page order/delete/duplicate/rotation tiếp tục được bake trên Working File vừa commit.
- Verify: TypeScript đạt; `git diff --check` đạt.

## Lô D — batch nguyên tử

- Frontend lập và validate toàn bộ plan trước upload.
- Chặn `effectiveDpi` ngoài 36–1200; tối đa 8 job.
- CMYK tự chuyển hàng PNG/WebP sang TIFF và khóa option không tương thích.
- Client gửi một request batch; backend rollback file của mọi job trước nếu job sau lỗi hoặc bị hủy.
- Endpoint cũ `/api/export/images` giữ nguyên; endpoint mới `/api/export/images/batch` chỉ dành cho client mới.
- Verify: 33 backend tests; `py_compile`; TypeScript đạt.

## Lô E — coverage và estimate multi-scale

- Thêm 5 test frontend cho range đảo/clamp, DPI vượt trần, CMYK+WebP và plan hợp lệ.
- Estimate cộng dung lượng của từng output multi-scale, theo DPI/format riêng, đồng thời hiển thị toàn bộ kích thước pixel.
- Coverage backend hiện gồm CMYK native 4 kênh + ICC, TIFF multipage, page box, confidence flags, disconnect/cancel và rollback batch.
- Verify: `vitest ExportImageModal.test.ts` — 5 passed.

## Verify cuối

```text
pytest backend/tests/test_export_images.py -q     33 passed
npm run typecheck --prefix desktop               đạt
npx vitest run ExportImageModal.test.ts           5 passed
py_compile schema/route/test                      đạt
```

