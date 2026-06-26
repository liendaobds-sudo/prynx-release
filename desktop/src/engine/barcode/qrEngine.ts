import QRCodeStyling, {
  type Options as QRStylingOptions,
  type DotType,
  type CornerSquareType,
  type CornerDotType,
  type GradientType,
} from 'qr-code-styling';

// ─── Re-exports for backward compat ─────────────────────
export type { DotType, CornerSquareType, CornerDotType, GradientType };

// ─── Content Types ───────────────────────────────────────
export type QRContentType =
  | 'text' | 'url' | 'wifi' | 'vcard' | 'email' | 'sms' | 'phone'
  | 'social' | 'app';

export interface QRContentTypeInfo {
  id: QRContentType;
  label: string;
  icon: string;        // Lucide icon name
  description: string;
}

export const QR_CONTENT_TYPES: QRContentTypeInfo[] = [
  { id: 'text',   label: 'Văn bản',      icon: 'Type',           description: 'Nội dung văn bản' },
  { id: 'url',    label: 'Website URL',   icon: 'Globe',          description: 'Liên kết trang web' },
  { id: 'wifi',   label: 'WiFi',          icon: 'Wifi',           description: 'Kết nối WiFi' },
  { id: 'vcard',  label: 'Danh thiếp',    icon: 'Contact',        description: 'Thẻ liên hệ vCard' },
  { id: 'email',  label: 'Email',         icon: 'Mail',           description: 'Gửi email' },
  { id: 'sms',    label: 'SMS',           icon: 'MessageSquare',  description: 'Nhắn tin' },
  { id: 'phone',  label: 'Điện thoại',    icon: 'Phone',          description: 'Gọi điện' },
  { id: 'social', label: 'Mạng xã hội',   icon: 'Share2',         description: 'Links mạng xã hội' },
  { id: 'app',    label: 'Ứng dụng',      icon: 'Smartphone',     description: 'App Store / Google Play' },
];

// ─── Data Interfaces ─────────────────────────────────────
export interface WiFiData { ssid: string; password: string; encryption: 'WPA' | 'WEP' | 'nopass'; }
export interface VCardData {
  firstName: string; lastName: string;
  phone?: string; email?: string; company?: string; website?: string;
}
export interface EmailData { to: string; subject?: string; body?: string; }
export interface SMSData   { phone: string; message?: string; }
export interface SocialData {
  links: { platform: string; url: string }[];
}
export interface AppData {
  appStore?: string;
  playStore?: string;
}

// ─── Build QR String ─────────────────────────────────────
export function buildQRString(type: QRContentType, data: any): string {
  switch (type) {
    case 'url':   return data as string;
    case 'text':  return data as string;
    case 'phone': return `tel:${data}`;
    case 'wifi': {
      const w = data as WiFiData;
      return `WIFI:T:${w.encryption};S:${w.ssid};P:${w.password};;`;
    }
    case 'email': {
      const e = data as EmailData;
      let s = `mailto:${e.to}`;
      const params: string[] = [];
      if (e.subject) params.push(`subject=${encodeURIComponent(e.subject)}`);
      if (e.body)    params.push(`body=${encodeURIComponent(e.body)}`);
      if (params.length) s += '?' + params.join('&');
      return s;
    }
    case 'sms': {
      const sm = data as SMSData;
      return sm.message ? `smsto:${sm.phone}:${sm.message}` : `smsto:${sm.phone}`;
    }
    case 'vcard': {
      const v = data as VCardData;
      let card = 'BEGIN:VCARD\nVERSION:3.0\n';
      card += `N:${v.lastName};${v.firstName}\n`;
      card += `FN:${v.firstName} ${v.lastName}\n`;
      if (v.phone)   card += `TEL:${v.phone}\n`;
      if (v.email)   card += `EMAIL:${v.email}\n`;
      if (v.company) card += `ORG:${v.company}\n`;
      if (v.website) card += `URL:${v.website}\n`;
      card += 'END:VCARD';
      return card;
    }
    case 'social': {
      const s = data as SocialData;
      return s.links.map(l => l.url).filter(Boolean).join('\n');
    }
    case 'app': {
      const a = data as AppData;
      // Prefer App Store link, fallback to Play Store
      return a.appStore || a.playStore || '';
    }
    default: return String(data || '');
  }
}

// ─── Dot Styles ──────────────────────────────────────────
export const DOT_STYLES: { id: DotType; label: string }[] = [
  { id: 'square',          label: 'Vuông' },
  { id: 'rounded',         label: 'Bo tròn' },
  { id: 'dots',            label: 'Chấm tròn' },
  { id: 'classy',          label: 'Classy' },
  { id: 'classy-rounded',  label: 'Classy bo' },
  { id: 'extra-rounded',   label: 'Siêu tròn' },
];

// ─── Corner Frame Styles ─────────────────────────────────
export const CORNER_SQUARE_STYLES: { id: CornerSquareType | 'none'; label: string }[] = [
  { id: 'none',            label: 'Mặc định' },
  { id: 'square',          label: 'Vuông' },
  { id: 'dot',             label: 'Tròn' },
  { id: 'extra-rounded',   label: 'Siêu tròn' },
];

// ─── Corner Dot Styles ───────────────────────────────────
export const CORNER_DOT_STYLES: { id: CornerDotType | 'none'; label: string }[] = [
  { id: 'none',    label: 'Mặc định' },
  { id: 'square',  label: 'Vuông' },
  { id: 'dot',     label: 'Tròn' },
];

// ─── Style Options ───────────────────────────────────────
export interface QRStyleOptions {
  // Body dots
  dotType: DotType;
  dotColor: string;
  dotGradient?: { type: GradientType; color1: string; color2: string; rotation?: number };

  // Corners
  cornerSquareType: CornerSquareType | 'none';
  cornerSquareColor: string;
  cornerDotType: CornerDotType | 'none';
  cornerDotColor: string;

  // Background
  bgColor: string;
  transparentBg: boolean;
  margin?: number;

  // Logo
  logoDataUrl?: string;
  logoMargin?: number;

  // Frame
  frameId?: string;
}

// ─── Generate Options ────────────────────────────────────
export interface QRGenerateOptions {
  data: string;
  size: number;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  style: QRStyleOptions;
}

// ─── Defaults ────────────────────────────────────────────
export const DEFAULT_QR_STYLE: QRStyleOptions = {
  dotType: 'square',
  dotColor: '#000000',
  cornerSquareType: 'none',
  cornerSquareColor: '#000000',
  cornerDotType: 'none',
  cornerDotColor: '#000000',
  bgColor: '#FFFFFF',
  transparentBg: false,
  margin: 10,
};

export const DEFAULT_QR_OPTIONS: QRGenerateOptions = {
  data: '',
  size: 300,
  errorCorrection: 'M',
  style: { ...DEFAULT_QR_STYLE },
};

// ─── Style Presets ───────────────────────────────────────
export interface QRStylePreset {
  id: string;
  name: string;
  style: Partial<QRStyleOptions>;
}

export const QR_STYLE_PRESETS: QRStylePreset[] = [
  {
    id: 'classic',
    name: 'Classic',
    style: { dotType: 'square', dotColor: '#000000', bgColor: '#FFFFFF', transparentBg: false, cornerSquareType: 'none', cornerDotType: 'none' },
  },
  {
    id: 'rounded',
    name: 'Bo tròn',
    style: { dotType: 'rounded', dotColor: '#1a1a2e', bgColor: '#FFFFFF', cornerSquareType: 'extra-rounded', cornerDotType: 'dot' },
  },
  {
    id: 'dots',
    name: 'Chấm tròn',
    style: { dotType: 'dots', dotColor: '#16213e', bgColor: '#FFFFFF', cornerSquareType: 'dot', cornerDotType: 'dot' },
  },
  {
    id: 'ocean',
    name: 'Đại dương',
    style: {
      dotType: 'rounded', bgColor: '#FFFFFF',
      dotGradient: { type: 'linear', color1: '#0077b6', color2: '#00b4d8', rotation: Math.PI / 4 },
      cornerSquareType: 'extra-rounded', cornerDotType: 'dot',
      cornerSquareColor: '#0077b6', cornerDotColor: '#00b4d8',
    },
  },
  {
    id: 'sunset',
    name: 'Hoàng hôn',
    style: {
      dotType: 'classy-rounded', bgColor: '#FFFFFF',
      dotGradient: { type: 'linear', color1: '#e63946', color2: '#f4a261', rotation: Math.PI / 4 },
      cornerSquareType: 'extra-rounded', cornerDotType: 'dot',
      cornerSquareColor: '#e63946', cornerDotColor: '#f4a261',
    },
  },
  {
    id: 'forest',
    name: 'Rừng xanh',
    style: {
      dotType: 'classy', bgColor: '#FFFFFF',
      dotGradient: { type: 'linear', color1: '#2d6a4f', color2: '#52b788', rotation: Math.PI / 3 },
      cornerSquareType: 'square', cornerDotType: 'square',
      cornerSquareColor: '#2d6a4f', cornerDotColor: '#52b788',
    },
  },
  {
    id: 'galaxy',
    name: 'Tím Galaxy',
    style: {
      dotType: 'extra-rounded', bgColor: '#FFFFFF',
      dotGradient: { type: 'radial', color1: '#7209b7', color2: '#f72585' },
      cornerSquareType: 'dot', cornerDotType: 'dot',
      cornerSquareColor: '#7209b7', cornerDotColor: '#f72585',
    },
  },
  {
    id: 'dark',
    name: 'Dark Mode',
    style: {
      dotType: 'rounded', dotColor: '#e0e0e0', bgColor: '#1a1a1a',
      cornerSquareType: 'extra-rounded', cornerDotType: 'dot',
      cornerSquareColor: '#e0e0e0', cornerDotColor: '#e0e0e0',
    },
  },
];

// ─── Build qr-code-styling options ───────────────────────
function buildStylingOptions(opts: QRGenerateOptions): QRStylingOptions {
  const { style } = opts;

  // Tiếng Việt (và mọi ký tự đa byte): qr-code-styling/qrcode-generator ở byte mode
  // ghi charCodeAt & 0xFF → CẮT CỤT ký tự >255 (vd "ả"→"£", "ư"→"°"). Encode chuỗi
  // Unicode thành "binary string" gồm các byte UTF-8 trước → QR chứa UTF-8 hợp lệ,
  // máy quét đọc đúng (khớp với output backend dùng segno). ASCII giữ nguyên.
  let qrData = opts.data;
  try { qrData = unescape(encodeURIComponent(opts.data)); } catch { /* giữ nguyên */ }

  const qrOpts: QRStylingOptions = {
    width: opts.size,
    height: opts.size,
    data: qrData,
    margin: style.margin ?? 10,
    type: 'canvas',
    qrOptions: {
      errorCorrectionLevel: opts.errorCorrection,
    },
    dotsOptions: {
      type: style.dotType,
      ...(style.dotGradient
        ? {
            gradient: {
              type: style.dotGradient.type,
              rotation: style.dotGradient.rotation || 0,
              colorStops: [
                { offset: 0, color: style.dotGradient.color1 },
                { offset: 1, color: style.dotGradient.color2 },
              ],
            },
          }
        : { color: style.dotColor }),
    },
    backgroundOptions: style.transparentBg
      ? { color: 'transparent' }
      : { color: style.bgColor },
  };

  // Corner squares
  if (style.cornerSquareType && style.cornerSquareType !== 'none') {
    qrOpts.cornersSquareOptions = {
      type: style.cornerSquareType as CornerSquareType,
      color: style.cornerSquareColor || style.dotColor,
    };
  }

  // Corner dots
  if (style.cornerDotType && style.cornerDotType !== 'none') {
    qrOpts.cornersDotOptions = {
      type: style.cornerDotType as CornerDotType,
      color: style.cornerDotColor || style.dotColor,
    };
  }

  // Logo
  if (style.logoDataUrl) {
    qrOpts.image = style.logoDataUrl;
    qrOpts.imageOptions = {
      crossOrigin: 'anonymous',
      margin: style.logoMargin ?? 5,
    };
  }

  return qrOpts;
}

// ─── Create QR instance ──────────────────────────────────
export function createQRInstance(opts: QRGenerateOptions): QRCodeStyling {
  return new QRCodeStyling(buildStylingOptions(opts));
}

// ─── Render to container ─────────────────────────────────
export function renderQRToElement(
  container: HTMLElement,
  opts: QRGenerateOptions
): QRCodeStyling {
  // Clear existing
  container.innerHTML = '';
  const qr = createQRInstance(opts);
  qr.append(container);
  return qr;
}

// ─── Update existing instance ────────────────────────────
export function updateQRInstance(
  qr: QRCodeStyling,
  opts: QRGenerateOptions
): void {
  qr.update(buildStylingOptions(opts));
}

// ─── Download ────────────────────────────────────────────
export async function downloadQR(
  qr: QRCodeStyling,
  filename: string,
  format: 'png' | 'svg' | 'jpeg' | 'webp' = 'png'
): Promise<void> {
  await qr.download({
    name: filename,
    extension: format,
  });
}

// ─── Get raw blob ────────────────────────────────────────
export async function getQRBlob(
  opts: QRGenerateOptions,
  format: 'png' | 'svg' | 'jpeg' | 'webp' = 'png'
): Promise<Blob> {
  const qr = createQRInstance(opts);

  // qr-code-styling getRawData returns Blob | Buffer
  const raw = await qr.getRawData(format);
  if (!raw) throw new Error('Không thể tạo QR code');

  if (raw instanceof Blob) return raw;
  // Node Buffer fallback
  return new Blob([new Uint8Array(raw as any)], { type: `image/${format === 'svg' ? 'svg+xml' : format}` });
}

