# Tic Tac Toe — Implementation Notes

How the animation layer works and why it is built this way.
For setup and features, see [README.md](README.md).

## Animation Notes

All animation runs through Anime.js 3.2.2 in `script.js`.

### Confetti physics

Each particle is **two nodes**: an outer `.cf` carrying ballistics
(translate + tumble) and an inner `.cf__face` carrying the flutter. They are
separate elements on purpose — two Anime instances writing to one element's
`transform` would overwrite each other.

The arc uses per-keyframe duration and easing:

- rise: `easeOutQuad` (decelerating upward)
- fall: `easeInQuad` (accelerating downward — gravity)
- horizontal: `easeOutQuad` across the whole flight (air drag)

A single easing across the whole arc makes pieces decelerate as they fall,
which reads as floating rather than falling. That was the main defect in the
previous version.

### Emitters

- `fireCannon(x, y, angleDeg, spreadDeg, count)` — cone of paper from a point.
- `burstFrom(x, y, count)` — radial firework.
- `dropGlitter(count)` — slow twinkling drift from above the fold.
- `celebrate(line)` — choreographs flash, shockwave, card recoil, three
  cannon volleys at 0 / 380 / 820ms, a burst at 150ms, and glitter at 1000ms.
- `launchPoopConfetti()` — the draw sequence.

### Other animations

- `drawMark()` — `anime.setDashoffset` line drawing for X and O.
- `drawStrike()` — draws the winning line through the board.
- `setStatus()` — animated text swap.
- `resetGame()` — grid-staggered card flip.

### Housekeeping

- `MAX_PARTICLES` (260) caps concurrent particles; every emitter checks it.
- Every particle's `complete` callback calls `anime.remove(face)` before
  removing the node — the flutter loops are infinite, so this is what stops
  them and lets the instance be collected.
- `clearConfetti()` tears down live particles, pending volley timers and the
  `liveParticles` counter. `resetGame()` calls it, so a new round never
  inherits the previous celebration's particle budget.
- `playIntro()` defers while `document.hidden` is true. Its start state is
  `opacity: 0`, and rAF is throttled in background tabs, so running it while
  hidden would leave the card invisible until the tab is focused.

## Constraints worth knowing

**Anime.js does not compose transforms across instances.** Two `anime()` calls
on the same element fight: the second resets any transform property the first
owned. Proven with `translateX` + `rotateY` on one node — the second instance
wrote `translateX(0px)`.

Three things in this file exist because of that:

- Confetti particles are two nodes: `.cf` carries ballistics, `.cf__face`
  carries the flutter.
- `boardBusy` is set while a scripted animation owns the cells (intro, reset
  flip, celebration). The hover handlers return early while it is set, instead
  of calling `anime.remove(cell)` and stranding a half-finished flip.
- `drawMark()` deliberately does not animate the cell, only the SVG inside it,
  because the hover handler owns the cell's transform.

**Cells overlap above scale 1.087.** They are 115.3px wide in a grid with a
10px gap. `easeOutBack` overshoots by ~13.2% of a tween's range, so
`scale: [0, 1]` peaks at 1.132 and made the whole grid collide. The intro
therefore starts at 0.5 (peak 1.066) and the winner pop tops out at 1.06.
Re-check this if the gap or card width changes.

**`resetting` gates input during reset.** `board[]` is emptied synchronously
but the DOM is cleared inside an animation callback ~290ms later. Without the
flag a click in that window is recorded and then wiped, leaving an invisible
move that blocks the square for the rest of the game. The `disabled` attribute
alone is not sufficient — it stops real clicks but not dispatched ones.

## Future Improvements

- Add score tracking across rounds.
- Add player name inputs.
- Add a single-player mode against the computer.
- Consider a canvas particle system if particle counts ever go much above ~300.
