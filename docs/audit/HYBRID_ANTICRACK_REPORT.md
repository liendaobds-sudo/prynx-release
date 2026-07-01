# Báo cáo: Mô hình lai Server-side cho tính năng cao cấp (chống crack triệt để phần lõi)

> **Mục đích:** Đánh giá tính khả thi + đề xuất kiến trúc để bảo vệ "bí mật công nghệ" của
> PrynX khỏi crack/keygen, bằng cách **tách Solver (IP) ra khỏi Renderer (hàng phổ thông)**.
> **Phương pháp:** dựa trên khảo sát code thật (`backend/app/workers/*`, `SECURITY_ARCHITECTURE.md`),
> không phỏng đoán. Đây là **báo cáo phân tích + lộ trình**, chưa đụng code production.
> **Ngày:** 2026-06-20

---

## 1. Tóm tắt điều hành (TL;DR)

- **Vấn đề:** App cài máy khách thì code chạy trên máy kẻ tấn công → về lý thuyết **luôn crack được** (trần ~8/10, xác nhận trong `SECURITY_ARCHITECTURE.md` Mục 7). Keygen thì PrynX đã kháng tốt (chữ ký Ed25519), nhưng "crack bỏ qua cổng license" thì không lớp client nào chặn tuyệt đối.
- **Biện pháp mạnh nhất tồn tại:** cái gì **không ship binary xuống máy khách thì không thể crack**. Nếu thuật toán lõi chạy trên server, kẻ gian có cướp được nguyên app cũng **không có thuật toán** để dùng.
- **Phát hiện then chốt:** "bí mật công nghệ" của PrynX **không phải** ở phần render PDF (đó là hàng phổ thông: pikepdf/pdfium/reportlab). Nó nằm ở **các solver hình học** — và các solver này là **pure-compute**: vào là số đo/đa giác, ra là toạ độ. **Chúng không cần file PDF để chạy.**
- **Hệ quả:** Có thể đẩy **chỉ phần solver** lên server (payload nhỏ — vài KB toạ độ, không phải file in 100MB), giữ phần render nặng + cần file ở client. → Vừa chống crack phần lõi, vừa **gần như không mất hiệu năng** (khác hẳn việc đưa cả app lên web đã phân tích hôm trước, mất 30–50%).
- **Ước tính mất hiệu năng của mô hình lai: ~5–15%** (chỉ thêm 1 round-trip mạng nhỏ cho bước solve), so với 30–50% nếu web-hoá toàn bộ.

---

## 2. Nguyên lý: tách Solver khỏi Renderer

Mọi công cụ bình/nesting của PrynX gồm 2 pha tách bạch:

```
[INPUT]                 PHA 1: SOLVE (IP — bí mật)          PHA 2: RENDER (phổ thông)
file PDF + thông số  →  thuật toán tính BỐ CỤC tối ưu   →   đặt artwork vào toạ độ + xuất PDF
                        (toạ độ, số tem/tờ, xoay, gap)        (pikepdf/pdfium/reportlab)
                        ── vào/ra ~vài KB, KHÔNG cần PDF ──   ── cần file thật + CPU + RAM ──
```

**Bằng chứng (đọc code thật):**
- `nup_layout_solver.solve_optimal_layout(usable_w, usable_h, orig_w, orig_h, gap_x, gap_y, strategy, secondary_gap)` → vào là **scalar**, ra là layout. Không chạm PDF.
- `sticker_imposer_pkg/` — `nfp_placer.py` (No-Fit-Polygon), `bin_packing.py`, `cluster_layouts.py`, `asymmetric_layouts.py` → nesting đa giác, vào là **hình học**, ra là **vị trí**.
- `die_detection.py` / `shape_classifier.py` / `shape_analyzer.py` → phân loại hình bế (vào là contour/đa giác).
- `cluster_layout.py`, `imposition_layout.py`, `cnc_layout.py`, `cut_export/blade_routing.py` → cùng kiểu.

Đây chính là **phần đáng tiền và khó làm lại nhất** — và may mắn là **phần dễ tách lên server nhất** vì payload bé.

---

## 3. Phân loại tính năng: lên server hay giữ client

| Thành phần | Loại | Đề xuất | Lý do |
|---|---|---|---|
| `nup_layout_solver`, `imposition_layout` | Solver bố cục N-up | **SERVER** | IP cốt lõi, payload vài KB |
| `sticker_imposer_pkg/*` (NFP, bin-packing, cluster) | Solver nesting tem bế | **SERVER** (ưu tiên #1) | IP giá trị cao nhất, khó làm lại nhất |
| `die_detection`, `shape_classifier`, `shape_analyzer` | Nhận diện hình bế | **SERVER** | Thuật toán phân loại = bí mật; vào là contour |
| `cnc_layout`, `cut_export/blade_routing` | Solver CNC/định tuyến dao | **SERVER** | IP; output là lệnh máy, đằng nào cũng cần gate |
| `cluster_tile_engine`, `cnc_marks`, `nup_marks` | Tính dấu/marks | SERVER (đi kèm solver) | Gắn liền layout |
| `nup_engine`, `sticker_engine`, `vdp_engine` (phần render) | Đặt artwork + xuất PDF | **CLIENT** | Cần file thật + CPU/RAM; là hàng phổ thông |
| Render preview (Rust pdfium, `tile://`) | Hiển thị | **CLIENT** | Cần tức thì, không round-trip |
| Merge/split/resize/OCR/optimize | PDF ops phổ thông | **CLIENT** | Không phải IP; thư viện mở |
| Compare (so sánh PDF) | Tiện ích | CLIENT (hoặc tuỳ) | Không phải IP lõi |

**Quy tắc vàng:** đẩy lên server **chỉ phần "nghĩ" (solve)**, giữ ở client phần "làm" (render). Server **không bao giờ nhận file in nặng** — chỉ nhận hình học trừu tượng.

---

## 4. Kiến trúc lai đề xuất

```
                          MÁY KHÁCH (Tauri)                          SERVER (Supabase Edge / VPS)
┌───────────────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ 1. Client trích hình học từ PDF                │        │                                        │
│    (bbox, contour, kích thước, số lượng)       │  HTTPS │ 3. SOLVER LÕI (Python compiled)        │
│ 2. Gửi {geometry, params} + X-License-Token ──┼───────►│    - verify token Ed25519 (đã có #21)  │
│                                                │  vài KB│    - chạy nfp/bin-packing/nup solve    │
│ 6. Nhận {layout coords} ◄──────────────────────┼────────┤ 4. Trả {coords, rotations, counts}     │
│ 7. RENDER tại client: đặt artwork theo coords  │  vài KB│    (KHÔNG trả thuật toán, chỉ kết quả) │
│    → xuất PDF (nup/sticker/vdp engine local)   │        │ 5. Rate-limit + log theo license       │
└───────────────────────────────────────────────┘        └──────────────────────────────────────┘
```

**Điểm mấu chốt chống crack:**
- Solver chạy server → **không có binary để mổ**. Crack client chỉ lấy được phần render (hàng phổ thông ai cũng viết được), **không lấy được thuật toán nesting**.
- Tái dùng đúng hạ tầng đã có: **token Ed25519 (#21)** để gate; **rate-limit/HWID** ở Supabase. Không phát sinh kiến trúc auth mới.
- Server chỉ thấy **hình học trừu tượng**, không thấy nội dung thiết kế của khách → **không lo lộ dữ liệu khách hàng** (điểm nhạy cảm khi web-hoá).

---

## 5. Đánh đổi (so với 2 thái cực)

| Tiêu chí | Desktop thuần (nay) | **Lai (đề xuất)** | Web-hoá toàn bộ |
|---|---|---|---|
| Kháng crack phần lõi IP | Thấp (binary local) | **Cao** (không có binary) | Cao |
| Mất hiệu năng | 0% (mốc) | **~5–15%** | 30–50% |
| Cần mạng để chạy | Không | **Chỉ lúc solve** (có thể cache/offline-grace) | Luôn cần |
| Lộ dữ liệu khách | Không | **Không** (chỉ gửi hình học) | Có rủi ro (gửi cả file) |
| Chi phí server | 0 | **Thấp** (payload KB, CPU ngắn) | Cao (file lớn + render) |
| File in 100MB qua mạng | Không | **Không** (không gửi file) | Có (đau) |

→ Mô hình lai là **điểm ngọt**: bảo vệ IP gần bằng web-hoá nhưng giữ ~85–95% hiệu năng desktop.

---

## 6. Lộ trình triển khai (theo pha, giảm rủi ro)

**Pha 0 — Chuẩn bị (không phá vỡ gì):**
- Chốt danh sách solver "ăn tiền" cần bảo vệ (đề xuất: bắt đầu với `sticker_imposer_pkg` — IP cao nhất).
- Định nghĩa **contract I/O** thuần JSON cho solver (geometry-in / layout-out). Vì solver đã pure-compute, đây chủ yếu là bọc 1 lớp serialize.

**Pha 1 — Tách solver ra sau ranh giới gọi được từ xa (vẫn chạy local):**
- Refactor solver sao cho **chỉ giao tiếp qua contract JSON** (không phụ thuộc file/PDF). Đảm bảo test parity: cùng input → cùng layout như hiện tại.
- *Chưa* chuyển server. Mục tiêu: code sẵn sàng "nhấc đi".

**Pha 2 — Deploy solver lên server + cờ chuyển mạch:**
- Đóng gói solver thành dịch vụ (Edge Function nếu đủ nhẹ; hoặc VPS Python compiled cho NFP nặng).
- Gate bằng token Ed25519 (tái dùng `verify_license_token`).
- Client thêm cờ `useRemoteSolver` (mặc định TẮT) → gọi server nếu bật, fallback local nếu lỗi/offline.

**Pha 3 — Bật dần + gỡ solver khỏi binary client:**
- Sau khi xác nhận server solver ổn định → ship bản client **không còn chứa solver lõi** (chỉ giữ stub gọi server). Lúc này IP thật sự rời khỏi máy khách.
- Giữ "offline-grace": cache layout gần nhất / cho phép giải đơn giản local khi mất mạng (tuỳ chính sách).

**Pha 4 — Đo & tinh chỉnh:**
- Đo độ trễ round-trip thật cho ca điển hình + ca nặng (nhiều hình). Tối ưu payload (nén contour).

---

## 7. Rủi ro & lưu ý

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Độ trễ mạng làm preview "khựng" | 🟡 | Chỉ solve qua mạng; preview vẫn local. Debounce + cache kết quả theo hash input. |
| Mất mạng = không bình được | 🟠 | Offline-grace có kiểm soát (giải bản rút gọn local) HOẶC yêu cầu online cho tính năng cao cấp (quyết định kinh doanh). |
| Chi phí server tăng theo user | 🟢 | Payload KB + CPU ngắn → rẻ hơn nhiều web-hoá. Rate-limit theo license. |
| Lộ private key Ed25519 | 🔴 | Như cũ: bảo vệ tuyệt đối secret Supabase. Đây vẫn là điểm tử huyệt chung. |
| Reverse contract để clone solver | 🟡 | Họ chỉ thấy I/O, không thấy thuật toán. Clone phải **tự nghĩ lại** solver — đúng mục tiêu (nâng chi phí sao chép). |
| Parity local↔server khi refactor | 🟠 | Bắt buộc test parity (audit-rules: verify bằng artifact) trước khi gỡ solver local. |

---

## 8. Khuyến nghị & quyết định cần chốt

1. **Nên làm**, nhưng **làm có chọn lọc**: chỉ đẩy solver IP cao nhất (`sticker_imposer_pkg` trước), không đẩy render. Đây là 20% công sức đổi 80% giá trị bảo vệ.
2. **Quyết định kinh doanh cần chốt trước khi code:**
   - Tính năng cao cấp có **bắt buộc online** không? (online-only = chống crack mạnh nhất nhưng phiền khách mất mạng).
   - Hạ tầng solver: **Supabase Edge** (rẻ, $0 thêm, nhưng giới hạn CPU/time — hợp solver nhẹ) hay **VPS Python compiled** (mạnh hơn cho NFP nặng, tốn phí)?
3. **Không nên** web-hoá toàn bộ (mất 30–50% + lộ dữ liệu khách + chi phí file lớn). Mô hình lai vượt trội cho ca dùng của xưởng in.
4. **Việc nền tảng cần xong song song** (từ `SECURITY_ARCHITECTURE.md` Mục 8.6): rotate 45 key từng phơi nhiễm; code signing Authenticode; CI chặn `USING(true)`.

---

## 9. Bước tiếp theo nếu bạn duyệt

Nếu bạn đồng ý hướng này, tôi có thể bắt đầu **Pha 0–1 cho `sticker_imposer_pkg`**: định nghĩa contract JSON geometry-in/layout-out + viết test parity (đảm bảo tách solver không đổi kết quả bình), **chưa đụng tới việc deploy server**. Đây là bước an toàn, có thể kiểm chứng bằng artifact, và không phá vỡ bản hiện tại.

> *Lưu ý phạm vi:* phần deploy server (Edge Function/VPS) nằm ở repo `printsolutions-main` + hạ tầng Supabase của bạn — tôi chuẩn bị được phần client + contract + solver, còn bước bấm deploy + set secret cần bạn thực hiện trên hạ tầng.
