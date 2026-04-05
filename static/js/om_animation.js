/**
 * SDH – OM Particle Animation System
 * ====================================
 * Uses Canvas 2D API to render the OM (ॐ) symbol as a particle field.
 *
 * On hover  → particles explode outward (dissolve)
 * On leave  → particles flow back to their resting position (reform)
 *
 * Also exports `initStarfield()` for the ambient background.
 */

'use strict';

// ─────────────────────────────────────────────────────────────
// STARFIELD BACKGROUND
// ─────────────────────────────────────────────────────────────
window.initStarfield = function (canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  const STAR_COUNT = 200;
  const stars = Array.from({ length: STAR_COUNT }, () => ({
    x:  Math.random() * canvas.width,
    y:  Math.random() * canvas.height,
    r:  Math.random() * 1.4 + 0.2,
    vx: (Math.random() - 0.5) * 0.08,
    vy: (Math.random() - 0.5) * 0.08,
    alpha: Math.random() * 0.6 + 0.3,
  }));

  // Subtle nebula colours
  const nebulaColors = ['#a855f720', '#818cf815', '#c084fc10'];

  function drawStars() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Nebula clouds
    nebulaColors.forEach((color, i) => {
      const gx = canvas.width * (0.2 + i * 0.3);
      const gy = canvas.height * (0.3 + i * 0.2);
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, 300);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    });

    // Stars
    stars.forEach(s => {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(212, 175, 55, ${s.alpha})`;
      ctx.fill();

      s.x += s.vx;
      s.y += s.vy;
      if (s.x < 0) s.x = canvas.width;
      if (s.x > canvas.width) s.x = 0;
      if (s.y < 0) s.y = canvas.height;
      if (s.y > canvas.height) s.y = 0;
    });

    requestAnimationFrame(drawStars);
  }

  drawStars();
};


// ─────────────────────────────────────────────────────────────
// OM PARTICLE SYSTEM
// ─────────────────────────────────────────────────────────────

/**
 * Samples pixel positions of the OM glyph by rendering it to an
 * off-screen canvas, then reading the alpha channel.
 */
function sampleOmGlyph(size) {
  const offscreen = document.createElement('canvas');
  offscreen.width  = size;
  offscreen.height = size;
  const ctx = offscreen.getContext('2d');

  // Clear
  ctx.clearRect(0, 0, size, size);

  // Draw OM at large size, centred
  const fontSize = Math.floor(size * 0.72);
  ctx.font        = `${fontSize}px serif`;
  ctx.fillStyle   = '#ffffff';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ॐ', size / 2, size / 2);

  const imageData = ctx.getImageData(0, 0, size, size);
  const data      = imageData.data;
  const points    = [];
  const stride    = 3; // sample every Nth pixel for performance

  for (let y = 0; y < size; y += stride) {
    for (let x = 0; x < size; x += stride) {
      const idx = (y * size + x) * 4;
      const alpha = data[idx + 3];
      if (alpha > 128) {
        points.push({ x, y });
      }
    }
  }

  return points;
}


class Particle {
  constructor(cx, cy, tx, ty, color) {
    // Current position (starts at random location around canvas)
    this.x  = cx + (Math.random() - 0.5) * 300;
    this.y  = cy + (Math.random() - 0.5) * 300;
    // Home / target position (on the glyph)
    this.tx = tx;
    this.ty = ty;
    // Velocity
    this.vx = 0;
    this.vy = 0;
    // Exploded position
    this.ex = 0;
    this.ey = 0;
    // State: 'forming' | 'formed' | 'exploding' | 'exploded'
    this.state  = 'forming';
    this.color  = color;
    this.radius = Math.random() * 1.6 + 0.8;
    this.alpha  = 0;
  }

  updateForming() {
    const ease  = 0.07;
    const dx    = this.tx - this.x;
    const dy    = this.ty - this.y;
    this.vx    += dx * ease;
    this.vy    += dy * ease;
    this.vx    *= 0.85;
    this.vy    *= 0.85;
    this.x     += this.vx;
    this.y     += this.vy;
    this.alpha  = Math.min(1, this.alpha + 0.04);

    const dist = Math.hypot(dx, dy);
    if (dist < 1.5) {
      this.x     = this.tx;
      this.y     = this.ty;
      this.state = 'formed';
    }
  }

  updateExploding(cx, cy) {
    const speed = 4 + Math.random() * 4;
    const angle = Math.atan2(this.ty - cy, this.tx - cx) + (Math.random() - 0.5) * Math.PI;
    this.ex     = this.x + Math.cos(angle) * speed * 12;
    this.ey     = this.y + Math.sin(angle) * speed * 12;
    this.vx     = (this.ex - this.x) * 0.05;
    this.vy     = (this.ey - this.y) * 0.05;
    this.state  = 'exploding';
  }

  updateExploded() {
    this.x    += this.vx;
    this.y    += this.vy;
    this.vx   *= 0.94;
    this.vy   *= 0.94;
    this.alpha = Math.max(0.2, this.alpha - 0.005);
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
    ctx.restore();
  }
}


window.initOmParticles = function (canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const W   = canvas.width;
  const H   = canvas.height;
  const ctx = canvas.getContext('2d');
  const cx  = W / 2;
  const cy  = H / 2;

  // Sample OM glyph pixel positions at canvas resolution
  const glyphPoints = sampleOmGlyph(W);

  // Colour palette: purple → indigo → violet gradient based on Y position
  function particleColor(y) {
    const t = y / H;
    if (t < 0.33) return '#a855f7';
    if (t < 0.66) return '#818cf8';
    return '#c084fc';
  }

  // Create particles
  const MAX_PARTICLES = Math.min(glyphPoints.length, 800);
  const step          = Math.max(1, Math.floor(glyphPoints.length / MAX_PARTICLES));
  const particles     = [];

  for (let i = 0; i < glyphPoints.length; i += step) {
    const p = glyphPoints[i];
    particles.push(new Particle(cx, cy, p.x, p.y, particleColor(p.y)));
  }

  let exploded   = false;
  let animFrameId = null;

  function loop() {
    ctx.clearRect(0, 0, W, H);

    particles.forEach(p => {
      if (p.state === 'forming')    p.updateForming();
      else if (p.state === 'exploding' || p.state === 'exploded') {
        p.state = 'exploded';
        p.updateExploded();
      }
      p.draw(ctx);
    });

    // Soft glow halo
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, W * 0.4);
    glow.addColorStop(0, 'rgba(168,85,247,0.06)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    animFrameId = requestAnimationFrame(loop);
  }

  loop();

  // ── Mouse events ────────────────────────────────────────────
  canvas.addEventListener('mouseenter', () => {
    if (exploded) return;
    exploded = true;
    particles.forEach(p => {
      if (p.state === 'formed') {
        p.updateExploding(cx, cy);
      }
    });
  });

  canvas.addEventListener('mouseleave', () => {
    exploded = false;
    particles.forEach(p => {
      p.state = 'forming';
      p.alpha = Math.max(0.1, p.alpha);
    });
  });

  // Touch support
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!exploded) {
      exploded = true;
      particles.forEach(p => {
        if (p.state === 'formed') p.updateExploding(cx, cy);
      });
    } else {
      exploded = false;
      particles.forEach(p => { p.state = 'forming'; });
    }
  }, { passive: false });
};
