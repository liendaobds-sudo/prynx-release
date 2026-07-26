//! `CCITTFaxDecode` — fax nhóm 3 và nhóm 4 (ITU-T T.4 / T.6).
//!
//! # Vì sao tự viết thay vì thêm thư viện
//!
//! Toàn bộ lý do PPE tồn tại là để **gỡ một phụ thuộc có ràng buộc bản quyền**. Thêm
//! một crate nữa vào đường đọc ảnh nghĩa là thêm một dòng vào NOTICE và một thứ nữa
//! phải theo dõi giấy phép. T.4/T.6 là chuẩn công khai, bảng mã của nó nằm trong
//! spec, và bộ giải mã là ~300 dòng. Viết thẳng ra là rẻ hơn.
//!
//! # Ảnh scan là lớp file nào
//!
//! CCITT là cách file khách cũ (và mọi máy scan) lưu bản vẽ đen trắng: đường bế, sơ
//! đồ khuôn, bản can. Trước đây PPE báo `codec ảnh CCITTFaxDecode` chưa hỗ trợ và
//! nhường cả trang cho Ghostscript — mà đó thường là **toàn bộ** nội dung của trang.
//!
//! # Đầu ra
//!
//! Trả về hàng bit đã đóng gói, 1 bit/pixel, mỗi hàng bắt đầu ở biên byte — đúng
//! dạng mà `unpack_samples` chờ đợi. Theo `/BlackIs1` (mặc định `false`), **bit 0 là
//! đen**: đó là quy ước của PDF, ngược với trực giác "1 là có mực". Đảo chiều ở đây
//! cho ra ảnh âm bản mà không có lỗi nào nổi lên.

use crate::error::{PpeError, PpeResult};

/// Trần số hàng khi `/Rows` không được khai.
///
/// Chặn stream hỏng làm bộ giải mã chạy mãi. 40 000 hàng là hơn 3 m giấy ở 300 DPI.
const MAX_ROWS: usize = 40_000;

/// Tham số `/DecodeParms` của `CCITTFaxDecode` (Table 11).
#[derive(Debug, Clone, Copy)]
pub struct CcittParams {
    /// `< 0`: nhóm 4 (2D thuần). `0`: nhóm 3 một chiều. `> 0`: nhóm 3 hai chiều.
    pub k: i32,
    pub columns: usize,
    /// `0` = không biết trước; giải tới khi hết dữ liệu.
    pub rows: usize,
    /// `false` (mặc định): bit 0 là **đen**.
    pub black_is_1: bool,
    /// Mỗi hàng mã hoá bắt đầu ở biên byte.
    pub encoded_byte_align: bool,
}

impl Default for CcittParams {
    fn default() -> Self {
        CcittParams {
            k: 0,
            columns: 1728,
            rows: 0,
            black_is_1: false,
            encoded_byte_align: false,
        }
    }
}

/// Giải mã, trả về hàng bit đã đóng gói (mỗi hàng tròn byte).
pub fn decode(data: &[u8], p: &CcittParams) -> PpeResult<Vec<u8>> {
    if p.columns == 0 {
        return Err(PpeError::MalformedPdf("CCITT: /Columns = 0".into()));
    }
    let cols = p.columns;
    let row_bytes = cols.div_ceil(8);
    let max_rows = if p.rows > 0 { p.rows } else { MAX_ROWS };

    let mut r = BitReader::new(data);
    let mut out: Vec<u8> = Vec::with_capacity(row_bytes * p.rows.max(1));
    // Hàng tham chiếu = vị trí các điểm đổi màu. Hàng đầu tiên coi như toàn trắng.
    let mut reference: Vec<usize> = Vec::new();
    let mut rows_done = 0usize;

    while rows_done < max_rows {
        if p.encoded_byte_align && p.k >= 0 {
            r.align();
        }
        // Bỏ mọi EOL đứng trước hàng. Với K > 0 thì bit ngay sau EOL cho biết hàng
        // này mã 1D hay 2D — bỏ qua bit đó sẽ lệch toàn bộ phần còn lại.
        let mut two_dimensional = p.k < 0;
        let mut saw_eol = false;
        while r.peek_eol() {
            r.skip(12);
            saw_eol = true;
        }
        if p.k > 0 {
            // Với K > 0, cờ chế độ luôn có mặt sau EOL. Nhiều encoder bỏ EOL của
            // hàng đầu, nên cờ vẫn phải đọc dù không thấy EOL.
            match r.read_bit() {
                Some(1) => two_dimensional = false,
                Some(_) => two_dimensional = true,
                None => break,
            }
        }
        let _ = saw_eol;
        if r.exhausted() {
            break;
        }
        if p.encoded_byte_align && p.k < 0 {
            r.align();
        }

        let current = if two_dimensional {
            decode_2d_row(&mut r, &reference, cols)
        } else {
            decode_1d_row(&mut r, cols)
        };
        let Some(current) = current else { break };

        out.extend_from_slice(&pack_row(&current, cols, row_bytes, p.black_is_1));
        reference = current;
        rows_done += 1;
    }

    if rows_done == 0 {
        return Err(PpeError::MalformedPdf(
            "CCITT: không giải được hàng nào".into(),
        ));
    }
    // Thiếu hàng so với `/Rows` là chuyện thường ở file cắt cụt: đệm trắng cho đủ
    // khung thay vì bỏ cả ảnh. Vùng đệm là **trắng**, tức thiếu mực chứ không thừa —
    // và phần thiếu đã được caller ghi nhận qua kích thước ảnh.
    if p.rows > 0 && rows_done < p.rows {
        let pad = if p.black_is_1 { 0x00 } else { 0xFF };
        out.resize(row_bytes * p.rows, pad);
    }
    Ok(out)
}

/// Đóng gói một hàng từ danh sách điểm đổi màu.
///
/// `transitions` là vị trí các điểm đổi màu, bắt đầu từ **trắng**: phần tử 0 là chỗ
/// chuyển sang đen, phần tử 1 là chỗ chuyển lại trắng, và cứ thế.
fn pack_row(transitions: &[usize], cols: usize, row_bytes: usize, black_is_1: bool) -> Vec<u8> {
    // Khởi tạo theo màu trắng, rồi chỉ ghi các đoạn đen.
    let white_byte = if black_is_1 { 0x00 } else { 0xFF };
    let mut row = vec![white_byte; row_bytes];
    let mut i = 0;
    while i + 1 <= transitions.len() {
        let start = transitions[i].min(cols);
        let end = transitions.get(i + 1).copied().unwrap_or(cols).min(cols);
        for x in start..end {
            let byte = x / 8;
            let bit = 7 - (x % 8);
            if black_is_1 {
                row[byte] |= 1 << bit;
            } else {
                row[byte] &= !(1 << bit);
            }
        }
        i += 2;
    }
    row
}

/// Một hàng mã hoá **một chiều** (T.4 §4.1): các run trắng/đen xen kẽ.
fn decode_1d_row(r: &mut BitReader, cols: usize) -> Option<Vec<usize>> {
    let mut transitions = Vec::new();
    let mut pos = 0usize;
    let mut color = 0u8; // 0 = trắng
    while pos < cols {
        let run = read_run(r, color)?;
        pos = (pos + run).min(cols);
        transitions.push(pos);
        color ^= 1;
    }
    // Phần tử cuối trùng `cols` là điểm kết thúc, không phải một đoạn mới.
    Some(transitions)
}

/// Chế độ mã hoá hai chiều (T.4 §4.2 / T.6).
enum Mode {
    Pass,
    Horizontal,
    Vertical(i32),
}

/// Một hàng mã hoá **hai chiều**, tham chiếu hàng trên.
fn decode_2d_row(r: &mut BitReader, reference: &[usize], cols: usize) -> Option<Vec<usize>> {
    let mut transitions: Vec<usize> = Vec::new();
    let mut a0: i32 = -1;
    let mut color = 0u8;

    while (a0 as i64) < cols as i64 {
        let (b1, b2) = find_b(reference, a0, color, cols);
        let mode = read_mode(r)?;
        match mode {
            Mode::Pass => {
                // Màu không đổi và **không** sinh điểm đổi màu: đoạn hiện tại chạy
                // tiếp tới b2. Sinh điểm ở đây là lỗi làm ảnh sọc dọc.
                a0 = b2 as i32;
            }
            Mode::Horizontal => {
                let start = if a0 < 0 { 0 } else { a0 as usize };
                let run1 = read_run(r, color)?;
                let run2 = read_run(r, color ^ 1)?;
                let a1 = (start + run1).min(cols);
                let a2 = (a1 + run2).min(cols);
                push_increasing(&mut transitions, a1);
                push_increasing(&mut transitions, a2);
                a0 = a2 as i32;
            }
            Mode::Vertical(delta) => {
                let a1 = (b1 as i32 + delta).clamp(0, cols as i32) as usize;
                push_increasing(&mut transitions, a1);
                a0 = a1 as i32;
                color ^= 1;
            }
        }
        if transitions.len() > cols * 2 + 4 {
            return None; // dữ liệu hỏng: nhiều điểm đổi màu hơn số pixel
        }
    }
    Some(transitions)
}

/// Giữ danh sách điểm đổi màu **không giảm**.
///
/// Stream hỏng có thể sinh vị trí lùi lại; nếu để lọt thì hàm đóng gói sẽ tô đoạn
/// ngược và ảnh loang thành vệt.
fn push_increasing(transitions: &mut Vec<usize>, value: usize) {
    match transitions.last() {
        Some(last) if *last > value => transitions.push(*last),
        _ => transitions.push(value),
    }
}

/// `b1`, `b2` — hai điểm đổi màu trên hàng tham chiếu, theo định nghĩa T.4.
///
/// `b1` là điểm đổi màu đầu tiên bên phải `a0` mà **màu sau nó** khác màu hiện tại.
/// Hàng tham chiếu bắt đầu từ trắng, nên điểm ở chỉ số chẵn là chuyển sang đen.
fn find_b(reference: &[usize], a0: i32, color: u8, cols: usize) -> (usize, usize) {
    let mut i = 0usize;
    while i < reference.len() && (reference[i] as i32) <= a0 {
        i += 1;
    }
    while i < reference.len() && (i % 2) != color as usize {
        i += 1;
    }
    let b1 = reference.get(i).copied().unwrap_or(cols);
    let b2 = reference.get(i + 1).copied().unwrap_or(cols);
    (b1.min(cols), b2.min(cols))
}

/// Đọc mã chế độ hai chiều (T.4 Table 4).
fn read_mode(r: &mut BitReader) -> Option<Mode> {
    // V0 = 1
    if r.read_bit()? == 1 {
        return Some(Mode::Vertical(0));
    }
    // 01x: VR1 (011) / VL1 (010)
    match r.read_bit()? {
        1 => {
            return Some(Mode::Vertical(if r.read_bit()? == 1 { 1 } else { -1 }));
        }
        _ => {}
    }
    // 001: horizontal
    if r.read_bit()? == 1 {
        return Some(Mode::Horizontal);
    }
    // 0001: pass
    if r.read_bit()? == 1 {
        return Some(Mode::Pass);
    }
    // 0000 11x: VR2 (000011) / VL2 (000010)
    if r.read_bit()? == 1 {
        return Some(Mode::Vertical(if r.read_bit()? == 1 { 2 } else { -2 }));
    }
    // 0000 011x: VR3 (0000011) / VL3 (0000010)
    if r.read_bit()? == 1 {
        return Some(Mode::Vertical(if r.read_bit()? == 1 { 3 } else { -3 }));
    }
    // Còn lại là EOL, EOFB hoặc mã mở rộng (uncompressed) — dừng hàng.
    None
}

/// Đọc một run length, gồm 0..n mã makeup rồi một mã kết thúc.
fn read_run(r: &mut BitReader, color: u8) -> Option<usize> {
    let mut total = 0usize;
    for _ in 0..64 {
        let (run, terminating) = read_code(r, color)?;
        total += run;
        if terminating {
            return Some(total);
        }
    }
    None
}

/// Tra một mã đơn. Trả `(run, là_mã_kết_thúc)`.
fn read_code(r: &mut BitReader, color: u8) -> Option<(usize, bool)> {
    let table: &[(u16, u8, u16)] = if color == 0 { WHITE_CODES } else { BLACK_CODES };
    for (bits, len, run) in table.iter().chain(SHARED_MAKEUP.iter()) {
        if let Some(v) = r.peek(*len as u32) {
            if v as u16 == *bits {
                r.skip(*len as u32);
                return Some((*run as usize, *run < 64));
            }
        }
    }
    None
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bảng mã T.4
// ─────────────────────────────────────────────────────────────────────────────
//
// Mỗi phần tử: (giá trị bit, số bit, run length). Mã có `run < 64` là mã **kết
// thúc**; `run >= 64` là mã makeup và phải đi kèm một mã kết thúc sau đó.
//
// Bảng dài nhưng phải đủ: thiếu một mã makeup làm ảnh scan bị lệch từ giữa hàng, và
// lỗi đó biểu hiện thành vệt chéo chứ không thành lỗi giải mã.

/// Mã cho run **trắng**.
#[rustfmt::skip]
const WHITE_CODES: &[(u16, u8, u16)] = &[
    // Mã kết thúc 0..63.
    (0b00110101, 8, 0),   (0b000111, 6, 1),     (0b0111, 4, 2),       (0b1000, 4, 3),
    (0b1011, 4, 4),       (0b1100, 4, 5),       (0b1110, 4, 6),       (0b1111, 4, 7),
    (0b10011, 5, 8),      (0b10100, 5, 9),      (0b00111, 5, 10),     (0b01000, 5, 11),
    (0b001000, 6, 12),    (0b000011, 6, 13),    (0b110100, 6, 14),    (0b110101, 6, 15),
    (0b101010, 6, 16),    (0b101011, 6, 17),    (0b0100111, 7, 18),   (0b0001100, 7, 19),
    (0b0001000, 7, 20),   (0b0010111, 7, 21),   (0b0000011, 7, 22),   (0b0000100, 7, 23),
    (0b0101000, 7, 24),   (0b0101011, 7, 25),   (0b0010011, 7, 26),   (0b0100100, 7, 27),
    (0b0011000, 7, 28),   (0b00000010, 8, 29),  (0b00000011, 8, 30),  (0b00011010, 8, 31),
    (0b00011011, 8, 32),  (0b00010010, 8, 33),  (0b00010011, 8, 34),  (0b00010100, 8, 35),
    (0b00010101, 8, 36),  (0b00010110, 8, 37),  (0b00010111, 8, 38),  (0b00101000, 8, 39),
    (0b00101001, 8, 40),  (0b00101010, 8, 41),  (0b00101011, 8, 42),  (0b00101100, 8, 43),
    (0b00101101, 8, 44),  (0b00000100, 8, 45),  (0b00000101, 8, 46),  (0b00001010, 8, 47),
    (0b00001011, 8, 48),  (0b01010010, 8, 49),  (0b01010011, 8, 50),  (0b01010100, 8, 51),
    (0b01010101, 8, 52),  (0b00100100, 8, 53),  (0b00100101, 8, 54),  (0b01011000, 8, 55),
    (0b01011001, 8, 56),  (0b01011010, 8, 57),  (0b01011011, 8, 58),  (0b01001010, 8, 59),
    (0b01001011, 8, 60),  (0b00110010, 8, 61),  (0b00110011, 8, 62),  (0b00110100, 8, 63),
    // Mã makeup 64..1728.
    (0b11011, 5, 64),     (0b10010, 5, 128),    (0b010111, 6, 192),   (0b0110111, 7, 256),
    (0b00110110, 8, 320), (0b00110111, 8, 384), (0b01100100, 8, 448), (0b01100101, 8, 512),
    (0b01101000, 8, 576), (0b01100111, 8, 640),
    (0b011001100, 9, 704),  (0b011001101, 9, 768),  (0b011010010, 9, 832),
    (0b011010011, 9, 896),  (0b011010100, 9, 960),  (0b011010101, 9, 1024),
    (0b011010110, 9, 1088), (0b011010111, 9, 1152), (0b011011000, 9, 1216),
    (0b011011001, 9, 1280), (0b011011010, 9, 1344), (0b011011011, 9, 1408),
    (0b010011000, 9, 1472), (0b010011001, 9, 1536), (0b010011010, 9, 1600),
    (0b011000, 6, 1664),    (0b010011011, 9, 1728),
];

/// Mã cho run **đen**.
#[rustfmt::skip]
const BLACK_CODES: &[(u16, u8, u16)] = &[
    (0b0000110111, 10, 0), (0b010, 3, 1),        (0b11, 2, 2),         (0b10, 2, 3),
    (0b011, 3, 4),         (0b0011, 4, 5),       (0b0010, 4, 6),       (0b00011, 5, 7),
    (0b000101, 6, 8),      (0b000100, 6, 9),     (0b0000100, 7, 10),   (0b0000101, 7, 11),
    (0b0000111, 7, 12),    (0b00000100, 8, 13),  (0b00000111, 8, 14),  (0b000011000, 9, 15),
    (0b0000010111, 10, 16), (0b0000011000, 10, 17), (0b0000001000, 10, 18),
    (0b00001100111, 11, 19), (0b00001101000, 11, 20), (0b00001101100, 11, 21),
    (0b00000110111, 11, 22), (0b00000101000, 11, 23), (0b00000010111, 11, 24),
    (0b00000011000, 11, 25),
    (0b000011001010, 12, 26), (0b000011001011, 12, 27), (0b000011001100, 12, 28),
    (0b000011001101, 12, 29), (0b000001101000, 12, 30), (0b000001101001, 12, 31),
    (0b000001101010, 12, 32), (0b000001101011, 12, 33), (0b000011010010, 12, 34),
    (0b000011010011, 12, 35), (0b000011010100, 12, 36), (0b000011010101, 12, 37),
    (0b000011010110, 12, 38), (0b000011010111, 12, 39), (0b000001101100, 12, 40),
    (0b000001101101, 12, 41), (0b000011011010, 12, 42), (0b000011011011, 12, 43),
    (0b000001010100, 12, 44), (0b000001010101, 12, 45), (0b000001010110, 12, 46),
    (0b000001010111, 12, 47), (0b000001100100, 12, 48), (0b000001100101, 12, 49),
    (0b000001010010, 12, 50), (0b000001010011, 12, 51), (0b000000100100, 12, 52),
    (0b000000110111, 12, 53), (0b000000111000, 12, 54), (0b000000100111, 12, 55),
    (0b000000101000, 12, 56), (0b000001011000, 12, 57), (0b000001011001, 12, 58),
    (0b000000101011, 12, 59), (0b000000101100, 12, 60), (0b000001011010, 12, 61),
    (0b000001100110, 12, 62), (0b000001100111, 12, 63),
    // Makeup.
    (0b0000001111, 10, 64),
    (0b000011001000, 12, 128), (0b000011001001, 12, 192), (0b000001011011, 12, 256),
    (0b000000110011, 12, 320), (0b000000110100, 12, 384), (0b000000110101, 12, 448),
    (0b0000001101100, 13, 512),  (0b0000001101101, 13, 576),  (0b0000001001010, 13, 640),
    (0b0000001001011, 13, 704),  (0b0000001001100, 13, 768),  (0b0000001001101, 13, 832),
    (0b0000001110010, 13, 896),  (0b0000001110011, 13, 960),  (0b0000001110100, 13, 1024),
    (0b0000001110101, 13, 1088), (0b0000001110110, 13, 1152), (0b0000001110111, 13, 1216),
    (0b0000001010010, 13, 1280), (0b0000001010011, 13, 1344), (0b0000001010100, 13, 1408),
    (0b0000001010101, 13, 1472), (0b0000001011010, 13, 1536), (0b0000001011011, 13, 1600),
    (0b0000001100100, 13, 1664), (0b0000001100101, 13, 1728),
];

/// Mã makeup dùng chung cho cả hai màu (T.4 Table 3, phần mở rộng).
#[rustfmt::skip]
const SHARED_MAKEUP: &[(u16, u8, u16)] = &[
    (0b00000001000, 11, 1792), (0b00000001100, 11, 1856), (0b00000001101, 11, 1920),
    (0b000000010010, 12, 1984), (0b000000010011, 12, 2048), (0b000000010100, 12, 2112),
    (0b000000010101, 12, 2176), (0b000000010110, 12, 2240), (0b000000010111, 12, 2304),
    (0b000000011100, 12, 2368), (0b000000011101, 12, 2432), (0b000000011110, 12, 2496),
    (0b000000011111, 12, 2560),
];

/// Bộ đọc bit MSB-first.
struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader { data, bit: 0 }
    }

    fn exhausted(&self) -> bool {
        self.bit >= self.data.len() * 8
    }

    fn peek(&self, bits: u32) -> Option<u32> {
        if bits == 0 || bits > 24 || self.bit + bits as usize > self.data.len() * 8 {
            return None;
        }
        let mut out = 0u32;
        for i in 0..bits as usize {
            let p = self.bit + i;
            let byte = self.data[p >> 3];
            out = (out << 1) | ((byte >> (7 - (p & 7))) & 1) as u32;
        }
        Some(out)
    }

    fn skip(&mut self, bits: u32) {
        self.bit = (self.bit + bits as usize).min(self.data.len() * 8);
    }

    fn read_bit(&mut self) -> Option<u8> {
        let v = self.peek(1)? as u8;
        self.bit += 1;
        Some(v)
    }

    fn align(&mut self) {
        if self.bit % 8 != 0 {
            self.bit += 8 - (self.bit % 8);
        }
    }

    /// `true` nếu ngay tại con trỏ là mã EOL `000000000001`.
    fn peek_eol(&self) -> bool {
        self.peek(12) == Some(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bộ ghi bit để dựng stream test — chỉ dùng trong test.
    struct BitWriter {
        data: Vec<u8>,
        bit: usize,
    }

    impl BitWriter {
        fn new() -> Self {
            BitWriter { data: Vec::new(), bit: 0 }
        }

        fn push(&mut self, value: u32, bits: u32) {
            for i in (0..bits).rev() {
                if self.bit % 8 == 0 {
                    self.data.push(0);
                }
                let b = ((value >> i) & 1) as u8;
                let last = self.data.len() - 1;
                self.data[last] |= b << (7 - (self.bit % 8));
                self.bit += 1;
            }
        }

        /// Ghi một run bằng cách tra ngược bảng — nếu bảng sai thì test cũng sai,
        /// nên test dùng nó chỉ để kiểm **cấu trúc**, còn tính đúng của bảng được
        /// chốt bằng dữ liệu ngoài trong `tests/render_ccitt.rs`.
        fn run(&mut self, len: usize, color: u8) {
            let table = if color == 0 { WHITE_CODES } else { BLACK_CODES };
            let (bits, n, _) = table
                .iter()
                .find(|(_, _, r)| *r as usize == len)
                .copied()
                .expect("run phải có mã kết thúc trong bảng");
            self.push(bits as u32, n as u32);
        }
    }

    fn params(cols: usize, rows: usize, k: i32) -> CcittParams {
        CcittParams { k, columns: cols, rows, ..Default::default() }
    }

    /// Đọc bit `x` của hàng `y` từ dữ liệu đã đóng gói. `true` = ĐEN.
    fn black_at(out: &[u8], cols: usize, x: usize, y: usize) -> bool {
        let row_bytes = cols.div_ceil(8);
        let byte = out[y * row_bytes + x / 8];
        // `black_is_1 = false` ⇒ bit 0 là đen.
        (byte >> (7 - (x % 8))) & 1 == 0
    }

    #[test]
    fn one_dimensional_row_decodes_white_then_black() {
        // 8 pixel: 3 trắng, 5 đen.
        let mut w = BitWriter::new();
        w.run(3, 0);
        w.run(5, 1);
        let out = decode(&w.data, &params(8, 1, 0)).unwrap();
        assert_eq!(out.len(), 1);
        for x in 0..3 {
            assert!(!black_at(&out, 8, x, 0), "x={x} phải trắng");
        }
        for x in 3..8 {
            assert!(black_at(&out, 8, x, 0), "x={x} phải đen");
        }
    }

    #[test]
    fn all_white_row_stays_white() {
        let mut w = BitWriter::new();
        w.run(8, 0);
        let out = decode(&w.data, &params(8, 1, 0)).unwrap();
        assert_eq!(out[0], 0xFF, "trắng toàn hàng ⇒ mọi bit 1");
    }

    #[test]
    fn all_black_row_is_all_zero_bits() {
        let mut w = BitWriter::new();
        w.run(0, 0); // run trắng độ dài 0 — hàng luôn bắt đầu bằng trắng
        w.run(8, 1);
        let out = decode(&w.data, &params(8, 1, 0)).unwrap();
        assert_eq!(out[0], 0x00);
    }

    #[test]
    fn black_is_one_inverts_the_output() {
        // `/BlackIs1 true` ⇒ bit 1 là đen. Đảo chiều cờ này cho ra ảnh âm bản mà
        // không có lỗi nào nổi lên, nên phải có test riêng.
        let mut w = BitWriter::new();
        w.run(0, 0);
        w.run(8, 1);
        let p = CcittParams { black_is_1: true, ..params(8, 1, 0) };
        let out = decode(&w.data, &p).unwrap();
        assert_eq!(out[0], 0xFF);
    }

    #[test]
    fn multiple_rows_are_decoded() {
        let mut w = BitWriter::new();
        for _ in 0..3 {
            w.run(4, 0);
            w.run(4, 1);
        }
        let out = decode(&w.data, &params(8, 3, 0)).unwrap();
        assert_eq!(out.len(), 3);
        for y in 0..3 {
            assert!(!black_at(&out, 8, 0, y));
            assert!(black_at(&out, 8, 7, y));
        }
    }

    #[test]
    fn missing_rows_are_padded_white_not_dropped() {
        // File cắt cụt: giữ phần đọc được, đệm trắng cho đủ khung. Bỏ cả ảnh vì một
        // hàng thiếu là mất nhiều hơn cần thiết.
        let mut w = BitWriter::new();
        w.run(0, 0);
        w.run(8, 1);
        let out = decode(&w.data, &params(8, 4, 0)).unwrap();
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], 0x00, "hàng đọc được phải đen");
        assert_eq!(out[3], 0xFF, "hàng thiếu phải trắng");
    }

    #[test]
    fn group4_vertical_zero_copies_the_reference_row() {
        // Hàng 1 mã 1D (4 trắng + 4 đen); hàng 2 dùng V0 hai lần ⇒ giống hàng 1.
        // Đây là bài test cốt lõi của chế độ 2D: sai hàng tham chiếu thì hàng 2 lệch.
        let mut w = BitWriter::new();
        // Nhóm 4 không có hàng 1D; hàng đầu tham chiếu là hàng trắng tưởng tượng.
        // Hàng 1: horizontal (001) + run trắng 4 + run đen 4.
        w.push(0b001, 3);
        w.run(4, 0);
        w.run(4, 1);
        // Hàng 2: V0 (điểm đổi màu tại 4), V0 (điểm tại 8).
        w.push(1, 1);
        w.push(1, 1);
        let out = decode(&w.data, &params(8, 2, -1)).unwrap();
        assert_eq!(out.len(), 2);
        for y in 0..2 {
            for x in 0..4 {
                assert!(!black_at(&out, 8, x, y), "({x},{y}) phải trắng");
            }
            for x in 4..8 {
                assert!(black_at(&out, 8, x, y), "({x},{y}) phải đen");
            }
        }
    }

    #[test]
    fn group4_vertical_right_shifts_the_edge() {
        let mut w = BitWriter::new();
        w.push(0b001, 3);
        w.run(4, 0);
        w.run(4, 1);
        // Hàng 2: VR1 ⇒ biên dịch sang phải 1 pixel; rồi V0 cho biên cuối.
        w.push(0b011, 3);
        w.push(1, 1);
        let out = decode(&w.data, &params(8, 2, -1)).unwrap();
        assert!(!black_at(&out, 8, 4, 1), "biên phải dịch sang phải");
        assert!(black_at(&out, 8, 5, 1));
    }

    #[test]
    fn group4_vertical_left_shifts_the_edge() {
        let mut w = BitWriter::new();
        w.push(0b001, 3);
        w.run(4, 0);
        w.run(4, 1);
        w.push(0b010, 3); // VL1
        w.push(1, 1);
        let out = decode(&w.data, &params(8, 2, -1)).unwrap();
        assert!(black_at(&out, 8, 3, 1), "biên phải dịch sang trái");
    }

    #[test]
    fn group4_pass_mode_extends_the_current_run() {
        // Hàng 1: trắng 2, đen 2, trắng 4. Hàng 2 dùng Pass ⇒ đoạn trắng đầu chạy
        // qua cả vùng đen của hàng trên.
        let mut w = BitWriter::new();
        w.push(0b001, 3);
        w.run(2, 0);
        w.run(2, 1);
        w.push(0b001, 3);
        w.run(4, 0);
        w.run(0, 1);
        // Hàng 2: Pass (0001) rồi horizontal trắng 8 / đen 0.
        w.push(0b0001, 4);
        w.push(0b001, 3);
        w.run(4, 0);
        w.run(0, 1);
        let out = decode(&w.data, &params(8, 2, -1)).unwrap();
        assert_eq!(out.len(), 2);
        for x in 0..8 {
            assert!(!black_at(&out, 8, x, 1), "hàng 2 phải trắng tại {x}");
        }
    }

    #[test]
    fn makeup_codes_handle_runs_over_63() {
        // Run 100 = makeup 64 + kết thúc 36.
        let mut w = BitWriter::new();
        w.push(0b11011, 5); // makeup trắng 64
        w.run(36, 0);
        w.run(28, 1);
        let out = decode(&w.data, &params(128, 1, 0)).unwrap();
        assert!(!black_at(&out, 128, 99, 0), "pixel 99 phải trắng");
        assert!(black_at(&out, 128, 100, 0), "pixel 100 phải đen");
    }

    #[test]
    fn eol_between_rows_is_skipped() {
        let mut w = BitWriter::new();
        w.push(1, 12); // EOL
        w.run(4, 0);
        w.run(4, 1);
        w.push(1, 12);
        w.run(4, 0);
        w.run(4, 1);
        let out = decode(&w.data, &params(8, 2, 0)).unwrap();
        assert_eq!(out.len(), 2);
        assert!(black_at(&out, 8, 7, 1));
    }

    #[test]
    fn encoded_byte_align_starts_each_row_on_a_byte() {
        let mut w = BitWriter::new();
        w.run(3, 0);
        w.run(5, 1);
        // Đệm tới biên byte.
        while w.bit % 8 != 0 {
            w.push(0, 1);
        }
        w.run(5, 0);
        w.run(3, 1);
        let p = CcittParams { encoded_byte_align: true, ..params(8, 2, 0) };
        let out = decode(&w.data, &p).unwrap();
        assert!(black_at(&out, 8, 3, 0));
        assert!(!black_at(&out, 8, 3, 1), "hàng 2 phải bắt đầu ở biên byte");
    }

    #[test]
    fn zero_columns_is_rejected() {
        assert!(decode(&[0xFF], &params(0, 1, 0)).is_err());
    }

    #[test]
    fn undecodable_data_is_an_error_not_a_blank_image() {
        // Toàn bit 0 không khớp mã nào ⇒ phải báo lỗi, không trả ảnh trắng.
        assert!(decode(&[0x00; 8], &params(1728, 1, -1)).is_err());
    }

    /// Dữ liệu G4 **thật**, sinh bởi một encoder độc lập (libtiff qua Pillow) từ một
    /// bitmap đã biết: 24×12 trắng, có hình chữ nhật đen `x ∈ [8,16)`, `y ∈ [3,9)`.
    ///
    /// Đây là bài test duy nhất chốt được **tính đúng của bảng mã**. Mọi test khác ở
    /// trên tự dựng stream bằng chính bảng này, nên một mã sai vẫn qua được chúng.
    /// Ghi chú về chiều bit: libtiff coi **bit 0 là run trắng**, còn Pillow ở chế độ
    /// `'1'` lưu trắng bằng bit 1. Nên bitmap nguồn dùng để sinh blob này bị đảo lại
    /// (hình chữ nhật mang giá trị 1) để chiều của stream khớp quy ước fax — cùng
    /// quy ước mà PDF dùng khi `/BlackIs1` là `false`.
    const REAL_G4: &[u8] = &[0xE6, 0x62, 0xFF, 0xFF, 0x8F, 0x00, 0x10, 0x01];

    #[test]
    fn real_group4_stream_decodes_to_the_expected_bitmap() {
        let out = decode(REAL_G4, &params(24, 12, -1)).expect("phải giải mã được");
        assert_eq!(out.len(), 3 * 12, "24 cột = 3 byte/hàng");
        for y in 0..12 {
            for x in 0..24 {
                let expected_black = (8..16).contains(&x) && (3..9).contains(&y);
                assert_eq!(
                    black_at(&out, 24, x, y),
                    expected_black,
                    "pixel ({x},{y})"
                );
            }
        }
    }

    #[test]
    fn real_group4_stream_respects_black_is_1() {
        let p = CcittParams { black_is_1: true, ..params(24, 12, -1) };
        let out = decode(REAL_G4, &p).unwrap();
        let row_bytes = 3;
        // `BlackIs1 true` ⇒ pixel đen mang bit 1.
        let byte = out[4 * row_bytes + 1];
        assert_eq!(byte, 0xFF, "hàng 4, byte giữa (x 8..16) phải toàn 1");
    }

    #[test]
    fn bit_reader_peek_does_not_advance() {
        let mut r = BitReader::new(&[0b1010_0000]);
        assert_eq!(r.peek(3), Some(0b101));
        assert_eq!(r.peek(3), Some(0b101));
        r.skip(3);
        assert_eq!(r.peek(2), Some(0b00));
    }

    #[test]
    fn bit_reader_align_moves_to_byte_boundary() {
        let mut r = BitReader::new(&[0xFF, 0x0F]);
        r.skip(3);
        r.align();
        assert_eq!(r.peek(4), Some(0b0000));
    }
}
