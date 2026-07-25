//! Mở tài liệu, dựng hình học trang, render ra [`InkBuffer`].

use lopdf::{Dictionary, Document, Object};

use crate::color::icc::ColorManager;
use crate::content::{RenderOptions, Renderer};
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::geom::{Matrix, Rect};
use crate::ink::{InkBuffer, InkSpace};
use crate::pdf;

/// Trần cạnh raster (pixel) cho một trang.
///
/// Chặn cả DPI vô lý lẫn PDF khai MediaBox khổng lồ. 30000 px ≈ 2.5 m ở 300 DPI,
/// vượt mọi khổ in thật, trong khi vẫn giữ trần bộ nhớ ở mức chấp nhận được:
/// 30000² × 4 kênh × 4 byte là quá lớn nên trần diện tích bên dưới mới là thứ
/// thực sự bảo vệ.
const MAX_RASTER_SIDE: u32 = 30_000;

/// Trần tổng số pixel: 80 MP (≈ A0 @ 300 DPI). Mỗi pixel tốn 4 byte × số kênh.
const MAX_RASTER_PIXELS: u64 = 80_000_000;

/// Kết quả render một trang.
pub struct PageRender {
    pub buffer: InkBuffer,
    pub warnings: RenderWarnings,
    /// Hộp đã dùng làm khung raster (thường là CropBox).
    pub box_used: Rect,
    /// `/Rotate` đã áp (0/90/180/270).
    pub rotate: i32,
}

/// Hộp trang nào dùng làm khung raster.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageBox {
    Media,
    Crop,
    Trim,
    Bleed,
    Art,
}

impl PageBox {
    fn key(&self) -> &'static str {
        match self {
            PageBox::Media => "MediaBox",
            PageBox::Crop => "CropBox",
            PageBox::Trim => "TrimBox",
            PageBox::Bleed => "BleedBox",
            PageBox::Art => "ArtBox",
        }
    }
}

/// Render một trang (1-based) ra buffer mực.
pub fn render_page(
    doc: &Document,
    page_number: usize,
    dpi: f32,
    which_box: PageBox,
    opts: RenderOptions,
) -> PpeResult<PageRender> {
    render_page_managed(doc, page_number, dpi, which_box, opts, None)
}

/// Như [`render_page`] nhưng có quản lý màu ICC.
///
/// Tách thành hai hàm thay vì thêm `Option` vào mọi lời gọi: đường không-ICC vẫn
/// hợp lệ (nội dung DeviceCMYK thuần không cần profile nào), còn đường có ICC là
/// lựa chọn có ý thức của caller.
pub fn render_page_managed(
    doc: &Document,
    page_number: usize,
    dpi: f32,
    which_box: PageBox,
    opts: RenderOptions,
    color: Option<&ColorManager>,
) -> PpeResult<PageRender> {
    let pages = doc.get_pages();
    let total = pages.len();
    let page_id = *pages
        .get(&(page_number as u32))
        .ok_or(PpeError::PageOutOfRange { requested: page_number, total })?;

    let page_dict = doc
        .get_dictionary(page_id)
        .map_err(|e| PpeError::MalformedPdf(format!("không đọc được dict trang: {e}")))?;

    let media = inherited_rect(doc, page_dict, PageBox::Media)
        .unwrap_or_else(|| Rect::new(0.0, 0.0, 612.0, 792.0));
    // Hộp yêu cầu phải nằm trong MediaBox (§14.11.2); hộp thiếu thì lùi về Media.
    let target = inherited_rect(doc, page_dict, which_box)
        .and_then(|r| r.intersect(&media))
        .unwrap_or(media);

    let rotate = normalize_rotate(
        inherited_num(doc, page_dict, "Rotate").unwrap_or(0.0) as i32,
    );

    let (width_px, height_px) = raster_size(&target, dpi, rotate)?;
    let device = device_matrix(&target, dpi, rotate);

    let buffer = InkBuffer::new(width_px, height_px, InkSpace::new())?;
    let mut renderer = Renderer::new(doc, buffer, opts, color)?;

    let resources = collect_resources(doc, page_dict);
    let content = doc
        .get_page_content(page_id);
    if content.is_empty() {
        // Trang trắng hợp lệ; không phải lỗi. Không ghi cảnh báo để khỏi hạ
        // accuracy oan cho trang thật sự trắng.
    }
    renderer.run(&content, resources.as_ref(), device)?;

    let (buffer, warnings) = renderer.into_parts();
    Ok(PageRender { buffer, warnings, box_used: target, rotate })
}

/// Mở PDF từ file.
pub fn open(path: &str) -> PpeResult<Document> {
    Document::load(path).map_err(|e| PpeError::OpenFailed(format!("{e}")))
}

/// Mở PDF từ bộ nhớ.
pub fn open_mem(bytes: &[u8]) -> PpeResult<Document> {
    Document::load_mem(bytes).map_err(|e| PpeError::OpenFailed(format!("{e}")))
}

/// Chuẩn hoá `/Rotate` về {0, 90, 180, 270}.
///
/// Spec đòi số chia hết cho 90, nhưng file thật có cả số âm và > 360.
pub fn normalize_rotate(raw: i32) -> i32 {
    let r = ((raw % 360) + 360) % 360;
    // Làm tròn về bậc 90 gần nhất để giá trị lệch (vd 89) không làm lật khung.
    match r {
        0..=44 | 315..=359 => 0,
        45..=134 => 90,
        135..=224 => 180,
        _ => 270,
    }
}

/// Kích thước raster, đã tính hoán đổi cạnh khi xoay 90/270.
pub fn raster_size(page_box: &Rect, dpi: f32, rotate: i32) -> PpeResult<(u32, u32)> {
    if !(dpi.is_finite()) || dpi <= 0.0 {
        return Err(PpeError::BadRasterSize { w: 0, h: 0, dpi });
    }
    let s = dpi / 72.0;
    let (w_pt, h_pt) = if rotate == 90 || rotate == 270 {
        (page_box.height(), page_box.width())
    } else {
        (page_box.width(), page_box.height())
    };
    let w = (w_pt * s).round().max(1.0);
    let h = (h_pt * s).round().max(1.0);
    if !w.is_finite() || !h.is_finite() || w > MAX_RASTER_SIDE as f32 || h > MAX_RASTER_SIDE as f32 {
        return Err(PpeError::BadRasterSize { w: w as i64, h: h as i64, dpi });
    }
    if (w as u64) * (h as u64) > MAX_RASTER_PIXELS {
        return Err(PpeError::BadRasterSize { w: w as i64, h: h as i64, dpi });
    }
    Ok((w as u32, h as u32))
}

/// Ma trận trang → thiết bị, đã gộp lật trục y và `/Rotate`.
///
/// Xoay theo chiều **kim đồng hồ** khi hiển thị (§7.7.3.3): `/Rotate 90` đưa góc
/// trên-trái của trang chưa xoay về góc trên-**phải** của ảnh.
pub fn device_matrix(page_box: &Rect, dpi: f32, rotate: i32) -> Matrix {
    let s = dpi / 72.0;
    let Rect { x0, y0, x1, y1 } = *page_box;
    match rotate {
        90 => Matrix::new(0.0, s, s, 0.0, -y0 * s, -x0 * s),
        180 => Matrix::new(-s, 0.0, 0.0, s, x1 * s, -y0 * s),
        270 => Matrix::new(0.0, -s, -s, 0.0, y1 * s, x1 * s),
        _ => Matrix::new(s, 0.0, 0.0, -s, -x0 * s, y1 * s),
    }
}

/// Đọc một hộp trang, có kế thừa từ `/Pages` cha.
fn inherited_rect(doc: &Document, page: &Dictionary, which: PageBox) -> Option<Rect> {
    let v = inherited(doc, page, which.key())
        .and_then(|o| pdf::num_array(doc, o))?;
    if v.len() < 4 {
        return None;
    }
    let r = Rect::new(v[0], v[1], v[2], v[3]);
    if r.is_empty() || !r.x0.is_finite() || !r.y1.is_finite() {
        None
    } else {
        Some(r)
    }
}

fn inherited_num(doc: &Document, page: &Dictionary, key: &str) -> Option<f32> {
    inherited(doc, page, key).and_then(pdf::as_num)
}

/// Trần độ cao cây trang khi truy ngược `/Parent`, chống vòng lặp cha-con.
const MAX_PAGE_TREE_DEPTH: u32 = 64;

/// Tìm một khoá trên trang, truy ngược `/Parent` nếu thiếu.
///
/// Kế thừa là điểm dễ bỏ sót: rất nhiều PDF chỉ khai `MediaBox`/`Resources` ở
/// node `/Pages`. Không truy ngược thì trang sẽ ra khổ mặc định sai và **mọi**
/// resources (kể cả colorspace spot) sẽ không tìm thấy.
fn inherited<'a>(doc: &'a Document, page: &'a Dictionary, key: &str) -> Option<&'a Object> {
    if let Some(v) = pdf::dict_get(doc, page, key) {
        return Some(v);
    }
    let mut current = page;
    for _ in 0..MAX_PAGE_TREE_DEPTH {
        let parent = pdf::dict_get(doc, current, "Parent")?;
        let parent_dict = match parent {
            Object::Dictionary(d) => d,
            _ => return None,
        };
        if let Some(v) = pdf::dict_get(doc, parent_dict, key) {
            return Some(v);
        }
        current = parent_dict;
    }
    None
}

fn collect_resources(doc: &Document, page: &Dictionary) -> Option<Dictionary> {
    match inherited(doc, page, "Resources")? {
        Object::Dictionary(d) => Some(d.clone()),
        Object::Stream(s) => Some(s.dict.clone()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a4() -> Rect {
        Rect::new(0.0, 0.0, 595.0, 842.0)
    }

    #[test]
    fn rotate_is_normalized_to_quadrants() {
        assert_eq!(normalize_rotate(0), 0);
        assert_eq!(normalize_rotate(90), 90);
        assert_eq!(normalize_rotate(-90), 270);
        assert_eq!(normalize_rotate(450), 90);
        assert_eq!(normalize_rotate(360), 0);
        assert_eq!(normalize_rotate(-360), 0);
    }

    #[test]
    fn odd_rotate_values_snap_to_nearest_quadrant() {
        assert_eq!(normalize_rotate(89), 90);
        assert_eq!(normalize_rotate(1), 0);
        assert_eq!(normalize_rotate(181), 180);
    }

    #[test]
    fn raster_size_matches_dpi() {
        let (w, h) = raster_size(&Rect::new(0.0, 0.0, 72.0, 144.0), 300.0, 0).unwrap();
        assert_eq!((w, h), (300, 600));
    }

    #[test]
    fn raster_size_swaps_sides_when_rotated_90() {
        let (w0, h0) = raster_size(&a4(), 72.0, 0).unwrap();
        let (w90, h90) = raster_size(&a4(), 72.0, 90).unwrap();
        assert_eq!((w90, h90), (h0, w0));
    }

    #[test]
    fn raster_size_rejects_zero_and_negative_dpi() {
        assert!(raster_size(&a4(), 0.0, 0).is_err());
        assert!(raster_size(&a4(), -300.0, 0).is_err());
    }

    #[test]
    fn raster_size_rejects_absurd_dpi() {
        // Chặn OOM trước khi cấp phát, thay vì để tiến trình bị kill.
        assert!(raster_size(&a4(), 100_000.0, 0).is_err());
    }

    #[test]
    fn raster_size_never_returns_zero() {
        let (w, h) = raster_size(&Rect::new(0.0, 0.0, 0.5, 0.5), 10.0, 0).unwrap();
        assert!(w >= 1 && h >= 1);
    }

    #[test]
    fn device_matrix_rotate_0_maps_top_left_to_origin() {
        let m = device_matrix(&a4(), 72.0, 0);
        let p = m.apply(0.0, 842.0);
        assert!(p.0.abs() < 1e-3 && p.1.abs() < 1e-3, "{p:?}");
    }

    #[test]
    fn device_matrix_rotate_90_moves_top_left_to_top_right() {
        // /Rotate 90 xoay theo chiều kim đồng hồ.
        let (w, _h) = raster_size(&a4(), 72.0, 90).unwrap();
        let m = device_matrix(&a4(), 72.0, 90);
        let p = m.apply(0.0, 842.0); // góc trên-trái khi chưa xoay
        assert!((p.0 - w as f32).abs() < 1e-2, "x={} w={}", p.0, w);
        assert!(p.1.abs() < 1e-2, "y={}", p.1);
    }

    #[test]
    fn device_matrix_rotate_180_moves_top_left_to_bottom_right() {
        let (w, h) = raster_size(&a4(), 72.0, 180).unwrap();
        let m = device_matrix(&a4(), 72.0, 180);
        let p = m.apply(0.0, 842.0);
        assert!((p.0 - w as f32).abs() < 1e-2, "{p:?}");
        assert!((p.1 - h as f32).abs() < 1e-2, "{p:?}");
    }

    #[test]
    fn device_matrix_rotate_270_moves_top_left_to_bottom_left() {
        let (_w, h) = raster_size(&a4(), 72.0, 270).unwrap();
        let m = device_matrix(&a4(), 72.0, 270);
        let p = m.apply(0.0, 842.0);
        assert!(p.0.abs() < 1e-2, "{p:?}");
        assert!((p.1 - h as f32).abs() < 1e-2, "{p:?}");
    }

    #[test]
    fn device_matrix_honours_offset_crop_box() {
        // CropBox lệch gốc là chuyện thường ở file bình trang.
        let crop = Rect::new(20.0, 30.0, 320.0, 430.0);
        let m = device_matrix(&crop, 72.0, 0);
        let p = m.apply(20.0, 430.0);
        assert!(p.0.abs() < 1e-3 && p.1.abs() < 1e-3, "{p:?}");
    }

    #[test]
    fn rotation_preserves_area_mapping() {
        // Bốn góc trang phải map vào bốn góc ảnh với mọi góc xoay.
        for rot in [0, 90, 180, 270] {
            let (w, h) = raster_size(&a4(), 72.0, rot).unwrap();
            let m = device_matrix(&a4(), 72.0, rot);
            let corners = [
                m.apply(0.0, 0.0),
                m.apply(595.0, 0.0),
                m.apply(0.0, 842.0),
                m.apply(595.0, 842.0),
            ];
            let xs: Vec<f32> = corners.iter().map(|c| c.0).collect();
            let ys: Vec<f32> = corners.iter().map(|c| c.1).collect();
            let minx = xs.iter().cloned().fold(f32::MAX, f32::min);
            let maxx = xs.iter().cloned().fold(f32::MIN, f32::max);
            let miny = ys.iter().cloned().fold(f32::MAX, f32::min);
            let maxy = ys.iter().cloned().fold(f32::MIN, f32::max);
            assert!(minx.abs() < 1e-2, "rot={rot} minx={minx}");
            assert!(miny.abs() < 1e-2, "rot={rot} miny={miny}");
            assert!((maxx - w as f32).abs() < 1e-2, "rot={rot} maxx={maxx} w={w}");
            assert!((maxy - h as f32).abs() < 1e-2, "rot={rot} maxy={maxy} h={h}");
        }
    }
}
