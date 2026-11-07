import { useEffect, useRef } from 'react';

const DOTS = 220;
const TAU = Math.PI * 2;

function readColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function withAlpha(color, alpha) {
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 6) return `#${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
  }
  return color;
}

export default function DotMatrixVortex() {
  const rootRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!root || !canvas || !context) return undefined;

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const particles = Array.from({ length: DOTS }, (_, index) => ({
      angle: (index / DOTS) * TAU,
      radius: 0.18 + ((index * 17) % 100) / 100 * 0.82,
      speed: 0.25 + ((index * 13) % 100) / 100 * 0.55,
      depth: 0.45 + ((index * 29) % 100) / 100 * 0.55,
      size: 0.7 + ((index * 7) % 100) / 100 * 1.5,
    }));
    const colors = {
      primary: readColor('--cyan', '#22d3ee'),
      accent: readColor('--violet', '#a78bfa'),
      background: readColor('--bg', '#020617'),
    };
    let width = 0;
    let height = 0;
    let frameId = 0;
    let start = 0;

    const resize = () => {
      const bounds = root.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (time) => {
      if (!start) start = time;
      const elapsed = (time - start) / 1000 * (reducedMotion ? 0.35 : 1);
      const centerX = width / 2;
      const centerY = height / 2;
      const scale = Math.min(width, height) * 0.46;
      context.clearRect(0, 0, width, height);

      const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, scale);
      glow.addColorStop(0, withAlpha(colors.primary, 0.14));
      glow.addColorStop(0.55, withAlpha(colors.primary, 0.04));
      glow.addColorStop(1, withAlpha(colors.background, 0));
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      particles.forEach((particle, index) => {
        const orbit = particle.angle + elapsed * particle.speed * (index % 2 ? -1 : 1);
        const wave = Math.sin(elapsed * 1.2 + particle.angle * 3) * 0.06;
        const radius = (particle.radius + wave) * scale;
        const x = centerX + Math.cos(orbit) * radius;
        const y = centerY + Math.sin(orbit) * radius * 0.56;
        const color = index % 5 === 0 ? colors.accent : colors.primary;
        context.globalAlpha = 0.25 + particle.depth * 0.7;
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, y, particle.size * particle.depth, 0, TAU);
        context.fill();
      });

      context.globalAlpha = 0.9;
      context.fillStyle = colors.primary;
      context.beginPath();
      context.arc(centerX, centerY, Math.max(2, scale * 0.035), 0, TAU);
      context.fill();
      context.globalAlpha = 1;
      frameId = requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(root);
    resize();
    frameId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={rootRef} className="dot-vortex" role="img" aria-label="Animated experiment progress">
      <canvas ref={canvasRef} />
      <span className="dot-vortex__ring dot-vortex__ring--outer" />
      <span className="dot-vortex__ring dot-vortex__ring--inner" />
      <span className="dot-vortex__dot dot-vortex__dot--one" />
      <span className="dot-vortex__dot dot-vortex__dot--two" />
      <span className="dot-vortex__dot dot-vortex__dot--three" />
    </div>
  );
}
