//! Regression cho provenance khi PDF stream chỉ phục hồi được từ payload raw.

use std::io::Write;

use flate2::write::ZlibEncoder;
use flate2::Compression;
use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use print_engine::color::space::OutputPreviewFilter;
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};
use print_engine::pdf::{decode_stream, DecodeQuality};

const PAGE: i64 = 100;
const FORM_REASON: &str = "Do Form (không giải nén được content stream)";
const SMASK_REASON: &str = "SMask /G (content stream chỉ phục hồi được)";
const PATTERN_REASON: &str = "Pattern (content stream chỉ phục hồi được)";
const TYPE3_REASON: &str = "Type3 CharProc (content stream chỉ phục hồi được)";
const ANNOTATION_REASON: &str = "Annotation appearance chỉ phục hồi được content stream";

fn pdf_rect(values: [i64; 4]) -> Vec<Object> {
    values.into_iter().map(Object::Integer).collect()
}

fn raw_flate_stream(mut dict: Dictionary, content: &[u8]) -> Stream {
    dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    Stream::new(dict, content.to_vec())
}

fn zlib(payload: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(payload).unwrap();
    encoder.finish().unwrap()
}

fn asciihex(payload: &[u8]) -> Vec<u8> {
    let mut encoded = String::with_capacity(payload.len() * 2 + 1);
    for byte in payload {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02X}").unwrap();
    }
    encoded.push('>');
    encoded.into_bytes()
}

fn lzw(payload: &[u8], early_change: bool, min_size: u8) -> Vec<u8> {
    let mut encoder = if early_change {
        weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, min_size)
    } else {
        weezl::encode::Encoder::new(weezl::BitOrder::Msb, min_size)
    };
    encoder
        .encode(payload)
        .expect("fixture LZW phải encode được")
}

fn pack_lzw_9bit_codes(codes: &[u16]) -> Vec<u8> {
    let mut output = Vec::new();
    let mut accumulator = 0u32;
    let mut bit_count = 0u32;
    for code in codes {
        assert!(*code < 512);
        accumulator = (accumulator << 9) | u32::from(*code);
        bit_count += 9;
        while bit_count >= 8 {
            bit_count -= 8;
            output.push((accumulator >> bit_count) as u8);
            accumulator &= (1u32 << bit_count).wrapping_sub(1);
        }
    }
    if bit_count > 0 {
        output.push((accumulator << (8 - bit_count)) as u8);
    }
    output
}

fn finish_document(
    mut doc: Document,
    content: &[u8],
    resources: Dictionary,
    annotations: Vec<Object>,
) -> Document {
    let content_id = doc.add_object(Stream::new(dictionary! {}, content.to_vec()));
    let pages_id = doc.new_object_id();
    let mut page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "Resources" => Object::Dictionary(resources),
        "MediaBox" => pdf_rect([0, 0, PAGE, PAGE]),
    };
    if !annotations.is_empty() {
        page.set("Annots", annotations);
    }
    let page_id = doc.add_object(page);
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

fn render_with_options(doc: &Document, options: RenderOptions) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, options)
        .expect("PDF stream synthetic phải render được")
}

fn render(doc: &Document, annotations: bool) -> PageRender {
    render_with_options(
        doc,
        RenderOptions::ink_accurate().with_annotations(annotations),
    )
}

fn warning_count(rendered: &PageRender, reason: &str) -> u32 {
    rendered
        .warnings
        .skipped_ops
        .iter()
        .find(|(current, _)| current == reason)
        .map_or(0, |(_, count)| *count)
}

fn any_ink(rendered: &PageRender) -> bool {
    (0..rendered.buffer.space().len()).any(|channel| {
        rendered
            .buffer
            .plate_u8(channel)
            .iter()
            .any(|value| *value > 0)
    })
}

fn form_document(visible: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let matrix = if visible {
        vec![1.into(), 0.into(), 0.into(), 1.into(), 0.into(), 0.into()]
    } else {
        vec![1.into(), 0.into(), 0.into(), 1.into(), 200.into(), 0.into()]
    };
    let form_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => pdf_rect([0, 0, 100, 100]),
            "Matrix" => matrix,
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 0 0 100 100 re f",
    ));
    finish_document(
        doc,
        b"/Fm Do",
        dictionary! { "XObject" => dictionary! { "Fm" => Object::Reference(form_id) } },
        Vec::new(),
    )
}

fn form_inside_clip_hole_document() -> Document {
    let mut doc = Document::with_version("1.7");
    let form_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => pdf_rect([30, 30, 70, 70]),
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 30 30 40 40 re f",
    ));
    finish_document(
        doc,
        b"0 0 100 100 re 20 20 60 60 re W* n /Fm Do",
        dictionary! { "XObject" => dictionary! { "Fm" => Object::Reference(form_id) } },
        Vec::new(),
    )
}

fn pattern_document(visible: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let pattern_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "Type" => "Pattern",
            "PatternType" => 1,
            "PaintType" => 1,
            "TilingType" => 1,
            "BBox" => pdf_rect([0, 0, 100, 100]),
            "XStep" => 100,
            "YStep" => 100,
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 0 0 100 100 re f",
    ));
    let path = if visible {
        "0 0 100 100 re f"
    } else {
        "200 200 20 20 re f"
    };
    finish_document(
        doc,
        format!("/Pattern cs /P scn {path}").as_bytes(),
        dictionary! { "Pattern" => dictionary! { "P" => Object::Reference(pattern_id) } },
        Vec::new(),
    )
}

fn type3_document(visible: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let char_proc_id = doc.add_object(raw_flate_stream(
        dictionary! {},
        b"1000 0 d0 0 0 0 1 k 0 0 1000 1000 re f",
    ));
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type3",
        "Name" => "F0",
        "FontBBox" => pdf_rect([0, 0, 1000, 1000]),
        "FontMatrix" => vec![
            Object::Real(0.001), 0.into(), 0.into(), Object::Real(0.001), 0.into(), 0.into(),
        ],
        "CharProcs" => dictionary! { "A" => Object::Reference(char_proc_id) },
        "Encoding" => dictionary! {
            "Type" => "Encoding",
            "Differences" => vec![65.into(), Object::Name(b"A".to_vec())],
        },
        "FirstChar" => 65,
        "LastChar" => 65,
        "Widths" => vec![1000.into()],
        "Resources" => dictionary! {},
    });
    let x = if visible { 10 } else { 200 };
    finish_document(
        doc,
        format!("BT /F0 80 Tf 1 0 0 1 {x} 10 Tm (A) Tj ET").as_bytes(),
        dictionary! { "Font" => dictionary! { "F0" => Object::Reference(font_id) } },
        Vec::new(),
    )
}

fn soft_mask_document(paint_host: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let group_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => pdf_rect([0, 0, 100, 100]),
            "Group" => dictionary! { "S" => "Transparency" },
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 0 0 100 100 re f",
    ));
    let content = if paint_host {
        b"/GS gs 0 0 0 1 k 0 0 100 100 re f".as_slice()
    } else {
        b"/GS gs".as_slice()
    };
    finish_document(
        doc,
        content,
        dictionary! {
            "ExtGState" => dictionary! {
                "GS" => dictionary! {
                    "SMask" => dictionary! {
                        "S" => "Alpha",
                        "G" => Object::Reference(group_id),
                    },
                },
            },
        },
        Vec::new(),
    )
}

fn annotation_document(visible: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let appearance_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Form",
            "BBox" => pdf_rect([0, 0, 100, 100]),
            "Resources" => dictionary! {},
        },
        b"0 0 0 1 k 0 0 100 100 re f",
    ));
    let rect = if visible {
        [10, 10, 90, 90]
    } else {
        [120, 120, 150, 150]
    };
    let annotation_id = doc.add_object(dictionary! {
        "Type" => "Annot",
        "Subtype" => "Stamp",
        "Rect" => pdf_rect(rect),
        "AP" => dictionary! { "N" => Object::Reference(appearance_id) },
    });
    finish_document(
        doc,
        b"",
        Dictionary::new(),
        vec![Object::Reference(annotation_id)],
    )
}

fn recovered_mesh_document() -> Document {
    let mut doc = Document::with_version("1.7");
    let shading_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "ShadingType" => 4,
            "ColorSpace" => "DeviceCMYK",
            "BitsPerCoordinate" => 8,
            "BitsPerComponent" => 8,
            "BitsPerFlag" => 8,
            "Decode" => vec![
                0.into(), 100.into(), 0.into(), 100.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
            ],
        },
        b"raw bytes khong phai bitstream mesh",
    ));
    finish_document(
        doc,
        b"/Sh sh",
        dictionary! { "Shading" => dictionary! { "Sh" => Object::Reference(shading_id) } },
        Vec::new(),
    )
}

fn recovered_mesh_pattern_document() -> Document {
    let mut doc = Document::with_version("1.7");
    let shading_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "ShadingType" => 4,
            "ColorSpace" => "DeviceCMYK",
            "BitsPerCoordinate" => 8,
            "BitsPerComponent" => 8,
            "BitsPerFlag" => 8,
            "Decode" => vec![
                0.into(), 100.into(), 0.into(), 100.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
                0.into(), 1.into(), 0.into(), 1.into(),
            ],
        },
        b"raw bytes khong phai bitstream mesh",
    ));
    let pattern_id = doc.add_object(dictionary! {
        "Type" => "Pattern",
        "PatternType" => 2,
        "Shading" => Object::Reference(shading_id),
    });
    finish_document(
        doc,
        b"/Pattern cs /P scn 0 0 100 100 re f",
        dictionary! { "Pattern" => dictionary! { "P" => Object::Reference(pattern_id) } },
        Vec::new(),
    )
}

fn recovered_calrgb_mesh_document(pattern: bool) -> Document {
    let mut doc = Document::with_version("1.7");
    let cal_rgb = Object::Array(vec![
        Object::Name(b"CalRGB".to_vec()),
        Object::Dictionary(dictionary! {
            "WhitePoint" => vec![Object::Real(1.0), Object::Real(1.0), Object::Real(1.0)],
        }),
    ]);
    let shading_id = doc.add_object(raw_flate_stream(
        dictionary! {
            "ShadingType" => 4,
            "ColorSpace" => cal_rgb,
            "BitsPerCoordinate" => 8,
            "BitsPerComponent" => 8,
            "BitsPerFlag" => 8,
            "Decode" => vec![
                0.into(), 100.into(), 0.into(), 100.into(),
                0.into(), 1.into(), 0.into(), 1.into(), 0.into(), 1.into(),
            ],
        },
        b"raw bytes khong phai bitstream mesh",
    ));

    if pattern {
        let pattern_id = doc.add_object(dictionary! {
            "Type" => "Pattern",
            "PatternType" => 2,
            "Shading" => Object::Reference(shading_id),
        });
        finish_document(
            doc,
            b"/Pattern cs /P scn 0 0 100 100 re f",
            dictionary! { "Pattern" => dictionary! { "P" => Object::Reference(pattern_id) } },
            Vec::new(),
        )
    } else {
        finish_document(
            doc,
            b"/Sh sh",
            dictionary! { "Shading" => dictionary! { "Sh" => Object::Reference(shading_id) } },
            Vec::new(),
        )
    }
}

#[test]
fn decode_helper_proves_filter_chain_before_marking_exact() {
    let payload = b"0 0 10 10 re f";
    let mut doc = Document::new();

    let unfiltered = decode_stream(&doc, &Stream::new(dictionary! {}, payload.to_vec()));
    assert_eq!(unfiltered.quality, DecodeQuality::Exact);
    assert_eq!(unfiltered.bytes, payload);

    let compressed = zlib(payload);
    let exact = decode_stream(
        &doc,
        &Stream::new(
            dictionary! { "Filter" => Object::Name(b"FlateDecode".to_vec()) },
            compressed.clone(),
        ),
    );
    assert_eq!(exact.quality, DecodeQuality::Exact);
    assert_eq!(exact.bytes, payload);

    let filter_id = doc.add_object(Object::Name(b"FlateDecode".to_vec()));
    let indirect = decode_stream(
        &doc,
        &Stream::new(
            dictionary! { "Filter" => Object::Reference(filter_id) },
            compressed.clone(),
        ),
    );
    assert_eq!(indirect.quality, DecodeQuality::Exact);
    assert_eq!(indirect.bytes, payload);

    let valid_chain = decode_stream(
        &doc,
        &Stream::new(
            dictionary! {
                "Filter" => vec![
                    Object::Name(b"ASCIIHexDecode".to_vec()),
                    Object::Name(b"FlateDecode".to_vec()),
                ],
            },
            asciihex(&compressed),
        ),
    );
    assert_eq!(valid_chain.quality, DecodeQuality::Exact);
    assert_eq!(valid_chain.bytes, payload);

    let params_id = doc.add_object(dictionary! {
        "Predictor" => 15,
        "Colors" => 1,
        "BitsPerComponent" => 8,
        "Columns" => 2,
    });
    let predicted = decode_stream(
        &doc,
        &Stream::new(
            dictionary! {
                "Filter" => Object::Name(b"FlateDecode".to_vec()),
                "DecodeParms" => Object::Reference(params_id),
            },
            zlib(&[0, b'A', b'B']),
        ),
    );
    assert_eq!(predicted.quality, DecodeQuality::Exact);
    assert_eq!(predicted.bytes, b"AB");

    let recovered = decode_stream(&doc, &raw_flate_stream(dictionary! {}, payload));
    assert_eq!(recovered.quality, DecodeQuality::Recovered);
    assert_eq!(recovered.bytes, payload);

    let malformed_filter = decode_stream(
        &doc,
        &Stream::new(dictionary! { "Filter" => 7 }, payload.to_vec()),
    );
    assert_eq!(malformed_filter.quality, DecodeQuality::Recovered);

    let corrupt_chain = decode_stream(
        &doc,
        &Stream::new(
            dictionary! {
                "Filter" => vec![
                    Object::Name(b"ASCIIHexDecode".to_vec()),
                    Object::Name(b"FlateDecode".to_vec()),
                ],
            },
            asciihex(payload),
        ),
    );
    assert_eq!(corrupt_chain.quality, DecodeQuality::Recovered);

    let mut truncated = compressed;
    truncated.truncate(truncated.len().saturating_sub(4));
    let truncated = decode_stream(
        &doc,
        &Stream::new(
            dictionary! { "Filter" => Object::Name(b"FlateDecode".to_vec()) },
            truncated,
        ),
    );
    assert_eq!(truncated.quality, DecodeQuality::Recovered);
}

#[test]
fn strict_flate_decode_handles_output_block_boundaries() {
    let doc = Document::new();
    // [PPE FLATE FIX 2026-09-11]: Form sau bù xén có thể gộp hàng trăm KiB
    // operators. Kiểm cả byte sát biên, bội số block và payload khó nén.
    for size in [
        0,
        1,
        65_535,
        65_536,
        65_537,
        131_072,
        354_115,
        356_135,
        2 * 1024 * 1024,
    ] {
        for compressible in [true, false] {
            let mut state = 0x1234_5678u32;
            let payload: Vec<u8> = (0..size)
                .map(|_| {
                    if compressible {
                        b' '
                    } else {
                        state ^= state << 13;
                        state ^= state >> 17;
                        state ^= state << 5;
                        state as u8
                    }
                })
                .collect();
            let decoded = decode_stream(
                &doc,
                &Stream::new(dictionary! { "Filter" => "FlateDecode" }, zlib(&payload)),
            );
            assert_eq!(
                decoded.quality,
                DecodeQuality::Exact,
                "size={size}, compressible={compressible}"
            );
            assert_eq!(
                decoded.bytes, payload,
                "size={size}, compressible={compressible}"
            );
        }
    }
}

#[test]
fn strict_flate_decode_keeps_large_corrupt_streams_recovered() {
    let doc = Document::new();
    let payload = b"0 0 0 1 k 0 0 10 10 re f\n".repeat(12_000);
    let encoded = zlib(&payload);
    let decode = |bytes: Vec<u8>| {
        decode_stream(
            &doc,
            &Stream::new(dictionary! { "Filter" => "FlateDecode" }, bytes),
        )
    };
    assert_eq!(decode(encoded.clone()).quality, DecodeQuality::Exact);

    let mut bad_checksum = encoded.clone();
    *bad_checksum.last_mut().unwrap() ^= 1;
    let missing_checksum = encoded[..encoded.len() - 4].to_vec();
    let truncated_body = encoded[..encoded.len() / 2].to_vec();
    let mut trailing_data = encoded.clone();
    trailing_data.push(0);
    let mut concatenated = encoded;
    concatenated.extend(zlib(b"q Q"));

    for (kind, bytes) in [
        ("checksum sai", bad_checksum),
        ("thiếu checksum", missing_checksum),
        ("thiếu thân stream", truncated_body),
        ("dư dữ liệu", trailing_data),
        ("hai stream nối nhau", concatenated),
        ("không có zlib stream", Vec::new()),
    ] {
        assert_eq!(decode(bytes).quality, DecodeQuality::Recovered, "{kind}");
    }
}

#[test]
fn large_compressed_form_preserves_render_and_soundness() {
    let mut content = b"0 1 0 0 k 5 5 20 20 re f\n%".to_vec();
    content.resize(356_100, b' ');
    // Vùng mực thứ hai nằm SAU nhiều block, bắt việc chỉ trả prefix 64 KiB.
    content.extend_from_slice(b"\n1 0 0 0 k 60 60 30 30 re f\n");
    let make_doc = |compressed: bool| {
        let mut doc = Document::new();
        let mut dict = dictionary! {
            "Type" => "XObject", "Subtype" => "Form",
            "BBox" => pdf_rect([0, 0, PAGE, PAGE]), "Resources" => dictionary! {},
        };
        let data = if compressed {
            dict.set("Filter", "FlateDecode");
            zlib(&content)
        } else {
            content.clone()
        };
        let form_id = doc.add_object(Stream::new(dict, data));
        finish_document(
            doc,
            b"/Fm Do /Fm Do",
            dictionary! { "XObject" => dictionary! { "Fm" => Object::Reference(form_id) } },
            Vec::new(),
        )
    };
    let expected = render(&make_doc(false), false);
    let actual = render(&make_doc(true), false);
    assert!(any_ink(&expected));
    assert_eq!(actual.warnings.dropped_objects, 0, "{:?}", actual.warnings);
    assert_eq!(warning_count(&actual, FORM_REASON), 0);
    assert!(!actual.warnings.ink_unsound());
    for channel in 0..4 {
        assert_eq!(
            actual.buffer.plate_u8(channel),
            expected.buffer.plate_u8(channel)
        );
    }
    assert!(actual.buffer.plate_u8(0).iter().any(|value| *value > 0));
    assert!(actual.buffer.plate_u8(1).iter().any(|value| *value > 0));
}

#[test]
fn strict_decode_rejects_malformed_predictor_metadata_and_rows() {
    let doc = Document::new();
    let decode = |params: Dictionary, rows: &[u8]| {
        decode_stream(
            &doc,
            &Stream::new(
                dictionary! {
                    "Filter" => Object::Name(b"FlateDecode".to_vec()),
                    "DecodeParms" => Object::Dictionary(params),
                },
                zlib(rows),
            ),
        )
    };

    let invalid_enum = decode(
        dictionary! { "Predictor" => 3, "Columns" => 2 },
        &[0, b'A', b'B'],
    );
    assert_eq!(invalid_enum.quality, DecodeQuality::Recovered);

    let invalid_bit_depth = decode(
        dictionary! { "Predictor" => 15, "BitsPerComponent" => 3, "Columns" => 2 },
        &[0, b'A', b'B'],
    );
    assert_eq!(invalid_bit_depth.quality, DecodeQuality::Recovered);

    let incomplete_row = decode(
        dictionary! { "Predictor" => 15, "Columns" => 2 },
        &[0, b'A'],
    );
    assert_eq!(incomplete_row.quality, DecodeQuality::Recovered);

    let mismatched_fixed_filter = decode(
        dictionary! { "Predictor" => 10, "Columns" => 2 },
        &[4, b'A', b'B'],
    );
    assert_eq!(mismatched_fixed_filter.quality, DecodeQuality::Recovered);

    // 16_777_217 từng bị làm tròn thành 16_777_216 qua f32, khiến hàng thiếu
    // đúng một byte vẫn được cấp Exact.
    let rounded_columns = 16_777_217i64;
    let rounded_row = vec![0u8; 16_777_217];
    let lossy_integer = decode(
        dictionary! { "Predictor" => 15, "Columns" => rounded_columns },
        &rounded_row,
    );
    assert_eq!(lossy_integer.quality, DecodeQuality::Recovered);

    let overflow_geometry = decode(
        dictionary! { "Predictor" => 15, "Columns" => i64::MAX, "Colors" => 2 },
        &[0],
    );
    assert_eq!(overflow_geometry.quality, DecodeQuality::Recovered);
}

#[test]
fn strict_decode_uses_pdf_lzw_dictionary_for_both_early_change_modes() {
    let doc = Document::new();
    let payload: Vec<u8> = (0..4096).map(|index| (index % 251) as u8).collect();

    for early_change in [false, true] {
        let exact = decode_stream(
            &doc,
            &Stream::new(
                dictionary! {
                    "Filter" => Object::Name(b"LZWDecode".to_vec()),
                    "DecodeParms" => dictionary! { "EarlyChange" => i64::from(early_change) },
                },
                lzw(&payload, early_change, 8),
            ),
        );
        assert_eq!(exact.quality, DecodeQuality::Exact);
        assert_eq!(exact.bytes, payload);
    }

    let non_pdf_size = decode_stream(
        &doc,
        &Stream::new(
            dictionary! {
                "Filter" => Object::Name(b"LZWDecode".to_vec()),
                "DecodeParms" => dictionary! { "EarlyChange" => 0 },
            },
            lzw(b"0 0 10 10 re f", false, 7),
        ),
    );
    assert_eq!(non_pdf_size.quality, DecodeQuality::Recovered);

    let missing_clear = decode_stream(
        &doc,
        &Stream::new(
            dictionary! { "Filter" => Object::Name(b"LZWDecode".to_vec()) },
            pack_lzw_9bit_codes(&[u16::from(b'A'), 257]),
        ),
    );
    assert_eq!(missing_clear.quality, DecodeQuality::Recovered);

    let mut trailing = lzw(&payload, true, 8);
    trailing.push(0);
    let trailing = decode_stream(
        &doc,
        &Stream::new(
            dictionary! {
                "Filter" => Object::Name(b"LZWDecode".to_vec()),
                "DecodeParms" => dictionary! { "EarlyChange" => 1 },
            },
            trailing,
        ),
    );
    assert_eq!(trailing.quality, DecodeQuality::Recovered);
}

#[test]
fn strict_lzw_bulk_path_handles_multimegabyte_stream() {
    let doc = Document::new();
    let mut state = 0x1234_5678u32;
    let payload: Vec<u8> = (0..2 * 1024 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect();
    let encoded = lzw(&payload, true, 8);
    assert!(encoded.len() > 1024 * 1024);

    let decoded = decode_stream(
        &doc,
        &Stream::new(
            dictionary! {
                "Filter" => Object::Name(b"LZWDecode".to_vec()),
                "DecodeParms" => dictionary! { "EarlyChange" => 1 },
            },
            encoded,
        ),
    );
    assert_eq!(decoded.quality, DecodeQuality::Exact);
    assert_eq!(decoded.bytes, payload);
}

#[test]
fn strict_decode_requires_complete_filter_terminators() {
    let doc = Document::new();
    let decode = |filter: &[u8], content: Vec<u8>| {
        decode_stream(
            &doc,
            &Stream::new(
                dictionary! { "Filter" => Object::Name(filter.to_vec()) },
                content,
            ),
        )
    };

    let ascii85 = decode(b"ASCII85Decode", b"z~>".to_vec());
    assert_eq!(ascii85.quality, DecodeQuality::Exact);
    assert_eq!(ascii85.bytes, vec![0; 4]);
    assert_eq!(
        decode(b"ASCII85Decode", b"z~".to_vec()).quality,
        DecodeQuality::Recovered
    );
    assert_eq!(
        decode(b"ASCII85Decode", b"z~>!".to_vec()).quality,
        DecodeQuality::Recovered
    );
    let upper_boundary = decode(b"ASCII85Decode", b"s8W-!~>".to_vec());
    assert_eq!(upper_boundary.quality, DecodeQuality::Exact);
    assert_eq!(upper_boundary.bytes, vec![u8::MAX; 4]);
    assert_eq!(
        decode(b"ASCII85Decode", b"uuuuu~>".to_vec()).quality,
        DecodeQuality::Recovered
    );

    let ascii_hex = decode(b"ASCIIHexDecode", b"4142>".to_vec());
    assert_eq!(ascii_hex.quality, DecodeQuality::Exact);
    assert_eq!(ascii_hex.bytes, b"AB");
    assert_eq!(
        decode(b"ASCIIHexDecode", b"4142".to_vec()).quality,
        DecodeQuality::Recovered
    );

    let run_length = decode(b"RunLengthDecode", vec![1, b'A', b'B', 128]);
    assert_eq!(run_length.quality, DecodeQuality::Exact);
    assert_eq!(run_length.bytes, b"AB");
    assert_eq!(
        decode(b"RunLengthDecode", vec![0, b'A', 128, 0]).quality,
        DecodeQuality::Recovered
    );
}

#[test]
fn form_recovery_is_reported_only_when_form_bbox_is_visible() {
    let visible = render(&form_document(true), false);
    assert!(any_ink(&visible), "raw operators phải vẫn được recovery");
    assert_eq!(warning_count(&visible, FORM_REASON), 1);
    assert!(visible.warnings.ink_unsound());

    let hidden = render(&form_document(false), false);
    assert!(!any_ink(&hidden));
    assert_eq!(warning_count(&hidden, FORM_REASON), 0);
    assert!(!hidden.warnings.ink_unsound());
}

#[test]
fn form_recovery_inside_an_exact_clip_hole_stays_clean() {
    let clipped = render(&form_inside_clip_hole_document(), false);
    assert!(!any_ink(&clipped));
    assert_eq!(warning_count(&clipped, FORM_REASON), 0);
    assert!(!clipped.warnings.ink_unsound());
}

#[test]
fn pattern_recovery_is_reported_only_for_a_visible_host_path() {
    let visible = render(&pattern_document(true), false);
    assert!(any_ink(&visible));
    assert_eq!(warning_count(&visible, PATTERN_REASON), 1);
    assert!(visible.warnings.ink_unsound());

    let hidden = render(&pattern_document(false), false);
    assert!(!any_ink(&hidden));
    assert_eq!(warning_count(&hidden, PATTERN_REASON), 0);
    assert!(!hidden.warnings.ink_unsound());
}

#[test]
fn pattern_recovery_respects_output_preview_source_filter() {
    let doc = pattern_document(true);
    let shown = render_with_options(
        &doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceCmyk),
    );
    assert!(any_ink(&shown));
    assert_eq!(warning_count(&shown, PATTERN_REASON), 1);

    let hidden = render_with_options(
        &doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceRgb),
    );
    assert!(!any_ink(&hidden));
    assert_eq!(warning_count(&hidden, PATTERN_REASON), 0);
    assert!(!hidden.warnings.ink_unsound());
}

#[test]
fn type3_recovery_is_reported_only_when_the_glyph_paints() {
    let visible = render(&type3_document(true), false);
    assert!(any_ink(&visible));
    assert_eq!(warning_count(&visible, TYPE3_REASON), 1);
    assert!(visible.warnings.ink_unsound());

    let hidden = render(&type3_document(false), false);
    assert!(!any_ink(&hidden));
    assert_eq!(warning_count(&hidden, TYPE3_REASON), 0);
    assert!(!hidden.warnings.ink_unsound());
}

#[test]
fn soft_mask_recovery_waits_until_the_mask_is_used_by_visible_paint() {
    let visible = render(&soft_mask_document(true), false);
    assert!(any_ink(&visible));
    assert_eq!(warning_count(&visible, SMASK_REASON), 1);
    assert!(visible.warnings.unsupported_transparency);

    let unused = render(&soft_mask_document(false), false);
    assert!(!any_ink(&unused));
    assert_eq!(warning_count(&unused, SMASK_REASON), 0);
    assert!(!unused.warnings.ink_unsound());
}

#[test]
fn annotation_recovery_is_reported_only_when_rect_meets_the_viewport() {
    let visible = render(&annotation_document(true), true);
    assert!(any_ink(&visible));
    assert_eq!(warning_count(&visible, ANNOTATION_REASON), 1);
    assert!(visible.warnings.ink_unsound());

    let hidden = render(&annotation_document(false), true);
    assert!(!any_ink(&hidden));
    assert_eq!(warning_count(&hidden, ANNOTATION_REASON), 0);
    assert!(!hidden.warnings.ink_unsound());
}

#[test]
fn mesh_shading_rejects_recovered_raw_bytes_only_in_visible_lanes() {
    let doc = recovered_mesh_document();
    let rendered = render(&doc, false);
    let diagnostic = rendered
        .warnings
        .skipped_ops
        .iter()
        .find(|(reason, _)| reason.contains("không giải nén chính xác được"))
        .expect("mesh recovered phải fail-loud");
    assert_eq!(diagnostic.1, 1);
    assert_eq!(rendered.warnings.dropped_objects, 1);
    assert!(rendered.warnings.ink_unsound());

    let source_hidden = render_with_options(
        &doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceRgb),
    );
    assert!(!any_ink(&source_hidden));
    assert_eq!(source_hidden.warnings.dropped_objects, 0);
    assert!(!source_hidden.warnings.ink_unsound());

    let source_visible = render_with_options(
        &doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceCmyk),
    );
    assert_eq!(source_visible.warnings.dropped_objects, 1);
    assert!(source_visible.warnings.ink_unsound());

    let object_hidden = render_with_options(
        &doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::Text),
    );
    assert!(!any_ink(&object_hidden));
    assert_eq!(object_hidden.warnings.dropped_objects, 0);
    assert!(!object_hidden.warnings.ink_unsound());
    assert!(object_hidden
        .warnings
        .skipped_ops
        .iter()
        .all(|(reason, _)| !reason.contains("không giải nén chính xác được")));

    let pattern_doc = recovered_mesh_pattern_document();
    let pattern_hidden = render_with_options(
        &pattern_doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceRgb),
    );
    assert!(!any_ink(&pattern_hidden));
    assert_eq!(pattern_hidden.warnings.dropped_objects, 0);
    assert!(!pattern_hidden.warnings.ink_unsound());

    let pattern_visible = render_with_options(
        &pattern_doc,
        RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceCmyk),
    );
    assert_eq!(pattern_visible.warnings.dropped_objects, 1);
    assert!(pattern_visible.warnings.ink_unsound());
    assert!(pattern_visible
        .warnings
        .skipped_ops
        .iter()
        .any(|(reason, _)| reason.contains("không giải nén chính xác được")));
}

#[test]
fn source_hidden_shading_discards_colorspace_resolver_warnings() {
    for pattern in [false, true] {
        let doc = recovered_calrgb_mesh_document(pattern);
        let hidden = render_with_options(
            &doc,
            RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceCmyk),
        );
        assert!(!any_ink(&hidden));
        assert_eq!(hidden.warnings.dropped_objects, 0);
        assert!(hidden.warnings.approximated_colorspaces.is_empty());
        assert!(!hidden.warnings.ink_unsound());

        let visible = render_with_options(
            &doc,
            RenderOptions::softproof().with_output_preview_filter(OutputPreviewFilter::DeviceRgb),
        );
        assert_eq!(visible.warnings.dropped_objects, 1);
        assert!(!visible.warnings.approximated_colorspaces.is_empty());
        assert!(visible.warnings.ink_unsound());
    }
}
