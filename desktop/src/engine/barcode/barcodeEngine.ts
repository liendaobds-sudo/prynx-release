// @ts-nocheck
import bwipjs from 'bwip-js';

// ─── Barcode Types ───────────────────────────────────────
export type BarcodeType =
  | 'ean13'
  | 'upca'
  | 'ean8'
  | 'upce'
  | 'code128'
  | 'code39'
  | 'itf14'
  | 'codabar'
  | 'pharmacode';

export interface BarcodeTypeInfo {
  id: BarcodeType;
  label: string;
  description: string;
  exampleData: string;
  validator: (data: string) => ValidationResult;
}

export interface BarcodeOptions {
  type: BarcodeType;
  data: string;
  width?: number;       // mm
  height?: number;      // mm
  scale?: number;
  barColor?: string;    // hex
  bgColor?: string;     // hex
  transparentBg?: boolean;
  showText?: boolean;
  fontSize?: number;
  textAlign?: 'center' | 'left' | 'right';
  quietZone?: number;   // mm
  rotation?: number;    // degrees (0, 90, 180, 270)
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  correctedData?: string;
}

// ─── Barcode Type Registry ───────────────────────────────
export const BARCODE_TYPES: BarcodeTypeInfo[] = [
  {
    id: 'ean13',
    label: 'EAN-13',
    description: 'Mã vạch bán lẻ quốc tế (13 chữ số)',
    exampleData: '4006381333931',
    validator: validateEAN13,
  },
  {
    id: 'upca',
    label: 'UPC-A',
    description: 'Mã vạch bán lẻ Mỹ/Canada (12 chữ số)',
    exampleData: '012345678905',
    validator: validateUPCA,
  },
  {
    id: 'ean8',
    label: 'EAN-8',
    description: 'Mã vạch nhỏ gọn (8 chữ số)',
    exampleData: '96385074',
    validator: validateEAN8,
  },
  {
    id: 'code128',
    label: 'Code 128',
    description: 'Mã vạch đa năng, hỗ trợ ký tự & số',
    exampleData: 'PrintSolutions-001',
    validator: validateCode128,
  },
  {
    id: 'code39',
    label: 'Code 39',
    description: 'Mã vạch công nghiệp, chữ in hoa & số',
    exampleData: 'PRINT2025',
    validator: validateCode39,
  },
  {
    id: 'itf14',
    label: 'ITF-14',
    description: 'Mã vạch thùng carton (14 chữ số)',
    exampleData: '04006381333935',
    validator: validateITF14,
  },
  {
    id: 'codabar',
    label: 'Codabar',
    description: 'Thư viện, ngân hàng máu, chuyển phát',
    exampleData: 'A12345B',
    validator: validateCodabar,
  },
];

// ─── Validation Functions ────────────────────────────────

function digitsOnly(data: string, len: number): ValidationResult {
  const cleaned = data.replace(/\s/g, '');
  if (!/^\d+$/.test(cleaned)) {
    return { valid: false, error: 'Chỉ được nhập số' };
  }
  if (cleaned.length !== len && cleaned.length !== len - 1) {
    return { valid: false, error: `Cần ${len} chữ số (hoặc ${len - 1} để tự tính check digit)` };
  }
  if (cleaned.length === len - 1) {
    const check = calculateCheckDigitEAN(cleaned, len);
    return { valid: true, correctedData: cleaned + check };
  }
  // Verify check digit
  const check = calculateCheckDigitEAN(cleaned.slice(0, -1), len);
  if (String(check) !== cleaned.slice(-1)) {
    return { valid: false, error: `Check digit sai. Đúng phải là: ${cleaned.slice(0, -1)}${check}` };
  }
  return { valid: true, correctedData: cleaned };
}

function validateEAN13(data: string): ValidationResult {
  return digitsOnly(data, 13);
}

function validateUPCA(data: string): ValidationResult {
  return digitsOnly(data, 12);
}

function validateEAN8(data: string): ValidationResult {
  return digitsOnly(data, 8);
}

function validateITF14(data: string): ValidationResult {
  return digitsOnly(data, 14);
}

function validateCode128(data: string): ValidationResult {
  if (!data || data.length === 0) {
    return { valid: false, error: 'Vui lòng nhập dữ liệu' };
  }
  if (data.length > 80) {
    return { valid: false, error: 'Tối đa 80 ký tự' };
  }
  return { valid: true, correctedData: data };
}

function validateCode39(data: string): ValidationResult {
  if (!data || data.length === 0) {
    return { valid: false, error: 'Vui lòng nhập dữ liệu' };
  }
  const upper = data.toUpperCase();
  if (!/^[A-Z0-9\-\.\s\$\/\+\%]+$/.test(upper)) {
    return { valid: false, error: 'Chỉ hỗ trợ: A-Z, 0-9, - . $ / + % SPACE' };
  }
  return { valid: true, correctedData: upper };
}

function validateCodabar(data: string): ValidationResult {
  if (!data || data.length === 0) {
    return { valid: false, error: 'Vui lòng nhập dữ liệu' };
  }
  const upper = data.toUpperCase();
  if (!/^[ABCD][0-9\-\$\:\/\.\+]+[ABCD]$/.test(upper)) {
    return { valid: false, error: 'Phải bắt đầu/kết thúc bằng A/B/C/D, giữa là: 0-9 - $ : / . +' };
  }
  return { valid: true, correctedData: upper };
}

// ─── Check Digit Calculation ─────────────────────────────
export function calculateCheckDigitEAN(data: string, totalLen: number): number {
  let sum = 0;
  const digits = data.split('').map(Number);
  // EAN/UPC check digit uses alternating weights 1,3
  for (let i = 0; i < digits.length; i++) {
    const weight = (totalLen === 12) // UPC-A uses 3,1,3,1...
      ? (i % 2 === 0 ? 3 : 1)
      : (i % 2 === 0 ? 1 : 3);
    sum += digits[i] * weight;
  }
  return (10 - (sum % 10)) % 10;
}

// ─── Map internal type to bwip-js encoder ────────────────
function getBwipEncoder(type: BarcodeType): string {
  const map: Record<BarcodeType, string> = {
    ean13: 'ean13',
    upca: 'upca',
    ean8: 'ean8',
    upce: 'upce',
    code128: 'code128',
    code39: 'code39',
    itf14: 'itf14',
    codabar: 'rationalizedCodabar',
    pharmacode: 'pharmacode',
  };
  return map[type] || 'code128';
}

// ─── Generate Barcode to Canvas ──────────────────────────
export async function generateBarcodeToCanvas(
  canvas: HTMLCanvasElement,
  options: BarcodeOptions
): Promise<void> {
  const typeInfo = BARCODE_TYPES.find(t => t.id === options.type);
  if (typeInfo) {
    const validation = typeInfo.validator(options.data);
    if (!validation.valid) {
      throw new Error(validation.error || 'Dữ liệu không hợp lệ');
    }
    if (validation.correctedData) {
      options = { ...options, data: validation.correctedData };
    }
  }

  try {
    const isEAN = ['ean13', 'ean8', 'upca', 'upce'].includes(options.type);

    // Convert quietZone from mm to points (bwip-js uses points: 1mm = 72/25.4 pts)
    const qzPts = Math.round((options.quietZone ?? 2) * 72 / 25.4);

    const bwipOpts: Record<string, any> = {
      bcid: getBwipEncoder(options.type),
      text: options.data,
      scale: options.scale || 3,
      height: options.height || 12,
      includetext: options.showText !== false,
      barcolor: (options.barColor || '#000000').replace('#', ''),
      paddingwidth: qzPts,
      paddingheight: qzPts,
    };
    
    if (!options.transparentBg) {
      bwipOpts.backgroundcolor = (options.bgColor || '#FFFFFF').replace('#', '');
    }
    
    if (!isEAN) {
      bwipOpts.textxalign = options.textAlign || 'center';
      if (options.fontSize) bwipOpts.textsize = options.fontSize;
    }
    if (options.rotation === 90) bwipOpts.rotate = 'R';
    else if (options.rotation === 180) bwipOpts.rotate = 'I';
    else if (options.rotation === 270) bwipOpts.rotate = 'L';
    else bwipOpts.rotate = 'N';
    if (options.width != null) bwipOpts.width = options.width;

    bwipjs.toCanvas(canvas, bwipOpts as any);
  } catch (e: any) {
    throw new Error(`Lỗi tạo mã vạch: ${e.message || e}`);
  }
}

// ─── Generate Barcode as Data URL ────────────────────────
export async function generateBarcodeDataURL(
  options: BarcodeOptions,
  format: 'png' | 'svg' = 'png'
): Promise<string> {
  if (format === 'svg') {
    return generateBarcodeSVG(options);
  }
  const canvas = document.createElement('canvas');
  await generateBarcodeToCanvas(canvas, options);
  return canvas.toDataURL('image/png');
}

// ─── Generate Barcode as SVG string ──────────────────────
export function generateBarcodeSVG(options: BarcodeOptions): string {
  const typeInfo = BARCODE_TYPES.find(t => t.id === options.type);
  if (typeInfo) {
    const validation = typeInfo.validator(options.data);
    if (!validation.valid) {
      throw new Error(validation.error || 'Dữ liệu không hợp lệ');
    }
    if (validation.correctedData) {
      options = { ...options, data: validation.correctedData };
    }
  }

  const isEAN = ['ean13', 'ean8', 'upca', 'upce'].includes(options.type);

  // Convert quietZone from mm to points (bwip-js uses points: 1mm = 72/25.4 pts)
  const qzPts = Math.round((options.quietZone ?? 2) * 72 / 25.4);

  const bwipOpts: Record<string, any> = {
    bcid: getBwipEncoder(options.type),
    text: options.data,
    scale: options.scale || 3,
    height: options.height || 12,
    includetext: options.showText !== false,
    barcolor: (options.barColor || '#000000').replace('#', ''),
    paddingwidth: qzPts,
    paddingheight: qzPts,
  };
  
  if (!options.transparentBg) {
    bwipOpts.backgroundcolor = (options.bgColor || '#FFFFFF').replace('#', '');
  }
  
  if (!isEAN) {
    bwipOpts.textxalign = options.textAlign || 'center';
    if (options.fontSize) bwipOpts.textsize = options.fontSize;
  }
  if (options.rotation === 90) bwipOpts.rotate = 'R';
  else if (options.rotation === 180) bwipOpts.rotate = 'I';
  else if (options.rotation === 270) bwipOpts.rotate = 'L';
  else bwipOpts.rotate = 'N';
  if (options.width != null) bwipOpts.width = options.width;

  return bwipjs.toSVG(bwipOpts as any);
}

// ─── canvas → Blob utility ───────────────────────────────
export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
      type,
      1.0
    );
  });
}
