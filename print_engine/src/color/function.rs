//! PDF Function (ISO 32000-2 §7.10) — bốn kiểu 0/2/3/4.
//!
//! # Vì sao đây là điều kiện tiên quyết cho spot color
//!
//! `Separation` và `DeviceN` lưu màu bằng **tint** (một số 0–1 cho mỗi mực) cộng
//! một **tint transform**: hàm quy tint về alternate space để hiển thị. Không có
//! function evaluator thì:
//!
//! * không dựng được màu xem trước của kẽm spot;
//! * không đổi được spot → CMYK (action `Spot→CMYK`);
//! * `DeviceN` nhiều mực không tách được thành phần.
//!
//! Illustrator/InDesign xuất tint transform gần như luôn là **kiểu 4**
//! (PostScript calculator), nên kiểu 4 là bắt buộc, không phải tuỳ chọn.

use crate::error::{PpeError, PpeResult};

/// Hàm PDF đã phân giải, sẵn sàng `eval`.
#[derive(Debug, Clone)]
pub enum PdfFunction {
    /// Kiểu 0 — bảng mẫu nội suy đa tuyến tính.
    Sampled {
        domain: Vec<f32>,
        range: Vec<f32>,
        size: Vec<usize>,
        encode: Vec<f32>,
        decode: Vec<f32>,
        /// Mẫu đã chuẩn hoá về 0.0..=1.0, thứ tự output-major theo spec.
        samples: Vec<f32>,
        n_out: usize,
    },
    /// Kiểu 2 — nội suy luỹ thừa `C0 + x^N × (C1 − C0)`.
    Exponential {
        domain: Vec<f32>,
        c0: Vec<f32>,
        c1: Vec<f32>,
        n: f32,
        range: Option<Vec<f32>>,
    },
    /// Kiểu 3 — ghép nhiều hàm con theo khoảng.
    Stitching {
        domain: Vec<f32>,
        functions: Vec<PdfFunction>,
        bounds: Vec<f32>,
        encode: Vec<f32>,
        range: Option<Vec<f32>>,
    },
    /// Kiểu 4 — PostScript calculator.
    PostScript {
        domain: Vec<f32>,
        range: Vec<f32>,
        program: Vec<PsOp>,
    },
    /// Không có tint transform hợp lệ — trả thẳng input, cắt/đệm theo `n_out`.
    ///
    /// Dùng khi file hỏng: thà xấp xỉ và ghi cảnh báo còn hơn bỏ trắng object.
    Identity { n_out: usize },
}

impl PdfFunction {
    /// Số kênh đầu ra, nếu suy được từ khai báo.
    pub fn n_out(&self) -> usize {
        match self {
            PdfFunction::Sampled { n_out, .. } => *n_out,
            PdfFunction::Exponential { c0, .. } => c0.len(),
            PdfFunction::Stitching {
                functions, range, ..
            } => range
                .as_ref()
                .map(|r| r.len() / 2)
                .unwrap_or_else(|| functions.first().map(|f| f.n_out()).unwrap_or(1)),
            PdfFunction::PostScript { range, .. } => range.len() / 2,
            PdfFunction::Identity { n_out } => *n_out,
        }
    }

    /// Tính hàm. Input được kẹp vào `Domain`, output kẹp vào `Range` (bắt buộc
    /// theo spec — Range là ràng buộc, không phải gợi ý).
    pub fn eval(&self, input: &[f32]) -> Vec<f32> {
        match self {
            PdfFunction::Identity { n_out } => {
                let mut out = vec![0.0; *n_out];
                for (o, i) in out.iter_mut().zip(input.iter()) {
                    *o = *i;
                }
                out
            }
            PdfFunction::Exponential {
                domain,
                c0,
                c1,
                n,
                range,
            } => {
                let x = clamp_to(input.first().copied().unwrap_or(0.0), domain, 0);
                let t = if *n == 1.0 { x } else { safe_pow(x, *n) };
                let mut out: Vec<f32> = c0
                    .iter()
                    .zip(c1.iter())
                    .map(|(a, b)| a + t * (b - a))
                    .collect();
                if let Some(r) = range {
                    clamp_range(&mut out, r);
                }
                out
            }
            PdfFunction::Stitching {
                domain,
                functions,
                bounds,
                encode,
                range,
            } => {
                let x = clamp_to(input.first().copied().unwrap_or(0.0), domain, 0);
                let (d0, d1) = (domain[0], domain[1]);
                let k = bounds
                    .iter()
                    .position(|b| x < *b)
                    .unwrap_or(functions.len() - 1);
                let low = if k == 0 { d0 } else { bounds[k - 1] };
                let high = if k == bounds.len() { d1 } else { bounds[k] };
                let (e0, e1) = (
                    encode.get(2 * k).copied().unwrap_or(0.0),
                    encode.get(2 * k + 1).copied().unwrap_or(1.0),
                );
                let xe = interpolate(x, low, high, e0, e1);
                let mut out = functions[k].eval(&[xe]);
                if let Some(r) = range {
                    clamp_range(&mut out, r);
                }
                out
            }
            PdfFunction::Sampled {
                domain,
                range,
                size,
                encode,
                decode,
                samples,
                n_out,
            } => {
                let mut out = eval_sampled(input, domain, size, encode, samples, *n_out);
                // Decode đưa mẫu 0..1 về khoảng thực; mặc định Decode = Range.
                let dec = if decode.len() >= n_out * 2 {
                    decode
                } else {
                    range
                };
                for (j, v) in out.iter_mut().enumerate() {
                    let (d0, d1) = (dec[2 * j], dec[2 * j + 1]);
                    *v = d0 + *v * (d1 - d0);
                }
                clamp_range(&mut out, range);
                out
            }
            PdfFunction::PostScript {
                domain,
                range,
                program,
            } => {
                let mut stack: Vec<f32> = Vec::with_capacity(32);
                for (i, v) in input.iter().enumerate() {
                    stack.push(clamp_to(*v, domain, i));
                }
                exec_ps(program, &mut stack, 0);
                let n_out = range.len() / 2;
                // Spec: n giá trị CUỐI trên stack là output.
                let mut out = if stack.len() >= n_out {
                    stack[stack.len() - n_out..].to_vec()
                } else {
                    let mut padded = vec![0.0; n_out - stack.len()];
                    padded.extend_from_slice(&stack);
                    padded
                };
                clamp_range(&mut out, range);
                out
            }
        }
    }
}

fn safe_pow(x: f32, n: f32) -> f32 {
    if x < 0.0 && n.fract() != 0.0 {
        0.0
    } else {
        x.powf(n)
    }
}

fn clamp_to(v: f32, domain: &[f32], i: usize) -> f32 {
    match (domain.get(2 * i), domain.get(2 * i + 1)) {
        (Some(lo), Some(hi)) => v.clamp(lo.min(*hi), hi.max(*lo)),
        _ => v,
    }
}

fn clamp_range(out: &mut [f32], range: &[f32]) {
    for (j, v) in out.iter_mut().enumerate() {
        if let (Some(lo), Some(hi)) = (range.get(2 * j), range.get(2 * j + 1)) {
            *v = v.clamp(lo.min(*hi), hi.max(*lo));
        }
    }
}

fn interpolate(x: f32, xmin: f32, xmax: f32, ymin: f32, ymax: f32) -> f32 {
    if (xmax - xmin).abs() < f32::EPSILON {
        ymin
    } else {
        ymin + (x - xmin) * (ymax - ymin) / (xmax - xmin)
    }
}

/// Nội suy đa tuyến tính trên lưới mẫu m chiều.
///
/// Duyệt `2^m` đỉnh của ô lưới chứa điểm cần tính. Với tint transform thực tế
/// `m` là 1–4 nên `2^m ≤ 16`, không cần tối ưu thêm.
fn eval_sampled(
    input: &[f32],
    domain: &[f32],
    size: &[usize],
    encode: &[f32],
    samples: &[f32],
    n_out: usize,
) -> Vec<f32> {
    let m = size.len();
    let mut base = Vec::with_capacity(m);
    let mut frac = Vec::with_capacity(m);

    for i in 0..m {
        let x = clamp_to(input.get(i).copied().unwrap_or(0.0), domain, i);
        let (d0, d1) = (domain[2 * i], domain[2 * i + 1]);
        let (e0, e1) = (
            encode.get(2 * i).copied().unwrap_or(0.0),
            encode
                .get(2 * i + 1)
                .copied()
                .unwrap_or((size[i] - 1) as f32),
        );
        let e = interpolate(x, d0, d1, e0, e1).clamp(0.0, (size[i] - 1) as f32);
        let i0 = e.floor() as usize;
        let i0 = i0.min(size[i].saturating_sub(1));
        base.push(i0);
        frac.push(e - i0 as f32);
    }

    let mut out = vec![0.0f32; n_out];
    let corners = 1usize << m;
    for corner in 0..corners {
        let mut weight = 1.0f32;
        let mut index = 0usize;
        let mut stride = 1usize;
        for i in 0..m {
            let up = (corner >> i) & 1 == 1;
            let coord = if up {
                (base[i] + 1).min(size[i] - 1)
            } else {
                base[i]
            };
            weight *= if up { frac[i] } else { 1.0 - frac[i] };
            index += coord * stride;
            stride *= size[i];
        }
        if weight == 0.0 {
            continue;
        }
        for j in 0..n_out {
            if let Some(s) = samples.get(index * n_out + j) {
                out[j] += weight * s;
            }
        }
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
//  Kiểu 4 — PostScript calculator
// ─────────────────────────────────────────────────────────────────────────────

/// Một lệnh trong chương trình kiểu 4.
///
/// Khối `{…}` được lưu dạng lồng nhau ngay khi parse, nên lúc chạy không phải
/// tìm dấu ngoặc khớp — `if`/`ifelse` chỉ là chọn nhánh đã dựng sẵn.
#[derive(Debug, Clone, PartialEq)]
pub enum PsOp {
    Num(f32),
    // Số học
    Add,
    Sub,
    Mul,
    Div,
    Idiv,
    Mod,
    Neg,
    Abs,
    Ceiling,
    Floor,
    Round,
    Truncate,
    Sqrt,
    Sin,
    Cos,
    Atan,
    Exp,
    Ln,
    Log,
    Cvi,
    Cvr,
    // Stack
    Dup,
    Pop,
    Exch,
    Copy,
    Index,
    Roll,
    // Quan hệ / logic
    Eq,
    Ne,
    Gt,
    Ge,
    Lt,
    Le,
    And,
    Or,
    Xor,
    Not,
    Bitshift,
    True,
    False,
    // Điều kiện
    If(Vec<PsOp>),
    IfElse(Vec<PsOp>, Vec<PsOp>),
}

/// Trần độ sâu lồng khối, chống chương trình dựng để làm tràn stack.
const PS_MAX_DEPTH: u32 = 64;
/// Trần kích thước stack — spec nói 100; nới nhẹ cho file thực tế hơi lệch.
const PS_MAX_STACK: usize = 256;

/// Parse chương trình kiểu 4 từ nội dung stream.
///
/// Chấp nhận cả dạng có và không có cặp `{}` bao ngoài.
pub fn parse_ps_program(src: &[u8]) -> PpeResult<Vec<PsOp>> {
    let text = String::from_utf8_lossy(src);
    let mut tokens = tokenize_ps(&text);
    // Bỏ cặp ngoặc ngoài cùng nếu có.
    if tokens.first().map(|t| t == "{").unwrap_or(false) {
        if tokens.last().map(|t| t == "}").unwrap_or(false) {
            tokens.remove(0);
            tokens.pop();
        }
    }
    let mut pos = 0usize;
    let ops = parse_ps_block(&tokens, &mut pos, 0)?;
    Ok(ops)
}

fn tokenize_ps(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_comment = false;
    for ch in text.chars() {
        if in_comment {
            if ch == '\n' || ch == '\r' {
                in_comment = false;
            }
            continue;
        }
        match ch {
            '%' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                in_comment = true;
            }
            '{' | '}' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                out.push(ch.to_string());
            }
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn parse_ps_block(tokens: &[String], pos: &mut usize, depth: u32) -> PpeResult<Vec<PsOp>> {
    if depth > PS_MAX_DEPTH {
        return Err(PpeError::ContentStream(
            "function kiểu 4 lồng quá sâu".into(),
        ));
    }
    let mut ops = Vec::new();
    // Khối `{…}` đã đọc nhưng chưa biết thuộc `if` hay `ifelse`.
    let mut pending: Vec<Vec<PsOp>> = Vec::new();

    while *pos < tokens.len() {
        let tok = &tokens[*pos];
        *pos += 1;
        match tok.as_str() {
            "}" => break,
            "{" => {
                let block = parse_ps_block(tokens, pos, depth + 1)?;
                pending.push(block);
            }
            "if" => {
                let proc_ = pending
                    .pop()
                    .ok_or_else(|| PpeError::ContentStream("`if` thiếu khối {}".into()))?;
                ops.push(PsOp::If(proc_));
            }
            "ifelse" => {
                let proc2 = pending
                    .pop()
                    .ok_or_else(|| PpeError::ContentStream("`ifelse` thiếu khối {}".into()))?;
                let proc1 = pending
                    .pop()
                    .ok_or_else(|| PpeError::ContentStream("`ifelse` thiếu khối {}".into()))?;
                ops.push(PsOp::IfElse(proc1, proc2));
            }
            other => {
                if let Some(op) = ps_op_from_name(other) {
                    ops.push(op);
                } else if let Ok(v) = other.parse::<f32>() {
                    ops.push(PsOp::Num(v));
                } else {
                    return Err(PpeError::ContentStream(format!(
                        "toán tử kiểu 4 không nhận dạng được: {other}"
                    )));
                }
            }
        }
    }
    Ok(ops)
}

fn ps_op_from_name(name: &str) -> Option<PsOp> {
    use PsOp::*;
    Some(match name {
        "add" => Add,
        "sub" => Sub,
        "mul" => Mul,
        "div" => Div,
        "idiv" => Idiv,
        "mod" => Mod,
        "neg" => Neg,
        "abs" => Abs,
        "ceiling" => Ceiling,
        "floor" => Floor,
        "round" => Round,
        "truncate" => Truncate,
        "sqrt" => Sqrt,
        "sin" => Sin,
        "cos" => Cos,
        "atan" => Atan,
        "exp" => Exp,
        "ln" => Ln,
        "log" => Log,
        "cvi" => Cvi,
        "cvr" => Cvr,
        "dup" => Dup,
        "pop" => Pop,
        "exch" => Exch,
        "copy" => Copy,
        "index" => Index,
        "roll" => Roll,
        "eq" => Eq,
        "ne" => Ne,
        "gt" => Gt,
        "ge" => Ge,
        "lt" => Lt,
        "le" => Le,
        "and" => And,
        "or" => Or,
        "xor" => Xor,
        "not" => Not,
        "bitshift" => Bitshift,
        "true" => True,
        "false" => False,
        _ => return None,
    })
}

/// Boolean trên stack biểu diễn bằng 1.0 / 0.0.
const PS_TRUE: f32 = 1.0;
const PS_FALSE: f32 = 0.0;

fn exec_ps(program: &[PsOp], stack: &mut Vec<f32>, depth: u32) {
    if depth > PS_MAX_DEPTH {
        return;
    }
    macro_rules! pop {
        () => {
            stack.pop().unwrap_or(0.0)
        };
    }
    macro_rules! bin {
        (|$a:ident, $b:ident| $body:expr) => {{
            let $b = pop!();
            let $a = pop!();
            stack.push($body);
        }};
    }

    for op in program {
        if stack.len() > PS_MAX_STACK {
            return; // chương trình bất thường: dừng, để lớp trên hạ accuracy
        }
        use PsOp::*;
        match op {
            Num(v) => stack.push(*v),
            True => stack.push(PS_TRUE),
            False => stack.push(PS_FALSE),

            Add => bin!(|a, b| a + b),
            Sub => bin!(|a, b| a - b),
            Mul => bin!(|a, b| a * b),
            Div => bin!(|a, b| if b == 0.0 { 0.0 } else { a / b }),
            Idiv => bin!(|a, b| if b as i32 == 0 {
                0.0
            } else {
                ((a as i32) / (b as i32)) as f32
            }),
            Mod => bin!(|a, b| if b as i32 == 0 {
                0.0
            } else {
                ((a as i32) % (b as i32)) as f32
            }),
            Exp => bin!(|a, b| safe_pow(a, b)),

            Neg => {
                let a = pop!();
                stack.push(-a);
            }
            Abs => {
                let a = pop!();
                stack.push(a.abs());
            }
            Ceiling => {
                let a = pop!();
                stack.push(a.ceil());
            }
            Floor => {
                let a = pop!();
                stack.push(a.floor());
            }
            Round => {
                let a = pop!();
                stack.push(a.round());
            }
            Truncate => {
                let a = pop!();
                stack.push(a.trunc());
            }
            Sqrt => {
                let a = pop!();
                stack.push(if a < 0.0 { 0.0 } else { a.sqrt() });
            }
            // sin/cos của PostScript nhận ĐỘ, không phải radian.
            Sin => {
                let a = pop!();
                stack.push(a.to_radians().sin());
            }
            Cos => {
                let a = pop!();
                stack.push(a.to_radians().cos());
            }
            // atan trả góc 0..360 độ, KHÔNG phải -π..π.
            Atan => {
                let den = pop!();
                let num = pop!();
                let mut deg = num.atan2(den).to_degrees();
                if deg < 0.0 {
                    deg += 360.0;
                }
                stack.push(deg);
            }
            Ln => {
                let a = pop!();
                stack.push(if a <= 0.0 { 0.0 } else { a.ln() });
            }
            Log => {
                let a = pop!();
                stack.push(if a <= 0.0 { 0.0 } else { a.log10() });
            }
            Cvi => {
                let a = pop!();
                stack.push(a.trunc());
            }
            Cvr => { /* đã là số thực */ }

            Dup => {
                let a = *stack.last().unwrap_or(&0.0);
                stack.push(a);
            }
            Pop => {
                stack.pop();
            }
            Exch => {
                let b = pop!();
                let a = pop!();
                stack.push(b);
                stack.push(a);
            }
            Copy => {
                let n = pop!().max(0.0) as usize;
                let len = stack.len();
                if n > 0 && n <= len && len + n <= PS_MAX_STACK {
                    let start = len - n;
                    let slice: Vec<f32> = stack[start..].to_vec();
                    stack.extend_from_slice(&slice);
                }
            }
            Index => {
                let n = pop!();
                if n >= 0.0 {
                    let n = n as usize;
                    if n < stack.len() {
                        let v = stack[stack.len() - 1 - n];
                        stack.push(v);
                    } else {
                        stack.push(0.0);
                    }
                } else {
                    stack.push(0.0);
                }
            }
            Roll => {
                let j = pop!() as i32;
                let n = pop!().max(0.0) as usize;
                if n > 0 && n <= stack.len() {
                    let start = stack.len() - n;
                    let slice = &mut stack[start..];
                    let shift = ((j % n as i32) + n as i32) % n as i32;
                    slice.rotate_right(shift as usize);
                }
            }

            Eq => bin!(|a, b| if a == b { PS_TRUE } else { PS_FALSE }),
            Ne => bin!(|a, b| if a != b { PS_TRUE } else { PS_FALSE }),
            Gt => bin!(|a, b| if a > b { PS_TRUE } else { PS_FALSE }),
            Ge => bin!(|a, b| if a >= b { PS_TRUE } else { PS_FALSE }),
            Lt => bin!(|a, b| if a < b { PS_TRUE } else { PS_FALSE }),
            Le => bin!(|a, b| if a <= b { PS_TRUE } else { PS_FALSE }),
            And => bin!(|a, b| ((a as i32) & (b as i32)) as f32),
            Or => bin!(|a, b| ((a as i32) | (b as i32)) as f32),
            Xor => bin!(|a, b| ((a as i32) ^ (b as i32)) as f32),
            Bitshift => bin!(|a, b| {
                let shift = b as i32;
                let v = a as i32;
                if shift >= 0 {
                    (v << shift.min(31)) as f32
                } else {
                    (v >> (-shift).min(31)) as f32
                }
            }),
            Not => {
                // `not` của PostScript là logic khi toán hạng là boolean, bitwise
                // khi là số nguyên. Ta chuẩn hoá boolean thành 0/1 nên chỉ cần
                // phân biệt đúng hai giá trị đó.
                let a = pop!();
                stack.push(if a == PS_TRUE {
                    PS_FALSE
                } else if a == PS_FALSE {
                    PS_TRUE
                } else {
                    !(a as i32) as f32
                });
            }

            If(proc_) => {
                let cond = pop!();
                if cond != PS_FALSE {
                    exec_ps(proc_, stack, depth + 1);
                }
            }
            IfElse(p1, p2) => {
                let cond = pop!();
                if cond != PS_FALSE {
                    exec_ps(p1, stack, depth + 1);
                } else {
                    exec_ps(p2, stack, depth + 1);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn exponential_linear_ramp() {
        let f = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![0.0],
            c1: vec![1.0],
            n: 1.0,
            range: None,
        };
        assert!(approx(f.eval(&[0.0])[0], 0.0));
        assert!(approx(f.eval(&[0.5])[0], 0.5));
        assert!(approx(f.eval(&[1.0])[0], 1.0));
    }

    #[test]
    fn exponential_tint_to_cmyk_is_typical_spot_transform() {
        // Tint transform hay gặp nhất của Separation: 0 → giấy, 1 → màu mực.
        let f = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![0.0, 0.0, 0.0, 0.0],
            c1: vec![0.0, 0.91, 0.76, 0.0],
            n: 1.0,
            range: Some(vec![0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0]),
        };
        let half = f.eval(&[0.5]);
        assert!(approx(half[1], 0.455), "M={}", half[1]);
        assert!(approx(half[3], 0.0));
    }

    #[test]
    fn exponential_clamps_input_to_domain() {
        let f = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![0.0],
            c1: vec![1.0],
            n: 1.0,
            range: None,
        };
        assert!(approx(f.eval(&[2.0])[0], 1.0));
        assert!(approx(f.eval(&[-1.0])[0], 0.0));
    }

    #[test]
    fn range_clamps_output() {
        let f = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![0.0],
            c1: vec![2.0],
            n: 1.0,
            range: Some(vec![0.0, 1.0]),
        };
        assert!(approx(f.eval(&[1.0])[0], 1.0), "Range là ràng buộc cứng");
    }

    #[test]
    fn stitching_selects_subfunction_by_bounds() {
        let low = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![0.0],
            c1: vec![0.0],
            n: 1.0,
            range: None,
        };
        let high = PdfFunction::Exponential {
            domain: vec![0.0, 1.0],
            c0: vec![1.0],
            c1: vec![1.0],
            n: 1.0,
            range: None,
        };
        let f = PdfFunction::Stitching {
            domain: vec![0.0, 1.0],
            functions: vec![low, high],
            bounds: vec![0.5],
            encode: vec![0.0, 1.0, 0.0, 1.0],
            range: None,
        };
        assert!(approx(f.eval(&[0.25])[0], 0.0));
        assert!(approx(f.eval(&[0.75])[0], 1.0));
    }

    #[test]
    fn sampled_1d_interpolates_between_samples() {
        // 3 mẫu: 0.0, 0.5, 1.0 trên domain 0..1.
        let f = PdfFunction::Sampled {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 1.0],
            size: vec![3],
            encode: vec![0.0, 2.0],
            decode: vec![0.0, 1.0],
            samples: vec![0.0, 0.5, 1.0],
            n_out: 1,
        };
        assert!(approx(f.eval(&[0.0])[0], 0.0));
        assert!(approx(f.eval(&[0.5])[0], 0.5));
        assert!(approx(f.eval(&[0.25])[0], 0.25));
        assert!(approx(f.eval(&[1.0])[0], 1.0));
    }

    #[test]
    fn sampled_decode_maps_to_range() {
        let f = PdfFunction::Sampled {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 100.0],
            size: vec![2],
            encode: vec![0.0, 1.0],
            decode: vec![0.0, 100.0],
            samples: vec![0.0, 1.0],
            n_out: 1,
        };
        assert!(approx(f.eval(&[1.0])[0], 100.0));
        assert!(approx(f.eval(&[0.5])[0], 50.0));
    }

    #[test]
    fn sampled_2d_bilinear() {
        // Lưới 2x2, output = trung bình song tuyến.
        let f = PdfFunction::Sampled {
            domain: vec![0.0, 1.0, 0.0, 1.0],
            range: vec![0.0, 1.0],
            size: vec![2, 2],
            encode: vec![0.0, 1.0, 0.0, 1.0],
            decode: vec![0.0, 1.0],
            samples: vec![0.0, 1.0, 1.0, 0.0],
            n_out: 1,
        };
        assert!(approx(f.eval(&[0.5, 0.5])[0], 0.5));
        assert!(approx(f.eval(&[0.0, 0.0])[0], 0.0));
        assert!(approx(f.eval(&[1.0, 0.0])[0], 1.0));
    }

    #[test]
    fn ps_parses_and_evaluates_arithmetic() {
        let prog = parse_ps_program(b"{ 2 mul }").unwrap();
        let f = PdfFunction::PostScript {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 2.0],
            program: prog,
        };
        assert!(approx(f.eval(&[0.5])[0], 1.0));
    }

    #[test]
    fn ps_ifelse_picks_correct_branch() {
        let prog = parse_ps_program(b"{ dup 0.5 lt { pop 0 } { pop 1 } ifelse }").unwrap();
        let f = PdfFunction::PostScript {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 1.0],
            program: prog,
        };
        assert!(approx(f.eval(&[0.2])[0], 0.0));
        assert!(approx(f.eval(&[0.8])[0], 1.0));
    }

    #[test]
    fn ps_if_without_else() {
        let prog = parse_ps_program(b"{ dup 0.5 gt { 2 mul } if }").unwrap();
        let f = PdfFunction::PostScript {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 2.0],
            program: prog,
        };
        assert!(approx(f.eval(&[0.8])[0], 1.6));
        assert!(approx(f.eval(&[0.2])[0], 0.2));
    }

    #[test]
    fn ps_spot_to_cmyk_transform_shape() {
        // Dạng tint transform Illustrator hay xuất cho Separation 1-in 4-out.
        let prog =
            parse_ps_program(b"{ dup 0.0 mul exch dup 0.91 mul exch dup 0.76 mul exch 0.0 mul }")
                .unwrap();
        let f = PdfFunction::PostScript {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0],
            program: prog,
        };
        let out = f.eval(&[1.0]);
        assert_eq!(out.len(), 4);
        assert!(approx(out[1], 0.91), "M={}", out[1]);
        assert!(approx(out[2], 0.76), "Y={}", out[2]);
    }

    #[test]
    fn ps_roll_rotates_top_n() {
        let prog = parse_ps_program(b"{ 1 2 3 3 1 roll }").unwrap();
        let mut stack = vec![];
        exec_ps(&prog, &mut stack, 0);
        assert_eq!(stack, vec![3.0, 1.0, 2.0]);
    }

    #[test]
    fn ps_index_and_copy() {
        let prog = parse_ps_program(b"{ 10 20 30 2 index }").unwrap();
        let mut stack = vec![];
        exec_ps(&prog, &mut stack, 0);
        assert_eq!(stack, vec![10.0, 20.0, 30.0, 10.0]);

        let prog = parse_ps_program(b"{ 1 2 2 copy }").unwrap();
        let mut stack = vec![];
        exec_ps(&prog, &mut stack, 0);
        assert_eq!(stack, vec![1.0, 2.0, 1.0, 2.0]);
    }

    #[test]
    fn ps_sin_cos_use_degrees() {
        // Nếu ai đó "sửa" thành radian, gradient dùng sin sẽ sai lệch âm thầm.
        let prog = parse_ps_program(b"{ 90 sin }").unwrap();
        let mut stack = vec![];
        exec_ps(&prog, &mut stack, 0);
        assert!(approx(stack[0], 1.0));
    }

    #[test]
    fn ps_atan_returns_degrees_0_to_360() {
        let prog = parse_ps_program(b"{ -1 0 atan }").unwrap();
        let mut stack = vec![];
        exec_ps(&prog, &mut stack, 0);
        assert!(approx(stack[0], 270.0), "got {}", stack[0]);
    }

    #[test]
    fn ps_div_by_zero_does_not_panic() {
        let prog = parse_ps_program(b"{ 1 0 div }").unwrap();
        let mut stack = vec![];
        exec_ps(&prog, &mut stack, 0);
        assert!(stack[0].is_finite());
    }

    #[test]
    fn ps_comment_is_ignored() {
        let prog = parse_ps_program(b"{ % day la comment\n 2 mul }").unwrap();
        assert_eq!(prog, vec![PsOp::Num(2.0), PsOp::Mul]);
    }

    #[test]
    fn ps_unknown_operator_is_reported_not_silently_dropped() {
        // Im lặng bỏ toán tử lạ sẽ cho ra màu sai mà không ai biết.
        assert!(parse_ps_program(b"{ 1 frobnicate }").is_err());
    }

    #[test]
    fn ps_underflow_yields_zeros_instead_of_panicking() {
        let prog = parse_ps_program(b"{ add add add }").unwrap();
        let f = PdfFunction::PostScript {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 1.0],
            program: prog,
        };
        let out = f.eval(&[0.5]);
        assert_eq!(out.len(), 1);
        assert!(out[0].is_finite());
    }

    #[test]
    fn ps_output_takes_last_n_values() {
        // Spec: n giá trị CUỐI stack là output, không phải n đầu.
        let prog = parse_ps_program(b"{ pop 0.1 0.2 0.3 0.4 }").unwrap();
        let f = PdfFunction::PostScript {
            domain: vec![0.0, 1.0],
            range: vec![0.0, 1.0, 0.0, 1.0],
            program: prog,
        };
        let out = f.eval(&[1.0]);
        assert_eq!(out.len(), 2);
        assert!(approx(out[0], 0.3) && approx(out[1], 0.4), "{out:?}");
    }

    #[test]
    fn identity_function_passes_input_through() {
        let f = PdfFunction::Identity { n_out: 4 };
        let out = f.eval(&[0.3, 0.4]);
        assert_eq!(out.len(), 4);
        assert!(approx(out[0], 0.3) && approx(out[1], 0.4));
    }
}
