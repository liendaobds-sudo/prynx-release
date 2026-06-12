// @ts-nocheck
// src/engine/barcode/qrWorker.ts
import QRCodeLib from 'qrcode';
import JSZip from 'jszip';

self.onmessage = async (e: MessageEvent) => {
  const { items, format, size, style } = e.data;

  try {
    const zip = new JSZip();

    const qrOptions: QRCodeLib.QRCodeToDataURLOptions = {
        errorCorrectionLevel: 'M',
        width: size,
        margin: 2,
        color: {
          dark: style.dotColor || '#000000',
          light: style.bgColor || '#ffffff',
        },
    };

    const svgOptions: QRCodeLib.QRCodeToStringOptions = {
        errorCorrectionLevel: 'M',
        width: size,
        margin: 2,
        color: {
          dark: style.dotColor || '#000000',
          light: style.bgColor || '#ffffff',
        },
        type: 'svg',
    };

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.content) continue;

        try {
            if (format === 'svg') {
                const svgStr = await QRCodeLib.toString(item.content, svgOptions);
                zip.file(`${item.filename}.svg`, svgStr);
            } else {
                // FALLBACK TO OFFSCREEN CANVAS FOR THE PNG RENDERER
                // QRCodeLib.toDataURL internally calls document.createElement('canvas'), which crashes in Workers.
                // By providing our own OffscreenCanvas, it bypasses the need for the DOM.
                if (typeof OffscreenCanvas !== 'undefined') {
                    // Create an offscreen canvas. The dimensions will be auto-resized by QRCodeLib.toCanvas
                    const canvas = new OffscreenCanvas(size, size);
                    await QRCodeLib.toCanvas(canvas as any, item.content, qrOptions);
                    const blob = await canvas.convertToBlob({ type: 'image/png' });
                    zip.file(`${item.filename}.png`, blob);
                } else {
                    // Fallback if browser doesn't somehow support OffscreenCanvas (Safari < 16.4)
                    // We must generate SVG, unfortunately, to avoid breaking entirely.
                    const svgStr = await QRCodeLib.toString(item.content, svgOptions);
                    zip.file(`${item.filename}.svg`, svgStr);
                }
            }
        } catch (err) {
            console.error(`QR Worker Render Error item ${i}`, err);
        }

        // Emit progress every 100 items to avoid flooding postMessage overhead
        if (i % 100 === 0 || i === items.length - 1) {
            self.postMessage({ type: 'progress', progress: i + 1, statusText: 'Đang tạo hình...' });
            await new Promise(r => setTimeout(r, 0)); 
        }
    }

    self.postMessage({ type: 'progress', progress: items.length, statusText: 'Đang nén ZIP...' });

    // Cực kỳ quan trọng: Nén STORE cho nhanh vì hình ảnh không nén thêm được nữa bằng thuật toán ZIP
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
        if (meta.percent % 10 === 0) {
           self.postMessage({ type: 'progress', progress: items.length + (meta.percent / 100), statusText: `Nén ZIP ${meta.percent.toFixed(0)}%` });
        }
    });

    self.postMessage({ type: 'done', payload: zipBlob, totalItems: items.length });

  } catch (error: any) {
    self.postMessage({ type: 'error', message: error.message || 'Worker Internal Error' });
  }
};
