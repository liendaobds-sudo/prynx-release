//! Optional content — lớp nội dung bật/tắt (ISO 32000-2 §8.11).
//!
//! # Vì sao đây là rủi ro **ngược chiều** với mọi thứ khác trong engine
//!
//! Mọi khoảng trống khác của PPE làm mực bị đo **thiếu**: một object bị bỏ, một
//! gradient chưa dựng. Optional content thì ngược: nếu không xét trạng thái bật/tắt,
//! engine sẽ vẽ cả những lớp **đang tắt** ⇒ đo **thừa** mực.
//!
//! Cả hai chiều đều sai, nhưng chúng sai ở hai chỗ khác nhau trong quy trình:
//!
//! * Đo thiếu ⇒ file vượt ngưỡng mực được coi là đạt ⇒ hỏng lô in.
//! * Đo thừa ⇒ file đạt bị chặn ⇒ mất thời gian, và nếu xảy ra thường xuyên thì
//!   người dùng học cách bỏ qua cảnh báo, tức là mất luôn tác dụng của chiều kia.
//!
//! # `/AS` và cấu hình **in**, không phải cấu hình xem
//!
//! Đây là điểm quan trọng nhất của module với prepress. Một lớp có thể **hiện trên
//! màn hình** nhưng được khai là **không in** (`/Usage << /Print << /PrintState /OFF
//! >> >>`, được kích hoạt qua `/AS` với `/Event /Print`). Watermark "BẢN NHÁP",
//! đường bế hướng dẫn, ghi chú kỹ thuật đều hay dùng cách này.
//!
//! Một renderer xem-trước sẽ vẽ những lớp đó. PPE **không được** vẽ: nó đang đo mực
//! sẽ lên giấy, nên nó phải đọc cấu hình `/Print`. Đây là lựa chọn có ý thức, không
//! phải mặc định của thư viện nào.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::pdf;

/// Trần độ sâu khi tính visibility expression (`/VE`), chống dict trỏ vòng.
const MAX_VE_DEPTH: u32 = 16;

/// Mục đích sử dụng quyết định nhánh `/AS` và `/Usage` phải đọc.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum OptionalContentUsage {
    #[default]
    Print,
    View,
}

impl OptionalContentUsage {
    fn event_name(self) -> &'static str {
        match self {
            Self::Print => "Print",
            Self::View => "View",
        }
    }

    fn state_name(self) -> &'static str {
        match self {
            Self::Print => "PrintState",
            Self::View => "ViewState",
        }
    }
}

/// Trạng thái bật/tắt của các nhóm optional content trong một tài liệu.
#[derive(Debug, Default, Clone)]
pub struct OptionalContent {
    /// Tài liệu có khai `/OCProperties` hay không.
    present: bool,
    /// OCG đang TẮT (đã tính cả `/BaseState`, `/OFF`, và `/AS` cho sự kiện in).
    off: HashSet<ObjectId>,
    /// OCG bị tắt **chỉ vì** `/Usage /Print /PrintState /OFF`.
    ///
    /// Tách riêng vì đây là trường hợp duy nhất mà cấu hình xem và cấu hình in nói
    /// khác nhau, và cũng là chỗ Ghostscript hành xử khác: GS đọc cấu hình mặc định
    /// `/D` mà bỏ qua `/AS`, nên nó **vẫn in** lớp này. PPE theo cấu hình in vì nó đo
    /// mực sẽ lên giấy — nhưng lệch đó phải nói ra, không được im lặng.
    usage_state_off: HashSet<ObjectId>,
    usage: OptionalContentUsage,
}

impl OptionalContent {
    /// Đọc cấu hình mặc định (`/OCProperties /D`) của tài liệu.
    pub fn load(doc: &Document) -> Self {
        Self::load_for_usage(doc, OptionalContentUsage::Print)
    }

    /// Đọc cấu hình theo đúng mục đích. Viewer dùng `/View`; separations/TAC giữ
    /// `/Print`, nên hai đường không còn dùng nhầm một trạng thái lớp.
    pub fn load_for_usage(doc: &Document, usage: OptionalContentUsage) -> Self {
        let mut oc = OptionalContent {
            usage,
            ..OptionalContent::default()
        };

        let Some(catalog) = catalog_dict(doc) else {
            return oc;
        };
        let Some(props) = pdf::dict_get_dict(doc, catalog, "OCProperties") else {
            return oc;
        };
        oc.present = true;

        let all: Vec<ObjectId> = ref_ids(doc, props.get(b"OCGs").ok());
        let Some(config) = pdf::dict_get_dict(doc, props, "D") else {
            return oc;
        };

        // `/BaseState /OFF` nghĩa là **mọi** OCG tắt, rồi `/ON` bật lại từng cái.
        // Bỏ qua bước này làm cả một tài liệu chỉ bật một lớp bị vẽ hết mọi lớp.
        let base_off = pdf::dict_get(doc, config, "BaseState")
            .and_then(pdf::name_str)
            .as_deref()
            == Some("OFF");
        if base_off {
            oc.off.extend(all.iter().copied());
            for id in ref_ids(doc, config.get(b"ON").ok()) {
                oc.off.remove(&id);
            }
        }
        for id in ref_ids(doc, config.get(b"OFF").ok()) {
            oc.off.insert(id);
        }

        oc.apply_usage(doc, config);
        oc
    }

    /// Áp `/AS` cho đúng sự kiện: `/Usage /Print|View /...State`.
    fn apply_usage(&mut self, doc: &Document, config: &Dictionary) {
        let Some(Object::Array(entries)) = pdf::dict_get(doc, config, "AS") else {
            return;
        };
        for entry in entries.clone() {
            let dict = match pdf::deref(doc, &entry) {
                Object::Dictionary(d) => d.clone(),
                _ => continue,
            };
            if pdf::dict_get(doc, &dict, "Event")
                .and_then(pdf::name_str)
                .as_deref()
                != Some(self.usage.event_name())
            {
                continue;
            }
            for id in ref_ids(doc, dict.get(b"OCGs").ok()) {
                let Ok(ocg) = doc.get_dictionary(id) else {
                    continue;
                };
                let Some(usage) = pdf::dict_get_dict(doc, ocg, "Usage") else {
                    continue;
                };
                let Some(usage_dict) = pdf::dict_get_dict(doc, usage, self.usage.event_name())
                else {
                    continue;
                };
                match pdf::dict_get(doc, usage_dict, self.usage.state_name())
                    .and_then(pdf::name_str)
                    .as_deref()
                {
                    Some("OFF") => {
                        if self.off.insert(id) {
                            // Chỉ ghi khi lớp *đang bật* theo cấu hình xem: nếu nó đã
                            // nằm trong `/OFF` thì không có gì lệch để nói.
                            self.usage_state_off.insert(id);
                        }
                    }
                    Some("ON") => {
                        self.off.remove(&id);
                        self.usage_state_off.remove(&id);
                    }
                    _ => {}
                }
            }
        }
    }

    /// `true` nếu tài liệu có khai optional content.
    pub fn present(&self) -> bool {
        self.present
    }

    /// `true` nếu một OCG cụ thể đang tắt.
    pub fn ocg_hidden(&self, id: ObjectId) -> bool {
        self.off.contains(&id)
    }

    /// `true` nếu lớp bị tắt **chỉ vì** khai không in (`/PrintState /OFF`).
    ///
    /// Dùng để ghi vết: cấu hình xem và cấu hình in nói khác nhau ở đúng những lớp
    /// này, nên người đọc báo cáo cần biết chúng tồn tại.
    pub fn hidden_only_for_print(&self, raw: &Object) -> bool {
        if self.usage != OptionalContentUsage::Print {
            return false;
        }
        match pdf::ref_id(raw) {
            Some(id) => self.usage_state_off.contains(&id),
            None => false,
        }
    }

    /// Quyết định một tham chiếu `/OC` (OCG hoặc OCMD) có bị **ẩn** hay không.
    ///
    /// `None` = **không quyết được**. Trả `None` thay vì đoán "hiện" là có chủ ý:
    /// caller phải bật cờ `hidden_content_risk` chứ không được im lặng vẽ tiếp.
    pub fn is_hidden(&self, doc: &Document, raw: &Object) -> Option<bool> {
        // OCG được nhận diện bằng `ObjectId`, không bằng nội dung dict: hai lớp
        // khác nhau hoàn toàn có thể có cùng `/Name`.
        if let Some(id) = pdf::ref_id(raw) {
            if let Ok(dict) = doc.get_dictionary(id) {
                let ty = pdf::dict_get(doc, dict, "Type").and_then(pdf::name_str);
                if ty.as_deref() == Some("OCMD") {
                    return self.ocmd_hidden(doc, dict, 0);
                }
                // Không có `/Type` vẫn coi là OCG nếu nó nằm trong danh sách tắt;
                // file thật hay thiếu `/Type`.
                return Some(self.ocg_hidden(id));
            }
            return Some(self.ocg_hidden(id));
        }
        // Dictionary trực tiếp (không qua tham chiếu): chỉ OCMD mới dùng được, vì
        // OCG phải so theo danh tính object.
        match pdf::deref(doc, raw) {
            Object::Dictionary(d) => {
                if pdf::dict_get(doc, d, "Type")
                    .and_then(pdf::name_str)
                    .as_deref()
                    == Some("OCMD")
                {
                    self.ocmd_hidden(doc, d, 0)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    /// OCMD: hợp nhiều OCG theo `/P`, hoặc theo `/VE` nếu có.
    fn ocmd_hidden(&self, doc: &Document, dict: &Dictionary, depth: u32) -> Option<bool> {
        // `/VE` (visibility expression) **thắng** `/OCGs` + `/P` khi cả hai có mặt.
        if let Some(ve) = pdf::dict_get(doc, dict, "VE") {
            let ve = ve.clone();
            if let Some(visible) = self.eval_ve(doc, &ve, depth) {
                return Some(!visible);
            }
            return None;
        }

        let ids = ref_ids(doc, dict.get(b"OCGs").ok());
        if ids.is_empty() {
            // OCMD không trỏ tới OCG nào ⇒ luôn hiện (§8.11.2.3).
            return Some(false);
        }
        let on: Vec<bool> = ids.iter().map(|id| !self.ocg_hidden(*id)).collect();
        let policy = pdf::dict_get(doc, dict, "P")
            .and_then(pdf::name_str)
            .unwrap_or_else(|| "AnyOn".to_string());
        let visible = match policy.as_str() {
            "AnyOn" => on.iter().any(|v| *v),
            "AllOn" => on.iter().all(|v| *v),
            "AnyOff" => on.iter().any(|v| !*v),
            "AllOff" => on.iter().all(|v| !*v),
            // Chính sách lạ: không quyết được, đừng đoán.
            _ => return None,
        };
        Some(!visible)
    }

    /// Visibility expression: `[/Not e]`, `[/And e…]`, `[/Or e…]`, hoặc một OCG.
    fn eval_ve(&self, doc: &Document, expr: &Object, depth: u32) -> Option<bool> {
        if depth > MAX_VE_DEPTH {
            return None;
        }
        // Phần tử lá: tham chiếu tới một OCG.
        if let Some(id) = pdf::ref_id(expr) {
            if !matches!(pdf::deref(doc, expr), Object::Array(_)) {
                return Some(!self.ocg_hidden(id));
            }
        }
        let arr = match pdf::deref(doc, expr) {
            Object::Array(a) => a.clone(),
            _ => return None,
        };
        let op = arr.first().and_then(pdf::name_str)?;
        let args = &arr[1..];
        match op.as_str() {
            "Not" => {
                let first = args.first()?;
                Some(!self.eval_ve(doc, first, depth + 1)?)
            }
            "And" => {
                let mut all = true;
                for a in args {
                    all &= self.eval_ve(doc, a, depth + 1)?;
                }
                Some(all)
            }
            "Or" => {
                let mut any = false;
                for a in args {
                    any |= self.eval_ve(doc, a, depth + 1)?;
                }
                Some(any)
            }
            _ => None,
        }
    }
}

fn catalog_dict(doc: &Document) -> Option<&Dictionary> {
    let root = doc.trailer.get(b"Root").ok()?;
    match pdf::deref(doc, root) {
        Object::Dictionary(d) => Some(d),
        _ => None,
    }
}

/// Thu `ObjectId` từ một tham chiếu đơn hoặc một mảng tham chiếu.
fn ref_ids(doc: &Document, obj: Option<&Object>) -> Vec<ObjectId> {
    let Some(obj) = obj else { return Vec::new() };
    if let Some(id) = pdf::ref_id(obj) {
        // Tham chiếu tới một mảng cũng hợp lệ.
        if let Object::Array(items) = pdf::deref(doc, obj) {
            return items.iter().filter_map(pdf::ref_id).collect();
        }
        return vec![id];
    }
    match obj {
        Object::Array(items) => items.iter().filter_map(pdf::ref_id).collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// Dựng tài liệu có `n` OCG; trả `(doc, ids)`.
    fn doc_with_ocgs(n: usize) -> (Document, Vec<ObjectId>) {
        let mut doc = Document::with_version("1.7");
        let ids: Vec<ObjectId> = (0..n)
            .map(|i| {
                doc.add_object(dictionary! {
                    "Type" => "OCG",
                    "Name" => format!("Lop {i}"),
                })
            })
            .collect();
        (doc, ids)
    }

    fn set_props(doc: &mut Document, props: Dictionary) {
        let props_id = doc.add_object(props);
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "OCProperties" => Object::Reference(props_id),
        });
        doc.trailer.set("Root", Object::Reference(catalog));
    }

    fn refs(ids: &[ObjectId]) -> Object {
        Object::Array(ids.iter().map(|i| Object::Reference(*i)).collect())
    }

    #[test]
    fn document_without_ocproperties_reports_absent() {
        let (doc, _) = doc_with_ocgs(0);
        let oc = OptionalContent::load(&doc);
        assert!(!oc.present());
    }

    #[test]
    fn ocg_listed_in_off_is_hidden() {
        let (mut doc, ids) = doc_with_ocgs(2);
        let d = dictionary! { "OFF" => refs(&ids[1..2]) };
        set_props(
            &mut doc,
            dictionary! { "OCGs" => refs(&ids), "D" => Object::Dictionary(d) },
        );
        let oc = OptionalContent::load(&doc);
        assert!(oc.present());
        assert!(!oc.ocg_hidden(ids[0]));
        assert!(oc.ocg_hidden(ids[1]));
    }

    #[test]
    fn base_state_off_hides_everything_except_on_list() {
        let (mut doc, ids) = doc_with_ocgs(3);
        let d = dictionary! { "BaseState" => "OFF", "ON" => refs(&ids[0..1]) };
        set_props(
            &mut doc,
            dictionary! { "OCGs" => refs(&ids), "D" => Object::Dictionary(d) },
        );
        let oc = OptionalContent::load(&doc);
        assert!(!oc.ocg_hidden(ids[0]), "trong /ON phải hiện");
        assert!(oc.ocg_hidden(ids[1]));
        assert!(oc.ocg_hidden(ids[2]));
    }

    #[test]
    fn print_state_off_hides_layer_that_is_visible_on_screen() {
        // Watermark "BẢN NHÁP": hiện trên màn hình, KHÔNG in. PPE đo mực trên giấy
        // nên phải coi lớp này là tắt.
        let mut doc = Document::with_version("1.7");
        let ocg = doc.add_object(dictionary! {
            "Type" => "OCG",
            "Name" => "Watermark",
            "Usage" => dictionary! { "Print" => dictionary! { "PrintState" => "OFF" } },
        });
        let d = dictionary! {
            // Không nằm trong /OFF ⇒ theo cấu hình xem thì đang HIỆN.
            "AS" => Object::Array(vec![Object::Dictionary(dictionary! {
                "Event" => "Print",
                "Category" => Object::Array(vec![Object::Name(b"Print".to_vec())]),
                "OCGs" => Object::Array(vec![Object::Reference(ocg)]),
            })]),
        };
        set_props(
            &mut doc,
            dictionary! {
                "OCGs" => Object::Array(vec![Object::Reference(ocg)]),
                "D" => Object::Dictionary(d),
            },
        );
        let oc = OptionalContent::load(&doc);
        assert!(oc.ocg_hidden(ocg), "lớp không-in phải bị coi là tắt");
    }

    #[test]
    fn print_state_on_overrides_off_list() {
        let mut doc = Document::with_version("1.7");
        let ocg = doc.add_object(dictionary! {
            "Type" => "OCG",
            "Usage" => dictionary! { "Print" => dictionary! { "PrintState" => "ON" } },
        });
        let d = dictionary! {
            "OFF" => Object::Array(vec![Object::Reference(ocg)]),
            "AS" => Object::Array(vec![Object::Dictionary(dictionary! {
                "Event" => "Print",
                "OCGs" => Object::Array(vec![Object::Reference(ocg)]),
            })]),
        };
        set_props(
            &mut doc,
            dictionary! {
                "OCGs" => Object::Array(vec![Object::Reference(ocg)]),
                "D" => Object::Dictionary(d),
            },
        );
        let oc = OptionalContent::load(&doc);
        assert!(
            !oc.ocg_hidden(ocg),
            "/PrintState /ON phải thắng danh sách /OFF"
        );
    }

    #[test]
    fn view_event_usage_is_ignored() {
        // `/Event /View` chỉ nói về màn hình; không được đổi kết luận về mực.
        let mut doc = Document::with_version("1.7");
        let ocg = doc.add_object(dictionary! {
            "Type" => "OCG",
            "Usage" => dictionary! { "View" => dictionary! { "ViewState" => "OFF" } },
        });
        let d = dictionary! {
            "AS" => Object::Array(vec![Object::Dictionary(dictionary! {
                "Event" => "View",
                "OCGs" => Object::Array(vec![Object::Reference(ocg)]),
            })]),
        };
        set_props(
            &mut doc,
            dictionary! {
                "OCGs" => Object::Array(vec![Object::Reference(ocg)]),
                "D" => Object::Dictionary(d),
            },
        );
        let oc = OptionalContent::load(&doc);
        assert!(!oc.ocg_hidden(ocg));
    }

    fn oc_with_off(doc: &mut Document, ids: &[ObjectId], off: &[ObjectId]) -> OptionalContent {
        let d = dictionary! { "OFF" => refs(off) };
        set_props(
            doc,
            dictionary! { "OCGs" => refs(ids), "D" => Object::Dictionary(d) },
        );
        OptionalContent::load(doc)
    }

    #[test]
    fn ocmd_any_on_is_the_default_policy() {
        let (mut doc, ids) = doc_with_ocgs(2);
        let ocmd = doc.add_object(dictionary! {
            "Type" => "OCMD",
            "OCGs" => refs(&ids),
        });
        let oc = oc_with_off(&mut doc, &ids, &ids[0..1]);
        // Một cái tắt, một cái bật ⇒ AnyOn ⇒ vẫn hiện.
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd)), Some(false));
    }

    #[test]
    fn ocmd_all_on_hides_when_one_is_off() {
        let (mut doc, ids) = doc_with_ocgs(2);
        let ocmd = doc.add_object(dictionary! {
            "Type" => "OCMD",
            "OCGs" => refs(&ids),
            "P" => "AllOn",
        });
        let oc = oc_with_off(&mut doc, &ids, &ids[0..1]);
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd)), Some(true));
    }

    #[test]
    fn ocmd_any_off_and_all_off_are_supported() {
        let (mut doc, ids) = doc_with_ocgs(2);
        let any_off = doc.add_object(dictionary! {
            "Type" => "OCMD", "OCGs" => refs(&ids), "P" => "AnyOff",
        });
        let all_off = doc.add_object(dictionary! {
            "Type" => "OCMD", "OCGs" => refs(&ids), "P" => "AllOff",
        });
        let oc = oc_with_off(&mut doc, &ids, &ids[0..1]);
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(any_off)), Some(false));
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(all_off)), Some(true));
    }

    #[test]
    fn ocmd_with_no_ocgs_is_always_visible() {
        let (mut doc, ids) = doc_with_ocgs(1);
        let ocmd = doc.add_object(dictionary! { "Type" => "OCMD" });
        let oc = oc_with_off(&mut doc, &ids, &ids);
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd)), Some(false));
    }

    #[test]
    fn ocmd_with_unknown_policy_is_undecidable_not_guessed() {
        let (mut doc, ids) = doc_with_ocgs(1);
        let ocmd = doc.add_object(dictionary! {
            "Type" => "OCMD", "OCGs" => refs(&ids), "P" => "KhongCo",
        });
        let oc = oc_with_off(&mut doc, &ids, &[]);
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd)), None);
    }

    #[test]
    fn visibility_expression_not_inverts() {
        let (mut doc, ids) = doc_with_ocgs(1);
        let ve = Object::Array(vec![
            Object::Name(b"Not".to_vec()),
            Object::Reference(ids[0]),
        ]);
        let ocmd = doc.add_object(dictionary! { "Type" => "OCMD", "VE" => ve });
        let oc = oc_with_off(&mut doc, &ids, &[]);
        // OCG đang bật ⇒ Not ⇒ không hiện.
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd)), Some(true));
    }

    #[test]
    fn visibility_expression_and_or_work() {
        let (mut doc, ids) = doc_with_ocgs(2);
        let and = Object::Array(vec![
            Object::Name(b"And".to_vec()),
            Object::Reference(ids[0]),
            Object::Reference(ids[1]),
        ]);
        let or = Object::Array(vec![
            Object::Name(b"Or".to_vec()),
            Object::Reference(ids[0]),
            Object::Reference(ids[1]),
        ]);
        let ocmd_and = doc.add_object(dictionary! { "Type" => "OCMD", "VE" => and });
        let ocmd_or = doc.add_object(dictionary! { "Type" => "OCMD", "VE" => or });
        let oc = oc_with_off(&mut doc, &ids, &ids[0..1]);
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd_and)), Some(true));
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd_or)), Some(false));
    }

    #[test]
    fn visibility_expression_takes_precedence_over_policy() {
        // `/VE` thắng `/OCGs` + `/P` (§8.11.2.3). Nếu cài sai thứ tự, một OCMD dùng
        // cả hai sẽ cho kết quả trái ngược.
        let (mut doc, ids) = doc_with_ocgs(1);
        let ve = Object::Array(vec![
            Object::Name(b"Not".to_vec()),
            Object::Reference(ids[0]),
        ]);
        let ocmd = doc.add_object(dictionary! {
            "Type" => "OCMD",
            "OCGs" => refs(&ids),
            "P" => "AnyOn",
            "VE" => ve,
        });
        let oc = oc_with_off(&mut doc, &ids, &[]);
        assert_eq!(oc.is_hidden(&doc, &Object::Reference(ocmd)), Some(true));
    }

    #[test]
    fn inline_dictionary_that_is_not_ocmd_is_undecidable() {
        // OCG phải so theo danh tính object; một dict lồng trực tiếp không có danh
        // tính nên không quyết được — và phải nói ra chứ không đoán "hiện".
        let (doc, _) = doc_with_ocgs(0);
        let obj = Object::Dictionary(dictionary! { "Type" => "OCG", "Name" => "X" });
        assert_eq!(OptionalContent::load(&doc).is_hidden(&doc, &obj), None);
    }
}
