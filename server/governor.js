// Overload governor: keeps the server alive through player floods it can't
// fully serve, by shedding quality in steps instead of missing ticks. Runs
// purely off measured tick cost, so it needs no tuning per map or player
// count and recovers on its own — built for waves that arrive while nobody
// is watching the dashboards.
//
// Levels:
//   0 normal   — 20Hz players, 10Hz spectators, 30 nearest players
//   1 stressed — 10Hz players,  5Hz spectators, 20 nearest players
//   2 critical — level 1 + new joins paused (existing players keep playing;
//                would-be joiners spectate and retry, better than everyone
//                rubber-banding)
//
// Escalation is immediate; de-escalation needs 30s at a comfortably lower
// cost (hysteresis) so the level doesn't flap at a threshold.
export class Governor {
  constructor(budgetMs) {
    this.budget = budgetMs;
    this.level = 0;
    this.lastChange = 0;
    this.sum = 0;
    this.n = 0;
    this.avg = 0;
  }

  // feed every tick's total cost; returns true when the level changed
  record(ms, now) {
    this.sum += ms;
    if (++this.n < 60) return false; // evaluate every ~3s at 20Hz
    this.avg = this.sum / this.n;
    this.sum = 0;
    this.n = 0;
    return this.evaluate(now);
  }

  evaluate(now) {
    const before = this.level;
    if (this.avg > this.budget * 0.84) this.level = 2;        // > ~42ms
    else if (this.avg > this.budget * 0.64 && this.level < 1) this.level = 1; // > ~32ms
    else if (now - this.lastChange > 30_000) {
      if (this.level === 2 && this.avg < this.budget * 0.6) this.level = 1;
      else if (this.level === 1 && this.avg < this.budget * 0.4) this.level = 0;
    }
    if (this.level !== before) this.lastChange = now;
    return this.level !== before;
  }

  get playerEvery() { return this.level >= 1 ? 2 : 1; } // ticks per player frame
  get specEvery() { return this.level >= 1 ? 4 : 2; }   // ticks per spectator frame
  get playerCap() { return [30, 20, 12][this.level]; }  // nearest players sent
  get joinsOpen() { return this.level < 2; }
}
