# Báo cáo audit — Phục hồi & Vector hóa Logo, 2026-08-13

**Đối chiếu:** worktree `d:\pdfcompare`, ngày 2026-08-13.  
**Báo cáo trước:** `BAO_CAO_AUDIT_LOGO_REBUILD_2026-08-09.md` và nhật ký `LOGO_REBUILD_FIXES_2026-08-09.md`, `LOGO_ENGINE_V2_FIXES_2026-08-10.md`.  
**Trạng thái mã:** audit chỉ đọc; **chưa sửa** sản phẩm.  
**Quy ước trích dẫn:** repo có hai file trùng tên — `routes/logo_rebuild.py` = `backend/app/api/routes/logo_rebuild.py`, `workers/logo_rebuild.py` = `backend/app/workers/logo_rebuild.py`.  
**Hiệu chỉnh re-audit 2026-08-13 (cùng ngày, trước khi sửa lô):** §LR4.01 nắn lại quy kết nguyên nhân + sửa claim sai về test; §LR4.02 sửa số 0,5625% (bản trước ghi nhầm 1,125%) và bổ sung cơ chế sàn coverage tương đối; §LR4.03 sửa chữ "comment" thành "message của exception". Các trích dẫn `file:dòng` còn lại đã đối chiếu khớp code.  
**Phạm vi:** Home/registry → entitlement Pro → tab/workspace → preflight/preview/cancel/save → scheduler/RAM → prepare ảnh → PrynX Logo Engine v2 (PyO3 structured) → QC → SVG preview/lưu.  
**Ngoài phạm vi:** AI dựng phần logo bị che, corpus logo khách có vector gốc, nghiệm thu Illustrator/CorelDRAW/RIP, installer release, fuzz Pillow/OpenCV.

## Tóm tắt điều hành

Đường chạy **dev** hiện đã chuyển lõi: UI luôn gửi `engine=prynx_core`, backend mặc định gọi `logo_vectorize_structured_rgba`, VTracer chỉ còn nhánh đối chiếu khi dev bật cờ tường minh. Các finding §LR3.01–§LR3.13 của vòng 2026-08-09 **vẫn đóng ở mức code/test (M2)**; không thấy hồi quy entitlement Free→Pro hay phá HOLD production.

Tính năng **vẫn NO-GO production**. Có **5 finding mới `[CONFIRMED]`** trên đường live Engine v2, trong đó **2 P1** liên quan đúng ca người dùng chính: logo raster nhỏ / scan độ phân giải cao. Bằng chứng chung của đợt này là `TRACED` + toán học xác định từ code; không nâng `RUNTIME` vì chưa chạy lại chuỗi Tauri/picker/save/mở SVG 1:1 trong phiên audit này. Harness Python chứng minh số bị gián đoạn — không dùng số đo runtime mới.

**Không có P0** (không thấy sai kết quả bắt buộc trên mọi ca, không thấy bypass license).

## Kiến trúc / đường chạy đã trace

1. **Entry UI:** card Home chỉ sinh khi `LOGO_REBUILD_ENABLED` (`DEV || VITE_LOGO_REBUILD_ENABLED`) — `toolRegistry.ts:723-734`. Badge `PRO` / `🔒 PRO` từ `ProFeatureBadge.tsx:15-16`. Nút `?` mở `longDescription`, không phải help kỹ thuật — `HomeTab.tsx:106-121`.
2. **Tab:** `ImpositionTab` mount overlay `z-[110]` và giữ workspace sau lần mở — `ImpositionTab.tsx:2856-2871`. Free user bị `FeatureAccessOverlay` khi `!canUse(util.logo_rebuild)` — `ImpositionTab.tsx:2623-2625, 3470-3471`.
3. **Workspace:** file/editor/history/preview/job local — `LogoRebuildWorkspace.tsx`. Picker + DOM drop + event `prynx-logo-rebuild-add-files`. Dirty đẩy lên tab; Save SVG qua `saveBlob`.
4. **API:** `logoRebuildApi.ts` → `GET/POST/DELETE /logo-rebuild/*`. Router fail-closed HOLD rồi mới `require_feature("util.logo_rebuild")` — `routes/logo_rebuild.py:103-108`.
5. **Engine:** `process_logo_preview` reserve job + RAM → `prepare_logo_image` (ICC, crop/quad, upscale NEAREST, illumination, chuẩn hóa mono) → structured core hoặc VTracer legacy → `analyze_logo_svg` — `workers/logo_rebuild.py:1282-1310, 713-822, 1095-1279`.
6. **Native:** `logo_vectorize_structured_rgba` → profile Silhouette/FlatColor → writer/QC. Production dev không còn trả chuỗi VTracer trừ khi chọn legacy.
7. **Consumer:** `<img>` / viewport so sánh + `saveBlob` ghi SVG. Chưa có đường đưa SVG vào project/imposition.

## Hợp đồng đã kiểm

| Biên | Hợp đồng hiện tại | Kết quả |
|---|---|---|
| Mode | Chỉ `monochrome` / `fixed_palette`; UI mặc định màu | Đúng; auto-color vẫn tắt |
| Engine | UI cứng `prynx_core`; VTracer chỉ dev + `PRYNX_LOGO_LEGACY_VTRACER_ENABLED` | Đúng; compiled không mở legacy |
| Palette | 1–12 `#RRGGBB`; preview màu bắt `paletteConfirmed` | Đúng ở client; gợi ý high-res còn lỗ §LR4.02 |
| Nền | Phải khác palette; CTA “Đặt làm nền” đã có từ Lô D3 | Không thấy hồi quy |
| mm | Cặp rộng/cao bắt buộc; DPI chỉ nút gợi ý | Đúng; thiếu mm → `review` có chủ đích |
| RAM | `<16 GB` mới giảm; `≥16 GB` giữ full nếu đủ; reservation nguyên tử | Giữ nguyên tắc; mất reservation khi không đọc được RAM §LR4.05 |
| Upscale ảnh nhỏ | Cạnh ngắn `<600` → 1200/900/600 theo tier RAM; nội suy NEAREST | Đúng code; đây không phải Real-ESRGAN §LR4.07 |
| Khử hạt | Mặc định 4 px; FlatColor thực thi `size²`; Silhouette chưa làm → `review` | Silhouette đúng khai báo; scale theo upscale gây §LR4.01 |
| Release | Frontend `VITE_*`; backend `PRYNX_LOGO_REBUILD_ENABLED`; compiled mặc định 404 | HOLD fail-closed; không gọi là bypass |
| Quyền | `util.logo_rebuild` = Pro | Overlay + API 403 có test |

## Phát hiện đã xác minh

### §LR4.01 — P1/M — `[CONFIRMED]` Khử hạt mặc định 4 px theo không gian nguồn nuốt dấu/nét nhỏ hơn 4×4 px trên logo nhỏ

**Đường chạy:** chọn ảnh → `despeckle: 4` — `LogoRebuildWorkspace.tsx:86, 503-508` → `prepare_logo_image` nâng ảnh nhỏ bằng NEAREST — `workers/logo_rebuild.py:751-767` → `_scaled_despeckle_size` quy đổi cạnh theo `sqrt(work_area_scale)` — `workers/logo_rebuild.py:825-834` → FlatColor `despeckle_artifact` xóa component `< size²` — `preprocess.rs:98-120`.

**Bằng chứng (toán học xác định từ code, máy ≥16 GB):**

| Ảnh nguồn | Ảnh làm việc | `despeckle` gửi native | Ngưỡng diện tích bị xóa |
|---|---|---|---|
| 100×100 | 1200×1200 (`×12`) | `4 × 12 = 48` | `48² = 2304 px` làm việc ≡ `4² = 16 px` nguồn |
| Dấu 3×3 trên nguồn | 36×36 sau NEAREST | — | `1296 < 2304` → **bị nhập vào màu hàng xóm** |

**Hiệu chỉnh re-audit 2026-08-13 về nguyên nhân:** phép nhân theo `sqrt(work_area_scale)` KHÔNG làm ngưỡng khắc nghiệt hơn — nó bảo toàn đúng ngữ nghĩa "px ảnh nguồn" (dấu 3×3 = 9 px < 4² = 16 px nguồn nên bị nuốt kể cả khi không upscale). Thủ phạm là **giá trị mặc định 4 px theo không gian nguồn** áp lên đúng ca logo nhỏ cần "phục hồi": comment khi chọn JPEG nói "không tăng despeckle vì sẽ làm rơi dấu tiếng Việt" (`LogoRebuildWorkspace.tsx:501-508`) và tin rằng 4 là an toàn, nhưng 4 px nguồn đã đủ nuốt mọi chi tiết nhỏ hơn 4×4 px nguồn. Backend có phát warning quy đổi ("Khử hạt đã quy đổi từ 4 px… thành 48 px…" — `workers/logo_rebuild.py:1115-1124`) nên việc quy đổi không im lặng, nhưng **không có cảnh báo nào nói nội dung nhỏ có thể bị mất**.

**Consumer live:** FlatColor H2 đã thực thi khử hạt (không còn warning giả). Hành vi quy đổi ĐÃ có test khóa (`test_worker_scales_despeckle_area_with_upscale` — `test_logo_rebuild.py:676-744`: nguồn 100×50 → work 200×100, despeckle 4 → 8, warning quy đổi + mono ép review); *bản trước ghi nhầm là "không có test"*. Cái thật sự thiếu là regression chứng minh dấu nhỏ bị nuốt (100×100 có dấu 3×3).

**Tác động:** logo raster nhỏ (đúng tên tính năng) có dấu tiếng Việt / ® / chấm nhận diện < 4×4 px nguồn bị mất mà không có cảnh báo mất nét; IoU vẫn có thể cao vì pixel đã bị đổi từ preprocess. Hướng sửa: giữ ngữ nghĩa px nguồn (đã có test khóa), nhưng UI đặt mặc định an toàn (0) khi ảnh sẽ bị upscale; khi user vẫn đặt despeckle > 0 trên ảnh nhỏ thì cảnh báo rõ "chi tiết nhỏ hơn N×N px nguồn sẽ bị gộp"; thêm regression 100×100 có dấu 3×3.

### §LR4.02 — P1/M — `[CONFIRMED]` Bộ gợi ý màu nhấn chỉ chạy trên lưới 40.000 px; scan lớn làm mất dấu

**Đường chạy:** preflight → `suggest_logo_palette` — `routes/logo_rebuild.py:274-277` → downsample NEAREST khi `w×h > 40_000` — `workers/logo_rebuild.py:89, 546-559` → detector accent trên `sample_rgba`, không trên ảnh đầy đủ — `workers/logo_rebuild.py:624-671`.

**Bằng chứng:** `_MIN_SMALL_ACCENT_COVERAGE = 0.001` và `minimum_component_pixels = max(8, ceil(len(colors) * 0.0005))` tính trên **mẫu**. Ảnh 2000×2000 scale `√(40000/4e6) = 0.1`. Ô đỏ 15×15 nguồn còn ~2 px trên lưới 200×200, nhỏ hơn ngưỡng 20 px và coverage chỉ 0,005% → không vào `merged`. Cùng 15×15 trên 200×200 (không downsample) chiếm 0,5625% — nằm trong khung accent `[0,1%, 1%)` nên **được giữ qua nhánh accent** *(hiệu chỉnh re-audit: bản trước ghi nhầm 1,125% và gán nhầm "nhánh màu chủ đạo")*. Regression Lô B 2026-08-09 dùng fixture 200×200 nên **không khóa** đường high-res. **Bổ sung cơ chế từ re-audit:** mọi cổng hiện tại đều **tương đối** (theo coverage), nên ô 15×15 trên scan 2000×2000 có coverage thật 0,0056% < sàn 0,1% — kể cả chạy detector trên ảnh đầy đủ vẫn bị loại; muốn giữ dấu tuyệt đối nhỏ trên scan lớn phải bổ sung **sàn theo diện tích px nguồn** bên cạnh lưới đủ dày.

**Consumer live:** “Áp dụng gợi ý” / “Đặt làm nền” sao chép đúng `palette_suggestions` — `LogoRebuildWorkspace.tsx:525-538`. Preview màu bắt buộc palette đã xác nhận nên dấu sót sẽ bị quy về màu gần nhất.

**Tác động:** scan logo 2–8K (ca xưởng) mất chấm/màu nhận diện nhỏ trong gợi ý. Hướng sửa: chạy detector accent trên lưới đủ dày (gate theo RAM — máy mạnh dùng lưới lớn/full-res, máy yếu mới giảm) VÀ thêm nhánh sàn tuyệt đối theo px nguồn cho accent liền khối, sắc độ rõ dù coverage < 0,1%; thêm test 2000×2000 (dấu 15×15 tuyệt đối) vs 200×200.

### §LR4.03 — P2/S — `[CONFIRMED]` Lỗi hợp đồng native `ValueError` bị đổi thành HTTP 500

**Đường chạy:** `logo_vectorize_structured_rgba` — `workers/logo_rebuild.py:1151-1164` → `except ValueError` gói thành `RuntimeError` — `workers/logo_rebuild.py:1191-1192` → route map `RuntimeError` → 500 — `routes/logo_rebuild.py:328-329`.

**Bằng chứng:** message của exception tự thừa nhận đây là “hợp đồng đầu vào đã được backend xác nhận”. Mọi lệch palette/mm/label còn lại ở biên Rust sẽ hiện 500 “Không thể tạo SVG preview” thay vì 422 có hướng xử lý.

**Tác động:** user/dev không phân biệt lỗi nhập và lỗi engine; telemetry/retry sai. Đưa `ValueError` ra 422, giữ 500 cho panic/engine.

### §LR4.04 — P2/S — `[CONFIRMED]` Hủy không cắt được lúc `prepare_logo_image`

**Đường chạy:** cancel token chỉ kiểm trước/sau `prepare_logo_image` — `workers/logo_rebuild.py:1104-1113`. Bên trong: ICC, `warpPerspective` CUBIC, resize, illumination Gaussian, Otsu — `workers/logo_rebuild.py:368-524, 713-822`. Native QC đã có cancel theo hàng (Hotfix H1); khâu Python trước engine thì không.

**Tác động:** ảnh lớn + illumination/phối cảnh: nút Hủy phải chờ hết prepare. Cần checkpoint `token.is_cancelled` giữa các bước và truyền cancel vào cv2 nếu được.

### §LR4.05 — P2/S — `[CONFIRMED]` Không đọc được RAM thì bỏ reservation

**Đường chạy:** `_reserve_logo_work_size` nếu `read_memory_status_mb()` trả `None` thì `yield` đủ kích thước và `return` — không cộng `_RESERVED_LOGO_MEMORY_MB` — `workers/logo_rebuild.py:274-277`. `_plan_work_size` cùng nhánh giữ nguyên kích thước — `workers/logo_rebuild.py:250-251`.

**Tác động:** hai preview Logo song song trên máy không đọc được RAM có thể overcommit. Không được hard-cap vô điều kiện; hướng: fail-closed “không đo được RAM, hãy đóng bớt việc” hoặc reserve theo ước lượng thô + một slot.

### §LR4.06 — P2/S — `[CONFIRMED]` Ca mặc định gần như không bao giờ `ready` nếu đi đen trắng

**Đường chạy:** editor mặc định `despeckle: 4`, `physicalWidthMm: null` — `LogoRebuildWorkspace.tsx:76-89`. Preview không gửi mm → `analyze_logo_svg(..., require_physical_size=True)` → `review` — `workers/logo_rebuild.py:1239`, `logo_svg_cleanup.py:581-584`. Thêm mode `monochrome` + despeckle > 0 → ép `review` vì Silhouette chưa khử hạt — `workers/logo_rebuild.py:1247-1259`. UI đã cảnh báo cả hai.

**Tác động:** không sai artifact, nhưng nút Lưu mặc định khóa sau “Tạo preview” (phải tick xác nhận + nhập mm + với mono phải để khử hạt = 0). Nên tách “chưa nhập mm” khỏi “engine chưa làm khử hạt”, và đổi default mono về 0.

### §LR4.07 — P2/M — `[CONFIRMED]` Tên “Phục hồi” không khớp engine: chỉ nội suy NEAREST

**Đường chạy:** cạnh ngắn < 600 px luôn `_upscale_target_dimensions` rồi `Image.Resampling.NEAREST` — `workers/logo_rebuild.py:303-320, 758-767`. Không gọi `realesrgan_engine`. Limitations API vẫn đúng: “Chưa tự phục hồi phần logo bị che hoặc mất nét” — `routes/logo_rebuild.py:112-115`. Card Home: “Phục hồi & Vector hóa Logo” / “Tái tạo logo raster thành SVG…” — `toolRegistry.ts:725-729`.

**Tác động:** user hiểu là khôi phục nét (cùng họ Upscale 2×/4×). Preview `ready` + IoU cao chỉ chứng minh SVG chép raster đã pixelate. Đổi copy (“Dựng vector từ logo phẳng”) hoặc nối có kiểm soát sang upscale thật; không gọi đây là bug hình học.

## Finding cũ — không mở lại

| Mã | Trạng thái trên cây 2026-08-13 |
|---|---|
| §LR3.01 RAM/cancel/admission | `[CLOSED — M2]` reservation + queue-cancel còn trong worker/route |
| §LR3.02 accent < 1% trên ảnh nhỏ | `[CLOSED một phần]` fixture 200×200 còn đúng; high-res → §LR4.02 |
| §LR3.03 DPI ngầm thành mm | `[CLOSED — M2]` UI + schema + QC artifact |
| §LR3.04 dirty-session | `[CLOSED — M2]` `onDirtyChange` + Save theo tab |
| §LR3.05 drop theo tab | `[CLOSED — M2]` receiver `logo_rebuild` |
| §LR3.06–§LR3.13 | `[CLOSED — M2]` limitations, capabilities SM, palette CTA, i18n, a11y, HOLD backend |
| §LR3.14 SVG vào project PrynX | `[OPEN — P3 roadmap]` |
| §LR2.03 JPEG holdout khách | `[OPEN PROOF GAP]` |
| Engine v2 Lô A–H + H1–H4 | `[EXPECTED]` core đã vào backend dev; Silhouette despeckle và progress phase còn nợ đúng như nhật ký |

## Cổng verify trong phiên này

| Cổng | Kết quả |
|---|---|
| Trace entry → overlay → API → worker → native → QC → save | Đạt `TRACED` với `file:dòng` |
| Đối chiếu báo cáo 2026-08-09 và nhật ký Engine v2 / H1–H4 | Đạt; không phát hiện lại bug đã đóng |
| Harness Python despeckle/palette | **Gián đoạn**; không ghi số đo mới |
| pytest / vitest / cargo Logo | **Không chạy lại** trong phiên này; số cuối nhật ký 2026-08-12: backend Logo ~51, workspace 30, Rust Logo 69 |
| Runtime Tauri picker → preview → save → mở 1:1 | Chưa chạy |
| `audit_contracts.ps1` | Không chạy lại |

**Mức bằng chứng đợt này:** `TRACED` (+ `AUTO` thừa kế từ test hiện có, chưa tái xác nhận). Không phải `RUNTIME`.

## Ma trận phủ đề xuất

`W3-U03` (Logo) nên chuyển từ “ARTIFACT synthetic 2026-08-09 / VTracer” sang:

- `AUTO` (test hiện có, chưa rerun) + `ARTIFACT-PARTIAL` (smoke core 2026-08-11/12 trong nhật ký Engine v2)
- `STALE` đối với bằng chứng VTracer-as-production
- Khoảng trống: §LR4.01–§LR4.05, JPEG holdout, Tauri/runtime, Illustrator/Corel 1:1, release HOLD

## Đề xuất sửa theo lô — ĐÃ DUYỆT & THỰC HIỆN 2026-08-13

User duyệt toàn bộ cùng ngày; các lô A–E đã thực hiện và verify, chi tiết tại `LOGO_REBUILD_FIXES_2026-08-13.md`. Nội dung dưới đây giữ nguyên làm căn cứ.

1. **Lô A — §LR4.01 (≤5 file):** `workers/logo_rebuild.py`, `LogoRebuildWorkspace.tsx`, test backend (+ test workspace nếu cần). Chốt đơn vị khử hạt (px nguồn — giữ, đã có test); UI mặc định an toàn với ảnh sẽ bị upscale + cảnh báo mất chi tiết khi despeckle > 0 trên ảnh nhỏ; regression 100×100 có dấu 3×3. Không hard-cap chất lượng máy mạnh.
2. **Lô B — §LR4.02 (≤5 file):** `workers/logo_rebuild.py` + `test_logo_rebuild.py`. Accent trên lưới đủ dày gate theo RAM + sàn tuyệt đối theo px nguồn; test 2000×2000 (dấu 15×15 tuyệt đối) vs 200×200.
3. **Lô C — §LR4.03–§LR4.05 (≤5 file):** map `ValueError`→422; checkpoint cancel trong prepare; reservation khi không đọc được RAM.
4. **Lô D — §LR4.06–§LR4.07 (copy/default):** default mono despeckle 0; tách lý do `review`; đổi title/longDescription “Dựng vector”, giữ limitations.
5. **Lô E — cổng bằng chứng (không GO):** rerun pytest/vitest/cargo Logo; một ca Tauri dev; giữ HOLD cho tới JPEG holdout + mở SVG 1:1.

§LR3.14 (round-trip PrynX) và Centerline/Pixel-art **không** vào đợt này.

## Kết luận / chốt duyệt

- **Production:** tiếp tục `HOLD/NO-GO`.
- **Dev:** dùng được để nghiệm thu artwork phẳng, palette xác nhận; phải biết upscale là NEAREST và default khử hạt đang nguy hiểm với logo nhỏ.
- **Bằng chứng:** `TRACED`; không tuyên bố hết bug.
- **Yêu cầu chốt:** duyệt Lô A→E ở trên. Sau duyệt mới sửa tối đa 5 file/lô, verify hẹp, ghi `LOGO_REBUILD_FIXES_2026-08-13.md`.
- **Cập nhật cùng ngày:** đã duyệt và thực hiện xong Lô A→E (backend logo 66/66, vitest 74/74, typecheck pass; regression engine thật cho §LR4.01). HOLD/NO-GO production giữ nguyên — còn runtime Tauri + JPEG holdout. Xem `LOGO_REBUILD_FIXES_2026-08-13.md`.
