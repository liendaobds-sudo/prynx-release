// ============================================================
// DielineGallery — Thư viện biến thể khuôn bế
// [VARIANT 2026-07-29]
//
// Trước đây: 11 card cứng theo `boxType`, mỗi card kèm một form dài đầy công
// tắc — người dùng phải BIẾT TRƯỚC mình cần tích gì mới ra hộp đúng.
// Nay: card lấy từ catalog biến thể (`lib/dieline/variants.ts`), mỗi card là
// một bộ thuộc tính đã chốt. Chọn hình giống cái hộp cần là xong.
//
// Bố cục: sidebar nhóm (có đếm số) + ô tìm kiếm + lưới card.
// Nhóm CHỒNG LẤN nên tổng các nhóm lớn hơn tổng "Tất cả" — đó là đúng.
// ============================================================

import React from 'react';
import { useTranslation } from 'react-i18next';
import { tv } from '../../i18n';
import {
    BOX_GROUPS,
    BOX_VARIANTS,
    BoxGroup,
    BoxVariant,
    countByGroup,
    variantDielineSvg,
    variantMatchesQuery,
} from '../../lib/dieline/variants';
import { variantThumbOverride } from './variantThumbs';

/** Namespace i18n của tên/mô tả biến thể và tên nhóm. Ép namespace tường minh vì
 *  vài chuỗi (vd "Hộp treo có cửa sổ") còn tồn tại ở namespace gallery cũ —
 *  `tv()` không có ns sẽ chọn theo thứ tự namespace, không đơn định. */
const VARIANT_NS = 'dieline.variant';

// ─── Card ────────────────────────────────────────────────────

function GalleryCard({
    variant,
    onSelect,
}: {
    variant: BoxVariant;
    onSelect: (id: string) => void;
}) {
    // MỘT ảnh cho mỗi card. Bộ ảnh sẵn có theo boxType đã gồm CẢ nét khuôn lẫn hộp
    // 3D cạnh nhau, nên KHÔNG vẽ thêm dải khuôn riêng — làm vậy là hiện nét khuôn
    // hai lần trên cùng một card (đã thử và bị loại 2026-07-29).
    //
    // Ưu tiên ảnh THAY THỦ CÔNG trong `src/assets/dieline/variants/<mã>.png` nếu có
    // (Vite biết trước tệp nào tồn tại ⇒ KHÔNG có request 404, không nháy ảnh);
    // chưa có thì dùng khuôn 2D SVG sinh tự động — nhẹ và luôn tồn tại.
    const [imgFailed, setImgFailed] = React.useState(false);
    const src = imgFailed
        ? null
        : variantThumbOverride(variant.code) ?? variantDielineSvg(variant);

    return (
        <button
            className="dt-gallery-card"
            onClick={() => onSelect(variant.id)}
            title={`${tv(variant.nameVi, VARIANT_NS)} — ${variant.code}`}
        >
            <div className="dt-gallery-card-header">
                <h3 className="dt-gallery-card-title">{tv(variant.nameVi, VARIANT_NS)}</h3>
                <p className="dt-gallery-card-desc">{tv(variant.descVi, VARIANT_NS)}</p>
            </div>

            <div className="dt-gallery-card-preview">
                {src === null ? (
                    <div className="dt-gallery-card-placeholder">
                        <span className="dt-gallery-card-placeholder-icon" aria-hidden="true">📦</span>
                        <span className="dt-gallery-card-placeholder-code">{variant.code}</span>
                    </div>
                ) : (
                    <img
                        key={src}
                        src={src}
                        alt={tv(variant.nameVi, VARIANT_NS)}
                        className="dt-gallery-card-img"
                        draggable={false}
                        loading="lazy"
                        onError={() => setImgFailed(true)}
                    />
                )}
                <div className="dt-gallery-card-overlay" />
            </div>

            <span className="dt-gallery-card-code">{variant.code}</span>
        </button>
    );
}

// ─── Sidebar nhóm ────────────────────────────────────────────

function GroupSidebar({
    active,
    counts,
    total,
    onPick,
}: {
    active: BoxGroup | 'all';
    counts: Record<BoxGroup, number>;
    total: number;
    onPick: (g: BoxGroup | 'all') => void;
}) {
    const { t } = useTranslation();
    return (
        <nav className="dt-gallery-sidebar" aria-label={t('dieline.dielineGallery:nhom_khuon')}>
            <p className="dt-gallery-sidebar-label">{t('dieline.dielineGallery:nhom_khuon')}</p>
            <ul className="dt-gallery-group-list">
                <li>
                    <button
                        className={`dt-gallery-group-btn ${active === 'all' ? 'active' : ''}`}
                        onClick={() => onPick('all')}
                        aria-current={active === 'all'}
                    >
                        <span>{t('dieline.dielineGallery:tat_ca')}</span>
                        <span className="dt-gallery-group-count">{total}</span>
                    </button>
                </li>
                {BOX_GROUPS.map((g) => (
                    <li key={g.id}>
                        <button
                            className={`dt-gallery-group-btn ${active === g.id ? 'active' : ''}`}
                            onClick={() => onPick(g.id)}
                            aria-current={active === g.id}
                            title={g.nameEn}
                        >
                            <span>{tv(g.nameVi, VARIANT_NS)}</span>
                            <span className="dt-gallery-group-count">{counts[g.id]}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </nav>
    );
}

// ─── Gallery ─────────────────────────────────────────────────

interface DielineGalleryProps {
    /** Nhận `variant.id` — KHÔNG phải boxType. Store tự suy boxType từ biến thể. */
    onSelect: (variantId: string) => void;
}

export default function DielineGallery({ onSelect }: DielineGalleryProps) {
    const { t } = useTranslation();
    const [group, setGroup] = React.useState<BoxGroup | 'all'>('all');
    const [query, setQuery] = React.useState('');

    // Catalog ~21 mục: lọc thẳng, không cần memo hoá phức tạp hay virtual list.
    const counts = countByGroup();
    const visible = BOX_VARIANTS.filter(
        (v) => (group === 'all' || v.groups.includes(group)) && variantMatchesQuery(v, query),
    );

    const resetFilters = () => {
        setGroup('all');
        setQuery('');
    };

    return (
        <div className="dt-gallery">
            <header className="dt-gallery-header">
                <div className="dt-gallery-header-text">
                    <h1 className="dt-gallery-title">
                        <span className="dt-gallery-title-icon">📦</span>
                        {t('dieline.dielineGallery:khuon_be_bao_bi')}
                    </h1>
                    <p className="dt-gallery-subtitle">
                        {t('dieline.dielineGallery:chon_loai_khuon_bao_bi_de_bat_dau_thiet')}
                    </p>
                </div>
                <div className="dt-gallery-search">
                    <span className="dt-gallery-search-icon" aria-hidden="true">🔍</span>
                    <input
                        type="search"
                        className="dt-gallery-search-input"
                        placeholder={t('dieline.dielineGallery:tim_theo_ten_ma_khuon_hoac_nhom')}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-label={t('dieline.dielineGallery:tim_theo_ten_ma_khuon_hoac_nhom')}
                    />
                </div>
            </header>

            <div className="dt-gallery-body">
                <GroupSidebar
                    active={group}
                    counts={counts}
                    total={BOX_VARIANTS.length}
                    onPick={setGroup}
                />

                {visible.length === 0 ? (
                    <div className="dt-gallery-empty">
                        <p className="dt-gallery-empty-text">
                            {t('dieline.dielineGallery:khong_tim_thay_khuon_nao_phu_hop')}
                        </p>
                        <button className="dt-gallery-empty-btn" onClick={resetFilters}>
                            {t('dieline.dielineGallery:xem_tat_ca')}
                        </button>
                    </div>
                ) : (
                    <div className="dt-gallery-grid">
                        {visible.map((v) => (
                            <GalleryCard key={v.id} variant={v} onSelect={onSelect} />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
