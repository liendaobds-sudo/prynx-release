import { planCatalog } from './desktop/src/lib/imposerEngine/CatalogPlanner';
const res = planCatalog({ totalPages: 80, bindingMode: 'saddle', hasSeparateCover: true, masterSig: 16 });
console.log(JSON.stringify(res.jobs.map(j => ({ id: j.id, label: j.label, indices: j.pageIndices })), null, 2));
