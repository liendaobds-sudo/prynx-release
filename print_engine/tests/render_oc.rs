//! Test tích hợp optional content (`/OC`).
//!
//! Đây là nhóm test duy nhất trong PPE kiểm chiều sai **thừa mực**: mọi test khác
//! hỏi "có vẽ đủ chưa", ở đây hỏi "có vẽ thứ đáng lẽ không được vẽ hay không".
//!
//! Ba thứ được chốt:
//!
//! 1. Lớp tắt không lên mực — kể cả khi nội dung của nó là Form XObject, chữ, ảnh
//!    hay gradient.
//! 2. Lớp **hiện trên màn hình nhưng khai không in** (`/Usage /Print /PrintState
//!    /OFF`) cũng không lên mực. Đây là điểm khác biệt giữa một renderer xem-trước
//!    và một engine đo mực.
//! 3. Thay đổi graphics state *trong* khối tắt vẫn có hiệu lực sau `EMC` — bỏ qua
//!    cả operator thay vì chỉ bỏ thao tác vẽ sẽ làm phần còn lại của trang lệch.

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};
use print_engine::content::RenderOptions;
use print_engine::page::{render_page, PageBox, PageRender};

const PAGE: i64 = 40;

/// Tài liệu một trang có `/OCProperties`.
struct Builder {
    doc: Document,
    ocgs: Vec<ObjectId>,
}

impl Builder {
    fn new() -> Self {
        Builder {
            doc: Document::with_version("1.7"),
            ocgs: Vec::new(),
        }
    }

    /// Thêm một OCG, trả chỉ số của nó.
    fn ocg(&mut self, name: &str, usage: Option<Dictionary>) -> usize {
        let mut d = dictionary! { "Type" => "OCG", "Name" => name };
        if let Some(u) = usage {
            d.set("Usage", Object::Dictionary(u));
        }
        self.ocgs.push(self.doc.add_object(d));
        self.ocgs.len() - 1
    }

    fn id(&self, index: usize) -> ObjectId {
        self.ocgs[index]
    }

    fn finish(
        mut self,
        content: &str,
        mut resources: Dictionary,
        config: Dictionary,
        extra: impl FnOnce(&mut Document) -> Option<(String, Object)>,
    ) -> Document {
        if let Some((key, value)) = extra(&mut self.doc) {
            resources.set(key, value);
        }
        let all: Vec<Object> = self.ocgs.iter().map(|i| Object::Reference(*i)).collect();
        let props = self.doc.add_object(dictionary! {
            "OCGs" => Object::Array(all),
            "D" => Object::Dictionary(config),
        });

        let content_id = self
            .doc
            .add_object(Stream::new(dictionary! {}, content.as_bytes().to_vec()));
        let resources_id = self.doc.add_object(resources);
        let pages_id = (self.doc.new_object_id().0, 0);
        let page_id = self.doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "Contents" => Object::Reference(content_id),
            "Resources" => Object::Reference(resources_id),
            "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
        });
        self.doc.set_object(
            pages_id,
            dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
        );
        let catalog = self.doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
            "OCProperties" => Object::Reference(props),
        });
        self.doc.trailer.set("Root", Object::Reference(catalog));
        self.doc
    }
}

fn render(doc: &Document) -> PageRender {
    render_page(doc, 1, 72.0, PageBox::Crop, RenderOptions::ink_accurate())
        .expect("render phải thành công")
}

fn solid_k() -> String {
    format!("0 0 0 1 k 0 0 {PAGE} {PAGE} re f")
}

fn properties(name: &str, id: ObjectId) -> Dictionary {
    dictionary! { "Properties" => dictionary! { name => Object::Reference(id) } }
}

fn no_extra(_doc: &mut Document) -> Option<(String, Object)> {
    None
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lớp bật / tắt
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn content_in_a_visible_layer_is_painted() {
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!("/OC /L0 BDC {} EMC", solid_k());
    let doc = b.finish(&content, properties("L0", id), dictionary! {}, no_extra);
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
    assert!(!r.warnings.hidden_content_risk);
}

#[test]
fn content_in_a_layer_listed_in_off_is_not_painted() {
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!("/OC /L0 BDC {} EMC", solid_k());
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let doc = b.finish(&content, properties("L0", id), config, no_extra);
    let r = render(&doc);
    assert_eq!(
        r.buffer.max_tac_percent(),
        0.0,
        "lớp tắt không được lên kẽm"
    );
    assert!(
        !r.warnings.hidden_content_risk,
        "đã quyết được trạng thái ⇒ không phải rủi ro: {:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn base_state_off_hides_a_layer_not_listed_in_on() {
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!("/OC /L0 BDC {} EMC", solid_k());
    let config = dictionary! { "BaseState" => "OFF" };
    let doc = b.finish(&content, properties("L0", id), config, no_extra);
    assert_eq!(render(&doc).buffer.max_tac_percent(), 0.0);
}

#[test]
fn layer_marked_not_to_print_is_not_painted() {
    // Watermark "BẢN NHÁP": hiện trên màn hình, khai `/PrintState /OFF`. Một
    // renderer xem-trước sẽ vẽ nó; engine đo mực thì KHÔNG được vẽ.
    let mut b = Builder::new();
    let l = b.ocg(
        "Watermark",
        Some(dictionary! { "Print" => dictionary! { "PrintState" => "OFF" } }),
    );
    let id = b.id(l);
    let content = format!("/OC /L0 BDC {} EMC", solid_k());
    let config = dictionary! {
        "AS" => Object::Array(vec![Object::Dictionary(dictionary! {
            "Event" => "Print",
            "Category" => Object::Array(vec![Object::Name(b"Print".to_vec())]),
            "OCGs" => Object::Array(vec![Object::Reference(id)]),
        })]),
    };
    let doc = b.finish(&content, properties("L0", id), config, no_extra);
    assert_eq!(
        render(&doc).buffer.max_tac_percent(),
        0.0,
        "lớp không-in phải không lên mực"
    );
}

#[test]
fn only_the_hidden_section_is_suppressed() {
    // Nửa dưới trong lớp tắt, nửa trên ngoài lớp. Chỉ nửa trong bị bỏ.
    let half = PAGE / 2;
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!(
        "/OC /L0 BDC 0 0 0 1 k 0 0 {PAGE} {half} re f EMC\n\
         0 0 0 1 k 0 {half} {PAGE} {half} re f"
    );
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let doc = b.finish(&content, properties("L0", id), config, no_extra);
    let r = render(&doc);
    let w = r.buffer.width() as usize;
    let h = r.buffer.height() as usize;
    let k = r.buffer.plate_u8(3);
    // y của raster tăng xuống, nên nửa trên ảnh = nửa trên trang PDF.
    assert_eq!(k[2 * w + w / 2], 255, "nội dung ngoài lớp phải in");
    assert_eq!(k[(h - 3) * w + w / 2], 0, "nội dung trong lớp tắt không in");
}

#[test]
fn nested_marked_content_keeps_balance() {
    // `BMC`/`EMC` lồng trong khối tắt không được làm mất dấu độ sâu; nếu lệch, nội
    // dung sau `EMC` ngoài cùng sẽ bị tắt oan (hoặc lớp tắt bị bật sớm).
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!("/OC /L0 BDC /Tag BMC {} EMC EMC\n{}", solid_k(), solid_k());
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let doc = b.finish(&content, properties("L0", id), config, no_extra);
    // Khối tắt không in; hình sau `EMC` ngoài cùng thì in ⇒ đúng 100%.
    assert_eq!(render(&doc).buffer.max_tac_percent(), 100.0);
}

#[test]
fn graphics_state_changes_inside_a_hidden_layer_still_apply() {
    // Clip đặt trong khối tắt phải còn hiệu lực sau `EMC`: clip là graphics state,
    // không phải nội dung. Bỏ qua cả operator sẽ làm hình sau đó tràn ra ngoài.
    let half = PAGE / 2;
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!(
        "/OC /L0 BDC 0 0 {half} {PAGE} re W n EMC\n\
         0 0 0 1 k 0 0 {PAGE} {PAGE} re f"
    );
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let doc = b.finish(&content, properties("L0", id), config, no_extra);
    let r = render(&doc);
    let w = r.buffer.width() as usize;
    let k = r.buffer.plate_u8(3);
    let row = (r.buffer.height() as usize / 2) * w;
    assert_eq!(k[row + 2], 255, "trong clip phải in");
    assert_eq!(k[row + w - 3], 0, "clip đặt trong lớp tắt vẫn phải cắt");
}

#[test]
fn text_inside_a_hidden_layer_is_not_painted() {
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    // Không nhúng font: nếu lớp tắt được xử lý đúng thì không có glyph nào bị bỏ,
    // nên `dropped_objects` cũng phải bằng 0.
    let content = "/OC /L0 BDC BT /F0 24 Tf 5 20 Td (Test) Tj ET EMC".to_string();
    let mut res = properties("L0", id);
    res.set(
        "Font",
        Object::Dictionary(dictionary! {
            "F0" => dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            }
        }),
    );
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let doc = b.finish(&content, res, config, no_extra);
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert_eq!(
        r.warnings.dropped_objects, 0,
        "chữ trong lớp tắt không phải nội dung bị mất"
    );
}

#[test]
fn shading_inside_a_hidden_layer_is_not_painted() {
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = "/OC /L0 BDC /Sh0 sh EMC".to_string();
    let mut res = properties("L0", id);
    res.set(
        "Shading",
        Object::Dictionary(dictionary! {
            "Sh0" => dictionary! {
                "ShadingType" => 2,
                "ColorSpace" => "DeviceCMYK",
                "Coords" => vec![0.into(), 0.into(), PAGE.into(), 0.into()],
                "Extend" => Object::Array(vec![Object::Boolean(true), Object::Boolean(true)]),
                "Function" => dictionary! {
                    "FunctionType" => 2,
                    "Domain" => vec![0.into(), 1.into()],
                    "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
                    "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
                    "N" => 1,
                    "Range" => vec![
                        0.into(), 1.into(), 0.into(), 1.into(),
                        0.into(), 1.into(), 0.into(), 1.into(),
                    ],
                },
            }
        }),
    );
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let doc = b.finish(&content, res, config, no_extra);
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert_eq!(r.warnings.dropped_objects, 0);
}

#[test]
fn form_xobject_drawn_inside_a_hidden_layer_is_skipped() {
    // Lớp tắt phải tắt **xuyên qua** ranh giới stream: nội dung của form cũng bỏ.
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = "/OC /L0 BDC /Fm0 Do EMC".to_string();
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let inner = solid_k();
    let doc = b.finish(&content, properties("L0", id), config, move |doc| {
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
            },
            inner.into_bytes(),
        ));
        Some((
            "XObject".to_string(),
            Object::Dictionary(dictionary! { "Fm0" => Object::Reference(form) }),
        ))
    });
    assert_eq!(render(&doc).buffer.max_tac_percent(), 0.0);
}

#[test]
fn xobject_with_its_own_oc_entry_is_skipped() {
    // `/OC` gắn trực tiếp trên XObject (§8.11.4.1), không qua `BDC`.
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let inner = solid_k();
    let doc = b.finish("/Fm0 Do", dictionary! {}, config, move |doc| {
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "OC" => Object::Reference(id),
            },
            inner.into_bytes(),
        ));
        Some((
            "XObject".to_string(),
            Object::Dictionary(dictionary! { "Fm0" => Object::Reference(form) }),
        ))
    });
    assert_eq!(render(&doc).buffer.max_tac_percent(), 0.0);
}

#[test]
fn xobject_oc_entry_that_is_on_still_paints() {
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let inner = solid_k();
    let doc = b.finish("/Fm0 Do", dictionary! {}, dictionary! {}, move |doc| {
        let form = doc.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Form",
                "BBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
                "OC" => Object::Reference(id),
            },
            inner.into_bytes(),
        ));
        Some((
            "XObject".to_string(),
            Object::Dictionary(dictionary! { "Fm0" => Object::Reference(form) }),
        ))
    });
    assert_eq!(render(&doc).buffer.max_tac_percent(), 100.0);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trường hợp không quyết được
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn oc_name_missing_from_properties_is_flagged_and_still_painted() {
    // Không tra được tên ⇒ không biết lớp bật hay tắt. Vẽ tiếp (thà thừa hơn thiếu)
    // nhưng PHẢI bật cờ, vì đây đúng là rủi ro đo thừa mực.
    let mut b = Builder::new();
    let _ = b.ocg("Lop 1", None);
    let content = format!("/OC /KhongCo BDC {} EMC", solid_k());
    let doc = b.finish(&content, dictionary! {}, dictionary! {}, no_extra);
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
    assert!(r.warnings.hidden_content_risk, "phải bật cờ rủi ro");
    assert!(r.warnings.ink_unsound());
}

#[test]
fn ocmd_with_unknown_policy_is_flagged() {
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!("/OC /M0 BDC {} EMC", solid_k());
    let doc = b.finish(&content, dictionary! {}, dictionary! {}, move |doc| {
        let ocmd = doc.add_object(dictionary! {
            "Type" => "OCMD",
            "OCGs" => Object::Array(vec![Object::Reference(id)]),
            "P" => "KhongBiet",
        });
        Some((
            "Properties".to_string(),
            Object::Dictionary(dictionary! { "M0" => Object::Reference(ocmd) }),
        ))
    });
    let r = render(&doc);
    assert!(r.warnings.hidden_content_risk);
}

#[test]
fn ocmd_all_on_hides_when_one_layer_is_off() {
    let mut b = Builder::new();
    let a = b.ocg("A", None);
    let c = b.ocg("B", None);
    let (ida, idb) = (b.id(a), b.id(c));
    let content = format!("/OC /M0 BDC {} EMC", solid_k());
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(ida)]) };
    let doc = b.finish(&content, dictionary! {}, config, move |doc| {
        let ocmd = doc.add_object(dictionary! {
            "Type" => "OCMD",
            "OCGs" => Object::Array(vec![Object::Reference(ida), Object::Reference(idb)]),
            "P" => "AllOn",
        });
        Some((
            "Properties".to_string(),
            Object::Dictionary(dictionary! { "M0" => Object::Reference(ocmd) }),
        ))
    });
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert!(!r.warnings.hidden_content_risk);
}

#[test]
fn unbalanced_bdc_is_noted() {
    // `BDC` không đóng: phần còn lại của stream nằm trong lớp tắt (đúng cú pháp),
    // nhưng engine phải ghi nhận cấu trúc lệch chứ không im lặng.
    let mut b = Builder::new();
    let l = b.ocg("Lop 1", None);
    let id = b.id(l);
    let content = format!("/OC /L0 BDC {}", solid_k());
    let config = dictionary! { "OFF" => Object::Array(vec![Object::Reference(id)]) };
    let doc = b.finish(&content, properties("L0", id), config, no_extra);
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 0.0);
    assert!(
        r.warnings
            .skipped_ops
            .iter()
            .any(|(op, _)| op.contains("BDC (không cân)")),
        "{:?}",
        r.warnings.skipped_ops
    );
}

#[test]
fn document_without_ocproperties_paints_everything() {
    // Không có optional content ⇒ `BDC /OC` (nếu có) không quyết được, nhưng trang
    // bình thường thì tuyệt đối không được bật cờ rủi ro.
    let mut doc = Document::with_version("1.7");
    let content_id = doc.add_object(Stream::new(dictionary! {}, solid_k().into_bytes()));
    let pages_id = (doc.new_object_id().0, 0);
    let page_id = doc.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "Contents" => Object::Reference(content_id),
        "MediaBox" => vec![0.into(), 0.into(), PAGE.into(), PAGE.into()],
    });
    doc.set_object(
        pages_id,
        dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1 },
    );
    let catalog =
        doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => Object::Reference(pages_id) });
    doc.trailer.set("Root", Object::Reference(catalog));
    let r = render(&doc);
    assert_eq!(r.buffer.max_tac_percent(), 100.0);
    assert!(!r.warnings.hidden_content_risk);
}
