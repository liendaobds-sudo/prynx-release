//! Pure helpers for print page ordering & multi-page layouts (unit-testable).

/// Which pages in [start, end] to include.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageSubset {
    All,
    Odd,
    Even,
}

impl PageSubset {
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(|x| x.to_ascii_lowercase()).as_deref() {
            Some("odd") => PageSubset::Odd,
            Some("even") => PageSubset::Even,
            _ => PageSubset::All,
        }
    }
}

/// Print layout mode (mirrors Acrobat Size / Multiple / Booklet / Poster).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayoutMode {
    Size,
    Multiple,
    Booklet,
    Poster,
}

impl LayoutMode {
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(|x| x.to_ascii_lowercase()).as_deref() {
            Some("multiple") => LayoutMode::Multiple,
            Some("booklet") => LayoutMode::Booklet,
            Some("poster") => LayoutMode::Poster,
            _ => LayoutMode::Size,
        }
    }
}

/// 1-based page numbers in print order (after range + subset + reverse).
pub fn collect_page_numbers(
    start: i32,
    end: i32,
    page_count: i32,
    subset: PageSubset,
    reverse: bool,
) -> Vec<i32> {
    let lo = start.max(1).min(page_count.max(1));
    let hi = end.max(1).min(page_count.max(1));
    if lo > hi || page_count <= 0 {
        return vec![];
    }
    let mut pages: Vec<i32> = (lo..=hi)
        .filter(|&p| match subset {
            PageSubset::All => true,
            PageSubset::Odd => p % 2 == 1,
            PageSubset::Even => p % 2 == 0,
        })
        .collect();
    if reverse {
        pages.reverse();
    }
    pages
}

/// Danh sách trang cuối cùng cho một job in.
///
/// Khi `explicit_pages` tồn tại, giữ nguyên thứ tự/danh sách caller đã chọn và chỉ
/// áp dụng lọc lẻ-chẵn + đảo thứ tự. Mọi trang ngoài biên phải fail-closed trước
/// khi tạo job GDI; tuyệt đối không kẹp về min/max vì sẽ in thêm trang ngoài ý muốn.
pub fn resolve_page_numbers(
    explicit_pages: Option<&[i32]>,
    start: i32,
    end: i32,
    page_count: i32,
    subset: PageSubset,
    reverse: bool,
) -> Result<Vec<i32>, String> {
    if page_count <= 0 {
        return Err("PDF không có trang nào".into());
    }

    let mut pages = if let Some(explicit) = explicit_pages {
        if explicit.is_empty() {
            return Err("Danh sách trang cần in đang trống".into());
        }
        for &page in explicit {
            if page < 1 || page > page_count {
                return Err(format!("Trang {page} nằm ngoài phạm vi 1-{page_count}"));
            }
        }
        explicit
            .iter()
            .copied()
            .filter(|&page| match subset {
                PageSubset::All => true,
                PageSubset::Odd => page % 2 == 1,
                PageSubset::Even => page % 2 == 0,
            })
            .collect::<Vec<_>>()
    } else {
        // Đường tương thích cũ: khoảng liên tục vẫn giữ nguyên hành vi hiện tại.
        return match collect_page_numbers(start, end, page_count, subset, reverse) {
            pages if pages.is_empty() => {
                Err("Không có trang nào để in (kiểm tra khoảng trang / lẻ-chẵn)".into())
            }
            pages => Ok(pages),
        };
    };

    if reverse {
        pages.reverse();
    }
    if pages.is_empty() {
        return Err("Không có trang nào để in (kiểm tra danh sách trang / lẻ-chẵn)".into());
    }
    Ok(pages)
}

/// Pad length up to multiple of 4 for saddle-stitch booklet.
pub fn booklet_padded_len(n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    ((n + 3) / 4) * 4
}

/// Booklet sides as (left_page, right_page) 1-based indices into a 1..=padded sequence.
/// Page numbers refer to logical document pages; blanks are 0.
/// `src_pages` is the list of real pages to place (already subset/reverse); blanks pad to 4k.
pub fn booklet_sheet_sides(src_pages: &[i32]) -> Vec<(i32, i32)> {
    let n = booklet_padded_len(src_pages.len());
    if n == 0 {
        return vec![];
    }
    // Map slot 1..=n → page number (0 = blank)
    let mut slots = vec![0i32; n];
    for (i, &p) in src_pages.iter().enumerate() {
        slots[i] = p;
    }
    let sheets = n / 4;
    let mut sides = Vec::with_capacity(sheets * 2);
    for s in 0..sheets {
        // Front: outer-left (last), outer-right (first of pair)
        let fl = slots[n - 1 - 2 * s];
        let fr = slots[2 * s];
        // Back: inner-left, inner-right
        let bl = slots[2 * s + 1];
        let br = slots[n - 2 - 2 * s];
        sides.push((fl, fr));
        sides.push((bl, br));
    }
    sides
}

/// Grid (cols, rows) for N pages per sheet.
pub fn multipage_grid(pages_per_sheet: u32) -> (u32, u32) {
    match pages_per_sheet {
        1 => (1, 1),
        2 => (2, 1),
        4 => (2, 2),
        6 => (3, 2),
        9 => (3, 3),
        16 => (4, 4),
        n if n > 0 => {
            let cols = (n as f64).sqrt().ceil() as u32;
            let rows = ((n as f64) / cols as f64).ceil() as u32;
            (cols.max(1), rows.max(1))
        }
        _ => (1, 1),
    }
}

/// Chunk pages into sheets of `per_sheet` (last sheet may be short).
pub fn chunk_pages(pages: &[i32], per_sheet: usize) -> Vec<Vec<i32>> {
    if per_sheet == 0 {
        return vec![];
    }
    pages.chunks(per_sheet).map(|c| c.to_vec()).collect()
}

/// Poster tile grid: cols × rows covering one page.
pub fn poster_tiles(cols: u32, rows: u32) -> Vec<(u32, u32)> {
    let cols = cols.max(1);
    let rows = rows.max(1);
    let mut out = Vec::with_capacity((cols * rows) as usize);
    for r in 0..rows {
        for c in 0..cols {
            out.push((c, r));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subset_odd_even_reverse() {
        assert_eq!(
            collect_page_numbers(1, 5, 5, PageSubset::Odd, false),
            vec![1, 3, 5]
        );
        assert_eq!(
            collect_page_numbers(1, 5, 5, PageSubset::Even, true),
            vec![4, 2]
        );
    }

    #[test]
    fn explicit_page_list_preserves_gaps_and_applies_subset_reverse() {
        let pages = vec![27, 28, 30, 31, 32, 33];
        assert_eq!(
            resolve_page_numbers(Some(&pages), 1, 40, 40, PageSubset::All, false).unwrap(),
            pages
        );
        assert_eq!(
            resolve_page_numbers(Some(&pages), 1, 40, 40, PageSubset::Even, true).unwrap(),
            vec![32, 30, 28]
        );
    }

    #[test]
    fn explicit_page_list_rejects_empty_and_out_of_bounds() {
        assert!(resolve_page_numbers(Some(&[]), 1, 40, 40, PageSubset::All, false).is_err());
        let error =
            resolve_page_numbers(Some(&[27, 41]), 1, 40, 40, PageSubset::All, false).unwrap_err();
        assert!(error.contains("Trang 41"));
        assert!(error.contains("1-40"));
    }

    #[test]
    fn booklet_8_pages_order() {
        let src: Vec<i32> = (1..=8).collect();
        let sides = booklet_sheet_sides(&src);
        // Classic: (8,1)(2,7)(6,3)(4,5)
        assert_eq!(sides, vec![(8, 1), (2, 7), (6, 3), (4, 5)]);
    }

    #[test]
    fn booklet_pads_to_4() {
        let src = vec![1, 2, 3];
        let sides = booklet_sheet_sides(&src);
        // padded slots [1,2,3,0] → (0,1)(2,0) wait n=4:
        // s=0: fl=slots[3]=0, fr=slots[0]=1, bl=slots[1]=2, br=slots[2]=3
        assert_eq!(sides, vec![(0, 1), (2, 3)]);
    }

    #[test]
    fn multipage_grid_known() {
        assert_eq!(multipage_grid(4), (2, 2));
        assert_eq!(multipage_grid(2), (2, 1));
        assert_eq!(multipage_grid(9), (3, 3));
    }

    #[test]
    fn chunk_pages_works() {
        assert_eq!(
            chunk_pages(&[1, 2, 3, 4, 5], 2),
            vec![vec![1, 2], vec![3, 4], vec![5]]
        );
    }
}
