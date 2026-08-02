import { describe, expect, it } from 'vitest';
import {
    buildResultTabPayload,
    partitionIncomingFiles,
    planIncomingFiles,
    registerActiveTabFeature,
    resolveActiveDedicatedReceiver,
    resolveActiveImageBatchReceiver,
} from './tabNavigation';

describe('điều hướng đa tab', () => {
    const tabs = [
        { id: 'pdf', type: 'imposition', payload: { file: 'a.pdf' } },
        { id: 'tach-nen', type: 'imposition', payload: { focusFeature: 'bgremover' } },
        { id: 'phong-to', type: 'imposition', payload: { focusFeature: 'upscale' } },
    ];

    it('không gửi file vào công cụ chuyên dụng đang nằm ở tab nền', () => {
        expect(resolveActiveDedicatedReceiver(tabs, 'pdf', 'bgremover')).toBeNull();
    });

    it('chỉ gửi file vào đúng tab chuyên dụng đang active', () => {
        expect(resolveActiveDedicatedReceiver(tabs, 'tach-nen', 'bgremover')).toBe('tach-nen');
    });

    it('định tuyến ảnh native vào đúng tab Upscale đang active', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'phong-to')).toEqual({
            tabId: 'phong-to',
            feature: 'upscale',
            eventName: 'prynx-upscale-add-files',
        });
    });

    it('không để tab công cụ ảnh ở nền hút file kéo-thả', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'pdf')).toBeNull();
    });

    it('giữ nguyên tuyến kéo-thả của Tách nền', () => {
        expect(resolveActiveImageBatchReceiver(tabs, 'tach-nen')).toEqual({
            tabId: 'tach-nen',
            feature: 'bgremover',
            eventName: 'prynx-bgremover-add-files',
        });
    });

    it('dung cong cu dang hien thi thay vi intent cu luc mo tab', () => {
        const genericTabs = [
            { id: 'pdf-runtime', type: 'imposition', payload: { file: 'a.pdf' } },
        ];
        const unregister = registerActiveTabFeature('pdf-runtime', 'upscale');
        try {
            expect(resolveActiveImageBatchReceiver(genericTabs, 'pdf-runtime')).toEqual({
                tabId: 'pdf-runtime',
                feature: 'upscale',
                eventName: 'prynx-upscale-add-files',
            });
        } finally {
            unregister();
        }
    });

    it('khong roi ve intent Upscale cu sau khi da chuyen sang cong cu khac', () => {
        const unregister = registerActiveTabFeature('phong-to', 'pages');
        try {
            expect(resolveActiveImageBatchReceiver(tabs, 'phong-to')).toBeNull();
        } finally {
            unregister();

        }
    });
    it('tách tất cả PDF để shell mở mỗi file thành một tab mới', () => {
        const files = [
            { name: '01_bia.PDF' },
            { name: 'du_lieu.xlsx' },
            { name: 'anh.png' },
            { name: '02_ruot.pdf' },
        ];

        expect(partitionIncomingFiles(files)).toEqual({
            pdfFiles: [files[0], files[3]],
            officeFiles: [files[1]],
            otherFiles: [files[2]],
        });
    });

    it('PDF không rơi vào nhóm công cụ ảnh dù đang thả cùng ảnh', () => {
        const result = partitionIncomingFiles([
            { name: 'tai_lieu.pdf' },
            { name: 'preview.jpg' },
        ]);
        expect(result.pdfFiles.map(file => file.name)).toEqual(['tai_lieu.pdf']);
        expect(result.otherFiles.map(file => file.name)).toEqual(['preview.jpg']);
    });

    it('khong dinh tuyen vao registry stale cua tab da dong', () => {
        const unregister = registerActiveTabFeature('tab-da-dong', 'upscale');
        try {
            expect(resolveActiveImageBatchReceiver(tabs, 'tab-da-dong')).toBeNull();
        } finally {
            unregister();
        }
    });

    it('tab kết quả không tự kế thừa chế độ khóa của tab cha', () => {
        expect(buildResultTabPayload('result.pdf')).toEqual({ file: 'result.pdf' });
        expect(buildResultTabPayload('result.pdf', { lockedMode: 'nup' })).toEqual({
            file: 'result.pdf',
            lockedMode: 'nup',
        });
    });
    it('intent Combine giữ nguyên toàn bộ PDF và ảnh trong một batch', () => {
        const files = [
            { name: '01_bia.pdf' },
            { name: '02_ruot.PDF' },
            { name: '03_minh-hoa.png' },
        ];

        expect(planIncomingFiles(files, 'combine')).toEqual({
            mode: 'combine',
            files,
        });
    });

    it('không có intent Combine vẫn giữ quy tắc mở PDF kiểu Acrobat', () => {
        const files = [
            { name: 'tai-lieu.pdf' },
            { name: 'anh.jpg' },
        ];

        expect(planIncomingFiles(files, '')).toEqual({
            mode: 'default',
            pdfFiles: [files[0]],
            officeFiles: [],
            otherFiles: [files[1]],
        });
    });

});