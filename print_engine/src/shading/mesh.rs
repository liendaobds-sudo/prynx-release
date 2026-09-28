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
//! Kiểu 4/5 lưu tam giác. Kiểu 6 (Coons) được nâng lên thành tensor patch 4×4;
//! kiểu 6/7 chỉ giữ điểm điều khiển và bốn màu góc, rồi dựng **từng** lưới 10×10
//! khi vẽ. Không bung cả shading thành hàng trăm nghìn tam giác trong bộ nhớ.
//!
//! # Nội suy trước hàm màu
//!
//! Thành phần trong stream được giữ nguyên: có `/Function` thì mỗi đỉnh/góc chỉ
//! mang tham số `t`. Vòng vẽ nội suy raw (trọng tâm với 4/5, song tuyến tại UV với
//! 6/7), sau đó mới áp hàm màu và đổi sang mực. Áp hàm ở đỉnh trước nội suy làm sai
//! hàm phi tuyến, còn nội suy mực trước ICC làm sai không gian màu của shading.

use lopdf::{Dictionary, Document};

use crate::cancel::CancelToken;
use crate::color::PdfFunction;
use crate::error::{PpeError, PpeResult};
use crate::geom::Matrix;
use crate::ink::DEFAULT_RENDER_MEMORY_BUDGET_BYTES;
use crate::pdf;

/// Trần số tam giác của một shading.
///
/// Giữ guard hiện có cho danh sách tam giác kiểu 4/5. Kiểu 6/7 không dùng trần
/// này: một stream nhỏ hợp lệ có thể tương ứng nhiều hơn 400 000 tam giác.
const MAX_TRIANGLES: usize = 400_000;

/// Số ô mỗi chiều khi chia một patch Coons/tensor thành lưới.
///
/// 10×10 ô (200 tam giác) là mức mà cạnh cong của patch không còn thấy răng ở 300
/// DPI với patch cỡ thường. Tăng lên không đổi lượng mực đo được một cách đáng kể,
/// còn giảm xuống thì cạnh cong bị vát và diện tích phủ bị hụt.
const PATCH_SUBDIV: usize = 10;

/// Một tam giác của lưới, toạ độ trong **không gian shading**.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MeshTriangle {
    pub p: [[f32; 2]; 3],
    /// Giá trị raw tại ba đỉnh: thành phần colorspace, hoặc `[t]` khi có hàm màu.
    pub c: [Vec<f32>; 3],
}

/// Patch gọn, chưa chia lưới hoặc áp hàm màu.
///
/// PERF (audit 2026-09-28 §KNOCK.01-C2c): không cấp 200 tam giác và 600 vector
/// màu cho mỗi patch trước khi biết vùng nào thực sự được vẽ.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MeshPatch {
    /// Điểm điều khiển theo hàng: `grid[row * 4 + col]`.
    pub grid: [[f32; 2]; 16],
    /// Raw tại góc (0,0), (1,0), (1,1), (0,1) trong hệ UV nội bộ.
    pub c: [Vec<f32>; 4],
}

/// Lưới hình học tạm của đúng một patch, nằm trên stack, không giữ màu đỉnh.
pub struct MeshPatchGrid {
    points: [[f32; 2]; (PATCH_SUBDIV + 1) * (PATCH_SUBDIV + 1)],
}

/// Tam giác lấy từ lưới patch, kèm UV để nội suy raw tại điểm thắng cuối cùng.
#[derive(Debug, Clone, Copy)]
pub struct MeshPatchTriangle {
    pub p: [[f32; 2]; 3],
    pub uv: [[f32; 2]; 3],
}

impl MeshPatch {
    /// Kiểm cả payload đọc từ PDF lẫn payload đã deserialize từ retained scene.
    pub fn validate(&self, expected_values: usize) -> PpeResult<()> {
        if expected_values == 0
            || self.grid.iter().flatten().any(|v| !v.is_finite())
            || self.c.iter().any(|corner| {
                corner.len() != expected_values || corner.iter().any(|v| !v.is_finite())
            })
        {
            return Err(PpeError::MalformedPdf(
                "patch shading có điểm/màu không hữu hạn hoặc sai số thành phần".into(),
            ));
        }
        Ok(())
    }

    /// Hộp bao bảo thủ sau CTM: mặt Bézier luôn nằm trong bao lồi control points.
    /// `None` báo dữ liệu/CTM không hữu hạn, không được hiểu là patch ngoài clip.
    pub fn control_bounds(&self, ctm: &Matrix) -> Option<[f32; 4]> {
        let mut bounds = [
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        ];
        for [x, y] in self.grid {
            let (dx, dy) = ctm.apply(x, y);
            if !dx.is_finite() || !dy.is_finite() {
                return None;
            }
            bounds[0] = bounds[0].min(dx);
            bounds[1] = bounds[1].min(dy);
            bounds[2] = bounds[2].max(dx);
            bounds[3] = bounds[3].max(dy);
        }
        Some(bounds)
    }

    /// Giữ nguyên 10×10 ô; chỉ thay thời điểm cấp phát, không giảm chất lượng.
    pub fn tessellate(&self) -> MeshPatchGrid {
        MeshPatchGrid {
            points: std::array::from_fn(|index| {
                let u = (index % (PATCH_SUBDIV + 1)) as f32 / PATCH_SUBDIV as f32;
                let v = (index / (PATCH_SUBDIV + 1)) as f32 / PATCH_SUBDIV as f32;
                bezier_surface(&self.grid, u, v)
            }),
        }
    }

    /// Nội suy raw song tuyến; caller áp `/Function` và chuyển colorspace sau đây.
    /// UV được kẹp để sai số nhỏ ở cạnh tam giác không ngoại suy qua biên patch.
    pub fn sample_raw_into(&self, u: f32, v: f32, out: &mut Vec<f32>) -> PpeResult<()> {
        out.clear();
        self.validate(self.c[0].len())?;
        self.sample_raw_into_validated(u, v, out)
    }

    /// Đường nóng sau khi caller đã `validate` toàn patch trước raster. Vẫn kiểm
    /// kích thước và kết quả nhưng không quét lại 16 điểm + mọi màu mỗi pixel.
    pub(crate) fn sample_raw_into_validated(
        &self,
        u: f32,
        v: f32,
        out: &mut Vec<f32>,
    ) -> PpeResult<()> {
        out.clear();
        let n = self.c[0].len();
        if !u.is_finite()
            || !v.is_finite()
            || n == 0
            || self.c.iter().any(|corner| corner.len() != n)
        {
            return Err(PpeError::MalformedPdf(
                "không nội suy được patch shading có UV/màu không hợp lệ".into(),
            ));
        }
        out.try_reserve(n).map_err(|_| {
            PpeError::Unsupported("không đủ bộ nhớ nội suy màu patch shading".into())
        })?;
        // Dùng f64 ở tổng có trọng số để cả khoảng raw hữu hạn rất lớn cũng
        // không tràn trung gian. Kết quả vẫn nằm trong bao lồi bốn giá trị góc.
        let (u, v) = (u.clamp(0.0, 1.0) as f64, v.clamp(0.0, 1.0) as f64);
        for i in 0..n {
            let top = self.c[0][i] as f64 * (1.0 - u) + self.c[1][i] as f64 * u;
            let bottom = self.c[3][i] as f64 * (1.0 - u) + self.c[2][i] as f64 * u;
            let value = (top * (1.0 - v) + bottom * v) as f32;
            if !value.is_finite() {
                out.clear();
                return Err(PpeError::MalformedPdf(
                    "màu patch shading không hữu hạn".into(),
                ));
            }
            out.push(value);
        }
        Ok(())
    }

    /// Dung lượng bản thân patch và capacity các vector màu, để caller tính budget.
    pub fn estimated_bytes(&self) -> usize {
        self.c
            .iter()
            .fold(std::mem::size_of::<Self>(), |total, corner| {
                total.saturating_add(corner.capacity().saturating_mul(std::mem::size_of::<f32>()))
            })
    }
}

impl MeshPatchGrid {
    /// Không cấp phát mỗi tam giác. Patch sau thắng patch trước; nếu một patch tự
    /// gập, caller chọn UV lớn nhất theo **u rồi v nội bộ** (v rồi u trong PDF).
    pub fn triangles(&self) -> impl Iterator<Item = MeshPatchTriangle> + '_ {
        (0..PATCH_SUBDIV * PATCH_SUBDIV * 2).map(|index| {
            let cell = index / 2;
            let i = cell % PATCH_SUBDIV;
            let j = cell / PATCH_SUBDIV;
            let row = j * (PATCH_SUBDIV + 1);
            let next_row = (j + 1) * (PATCH_SUBDIV + 1);
            let (u0, v0) = (
                i as f32 / PATCH_SUBDIV as f32,
                j as f32 / PATCH_SUBDIV as f32,
            );
            let (u1, v1) = (
                (i + 1) as f32 / PATCH_SUBDIV as f32,
                (j + 1) as f32 / PATCH_SUBDIV as f32,
            );
            if index % 2 == 0 {
                MeshPatchTriangle {
                    p: [
                        self.points[row + i],
                        self.points[row + i + 1],
                        self.points[next_row + i],
                    ],
                    uv: [[u0, v0], [u1, v0], [u0, v1]],
                }
            } else {
                MeshPatchTriangle {
                    p: [
                        self.points[row + i + 1],
                        self.points[next_row + i + 1],
                        self.points[next_row + i],
                    ],
                    uv: [[u1, v0], [u1, v1], [u0, v1]],
                }
            }
        })
    }
}

/// Đọc dữ liệu lưới kiểu 4/5 thành danh sách tam giác, giữ nguyên thành phần raw.
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
    parse_mesh_bounded(
        doc,
        dict,
        shading_type,
        data,
        function,
        n_comps,
        DEFAULT_RENDER_MEMORY_BUDGET_BYTES,
        None,
    )
}

/// Ngân sách gồm slice stream đang sống và các Vec do parser tạo; caller có
/// buffer raster phải truyền số byte còn lại của cùng lần render.
#[allow(clippy::too_many_arguments)]
pub fn parse_mesh_bounded(
    doc: &Document,
    dict: &Dictionary,
    shading_type: i32,
    data: &[u8],
    function: Option<&PdfFunction>,
    n_comps: usize,
    memory_budget_bytes: usize,
    cancel: Option<&CancelToken>,
) -> PpeResult<Vec<MeshTriangle>> {
    let mut budget = MeshParseBudget::new(memory_budget_bytes, data.len(), cancel)?;
    let ctx = MeshCtx::from_dict(doc, dict, function.is_some(), n_comps, &mut budget)?;
    let mut reader = BitReader::new(data);
    match shading_type {
        4 => parse_free_triangles(
            &mut reader,
            &ctx,
            int_key(doc, dict, "BitsPerFlag"),
            &mut budget,
        ),
        5 => {
            let per_row = int_key(doc, dict, "VerticesPerRow").ok_or_else(|| {
                PpeError::MalformedPdf("shading kiểu 5 thiếu VerticesPerRow".into())
            })?;
            if per_row < 2 {
                return Err(PpeError::MalformedPdf("VerticesPerRow phải >= 2".into()));
            }
            parse_lattice(&mut reader, &ctx, per_row as usize, &mut budget)
        }
        other => Err(PpeError::Unsupported(format!(
            "shading tam giác kiểu {other}"
        ))),
    }
}

/// Đọc kiểu 6/7 thành patch gọn; số patch chỉ tăng sau khi đọc đủ một record.
pub fn parse_patch_mesh(
    doc: &Document,
    dict: &Dictionary,
    shading_type: i32,
    data: &[u8],
    function: Option<&PdfFunction>,
    n_comps: usize,
) -> PpeResult<Vec<MeshPatch>> {
    parse_patch_mesh_bounded(
        doc,
        dict,
        shading_type,
        data,
        function,
        n_comps,
        DEFAULT_RENDER_MEMORY_BUDGET_BYTES,
        None,
    )
}

/// Bản có ngân sách/hủy cho đường render; không áp trần số patch cố định.
#[allow(clippy::too_many_arguments)]
pub fn parse_patch_mesh_bounded(
    doc: &Document,
    dict: &Dictionary,
    shading_type: i32,
    data: &[u8],
    function: Option<&PdfFunction>,
    n_comps: usize,
    memory_budget_bytes: usize,
    cancel: Option<&CancelToken>,
) -> PpeResult<Vec<MeshPatch>> {
    let mut budget = MeshParseBudget::new(memory_budget_bytes, data.len(), cancel)?;
    if !matches!(shading_type, 6 | 7) {
        return Err(PpeError::Unsupported(format!(
            "shading patch kiểu {shading_type}"
        )));
    }
    let ctx = MeshCtx::from_dict(doc, dict, function.is_some(), n_comps, &mut budget)?;
    parse_patches(
        &mut BitReader::new(data),
        &ctx,
        int_key(doc, dict, "BitsPerFlag"),
        shading_type == 7,
        &mut budget,
    )
}

/// MEMORY (audit 2026-09-28 §KNOCK.01-C2c): kiểm trước allocator, tính capacity
/// thật cả Vec ngoài lẫn màu bên trong. Đây là ngân sách request, không phải cap
/// phần cứng hoặc chất lượng mới. Mọi tài nguyên sống cùng parser được cộng dồn.
struct MeshParseBudget<'a> {
    used: usize,
    limit: usize,
    cancel: Option<&'a CancelToken>,
}

impl<'a> MeshParseBudget<'a> {
    fn new(limit: usize, stream_bytes: usize, cancel: Option<&'a CancelToken>) -> PpeResult<Self> {
        let mut budget = Self {
            used: 0,
            limit,
            cancel,
        };
        budget.check_cancelled()?;
        budget.add(stream_bytes)?;
        Ok(budget)
    }

    fn check_cancelled(&self) -> PpeResult<()> {
        self.cancel.map_or(Ok(()), CancelToken::check)
    }

    fn error(&self, additional: usize) -> PpeError {
        const MIB: usize = 1024 * 1024;
        PpeError::MemoryBudgetExceeded {
            requested_mib: self.used.saturating_add(additional).saturating_add(MIB - 1) / MIB,
            limit_mib: self.limit.saturating_add(MIB - 1) / MIB,
        }
    }

    fn add(&mut self, bytes: usize) -> PpeResult<()> {
        let requested = self
            .used
            .checked_add(bytes)
            .ok_or_else(|| self.error(usize::MAX))?;
        if requested > self.limit {
            return Err(self.error(bytes));
        }
        self.used = requested;
        Ok(())
    }

    fn release(&mut self, bytes: usize) {
        debug_assert!(bytes <= self.used);
        self.used = self.used.saturating_sub(bytes);
    }

    fn reserve_exact<T>(&mut self, values: &mut Vec<T>, capacity: usize) -> PpeResult<()> {
        self.check_cancelled()?;
        let old_capacity = values.capacity();
        if capacity <= old_capacity {
            return Ok(());
        }
        let bytes = (capacity - old_capacity)
            .checked_mul(std::mem::size_of::<T>())
            .ok_or_else(|| self.error(usize::MAX))?;
        // Reserve trước; mọi đường lỗi kết thúc parser nên không giữ lease giả.
        self.add(bytes)?;
        values
            .try_reserve_exact(capacity - values.len())
            .map_err(|_| self.error(0))?;
        // Vec được phép trả capacity lớn hơn yêu cầu; vẫn tính phần thực tế đó.
        self.add(
            (values.capacity() - capacity)
                .checked_mul(std::mem::size_of::<T>())
                .ok_or_else(|| self.error(usize::MAX))?,
        )?;
        Ok(())
    }

    fn reserve_one<T>(&mut self, values: &mut Vec<T>) -> PpeResult<()> {
        if values.len() < values.capacity() {
            return self.check_cancelled();
        }
        let item_bytes = std::mem::size_of::<T>();
        if item_bytes == 0 {
            return self.check_cancelled();
        }
        let available_items = (self.limit - self.used) / item_bytes;
        if available_items == 0 {
            return Err(self.error(item_bytes));
        }
        // Tăng theo cấp số nhân khi còn RAM; gần budget chỉ xin phần còn đủ,
        // tránh từ chối một record hợp lệ chỉ vì capacity dư của chiến lược grow.
        let capacity = values
            .capacity()
            .checked_mul(2)
            .unwrap_or(usize::MAX)
            .max(1)
            .min(values.capacity().saturating_add(available_items));
        self.reserve_exact(values, capacity)
    }

    fn clone_values(&mut self, source: &[f32]) -> PpeResult<Vec<f32>> {
        let mut values = Vec::new();
        self.reserve_exact(&mut values, source.len())?;
        values.extend_from_slice(source);
        Ok(values)
    }
}

struct MeshCtx {
    bits_coord: u32,
    bits_comp: u32,
    n_values: usize,
    decode: Vec<f32>,
}

impl MeshCtx {
    fn from_dict(
        doc: &Document,
        dict: &Dictionary,
        has_function: bool,
        n_comps: usize,
        budget: &mut MeshParseBudget<'_>,
    ) -> PpeResult<Self> {
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

        let n_values = if has_function { 1 } else { n_comps };
        let decode_items = pdf::dict_get(doc, dict, "Decode")
            .and_then(|o| o.as_array().ok())
            .ok_or_else(|| PpeError::MalformedPdf("shading lưới thiếu /Decode".into()))?;
        let required_decode = n_values
            .checked_mul(2)
            .and_then(|n| n.checked_add(4))
            .filter(|_| n_values > 0)
            .ok_or_else(|| {
                PpeError::MalformedPdf("số thành phần shading lưới không hợp lệ".into())
            })?;
        if decode_items.len() < required_decode {
            return Err(PpeError::MalformedPdf(format!(
                "/Decode cần {} phần tử, có {}",
                required_decode,
                decode_items.len()
            )));
        }
        let mut decode = Vec::new();
        budget.reserve_exact(&mut decode, required_decode)?;
        for item in &decode_items[..required_decode] {
            budget.check_cancelled()?;
            decode.push(pdf::num(doc, item).ok_or_else(|| {
                PpeError::MalformedPdf("/Decode shading lưới chứa giá trị không phải số".into())
            })?);
        }
        if decode[..required_decode].iter().any(|v| !v.is_finite()) {
            return Err(PpeError::MalformedPdf(
                "/Decode shading lưới không hữu hạn".into(),
            ));
        }
        Ok(Self {
            bits_coord,
            bits_comp,
            n_values,
            decode,
        })
    }
    fn vertex_bits(&self) -> Option<usize> {
        self.n_values
            .checked_mul(self.bits_comp as usize)
            .and_then(|bits| bits.checked_add(2 * self.bits_coord as usize))
    }

    fn read_vertex(
        &self,
        r: &mut BitReader,
        budget: &mut MeshParseBudget<'_>,
    ) -> PpeResult<Option<Vertex>> {
        budget.check_cancelled()?;
        let bits = self.vertex_bits().ok_or_else(|| budget.error(usize::MAX))?;
        if bits > r.remaining_bits() {
            return Ok(None);
        }
        let point = self
            .read_point(r)
            .ok_or_else(|| PpeError::MalformedPdf("thiếu tọa độ đỉnh shading lưới".into()))?;
        Ok(self.read_colour(r, budget)?.map(|colour| (point, colour)))
    }

    fn read_colour(
        &self,
        r: &mut BitReader,
        budget: &mut MeshParseBudget<'_>,
    ) -> PpeResult<Option<Vec<f32>>> {
        // Không dùng số kênh khai báo để cấp phát trước khi bitstream chứng minh
        // rằng thật sự còn đủ payload màu cho record này.
        if self.n_values > r.remaining_bits() / self.bits_comp as usize {
            return Ok(None);
        }
        let mut vals = Vec::new();
        budget.reserve_exact(&mut vals, self.n_values)?;
        for i in 0..self.n_values {
            budget.check_cancelled()?;
            let raw = r
                .read(self.bits_comp)
                .ok_or_else(|| PpeError::MalformedPdf("thiếu màu đỉnh shading lưới".into()))?;
            vals.push(self.decode_value(raw, self.bits_comp, 2 + i));
        }
        Ok(Some(vals))
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
}

/// Kiểu 4 — lưới tam giác tự do, mỗi đỉnh có cờ nối.
fn parse_free_triangles(
    r: &mut BitReader,
    ctx: &MeshCtx,
    bits_flag: Option<i64>,
    budget: &mut MeshParseBudget<'_>,
) -> PpeResult<Vec<MeshTriangle>> {
    let bits_flag = bits_flag
        .ok_or_else(|| PpeError::MalformedPdf("shading kiểu 4 thiếu BitsPerFlag".into()))?
        as u32;
    if !matches!(bits_flag, 2 | 4 | 8) {
        return Err(PpeError::MalformedPdf(format!(
            "BitsPerFlag không hợp lệ: {bits_flag}"
        )));
    }

    let mut out: Vec<MeshTriangle> = Vec::new();

    loop {
        budget.check_cancelled()?;
        let Some(flag) = r.read(bits_flag) else { break };
        let Some(vertex) = ctx.read_vertex(r, budget)? else {
            break;
        };
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
                    let Some(v) = ctx.read_vertex(r, budget)? else {
                        return finish(out);
                    };
                    r.align();
                    tri[slot] = v;
                }
                push_owned(&mut out, tri, budget)?;
            }
            1 | 2 => {
                // Cờ 1: (vb,vc,mới); cờ 2: (va,vc,mới). Giữ tam giác trước
                // trong `out`, không tạo thêm ba bản copy trạng thái ngoài budget.
                let Some(prev) = out.last() else {
                    break;
                };
                let first = if flag == 1 { 1 } else { 0 };
                let a = (prev.p[first], budget.clone_values(&prev.c[first])?);
                let b = (prev.p[2], budget.clone_values(&prev.c[2])?);
                push_owned(&mut out, [a, b, vertex], budget)?;
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
    budget: &mut MeshParseBudget<'_>,
) -> PpeResult<Vec<MeshTriangle>> {
    let row_bits = ctx
        .vertex_bits()
        .and_then(|n| n.checked_mul(per_row))
        .ok_or_else(|| budget.error(usize::MAX))?;
    let mut prev: Vec<Vertex> = Vec::new();
    let mut out = Vec::new();
    // Chỉ giữ hai hàng nguồn, vẫn tạo đúng các tam giác như cách giữ toàn lưới.
    // VerticesPerRow không được phép gây cấp phát khi stream không có đủ hàng.
    while row_bits <= r.remaining_bits() {
        budget.check_cancelled()?;
        let mut row: Vec<Vertex> = Vec::new();
        budget.reserve_exact(&mut row, per_row)?;
        for _ in 0..per_row {
            row.push(ctx.read_vertex(r, budget)?.ok_or_else(|| {
                PpeError::MalformedPdf("thiếu đỉnh trong hàng shading kiểu 5".into())
            })?);
        }
        if !prev.is_empty() {
            for i in 1..per_row {
                budget.check_cancelled()?;
                push(&mut out, &prev[i - 1], &prev[i], &row[i - 1], budget)?;
                push(&mut out, &prev[i], &row[i], &row[i - 1], budget)?;
            }
        }
        let mut released = prev
            .capacity()
            .saturating_mul(std::mem::size_of::<Vertex>());
        for vertex in &prev {
            released = released.saturating_add(
                vertex
                    .1
                    .capacity()
                    .saturating_mul(std::mem::size_of::<f32>()),
            );
        }
        budget.release(released);
        prev = row;
    }
    finish(out)
}

/// Kiểu 6/7 — Coons patch và tensor patch.
fn parse_patches(
    r: &mut BitReader,
    ctx: &MeshCtx,
    bits_flag: Option<i64>,
    tensor: bool,
    budget: &mut MeshParseBudget<'_>,
) -> PpeResult<Vec<MeshPatch>> {
    let bits_flag = bits_flag
        .ok_or_else(|| PpeError::MalformedPdf("shading kiểu 6/7 thiếu BitsPerFlag".into()))?
        as u32;
    if !matches!(bits_flag, 2 | 4 | 8) {
        return Err(PpeError::MalformedPdf(format!(
            "BitsPerFlag không hợp lệ: {bits_flag}"
        )));
    }

    let mut out: Vec<MeshPatch> = Vec::new();

    loop {
        budget.check_cancelled()?;
        let Some(flag) = r.read(bits_flag) else { break };
        if flag > 3 || (flag != 0 && out.is_empty()) {
            return Err(PpeError::MalformedPdf(format!(
                "cờ nối patch shading không hợp lệ: {flag}"
            )));
        }
        let mut grid = [[0.0f32; 2]; 16];
        let mut colours: [Vec<f32>; 4] = Default::default();

        // Cờ khác 0: cạnh đầu và hai màu đầu lấy từ patch trước. Bỏ qua cơ chế này
        // làm mọi patch từ thứ hai trở đi bị lệch chỗ — lưới rời thành các mảnh.
        let (n_points, n_colours): (usize, usize) = if flag == 0 { (12, 4) } else { (8, 2) };
        // PERF (audit 2026-09-28 §KNOCK.01-C2c): số kênh/flag không đủ chứng minh
        // cần cấp phát. Kiểm payload còn lại trước cả clone hai màu nối cạnh.
        let coord_bits = (n_points + if tensor { 4 } else { 0 }) * 2 * ctx.bits_coord as usize;
        let colour_bits = ctx
            .n_values
            .checked_mul(n_colours)
            .and_then(|n| n.checked_mul(ctx.bits_comp as usize));
        let record_bits = colour_bits
            .and_then(|n| n.checked_add(coord_bits))
            .ok_or_else(|| PpeError::MalformedPdf("record patch shading quá lớn".into()))?;
        if record_bits > r.remaining_bits() {
            return Err(PpeError::MalformedPdf(
                "stream patch shading bị cắt giữa record".into(),
            ));
        }
        if flag != 0 {
            let prev = out.last().expect("cờ nối đã kiểm tra có patch trước");
            let (edge, c0, c1) = shared_edge(&prev.grid, &prev.c, flag);
            grid[0] = edge[0];
            grid[1] = edge[1];
            grid[2] = edge[2];
            grid[3] = edge[3];
            colours[0] = budget.clone_values(c0)?;
            colours[1] = budget.clone_values(c1)?;
        }

        // Điểm biên còn lại, theo thứ tự đi quanh chu vi (§8.7.4.5.7).
        let mut boundary = [[0.0; 2]; 12];
        for point in &mut boundary[..n_points] {
            *point = ctx
                .read_point(r)
                .ok_or_else(|| PpeError::MalformedPdf("thiếu điểm biên patch shading".into()))?;
        }
        // Tensor patch có thêm 4 điểm trong.
        let mut inner = [[0.0; 2]; 4];
        if tensor {
            for point in &mut inner {
                *point = ctx.read_point(r).ok_or_else(|| {
                    PpeError::MalformedPdf("thiếu điểm trong tensor patch".into())
                })?;
            }
        }
        for colour in &mut colours[(4 - n_colours)..4] {
            *colour = ctx
                .read_colour(r, budget)?
                .ok_or_else(|| PpeError::MalformedPdf("thiếu dữ liệu màu patch shading".into()))?;
        }
        r.align();

        fill_boundary(&mut grid, &boundary[..n_points], flag == 0);
        if tensor {
            // CORRECTNESS (audit 2026-09-28 §KNOCK.01-C2c): ISO Table86 đưa
            // p11 p12 p22 p21 vào row-major [5,6,10,9], không đảo p12/p21.
            grid[5] = inner[0];
            grid[6] = inner[1];
            grid[10] = inner[2];
            grid[9] = inner[3];
        } else {
            coons_interior(&mut grid);
        }

        let patch = MeshPatch { grid, c: colours };
        patch.validate(ctx.n_values)?;
        budget.reserve_one(&mut out)?;
        out.push(patch);
    }
    if out.is_empty() {
        return Err(PpeError::MalformedPdf(
            "shading lưới không đọc được patch nào".into(),
        ));
    }
    Ok(out)
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
fn shared_edge<'a>(
    grid: &[[f32; 2]; 16],
    colours: &'a [Vec<f32>; 4],
    flag: u32,
) -> ([[f32; 2]; 4], &'a [f32], &'a [f32]) {
    match flag {
        1 => (
            [grid[3], grid[7], grid[11], grid[15]],
            &colours[1],
            &colours[2],
        ),
        2 => (
            [grid[15], grid[14], grid[13], grid[12]],
            &colours[2],
            &colours[3],
        ),
        _ => (
            [grid[12], grid[8], grid[4], grid[0]],
            &colours[3],
            &colours[0],
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

type Vertex = ([f32; 2], Vec<f32>);

fn push(
    out: &mut Vec<MeshTriangle>,
    a: &Vertex,
    b: &Vertex,
    c: &Vertex,
    budget: &mut MeshParseBudget<'_>,
) -> PpeResult<()> {
    let vertices = [
        (a.0, budget.clone_values(&a.1)?),
        (b.0, budget.clone_values(&b.1)?),
        (c.0, budget.clone_values(&c.1)?),
    ];
    push_owned(out, vertices, budget)
}

fn push_owned(
    out: &mut Vec<MeshTriangle>,
    vertices: [Vertex; 3],
    budget: &mut MeshParseBudget<'_>,
) -> PpeResult<()> {
    if out.len() >= MAX_TRIANGLES {
        return Err(PpeError::Unsupported(format!(
            "shading lưới vượt trần {MAX_TRIANGLES} tam giác"
        )));
    }
    budget.reserve_one(out)?;
    let [a, b, c] = vertices;
    out.push(MeshTriangle {
        p: [a.0, b.0, c.0],
        c: [a.1, b.1, c.1],
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
    pdf::dict_get(doc, dict, key)
        .and_then(pdf::as_num)
        .map(|v| v as i64)
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
        if bits as usize > self.remaining_bits() {
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

    fn remaining_bits(&self) -> usize {
        self.data.len().saturating_mul(8).saturating_sub(self.bit)
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
    fn function_based_mesh_preserves_raw_t_until_after_interpolation() {
        // Đỉnh phải giữ một tham số `t`; t² chỉ được tính sau nội suy.
        let doc = Document::new();
        let dict = base_dict(4, 1);
        let f = crate::color::space::resolve_function(
            &doc,
            &lopdf::Object::Dictionary(dictionary! {
                "FunctionType" => 2,
                "Domain" => vec![0.into(), 1.into()],
                "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
                "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
                "N" => 2,
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
        assert_eq!(tris[0].c, [vec![0.0], vec![1.0], vec![1.0]]);
        let raw = (tris[0].c[0][0] + tris[0].c[1][0]) * 0.5;
        assert!((f.eval(&[raw])[3] - 0.25).abs() < 1e-6);
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
        let patches = parse_patch_mesh(&doc, &dict, 6, &data, None, 1).unwrap();
        assert_eq!(patches.len(), 1);
        let grid = patches[0].tessellate();
        let tris: Vec<_> = grid.triangles().collect();
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
        let patches = parse_patch_mesh(&doc, &dict, 7, &data, None, 1).unwrap();
        assert_eq!(patches.len(), 1);
        assert_eq!(
            patches[0].tessellate().triangles().count(),
            PATCH_SUBDIV * PATCH_SUBDIV * 2
        );
    }

    fn square_patch_record(tensor: bool, flag: u8) -> Vec<u8> {
        let boundary = [
            [0, 0],
            [85, 0],
            [170, 0],
            [255, 0],
            [255, 85],
            [255, 170],
            [255, 255],
            [170, 255],
            [85, 255],
            [0, 255],
            [0, 170],
            [0, 85],
        ];
        let mut data = vec![flag];
        for point in &boundary[if flag == 0 { 0 } else { 4 }..] {
            data.extend_from_slice(point);
        }
        if tensor {
            // Table86: p11, p12, p22, p21; row-major phải là 5,6,10,9.
            data.extend_from_slice(&[85, 85, 170, 85, 170, 170, 85, 170]);
        }
        data.extend_from_slice(if flag == 0 {
            &[0, 85, 170, 255]
        } else {
            &[85, 170]
        });
        data
    }

    #[test]
    fn tensor_off_diagonal_uses_table_86_inner_point_order() {
        let doc = Document::new();
        let patches = parse_patch_mesh(
            &doc,
            &base_dict(7, 1),
            7,
            &square_patch_record(true, 0),
            None,
            1,
        )
        .unwrap();
        let p = bezier_surface(&patches[0].grid, 0.75, 0.25);
        // Oracle của mặt phẳng, không lấy lại dữ liệu tam giác để làm expected.
        assert!((p[0] - 75.0).abs() < 1e-4, "x={}", p[0]);
        assert!((p[1] - 25.0).abs() < 1e-4, "y={}", p[1]);
        for triangle in patches[0].tessellate().triangles() {
            for (point, uv) in triangle.p.iter().zip(triangle.uv) {
                assert!((point[0] - uv[0] * 100.0).abs() < 1e-4);
                assert!((point[1] - uv[1] * 100.0).abs() < 1e-4);
            }
        }
    }

    #[test]
    fn compact_patch_stream_exceeds_old_expanded_triangle_guard_without_quality_loss() {
        let doc = Document::new();
        for shading_type in [6, 7] {
            let data = square_patch_record(shading_type == 7, 0).repeat(2001);
            let patches = parse_patch_mesh(
                &doc,
                &base_dict(shading_type, 1),
                shading_type,
                &data,
                None,
                1,
            )
            .unwrap();
            assert_eq!(patches.len(), 2001);
            assert!(patches.len() * PATCH_SUBDIV * PATCH_SUBDIV * 2 > MAX_TRIANGLES);
            assert_eq!(
                patches.last().unwrap().tessellate().triangles().count(),
                200
            );
            assert_eq!(
                std::mem::size_of::<MeshPatchGrid>(),
                121 * 2 * std::mem::size_of::<f32>()
            );
            assert!(patches[0].estimated_bytes() < 2 * std::mem::size_of::<MeshTriangle>() * 200);
        }
    }

    #[test]
    fn patch_continuation_flags_reuse_the_correct_edge_and_raw_colours() {
        let doc = Document::new();
        let expected_edges = [
            [
                [100.0, 0.0],
                [100.0, 100.0 / 3.0],
                [100.0, 200.0 / 3.0],
                [100.0, 100.0],
            ],
            [
                [100.0, 100.0],
                [200.0 / 3.0, 100.0],
                [100.0 / 3.0, 100.0],
                [0.0, 100.0],
            ],
            [
                [0.0, 100.0],
                [0.0, 200.0 / 3.0],
                [0.0, 100.0 / 3.0],
                [0.0, 0.0],
            ],
        ];
        let expected_colours = [[1.0 / 3.0, 2.0 / 3.0], [2.0 / 3.0, 1.0], [1.0, 0.0]];
        for shading_type in [6, 7] {
            for flag in 1..=3 {
                let mut data = square_patch_record(shading_type == 7, 0);
                data.extend(square_patch_record(shading_type == 7, flag));
                let patches = parse_patch_mesh(
                    &doc,
                    &base_dict(shading_type, 1),
                    shading_type,
                    &data,
                    None,
                    1,
                )
                .unwrap();
                assert_eq!(patches.len(), 2);
                for (actual, expected) in patches[1].grid[..4]
                    .iter()
                    .zip(expected_edges[flag as usize - 1])
                {
                    assert!((actual[0] - expected[0]).abs() < 1e-4);
                    assert!((actual[1] - expected[1]).abs() < 1e-4);
                }
                for i in 0..2 {
                    assert!(
                        (patches[1].c[i][0] - expected_colours[flag as usize - 1][i]).abs() < 1e-6
                    );
                }
            }
        }
    }

    #[test]
    fn bilinear_raw_sample_preserves_cross_term_and_reuses_output_storage() {
        let patch = MeshPatch {
            grid: [[0.0, 0.0]; 16],
            c: [
                vec![0.0, 0.0],
                vec![0.0, 1.0],
                vec![1.0, 1.0],
                vec![0.0, 0.0],
            ],
        };
        let mut raw = Vec::with_capacity(2);
        let allocation = raw.as_ptr();
        patch.sample_raw_into(0.25, 0.75, &mut raw).unwrap();
        assert_eq!(raw, vec![0.1875, 0.25], "raw[0]=u*v, raw[1]=u");
        assert_eq!(raw.as_ptr(), allocation);
        patch
            .sample_raw_into_validated(1.00001, -0.00001, &mut raw)
            .unwrap();
        assert_eq!(raw, vec![0.0, 1.0], "UV cạnh phải được kẹp");
    }

    #[test]
    fn patch_function_input_stays_raw_for_nonlinear_evaluation() {
        let doc = Document::new();
        let function = crate::color::space::resolve_function(
            &doc,
            &lopdf::Object::Dictionary(dictionary! {
                "FunctionType" => 2, "Domain" => vec![0.into(), 1.into()],
                "C0" => vec![0.into()], "C1" => vec![1.into()], "N" => 2,
            }),
        )
        .unwrap();
        let patches = parse_patch_mesh(
            &doc,
            &base_dict(7, 1),
            7,
            &square_patch_record(true, 0),
            Some(&function),
            1,
        )
        .unwrap();
        assert!((patches[0].c[1][0] - 1.0 / 3.0).abs() < 1e-6);
        let mut raw = Vec::new();
        patches[0].sample_raw_into(0.5, 0.5, &mut raw).unwrap();
        assert!((raw[0] - 0.5).abs() < 1e-6);
        assert!((function.eval(&raw)[0] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn patch_control_bounds_conservatively_cover_affine_transformed_surface() {
        let doc = Document::new();
        let mut patch = parse_patch_mesh(
            &doc,
            &base_dict(7, 1),
            7,
            &square_patch_record(true, 0),
            None,
            1,
        )
        .unwrap()
        .remove(0);
        patch.grid[5] = [-25.0, 150.0];
        let ctm = Matrix::new(0.0, 2.0, -3.0, 0.0, 10.0, 20.0);
        let bounds = patch.control_bounds(&ctm).unwrap();
        assert_eq!(bounds, [-440.0, -30.0, 10.0, 220.0]);
        for triangle in patch.tessellate().triangles() {
            for point in triangle.p {
                let (x, y) = ctm.apply(point[0], point[1]);
                assert!(x >= bounds[0] - 1e-4 && x <= bounds[2] + 1e-4);
                assert!(y >= bounds[1] - 1e-4 && y <= bounds[3] + 1e-4);
            }
        }
        assert!(patch
            .control_bounds(&Matrix::new(f32::NAN, 0.0, 0.0, 1.0, 0.0, 0.0))
            .is_none());
    }

    #[test]
    fn patch_validation_rejects_malformed_deserialized_values_without_panicking() {
        let patch = MeshPatch {
            grid: [[0.0, 0.0]; 16],
            c: std::array::from_fn(|_| vec![0.5]),
        };
        let mut json = serde_json::to_value(&patch).unwrap();
        let mut restored: MeshPatch = serde_json::from_value(json.clone()).unwrap();
        restored.validate(1).unwrap();
        json["c"][2] = serde_json::json!([]);
        restored = serde_json::from_value(json).unwrap();
        assert!(restored.validate(1).is_err());
        let mut raw = vec![99.0];
        assert!(restored.sample_raw_into(0.5, 0.5, &mut raw).is_err());
        assert!(raw.is_empty());
        restored.c[2] = vec![f32::NAN];
        assert!(restored
            .sample_raw_into_validated(0.5, 0.5, &mut raw)
            .is_err());
        restored.c[2] = vec![0.5];
        assert!(restored
            .sample_raw_into(f32::INFINITY, 0.5, &mut raw)
            .is_err());
        restored.grid[3][0] = f32::NAN;
        assert!(restored.validate(1).is_err());
    }

    #[test]
    fn patch_parser_rejects_truncation_invalid_flags_and_declared_size_without_payload() {
        let doc = Document::new();
        let dict = base_dict(7, 1);
        let mut data = square_patch_record(true, 0);
        data.pop();
        assert!(parse_patch_mesh(&doc, &dict, 7, &data, None, 1).is_err());
        for flag in [1, 2, 3, 4, 255] {
            assert!(
                parse_patch_mesh(&doc, &dict, 7, &square_patch_record(true, flag), None, 1)
                    .is_err()
            );
        }
        assert!(parse_patch_mesh(&doc, &dict, 7, &[0], None, usize::MAX).is_err());
        assert!(parse_patch_mesh(&doc, &dict, 7, &[], None, 1).is_err());
        assert!(parse_mesh(&doc, &dict, 7, &square_patch_record(true, 0), None, 1).is_err());
    }

    #[test]
    fn bounded_patch_parser_counts_stream_metadata_colours_and_outer_capacity() {
        let doc = Document::new();
        let dict = base_dict(7, 1);
        let data = square_patch_record(true, 0).repeat(3);
        let compact_bytes = 3 * (std::mem::size_of::<MeshPatch>() + 4 * std::mem::size_of::<f32>());
        let exact_budget = data.len() + 6 * std::mem::size_of::<f32>() + compact_bytes;
        let patches =
            parse_patch_mesh_bounded(&doc, &dict, 7, &data, None, 1, exact_budget, None).unwrap();
        assert_eq!(patches.len(), 3);
        assert_eq!(
            patches.capacity(),
            3,
            "gần budget không bắt buộc giữ capacity4"
        );
        assert!(matches!(
            parse_patch_mesh_bounded(&doc, &dict, 7, &data, None, 1, exact_budget - 1, None),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
        // Nếu chỉ đếm payload input mà bỏ Vec/metadata, ca này sẽ lọt budget.
        assert!(matches!(
            parse_patch_mesh_bounded(&doc, &dict, 7, &data, None, 1, data.len(), None),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
    }

    #[test]
    fn bounded_free_mesh_accounts_for_reused_vertices_without_extra_state_copies() {
        let doc = Document::new();
        let dict = base_dict(4, 1);
        let data = [
            vertex4(0, 0, 0, 0),
            vertex4(0, 255, 0, 0),
            vertex4(0, 0, 255, 0),
            vertex4(1, 255, 255, 255),
        ]
        .concat();
        let exact_budget = data.len()
            + 6 * std::mem::size_of::<f32>()
            + 2 * (std::mem::size_of::<MeshTriangle>() + 3 * std::mem::size_of::<f32>());
        let triangles =
            parse_mesh_bounded(&doc, &dict, 4, &data, None, 1, exact_budget, None).unwrap();
        assert_eq!(triangles.len(), 2);
        assert!(matches!(
            parse_mesh_bounded(&doc, &dict, 4, &data, None, 1, exact_budget - 1, None),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
    }

    #[test]
    fn bounded_lattice_accounts_for_two_live_rows_and_preserves_cell_order() {
        let doc = Document::new();
        let mut dict = base_dict(5, 1);
        dict.set("VerticesPerRow", 2);
        let data = [0, 0, 0, 255, 0, 85, 0, 255, 170, 255, 255, 255];
        let row_bytes = 2 * std::mem::size_of::<Vertex>() + 2 * std::mem::size_of::<f32>();
        let exact_budget = data.len()
            + 6 * std::mem::size_of::<f32>()
            + 2 * row_bytes
            + 2 * (std::mem::size_of::<MeshTriangle>() + 3 * std::mem::size_of::<f32>());
        let triangles =
            parse_mesh_bounded(&doc, &dict, 5, &data, None, 1, exact_budget, None).unwrap();
        assert_eq!(triangles.len(), 2);
        assert_eq!(triangles[0].p, [[0.0, 0.0], [100.0, 0.0], [0.0, 100.0]]);
        assert_eq!(triangles[1].p, [[100.0, 0.0], [100.0, 100.0], [0.0, 100.0]]);
        assert!(matches!(
            parse_mesh_bounded(&doc, &dict, 5, &data, None, 1, exact_budget - 1, None),
            Err(PpeError::MemoryBudgetExceeded { .. })
        ));
        dict.set("VerticesPerRow", i64::MAX);
        assert!(parse_mesh_bounded(&doc, &dict, 5, &data, None, 1, 4096, None).is_err());
    }

    #[test]
    fn bounded_mesh_parsers_preserve_cancelled_error() {
        let doc = Document::new();
        let token = CancelToken::new();
        let mut budget = MeshParseBudget::new(4096, 0, Some(&token)).unwrap();
        let mut temporary = Vec::<f32>::new();
        budget.reserve_exact(&mut temporary, 1).unwrap();
        token.cancel();
        assert!(matches!(
            budget.reserve_exact(&mut temporary, 2),
            Err(PpeError::Cancelled)
        ));
        for shading_type in [4, 5] {
            assert!(matches!(
                parse_mesh_bounded(
                    &doc,
                    &base_dict(shading_type, 1),
                    shading_type,
                    &[],
                    None,
                    1,
                    4096,
                    Some(&token)
                ),
                Err(PpeError::Cancelled)
            ));
        }
        for shading_type in [6, 7] {
            assert!(matches!(
                parse_patch_mesh_bounded(
                    &doc,
                    &base_dict(shading_type, 1),
                    shading_type,
                    &[],
                    None,
                    1,
                    4096,
                    Some(&token)
                ),
                Err(PpeError::Cancelled)
            ));
        }
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
