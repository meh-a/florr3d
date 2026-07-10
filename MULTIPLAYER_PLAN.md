# True Multiplayer — Implementation Plan

**Audience:** this doc is written for an agent (or engineer) picking up the
work cold, with no other context from prior sessions. It assumes you can
read the repo yourself but shouldn't have to re-derive the architecture or
re-discover the gotchas below by trial and error.

**Why now:** the repo was just made private because people were forking the
client and passing it off as their own. That's a separate problem from this
doc (private-repo protects the source, not the running client — see
"Non-goals" below) but it's the trigger for prioritizing the next big step:
today this is a *server-authoritative singleplayer game*, not multiplayer.
Every player gets their own private simulation. This doc is the plan for
turning it into one shared world multiple people actually play in together.

---

## 1. Current architecture (read this before touching anything)

The client/server split already exists and is good — keep it. The gap is
that the server creates a **separate, isolated `Game` world per websocket
connection**, not one shared world.

```
server/game.js   — class Game: one full authoritative world. Owns Player,
                    PetalManager, MobManager, DropManager. tick(dt) advances
                    everything; snapshot() serializes the whole world for
                    the client. THE KEY FACT: today there is exactly one
                    Player per Game, hardcoded as `this.player` everywhere.
server/ws.js     — attachGameServer(httpServer): on each websocket
                    `connection`, does `new Game()` and starts its OWN
                    setInterval tick loop (30Hz), sending snapshots only to
                    that one socket. Two browser tabs today get two
                    completely independent worlds — they cannot see each
                    other, there is no "shared" anything.
server/index.js  — standalone Node server (serves dist/ + the /ws endpoint).
                    Deploy target for a real dedicated server.
server/worker.js — the SAME Game class, run inside a browser Web Worker
                    instead of over a socket. This is the GitHub Pages
                    fallback (see client/src/net.js) for when there's no
                    server to connect to. It is fundamentally a SOLO mode —
                    a Worker only exists inside one browser tab, it can
                    never be shared between players. Multiplayer requires a
                    real always-on dedicated server; the worker path stays
                    relevant only as an explicit offline/solo fallback.
server/player.js — class Player: position, hp, xp/level, movement. Singular,
                    assumes it's the only one. Has a hardcoded `id = 0`
                    sentinel specifically chosen to not collide with
                    uid()-generated ids (mobs/petals/drops all start at 1).
server/petals.js — class PetalManager: one player's loadout + orbiting
                    petal instances + in-flight missile projectiles.
                    Constructed with `this.player = game.player` — i.e. it
                    is bound to "the" player, not parameterized by player.
server/mobs.js   — class MobManager: all mobs + hornet missiles for ONE
                    Game/world. Mob AI (updateGround/updateHornet) targets
                    `this.game.player` directly — hardcoded singular.
server/combat.js — updateCombat(game, dt): mob-vs-player-body,
                    mob-vs-petals, projectiles-vs-mobs, hornet-missiles-vs-
                    player-or-petals. All of it assumes one `game.player`.
server/drops.js  — ground pickups, checked against `game.player` only.
server/utils.js  — uid(): a simple module-level `nextUid++` counter, shared
                    across every entity kind in one process. This is fine
                    for one shared World per process (see §4) but would
                    need to become per-World if you ever shard into
                    multiple concurrent rooms.
shared/config.js — MOB_TYPES, PETAL_TYPES, RARITIES, ARENA_HALF=145,
                    MOB_CAP=22 (per-world today), spawn/drop tables. No
                    concept of "world size relative to player count" exists
                    yet.
client/src/net.js — Net class: connects to `VITE_WS_URL` if set at build
                    time (pins to a dedicated server), otherwise tries
                    `${proto}://${location.host}/ws`, and if that never
                    opens, falls back to the Worker. This dual-path logic
                    is already correct and needs no changes for
                    multiplayer — you just need GAME_SERVER_URL set (see
                    §7) so Pages builds point at a real server.
client/src/entities.js — EntitySync: syncs mobs/petals/drops/missiles from
                    snapshots into three.js meshes via the same
                    create/update/remove-by-id pattern throughout
                    (`syncCollection`). The one exception: `this.playerMesh`
                    is a SINGLE hardcoded mesh, not a synced collection —
                    this is the main client-side thing that has to change.
.github/workflows/ — Pages deploy already reads a `GAME_SERVER_URL` repo
                    variable into `VITE_WS_URL` at build time. Currently
                    unset, so the live Pages deploy runs the Worker
                    fallback (solo). Setting this variable to a real
                    server's wss:// URL is literally all that's needed on
                    the deploy side once a dedicated server exists.
```

Tick rate is 30Hz everywhere (client input send rate matches). Snapshots are
plain `JSON.stringify`, uncompressed, sent every tick. The server is already
correctly authoritative — the client only ever sends *intents*
(`input`, `swapSlot`, `swapRows`, `rotSpeed`, `equip`) and never gameplay
outcomes. Keep that property; nothing here should change it.

---

## 2. Goals

- Multiple real players occupy and see **the same arena, the same mobs, the
  same drops, in real time** — not parallel private copies.
- Players see each other: position, facing, orbiting petals, health.
- The server remains fully authoritative (no client-trusted gameplay state).
- Runs acceptably at a modest concurrent-player target — see §3 open
  questions for what "modest" means; don't over-engineer for a scale nobody
  asked for.

## 3. Open questions — resolve these with the user before/while building

These are product decisions, not implementation details. Don't silently
guess on them; confirm early, since several ripple through the whole design.

1. **PvP or co-op?** Real florr.io is PvP (petals and flowers can hit other
   players). Today's combat code has zero player-vs-player logic. Recommend
   shipping **co-op first** (shared mobs, can't hurt each other) as its own
   phase, with PvP as an explicit, separately-scoped follow-up — it's a
   materially larger amount of combat-code surgery (petal-vs-petal,
   flower-vs-flower contact, spawn protection, griefing considerations) and
   co-op alone is already "true multiplayer."
2. **Target concurrent players per world?** Changes whether naive O(n²)-ish
   loops are fine or whether interest management (§5) is a phase-1
   requirement vs. a later optimization. Recommend designing for ~10-30
   concurrent in one arena as the initial bar.
3. **One shared world, or multiple rooms/instances?** Simplest and
   recommended for phase 1: **one world per server process.** Sharding into
   multiple rooms is a real feature (matchmaking/room-routing) that should
   only be built if the player count actually demands it.
4. **Does mob population scale with player count?** A 22-mob cap built for
   one player will feel empty with 10 players competing for kills, or (if
   simply multiplied naively) explode combat-loop cost. Needs a formula,
   e.g. `MOB_CAP = base + perPlayer * playerCount`, capped at a hard
   ceiling. Proposed starting point: `base=22, perPlayer=6, ceiling=80` —
   treat as a tuning knob, not a fixed answer.
5. **Does the arena need to be bigger?** `ARENA_HALF=145` was sized for one
   player's screen. Not a hard blocker for phase 1, but likely wants
   revisiting once more than a handful of players share it.
6. **Player display names?** florr.io shows names over flowers. Not
   required for "true multiplayer" to be true, but cheap enough to bolt on
   in phase 2 (a text prompt/input on join, sent once, shown as a sprite
   like the damage numbers in `client/src/effects.js`).
7. **Hosting provider for the dedicated server?** `server/index.js` already
   runs anywhere Node runs. Needs an always-on host now (Fly.io, Railway,
   Render, a small VPS — anything that can run `npm run build && npm run
   server` and stay up). This is an infra/ops decision with a recurring
   cost, separate from code work, and should happen early since multiplayer
   literally cannot be tested with real, separate clients until it exists
   (local multi-tab testing against `npm run dev` works fine without it,
   though — see §8).

   Current lean: **Oracle Cloud's Always Free VPS tier.** Genuinely free
   (not a trial — no surprise billing if usage stays under the caps: 1
   OCPU/1GB on the free x86 shape, or up to 4 OCPU/24GB across the ARM
   Ampere shapes, either comfortably enough for this project's realistic
   scale), 10TB/month egress, and — the part that actually matters for a
   shared-world game specifically — **no idle spin-down.** That rules it
   in over something like Render's free tier, whose services sleep on
   inactivity and cold-start on the next request; fatal for a persistent
   world that needs to stay up for everyone to stay in sync.

   The tradeoff: Oracle's tier is IaaS (a real VM you fully manage), not
   PaaS (Fly/Railway/Render-style git-push-and-it's-up). Ops work a PaaS
   would otherwise absorb, that this now needs explicitly:
   - **TLS.** `server/index.js` is a bare `http.createServer` with no
     HTTPS/WSS. The Pages client is served over `https://`, so browsers
     will refuse a plain `ws://` connection to the game server (mixed
     content) — it must be `wss://`. Put a reverse proxy in front (Caddy
     is the easy option, auto-provisions a Let's Encrypt cert with almost
     no config; nginx works too but needs more manual setup).
   - **Process supervision.** A systemd unit or pm2 to keep
     `node server/index.js` running, restart it on crash, and start it on
     VM reboot.
   - **Deploys.** No git-push-to-deploy built in. Either SSH in and
     pull/rebuild/restart manually, or add a small GitHub Actions workflow
     that does it over SSH — could pattern one after the existing Pages
     deploy workflow in `.github/workflows/`.

   Two Oracle-specific gotchas, worth knowing before debugging a mysterious
   "unreachable" server:
   - Oracle has **two firewall layers** — the cloud-level security
     list/NSG *and* the VM's own OS firewall (iptables/ufw). Opening the
     port in only one of them is the single most common reason people
     can't reach an Oracle instance.
   - Always Free instances are reportedly **reclaimable if utilization
     stays very low for an extended idle period** — worth verifying
     Oracle's current exact policy before relying on it, since "up but
     zero players overnight" is plausibly the kind of pattern that policy
     targets.

## 4. Non-goals for this effort (deferred, not abandoned)

- **Accounts / persistence.** Correction to an earlier draft of this doc:
  florr.io *does* have persistent accounts (linked via Discord login), and
  it's a major part of the real game — inventory/petal collection survives
  across sessions. This project currently has **zero persistence of any
  kind** (inventory is a `Map` inside one in-memory `Game`/`World` object,
  gone the moment the socket closes), and the user has decided accounts are
  explicitly **deferred to a later, separately-scoped effort** — not part
  of the phases in §6. Don't fold login/persistence work into this
  refactor. See §10 for a grounding summary to work from whenever that
  phase actually starts, so it doesn't need to be re-researched from
  scratch.
- **Fixing the "people can fork the code" problem.** Making the repo
  private already addressed the *source*. Multiplayer doesn't add or remove
  protection for the *running client* — anyone can still open devtools on
  the deployed page and read the bundled JS, and the websocket protocol is
  inherently visible to anyone playing. If client-side protection
  (obfuscation, etc.) is wanted, that's unrelated to this doc.
- **Matchmaking, rooms, regions.** See §3.3 — only build if needed.
- **Anti-cheat beyond "server is authoritative."** The existing design
  already does the right thing (client sends intents only). The one gap
  worth closing as part of this work is basic per-connection message rate
  limiting (§6.6), since a flood from one client now has a blast radius
  affecting *other real people* sharing the process, not just the
  attacker's own world.

## 5. Target architecture

### 5.1 `Game` → shared `World`

Replace "one `Game` per connection" with **one `World` per server process**,
holding:

- `players: Map<id, Player>` instead of a single `this.player`.
- One shared `MobManager`, one shared `DropManager` (unchanged in spirit,
  just now genuinely shared).
- `PetalManager` becomes **owned per-player** (each `Player` gets its own
  loadout/orbit/projectiles) rather than one `PetalManager` bound to "the"
  player. Concretely: move the `PetalManager` instantiation from `Game`'s
  constructor into `Player`'s, or have `World` construct one per player on
  join.
- Input becomes `Map<id, InputState>` instead of a single `this.input`.
- `world.tick(dt)` advances the shared mob/drop managers once, then every
  player's movement/petals, then runs combat across the shared population.

### 5.2 Connection lifecycle (`ws.js`)

Today: `new Game()` + `new setInterval(...)` **per connection**. Change to:

- One `World` instance + **one shared tick interval** for the whole process
  (started once, not per connection).
- On `connection`: create a `Player`, add it to `world.players`, register
  the socket for that player id.
- On `message`: route to `world.handle(playerId, msg)` (handlers need the
  player id now, since `equip`/`swapSlot`/etc. must act on the sender's own
  `Player`, not a singular `game.player`).
- On `close`: remove just that player from `world.players` (despawn their
  petals/drops-in-flight as appropriate) — the world and every other
  connection keep running untouched.
- The tick loop, after `world.tick(dt)`, builds snapshots **per recipient**
  (see §5.3) and sends each connection its own.

### 5.3 Snapshot: per-recipient, not one-size-fits-all

Today `inventory` (private) is embedded directly in the single snapshot
object because there's only one recipient. In a shared world, **inventory
must never be broadcast to other players.** Split the snapshot into:

- **Public/shared payload**, safe to compute once per tick and reuse across
  every recipient: mob states, drops, all players' positions/facing/hp/
  petals-in-orbit (other players' equipped loadouts and orbiting petal
  instances need to be visible so people can see what others are fighting
  with — same as mob petal-combat is visible today), missiles, pmissiles,
  world-visible events (toasts are per-player, but damage-number events are
  fine to share, matching florr.io showing others' damage numbers).
- **Private per-recipient slice**, computed only for that connection's own
  player: their own inventory, their own toasts.

Proposed shape:

```js
{
  t: 'state',
  time,
  you: <yourPlayerId>,        // NEW — which entry in `players` is you
  players: [ { id, x, z, facing, hp, maxHp, level, dead, deadTimer,
               petals: { rotFactor, primary, secondary, instances: [...] } }, ... ],
  mobs: [...],                 // unchanged shape, now world-shared
  missiles: [...],
  pmissiles: [...],
  drops: [...],
  inventory: [...],            // ONLY valid/present for `you` — send this
                                // in the private slice, never in the
                                // shared-computed part
  events: [...],                // see the flash-event gotcha below
}
```

Optimization note (not required for phase 1, but design so it's easy to add
later): compute the shared/public part of the payload **once per tick**
and merge each recipient's private slice on top, rather than
re-serializing the whole world once per connection. Don't build this until
you've actually measured it mattering.

### 5.4 Entity IDs

`uid()` in `server/utils.js` is a single global counter shared by every
entity kind — this already gives you cross-kind-unique ids for free, and
continues to work correctly for a single shared `World` per process (drop
this if you ever shard into multiple concurrent worlds in one process —
then `uid()` needs to move from module-global to per-`World`, which it
currently is not).

**Concrete gotcha:** `Player.id` is hardcoded to the sentinel `0` today,
specifically chosen to be distinct from `uid()`'s output (which starts at
1). With multiple players you need multiple unique non-zero ids — just call
`uid()` for player ids too and delete the `id = 0` special-casing.

**Second concrete gotcha:** `client/src/entities.js`'s `handleEvent` uses
that `id === 0` sentinel to decide whether a `flash` event targets the
(single, hardcoded) player mesh or a mob:
```js
if (ev.e === 'flash') {
  if (ev.id === 0) flashMaterials(this.playerMesh);
  else { const view = this.mobs.get(ev.id); if (view) flashMaterials(view.mesh); }
}
```
This breaks once players have real ids. Fix by adding a `kind: 'player' |
'mob'` field to flash (and any similar) events, and dispatching by kind +
id against the right map (`this.players.get(id)` vs `this.mobs.get(id)`)
instead of a magic id value.

### 5.5 Mob AI targeting

`updateGround`/`updateHornet` in `server/mobs.js` hardcode `this.game.player`
as the only possible target for aggro/chase/hornet-volley logic. This needs
to become "find the nearest (or nearest-with-some-tiebreak) player in
`world.players`" instead of a fixed reference. This is the one piece of AI
logic that's genuinely more than a rename — it's a nearest-neighbor search
across however many players are in the world, once per mob, once per tick.
At the player-count target in §3.2 this is still cheap as a plain linear
scan (tens of mobs × tens of players = at most a few thousand distance
checks per tick, trivial at 30Hz) — don't build a spatial index for this
until profiling says otherwise.

### 5.6 Combat

`server/combat.js` needs the same treatment as mob AI: every place it
reads `game.player` singular needs to become "for each player in
`world.players`." For phase 1 (co-op, §3.1), this means: mob-vs-player-body
and mob-vs-petals loops over all players instead of one; hornet
missiles/projectiles likewise check against all players' petals. Player-vs-
player damage stays absent in phase 1 by construction (petals only ever
check `mob` targets, never other players' flowers/petals) — that boundary
*is* the co-op/PvP toggle, so keep it isolated/obvious in the code (e.g. a
single clearly-commented block) rather than scattered, so flipping to PvP
later is a contained change.

### 5.7 Client rendering

`client/src/entities.js` currently has one hardcoded `this.playerMesh`. This
needs to become a synced collection just like mobs already are — same
`syncCollection` pattern, keyed by player id, with one entry recognized as
"yourself" (via the new `you` field in the snapshot) for camera-follow
purposes. Other players' orbiting petals need their own client-side view
objects too, same pattern as your own petals today but keyed by owning
player id instead of assumed-singular.

---

## 6. Phased implementation plan

Each phase should be independently shippable/testable — don't try to land
this as one giant change.

**Phase 0 — infra decision.** Resolve §3.7 (hosting) and §3.1/3.2 (PvP vs
co-op, target scale) with the user. Stand up (or confirm access to) an
always-on host that can run `server/index.js`. Not code work, but blocks
real end-to-end testing with separate physical clients.

**Phase 1 — shared world skeleton.** The `Game`→`World` refactor (§5.1),
connection lifecycle changes (§5.2), per-recipient snapshots (§5.3), id
fixes (§5.4). Co-op only. No interest management yet, no mob-cap scaling
yet — just get two browser tabs hitting `npm run dev` into the *same*
world, seeing the *same* mobs, at all. This is the core of "true
multiplayer" and should be validated hard before moving on.

**Phase 2 — render other players.** Client-side player collection (§5.7),
flash-event kind fix (§5.4). Optionally: display names (§3.6).

**Phase 3 — mob AI + population against multiple players.** Nearest-player
targeting (§5.5), mob-cap/hornet-cap scaling formula (§3.4).

**Phase 4 — interest management.** Once basic shared multiplayer works and
is fun, this is the actual scalability lever: stop sending every mob/
drop/other-player to every client regardless of distance. Scope each
recipient's snapshot to entities within some radius of their own player (or
similar). This is the change that prevents bandwidth/CPU from scaling
badly with player count — treat it as required before advertising the game
publicly at any real scale, but not required to validate the core loop in
phase 1-3.

**Phase 5 — PvP (only if resolved "yes" in §3.1).** Petal-vs-petal,
flower-vs-flower contact damage, spawn protection, kill feed/attribution.
Scope this as its own effort once co-op multiplayer is solid.

**Phase 6 — hardening.** Per-connection message rate limiting (a client
spamming `equip` or malformed messages now burns shared-process CPU that
affects other real players, not just itself — this is new risk that didn't
exist in the one-world-per-connection model). Reconnect/disconnect edge
cases (mid-fight disconnects, stale sockets). Basic load testing with
several simulated headless clients before trusting a real player count
target.

---

## 7. Deployment notes

- `client/src/net.js` already does the right thing: it tries same-origin
  `/ws` first, falls back to the in-browser Worker only if that never
  connects, and — if `VITE_WS_URL` was baked in at build time — skips the
  fallback entirely and always targets that dedicated server. **No client
  code changes needed here for multiplayer to go live**, once phases 1-3
  are done server-side.
- `.github/workflows/*.yml` already reads a `GAME_SERVER_URL` repository
  variable into `VITE_WS_URL` at build time. Set that variable (Settings →
  Secrets and variables → Actions → Variables) to the dedicated server's
  `wss://...` URL once phase 0/1 are done, and the next Pages deploy will
  point real visitors at the shared world instead of the solo Worker
  fallback.
- Decide explicitly whether to **keep the Worker fallback** as a
  deliberate "play solo if the server's unreachable" mode (harmless,
  already works, arguably nice) or drop it. Either is fine; just don't let
  it silently become the accidental multiplayer path for anyone whose
  connection to the dedicated server fails.

## 8. Testing strategy

- **Local multi-client testing needs no extra infra**: run `npm run dev`
  (the vite plugin in `vite.config.js` already attaches the game websocket
  to the dev server), then open several browser tabs/windows at the same
  `localhost` URL. Once phase 1 lands, they should all land in the same
  world automatically — this is the fastest, cheapest way to validate
  sharing is actually working, and should be the first thing checked after
  phase 1.
- For anything beyond a couple of manual tabs (load-testing phase 4/6),
  script several headless websocket clients directly against `server/ws.js`
  (no browser needed — it's just JSON messages over a socket) sending
  synthetic `input` messages and asserting on snapshot shape/latency under
  load.
- Re-run the existing manual QA habits from this project's history (this
  codebase has repeatedly needed *actual rendered verification*, not just
  code review, for anything visual — see EntitySync changes especially).

## 9. Risks / things likely to go wrong

- **Silently reintroducing "one player" assumptions.** The codebase has
  `game.player` (singular) threaded through `player.js`, `petals.js`,
  `mobs.js`, `combat.js`, `drops.js`. It is easy to fix 90% of these and
  miss one, producing a subtle bug where (e.g.) drops only pick up for one
  specific player, or hornets only ever target the first player who
  connected. Grep for `game.player` and `this.player` (singular) as a
  checklist when doing the refactor — every hit needs a deliberate decision
  about whether it becomes "the sender," "all players," or "the nearest
  player."
- **Bandwidth/CPU scaling surprising you late.** Phase 1-3 will work fine
  and feel fine at low player counts even without interest management —
  don't skip phase 4 just because early testing looks fine with 2-3 tabs
  open.
- **PvP scope creep into phase 1.** It's tempting to "just also" let petals
  hit other players while doing the combat refactor in §5.6, since the code
  is already open. Resist this — land co-op multiplayer as a complete,
  solid, separately-validated thing first.

## 10. Appendix — accounts/persistence, for whenever that phase starts

Not part of this effort (§4), captured here purely so the groundwork
doesn't need re-researching later.

**Discord login mechanics (OAuth2 Authorization Code flow):**
1. Register an app at Discord's developer portal → get a `CLIENT_ID` and
   `CLIENT_SECRET`.
2. A "Login with Discord" link sends the browser to Discord's authorize URL
   with the client id and requested scopes (`identify`, optionally `email`).
3. User approves on Discord's page; Discord redirects back to your server
   with a one-time `code`.
4. **The server** (never the client — this step needs the secret) exchanges
   the code for an access token via a POST to Discord's token endpoint,
   then calls `/users/@me` with it to get the user's Discord id/username/
   avatar.
5. The server now knows which Discord user this browser is, looks up/
   creates an account row keyed by that id, and issues its own session
   cookie so the browser stays logged in without repeating the Discord
   round-trip every visit.

**Why this is two projects, not one:** Discord OAuth only solves *identity*
(who is this). It doesn't solve *storage* (what do we remember about them).
The actual lift, in rough order:
- A real database for accounts + inventories — SQLite is enough at small
  scale; a hosted Postgres (Supabase/Neon/Railway) if it needs to survive
  redeploys/scale later. Nothing like this exists in the codebase today.
- Session handling — a cookie/token surviving page reloads, wired into the
  websocket handshake. `server/ws.js`'s `attachGameServer` already receives
  the raw `req` in its `upgrade` handler (see `httpServer.on('upgrade', ...)`
  in §1) — that's the natural hook point to read/verify a session cookie
  before accepting a connection and attaching a resolved account id to it.
- Deciding what actually persists. Worth confirming against the live game
  rather than assuming, but the headline feature is believed to be the
  petal collection (inventory), not in-round XP/level.
- Client-side: a login button/state, and a decision on whether login is
  required to play at all or optional with anonymous/guest play still
  allowed (many browser games default to guest-allowed).

The OAuth handshake itself is one of the easier third-party integrations —
maybe an hour or two of focused work for a developer who's done it before.
The database + session + account-bound-inventory plumbing around it is the
real, separately-scoped effort.
