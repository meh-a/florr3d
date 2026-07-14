# Code health rules

Lightweight rules to keep this codebase from turning into the tangle-of-cables
problem that kills a lot of AI-assisted projects. These are heuristics, not
gates — use judgment, don't block a fix over a rule.

## 1. Split before you grow
If a file you're about to edit is already >400-500 lines and your change adds
a new concern (not just extending the existing one), pull the new concern
into its own module instead of appending. Current files (server/mobs.js,
world.js, client/src/entities.js, models.js, shared/protocol.js) are the
danger zone — they're the ones most likely to become god-files.

## 2. One source of truth for numbers
Anything both client and server need (stats, timings, radii, rarities) lives
in shared/config.js or shared/protocol.js — never hardcoded again on either
side. If you catch a magic number duplicated in two places, that's a bug
waiting to happen the next time one side gets rebalanced and the other
doesn't.

## 3. New feature = new file, not a bigger old file
Bolting a new mob type, mechanic, or system onto an existing file because
"it's related" is how files become 1000+ lines of mixed responsibility.
Default to a new module; only inline it if it's genuinely a couple lines.

## 4. No copy-paste beyond ~10 lines
If you're about to paste a block you just wrote elsewhere with minor tweaks,
extract a helper instead. Three near-identical blocks is a stronger signal
than the codebase currently has — don't wait for a third occurrence to fix
the first two.

## 5. Delete, don't deprecate
No feature flags, `_old`, commented-out blocks, or back-compat shims for
internal-only code. If it's unused, delete it. This is a single-deploy game
server, not a library with external consumers — nothing to stay compatible
with.

## 6. Comments explain why, not what
Skip comments that restate the code. Only write one when there's a non-obvious
constraint, workaround, or invariant that would bite the next change if
forgotten (e.g. "ordering matters here because X").

## 7. Review the diff before it's real
Before deploying non-trivial changes, run `/code-review` (or `/simplify` for
pure cleanup) on the diff. This is the actual mechanism that catches drift —
rules 1-4 are what the review should be checking for, not something to
manually audit on every commit.

## 8. Prune periodically, not never
Every so often (e.g. before a big feature push), skim for dead code, stale
TODOs, and files that have crept past the size threshold in rule 1, and clean
them up in a dedicated pass rather than mixed into feature work.
