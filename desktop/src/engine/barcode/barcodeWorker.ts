// @ts-nocheck
// src/engine/barcode/barcodeWorker.ts
import bwipjs from 'bwip-js';
import JSZip from 'jszip';
import { BARCODE_TYPES, BarcodeOptions } from './barcodeEngine';

// Mapping function exactly as defined in barcodeEngine.ts
function getBwipEncoder(type: string): string {
  const map: Record<string, string> = {
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

function toPxWorker(val: number, unit: string): number {
  if (unit === 'px') return val;
  if (unit === 'mm') return val / 25.4 * 96;
  if (unit === 'cm') return val * 10 / 25.4 * 96;
  if (unit === 'inch') return val * 96;
  return val;
}

self.onmessage = async (e: MessageEvent) => {
  const { items, format, options } = e.data;
  
  try {
    const zip = new JSZip();
    
    // We get the type info here manually to run validation natively in Worker
    const typeInfo = BARCODE_TYPES.find((t: any) => t.id === options.type);
    
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item.content) continue;

        try {
            const itemOpts = { ...options, data: item.content };
            
            if (typeInfo) {
              const validation = typeInfo.validator(item.content);
              if (!validation.valid) {
                 throw new Error(validation.error || 'Dữ liệu không hợp lệ');
              }
              if (validation.correctedData) {
                 itemOpts.data = validation.correctedData;
              }
            }
            
            const bwipOpts: Record<string, any> = {
              bcid: getBwipEncoder(itemOpts.type),
              text: itemOpts.data,
              scale: itemOpts.scale || 3,
              height: itemOpts.height || 12,
              includetext: itemOpts.showText !== false,
              textxalign: itemOpts.textAlign || 'center',
              textsize: itemOpts.fontSize || 10,
              barcolor: (itemOpts.barColor || '#000000').replace('#', ''),
              backgroundcolor: (itemOpts.bgColor || '#FFFFFF').replace('#', ''),
              paddingwidth: itemOpts.quietZone || 2,
              paddingheight: 2,
            };
            if (itemOpts.width != null) bwipOpts.width = itemOpts.width;
            
            if (format === 'svg') {
                let svgStr = bwipjs.toSVG(bwipOpts as any);
                if (e.data.useExactWidth && e.data.widthInput) {
                    const exactWidthPx = Math.round(toPxWorker(Number(e.data.widthInput), e.data.widthUnit));
                    svgStr = svgStr.replace(/width="[^"]+"/, `width="${exactWidthPx}px" preserveAspectRatio="none"`);
                }
                zip.file(`${item.filename}.svg`, svgStr);
            } else {
                if (typeof OffscreenCanvas !== 'undefined') {
                    // Start with an arbitrary size, bwip-js will auto-resize it based on parameters
                    const canvas = new OffscreenCanvas(1, 1);
                    bwipjs.toCanvas(canvas as any, bwipOpts as any);
                    let targetCanvas = canvas;
                    
                    if (e.data.useExactWidth && e.data.widthInput) {
                        const exactWidthPx = Math.round(toPxWorker(Number(e.data.widthInput), e.data.widthUnit));
                        const dest = new OffscreenCanvas(exactWidthPx, targetCanvas.height);
                        const ctx = dest.getContext('2d') as OffscreenCanvasRenderingContext2D;
                        ctx.imageSmoothingEnabled = false;
                        ctx.drawImage(targetCanvas, 0, 0, exactWidthPx, targetCanvas.height);
                        targetCanvas = dest;
                    }
                    
                    if (e.data.rotation && (e.data.rotation === 90 || e.data.rotation === 180 || e.data.rotation === 270)) {
                        const r = e.data.rotation;
                        const rotated = new OffscreenCanvas(
                            r === 90 || r === 270 ? targetCanvas.height : targetCanvas.width,
                            r === 90 || r === 270 ? targetCanvas.width : targetCanvas.height
                        );
                        const ctxR = rotated.getContext('2d') as OffscreenCanvasRenderingContext2D;
                        ctxR.translate(rotated.width / 2, rotated.height / 2);
                        ctxR.rotate((r * Math.PI) / 180);
                        ctxR.drawImage(targetCanvas, -targetCanvas.width / 2, -targetCanvas.height / 2);
                        targetCanvas = rotated;
                    }
                    
                    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
                    const ext = format === 'jpeg' ? 'jpg' : 'png';
                    const q = format === 'jpeg' ? 1.0 : undefined;
                    const blob = await targetCanvas.convertToBlob({ type: mime, quality: q });
                    zip.file(`${item.filename}.${ext}`, blob);
                } else {
                    // Fallback to SVG if not supported
                    let svgStr = bwipjs.toSVG(bwipOpts as any);
                    if (e.data.useExactWidth && e.data.widthInput) {
                        const exactWidthPx = Math.round(toPxWorker(Number(e.data.widthInput), e.data.widthUnit));
                        svgStr = svgStr.replace(/width="[^"]+"/, `width="${exactWidthPx}px" preserveAspectRatio="none"`);
                    }
                    zip.file(`${item.filename}.svg`, svgStr);
                }
            }
        } catch (err: any) {
            console.error(`Barcode Worker Render Error item ${i}`, err);
            // Optionally, we could collect error counts here
        }

        // Emit progress every 100 items (or exactly 50 for smaller payload updates)
        if (i % 50 === 0 || i === items.length - 1) {
            self.postMessage({ type: 'progress', progress: i + 1, statusText: 'Đang tạo hình...' });
            await new Promise(r => setTimeout(r, 0)); 
        }
    }

    self.postMessage({ type: 'progress', progress: items.length, statusText: 'Đang nén ZIP...' });

    // Store compression
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta: any) => {
        if (meta.percent % 10 === 0) {
           self.postMessage({ type: 'progress', progress: items.length + (meta.percent / 100), statusText: `Nén ZIP ${meta.percent.toFixed(0)}%` });
        }
    });

    self.postMessage({ type: 'done', payload: zipBlob, totalItems: items.length });

  } catch (error: any) {
    self.postMessage({ type: 'error', message: error.message || 'Worker Internal Error' });
  }
};
