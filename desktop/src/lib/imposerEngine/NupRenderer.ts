// src/lib/imposerEngine/NupRenderer.ts
import { PDFDocument, cmyk, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, translate, rotateDegrees } from 'pdf-lib';
import { MM_TO_POINTS, ProcessingSettings } from '../pdfImposer';
import { solveOptimalNupLayout } from './NupGridSolver';
import { drawMarksNup } from './MarksRenderer';


export const renderNup = async (
    pageCount: number,
    embeddedPages: any[],
    srcPageDetails: any[],
    maxSrcPageWidth: number,
    maxSrcPageHeight: number,
    finalSheetWidth: number,
    finalSheetHeight: number,
    _settings: ProcessingSettings,
    outputPdf: PDFDocument,
    setStatus: (msg: string) => void
) => {
    const settings = _settings as any;
    const jobName = settings.layoutType === 'repeat' ? 'Nhân bản' : 'N-Up';
    setStatus(`Đang phân tích cấu trúc ma trận ${jobName}...`);
        
    const bleedPt = settings.bleed * MM_TO_POINTS;
    const trimWidth = maxSrcPageWidth - 2 * bleedPt;
    const trimHeight = maxSrcPageHeight - 2 * bleedPt;
    
    let cols = settings.cols || 0;
    let rows = settings.rows || 0;
    const gapX = (settings.gapX || 0) * MM_TO_POINTS;
    const gapY = (settings.gapY || 0) * MM_TO_POINTS;
    let marginTop = (settings.marginTop || 0) * MM_TO_POINTS;
    let marginBottom = (settings.marginBottom || 0) * MM_TO_POINTS;
    let marginLeft = (settings.marginLeft || 0) * MM_TO_POINTS;
    let marginRight = (settings.marginRight || 0) * MM_TO_POINTS;

    if (settings.marginMode === 'include_marks' && settings.markType && settings.markType !== 'none') {
        const len = (settings.markLength ?? 5.0) * MM_TO_POINTS;
        const off = (settings.markOffset ?? 3.0) * MM_TO_POINTS;
        const markSpace = len + off;
        
        marginTop += markSpace;
        marginBottom += markSpace;
        marginLeft += markSpace;
        marginRight += markSpace;
    }

    const clusterMode = settings.clusterMode || 'none';
    const clusterCount = Math.max(2, settings.clusterCount || 2);
    
    // Calculate clearance for guillotine marks. This is used for BOTH gap calculation and border drawing.
    const tLen = (settings.markLength ?? 5.0) * MM_TO_POINTS;
    const tOff = (settings.markOffset ?? 3.0) * MM_TO_POINTS;
    const markClearance = tOff + tLen;

    let clusterGapPt = (settings.clusterGap || 0) * MM_TO_POINTS;
    if (settings.clusterGapMode === 'mark' && settings.markType === 'guillotine') {
        clusterGapPt += 2 * markClearance;
    }
    
    const clusterBorder = settings.clusterBorder || false;

    let usableW = finalSheetWidth - marginLeft - marginRight;
    let usableH = finalSheetHeight - marginTop - marginBottom;
    
    const sheetUsableW = usableW;
    const sheetUsableH = usableH;

    let cxCount = 1;
    let cyCount = 1;

    if (clusterMode === 'column' && clusterCount >= 2) {
        usableW = (usableW - clusterGapPt * (clusterCount - 1)) / clusterCount;
        cxCount = clusterCount;
    } else if (clusterMode === 'row' && clusterCount >= 2) {
        usableH = (usableH - clusterGapPt * (clusterCount - 1)) / clusterCount;
        cyCount = clusterCount;
    }

    let isAutoRotated = false;
    let actualTrimWidth = trimWidth;
    let actualTrimHeight = trimHeight;

    let splitGap = settings.clusterGap !== undefined && settings.clusterGap > 0 
        ? settings.clusterGap * MM_TO_POINTS 
        : Math.max(gapX, gapY, 14.17); // 14.17pt = 5mm
        
    if (((settings as any).markType === 'guillotine' || (settings as any).markType === 'corners') && 
        (!settings.clusterGap || settings.clusterGapMode === 'mark')) {
        // Gap = chính xác 2×markClearance để đỉnh mark 2 cụm CHẠM NHAU.
        splitGap = 2 * markClearance;
    }

    const layout = solveOptimalNupLayout(
        usableW, usableH, 
        trimWidth, trimHeight, 
        gapX, gapY, 
        settings.gridStrategy || 'simple_auto', 
        cols, rows,
        splitGap,
        settings.shapeType,
        settings.shapeParams
    );

    if (layout.cells.length < 1) {
        throw new Error(`Khổ giấy hoặc Cụm chia quá nhỏ. Số lượng tính toán <= 0. Vui lòng kiểm tra lại kích thước giấy, lề, hoặc Khoảng cách Cụm.`);
    }

    const { overallWidth: activeGridW_Full, overallHeight: activeGridH_Full, blocks } = layout;

    // Build the sheet-matrix rendering plan
    interface LayoutCell {
        c: number;
        r: number;
        x: number;
        y: number;
        width: number;
        height: number;
        isRotated: boolean;
        blockId: number;
        srcIndex: number | null;
    }
    interface RenderSheet {
        sheetIndex: number;
        logicalSheetIdx: number;
        isFront: boolean;
        cells: LayoutCell[];
    }

    const layoutType = settings.layoutType || 'sequential';
    const duplexFlow = settings.duplexFlow || 'normal';
    const sheetsToRender: RenderSheet[] = [];

    setStatus(`Khởi tạo lưới ${jobName} (${cols} cột x ${rows} dòng) - Chế độ: ${layoutType === 'cut_stacks' ? 'Cắt xếp chồng' : (layoutType === 'repeat' ? 'Nhân bản' : 'Trải tuần tự')}...`);

    const isDouble = duplexFlow === 'double';
    
    // Group source pages into Logical Items that map to 1 Cell
    const sourceLogicalItems: number[][] = [];
    if (isDouble) {
        for (let p = 0; p < pageCount; p += 2) {
            sourceLogicalItems.push([p, p + 1 < pageCount ? p + 1 : -1]);
        }
    } else {
        for (let p = 0; p < pageCount; p++) {
            sourceLogicalItems.push([p]);
        }
    }

    const capacity = layout.cells.length;
    let expandedLogicalItems: number[][] = [];
    
    if (settings.gridStrategy !== 'manual') {
        let p = 0;
        const totalSourceItems = sourceLogicalItems.length;
        while (p < totalSourceItems) {
             const chunk: number[][] = [];
             while (p < totalSourceItems && chunk.length < capacity) {
                 chunk.push(sourceLogicalItems[p]);
                 p++;
             }
             if (chunk.length < capacity) {
                 const baseCopies = Math.floor(capacity / chunk.length);
                 let rem = capacity % chunk.length;
                 
                 for (const item of chunk) {
                     let currentCopies = baseCopies;
                     if (rem > 0) {
                         currentCopies++;
                         rem--;
                     }
                     for (let k = 0; k < currentCopies; k++) {
                         expandedLogicalItems.push(item);
                     }
                 }
             } else {
                 for (const item of chunk) {
                     expandedLogicalItems.push(item);
                 }
             }
        }
    } else {
        expandedLogicalItems = [...sourceLogicalItems];
    }

    const virtualCellCount = expandedLogicalItems.length;

    if (layoutType === 'repeat') {
        let sIdx = 0;
        let s = 0;
        for (const item of sourceLogicalItems) {
            const frontCells: LayoutCell[] = [];
            const backCells: LayoutCell[] = [];
            for (const cell of layout.cells) {
                const b = blocks.find(x => x.id === cell.blockId)!;
                if (isDouble) {
                    frontCells.push({ ...cell, srcIndex: item[0] !== -1 ? item[0] : null });
                    backCells.push({ ...cell, c: b.cols - 1 - cell.c, x: activeGridW_Full - cell.x - cell.width, srcIndex: item[1] !== -1 ? item[1] : null });
                } else {
                    frontCells.push({ ...cell, srcIndex: item[0] !== -1 ? item[0] : null });
                }
            }
            if (isDouble) {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: s, isFront: true, cells: frontCells });
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: s, isFront: false, cells: backCells });
            } else {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: s, isFront: true, cells: frontCells });
            }
            s++;
        }
    } else if (layoutType === 'sequential') {
        let cellCursor = 0;
        let sIdx = 0;
        let logicalS = 0;
        while (cellCursor < virtualCellCount) {
            const frontCells: LayoutCell[] = [];
            const backCells: LayoutCell[] = [];
            const isFront = sIdx % 2 === 0;

            for (const cell of layout.cells) {
                const b = blocks.find(x => x.id === cell.blockId)!;
                if (cellCursor < virtualCellCount) {
                    const item = expandedLogicalItems[cellCursor];
                    if (isDouble) {
                        frontCells.push({ ...cell, srcIndex: item[0] !== -1 ? item[0] : null });
                        backCells.push({ ...cell, c: b.cols - 1 - cell.c, x: activeGridW_Full - cell.x - cell.width, srcIndex: item[1] !== -1 ? item[1] : null });
                    } else {
                        const doMirror = (!isFront && settings.mirrorAlign);
                        const actualC = doMirror ? (b.cols - 1 - cell.c) : cell.c;
                        const actualX = doMirror ? activeGridW_Full - cell.x - cell.width : cell.x;
                        frontCells.push({ ...cell, c: actualC, x: actualX, srcIndex: item[0] !== -1 ? item[0] : null });
                    }
                    cellCursor++;
                }
            }
            if (isDouble) {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: logicalS, isFront: true, cells: frontCells });
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: logicalS, isFront: false, cells: backCells });
            } else {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: logicalS, isFront, cells: frontCells });
            }
            logicalS++;
        }
    } else if (layoutType === 'cut_stacks') {
        const blocksCount = capacity; 
        const stackDepth = Math.ceil(virtualCellCount / blocksCount);
        
        let sIdx = 0;
        for (let depth = 0; depth < stackDepth; depth++) {
            const frontCells: LayoutCell[] = [];
            const backCells: LayoutCell[] = [];
            
            for (let i = 0; i < layout.cells.length; i++) {
                const cell = layout.cells[i];
                const b = blocks.find(x => x.id === cell.blockId)!;
                const logicalCardIdx = i * stackDepth + depth;
                
                if (logicalCardIdx < virtualCellCount) {
                    const item = expandedLogicalItems[logicalCardIdx];
                    if (isDouble) {
                        frontCells.push({ ...cell, srcIndex: item[0] !== -1 ? item[0] : null });
                        backCells.push({ ...cell, c: b.cols - 1 - cell.c, x: activeGridW_Full - cell.x - cell.width, srcIndex: item[1] !== -1 ? item[1] : null });
                    } else {
                        const doMirror = ((sIdx % 2 !== 0) && settings.mirrorAlign);
                        const actualC = doMirror ? (b.cols - 1 - cell.c) : cell.c;
                        const actualX = doMirror ? activeGridW_Full - cell.x - cell.width : cell.x;
                        frontCells.push({ ...cell, c: actualC, x: actualX, srcIndex: item[0] !== -1 ? item[0] : null });
                    }
                }
            }
            
            if (isDouble) {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: depth, isFront: true, cells: frontCells });
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: depth, isFront: false, cells: backCells });
            } else {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: depth, isFront: true, cells: frontCells });
            }
        }
    }

    const isMergedItemTypeMode = settings.clusterMode !== 'none' && settings.clusterDistribution === 'type';
    if (isMergedItemTypeMode) {
        const totalClusters = cxCount * cyCount;
        const totalSheetsNeeded = Math.ceil(sourceLogicalItems.length / totalClusters);
        
        sheetsToRender.length = 0; // Thay thế logic sheetsToRender cũ
        let sIdx = 0;
        for (let s = 0; s < totalSheetsNeeded; s++) {
            const frontCells = layout.cells.map(c => ({...c, srcIndex: 0})); // dummy srcIndex
            const backCells = layout.cells.map(c => ({...c, srcIndex: 0}));
            if (isDouble) {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: s, isFront: true, cells: frontCells });
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: s, isFront: false, cells: backCells });
            } else {
                sheetsToRender.push({ sheetIndex: sIdx++, logicalSheetIdx: s, isFront: true, cells: frontCells });
            }
        }
    }

    const drawL = (page: any, x1: number, y1: number, x2: number, y2: number, color: any) => {
        page.drawLine({start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness: 0.5, color});
    };
    const black = cmyk(1, 1, 1, 1); // Registration (mọi kẽm) cho dấu N-up
    const tickLen = 7;
    const tickOff = 4;

    for (let s = 0; s < sheetsToRender.length; s++) {
        const renderItem = sheetsToRender[s];
        if (renderItem.cells.every(c => c.srcIndex === null)) continue; // Skip empty sheets

        setStatus(`Đang xuất mâm in tờ ${s + 1}/${sheetsToRender.length}...`);
        const outputPage = outputPdf.addPage([finalSheetWidth, finalSheetHeight]);

        // Find active bounds for this sheet to collapse empty rows/cols if manual
        let activeGridW = activeGridW_Full;
        let activeGridH = activeGridH_Full;
        
        if (settings.gridStrategy === 'manual') {
            let maxRight = 0, maxBottom = 0;
            let hasItem = false;
            for (const c of renderItem.cells) {
                if (c.srcIndex !== null) {
                    hasItem = true;
                    if (c.x + c.width > maxRight) maxRight = c.x + c.width;
                    if (c.y + c.height > maxBottom) maxBottom = c.y + c.height;
                }
            }
            if (hasItem) {
                activeGridW = maxRight;
                activeGridH = maxBottom;
            }
        }

        const superGridW = cxCount * activeGridW + (cxCount > 1 ? (cxCount - 1) * clusterGapPt : 0);
        const superGridH = cyCount * activeGridH + (cyCount > 1 ? (cyCount - 1) * clusterGapPt : 0);

        // Alignment logic
        let alignStr: string = settings.align || 'center';
        if (!renderItem.isFront && settings.mirrorAlign) {
            if (alignStr.includes('left')) alignStr = alignStr.replace('left', 'right');
            else if (alignStr.includes('right')) alignStr = alignStr.replace('right', 'left');
        }

        let superBaseX = marginLeft;
        if (alignStr.includes('center')) superBaseX = marginLeft + (sheetUsableW - superGridW) / 2;
        if (alignStr.includes('right')) superBaseX = finalSheetWidth - marginRight - superGridW;

        let superBaseY = marginBottom;
        if (alignStr.includes('center')) superBaseY = marginBottom + (sheetUsableH - superGridH) / 2;
        if (alignStr.includes('top')) superBaseY = finalSheetHeight - marginTop - superGridH;

        for (let cy = 0; cy < cyCount; cy++) {
            for (let cx = 0; cx < cxCount; cx++) {
                const clusterBaseX = superBaseX + cx * (activeGridW + clusterGapPt);
                const visualCy = cyCount - 1 - cy;
                const clusterBaseY = superBaseY + visualCy * (activeGridH + clusterGapPt);

                const isMirroredBack = isDouble ? !renderItem.isFront : (!renderItem.isFront && settings.mirrorAlign);
                const renderBlocks = isMirroredBack ? blocks.map(b => ({
                    ...b,
                    startX: activeGridW_Full - b.startX - b.width,
                    cells: b.cells.map(c => ({...c, x: activeGridW_Full - c.x - c.width}))
                })) : blocks;
                
                const isMergedItemMode = settings.clusterMode !== 'none' && settings.clusterGapMode === 'item';

                const isMergedItemTypeMode = settings.clusterMode !== 'none' && settings.clusterDistribution === 'type';

                for (const cell of renderItem.cells) {
                    let actualSrcIndex = cell.srcIndex;

                    if (isMergedItemTypeMode) {
                        const clusterIdx = cy * cxCount + cx;
                        const logicalItemIdx = renderItem.logicalSheetIdx * (cxCount * cyCount) + clusterIdx;
                        if (logicalItemIdx >= sourceLogicalItems.length) continue;
                        const logicalItem = sourceLogicalItems[logicalItemIdx];
                        actualSrcIndex = renderItem.isFront ? logicalItem[0] : (logicalItem[1] !== -1 ? logicalItem[1] : null);
                    }

                    if (actualSrcIndex === null) continue;

                    const pageToDraw = embeddedPages[actualSrcIndex];
                    const srcDetail = srcPageDetails[actualSrcIndex];
                    if (!pageToDraw) continue;

                    const visualY = activeGridH_Full - cell.y - cell.height;
                    const xPos = clusterBaseX + cell.x;
                    const yPos = clusterBaseY + visualY;
                    
                    const actualCellW = cell.width;
                    const actualCellH = cell.height;

                    const bx = xPos - bleedPt;
                    const by = yPos - bleedPt;

                    const rawW = pageToDraw.width;
                    const rawH = pageToDraw.height;
                    let nativeAngle = 0;
                    let drawX = 0;
                    let drawY = 0;
                    
                    if (srcDetail.angle === 90) {
                        nativeAngle = -90; drawX = -rawW;
                    } else if (srcDetail.angle === 270 || srcDetail.angle === -90) {
                        nativeAngle = 90; drawY = -rawH;
                    } else if (srcDetail.angle === 180) {
                        nativeAngle = 180; drawX = -rawW; drawY = -rawH;
                    }

                    const isGuillotine = settings.markType === 'guillotine';
                    
                    const b = renderBlocks.find(x => x.id === cell.blockId)!;
                    
                    // So sánh mép của cell với mép cục bộ của Block (cụm)
                    const isTopEdge    = Math.abs(cell.y - b.startY) <= 0.01;
                    const isBottomEdge = Math.abs(cell.y + cell.height - (b.startY + b.height)) <= 0.01;
                    const isLeftEdge   = Math.abs(cell.x - b.startX) <= 0.01;
                    const isRightEdge  = Math.abs(cell.x + cell.width - (b.startX + b.width)) <= 0.01;
                    
                    const clipOffsetX = Math.min(gapX > 0 ? gapX / 2 : 0, bleedPt);
                    const clipOffsetY = Math.min(gapY > 0 ? gapY / 2 : 0, bleedPt);
                    
                    let clipLeft:   number, clipRight:  number;
                    let clipBottom: number, clipTop:    number;
                    
                    if (isGuillotine) {
                        clipLeft   = isLeftEdge   ? (xPos - bleedPt) : (xPos - clipOffsetX);
                        clipRight  = isRightEdge  ? (xPos + actualCellW + bleedPt) : (xPos + actualCellW + clipOffsetX);
                        clipBottom = isBottomEdge ? (yPos - bleedPt) : (yPos - clipOffsetY);
                        clipTop    = isTopEdge    ? (yPos + actualCellH + bleedPt) : (yPos + actualCellH + clipOffsetY);
                    } else {
                        clipLeft   = bx;
                        clipRight  = bx + actualCellW + 2 * bleedPt;
                        clipBottom = by;
                        clipTop    = by + actualCellH + 2 * bleedPt;
                    }
                    
                    const clipW = clipRight - clipLeft;
                    const clipH = clipTop - clipBottom;

                    let bxTrans = bx;
                    let byTrans = by;
                    let drawAngle = nativeAngle;
                    
                    if (cell.isRotated && (cell as any).isRotated180) {
                        if (renderItem.isFront || settings.duplexFlow !== 'double') {
                            bxTrans = bx + rawH;
                            drawAngle += 90;
                        } else {
                            byTrans = by + rawW;
                            drawAngle -= 90;
                        }
                    } else if ((cell as any).isRotated180) {
                        bxTrans = bx + rawW;
                        byTrans = by + rawH;
                        drawAngle += 180;
                    } else if (cell.isRotated) {
                        if (renderItem.isFront || settings.duplexFlow !== 'double') {
                            byTrans = by + rawW;
                            drawAngle -= 90;
                        } else {
                            bxTrans = bx + rawH;
                            drawAngle += 90;
                        }
                    }

                    outputPage.pushOperators(
                        pushGraphicsState(),
                        rectangle(clipLeft, clipBottom, clipW, clipH),
                        clip(),
                        endPath(),
                        translate(bxTrans, byTrans),
                        rotateDegrees(drawAngle)
                    );
                    outputPage.drawPage(pageToDraw, { x: drawX, y: drawY, width: rawW, height: rawH });
                    outputPage.pushOperators(popGraphicsState());
                }
                
                if (!isMergedItemMode) {
                    drawMarksNup(outputPage, settings, clusterBaseX, clusterBaseY, activeGridW, activeGridH, renderBlocks, gapX, gapY);
                    if (clusterBorder) {
                        const padding = settings.markType === 'guillotine' ? markClearance : 0;
                        outputPage.drawRectangle({
                            x: clusterBaseX - padding,
                            y: clusterBaseY - padding,
                            width: activeGridW + padding * 2,
                            height: activeGridH + padding * 2,
                            borderWidth: 0.5,
                            borderColor: cmyk(1, 1, 1, 1)
                        });
                    }
                }
            }
        }
        
        const isMergedItemMode = settings.clusterMode !== 'none' && settings.clusterGapMode === 'item';
        if (isMergedItemMode) {
            const superBlocks: any[] = [];
            for (let cy = 0; cy < cyCount; cy++) {
                for (let cx = 0; cx < cxCount; cx++) {
                    const clusterBaseX = superBaseX + cx * (activeGridW + clusterGapPt);
                    const visualCy = cyCount - 1 - cy;
                    const clusterBaseY = superBaseY + visualCy * (activeGridH + clusterGapPt);

                    const isMirroredBack = isDouble ? !renderItem.isFront : (!renderItem.isFront && settings.mirrorAlign);
                    const renderBlocks = isMirroredBack ? blocks.map(b => ({
                        ...b,
                        startX: activeGridW_Full - b.startX - b.width,
                        cells: b.cells.map(c => ({...c, x: activeGridW_Full - c.x - c.width}))
                    })) : blocks;
                    
                    const translatedBlocks = renderBlocks.map((b, idx) => ({
                        ...b,
                        id: cy * 1000 + cx * 100 + idx, // Ensure unique IDs across clusters
                        startX: Math.round(((clusterBaseX - superBaseX) + b.startX) * 1000) / 1000,
                        startY: Math.round(((clusterBaseY - superBaseY) + b.startY) * 1000) / 1000,
                    }));
                    superBlocks.push(...translatedBlocks);
                }
            }
            drawMarksNup(outputPage, settings, superBaseX, superBaseY, superGridW, superGridH, superBlocks, gapX, gapY, true);
            if (clusterBorder) {
                const padding = settings.markType === 'guillotine' ? markClearance : 0;
                outputPage.drawRectangle({
                    x: superBaseX - padding,
                    y: superBaseY - padding,
                    width: superGridW + padding * 2,
                    height: superGridH + padding * 2,
                    borderWidth: 0.5,
                    borderColor: cmyk(1, 1, 1, 1)
                });
            }
        }
    }
};
