import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch, getApiUrl, uploadPDF } from '../../lib/api';
import { useWorkingPdf } from '../../hooks/useWorkingPdf';
import { ToolSectionLabel, ToolCheckboxOption, ToolNumberInput, ToolInfo } from './ToolUI';

interface Props {
  pdfFile: File | null;
  onFileFixed?: (blob: Blob, name: string) => void;
}

export default function PageBoxesTool({ pdfFile, onFileFixed }: Props) {
  const [fileId, setFileId] = useState('');
  const [bleedMm, setBleedMm] = useState(2.0);
  const [removeWhiteBg, setRemoveWhiteBg] = useState(true);
  
  const [applying, setApplying] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => { setFileId(''); setStatus(''); }, [pdfFile]);

  const getWorkingFile = useWorkingPdf();
  const ensureUploaded = useCallback(async (): Promise<string> => {
    if (fileId) return fileId;
    if (!pdfFile) throw new Error('Chưa có file PDF');
    const result = await uploadPDF((await getWorkingFile()) || pdfFile);
    setFileId(result.id);
    return result.id;
  }, [fileId, pdfFile, getWorkingFile]);

  const handleRun = async () => {
    if (!pdfFile) return;
    setApplying(true); 
    setStatus('Đang xử lý...');
    try {
        let currentFid = await ensureUploaded();
        
        // Step 1: Auto Trim
        if (removeWhiteBg) {
            setStatus('Đang cắt lề trắng (Auto Trim)...');
            const trimRes = await authenticatedFetch(`${getApiUrl()}/preflight/auto-trim`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_id: currentFid, pages: null, margin_mm: 0 }),
            });
            const trimData = await trimRes.json();
            if (!trimData.success) throw new Error(trimData.detail || 'Lỗi xóa lề trắng');
            
            // Download the trimmed file to re-upload it (since API expects file_id)
            const dlRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${trimData.output_filename}`);
            const trimBlob = await dlRes.blob();
            const trimFile = new File([trimBlob], 'trimmed.pdf', { type: 'application/pdf' });
            
            setStatus('Đang tải lên trung gian...');
            const reUploadRes = await uploadPDF(trimFile);
            currentFid = reUploadRes.id;
        }
        
        // Step 2: Add Bleed Mirror
        setStatus('Đang lật gương 4 cạnh (Vector)...');
        const bleedRes = await authenticatedFetch(`${getApiUrl()}/preflight/add-bleed`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_id: currentFid, bleed_mm: bleedMm, pages: null }),
        });
        const bleedData = await bleedRes.json();
        if (!bleedData.success) throw new Error(bleedData.detail || 'Lỗi tạo bù xén');
        
        // Final Output
        setStatus('Đang hoàn thiện file...');
        const finalRes = await authenticatedFetch(`${getApiUrl()}/preflight/download/${bleedData.output_filename}`);
        const resultBlob = await finalRes.blob();
        
        setStatus('✅ Hoàn tất!');
        if (onFileFixed) {
            onFileFixed(resultBlob, `bleed_${pdfFile.name}`);
        }
    } catch (e: any) { 
        setStatus(`❌ ${e.message}`); 
    }
    setApplying(false);
  };

  if (!pdfFile) return <div className="text-[11px] text-slate-400 text-center py-6">Vui lòng mở file PDF trước</div>;

  return (
    <div className="flex flex-col gap-4 animate-in fade-in duration-200">
        <div>
            <ToolSectionLabel>Thiết lập Bù xén vuông góc</ToolSectionLabel>
            <div className="grid grid-cols-2 gap-2 mb-3 mt-3">
                <ToolNumberInput
                    label="Độ dày lề bù xén"
                    value={bleedMm}
                    onChange={setBleedMm}
                    suffix="mm"
                    step={0.5}
                />
            </div>
            
            <ToolCheckboxOption
                label="Xóa lề trắng thừa"
                desc="Tự động thu gọn các khoảng trắng vô dụng xung quanh hình trước khi lật gương."
                selected={removeWhiteBg}
                onClick={() => setRemoveWhiteBg(!removeWhiteBg)}
            />
        </div>

        <ToolInfo desc={
            <>
                <strong>Công nghệ Lật Gương Vector (Mirror):</strong> Thích hợp nhất cho các sản phẩm cắt xén thẳng góc như Card Visit, Tờ rơi, Voucher. Hệ thống sẽ lật ngược 4 mép cạnh ra ngoài, giữ nguyên 100% độ nét Vector siêu tốc.
            </>
        } />

        <button 
            onClick={handleRun} 
            disabled={applying}
            className={`w-full py-3 rounded-xl text-[13px] font-bold transition-all shadow-lg mt-2 ${
                applying
                    ? 'bg-slate-300 dark:bg-zinc-700 text-slate-500 cursor-not-allowed'
                    : 'bg-gradient-to-r from-teal-500 to-emerald-600 hover:from-teal-600 hover:to-emerald-700 text-white shadow-teal-500/25 hover:shadow-teal-500/40'
            }`}
        >
            {applying ? (<><div className="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2" /> Đang xử lý...</>) : (<>🔲 Tự động Xóa lề & Bù xén</>)}
        </button>

        {status && (
            <div className={`p-3 rounded-lg border ${status.startsWith('✅') ? 'bg-emerald-500/10 border-emerald-500/20' : status.startsWith('❌') ? 'bg-red-500/10 border-red-500/20' : 'bg-slate-100 dark:bg-zinc-800 border-slate-200 dark:border-zinc-700'}`}>
                <span className={`text-[11px] font-bold ${status.startsWith('✅') ? 'text-emerald-600' : status.startsWith('❌') ? 'text-red-600' : 'text-slate-600 dark:text-zinc-300'}`}>{status}</span>
            </div>
        )}
    </div>
  );
}
