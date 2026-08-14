//! Profile theo pha cho đường PPE — dùng trong audit hiệu năng.
//!
//! ```text
//! cargo run --release --example perf_profile -- \
//!   <file.pdf> [dpi] [repeats] [clip] [render_budget_mib] [resource_cache_budget_mib]
//! ```

use std::hint::black_box;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use print_engine::color::RenderIntent;
use print_engine::content::RenderOptions;
use print_engine::oc::OptionalContentUsage;
use print_engine::page::{PageBox, RasterClip};
use print_engine::session::{RenderSession, ResourceCacheStats};

const MIB: usize = 1024 * 1024;
const FOGRA39_SHA256: &str = "da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77";
const FALLBACK_FONT_SHA256: &str =
    "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954";

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    len: u64,
    modified: Option<std::time::SystemTime>,
    created: Option<std::time::SystemTime>,
}

fn file_identity(path: &str) -> Result<FileIdentity, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| format!("không đọc được metadata '{}': {error}", path))?;
    Ok(FileIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
    })
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1_000.0
}

fn duration_ms(value: std::time::Duration) -> f64 {
    value.as_secs_f64() * 1_000.0
}

fn json_string(value: &str) -> String {
    format!("{value:?}")
}

fn find_default_cmyk_profile() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let profile = root.join("backend/app/assets/icc/FOGRA39.icc");
    profile.is_file().then_some(profile)
}

fn load_default_fallback_font() -> Result<Arc<Vec<u8>>, String> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "không tìm được thư mục gốc repo".to_string())?;
    let path = root.join("backend/app/assets/fonts/DejaVuSans.ttf");
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("không đọc được font dự phòng '{}': {error}", path.display()))?;
    Ok(Arc::new(bytes))
}

fn parse_clip(value: Option<&String>) -> Result<Option<RasterClip>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.eq_ignore_ascii_case("full") {
        return Ok(None);
    }
    let parts = value
        .split(',')
        .map(str::trim)
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "clip phải có dạng x,y,width,height hoặc full".to_string())?;
    if parts.len() != 4 || !(1..=4000).contains(&parts[2]) || !(1..=4000).contains(&parts[3]) {
        return Err(
            "clip phải có dạng x,y,width,height với width/height trong 1..4000".to_string(),
        );
    }
    Ok(Some(RasterClip {
        x: parts[0],
        y: parts[1],
        width: parts[2],
        height: parts[3],
    }))
}

fn parse_budget_mib(
    value: Option<&String>,
    default_mib: usize,
    name: &str,
) -> Result<usize, String> {
    let mib = match value {
        Some(raw) => raw
            .parse::<usize>()
            .map_err(|_| format!("{name} phải là số MiB nguyên không âm"))?,
        None => default_mib,
    };
    mib.checked_mul(MIB)
        .ok_or_else(|| format!("{name} vượt giới hạn của nền tảng"))
}

fn stats_json(stats: ResourceCacheStats) -> String {
    format!(
        "{{\"image_hits\":{},\"image_misses\":{},\"image_evictions\":{},\"page_hits\":{},\"page_misses\":{},\"bytes\":{},\"budget_bytes\":{}}}",
        stats.image_hits,
        stats.image_misses,
        stats.image_evictions,
        stats.page_hits,
        stats.page_misses,
        stats.bytes,
        stats.budget_bytes,
    )
}

fn encode_rgb_png(rgb: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let row_bytes = (width as usize)
        .checked_mul(3)
        .ok_or_else(|| "chiều rộng PNG vượt giới hạn".to_string())?;
    let expected = row_bytes
        .checked_mul(height as usize)
        .ok_or_else(|| "kích thước PNG vượt giới hạn".to_string())?;
    if rgb.len() != expected {
        return Err(format!(
            "buffer RGB sai kích thước: nhận {}, cần {expected}",
            rgb.len()
        ));
    }

    // Proxy cố ý nhỏ: filter None + zlib mặc định, đủ đo chi phí encode/memory mà
    // không kéo dependency mới vào lockfile. Worker runtime vẫn dùng Image::PngEncoder.
    let mut filtered = Vec::new();
    filtered
        .try_reserve_exact(expected.saturating_add(height as usize))
        .map_err(|error| format!("không cấp được buffer PNG proxy: {error}"))?;
    for row in rgb.chunks_exact(row_bytes) {
        filtered.push(0);
        filtered.extend_from_slice(row);
    }
    let mut compressor =
        flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    compressor
        .write_all(&filtered)
        .map_err(|error| format!("không nén được PNG PPE proxy: {error}"))?;
    let compressed = compressor
        .finish()
        .map_err(|error| format!("không chốt được PNG PPE proxy: {error}"))?;

    if compressed.len() > u32::MAX as usize {
        return Err("PNG proxy vượt giới hạn chunk 4 GiB".to_string());
    }
    let output_capacity = compressed
        .len()
        .checked_add(57)
        .ok_or_else(|| "kích thước PNG proxy vượt giới hạn".to_string())?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(output_capacity)
        .map_err(|error| format!("không cấp được output PNG proxy: {error}"))?;
    output.extend_from_slice(b"\x89PNG\r\n\x1a\n");
    append_png_chunk(&mut output, b"IHDR", &{
        let mut header = Vec::with_capacity(13);
        header.extend_from_slice(&width.to_be_bytes());
        header.extend_from_slice(&height.to_be_bytes());
        header.extend_from_slice(&[8, 2, 0, 0, 0]);
        header
    });
    append_png_chunk(&mut output, b"IDAT", &compressed);
    append_png_chunk(&mut output, b"IEND", &[]);
    Ok(output)
}

fn append_png_chunk(output: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    output.extend_from_slice(&(data.len() as u32).to_be_bytes());
    output.extend_from_slice(chunk_type);
    output.extend_from_slice(data);
    let mut crc = crc32_update(0xffff_ffff, chunk_type);
    crc = crc32_update(crc, data) ^ 0xffff_ffff;
    output.extend_from_slice(&crc.to_be_bytes());
}

fn crc32_update(mut crc: u32, bytes: &[u8]) -> u32 {
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
        }
    }
    crc
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "dùng: perf_profile <file.pdf> [dpi] [repeats] \
             [clip=x,y,width,height|full] [render_budget_mib] [resource_cache_budget_mib]"
        );
        std::process::exit(2);
    }
    let path = &args[1];
    let source_identity = file_identity(path).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    let dpi: f32 = args
        .get(2)
        .map_or(Ok(300.0), |value| {
            value
                .parse()
                .map_err(|_| "dpi phải là số hữu hạn >0".to_string())
        })
        .unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
    if !dpi.is_finite() || !(24.0..=9600.0).contains(&dpi) {
        eprintln!("dpi phải là số hữu hạn trong miền PPE 24..9600");
        std::process::exit(2);
    }
    let repeats = args
        .get(3)
        .map_or(Ok(5usize), |value| {
            value
                .parse::<usize>()
                .map_err(|_| "repeats phải là số nguyên >=1".to_string())
        })
        .unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
    if repeats == 0 {
        eprintln!("repeats phải là số nguyên >=1");
        std::process::exit(2);
    }
    let clip = parse_clip(args.get(4)).unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    let render_budget_bytes = parse_budget_mib(args.get(5), 1536, "render_budget_mib")
        .unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
    let resource_cache_budget_bytes =
        parse_budget_mib(args.get(6), 512, "resource_cache_budget_mib").unwrap_or_else(|error| {
            eprintln!("{error}");
            std::process::exit(2);
        });
    let profile = find_default_cmyk_profile().unwrap_or_else(|| {
        eprintln!("không tìm thấy backend/app/assets/icc/FOGRA39.icc");
        std::process::exit(2);
    });
    let fallback_font = load_default_fallback_font().unwrap_or_else(|error| {
        eprintln!("{error}");
        std::process::exit(2);
    });
    let fallback_font_bytes = fallback_font.len();

    // PERF (audit 2026-08-13 §V.1–V.3): probe này chỉ đo; không thay policy/cache runtime.
    // Mỗi process mở đúng một session rồi lặp render để tách cold-open và warm resource.
    let session_started = Instant::now();
    let (mut session, open_timings) = RenderSession::open_with_profile_paths_timed(
        path,
        Some(&profile),
        None,
        RenderIntent::RelativeColorimetric,
    )
    .unwrap_or_else(|error| panic!("không mở được {path}: {error}"));
    session.set_resource_cache_budget(resource_cache_budget_bytes);
    let open_wall_ms = elapsed_ms(session_started);
    let options = || {
        RenderOptions::softproof()
            .with_overprint_simulation(false)
            .with_optional_content_usage(OptionalContentUsage::View)
            .with_annotations(true)
            .with_fallback_font(Arc::clone(&fallback_font))
            .with_memory_budget_bytes(render_budget_bytes)
    };
    let mut samples = Vec::with_capacity(repeats);
    let mut last_rgb_len = 0usize;
    let mut last_width = 0u32;
    let mut last_height = 0u32;
    let mut last_checksum = 0u64;
    let mut last_png_len = 0usize;
    let mut baseline_render_signature: Option<(u32, u32, usize, usize, u64)> = None;
    for iteration in 0..repeats {
        let current_identity = file_identity(path)
            .unwrap_or_else(|error| panic!("không kiểm tra được revision PDF: {error}"));
        if current_identity != source_identity {
            panic!("file PDF thay đổi trong lúc chạy probe; từ chối trộn revision");
        }
        let total_started = Instant::now();
        let render_started = Instant::now();
        let (rendered, timings) = session
            .render_page_srgb_region_timed(1, dpi, PageBox::Crop, options(), clip)
            .unwrap_or_else(|error| panic!("không render được {path}: {error}"));
        let render_wall_ms = elapsed_ms(render_started);
        last_width = rendered.width;
        last_height = rendered.height;
        last_rgb_len = rendered.rgb.len();
        let checksum_started = Instant::now();
        last_checksum = rendered.rgb.iter().fold(0u64, |sum, value| {
            sum.wrapping_mul(16777619).wrapping_add(u64::from(*value))
        });
        let checksum_ms = elapsed_ms(checksum_started);
        let encode_started = Instant::now();
        let png = encode_rgb_png(&rendered.rgb, rendered.width, rendered.height)
            .unwrap_or_else(|error| panic!("không encode được PNG PPE: {error}"));
        let encode_ms = elapsed_ms(encode_started);
        last_png_len = png.len();
        let cache = session.resource_cache_stats();
        let render_signature = (
            rendered.width,
            rendered.height,
            rendered.rgb.len(),
            png.len(),
            last_checksum,
        );
        match baseline_render_signature {
            Some(expected) if expected != render_signature => {
                panic!("kết quả render warm không ổn định giữa các lượt")
            }
            None => baseline_render_signature = Some(render_signature),
            _ => {}
        }
        let total_wall_ms = elapsed_ms(total_started);
        samples.push(format!(
            "{{\"iteration\":{},\"render_wall_ms\":{:.3},\"open_ms\":{:.3},\"parse_ms\":{:.3},\"resource_ms\":{:.3},\"raster_ms\":{:.3},\"color_ms\":{:.3},\"checksum_ms\":{:.3},\"encode_ms\":{:.3},\"total_wall_ms\":{:.3},\"width\":{},\"height\":{},\"rgb_bytes\":{},\"png_bytes\":{},\"cache\":{}}}",
            iteration + 1,
            render_wall_ms,
            duration_ms(timings.open),
            duration_ms(timings.parse),
            duration_ms(timings.resource),
            duration_ms(timings.raster),
            duration_ms(timings.color),
            checksum_ms,
            encode_ms,
            total_wall_ms,
            rendered.width,
            rendered.height,
            rendered.rgb.len(),
            png.len(),
            stats_json(cache),
        ));
    }

    let final_identity = file_identity(path)
        .unwrap_or_else(|error| panic!("không kiểm tra được revision PDF cuối: {error}"));
    if final_identity != source_identity {
        panic!("file PDF thay đổi trước khi chốt probe; từ chối trộn revision");
    }

    black_box(last_checksum);

    println!(
        "{{\"schema_version\":2,\"source_name\":{},\"dpi\":{:.3},\"page\":1,\"clip\":{},\"repeats\":{},\"budgets\":{{\"render_bytes\":{},\"resource_cache_bytes\":{}}},\"viewer_options\":{{\"profile\":\"FOGRA39\",\"profile_sha256\":\"{}\",\"intent\":\"relative\",\"optional_content\":\"view\",\"annotations\":true,\"overprint_simulation\":false,\"fallback_font\":\"DejaVuSans.ttf\",\"fallback_font_bytes\":{},\"fallback_font_sha256\":\"{}\"}},\"open_wall_ms\":{:.3},\"open\":{{\"total_ms\":{:.3},\"file_ms\":{:.3},\"parse_ms\":{:.3},\"resource_ms\":{:.3},\"color_ms\":{:.3}}},\"width\":{},\"height\":{},\"rgb_bytes\":{},\"png_bytes\":{},\"checksum\":{},\"encode\":{{\"kind\":\"flate2-rgb-png-proxy\",\"runtime_equivalent\":false}},\"samples\":[{}]}}",
        json_string(
            Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("pdf"),
        ),
        dpi,
        match clip {
            Some(value) => format!(
                "{{\"x\":{},\"y\":{},\"width\":{},\"height\":{}}}",
                value.x, value.y, value.width, value.height
            ),
            None => "null".to_string(),
        },
        repeats,
        render_budget_bytes,
        resource_cache_budget_bytes,
        FOGRA39_SHA256,
        fallback_font_bytes,
        FALLBACK_FONT_SHA256,
        open_wall_ms,
        duration_ms(open_timings.total),
        duration_ms(open_timings.open),
        duration_ms(open_timings.parse),
        duration_ms(open_timings.resource),
        duration_ms(open_timings.color),
        last_width,
        last_height,
        last_rgb_len,
        last_png_len,
        last_checksum,
        samples.join(","),
    );
}
