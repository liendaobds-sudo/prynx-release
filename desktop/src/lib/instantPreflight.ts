import {
    PDFDocument,
    PDFName,
    PDFDict,
    PDFArray,
    PDFStream,
    PDFRawStream,
    PDFNumber,
} from 'pdf-lib';
import pako from 'pako';

export type PreflightIssueSeverity = 'error' | 'warning' | 'info';

export type PreflightIssueType =
    | 'rich_black'
    | 'hairline'
    | 'low_res_image'
    | 'rgb_color'
    | 'spot_color'
    | 'overprint';

export interface InstantPreflightIssue {
    type: PreflightIssueType;
    severity: PreflightIssueSeverity;
    title: string;
    description: string;
    page: number;
    metric?: string;
}

export interface InstantPreflightSummary {
    colorMode: 'CMYK' | 'RGB' | 'Mixed' | 'K-Only' | 'Spot';
    hasRgb: boolean;
    spotColors: string[];
    hairlineCount: number;
    minHairlineWidthPt: number | null;
    richBlackCount: number;
    lowResImageCount: number;
    minImageDpi: number | null;
    hasOverprint: boolean;
    totalImagesChecked: number;
}

export interface InstantPreflightResult {
    hasErrors: boolean;
    hasWarnings: boolean;
    issues: InstantPreflightIssue[];
    summary: InstantPreflightSummary;
    scanDurationMs: number;
    scannedPages: number[];
}

export interface InstantPreflightOptions {
    maxPages?: number;
    targetPages?: number[]; // 1-indexed
    dpiThreshold?: number; // mặc định 150 DPI
    hairlineThresholdPt?: number; // mặc định 0.10 pt
}

/**
 * Giải nén nội dung content stream của trang PDF
 */
function decodeContentStream(stream: PDFStream | PDFRawStream): string {
    try {
        const rawBytes = stream.getContents();
        if (!rawBytes || rawBytes.length === 0) return '';

        const filter = stream.dict.lookup(PDFName.of('Filter'));
        let isFlate = false;
        if (filter instanceof PDFName && filter.asString() === '/FlateDecode') {
            isFlate = true;
        } else if (filter instanceof PDFArray) {
            isFlate = filter.asArray().some(f => f instanceof PDFName && f.asString() === '/FlateDecode');
        }

        if (isFlate) {
            try {
                const decompressed = pako.inflate(rawBytes);
                return new TextDecoder('latin1').decode(decompressed);
            } catch {
                // Nếu pako inflate thất bại, thử decode thô
                return new TextDecoder('latin1').decode(rawBytes);
            }
        }
        return new TextDecoder('latin1').decode(rawBytes);
    } catch {
        return '';
    }
}

/**
 * Quét nhanh và tức thì các lỗi chế bản thường gặp khi người dùng lưu file:
 * 1. Nét mảnh Hairline (< 0.1pt hoặc = 0)
 * 2. Chữ đen 4 màu (Rich Black text: CMY > 15% khi K >= 85%)
 * 3. Màu RGB trong vector / text / ảnh
 * 4. Ảnh độ phân giải thấp (< 150 DPI)
 * 5. Kênh màu pha Spot Color (Khuôn bế, DieCut, Pantone...)
 */
export async function runInstantPreflight(
    pdfBytes: Uint8Array | ArrayBuffer,
    options?: InstantPreflightOptions,
): Promise<InstantPreflightResult> {
    const startTime = performance.now();
    const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);

    const issues: InstantPreflightIssue[] = [];
    const spotColorsSet = new Set<string>();

    let hairlineCount = 0;
    let minHairlineWidthPt: number | null = null;
    let richBlackCount = 0;
    let lowResImageCount = 0;
    let minImageDpi: number | null = null;
    let hasRgbInDoc = false;
    let hasCmykInDoc = false;
    let hasOverprint = false;
    let totalImagesChecked = 0;

    const dpiThreshold = options?.dpiThreshold ?? 150;
    const hairlineThreshold = options?.hairlineThresholdPt ?? 0.10;

    let doc: PDFDocument;
    try {
        doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    } catch {
        return {
            hasErrors: true,
            hasWarnings: false,
            issues: [{
                type: 'rgb_color',
                severity: 'error',
                title: 'Không thể đọc cấu trúc PDF',
                description: 'Tệp PDF bị hỏng hoặc chưa hoàn tất quá trình ghi đĩa từ ứng dụng ngoài.',
                page: 1,
            }],
            summary: {
                colorMode: 'Mixed',
                hasRgb: false,
                spotColors: [],
                hairlineCount: 0,
                minHairlineWidthPt: null,
                richBlackCount: 0,
                lowResImageCount: 0,
                minImageDpi: null,
                hasOverprint: false,
                totalImagesChecked: 0,
            },
            scanDurationMs: performance.now() - startTime,
            scannedPages: [],
        };
    }

    const pages = doc.getPages();
    const totalPages = pages.length;

    // Chọn danh sách trang cần quét (tối ưu hiệu năng)
    let pagesToScan: number[] = [];
    if (options?.targetPages && options.targetPages.length > 0) {
        pagesToScan = options.targetPages.filter(p => p >= 1 && p <= totalPages);
    } else {
        const maxPages = options?.maxPages ?? Math.min(totalPages, 20);
        pagesToScan = Array.from({ length: maxPages }, (_, i) => i + 1);
    }

    for (const pageNum of pagesToScan) {
        const page = pages[pageNum - 1];
        if (!page) continue;

        const resources = page.node.Resources();

        // ── 1. Quét ColorSpace trong Resources ──
        if (resources) {
            const csDict = resources.lookupMaybe(PDFName.of('ColorSpace'), PDFDict);
            if (csDict) {
                for (const [key, val] of csDict.entries()) {
                    const csName = key.asString().replace(/^\//, '');
                    const csObj = page.node.context.lookup(val);

                    if (csObj instanceof PDFArray) {
                        const csType = csObj.get(0);
                        if (csType instanceof PDFName && csType.asString() === '/Separation') {
                            const spotNameObj = csObj.get(1);
                            if (spotNameObj instanceof PDFName) {
                                const rawName = spotNameObj.asString().replace(/^\//, '');
                                spotColorsSet.add(rawName);
                            }
                        } else if (csType instanceof PDFName && csType.asString() === '/DeviceRGB') {
                            hasRgbInDoc = true;
                        } else if (csType instanceof PDFName && csType.asString() === '/DeviceCMYK') {
                            hasCmykInDoc = true;
                        }
                    } else if (csObj instanceof PDFName) {
                        const nameStr = csObj.asString();
                        if (nameStr === '/DeviceRGB') hasRgbInDoc = true;
                        if (nameStr === '/DeviceCMYK') hasCmykInDoc = true;
                    }
                }
            }
        }

        // ── 2. Thu thập danh sách Image XObjects của trang ──
        const imageMetadataMap = new Map<string, { width: number; height: number; isRgb: boolean }>();
        if (resources) {
            const xObjDict = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
            if (xObjDict) {
                for (const [key, val] of xObjDict.entries()) {
                    const xObjName = key.asString().replace(/^\//, '');
                    const xObj = page.node.context.lookup(val);
                    if (xObj instanceof PDFStream || xObj instanceof PDFRawStream) {
                        const subtype = xObj.dict.lookup(PDFName.of('Subtype'));
                        if (subtype instanceof PDFName && subtype.asString() === '/Image') {
                            totalImagesChecked++;
                            const w = xObj.dict.lookup(PDFName.of('Width'), PDFNumber)?.asNumber() ?? 0;
                            const h = xObj.dict.lookup(PDFName.of('Height'), PDFNumber)?.asNumber() ?? 0;
                            const cs = xObj.dict.lookup(PDFName.of('ColorSpace'));
                            let isRgb = false;
                            if (cs instanceof PDFName && cs.asString() === '/DeviceRGB') {
                                isRgb = true;
                                hasRgbInDoc = true;
                            }
                            if (w > 0 && h > 0) {
                                imageMetadataMap.set(xObjName, { width: w, height: h, isRgb });
                            }
                        }
                    }
                }
            }
        }

        // ── 3. Quét Content Streams ──
        const contentsObj = page.node.Contents();
        const contentStreams: (PDFStream | PDFRawStream)[] = [];
        if (contentsObj instanceof PDFStream || contentsObj instanceof PDFRawStream) {
            contentStreams.push(contentsObj);
        } else if (contentsObj instanceof PDFArray) {
            for (const item of contentsObj.asArray()) {
                const resolved = page.node.context.lookup(item);
                if (resolved instanceof PDFStream || resolved instanceof PDFRawStream) {
                    contentStreams.push(resolved);
                }
            }
        }

        let combinedStreamText = '';
        for (const stream of contentStreams) {
            combinedStreamText += '\n' + decodeContentStream(stream);
        }

        if (!combinedStreamText.trim()) continue;

        // Quét Overprint trong content stream
        if (/\/(?:OP|op)\s+true\b/.test(combinedStreamText) || /\/OPM\s+1\b/.test(combinedStreamText)) {
            hasOverprint = true;
        }

        // A. Quét Hairlines: ([0-9.]+) w
        const hairlineRegex = /(?:^|[\s\r\n])([0-9.]+)\s+w(?:\b|[\s\r\n])/g;
        let hlMatch: RegExpExecArray | null;
        let pageHairlineCount = 0;
        let pageMinHairline = 999;

        while ((hlMatch = hairlineRegex.exec(combinedStreamText)) !== null) {
            const width = parseFloat(hlMatch[1]);
            if (!isNaN(width) && width <= hairlineThreshold) {
                hairlineCount++;
                pageHairlineCount++;
                if (width < pageMinHairline) pageMinHairline = width;
                if (minHairlineWidthPt === null || width < minHairlineWidthPt) {
                    minHairlineWidthPt = width;
                }
            }
        }

        if (pageHairlineCount > 0) {
            issues.push({
                type: 'hairline',
                severity: 'warning',
                title: 'Nét vẽ mảnh (Hairline)',
                description: `Phát hiện ${pageHairlineCount} nét mảnh ≤ ${hairlineThreshold} pt (nét nhỏ nhất: ${pageMinHairline === 0 ? '0 (hairline)' : pageMinHairline.toFixed(3) + ' pt'}). Nguy cơ mất nét khi ghi kẽm.`,
                page: pageNum,
                metric: `${pageMinHairline.toFixed(2)} pt`,
            });
        }

        // B. Quét RGB Color trong stream:
        // Cú pháp: r g b rg (fill) hoặc r g b RG (stroke)
        const rgbRegex = /(?:^|[\s\r\n])([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+(rg|RG)(?:\b|[\s\r\n])/g;
        let rgbMatch: RegExpExecArray | null;
        let pageRgbCount = 0;

        while ((rgbMatch = rgbRegex.exec(combinedStreamText)) !== null) {
            const r = parseFloat(rgbMatch[1]);
            const g = parseFloat(rgbMatch[2]);
            const b = parseFloat(rgbMatch[3]);
            // Loại trừ màu đơn sắc Grayscale x=y=z (ví dụ 0 0 0 hoặc 1 1 1)
            const isNeutralGray = Math.abs(r - g) < 0.01 && Math.abs(g - b) < 0.01;
            if (!isNeutralGray) {
                hasRgbInDoc = true;
                pageRgbCount++;
            }
        }

        if (pageRgbCount > 0) {
            issues.push({
                type: 'rgb_color',
                severity: 'warning',
                title: 'Hệ màu RGB phát hiện',
                description: `Trang chứa ${pageRgbCount} đối tượng dùng màu RGB. Có thể bị biến đổi màu khi in offset CMYK.`,
                page: pageNum,
            });
        }

        // C. Quét Rich Black Text:
        // Duyệt dòng lệnh để bắt đúng trạng thái CMYK fill khi vẽ Text (BT ... ET)
        let curC = 0, curM = 0, curY = 0, curK = 0;
        let inText = false;
        let pageRichBlackCount = 0;

        // Tách tokens nhanh theo whitespace
        const tokens = combinedStreamText.trim().split(/\s+/);
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];

            if (tok === 'k' && i >= 4) {
                const c = parseFloat(tokens[i - 4]);
                const m = parseFloat(tokens[i - 3]);
                const y = parseFloat(tokens[i - 2]);
                const k = parseFloat(tokens[i - 1]);
                if (!isNaN(c) && !isNaN(m) && !isNaN(y) && !isNaN(k)) {
                    curC = c; curM = m; curY = y; curK = k;
                    if (c > 0 || m > 0 || y > 0 || k > 0) hasCmykInDoc = true;
                }
            } else if (tok === 'BT') {
                inText = true;
            } else if (tok === 'ET') {
                inText = false;
            } else if (inText && (tok === 'Tj' || tok === 'TJ' || tok === "'" || tok === '"')) {
                // Kiểm tra xem chữ có đang dùng Rich Black không
                // Điều kiện: K >= 0.85 và tổng C+M+Y > 0.15
                const cmySum = curC + curM + curY;
                if (curK >= 0.85 && cmySum >= 0.15) {
                    richBlackCount++;
                    pageRichBlackCount++;
                }
            }
        }

        if (pageRichBlackCount > 0) {
            issues.push({
                type: 'rich_black',
                severity: 'warning',
                title: 'Chữ đen 4 màu (Rich Black)',
                description: `Phát hiện ${pageRichBlackCount} cụm chữ dùng màu phối C+M+Y+K (Đen 4 màu) thay vì 100% K. Dễ gây lé chữ, bóng mờ khi in chồng màu offset.`,
                page: pageNum,
            });
        }

        // D. Quét Image DPI:
        // Cú pháp: a b c d e f cm ... /ImName Do
        const doRegex = /(?:([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+cm\s+)?\/([a-zA-Z0-9_.-]+)\s+Do\b/g;
        let doMatch: RegExpExecArray | null;

        while ((doMatch = doRegex.exec(combinedStreamText)) !== null) {
            const imageName = doMatch[7];
            const meta = imageMetadataMap.get(imageName);
            if (!meta) continue;

            let placedW_pt = 0;
            let placedH_pt = 0;

            if (doMatch[1] && doMatch[2] && doMatch[3] && doMatch[4]) {
                const a = parseFloat(doMatch[1]);
                const b = parseFloat(doMatch[2]);
                const c = parseFloat(doMatch[3]);
                const d = parseFloat(doMatch[4]);
                placedW_pt = Math.hypot(a, b);
                placedH_pt = Math.hypot(c, d);
            }

            if (placedW_pt > 1 && placedH_pt > 1) {
                const dpiX = meta.width / (placedW_pt / 72);
                const dpiY = meta.height / (placedH_pt / 72);
                const effectiveDpi = Math.round(Math.min(dpiX, dpiY));

                if (minImageDpi === null || effectiveDpi < minImageDpi) {
                    minImageDpi = effectiveDpi;
                }

                if (effectiveDpi < dpiThreshold) {
                    lowResImageCount++;
                    issues.push({
                        type: 'low_res_image',
                        severity: effectiveDpi < 100 ? 'error' : 'warning',
                        title: 'Ảnh độ phân giải thấp (Low-res)',
                        description: `Ảnh /${imageName} có độ phân giải hiệu dụng ${effectiveDpi} DPI (dưới ngưỡng ${dpiThreshold} DPI). Nguy cơ vỡ hạt, mờ khi in.`,
                        page: pageNum,
                        metric: `${effectiveDpi} DPI`,
                    });
                }
            }
        }
    }

    // Spot Colors summary issue (info)
    const spotColors = Array.from(spotColorsSet);
    if (spotColors.length > 0) {
        issues.push({
            type: 'spot_color',
            severity: 'info',
            title: 'Kênh màu pha (Spot Color)',
            description: `Tài liệu chứa ${spotColors.length} kênh màu Spot: ${spotColors.join(', ')}.`,
            page: 1,
            metric: spotColors.join(', '),
        });
    }

    // Xác định Color Mode chung
    let colorMode: InstantPreflightSummary['colorMode'] = 'CMYK';
    if (hasRgbInDoc && hasCmykInDoc) {
        colorMode = 'Mixed';
    } else if (hasRgbInDoc) {
        colorMode = 'RGB';
    } else if (spotColors.length > 0 && !hasCmykInDoc) {
        colorMode = 'Spot';
    } else if (hasCmykInDoc) {
        colorMode = 'CMYK';
    }

    const hasErrors = issues.some(i => i.severity === 'error');
    const hasWarnings = issues.some(i => i.severity === 'warning');

    return {
        hasErrors,
        hasWarnings,
        issues,
        summary: {
            colorMode,
            hasRgb: hasRgbInDoc,
            spotColors,
            hairlineCount,
            minHairlineWidthPt,
            richBlackCount,
            lowResImageCount,
            minImageDpi,
            hasOverprint,
            totalImagesChecked,
        },
        scanDurationMs: Math.round(performance.now() - startTime),
        scannedPages: pagesToScan,
    };
}
