import {describe,expect,it} from 'vitest';
import {pinNativeFallbackRaster,shouldProduceNativeFallback} from './nativeFallbackPolicy';
describe('V27 — giữ bitmap proof trước khi pause fallback',()=>{
    it('native ready sớm vẫn cho nền đầu hoàn tất; sau đó không phát request mới',()=>{
        expect(shouldProduceNativeFallback(true,true,false)).toBe(true);
        expect(shouldProduceNativeFallback(true,true,true)).toBe(false);
        expect(shouldProduceNativeFallback(true,false,true)).toBe(true);
        expect(shouldProduceNativeFallback(false,false,false)).toBe(false);
    });
    it('wheel không đổi mục tiêu nền ẩn; đổi identity hoặc trả CPU mới nhả pin',()=>{
        const first=pinNativeFallbackRaster(null,'v1',true,1)!;
        expect(pinNativeFallbackRaster(first,'v1',true,8)).toBe(first);
        expect(pinNativeFallbackRaster(first,'v2',true,2)).toEqual({identity:'v2',zoom:2});
        expect(pinNativeFallbackRaster(first,'v1',false,8)).toBeNull();
    });
});
