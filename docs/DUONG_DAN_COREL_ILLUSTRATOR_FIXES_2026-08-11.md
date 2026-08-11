# Fixes đường dẫn mở khuôn bằng CorelDRAW / Illustrator

> Ngày sửa: 2026-08-11
> Audit nguồn: `BAO_CAO_AUDIT_DUONG_DAN_COREL_ILLUSTRATOR_2026-08-11.md`
> Audit unit: `W2-U07`
> Findings: `§OPENAPP.1`, `§OPENAPP.2`
> Mức bằng chứng: `AUTO`; chưa smoke Tauri/CorelDRAW/Illustrator thật

## 1. Kết quả

Đã sửa hộp **Bế → Mở bằng Illustrator / CorelDRAW** để đường dẫn `.exe` người dùng chọn
thủ công là override rõ ràng, còn kết quả tự dò chỉ là fallback. Bản sửa áp dụng độc lập cho
cả Illustrator và CorelDRAW, có hiệu lực ngay sau khi chọn và được giữ qua lần mở modal sau.

Không đổi PDF tạm, OCG/layer, backend, Rust hoặc định dạng payload Tauri.

## 2. Bằng chứng trước sửa

Regression được thêm trước code fix. Suite đỏ đúng ba ca:

- Illustrator đã tự dò → chọn lại path khác nhưng UI không hiển thị path mới;
- CorelDRAW đã tự dò → chọn lại path khác nhưng UI không hiển thị path mới;
- localStorage đã giữ path thủ công → bộ dò chạy lại làm UI quay về path tự dò.

Hai ca đối chứng vẫn xanh trước sửa: tự dò không tìm thấy thì path thủ công hoạt động, và
hủy picker giữ nguyên path tự dò. Điều này khoanh nguyên nhân vào thứ tự ưu tiên
`detected.* || custom.*`, không phải picker hay localStorage.

## 3. Thay đổi

| File | Thay đổi |
|---|---|
| `desktop/src/components/imposition-tools/OpenInDesignModal.tsx` | Đổi resolver hiệu lực thành `custom.* || detected.*`; gắn tag `UIUX (audit 2026-08-11 §OPENAPP.1)`. Cùng giá trị này tiếp tục phục vụ cả text UI và payload `launch_external_app`. |
| `desktop/src/components/imposition-tools/OpenInDesignModal.test.tsx` | Nối mock picker thật vào `mocks.openDialog`; thêm 5 nhóm hành vi/5 test mới, trong đó bảng Illustrator/CorelDRAW tạo 2 ca, tổng suite từ 4 lên 9 test. Assert cả localStorage, text UI và payload native mock. |

## 4. Verify

| Kiểm tra | Kết quả |
|---|---|
| Baseline sau khi thêm regression, trước code fix | **3 fail đúng §OPENAPP.1**; các test cũ và đối chứng vẫn pass |
| `npx.cmd vitest run src/components/imposition-tools/OpenInDesignModal.test.tsx` | **9/9 passed** |
| Modal + `pdfOptionalContent` | **2 file / 29 test passed** |
| `npm.cmd run typecheck` | **PASS** (`tsc --noEmit -p tsconfig.app.json`) |
| ESLint hai file chạm | **0 error**; còn 1 warning `react-hooks/exhaustive-deps` có sẵn tại effect dòng 182 |
| `git diff --check` | Chạy ở lượt kiểm cuối |

Test có “răng”: trước khi đổi resolver, chính ba regression override/persistence đỏ; sau khi
đổi đúng hai biểu thức path, cả ba xanh mà fallback/cancel và bốn test artifact cũ vẫn xanh.

## 5. Phạm vi chưa đổi

- `§OPENAPP.S1` (`separateCut=false` nhưng mặc định **Chỉ trang khuôn**) chưa được duyệt,
  nên giữ nguyên để không tự đổi nghiệp vụ.
- Chưa chạy runtime app thật để xác nhận đúng process/version CorelDRAW/Illustrator nhận PDF.
- Không chạy lại Rust test vì lô này không thay command native; lượt audit trước gặp resource
  đang bị process khác giữ và không được phép dừng dev server của người dùng.

## 6. Checklist runtime còn lại

1. Trên máy tự dò được app, chọn lại một `.exe` khác và xác nhận text đổi ngay.
2. Bấm mở, xác nhận đúng phiên bản/process nhận PDF.
3. Đóng rồi mở lại modal, xác nhận path thủ công vẫn còn.
4. Lặp độc lập cho Illustrator và CorelDRAW, cả **Chỉ trang khuôn** lẫn **Cả khuôn + in**.
