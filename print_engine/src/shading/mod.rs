//! Shading (gradient) — ISO 32000-2 §8.7.4.5.
//!
//! # Vì sao shading quan trọng với đo mực
//!
//! Trước milestone này, mọi trang có gradient đều bật `ink_unsound` và bị nhường
//! hết cho Ghostscript. Đó là lớp file lớn nhất PPE chưa lấy được: nhãn, bao bì,
//! phông nền gần như luôn có ít nhất một dải chuyển màu.
//!
//! Gradient cũng là chỗ TAC dễ vượt ngưỡng nhất mà mắt không thấy: vùng tối của
//! một dải chuyển sang đen có thể lên 380% mực trong khi phần còn lại của trang
//! rất nhẹ. Bỏ shading không chỉ làm thiếu mực — nó làm thiếu **đúng chỗ nguy
//! hiểm nhất**.
//!
//! # Phạm vi
//!
//! Kiểu 1 (theo hàm), 2 (dọc trục), 3 (theo bán kính) — ba kiểu này chiếm gần
//! toàn bộ file thực tế. Kiểu 4–7 (lưới tam giác Gouraud, Coons, tensor) chưa
//! dựng: chúng bị báo là chưa hỗ trợ để trang rơi về Ghostscript, chứ không được
//! vẽ xấp xỉ rồi báo là tin được.

pub mod eval;
pub mod mesh;

use lopdf::{Dictionary, Document, Object};

use crate::shading::mesh::MeshTriangle;

use crate::color::space::{resolve_colorspace, resolve_function};
use crate::color::{ColorSpace, PdfFunction};
use crate::error::{PpeError, PpeResult, RenderWarnings};
use crate::geom::{Matrix, Rect};
use crate::pdf;

/// Kiểu shading đã phân giải.
#[derive(Debug, Clone)]
pub enum ShadingKind {
    /// Kiểu 1 — màu là hàm của (x, y) trong `domain`.
    FunctionBased {
        /// `[x0 x1 y0 y1]`.
        domain: [f32; 4],
        /// Ma trận riêng của shading, đưa domain về không gian shading.
        matrix: Matrix,
    },
    /// Kiểu 2 — dọc trục từ `(x0,y0)` tới `(x1,y1)`.
    Axial {
        coords: [f32; 4],
        domain: [f32; 2],
        extend: [bool; 2],
    },
    /// Kiểu 3 — giữa hai đường tròn.
    Radial {
        coords: [f32; 6],
        domain: [f32; 2],
        extend: [bool; 2],
    },
    /// Kiểu 4–7 — lưới tam giác, đã quy về một dạng duy nhất.
    ///
    /// Khác ba kiểu trên, màu ở đây **không** là hàm của vị trí: nó nằm ở các đỉnh.
    /// Nên đường vẽ của lưới không dùng bảng LUT theo `t` mà nội suy theo toạ độ
    /// trọng tâm của từng tam giác — xem [`mesh`].
    Mesh { triangles: Vec<MeshTriangle> },
}

/// Shading đã phân giải, sẵn sàng lấy màu theo điểm.
#[derive(Debug, Clone)]
pub struct Shading {
    pub kind: ShadingKind,
    pub colorspace: ColorSpace,
    /// Hàm màu. Một hàm nhiều output, hoặc nhiều hàm một output đã ghép.
    pub function: Option<PdfFunction>,
    /// `/BBox` trong không gian shading.
    pub bbox: Option<Rect>,
    /// `/Background` — màu ngoài vùng shading, chỉ dùng cho pattern chứ không
    /// dùng cho `sh` (§8.7.4.3).
    pub background: Option<Vec<f32>>,
}

/// Phân giải shading dictionary.
pub fn resolve_shading(
    doc: &Document,
    obj: &Object,
    resources: Option<&Dictionary>,
    warn: &mut RenderWarnings,
) -> PpeResult<Shading> {
    let resolved = pdf::deref(doc, obj);
    let dict = match resolved {
        Object::Dictionary(d) => d,
        Object::Stream(s) => &s.dict,
        _ => return Err(PpeError::MalformedPdf("shading không phải dict/stream".into())),
    };

    let shading_type = pdf::dict_get(doc, dict, "ShadingType")
        .and_then(pdf::as_num)
        .ok_or_else(|| PpeError::MalformedPdf("shading thiếu ShadingType".into()))?
        as i32;

    let cs_obj = dict
        .get(b"ColorSpace")
        .map_err(|_| PpeError::MalformedPdf("shading thiếu ColorSpace".into()))?
        .clone();
    let colorspace = resolve_colorspace(doc, &cs_obj, resources, warn)?;

    let function = match dict.get(b"Function") {
        Ok(f) => Some(resolve_function(doc, f)?),
        Err(_) => None,
    };

    let bbox = pdf::dict_get(doc, dict, "BBox")
        .and_then(|o| pdf::num_array(doc, o))
        .and_then(|v| (v.len() >= 4).then(|| Rect::new(v[0], v[1], v[2], v[3])));
    let background = pdf::dict_get(doc, dict, "Background").and_then(|o| pdf::num_array(doc, o));

    let kind = match shading_type {
        1 => {
            let domain = pdf::dict_get(doc, dict, "Domain")
                .and_then(|o| pdf::num_array(doc, o))
                .filter(|v| v.len() >= 4)
                .map(|v| [v[0], v[1], v[2], v[3]])
                .unwrap_or([0.0, 1.0, 0.0, 1.0]);
            let matrix = pdf::dict_get(doc, dict, "Matrix")
                .and_then(|o| pdf::num_array(doc, o))
                .and_then(|v| {
                    (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5]))
                })
                .unwrap_or(Matrix::IDENTITY);
            ShadingKind::FunctionBased { domain, matrix }
        }
        2 | 3 => {
            let coords = pdf::dict_get(doc, dict, "Coords")
                .and_then(|o| pdf::num_array(doc, o))
                .ok_or_else(|| PpeError::MalformedPdf("shading thiếu Coords".into()))?;
            let domain = pdf::dict_get(doc, dict, "Domain")
                .and_then(|o| pdf::num_array(doc, o))
                .filter(|v| v.len() >= 2)
                .map(|v| [v[0], v[1]])
                .unwrap_or([0.0, 1.0]);
            // `/Extend` mặc định [false false]. Bỏ qua nó làm dải chuyển kết thúc
            // đột ngột ở đầu trục thay vì phủ tiếp — sai diện tích phủ mực.
            let extend = match pdf::dict_get(doc, dict, "Extend") {
                Some(Object::Array(items)) if items.len() >= 2 => [
                    matches!(pdf::deref(doc, &items[0]), Object::Boolean(true)),
                    matches!(pdf::deref(doc, &items[1]), Object::Boolean(true)),
                ],
                _ => [false, false],
            };
            if shading_type == 2 {
                if coords.len() < 4 {
                    return Err(PpeError::MalformedPdf("shading kiểu 2 cần 4 toạ độ".into()));
                }
                ShadingKind::Axial {
                    coords: [coords[0], coords[1], coords[2], coords[3]],
                    domain,
                    extend,
                }
            } else {
                if coords.len() < 6 {
                    return Err(PpeError::MalformedPdf("shading kiểu 3 cần 6 toạ độ".into()));
                }
                ShadingKind::Radial {
                    coords: [
                        coords[0], coords[1], coords[2], coords[3], coords[4], coords[5],
                    ],
                    domain,
                    extend,
                }
            }
        }
        4..=7 => {
            // Dữ liệu lưới nằm trong **stream**, không trong dictionary. Một shading
            // kiểu 4–7 khai bằng dictionary là file hỏng, không phải lưới rỗng.
            let Object::Stream(stream) = resolved else {
                return Err(PpeError::MalformedPdf(format!(
                    "shading kiểu {shading_type} phải là stream"
                )));
            };
            let data = stream
                .decompressed_content()
                .unwrap_or_else(|_| stream.content.clone());
            let triangles = mesh::parse_mesh(
                doc,
                dict,
                shading_type,
                &data,
                function.as_ref(),
                colorspace.n_components(),
            )?;
            ShadingKind::Mesh { triangles }
        }
        other => {
            return Err(PpeError::MalformedPdf(format!(
                "ShadingType {other} không tồn tại"
            )));
        }
    };

    Ok(Shading { kind, colorspace, function, bbox, background })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn warn() -> RenderWarnings {
        RenderWarnings::default()
    }

    fn axial_dict() -> Dictionary {
        dictionary! {
            "ShadingType" => 2,
            "ColorSpace" => "DeviceCMYK",
            "Coords" => vec![0.into(), 0.into(), 100.into(), 0.into()],
            "Function" => Object::Dictionary(dictionary! {
                "FunctionType" => 2,
                "Domain" => vec![0.into(), 1.into()],
                "C0" => vec![0.into(), 0.into(), 0.into(), 0.into()],
                "C1" => vec![0.into(), 0.into(), 0.into(), 1.into()],
                "N" => 1,
                "Range" => vec![
                    0.into(), 1.into(), 0.into(), 1.into(),
                    0.into(), 1.into(), 0.into(), 1.into(),
                ],
            }),
        }
    }

    #[test]
    fn axial_shading_resolves() {
        let doc = Document::new();
        let mut w = warn();
        let sh = resolve_shading(&doc, &Object::Dictionary(axial_dict()), None, &mut w).unwrap();
        assert!(matches!(sh.kind, ShadingKind::Axial { .. }));
        assert!(sh.function.is_some());
    }

    #[test]
    fn extend_defaults_to_false_false() {
        let doc = Document::new();
        let mut w = warn();
        let sh = resolve_shading(&doc, &Object::Dictionary(axial_dict()), None, &mut w).unwrap();
        match sh.kind {
            ShadingKind::Axial { extend, .. } => assert_eq!(extend, [false, false]),
            _ => panic!("phải là axial"),
        }
    }

    #[test]
    fn extend_is_read_when_present() {
        let doc = Document::new();
        let mut d = axial_dict();
        d.set(
            "Extend",
            Object::Array(vec![Object::Boolean(true), Object::Boolean(false)]),
        );
        let mut w = warn();
        let sh = resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).unwrap();
        match sh.kind {
            ShadingKind::Axial { extend, .. } => assert_eq!(extend, [true, false]),
            _ => panic!("phải là axial"),
        }
    }

    #[test]
    fn radial_needs_six_coords() {
        let doc = Document::new();
        let mut d = axial_dict();
        d.set("ShadingType", Object::Integer(3));
        let mut w = warn();
        // Vẫn 4 toạ độ ⇒ phải báo lỗi thay vì đọc rác.
        assert!(resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).is_err());
    }

    #[test]
    fn radial_resolves_with_six_coords() {
        let doc = Document::new();
        let mut d = axial_dict();
        d.set("ShadingType", Object::Integer(3));
        d.set(
            "Coords",
            Object::Array(vec![
                50.into(),
                50.into(),
                0.into(),
                50.into(),
                50.into(),
                40.into(),
            ]),
        );
        let mut w = warn();
        let sh = resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).unwrap();
        assert!(matches!(sh.kind, ShadingKind::Radial { .. }));
    }

    #[test]
    fn mesh_shading_declared_as_dictionary_is_an_error() {
        // Dữ liệu lưới nằm trong stream. Một dict kiểu 4–7 là file hỏng — phải báo,
        // không được coi là lưới rỗng rồi vẽ trang trắng.
        let doc = Document::new();
        for t in [4, 5, 6, 7] {
            let mut d = axial_dict();
            d.set("ShadingType", Object::Integer(t));
            let mut w = warn();
            assert!(
                resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).is_err(),
                "kiểu {t} phải báo lỗi"
            );
        }
    }

    #[test]
    fn unknown_shading_type_is_an_error() {
        let doc = Document::new();
        let mut d = axial_dict();
        d.set("ShadingType", Object::Integer(9));
        let mut w = warn();
        assert!(resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).is_err());
    }

    #[test]
    fn missing_shading_type_is_an_error() {
        let doc = Document::new();
        let mut d = axial_dict();
        d.remove(b"ShadingType");
        let mut w = warn();
        assert!(resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).is_err());
    }

    #[test]
    fn missing_colorspace_is_an_error() {
        let doc = Document::new();
        let mut d = axial_dict();
        d.remove(b"ColorSpace");
        let mut w = warn();
        assert!(resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).is_err());
    }

    #[test]
    fn function_based_defaults_domain_and_matrix() {
        let doc = Document::new();
        let mut d = axial_dict();
        d.set("ShadingType", Object::Integer(1));
        let mut w = warn();
        let sh = resolve_shading(&doc, &Object::Dictionary(d), None, &mut w).unwrap();
        match sh.kind {
            ShadingKind::FunctionBased { domain, matrix } => {
                assert_eq!(domain, [0.0, 1.0, 0.0, 1.0]);
                assert_eq!(matrix, Matrix::IDENTITY);
            }
            _ => panic!("phải là kiểu 1"),
        }
    }
}
