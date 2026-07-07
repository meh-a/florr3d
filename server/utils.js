let nextUid = 1;
export function uid() { return nextUid++; }

// frame-rate independent lerp factor
export function damp(k, dt) { return 1 - Math.exp(-k * dt); }
