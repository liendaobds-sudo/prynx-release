//! Bàn giao boong PDF thành layer/group Illustrator, không đoán theo hình học/màu.

use lopdf::{
    content::{Content, Operation},
    dictionary, Dictionary, Document, Object, ObjectId,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize)]
struct Color {
    space: String,
    values: Vec<f32>,
}

#[derive(Clone)]
struct Paint {
    stroke: Option<Color>,
    fill: Option<Color>,
}

impl Default for Paint {
    fn default() -> Self {
        let black = Some(Color {
            space: "DeviceGray".into(),
            values: vec![0.0],
        });
        Self {
            stroke: black.clone(),
            fill: black,
        }
    }
}

#[derive(Clone, Default)]
struct Scope {
    group: Option<ObjectId>,
    item: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Mark {
    token: String,
    layer_key: usize,
    group_key: usize,
    layer_name: String,
    group_name: String,
    item_name: String,
    stroke: Option<Color>,
    fill: Option<Color>,
}

pub(super) struct Prepared {
    pub pdf: Vec<u8>,
    marks: Vec<Mark>,
    info_names: Vec<String>,
    token_prefix: String,
}

fn resolve<'a>(doc: &'a Document, value: &'a Object) -> Result<&'a Object, String> {
    doc.dereference(value)
        .map(|(_, value)| value)
        .map_err(|e| e.to_string())
}

fn dict<'a>(doc: &'a Document, value: &'a Object) -> Result<&'a Dictionary, String> {
    resolve(doc, value)?.as_dict().map_err(|e| e.to_string())
}

fn text(value: &Object) -> Result<String, String> {
    lopdf::decode_text_string(value).map_err(|_| "Tên layer PDF không hợp lệ.".into())
}

fn group_parents(
    order: &[Object],
    parent: Option<ObjectId>,
    map: &mut BTreeMap<ObjectId, ObjectId>,
) {
    let mut preceding = parent;
    for value in order {
        match value {
            Object::Reference(id) => {
                if let Some(parent) = parent {
                    map.insert(*id, parent);
                }
                preceding = Some(*id);
            }
            Object::Array(children) => group_parents(children, preceding, map),
            _ => {}
        }
    }
}

fn color(space: &str, operands: &[Object], count: usize) -> Result<Color, String> {
    if operands.len() != count {
        return Err("Số thành phần màu boong không hợp lệ.".into());
    }
    let values = operands
        .iter()
        .map(|value| {
            let number = value.as_float().map_err(|e| e.to_string())?;
            if !number.is_finite() || !(0.0..=1.0).contains(&number) {
                return Err("Thành phần màu boong ngoài khoảng hợp lệ.".into());
            }
            Ok(number)
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(Color {
        space: space.into(),
        values,
    })
}

fn spot(colorspaces: &mut Dictionary, token: &str, value: &Color) -> Object {
    let function = dictionary! {
        "FunctionType" => 2,
        "Domain" => vec![0.into(), 1.into()],
        "C0" => vec![Object::Integer(0); value.values.len()],
        "C1" => value.values.iter().map(|n| Object::Real(*n)).collect::<Vec<_>>(),
        "N" => 1,
    };
    colorspaces.set(
        token,
        vec![
            Object::Name(b"Separation".to_vec()),
            Object::Name(token.as_bytes().to_vec()),
            Object::Name(value.space.as_bytes().to_vec()),
            Object::Dictionary(function),
        ],
    );
    Object::Name(token.as_bytes().to_vec())
}

pub(super) fn prepare(bytes: &[u8]) -> Result<Option<Prepared>, String> {
    // Dùng đúng chính sách parser theo RAM của viewer, không thêm hard cap riêng.
    let mut doc = crate::load_lopdf_structure(bytes, crate::system_total_memory_bytes())?;
    let root = doc.catalog().map_err(|e| e.to_string())?;
    let Ok(raw_props) = root.get(b"OCProperties") else {
        return Ok(None);
    };
    let props = dict(&doc, raw_props)?;
    let mut names = BTreeMap::new();
    for value in props
        .get(b"OCGs")
        .and_then(Object::as_array)
        .map_err(|e| e.to_string())?
    {
        let id = value.as_reference().map_err(|e| e.to_string())?;
        names.insert(
            id,
            text(dict(&doc, value)?.get(b"Name").map_err(|e| e.to_string())?)?,
        );
    }
    let default = dict(&doc, props.get(b"D").map_err(|e| e.to_string())?)?;
    let order = default
        .get(b"Order")
        .and_then(Object::as_array)
        .map_err(|e| e.to_string())?;
    let mut parents = BTreeMap::new();
    group_parents(order, None, &mut parents);
    let pages = doc.get_pages();
    if pages.len() != 1 {
        return Err("Hãy chọn một trang khuôn để mở với layer Illustrator. Mỗi lượt bàn giao xử lý một trang.".into());
    }
    let page_id = *pages.values().next().ok_or("PDF không có trang.")?;
    let page = doc.get_dictionary(page_id).map_err(|e| e.to_string())?;
    let mut resources = dict(&doc, page.get(b"Resources").map_err(|e| e.to_string())?)?.clone();
    let properties = match resources.get(b"Properties") {
        Ok(value) => dict(&doc, value)?.clone(),
        Err(_) => return Ok(None),
    };
    let mut colorspaces = match resources.get(b"ColorSpace") {
        Ok(value) => dict(&doc, value)?.clone(),
        Err(_) => Dictionary::new(),
    };
    // Illustrator 29 cắt tên spot ở 31 byte; đặt chỉ số trước giới hạn này.
    let prefix = format!("P{}", hex::encode(rand::random::<[u8; 6]>()));
    let content = Content::decode(&doc.get_page_content(page_id))
        .map_err(|e| format!("Không đọc được nội dung trang khuôn: {e}"))?;
    let mut operations = Vec::new();
    let mut scopes = vec![Scope::default()];
    let mut paint = Paint::default();
    let mut paints = Vec::new();
    let mut marks = Vec::new();
    let mut used = BTreeSet::new();
    let ids: Vec<ObjectId> = names.keys().copied().collect();
    for operation in content.operations {
        let operands = &operation.operands;
        match operation.operator.as_str() {
            "q" => paints.push(paint.clone()),
            "Q" => paint = paints.pop().ok_or("Ngăn xếp màu PDF không hợp lệ.")?,
            "K" => paint.stroke = Some(color("DeviceCMYK", operands, 4)?),
            "k" => paint.fill = Some(color("DeviceCMYK", operands, 4)?),
            "RG" => paint.stroke = Some(color("DeviceRGB", operands, 3)?),
            "rg" => paint.fill = Some(color("DeviceRGB", operands, 3)?),
            "G" => paint.stroke = Some(color("DeviceGray", operands, 1)?),
            "g" => paint.fill = Some(color("DeviceGray", operands, 1)?),
            "CS" | "SC" | "SCN" => paint.stroke = None,
            "cs" | "sc" | "scn" => paint.fill = None,
            "BMC" | "BDC" => {
                let mut scope = scopes.last().cloned().unwrap_or_default();
                if operation.operator == "BDC" && operands.len() == 2 {
                    let value = match &operands[1] {
                        Object::Name(name) => properties.get(name).map_err(|e| e.to_string())?,
                        value => value,
                    };
                    let property = dict(&doc, value)?;
                    if operands[0].as_name().ok() == Some(b"OC".as_slice()) {
                        scope.group = value
                            .as_reference()
                            .ok()
                            .filter(|id| names.contains_key(id));
                    }
                    if let Ok(value) = property.get(b"NM") {
                        scope.item = Some(text(value)?);
                    }
                }
                scopes.push(scope);
            }
            "EMC" => {
                if scopes.len() <= 1 {
                    return Err("Ngăn xếp layer PDF không hợp lệ.".into());
                }
                scopes.pop();
            }
            _ => {}
        }
        let scope = scopes.last().cloned().unwrap_or_default();
        if let (Some(group), Some(item)) = (scope.group, scope.item) {
            let op = operation.operator.as_str();
            if matches!(op, "Do" | "sh" | "Tj" | "TJ") {
                return Err("Boong chứa đối tượng chưa hỗ trợ bàn giao Illustrator.".into());
            }
            if matches!(op, "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*") {
                let stroke = if matches!(op, "S" | "s" | "B" | "B*" | "b" | "b*") {
                    Some(paint.stroke.clone().ok_or("Màu nét boong chưa hỗ trợ.")?)
                } else {
                    None
                };
                let fill = if !matches!(op, "S" | "s") {
                    Some(paint.fill.clone().ok_or("Màu nền boong chưa hỗ trợ.")?)
                } else {
                    None
                };
                let layer = *parents
                    .get(&group)
                    .ok_or("Boong thiếu quan hệ layer cha/group.")?;
                let layer_name = names
                    .get(&layer)
                    .ok_or("Không tìm thấy tên layer cha.")?
                    .clone();
                let token = format!("{prefix}_{:x}", marks.len());
                operations.push(Operation::new("q", vec![]));
                for (suffix, value, cs, scn) in
                    [("S", &stroke, "CS", "SCN"), ("F", &fill, "cs", "scn")]
                {
                    if let Some(value) = value {
                        let resource = spot(&mut colorspaces, &format!("{token}{suffix}"), value);
                        operations.push(Operation::new(cs, vec![resource]));
                        operations.push(Operation::new(scn, vec![1.into()]));
                    }
                }
                operations.push(operation);
                operations.push(Operation::new("Q", vec![]));
                used.extend([layer, group]);
                marks.push(Mark {
                    token,
                    layer_key: ids.iter().position(|id| *id == layer).unwrap(),
                    group_key: ids.iter().position(|id| *id == group).unwrap(),
                    layer_name,
                    group_name: names[&group].clone(),
                    item_name: item,
                    stroke,
                    fill,
                });
                continue;
            }
        }
        operations.push(operation);
    }
    if marks.is_empty() {
        return Ok(None);
    }
    if scopes.len() != 1 || !paints.is_empty() {
        return Err("Cấu trúc trang PDF chưa khép kín.".into());
    }
    let info_names = names
        .into_iter()
        .filter(|(id, _)| !used.contains(id))
        .map(|(_, name)| name)
        .collect();
    resources.set("ColorSpace", colorspaces);
    doc.get_dictionary_mut(page_id)
        .map_err(|e| e.to_string())?
        .set("Resources", resources);
    doc.change_page_content(
        page_id,
        Content { operations }.encode().map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut pdf = Vec::new();
    doc.save_to(&mut pdf).map_err(|e| e.to_string())?;
    Ok(Some(Prepared {
        pdf,
        marks,
        info_names,
        token_prefix: prefix,
    }))
}

impl Prepared {
    pub(super) fn script(&self, path: &str, app_path: &str) -> Result<String, String> {
        let payload = serde_json::json!({
            "path": path, "appPath": app_path, "marks": self.marks,
            "infoNames": self.info_names, "tokenPrefix": self.token_prefix,
        });
        // Chỉ dữ liệu JSON được ghép vào script cố định; không nhận mã từ renderer/PDF.
        let data = serde_json::to_string(&payload)
            .map_err(|e| e.to_string())?
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
        Ok(format!(
            "{}({data});",
            include_str!("illustrator_handoff.js")
        ))
    }
}

pub(super) fn open(app_path: &str, file_path: &str) -> Result<bool, String> {
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    // Giữ handle không share WRITE/DELETE suốt lượt đọc và bàn giao.
    let mut source = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(file_path)
        .map_err(|e| format!("Không mở được file khuôn: {e}"))?;
    let mut bytes = Vec::new();
    source.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let Some(prepared) = prepare(&bytes)? else {
        return Ok(false);
    };
    drop(bytes);

    let name = format!(
        "prynx_illustrator_{}.pdf",
        hex::encode(rand::random::<[u8; 16]>())
    );
    let path = std::env::temp_dir().join(name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .share_mode(1)
        .open(&path)
        .map_err(|e| format!("Không tạo được bản bàn giao Illustrator: {e}"))?;
    file.write_all(&prepared.pdf).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    // Illustrator mở file với share READ, không chấp nhận handle WRITE còn sống.
    // Hạ về read lease rồi kiểm từng byte trước khi gửi đường dẫn sang COM.
    drop(file);
    let mut file = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .map_err(|e| format!("Không khóa được bản bàn giao: {e}"))?;
    let mut buffer = [0u8; 8192];
    for expected in prepared.pdf.chunks(buffer.len()) {
        file.read_exact(&mut buffer[..expected.len()])
            .map_err(|e| e.to_string())?;
        if &buffer[..expected.len()] != expected {
            return Err("Bản bàn giao thay đổi trước khi mở Illustrator.".into());
        }
    }
    if file.read(&mut buffer[..1]).map_err(|e| e.to_string())? != 0 {
        return Err("Bản bàn giao có nội dung ngoài dự kiến.".into());
    }
    drop(file);
    let script = prepared.script(&path.to_string_lossy(), app_path)?;
    // Chỉ khởi động EXE đã qua authorize_app_path; không dùng New-Object COM để
    // kích hoạt một EXE khác theo registry. COM phải trỏ đúng app.path trong JSX.
    Command::new(app_path)
        .spawn()
        .map_err(|e| format!("Không mở được Illustrator: {e}"))?;
    const POWERSHELL: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script = [Console]::In.ReadToEnd()
$deadline = [DateTime]::UtcNow.AddSeconds(12)
$ai = $null
while ($null -eq $ai -and [DateTime]::UtcNow -lt $deadline) {
    try { $ai = [Runtime.InteropServices.Marshal]::GetActiveObject('Illustrator.Application') }
    catch { Start-Sleep -Milliseconds 250 }
}
if ($null -eq $ai) {
    try { $ai = New-Object -ComObject 'Illustrator.Application' }
    catch { }
}
if ($null -eq $ai) { throw 'Illustrator chua san sang.' }
$result = $ai.DoJavaScript($script)
if (-not ([string]$result).StartsWith('PRYNX_OK:')) { throw 'Illustrator khong xac nhan cay layer.' }
[Console]::Out.Write([string]$result)
"#;
    let mut process = Command::new(crate::security::system_powershell_path()?)
        .args([
            "-NoProfile",
            "-NoLogo",
            "-NonInteractive",
            "-Command",
            POWERSHELL,
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Không kết nối được Illustrator: {e}"))?;
    let write_result = process
        .stdin
        .take()
        .ok_or("Thiếu kênh bàn giao Illustrator.")?
        .write_all(script.as_bytes());
    let result = process.wait_with_output().map_err(|e| e.to_string())?;
    write_result.map_err(|e| format!("Không gửi được dữ liệu layer: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "Không dựng được layer Illustrator: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    let expected = format!("PRYNX_OK:{}", prepared.marks.len());
    if String::from_utf8_lossy(&result.stdout).trim() != expected {
        return Err("Illustrator trả số đối tượng boong không khớp.".into());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(marked: &str) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let info = doc.add_object(
            dictionary! { "Type" => "OCG", "Name" => lopdf::text_string("SA info Ốc") },
        );
        let layer = doc.add_object(
            dictionary! { "Type" => "OCG", "Name" => lopdf::text_string("Marks_Model_") },
        );
        let group = doc
            .add_object(dictionary! { "Type" => "OCG", "Name" => lopdf::text_string("MarkLine") });
        let pages = doc.new_object_id();
        let content = doc.add_object(lopdf::Stream::new(
            Dictionary::new(),
            format!(
                "q 0 1 0 0 K 0 0 m 10 10 l S Q\n/OC /Group BDC /Span /Item BDC {marked} EMC EMC"
            )
            .into_bytes(),
        ));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Contents" => content,
            "Resources" => dictionary! { "Properties" => dictionary! {
                "Group" => group, "Item" => dictionary! { "NM" => lopdf::text_string("MKLINE") },
            } },
        });
        doc.objects.insert(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 }.into(),
        );
        let root = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages,
            "OCProperties" => dictionary! {
                "OCGs" => vec![info.into(), layer.into(), group.into()],
                "D" => dictionary! { "Order" => vec![info.into(), layer.into(), Object::Array(vec![group.into()])] },
            },
        });
        doc.trailer.set("Root", root);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn danh_dau_dung_boong_khong_doi_duong_be() {
        let source = fixture("q 1 1 1 1 K 0.5 w 20 20 m 25 20 l 25 25 l S Q");
        let prepared = prepare(&source).unwrap().unwrap();
        assert_eq!(prepared.marks.len(), 1);
        assert_eq!(prepared.info_names, ["SA info Ốc"]);
        let mark = &prepared.marks[0];
        assert_eq!(mark.layer_name, "Marks_Model_");
        assert_eq!(mark.group_name, "MarkLine");
        assert_eq!(mark.item_name, "MKLINE");
        assert_eq!(mark.stroke.as_ref().unwrap().values, [1.0, 1.0, 1.0, 1.0]);
        assert!(mark.fill.is_none());
        let doc = Document::load_mem(&prepared.pdf).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let ops = Content::decode(&doc.get_page_content(page))
            .unwrap()
            .operations;
        assert_eq!(ops.iter().filter(|op| op.operator == "S").count(), 2);
        let first_paint = ops.iter().position(|op| op.operator == "S").unwrap();
        assert!(!ops[..first_paint].iter().any(|op| op.operator == "CS"));
        assert_eq!(ops.iter().filter(|op| op.operator == "CS").count(), 1);
        assert_eq!(ops.iter().filter(|op| op.operator == "l").count(), 3);
    }

    #[test]
    fn mau_fill_stroke_va_q_q_duoc_giu_rieng() {
        let prepared = prepare(&fixture(
            "1 1 1 1 K q 1 0 0 RG 0 1 0 rg 10 10 5 5 re B Q 20 20 m 25 25 l S",
        ))
        .unwrap()
        .unwrap();
        assert_eq!(prepared.marks.len(), 2);
        assert_eq!(
            prepared.marks[0].stroke.as_ref().unwrap().space,
            "DeviceRGB"
        );
        assert_eq!(
            prepared.marks[0].fill.as_ref().unwrap().values,
            [0.0, 1.0, 0.0]
        );
        assert_eq!(
            prepared.marks[1].stroke.as_ref().unwrap().space,
            "DeviceCMYK"
        );
        assert_ne!(prepared.marks[0].token, prepared.marks[1].token);
        for mark in &prepared.marks {
            assert!(format!("{}S", mark.token).len() <= 31);
            assert!(format!("{}F", mark.token).len() <= 31);
        }
    }

    #[test]
    fn boong_tron_fill_va_guide_nhieu_net() {
        let prepared = prepare(&fixture(
            "1 1 1 1 k 10 10 m 10 15 15 15 15 10 c 15 5 10 5 10 10 c f \
             1 1 1 1 K 0 0 m 0 10 l S 20 0 m 20 10 l S",
        ))
        .unwrap()
        .unwrap();
        assert_eq!(prepared.marks.len(), 3);
        assert!(prepared.marks[0].fill.is_some());
        assert!(prepared.marks[0].stroke.is_none());
    }

    #[test]
    fn ten_khong_the_thoat_khoi_du_lieu_json() {
        let mut prepared = prepare(&fixture("0 G 10 10 m 20 20 l S")).unwrap().unwrap();
        let hostile = "\"); app.activeDocument.close(); //\nỐc\u{2028}";
        prepared.marks[0].item_name = hostile.into();
        let script = prepared
            .script("C:\\temp\\khuon.pdf", "C:\\Adobe\\Illustrator.exe")
            .unwrap();
        let data = script
            .strip_prefix(include_str!("illustrator_handoff.js"))
            .unwrap()
            .strip_prefix('(')
            .unwrap()
            .strip_suffix(");")
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(data).unwrap();
        assert_eq!(parsed["marks"][0]["itemName"], hostile);
        assert!(!data.contains('\u{2028}'));
    }

    #[test]
    fn tu_choi_mau_va_doi_tuong_chua_ho_tro() {
        for marked in [
            "/Other CS 1 SCN 0 0 m 10 10 l S",
            "/Form Do",
            "Q 0 G 0 0 m 10 10 l S",
        ] {
            assert!(prepare(&fixture(marked)).is_err());
        }
    }

    #[test]
    fn pdf_khong_co_boong_khong_bi_doi() {
        assert!(prepare(&fixture("0 0 m 10 10 l n")).unwrap().is_none());
        let mut doc = Document::load_mem(&fixture("0 G 0 0 m 10 10 l S")).unwrap();
        doc.catalog_mut().unwrap().remove(b"OCProperties");
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert!(prepare(&bytes).unwrap().is_none());
    }

    #[test]
    fn nhieu_trang_khong_am_tham_mo_nham_mot_trang() {
        let mut doc = Document::load_mem(&fixture("0 G 0 0 m 10 10 l S")).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        let parent = doc
            .get_dictionary(page)
            .unwrap()
            .get(b"Parent")
            .unwrap()
            .as_reference()
            .unwrap();
        let new_page = doc.add_object(doc.get_dictionary(page).unwrap().clone());
        let pages = doc.get_dictionary_mut(parent).unwrap();
        pages.set(
            "Kids",
            vec![Object::Reference(page), Object::Reference(new_page)],
        );
        pages.set("Count", 2);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert!(prepare(&bytes).err().unwrap().contains("một trang"));
    }

    #[test]
    #[ignore = "Mở bản sao PDF trong Illustrator thật; chỉ chạy khi người dùng cho phép"]
    fn smoke_illustrator_that() {
        let app = std::env::var("PRYNX_TEST_ILLUSTRATOR_EXE").unwrap();
        let source = std::env::var("PRYNX_TEST_CUT_PDF").unwrap();
        assert!(open(&app, &source).unwrap());
    }
}
