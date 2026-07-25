//! Lớp binding PyO3 cho PrynX Print Engine (PPE).
//!
//! Chỉ làm ba việc: nhận tham số, gọi `print_engine`, đóng gói kết quả. Mọi logic
//! prepress nằm trong crate `print_engine` để test được bằng `cargo test` mà
//! không cần Python.
//!
//! Contract trả về **khớp sẵn** cấu trúc plate mà `backend/app/core/separations.py`
//! đang dựng: mỗi kẽm là mảng `u8` với `255 = 100% mực`, đúng chiều của
//! `ink_density` mà lớp Python nén zlib + base64. Nhờ vậy đổi engine không phải
//! đổi contract API hay code frontend.

use std::path::Path;

use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::page::{open as ppe_open, render_page_managed, PageBox};

/// Tách kẽm một trang bằng PPE.
///
/// * `ink_accurate = true` → đo lượng mực DeviceCMYK: không khử răng cưa. Dùng
///   cho TAC / ink-limit. Vùng đặc đọc đúng 100% mực mỗi kênh.
/// * `ink_accurate = false` → đường xem trước, có khử răng cưa.
/// * `cmyk_profile` → bật quản lý màu ICC (thường là FOGRA39.icc).
/// * `rgb_profile` → profile RGB nguồn cho `DeviceRGB`; bỏ trống thì dùng sRGB.
/// * `render_intent` → 0 perceptual, 1 relative, 2 saturation, 3 absolute.
/// * `fallback_font` → file TrueType dùng thay khi PDF **không nhúng** font.
///
/// # Vì sao `fallback_font` là đường dẫn do Python truyền vào
///
/// Không hardcode trong Rust: layout thư mục assets do lớp đóng gói quyết định
/// (dev chạy từ repo, bản phát hành nằm trong sidecar), nên chỉ Python biết font
/// thật ở đâu. Truyền `None` là lựa chọn trung thực nhất nhưng để lại lỗ đo —
/// trang toàn chữ không nhúng font sẽ báo **0% mực**, tức báo *thiếu* mực, đúng
/// chiều sai làm hỏng lô in.
///
/// Trả dict với `plates[i]["ink"]` là `bytes` dài `width * height`.
#[pyfunction]
#[pyo3(signature = (
    pdf_path,
    page = 1,
    dpi = 100.0,
    ink_accurate = false,
    page_box = "crop",
    cmyk_profile = None,
    rgb_profile = None,
    render_intent = 1,
    fallback_font = None,
))]
#[allow(clippy::too_many_arguments)]
pub fn ppe_separations(
    py: Python<'_>,
    pdf_path: &str,
    page: usize,
    dpi: f32,
    ink_accurate: bool,
    page_box: &str,
    cmyk_profile: Option<&str>,
    rgb_profile: Option<&str>,
    render_intent: i32,
    fallback_font: Option<&str>,
) -> PyResult<Py<PyDict>> {
    if page == 0 {
        return Err(PyValueError::new_err("page là chỉ số 1-based, không nhận 0"));
    }
    let which_box = match page_box {
        "media" => PageBox::Media,
        "crop" => PageBox::Crop,
        "trim" => PageBox::Trim,
        "bleed" => PageBox::Bleed,
        "art" => PageBox::Art,
        other => {
            return Err(PyValueError::new_err(format!(
                "page_box không hợp lệ: {other} (media|crop|trim|bleed|art)"
            )))
        }
    };
    let base_opts = if ink_accurate {
        RenderOptions::ink_accurate()
    } else {
        RenderOptions::default()
    };
    // Đọc font ngay ở đây để đường dẫn sai **nổ** thành lỗi Python, thay vì lặng
    // lẽ chạy tiếp ở chế độ không-fallback. Bỏ qua âm thầm sẽ cho ra một trang
    // chữ báo 0% mực mà không có dấu hiệu nào cho biết vì sao.
    let opts = match fallback_font {
        Some(path) => {
            let data = std::fs::read(path).map_err(|e| {
                PyRuntimeError::new_err(format!("không đọc được fallback_font {path}: {e}"))
            })?;
            base_opts.with_fallback_font(std::sync::Arc::new(data))
        }
        None => base_opts,
    };

    let intent = RenderIntent::from_pdf(render_intent);

    // Render là việc nặng và không chạm Python object nào → nhả GIL để backend
    // vẫn phục vụ request khác. Đây là khác biệt lớn so với gọi Ghostscript qua
    // subprocess: không có tiến trình con, không có cửa sổ console, không temp file.
    //
    // `ColorManager` được dựng **bên trong** closure, không dựng trước rồi truyền
    // vào: nó giữ cache LUT bằng `RefCell` nên không `Sync`, mà `allow_threads`
    // đòi closure không mang theo dữ liệu chia sẻ được. Không mất gì vì LUT vốn
    // dựng lười — chi phí đúng bằng lần dùng đầu tiên.
    //
    // Lưu ý quan trọng: nạp profile **không** làm đổi kết quả của nội dung
    // DeviceCMYK — giá trị CMYK trong file chính là lượng mực và không bao giờ
    // được round-trip qua ICC. Profile chỉ áp cho DeviceRGB / Lab / ICCBased.
    // Nhờ vậy `ink_accurate` vẫn cho vùng đặc đúng 400% dù đã bật ICC.
    let rendered = py
        .allow_threads(|| {
            let manager = match cmyk_profile {
                Some(path) => Some(ColorManager::from_profiles(
                    Path::new(path),
                    rgb_profile.map(Path::new),
                    intent,
                )?),
                None => None,
            };
            let doc = ppe_open(pdf_path)?;
            render_page_managed(&doc, page, dpi, which_box, opts, manager.as_ref())
        })
        .map_err(|e| PyRuntimeError::new_err(format!("PPE: {e}")))?;

    let buffer = &rendered.buffer;
    let warnings = &rendered.warnings;

    let plates = PyList::empty(py);
    for (ch, colorant) in buffer.space().colorants().iter().enumerate() {
        let plate = PyDict::new(py);
        plate.set_item("name", colorant.name())?;
        plate.set_item("is_spot", colorant.is_spot())?;
        plate.set_item("ink", PyBytes::new(py, &buffer.plate_u8(ch)))?;
        plate.set_item("coverage_pct", buffer.plate_coverage_pct(ch))?;
        plates.append(plate)?;
    }

    let skipped = PyList::empty(py);
    for (op, count) in &warnings.skipped_ops {
        let entry = PyDict::new(py);
        entry.set_item("op", op)?;
        entry.set_item("count", *count)?;
        skipped.append(entry)?;
    }

    let out = PyDict::new(py);
    out.set_item("engine", "ppe")?;
    out.set_item("width", buffer.width())?;
    out.set_item("height", buffer.height())?;
    out.set_item("rotate", rendered.rotate)?;
    out.set_item("max_tac_pct", buffer.max_tac_percent())?;
    out.set_item("plates", plates)?;
    // `degraded = true` nghĩa là trang có thứ PPE chưa vẽ đúng ⇒ lớp Python PHẢI
    // hạ `accuracy` và KHÔNG được kết luận "đạt ngưỡng mực".
    //
    // Giữ `degraded` (hợp của hai trục) để contract cũ không vỡ, nhưng phơi thêm
    // hai trục riêng vì chúng dẫn tới quyết định KHÁC NHAU:
    //
    // * `ink_unsound` — lượng mực không đáng tin (thiếu object / transparency chưa
    //   dựng / màu xấp xỉ / nội dung có thể đang bị ẩn). Cấm chốt kẽm.
    // * `geometry_approximate` — chữ ĐÃ lên mực nhưng hình khác bản gốc (font thay
    //   thế). Đỉnh mực vùng đặc vẫn đúng, chỉ % diện tích phủ là ước lượng.
    //
    // Gộp hai thứ này vào một cờ khiến gần như mọi file xưởng thật bị hạ tin cậy
    // (file nào cũng có chữ) — cảnh báo báo oan rồi cũng bị bỏ qua như không có.
    out.set_item("degraded", warnings.degrades_accuracy())?;
    out.set_item("ink_unsound", warnings.ink_unsound())?;
    out.set_item("geometry_approximate", warnings.geometry_approximate())?;
    out.set_item("substituted_fonts", warnings.substituted_fonts.clone())?;
    out.set_item("hidden_content_risk", warnings.hidden_content_risk)?;
    out.set_item("dropped_objects", warnings.dropped_objects)?;
    out.set_item("unsupported_transparency", warnings.unsupported_transparency)?;
    out.set_item(
        "approximated_colorspaces",
        warnings.approximated_colorspaces.clone(),
    )?;
    out.set_item("colorspaces_used", warnings.colorspaces_used.clone())?;
    out.set_item("color_managed", cmyk_profile.is_some())?;
    out.set_item("skipped_ops", skipped)?;
    Ok(out.into())
}

/// Năng lực hiện tại của PPE — nguồn duy nhất cho capability matrix ở lớp Python.
///
/// Để ở Rust (cạnh code thật) thay vì hardcode trong Python: khi một tính năng
/// được hoàn thiện, cờ đổi cùng lúc với code, không thể quên cập nhật.
#[pyfunction]
pub fn ppe_capabilities(py: Python<'_>) -> PyResult<Py<PyDict>> {
    let caps = PyDict::new(py);
    caps.set_item("version", env!("CARGO_PKG_VERSION"))?;
    caps.set_item("process_separations", true)?;
    caps.set_item("spot_separations", true)?;
    caps.set_item("overprint", true)?;
    caps.set_item("overprint_mode_1", true)?;
    caps.set_item("tac", true)?;
    caps.set_item("vector_fill_stroke", true)?;
    caps.set_item("clipping", true)?;
    caps.set_item("form_xobject", true)?;
    caps.set_item("images", true)?;
    caps.set_item("image_mask_stencil", true)?;
    caps.set_item("image_soft_mask", true)?;
    // Codec ảnh khai riêng: "images = true" không có nghĩa mọi ảnh đều đọc được.
    // Gộp chung sẽ khiến lớp trên tin rằng một trang ảnh JPEG 2000 đã được vẽ.
    caps.set_item(
        "image_filters",
        vec![
            "FlateDecode",
            "LZWDecode",
            "ASCII85Decode",
            "ASCIIHexDecode",
            "RunLengthDecode",
            "DCTDecode",
        ],
    )?;
    caps.set_item(
        "image_filters_missing",
        vec!["JPXDecode", "CCITTFaxDecode", "JBIG2Decode"],
    )?;

    caps.set_item("icc_color_management", true)?;
    // ICC chỉ áp cho nội dung CHƯA phải mực. Dữ liệu đã là mực thì không bao giờ
    // round-trip: round-trip nén vùng đặc 400% xuống ~292% và biến một file vượt
    // giới hạn mực thành "đạt".
    caps.set_item("icc_applies_to", vec!["DeviceRGB", "Lab", "ICCBased"])?;
    caps.set_item(
        "icc_never_applies_to",
        vec!["DeviceCMYK", "DeviceGray", "Separation", "DeviceN"],
    )?;
    caps.set_item("soft_proof_cmyk_to_srgb", true)?;

    // Chữ: Type1 / CFF / TrueType / Type0-CID / Type3 → outline, có clip theo chữ.
    caps.set_item("text", true)?;
    caps.set_item(
        "text_font_formats",
        vec!["Type1", "Type1C/CFF", "TrueType", "Type0-CID", "Type3"],
    )?;
    // Font KHÔNG nhúng: engine chỉ vẽ được khi caller cấp `fallback_font`, và khi
    // đó hình chữ là xấp xỉ ⇒ bật `geometry_approximate`, KHÔNG bật `ink_unsound`.
    caps.set_item("text_substitute_font_requires_caller_asset", true)?;
    // Hai trục hỏng — lớp Python phải đọc đúng trục để không hạ tin cậy oan.
    caps.set_item(
        "degraded_axes",
        vec!["ink_unsound", "geometry_approximate"],
    )?;

    // Chưa xong — giữ đúng sự thật, đừng hứa trước.
    caps.set_item("shading", false)?;
    caps.set_item("transparency_groups", false)?;
    caps.set_item("soft_mask", false)?;
    caps.set_item("blend_modes", false)?;
    caps.set_item("inline_images", false)?;
    Ok(caps.into())
}
