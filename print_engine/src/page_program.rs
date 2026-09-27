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
    operations: Box<[Operation]>,
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
        let tokens = normalize_content_tokens(&extracted.data);
        let content = Content::decode(&tokens)
            .map_err(|error| PpeError::ContentStream(format!("{error}")))?;
        // PERF (audit 2026-09-23 §R23.PROGRAM): tokenizer cấp tối thiểu 4 slot
        // operand kể cả q/Q không có operand. Chương trình đã bất biến nên nhả
        // capacity tăng trưởng trước khi giữ trong cache; không đổi token/giá trị.
        let mut operations = content.operations.into_boxed_slice();
        for operation in &mut operations {
            match operation.operator.as_str() {
                "pxTypeZero" => operation.operator = "d0".into(),
                "pxTypeOne" => operation.operator = "d1".into(),
                _ => {}
            }
            operation.operands = std::mem::take(&mut operation.operands)
                .into_boxed_slice().into_vec();
        }
        Ok(Self {
            operations,
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
                .len()
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

/// PERF/CORRECTNESS (audit 2026-09-25 §R25.GPU.19): lopdf 0.44 chỉ đọc phần chữ
/// của d0/d1, làm hậu tố số nhiễm vào operands kế tiếp. Chỉ thay token operator;
/// giữ nguyên string, name, hex và payload ảnh đã được bóc riêng. Comment đổi
/// thành khoảng trắng vì lopdf có thể dừng sớm khi sau comment là dòng thụt vào.
fn normalize_content_tokens(data:&[u8])->std::borrow::Cow<'_,[u8]>{
    let delimiter=|c:u8|c.is_ascii_whitespace() || b"()<>[]{}/%".contains(&c);
    let mut at=0;let mut copied=0;let mut output=Vec::new();
    while at<data.len(){match data[at]{
        b'%'=>{let start=at;while at<data.len() && data[at]!=b'\n' && data[at]!=b'\r'{at+=1;}
            output.extend_from_slice(&data[copied..start]);output.push(b' ');copied=at;},
        b'('=>{at+=1;let mut depth=1;while at<data.len() && depth>0{match data[at]{b'\\'=>{at=(at+2).min(data.len());continue;},b'('=>depth+=1,b')'=>depth-=1,_=>{}}at+=1;}},
        b'/'=>{at+=1;while at<data.len() && !delimiter(data[at]){at+=1;}},
        b'<' if data.get(at+1)!=Some(&b'<')=>{at+=1;while at<data.len() && data[at]!=b'>'{at+=1;}at=(at+1).min(data.len());},
        b'<' if data.get(at+1)==Some(&b'<')=>{at+=2;},
        c if delimiter(c)=>{at+=1;},
        _=>{let start=at;while at<data.len() && !delimiter(data[at]){at+=1;}
            let replacement:Option<&[u8]>=match &data[start..at]{b"d0"=>Some(b"pxTypeZero"),b"d1"=>Some(b"pxTypeOne"),_=>None};
            if let Some(replacement)=replacement{output.extend_from_slice(&data[copied..start]);output.extend_from_slice(replacement);copied=at;}
        },
    }}
    if copied==0{std::borrow::Cow::Borrowed(data)}else{output.extend_from_slice(&data[copied..]);std::borrow::Cow::Owned(output)}
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
    fn type3_width_suffix_does_not_shift_next_operator_or_touch_literals(){
        let p=PageProgram::compile(b"500 0 0 0 500 700 d1 0 0 500 700 re f /d1 (d0 (d1) \\)) Tj % d0\n 500 0 d0 3 4 m").unwrap();
        assert_eq!(p.operations[0].operator,"d1");assert_eq!(p.operations[1].operands.len(),4);
        assert_eq!(p.operations[1].operands[0],Object::Integer(0));
        assert_eq!(p.operations[3].operands[0],Object::Name(b"d1".to_vec()));
        assert_eq!(p.operations[4].operator,"d0");assert_eq!(p.operations[5].operands,vec![Object::Integer(3),Object::Integer(4)]);
    }

    #[test]
    fn compiled_program_releases_operand_capacity_without_changing_tokens() {
        let data = b"q 1 2 m 3 4 l 1 2 3 4 5 6 c h f Q /Spot cs [(text) -12.5] TJ\n".repeat(127);
        let expected = Content::decode(&data).unwrap().encode().unwrap();
        let program = PageProgram::compile(&data).unwrap();
        assert_eq!(Content { operations: program.operations() }.encode().unwrap(), expected);
        for op in program.operations() {
            assert_eq!(op.operands.capacity(), op.operands.len(),
                "operator {} còn giữ slot operand chưa dùng", op.operator);
        }
    }

    #[test]
    #[ignore = "benchmark thủ công cần PRYNX_THUMB_SESSION_BENCH_PDF"]
    fn benchmark_session_thumbnail_sequence_real_pdf() {
        use std::path::Path;
        use std::sync::Arc;
        use std::time::Instant;
        use crate::color::RenderIntent;
        use crate::content::RenderOptions;
        use crate::oc::OptionalContentUsage;
        use crate::page::PageBox;
        use crate::RenderSession;

        let path = std::env::var("PRYNX_THUMB_SESSION_BENCH_PDF").expect("thiếu PDF probe");
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let profile = root.join("backend/app/assets/icc/FOGRA39.icc");
        let font = Arc::new(std::fs::read(root.join("backend/app/assets/fonts/DejaVuSans.ttf")).unwrap());
        let cache_mib: usize = std::env::var("PRYNX_THUMB_SESSION_BENCH_CACHE_MIB")
            .unwrap_or_else(|_| "512".into()).parse().unwrap();
        let render_mib: usize = std::env::var("PRYNX_THUMB_SESSION_BENCH_RENDER_MIB")
            .unwrap_or_else(|_| "4096".into()).parse().unwrap();
        let opened = Instant::now();
        let mut session = RenderSession::open_with_profile_paths(&path, Some(&profile), None,
            RenderIntent::RelativeColorimetric).unwrap()
            .with_resource_cache_budget(cache_mib.checked_mul(1024 * 1024).unwrap());
        let open_ms = opened.elapsed().as_secs_f64() * 1000.0;
        let sequence = std::iter::once((1, 92.0))
            .chain((0..2).flat_map(|_| (1..=session.page_count()).map(|page| (page, 24.0))))
            .collect::<Vec<_>>();
        let mut samples = Vec::new();
        for (page, dpi) in sequence {
            let started = Instant::now();
            let (rendered, timing) = session.render_page_srgb_region_timed(page, dpi, PageBox::Crop,
                RenderOptions::softproof().with_overprint_simulation(false)
                    .with_optional_content_usage(OptionalContentUsage::View).with_annotations(true)
                    .with_fallback_font(Arc::clone(&font))
                    .with_memory_budget_bytes(render_mib.checked_mul(1024 * 1024).unwrap()), None).unwrap();
            let wall_ms = started.elapsed().as_secs_f64() * 1000.0;
            let checksum = rendered.rgb.iter().fold(0_u64, |sum, byte|
                sum.wrapping_mul(16777619).wrapping_add(u64::from(*byte)));
            let stats = session.resource_cache_stats();
            samples.push(format!(
                "{{\"page\":{page},\"dpi\":{dpi},\"width\":{},\"height\":{},\"checksum_decimal\":\"{checksum}\",\"wall_ms\":{wall_ms:.3},\"raster_ms\":{:.3},\"color_ms\":{:.3},\"ink_unsound\":{},\"degraded\":{},\"cache_bytes\":{},\"form_hits\":{},\"form_misses\":{},\"form_evictions\":{},\"image_hits\":{},\"image_misses\":{}}}",
                rendered.width, rendered.height, timing.raster.as_secs_f64() * 1000.0,
                timing.color.as_secs_f64() * 1000.0, rendered.warnings.ink_unsound(),
                rendered.warnings.degrades_accuracy(), stats.bytes, stats.form_hits,
                stats.form_misses, stats.form_evictions, stats.image_hits, stats.image_misses));
        }
        eprintln!("THUMB_SESSION_PROBE {{\"open_ms\":{open_ms:.3},\"cache_mib\":{cache_mib},\"render_mib\":{render_mib},\"samples\":[{}]}}", samples.join(","));
        session.close();
    }

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
