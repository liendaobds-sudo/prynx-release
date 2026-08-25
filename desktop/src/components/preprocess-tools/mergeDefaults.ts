import type { MergeSettings } from './MergeTool';

/**
 * Cấu hình khởi tạo cho công cụ ghép PDF.
 *
 * Tách khỏi component để Fast Refresh chỉ cần theo dõi export component trong
 * MergeTool.tsx; giá trị và kiểu vẫn giữ nguyên hợp đồng hiện tại.
 */
export const defaultMergeSettings: MergeSettings = {
    mode: 'merge_files',
    filesToMerge: [],
    oddFile: null,
    evenFile: null,
    insertFile: null,
    insertWhat: 'entire',
    insertRangeFrom: 1,
    insertRangeTo: 1,
    useIntervals: false,
    startInserting: 'after_page',
    afterPageNum: 1,
    skipPages: 1,
    repeatMode: 'pages',
    insertPagesEachTime: 1,
    whenFinished: 'stop',
};