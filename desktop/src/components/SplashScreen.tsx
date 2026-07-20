import { useEffect, useLayoutEffect, useRef } from 'react';
import './SplashScreen.css';

/**
 * PRYNX brand intro — ported from prynx-logo-animation/index.html
 * Pure CSS + path prep (no GSAP CDN; works offline in Tauri).
 */
export default function SplashScreen() {
  const svgRef = useRef<SVGSVGElement>(null);

  useLayoutEffect(() => {
    const root = svgRef.current;
    if (!root) return;
    root.querySelectorAll<SVGGeometryElement>('.draw-path').forEach((path) => {
      const length = path.getTotalLength();
      path.style.strokeDasharray = `${length}`;
      path.style.strokeDashoffset = `${length}`;
    });
  }, []);

  // Re-trigger path draw after lengths are set (CSS animation needs starting offset applied first)
  useEffect(() => {
    const root = svgRef.current;
    if (!root) return;
    // Force reflow so dashoffset initial state is painted before animation class
    void root.getBoundingClientRect();
    root.classList.add('paths-ready');
  }, []);

  return (
    <div className="prynx-intro" role="status" aria-label="PrynX is starting">
      <div className="prynx-intro__logo-group">
        <div className="prynx-intro__icon">
          <svg
            ref={svgRef}
            viewBox="0 0 70.87 70.87"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden
          >
            <polygon
              className="fill-shape fill-dark"
              points="24.86 44.95 24.86 70.87 8.93 70.87 8.93 64.57 24.86 44.95"
            />
            <polygon
              className="fill-shape fill-gray"
              points="37.99 25.33 8.93 60.69 8.93 55.61 29.5 30.27 11.55 8.16 24.06 8.16 37.99 25.33"
            />
            <polygon
              className="fill-shape fill-dark"
              points="32.87 35.37 61.93 0 61.93 5.08 41.37 30.42 59.01 52.16 46.5 52.16 32.87 35.37"
            />
            <polygon
              className="fill-shape fill-dark"
              points="8.93 52.16 8.93 8.38 26.7 30.27 8.93 52.16"
            />

            <polygon
              className="draw-path draw-path-dark"
              id="outline1"
              points="24.86 44.95 24.86 70.87 8.93 70.87 8.93 64.57 24.86 44.95"
            />
            <polygon
              className="draw-path draw-path-gray"
              id="outline2"
              points="37.99 25.33 8.93 60.69 8.93 55.61 29.5 30.27 11.55 8.16 24.06 8.16 37.99 25.33"
            />
            <polygon
              className="draw-path draw-path-dark"
              id="outline3"
              points="32.87 35.37 61.93 0 61.93 5.08 41.37 30.42 59.01 52.16 46.5 52.16 32.87 35.37"
            />
            <polygon
              className="draw-path draw-path-dark"
              id="outline4"
              points="8.93 52.16 8.93 8.38 26.7 30.27 8.93 52.16"
            />
          </svg>
        </div>

        <div className="prynx-intro__brand" aria-label="PRYNX">
          {(['P', 'R', 'Y', 'N', 'X'] as const).map((ch, i) => (
            <span
              key={ch}
              className="prynx-intro__letter"
              style={{ animationDelay: `${1.6 + i * 0.1}s` }}
            >
              {ch}
            </span>
          ))}
        </div>

        <div className="prynx-intro__sweep" aria-hidden />
      </div>

      <div className="prynx-intro__slogan">Print made easy!</div>
      <div className="prynx-intro__accent" aria-hidden />

      <p className="prynx-intro__status">
        <span className="prynx-intro__spinner" aria-hidden />
        Getting ready…
      </p>
    </div>
  );
}
