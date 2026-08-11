//! Hồi quy cooperative cancellation từ API trang xuống codec ảnh.

use std::io::Write;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::{dictionary, Document, Object, Stream};
use print_engine::color::{ColorManager, RenderIntent};
use print_engine::content::RenderOptions;
use print_engine::image::filters::{
    apply_predictor_with_cancel, decode_chain, decode_chain_with_cancel, PredictorParams,
};
use print_engine::page::PageBox;
use print_engine::session::RenderSession;
use print_engine::{CancelToken, PpeError};

fn zlib(data: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(data)
        .expect("nén fixture phải thành công");
    encoder.finish().expect("chốt fixture phải thành công")
}

fn color_manager() -> Option<ColorManager> {
    ColorManager::from_cmyk_profile(
        Path::new("../backend/app/assets/icc/FOGRA39.icc"),
        RenderIntent::RelativeColorimetric,
    )
    .ok()
}

fn serialize(mut doc: Document) -> Vec<u8> {
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .expect("ghi fixture PDF vào bộ nhớ phải thành công");
    bytes
}

fn build_image_pdf(width: u32, height: u32, encoded: Vec<u8>, flate: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let mut image_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => width as i64,
        "Height" => height as i64,
        "BitsPerComponent" => 8,
        "ColorSpace" => "DeviceGray",
    };
    if flate {
        image_dict.set("Filter", "FlateDecode");
    }
    let image_id = doc.add_object(Stream::new(image_dict, encoded));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 16 0 0 16 0 0 cm /Im0 Do Q".to_vec(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 16.into(), 16.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(page_id)],
            "Count" => 1,
        },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

fn cancel_after(token: CancelToken, delay: Duration) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        thread::sleep(delay);
        token.cancel();
    })
}

fn assert_same_render(left: &print_engine::PageRender, right: &print_engine::PageRender) {
    assert_eq!(left.buffer.width(), right.buffer.width());
    assert_eq!(left.buffer.height(), right.buffer.height());
    assert_eq!(left.buffer.space().len(), right.buffer.space().len());
    for channel in 0..left.buffer.space().len() {
        assert_eq!(left.buffer.plane(channel), right.buffer.plane(channel));
    }
}

#[test]
fn pre_cancelled_page_returns_distinct_cancel_error() {
    let bytes = serialize(build_image_pdf(2, 1, vec![0, 255], false));
    let mut session = RenderSession::open_mem(&bytes, None).expect("session phải mở được");
    let token = CancelToken::new();
    token.cancel();

    let result = session.render_page(
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_cancel_token(token),
    );
    assert!(matches!(result, Err(PpeError::Cancelled)));
}

#[test]
fn cancellation_interrupts_flate_before_full_output() {
    let encoded = zlib(&vec![0x5a; 128 * 1024 * 1024]);
    let filters = vec!["FlateDecode".to_string()];
    let token = CancelToken::new();
    let canceller = cancel_after(token.clone(), Duration::from_millis(2));
    let started = Instant::now();

    let result = decode_chain_with_cancel(&encoded, &filters, &[None], Some(&token));
    canceller.join().expect("luồng hủy không được panic");

    assert!(matches!(result, Err(PpeError::Cancelled)));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "Flate phải quan sát token theo block thay vì giải hết stream"
    );
}

#[test]
fn cancellation_interrupts_png_predictor_between_rows() {
    let columns = 256usize;
    let rows = 128 * 1024usize;
    let data = vec![0u8; rows * (columns + 1)];
    let params = PredictorParams {
        predictor: 15,
        colors: 1,
        bits_per_component: 8,
        columns,
        early_change: true,
    };
    let token = CancelToken::new();
    let canceller = cancel_after(token.clone(), Duration::from_millis(2));

    let result = apply_predictor_with_cancel(&data, params, Some(&token));
    canceller.join().expect("luồng hủy không được panic");
    assert!(matches!(result, Err(PpeError::Cancelled)));
}

#[test]
fn cancelled_image_decode_does_not_populate_session_cache() {
    let width = 8192u32;
    let height = 8192u32;
    let encoded = zlib(&vec![127u8; width as usize * height as usize]);
    let bytes = serialize(build_image_pdf(width, height, encoded, true));
    let mut session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(128 * 1024 * 1024);
    let token = CancelToken::new();
    let canceller = cancel_after(token.clone(), Duration::from_millis(2));

    let result = session.render_page(
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate().with_cancel_token(token),
    );
    canceller.join().expect("luồng hủy không được panic");

    assert!(matches!(result, Err(PpeError::Cancelled)));
    assert_eq!(
        session.resource_cache_stats().bytes,
        0,
        "ảnh giải mã dở không được lọt vào cache session"
    );
}

#[test]
fn uncancelled_token_preserves_exact_pixels() {
    let bytes = serialize(build_image_pdf(2, 1, vec![0, 255], false));
    let mut baseline = RenderSession::open_mem(&bytes, None).expect("session gốc phải mở được");
    let mut cancellable =
        RenderSession::open_mem(&bytes, None).expect("session có token phải mở được");
    let expected = baseline
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render gốc phải thành công");
    let actual = cancellable
        .render_page(
            1,
            72.0,
            PageBox::Crop,
            RenderOptions::ink_accurate().with_cancel_token(CancelToken::new()),
        )
        .expect("token chưa hủy không được đổi kết quả");

    assert_same_render(&expected, &actual);
}

#[test]
fn cancellation_interrupts_lcms_between_batches() {
    let Some(manager) = color_manager() else {
        eprintln!("bỏ qua: không có FOGRA39.icc");
        return;
    };
    let input = vec![[0.25f32, 0.5, 0.75, 0.2]; 4 * 1024 * 1024];
    let token = CancelToken::new();
    let canceller = cancel_after(token.clone(), Duration::from_millis(2));
    let started = Instant::now();

    let result = manager.cmyk_to_srgb_batch_with_cancel(&input, Some(&token));
    canceller.join().expect("luồng hủy không được panic");

    assert!(matches!(result, Err(PpeError::Cancelled)));
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "LCMS phải quan sát token giữa các lô 64K pixel"
    );
}

#[test]
fn uncancelled_lcms_batches_preserve_exact_bytes() {
    let Some(manager) = color_manager() else {
        eprintln!("bỏ qua: không có FOGRA39.icc");
        return;
    };
    let input: Vec<[f32; 4]> = (0..(512 * 1024 + 17))
        .map(|index| {
            let a = (index % 257) as f32 / 256.0;
            [a, 1.0 - a, a * 0.5, a * 0.25]
        })
        .collect();
    let expected = manager
        .cmyk_to_srgb_batch(&input)
        .expect("LCMS gốc phải thành công");
    let actual = manager
        .cmyk_to_srgb_batch_with_cancel(&input, Some(&CancelToken::new()))
        .expect("token chưa hủy không được báo lỗi")
        .expect("LCMS có token phải thành công");
    assert_eq!(expected, actual);
}

/// Chạy riêng ở release để gate overhead; bỏ khỏi suite mặc định vì đây là benchmark.
#[test]
#[ignore = "benchmark release thủ công cho gate Lô 5B"]
fn uncancelled_codec_overhead_stays_below_five_percent() {
    let encoded = zlib(&vec![0x35; 32 * 1024 * 1024]);
    let filters = vec!["FlateDecode".to_string()];
    let mut plain = Vec::new();
    let mut cancellable = Vec::new();

    for round in 0..9 {
        let token = CancelToken::new();
        if round % 2 == 0 {
            let started = Instant::now();
            let expected = decode_chain(&encoded, &filters, &[None]).expect("decode gốc phải đạt");
            plain.push(started.elapsed());
            let started = Instant::now();
            let actual = decode_chain_with_cancel(&encoded, &filters, &[None], Some(&token))
                .expect("decode có token chưa hủy phải đạt");
            cancellable.push(started.elapsed());
            assert_eq!(expected.data, actual.data);
        } else {
            let started = Instant::now();
            let actual = decode_chain_with_cancel(&encoded, &filters, &[None], Some(&token))
                .expect("decode có token chưa hủy phải đạt");
            cancellable.push(started.elapsed());
            let started = Instant::now();
            let expected = decode_chain(&encoded, &filters, &[None]).expect("decode gốc phải đạt");
            plain.push(started.elapsed());
            assert_eq!(expected.data, actual.data);
        }
    }
    plain.sort_unstable();
    cancellable.sort_unstable();
    let base = plain[plain.len() / 2];
    let with_token = cancellable[cancellable.len() / 2];
    eprintln!("median không-token={base:?}, có-token={with_token:?}");
    assert!(
        with_token.as_secs_f64() <= base.as_secs_f64() * 1.05,
        "checkpoint làm chậm quá 5%: {base:?} -> {with_token:?}"
    );
}

#[test]
#[ignore = "benchmark release thủ công cho gate LCMS Lô 5B"]
fn uncancelled_lcms_overhead_stays_below_five_percent() {
    let Some(manager) = color_manager() else {
        eprintln!("bỏ qua: không có FOGRA39.icc");
        return;
    };
    let input = vec![[0.35f32, 0.15, 0.65, 0.4]; 2 * 1024 * 1024];
    let mut plain = Vec::new();
    let mut cancellable = Vec::new();
    for round in 0..7 {
        let token = CancelToken::new();
        if round % 2 == 0 {
            let started = Instant::now();
            let expected = manager
                .cmyk_to_srgb_batch(&input)
                .expect("LCMS gốc phải đạt");
            plain.push(started.elapsed());
            let started = Instant::now();
            let actual = manager
                .cmyk_to_srgb_batch_with_cancel(&input, Some(&token))
                .expect("token chưa hủy không được báo lỗi")
                .expect("LCMS có token phải đạt");
            cancellable.push(started.elapsed());
            assert_eq!(expected, actual);
        } else {
            let started = Instant::now();
            let actual = manager
                .cmyk_to_srgb_batch_with_cancel(&input, Some(&token))
                .expect("token chưa hủy không được báo lỗi")
                .expect("LCMS có token phải đạt");
            cancellable.push(started.elapsed());
            let started = Instant::now();
            let expected = manager
                .cmyk_to_srgb_batch(&input)
                .expect("LCMS gốc phải đạt");
            plain.push(started.elapsed());
            assert_eq!(expected, actual);
        }
    }
    plain.sort_unstable();
    cancellable.sort_unstable();
    let base = plain[plain.len() / 2];
    let with_token = cancellable[cancellable.len() / 2];
    eprintln!("LCMS median không-token={base:?}, có-token={with_token:?}");
    assert!(
        with_token.as_secs_f64() <= base.as_secs_f64() * 1.05,
        "checkpoint LCMS làm chậm quá 5%: {base:?} -> {with_token:?}"
    );
}
