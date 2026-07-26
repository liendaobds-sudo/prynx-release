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
    memory_budget_mb = 512,
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
    memory_budget_mb: usize,
) -> PyResult<Py<PyDict>> {
    if page == 0 {
        return Err(PyValueError::new_err(
            "page là chỉ số 1-based, không nhận 0",
        ));
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
    let memory_budget_bytes = memory_budget_mb
        .checked_mul(1024 * 1024)
        .filter(|bytes| *bytes > 0)
        .ok_or_else(|| PyValueError::new_err("memory_budget_mb must be greater than zero"))?;
    let base_opts = base_opts.with_memory_budget_bytes(memory_budget_bytes);

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
        .detach(|| {
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
    out.set_item(
        "unsupported_transparency",
        warnings.unsupported_transparency,
    )?;
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
/// Soft-proof một trang: render trong không gian mực rồi quy sang sRGB qua ICC.
///
/// Trả `(width, height, rgb_bytes, degraded, ink_unsound)` — `rgb_bytes` dài
/// `width * height * 3`.
///
/// # Khác `ppe_separations` ở hai điểm, và cả hai là có chủ ý
///
/// 1. **Khử răng cưa bật.** Đây là đường để *xem*, không phải để *đo*.
/// 2. **Mực pha được quy về CMYK** qua tint transform. Màn hình không có mực pha; giữ
///    kênh riêng rồi chỉ đọc bốn kênh process sẽ làm một trang chỉ dùng Pantone hiện
///    ra trắng.
///
/// Vì lý do (1) và (2), kết quả của hàm này **không được** dùng để kết luận về lượng
/// mực. Đó là lý do nó là một hàm riêng chứ không phải một cờ của `ppe_separations`.
///
/// `cmyk_profile` là **bắt buộc**: không có profile thì "soft-proof" chỉ là một công
/// thức đoán, và hứa một thứ không có là tệ hơn không hứa.
#[pyfunction]
#[pyo3(signature = (
    pdf_path,
    page = 1,
    dpi = 150.0,
    cmyk_profile = "",
    rgb_profile = None,
    render_intent = 1,
    page_box = "crop",
    fallback_font = None,
    memory_budget_mb = 512,
))]
#[allow(clippy::too_many_arguments)]
pub fn ppe_softproof(
    py: Python<'_>,
    pdf_path: &str,
    page: usize,
    dpi: f32,
    cmyk_profile: &str,
    rgb_profile: Option<&str>,
    render_intent: i32,
    page_box: &str,
    fallback_font: Option<&str>,
    memory_budget_mb: usize,
) -> PyResult<Py<PyDict>> {
    if page == 0 {
        return Err(PyValueError::new_err(
            "page là chỉ số 1-based, không nhận 0",
        ));
    }
    if cmyk_profile.is_empty() {
        return Err(PyValueError::new_err(
            "soft-proof cần cmyk_profile; không có profile thì không có soft-proof",
        ));
    }
    let which_box = match page_box {
        "media" => PageBox::Media,
        "crop" => PageBox::Crop,
        "trim" => PageBox::Trim,
        "bleed" => PageBox::Bleed,
        "art" => PageBox::Art,
        other => {
            return Err(PyValueError::new_err(format!(
                "page_box không hợp lệ: {other}"
            )))
        }
    };
    let memory_budget_bytes = memory_budget_mb
        .checked_mul(1024 * 1024)
        .filter(|bytes| *bytes > 0)
        .ok_or_else(|| PyValueError::new_err("memory_budget_mb must be greater than zero"))?;
    let base_opts = RenderOptions::softproof().with_memory_budget_bytes(memory_budget_bytes);
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

    let (width, height, rgb, degraded, ink_unsound) = py
        .detach(|| -> print_engine::error::PpeResult<_> {
            let manager = ColorManager::from_profiles(
                Path::new(cmyk_profile),
                rgb_profile.map(Path::new),
                intent,
            )?;
            let doc = ppe_open(pdf_path)?;
            let rendered = render_page_managed(&doc, page, dpi, which_box, opts, Some(&manager))?;
            let rgb = rendered.buffer.to_srgb(&manager).ok_or_else(|| {
                print_engine::error::PpeError::Unsupported(
                    "không quy được mực sang sRGB".to_string(),
                )
            })?;
            Ok((
                rendered.buffer.width(),
                rendered.buffer.height(),
                rgb,
                rendered.warnings.degrades_accuracy(),
                rendered.warnings.ink_unsound(),
            ))
        })
        .map_err(|e| PyRuntimeError::new_err(format!("PPE: {e}")))?;

    let out = PyDict::new(py);
    out.set_item("width", width)?;
    out.set_item("height", height)?;
    out.set_item("rgb", PyBytes::new(py, &rgb))?;
    out.set_item("degraded", degraded)?;
    // Trả cả cờ này dù đây là đường xem: một trang mà engine chưa vẽ đủ thì ảnh
    // soft-proof cũng thiếu nội dung, và lớp UI cần nói ra chứ không im lặng.
    out.set_item("ink_unsound", ink_unsound)?;
    Ok(out.into())
}

/// Để ở Rust (cạnh code thật) thay vì hardcode trong Python: khi một tính năng
/// được hoàn thiện, cờ đổi cùng lúc với code, không thể quên cập nhật.
#[pyfunction]
pub fn ppe_capabilities(py: Python<'_>) -> PyResult<Py<PyDict>> {
    let caps = PyDict::new(py);
    caps.set_item("version", env!("CARGO_PKG_VERSION"))?;
    caps.set_item("memory_budget_default_mb", 512)?;
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
            "CCITTFaxDecode",
        ],
    )?;
    caps.set_item("image_filters_missing", vec!["JPXDecode", "JBIG2Decode"])?;

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
    caps.set_item("degraded_axes", vec!["ink_unsound", "geometry_approximate"])?;

    // Shading: kiểu 1/2/3 đã dựng, lưới 4–7 thì chưa. Khai riêng từng kiểu thay vì
    // một cờ `shading` duy nhất — "có shading" mà thực ra thiếu lưới Coons sẽ khiến
    // lớp trên tin rằng mọi trang gradient đều đo được.
    caps.set_item("shading", true)?;
    caps.set_item("shading_types", vec![1, 2, 3, 4, 5, 6, 7])?;
    caps.set_item("shading_types_missing", Vec::<i32>::new())?;
    caps.set_item("shading_pattern", true)?;
    caps.set_item("tiling_pattern", true)?;
    // Tiling pattern được vẽ thật (lặp lại ô mẫu), nhưng có trần số ô: vượt trần thì
    // báo thiếu tính năng chứ không vẽ một phần — vẽ một phần cho lượng mực thấp hơn
    // thực tế, đúng chiều sai nguy hiểm.
    caps.set_item("tiling_pattern_max_tiles", 1024)?;

    // Optional content: đọc theo cấu hình **in** (`/AS` + `/Usage /Print`), không
    // theo cấu hình xem. Một lớp hiện trên màn hình nhưng khai không-in thì KHÔNG
    // được tính mực.
    caps.set_item("optional_content", true)?;
    caps.set_item("optional_content_config", "print")?;
    caps.set_item("inline_images", true)?;
    // Soft-proof: đường **xem**, khử răng cưa và quy mực pha về CMYK ⇒ tuyệt đối
    // không dùng kết quả của nó để kết luận lượng mực.
    caps.set_item("softproof", true)?;
    caps.set_item("softproof_requires_icc", true)?;

    // Trong suốt: blend mode và soft mask đã dựng; group đã dựng cả ba đường
    // (đục / không cách ly / cách ly). Riêng knockout group thì chưa — khai riêng
    // thay vì để `transparency_groups = true` che mất phần thiếu.
    caps.set_item("transparency_groups", true)?;
    caps.set_item("transparency_knockout_groups", false)?;
    caps.set_item("soft_mask", true)?;
    caps.set_item("soft_mask_types", vec!["Luminosity", "Alpha"])?;
    caps.set_item("blend_modes", true)?;
    // Bốn mode không tách kênh phải đi qua xấp xỉ RGB và **không** chạm kênh spot,
    // nên chúng không cùng mức tin cậy với mười một mode tách kênh.
    caps.set_item(
        "blend_modes_separable",
        vec![
            "Normal",
            "Multiply",
            "Screen",
            "Overlay",
            "Darken",
            "Lighten",
            "ColorDodge",
            "ColorBurn",
            "HardLight",
            "SoftLight",
            "Difference",
            "Exclusion",
        ],
    )?;
    caps.set_item(
        "blend_modes_approximated",
        vec!["Hue", "Saturation", "Color", "Luminosity"],
    )?;
    Ok(caps.into())
}
