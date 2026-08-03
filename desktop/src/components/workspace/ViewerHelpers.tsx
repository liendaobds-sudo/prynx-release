import { useState, useEffect } from 'react';
import { getQRBlob, DEFAULT_QR_STYLE } from '@/engine/barcode/qrEngine';
import { generateBarcodeDataURL } from '@/engine/barcode/barcodeEngine';
import { useTranslation } from 'react-i18next';

/**
 * VdpPreviewImage — Renders a live preview of a VDP field (QR code or barcode).
 * Generates a data URL asynchronously and displays it as an image.
 */
export const VdpPreviewImage = ({ field }: { field: any }) => {
  const { t } = useTranslation();
    const [dataUrl, setDataUrl] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;
        const generate = async () => {
            try {
                if (field.type === 'qrcode') {
                    // Lề trắng vẽ bằng container (padding) → sinh ảnh QR không margin, nền trong suốt.
                    const style = { ...(field.qrStyle || DEFAULT_QR_STYLE), margin: 0, transparentBg: true };
                    const blob = await getQRBlob({
                        data: "https://www.printsolutions.vn/",
                        size: 400,
                        errorCorrection: field.errorCorrection || 'M',
                        style
                    }, 'png');
                    const url = await new Promise<string>((resolve) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.readAsDataURL(blob);
                    });
                    if (isMounted) setDataUrl(url);
                } else if (field.type === 'barcode') {
                    const barcodeType = field.barcodeType || 'code128';
                    // Sample data appropriate for each barcode type
                    const sampleData: Record<string, string> = {
                        code128: 'SAMPLE-12345',
                        ean13: '4006381333931',
                        upca: '012345678905',
                        ean8: '96385074',
                        code39: 'SAMPLE39',
                        itf14: '10012345000017',
                        codabar: 'A12345B',
                    };
                    const url = await generateBarcodeDataURL({
                        type: barcodeType,
                        data: sampleData[barcodeType] || 'SAMPLE-12345',
                        scale: 3,
                        height: field.barHeight || 12,
                        barColor: field.barColor || '#000000',
                        // Lề trắng + nền vẽ bằng container → sinh mã không margin, nền trong suốt.
                        transparentBg: true,
                        showText: field.showText !== false,
                        quietZone: 0,
                        rotation: field.rotation || 0,
                        fontSize: field.fontSize || 10,
                        textAlign: field.textAlign || 'center'
                    }, 'png');
                    if (isMounted) setDataUrl(url);
                }
            } catch (e) {
                console.error(t('misc.viewerHelpers:loi_preview_vdp'), e);
            }
        };
        generate();
        return () => { isMounted = false; };
        // CHỈ regen ảnh khi thuộc tính NỘI DUNG đổi — KHÔNG phụ thuộc x/y/width/height.
        // Nếu phụ thuộc cả `field` thì mỗi lần kéo/di chuyển/resize sẽ render lại QR/
        // barcode từng pixel → giật nặng. Kích thước khung do CSS lo (object-fit + padding).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        field.type, field.errorCorrection, field.qrStyle,
        field.barcodeType, field.barHeight, field.barColor,
        field.bgColor, field.transparentBg, field.showText,
        field.quietZone, field.rotation, field.fontSize, field.textAlign,
    ]);

    if (!dataUrl) {
        return (
            <div className="w-full h-full flex items-center justify-center bg-slate-100 text-slate-400 text-[10px]">
                {t('misc.viewerHelpers:dang_tai')}
            </div>
        );
    }

    // Lề trắng (quiet zone): vẽ bằng padding theo % kích thước khung (không phụ thuộc zoom),
    // khớp chính xác backend (inset theo mm "Lề trắng").
    const qz = field.quietZone ?? 2;
    const padX = field.width ? Math.min(49, (qz / field.width) * 100) : 0;
    const padY = field.height ? Math.min(49, (qz / field.height) * 100) : 0;
    const transparent = field.type === 'qrcode'
        ? (field.qrStyle?.transparentBg ?? false)
        : (field.transparentBg ?? false);
    const bg = field.type === 'qrcode'
        ? (field.qrStyle?.bgColor || '#FFFFFF')
        : (field.bgColor || '#FFFFFF');

    // Barcode: lấp đầy vùng trong (stretch) như backend. QR: scale đều + canh giữa.
    const fitClass = field.type === 'barcode' ? 'object-fill' : 'object-contain';
    return (
        <div
            className="w-full h-full"
            style={{
                background: transparent ? 'transparent' : bg,
                padding: `${padY}% ${padX}%`,
                boxSizing: 'border-box',
            }}
        >
            <img src={dataUrl} alt="VDP Preview" className={`w-full h-full ${fitClass} pointer-events-none`} />
        </div>
    );
};
