//! Shading lưới — kiểu 4/5 (tam giác Gouraud) và 6/7 (Coons / tensor patch).
//!
//! # Vì sao lưới phải dựng thật, không xấp xỉ
//!
//! Bốn kiểu này là cách Illustrator/InDesign xuất **gradient mesh** và mọi hiệu ứng
//! chuyển màu tự do. Chúng luôn phủ diện tích lớn, và vùng tối của chúng là chỗ TAC
//! dễ vượt ngưỡng nhất. Tô một màu trung bình thay lưới cho ra một con số nghe hợp
//! lý nhưng không liên quan gì tới lượng mực thật.
//!
//! # Cách dựng
//!
//! Tất cả bốn kiểu được quy về **một** dạng duy nhất: danh sách tam giác có màu ở ba
//! đỉnh. Kiểu 4/5 vốn đã là tam giác. Kiểu 6 (Coons) được nâng lên thành tensor
//! patch 4×4 rồi cả kiểu 6 và 7 được chia lưới thành tam giác.
//!
//! Quy về một dạng có hai cái lợi thật: vòng vẽ chỉ có một đường (nên overprint,
//! alpha, blend không thể lệch giữa các kiểu), và nội suy màu chỉ cài một lần.
//!
//! # Nội suy trong không gian **mực**, không trong không gian màu
//!
//! Màu ba đỉnh được quy sang mực **một lần cho mỗi tam giác**, rồi nội suy tuyến
//! tính theo toạ độ trọng tâm. Với `DeviceCMYK` (ánh xạ đồng nhất) đây là chính
//! xác. Với `DeviceRGB` qua ICC thì khác một chút so với nội suy trong RGB rồi mới
//! quy đổi — nhưng đổi lại là **không gọi ICC cho từng pixel**, và với một dải
//! chuyển mượt thì sai lệch nằm sâu trong dung sai. Gọi ICC theo pixel sẽ làm một
//! trang mesh mất hàng phút.

use lopdf::{Dictionary, Document};

use crate::color::PdfFunction;
use crate::error::{PpeError, PpeResult};
use crate::pdf;

/// Trần số tam giác của một shading.
///
/// Chặn file thù địch (hoặc hỏng) khai lưới khổng lồ. 400 000 tam giác đã vượt xa
/// mọi gradient mesh thật; vượt trần thì báo lỗi để trang rơi về Ghostscript.
const MAX_TRIANGLES: usize = 400_000;

/// Số ô mỗi chiều khi chia một patch Coons/tensor thành lưới.
///
/// 10×10 ô (200 tam giác) là mức mà cạnh cong của patch không còn thấy răng ở 300
/// DPI với patch cỡ thường. Tăng lên không đổi lượng mực đo được một cách đáng kể,
/// còn giảm xuống thì cạnh cong bị vát và diện tích phủ bị hụt.
const PATCH_SUBDIV: usize = 10;

/// Một tam giác của lưới, toạ độ trong **không gian shading**.
#[derive(Debug, Clone)]
pub struct MeshTriangle {
    pub p: [[f32; 2]; 3],
    /// Thành phần màu tại ba đỉnh, trong colorspace của shading.
    pub c: [Vec<f32>; 3],
}

/// Đọc dữ liệu lưới và quy về danh sách tam giác.
///
/// `n_values` là số giá trị màu mỗi đỉnh: `1` khi shading có `/Function` (đỉnh mang
/// tham số `t`), ngược lại là số kênh của colorspace.
pub fn parse_mesh(
    doc: &Document,
    dict: &Dictionary,
    shading_type: i32,
    data: &[u8],
    function: Option<&PdfFunction>,
    n_comps: usize,
) -> PpeResult<Vec<MeshTriangle>> {
    let bits_coord = int_key(doc, dict, "BitsPerCoordinate")
        .ok_or_else(|| PpeError::MalformedPdf("shading lưới thiếu BitsPerCoordinate".into()))?;
    let bits_comp = int_key(doc, dict, "BitsPerComponent")
        .ok_or_else(|| PpeError::MalformedPdf("shading lưới thiếu BitsPerComponent".into()))?;
    if !matches!(bits_coord, 1 | 2 | 4 | 8 | 12 | 16 | 24 | 32) {
        return Err(PpeError::MalformedPdf(format!(
            "BitsPerCoordinate không hợp lệ: {bits_coord}"
        )));
    }
    if !matches!(bits_comp, 1 | 2 | 4 | 8 | 12 | 16) {
        return Err(PpeError::MalformedPdf(format!(
            "BitsPerComponent không hợp lệ: {bits_comp}"
        )));
    }
    let bits_coord = bits_coord as u32;
    let bits_comp = bits_comp as u32;

    let n_values = if function.is_some() { 1 } else { n_comps };
    let decode = pdf::dict_get(doc, dict, "Decode")
        .and_then(|o| pdf::num_array(doc, o))
        .ok_or_else(|| PpeError::MalformedPdf("shading lưới thiếu /Decode".into()))?;
    if decode.len() < 4 + 2 * n_values {
        return Err(PpeError::MalformedPdf(format!(
            "/Decode cần {} phần tử, có {}",
            4 + 2 * n_values,
            decode.len()
        )));
    }

    let mut reader = BitReader::new(data);
    let ctx = MeshCtx {
        bits_coord,
        bits_comp,
        n_values,
        decode,
        function,
        n_comps,
    };

    match shading_type {
        4 => parse_free_triangles(&mut reader, &ctx, int_key(doc, dict, "BitsPerFlag")),
        5 => {
            let per_row = int_key(doc, dict, "VerticesPerRow").ok_or_else(|| {
                PpeError::MalformedPdf("shading kiểu 5 thiếu VerticesPerRow".into())
            })?;
            if per_row < 2 {
                return Err(PpeError::MalformedPdf(
                    "VerticesPerRow phải >= 2".into(),
                ));
            }
            parse_lattice(&mut reader, &ctx, per_row as usize)
        }
        6 | 7 => parse_patches(
            &mut reader,
            &ctx,
            int_key(doc, dict, "BitsPerFlag"),
            shading_type == 7,
        ),
        other => Err(PpeError::Unsupported(format!("shading kiểu {other}"))),
    }
}

struct MeshCtx<'a> {
    bits_coord: u32,
    bits_comp: u32,
    n_values: usize,
    decode: Vec<f32>,
    function: Option<&'a PdfFunction>,
    n_comps: usize,
}

impl MeshCtx<'_> {
    fn read_vertex(&self, r: &mut BitReader) -> Option<([f32; 2], Vec<f32>)> {
        let x = self.decode_value(r.read(self.bits_coord)?, self.bits_coord, 0);
        let y = self.decode_value(r.read(self.bits_coord)?, self.bits_coord, 1);
        let mut vals = Vec::with_capacity(self.n_values);
        for i in 0..self.n_values {
            let raw = r.read(self.bits_comp)?;
            vals.push(self.decode_value(raw, self.bits_comp, 2 + i));
        }
        Some(([x, y], self.to_components(vals)))
    }

    fn read_colour(&self, r: &mut BitReader) -> Option<Vec<f32>> {
        let mut vals = Vec::with_capacity(self.n_values);
        for i in 0..self.n_values {
            let raw = r.read(self.bits_comp)?;
            vals.push(self.decode_value(raw, self.bits_comp, 2 + i));
        }
        Some(self.to_components(vals))
    }

    fn read_point(&self, r: &mut BitReader) -> Option<[f32; 2]> {
        let x = self.decode_value(r.read(self.bits_coord)?, self.bits_coord, 0);
        let y = self.decode_value(r.read(self.bits_coord)?, self.bits_coord, 1);
        Some([x, y])
    }

    /// Trải giá trị nguyên về khoảng của `/Decode` (§8.9.5.2, cùng công thức ảnh).
    fn decode_value(&self, raw: u32, bits: u32, index: usize) -> f32 {
        let max = if bits >= 32 {
            u32::MAX as f32
        } else {
            ((1u64 << bits) - 1) as f32
        };
        let dmin = self.decode[index * 2];
        let dmax = self.decode[index * 2 + 1];
        if max <= 0.0 {
            return dmin;
        }
        dmin + (raw as f32) * (dmax - dmin) / max
    }

    /// Đỉnh mang `t` khi có `/Function`; quy về thành phần màu ngay tại đây.
    ///
    /// Làm ở bước đọc thay vì trong vòng vẽ: hàm màu thường là chương trình
    /// PostScript, và một lưới có hàng nghìn đỉnh chứ hàng triệu pixel.
    fn to_components(&self, vals: Vec<f32>) -> Vec<f32> {
        match self.function {
            Some(f) => {
                let mut out = f.eval(&[vals.first().copied().unwrap_or(0.0)]);
                out.resize(self.n_comps.max(1), 0.0);
                out
            }
            None => vals,
        }
    }
}

/// Kiểu 4 — lưới tam giác tự do, mỗi đỉnh có cờ nối.
fn parse_free_triangles(
    r: &mut BitReader,
    ctx: &MeshCtx,
    bits_flag: Option<i64>,
) -> PpeResult<Vec<MeshTriangle>> {
    let bits_flag = bits_flag.ok_or_else(|| {
        PpeError::MalformedPdf("shading kiểu 4 thiếu BitsPerFlag".into())
    })? as u32;
    if !matches!(bits_flag, 2 | 4 | 8) {
        return Err(PpeError::MalformedPdf(format!(
            "BitsPerFlag không hợp lệ: {bits_flag}"
        )));
    }

    let mut out: Vec<MeshTriangle> = Vec::new();
    // Ba đỉnh gần nhất, dùng cho cờ 1/2.
    let mut va: Option<([f32; 2], Vec<f32>)> = None;
    let mut vb: Option<([f32; 2], Vec<f32>)> = None;
    let mut vc: Option<([f32; 2], Vec<f32>)> = None;

    loop {
        let Some(flag) = r.read(bits_flag) else { break };
        let Some(vertex) = ctx.read_vertex(r) else { break };
        // Mỗi **đỉnh** của kiểu 4 chiếm số byte nguyên (§8.7.4.5.5).
        r.align();

        match flag {
            0 => {
                // Cờ 0 bắt đầu một tam giác mới: hai đỉnh sau cũng phải là cờ 0.
                let mut tri = [vertex, Default::default(), Default::default()];
                for slot in 1..3 {
                    if r.read(bits_flag).is_none() {
                        return finish(out);
                    }
                    let Some(v) = ctx.read_vertex(r) else {
                        return finish(out);
                    };
                    r.align();
                    tri[slot] = v;
                }
                va = Some(tri[0].clone());
                vb = Some(tri[1].clone());
                vc = Some(tri[2].clone());
                push(&mut out, &tri[0], &tri[1], &tri[2])?;
            }
            1 => {
                // (vb, vc, mới)
                let (Some(b), Some(c)) = (vb.clone(), vc.clone()) else {
                    break;
                };
                push(&mut out, &b, &c, &vertex)?;
                va = Some(b);
                vb = Some(c);
                vc = Some(vertex);
            }
            2 => {
                // (va, vc, mới)
                let (Some(a), Some(c)) = (va.clone(), vc.clone()) else {
                    break;
                };
                push(&mut out, &a, &c, &vertex)?;
                vb = Some(c);
                vc = Some(vertex);
                va = Some(a);
            }
            _ => break, // cờ lạ ⇒ dừng, phần đã đọc vẫn dùng được
        }
    }
    finish(out)
}

/// Kiểu 5 — lưới hình chữ nhật, không có cờ.
fn parse_lattice(
    r: &mut BitReader,
    ctx: &MeshCtx,
    per_row: usize,
) -> PpeResult<Vec<MeshTriangle>> {
    let mut rows: Vec<Vec<([f32; 2], Vec<f32>)>> = Vec::new();
    'outer: loop {
        let mut row = Vec::with_capacity(per_row);
        for _ in 0..per_row {
            match ctx.read_vertex(r) {
                Some(v) => row.push(v),
                None => break 'outer,
            }
        }
        rows.push(row);
        if rows.len() * per_row > MAX_TRIANGLES {
            break;
        }
    }

    let mut out = Vec::new();
    for j in 1..rows.len() {
        for i in 1..per_row {
            let a = &rows[j - 1][i - 1];
            let b = &rows[j - 1][i];
            let c = &rows[j][i - 1];
            let d = &rows[j][i];
            push(&mut out, a, b, c)?;
            push(&mut out, b, d, c)?;
        }
    }
    finish(out)
}

/// Kiểu 6/7 — Coons patch và tensor patch.
fn parse_patches(
    r: &mut BitReader,
    ctx: &MeshCtx,
    bits_flag: Option<i64>,
    tensor: bool,
) -> PpeResult<Vec<MeshTriangle>> {
    let bits_flag = bits_flag.ok_or_else(|| {
        PpeError::MalformedPdf("shading kiểu 6/7 thiếu BitsPerFlag".into())
    })? as u32;
    if !matches!(bits_flag, 2 | 4 | 8) {
        return Err(PpeError::MalformedPdf(format!(
            "BitsPerFlag không hợp lệ: {bits_flag}"
        )));
    }

    let mut out = Vec::new();
    // Lưới 4×4 điểm điều khiển của patch trước, dùng khi cờ 1/2/3 nối cạnh.
    let mut prev: Option<([[f32; 2]; 16], [Vec<f32>; 4])> = None;

    loop {
        let Some(flag) = r.read(bits_flag) else { break };
        let mut grid = [[0.0f32; 2]; 16];
        let mut colours: [Vec<f32>; 4] = Default::default();

        // Cờ khác 0: cạnh đầu và hai màu đầu lấy từ patch trước. Bỏ qua cơ chế này
        // làm mọi patch từ thứ hai trở đi bị lệch chỗ — lưới rời thành các mảnh.
        let (n_points, n_colours) = if flag == 0 { (12, 4) } else { (8, 2) };
        if flag != 0 {
            let Some((pg, pc)) = prev.clone() else { break };
            let (edge, c0, c1) = shared_edge(&pg, &pc, flag);
            grid[0] = edge[0];
            grid[1] = edge[1];
            grid[2] = edge[2];
            grid[3] = edge[3];
            colours[0] = c0;
            colours[1] = c1;
        }

        // Điểm biên còn lại, theo thứ tự đi quanh chu vi (§8.7.4.5.7).
        let mut boundary: Vec<[f32; 2]> = Vec::with_capacity(n_points);
        let mut ok = true;
        for _ in 0..n_points {
            match ctx.read_point(r) {
                Some(p) => boundary.push(p),
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            break;
        }
        // Tensor patch có thêm 4 điểm trong.
        let mut inner: Vec<[f32; 2]> = Vec::new();
        if tensor {
            for _ in 0..4 {
                match ctx.read_point(r) {
                    Some(p) => inner.push(p),
                    None => {
                        ok = false;
                        break;
                    }
                }
            }
            if !ok {
                break;
            }
        }
        for slot in (4 - n_colours)..4 {
            match ctx.read_colour(r) {
                Some(c) => colours[slot] = c,
                None => {
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            break;
        }
        r.align();

        fill_boundary(&mut grid, &boundary, flag == 0);
        if tensor && inner.len() == 4 {
            // Thứ tự điểm trong của tensor patch: p11 p12 p22 p21 (§Table 85).
            grid[5] = inner[0];
            grid[9] = inner[1];
            grid[10] = inner[2];
            grid[6] = inner[3];
        } else {
            coons_interior(&mut grid);
        }

        emit_patch(&mut out, &grid, &colours)?;
        prev = Some((grid, colours));
        if out.len() > MAX_TRIANGLES {
            break;
        }
    }
    finish(out)
}

/// Xếp các điểm biên đã đọc vào lưới 4×4.
///
/// Lưới đánh số theo hàng: `grid[row * 4 + col]`. Chu vi đi từ `grid[0]` sang phải
/// theo hàng đầu, xuống cột phải, về theo hàng cuối, rồi lên cột trái.
fn fill_boundary(grid: &mut [[f32; 2]; 16], boundary: &[[f32; 2]], full: bool) {
    // Thứ tự vị trí trên chu vi, bắt đầu sau `grid[3]` (góc phải hàng đầu).
    const AFTER_FIRST_EDGE: [usize; 8] = [7, 11, 15, 14, 13, 12, 8, 4];
    if full {
        // 12 điểm: 4 điểm hàng đầu rồi 8 điểm còn lại.
        let (head, tail) = boundary.split_at(4.min(boundary.len()));
        for (i, p) in head.iter().enumerate() {
            grid[i] = *p;
        }
        for (slot, p) in AFTER_FIRST_EDGE.iter().zip(tail.iter()) {
            grid[*slot] = *p;
        }
    } else {
        // 8 điểm: hàng đầu đã lấy từ patch trước.
        for (slot, p) in AFTER_FIRST_EDGE.iter().zip(boundary.iter()) {
            grid[*slot] = *p;
        }
    }
}

/// Cạnh và hai màu được chia sẻ từ patch trước, theo cờ 1/2/3 (§Table 85).
fn shared_edge(
    grid: &[[f32; 2]; 16],
    colours: &[Vec<f32>; 4],
    flag: u32,
) -> ([[f32; 2]; 4], Vec<f32>, Vec<f32>) {
    match flag {
        1 => (
            [grid[3], grid[7], grid[11], grid[15]],
            colours[1].clone(),
            colours[2].clone(),
        ),
        2 => (
            [grid[15], grid[14], grid[13], grid[12]],
            colours[2].clone(),
            colours[3].clone(),
        ),
        _ => (
            [grid[12], grid[8], grid[4], grid[0]],
            colours[3].clone(),
            colours[0].clone(),
        ),
    }
}

/// Bốn điểm trong của Coons patch, suy từ 12 điểm biên (§8.7.4.5.7).
///
/// Coons patch **không** khai điểm trong; mặt được định nghĩa bởi biên. Công thức
/// này chính là cách nâng nó lên thành tensor patch tương đương, nhờ đó kiểu 6 và 7
/// dùng chung một đường vẽ duy nhất.
fn coons_interior(grid: &mut [[f32; 2]; 16]) {
    // Lưới đánh số `grid[row * 4 + col]`, tức `p_{row,col}`:
    //   p00 p01 p02 p03      0  1  2  3
    //   p10 p11 p12 p13  =   4  5  6  7
    //   p20 p21 p22 p23      8  9 10 11
    //   p30 p31 p32 p33     12 13 14 15
    //
    // Bốn công thức đối xứng nhau qua phép hoán vị góc; sao chép sai một chỉ số làm
    // mặt bị vặn ở đúng một góc — rất khó thấy bằng mắt trên một dải chuyển mượt.
    for axis in 0..2 {
        let g: [f32; 16] = std::array::from_fn(|i| grid[i][axis]);
        grid[5][axis] = (-4.0 * g[0] + 6.0 * (g[1] + g[4]) - 2.0 * (g[3] + g[12])
            + 3.0 * (g[13] + g[7])
            - g[15])
            / 9.0;
        grid[6][axis] = (-4.0 * g[3] + 6.0 * (g[2] + g[7]) - 2.0 * (g[0] + g[15])
            + 3.0 * (g[14] + g[4])
            - g[12])
            / 9.0;
        grid[9][axis] = (-4.0 * g[12] + 6.0 * (g[13] + g[8]) - 2.0 * (g[15] + g[0])
            + 3.0 * (g[1] + g[11])
            - g[3])
            / 9.0;
        grid[10][axis] = (-4.0 * g[15] + 6.0 * (g[14] + g[11]) - 2.0 * (g[12] + g[3])
            + 3.0 * (g[2] + g[8])
            - g[0])
            / 9.0;
    }
}

/// Chia patch thành lưới tam giác, màu nội suy song tuyến từ bốn góc.
fn emit_patch(
    out: &mut Vec<MeshTriangle>,
    grid: &[[f32; 2]; 16],
    colours: &[Vec<f32>; 4],
) -> PpeResult<()> {
    let n = PATCH_SUBDIV;
    // Bảng điểm (n+1)² của mặt Bézier bậc ba hai chiều.
    let mut pts = vec![[0.0f32; 2]; (n + 1) * (n + 1)];
    for j in 0..=n {
        let v = j as f32 / n as f32;
        for i in 0..=n {
            let u = i as f32 / n as f32;
            pts[j * (n + 1) + i] = bezier_surface(grid, u, v);
        }
    }
    for j in 0..n {
        for i in 0..n {
            let (u0, v0) = (i as f32 / n as f32, j as f32 / n as f32);
            let (u1, v1) = ((i + 1) as f32 / n as f32, (j + 1) as f32 / n as f32);
            let a = (pts[j * (n + 1) + i], bilinear(colours, u0, v0));
            let b = (pts[j * (n + 1) + i + 1], bilinear(colours, u1, v0));
            let c = (pts[(j + 1) * (n + 1) + i], bilinear(colours, u0, v1));
            let d = (pts[(j + 1) * (n + 1) + i + 1], bilinear(colours, u1, v1));
            push(out, &a, &b, &c)?;
            push(out, &b, &d, &c)?;
        }
    }
    Ok(())
}

/// Mặt Bézier bậc ba từ lưới 4×4 điểm điều khiển.
fn bezier_surface(grid: &[[f32; 2]; 16], u: f32, v: f32) -> [f32; 2] {
    let bu = bernstein(u);
    let bv = bernstein(v);
    let mut out = [0.0f32; 2];
    for row in 0..4 {
        for col in 0..4 {
            let w = bv[row] * bu[col];
            out[0] += w * grid[row * 4 + col][0];
            out[1] += w * grid[row * 4 + col][1];
        }
    }
    out
}

fn bernstein(t: f32) -> [f32; 4] {
    let s = 1.0 - t;
    [s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t]
}

/// Màu nội suy song tuyến từ bốn góc `c0..c3` (thứ tự đi quanh chu vi).
fn bilinear(c: &[Vec<f32>; 4], u: f32, v: f32) -> Vec<f32> {
    // Góc: c0 = (u0,v0), c1 = (u1,v0), c2 = (u1,v1), c3 = (u0,v1).
    let n = c.iter().map(|x| x.len()).max().unwrap_or(0);
    let get = |k: usize, i: usize| c[k].get(i).copied().unwrap_or(0.0);
    (0..n)
        .map(|i| {
            let top = get(0, i) * (1.0 - u) + get(1, i) * u;
            let bottom = get(3, i) * (1.0 - u) + get(2, i) * u;
            top * (1.0 - v) + bottom * v
        })
        .collect()
}

type Vertex = ([f32; 2], Vec<f32>);

fn push(out: &mut Vec<MeshTriangle>, a: &Vertex, b: &Vertex, c: &Vertex) -> PpeResult<()> {
    if out.len() >= MAX_TRIANGLES {
        return Err(PpeError::Unsupported(format!(
            "shading lưới vượt trần {MAX_TRIANGLES} tam giác"
        )));
    }
    out.push(MeshTriangle {
        p: [a.0, b.0, c.0],
        c: [a.1.clone(), b.1.clone(), c.1.clone()],
    });
    Ok(())
}

/// Lưới rỗng là **mất nội dung**, không phải chuyện vô hại: dữ liệu có mà không đọc
/// ra tam giác nào nghĩa là engine hiểu sai cấu trúc.
fn finish(out: Vec<MeshTriangle>) -> PpeResult<Vec<MeshTriangle>> {
    if out.is_empty() {
        return Err(PpeError::MalformedPdf(
            "shading lưới không đọc được tam giác nào".into(),
        ));
    }
    Ok(out)
}

fn int_key(doc: &Document, dict: &Dictionary, key: &str) -> Option<i64> {
    pdf::dict_get(doc, dict, key).and_then(pdf::as_num).map(|v| v as i64)
}

/// Bộ đọc bit, tối đa 32 bit một lần.
///
/// Dữ liệu lưới là **dòng bit** liên tục: `/BitsPerCoordinate` có thể là 12 hoặc 24,
/// nên đọc theo byte là sai ngay từ đỉnh thứ hai.
struct BitReader<'a> {
    data: &'a [u8],
    bit: usize,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        BitReader { data, bit: 0 }
    }

    fn read(&mut self, bits: u32) -> Option<u32> {
        if bits == 0 || bits > 32 {
            return None;
        }
        if self.bit + bits as usize > self.data.len() * 8 {
            return None;
        }
        let mut out: u64 = 0;
        for _ in 0..bits {
            let byte = self.data[self.bit >> 3];
            let shift = 7 - (self.bit & 7);
            out = (out << 1) | ((byte >> shift) & 1) as u64;
            self.bit += 1;
        }
        Some(out as u32)
    }

    /// Nhảy tới biên byte kế tiếp.
    fn align(&mut self) {
        if self.bit % 8 != 0 {
            self.bit += 8 - (self.bit % 8);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn base_dict(shading_type: i32, n_comps: usize) -> Dictionary {
        let mut decode: Vec<lopdf::Object> = vec![0.into(), 100.into(), 0.into(), 100.into()];
        for _ in 0..n_comps {
            decode.push(0.into());
            decode.push(1.into());
        }
        dictionary! {
            "ShadingType" => shading_type,
            "BitsPerCoordinate" => 8,
            "BitsPerComponent" => 8,
            "BitsPerFlag" => 8,
            "Decode" => lopdf::Object::Array(decode),
        }
    }

    /// Một đỉnh kiểu 4: cờ, x, y, một kênh màu — mỗi đỉnh tròn byte nên 8 bit là đủ.
    fn vertex4(flag: u8, x: u8, y: u8, c: u8) -> Vec<u8> {
        vec![flag, x, y, c]
    }

    #[test]
    fn bit_reader_reads_across_byte_boundaries() {
        let data = [0b1010_1010u8, 0b1100_0011];
        let mut r = BitReader::new(&data);
        assert_eq!(r.read(4), Some(0b1010));
        assert_eq!(r.read(8), Some(0b1010_1100));
        assert_eq!(r.read(4), Some(0b0011));
        assert_eq!(r.read(1), None, "hết dữ liệu phải trả None");
    }

    #[test]
    fn bit_reader_align_moves_to_byte_boundary() {
        let data = [0xFF, 0x00, 0xFF];
        let mut r = BitReader::new(&data);
        r.read(3).unwrap();
        r.align();
        assert_eq!(r.read(8), Some(0x00));
    }

    #[test]
    fn bit_reader_rejects_oversized_reads() {
        let data = [0xFF; 8];
        let mut r = BitReader::new(&data);
        assert_eq!(r.read(0), None);
        assert_eq!(r.read(33), None);
    }

    #[test]
    fn free_form_triangle_is_parsed_with_decoded_coordinates() {
        let doc = Document::new();
        let dict = base_dict(4, 1);
        let mut data = Vec::new();
        data.extend(vertex4(0, 0, 0, 0));
        data.extend(vertex4(0, 255, 0, 128));
        data.extend(vertex4(0, 0, 255, 255));
        let tris = parse_mesh(&doc, &dict, 4, &data, None, 1).unwrap();
        assert_eq!(tris.len(), 1);
        // `/Decode` [0 100] ⇒ 255 phải thành 100.
        assert!((tris[0].p[1][0] - 100.0).abs() < 1e-3, "{:?}", tris[0].p);
        assert!((tris[0].c[2][0] - 1.0).abs() < 1e-3);
    }

    #[test]
    fn free_form_flag_one_reuses_two_previous_vertices() {
        let doc = Document::new();
        let dict = base_dict(4, 1);
        let mut data = Vec::new();
        data.extend(vertex4(0, 0, 0, 0));
        data.extend(vertex4(0, 255, 0, 0));
        data.extend(vertex4(0, 0, 255, 0));
        data.extend(vertex4(1, 255, 255, 255));
        let tris = parse_mesh(&doc, &dict, 4, &data, None, 1).unwrap();
        assert_eq!(tris.len(), 2, "cờ 1 phải tạo tam giác thứ hai");
        // Tam giác 2 = (vb, vc, mới) ⇒ đỉnh đầu là đỉnh thứ hai của tam giác 1.
        assert_eq!(tris[1].p[0], tris[0].p[1]);
        assert_eq!(tris[1].p[1], tris[0].p[2]);
    }

    #[test]
    fn free_form_flag_two_reuses_first_and_third() {
        let doc = Document::new();
        let dict = base_dict(4, 1);
        let mut data = Vec::new();
        data.extend(vertex4(0, 0, 0, 0));
        data.extend(vertex4(0, 255, 0, 0));
        data.extend(vertex4(0, 0, 255, 0));
        data.extend(vertex4(2, 255, 255, 255));
        let tris = parse_mesh(&doc, &dict, 4, &data, None, 1).unwrap();
        assert_eq!(tris.len(), 2);
        assert_eq!(tris[1].p[0], tris[0].p[0]);
        assert_eq!(tris[1].p[1], tris[0].p[2]);
    }

    #[test]
    fn lattice_mesh_builds_two_triangles_per_cell() {
        let doc = Document::new();
        let mut dict = base_dict(5, 1);
        dict.set("VerticesPerRow", 2);
        // 2 hàng × 2 đỉnh, mỗi đỉnh 3 byte (x, y, màu) — kiểu 5 không có cờ.
        let data = vec![
            0, 0, 0, //
            255, 0, 0, //
            0, 255, 0, //
            255, 255, 255,
        ];
        let tris = parse_mesh(&doc, &dict, 5, &data, None, 1).unwrap();
        assert_eq!(tris.len(), 2, "một ô lưới = hai tam giác");
    }

    #[test]
    fn lattice_requires_at_least_two_vertices_per_row() {
        let doc = Document::new();
        let mut dict = base_dict(5, 1);
        dict.set("VerticesPerRow", 1);
        assert!(parse_mesh(&doc, &dict, 5, &[0, 0, 0], None, 1).is_err());
    }

    #[test]
    fn function_based_mesh_maps_t_through_the_function() {
        // Đỉnh mang một tham số `t`; hàm biến nó thành 4 kênh CMYK.
        let doc = Document::new();
        let dict = base_dict(4, 1);
        let f = crate::color::space::resolve_function(
            &doc,
            &lopdf::Object::Dictionary(dictionary! {
                "FunctionType" => 2,
                "Domain" => vec![0.into(), 1.into()],
                "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
                "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
                "N" => 1,
                "Range" => vec![
                    0.into(), 1.into(), 0.into(), 1.into(),
                    0.into(), 1.into(), 0.into(), 1.into(),
                ],
            }),
        )
        .unwrap();
        let mut data = Vec::new();
        data.extend(vertex4(0, 0, 0, 0));
        data.extend(vertex4(0, 255, 0, 255));
        data.extend(vertex4(0, 0, 255, 255));
        let tris = parse_mesh(&doc, &dict, 4, &data, Some(&f), 4).unwrap();
        assert_eq!(tris[0].c[0].len(), 4, "phải ra 4 kênh");
        assert!(tris[0].c[0][3] < 0.01, "t=0 ⇒ K 0");
        assert!(tris[0].c[1][3] > 0.99, "t=1 ⇒ K 100%");
    }

    #[test]
    fn coons_patch_produces_a_grid_of_triangles() {
        let doc = Document::new();
        let dict = base_dict(6, 1);
        let mut data = vec![0u8]; // cờ 0
        // 12 điểm biên của một ô vuông.
        let pts: [(u8, u8); 12] = [
            (0, 0),
            (85, 0),
            (170, 0),
            (255, 0),
            (255, 85),
            (255, 170),
            (255, 255),
            (170, 255),
            (85, 255),
            (0, 255),
            (0, 170),
            (0, 85),
        ];
        for (x, y) in pts {
            data.push(x);
            data.push(y);
        }
        data.extend_from_slice(&[0, 85, 170, 255]); // 4 màu góc
        let tris = parse_mesh(&doc, &dict, 6, &data, None, 1).unwrap();
        assert_eq!(tris.len(), PATCH_SUBDIV * PATCH_SUBDIV * 2);
        // Patch phủ đúng ô vuông [0,100]² sau khi giải mã.
        let xs: Vec<f32> = tris.iter().flat_map(|t| t.p.iter().map(|p| p[0])).collect();
        let max_x = xs.iter().cloned().fold(f32::MIN, f32::max);
        assert!((max_x - 100.0).abs() < 1.0, "max_x={max_x}");
    }

    #[test]
    fn tensor_patch_reads_four_extra_points() {
        let doc = Document::new();
        let dict = base_dict(7, 1);
        let mut data = vec![0u8];
        for i in 0..16u8 {
            // 16 điểm: 12 biên + 4 trong.
            data.push(i * 16);
            data.push(i * 16);
        }
        data.extend_from_slice(&[0, 85, 170, 255]);
        let tris = parse_mesh(&doc, &dict, 7, &data, None, 1).unwrap();
        assert_eq!(tris.len(), PATCH_SUBDIV * PATCH_SUBDIV * 2);
    }

    #[test]
    fn empty_mesh_data_is_an_error_not_an_empty_page() {
        let doc = Document::new();
        let dict = base_dict(4, 1);
        assert!(parse_mesh(&doc, &dict, 4, &[], None, 1).is_err());
    }

    #[test]
    fn missing_decode_array_is_an_error() {
        let doc = Document::new();
        let mut dict = base_dict(4, 1);
        dict.remove(b"Decode");
        let data = vec![0u8; 32];
        assert!(parse_mesh(&doc, &dict, 4, &data, None, 1).is_err());
    }

    #[test]
    fn invalid_bits_per_coordinate_is_rejected() {
        let doc = Document::new();
        let mut dict = base_dict(4, 1);
        dict.set("BitsPerCoordinate", 7);
        assert!(parse_mesh(&doc, &dict, 4, &[0u8; 32], None, 1).is_err());
    }

    #[test]
    fn truncated_data_keeps_the_triangles_already_read() {
        // File cắt giữa: phần đã đọc được vẫn dùng, phần thiếu thì thôi. Trả lỗi ở
        // đây sẽ mất cả lưới vì một byte thiếu.
        let doc = Document::new();
        let dict = base_dict(4, 1);
        let mut data = Vec::new();
        data.extend(vertex4(0, 0, 0, 0));
        data.extend(vertex4(0, 255, 0, 0));
        data.extend(vertex4(0, 0, 255, 0));
        data.extend_from_slice(&[1, 255]); // đỉnh thứ 4 bị cắt giữa
        let tris = parse_mesh(&doc, &dict, 4, &data, None, 1).unwrap();
        assert_eq!(tris.len(), 1);
    }
}
