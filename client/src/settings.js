// Client-side graphics settings, persisted across sessions. Quality gates
// the expensive visuals: shadows/AA/pixel-ratio/lens flare, volumetric vs
// toon clouds, and shader vs flat water.
const QUALITY_KEY = 'florr3d-quality';

export function getQuality() {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'low' ? 'low' : 'high';
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
  el.textContent = `Quality: ${getQuality() === 'high' ? 'High' : 'Low'}`;
  el.onclick = () => {
    setQuality(getQuality() === 'high' ? 'low' : 'high');
    location.reload();
  };
}
