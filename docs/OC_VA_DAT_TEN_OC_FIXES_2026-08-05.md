# Fixes tạo ốc và đặt tên ốc — Bình Tem Bế / CNC

> Ngày sửa: 2026-08-05
> Audit nguồn: `BAO_CAO_AUDIT_OC_VA_DAT_TEN_OC_2026-08-05.md`
> Audit unit: `W2-U02-OC`
> Trạng thái: code + test tự động + artifact đạt; chưa smoke app cài đặt/cắt máy

## 1. Kết quả

Đã xử lý đủ ba finding được duyệt:

- §OC.1: CNC giữ đúng Graphtec info layer, layer ốc, group ốc và `itemName` trên cả Front/Cut.
- §OC.2: PontConfig sai bị chặn ở dialog, preview schema, route tạo job và engine; không còn silent-success với size 0/âm hoặc tên rỗng.
- §OC.3: chốt hợp đồng CNC luôn có ốc ở Front + Cut, không có ở Back; frontend không còn serialize toggle `pontsOnCutFile` của Sticker sang CNC.

## 2. Các lô đã sửa

### Lô backend — hợp đồng và artifact CNC

| File | Thay đổi |
|---|---|
| `backend/app/schemas/pont.py` | Validator dùng chung: enum shape, số hữu hạn/dương, lề, guide, boolean, tên bắt buộc; điền default writer cần dùng; `BeforeValidator` cho schema preview. |
| `backend/app/api/routes/imposition.py` | Validate PontConfig trước khi tạo job; preview đơn/batch dùng cùng hợp đồng; giữ route ở đúng trần 3.878 dòng. |
| `backend/app/workers/nup_engine.py` | Guard lần hai cho caller nội bộ đi thẳng vào engine. |
| `backend/app/workers/cnc_render.py` | Tạo OCG Graphtec/layer/group, dùng chung group OCG cho Front/Cut và giữ `/NM` từng ốc. Khóa quy tắc CNC Front + Cut. |
| `backend/tests/test_pont_config_and_cnc_naming.py` | Test input biên, route/preview/engine guard, ba shape, artifact CNC 1 mặt/2 mặt, `/OCProperties`, `/Order`, `/NM`, số ốc `4/4` và `4/0/4`. |

### Lô frontend — chặn lỗi trước khi lưu

| File | Thay đổi |
|---|---|
| `desktop/src/components/imposition-tools/pontConfigValidation.ts` | Validator thuần cho dialog, cùng bất biến chính với backend. |
| `desktop/src/components/imposition-tools/PontSettingsDialog.tsx` | Hiển thị lỗi tiếng Việt/Anh, vô hiệu Save khi sai, chặn preset sai, thêm `min`, bổ sung độ dày Guide 2 và merge default cho preset cũ. |
| `desktop/src/components/imposition-tools/PontSettingsDialog.validation.test.ts` | Test default/Unicode và 11 ca rỗng, 0/âm, margin, Graphtec, guide. |
| `desktop/src/lib/processHandlers.ts` | Chỉ serialize `pontsOnCutFile` cho Sticker/Page Sheet. |
| `desktop/src/components/imposition-tools/ImposerDashboard.tsx` | Không đưa field Sticker vào cấu hình CNC. |
| `desktop/src/lib/processHandlers.test.ts` | Khóa payload Page Sheet giữ toggle và payload CNC không có toggle. |
| `desktop/src/i18n/locales/vi.json`, `en.json` | Thêm thông báo validation cho người dùng. |

## 3. Bằng chứng artifact

Test CNC tạo PDF thật rồi mở lại bằng `pikepdf`:

| Chế độ | Số object ốc theo trang | Tên OCG | Tên item |
|---|---:|---|---|
| CNC 1 mặt, cả 3 shape | `4 / 4` (Front/Cut) | `AUDIT_GRAPH_INFO`, `AUDIT_LAYER`, `AUDIT_GROUP` | 4 × `AUDIT_ITEM` mỗi trang |
| CNC 2 mặt, cả 3 shape | `4 / 0 / 4` (Front/Back/Cut) | `AUDIT_GRAPH_INFO`, `AUDIT_LAYER`, `AUDIT_GROUP` | Front/Cut có `AUDIT_ITEM`, Back không có ốc |

`pontsOnCutFile=false` cố ý vẫn cho kết quả trên trong test backend CNC, vì field này không thuộc hợp đồng CNC. Test frontend xác nhận field không được gửi qua HTTP.

## 4. Verify

| Kiểm tra | Kết quả |
|---|---|
| Backend full `pytest -q tests` | **2.302 passed, 4 skipped**, 3 warning deprecation có sẵn; sau đó thêm 5 regression route/shape và chạy file đích **20 passed** |
| Frontend full `npm run test` | **195 file passed; 1.893 passed, 2 skipped** |
| Frontend typecheck | **PASS** |
| Lint budget | **PASS** — 1.441 error/104 warning trong backlog hiện hữu, không vượt budget |
| ESLint riêng validator/test mới | **PASS** |
| God-file ratchet | **PASS** — `imposition.py` đúng trần 3.878 dòng |

Lượt full backend đầu tiên phát hiện route vượt trần sau khi thêm validator. Logic khai báo đã được chuyển sang `schemas/pont.py`; ratchet và full suite sau đó đều xanh. Một lượt full backend chạy song song bị timeout ở 96% nhưng không có failure; lượt chạy độc lập kế tiếp kết thúc 100%. Năm regression route/ba-shape được bổ sung sau full suite chỉ thay đổi test và đã chạy riêng xanh 20/20.

## 5. Còn phải kiểm runtime

- Mở dialog trên app thật, thử xóa tên/nhập 0 và xác nhận nút Save bị khóa, thông báo không làm tràn modal.
- Xuất CNC 1 mặt/2 mặt từ app rồi mở bằng Illustrator/Graphtec Studio để kiểm cây layer hiển thị đúng như OCG parse.
- Kiểm multi-sheet/multi-unit bằng file sản xuất thật và cắt thử vật lý nếu dùng làm release gate.

Do chưa chạy app cài đặt và công cụ downstream thật, audit unit giữ mức `ARTIFACT`, chưa nâng `RUNTIME`.
