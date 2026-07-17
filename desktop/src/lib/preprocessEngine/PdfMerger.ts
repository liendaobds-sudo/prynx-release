import { PDFDocument } from 'pdf-lib';
import { MergeSettings } from '../../components/preprocess-tools/MergeTool';
import { imageBytesToPdfDoc, addImagePageToDoc } from '../imageNormalizer';
import { tv } from '../../i18n';

export async function mergePdf(
    mainPdfBytes: Uint8Array | null,
    settings: MergeSettings
): Promise<Uint8Array> {
    const newPdf = await PDFDocument.create();

    if (settings.mode === 'merge_files') {
        if (!mainPdfBytes && (!settings.filesToMerge || settings.filesToMerge.length === 0)) {
            throw new Error(tv("Vui lòng chọn ít nhất 1 file để ghép."));
        }

        if (mainPdfBytes) {
            const mainPdf = await PDFDocument.load(mainPdfBytes);
            const copied = await newPdf.copyPages(mainPdf, mainPdf.getPageIndices());
            for (const page of copied) {
                newPdf.addPage(page);
            }
        }

        if (settings.filesToMerge) {
            for (const file of settings.filesToMerge) {
                const bytes = await file.arrayBuffer();
                const name = file.name.toLowerCase();
                
                if (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) {
                    await addImagePageToDoc(newPdf, bytes, file.name);
                } else {
                    const srcPdf = await PDFDocument.load(bytes);
                    const copied = await newPdf.copyPages(srcPdf, srcPdf.getPageIndices());
                    for (const page of copied) {
                        newPdf.addPage(page);
                    }
                }
            }
        }
    } else if (settings.mode === 'interleave') {
        if (!settings.oddFile || !settings.evenFile) {
            throw new Error(tv("Vui lòng chọn đủ 2 file nguồn."));
        }
        const oddBytes = await settings.oddFile.arrayBuffer();
        const evenBytes = await settings.evenFile.arrayBuffer();
        
        const loadOrConvert = async (file: File, bytes: ArrayBuffer) => {
            const name = file.name.toLowerCase();
            if (name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')) {
                return await imageBytesToPdfDoc(bytes, file.name);
            }
            return await PDFDocument.load(bytes);
        };

        const oddPdf = await loadOrConvert(settings.oddFile, oddBytes);
        const evenPdf = await loadOrConvert(settings.evenFile, evenBytes);
        
        const maxPages = Math.max(oddPdf.getPageCount(), evenPdf.getPageCount());
        
        const copiedOdd = await newPdf.copyPages(oddPdf, oddPdf.getPageIndices());
        const copiedEven = await newPdf.copyPages(evenPdf, evenPdf.getPageIndices());
        
        for (let i = 0; i < maxPages; i++) {
            if (i < copiedOdd.length) newPdf.addPage(copiedOdd[i]);
            if (i < copiedEven.length) newPdf.addPage(copiedEven[i]);
        }
    } else if (settings.mode === 'insert_pages') {
        if (!mainPdfBytes) {
            throw new Error(tv("Không tìm thấy file PDF chính đang mở."));
        }
        if (!settings.insertFile) {
            throw new Error(tv("Vui lòng chọn file chứa trang cần chèn."));
        }

        const mainPdf = await PDFDocument.load(mainPdfBytes);
        
        let insertPdf;
        const insertName = settings.insertFile.name.toLowerCase();
        const insertBytes = await settings.insertFile.arrayBuffer();
        
        if (insertName.endsWith('.jpg') || insertName.endsWith('.jpeg') || insertName.endsWith('.png')) {
            insertPdf = await imageBytesToPdfDoc(insertBytes, settings.insertFile.name);
        } else {
            insertPdf = await PDFDocument.load(insertBytes);
        }

        // Prepare pages to insert
        let insertIndices: number[] = [];
        if (settings.insertWhat === 'entire') {
            insertIndices = insertPdf.getPageIndices();
        } else {
            const start = Math.max(0, settings.insertRangeFrom - 1);
            const end = Math.min(insertPdf.getPageCount() - 1, settings.insertRangeTo - 1);
            if (start <= end) {
                for (let i = start; i <= end; i++) insertIndices.push(i);
            }
        }

        if (insertIndices.length === 0) {
            throw new Error(tv("Dải trang chèn không hợp lệ hoặc file rỗng."));
        }

        const copiedMain = await newPdf.copyPages(mainPdf, mainPdf.getPageIndices());
        const copiedInsert = await newPdf.copyPages(insertPdf, insertIndices);

        if (!settings.useIntervals) {
            // Default insert at end if no intervals used
            for (const p of copiedMain) newPdf.addPage(p);
            for (const p of copiedInsert) newPdf.addPage(p);
        } else {
            // Intervals logic
            const totalMainPages = copiedMain.length;
            let currentMainIdx = 0;
            let currentInsertIdx = 0;

            if (settings.startInserting === 'before_first') {
                // insert block right away
                const block = getNextInsertBlock(copiedInsert, settings, currentInsertIdx);
                for (const p of block.pages) newPdf.addPage(p);
                currentInsertIdx = block.nextIdx;
            } else {
                // after page N
                const afterPage = Math.max(1, settings.afterPageNum);
                for (let i = 0; i < Math.min(afterPage, totalMainPages); i++) {
                    newPdf.addPage(copiedMain[currentMainIdx++]);
                }
                const block = getNextInsertBlock(copiedInsert, settings, currentInsertIdx);
                for (const p of block.pages) newPdf.addPage(p);
                currentInsertIdx = block.nextIdx;
            }

            // now repeat
            while (currentMainIdx < totalMainPages) {
                const skip = Math.max(1, settings.skipPages);
                let skipped = 0;
                while (skipped < skip && currentMainIdx < totalMainPages) {
                    newPdf.addPage(copiedMain[currentMainIdx++]);
                    skipped++;
                }

                if (currentMainIdx < totalMainPages) {
                    // time to insert again
                    const block = getNextInsertBlock(copiedInsert, settings, currentInsertIdx);
                    if (block.pages.length === 0) {
                        // stopped, just finish main pages
                        while (currentMainIdx < totalMainPages) {
                            newPdf.addPage(copiedMain[currentMainIdx++]);
                        }
                        break;
                    }
                    for (const p of block.pages) newPdf.addPage(p);
                    currentInsertIdx = block.nextIdx;
                }
            }
        }
    }

    return newPdf.save();
}

function getNextInsertBlock(copiedInsert: any[], settings: MergeSettings, currentIdx: number): { pages: any[], nextIdx: number } {
    if (settings.repeatMode === 'entire') {
        return { pages: copiedInsert, nextIdx: currentIdx }; // nextIdx doesn't matter, we always return entire
    } else {
        const count = settings.insertPagesEachTime;
        let pagesToReturn = [];
        let newIdx = currentIdx;
        
        for (let i = 0; i < count; i++) {
            if (newIdx >= copiedInsert.length) {
                if (settings.whenFinished === 'start_again') {
                    newIdx = 0;
                } else {
                    break;
                }
            }
            pagesToReturn.push(copiedInsert[newIdx]);
            newIdx++;
        }
        return { pages: pagesToReturn, nextIdx: newIdx };
    }
}
