import { SvgNest } from 'svgnest-mjs';

const svgStr = `
<svg width="400" height="500" xmlns="http://www.w3.org/2000/svg">
  <rect id="sheet" width="320" height="450" fill="none" stroke="black"/>
  <rect id="part_1" x="0" y="0" width="50" height="100" fill="red"/>
  <rect id="part_2" x="0" y="0" width="50" height="100" fill="blue"/>
</svg>
`;

const nester = new SvgNest();
nester.config({
    curveTolerance: 0.2,
    spacing: 2,
    rotations: 4,
    populationSize: 10,
    mutationRate: 10,
});

nester.parseSvg(svgStr);
nester.setBin(document.getElementById('sheet')); // Wait, svgnest-mjs might need DOM! Let's check if it needs DOM.
