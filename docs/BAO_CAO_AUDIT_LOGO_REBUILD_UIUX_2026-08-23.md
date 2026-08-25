# Báo cáo audit — Vector hóa Logo (UI/UX + chức năng), 2026-08-23

**Workspace:** `D:\pdfcompare`  
**Trạng thái:** audit chỉ đọc; **chưa sửa product code**.  
**Báo cáo kế thừa:** `docs/BAO_CAO_AUDIT_LOGO_REBUILD_2026-08-13.md` và `docs/LOGO_REBUILD_FIXES_2026-08-13.md`.  
**Quy ước:** `routes/...` dưới đây là `backend/app/api/routes/...`; `workers/...` là `backend/app/workers/...`.  
**Mức bằng chứng:** `[CONFIRMED]` = thấy trực tiếp trong code và/hoặc tái hiện được bằng harness; `[PROOF GAP]` = chưa đủ bằng chứng để kết luận artifact/runtime; `[EXPECTED]` = hành vi đã được đặc tả, không mở lại thành bug.

## 1. Tóm tắt điều hành

Luồng đã được trace dọc từ Home/registry → entitlement → `ImpositionTab` →
`LogoRebuildWorkspace` → `logoRebuildApi.ts` → FastAPI → heavy scheduler →
`workers/logo_rebuild.py` → Rust Logo Engine v2 → QC/SVG → preview/save.

Có **4 finding P1** ảnh hưởng trực tiếp đến độ đúng của artwork hoặc khả năng
nghiệm thu, và **7 finding P2/P3** về hợp đồng, tài nguyên, UI/UX và
accessibility. Không thấy P0 và không thấy đường bypass entitlement. Điểm rủi ro
lớn nhất là: compare overlay sai hệ tọa độ sau crop/perspective; FlatColor có
thể nuốt chi tiết nhỏ mà vẫn trả `ready`; alpha bán trong suốt bị ghi thành
path đục; và polarity đơn sắc có thể đảo logo khi artwork chạm biên.

**Kết luận phát hành:** tiếp tục `HOLD/NO-GO` production. Ma trận hiện tại vẫn
đúng với `W3-U03 = AUTO + ARTIFACT-PARTIAL`; chưa có bằng chứng `RUNTIME`.

## 2. Phạm vi và đường chạy

| Tầng | Điểm đã kiểm |
|---|---|
| UI | picker/drop, preflight, palette, crop/perspective, mm, compare viewport, review/export, dirty/revision, active tab, Pro overlay, keyboard/wheel |
| API | capabilities, preflight, preview, cancel, error mapping, upload limit, scheduler/admission |
| Worker | decode/ICC, crop/warp, mm ratio, upscale, illumination, monochrome polarity, palette suggestion, RAM/cancel |
| Native | RGBA → labels/alpha → despeckle → topology → curve-fit → SVG writer/QC |
| Artifact/release | save bytes, reopen/render 1:1, JPEG holdout, Tauri runtime, installer/release flag |

## 3. Bảng finding

| Mã | Ưu tiên | Trạng thái | Kết luận ngắn |
|---|---:|---|---|
| §LR5.01 | P1/M | `[CONFIRMED]` | Compare split/overlay dùng sai hệ tọa độ sau crop hoặc perspective; QA trực quan có thể chấp nhận artifact lệch. |
| §LR5.02 | P1/M | `[CONFIRMED]` | FlatColor khử component nhỏ theo mặc định 4 px nhưng không cảnh báo trên ảnh không upscale; dấu thương hiệu có thể biến mất và kết quả vẫn `ready`. |
| §LR5.03 | P1/M | `[CONFIRMED]` | Alpha bán trong suốt được phân loại như pixel đầy đủ và writer luôn sơn alpha 255; SVG mất coverage/opacity. |
| §LR5.04 | P1/M | `[CONFIRMED]` | Monochrome suy nền từ đa số pixel ở border; logo/khung chạm biên có thể bị đảo polarity mà QC vẫn `ready`. |
| §LR5.05 | P2/M | `[CONFIRMED]` | UI/backend tính tỷ lệ mm trên hình học liên tục nhưng worker kiểm tỷ lệ sau làm tròn crop/warp; workflow hợp lệ bị 422. |
| §LR5.06 | P2/S | `[CONFIRMED — resource risk]` | Preflight palette chạy ngoài heavy scheduler/RAM reservation; áp lực tài nguyên khi nhiều ảnh lớn là rủi ro còn mở. |
| §LR5.07 | P2/S | `[CONFIRMED STATIC]` | Pro overlay không chặn custom native-drop listener; surface khóa vẫn nhận file và gửi request rồi nhận 403. Không phải bypass license. |
| §LR5.08 | P2/M | `[CONFIRMED A11Y]` | Crop/perspective handles là `<button>` nhưng pointer-only; Enter/Space/phím mũi tên không điều khiển được handle. |
| §LR5.09 | P2/S | `[CONFIRMED UX]` | Wheel listener nuốt mọi cuộn; ở zoom 1 canvas trở thành scroll trap của panel/trang. |
| §LR5.10 | P2/S | `[CONFIRMED UX]` | Upload phía UI chỉ kiểm extension; file đổi đuôi/hỏng/quá lớn chỉ thất bại muộn ở preflight. |
| §LR5.11 | P2/S | `[CONFIRMED DESIGN RISK]` | `reviewAccepted` tự đặt `true` cho kết quả `ready`; semantics “đã kiểm tra” dễ bị hiểu là người dùng đã xác nhận. Theo contract hiện tại `ready` được phép xuất, nên đây cần chốt product trước khi sửa. |
| §LR5.12 | P3/S | `[CONFIRMED UX]` | Coverage palette làm tròn số nguyên; màu 0–0,49% hiển thị `0%`, che dấu màu nhấn nhỏ. |
| §LR5.13 | P3/S | `[CONFIRMED A11Y]` | Nút reset zoom chỉ có `title`, pan hint không nối `aria-describedby` với viewport `role="application"`. |

## 4. Chi tiết bằng chứng

### §LR5.01 — Compare split/overlay sai hệ tọa độ sau crop/perspective (P1/M)

`LogoRebuildWorkspace.tsx:1331-1359` truyền **ảnh nguồn nguyên bản** cùng
`previewUrl` SVG đã qua selection. `LogoCompareViewport.tsx:73,
259-278,331-340` lấy kích thước tự nhiên của toàn ảnh để dựng một artboard và
fit cả hai lớp bằng `object-contain`. Selection ở `:342-396` chỉ vẽ overlay
crop/4 điểm; không cắt/warp ảnh nguồn theo cùng biến đổi.

Do đó, với crop hoặc perspective, SVG có kích thước/hệ tọa độ của vùng đã chọn
nhưng ảnh gốc vẫn là toàn canvas. Split/overlay có thể cho cảm giác hai lớp
trùng nhau do cùng được fit vào artboard, trong khi căn nét thực tế lệch. Đây là
lỗi hợp đồng QA, không chỉ là khác biệt thẩm mỹ.

**Đề xuất:** compare một raster reference đã áp dụng đúng crop/warp (hoặc tắt
split/overlay khi selection khác `full`); thêm test artifact/render kiểm tra
điểm đánh dấu ở bốn góc vùng chọn.

### §LR5.02 — FlatColor nuốt chi tiết nhỏ nhưng không chuyển `review` (P1/M)

`native/src/logo_engine/preprocess.rs:52-67,98-164` lưu mọi pixel alpha > 0 vào
label palette; `despeckle_artifact` gộp component nhỏ hơn
`despeckle_size_px²` vào nhãn lân cận. `profiles/flat_color.rs:20-34` gọi khử
hạt trước khi dựng contour. `native/src/logo_engine/result.rs:125-131` chỉ thêm
warning khi profile là **Silhouette**, không có warning tương ứng cho FlatColor.

UI vẫn khởi tạo `despeckle = 4` (`LogoRebuildWorkspace.tsx:67-93,516-546`).
Hint mới chỉ hiện khi `willUpscaleSource(...)` (`:1287-1297`), nên ảnh 600×600
hoặc lớn hơn vẫn dùng 4 px mà không được nói rằng component 3×3 sẽ bị gộp.

**Harness native/worker:** ảnh 600×600 palette đen + đỏ, dấu đỏ 3×3:

| `despeckle` | trạng thái | dấu đỏ trong SVG | warning |
|---:|---|---|---|
| 0 | `ready` | còn | `[]` |
| 4 | `ready` | mất | `[]` |

Test hiện có `backend/tests/test_logo_rebuild.py:824-851` khóa ca 100×100,
nhưng không khóa cảnh báo/giữ dấu cho ảnh không upscale. Hướng sửa là hiển thị
ngưỡng mất chi tiết theo px nguồn và chuyển `review` khi component hợp lệ bị
gộp; không tự đặt cap chất lượng trên máy mạnh.

### §LR5.03 — Alpha bán trong suốt thành path đục (P1/M)

Hợp đồng IR ghi rõ coverage alpha 1–255 được giữ để downstream dùng
(`native/src/logo_engine/scene.rs:136-145`). Thực tế:

- `preprocess.rs:52-67` chỉ coi `alpha == 0` là transparent; alpha 1 được gán
  nhãn như pixel đầy đủ.
- `topology.rs:24-74` dựng contour từ labels, không dùng độ coverage.
- `native/src/logo_engine/color.rs:20-25` tạo `SolidPaint` với alpha `255` cho
  mọi palette màu.
- `svg_writer.rs:83-97,183-190` chỉ ghi opacity nếu paint có alpha khác 255;
  vì vậy output thường không có `fill-opacity`.

Harness dùng cùng RGB/hình học với hai input alpha=1 và alpha=255: SVG/hình học
đầu ra tương đương và không có opacity cho vùng bán trong suốt. Kết quả vẫn
`ready`; QC tự so với raster đã nhãn hóa nên không bắt được sai khác coverage.

**Tác động:** antialias/viền mềm, artwork có shadow nhẹ hoặc logo trên nền
trong suốt bị đục hóa khi mở ở nền khác. Cần chọn một contract rõ ràng: giữ
coverage thành opacity/gradient có kiểm soát, hoặc threshold alpha và bắt buộc
warning/review; hiện code và comment đang mâu thuẫn.

### §LR5.04 — Monochrome polarity đảo khi logo chạm biên (P1/M)

`workers/logo_rebuild.py:524-546` lấy Otsu rồi suy nền bằng đa số pixel ở
khung ảnh (`border_values`, `low_is_background`). Với ảnh nền trắng có khung
đen dày chạm cả bốn biên, border majority không còn đại diện cho nền.

Harness cho ca này cho thấy output monochrome có alpha ở border = 0, tâm = 255
(logo/khung bị đảo cách hiểu), nhưng preview vẫn `ready`; IoU cao vì QC so với
ảnh đã normalize cùng polarity. Đây là lỗi semantic ở input tight-crop, không
phải lỗi đo IoU.

**Đề xuất:** preflight phát hiện border không đồng nhất/foreground chạm biên,
đưa `review` và cho user chọn polarity/nền; không tự đảo khi độ tin cậy thấp.

### §LR5.05 — Mismatch tỷ lệ mm do crop/warp rounding (P2/M)

UI tính `sourceAspectRatio` liên tục (`LogoRebuildWorkspace.tsx:835-853`) và
làm tròn cặp mm còn 4 chữ số (`:130-132,864-893`). Input mm có `min=0.1,
step=0.1` (`:1231-1252`). Worker lại áp crop bằng `floor/ceil`
(`backend/app/workers/logo_rebuild.py:420-429`), perspective bằng target pixel
đã `round` (`:191-203,445-460`), rồi kiểm `math.isclose(... rel_tol=0.0001)`
(`:810-818`). Hai phép tính không dùng cùng canvas thực tế.

Repro đã chạy:

- 320×180, crop `{x:0,y:0,width:.33,height:.33}`: UI gửi `10.0 × 5.625 mm`,
  worker crop thành 106×60 (tỷ lệ 1.7667 so với 1.7778) và trả
  `LogoInputError`.
- 600×600 perspective hợp lệ: UI ratio ≈ 1.10191866, cặp `100 × 90.7508 mm`;
  backend warp thành 539×489 (ratio ≈ 1.10224949) và từ chối.
- 314×100 full image, kích thước nhỏ nhất `0.1 × 0.0318 mm` cũng bị từ chối;
  sai số tương đối ≈ 0.00148219.

**Đề xuất:** tính ratio từ kích thước pixel sau cùng mà worker sẽ dùng, hoặc nới
contract theo sai số lượng tử hóa có chứng minh; thêm regression crop/perspective
→ mm → preview thật.

### §LR5.06 — Preflight palette ngoài admission/RAM reservation (P2/S)

Upload tối đa 500 MB (`backend/app/config.py:36`). Route đọc toàn payload và
inspect (`backend/app/api/routes/logo_rebuild.py:220-244`), sau đó gọi
`suggest_logo_palette` qua `run_in_threadpool` trực tiếp (`:263-290`). Preview
mới đi `reserve_logo_job` + `run_scheduled_in_threadpool`
(`:299-321`). Trong worker, preflight tạo RGBA/numpy/OpenCV arrays và có thể
resize lưới (`workers/logo_rebuild.py:565-671`) mà không có reservation tương
ứng.

Đường chạy/admission gap là **confirmed**; OOM cụ thể khi đồng thời nhiều
upload lớn chưa được runtime benchmark nên phần tác động là `[SUSPECTED]`. Đây
là residual của class rủi ro đã nêu ở `BAO_CAO_AUDIT_LOGO_REBUILD_LAN2_2026-08-02.md`,
không báo lại như finding hoàn toàn mới.

### §LR5.07 — Native drop không tôn trọng entitlement overlay (P2/S)

`ImpositionTab.tsx:3529` vẫn mount workspace với `isActive`; overlay khóa chỉ
được render ở `:4135-4137`. Listener custom event trong
`LogoRebuildWorkspace.tsx:612-628` chỉ kiểm `isActive/tabId`, không nhận trạng
thái `activeToolLocked`. Sau khi nhận file, `selectFile`/preflight chạy theo
`:516-547`. Vì vậy native custom-drop có thể gửi request từ surface đang bị phủ,
backend mới trả 403. Không có bypass license, nhưng tạo upload/I/O và lỗi ẩn
phía sau overlay.

### §LR5.08 — Handles pointer-only (P2/M, A11Y)

Các crop handles `LogoCompareViewport.tsx:364-372` và perspective handles
`:381-391` là `<button>` có `aria-label` nhưng chỉ có `onPointerDown`. Enter/Space
không kích hoạt di chuyển; phím mũi tên đi vào handler viewport
`:165-176,312-324` và pan toàn canvas. Numeric fields ở workspace
`:1175-1203` là đường thay thế nhưng không làm semantics của handle trực tiếp
đúng. Cần keyboard step/roving focus hoặc đổi semantics thành control pointer
đúng với mô tả.

### §LR5.09 — Wheel scroll trap (P2/S)

`LogoCompareViewport.tsx:103-121` luôn `preventDefault()` và `stopPropagation()`;
Ctrl+wheel zoom, mọi wheel khác pan (`:113-117`) kể cả zoom=1. Layout workspace
xếp panel dọc dưới breakpoint XL (`LogoRebuildWorkspace.tsx:961-962`), nên hover
canvas sẽ nuốt cuộn trang/aside. Chưa có wheel regression test.

### §LR5.10 — Upload validation chỉ extension (P2/S)

`LogoRebuildWorkspace.tsx:516-521` chỉ kiểm tên `.png/.jpg/.webp`; native/drop
path `:608-645` nhận file hợp lệ theo tên mà không probe MIME/decode/size/dimension
ở client. Backend cuối cùng vẫn verify (`routes/logo_rebuild.py:220-244`), nhưng
lỗi đến muộn và thông báo generic; file đổi đuôi hoặc ảnh rất lớn có thể tạo
trải nghiệm “đã nhận” rồi mới thất bại. Có thể bổ sung probe bất đồng bộ và phản
chiếu giới hạn backend, không hard-cap mới không có policy.

### §LR5.11 — Semantics review gate cần chốt product (P2/S, design risk)

`replacePreview` đặt `reviewAccepted(result.status === 'ready')`
(`LogoRebuildWorkspace.tsx:413-425`). Với `review`, UI mới hiển thị nút
“Tôi đã kiểm tra và vẫn muốn xuất” (`:1404-1415`); với `ready`, export được phép
theo `canExport`/`exportSvg` (`:647-824,1361-1366`). Đây là **đúng với contract
đã ghi**: QC `ready` không cần override, `review` mới cần xác nhận. Tuy nhiên
tên state và copy dễ bị hiểu thành “đã có người kiểm tra”.

**Không tự sửa trong lượt audit:** product cần chọn một trong hai contract:
(a) giữ auto-export cho `ready` và đổi tên/copy cho rõ “QC đạt”, hoặc (b) bắt
buộc acknowledgement người dùng cho mọi artifact trước khi tải.

### §LR5.12/§LR5.13 — Precision và discoverability (P3)

`LogoRebuildWorkspace.tsx:1046-1088` hiển thị
`Math.round(suggestion.coverage_ratio * 100)`, nên màu có coverage dương dưới
0,5% thành `0%`. `LogoCompareViewport.tsx:303` reset zoom chỉ có `title`; hint
ở `:400-401` không gắn `aria-describedby` với viewport
`:312-324`. Toolbar mode đã có `aria-pressed`/disabled (`:285-297`), và
error/status đã có `role=alert`/`role=status` (`Workspace.tsx:1321-1322`).

## 5. Những điểm đã kiểm và không mở lại thành bug

- Picker button + hidden input/`accept` (`LogoRebuildWorkspace.tsx:971-990`).
- Active-tab/native-drop routing, dirty-session, stale revision, undo/redo và
  cancel lifecycle đã có test; listener vẫn cần entitlement guard như §LR5.07.
- Palette màu yêu cầu user xác nhận; limitations panel hiện rõ.
- `ready | review | rejected` và export gate hiện đúng contract hiện tại;
  §LR5.11 chỉ là quyết định copy/semantics.
- i18n VI/EN catalog/routing baseline xanh; không mở lại các finding cũ đã ghi
  trong `LOGO_REBUILD_FIXES_2026-08-13.md`.

## 6. Baseline verify trong phiên audit

| Cổng | Kết quả |
|---|---|
| Backend Logo + feature gate | `66 passed`, 2 warning dependency/deprecation |
| Frontend targeted Vitest (workspace, routing, tool panel, i18n, tab navigation) | 5 file, `75 passed` |
| TypeScript | `npm run typecheck` — pass |
| Native Logo | `cargo test --locked --lib logo` — `69 passed`, 34 filtered |
| Static/runtime contract | Không có installer/runtime artifact logo để kiểm |
| Tauri/browser visual | Chưa chạy được; browser helper trả `helper_unknown_error` |

Lưu ý: UI tests mock toàn bộ API (`LogoRebuildWorkspace.test.tsx:24-30`),
backend preview route test thay worker bằng fake (`backend/tests/test_logo_rebuild.py:552-634`),
và save test chỉ assert `saveBlob` call (`:753-805`). Vì vậy các cổng xanh trên
không chứng minh HTTP → native → SVG bytes → reopen.

## 7. Proof gaps còn mở

1. Tauri runtime thật: picker/drop → preflight → preview native → save bytes →
   mở SVG 1:1 trong Illustrator/CorelDRAW/Inkscape.
2. JPEG holdout khách có vector ground truth; test JPEG hiện là fixture tổng hợp
   cho palette (`backend/tests/test_logo_rebuild.py:322-343`).
3. Render/reopen artifact sau `saveBlob`, thay vì mock call; compare parity cho
   crop/perspective.
4. Packaged/release installer và sidecar logo; test hiện tại chỉ assert source
   flag/HOLD (`backend/tests/test_artifact_runtime_self_test.py:327-371`).
5. Corpus logo thật (alpha bán trong, khung chạm biên, nét nhỏ, nhiều màu) và
   renderer/RIP độc lập.
6. Phase progress/cancel telemetry: kế hoạch Engine v2 vẫn ghi callback progress
   là khoảng trống (`docs/KE_HOACH_PRYNX_LOGO_ENGINE_V2_2026-08-10.md:53-60`);
   không tạo progress giả từ phía UI.

## 8. Đề xuất lô sửa (chưa thực hiện, chờ duyệt)

Mỗi lô giữ tối đa 5 file và phải verify hẹp trước khi sang lô kế:

1. **Lô A — compare contract (P1):** `LogoRebuildWorkspace.tsx`,
   `LogoCompareViewport.tsx`, test UI + artifact/render test. Chốt cùng hệ tọa
   độ hoặc disable split/overlay khi crop/perspective.
2. **Lô B — input geometry (P1/P2):** `LogoRebuildWorkspace.tsx`,
   `backend/app/workers/logo_rebuild.py`, schema/test liên quan. Dùng kích thước
   crop/warp thực tế cho cả UI và writer; thêm regression mm/crop/perspective.
3. **Lô C — native image semantics (P1):** `preprocess.rs`, `scene.rs`,
   `color.rs`, `topology.rs`, `svg_writer.rs` (có thể tách C1/C2 để ≤5 file),
   quyết định threshold/opacity alpha và warning/QC; thêm test alpha coverage.
4. **Lô D — monochrome + resource admission (P1/P2):** worker, route,
   scheduler/helper và backend tests. Cảnh báo polarity thiếu tin cậy; đưa
   preflight palette qua admission/RAM policy với RAM-gating đúng quy ước.
5. **Lô E — UI resilience/a11y (P2/P3):** viewport/workspace + tests; keyboard
   handles, wheel handoff, MIME/decode feedback, coverage precision, aria help,
   native-drop entitlement guard. Không thêm hard-cap máy mạnh.

**Chưa được phép sửa source trong lượt này theo quy trình audit 2 chốt.** Sau khi
user duyệt lô nào, sửa theo lô đó và chạy verify Windows thật tương ứng.

## 9. Kết luận / yêu cầu chốt

- Dev hiện phù hợp để nghiệm thu artwork phẳng với palette do người dùng xác
  nhận, nhưng không nên coi `ready` là bằng chứng thay thế cho render/reopen
  thực tế.
- Production giữ `HOLD/NO-GO`; không nâng `W3-U03` lên `RUNTIME`.
- Mời user duyệt phạm vi/lô sửa ở mục 8. Mình sẽ không tự sửa product code trước
  khi có chốt duyệt.
