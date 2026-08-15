// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import SplitTool from './SplitTool';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('SplitTool', () => {
  it('chỉ phát pagesPerFile nguyên và không nhỏ hơn 1', () => {
    const onChange = vi.fn();
    render(<SplitTool
      settings={{ mode: 'by_count', ranges: '', pagesPerFile: 2, pageListStr: '' }}
      onChange={onChange}
    />);

    const input = screen.getByRole('spinbutton');
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('step')).toBe('1');

    fireEvent.change(input, { target: { value: '3.8' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ pagesPerFile: 3 }));
  });
});
