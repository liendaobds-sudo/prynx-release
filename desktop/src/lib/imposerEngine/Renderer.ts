// src/lib/imposerEngine/Renderer.ts
import { PDFDocument, cmyk, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, translate, rotateDegrees, scale } from 'pdf-lib';
import { VirtualSheet } from './VirtualMap';
import type { GuillotineSettings, OffsetSettings } from './SettingsTypes';
export type BookletSettings = GuillotineSettings | OffsetSettings;
import { GeometricContext, solvePageTransform } from './GeometricSolver';
import { drawRegistrationMarks } from './MarksRenderer';
import i18n from '../../i18n';

const MM_TO_POINTS = 2.83465;

export const drawSpreadMarks = (
    outputPage: any,
    leftTrimBox: { x: number; y: number; width: number; height: number },
    rightTrimBox: { x: number; y: number; width: number; height: number },
    sheetWidth: number,
    sheetHeight: number,
    settings?: any
) => {
    const markLength = ((settings?.markLength ?? 5.0) * MM_TO_POINTS);
    const markOffset = ((settings?.markOffset ?? 3.0) * MM_TO_POINTS);
    const markThickness = ((settings?.markThickness ?? 0.25) * MM_TO_POINTS);

    const drawL = (x1: number, y1: number, x2: number, y2: number, color: any) => {
        outputPage.drawLine({start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness: markThickness, color});
    };
    
    const trimColor = cmyk(1, 1, 1, 1); // Registration (mọi kẽm), không dùng RGB

    const drawBoxMarks = (box: { x: number, y: number, width: number, height: number }) => {
        const right = box.x + box.width;
        const top = box.y + box.height;
        // TL
        drawL(box.x, top + markOffset, box.x, top + markOffset + markLength, trimColor);
        drawL(box.x - markOffset, top, box.x - markOffset - markLength, top, trimColor);
        // TR
        drawL(right, top + markOffset, right, top + markOffset + markLength, trimColor);
        drawL(right + markOffset, top, right + markOffset + markLength, top, trimColor);
        // BL
        drawL(box.x, box.y - markOffset, box.x, box.y - markOffset - markLength, trimColor);
        drawL(box.x - markOffset, box.y, box.x - markOffset - markLength, box.y, trimColor);
        // BR
        drawL(right, box.y - markOffset, right, box.y - markOffset - markLength, trimColor);
        drawL(right + markOffset, box.y, right + markOffset + markLength, box.y, trimColor);
    };
    
    // Spread Distribution
    const spreadDistribution = (settings as any)?.spreadDistribution || 'clustered';
    const bMode = (settings as any)?.bindingMode;
    const isFoldable = bMode === 'saddle' || bMode === 'thread';
    const spineGap = settings?.gapX || 0;
    const drawIndividual = spreadDistribution === 'even' || spineGap > 0;

    if (drawIndividual) {
        // Draw individual crop marks for both pages
        if (leftTrimBox.width > 0) drawBoxMarks(leftTrimBox);
        if (rightTrimBox.width > 0) drawBoxMarks(rightTrimBox);
        
        // Also draw the center cut mark to halve the sheet based on precise box positioning
        const centerX = (leftTrimBox.width > 0 && rightTrimBox.width > 0)
            ? (leftTrimBox.x + leftTrimBox.width + rightTrimBox.x) / 2
            : sheetWidth / 2;
        const top = Math.max(
            leftTrimBox.width > 0 ? leftTrimBox.y + leftTrimBox.height : 0,
            rightTrimBox.width > 0 ? rightTrimBox.y + rightTrimBox.height : 0
        );
        const bottom = Math.min(
            leftTrimBox.width > 0 ? leftTrimBox.y : Infinity,
            rightTrimBox.width > 0 ? rightTrimBox.y : Infinity
        );
        
        if (top > 0 && bottom !== Infinity) {
            const centerMarkColor = isFoldable ? cmyk(0, 1, 1, 0) : trimColor;
            drawL(centerX, top + markOffset, centerX, top + markOffset + markLength, centerMarkColor);
            drawL(centerX, bottom - markOffset, centerX, bottom - markOffset - markLength, centerMarkColor);
        }
    } else {
        const spreadTrimBox = {
            x: leftTrimBox.x,
            y: leftTrimBox.y,
            width: rightTrimBox.x + rightTrimBox.width - leftTrimBox.x,
            height: leftTrimBox.height,
        };
        drawBoxMarks(spreadTrimBox);
        
        const top = spreadTrimBox.y + spreadTrimBox.height;
        const bottom = spreadTrimBox.y;

        // Center spine mark: Red = fold (saddle/thread), Black = slit/cut (continuous/cut_stacks)
        const spineColor = isFoldable ? cmyk(0, 1, 1, 0) : trimColor;
        const centerX = sheetWidth / 2;

        drawL(centerX, top + markOffset, centerX, top + markOffset + markLength, spineColor);
        drawL(centerX, bottom - markOffset, centerX, bottom - markOffset - markLength, spineColor);
    }
};

export const renderBooklet = async (
    virtualMap: VirtualSheet[],
    embeddedPages: any[],
    srcPageDetails: any[],
    context: GeometricContext,
    outputPdf: PDFDocument,
    bleedPt: number,
    paperThicknessPt: number,
    isSaddleOrThread: boolean,
    markType: 'none' | 'corners' | 'guillotine' | undefined,
    interleaveMode: 'normal' | 'all_fronts_first' | 'reverse_backs' | 'reverse_backs_180',
    setStatus: (msg: string) => void,
    settings?: BookletSettings,
    gutterPt: number = 0
) => {
    
    // Flatten iteration plan based on Interleave Mode
    const surfaces: { sheetIndex: number, isFront: boolean, slots: any, sheet: VirtualSheet }[] = [];
    const isSingleSided = settings?.bindingMode === 'flush_mount';
    
    if (interleaveMode === 'normal' || isSingleSided) {
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: true, slots: sheet.front, sheet });
            if (!isSingleSided) {
                surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: false, slots: sheet.back, sheet });
            }
        }
    } else if (interleaveMode === 'all_fronts_first') {
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: true, slots: sheet.front, sheet });
        }
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: false, slots: sheet.back, sheet });
        }
    } else if (interleaveMode === 'reverse_backs' || interleaveMode === 'reverse_backs_180') {
        for (const sheet of virtualMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: true, slots: sheet.front, sheet });
        }
        const reversedMap = [...virtualMap].reverse();
        for (const sheet of reversedMap) {
            surfaces.push({ sheetIndex: sheet.sheetIndex, isFront: false, slots: sheet.back, sheet });
        }
    }

    let currentRenderIndex = 0;
    
    for (const surface of surfaces) {
        currentRenderIndex++;
        const { sheetIndex, isFront, slots, sheet } = surface;
        
        const sideLabel = isFront ? i18n.t('lib.renderer:mat_truoc') : i18n.t('lib.renderer:mat_sau');
        setStatus(i18n.t('lib.renderer:dang_render_mat_isfront_truoc_sau_to', { side: sideLabel, sheet: sheetIndex + 1, current: currentRenderIndex, total: surfaces.length }));
        
        const outputPage = outputPdf.addPage([context.finalSheetWidth, context.finalSheetHeight]);

            const trimBoxes: any[] = [];

            for (const pos of ['left', 'right']) {
                const isLeft = pos === 'left';
                const slot = isLeft ? slots.left : slots.right;

                const effSheetIndex = sheet.sigLocalIndex ?? sheetIndex;
                const effTotalSheets = sheet.sigTotalSheets ?? virtualMap.length;

                const isCutStackSpread = settings?.bindingMode === 'cut_stacks';
                // Phase 1 (booklet spread creation): ALWAYS use clustered + no spine gap.
                // Pages must be flush at the spine for folding/stapling.
                // gapX and spreadDistribution only apply to Phase 2 (SpreadPlacer on press sheet).
                const spineGapPt = 0;
                const distribution = 'clustered';


                const transform = solvePageTransform(
                    context,
                    isLeft,
                    isFront,
                    effSheetIndex,
                    effTotalSheets,
                    bleedPt,
                    paperThicknessPt,
                    isSaddleOrThread,
                    gutterPt,
                    isCutStackSpread,
                    spineGapPt,
                    distribution,
                    settings?.bindingMode === 'saddle'
                );

                trimBoxes.push(transform.trimBox);

                if (slot.srcIndex !== null && slot.srcIndex < embeddedPages.length) {
                    const pageToDraw = embeddedPages[slot.srcIndex];
                    const srcDetail = srcPageDetails[slot.srcIndex];

                    if (!pageToDraw) {
                        // dummy
                        continue;
                    }

                    let nativeAngle = 0;
                    let drawX = 0; let drawY = 0;
                    const rawW = pageToDraw.width;
                    const rawH = pageToDraw.height;

                    if (srcDetail.angle === 90) { nativeAngle = -90; drawX = -rawW; }
                    else if (srcDetail.angle === 270 || srcDetail.angle === -90) { nativeAngle = 90; drawY = -rawH; }
                    else if (srcDetail.angle === 180) { nativeAngle = 180; drawX = -rawW; drawY = -rawH; }

                    const isCutStackSpread = settings?.bindingMode === 'cut_stacks';
                    const distribution = (settings as any)?.spreadDistribution || 'clustered';
                    const isHutGay = distribution !== 'even';
                    const isRightStack = isFront ? !isLeft : isLeft;
                    const shouldRotateCutStack = isCutStackSpread && isHutGay && isRightStack;

                    const is180 = (interleaveMode === 'reverse_backs_180' && !isFront) !== shouldRotateCutStack;

                    outputPage.pushOperators(
                        pushGraphicsState(),
                        rectangle(transform.clipX, transform.clipY, transform.clipW, transform.clipH),
                        clip(),
                        endPath(),
                        translate(transform.rawX, transform.rawY)
                    );

                    if (is180) {
                        outputPage.pushOperators(
                            translate(context.actualDrawnWidth / 2, context.actualDrawnHeight / 2),
                            rotateDegrees(180),
                            translate(-context.actualDrawnWidth / 2, -context.actualDrawnHeight / 2)
                        );
                    }

                    outputPage.pushOperators(
                        scale(transform.scale, transform.scale), // APPLIED AUTO-SCALE HERE
                        rotateDegrees(nativeAngle)
                    );
                    outputPage.drawPage(pageToDraw, { x: drawX, y: drawY, width: rawW, height: rawH });
                    outputPage.pushOperators(popGraphicsState());
                }
            }

            if (markType && markType !== 'none' && trimBoxes[0] && trimBoxes[1]) {
                drawSpreadMarks(outputPage, trimBoxes[0], trimBoxes[1], context.finalSheetWidth, context.finalSheetHeight, settings);

                // Registration marks for fit mode (sheet larger than spread)
                const spreadArea = (trimBoxes[1].x + trimBoxes[1].width - trimBoxes[0].x) * trimBoxes[0].height;
                const sheetArea = context.finalSheetWidth * context.finalSheetHeight;
                if (sheetArea > spreadArea * 1.1) {
                    const gridX = trimBoxes[0].x;
                    const gridY = trimBoxes[0].y;
                    const gridW = trimBoxes[1].x + trimBoxes[1].width - trimBoxes[0].x;
                    const gridH = trimBoxes[0].height;
                    const mmToPt = 2.83465;
                    const markLen = (settings as any)?.markLength ?? 5;
                    const markOff = (settings as any)?.markOffset ?? 3;
                    const offsetPt = (((settings as any)?.bleed || 0) + markLen + markOff + 2) * mmToPt;
                    drawRegistrationMarks(outputPage, context.finalSheetWidth, context.finalSheetHeight, gridX, gridY, gridW, gridH, offsetPt);
                }
            }
    }
};
