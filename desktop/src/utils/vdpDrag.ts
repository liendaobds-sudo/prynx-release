export const startVdpDrag = (
    e: React.PointerEvent, 
    vdpType: string, 
    label: string, 
    defaultTextContent?: string, 
    defaultName?: string
) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Create ghost element
    const ghost = document.createElement('div');
    ghost.id = 'vdp-ghost';
    ghost.textContent = label;
    ghost.className = 'fixed z-[99999] pointer-events-none bg-blue-600 text-white px-3 py-1.5 rounded shadow-lg text-xs font-bold opacity-90 border border-white/20 flex items-center justify-center';
    ghost.style.left = (e.clientX + 10) + 'px';
    ghost.style.top = (e.clientY + 10) + 'px';
    ghost.style.transform = 'scale(1.05)';
    ghost.style.transition = 'transform 0.1s';
    document.body.appendChild(ghost);

    const onMove = (me: PointerEvent) => {
        ghost.style.left = (me.clientX + 10) + 'px';
        ghost.style.top = (me.clientY + 10) + 'px';
    };

    const onUp = (ue: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        ghost.style.transform = 'scale(0.9)';
        ghost.style.opacity = '0';
        setTimeout(() => ghost.remove(), 150);
        
        const target = document.elementFromPoint(ue.clientX, ue.clientY);
        if (target) {
            const customEvent = new CustomEvent('vdp-drop', { 
                detail: { 
                    type: vdpType, 
                    clientX: ue.clientX, 
                    clientY: ue.clientY, 
                    target,
                    textContent: defaultTextContent,
                    name: defaultName
                } 
            });
            window.dispatchEvent(customEvent);
        }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
};
