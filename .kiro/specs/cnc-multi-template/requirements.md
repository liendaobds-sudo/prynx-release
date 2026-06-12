# Requirements Document

> Tài liệu Yêu cầu — Tính năng "CNC ghép nhiều mẫu" (cnc-multi-template)

## Introduction

Công cụ **Bình Bế Rớt (CNC)** (`imposerMode='cnc'`) hiện chỉ xử lý **một mẫu** trên mỗi đơn vị bình: mỗi trang (1 mặt) hoặc mỗi cặp trang (2 mặt) được xếp riêng thành một cụm trang output. Tính năng này bổ sung khả năng **trộn NHIỀU mẫu khác nhau lên cùng 1 tờ in**, cho cả chế độ 1 mặt lẫn 2 mặt, sao cho **preview khớp khít output**.

Mục tiêu nghiệp vụ:
- Cho phép nhiều mẫu (mỗi trang/cặp trang là một mẫu) chen nhau đầy 1 tờ theo **số lượng riêng từng mẫu** (trộn theo tỉ lệ) hoặc **tự lấp đầy** khi chưa nhập số lượng.
- Với 2 mặt: bin-pack tất cả **mặt trước** của các mẫu lên một tờ, **lật gương cả cụm**, rồi đặt **mặt sau** từng mẫu vào đúng ô đã lật để in lật giấy thì bế trùng khít.
- Xuất **một file khuôn chung** chứa đường bế của tất cả mẫu trên tờ.
- Preview (GridPreview) cho lật xem Mặt trước / Mặt sau / Khuôn và phải khớp output.

Ràng buộc kiến trúc đã chốt:
- Tách một **helper dùng chung** dựng layout trộn 1 tờ (chọn `solve_offset_mixed` / `solve_auto_fill_mixed` + căn giữa tờ) làm **nguồn chân lý duy nhất**; `cnc_render` gọi lại helper này để lấy layout mặt trước rồi tự lo lật gương, khuôn gộp, boong.
- KHÔNG route CNC qua nhánh trộn của `nup_engine`; giữ CNC tách biệt ở `cnc_render`.
- KHÔNG phá vỡ luồng **Bình Tem Bế** và các công cụ khác.

## Glossary

- **CNC_Renderer**: module `cnc_render` chịu trách nhiệm render công cụ Bình Bế Rớt (CNC).
- **Layout_Helper**: helper dùng chung mới, dựng layout trộn nhiều mẫu cho 1 tờ (chọn solver + căn giữa tờ); là nguồn chân lý duy nhất cho cả render và preview.
- **Preview_Service**: nhánh tạo dữ liệu xem trước layout (`is_nup_multi` trong `imposition.py`) phục vụ GridPreview.
- **GridPreview**: thành phần giao diện hiển thị xem trước layout, hỗ trợ lật xem nhiều chế độ.
- **Mẫu (template)**: một sản phẩm khác biệt; ở 1 mặt mỗi trang nguồn là một mẫu, ở 2 mặt mỗi cặp trang liền nhau là một mẫu.
- **Mặt trước / Mặt sau**: hai mặt in của một mẫu 2 mặt.
- **Cụm trang (page unit)**: nhóm trang output của một tờ — `[Mặt trước, Mặt sau, Khuôn]` (2 mặt) hoặc `[Mặt trước, Khuôn]` (1 mặt).
- **Lật gương (mirror)**: lật đối xứng cả cụm layout mặt trước để khi in lật giấy thì bế hai mặt trùng khít.
- **Cạnh lật (flip edge)**: lật quanh cạnh dài (`long`) hoặc cạnh ngắn (`short`) của tờ in.
- **Khuôn (cut file)**: trang chỉ chứa đường bế, gộp đường bế của tất cả mẫu trên tờ.
- **Boong định vị (pont)**: dấu định vị cho máy cắt; ở CNC chỉ vẽ ở Mặt trước và Khuôn.
- **Dấu canh 2 mặt (duplex marks)**: dấu canh chồng khi in lật giấy; vẽ ở cả Mặt trước và Mặt sau.
- **solve_offset_mixed**: solver bin-pack trộn nhiều mẫu theo tỉ lệ số lượng cho 1 tờ, trả về `sheets_needed`.
- **solve_auto_fill_mixed**: solver bin-pack tự lấp đầy 1 tờ bằng tất cả mẫu khi chưa có số lượng.
- **sheets_needed**: số tờ cần in tính từ số lượng yêu cầu và sức chứa mỗi tờ.

---

## Requirements

### Yêu cầu 1 — Trộn nhiều mẫu từ nguồn (ghép cặp 1 mặt / 2 mặt)

**User Story:** Là thợ chế bản, tôi muốn nhiều mẫu khác nhau cùng nằm trên một tờ in, để tận dụng tối đa tờ giấy và in một lượt.

#### Acceptance Criteria
1. WHILE chế độ 1 mặt đang bật, THE CNC_Renderer SHALL coi mỗi trang nguồn là một mẫu độc lập và đưa tất cả mẫu vào trộn chung trên một tờ.
2. WHILE chế độ 2 mặt đang bật, THE CNC_Renderer SHALL ghép cặp trang liền nhau theo thứ tự, trong đó trang ở vị trí chẵn (trang 1, 3, 5…) là Mặt trước của một mẫu và trang kế tiếp là Mặt sau của chính mẫu đó.
3. WHILE chế độ 2 mặt đang bật, THE CNC_Renderer SHALL chỉ đưa các trang Mặt trước của tất cả mẫu vào bước bin-pack trộn tờ, và liên kết mỗi Mặt trước với Mặt sau theo cặp.
4. IF chế độ 2 mặt đang bật VÀ số trang nguồn là số lẻ, THEN THE CNC_Renderer SHALL dừng xử lý và trả về thông báo lỗi nêu rõ số trang hiện có và yêu cầu số trang chẵn.

### Yêu cầu 2 — Số lượng riêng từng mẫu và trộn theo tỉ lệ

**User Story:** Là người lập lệnh in, tôi muốn nhập số lượng riêng cho từng mẫu, để hệ thống trộn các mẫu theo đúng tỉ lệ cần in.

#### Acceptance Criteria
1. WHERE có ít nhất một mẫu được nhập số lượng lớn hơn 0, THE Layout_Helper SHALL dùng `solve_offset_mixed` để trộn các mẫu lên một tờ theo tỉ lệ số lượng đã nhập.
2. WHEN tất cả số lượng các mẫu bằng 0, THE Layout_Helper SHALL dùng `solve_auto_fill_mixed` để tự lấp đầy một tờ bằng tất cả mẫu.
3. WHILE chế độ 2 mặt đang bật, THE Layout_Helper SHALL lấy số lượng của mỗi mẫu từ trang Mặt trước (trang ở vị trí chẵn) của mẫu đó.
4. WHILE chế độ 2 mặt đang bật, THE CNC_Renderer SHALL áp dụng số lượng và tỉ lệ của trang Mặt trước cho Mặt sau theo cặp, không yêu cầu nhập số lượng riêng cho Mặt sau.

### Yêu cầu 3 — Lật gương cả cụm và đặt mặt sau khớp ô

**User Story:** Là thợ in, tôi muốn mặt sau của mọi mẫu khớp với mặt trước sau khi lật giấy, để bế hai mặt trùng khít.

#### Acceptance Criteria
1. WHILE chế độ 2 mặt đang bật, THE CNC_Renderer SHALL lật gương toàn bộ cụm layout mặt trước (gồm tất cả mẫu) thành layout mặt sau.
2. THE CNC_Renderer SHALL cho người dùng chọn cạnh lật `long` hoặc `short`, với giá trị mặc định là `long`.
3. WHEN lật gương cụm, THE CNC_Renderer SHALL đặt Mặt sau của từng mẫu vào đúng ô đã lật tương ứng với Mặt trước của mẫu đó.
4. THE CNC_Renderer SHALL giữ vị trí mỗi ô Mặt sau đối xứng với ô Mặt trước tương ứng theo cạnh lật đã chọn.

### Yêu cầu 4 — Khuôn gộp, boong và dấu canh

**User Story:** Là người vận hành máy cắt, tôi muốn một file khuôn chung chứa đường bế của tất cả mẫu, để cắt cả tờ trong một lần.

#### Acceptance Criteria
1. THE CNC_Renderer SHALL xuất một trang Khuôn chứa đường bế của tất cả mẫu nằm trên tờ.
2. WHERE boong định vị được bật, THE CNC_Renderer SHALL vẽ boong định vị chỉ trên trang Mặt trước và trang Khuôn.
3. THE CNC_Renderer SHALL không vẽ boong định vị trên trang Mặt sau.
4. WHERE dấu canh 2 mặt được bật VÀ chế độ 2 mặt đang bật, THE CNC_Renderer SHALL vẽ dấu canh 2 mặt trên cả trang Mặt trước và trang Mặt sau.

### Yêu cầu 5 — Helper layout dùng chung là nguồn chân lý duy nhất

**User Story:** Là kỹ sư, tôi muốn một helper layout duy nhất dùng cho cả render lẫn preview, để preview luôn khớp output.

#### Acceptance Criteria
1. THE Layout_Helper SHALL dựng layout trộn một tờ bằng cách chọn `solve_offset_mixed` hoặc `solve_auto_fill_mixed` theo số lượng và căn giữa các ô trên tờ.
2. WHEN render layout mặt trước, THE CNC_Renderer SHALL gọi Layout_Helper để lấy layout thay vì tự dựng layout riêng.
3. WHEN tạo dữ liệu xem trước, THE Preview_Service SHALL dùng cùng Layout_Helper để dữ liệu xem trước và output dùng chung một nguồn layout.
4. THE CNC_Renderer SHALL không route luồng CNC qua nhánh trộn của `nup_engine`.

### Yêu cầu 6 — Preview khớp output (GridPreview 3 chế độ)

**User Story:** Là người dùng, tôi muốn xem trước đúng những gì sẽ in ra, để duyệt trước khi xuất file.

#### Acceptance Criteria
1. THE GridPreview SHALL cho người dùng lật xem ba chế độ: Mặt trước, Mặt sau (đã lật gương), và Khuôn.
2. WHILE chế độ 2 mặt đang bật, THE Preview_Service SHALL chỉ bin-pack các trang Mặt trước (trang ở vị trí chẵn) và không gộp các trang Mặt sau vào bước bin-pack.
3. THE Preview_Service SHALL dựng Mặt sau trong preview bằng cách lật gương cụm Mặt trước theo cạnh lật đã chọn, khớp với cách CNC_Renderer dựng Mặt sau output.
4. THE GridPreview SHALL hiển thị vị trí và số ô từng mẫu khớp với output tương ứng từng chế độ.

### Yêu cầu 7 — Output đa tờ đúng một cụm trang

**User Story:** Là thợ chế bản, tôi muốn file kết quả chỉ chứa một cụm trang cho cả lệnh in nhiều tờ, để không bị lặp trang thừa.

#### Acceptance Criteria
1. WHILE chế độ 2 mặt đang bật, THE CNC_Renderer SHALL xuất đúng một cụm trang theo thứ tự `[Mặt trước, Mặt sau, Khuôn]`.
2. WHILE chế độ 1 mặt đang bật, THE CNC_Renderer SHALL xuất đúng một cụm trang theo thứ tự `[Mặt trước, Khuôn]`.
3. THE CNC_Renderer SHALL không lặp lại cụm trang theo số tờ cần in.
4. THE CNC_Renderer SHALL ghi trong report số tờ cần in theo giá trị `sheets_needed` đã tính.

### Yêu cầu 8 — Giao diện nhập số lượng từng mẫu

**User Story:** Là người lập lệnh in, tôi muốn ô nhập số lượng chỉ hiện ở trang mặt trước khi in 2 mặt, để không nhập nhầm vào trang mặt sau.

#### Acceptance Criteria
1. WHILE chế độ 2 mặt đang bật, THE GridPreview SHALL chỉ hiển thị ô nhập số lượng cho các trang Mặt trước (trang ở vị trí chẵn).
2. WHILE chế độ 2 mặt đang bật, THE GridPreview SHALL ẩn ô nhập số lượng ở các trang Mặt sau.
3. WHILE chế độ 1 mặt đang bật, THE GridPreview SHALL hiển thị ô nhập số lượng cho mỗi trang nguồn.

### Yêu cầu 9 — Không phá vỡ Bình Tem Bế và các công cụ khác

**User Story:** Là người dùng các công cụ hiện có, tôi muốn tính năng mới không làm thay đổi hành vi của Bình Tem Bế, N-Up, Booklet, để quy trình cũ vẫn chạy đúng.

#### Acceptance Criteria
1. WHEN bổ sung trộn nhiều mẫu cho CNC, THE Preview_Service SHALL giữ nguyên hành vi xếp hiện tại cho các luồng không phải CNC 2 mặt.
2. THE thay đổi SHALL giữ nguyên hành vi hiện tại của Bình Tem Bế, N-Up và Booklet.
3. THE thay đổi SHALL không làm hỏng các test backend hiện có.

---

## Out of Scope
- Viết lại thuật toán bin-pack (tái dùng `solve_offset_mixed` / `solve_auto_fill_mixed`).
- Trộn nhiều mẫu cho các công cụ không phải CNC (N-Up, Booklet, Bình Tem Bế).
- Tích hợp trực tiếp driver máy CNC (chỉ xuất file đúng chuẩn).
