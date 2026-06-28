/**
 * toolHelp — Nội dung giới thiệu chi tiết cho từng công cụ (hiển thị trong modal).
 *
 * Key = tool unique key (giống getToolUniqueKey): focusFeature | lockedMode | id.
 * ToolItem sẽ tra cứu theo key này; nếu không có entry → fallback popover ngắn
 * dùng longDescription trong toolRegistry.
 */

export interface ToolHelpSection {
  heading: string;
  items: string[];
}

export interface ToolHelp {
  /** Tiêu đề hiển thị trong modal (thường trùng title trong registry). */
  title: string;
  /** Một câu tóm tắt công cụ làm gì. */
  tagline: string;
  /** Các mục nội dung: Khi nào dùng / Cách hoạt động / Lưu ý... */
  sections: ToolHelpSection[];
  /** Ghi chú công nghệ in (offset vs in nhanh) nếu liên quan. */
  printNote?: string;
}

export const TOOL_HELP: Record<string, ToolHelp> = {
  // ─────────── XỬ LÝ FILE ───────────
  shuffle: {
    title: 'Xáo trộn trang',
    tagline: 'Sắp xếp lại thứ tự trang trước khi in hoặc bình bài.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Cần đảo ngược thứ tự trang.',
        'In 2 mặt trên máy 1 mặt: tách/ghép trang lẻ và chẵn.',
        'Dồn trang theo mẫu lặp lại để vào khâu in tự động.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Nhập thứ tự trang mới hoặc chọn preset có sẵn (đảo ngược, lẻ trước/chẵn sau…).',
        'Mọi thao tác chạy trên bản đang làm việc, không sửa file gốc.',
      ]},
    ],
  },
  resize: {
    title: 'Co giãn trang (Resize)',
    tagline: 'Thu/phóng nội dung trang về đúng khổ giấy đích.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Artwork lệch khổ, cần fit khít A4/A3 hoặc khổ tùy chọn.',
        'Cần cắt (crop) theo viền artboard.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Chọn khổ đích và chế độ: Fit (giữ tỉ lệ), Fill, Stretch, hoặc Crop.',
      ]},
      { heading: 'Lưu ý', items: [
        'Fill/Stretch có thể làm méo tỉ lệ — ưu tiên Fit khi cần giữ hình.',
      ]},
    ],
  },
  split: {
    title: 'Tách file PDF',
    tagline: 'Tách một file PDF thành nhiều file con.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Cắt lẻ từng trang thành file riêng.',
        'Trích xuất một dải trang chỉ định.',
        'Chia đều file thành nhiều phần theo số trang/nhóm.',
      ]},
    ],
  },
  pages: {
    title: 'Quản lý trang',
    tagline: 'Chỉnh sửa cấu trúc trang của file PDF.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Nhân bản, di chuyển, xóa hoặc xoay trang.',
        'Xoay theo từng trang, theo dải, hoặc theo chẵn/lẻ.',
      ]},
    ],
  },
  combine_pdf: {
    title: 'Ghép & Trộn PDF',
    tagline: 'Ghép nhiều file PDF thành một, trực quan.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Nối tiếp nhiều file thành một bộ.',
        'Trộn xen kẽ trang lẻ/chẵn (vd ghép 2 lần scan một mặt).',
        'Chèn trang trắng hoặc trang từ file khác.',
      ]},
    ],
  },

  // ─────────── KỸ THUẬT IN (PREPRESS) ───────────
  preflight: {
    title: 'Preflight chuẩn in',
    tagline: 'Kiểm tra và tự động sửa lỗi kỹ thuật trước khi in.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Trước khi gửi file cho nhà in hoặc trước khi bình bài.',
        'Khi nhận file từ khách, chưa rõ chất lượng kỹ thuật.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Quét hệ màu RGB/CMYK, font nhúng, DPI ảnh, transparency, bleed.',
        'Liệt kê lỗi kèm nút auto-fix giống PitStop.',
      ]},
    ],
    printNote: 'Gần như bắt buộc cho offset. In nhanh vẫn nên kiểm hệ màu và font nhúng.',
  },
  convertcolors: {
    title: 'Chuyển hệ màu',
    tagline: 'Chuyển không gian màu sang CMYK và gắn ICC Profile chuẩn in.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'File thiết kế ở RGB cần in CMYK.',
        'Cần đồng bộ một ICC profile cho cả bộ file.',
      ]},
    ],
    printNote: 'Offset cần CMYK đúng ICC để màu khớp. In nhanh nhiều máy nhận RGB nhưng chuyển CMYK giúp màu ổn định hơn.',
  },
  hairlines: {
    title: 'Sửa nét mảnh (Hairlines)',
    tagline: 'Làm dày các nét quá mảnh để không bị mất khi in.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'File có nét mảnh dưới ~0.25pt, hoặc nét đặt 0pt (mảnh nhất).',
        'Bản vẽ kỹ thuật, biểu mẫu, khung viền nhiều đường mảnh.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Chọn ngưỡng phát hiện và độ dày thay thế (preset Nhẹ/Tiêu chuẩn/Mạnh).',
        'Tự bỏ qua nét màu Spot/Separation (vd đường bế CutContour) để không phá khuôn.',
      ]},
    ],
    printNote: 'Chủ yếu cho OFFSET/flexo — khi lên bản, nét quá mảnh dễ đứt hoặc mất. In nhanh (digital) hầu như không cần vì in raster độ phân giải cao.',
  },
  trapping: {
    title: 'Chồng tràn (Trapping) — Overprint đen',
    tagline: 'Bật Overprint cho chữ/nét đen để chống viền trắng khi in.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Chữ hoặc nét đen nằm trên nền màu.',
        'In offset nhiều lượt màu, lo lệch chồng màu (misregistration) lộ viền trắng.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Bật overprint cho đối tượng đen thuần (K > 95%).',
        'Tùy chọn giữ nguyên các thiết lập overprint đã có trong file.',
      ]},
      { heading: 'Lưu ý', items: [
        'Trapping spread/choke (bẫy mực hình học) cần hệ thống RIP trên máy CTP — không thực hiện ở đây.',
      ]},
    ],
    printNote: 'Dành cho OFFSET. In nhanh thường in một lượt nên không cần, và một số RIP digital còn bỏ qua cờ overprint.',
  },

  // ─────────── BÌNH BÀI / TEM / KHUÔN ───────────
  sticker: {
    title: 'Bù xén — Tạo đường cắt',
    tagline: 'Tạo đường cắt bế (CutContour) và tràn lề cho tem/nhãn.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Tem, nhãn, decal cần khuôn bế và bù xén (bleed).',
        'Cần xóa nền trắng và bo góc đường cắt.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Quét hình, offset viền ra ngoài, tạo lớp CutContour màu spot.',
        'Tùy chọn tràn lề ảnh hoặc lật gương mép để bù xén.',
      ]},
    ],
  },
  booklet: {
    title: 'Bình Sách & Tạp chí',
    tagline: 'Dàn tay sách lồng/khâu và tự tính bù gáy.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Sách, tạp chí, brochure cần dàn theo tay in.',
        'Đóng lồng đôi (saddle stitch) hoặc khâu chỉ.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Chọn kiểu đóng, số trang mỗi tay.',
        'Tự tính độ bù gáy (Creep) chống xẹp giấy khi lồng.',
      ]},
    ],
  },
  nup: {
    title: 'Bình Cắt Xén (N-Up)',
    tagline: 'Ghép nhiều trang hoặc nhân bản kín một tờ in lớn.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Card visit, tờ rơi, biểu mẫu in ghép nhiều con trên tờ lớn.',
        'Step & Repeat (nhân bản 1 mẫu kín tờ).',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Chọn lưới hàng × cột, khoảng cách giữa các con, vạch cắt.',
      ]},
    ],
  },
  sticker_imposer: {
    title: 'Bình Tem Bế',
    tagline: 'Bình bản tem bế: xếp so le tổ ong, chừa lề kẹp.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Tem decal dạng tờ hoặc cuộn cần bình tối ưu giấy.',
        'Ghép nhiều loại kích thước tem trên cùng tờ.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Hỗ trợ xếp so le tổ ong (Staggered Hex), chừa lề kẹp bế.',
      ]},
    ],
  },
  cnc_imposer: {
    title: 'Bình Bế Rớt (CNC)',
    tagline: 'Bình sản phẩm bế rớt/cắt rời trên máy CNC, hỗ trợ 2 mặt.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Sản phẩm cắt rời trên CNC/flatbed.',
        'In 2 mặt cần lật gương mặt sau và canh chồng.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Lật gương mặt sau, thêm dấu canh in 2 mặt.',
        'Xuất 3 trang: Mặt trước / Mặt sau / Khuôn.',
      ]},
    ],
  },
  dieline: {
    title: 'Khuôn bế Bao bì',
    tagline: 'Vẽ khuôn bao bì tham số và mô phỏng gập 3D.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Thiết kế hộp giấy, túi, bao bì cần khuôn bế chuẩn.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Chọn 1 trong 8 loại (nắp cài, đáy gài, quai xách, túi giấy, bọc ly, pizza, bì thư, hộp diêm).',
        'Nhập kích thước, xem mockup 3D, xuất PDF chuẩn tỉ lệ 1:1.',
      ]},
    ],
  },

  // ─────────── DỮ LIỆU BIẾN ĐỔI (VDP) ───────────
  datamerge: {
    title: 'Trộn dữ liệu VDP',
    tagline: 'Trộn dữ liệu CSV vào template để sinh PDF hàng loạt.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'In dữ liệu biến đổi: tên, mã, địa chỉ khác nhau mỗi bản.',
        'Thiệp, thẻ, phiếu cá nhân hóa số lượng lớn.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Nạp CSV (xuất từ Excel/Google Sheets), gán cột vào Data fields.',
        'Chèn chữ và hình theo dữ liệu, sinh PDF lô tốc độ cao.',
      ]},
    ],
  },
  numbering: {
    title: 'Nhảy số tự động',
    tagline: 'Đánh số serial thông minh theo tọa độ cố định.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Vé, phiếu, hóa đơn, mã serial cần nhảy số.',
        'In nhiều liên dùng chung dải số.',
      ]},
    ],
  },
  cover_numbering: {
    title: 'Mẹc Bìa (Chạy số bìa)',
    tagline: 'Đánh số bìa sổ/quyển nhiều liên (X/Y/Z).',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Sổ, quyển nhiều liên cần đánh số bìa theo dải ruột mỗi cuốn.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Phối hợp với Nhảy số (mẹc số) dùng chung dải để khớp bìa–ruột.',
      ]},
    ],
  },
  stick_text_number: {
    title: 'Header & Footer',
    tagline: 'Chèn đầu/chân trang cố định: số trang, ngày, text.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Cần đánh số trang, ngày tháng, hoặc text vào góc trang.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Chèn vào 6 vị trí góc trang (giống Acrobat), hỗ trợ [page], [date].',
      ]},
    ],
  },

  // ─────────── TIỆN ÍCH ───────────
  bgremover: {
    title: 'Tách nền ảnh AI',
    tagline: 'Bóc tách nền ảnh độ nét cao bằng AI.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Cần tách chủ thể khỏi nền phức tạp.',
        'Giữ chi tiết mảnh như tóc, lông thú.',
      ]},
    ],
  },
  watermark: {
    title: 'Chèn Nền & Đóng Dấu',
    tagline: 'Chèn phôi nền hoặc logo chìm (watermark).',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Bảo vệ bản quyền bằng watermark.',
        'Chèn phôi thiết kế vector làm nền.',
      ]},
    ],
  },
  optimize: {
    title: 'Nén / Tối ưu PDF',
    tagline: 'Giảm dung lượng file, nén ảnh, gỡ rác.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'File quá nặng khó gửi nhà in/email.',
        'Cần gỡ metadata, profile màu thừa.',
      ]},
      { heading: 'Lưu ý', items: [
        'Đừng downsample ảnh xuống dưới 300 DPI nếu còn dùng để in.',
      ]},
    ],
  },
  pdfx: {
    title: 'Xuất PDF/X chuẩn',
    tagline: 'Xuất file theo chuẩn in ấn PDF/X an toàn.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Nhà in yêu cầu file chuẩn PDF/X-1a hoặc PDF/X-4.',
      ]},
      { heading: 'Cách hoạt động', items: [
        'Flatten transparency, gắn output intent, chuyển chuẩn PDF/X.',
      ]},
    ],
    printNote: 'Chuẩn an toàn nhất để gửi nhà in offset.',
  },
  upscale: {
    title: 'AI Upscale',
    tagline: 'Phóng to ảnh nét căng (2x, 4x) bằng siêu phân giải.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Ảnh độ phân giải thấp cần phóng to mà không vỡ hạt.',
      ]},
    ],
  },

  // ─────────── KIỂM TRA CHẤT LƯỢNG (QC) ───────────
  compare_pdf: {
    title: 'So sánh PDF (In ấn)',
    tagline: 'So pixel bản mẫu và bản bình để phát hiện sai khác.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Kiểm tra bản bình có lệch so với bản mẫu duyệt.',
      ]},
    ],
  },
  compare_text: {
    title: 'So sánh Văn bản',
    tagline: 'So sánh text thuần siêu tốc giữa 2 phiên bản.',
    sections: [
      { heading: 'Khi nào dùng', items: [
        'Đối chiếu nội dung chữ giữa 2 bản Word/PDF.',
      ]},
    ],
  },
};

export function getToolHelp(key?: string): ToolHelp | undefined {
  if (!key) return undefined;
  return TOOL_HELP[key];
}
