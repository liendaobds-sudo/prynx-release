import React, { useState, useRef, useEffect } from 'react';
import weightsAnime from '@websr/websr/weights/anime4k/cnn-2x-l-an.json';
import weightsReal from '@websr/websr/weights/anime4k/cnn-2x-l-rl.json';
import { ToolSectionLabel, ToolCardOption, ToolInfo } from './ToolUI';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

const getWebSR = () => {
    return (window as any).WebSR?.default || (window as any).WebSR;
};

interface Props {
    pdfFile: File | null;
    onFileFixed?: (blob: Blob, filename: string) => void;
}

export default function UpscaleTool({ pdfFile, onFileFixed }: Props) {
    const [model, setModel] = useState<'anime' | 'real'>('real');
    const [scaleFactor, setScaleFactor] = useState<2 | 4>(4);
    const [isProcessing, setIsProcessing] = useState(false);
    const [progress, setProgress] = useState('');
    const [error, setError] = useState('');
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Register global flag for App.tsx
    useEffect(() => {
        (window as any).__isUpscalerActive = true;
        return () => { (window as any).__isUpscalerActive = false; };
    }, []);

    const handleRun = async () => {
        if (!pdfFile || !canvasRef.current) return;
        
        setIsProcessing(true);
        setError('');
        setProgress('Đang nạp dữ liệu ảnh...');

        try {
            const isImage = pdfFile.type.startsWith('image/') || pdfFile.name.match(/\.(jpg|jpeg|png|webp|gif)$/i);
            if (!isImage) {
                throw new Error("Công cụ này hiện chỉ hỗ trợ các file ảnh đơn lẻ (JPG, PNG). Vui lòng Tách trang PDF thành ảnh trước.");
            }

            let imgUrl = '';
            if ((window as any).__TAURI_INTERNALS__ && (pdfFile as any).path) {
                const { readFile } = await import('@tauri-apps/plugin-fs');
                const bytes = await readFile((pdfFile as any).path);
                const type = pdfFile.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
                const blob = new Blob([bytes], { type });
                imgUrl = URL.createObjectURL(blob);
            } else {
                imgUrl = URL.createObjectURL(pdfFile);
            }

            const img = new Image();
            img.src = imgUrl;
            await new Promise((res, rej) => {
                img.onload = res;
                img.onerror = () => rej(new Error("Lỗi đọc ảnh"));
            });

            setProgress('Đang khởi tạo WebGPU (Hardware Acceleration)...');
            const WebSR_class = getWebSR();
            
            if (!(navigator as any).gpu) {
                throw new Error("Trình duyệt hoặc hệ điều hành của bạn không hỗ trợ WebGPU.");
            }
            const adapter = await (navigator as any).gpu.requestAdapter();
            if (!adapter) {
                throw new Error("Không tìm thấy WebGPU Adapter.");
            }
            
            const gpu = await adapter.requestDevice({
                requiredLimits: {
                    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
                    maxBufferSize: adapter.limits.maxBufferSize,
                    maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
                    maxTextureDimension1D: adapter.limits.maxTextureDimension1D,
                    maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
                    maxTextureDimension3D: adapter.limits.maxTextureDimension3D,
                }
            });

            const originalDeviceDestroy = gpu.destroy.bind(gpu);
            gpu.destroy = () => {};

            const targetWeights = model === 'anime' ? weightsAnime : weightsReal;
            const upscaler = new WebSR_class({
                canvas: canvasRef.current,
                weights: targetWeights,
                network_name: "anime4k/cnn-2x-l",
                gpu: gpu
            });

            const originalGetCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
            let customTexture: GPUTexture | null = null;
            
            GPUCanvasContext.prototype.getCurrentTexture = function() {
                const width = upscaler.resolution!.width * upscaler.scale;
                const height = upscaler.resolution!.height * upscaler.scale;
                if (!customTexture || customTexture.width !== width || customTexture.height !== height) {
                    if (customTexture) customTexture.destroy();
                    customTexture = gpu.createTexture({
                        size: [width, height, 1],
                        format: navigator.gpu.getPreferredCanvasFormat(),
                        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
                    });
                }
                return customTexture as GPUTexture;
            };

            const readTextureToBlob = async (texture: GPUTexture, width: number, height: number): Promise<Blob> => {
                const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
                const buffer = gpu.createBuffer({
                    size: bytesPerRow * height,
                    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
                });
                const encoder = gpu.createCommandEncoder();
                encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
                gpu.queue.submit([encoder.finish()]);
                
                await buffer.mapAsync(GPUMapMode.READ);
                const arrayBuffer = buffer.getMappedRange();
                const imgData = new ImageData(width, height);
                
                const isBGRA = navigator.gpu.getPreferredCanvasFormat() === 'bgra8unorm';
                
                for (let y = 0; y < height; y++) {
                    const srcRow = new Uint8Array(arrayBuffer, y * bytesPerRow, width * 4);
                    const destOffset = y * width * 4;
                    
                    if (isBGRA) {
                        for (let x = 0; x < width; x++) {
                            const srcOffset = x * 4;
                            const destIdx = destOffset + srcOffset;
                            imgData.data[destIdx]     = srcRow[srcOffset + 2]; // R <- B
                            imgData.data[destIdx + 1] = srcRow[srcOffset + 1]; // G <- G
                            imgData.data[destIdx + 2] = srcRow[srcOffset];     // B <- R
                            imgData.data[destIdx + 3] = srcRow[srcOffset + 3]; // A <- A
                        }
                    } else {
                        imgData.data.set(srcRow, destOffset);
                    }
                }
                buffer.unmap();
                buffer.destroy();
                
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = width;
                tempCanvas.height = height;
                tempCanvas.getContext('2d')!.putImageData(imgData, 0, 0);
                return new Promise((resolve, reject) => {
                    tempCanvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Canvas toBlob failed")), 'image/png');
                });
            };

            const resizeToTarget = async (sourceBlob: Blob, targetW: number, targetH: number): Promise<Blob> => {
                const tempImg = new Image();
                tempImg.src = URL.createObjectURL(sourceBlob);
                await new Promise(res => tempImg.onload = res);
                const canvas = document.createElement('canvas');
                canvas.width = targetW;
                canvas.height = targetH;
                const ctx = canvas.getContext('2d')!;
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(tempImg, 0, 0, targetW, targetH);
                return new Promise((resolve, reject) => {
                    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Resize toBlob failed")), 'image/png');
                });
            };

            try {
                // Pass 1: AI 2x
                setProgress(`Đang tiến hành chạy AI (Pass 1 - 2x)...`);
                await upscaler.render(img);
                let finalBlob = await readTextureToBlob(customTexture!, upscaler.resolution!.width * 2, upscaler.resolution!.height * 2);

                if (scaleFactor === 4) {
                    const finalWidth = img.width * 4;
                    const finalHeight = img.height * 4;
                    const estimatedVramGB = (finalWidth * finalHeight * 16 * 15) / (1024 * 1024 * 1024);
                    
                    if (estimatedVramGB > 10) {
                        setProgress(`VRAM không đủ cho Full AI 4x. Đang dùng Hybrid AI Scaling...`);
                        // Fallback: AI 2x -> Canvas 2x
                        finalBlob = await resizeToTarget(finalBlob, finalWidth, finalHeight);
                    } else {
                        // Full AI 4x (Pass 2)
                        setProgress(`Đang tiến hành chạy AI (Pass 2 - 4x)...`);
                        const img2 = new Image();
                        img2.src = URL.createObjectURL(finalBlob);
                        await new Promise(res => img2.onload = res);
                        await upscaler.render(img2);
                        finalBlob = await readTextureToBlob(customTexture!, upscaler.resolution!.width * 2, upscaler.resolution!.height * 2);
                    }
                }
                
                if (onFileFixed) {
                    const newName = `${pdfFile.name.replace(/\.[^/.]+$/, "")}_upscale.png`;
                    onFileFixed(finalBlob, newName);
                }
            } finally {
                GPUCanvasContext.prototype.getCurrentTexture = originalGetCurrentTexture;
                if (customTexture) (customTexture as GPUTexture).destroy();
                originalDeviceDestroy();
            }
            setProgress('');
        } catch (e: any) {
            console.error(e);
            setError(e.message || "Lỗi xử lý");
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="flex flex-col gap-4 animate-in fade-in duration-300">
            <canvas ref={canvasRef} style={{ position: 'absolute', opacity: 0.001, pointerEvents: 'none', zIndex: -1, width: '10px', height: '10px' }} />

            <div>
                <ToolSectionLabel>Mô hình AI (Upscale Model)</ToolSectionLabel>
                <div className="grid grid-cols-2 gap-1.5 mt-2">
                    <ToolCardOption
                        label="Ảnh thực tế"
                        desc="Phong cảnh, người, động vật"
                        selected={model === 'real'}
                        onClick={() => setModel('real')}
                    />
                    <ToolCardOption
                        label="Đồ họa / Anime"
                        desc="Tranh vẽ 2D, line-art"
                        selected={model === 'anime'}
                        onClick={() => setModel('anime')}
                    />
                </div>
            </div>

            <div>
                <ToolSectionLabel>Mức độ phóng to (Upscale Factor)</ToolSectionLabel>
                <select
                    value={scaleFactor}
                    onChange={(e) => setScaleFactor(parseInt(e.target.value) as 2 | 4)}
                    className="w-full h-10 mt-1 bg-white dark:bg-[#27272a] border border-slate-200 dark:border-white/10 rounded-lg px-3 text-[13px] font-medium text-slate-700 dark:text-zinc-200 outline-none"
                >
                    <option value={2}>Gấp 2 lần (2x)</option>
                    <option value={4}>Gấp 4 lần (4x)</option>
                </select>
                <p className="text-[11px] text-slate-500 mt-2 text-center px-2">
                    Ảnh sẽ được chạy qua AI Upscale và tự động nội suy kích thước.
                </p>
            </div>
            <ToolInfo desc={
                <>
                    Phóng to ảnh nhưng vẫn giữ được độ sắc nét, không bị vỡ hạt. Tính năng chạy hoàn toàn trên máy của bạn nên đảm bảo bảo mật tuyệt đối.
                </>
            } />

            <button
                onClick={handleRun}
                disabled={isProcessing || !pdfFile}
                className={`w-full h-12 rounded-xl text-[14px] font-bold transition-all shadow-lg flex items-center justify-center gap-2 ${
                    isProcessing || !pdfFile
                        ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                        : 'bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white shadow-indigo-500/25 hover:shadow-indigo-500/40'
                }`}
            >
                {isProcessing ? '⏳ Đang xử lý...' : '🚀 Bắt Đầu Phóng To Ảnh'}
            </button>

            {progress && (
                <div className="flex items-center gap-3 bg-indigo-50 dark:bg-indigo-900/20 p-3 rounded-lg border border-indigo-200 dark:border-indigo-800/50">
                    <div className="w-5 h-5 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin shrink-0" />
                    <span className="text-[12px] text-indigo-700 dark:text-indigo-300 font-medium">{progress}</span>
                </div>
            )}

            {error && (
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800/50">
                    <span className="text-[12px] text-red-600 dark:text-red-400 font-medium">❌ {error}</span>
                </div>
            )}
        </div>
    );
}
