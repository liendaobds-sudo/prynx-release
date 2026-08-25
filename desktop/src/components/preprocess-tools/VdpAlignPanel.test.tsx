// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SetVdpFields, VdpToolField } from '../../hooks/useVdpTool';
import { VdpAlignPanel } from './VdpAlignPanel';

vi.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

function renderPanel(fields: VdpToolField[], selectedFieldIds: string[]) {
    let current = fields;
    const setVdpFields = vi.fn<SetVdpFields>((updater) => {
        current = typeof updater === 'function' ? updater(current) : updater;
    });
    render(
        <VdpAlignPanel
            vdpFields={fields}
            setVdpFields={setVdpFields}
            selectedFieldIds={selectedFieldIds}
        />,
    );
    return { getCurrent: () => current, setVdpFields };
}

describe('VdpAlignPanel — contract field VDP', () => {
    it('căn trái theo bounding box của nhóm', () => {
        const { getCurrent, setVdpFields } = renderPanel([
            { id: 'a', name: 'A', x: 12, y: 4, width: 10, height: 5 },
            { id: 'b', name: 'B', x: 30, y: 8, width: 6, height: 4 },
            { id: 'other', name: 'Other', x: 99, y: 99, width: 3, height: 3 },
        ], ['a', 'b']);

        fireEvent.click(screen.getByTitle('preprocess.vdpAlign:can_trai'));

        expect(setVdpFields).toHaveBeenCalledTimes(1);
        expect(getCurrent()).toMatchObject([
            { id: 'a', x: 12 },
            { id: 'b', x: 12 },
            { id: 'other', x: 99 },
        ]);
    });

    it('phân bố field hợp lệ và field thiếu tọa độ không tạo NaN', () => {
        const { getCurrent } = renderPanel([
            { id: 'a', name: 'A', x: 0, y: 0, width: 10, height: 5 },
            { id: 'b', name: 'B', x: 20, y: 0, width: 10, height: 5 },
            { id: 'c', name: 'C', y: 0, width: 10, height: 5 },
        ], ['a', 'b', 'c']);

        fireEvent.click(screen.getByTitle('preprocess.vdpAlign:dan_deu_theo_chieu_ngang'));

        const selected = getCurrent().filter(field => ['a', 'b', 'c'].includes(field.id));
        expect(selected.every(field => typeof field.x === 'number' && Number.isFinite(field.x))).toBe(true);
    });
});
