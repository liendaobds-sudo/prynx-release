//! Nạp font PDF và lấy đường viền glyph.
//!
//! # Ba đường định danh glyph khác nhau
//!
//! PDF không có một cách duy nhất để trả lời "mã 65 là glyph nào":
//!
//! | Loại font | Đường tra |
//! |---|---|
//! | Type1 / CFF đơn byte | mã → **tên glyph** → glyph theo tên |
//! | TrueType đơn byte | mã → **Unicode** → bảng `cmap` |
//! | Type0 (CID) | byte → **CID** qua CMap → GID qua `CIDToGIDMap` |
//! | Type3 | mã → **tên** → content stream trong `/CharProcs` |
//!
//! Dùng sai đường cho ra glyph sai — và với chữ Latin thì kết quả *vẫn trông như
//! chữ*, nên lỗi này rất dễ trôi qua mắt người kiểm.
//!
//! # Font không nhúng
//!
//! Engine **không** tự thay bằng font hệ thống. Với prepress, font không nhúng là
//! một lỗi preflight, và thay font làm đổi bề rộng chữ, đổi diện tích phủ mực,
//! nên báo cáo mực sẽ sai theo cách không ai kiểm được. Ta ghi nhận và bỏ vẽ.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use lopdf::{Dictionary, Document, Object};
use tiny_skia::{Path, PathBuilder};

use crate::geom::Matrix;
use crate::pdf;
use crate::text::encoding::{
    glyph_index_from_name, unicode_from_glyph_name, BaseEncoding, SimpleEncoding,
};

/// Chương trình font đã nhúng.
///
/// Giữ **dữ liệu thô** thay vì đối tượng đã parse: cả `ttf_parser::Face` lẫn bảng
/// CFF của `hayro-font` đều vay mượn (`borrow`) từ dữ liệu, nên lưu chúng trong
/// struct sẽ thành cấu trúc tự tham chiếu. Parse lại ở mỗi lần lấy glyph là rẻ
/// (chỉ là tra bảng, không cấp phát) và kết quả được cache lại theo mã ký tự.
#[derive(Clone)]
pub enum FontProgram {
    /// `FontFile2` — TrueType/OpenType.
    TrueType(Arc<Vec<u8>>),
    /// `FontFile3` với `/Subtype /Type1C` hoặc `/CIDFontType0C` — CFF thô.
    Cff(Arc<Vec<u8>>),
    /// `FontFile` — Type1 (PFA/PFB).
    Type1(Arc<Vec<u8>>),
    /// Không nhúng font.
    Missing,
}

impl FontProgram {
    pub fn is_missing(&self) -> bool {
        matches!(self, FontProgram::Missing)
    }

    fn kind(&self) -> &'static str {
        match self {
            FontProgram::TrueType(_) => "TrueType",
            FontProgram::Cff(_) => "CFF",
            FontProgram::Type1(_) => "Type1",
            FontProgram::Missing => "không nhúng",
        }
    }
}

/// Bề rộng ký tự (đơn vị 1/1000 không gian text).
#[derive(Debug, Clone)]
pub enum Widths {
    Simple {
        first_char: u32,
        widths: Vec<f32>,
        missing: f32,
    },
    /// `/DW` + `/W` của CIDFont.
    Cid {
        default: f32,
        ranges: Vec<(u32, u32, f32)>,
    },
    /// Không khai bề rộng: phải lấy từ chương trình font.
    FromProgram,
}

impl Widths {
    /// Bề rộng theo mã (font đơn byte) hoặc theo CID (Type0), đơn vị 1/1000.
    pub fn get(&self, code_or_cid: u32) -> Option<f32> {
        match self {
            Widths::Simple {
                first_char,
                widths,
                missing,
            } => {
                let idx = code_or_cid.checked_sub(*first_char)? as usize;
                match widths.get(idx) {
                    Some(w) => Some(*w),
                    None => Some(*missing),
                }
            }
            Widths::Cid { default, ranges } => {
                for (lo, hi, w) in ranges {
                    if code_or_cid >= *lo && code_or_cid <= *hi {
                        return Some(*w);
                    }
                }
                Some(*default)
            }
            Widths::FromProgram => None,
        }
    }
}

/// Ánh xạ CID → GID cho `CIDFontType2`.
#[derive(Debug, Clone)]
pub enum CidToGid {
    Identity,
    /// Bảng 2 byte big-endian.
    Map(Arc<Vec<u8>>),
}

impl CidToGid {
    pub fn gid(&self, cid: u32) -> u16 {
        match self {
            CidToGid::Identity => cid as u16,
            CidToGid::Map(data) => {
                let i = (cid as usize) * 2;
                match (data.get(i), data.get(i + 1)) {
                    (Some(hi), Some(lo)) => ((*hi as u16) << 8) | *lo as u16,
                    // Ngoài bảng ⇒ glyph 0 (notdef). Đúng spec, và quan trọng là
                    // KHÔNG được rơi về identity: identity sẽ vẽ một glyph tuỳ ý.
                    _ => 0,
                }
            }
        }
    }
}

/// CMap của font Type0: chuỗi byte → CID.
#[derive(Debug, Clone)]
pub struct CMap {
    /// `true` nếu là Identity-H/V (2 byte, CID = mã).
    pub identity: bool,
    /// Khoảng mã: (số byte, mã thấp, mã cao, CID bắt đầu).
    ranges: Vec<(usize, u32, u32, u32)>,
    /// Số byte của các khoảng codespace, để tách mã khi độ dài không đồng nhất.
    codespace: Vec<(usize, u32, u32)>,
}

impl CMap {
    pub fn identity_two_byte() -> Self {
        CMap {
            identity: true,
            ranges: Vec::new(),
            codespace: vec![(2, 0, 0xFFFF)],
        }
    }

    /// Đọc mã kế tiếp: trả (CID, số byte đã dùng).
    pub fn next_code(&self, bytes: &[u8]) -> (u32, usize) {
        if self.identity || self.codespace.is_empty() {
            // Identity-H: luôn 2 byte big-endian.
            let hi = bytes.first().copied().unwrap_or(0) as u32;
            let lo = bytes.get(1).copied().unwrap_or(0) as u32;
            return ((hi << 8) | lo, 2.min(bytes.len().max(1)));
        }
        // Thử độ dài 1..4 byte theo codespace. Bắt buộc phải theo codespace, vì
        // CMap trộn mã 1 byte và 2 byte là chuyện thường ở font CJK; đoán độ dài
        // sẽ làm lệch toàn bộ phần chữ còn lại của chuỗi.
        for n in 1..=4usize {
            if bytes.len() < n {
                break;
            }
            let mut code = 0u32;
            for b in &bytes[..n] {
                code = (code << 8) | *b as u32;
            }
            if self
                .codespace
                .iter()
                .any(|(len, lo, hi)| *len == n && code >= *lo && code <= *hi)
            {
                return (self.lookup(n, code), n);
            }
        }
        let n = 1.min(bytes.len().max(1));
        let code = bytes.first().copied().unwrap_or(0) as u32;
        (self.lookup(n, code), n)
    }

    fn lookup(&self, nbytes: usize, code: u32) -> u32 {
        for (len, lo, hi, cid) in &self.ranges {
            if *len == nbytes && code >= *lo && code <= *hi {
                return cid + (code - lo);
            }
        }
        code
    }
}

/// Font Type3: glyph là content stream.
#[derive(Clone)]
pub struct Type3Data {
    pub char_procs: Dictionary,
    pub resources: Option<Dictionary>,
    pub font_matrix: Matrix,
}

/// Font đã nạp, sẵn sàng lấy glyph.
pub struct LoadedFont {
    pub program: FontProgram,
    pub encoding: Option<SimpleEncoding>,
    pub cmap: Option<CMap>,
    pub cid_to_gid: CidToGid,
    pub widths: Widths,
    pub type3: Option<Type3Data>,
    pub is_type0: bool,
    /// Tên font để báo lỗi có ích.
    pub base_font: String,
    /// `true` khi `program` là font THAY THẾ (font không nhúng trong file) —
    /// glyph vẽ ra chỉ gần đúng hình dạng gốc nên caller phải hạ `accuracy`.
    substituted: bool,
    /// Cache đường viền theo mã ký tự (hoặc CID với Type0).
    cache: RefCell<HashMap<u32, Option<Arc<Path>>>>,
}

impl LoadedFont {
    /// `true` nếu font này không vẽ được glyph nào.
    pub fn cannot_draw(&self) -> bool {
        self.type3.is_none() && self.program.is_missing()
    }

    /// Gắn chương trình font thay thế cho font không nhúng.
    ///
    /// Cache glyph bị xoá vì mọi kết quả đã cache đều thuộc font cũ.
    pub fn substitute_program(&mut self, program: FontProgram) {
        self.program = program;
        self.substituted = true;
        self.cache.borrow_mut().clear();
    }

    /// `true` nếu chương trình font là bản thay thế, không phải font trong file.
    pub fn is_substituted(&self) -> bool {
        self.substituted
    }

    pub fn describe(&self) -> String {
        format!("{} ({})", self.base_font, self.program.kind())
    }

    /// Bề rộng ký tự trong không gian text (đã chia 1000).
    pub fn advance(&self, code_or_cid: u32) -> f32 {
        if let Some(w) = self.widths.get(code_or_cid) {
            return w / 1000.0;
        }
        self.advance_from_program(code_or_cid).unwrap_or(0.5)
    }

    fn advance_from_program(&self, code_or_cid: u32) -> Option<f32> {
        match &self.program {
            FontProgram::TrueType(data) => {
                let face = ttf_parser::Face::parse(data, 0).ok()?;
                let gid = self.truetype_gid(&face, code_or_cid)?;
                let adv = face.glyph_hor_advance(ttf_parser::GlyphId(gid))? as f32;
                Some(adv / face.units_per_em() as f32)
            }
            FontProgram::Cff(data) => {
                let table = hayro_font::cff::Table::parse(data)?;
                let gid = self.cff_gid(&table, code_or_cid)?;
                let w = table.glyph_width(gid)? as f32;
                Some(w / 1000.0)
            }
            _ => None,
        }
    }

    /// Đường viền glyph trong **không gian text** (1 đơn vị = cỡ chữ 1).
    ///
    /// `None` = không có glyph để vẽ (font thiếu, glyph rỗng như dấu cách).
    pub fn glyph_outline(&self, code_or_cid: u32) -> Option<Arc<Path>> {
        if let Some(cached) = self.cache.borrow().get(&code_or_cid) {
            return cached.clone();
        }
        let built = self.build_outline(code_or_cid);
        self.cache.borrow_mut().insert(code_or_cid, built.clone());
        built
    }

    fn build_outline(&self, code_or_cid: u32) -> Option<Arc<Path>> {
        match &self.program {
            FontProgram::TrueType(data) => {
                let face = ttf_parser::Face::parse(data, 0).ok()?;
                let gid = self.truetype_gid(&face, code_or_cid)?;
                let mut sink = PathSink::default();
                face.outline_glyph(ttf_parser::GlyphId(gid), &mut sink)?;
                // TrueType dùng đơn vị unitsPerEm; quy về không gian text.
                let scale = 1.0 / face.units_per_em() as f32;
                sink.finish(Matrix::scale(scale, scale))
            }
            FontProgram::Cff(data) => {
                let table = hayro_font::cff::Table::parse(data)?;
                let gid = self.cff_gid(&table, code_or_cid)?;
                let mut sink = PathSink::default();
                table.outline(gid, &mut sink).ok()?;
                sink.finish(font_matrix_of(table.matrix()))
            }
            FontProgram::Type1(data) => {
                let table = hayro_font::type1::Table::parse(data)?;
                let name = self.type1_glyph_name(&table, code_or_cid)?;
                let mut sink = PathSink::default();
                table.outline(&name, &mut sink)?;
                sink.finish(font_matrix_of(table.matrix()))
            }
            FontProgram::Missing => None,
        }
    }

    fn truetype_gid(&self, face: &ttf_parser::Face, code_or_cid: u32) -> Option<u16> {
        if self.is_type0 {
            return Some(self.cid_to_gid.gid(code_or_cid));
        }
        let code = code_or_cid as u8;
        let enc = self.encoding.as_ref();

        // 1) Tên glyph dạng `gNN` trong /Differences trỏ thẳng chỉ số glyph.
        if let Some(name) = enc.and_then(|e| e.glyph_name(code)) {
            if let Some(gid) = glyph_index_from_name(name) {
                return Some(gid);
            }
            // 2) Tên → Unicode → cmap.
            if let Some(uni) = unicode_from_glyph_name(name) {
                if let Some(gid) = char::from_u32(uni).and_then(|c| face.glyph_index(c)) {
                    return Some(gid.0);
                }
            }
        }
        if let Some(uni) = enc.and_then(|e| e.unicode(code)) {
            if let Some(gid) = char::from_u32(uni).and_then(|c| face.glyph_index(c)) {
                return Some(gid.0);
            }
        }
        // [FONT FIX 2026-08-24] Tra cmap non-Unicode của TrueType symbolic subset.
        if enc.is_some_and(|e| e.base == BaseEncoding::Builtin) {
            // Ưu tiên Windows Symbol (F000+byte), sau đó mới MacRoman (byte
            // trực tiếp); đây cũng là thứ tự mà đường outline Python dùng.
            for code_point in [0xF000 + code as u32, code as u32] {
                if let Some(cmap) = face.tables().cmap {
                    for subtable in cmap.subtables {
                        if subtable.is_unicode() {
                            continue;
                        }
                        if let Some(gid) = subtable.glyph_index(code_point) {
                            return Some(gid.0);
                        }
                    }
                }
            }
        }
        // 3) Font symbol: bảng (3,0) đánh mã ở vùng 0xF000.
        if let Some(gid) = face
            .glyph_index(char::from_u32(0xF000 + code as u32)?)
            .or_else(|| face.glyph_index(code as char))
        {
            return Some(gid.0);
        }
        // 4) Cuối cùng coi mã là chỉ số glyph. Chỉ đúng với font subset không có
        //    cmap, nhưng vẫn hơn là không vẽ gì.
        Some(code as u16)
    }

    fn cff_gid(
        &self,
        table: &hayro_font::cff::Table,
        code_or_cid: u32,
    ) -> Option<hayro_font::GlyphId> {
        if self.is_type0 {
            return if table.is_cid() {
                table.glyph_index_by_cid(code_or_cid as u16)
            } else {
                Some(hayro_font::GlyphId(self.cid_to_gid.gid(code_or_cid)))
            };
        }
        let code = code_or_cid as u8;
        if let Some(name) = self.encoding.as_ref().and_then(|e| e.glyph_name(code)) {
            if let Some(gid) = table.glyph_index_by_name(name) {
                return Some(gid);
            }
            if let Some(idx) = glyph_index_from_name(name) {
                return Some(hayro_font::GlyphId(idx));
            }
        }
        // Bảng mã dựng sẵn trong CFF.
        table.glyph_index(code)
    }

    fn type1_glyph_name(
        &self,
        table: &hayro_font::type1::Table,
        code_or_cid: u32,
    ) -> Option<String> {
        let code = code_or_cid as u8;
        // `/Differences` và bảng mã cơ sở thắng bảng dựng sẵn của font: đó là ý
        // định của người tạo file.
        if let Some(name) = self.encoding.as_ref().and_then(|e| e.glyph_name(code)) {
            return Some(name.to_string());
        }
        table.code_to_string(code).map(|s| s.to_string())
    }
}

fn font_matrix_of(m: hayro_font::Matrix) -> Matrix {
    Matrix::new(m.sx, m.ky, m.kx, m.sy, m.tx, m.ty)
}

/// Nhận đường viền từ bộ đọc font và dựng `Path`.
///
/// Cài cả hai trait `OutlineBuilder` (của `ttf-parser` và của `hayro-font`) trên
/// cùng một struct để hai đường font dùng chung một bộ dựng path — nhờ vậy không
/// thể lệch nhau ở chi tiết như hướng đóng contour.
#[derive(Default)]
struct PathSink {
    builder: PathBuilder,
    has_segments: bool,
    open: bool,
}

impl PathSink {
    fn finish(mut self, transform: Matrix) -> Option<Arc<Path>> {
        if !self.has_segments {
            return None;
        }
        if self.open {
            self.builder.close();
        }
        let path = self.builder.finish()?;
        let ts = tiny_skia::Transform::from_row(
            transform.a,
            transform.b,
            transform.c,
            transform.d,
            transform.e,
            transform.f,
        );
        path.transform(ts).map(Arc::new)
    }
}

macro_rules! impl_outline_builder {
    ($t:path) => {
        impl $t for PathSink {
            fn move_to(&mut self, x: f32, y: f32) {
                if self.open {
                    self.builder.close();
                }
                self.builder.move_to(x, y);
                self.open = true;
            }
            fn line_to(&mut self, x: f32, y: f32) {
                if self.open {
                    self.builder.line_to(x, y);
                    self.has_segments = true;
                }
            }
            fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
                if self.open {
                    self.builder.quad_to(x1, y1, x, y);
                    self.has_segments = true;
                }
            }
            fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
                if self.open {
                    self.builder.cubic_to(x1, y1, x2, y2, x, y);
                    self.has_segments = true;
                }
            }
            fn close(&mut self) {
                if self.open {
                    self.builder.close();
                    self.open = false;
                }
            }
        }
    };
}

impl_outline_builder!(ttf_parser::OutlineBuilder);
impl_outline_builder!(hayro_font::OutlineBuilder);

// ─────────────────────────────────────────────────────────────────────────────
//  Nạp từ dictionary PDF
// ─────────────────────────────────────────────────────────────────────────────

/// Nạp font từ `/Font` trong resources.
pub fn load_font(doc: &Document, font_dict: &Dictionary) -> LoadedFont {
    let subtype = pdf::dict_get(doc, font_dict, "Subtype")
        .and_then(pdf::name_str)
        .unwrap_or_default();
    let base_font = pdf::dict_get(doc, font_dict, "BaseFont")
        .and_then(pdf::name_str)
        .unwrap_or_else(|| "(không tên)".into());

    if subtype == "Type0" {
        return load_type0(doc, font_dict, base_font);
    }
    if subtype == "Type3" {
        return load_type3(doc, font_dict, base_font);
    }
    load_simple(doc, font_dict, base_font, &subtype)
}

fn load_simple(
    doc: &Document,
    font_dict: &Dictionary,
    base_font: String,
    subtype: &str,
) -> LoadedFont {
    let descriptor = pdf::dict_get_dict(doc, font_dict, "FontDescriptor");
    let program = load_program(doc, descriptor);

    // Bảng mã cơ sở: TrueType symbol thì mặc định dùng bảng dựng sẵn của font,
    // còn lại mặc định StandardEncoding (§9.6.6.2).
    let symbolic = descriptor
        .and_then(|d| pdf::dict_get(doc, d, "Flags"))
        .and_then(pdf::as_num)
        .map(|f| (f as u32) & 4 != 0)
        .unwrap_or(false);
    let default_base = if symbolic {
        BaseEncoding::Builtin
    } else {
        BaseEncoding::Standard
    };

    let mut encoding = SimpleEncoding::new(default_base);
    if let Some(enc_obj) = pdf::dict_get(doc, font_dict, "Encoding") {
        match enc_obj {
            Object::Name(_) => {
                if let Some(base) = pdf::name_str(enc_obj).and_then(|n| BaseEncoding::from_name(&n))
                {
                    encoding = SimpleEncoding::new(base);
                }
            }
            Object::Dictionary(enc_dict) => {
                if let Some(base) = pdf::dict_get(doc, enc_dict, "BaseEncoding")
                    .and_then(pdf::name_str)
                    .and_then(|n| BaseEncoding::from_name(&n))
                {
                    encoding = SimpleEncoding::new(base);
                }
                apply_differences(doc, enc_dict, &mut encoding);
            }
            _ => {}
        }
    }

    let widths = load_simple_widths(doc, font_dict, descriptor);
    let _ = subtype;

    LoadedFont {
        program,
        encoding: Some(encoding),
        cmap: None,
        cid_to_gid: CidToGid::Identity,
        widths,
        type3: None,
        is_type0: false,
        base_font,
        substituted: false,
        cache: RefCell::new(HashMap::new()),
    }
}

fn apply_differences(doc: &Document, enc_dict: &Dictionary, encoding: &mut SimpleEncoding) {
    let Some(Object::Array(items)) = pdf::dict_get(doc, enc_dict, "Differences") else {
        return;
    };
    let mut code: i64 = 0;
    for item in items {
        match pdf::deref(doc, item) {
            Object::Integer(n) => code = *n,
            Object::Real(r) => code = *r as i64,
            Object::Name(_) => {
                if let Some(name) = pdf::name_str(pdf::deref(doc, item)) {
                    if (0..=255).contains(&code) {
                        encoding.set_difference(code as u8, &name);
                    }
                    code += 1;
                }
            }
            _ => {}
        }
    }
}

fn load_simple_widths(
    doc: &Document,
    font_dict: &Dictionary,
    descriptor: Option<&Dictionary>,
) -> Widths {
    let widths = pdf::dict_get(doc, font_dict, "Widths").and_then(|o| pdf::num_array(doc, o));
    let first_char = pdf::dict_get(doc, font_dict, "FirstChar")
        .and_then(pdf::as_num)
        .unwrap_or(0.0) as u32;
    let missing = descriptor
        .and_then(|d| pdf::dict_get(doc, d, "MissingWidth"))
        .and_then(pdf::as_num)
        .unwrap_or(0.0);
    match widths {
        Some(w) if !w.is_empty() => Widths::Simple {
            first_char,
            widths: w,
            missing,
        },
        // Không có /Widths: font chuẩn 14 hoặc file lệch spec. Lấy từ chương trình
        // font thay vì đoán, vì bề rộng sai làm lệch vị trí toàn bộ dòng chữ.
        _ => Widths::FromProgram,
    }
}

fn load_type0(doc: &Document, font_dict: &Dictionary, base_font: String) -> LoadedFont {
    // CMap của font Type0.
    let cmap = match pdf::dict_get(doc, font_dict, "Encoding") {
        Some(Object::Name(_)) => {
            let name = pdf::dict_get(doc, font_dict, "Encoding")
                .and_then(pdf::name_str)
                .unwrap_or_default();
            if name.starts_with("Identity") {
                CMap::identity_two_byte()
            } else {
                // CMap dựng sẵn của CJK (UniJIS-UCS2-H…) chưa có bảng. Dùng
                // identity 2 byte làm xấp xỉ; sai CID nhưng giữ đúng nhịp 2 byte
                // nên phần còn lại của chuỗi không bị lệch.
                CMap::identity_two_byte()
            }
        }
        Some(obj @ Object::Stream(_)) => parse_cmap_stream(doc, obj),
        _ => CMap::identity_two_byte(),
    };

    // Font con (DescendantFonts) mang chương trình font và bề rộng.
    let descendant = pdf::dict_get(doc, font_dict, "DescendantFonts")
        .and_then(|o| match o {
            Object::Array(items) => items.first().cloned(),
            _ => None,
        })
        .and_then(|o| match pdf::deref(doc, &o) {
            Object::Dictionary(d) => Some(d.clone()),
            _ => None,
        });

    let (program, widths, cid_to_gid) = match &descendant {
        Some(d) => {
            let desc = pdf::dict_get_dict(doc, d, "FontDescriptor");
            let program = load_program(doc, desc);
            let default = pdf::dict_get(doc, d, "DW")
                .and_then(pdf::as_num)
                .unwrap_or(1000.0);
            let ranges = parse_cid_widths(doc, d);
            let c2g = match pdf::dict_get(doc, d, "CIDToGIDMap") {
                Some(Object::Stream(_)) => {
                    match pdf::stream_data(doc, pdf::dict_get(doc, d, "CIDToGIDMap").unwrap()) {
                        Some(bytes) => CidToGid::Map(Arc::new(bytes)),
                        None => CidToGid::Identity,
                    }
                }
                _ => CidToGid::Identity,
            };
            (program, Widths::Cid { default, ranges }, c2g)
        }
        None => (
            FontProgram::Missing,
            Widths::FromProgram,
            CidToGid::Identity,
        ),
    };

    LoadedFont {
        program,
        encoding: None,
        cmap: Some(cmap),
        cid_to_gid,
        widths,
        type3: None,
        is_type0: true,
        base_font,
        substituted: false,
        cache: RefCell::new(HashMap::new()),
    }
}

/// `/W` của CIDFont: `[ c [w1 w2 …] cFirst cLast w ]`.
fn parse_cid_widths(doc: &Document, cid_font: &Dictionary) -> Vec<(u32, u32, f32)> {
    let Some(Object::Array(items)) = pdf::dict_get(doc, cid_font, "W") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < items.len() {
        let first = match pdf::num(doc, &items[i]) {
            Some(v) => v as u32,
            None => break,
        };
        i += 1;
        if i >= items.len() {
            break;
        }
        match pdf::deref(doc, &items[i]) {
            Object::Array(list) => {
                for (k, w) in list.iter().enumerate() {
                    if let Some(w) = pdf::num(doc, w) {
                        let c = first + k as u32;
                        out.push((c, c, w));
                    }
                }
                i += 1;
            }
            _ => {
                let last = match pdf::num(doc, &items[i]) {
                    Some(v) => v as u32,
                    None => break,
                };
                i += 1;
                if i >= items.len() {
                    break;
                }
                if let Some(w) = pdf::num(doc, &items[i]) {
                    out.push((first, last, w));
                }
                i += 1;
            }
        }
    }
    out
}

/// Đọc CMap nhúng: lấy `codespacerange`, `cidrange`, `cidchar`.
fn parse_cmap_stream(doc: &Document, obj: &Object) -> CMap {
    let Some(data) = pdf::stream_data(doc, obj) else {
        return CMap::identity_two_byte();
    };
    let text = String::from_utf8_lossy(&data);
    let mut ranges = Vec::new();
    let mut codespace = Vec::new();

    let mut tokens = text.split_whitespace().peekable();
    let mut section: Option<&str> = None;
    let mut buf: Vec<String> = Vec::new();

    while let Some(tok) = tokens.next() {
        match tok {
            "begincodespacerange" => {
                section = Some("codespace");
                buf.clear();
            }
            "begincidrange" => {
                section = Some("cidrange");
                buf.clear();
            }
            "begincidchar" => {
                section = Some("cidchar");
                buf.clear();
            }
            "endcodespacerange" | "endcidrange" | "endcidchar" => {
                match section {
                    Some("codespace") => {
                        for pair in buf.chunks(2) {
                            if let [lo, hi] = pair {
                                if let (Some((n, l)), Some((_, h))) = (hex_token(lo), hex_token(hi))
                                {
                                    codespace.push((n, l, h));
                                }
                            }
                        }
                    }
                    Some("cidrange") => {
                        for triple in buf.chunks(3) {
                            if let [lo, hi, cid] = triple {
                                if let (Some((n, l)), Some((_, h))) = (hex_token(lo), hex_token(hi))
                                {
                                    if let Ok(c) = cid.parse::<u32>() {
                                        ranges.push((n, l, h, c));
                                    }
                                }
                            }
                        }
                    }
                    Some("cidchar") => {
                        for pair in buf.chunks(2) {
                            if let [code, cid] = pair {
                                if let (Some((n, c)), Ok(id)) =
                                    (hex_token(code), cid.parse::<u32>())
                                {
                                    ranges.push((n, c, c, id));
                                }
                            }
                        }
                    }
                    _ => {}
                }
                section = None;
                buf.clear();
            }
            other if section.is_some() => buf.push(other.to_string()),
            _ => {}
        }
    }

    if codespace.is_empty() && ranges.is_empty() {
        return CMap::identity_two_byte();
    }
    if codespace.is_empty() {
        codespace.push((2, 0, 0xFFFF));
    }
    CMap {
        identity: false,
        ranges,
        codespace,
    }
}

/// `<0041>` → (số byte, giá trị).
fn hex_token(tok: &str) -> Option<(usize, u32)> {
    let inner = tok.trim().strip_prefix('<')?.strip_suffix('>')?;
    if inner.is_empty() || inner.len() % 2 != 0 || inner.len() > 8 {
        return None;
    }
    let v = u32::from_str_radix(inner, 16).ok()?;
    Some((inner.len() / 2, v))
}

fn load_type3(doc: &Document, font_dict: &Dictionary, base_font: String) -> LoadedFont {
    let font_matrix = pdf::dict_get(doc, font_dict, "FontMatrix")
        .and_then(|o| pdf::num_array(doc, o))
        .and_then(|v| (v.len() >= 6).then(|| Matrix::new(v[0], v[1], v[2], v[3], v[4], v[5])))
        // Mặc định của Type3 là 1/1000 giống Type1.
        .unwrap_or(Matrix::new(0.001, 0.0, 0.0, 0.001, 0.0, 0.0));

    let char_procs = pdf::dict_get_dict(doc, font_dict, "CharProcs")
        .cloned()
        .unwrap_or_default();
    let resources = pdf::dict_get_dict(doc, font_dict, "Resources").cloned();

    let mut encoding = SimpleEncoding::new(BaseEncoding::Builtin);
    if let Some(Object::Dictionary(enc_dict)) = pdf::dict_get(doc, font_dict, "Encoding") {
        apply_differences(doc, enc_dict, &mut encoding);
    }

    LoadedFont {
        program: FontProgram::Missing,
        encoding: Some(encoding),
        cmap: None,
        cid_to_gid: CidToGid::Identity,
        widths: load_simple_widths(doc, font_dict, None),
        type3: Some(Type3Data {
            char_procs,
            resources,
            font_matrix,
        }),
        is_type0: false,
        base_font,
        substituted: false,
        cache: RefCell::new(HashMap::new()),
    }
}

fn load_program(doc: &Document, descriptor: Option<&Dictionary>) -> FontProgram {
    let Some(desc) = descriptor else {
        return FontProgram::Missing;
    };
    if let Some(obj) = desc.get(b"FontFile2").ok() {
        if let Some(data) = pdf::stream_data(doc, obj) {
            return FontProgram::TrueType(Arc::new(data));
        }
    }
    if let Some(obj) = desc.get(b"FontFile3").ok() {
        if let Some(data) = pdf::stream_data(doc, obj) {
            // `/Subtype /OpenType` là file OpenType đầy đủ; các subtype khác
            // (Type1C, CIDFontType0C) là CFF thô.
            let subtype = match pdf::deref(doc, obj) {
                Object::Stream(s) => pdf::dict_get(doc, &s.dict, "Subtype").and_then(pdf::name_str),
                _ => None,
            };
            return if subtype.as_deref() == Some("OpenType") {
                FontProgram::TrueType(Arc::new(data))
            } else {
                FontProgram::Cff(Arc::new(data))
            };
        }
    }
    if let Some(obj) = desc.get(b"FontFile").ok() {
        if let Some(data) = pdf::stream_data(doc, obj) {
            return FontProgram::Type1(Arc::new(data));
        }
    }
    FontProgram::Missing
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_widths_lookup_and_missing() {
        let w = Widths::Simple {
            first_char: 65,
            widths: vec![500.0, 600.0],
            missing: 250.0,
        };
        assert_eq!(w.get(65), Some(500.0));
        assert_eq!(w.get(66), Some(600.0));
        assert_eq!(w.get(67), Some(250.0), "ngoài bảng dùng MissingWidth");
        assert_eq!(w.get(10), None, "dưới FirstChar là không xác định");
    }

    #[test]
    fn cid_widths_use_ranges_then_default() {
        let w = Widths::Cid {
            default: 1000.0,
            ranges: vec![(1, 5, 500.0), (10, 10, 750.0)],
        };
        assert_eq!(w.get(3), Some(500.0));
        assert_eq!(w.get(10), Some(750.0));
        assert_eq!(w.get(99), Some(1000.0));
    }

    #[test]
    fn cid_to_gid_identity_and_map() {
        assert_eq!(CidToGid::Identity.gid(42), 42);
        let map = CidToGid::Map(Arc::new(vec![0x00, 0x05, 0x00, 0x09]));
        assert_eq!(map.gid(0), 5);
        assert_eq!(map.gid(1), 9);
    }

    #[test]
    fn cid_to_gid_out_of_range_is_notdef_not_identity() {
        // Rơi về identity sẽ vẽ một glyph tuỳ ý — sai mà vẫn "có chữ".
        let map = CidToGid::Map(Arc::new(vec![0x00, 0x05]));
        assert_eq!(map.gid(50), 0);
    }

    #[test]
    fn identity_cmap_reads_two_bytes() {
        let cmap = CMap::identity_two_byte();
        let (cid, n) = cmap.next_code(&[0x00, 0x41, 0x00, 0x42]);
        assert_eq!((cid, n), (0x41, 2));
    }

    #[test]
    fn identity_cmap_on_odd_tail_does_not_panic() {
        let cmap = CMap::identity_two_byte();
        let (_, n) = cmap.next_code(&[0x00]);
        assert!(n >= 1);
    }

    #[test]
    fn hex_token_parses_length_and_value() {
        assert_eq!(hex_token("<0041>"), Some((2, 0x41)));
        assert_eq!(hex_token("<41>"), Some((1, 0x41)));
        assert_eq!(hex_token("0041"), None);
        assert_eq!(hex_token("<041>"), None, "số nibble lẻ là không hợp lệ");
    }

    #[test]
    fn custom_cmap_maps_range_to_cid() {
        let cmap = CMap {
            identity: false,
            ranges: vec![(2, 0x0020, 0x007E, 1)],
            codespace: vec![(2, 0x0000, 0xFFFF)],
        };
        // Mã 0x0041 nằm trong khoảng bắt đầu 0x20 → CID = 1 + (0x41-0x20).
        let (cid, n) = cmap.next_code(&[0x00, 0x41]);
        assert_eq!(n, 2);
        assert_eq!(cid, 1 + (0x41 - 0x20));
    }

    #[test]
    fn mixed_length_codespace_picks_one_byte_range() {
        // CMap CJK trộn mã 1 byte và 2 byte. Đoán sai độ dài làm lệch cả chuỗi.
        let cmap = CMap {
            identity: false,
            ranges: vec![(1, 0x20, 0x7E, 1), (2, 0x8140, 0x9FFC, 633)],
            codespace: vec![(1, 0x20, 0x7E), (2, 0x8140, 0x9FFC)],
        };
        let (cid, n) = cmap.next_code(&[0x41, 0x81, 0x40]);
        assert_eq!(n, 1, "phải nhận mã 1 byte");
        assert_eq!(cid, 1 + (0x41 - 0x20));
        let (cid2, n2) = cmap.next_code(&[0x81, 0x40]);
        assert_eq!(n2, 2);
        assert_eq!(cid2, 633);
    }

    #[test]
    fn parse_cmap_stream_falls_back_to_identity_when_empty() {
        let doc = Document::new();
        let cmap = parse_cmap_stream(&doc, &Object::Null);
        assert!(cmap.identity);
    }

    #[test]
    fn symbolic_truetype_uses_builtin_macintosh_cmap() {
        // ReportLab subset font có `/Flags 4` và không có `/Encoding`. Với mã
        // 0x80, cmap Macintosh của DejaVu có glyph riêng còn cmap Unicode không
        // có U+0080; nếu rơi về `code as GID` thì sẽ chọn nhầm outline.
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("backend/app/assets/fonts/DejaVuSans.ttf");
        let data = std::fs::read(path).expect("test cần DejaVuSans.ttf");
        let face = ttf_parser::Face::parse(&data, 0).expect("font phải parse được");
        let expected = face
            .tables()
            .cmap
            .expect("font phải có cmap")
            .subtables
            .into_iter()
            .filter(|subtable| {
                subtable.platform_id == ttf_parser::PlatformId::Macintosh
            })
            .find_map(|subtable| subtable.glyph_index(0x80).map(|gid| gid.0))
            .expect("cmap Macintosh phải có mã 0x80");
        assert_ne!(expected, 0x80, "ca test phải phân biệt GID với mã byte");

        let font = LoadedFont {
            program: FontProgram::TrueType(Arc::new(data.clone())),
            encoding: Some(SimpleEncoding::new(BaseEncoding::Builtin)),
            cmap: None,
            cid_to_gid: CidToGid::Identity,
            widths: Widths::FromProgram,
            type3: None,
            is_type0: false,
            base_font: "AAAAAA+DejaVuSans".into(),
            substituted: false,
            cache: RefCell::new(HashMap::new()),
        };
        assert_eq!(font.truetype_gid(&face, 0x80), Some(expected));
    }

    #[test]
    fn missing_program_cannot_draw() {
        let font = LoadedFont {
            program: FontProgram::Missing,
            encoding: None,
            cmap: None,
            cid_to_gid: CidToGid::Identity,
            widths: Widths::FromProgram,
            type3: None,
            is_type0: false,
            base_font: "Test".into(),
            substituted: false,
            cache: RefCell::new(HashMap::new()),
        };
        assert!(font.cannot_draw());
        assert!(font.glyph_outline(65).is_none());
    }

    #[test]
    fn advance_falls_back_to_half_em_when_nothing_known() {
        // Không có /Widths và không có font: vẫn phải tiến con trỏ, nếu không mọi
        // ký tự sẽ chồng lên nhau tại một điểm.
        let font = LoadedFont {
            program: FontProgram::Missing,
            encoding: None,
            cmap: None,
            cid_to_gid: CidToGid::Identity,
            widths: Widths::FromProgram,
            type3: None,
            is_type0: false,
            base_font: "Test".into(),
            substituted: false,
            cache: RefCell::new(HashMap::new()),
        };
        assert!(font.advance(65) > 0.0);
    }
}
