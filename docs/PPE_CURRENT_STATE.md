# PPE — TRẠNG THÁI HIỆN TẠI (SSOT)

**Cập nhật:** 2026-08-08
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
| Runtime sản phẩm còn gọi Ghostscript? | **KHÔNG** — các luồng prepress thuộc tài liệu này chỉ dùng PPE, PDFium và các engine nội bộ; hàng rào subprocess chặn executable bị cấm trước khi tạo process. |
| Còn fallback hoặc chế độ opt-in cho engine cũ? | **KHÔNG** — không còn cờ build/release, biến môi trường hay nhánh runtime để bật lại. Tác vụ sửa file chưa được engine nội bộ hỗ trợ sẽ dừng an toàn và xoá output dở. |
| Pipeline phát hành đã theo hợp đồng PPE-only? | **ĐẠT** — build không tạo/bundle payload GS; verifier luôn quét binary và NOTICE, không phụ thuộc cờ hay marker. |
| Phát hành **công khai** artifact mới sau đợt dọn 2026-08-08? | **CHƯA XÁC NHẬN** — còn validator PDF/X độc lập, kiểm tay trên máy sạch và installed smoke trên artifact vừa build. |

## 2. Số đo đối chứng lịch sử — snapshot 2026-07-28

Các số dưới đây được giữ để so hồi quy, **không phải kết quả test hiện hành của
worktree 2026-08-08**. Công cụ `ppe_golden_compare.py` có thể dùng Ghostscript do
nhà phát triển tự cài làm renderer tham chiếu; công cụ đó không thuộc runtime hay
payload phát hành của PrynX.

| Hạng mục | Số | Lệnh tái lập |
|---|---|---|
| Rust `print_engine` | **565 pass** | `cargo test --locked` trong `print_engine/` |
| Backend pytest | **1467 pass, 1 skip** | `cd backend && venv\Scripts\python.exe -m pytest -q` |
| Frontend Vitest | **1140 pass, 2 skip** | `cd desktop && npm.cmd test` |
| Corpus PPE-only (tên phép đo cũ: no-GS) | **18 PDF × 16 thao tác: 276 OK, 12 REFUSED, 0 GS, 0 ERROR** | `scripts/gs_dependency_audit.py private_test_corpus\incoming --limit 18 --gate` |
| Golden một-biến @100 DPI | **52 PASS, 0 FAIL, 1 khác renderer GS tham chiếu có chủ ý** (53 fixture) | `scripts/ppe_golden_compare.py print_engine/golden/fixtures --dpi 100 --color-managed` |
| Golden một-biến @72 DPI | **50 PASS, 0 FAIL, 1 khác renderer GS tham chiếu có chủ ý** (đo trước khi thêm cặp spot-overprint) | như trên, `--dpi 72` |
| Golden preflight @100 DPI | **17 PASS, 1 fixture JPEG stub chưa đủ tính năng** | `scripts/ppe_golden_compare.py backend/tests/preflight_fixtures/pdfs --dpi 100 --color-managed` |
| Fixture golden trong repo | **53 PDF** (thêm cặp spot-overprint 2026-07-27) | `print_engine/golden/fixtures/` |

Khi có baseline mới, phải ghi ngày và artifact/corpus đi kèm; không đổi nhãn snapshot
trên thành “hiện hành” nếu chưa chạy lại toàn bộ phép đo.

## 3. Sáu gate thay engine — snapshot chốt 2026-07-28

Đây là bảng quyết định lịch sử đã dẫn tới hợp đồng PPE-only hiện tại; các bước QA
artifact còn mở được liệt kê riêng ở §5.

| # | Gate | Trạng thái |
|---|---|---|
| 1 | ≥95% job prepress 30 ngày không cần GS | **Đã loại khỏi gate** theo quyết định sản phẩm — thiết bị đo không tính được mẫu số, và không dựng số liệu giả để làm đẹp gate. |
| 2 | Separations + soft-proof + TAC chạy PPE mặc định, badge đúng | **ĐẠT** |
| 3 | ≥1 chuẩn PDF/X qua validator độc lập | **CHƯA** — chỉ có validator nội bộ |
| 4 | Convert CMYK / Downscale / Embed non-GS | **ĐẠT** |
| 5 | Flatten / Outline có quyết định sản phẩm rõ | **ĐẠT tại snapshot**: flatten raster PPE có cảnh báo; corpus khi đó có OUTLINE_FONTS 12/18 OK, 6/18 REFUSED; **13.985 glyph dùng PPE, 0 glyph lùi fontTools** |
| 6 | Build không copy GS + release QA xanh | **ĐẠT tại snapshot**: wrapper Release QA end-to-end đã xanh ngày 2026-07-28; audit corpus/typecheck/`print_engine` là gate bắt buộc. Artifact mới vẫn phải qua §5 |

## 4. Hành vi engine đã chốt

- **Đường đo** (tách kẽm, TAC): `InkSpace::new()` — mực pha giữ kẽm riêng, dữ liệu DeviceCMYK/Gray/Separation/DeviceN **không** qua ICC.
- **Đường xem** (soft-proof, Overprint Preview): `InkSpace::preview()` — mực pha giữ kênh riêng khi trộn, chỉ gộp về CMYK ở bước xuất ảnh qua bảng tra tint→CMYK. Đây là bản sửa 2026-07-27 §A.1; quy sớm như trước làm overprint của Pantone biến mất khỏi preview.
- **Overprint Preview**: hai ảnh knockout/overprint đều dựng bằng PPE; `simulate_overprint=false` chỉ vô hiệu hoá `/OP`,`/op`,`/OPM` tại ExtGState, không sửa file nguồn. Thiếu tin cậy thì **fail-loud**, không trả overlay rỗng.
- **Ngân sách RAM**: `<8 GB` giảm mạnh, `8–<16 GB` giảm nhẹ, `>=16 GB` không trần nhân tạo; chia theo số slot việc nặng; `PRYNX_PPE_MEMORY_BUDGET_MB` ghi đè.
- **`OUTLINE_FONTS`**: hình học chữ lấy từ PPE (`ppe_text_outlines`), pikepdf ghi PDF. Nguồn PPE **cộng thêm** vào đường fontTools, không thay thế; mỗi path bị kiểm nằm đúng vị trí bút để bắt lệch chỉ số; chốt so-kẽm từng trang giữ nguyên. Action fail-closed: thiếu font gốc, còn text sống, hoặc so kẽm lệch thì dừng và **xoá** output.
- **Chính sách runtime PPE-only**: không có đường khám phá hoặc khởi chạy Ghostscript. PPE/native là đường xử lý chính; PDFium chỉ làm đường hiển thị hoặc kết quả xấp xỉ có nhãn ở những luồng cho phép. Action/PDF-X chưa được engine nội bộ hỗ trợ sẽ ném `InternalEngineUnsupported`, xoá output dở và trả `REFUSED`/HTTP 422.

## 5. Ba chốt còn lại trước phát hành công khai

1. Chạy Acrobat Pro Preflight hoặc validator độc lập trên bộ output PDF/X-4 và PDF/X-1a đại diện; lưu report cùng artifact.
2. Kiểm tay đầy đủ UI trên máy sạch không chạy vòng dev (separations, soft-proof, TAC, Overprint Preview gồm ca **mực pha**, OUT FONT, flatten, PDF/X).
3. Build bản phát hành mới bằng `release_update.ps1`. Script tiếp tục đồng bộ version tự động; Tauri sinh file chữ ký cập nhật `.sig` cho từng phiên bản từ khóa updater hiện có. Sau build, chạy `scripts/verify_installed_artifact.ps1` để điền `EXE_SHA256`; verifier luôn từ chối binary hoặc NOTICE Ghostscript/Artifex/AGPL, không cần cờ hay marker. Authenticode không thuộc gate thay engine hiện tại.

## 6. Việc đã biết, chưa làm

| Việc | Vì sao chưa | Ghi ở |
|---|---|---|
| Mở rộng gate từ 18 lên đủ 33 PDF khách | Gate 18 file hiện đã đạt; 15 file còn lại cần manifest/hash ẩn danh trước khi dùng làm bằng chứng lặp lại | `GS_SUNSET_FIXES` §12 |
| Corpus khách không nằm trong repo | Không commit file khách; Release QA đọc `PRYNX_NO_GS_CORPUS` hoặc corpus riêng trên máy phát hành | Báo cáo lần 4 §3.3 |
| Telemetry lịch sử đo tỉ lệ GS | Đã loại khỏi gate và khỏi runtime; nếu nghiên cứu lại thì phải là công cụ đối chứng dev có mẫu số theo operation | Báo cáo lần 1 §4.2 |

## 7. Lịch sử và bằng chứng

- Kế hoạch + changelog: `PRYNX_GS_REPLACEMENT_ENGINE_PLAN.md`
- Audit lần 1 (sáng 2026-07-27): `BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27.md`
- Audit lần 2 (chiều 2026-07-27): `BAO_CAO_AUDIT_GS_REPLACEMENT_ENGINE_2026-07-27_LAN2.md`
- Audit sẵn sàng lần 3: `BAO_CAO_AUDIT_SAN_SANG_LOAI_BO_GHOSTSCRIPT_2026-07-27_LAN3.md`
- Audit sẵn sàng lần 4: `BAO_CAO_AUDIT_SAN_SANG_LOAI_BO_GHOSTSCRIPT_2026-07-27_LAN4.md`
- Nhật ký sửa: `GS_SUNSET_FIXES_2026-07-27.md`
- OUT FONT: `BAO_CAO_BO_SUNG_AUDIT_OUT_FONT_2026-07-27.md`, `OUT_FONT_FIXES_2026-07-27.md`
- Audit dọn sạch runtime/build hiện hành: `BAO_CAO_AUDIT_DON_SACH_GHOSTSCRIPT_2026-08-08.md`
- Nhật ký dọn sạch hiện hành: `GHOSTSCRIPT_CLEANUP_FIXES_2026-08-08.md`
- Chuẩn hình học khuôn bế (không liên quan PPE): `audit-rules.md`
