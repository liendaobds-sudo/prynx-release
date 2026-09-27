//! UIUX (audit 2026-09-25 §R25.GPU.30): công cụ không chọn renderer.
use super::{controller::CameraSnapshot, overlay::OverlayRect};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
impl Rect {
    pub fn valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width >= 0.
            && self.height >= 0.
    }
    fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
    fn union(self, b: Self) -> Self {
        let x = self.x.min(b.x);
        let y = self.y.min(b.y);
        Self {
            x,
            y,
            width: (self.x + self.width).max(b.x + b.width) - x,
            height: (self.y + self.height).max(b.y + b.height) - y,
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
pub struct Glyph {
    pub text: String,
    pub bounds: Rect,
}
#[derive(Clone, Debug, Deserialize)]
pub struct TextLine {
    pub glyphs: Vec<Glyph>,
    pub link: Option<String>,
    #[serde(default)]
    pub pdf_coordinates: bool,
}
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Tool {
    #[default]
    Pointer,
    Hand,
}
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MarkupKind {
    Highlight,
    Underline,
    Strikethrough,
    Comment,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Markup {
    pub id: String,
    pub kind: MarkupKind,
    pub bounds: Rect,
    pub selected: bool,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Selection {
    pub text: String,
    pub rects: Vec<Rect>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InteractionEvent {
    Selection { selection: Option<Selection> },
    Link { url: String },
    Markup { id: String },
    ContextMenu { x: f32, y: f32 },
    // UIUX (audit 2026-09-25 §R25.GPU.32): sự kiện đi qua lease/revision như input khác.
    Wheel { delta_y: f32, at_top: bool, at_bottom: bool, viewport_height: f32 },
    // UIUX (audit 2026-09-27 §V27.R8): shell xử lý fit/zoom/chuyển trang thống nhất.
    ViewerCommand { command: &'static str },
    Dismiss,
    Copy,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Caret {
    line: usize,
    offset: usize,
}
#[derive(Default)]
pub struct Interaction {
    pub tool: Tool,
    pub lines: Vec<TextLine>,
    pub markups: Vec<Markup>,
    anchor: Option<Caret>,
    focus: Option<Caret>,
    down: Option<(f32, f32)>,
    dragged: bool,
    pub selecting: bool,
}
impl Interaction {
    pub fn validate_lines(lines: &[TextLine]) -> Result<(), String> {
        if lines
            .iter()
            .flat_map(|l| &l.glyphs)
            .any(|g| !g.bounds.valid())
        {
            return Err("Tọa độ chữ không hợp lệ".into());
        }
        Ok(())
    }
    pub fn set_tool(&mut self, tool: Tool) {
        self.tool = tool;
        self.selecting = false;
        self.down = None;
    }
    pub fn clear(&mut self) {
        self.anchor = None;
        self.focus = None;
        self.selecting = false;
        self.down = None;
    }
    fn line_bounds(line: &TextLine) -> Option<Rect> {
        line.glyphs.iter().map(|g| g.bounds).reduce(Rect::union)
    }
    pub fn text_hit(&self, x: f32, y: f32) -> bool {
        self.lines
            .iter()
            .any(|l| Self::line_bounds(l).is_some_and(|b| b.contains(x, y)))
    }
    fn caret(&self, x: f32, y: f32) -> Option<Caret> {
        let (index, line) = self
            .lines
            .iter()
            .enumerate()
            .filter(|(_, l)| !l.glyphs.is_empty())
            .min_by(|(_, a), (_, b)| {
                let score = |l: &TextLine| {
                    let b = Self::line_bounds(l).unwrap();
                    let dy = (b.y - y).max(y - b.y - b.height).max(0.);
                    let dx = (b.x - x).max(x - b.x - b.width).max(0.);
                    dy * dy + dx * dx
                };
                score(a).total_cmp(&score(b))
            })?;
        // Mỗi glyph có 2 mép caret: giữ đúng thứ tự Unicode, không cắt byte UTF-8.
        let first = line.glyphs.first()?.bounds;
        let last = line.glyphs.last()?.bounds;
        let dx = (last.x + last.width / 2.) - (first.x + first.width / 2.);
        let dy = (last.y + last.height / 2.) - (first.y + first.height / 2.);
        let vertical = dy.abs() > dx.abs();
        let reverse = if vertical { dy < 0. } else { dx < 0. };
        let mut best = (f32::INFINITY, 0);
        for (i, g) in line.glyphs.iter().enumerate() {
            let r = g.bounds;
            for end in [false, true] {
                let high = end != reverse;
                let (cx, cy) = if vertical {
                    (r.x + r.width / 2., r.y + if high { r.height } else { 0. })
                } else {
                    (r.x + if high { r.width } else { 0. }, r.y + r.height / 2.)
                };
                let distance = (x - cx).powi(2) + (y - cy).powi(2);
                if distance < best.0 {
                    best = (distance, i + usize::from(end));
                }
            }
        }
        let offset = best.1;
        Some(Caret {
            line: index,
            offset,
        })
    }
    pub fn down(&mut self, x: f32, y: f32, extend: bool) {
        self.down = Some((x, y));
        self.dragged = false;
        self.selecting = true;
        let caret = self.caret(x, y);
        if !extend || self.anchor.is_none() {
            self.anchor = caret;
        }
        self.focus = caret;
    }
    pub fn motion(&mut self, x: f32, y: f32, zoom: f32) {
        if !self.selecting {
            return;
        }
        if self
            .down
            .is_some_and(|(a, b)| ((x - a).hypot(y - b)) * zoom > 3.)
        {
            self.dragged = true;
        }
        self.focus = self.caret(x, y);
    }
    pub fn up(&mut self, x: f32, y: f32) -> InteractionEvent {
        if self.selecting {
            self.focus = self.caret(x, y);
        }
        self.selecting = false;
        self.down = None;
        if !self.dragged {
            if let Some(m) = self.markups.iter().rev().find(|m| m.bounds.contains(x, y)) {
                let id = m.id.clone();
                self.clear();
                return InteractionEvent::Markup { id };
            }
            if self.selection().is_none() {
                if let Some(url) = self
                    .lines
                    .iter()
                    .find(|l| Self::line_bounds(l).is_some_and(|b| b.contains(x, y)))
                    .and_then(|l| l.link.clone())
                {
                    self.clear();
                    return InteractionEvent::Link { url };
                }
            }
        }
        InteractionEvent::Selection {
            selection: self.selection(),
        }
    }
    pub fn select_word(&mut self, x: f32, y: f32) {
        let Some(c) = self.caret(x, y) else {
            return;
        };
        let line = &self.lines[c.line];
        if line.glyphs.is_empty() {
            return;
        }
        let at = c.offset.min(line.glyphs.len() - 1);
        let is_word = |i: usize| {
            line.glyphs[i]
                .text
                .chars()
                .any(|c| c.is_alphanumeric() || c == '_')
        };
        let mut a = at;
        let mut b = at + 1;
        if is_word(at) {
            while a > 0 && is_word(a - 1) {
                a -= 1;
            }
            while b < line.glyphs.len() && is_word(b) {
                b += 1;
            }
        }
        self.anchor = Some(Caret {
            line: c.line,
            offset: a,
        });
        self.focus = Some(Caret {
            line: c.line,
            offset: b,
        });
        self.selecting = false;
        self.dragged = true;
    }
    pub fn selection(&self) -> Option<Selection> {
        let (a, b) = (self.anchor?, self.focus?);
        if a == b {
            return None;
        }
        let (a, b) = if a < b { (a, b) } else { (b, a) };
        let mut text = String::new();
        let mut rects = vec![];
        for i in a.line..=b.line {
            let line = self.lines.get(i)?;
            let from = if i == a.line { a.offset } else { 0 };
            let to = if i == b.line {
                b.offset
            } else {
                line.glyphs.len()
            };
            let glyphs = line.glyphs.get(from..to)?;
            if glyphs.is_empty() {
                continue;
            }
            if !text.is_empty() {
                text.push('\n');
            }
            for g in glyphs {
                text.push_str(&g.text);
            }
            if let Some(rect) = glyphs.iter().map(|g| g.bounds).reduce(Rect::union) {
                rects.push(rect);
            }
        }
        if text.trim().is_empty() {
            None
        } else {
            Some(Selection { text, rects })
        }
    }
    pub fn overlay(&self, camera: CameraSnapshot) -> Vec<OverlayRect> {
        let s = camera.zoom * camera.dpr;
        let mut out = vec![];
        let mut add = |b: Rect, color, multiply| {
            out.push(OverlayRect {
                bounds: [
                    (b.x * camera.zoom + camera.pan_x) * camera.dpr,
                    (b.y * camera.zoom + camera.pan_y) * camera.dpr,
                    b.width * s,
                    b.height * s,
                ],
                color,
                multiply,
            })
        };
        for m in &self.markups {
            let mut b = m.bounds;
            let (color, multiply) = match m.kind {
                MarkupKind::Highlight | MarkupKind::Comment => {
                    ([250. / 255., 204. / 255., 21. / 255., 0.42], true)
                }
                MarkupKind::Underline => {
                    b.y += b.height - 2. / s;
                    b.height = 2. / s;
                    ([37. / 255., 99. / 255., 235. / 255., 1.], false)
                }
                MarkupKind::Strikethrough => {
                    b.y += b.height * 0.55;
                    b.height = 2. / s;
                    ([220. / 255., 38. / 255., 38. / 255., 1.], false)
                }
            };
            add(b, color, multiply);
            if m.selected {
                let b = m.bounds;
                let t = 2. / s;
                for edge in [
                    Rect { height: t, ..b },
                    Rect {
                        y: b.y + b.height - t,
                        height: t,
                        ..b
                    },
                    Rect { width: t, ..b },
                    Rect {
                        x: b.x + b.width - t,
                        width: t,
                        ..b
                    },
                ] {
                    add(edge, [0.15, 0.39, 0.92, 1.], false);
                }
            }
        }
        if let Some(sel) = self.selection() {
            for b in sel.rects {
                add(b, [0.1, 0.4, 1., 0.3], false);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(text: &str, y: f32) -> TextLine {
        TextLine {
            glyphs: text
                .chars()
                .enumerate()
                .map(|(i, c)| Glyph {
                    text: c.to_string(),
                    bounds: Rect {
                        x: i as f32 * 10.,
                        y,
                        width: 10.,
                        height: 10.,
                    },
                })
                .collect(),
            link: None,
            pdf_coordinates: false,
        }
    }
    fn model() -> Interaction {
        Interaction {
            lines: vec![line("Việt Nam", 0.), line("ABC", 20.)],
            ..Default::default()
        }
    }
    #[test]
    fn selection_unicode_and_reverse_multiline() {
        let mut m = model();
        m.down(29., 25., false);
        m.motion(10., 5., 2.);
        let s = m.selection().unwrap();
        assert_eq!(s.text, "iệt Nam\nABC");
        assert_eq!(s.rects.len(), 2);
    }
    #[test]
    fn pointer_click_does_not_select_or_pan() {
        let mut m = model();
        m.down(11., 5., false);
        assert!(matches!(
            m.up(11., 5.),
            InteractionEvent::Selection { selection: None }
        ));
    }
    #[test]
    fn hand_switch_keeps_selection_but_cancels_drag() {
        let mut m = model();
        m.down(1., 5., false);
        m.motion(29., 5., 1.);
        let s = m.selection();
        m.set_tool(Tool::Hand);
        m.motion(79., 5., 1.);
        assert_eq!(m.selection(), s);
        assert!(!m.selecting);
    }
    #[test]
    fn double_click_selects_unicode_word() {
        let mut m = model();
        m.select_word(21., 5.);
        assert_eq!(m.selection().unwrap().text, "Việt");
    }
    #[test]
    fn selection_overlay_tracks_pan_zoom_and_dpr() {
        let mut m = model();
        m.down(10., 5., false);
        m.motion(29., 5., 1.);
        let c = CameraSnapshot {
            zoom: 2.,
            pan_x: -5.,
            pan_y: 7.,
            viewport_width: 800,
            viewport_height: 600,
            dpr: 1.5,
        };
        let r = m.overlay(c);
        assert_eq!(r[0].bounds, [22.5, 10.5, 60., 30.]);
    }
    #[test]
    fn invalid_geometry_rejected_without_silently_dropping_text() {
        let mut l = line("A", 0.);
        l.glyphs[0].bounds.x = f32::NAN;
        assert!(Interaction::validate_lines(&[l]).is_err());
    }
    #[test]
    fn drag_on_link_selects_text_without_opening_link() {
        let mut m = model();
        m.lines[0].link = Some("https://example.com".into());
        m.down(1., 5., false);
        m.motion(35., 5., 1.);
        assert!(matches!(
            m.up(35., 5.),
            InteractionEvent::Selection { selection: Some(_) }
        ));
    }
    #[test]
    fn shift_click_extends_selection_without_opening_link() {
        let mut m = model();
        m.lines[0].link = Some("https://example.com".into());
        m.down(1., 5., false);
        m.motion(19., 5., 1.);
        m.up(19., 5.);
        m.down(39., 5., true);
        assert!(matches!(
            m.up(39., 5.),
            InteractionEvent::Selection { selection: Some(_) }
        ));
    }
    #[test]
    fn markup_hit_uses_page_space() {
        let mut m = model();
        m.markups = vec![Markup {
            id: "a".into(),
            kind: MarkupKind::Highlight,
            bounds: Rect {
                x: 0.,
                y: 0.,
                width: 30.,
                height: 10.,
            },
            selected: false,
        }];
        m.down(5., 5., false);
        assert!(matches!(m.up(5.,5.),InteractionEvent::Markup{id} if id=="a"));
    }
    #[test]
    fn rotated_text_uses_glyph_direction_not_horizontal_guess() {
        let mut m = model();
        m.lines.truncate(1);
        for g in &mut m.lines[0].glyphs {
            let r = &mut g.bounds;
            std::mem::swap(&mut r.x, &mut r.y);
        }
        m.down(5., 1., false);
        m.motion(5., 39., 1.);
        assert_eq!(m.selection().unwrap().text, "Việt");
    }
}
