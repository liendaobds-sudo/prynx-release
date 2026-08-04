---
name: prynx-deep-audit
description: "Audit dọc toàn dự án PrynX theo mức bằng chứng, từ điểm vào qua handler/engine đến file kết quả và nơi đọc lại. Dùng khi user muốn rà từng chân tơ kẽ tóc, săn bug ẩn hoặc bug xuyên tầng, kiểm hợp đồng/đơn vị/preview-artifact, quét pattern sau một lỗi, lập hoặc cập nhật master audit matrix. Use for deep systematic audits, vertical-flow tracing, hidden bug hunts, contract drift, unit drift, artifact parity, and project-wide pattern sweeps."
---

# PrynX Deep Audit

Mục tiêu là tăng dần bằng chứng cho từng luồng nghiệp vụ, không hứa “hết bug”. Máy quét chỉ tạo danh sách điều tra; file kết quả thật và hành vi runtime mới quyết định tính đúng.

## Nạp đúng kiến thức trước khi audit

1. Luôn đọc `prynx-architecture`, `prynx-audit-workflow` và `prynx-testing`.
2. Đọc skill chuyên sâu theo wave: `prynx-imposition`, `prynx-dieline`, `prynx-performance`, `prynx-security-review` hoặc `prynx-build-release`.
3. Đọc `audit-rules.md`, báo cáo `docs/BAO_CAO_AUDIT_*.md` và log `docs/*FIXES*.md` liên quan trước khi gọi điều gì là bug.
4. Mở `docs/PRYNX_MASTER_AUDIT_MATRIX.md` để chọn khoảng trống có rủi ro cao nhất và cập nhật lại sau đợt audit.

## Thang bằng chứng

Ghi một trạng thái cho mỗi luồng; trạng thái cao hơn chỉ hợp lệ khi các bước thấp hơn vẫn còn đúng.

| Trạng thái | Điều kiện tối thiểu |
|---|---|
| `UNKNOWN` | Chưa truy vết đủ luồng đang chạy. |
| `TRACED` | Đã chứng minh route reachable và nối đủ entry → handler → engine → artifact/consumer bằng `file:dòng`. |
| `AUTO` | `TRACED` và test tự động kiểm đúng bất biến nghiệp vụ/biên dữ liệu. |
| `ARTIFACT` | `AUTO` và đã parse/render/đo file thật được tạo ra; không suy từ preview hoặc object trung gian. |
| `RUNTIME` | `ARTIFACT` và đã chạy lại thao tác người dùng trên app thật, đúng chế độ cần kiểm (dev/cài đặt/release). |
| `STALE` | Bằng chứng cũ không còn đáng tin vì code, dependency, pipeline hoặc hợp đồng đã đổi. |

`STALE` là trạng thái phủ định, không phải mức cao nhất. Ghi commit/ngày/phạm vi khiến bằng chứng cũ đi stale.

## Vòng đời một phát hiện

- `[SUSPECTED]`: regex, scanner, code smell hoặc giả thuyết; chưa xếp P0–P3 và chưa sửa.
- `[CONFIRMED]`: đã chứng minh reachable, xác định consumer, chỉ ra bất biến bị vi phạm và có tái hiện/test/artifact.
- `[DISPROVED]`: đã bác bỏ, ghi lý do để lần quét sau không điều tra lại.
- `[EXPECTED]`: hành vi có chủ đích, ghi nguồn quyết định hoặc test bảo vệ.

Chỉ `[CONFIRMED]` mới đi vào bảng finding chính và được xếp P0–P3. Main agent phải tự xác minh finding quan trọng do subagent nêu.

## Quy trình audit dọc

1. **Chốt audit unit.** Chọn một hành động người dùng và một kết quả quan sát được, không chọn cả module mơ hồ. Ví dụ: “Nhập PDF có CropBox lẻ mm → bình N-up → mở lại PDF xuất và đo TrimBox”.
2. **Lập baseline.** Ghi ca đang chạy, dữ liệu đầu vào, artifact hiện tại, test liên quan và trạng thái trong master matrix trước khi sửa.
3. **Chứng minh reachability.** Tìm registration/router/registry thật. Code không được gọi không phải bug runtime của luồng này.
4. **Trace xuyên tầng.** Theo entry UI/API → state/schema → handler/route → engine Python/Rust/TS → writer → file → parser/consumer đọc lại. Ghi `file:dòng` ở mỗi mắt xích.
5. **Kiểm hợp đồng tại mọi biên.** Đối chiếu tên field, optional/default, enum, đơn vị, hệ tọa độ, page box, phép làm tròn, thứ tự trang, ownership theo tab, entitlement và xử lý lỗi/cancel.
6. **Lấy artifact làm nguồn sự thật.** Parse page boxes/object/content stream/metadata hoặc render và đo file thật. Preview đúng không chứng minh file đúng; response đúng không chứng minh writer đã dùng response đó.
7. **Thử ma trận biên.** Tối thiểu cân nhắc: rỗng/0, min/max, số mm thập phân, trang hỗn hợp, MediaBox/CropBox/TrimBox lệch nhau, locale, free/pro, nhiều tab, cancel/retry, máy yếu/mạnh, dev/release, restart và clean-user.
8. **Quét pattern anh em.** Sau một bug đã xác nhận, tìm cùng conversion/helper/schema/gate/consumer ở toàn repo. Mỗi hit mới quay lại `[SUSPECTED]`, không sửa hàng loạt theo regex.
9. **Viết báo cáo và dừng ở chốt duyệt.** Dùng `docs/BAO_CAO_AUDIT_<CHUDE>_<YYYY-MM-DD>.md`; nêu bằng chứng, khoảng trống và lô sửa đề xuất. Không sửa trước khi user duyệt.
10. **Sửa theo lô ≤5 file.** Verify hẹp sau mỗi lô theo `prynx-testing`, rồi verify artifact/runtime tương ứng. Cập nhật log fixes và master matrix ngay trong đợt đó.

## Thẻ audit unit bắt buộc

Mỗi hàng/phiếu audit cần có:

- mã ổn định và tên luồng người dùng;
- entry, handler, engine, writer, artifact và consumer;
- hợp đồng quan trọng: field, đơn vị, page box, rounding, gate;
- ca biên đã kiểm;
- test tự động và cách kiểm artifact/runtime;
- trạng thái bằng chứng, ngày/commit gần nhất;
- khoảng trống và người/bước xác minh tiếp theo.

Không nâng trạng thái nếu thiếu mắt xích. Nếu chỉ đọc code, tối đa là `TRACED`.

## Tám wave chuẩn

1. Kích thước, đơn vị và PDF page boxes.
2. Preview ↔ PDF xuất của các luồng bình bản.
3. Resize/crop/combine/split/chuyển đổi và các PDF utilities.
4. VDP và dữ liệu biến đổi.
5. Khuôn bế, nesting, export và 3D.
6. Multi-tab, routing, event và state ownership.
7. PDFium, worker/process, RAM gate và hiệu năng.
8. Security, license/entitlement, build và release artifact.

Ưu tiên theo thiệt hại × khả năng xảy ra × độ thiếu bằng chứng, không theo số hit của scanner.

## Máy quét hợp đồng

Chạy từ gốc repo:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/audit_contracts.ps1 -SelfTest
powershell -ExecutionPolicy Bypass -File scripts/audit_contracts.ps1
powershell -ExecutionPolicy Bypass -File scripts/audit_contracts.ps1 -IncludeUntracked -Format Json -OutputPath audit-contracts-baseline.tmp.json
powershell -ExecutionPolicy Bypass -File scripts/audit_contracts.ps1 -Format Markdown -OutputPath docs/audit/contract-candidates.md
```

Mặc định máy quét lấy file tracked nhưng đọc nội dung worktree hiện tại; thêm `-IncludeUntracked` khi audit source mới chưa add Git. Nó bỏ ignored/vendor/generated. Mọi kết quả mang `[SUSPECTED]`; không dùng số hit làm release gate, không tự xếp severity và không tự sửa. Chỉ lưu báo cáo sinh ra khi nó phục vụ một đợt audit đã chốt phạm vi.

## Dùng subagent mà không làm loãng bằng chứng

- Chia theo audit unit hoặc wave độc lập; không giao “audit toàn bộ repo” cho một agent.
- Yêu cầu trả về đường trace, artifact/test và điều chưa chứng minh, không chỉ danh sách smell.
- Không tiết lộ đáp án mong đợi khi forward-test skill.
- Main agent đọc lại ngữ cảnh và xác minh các finding P0/P1 hoặc thay đổi xuyên tầng.

## Điều kiện kết thúc một đợt

Chỉ báo hoàn thành phạm vi đã chọn khi: ma trận được cập nhật; finding có trạng thái; test đã chạy được ghi trung thực; artifact/runtime còn thiếu được nêu rõ; báo cáo đã qua chốt duyệt nếu có sửa. Luôn nói “độ phủ nào đã đạt”, không nói “toàn dự án không còn bug”.
