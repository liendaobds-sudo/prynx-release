use lopdf::{Document, Object, ObjectId};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct ColorFlags {
    has_device_cmyk: bool,
    has_device_n: bool,
    has_separation: bool,
    has_transparency_group: bool,
    has_soft_mask: bool,
    has_blend_mode: bool,
    has_alpha: bool,
}

impl ColorFlags {
    fn merge(&mut self, other: Self) {
        self.has_device_cmyk |= other.has_device_cmyk;
        self.has_device_n |= other.has_device_n;
        self.has_separation |= other.has_separation;
        self.has_transparency_group |= other.has_transparency_group;
        self.has_soft_mask |= other.has_soft_mask;
        self.has_blend_mode |= other.has_blend_mode;
        self.has_alpha |= other.has_alpha;
    }

    fn has_non_rgb_color(self) -> bool {
        self.has_device_cmyk || self.has_device_n || self.has_separation
    }

    fn has_transparency(self) -> bool {
        self.has_transparency_group || self.has_soft_mask || self.has_blend_mode || self.has_alpha
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfPageColorRisk {
    pub page: u32,
    pub high_risk: bool,
    pub accurate_color_recommended: bool,
    pub has_device_cmyk: bool,
    pub has_device_n: bool,
    pub has_separation: bool,
    pub has_transparency: bool,
    pub has_soft_mask: bool,
    pub has_blend_mode: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PdfColorRiskSummary {
    pub high_risk: bool,
    pub accurate_color_recommended: bool,
    pub has_output_intent: bool,
    pub risky_pages: Vec<u32>,
    pub pages: Vec<PdfPageColorRisk>,
    pub reason_codes: Vec<&'static str>,
}

impl PdfColorRiskSummary {
    #[cfg(test)]
    pub(crate) fn empty() -> Self {
        Self {
            high_risk: false,
            accurate_color_recommended: false,
            has_output_intent: false,
            risky_pages: Vec::new(),
            pages: Vec::new(),
            reason_codes: Vec::new(),
        }
    }
}

fn object_name_is(object: &Object, expected: &[u8]) -> bool {
    matches!(object, Object::Name(name) if name.as_slice() == expected)
}

fn object_is_none(document: &Document, object: &Object) -> bool {
    match object {
        Object::Null => true,
        Object::Name(name) => name.as_slice() == b"None",
        Object::Reference(object_id) => document
            .get_object(*object_id)
            .map(|resolved| object_is_none(document, resolved))
            .unwrap_or(false),
        _ => false,
    }
}

fn object_has_non_normal_blend(document: &Document, object: &Object) -> bool {
    match object {
        Object::Name(name) => name.as_slice() != b"Normal" && name.as_slice() != b"Compatible",
        Object::Array(items) => items
            .iter()
            .any(|item| object_has_non_normal_blend(document, item)),
        Object::Reference(object_id) => document
            .get_object(*object_id)
            .map(|resolved| object_has_non_normal_blend(document, resolved))
            .unwrap_or(false),
        _ => false,
    }
}

fn object_alpha_is_transparent(document: &Document, object: &Object) -> bool {
    match object {
        Object::Integer(value) => *value < 1,
        Object::Real(value) => *value < 0.999,
        Object::Reference(object_id) => document
            .get_object(*object_id)
            .map(|resolved| object_alpha_is_transparent(document, resolved))
            .unwrap_or(false),
        _ => false,
    }
}

fn scan_object(
    document: &Document,
    object: &Object,
    memo: &mut HashMap<ObjectId, ColorFlags>,
    visiting: &mut HashSet<ObjectId>,
    depth: usize,
) -> ColorFlags {
    // COLOR (audit 2026-08-07 §GV.3): chặn PDF dị thường tạo graph quá sâu;
    // detector chỉ đọc dictionary, không giải mã stream ảnh/nội dung trang.
    if depth > 64 {
        return ColorFlags::default();
    }

    match object {
        Object::Reference(object_id) => {
            if let Some(cached) = memo.get(object_id) {
                return *cached;
            }
            if !visiting.insert(*object_id) {
                return ColorFlags::default();
            }
            let flags = document
                .get_object(*object_id)
                .map(|resolved| scan_object(document, resolved, memo, visiting, depth + 1))
                .unwrap_or_default();
            visiting.remove(object_id);
            memo.insert(*object_id, flags);
            flags
        }
        Object::Name(name) => {
            let mut flags = ColorFlags::default();
            match name.as_slice() {
                b"DeviceCMYK" => flags.has_device_cmyk = true,
                b"DeviceN" => flags.has_device_n = true,
                b"Separation" => flags.has_separation = true,
                _ => {}
            }
            flags
        }
        Object::Array(items) => {
            let mut flags = ColorFlags::default();
            for item in items {
                flags.merge(scan_object(document, item, memo, visiting, depth + 1));
            }
            flags
        }
        Object::Dictionary(dictionary) => {
            let mut flags = ColorFlags::default();
            if dictionary
                .get(b"S")
                .map(|value| object_name_is(value, b"Transparency"))
                .unwrap_or(false)
            {
                flags.has_transparency_group = true;
            }
            if dictionary
                .get(b"SMask")
                .map(|value| !object_is_none(document, value))
                .unwrap_or(false)
            {
                flags.has_soft_mask = true;
            }
            if dictionary
                .get(b"BM")
                .map(|value| object_has_non_normal_blend(document, value))
                .unwrap_or(false)
            {
                flags.has_blend_mode = true;
            }
            if [b"CA".as_slice(), b"ca".as_slice()].iter().any(|key| {
                dictionary
                    .get(key)
                    .map(|value| object_alpha_is_transparent(document, value))
                    .unwrap_or(false)
            }) {
                flags.has_alpha = true;
            }

            for (key, value) in dictionary.iter() {
                // Không đi ngược PageTree và không parse bytes content. Những dấu hiệu
                // cần thiết đều nằm trong Resources/Group/dictionary của XObject.
                if matches!(key.as_slice(), b"Parent" | b"Contents" | b"Length") {
                    continue;
                }
                flags.merge(scan_object(document, value, memo, visiting, depth + 1));
            }
            flags
        }
        Object::Stream(stream) => scan_object(
            document,
            &Object::Dictionary(stream.dict.clone()),
            memo,
            visiting,
            depth + 1,
        ),
        _ => ColorFlags::default(),
    }
}

fn inherited_page_value(document: &Document, page_id: ObjectId, key: &[u8]) -> Option<Object> {
    let mut current = page_id;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        let dictionary = document.get_dictionary(current).ok()?;
        if let Ok(value) = dictionary.get(key) {
            return Some(value.clone());
        }
        current = match dictionary.get(b"Parent").ok()? {
            Object::Reference(parent_id) => *parent_id,
            _ => return None,
        };
    }
    None
}

fn has_output_intent(document: &Document) -> bool {
    let Ok(root) = document.trailer.get(b"Root") else {
        return false;
    };
    let catalog = match root {
        Object::Reference(object_id) => document.get_dictionary(*object_id).ok(),
        Object::Dictionary(dictionary) => Some(dictionary),
        _ => None,
    };
    let Some(catalog) = catalog else {
        return false;
    };
    match catalog.get(b"OutputIntents") {
        Ok(Object::Array(items)) => !items.is_empty(),
        Ok(Object::Reference(object_id)) => document
            .get_object(*object_id)
            .map(|object| match object {
                Object::Null => false,
                Object::Array(items) => !items.is_empty(),
                _ => true,
            })
            .unwrap_or(false),
        Ok(Object::Null) | Err(_) => false,
        Ok(_) => true,
    }
}

pub(crate) fn analyze_pdf_color_risk(document: &Document) -> PdfColorRiskSummary {
    let has_output_intent = has_output_intent(document);
    let mut memo = HashMap::new();
    let mut pages = Vec::new();
    let mut aggregate = ColorFlags::default();

    for (page_index, page_id) in document.get_pages().values().enumerate() {
        let mut flags = ColorFlags::default();
        let mut visiting = HashSet::new();
        for key in [b"Resources".as_slice(), b"Group".as_slice()] {
            if let Some(value) = inherited_page_value(document, *page_id, key) {
                flags.merge(scan_object(document, &value, &mut memo, &mut visiting, 0));
            }
        }

        let accurate_color_recommended = flags.has_non_rgb_color();
        let high_risk = accurate_color_recommended
            && (!has_output_intent
                || flags.has_transparency()
                || flags.has_device_n
                || flags.has_separation);
        aggregate.merge(flags);
        pages.push(PdfPageColorRisk {
            page: page_index as u32 + 1,
            high_risk,
            accurate_color_recommended,
            has_device_cmyk: flags.has_device_cmyk,
            has_device_n: flags.has_device_n,
            has_separation: flags.has_separation,
            has_transparency: flags.has_transparency(),
            has_soft_mask: flags.has_soft_mask,
            has_blend_mode: flags.has_blend_mode,
        });
    }

    let mut reason_codes = Vec::new();
    if !has_output_intent && aggregate.has_non_rgb_color() {
        reason_codes.push("missing_output_intent");
    }
    if aggregate.has_device_cmyk {
        reason_codes.push("device_cmyk");
    }
    if aggregate.has_device_n {
        reason_codes.push("device_n");
    }
    if aggregate.has_separation {
        reason_codes.push("separation");
    }
    if aggregate.has_transparency() {
        reason_codes.push("transparency");
    }

    let risky_pages = pages
        .iter()
        .filter(|page| page.high_risk)
        .map(|page| page.page)
        .collect::<Vec<_>>();
    PdfColorRiskSummary {
        high_risk: !risky_pages.is_empty(),
        accurate_color_recommended: pages.iter().any(|page| page.accurate_color_recommended),
        has_output_intent,
        risky_pages,
        pages,
        reason_codes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    fn document_with_resources(
        resources: lopdf::Dictionary,
        group: Option<lopdf::Dictionary>,
        output_intent: bool,
    ) -> Document {
        let mut document = Document::with_version("1.7");
        let pages_id = document.new_object_id();
        let content_id = document.add_object(Stream::new(dictionary! {}, Vec::new()));
        let mut page = dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Resources" => resources,
            "Contents" => content_id,
        };
        if let Some(group) = group {
            page.set("Group", group);
        }
        let page_id = document.add_object(page);
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let mut catalog = dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        };
        if output_intent {
            catalog.set(
                "OutputIntents",
                vec![Object::Dictionary(dictionary! {
                    "Type" => "OutputIntent",
                    "S" => "GTS_PDFX",
                })],
            );
        }
        let catalog_id = document.add_object(catalog);
        document.trailer.set("Root", catalog_id);
        document
    }

    #[test]
    fn rgb_thuan_khong_bi_danh_dau_rui_ro_mau() {
        let document = document_with_resources(
            dictionary! {
                "ColorSpace" => dictionary! { "CS0" => "DeviceRGB" },
            },
            None,
            false,
        );

        let summary = analyze_pdf_color_risk(&document);

        assert!(!summary.high_risk);
        assert!(!summary.accurate_color_recommended);
        assert!(summary.risky_pages.is_empty());
    }

    #[test]
    fn cmyk_devicen_transparency_khong_output_intent_duoc_danh_dau() {
        let image = Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "ColorSpace" => "DeviceCMYK",
                "SMask" => dictionary! { "S" => "Luminosity" },
            },
            Vec::new(),
        );
        let mut document = document_with_resources(
            dictionary! {
                "ColorSpace" => dictionary! {
                    "CS0" => vec![
                        Object::Name(b"DeviceN".to_vec()),
                        Object::Array(vec![Object::Name(b"Cyan".to_vec()), Object::Name(b"Magenta".to_vec())]),
                        Object::Name(b"DeviceCMYK".to_vec()),
                    ],
                    "CS1" => vec![
                        Object::Name(b"Separation".to_vec()),
                        Object::Name(b"VietinBank Dark Blue".to_vec()),
                        Object::Name(b"DeviceCMYK".to_vec()),
                    ],
                },
                "ExtGState" => dictionary! {
                    "GS0" => dictionary! {
                        "BM" => "Overlay",
                        "ca" => 0.4,
                    },
                },
            },
            Some(dictionary! {
                "S" => "Transparency",
                "CS" => "DeviceCMYK",
            }),
            false,
        );
        let image_id = document.add_object(image);
        let page_id = *document.get_pages().values().next().unwrap();
        document
            .get_dictionary_mut(page_id)
            .unwrap()
            .get_mut(b"Resources")
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("XObject", dictionary! { "Im0" => image_id });

        let summary = analyze_pdf_color_risk(&document);

        assert!(summary.high_risk);
        assert_eq!(summary.risky_pages, vec![1]);
        assert_eq!(
            summary.reason_codes,
            vec![
                "missing_output_intent",
                "device_cmyk",
                "device_n",
                "separation",
                "transparency",
            ]
        );
        let page = &summary.pages[0];
        assert!(page.has_device_cmyk);
        assert!(page.has_device_n);
        assert!(page.has_separation);
        assert!(page.has_transparency);
        assert!(page.has_soft_mask);
        assert!(page.has_blend_mode);
    }

    #[test]
    fn output_intent_duoc_ghi_nhan_nhung_trang_devicen_van_rui_ro() {
        let document = document_with_resources(
            dictionary! {
                "ColorSpace" => dictionary! {
                    "CS0" => vec![
                        Object::Name(b"Separation".to_vec()),
                        Object::Name(b"Spot".to_vec()),
                        Object::Name(b"DeviceCMYK".to_vec()),
                    ],
                },
            },
            None,
            true,
        );

        let summary = analyze_pdf_color_risk(&document);

        assert!(summary.has_output_intent);
        assert!(summary.high_risk);
        assert!(!summary.reason_codes.contains(&"missing_output_intent"));
    }
}
