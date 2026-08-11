//! Hợp đồng hình học trung gian của PrynX Logo Engine v2.
//!
//! Tracer riêng chưa chạy trên đường production; Lô C đã bổ sung contour có
//! outer/hole và winding tường minh để các lô curve-fit/writer dùng chung.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub(crate) const VECTOR_SCENE_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CoordinateSystem {
    PixelTopLeft,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ScenePoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

impl ScenePoint {
    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SceneSegment {
    Line {
        to: ScenePoint,
    },
    Cubic {
        control_1: ScenePoint,
        control_2: ScenePoint,
        to: ScenePoint,
    },
}

impl SceneSegment {
    fn is_finite(&self) -> bool {
        match self {
            Self::Line { to } => to.is_finite(),
            Self::Cubic {
                control_1,
                control_2,
                to,
            } => control_1.is_finite() && control_2.is_finite() && to.is_finite(),
        }
    }

    pub(crate) fn end_point(&self) -> ScenePoint {
        match self {
            Self::Line { to } | Self::Cubic { to, .. } => *to,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ScenePath {
    pub(crate) start: ScenePoint,
    pub(crate) segments: Vec<SceneSegment>,
    pub(crate) closed: bool,
}

impl ScenePath {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !self.start.is_finite() || self.segments.iter().any(|segment| !segment.is_finite()) {
            return Err("Đường vector chứa tọa độ không hữu hạn".to_string());
        }
        if self.segments.is_empty() {
            return Err("Đường vector không có đoạn hình học".to_string());
        }
        Ok(())
    }

    pub(crate) fn node_count(&self) -> usize {
        let explicitly_returns_to_start = self.closed
            && self
                .segments
                .last()
                .is_some_and(|segment| segment.end_point() == self.start);
        self.segments.len() + usize::from(!explicitly_returns_to_start)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RingRole {
    Outer,
    Hole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Winding {
    Clockwise,
    CounterClockwise,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct FillRing {
    pub(crate) role: RingRole,
    pub(crate) winding: Winding,
    pub(crate) path: ScenePath,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SceneGeometry {
    FillRegion { rings: Vec<FillRing> },
    StrokePath { path: ScenePath, width_px: f64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct SolidPaint {
    pub(crate) rgba: [u8; 4],
}

pub(crate) const TRANSPARENT_PIXEL_LABEL: u16 = u16::MAX;
pub(crate) const PREPROCESS_ARTIFACT_VERSION: u16 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RasterColorComponent {
    pub(crate) label_index: u16,
    pub(crate) pixel_count: u64,
    pub(crate) min_x: u32,
    pub(crate) min_y: u32,
    pub(crate) max_x: u32,
    pub(crate) max_y: u32,
}

/// Raster đã chuẩn hóa, sẵn sàng cho contour tracer ở Lô C.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PreprocessArtifact {
    pub(crate) version: u16,
    pub(crate) width_px: u32,
    pub(crate) height_px: u32,
    pub(crate) palette: Vec<SolidPaint>,
    /// Coverage alpha gốc; 0 là trong suốt, giá trị 1–255 vẫn được giữ để không
    /// làm mất dải chuyển tiếp mà contour/raster-QC hạ nguồn có thể cần.
    pub(crate) alpha_mask: Vec<u8>,
    /// Mỗi pixel nhìn thấy có đúng một nhãn palette; pixel alpha=0 dùng sentinel.
    pub(crate) labels: Vec<u16>,
    pub(crate) label_pixel_counts: Vec<u64>,
    /// Component 4-liên kết, không lọc theo diện tích để giữ màu nhấn nhỏ.
    pub(crate) components: Vec<RasterColorComponent>,
    pub(crate) artifact_hash: String,
}

impl PreprocessArtifact {
    pub(crate) fn validate_contract(&self) -> Result<(), String> {
        if self.version != PREPROCESS_ARTIFACT_VERSION {
            return Err("Phiên bản PreprocessArtifact không được hỗ trợ".to_string());
        }
        if self.width_px == 0 || self.height_px == 0 {
            return Err("PreprocessArtifact phải có kích thước lớn hơn 0".to_string());
        }
        if self.palette.is_empty() {
            return Err("PreprocessArtifact phải có ít nhất một màu".to_string());
        }
        if self.label_pixel_counts.len() != self.palette.len() {
            return Err("Bảng đếm pixel không khớp palette".to_string());
        }
        let expected_pixels = usize::try_from(self.width_px)
            .ok()
            .and_then(|width| {
                usize::try_from(self.height_px)
                    .ok()
                    .and_then(|height| width.checked_mul(height))
            })
            .ok_or_else(|| "Kích thước PreprocessArtifact vượt giới hạn biểu diễn".to_string())?;
        if self.alpha_mask.len() != expected_pixels || self.labels.len() != expected_pixels {
            return Err("Alpha mask hoặc bản đồ nhãn sai kích thước".to_string());
        }

        let mut actual_counts = vec![0_u64; self.palette.len()];
        for (&alpha, &label) in self.alpha_mask.iter().zip(&self.labels) {
            if alpha == 0 {
                if label != TRANSPARENT_PIXEL_LABEL {
                    return Err("Pixel trong suốt không được mang nhãn màu".to_string());
                }
                continue;
            }
            let label_index = usize::from(label);
            if label == TRANSPARENT_PIXEL_LABEL || label_index >= self.palette.len() {
                return Err("Pixel hiển thị phải có đúng một nhãn palette".to_string());
            }
            actual_counts[label_index] += 1;
        }
        if actual_counts != self.label_pixel_counts {
            return Err("Bảng đếm pixel không khớp bản đồ nhãn".to_string());
        }
        if actual_counts.iter().sum::<u64>() == 0 {
            return Err("PreprocessArtifact không có pixel hiển thị".to_string());
        }

        let mut component_counts = vec![0_u64; self.palette.len()];
        for component in &self.components {
            let label_index = usize::from(component.label_index);
            if label_index >= self.palette.len() || component.pixel_count == 0 {
                return Err("Component màu có nhãn hoặc diện tích không hợp lệ".to_string());
            }
            if component.min_x > component.max_x
                || component.min_y > component.max_y
                || component.max_x >= self.width_px
                || component.max_y >= self.height_px
            {
                return Err("Khung component màu nằm ngoài ảnh".to_string());
            }
            component_counts[label_index] += component.pixel_count;
        }
        if component_counts != actual_counts {
            return Err("Component màu không phủ đúng bản đồ nhãn".to_string());
        }
        if self.artifact_hash.len() != 64
            || !self
                .artifact_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Hash PreprocessArtifact không hợp lệ".to_string());
        }
        Ok(())
    }

    pub(crate) fn visible_pixel_count(&self) -> u64 {
        self.label_pixel_counts.iter().sum()
    }

    pub(crate) fn components_for_label(
        &self,
        label_index: u16,
    ) -> impl Iterator<Item = &RasterColorComponent> {
        self.components
            .iter()
            .filter(move |component| component.label_index == label_index)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct VectorLayer {
    pub(crate) paint: SolidPaint,
    pub(crate) geometry: Vec<SceneGeometry>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct EngineProvenance {
    pub(crate) engine: String,
    pub(crate) engine_version: String,
    pub(crate) profile: String,
    pub(crate) settings_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct VectorScene {
    pub(crate) version: u16,
    pub(crate) width_px: u32,
    pub(crate) height_px: u32,
    pub(crate) coordinate_system: CoordinateSystem,
    pub(crate) layers: Vec<VectorLayer>,
    pub(crate) provenance: EngineProvenance,
}

impl VectorScene {
    pub(crate) fn empty(width_px: u32, height_px: u32, provenance: EngineProvenance) -> Self {
        Self {
            version: VECTOR_SCENE_VERSION,
            width_px,
            height_px,
            coordinate_system: CoordinateSystem::PixelTopLeft,
            layers: Vec::new(),
            provenance,
        }
    }

    pub(crate) fn validate_contract(&self) -> Result<(), String> {
        if self.version != VECTOR_SCENE_VERSION {
            return Err("Phiên bản VectorScene không được hỗ trợ".to_string());
        }
        if self.width_px == 0 || self.height_px == 0 {
            return Err("VectorScene phải có kích thước pixel lớn hơn 0".to_string());
        }
        for layer in &self.layers {
            for geometry in &layer.geometry {
                match geometry {
                    SceneGeometry::FillRegion { rings } => {
                        if rings.is_empty() {
                            return Err("Vùng tô không có vòng biên".to_string());
                        }
                        if !rings.iter().any(|ring| ring.role == RingRole::Outer) {
                            return Err("Vùng tô phải có ít nhất một vòng outer".to_string());
                        }
                        for ring in rings {
                            ring.path.validate()?;
                            if !ring.path.closed {
                                return Err("Vòng tô phải là đường kín".to_string());
                            }
                            if ring.path.segments.len() < 2 {
                                return Err("Vòng tô cần ít nhất ba đỉnh".to_string());
                            }
                            if !matches!(
                                (ring.role, ring.winding),
                                (RingRole::Outer, Winding::Clockwise)
                                    | (RingRole::Hole, Winding::CounterClockwise)
                            ) {
                                return Err(
                                    "Vai trò outer/hole không khớp chiều winding".to_string()
                                );
                            }
                        }
                    }
                    SceneGeometry::StrokePath { path, width_px } => {
                        path.validate()?;
                        if !width_px.is_finite() || *width_px <= 0.0 {
                            return Err("Độ rộng nét phải là số hữu hạn lớn hơn 0".to_string());
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provenance() -> EngineProvenance {
        EngineProvenance {
            engine: "test".to_string(),
            engine_version: "1".to_string(),
            profile: "silhouette".to_string(),
            settings_hash: "abc".to_string(),
        }
    }

    #[test]
    fn empty_scene_keeps_version_and_coordinate_contract() {
        let scene = VectorScene::empty(600, 300, provenance());

        assert_eq!(scene.version, VECTOR_SCENE_VERSION);
        assert_eq!(scene.coordinate_system, CoordinateSystem::PixelTopLeft);
        assert!(scene.validate_contract().is_ok());
    }

    #[test]
    fn fill_region_rejects_open_ring() {
        let mut scene = VectorScene::empty(10, 10, provenance());
        scene.layers.push(VectorLayer {
            paint: SolidPaint {
                rgba: [0, 0, 0, 255],
            },
            geometry: vec![SceneGeometry::FillRegion {
                rings: vec![FillRing {
                    role: RingRole::Outer,
                    winding: Winding::Clockwise,
                    path: ScenePath {
                        start: ScenePoint { x: 0.0, y: 0.0 },
                        segments: vec![SceneSegment::Line {
                            to: ScenePoint { x: 1.0, y: 0.0 },
                        }],
                        closed: false,
                    },
                }],
            }],
        });

        assert!(scene.validate_contract().unwrap_err().contains("đường kín"));
    }

    #[test]
    fn stroke_rejects_non_finite_width() {
        let mut scene = VectorScene::empty(10, 10, provenance());
        scene.layers.push(VectorLayer {
            paint: SolidPaint {
                rgba: [0, 0, 0, 255],
            },
            geometry: vec![SceneGeometry::StrokePath {
                path: ScenePath {
                    start: ScenePoint { x: 0.0, y: 0.0 },
                    segments: vec![SceneSegment::Line {
                        to: ScenePoint { x: 1.0, y: 1.0 },
                    }],
                    closed: false,
                },
                width_px: f64::NAN,
            }],
        });

        assert!(scene
            .validate_contract()
            .unwrap_err()
            .contains("Độ rộng nét"));
    }
}
