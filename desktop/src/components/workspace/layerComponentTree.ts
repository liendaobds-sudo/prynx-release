export interface LayerTreeNode {
    id: number;
    children?: LayerTreeNode[];
}

export interface LayeredComponent {
    id: string;
    ocgIds?: number[];
}

export interface LayerComponentAssignment<T extends LayeredComponent> {
    byLayerId: Map<number, T[]>;
    unlayered: T[];
}

/**
 * Assign each current-page component to its real PDF layer.
 *
 * A nested BDC object can inherit both parent and child OCG IDs. In that case the
 * component is shown only under the deepest matching child. Memberships in unrelated
 * layers are preserved, because an OCMD may intentionally reference more than one OCG.
 */
export function assignComponentsToDeepestLayers<T extends LayeredComponent>(
    layers: LayerTreeNode[],
    components: T[],
): LayerComponentAssignment<T> {
    const displayedIds = new Set<number>();
    const ancestorsById = new Map<number, Set<number>>();

    const visit = (nodes: LayerTreeNode[], positiveAncestors: number[]) => {
        for (const node of nodes) {
            const isRealLayer = node.id > 0;
            const nextAncestors = isRealLayer
                ? [...positiveAncestors, node.id]
                : positiveAncestors;
            if (isRealLayer) {
                displayedIds.add(node.id);
                ancestorsById.set(node.id, new Set(positiveAncestors));
            }
            visit(node.children || [], nextAncestors);
        }
    };
    visit(layers, []);

    const byLayerId = new Map<number, T[]>();
    const unlayered: T[] = [];
    for (const component of components) {
        const memberships = Array.from(new Set(component.ocgIds || []))
            .filter(id => displayedIds.has(id));
        const deepest = memberships.filter(id => !memberships.some(other =>
            other !== id && (ancestorsById.get(other)?.has(id) ?? false)
        ));
        if (deepest.length === 0) {
            unlayered.push(component);
            continue;
        }
        for (const layerId of deepest) {
            const bucket = byLayerId.get(layerId) || [];
            bucket.push(component);
            byLayerId.set(layerId, bucket);
        }
    }
    return { byLayerId, unlayered };
}