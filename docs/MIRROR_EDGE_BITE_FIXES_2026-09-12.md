# Lô A — Độ lẹm mép cho Lật gương — 2026-09-12

Phạm vi lô: backend schema, route, engine và hồi quy mirror theo báo cáo
`BAO_CAO_AUDIT_MIRROR_EDGE_BITE_2026-09-11.md` (§MIRROR.BITE.1–.3).

## Thay đổi

- Tạo `MirrorBleedRequest` riêng; `edge_bite_mm` hữu hạn trong 0–5 mm, mặc định
  0. `AddBleedRequest` không nhận field này để endpoint `/add-bleed` không quảng
  bá tham số không sử dụng.
- Route `/preflight/mirror-bleed` forward `edge_bite_mm` bằng keyword vào engine.
- `PageBoxesEngine.add_mirror_bleed` dời trục phản chiếu vào trong theo lượng
  lẹm, chồng dải mirror vào phần sát mép TrimBox; chỉ cạnh đang bật mới bị lẹm.
  TrimBox và kích thước thành phẩm giữ nguyên. Bleed 0/không cạnh vẫn không
  rewrite hoặc cắt nội dung.
- Từ chối trang có tổng lẹm hai cạnh đối diện làm triệt tiêu vùng nội dung lõi.

## Verify

- `backend\\.venv\\Scripts\\python.exe -m pytest -q tests/test_mirror_bleed_origin.py`:
  **23 passed** (1 cảnh báo Pydantic deprecation có sẵn).
- `python -m py_compile` trên 4 file Python của lô: **đạt**.
- Kiểm tra FastAPI route: `/preflight/mirror-bleed` nhận đúng
  `MirrorBleedRequest` và trả `FixFileResponse`.
- `git diff --check` trên 4 file mã/test: **đạt**.
- Chạy kèm `tests/test_api_contract.py` cho baseline hiện tại: 4 lỗi ở
  `/impose-start`, `/nup-start`, `/sticker-start`, `/generate` do response model
  imposition/VDP ngoài phạm vi lô A; nhóm preflight mirror không lỗi.

Chưa chạy Tauri/runtime với PDF mẫu người dùng; lô B chỉ được triển khai sau khi
lô A đã đạt verify tự động.

## Lô B — desktop/recipe

- `StickerTool` có state/persistence riêng `mirrorEdgeBiteMm`; field cũ
  `edgeBiteMm` không được dùng cho mode mirror.
- Chọn `Lật gương tự động` hiện ô `Độ lẹm mép`, bước 0,1 mm, miền 0–5 mm và
  gửi `edge_bite_mm` tới `/preflight/mirror-bleed`.
- Recipe ghi/phát lại `mirrorEdgeBiteMm`; recipe cũ thiếu field này luôn gửi 0,
  kể cả có `edgeBiteMm` cũ khác 0. RecipePanel hiển thị nhãn riêng.
- Ẩn cảnh báo nội dung khỏi panel mirror theo yêu cầu giao diện. Engine thêm
  chồng mí nội bộ `0,25 pt` vào phía nội dung khi mirror hoạt động, không đổi
  page box hay lượng bleed ngoài, để tránh hairline trắng do anti-alias tại biên
  clip.

### Verify lô B

- `npm run typecheck`: **đạt**.
- `npx vitest run src/components/preprocess-tools/StickerTool.ui.test.tsx`:
  **22 passed**.
- `npx vitest run src/lib/recipe/recipeRunners.test.ts`: **37 passed**.
- `npx vitest run src/components/preprocess-tools/StickerTool.test.ts`:
  **22 passed**.
- Sau bổ sung seam/UI: `tests/test_mirror_bleed_origin.py` **25 passed**; test UI
  mirror + ẩn cảnh báo **2 passed**.
- Test riêng mới cho UI mirror và recipe mirror: **đạt**.
- `git diff --check` trên 5 file lô B: **đạt**.

Chưa chạy Tauri runtime với PDF mẫu người dùng; kiểm tra hiện đạt mức typecheck
và tự động. Các thay đổi khác đang có sẵn trong working tree được giữ nguyên.
