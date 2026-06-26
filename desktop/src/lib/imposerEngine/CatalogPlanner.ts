// src/lib/imposerEngine/CatalogPlanner.ts
// =========================================================================
//  Smart Catalog Auto Planner
//  Phân tích 1 file PDF catalog → trả về danh sách PlateJob[]
//  mà mỗi job tương ứng 1 tấm kẽm in cần xuất.
//
//  Hỗ trợ 2 kiểu đóng gáy:
//    - 'perfect'  = Bóc tép vô keo (Perfect Binding) → Trang tuần tự
//    - 'saddle'   = Ghim lồng (Saddle Stitch) → Phễu từ tâm ra ngoài
//
//  Hỗ trợ bìa riêng chất liệu hoặc bìa chung.
//  Hỗ trợ Master Signature 8 hoặc 16.
// =========================================================================

// ==================== INTERFACES ====================

export interface PlateJob {
    /** Unique ID: 'main_1', 'remainder_8', 'cover' */
    id: string;
    /** Nhãn hiển thị trên UI: 'Kẽm Tay 16 (Tép 1)' */
    label: string;
    /** Tên file xuất: 'Catalog80_Kem1_Tay16_Tep1.pdf' */
    filename: string;
    /** ID sơ đồ gấp: 'sig_16p', 'sig_8p', 'sig_4p' */
    foldPatternId: string;
    /** Kiểu gán trang nội bộ trong tay này */
    bindingMode: 'saddle' | 'thread';
    /** Mảng 0-based index trang gốc từ file PDF đầu vào */
    pageIndices: number[];
    /** Số trang thực (không tính padding) */
    actualPageCount: number;
    /** Đánh cờ: đây là kẽm bìa */
    isCover: boolean;
    /** Sheetwise = 2 lá kẽm (Trước/Sau), Work & Turn = tự trở lật ngang, Work & Tumble = tự trở lật nhíp */
    workStyle: 'sheetwise' | 'work_and_turn' | 'work_and_tumble';
    /** Màu nhãn cho UI (tùy chọn) */
    color?: string;
    /** Thứ tự sắp xếp (dùng để UI hiển thị đúng trình tự vật lý) */
    sortOrder: number;
}

export interface PlanConfig {
    /** Tổng số trang file PDF gốc */
    totalPages: number;
    /** Kiểu đóng gáy */
    bindingMode: 'saddle' | 'perfect';
    /** true = Bìa khác chất liệu, tách ra kẽm riêng */
    hasSeparateCover: boolean;
    /** Sơ đồ gấp chính: 4, 8, hoặc 16 (auto-calculated bởi SheetOptimizer) */
    masterSig: 4 | 8 | 16;
    /** Vị trí đặt tay dư trong ruột cuốn sách */
    remainderPlacement?: 'outside' | 'inside';
    /** Tên file gốc (để đặt tên output) */
    sourceFileName?: string;
}

export interface PlanResult {
    jobs: PlateJob[];
    report: string;
    /** Tổng trang đã phân bổ (để kiểm chứng = totalPages) */
    totalAllocated: number;
}

// ==================== COLOR PALETTE ====================
// Dùng cho UI — mỗi kẽm 1 màu dễ phân biệt
const PLATE_COLORS = [
    '#3F51B5', // Indigo (Kẽm 1)
    '#4CAF50', // Green  (Kẽm 2)
    '#FF5722', // Deep Orange (Kẽm 3)
    '#E91E63', // Pink   (Kẽm 4)
    '#9C27B0', // Purple (Kẽm 5)
    '#00BCD4', // Cyan   (Kẽm 6)
    '#FF9800', // Orange (Kẽm 7)
    '#607D8B', // Blue Grey (Kẽm 8+)
];
const COVER_COLOR = '#2E7D32'; // Green Darker cho bìa

// ==================== UTILITIES ====================

/** Lấy tên file gốc không có extension */
function getBaseName(fileName?: string): string {
    if (!fileName) return 'Output';
    const name = fileName.replace(/\.[^/.]+$/, ''); // bỏ extension
    // Sanitize: bỏ ký tự đặc biệt không hợp lệ cho tên file
    return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'Output';
}

/** Pad số trang lên bội 4 gần nhất */
function padTo4(n: number): number {
    return Math.ceil(n / 4) * 4;
}

/** Map fold pattern ID theo số trang và masterSig để tránh tràn kẽm */
function getFoldPatternId(sigSize: number, masterSig: number = 8) {
    if (sigSize === 16) return 'sig_16p';
    if (sigSize === 8) return 'sig_8p';
    if (sigSize === 4) return masterSig === 4 ? 'sig_4p_1up' : 'sig_4p_2up';
    return masterSig === 4 ? 'sig_4p_1up' : 'sig_4p_2up';
}

// ==================== CORE: PAGE ROUTING ====================

/**
 * Routing cho Bóc Tép (Perfect Binding / Thread Binding).
 * Trang gán tuần tự: Kẽm 1 lấy trang [startPage ... startPage + sigSize - 1]
 */
function routePerfectBinding(
    bodyPageIndices: number[],
    masterSig: number
): { mainJobs: { pageIndices: number[]; sigSize: number }[]; remainderJobs: { pageIndices: number[]; sigSize: number }[] } {
    const P = bodyPageIndices.length;
    const P_padded = padTo4(P);
    const mainSigCount = Math.floor(P_padded / masterSig);
    const remainder = P_padded % masterSig;

    const mainJobs: { pageIndices: number[]; sigSize: number }[] = [];
    const remainderJobs: { pageIndices: number[]; sigSize: number }[] = [];

    // Kẽm chính — tuần tự
    let cursor = 0;
    for (let i = 0; i < mainSigCount; i++) {
        const indices: number[] = [];
        for (let j = 0; j < masterSig; j++) {
            const idx = cursor + j;
            // idx có thể vượt quá P (padding) → push -1 (trang trắng)
            indices.push(idx < P ? bodyPageIndices[idx] : -1);
        }
        mainJobs.push({ pageIndices: indices, sigSize: masterSig });
        cursor += masterSig;
    }

    // Kẽm phụ — xử lý phần dư
    if (remainder > 0) {
        if (remainder <= 8) {
            // Dư ≤ 8 → 1 tay (4 hoặc 8)
            const indices: number[] = [];
            for (let j = 0; j < remainder; j++) {
                const idx = cursor + j;
                indices.push(idx < P ? bodyPageIndices[idx] : -1);
            }
            remainderJobs.push({ pageIndices: indices, sigSize: remainder });
        } else {
            // Dư = 12 → Tay 8 + Tay 4
            const indices8: number[] = [];
            for (let j = 0; j < 8; j++) {
                const idx = cursor + j;
                indices8.push(idx < P ? bodyPageIndices[idx] : -1);
            }
            remainderJobs.push({ pageIndices: indices8, sigSize: 8 });

            const indices4: number[] = [];
            for (let j = 0; j < 4; j++) {
                const idx = cursor + 8 + j;
                indices4.push(idx < P ? bodyPageIndices[idx] : -1);
            }
            remainderJobs.push({ pageIndices: indices4, sigSize: 4 });
        }
    }

    return { mainJobs, remainderJobs };
}

/**
 * Routing cho Ghim Lồng (Saddle Stitch).
 * 
 * Nguyên lý: Toàn bộ ruột là 1 cuốn sách saddle lớn. Khi gấp lồng, các trang
 * ở chính giữa sách (vd: trang 40-41 của cuốn 80 trang) nằm ở lõi trong cùng,
 * còn các trang ở đầu/cuối sách (vd: trang 3-4 và 77-78) nằm ngoài cùng.
 * 
 * Phân vùng trang theo "vòng đồng tâm" (concentric rings):
 *   - Vòng lõi (kẽm 1):   masterSig trang ở trung tâm sách
 *   - Vòng ôm 1 (kẽm 2):  masterSig trang tiếp theo bọc quanh lõi
 *   - ...
 *   - Vòng ngoài cùng:    trang dư (gần bìa nhất) → kẽm phụ
 * 
 * Mỗi PlateJob chứa pageIndices tuần tự (theo thứ tự logic của vùng đó).
 * VirtualMap sẽ nhận pageIndices này và tự áp công thức saddle nội bộ.
 */
function routeSaddleBinding(
    bodyPageIndices: number[],
    masterSig: number,
    remainderPlacement: 'outside' | 'inside' = 'outside'
): { mainJobs: { pageIndices: number[]; sigSize: number }[]; remainderJobs: { pageIndices: number[]; sigSize: number }[] } {
    const P = bodyPageIndices.length;
    const P_padded = padTo4(P);

    // Tính số kẽm chính và phần dư
    const mainSigCount = Math.floor(P_padded / masterSig);
    const remainder = P_padded % masterSig;

    const mainJobs: { pageIndices: number[]; sigSize: number }[] = [];
    const remainderJobs: { pageIndices: number[]; sigSize: number }[] = [];

    // Bước 1: Tạo mảng padded (thêm -1 cho trang trắng)
    const paddedIndices: number[] = [];
    for (let i = 0; i < P_padded; i++) {
        paddedIndices.push(i < P ? bodyPageIndices[i] : -1);
    }

    // Bước 2: Thiết lập 2 con trỏ Đầu (front) và Cuối (back)
    let front = 0;
    let back = P_padded - 1;

    function grabSymmetricIndices(n: number) {
        const half = n / 2;
        const frontPages: number[] = [];
        const backPages: number[] = [];
        
        for (let i = 0; i < half; i++) {
            frontPages.push(paddedIndices[front++]);
        }
        for (let i = 0; i < half; i++) {
            backPages.unshift(paddedIndices[back--]);
        }
        
        return [...frontPages, ...backPages];
    }

    const grabRemainder = () => {
        if (remainder > 0) {
            if (remainder <= 8) {
                remainderJobs.push({ pageIndices: grabSymmetricIndices(remainder), sigSize: remainder });
            } else {
                remainderJobs.push({ pageIndices: grabSymmetricIndices(4), sigSize: 4 });
                remainderJobs.push({ pageIndices: grabSymmetricIndices(8), sigSize: 8 });
            }
        }
    };

    if (remainderPlacement === 'outside') {
        // Tay bù ở ngoài: Xử lý vét số trước, nên tay bù lấy các trang sát bìa
        grabRemainder();
        for (let g = 0; g < mainSigCount; g++) {
            mainJobs.push({ pageIndices: grabSymmetricIndices(masterSig), sigSize: masterSig });
        }
    } else {
        // Tay bù nhét lõi: Xử lý thuật vét vét các tay chính trước (bọc ngoài)
        for (let g = 0; g < mainSigCount; g++) {
            mainJobs.push({ pageIndices: grabSymmetricIndices(masterSig), sigSize: masterSig });
        }
        // Cuối cùng mới lấy tay bù, nên tay bù lấy đúng phần lõi trung tâm
        grabRemainder();
    }

    // Theo chuẩn gia công, Tay 1 luôn là Lõi (rớt xuống máy bắt lồng đầu tiên).
    // Do đó đảo mảng các tay chính để tay được vét cuối cùng (sâu nhất) thành Tay 1.
    mainJobs.reverse();

    return { mainJobs, remainderJobs };
}

// ==================== MAIN PLANNER ====================

export function planCatalog(config: PlanConfig): PlanResult {
    const { totalPages, bindingMode, hasSeparateCover, masterSig, sourceFileName } = config;
    const baseName = getBaseName(sourceFileName);
    const jobs: PlateJob[] = [];
    let reportLines: string[] = [];
    let sortOrder = 0;

    // ---- Bước 1: Xử lý Bìa ----
    let coverPageIndices: number[] = [];
    let bodyPageIndices: number[] = [];

    if (hasSeparateCover && totalPages >= 8) {
        // Bìa riêng chất liệu: trước(0), trước-trong(1), sau-trong(N-2), sau(N-1)
        coverPageIndices = [0, 1, totalPages - 2, totalPages - 1];
        // Ruột: toàn bộ trang giữa
        for (let i = 2; i < totalPages - 2; i++) {
            bodyPageIndices.push(i);
        }
        reportLines.push(`Bìa: [trước, 01, ${totalPages - 2}, sau] → Tay riêng Tự Trở.`);
        reportLines.push(`Ruột: ${bodyPageIndices.length} trang (02 → ${totalPages - 3}).`);
    } else {
        // Bìa chung: toàn bộ đi vào ruột
        for (let i = 0; i < totalPages; i++) {
            bodyPageIndices.push(i);
        }
        reportLines.push(`Bìa chung chất liệu: Toàn bộ ${totalPages} trang xử lý chung.`);
    }

    const P = bodyPageIndices.length;
    const P_padded = padTo4(P);
    
    if (P_padded !== P) {
        reportLines.push(`Padding: Thêm ${P_padded - P} trang trắng (${P} → ${P_padded}) để chia hết cho 4.`);
    }

    // ---- Bước 2: Route trang theo kiểu gáy ----
    let plan: { mainJobs: { pageIndices: number[]; sigSize: number }[]; remainderJobs: { pageIndices: number[]; sigSize: number }[] } = { mainJobs: [], remainderJobs: [] };

    if (bindingMode === 'saddle') {
        plan = routeSaddleBinding(bodyPageIndices, masterSig, config.remainderPlacement || 'outside');
    } else {
        plan = routePerfectBinding(bodyPageIndices, masterSig);
    }
    const { mainJobs, remainderJobs } = plan;

    // ---- Bước 3: Tạo PlateJob cho kẽm chính ----
    const mainSigLabel = `Tay${masterSig}`;

    for (let i = 0; i < mainJobs.length; i++) {
        const job = mainJobs[i];
        const tepNum = i + 1;
        const realPages = job.pageIndices.filter(idx => idx !== -1);
        const ws = masterSig === 16 ? 'sheetwise' : 'work_and_turn';
        
        jobs.push({
            id: `main_${tepNum}`,
            label: `Tay in ${mainSigLabel} — Tép ${tepNum}`,
            filename: `${baseName}_TayIn${tepNum}_${mainSigLabel}_Tep${tepNum}.pdf`,
            foldPatternId: getFoldPatternId(job.sigSize, masterSig),
            bindingMode: bindingMode === 'perfect' ? 'thread' : 'saddle',
            pageIndices: job.pageIndices,
            actualPageCount: realPages.length,
            isCover: false,
            workStyle: ws,
            color: PLATE_COLORS[(sortOrder) % PLATE_COLORS.length],
            sortOrder: sortOrder++,
        });
    }

    if (mainJobs.length > 0) {
        const wsLabel = masterSig === 16 ? 'Sheetwise — 2 mặt/tay' : 'Tự Trở — 1 mặt/tay';
        reportLines.push(`Tay in chính: ${mainJobs.length} × ${mainSigLabel} (${wsLabel}).`);
    }

    // ---- Bước 4: Tạo PlateJob cho kẽm phụ (trang dư) ----
    let remainderKemIndex = mainJobs.length + 1;
    for (const rem of remainderJobs) {
        const sigLabel = rem.sigSize === 8 ? 'Tay8' : 'Tay4';
        const realPages = rem.pageIndices.filter(idx => idx !== -1);

        jobs.push({
            id: `remainder_${rem.sigSize}_${remainderKemIndex}`,
            label: `Tay in ${sigLabel} — Trang lẻ (Tự Trở ${rem.sigSize === 8 ? 'Lật Nhíp' : 'Lật Ngang'})`,
            filename: `${baseName}_TayIn${remainderKemIndex}_${sigLabel}_TuTro.pdf`,
            foldPatternId: getFoldPatternId(rem.sigSize, masterSig),
            bindingMode: bindingMode === 'perfect' ? 'thread' : 'saddle',
            pageIndices: rem.pageIndices,
            actualPageCount: realPages.length,
            isCover: false,
            workStyle: 'work_and_turn',
            color: PLATE_COLORS[(sortOrder) % PLATE_COLORS.length],
            sortOrder: sortOrder++,
        });
        remainderKemIndex++;
    }

    if (remainderJobs.length > 0) {
        const remDetail = remainderJobs.map(r => `${r.sigSize} trang`).join(' + ');
        reportLines.push(`Tay phụ (trang dư): ${remainderJobs.length} tay (${remDetail}) — Tự Trở.`);
    }

    // ---- Bước 5: Tạo PlateJob cho kẽm bìa ----
    if (coverPageIndices.length > 0) {
        jobs.push({
            id: 'cover',
            label: 'Tay in Bìa (Tự Trở Lật Ngang)',
            filename: `${baseName}_Bia_TuTro.pdf`,
            foldPatternId: getFoldPatternId(4, masterSig),
            bindingMode: 'saddle',
            pageIndices: coverPageIndices,
            actualPageCount: 4,
            isCover: true,
            workStyle: 'work_and_turn',
            color: COVER_COLOR,
            sortOrder: sortOrder++,
        });
        reportLines.push(`Tay in bìa: 1 × Tay 4 (Tự Trở) — Chất liệu riêng.`);
    }

    // ---- Báo cáo tổng kết ----
    const totalAllocated = jobs.reduce((sum, j) => sum + j.pageIndices.length, 0);
    const totalRealPages = jobs.reduce((sum, j) => sum + j.actualPageCount, 0);
    
    const bindingLabel = bindingMode === 'perfect' ? 'Bóc tép vô keo' : 'Ghim lồng (Saddle Stitch)';
    reportLines.unshift(`📋 Phân tích bài bình: ${totalPages} trang | ${bindingLabel} | Master: Tay ${masterSig}`);
    reportLines.push(`──────────────────`);
    reportLines.push(`Tổng: ${jobs.length} tay in | ${totalRealPages} trang thực + ${totalAllocated - totalRealPages} trang padding.`);

    return {
        jobs,
        report: reportLines.join('\n'),
        totalAllocated,
    };
}

// ==================== VERIFICATION HELPER ====================

/**
 * Hàm kiểm chứng nhanh: đảm bảo không sót trang, không trùng trang.
 * Gọi sau planCatalog() để validate kết quả.
 */
export function verifyCatalogPlan(config: PlanConfig, result: PlanResult): string[] {
    const errors: string[] = [];
    const allRealIndices: number[] = [];

    for (const job of result.jobs) {
        for (const idx of job.pageIndices) {
            if (idx !== -1) {
                allRealIndices.push(idx);
            }
        }
    }

    // Kiểm tra trùng
    const seen = new Set<number>();
    for (const idx of allRealIndices) {
        if (seen.has(idx)) {
            errors.push(`TRÙNG: Trang ${idx + 1} xuất hiện trên nhiều kẽm!`);
        }
        seen.add(idx);
    }

    // Kiểm tra sót
    for (let i = 0; i < config.totalPages; i++) {
        if (!seen.has(i)) {
            errors.push(`SÓT: Trang ${i + 1} không nằm trên kẽm nào!`);
        }
    }

    // Kiểm tra trang ngoài phạm vi
    for (const idx of allRealIndices) {
        if (idx < 0 || idx >= config.totalPages) {
            errors.push(`NGOÀI PHẠM VI: Index ${idx} vượt khỏi [0, ${config.totalPages - 1}]!`);
        }
    }

    return errors;
}
