import { describe, expect, it } from 'vitest';
import { createImposerSettingsStore } from '../useImposerSettingsStore';

describe('BE.04: đơn vị bình và cách ráp phải đổi cùng nhau', () => {
  it.each(['cut_stacks','ratio_stack'] as const)('đổi %s sang Từng tem mở lại SL, không mất lượng', (layoutType) => {
    const store=createImposerSettingsStore();
    store.setState({activeDashboardTool:'sticker_imposer',impositionUnit:'page_sheet',
      taskMode:'nup',layoutType,targetQuantity:100,targetQuantitiesByPage:{0:0,1:12}});
    store.getState().setImpositionUnit('sticker');
    expect(store.getState().layoutType).toBe('sequential');
    expect(store.getState().targetQuantity).toBe(100);
    expect(store.getState().targetQuantitiesByPage).toEqual({0:0,1:12});
    expect(store.getState().toolProfiles.sticker_imposer.layoutType).toBe('sequential');
  });
  it('restore profile từng tem cũ không giữ cách ráp ẩn', () => {
    const store=createImposerSettingsStore();
    store.setState({toolProfiles:{sticker_imposer:{taskMode:'nup',layoutType:'cut_stacks',impositionUnit:'sticker'}}});
    store.getState().restoreTaskModeForTool('sticker_imposer');
    expect(store.getState().layoutType).toBe('sequential');
  });
  it('restore nguyên tấm vẫn giữ Xếp chồng đã chọn', () => {
    const store=createImposerSettingsStore();
    store.setState({toolProfiles:{sticker_imposer:{taskMode:'nup',layoutType:'cut_stacks',impositionUnit:'page_sheet'}}});
    store.getState().restoreTaskModeForTool('sticker_imposer');
    expect(store.getState().layoutType).toBe('cut_stacks');
  });
  it('đổi tab/tool không tác động profile cắt xén hoặc store tab khác', () => {
    const store=createImposerSettingsStore();
    const other=createImposerSettingsStore();
    other.setState({layoutType:'cut_stacks'});
    store.setState({activeDashboardTool:'sticker_imposer',impositionUnit:'page_sheet',
      taskMode:'nup',layoutType:'cut_stacks',toolProfiles:{nup:{taskMode:'nup',layoutType:'cut_stacks'}}});
    store.getState().setImpositionUnit('sticker');
    expect(other.getState().layoutType).toBe('cut_stacks');
    store.getState().switchToolProfile('sticker_imposer','nup');
    expect(store.getState().layoutType).toBe('cut_stacks');
  });
});
