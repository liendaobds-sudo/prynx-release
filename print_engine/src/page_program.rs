//! Chương trình trang đã giải mã cho đường render lặp của Viewer.
//!
//! Cache chỉ giữ operator và ảnh nội tuyến bất biến. Resource scope, CTM, clip và
//! trạng thái màu vẫn được phân giải lại khi thực thi, kể cả với Form lồng nhau.

use lopdf::content::{Content, Operation};
use lopdf::Object;

use crate::content::inline_image::extract_inline_images;
use crate::error::{PpeError, PpeResult};
use crate::pdf::DecodeQuality;

/// PERF (audit 2026-09-11 §PPEBX.2): provenance giải nén đi cùng chương trình;
/// cảnh báo do clip/visibility vẫn được phát riêng cho từng invocation.
#[derive(Debug)]
pub(crate) struct FormProgram {
    pub program: PageProgram,
    pub quality: DecodeQuality,
}

impl FormProgram {
    pub fn memory_bytes(&self) -> usize {
        self.program
            .memory_bytes()
            .saturating_add(std::mem::size_of::<Self>())
    }
}

/// Content stream trang sau pha bóc ảnh nội tuyến và tokenize operator.
#[derive(Debug)]
pub struct PageProgram {
    operations: Vec<Operation>,
    inline_images: Vec<Object>,
    failed_inline_images: u32,
    source_bytes: usize,
}

impl PageProgram {
    /// Biên dịch content bytes thành chương trình bất biến, không phụ thuộc DPI/clip.
    pub fn compile(data: &[u8]) -> PpeResult<Self> {
        // PERF (audit 2026-08-09 §L4A): BI phải được bóc trước tokenizer đúng như
        // interpreter cũ; chương trình sở hữu Object ảnh nên replay không mượn buffer tạm.
        let extracted = extract_inline_images(data);
        let content = Content::decode(&extracted.data)
            .map_err(|error| PpeError::ContentStream(format!("{error}")))?;
        Ok(Self {
            operations: content.operations,
            inline_images: extracted.images,
            failed_inline_images: extracted.failed,
            source_bytes: data.len(),
        })
    }

    pub fn operation_count(&self) -> usize {
        self.operations.len()
    }

    pub fn inline_image_count(&self) -> usize {
        self.inline_images.len()
    }

    pub fn source_bytes(&self) -> usize {
        self.source_bytes
    }

    /// Tính vùng nhớ sở hữu, không dùng số byte PDF nén làm kích thước cache.
    pub(crate) fn memory_bytes(&self) -> usize {
        let operations = self.operations.iter().fold(
            self.operations
                .capacity()
                .saturating_mul(std::mem::size_of::<Operation>()),
            |total, op| {
                total
                    .saturating_add(op.operator.capacity())
                    .saturating_add(objects_memory_bytes(&op.operands))
            },
        );
        std::mem::size_of::<Self>()
            .saturating_add(operations)
            .saturating_add(objects_memory_bytes(&self.inline_images))
    }

    pub(crate) fn operations(&self) -> &[Operation] {
        &self.operations
    }

    pub(crate) fn inline_images(&self) -> &[Object] {
        &self.inline_images
    }

    pub(crate) fn failed_inline_images(&self) -> u32 {
        self.failed_inline_images
    }
}

fn objects_memory_bytes(objects: &Vec<Object>) -> usize {
    objects.iter().fold(
        objects
            .capacity()
            .saturating_mul(std::mem::size_of::<Object>()),
        |total, object| total.saturating_add(object_heap_bytes(object)),
    )
}

fn dictionary_memory_bytes(dict: &lopdf::Dictionary) -> usize {
    // IndexMap không công bố capacity. Dictionary vừa parse chưa xóa entry:
    // dự trù cả tăng trưởng Vec/bucket tối thiểu, theo kích thước Object thật.
    let slots = if dict.is_empty() {
        0
    } else {
        dict.len()
            .checked_next_power_of_two()
            .unwrap_or(usize::MAX)
            .saturating_mul(2)
            .max(4)
    };
    let slot_bytes = std::mem::size_of::<(Vec<u8>, Object)>()
        .saturating_add(2 * std::mem::size_of::<usize>() + 1);
    dict.iter()
        .fold(slots.saturating_mul(slot_bytes), |total, (key, value)| {
            total
                .saturating_add(key.capacity())
                .saturating_add(object_heap_bytes(value))
        })
}

fn object_heap_bytes(object: &Object) -> usize {
    match object {
        Object::Name(bytes) | Object::String(bytes, _) => bytes.capacity(),
        Object::Array(items) => objects_memory_bytes(items),
        Object::Dictionary(dict) => dictionary_memory_bytes(dict),
        Object::Stream(stream) => stream
            .content
            .capacity()
            .saturating_add(dictionary_memory_bytes(&stream.dict)),
        // Reference không sở hữu object đích, không lần theo cây PDF để đếm hai lần.
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_memory_accounts_for_dictionary_slots_and_inline_payloads() {
        let dict = lopdf::dictionary! { "One" => Object::Name(vec![b'x'; 300]) };
        let bytes = dictionary_memory_bytes(&dict);
        assert!(bytes >= 4 * std::mem::size_of::<(Vec<u8>, Object)>() + 300);
        let nested = lopdf::dictionary! { "Child" => dict.clone() };
        assert!(dictionary_memory_bytes(&nested) > bytes);
        let raw = b"q BI /W 3 /H 1 /BPC 8 /CS /G ID \x01\x02\x03 EI Q";
        let program = PageProgram::compile(raw).unwrap();
        assert_eq!(program.inline_image_count(), 1);
        assert!(program.memory_bytes() > program.source_bytes());
    }

    #[test]
    fn compile_giu_operator_va_anh_noi_tuyen_de_replay() {
        let data = b"q BI /W 1 /H 1 /BPC 8 /CS /G ID \x7f EI 0 0 10 10 re f Q";
        let program = PageProgram::compile(data).unwrap();

        assert_eq!(program.inline_image_count(), 1);
        assert_eq!(program.failed_inline_images(), 0);
        assert_eq!(program.source_bytes(), data.len());
        assert!(program.operation_count() >= 5);
    }

    #[test]
    fn compile_giu_tinh_khoan_dung_cua_tokenizer_cu() {
        // lopdf hiện coi chuỗi dở dang này là stream không có operator. PageProgram
        // phải giữ đúng semantics cũ, không biến lô hiệu năng thành đổi correctness.
        let program = PageProgram::compile(b"[( chuoi khong ket thuc").unwrap();
        assert_eq!(program.operation_count(), 0);
    }

    #[test]
    #[ignore = "benchmark thủ công cần PRYNX_PAGE_PROGRAM_BENCH_PDF"]
    fn benchmark_decode_page_program_pdf_that() {
        use std::time::Instant;

        let path = std::env::var("PRYNX_PAGE_PROGRAM_BENCH_PDF")
            .expect("đặt PRYNX_PAGE_PROGRAM_BENCH_PDF tới PDF cần đo");
        let doc = lopdf::Document::load(&path).expect("mở PDF benchmark");
        let page_id = *doc.get_pages().get(&1).expect("PDF phải có trang 1");
        let bytes = doc.get_page_content(page_id);
        let mut samples = Vec::new();
        let mut operation_count = 0;
        for _ in 0..21 {
            let started = Instant::now();
            let program = PageProgram::compile(&bytes).expect("decode PageProgram");
            samples.push(started.elapsed().as_secs_f64() * 1_000.0);
            operation_count = program.operation_count();
        }
        samples.sort_by(f64::total_cmp);
        eprintln!(
            "PAGE_PROGRAM_DECODE bytes={} operations={} median_ms={:.3} p95_ms={:.3}",
            bytes.len(),
            operation_count,
            samples[10],
            samples[19]
        );
    }

    #[test]
    #[ignore = "benchmark thủ công cần PRYNX_PAGE_PROGRAM_BENCH_PDF"]
    fn benchmark_session_viewport_theo_pha_tren_pdf_that() {
        use std::path::Path;

        use crate::color::RenderIntent;
        use crate::content::RenderOptions;
        use crate::page::{PageBox, RasterClip};
        use crate::RenderSession;

        let path = std::env::var("PRYNX_PAGE_PROGRAM_BENCH_PDF")
            .expect("đặt PRYNX_PAGE_PROGRAM_BENCH_PDF tới PDF cần đo");
        let profile =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../backend/app/assets/icc/FOGRA39.icc");
        let mut session = RenderSession::open_with_profile_paths(
            &path,
            Some(&profile),
            None,
            RenderIntent::RelativeColorimetric,
        )
        .expect("mở RenderSession benchmark");
        let options = RenderOptions::softproof().with_overprint_simulation(true);

        for (label, dpi, clip) in [
            ("full-96-cold", 96.0, None),
            ("full-96-warm", 96.0, None),
            (
                "viewport-600-warm-1",
                600.0,
                Some(RasterClip {
                    x: 0,
                    y: 0,
                    width: 1600,
                    height: 900,
                }),
            ),
            (
                "viewport-600-warm-2",
                600.0,
                Some(RasterClip {
                    x: 0,
                    y: 0,
                    width: 1600,
                    height: 900,
                }),
            ),
            (
                "viewport-600-warm-3",
                600.0,
                Some(RasterClip {
                    x: 0,
                    y: 0,
                    width: 1600,
                    height: 900,
                }),
            ),
        ] {
            let started = std::time::Instant::now();
            let (rendered, timing) = session
                .render_page_srgb_region_timed(1, dpi, PageBox::Crop, options.clone(), clip)
                .expect("render benchmark");
            let rgb_hash = rendered
                .rgb
                .iter()
                .fold(0xcbf29ce484222325_u64, |hash, byte| {
                    (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
                });
            eprintln!(
                "SESSION_PHASE label={} size={}x{} rgb_hash={:016x} wall_ms={:.3} open_ms={:.3} parse_ms={:.3} resource_ms={:.3} raster_ms={:.3} color_ms={:.3}",
                label,
                rendered.width,
                rendered.height,
                rgb_hash,
                started.elapsed().as_secs_f64() * 1_000.0,
                timing.open.as_secs_f64() * 1_000.0,
                timing.parse.as_secs_f64() * 1_000.0,
                timing.resource.as_secs_f64() * 1_000.0,
                timing.raster.as_secs_f64() * 1_000.0,
                timing.color.as_secs_f64() * 1_000.0,
            );
        }
    }
}
