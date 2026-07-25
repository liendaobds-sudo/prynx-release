//! Bảng mã hoá ký tự đơn byte của PDF.
//!
//! # Vì sao cần cả tên glyph và Unicode
//!
//! PDF định danh glyph theo hai đường khác nhau tuỳ loại font:
//!
//! * **Type1 / CFF** tra glyph theo **tên** (`/A`, `/eacute`). Đây là đường chính
//!   xác nhất vì chính font khai tên đó.
//! * **TrueType** tra theo **Unicode** qua bảng `cmap`. Nên với cùng một mã ký tự
//!   ta phải biết cả tên lẫn Unicode.
//!
//! Nhầm bảng mã dẫn tới vẽ sai mặt chữ — lỗi mà mắt thường khó bắt trên chữ Latin
//! nhưng lộ ngay với chữ có dấu, và với prepress thì sai chữ là in lại cả lô.

/// Một ô trong bảng mã: mã đơn byte → (tên glyph, điểm mã Unicode).
type Entry = (u8, &'static str, u32);

/// `WinAnsiEncoding` — bảng hay gặp nhất trong PDF thực tế.
///
/// Là Windows-1252: ASCII cho 32–126, khoảng 128–159 là ký tự in được (khác
/// Latin-1), 160–255 theo Latin-1.
pub const WIN_ANSI: &[Entry] = &[
    (32, "space", 0x0020), (33, "exclam", 0x0021), (34, "quotedbl", 0x0022),
    (35, "numbersign", 0x0023), (36, "dollar", 0x0024), (37, "percent", 0x0025),
    (38, "ampersand", 0x0026), (39, "quotesingle", 0x0027), (40, "parenleft", 0x0028),
    (41, "parenright", 0x0029), (42, "asterisk", 0x002A), (43, "plus", 0x002B),
    (44, "comma", 0x002C), (45, "hyphen", 0x002D), (46, "period", 0x002E),
    (47, "slash", 0x002F),
    (48, "zero", 0x0030), (49, "one", 0x0031), (50, "two", 0x0032), (51, "three", 0x0033),
    (52, "four", 0x0034), (53, "five", 0x0035), (54, "six", 0x0036), (55, "seven", 0x0037),
    (56, "eight", 0x0038), (57, "nine", 0x0039),
    (58, "colon", 0x003A), (59, "semicolon", 0x003B), (60, "less", 0x003C),
    (61, "equal", 0x003D), (62, "greater", 0x003E), (63, "question", 0x003F),
    (64, "at", 0x0040),
    (65, "A", 0x0041), (66, "B", 0x0042), (67, "C", 0x0043), (68, "D", 0x0044),
    (69, "E", 0x0045), (70, "F", 0x0046), (71, "G", 0x0047), (72, "H", 0x0048),
    (73, "I", 0x0049), (74, "J", 0x004A), (75, "K", 0x004B), (76, "L", 0x004C),
    (77, "M", 0x004D), (78, "N", 0x004E), (79, "O", 0x004F), (80, "P", 0x0050),
    (81, "Q", 0x0051), (82, "R", 0x0052), (83, "S", 0x0053), (84, "T", 0x0054),
    (85, "U", 0x0055), (86, "V", 0x0056), (87, "W", 0x0057), (88, "X", 0x0058),
    (89, "Y", 0x0059), (90, "Z", 0x005A),
    (91, "bracketleft", 0x005B), (92, "backslash", 0x005C), (93, "bracketright", 0x005D),
    (94, "asciicircum", 0x005E), (95, "underscore", 0x005F), (96, "grave", 0x0060),
    (97, "a", 0x0061), (98, "b", 0x0062), (99, "c", 0x0063), (100, "d", 0x0064),
    (101, "e", 0x0065), (102, "f", 0x0066), (103, "g", 0x0067), (104, "h", 0x0068),
    (105, "i", 0x0069), (106, "j", 0x006A), (107, "k", 0x006B), (108, "l", 0x006C),
    (109, "m", 0x006D), (110, "n", 0x006E), (111, "o", 0x006F), (112, "p", 0x0070),
    (113, "q", 0x0071), (114, "r", 0x0072), (115, "s", 0x0073), (116, "t", 0x0074),
    (117, "u", 0x0075), (118, "v", 0x0076), (119, "w", 0x0077), (120, "x", 0x0078),
    (121, "y", 0x0079), (122, "z", 0x007A),
    (123, "braceleft", 0x007B), (124, "bar", 0x007C), (125, "braceright", 0x007D),
    (126, "asciitilde", 0x007E),
    (128, "Euro", 0x20AC), (130, "quotesinglbase", 0x201A), (131, "florin", 0x0192),
    (132, "quotedblbase", 0x201E), (133, "ellipsis", 0x2026), (134, "dagger", 0x2020),
    (135, "daggerdbl", 0x2021), (136, "circumflex", 0x02C6), (137, "perthousand", 0x2030),
    (138, "Scaron", 0x0160), (139, "guilsinglleft", 0x2039), (140, "OE", 0x0152),
    (142, "Zcaron", 0x017D), (145, "quoteleft", 0x2018), (146, "quoteright", 0x2019),
    (147, "quotedblleft", 0x201C), (148, "quotedblright", 0x201D), (149, "bullet", 0x2022),
    (150, "endash", 0x2013), (151, "emdash", 0x2014), (152, "tilde", 0x02DC),
    (153, "trademark", 0x2122), (154, "scaron", 0x0161), (155, "guilsinglright", 0x203A),
    (156, "oe", 0x0153), (158, "zcaron", 0x017E), (159, "Ydieresis", 0x0178),
    (160, "space", 0x00A0), (161, "exclamdown", 0x00A1), (162, "cent", 0x00A2),
    (163, "sterling", 0x00A3), (164, "currency", 0x00A4), (165, "yen", 0x00A5),
    (166, "brokenbar", 0x00A6), (167, "section", 0x00A7), (168, "dieresis", 0x00A8),
    (169, "copyright", 0x00A9), (170, "ordfeminine", 0x00AA), (171, "guillemotleft", 0x00AB),
    (172, "logicalnot", 0x00AC), (173, "hyphen", 0x00AD), (174, "registered", 0x00AE),
    (175, "macron", 0x00AF), (176, "degree", 0x00B0), (177, "plusminus", 0x00B1),
    (178, "twosuperior", 0x00B2), (179, "threesuperior", 0x00B3), (180, "acute", 0x00B4),
    (181, "mu", 0x00B5), (182, "paragraph", 0x00B6), (183, "periodcentered", 0x00B7),
    (184, "cedilla", 0x00B8), (185, "onesuperior", 0x00B9), (186, "ordmasculine", 0x00BA),
    (187, "guillemotright", 0x00BB), (188, "onequarter", 0x00BC), (189, "onehalf", 0x00BD),
    (190, "threequarters", 0x00BE), (191, "questiondown", 0x00BF),
    (192, "Agrave", 0x00C0), (193, "Aacute", 0x00C1), (194, "Acircumflex", 0x00C2),
    (195, "Atilde", 0x00C3), (196, "Adieresis", 0x00C4), (197, "Aring", 0x00C5),
    (198, "AE", 0x00C6), (199, "Ccedilla", 0x00C7), (200, "Egrave", 0x00C8),
    (201, "Eacute", 0x00C9), (202, "Ecircumflex", 0x00CA), (203, "Edieresis", 0x00CB),
    (204, "Igrave", 0x00CC), (205, "Iacute", 0x00CD), (206, "Icircumflex", 0x00CE),
    (207, "Idieresis", 0x00CF), (208, "Eth", 0x00D0), (209, "Ntilde", 0x00D1),
    (210, "Ograve", 0x00D2), (211, "Oacute", 0x00D3), (212, "Ocircumflex", 0x00D4),
    (213, "Otilde", 0x00D5), (214, "Odieresis", 0x00D6), (215, "multiply", 0x00D7),
    (216, "Oslash", 0x00D8), (217, "Ugrave", 0x00D9), (218, "Uacute", 0x00DA),
    (219, "Ucircumflex", 0x00DB), (220, "Udieresis", 0x00DC), (221, "Yacute", 0x00DD),
    (222, "Thorn", 0x00DE), (223, "germandbls", 0x00DF),
    (224, "agrave", 0x00E0), (225, "aacute", 0x00E1), (226, "acircumflex", 0x00E2),
    (227, "atilde", 0x00E3), (228, "adieresis", 0x00E4), (229, "aring", 0x00E5),
    (230, "ae", 0x00E6), (231, "ccedilla", 0x00E7), (232, "egrave", 0x00E8),
    (233, "eacute", 0x00E9), (234, "ecircumflex", 0x00EA), (235, "edieresis", 0x00EB),
    (236, "igrave", 0x00EC), (237, "iacute", 0x00ED), (238, "icircumflex", 0x00EE),
    (239, "idieresis", 0x00EF), (240, "eth", 0x00F0), (241, "ntilde", 0x00F1),
    (242, "ograve", 0x00F2), (243, "oacute", 0x00F3), (244, "ocircumflex", 0x00F4),
    (245, "otilde", 0x00F5), (246, "odieresis", 0x00F6), (247, "divide", 0x00F7),
    (248, "oslash", 0x00F8), (249, "ugrave", 0x00F9), (250, "uacute", 0x00FA),
    (251, "ucircumflex", 0x00FB), (252, "udieresis", 0x00FC), (253, "yacute", 0x00FD),
    (254, "thorn", 0x00FE), (255, "ydieresis", 0x00FF),
];

/// `StandardEncoding` — mã hoá gốc của Adobe. Khác WinAnsi chủ yếu ở vùng > 127
/// và ở dấu nháy (`quoteright` ở 39 thay vì `quotesingle`).
pub const STANDARD: &[Entry] = &[
    (39, "quoteright", 0x2019), (96, "quoteleft", 0x2018),
    (161, "exclamdown", 0x00A1), (162, "cent", 0x00A2), (163, "sterling", 0x00A3),
    (164, "fraction", 0x2044), (165, "yen", 0x00A5), (166, "florin", 0x0192),
    (167, "section", 0x00A7), (168, "currency", 0x00A4), (169, "quotesingle", 0x0027),
    (170, "quotedblleft", 0x201C), (171, "guillemotleft", 0x00AB),
    (172, "guilsinglleft", 0x2039), (173, "guilsinglright", 0x203A), (174, "fi", 0xFB01),
    (175, "fl", 0xFB02), (177, "endash", 0x2013), (178, "dagger", 0x2020),
    (179, "daggerdbl", 0x2021), (180, "periodcentered", 0x00B7), (182, "paragraph", 0x00B6),
    (183, "bullet", 0x2022), (184, "quotesinglbase", 0x201A), (185, "quotedblbase", 0x201E),
    (186, "quotedblright", 0x201D), (187, "guillemotright", 0x00BB), (188, "ellipsis", 0x2026),
    (189, "perthousand", 0x2030), (191, "questiondown", 0x00BF), (193, "grave", 0x0060),
    (194, "acute", 0x00B4), (195, "circumflex", 0x02C6), (196, "tilde", 0x02DC),
    (197, "macron", 0x00AF), (198, "breve", 0x02D8), (199, "dotaccent", 0x02D9),
    (200, "dieresis", 0x00A8), (202, "ring", 0x02DA), (203, "cedilla", 0x00B8),
    (205, "hungarumlaut", 0x02DD), (206, "ogonek", 0x02DB), (207, "caron", 0x02C7),
    (208, "emdash", 0x2014), (225, "AE", 0x00C6), (227, "ordfeminine", 0x00AA),
    (232, "Lslash", 0x0141), (233, "Oslash", 0x00D8), (234, "OE", 0x0152),
    (235, "ordmasculine", 0x00BA), (241, "ae", 0x00E6), (245, "dotlessi", 0x0131),
    (248, "lslash", 0x0142), (249, "oslash", 0x00F8), (250, "oe", 0x0153),
    (251, "germandbls", 0x00DF),
];

/// `MacRomanEncoding` — phần khác WinAnsi ở vùng > 127.
pub const MAC_ROMAN: &[Entry] = &[
    (128, "Adieresis", 0x00C4), (129, "Aring", 0x00C5), (130, "Ccedilla", 0x00C7),
    (131, "Eacute", 0x00C9), (132, "Ntilde", 0x00D1), (133, "Odieresis", 0x00D6),
    (134, "Udieresis", 0x00DC), (135, "aacute", 0x00E1), (136, "agrave", 0x00E0),
    (137, "acircumflex", 0x00E2), (138, "adieresis", 0x00E4), (139, "atilde", 0x00E3),
    (140, "aring", 0x00E5), (141, "ccedilla", 0x00E7), (142, "eacute", 0x00E9),
    (143, "egrave", 0x00E8), (144, "ecircumflex", 0x00EA), (145, "edieresis", 0x00EB),
    (146, "iacute", 0x00ED), (147, "igrave", 0x00EC), (148, "icircumflex", 0x00EE),
    (149, "idieresis", 0x00EF), (150, "ntilde", 0x00F1), (151, "oacute", 0x00F3),
    (152, "ograve", 0x00F2), (153, "ocircumflex", 0x00F4), (154, "odieresis", 0x00F6),
    (155, "otilde", 0x00F5), (156, "uacute", 0x00FA), (157, "ugrave", 0x00F9),
    (158, "ucircumflex", 0x00FB), (159, "udieresis", 0x00FC), (160, "dagger", 0x2020),
    (161, "degree", 0x00B0), (162, "cent", 0x00A2), (163, "sterling", 0x00A3),
    (164, "section", 0x00A7), (165, "bullet", 0x2022), (166, "paragraph", 0x00B6),
    (167, "germandbls", 0x00DF), (168, "registered", 0x00AE), (169, "copyright", 0x00A9),
    (170, "trademark", 0x2122), (171, "acute", 0x00B4), (172, "dieresis", 0x00A8),
    (174, "AE", 0x00C6), (175, "Oslash", 0x00D8), (177, "plusminus", 0x00B1),
    (180, "yen", 0x00A5), (181, "mu", 0x00B5), (187, "ordfeminine", 0x00AA),
    (188, "ordmasculine", 0x00BA), (190, "ae", 0x00E6), (191, "oslash", 0x00F8),
    (192, "questiondown", 0x00BF), (193, "exclamdown", 0x00A1), (194, "logicalnot", 0x00AC),
    (196, "florin", 0x0192), (199, "guillemotleft", 0x00AB), (200, "guillemotright", 0x00BB),
    (201, "ellipsis", 0x2026), (202, "space", 0x00A0), (203, "Agrave", 0x00C0),
    (204, "Atilde", 0x00C3), (205, "Otilde", 0x00D5), (206, "OE", 0x0152),
    (207, "oe", 0x0153), (208, "endash", 0x2013), (209, "emdash", 0x2014),
    (210, "quotedblleft", 0x201C), (211, "quotedblright", 0x201D), (212, "quoteleft", 0x2018),
    (213, "quoteright", 0x2019), (214, "divide", 0x00F7), (216, "ydieresis", 0x00FF),
    (217, "Ydieresis", 0x0178), (218, "fraction", 0x2044), (219, "currency", 0x00A4),
    (220, "guilsinglleft", 0x2039), (221, "guilsinglright", 0x203A), (222, "fi", 0xFB01),
    (223, "fl", 0xFB02), (224, "daggerdbl", 0x2021), (225, "periodcentered", 0x00B7),
    (226, "quotesinglbase", 0x201A), (227, "quotedblbase", 0x201E),
    (228, "perthousand", 0x2030), (229, "Acircumflex", 0x00C2),
    (230, "Ecircumflex", 0x00CA), (231, "Aacute", 0x00C1), (232, "Edieresis", 0x00CB),
    (233, "Egrave", 0x00C8), (234, "Iacute", 0x00CD), (235, "Icircumflex", 0x00CE),
    (236, "Idieresis", 0x00CF), (237, "Igrave", 0x00CC), (238, "Oacute", 0x00D3),
    (239, "Ocircumflex", 0x00D4), (241, "Ograve", 0x00D2), (242, "Uacute", 0x00DA),
    (243, "Ucircumflex", 0x00DB), (244, "Ugrave", 0x00D9), (245, "dotlessi", 0x0131),
    (246, "circumflex", 0x02C6), (247, "tilde", 0x02DC), (248, "macron", 0x00AF),
    (249, "breve", 0x02D8), (250, "dotaccent", 0x02D9), (251, "ring", 0x02DA),
    (252, "cedilla", 0x00B8), (253, "hungarumlaut", 0x02DD), (254, "ogonek", 0x02DB),
    (255, "caron", 0x02C7),
];

/// Bảng mã hoá cơ sở đã chọn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BaseEncoding {
    Standard,
    WinAnsi,
    MacRoman,
    /// Không khai bảng nào: dùng mã hoá dựng sẵn trong font (font symbol).
    Builtin,
}

impl BaseEncoding {
    pub fn from_name(name: &str) -> Option<BaseEncoding> {
        match name {
            "WinAnsiEncoding" => Some(BaseEncoding::WinAnsi),
            "MacRomanEncoding" => Some(BaseEncoding::MacRoman),
            "StandardEncoding" | "PDFDocEncoding" => Some(BaseEncoding::Standard),
            // MacExpertEncoding là bảng ký tự chuyên biệt; chưa dựng bảng riêng.
            _ => None,
        }
    }
}

/// Bảng mã hoá đã phân giải cho một font đơn byte.
#[derive(Debug, Clone)]
pub struct SimpleEncoding {
    /// Tên glyph theo mã, `None` nếu không xác định.
    names: Vec<Option<String>>,
    /// Điểm mã Unicode theo mã.
    unicode: Vec<Option<u32>>,
    pub base: BaseEncoding,
}

impl SimpleEncoding {
    /// Dựng từ bảng cơ sở, chưa áp `/Differences`.
    pub fn new(base: BaseEncoding) -> Self {
        let mut enc = SimpleEncoding {
            names: vec![None; 256],
            unicode: vec![None; 256],
            base,
        };
        match base {
            BaseEncoding::Builtin => {}
            BaseEncoding::WinAnsi => enc.apply_table(WIN_ANSI),
            BaseEncoding::MacRoman => {
                // MacRoman dùng chung ASCII với WinAnsi; chỉ khác vùng > 127.
                enc.apply_table(&WIN_ANSI[..95]);
                enc.apply_table(MAC_ROMAN);
            }
            BaseEncoding::Standard => {
                enc.apply_table(&WIN_ANSI[..95]);
                enc.apply_table(STANDARD);
            }
        }
        enc
    }

    fn apply_table(&mut self, table: &[Entry]) {
        for (code, name, uni) in table {
            self.names[*code as usize] = Some((*name).to_string());
            self.unicode[*code as usize] = Some(*uni);
        }
    }

    /// Áp một ô của `/Differences`.
    ///
    /// Tên trong `/Differences` là **thẩm quyền cao nhất**: nó ghi đè bảng cơ sở.
    /// Bỏ qua nó là nguyên nhân phổ biến nhất của "chữ ra sai ký tự" khi font đã
    /// được subset lại bởi Illustrator/InDesign.
    pub fn set_difference(&mut self, code: u8, glyph_name: &str) {
        self.unicode[code as usize] = unicode_from_glyph_name(glyph_name);
        self.names[code as usize] = Some(glyph_name.to_string());
    }

    pub fn glyph_name(&self, code: u8) -> Option<&str> {
        self.names[code as usize].as_deref()
    }

    pub fn unicode(&self, code: u8) -> Option<u32> {
        self.unicode[code as usize]
    }
}

/// Suy Unicode từ tên glyph.
///
/// Xử lý ba dạng: tên trong bảng chuẩn, `uniXXXX` / `uXXXX{4,6}` (AGL), và
/// `gNN` / `cidNN` (không có nghĩa Unicode — trả `None`, caller phải tra theo chỉ
/// số glyph).
pub fn unicode_from_glyph_name(name: &str) -> Option<u32> {
    for table in [WIN_ANSI, STANDARD, MAC_ROMAN] {
        if let Some((_, _, uni)) = table.iter().find(|(_, n, _)| *n == name) {
            return Some(*uni);
        }
    }
    if let Some(hex) = name.strip_prefix("uni") {
        if hex.len() >= 4 {
            return u32::from_str_radix(&hex[..4], 16).ok();
        }
    }
    if let Some(hex) = name.strip_prefix('u') {
        if (4..=6).contains(&hex.len()) {
            return u32::from_str_radix(hex, 16).ok();
        }
    }
    // Tên một ký tự ASCII (font subset đôi khi dùng) — coi là chính ký tự đó.
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_graphic() {
            return Some(c as u32);
        }
    }
    None
}

/// Chỉ số glyph suy từ tên dạng `gNN` (font subset thường dùng).
pub fn glyph_index_from_name(name: &str) -> Option<u16> {
    for prefix in ["glyph", "g", "index", "cid"] {
        if let Some(rest) = name.strip_prefix(prefix) {
            if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                return rest.parse().ok();
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_ansi_covers_ascii_letters() {
        let enc = SimpleEncoding::new(BaseEncoding::WinAnsi);
        assert_eq!(enc.glyph_name(b'A'), Some("A"));
        assert_eq!(enc.unicode(b'A'), Some(0x41));
        assert_eq!(enc.glyph_name(b'z'), Some("z"));
    }

    #[test]
    fn win_ansi_has_windows_1252_specials() {
        let enc = SimpleEncoding::new(BaseEncoding::WinAnsi);
        assert_eq!(enc.unicode(128), Some(0x20AC), "128 phải là dấu Euro");
        assert_eq!(enc.glyph_name(150), Some("endash"));
    }

    #[test]
    fn win_ansi_accented_letters_are_present() {
        // Vùng này là nơi chọn sai bảng mã lộ ra rõ nhất.
        let enc = SimpleEncoding::new(BaseEncoding::WinAnsi);
        assert_eq!(enc.glyph_name(233), Some("eacute"));
        assert_eq!(enc.unicode(233), Some(0x00E9));
    }

    #[test]
    fn standard_encoding_differs_from_win_ansi_at_quote() {
        // Ô 39: Standard là `quoteright`, WinAnsi là `quotesingle`. Lẫn hai bảng
        // này làm dấu nháy ra sai hình.
        let std_enc = SimpleEncoding::new(BaseEncoding::Standard);
        let win = SimpleEncoding::new(BaseEncoding::WinAnsi);
        assert_eq!(std_enc.glyph_name(39), Some("quoteright"));
        assert_eq!(win.glyph_name(39), Some("quotesingle"));
    }

    #[test]
    fn mac_roman_differs_above_127() {
        let mac = SimpleEncoding::new(BaseEncoding::MacRoman);
        assert_eq!(mac.glyph_name(128), Some("Adieresis"));
        assert_eq!(mac.glyph_name(b'A'), Some("A"), "ASCII vẫn phải đúng");
    }

    #[test]
    fn builtin_encoding_starts_empty() {
        let enc = SimpleEncoding::new(BaseEncoding::Builtin);
        assert_eq!(enc.glyph_name(b'A'), None, "font symbol tự khai bảng mã");
    }

    #[test]
    fn differences_override_base_table() {
        let mut enc = SimpleEncoding::new(BaseEncoding::WinAnsi);
        enc.set_difference(65, "eacute");
        assert_eq!(enc.glyph_name(65), Some("eacute"));
        assert_eq!(enc.unicode(65), Some(0x00E9));
    }

    #[test]
    fn base_encoding_names_are_recognised() {
        assert_eq!(BaseEncoding::from_name("WinAnsiEncoding"), Some(BaseEncoding::WinAnsi));
        assert_eq!(BaseEncoding::from_name("MacRomanEncoding"), Some(BaseEncoding::MacRoman));
        assert_eq!(BaseEncoding::from_name("KhongCo"), None);
    }

    #[test]
    fn unicode_from_uni_prefixed_names() {
        assert_eq!(unicode_from_glyph_name("uni0041"), Some(0x41));
        assert_eq!(unicode_from_glyph_name("u00E9"), Some(0xE9));
        assert_eq!(unicode_from_glyph_name("uni1EA1"), Some(0x1EA1), "chữ Việt");
    }

    #[test]
    fn unicode_from_standard_names() {
        assert_eq!(unicode_from_glyph_name("eacute"), Some(0x00E9));
        assert_eq!(unicode_from_glyph_name("space"), Some(0x20));
    }

    #[test]
    fn unknown_glyph_name_yields_none() {
        assert_eq!(unicode_from_glyph_name("hoantoanlaso"), None);
    }

    #[test]
    fn glyph_index_names_are_parsed() {
        assert_eq!(glyph_index_from_name("g42"), Some(42));
        assert_eq!(glyph_index_from_name("glyph7"), Some(7));
        assert_eq!(glyph_index_from_name("cid100"), Some(100));
        assert_eq!(glyph_index_from_name("A"), None);
    }
}
