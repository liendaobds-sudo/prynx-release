// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createImposerSettingsStore, ImposerSettingsContext } from '../useImposerSettingsStore';
import GridSettingsSection, { type GridSettingsProps } from './GridSettingsSection';

afterEach(() => { cleanup(); localStorage.clear(); });
const noop = () => {};
function Harness({ initial = 3, pageSheet = false, cutStacks = false, tool = 'sticker_imposer', pages = 72 }: {
  initial?: number; pageSheet?: boolean; cutStacks?: boolean; tool?: 'sticker_imposer' | 'nup'; pages?: number;
}) {
  const [store] = React.useState(() => {
    const settings = createImposerSettingsStore();
    settings.setState({
      activeDashboardTool: tool, impositionUnit: pageSheet ? 'page_sheet' : 'sticker',
      layoutType: cutStacks ? 'cut_stacks' : 'sequential', taskMode: 'nup',
    });
    return settings;
  });
  const [quantity, setQuantity] = React.useState(initial);
  const [quantities, setQuantities] = React.useState<Record<number, number>>({ 0: 5 });
  const props: GridSettingsProps = {
    activeTool: tool, taskMode: 'nup', setTaskMode: noop,
    showImpositionUnitSelector: true,
    duplexFlow: 'normal', setDuplexFlow: noop, gridStrategy: 'simple_auto', setGridStrategy: noop,
    targetQuantity: quantity, setTargetQuantity: setQuantity,
    targetQuantitiesByPage: quantities, setTargetQuantitiesByPage: setQuantities,
    sourceTotalPages: pages, previewCapacity: 20, columns: 0, setColumns: noop, rows: 0, setRows: noop,
    gapX: 2, setGapX: noop, gapY: 2, setGapY: noop, showGapSettings: false, setShowGapSettings: noop,
    detectedShapesByPage: {}, setDetectedShapesByPage: noop, viewerActivePage: 1, viewerPageOrder: null,
  };
  return <ImposerSettingsContext.Provider value={store}><GridSettingsSection {...props} />
    <output data-testid="quantities">{JSON.stringify(quantities)}</output>
  </ImposerSettingsContext.Provider>;
}
it('không còn trường Mục đích', () => {
  render(<Harness />);
  expect(screen.queryByTestId('sticker-order-purpose')).toBeNull();
  expect(screen.queryByText('MỤC ĐÍCH')).toBeNull();
});
it('cho phép để trống SL, hiện hướng dẫn một mẫu mỗi loại, không mất SL riêng', () => {
  render(<Harness />);
  fireEvent.change(screen.getByTestId('global-imposition-quantity'), { target: { value: '' } });
  const input = screen.getByTestId('global-imposition-quantity') as HTMLInputElement;
  expect(input.value).toBe('');
  expect(input.disabled).toBe(false);
  expect(input.placeholder).toBe('Trống = 1 mẫu mỗi loại');
  expect(screen.getByTestId('quantities').textContent).toBe('{"0":5}');
});
it('SL nhập trực tiếp không cần đổi chế độ', () => {
  render(<Harness initial={0} />);
  fireEvent.change(screen.getByTestId('global-imposition-quantity'), { target: { value: '12' } });
  expect((screen.getByTestId('global-imposition-quantity') as HTMLInputElement).value).toBe('12');
});

it.each([[70, 10], [72, 8], [80, 0]])('nguyên tấm xếp chồng %s trang hiện rõ %s bản in bù', (pages, extra) => {
  render(<Harness pageSheet cutStacks pages={pages} />);
  expect(screen.getByTestId('cut-stack-fill-summary').textContent).toBe(`Tổng: 80 bản, gồm ${extra} bản in bù.`);
  expect(screen.getByText(/Xếp chồng lấp kín mọi tờ/)).toBeTruthy();
  expect(screen.queryByText(/Xếp chồng dùng mỗi trang PDF đúng một lần/)).toBeNull();
  expect((screen.getByTestId('global-imposition-quantity') as HTMLInputElement).disabled).toBe(true);
});

it('cắt xén xếp chồng vẫn giữ đúng một lần và không hiện in bù', () => {
  render(<Harness cutStacks tool="nup" />);
  expect(screen.queryByTestId('cut-stack-fill-summary')).toBeNull();
  expect(screen.getByText(/Xếp chồng dùng mỗi trang PDF đúng một lần/)).toBeTruthy();
});

it('nguyên tấm xếp lần lượt không tự bật in bù', () => {
  render(<Harness pageSheet />);
  expect(screen.queryByTestId('cut-stack-fill-summary')).toBeNull();
  expect(screen.queryByText(/Xếp chồng lấp kín mọi tờ/)).toBeNull();
});

it('đổi nguyên tấm Xếp chồng sang Từng tem mở lại SL và giữ số đã nhập', () => {
  render(<Harness pageSheet cutStacks initial={100}/>);
  const selector=(screen.getAllByRole('combobox') as HTMLSelectElement[])
    .find(node=>Array.from(node.options).some(option=>option.value==='page_sheet'))!;
  fireEvent.change(selector,{target:{value:'sticker'}});
  const input=screen.getByTestId('global-imposition-quantity') as HTMLInputElement;
  expect(input.disabled).toBe(false);
  expect(input.value).toBe('100');
  expect(screen.queryByText(/Xếp chồng dùng mỗi trang PDF đúng một lần/)).toBeNull();
});
