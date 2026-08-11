//! Kiểm thử owner/session của PPE: parity, cache, save-over và invalidate.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use lopdf::{dictionary, Document, Object, Stream};
use print_engine::color::RenderIntent;
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox};
use print_engine::session::RenderSession;

fn build_pdf(gray: u8, marker: &str) -> Document {
    build_pdf_with_image_width(gray, marker, 1)
}

fn build_pdf_with_image_width(gray: u8, marker: &str, image_width: i64) -> Document {
    let mut doc = Document::with_version("1.7");
    let image_id = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => image_width,
            "Height" => 1,
            "BitsPerComponent" => 8,
            "ColorSpace" => "DeviceGray",
        },
        vec![gray; image_width as usize],
    ));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! { "Im0" => Object::Reference(image_id) },
    });
    let content_id = doc.add_object(Stream::new(
        dictionary! {},
        format!("% {marker}\nq 10 0 0 10 0 0 cm /Im0 Do Q").into_bytes(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

fn build_alternating_images_pdf() -> Document {
    let mut doc = Document::with_version("1.7");
    let image_a = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 4096,
            "Height" => 1,
            "BitsPerComponent" => 8,
            "ColorSpace" => "DeviceGray",
        },
        vec![0; 4096],
    ));
    let image_b = doc.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => 4096,
            "Height" => 1,
            "BitsPerComponent" => 8,
            "ColorSpace" => "DeviceGray",
        },
        vec![255; 4096],
    ));
    let resources_id = doc.add_object(dictionary! {
        "XObject" => dictionary! {
            "A" => Object::Reference(image_a),
            "B" => Object::Reference(image_b),
        },
    });
    let warm_content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 10 0 0 10 0 0 cm /A Do Q".to_vec(),
    ));
    let alternating_content_id = doc.add_object(Stream::new(
        dictionary! {},
        b"q 10 0 0 10 0 0 cm /A Do /B Do /A Do Q".to_vec(),
    ));
    let pages_id = (doc.new_object_id().0, 0);
    let warm_page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(warm_content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    let alternating_page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(alternating_content_id),
        "Resources" => Object::Reference(resources_id),
        "MediaBox" => vec![0.into(), 0.into(), 10.into(), 10.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! {
            "Type" => "Pages",
            "Kids" => vec![Object::Reference(warm_page_id), Object::Reference(alternating_page_id)],
            "Count" => 2,
        },
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    });
    doc.trailer.set("Root", Object::Reference(catalog_id));
    doc
}

fn build_pdf_with_broken_smask() -> Document {
    let mut doc = build_pdf(0, "broken-smask");
    let broken_mask = doc.add_object(Object::Null);
    let mut found_image = false;
    for object in doc.objects.values_mut() {
        let Object::Stream(stream) = object else {
            continue;
        };
        let is_image = matches!(
            stream.dict.get(b"Subtype"),
            Ok(Object::Name(name)) if name.as_slice() == b"Image"
        );
        if is_image {
            stream.dict.set("SMask", Object::Reference(broken_mask));
            found_image = true;
            break;
        }
    }
    assert!(found_image, "fixture phải tìm được image stream");
    doc
}

fn serialize(mut doc: Document) -> Vec<u8> {
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .expect("fixture phải serialize được");
    bytes
}

fn assert_same_render(left: &print_engine::PageRender, right: &print_engine::PageRender) {
    assert_eq!(left.buffer.width(), right.buffer.width());
    assert_eq!(left.buffer.height(), right.buffer.height());
    assert_eq!(left.buffer.space().len(), right.buffer.space().len());
    for channel in 0..left.buffer.space().len() {
        assert_eq!(left.buffer.plane(channel), right.buffer.plane(channel));
    }
    assert_eq!(left.warnings.ink_unsound(), right.warnings.ink_unsound());
}

#[test]
fn session_render_is_pixel_equal_to_stateless_api() {
    let bytes = serialize(build_pdf(0, "parity"));
    let document = lopdf::Document::load_mem(&bytes).expect("fixture phải mở được");
    let stateless = render_page(
        &document,
        1,
        72.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
    )
    .expect("stateless render phải thành công");
    let mut session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(1024 * 1024);
    let through_session = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("session render phải thành công");
    assert_same_render(&stateless, &through_session);
    assert_eq!(session.page_count(), 1);
    assert_eq!(session.resource_cache_stats().page_hits, 1);
}

#[test]
fn session_reuses_image_resource_without_changing_output() {
    let bytes = serialize(build_pdf(0, "cache"));
    let document = lopdf::Document::load_mem(&bytes).expect("fixture phải mở được");
    let expected_second = render_page(
        &document,
        1,
        144.0,
        PageBox::Crop,
        RenderOptions::ink_accurate(),
    )
    .expect("stateless render phải thành công");
    let mut session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(1024 * 1024);
    let first = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("lần render đầu phải thành công");
    let second = session
        .render_page(1, 144.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("lần render thứ hai phải thành công");
    assert_same_render(&expected_second, &second);
    assert_eq!(first.buffer.max_tac_percent(), 100.0);
    assert_eq!(second.buffer.max_tac_percent(), 100.0);
    let stats = session.resource_cache_stats();
    assert!(stats.image_hits >= 1, "cache phải có hit: {stats:?}");
    assert!(stats.bytes > 0, "cache phải ghi nhận byte: {stats:?}");
    assert_eq!(stats.page_hits, 2);
}

#[test]
fn save_over_refreshes_identity_and_drops_old_bitmap_source() {
    let path = unique_temp_path("ppe-session-save-over");
    let mut first_doc = build_pdf(0, "old");
    first_doc
        .save(&path)
        .expect("ghi fixture đầu phải thành công");
    let mut session = RenderSession::open(&path).expect("session phải mở được");
    let old_generation = session.generation();
    let old = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render cũ phải thành công");
    assert_eq!(old.buffer.max_tac_percent(), 100.0);

    let mut replacement = build_pdf(255, "replacement-with-a-longer-marker");
    replacement
        .save(&path)
        .expect("ghi fixture thay thế phải thành công");
    assert!(session.is_stale(), "session phải nhận ra save-over");
    let (new, timings) = session
        .render_page_region_timed(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate(), None)
        .expect("render phải tự refresh và trả trang mới");
    assert!(session.generation() > old_generation);
    assert!(
        timings.open > Duration::ZERO && timings.parse > Duration::ZERO,
        "save-over phải được phân vào open/parse thay vì resource: {timings:?}"
    );
    assert_eq!(new.buffer.max_tac_percent(), 0.0);
    let _ = std::fs::remove_file(path);
}

#[test]
fn invalidate_closes_document_and_clears_resource_cache() {
    let bytes = serialize(build_pdf(0, "invalidate"));
    let mut session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(1024 * 1024);
    session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công");
    session.invalidate();
    assert!(!session.is_valid());
    assert_eq!(session.page_count(), 0);
    assert_eq!(session.resource_cache_stats().bytes, 0);
    assert!(session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .is_err());
}

#[test]
fn memory_label_is_not_treated_as_a_save_over_source() {
    let bytes = serialize(build_pdf(0, "memory-label"));
    let label = Path::new("nhan-khong-ton-tai.pdf");
    let mut session = RenderSession::open_mem(&bytes, Some(label)).expect("session phải mở được");
    assert_eq!(
        session.identity().document.canonical_path.as_deref(),
        Some(label)
    );
    assert!(!session.is_stale(), "nhãn bộ nhớ không phải file nguồn");
    session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("session từ bộ nhớ có nhãn vẫn phải render được");
}

#[test]
fn closed_file_session_cannot_be_resurrected_by_refresh() {
    let path = unique_temp_path("ppe-session-close");
    let mut first_doc = build_pdf(0, "before-close");
    first_doc
        .save(&path)
        .expect("ghi fixture đầu phải thành công");
    let mut session = RenderSession::open(&path).expect("session phải mở được");
    session.close();

    let mut replacement = build_pdf(255, "replacement-after-close");
    replacement
        .save(&path)
        .expect("ghi fixture thay thế phải thành công");
    assert!(session.refresh_if_changed().is_err());
    assert!(!session.is_valid());
    assert!(session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .is_err());
    let _ = std::fs::remove_file(path);
}

#[test]
fn refresh_loi_tam_thoi_khong_lam_session_chet_vinh_vien() {
    let path = unique_temp_path("ppe-session-transient-save");
    let mut first_doc = build_pdf(0, "before-partial-save");
    first_doc
        .save(&path)
        .expect("ghi fixture đầu phải thành công");
    let mut session = RenderSession::open(&path).expect("session phải mở được");
    let old_generation = session.generation();

    std::fs::write(&path, b"%PDF-1.7\nfile-dang-ghi-do")
        .expect("phải mô phỏng được file đang ghi dở");
    assert!(session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .is_err());
    assert!(
        session.is_valid(),
        "lỗi refresh tạm thời không được đóng terminal session"
    );
    assert_eq!(session.generation(), old_generation);

    let mut replacement = build_pdf(255, "after-partial-save-completes");
    replacement
        .save(&path)
        .expect("ghi replacement hoàn chỉnh phải thành công");
    let rendered = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("request sau phải tự refresh lại");
    assert_eq!(rendered.buffer.max_tac_percent(), 0.0);
    assert!(session.generation() > old_generation);
    let _ = std::fs::remove_file(path);
}

#[test]
fn insufficient_session_cache_budget_preserves_pixels() {
    let bytes = serialize(build_pdf_with_image_width(0, "tiny-cache", 2));
    let mut session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(1);
    let first = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("lần render đầu phải thành công");
    let second = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("lần render sau phải thành công dù cache thiếu ngân sách");
    assert_same_render(&first, &second);
    let stats = session.resource_cache_stats();
    assert_eq!(
        stats.bytes, 0,
        "entry vượt budget không được giữ: {stats:?}"
    );
    assert_eq!(stats.image_hits, 0, "không được báo hit giả: {stats:?}");
}

#[test]
fn warm_session_cache_does_not_thrash_repeated_images_within_one_render() {
    let bytes = serialize(build_alternating_images_pdf());
    let mut session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(5_000);
    session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("trang đầu phải làm ấm ảnh A");
    session
        .render_page(2, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("chuỗi ảnh A-B-A phải render được");
    let stats = session.resource_cache_stats();
    assert_eq!(
        stats.image_misses, 2,
        "A thứ hai phải lấy từ cache cục bộ thay vì làm cache session thrash: {stats:?}"
    );
    assert_eq!(
        stats.image_hits, 1,
        "A đầu trang 2 phải hit cache session: {stats:?}"
    );
    assert_eq!(
        stats.image_evictions, 1,
        "cache phải đẩy đúng một ảnh: {stats:?}"
    );
}

#[test]
fn warm_image_cache_replays_decode_warnings() {
    let bytes = serialize(build_pdf_with_broken_smask());
    let mut session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(1024 * 1024);
    let cold = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("cold render phải thành công và báo SMask lỗi");
    let warm = session
        .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("warm render phải thành công và phát lại warning");
    assert_same_render(&cold, &warm);
    assert!(cold.warnings.unsupported_transparency);
    assert!(warm.warnings.unsupported_transparency);
    assert_eq!(cold.warnings.skipped_ops, warm.warnings.skipped_ops);
}

#[test]
fn shared_session_serializes_two_concurrent_owners() {
    let bytes = serialize(build_pdf(0, "concurrent"));
    let session = RenderSession::open_mem(&bytes, None)
        .expect("session phải mở được")
        .with_resource_cache_budget(1024 * 1024)
        .into_shared();
    let mut workers = Vec::new();
    for _ in 0..2 {
        let shared = Arc::clone(&session);
        workers.push(thread::spawn(move || {
            let mut owner = shared.lock().expect("owner phải lock được");
            owner
                .render_page(1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
                .expect("owner render phải thành công")
                .buffer
                .max_tac_percent()
        }));
    }
    for worker in workers {
        assert_eq!(worker.join().expect("worker không được panic"), 100.0);
    }
    let stats = session
        .lock()
        .expect("session phải còn sống")
        .resource_cache_stats();
    assert_eq!(stats.page_hits, 2);
    assert!(
        stats.image_hits >= 1,
        "owner sau phải dùng cache: {stats:?}"
    );
}

#[test]
fn profiled_session_returns_srgb_and_separate_stage_timings() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate phải nằm trong repo");
    let cmyk = root.join("backend/app/assets/icc/FOGRA39.icc");
    if !cmyk.is_file() {
        eprintln!("bỏ qua: không có FOGRA39.icc");
        return;
    }
    let path = unique_temp_path("ppe-session-srgb");
    let mut document = build_pdf(0, "srgb-session");
    document.save(&path).expect("ghi fixture phải thành công");
    let (mut session, open_timings) = RenderSession::open_with_profile_paths_timed(
        &path,
        Some(&cmyk),
        None,
        RenderIntent::RelativeColorimetric,
    )
    .expect("session có profile phải mở được");
    session.set_resource_cache_budget(1024 * 1024);
    let (rendered, timings) = session
        .render_page_srgb_region_timed(
            1,
            72.0,
            PageBox::Crop,
            RenderOptions::softproof().with_memory_budget_bytes(16 * 1024 * 1024),
            None,
        )
        .expect("session phải quy được mực sang sRGB");
    assert_eq!(
        rendered.rgb.len(),
        rendered.width as usize * rendered.height as usize * 3
    );
    assert!(open_timings.total >= open_timings.parse);
    assert!(timings.raster > Duration::ZERO);
    assert!(timings.color > Duration::ZERO);
    let _ = std::fs::remove_file(path);
}

fn unique_temp_path(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock phải hợp lệ")
        .as_nanos();
    std::env::temp_dir().join(format!("{label}-{}-{nanos}.pdf", std::process::id()))
}
