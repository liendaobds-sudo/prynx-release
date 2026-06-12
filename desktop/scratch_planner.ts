function padTo4(num) {
    while (num % 4 !== 0) num++;
    return num;
}

function routeSaddleBinding(
    bodyPageIndices,
    masterSig
) {
    const P = bodyPageIndices.length;
    const P_padded = padTo4(P);

    const mainSigCount = Math.floor(P_padded / masterSig);
    const remainder = P_padded % masterSig;

    const mainJobs = [];
    const remainderJobs = [];

    const paddedIndices = [];
    for (let i = 0; i < P_padded; i++) {
        paddedIndices.push(i < P ? bodyPageIndices[i] : -1);
    }

    // Two pointers: front and back
    let front = 0;
    let back = P_padded - 1;

    // Helper to grab N symmetric pages from the current front/back
    // For Saddle Stitch, we grab N/2 from front and N/2 from back.
    // We return them such that the "front" pages come first and the "back" pages come second,
    // which aligns perfectly with VirtualMap.ts folding logic.
    function grabSymmetricIndices(n) {
        const half = n / 2;
        const frontPages = [];
        const backPages = [];
        
        for (let i = 0; i < half; i++) {
            frontPages.push(paddedIndices[front++]);
        }
        for (let i = 0; i < half; i++) {
            // Unshift because we are iterating down from the back, but we want the back pages
            // to be in ascending order relative to their indices in the array.
            // Wait, frontPages: [0, 1, 2, 3]
            // If back starts at 75...
            // the pages are 75, 74, 73, 72.
            // Do we want backPages to be [72, 73, 74, 75]?
            // Yes! Because standard VirtualMap expects a sequential monotonically increasing array of logic indices.
            backPages.unshift(paddedIndices[back--]);
        }
        
        return [...frontPages, ...backPages];
    }

    // 1. Remainder Jobs (Outermost)
    if (remainder > 0) {
        if (remainder <= 8) {
            remainderJobs.push({ pageIndices: grabSymmetricIndices(remainder), sigSize: remainder });
        } else {
            // Remainder 12: Tay 4 + Tay 8
            // Tay 4 is outermost!
            remainderJobs.push({ pageIndices: grabSymmetricIndices(4), sigSize: 4 });
            remainderJobs.push({ pageIndices: grabSymmetricIndices(8), sigSize: 8 });
        }
    }

    // 2. Main Jobs (Working inwards to the core)
    // VirtualMap expects them in order? The order they are pushed into the jobs array
    // is the order the physical plates are printed. It doesn't really matter.
    // But working from OUTSIDE to INSIDE is conceptually simple.
    for (let g = 0; g < mainSigCount; g++) {
        // The last job built this way will be the Core, because front and back pointers converge.
        mainJobs.push({ pageIndices: grabSymmetricIndices(masterSig), sigSize: masterSig });
    }

    return { mainJobs, remainderJobs };
}

// TEST 76 pages (body of a 80 page book)
const p76 = Array.from({length: 76}, (_, i) => i + 2); // 2..77
const r1 = routeSaddleBinding(p76, 16);
console.log("TEST 76 pages:");
console.log("REMAIN", r1.remainderJobs.map(j => `SigSize: ${j.sigSize}, Indices: ${j.pageIndices}`));
console.log("MAIN", r1.mainJobs.map(j => `SigSize: ${j.sigSize}, Indices: ${j.pageIndices}`));
