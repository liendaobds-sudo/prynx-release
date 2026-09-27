//! UIUX (audit 2026-09-27 §V27.R8): HWND có focus gửi lệnh về shell đang sở hữu
//! tài liệu; fit/zoom dùng lại hiệu chuẩn và điều hướng hiện có của Viewer.

const VK_PRIOR: u32 = 0x21;
const VK_NEXT: u32 = 0x22;
const VK_END: u32 = 0x23;
const VK_HOME: u32 = 0x24;
const VK_0: u32 = 0x30;
const VK_1: u32 = 0x31;
const VK_2: u32 = 0x32;
const VK_NUMPAD0: u32 = 0x60;
const VK_NUMPAD1: u32 = 0x61;
const VK_NUMPAD2: u32 = 0x62;
const VK_ADD: u32 = 0x6B;
const VK_SUBTRACT: u32 = 0x6D;
const VK_OEM_PLUS: u32 = 0xBB;
const VK_OEM_MINUS: u32 = 0xBD;

/// Chỉ ánh xạ lệnh xem đã có; không lấy Space/Escape/Copy khỏi tương tác native.
pub fn viewer_command(vk: u32, ctrl: bool, alt: bool) -> Option<&'static str> {
    if alt {
        return None;
    }
    match vk {
        VK_0 | VK_NUMPAD0 if ctrl => Some("fit-page"),
        VK_1 | VK_NUMPAD1 if ctrl => Some("zoom-100"),
        VK_2 | VK_NUMPAD2 if ctrl => Some("fit-width"),
        VK_ADD | VK_OEM_PLUS => Some("zoom-in"),
        VK_SUBTRACT | VK_OEM_MINUS => Some("zoom-out"),
        VK_PRIOR if !ctrl => Some("prev-page"),
        VK_NEXT if !ctrl => Some("next-page"),
        VK_HOME if !ctrl => Some("first-page"),
        VK_END if !ctrl => Some("last-page"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_fit_commands_match_shell_for_top_row_and_numpad() {
        for (keys, expected) in [
            ([VK_0, VK_NUMPAD0], "fit-page"),
            ([VK_1, VK_NUMPAD1], "zoom-100"),
            ([VK_2, VK_NUMPAD2], "fit-width"),
        ] {
            for key in keys {
                assert_eq!(viewer_command(key, true, false), Some(expected));
                assert_eq!(viewer_command(key, false, false), None);
            }
        }
    }

    #[test]
    fn plus_and_minus_match_shell_with_and_without_ctrl() {
        for ctrl in [false, true] {
            for key in [VK_ADD, VK_OEM_PLUS] {
                assert_eq!(viewer_command(key, ctrl, false), Some("zoom-in"));
            }
            for key in [VK_SUBTRACT, VK_OEM_MINUS] {
                assert_eq!(viewer_command(key, ctrl, false), Some("zoom-out"));
            }
        }
    }

    #[test]
    fn page_navigation_rejects_ctrl_and_alt_modifiers() {
        for (key, expected) in [
            (VK_PRIOR, "prev-page"),
            (VK_NEXT, "next-page"),
            (VK_HOME, "first-page"),
            (VK_END, "last-page"),
        ] {
            assert_eq!(viewer_command(key, false, false), Some(expected));
            assert_eq!(viewer_command(key, true, false), None);
            assert_eq!(viewer_command(key, false, true), None);
            assert_eq!(viewer_command(key, true, true), None);
        }
    }

    #[test]
    fn alt_never_dispatches_viewer_commands() {
        for key in [
            VK_0,
            VK_1,
            VK_2,
            VK_NUMPAD0,
            VK_NUMPAD1,
            VK_NUMPAD2,
            VK_ADD,
            VK_OEM_PLUS,
            VK_SUBTRACT,
            VK_OEM_MINUS,
        ] {
            for ctrl in [false, true] {
                assert_eq!(viewer_command(key, ctrl, true), None);
            }
        }
    }

    #[test]
    fn native_interactions_and_unrelated_shortcuts_remain_unmapped() {
        for key in [
            0x20, // Space giữ chế độ bàn tay tạm thời.
            0x1B, // Escape giữ hủy pan/vùng chọn.
            0x43, // Ctrl+C giữ sao chép vùng chọn native.
            0x48, // Không thêm lệnh H/V ngoài phạm vi.
            0x56,
            0x25, // Không lấy phím mũi tên của consumer khác.
            0x26,
            0x27,
            0x28,
            0x09,
            0x70,
            u32::MAX,
        ] {
            for ctrl in [false, true] {
                for alt in [false, true] {
                    assert_eq!(viewer_command(key, ctrl, alt), None);
                }
            }
        }
    }
}
