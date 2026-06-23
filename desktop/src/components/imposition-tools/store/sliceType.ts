import type { StateCreator } from 'zustand';
import type { ImposerSettingsState } from './types';

/**
 * Kiểu chung cho mọi slice của store. State tổng là PHẲNG (giao của các slice),
 * nên mỗi slice nhận `set/get` của toàn store và chỉ định nghĩa phần của mình.
 */
export type ImposerSlice<T> = StateCreator<ImposerSettingsState, [], [], T>;
