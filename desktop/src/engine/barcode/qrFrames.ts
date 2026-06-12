// ─── QR Frame definitions ────────────────────────────────
// Each frame wraps around the QR code as decorative border + CTA text

export interface QRFrame {
  id: string;
  name: string;
  ctaText?: string;       // Call-to-action text (e.g. "Quét tôi!")
  ctaPosition: 'top' | 'bottom' | 'none';
  borderRadius: number;   // px
  padding: number;        // px around QR
  borderWidth: number;    // px
  style: 'simple' | 'rounded' | 'badge' | 'bubble' | 'arrow' | 'tag';
}

export const QR_FRAMES: QRFrame[] = [
  // No frame
  { id: 'none', name: 'Không khung', ctaPosition: 'none', borderRadius: 0, padding: 0, borderWidth: 0, style: 'simple' },

  // Simple frames
  { id: 'simple-square', name: 'Vuông', ctaPosition: 'none', borderRadius: 0, padding: 16, borderWidth: 3, style: 'simple' },
  { id: 'simple-rounded', name: 'Bo tròn', ctaPosition: 'none', borderRadius: 16, padding: 16, borderWidth: 3, style: 'rounded' },
  { id: 'simple-pill', name: 'Bo tròn lớn', ctaPosition: 'none', borderRadius: 28, padding: 20, borderWidth: 3, style: 'rounded' },

  // With CTA text — bottom
  { id: 'scan-me', name: 'Quét tôi!', ctaText: 'QUÉT TÔI!', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'scan-me-en', name: 'Scan Me', ctaText: 'SCAN ME', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'scan-here', name: 'Quét ở đây', ctaText: 'QUÉT Ở ĐÂY', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'scan-qr', name: 'Scan QR Code', ctaText: 'SCAN QR CODE', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'follow-us', name: 'Theo dõi', ctaText: 'THEO DÕI CHÚNG TÔI', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'visit-us', name: 'Truy cập', ctaText: 'TRUY CẬP NGAY', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'view-menu', name: 'Xem menu', ctaText: 'XEM MENU', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'order-now', name: 'Đặt hàng', ctaText: 'ĐẶT HÀNG NGAY', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'download-app', name: 'Tải app', ctaText: 'TẢI ỨNG DỤNG', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'connect-wifi', name: 'Kết nối', ctaText: 'KẾT NỐI WIFI', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'pay-here', name: 'Thanh toán', ctaText: 'THANH TOÁN TẠI ĐÂY', ctaPosition: 'bottom', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },

  // With CTA text — top
  { id: 'scan-top', name: 'Quét (trên)', ctaText: 'QUÉT MÃ QR', ctaPosition: 'top', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },
  { id: 'info-top', name: 'Thông tin', ctaText: 'THÔNG TIN', ctaPosition: 'top', borderRadius: 16, padding: 16, borderWidth: 3, style: 'badge' },

  // Bubble style
  { id: 'bubble-scan', name: 'Bong bóng', ctaText: 'QUÉT TÔI!', ctaPosition: 'top', borderRadius: 24, padding: 20, borderWidth: 2, style: 'bubble' },

  // Arrow style
  { id: 'arrow-scan', name: 'Mũi tên', ctaText: 'SCAN HERE ↓', ctaPosition: 'top', borderRadius: 12, padding: 16, borderWidth: 3, style: 'arrow' },

  // Tag style (like a price tag / label)
  { id: 'tag-scan', name: 'Nhãn', ctaText: 'QUÉT MÃ', ctaPosition: 'bottom', borderRadius: 8, padding: 16, borderWidth: 2, style: 'tag' },
  { id: 'tag-promo', name: 'Khuyến mãi', ctaText: 'KHUYẾN MÃI', ctaPosition: 'bottom', borderRadius: 8, padding: 16, borderWidth: 2, style: 'tag' },
];
