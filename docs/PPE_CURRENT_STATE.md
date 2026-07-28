# PPE — TRẠNG THÁI HIỆN TẠI (SSOT)

**Cập nhật:** 2026-07-28
**Nguồn sự thật duy nhất** cho câu hỏi “PPE đang ở đâu, cái gì đã đóng, cái gì chưa”.

> `docs/PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md` là **kế hoạch + changelog**: nó chồng
> lớp theo thời gian và các mục cũ **không** được cập nhật khi trạng thái đổi. Đừng
> đọc con số ở đó để ra quyết định phát hành — đọc file này. Khi hai file lệch nhau,
> file này đúng.
>
> Vì sao tách: audit hai lần trong cùng một ngày đều bắt được người đọc lấy nhầm số
> cũ (§4.6 và §A.6 của hai báo cáo). Một tài liệu vừa là lịch sử vừa là hiện trạng
> thì không thể tin ở cả hai vai.

---

## 1. Kết luận phát hành

| Câu hỏi | Trả lời |
|---|---|
| Gỡ Ghostscript khỏi sản phẩm về mặt **mã nguồn/gate kỹ thuật**? | **ĐẠT** — release mặc định no-GS; ma trận 18×16 chốt 0 lần gọi GS và 0 lỗi ngoài dự kiến. |
| Phát hành **công khai** bản no-GS? | **CHƯA** — còn validator PDF/X độc lập, kiểm tay trên máy sạch và build artifact no-GS mới bằng quy trình phát hành hiện có. |
| Ghostscript còn là fallback? | Chỉ trong nhánh legacy opt-in `-WithGhostscript` hoặc môi trường dev có chủ đích. Bản no-GS không dò GS hệ thống và từ chối an toàn khi PPE chưa hỗ trợ. |

## 2. Số đo hiện hành

| Hạng mục | Số | Lệnh tái lập |
|---|---|---|
| Rust `print_engine` | **565 pass** | `cargo test --locked` trong `print_engine/` |
| Backend pytest | **1467 pass, 1 skip** | `cd backend && venv\Scripts\python.exe -m pytest -q` |
| Frontend Vitest | **1140 pass, 2 skip** | `cd desktop && npm.cmd test` |
| No-GS corpus | **18 PDF × 16 thao tác: 276 OK, 12 REFUSED, 0 GS, 0 ERROR** | `scripts/gs_dependency_audit.py private_test_corpus\incoming --limit 18 --gate` |
| Golden một-biến @100 DPI | **52 PASS, 0 FAIL, 1 khác GS có chủ ý** (53 fixture) | `scripts/ppe_golden_compare.py print_engine/golden/fixtures --dpi 100 --color-managed` |
| Golden một-biến @72 DPI | **50 PASS, 0 FAIL, 1 khác GS có chủ ý** (đo trước khi thêm cặp spot-overprint) | như trên, `--dpi 72` |
| Golden preflight @100 DPI | **17 PASS, 1 fixture JPEG stub chưa đủ tính năng** | `scripts/ppe_golden_compare.py backend/tests/preflight_fixtures/pdfs --dpi 100 --color-managed` |
| Fixture golden trong repo | **53 PDF** (thêm cặp spot-overprint 2026-07-27) | `print_engine/golden/fixtures/` |

Số ở bảng này **phải** được đo lại sau mỗi đợt sửa engine. Nếu không đo lại thì xoá
số đi, đừng để số cũ.

## 3. Sáu gate gỡ bundle GS (§8 của kế hoạch)

| # | Gate | Trạng thái |
|---|---|---|
| 1 | ≥95% job prepress 30 ngày không cần GS | **Đã loại khỏi gate** theo quyết định sản phẩm — thiết bị đo không tính được mẫu số, và không dựng số liệu giả để làm đẹp gate. |
| 2 | Separations + soft-proof + TAC chạy PPE mặc định, badge đúng | **ĐẠT** |
| 3 | ≥1 chuẩn PDF/X qua validator độc lập | **CHƯA** — chỉ có validator nội bộ |
| 4 | Convert CMYK / Downscale / Embed non-GS | **ĐẠT** |
| 5 | Flatten / Outline có quyết định sản phẩm rõ | **ĐẠT**: flatten raster PPE có cảnh báo; corpus hiện hành OUTLINE_FONTS 12/18 OK, 6/18 REFUSED; **13.985 glyph dùng PPE, 0 glyph lùi fontTools** |
| 6 | Build không copy GS + release QA xanh | **ĐẠT**: wrapper Release QA end-to-end đã xanh ngày 2026-07-28; no-GS là mặc định và audit corpus/typecheck/`print_engine` là gate bắt buộc. Artifact mới vẫn phải qua §5 |

## 4. Hành vi engine đã chốt

- **Đường đo** (tách kẽm, TAC): `InkSpace::new()` — mực pha giữ kẽm riêng, dữ liệu DeviceCMYK/Gray/Separation/DeviceN **không** qua ICC.
- **Đường xem** (soft-proof, Overprint Preview): `InkSpace::preview()` — mực pha giữ kênh riêng khi trộn, chỉ gộp về CMYK ở bước xuất ảnh qua bảng tra tint→CMYK. Đây là bản sửa 2026-07-27 §A.1; quy sớm như trước làm overprint của Pantone biến mất khỏi preview.
- **Overprint Preview**: hai ảnh knockout/overprint đều dựng bằng PPE; `simulate_overprint=false` chỉ vô hiệu hoá `/OP`,`/op`,`/OPM` tại ExtGState, không sửa file nguồn. Thiếu tin cậy thì **fail-loud**, không trả overlay rỗng.
- **Ngân sách RAM**: `<8 GB` giảm mạnh, `8–<16 GB` giảm nhẹ, `>=16 GB` không trần nhân tạo; chia theo số slot việc nặng; `PRYNX_PPE_MEMORY_BUDGET_MB` ghi đè.
- **`OUTLINE_FONTS`**: hình học chữ lấy từ PPE (`ppe_text_outlines`), pikepdf ghi PDF. Nguồn PPE **cộng thêm** vào đường fontTools, không thay thế; mỗi path bị kiểm nằm đúng vị trí bút để bắt lệch chỉ số; chốt so-kẽm từng trang giữ nguyên. Action fail-closed: thiếu font gốc, còn text sống, hoặc so kẽm lệch thì dừng và **xoá** output.
- **Ghostscript trên bản no-GS**: marker `binaries/gs/NO_GHOSTSCRIPT.txt` là lời khai của artifact; backend đọc nó và **không** dò GS hệ thống. Action/PDF-X PPE chưa hỗ trợ ném `InternalEngineUnsupported`, xoá output dở và trả `REFUSED`; không chạy subprocess rồi mới báo thiếu GS.

## 5. Ba chốt còn lại trước phát hành công khai

1. Chạy Acrobat Pro Preflight hoặc validator độc lập trên bộ output PDF/X-4 và PDF/X-1a đại diện; lưu report cùng artifact.
2. Kiểm tay đầy đủ UI trên máy sạch không chạy vòng dev (separations, soft-proof, TAC, Overprint Preview gồm ca **mực pha**, OUT FONT, flatten, PDF/X).
3. Build bản phát hành no-GS mới bằng `release_update.ps1`. Script tiếp tục đồng bộ version tự động; Tauri sinh file chữ ký cập nhật `.sig` cho từng phiên bản từ khóa updater hiện có. Sau build, chạy `scripts/verify_installed_artifact.ps1 -ExpectNoGhostscript` để điền `EXE_SHA256` và xác minh payload cài đặt không chứa GS. Authenticode không thuộc gate loại bỏ GS hiện tại.

## 6. Việc đã biết, chưa làm

| Việc | Vì sao chưa | Ghi ở |
|---|---|---|
| Mở rộng gate từ 18 lên đủ 33 PDF khách | Gate 18 file hiện đã đạt; 15 file còn lại cần manifest/hash ẩn danh trước khi dùng làm bằng chứng lặp lại | `GS_SUNSET_FIXES` §12 |
| Corpus khách không nằm trong repo | Không commit file khách; Release QA đọc `PRYNX_NO_GS_CORPUS` hoặc corpus riêng trên máy phát hành | Báo cáo lần 4 §3.3 |
| Telemetry đo tỉ lệ GS thật | Đã loại khỏi gate; nếu làm lại thì phải có mẫu số theo operation | Báo cáo lần 1 §4.2 |

## 7. Lịch sử và bằng chứng

- Kế hoạch + changelog: `PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md`
- Audit lần 1 (sáng 2026-07-27): `BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27.md`
- Audit lần 2 (chiều 2026-07-27): `BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27_LAN2.md`
- Audit sẵn sàng lần 3: `BAO_CAO_AUDIT_SAN_SANG_LOAI_BO_GHOSTSCRIPT_2026-07-27_LAN3.md`
- Audit sẵn sàng lần 4: `BAO_CAO_AUDIT_SAN_SANG_LOAI_BO_GHOSTSCRIPT_2026-07-27_LAN4.md`
- Nhật ký sửa: `GS_SUNSET_FIXES_2026-07-27.md`
- OUT FONT: `BAO_CAO_BO_SUNG_AUDIT_OUT_FONT_2026-07-27.md`, `OUT_FONT_FIXES_2026-07-27.md`
- Chuẩn hình học khuôn bế (không liên quan PPE): `audit-rules.md`
