# Nhật ký sửa — Vector hóa Logo (§LR4.01–§LR4.07), 2026-08-13

**Căn cứ:** `BAO_CAO_AUDIT_LOGO_REBUILD_2026-08-13.md` (đã hiệu chỉnh re-audit cùng ngày, xem mục "Hiệu chỉnh re-audit" trong báo cáo) — user duyệt toàn bộ Lô A→E.
**Quy ước:** `routes/` = `backend/app/api/routes/`, `workers/` = `backend/app/workers/`.

## 0. Hiệu chỉnh báo cáo trước khi sửa (re-audit)

Đối chiếu ~30 trích dẫn `file:dòng` với code — tất cả khớp. Ba điểm phải sửa trong báo cáo:

1. **§LR4.01** — claim "Không có test `_scaled_despeckle_size`" sai: `test_worker_scales_despeckle_area_with_upscale` đã khóa quy đổi 4→8. Cái thiếu thật là regression "dấu 3×3 bị nuốt".
2. **§LR4.01** — quy kết nguyên nhân: phép nhân `sqrt(work_area_scale)` bảo toàn ngữ nghĩa px nguồn (dấu 3×3 = 9 px < 4² = 16 px nguồn chết ở mọi scale); thủ phạm là default 4 px không gian nguồn.
3. **§LR4.02** — 15×15 trên 200×200 là 0,5625% (bản cũ ghi 1,125%) và đi nhánh accent, không phải nhánh chủ đạo; bổ sung: sàn coverage 0,1% tương đối loại dấu tuyệt đối nhỏ kể cả khi chạy full-res → hướng sửa phải thêm sàn tuyệt đối theo px nguồn.

## Lô A — §LR4.01: default despeckle an toàn khi upscale

**File:** `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.tsx`, `backend/app/workers/logo_rebuild.py`, `backend/tests/test_logo_rebuild.py`, `desktop/src/components/preprocess-tools/LogoRebuildWorkspace.test.tsx`.

- Giữ ngữ nghĩa khử hạt theo **px ảnh nguồn** (đã có test khóa; thêm unit test `_scaled_despeckle_size` các hệ số 144/1/0.25/cap 128).
- UI: hằng `UPSCALE_SHORTEST_SIDE_PX = 600` (đồng bộ `_upscale_target_dimensions` backend); sau preflight, nếu cạnh ngắn nguồn < 600 (sẽ upscale NEAREST) và user chưa đổi giá trị mặc định 4 → tự hạ về 0 kèm status; hint tĩnh dưới ô "Khử hạt nhỏ" khi despeckle > 0 trên ảnh nhỏ.
- Backend: khi `mode=fixed_palette`, despeckle > 0 và `work_area_scale > 1` → warning nêu rõ "chi tiết nhỏ hơn N×N px ảnh nguồn sẽ bị gộp" (trước chỉ báo số quy đổi).
- Sửa comment JPEG §LR2.03 (tin nhầm 4 px an toàn cho dấu tiếng Việt).
- **Regression engine thật** (`pytest.importorskip("pdfcompare_native")`): logo 100×100 + dấu đỏ 3×3 — despeckle 0 giữ `#d71920` trong SVG, despeckle 4 nuốt; bất biến theo mọi tier RAM vì ngưỡng theo px nguồn.

**Verify:** pytest `test_logo_rebuild.py` 54/54; vitest workspace 32/32; typecheck pass.

## Lô B — §LR4.02: accent trên lưới dày theo RAM + sàn tuyệt đối px nguồn

**File:** `backend/app/workers/logo_rebuild.py`, `backend/tests/test_logo_rebuild.py`.

- Detector accent tách khỏi lưới k-means 40k px, chạy trên lưới riêng `_accent_grid_pixel_budget()`: ≥16 GB → 16 Mpx (full-res với scan tới 4K), 8–16 GB → 4 Mpx, <8 GB hoặc RAM unreadable → 1 Mpx. Máy mạnh không bị giảm (đúng nguyên tắc RAM-gating).
- Thêm `_MIN_ACCENT_SOURCE_AREA_PX = 64` (8×8 px nguồn): component liền khối đạt sàn tuyệt đối được nhận dù coverage < 0,1% (mọi cổng cũ đều tương đối nên dấu rõ trên scan 2–8K vẫn bị loại). Các gate chất lượng (box-fill ≥ 0.15, chroma ≥ 48, RMS ≤ 45, cap 4 accent, warning) giữ nguyên.
- Test mới: dấu 15×15 trên scan 2000×2000 được gợi ý ở cả 4 tier RAM (32 GB/12 GB/6 GB/unreadable); 400 chấm 1 px rời trên scan lớn không được nâng thành màu.

**Verify:** pytest 59/59 (các fixture cũ 200×200/240×160/80×80 không đổi hành vi).

## Lô C — §LR4.03–§LR4.05: mapping lỗi, cancel, reservation

**File:** `backend/app/workers/logo_rebuild.py`, `backend/tests/test_logo_rebuild.py`.

- **§LR4.03:** `except ValueError` quanh lời gọi native đổi từ gói `RuntimeError` (→500) thành `LogoInputError` (→422) kèm nguyên nhân thật từ engine; thêm guard `except LogoInputError: raise`.
- **§LR4.04:** `prepare_logo_image` nhận `cancel_check` và checkpoint giữa các bước nặng (load → ICC → phối cảnh → resize → illumination); worker truyền `token.is_cancelled`.
- **§LR4.05:** `_reserve_logo_work_size` khi RAM unreadable: giữ NGUYÊN kích thước (không hạ chất lượng) nhưng reserve ước lượng + chỉ một job Logo mỗi lúc; job thứ hai nhận `LogoInputError` có hướng xử lý; release trong `finally`.

**Verify:** pytest 62/62 (3 test mới: ValueError→LogoInputError, cancel giữa prepare, serialize khi RAM unreadable).

## Lô D — §LR4.06–§LR4.07: default mono + copy trung thực

**D1** (`vi.json`, `en.json`, `LogoRebuildWorkspace.tsx`, `LogoRebuildWorkspace.test.tsx`):

- Thêm key i18n cho 3 chuỗi mới của Lô A (`despeckle_small_image_*`).
- Chuyển sang chế độ Đen trắng → despeckle tự về 0 (Silhouette chưa thực thi khử hạt; giá trị > 0 chỉ ép review vô cớ — §LR4.06). Quay lại Logo màu → khôi phục mặc định theo ảnh (0 nếu ảnh nhỏ, 4 nếu lớn), tôn trọng giá trị user tự đặt.
- Với default này, hai lý do review ("chưa nhập mm" vs "engine chưa khử hạt") không còn dính nhau trong flow mặc định.

**D2** (`vi.json`, `en.json`, `LogoRebuildWorkspace.tsx`, `i18nCatalog.test.ts`) + **D3** (`toolRegistry.ts`, `PreprocessingRouter.tsx`, `ImpositionTab.tsx`, `license/features.ts`):

- §LR4.07: engine chỉ nội suy NEAREST, không phục hồi nét → đổi toàn bộ copy "Phục hồi & Vector hóa Logo"/"Phục hồi Logo" thành **"Vector hóa Logo"** (card Home, tab title, heading workspace, router preprocess, label license, EN "Vectorize Logo"); `longDescription` nêu rõ "Ảnh nhỏ được phóng to bằng nội suy giữ biên — chưa tự phục hồi phần logo bị che hoặc mất nét". Limitations API giữ nguyên.
- Message 404 HOLD ở `routes/logo_rebuild.py` vẫn dùng tên cũ — không user nào đối chiếu được với card (card chỉ hiện khi feature mở); để nguyên cho khỏi chạm file backend trong lô copy.

**Verify:** vitest workspace + i18nCatalog + toolRegistry.routing + toolPanel + tabNavigation = 74/74; đã quét không còn chuỗi "Phục hồi & Vector hóa Logo"/"Phục hồi Logo" trong `desktop/src`.

## Lô E — cổng bằng chứng

| Cổng | Kết quả |
|---|---|
| pytest `test_logo_rebuild.py` + `test_logo_rebuild_feature_gate.py` | **66/66 pass** (14 test mới trong đợt này) |
| vitest logo + i18n + routing + panel + tabNavigation | **74/74 pass** |
| `npm run typecheck` | pass |
| ESLint hẹp 5 file TS đã sửa | `LogoRebuildWorkspace.tsx`, `features.ts` sạch; lỗi còn lại trong `ImpositionTab.tsx`/`PreprocessingRouter.tsx`/`toolRegistry.ts` là nợ legacy có sẵn (any/unused-vars, không thuộc dòng đã sửa) |
| cargo test Logo | **Không chạy** — đợt này không chạm native Rust |
| Runtime Tauri (picker → preview → save → mở SVG 1:1) | **Chưa chạy — còn mở.** HOLD/NO-GO production giữ nguyên cho tới khi có runtime + JPEG holdout khách có vector gốc |

## Ngoài phạm vi Logo (sửa kèm, minh bạch)

- `tabs.compare:da_huy_so_sanh` thiếu trong locale làm `i18nCatalog.test.ts` đỏ toàn cục — key này do `CompareTab.tsx` (đợt sửa khác đang dở trong worktree) tham chiếu. Đã bổ sung vi/en khớp fallback trong code để catalog xanh; không đổi hành vi CompareTab.

## Trạng thái

- Production: **HOLD/NO-GO giữ nguyên** (đúng chốt của báo cáo).
- Ma trận: `W3-U03` nâng lên `AUTO` + `ARTIFACT-PARTIAL` (rerun đủ, thêm regression engine thật); khoảng trống còn lại: runtime Tauri, JPEG holdout, mở SVG 1:1 trong Illustrator/Corel.
