// Client-side graphics settings, persisted across sessions. Quality gates
// the expensive visuals: shadows/AA/pixel-ratio/lens flare, volumetric vs
// toon clouds, and shader vs flat water. 'ultra' adds the photorealistic
// instanced grass field on top of everything 'high' enables.
const QUALITY_KEY = 'florr3d-quality';

// 'ultra' (photorealistic instanced grass, see grass.js) is implemented but
// hidden from the toggle for now — the look needs more work. Flip this to
// re-expose it; a stored 'ultra' preference safely falls back to 'high'.
const ULTRA_ENABLED = false;

const LEVELS = ULTRA_ENABLED ? ['low', 'high', 'ultra'] : ['low', 'high'];
const LABELS = { low: 'Low', high: 'High', ultra: 'Ultra Realistic' };

export function getQuality() {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    return LEVELS.includes(q) ? q : 'high';
  } catch {
    return 'high';
  }
}

export function setQuality(q) {
  try { localStorage.setItem(QUALITY_KEY, q); } catch {}
}

// Renderer flags (antialias, shadow maps) and the cloud bake are fixed at
// world creation, so the toggle applies by reloading — simpler and less
// leak-prone than tearing down and rebuilding the scene in place.
export function initQualityToggle() {
  const el = document.getElementById('quality');
  el.textContent = `Quality: ${LABELS[getQuality()]}`;
  el.onclick = () => {
    const next = LEVELS[(LEVELS.indexOf(getQuality()) + 1) % LEVELS.length];
    setQuality(next);
    location.reload();
  };
}
