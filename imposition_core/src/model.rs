//! Hợp đồng dữ liệu cho imposition_core (Task 4 / Requirements 4.1, 4.3, 6.1).
//!
//! Đây là *nguồn* để sinh type TS ở Task 7 (ts-rs/schemars).
//! Quy ước đơn vị: mọi trường kích thước trong `ImposeSettings` tính bằng **mm**;
//! mọi trường trong `LayoutOutput`/`Placement` tính bằng **point (pt)**.
//! Serialize theo camelCase để khớp payload client.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ─────────────────────────────────────────────────────────────────────────────
//  Enums cơ bản
// ─────────────────────────────────────────────────────────────────────────────

/// Công cụ bình bài. Thay cho cờ `isDieCutMode` rải rác (Req 6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    /// Cắt xén / N-up (guillotine).
    Nup,
    /// Bế tem (die-cut).
    Sticker,
    /// Booklet/offset.
    Booklet,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum MarginMode {
    LabelsOnly,
    IncludeMarks,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum Duplex {
    Normal,
    Double,
}

/// Cách ráp thành phẩm (N-up).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum LayoutType {
    Sequential,
    Repeat,
    CutStacks,
}

/// Căn lề lưới trên tờ. 9 vị trí.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "kebab-case")]
pub enum Align {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

/// Chiến lược xếp lưới. `Manual` BẮT BUỘC mang cols/rows (Req 4.3) —
/// không còn cách nào gửi "manual" mà thiếu số cột/dòng.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GridStrategy {
    SimpleAuto,
    OptimalAuto,
    Manual { cols: u32, rows: u32 },
    Staggered,
    RowAlt,
    HeadToTail,
}

/// Góc xoay ô khi đặt trang (đo theo PDF, CCW).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum Rotation {
    Deg0,
    Deg90,
    Deg180,
    Deg270,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Cấu hình con
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct Margins {
    /// mm
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum MarkType {
    None,
    Corners,
    Guillotine,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum MarkStyle {
    Default,
    Japanese,
}

/// Cấu hình mark cắt. `None` ở `ImposeSettings.marks` = không vẽ mark (Req 6).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MarkConfig {
    pub mark_type: MarkType,
    /// mm
    pub length: f64,
    /// mm
    pub offset: f64,
    /// mm — TRƯỚC đây bị backend bỏ qua (field câm); nay thuộc hợp đồng (Req 4.3).
    pub thickness: f64,
    pub style: MarkStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum CutType {
    Default,
    OneDao,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum PontShape {
    Circle,
    LInverted,
    LCorner,
}

/// Cấu hình pont định vị (die-cut). `None` ở `ImposeSettings.pont` = không pont (Req 6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct PontConfig {
    pub shape: PontShape,
    pub size: f64,
    pub thickness: f64,
    #[serde(default)]
    pub disable_collision: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum GroupingStrategy {
    MaximizeArea,
    StrictRatio,
    ClusterTile,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "snake_case")]
pub enum ClusterSizingMode {
    Dims,
    SplitCols,
    SplitRows,
}

/// Cấu hình gom cụm / cluster-tile (die-cut nâng cao).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ClusterConfig {
    pub grouping: GroupingStrategy,
    pub sizing_mode: ClusterSizingMode,
    /// mm
    pub tile_w: f64,
    /// mm
    pub tile_h: f64,
    pub cols: u32,
    pub rows: u32,
    /// mm
    pub tile_gap_x: f64,
    /// mm
    pub tile_gap_y: f64,
    pub nesting: bool,
}

/// Cấu hình riêng die-cut (Bế Tem).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct DieCutConfig {
    pub cut_type: CutType,
    /// mm — khoảng cách cụm phụ (1-dao).
    pub fill_block_gap: f64,
    pub separate_cut_page: bool,
    pub ponts_on_cut_file: bool,
    /// Override hình theo trang (index trang → tên hình).
    #[serde(default)]
    pub shapes_by_page: BTreeMap<u32, String>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Input chính
// ─────────────────────────────────────────────────────────────────────────────

/// Toàn bộ thiết lập một lần bình bài. Đơn vị: mm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct ImposeSettings {
    pub tool: ToolKind,

    pub sheet_width: f64,
    pub sheet_height: f64,
    pub margins: Margins,
    pub margin_mode: MarginMode,
    pub gap_x: f64,
    pub gap_y: f64,
    pub bleed: f64,

    pub strategy: GridStrategy,
    pub align: Align,
    pub duplex: Duplex,
    pub layout: LayoutType,

    /// None = không vẽ mark (thay cho khóa cứng theo tool) — Req 6.
    #[serde(default)]
    pub marks: Option<MarkConfig>,
    /// None = không pont — Req 6.
    #[serde(default)]
    pub pont: Option<PontConfig>,
    #[serde(default)]
    pub cluster: Option<ClusterConfig>,
    #[serde(default)]
    pub diecut: Option<DieCutConfig>,

    #[serde(default)]
    pub target_quantity: u32,
    #[serde(default)]
    pub target_quantities_by_page: BTreeMap<u32, u32>,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Output
// ─────────────────────────────────────────────────────────────────────────────

/// Một ô đã đặt vị trí tuyệt đối trên tờ. Đơn vị: pt, gốc toạ độ PDF (Y hướng lên).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub abs_x: f64,
    pub abs_y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: Rotation,
    pub src_page: usize,
}

/// Một đoạn mark cắt để assembler vẽ. Đơn vị: pt.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct MarkSeg {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

/// Một tờ output đã tính sẵn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct Sheet {
    pub placements: Vec<Placement>,
    #[serde(default)]
    pub marks: Vec<MarkSeg>,
}

/// Kết quả layout đầy đủ — assembler chỉ việc tiêu thụ.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts-export", ts(export, export_to = "generated/"))]
#[serde(rename_all = "camelCase")]
pub struct LayoutOutput {
    pub sheets: Vec<Sheet>,
    pub capacity_per_sheet: usize,
    pub strategy_used: String,
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tests — round-trip + hình dạng JSON hợp đồng
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ImposeSettings {
        ImposeSettings {
            tool: ToolKind::Nup,
            sheet_width: 320.0,
            sheet_height: 450.0,
            margins: Margins {
                top: 5.0,
                bottom: 5.0,
                left: 0.0,
                right: 0.0,
            },
            margin_mode: MarginMode::LabelsOnly,
            gap_x: 2.0,
            gap_y: 2.0,
            bleed: 2.0,
            strategy: GridStrategy::Manual { cols: 4, rows: 5 },
            align: Align::Center,
            duplex: Duplex::Normal,
            layout: LayoutType::Sequential,
            marks: Some(MarkConfig {
                mark_type: MarkType::Guillotine,
                length: 5.0,
                offset: 3.0,
                thickness: 0.25,
                style: MarkStyle::Default,
            }),
            pont: None,
            cluster: None,
            diecut: None,
            target_quantity: 0,
            target_quantities_by_page: BTreeMap::new(),
        }
    }

    #[test]
    fn round_trip_settings() {
        let s = sample();
        let json = serde_json::to_string(&s).unwrap();
        let back: ImposeSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(s, back);
    }

    #[test]
    fn manual_strategy_requires_cols_rows() {
        // Hợp đồng: "manual" mà thiếu cols/rows → deserialize THẤT BẠI (hết field câm).
        let bad = r#"{"kind":"manual"}"#;
        assert!(serde_json::from_str::<GridStrategy>(bad).is_err());

        let good = r#"{"kind":"manual","cols":3,"rows":7}"#;
        let g: GridStrategy = serde_json::from_str(good).unwrap();
        assert_eq!(g, GridStrategy::Manual { cols: 3, rows: 7 });
    }

    #[test]
    fn optional_marks_pont_default_none() {
        // marks/pont vắng mặt → None (không vẽ), đúng ngữ nghĩa Req 6.
        let json = r#"{
            "tool":"nup","sheetWidth":320,"sheetHeight":450,
            "margins":{"top":0,"bottom":0,"left":0,"right":0},
            "marginMode":"labels_only","gapX":0,"gapY":0,"bleed":0,
            "strategy":{"kind":"simple_auto"},"align":"center",
            "duplex":"normal","layout":"sequential"
        }"#;
        let s: ImposeSettings = serde_json::from_str(json).unwrap();
        assert!(s.marks.is_none());
        assert!(s.pont.is_none());
        assert_eq!(s.target_quantity, 0);
    }

    #[test]
    fn output_round_trip() {
        let out = LayoutOutput {
            sheets: vec![Sheet {
                placements: vec![Placement {
                    abs_x: 10.0,
                    abs_y: 20.0,
                    width: 100.0,
                    height: 60.0,
                    rotation: Rotation::Deg90,
                    src_page: 0,
                }],
                marks: vec![MarkSeg {
                    x1: 0.0,
                    y1: 0.0,
                    x2: 0.0,
                    y2: 5.0,
                }],
            }],
            capacity_per_sheet: 1,
            strategy_used: "manual".to_string(),
        };
        let json = serde_json::to_string(&out).unwrap();
        let back: LayoutOutput = serde_json::from_str(&json).unwrap();
        assert_eq!(out, back);
    }
}
