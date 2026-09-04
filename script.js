const cells = document.querySelectorAll('.cell');
const statusText = document.getElementById('status');
const resetButton = document.getElementById('reset');
const boardEl = document.getElementById('board');
const cardEl = document.getElementById('card');
const strikeEl = document.getElementById('strike');
const flashEl = document.getElementById('flash');
const confettiLayer = document.getElementById('confetti-layer');

const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reduceMotion = motionQuery.matches;

/* Board coordination state.
   `boardBusy` marks the windows where a scripted animation owns the cells
   (intro, reset flip, celebration). anime.js does NOT compose transforms
   across instances on one element - a second instance resets the properties
   it does not own - so the hover handlers must stand down during those
   windows instead of calling anime.remove() and stranding a half-run flip. */
let boardBusy = false;
/* Input gate for the reset window. board[] is emptied synchronously but the
   DOM is only cleared inside an animation callback ~290ms later; without this
   a click in between is recorded against the fresh state and then has its mark
   wiped, leaving an invisible move that blocks the square. The disabled
   attribute alone is not enough - it stops real clicks but not dispatched
   ones, so the rule is stated explicitly here. */
let resetting = false;
let celebrationTimers = [];
let activeWinLine = null;
let statusTarget = "Player X's turn";

const winningLines = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const CONFETTI_COLORS = [
  '#5ee7ff', '#7cffb2', '#ffd45e', '#ff7a8a',
  '#c08bff', '#ff5ec4', '#c6ff5e', '#ffffff',
];

let board = Array(9).fill('');
let currentPlayer = 'X';
let gameOver = false;

/* Hard ceiling on live particles so a mash of New Game -> win can never
   pile up enough nodes to drop frames. */
const MAX_PARTICLES = 260;
let liveParticles = 0;

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/* =========================================================
   Particle primitives
   ========================================================= */

/**
 * Builds a two-node particle: an outer node that carries ballistics and
 * an inner "face" that carries the flutter. Keeping them separate means
 * the two anime instances write to two different transform strings
 * instead of overwriting each other.
 */
function createParticle(x, y) {
  const outer = document.createElement('div');
  outer.className = 'cf';
  outer.style.left = `${x}px`;
  outer.style.top = `${y}px`;

  const face = document.createElement('span');
  face.className = 'cf__face';
  outer.appendChild(face);

  return { outer, face };
}

function styleAsPaper(face) {
  const kind = Math.random();
  const color = pick(CONFETTI_COLORS);

  if (kind < 0.16) {
    // Streamer: long, thin, tumbles slowly and hangs in the air.
    face.style.width = `${randomBetween(4, 7)}px`;
    face.style.height = `${randomBetween(26, 46)}px`;
    face.style.borderRadius = '3px';
    face.style.backgroundColor = color;
    return 'streamer';
  }

  if (kind < 0.34) {
    // Dot.
    const d = randomBetween(6, 11);
    face.style.width = `${d}px`;
    face.style.height = `${d}px`;
    face.style.borderRadius = '50%';
    face.style.backgroundColor = color;
    return 'dot';
  }

  // Rectangular paper strip, half of them foiled so the flip catches light.
  face.style.width = `${randomBetween(7, 13)}px`;
  face.style.height = `${randomBetween(11, 20)}px`;
  face.style.borderRadius = '2px';
  face.style.backgroundColor = color;
  if (Math.random() > 0.5) face.classList.add('foil');
  return 'paper';
}

/**
 * Attaches the flutter: an endless alternating scaleX/rotateY on the
 * inner face. This is what sells paper — the piece periodically turns
 * edge-on and appears to vanish for a frame.
 */
function addFlutter(face, kind) {
  if (reduceMotion) return;

  const slow = kind === 'streamer';

  anime({
    targets: face,
    scaleX: [1, -1],
    rotateY: [0, 180],
    duration: slow ? randomBetween(700, 1100) : randomBetween(240, 520),
    direction: 'alternate',
    loop: true,
    easing: 'easeInOutSine',
  });
}

/**
 * Ballistic flight with correct gravity easing.
 *
 * The fix over a single easeOutQuad across the whole arc: the rise and the
 * fall are separate keyframes with their OWN duration and easing. Rising
 * decelerates (easeOutQuad), falling accelerates (easeInQuad). Horizontal
 * travel decelerates across the full flight, which models air drag.
 */
function flyParticle({ outer, face }, opts) {
  const {
    travelX,
    riseH,
    fallExtra,
    riseTime,
    fallTime,
    delay = 0,
    spinScale = 1,
  } = opts;

  liveParticles += 1;

  anime({
    targets: outer,
    translateX: [
      { value: travelX, duration: riseTime + fallTime, easing: 'easeOutQuad' },
    ],
    translateY: [
      { value: -riseH, duration: riseTime, easing: 'easeOutQuad' },
      { value: fallExtra, duration: fallTime, easing: 'easeInQuad' },
    ],
    rotateZ: [
      { value: randomBetween(-420, 420) * spinScale, duration: riseTime + fallTime, easing: 'easeOutQuad' },
    ],
    rotateX: [
      { value: randomBetween(-720, 720) * spinScale, duration: riseTime + fallTime, easing: 'linear' },
    ],
    opacity: [
      { value: 1, duration: 1 },
      { value: 1, duration: (riseTime + fallTime) * 0.72 },
      { value: 0, duration: (riseTime + fallTime) * 0.28, easing: 'easeInQuad' },
    ],
    delay,
    complete: () => {
      anime.remove(face);
      outer.remove();
      liveParticles -= 1;
    },
  });
}

/* =========================================================
   Emitters
   ========================================================= */

/**
 * A corner cannon. Fires a cone of paper along `angleDeg` (measured
 * counter-clockwise from +X, so 90 is straight up).
 */
function fireCannon(originX, originY, angleDeg, spreadDeg, count) {
  const frag = document.createDocumentFragment();
  const queued = [];
  const h = window.innerHeight;

  for (let i = 0; i < count; i += 1) {
    if (liveParticles + queued.length >= MAX_PARTICLES) break;

    const particle = createParticle(originX, originY);
    const kind = styleAsPaper(particle.face);

    // Bias toward the cone centre so the edges of the spray thin out.
    const spread = (Math.random() + Math.random() - 1) * spreadDeg;
    const rad = ((angleDeg + spread) * Math.PI) / 180;
    const power = randomBetween(420, 1080) * (kind === 'streamer' ? 0.78 : 1);

    const travelX = Math.cos(rad) * power * randomBetween(0.85, 1.35);
    const riseH = Math.max(120, Math.sin(rad) * power);

    // Time scales with distance, so tall shots genuinely hang longer.
    const riseTime = 460 + riseH * 0.62;
    const fallDist = riseH + (h - originY) + 110;
    const fallTime = (620 + fallDist * 1.05) * (kind === 'streamer' ? 1.35 : 1);

    frag.appendChild(particle.outer);
    queued.push({
      particle,
      kind,
      opts: {
        travelX,
        riseH,
        fallExtra: fallDist - riseH,
        riseTime,
        fallTime,
        delay: randomBetween(0, 160),
        spinScale: kind === 'streamer' ? 0.55 : 1,
      },
    });
  }

  confettiLayer.appendChild(frag);
  queued.forEach(({ particle, kind, opts }) => {
    addFlutter(particle.face, kind);
    flyParticle(particle, opts);
  });
}

/**
 * Radial burst from a point — fireworks rather than a fountain. Pieces
 * shoot outward fast (easeOutQuart, heavy drag) and gravity takes over.
 */
function burstFrom(cx, cy, count) {
  const frag = document.createDocumentFragment();
  const queued = [];
  const h = window.innerHeight;

  for (let i = 0; i < count; i += 1) {
    if (liveParticles + queued.length >= MAX_PARTICLES) break;

    const particle = createParticle(cx, cy);
    const kind = styleAsPaper(particle.face);

    // Even angular coverage with jitter, so the ring reads as a ring.
    const rad = ((i / count) * 360 + randomBetween(-14, 14)) * (Math.PI / 180);
    const power = randomBetween(140, 420);
    const dx = Math.cos(rad) * power;
    const dy = -Math.sin(rad) * power;

    frag.appendChild(particle.outer);
    queued.push({
      particle,
      kind,
      dx,
      dy,
      fallDist: h - cy - dy + 130,
    });
  }

  confettiLayer.appendChild(frag);

  queued.forEach(({ particle, kind, dx, dy, fallDist }) => {
    addFlutter(particle.face, kind);
    liveParticles += 1;

    const fallTime = 700 + fallDist * 1.1;

    anime({
      targets: particle.outer,
      translateX: [
        { value: dx * 1.5, duration: 340 + fallTime, easing: 'easeOutQuart' },
      ],
      translateY: [
        { value: dy, duration: 340, easing: 'easeOutQuart' },
        { value: dy + fallDist, duration: fallTime, easing: 'easeInQuad' },
      ],
      rotateZ: randomBetween(-540, 540),
      rotateX: randomBetween(-720, 720),
      scale: [{ value: 0.4, duration: 1 }, { value: 1, duration: 220, easing: 'easeOutBack' }],
      opacity: [
        { value: 1, duration: 1 },
        { value: 1, duration: (340 + fallTime) * 0.7 },
        { value: 0, duration: (340 + fallTime) * 0.3, easing: 'easeInQuad' },
      ],
      complete: () => {
        anime.remove(particle.face);
        particle.outer.remove();
        liveParticles -= 1;
      },
    });
  });
}

/**
 * Slow twinkling glitter drifting down from above the fold. Keeps the
 * celebration alive after the cannon volleys have landed.
 */
function dropGlitter(count) {
  if (reduceMotion) return;

  const frag = document.createDocumentFragment();
  const queued = [];
  const w = window.innerWidth;
  const h = window.innerHeight;

  for (let i = 0; i < count; i += 1) {
    if (liveParticles + queued.length >= MAX_PARTICLES) break;

    const x = randomBetween(0, w);
    const particle = createParticle(x, -40);

    particle.face.className = 'cf__glyph';
    particle.face.textContent = pick(['✦', '✧', '★', '❋']);
    particle.face.style.color = pick(CONFETTI_COLORS);
    particle.face.style.fontSize = `${randomBetween(9, 20)}px`;

    frag.appendChild(particle.outer);
    queued.push({ particle, x });
  }

  confettiLayer.appendChild(frag);

  queued.forEach(({ particle }) => {
    liveParticles += 1;
    const duration = randomBetween(2600, 4600);

    // Twinkle runs on the inner node, drift on the outer node.
    anime({
      targets: particle.face,
      opacity: [randomBetween(0.2, 0.5), 1],
      scale: [0.7, 1.15],
      duration: randomBetween(380, 820),
      direction: 'alternate',
      loop: true,
      easing: 'easeInOutSine',
    });

    anime({
      targets: particle.outer,
      translateY: [{ value: h + 80, duration, easing: 'linear' }],
      translateX: [
        { value: randomBetween(-70, 70), duration: duration * 0.5, easing: 'easeInOutSine' },
        { value: randomBetween(-70, 70), duration: duration * 0.5, easing: 'easeInOutSine' },
      ],
      rotateZ: randomBetween(-180, 180),
      delay: randomBetween(0, 1400),
      complete: () => {
        anime.remove(particle.face);
        particle.outer.remove();
        liveParticles -= 1;
      },
    });
  });
}

/**
 * Tears down every live particle. Without this, winning and immediately
 * starting a new game leaves the old confetti in flight and liveParticles
 * pinned near MAX_PARTICLES, which starves the next celebration.
 */
function clearConfetti() {
  celebrationTimers.forEach(clearTimeout);
  celebrationTimers = [];

  confettiLayer.querySelectorAll('.cf').forEach((outer) => {
    const face = outer.firstElementChild;
    // The face carries the infinite flutter/twinkle loop; remove it first or
    // the instance keeps running against a detached node.
    if (face) anime.remove(face);
    anime.remove(outer);
    outer.remove();
  });

  confettiLayer.querySelectorAll('.shockwave').forEach((ring) => {
    anime.remove(ring);
    ring.remove();
  });

  anime.remove(flashEl);
  flashEl.style.opacity = 0;
  liveParticles = 0;
}

function shockwaveAt(x, y) {
  if (reduceMotion) return;

  const ring = document.createElement('div');
  ring.className = 'shockwave';
  ring.style.left = `${x}px`;
  ring.style.top = `${y}px`;
  // Inside the clipping layer so an expanding ring can never extend the page
  // box (body is no longer overflow:hidden, so that would add scrollbars).
  confettiLayer.appendChild(ring);

  anime({
    targets: ring,
    scale: [0.2, 16],
    opacity: [0.85, 0],
    borderWidth: [3, 0.5],
    duration: 900,
    easing: 'easeOutExpo',
    complete: () => ring.remove(),
  });
}

function flashScreen(intensity = 0.85, duration = 620) {
  if (reduceMotion) return;

  anime.remove(flashEl);
  anime({
    targets: flashEl,
    opacity: [
      { value: intensity, duration: 90, easing: 'easeOutQuad' },
      { value: 0, duration: duration, easing: 'easeOutQuad' },
    ],
  });
}

/* =========================================================
   Marks (SVG line drawing)
   ========================================================= */

const SVG_NS = 'http://www.w3.org/2000/svg';

function buildMark(player) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', `mark mark--${player.toLowerCase()}`);

  const shapes =
    player === 'X'
      ? ['M28 28 L72 72', 'M72 28 L28 72']
      : ['M50 24 a26 26 0 1 1 -0.01 0'];

  shapes.forEach((d) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });

  return svg;
}

function drawMark(cell, player) {
  const svg = buildMark(player);
  // The button's aria-label wins the accessible-name computation, so the mark
  // must be hidden and the label rewritten or the board reads as nine
  // identical empty cells forever.
  svg.setAttribute('aria-hidden', 'true');
  cell.appendChild(svg);
  cell.classList.add('filled');
  cell.setAttribute('aria-label', `Cell ${Number(cell.dataset.index) + 1}, ${player}`);

  const paths = svg.querySelectorAll('path');

  if (reduceMotion) {
    anime({ targets: paths, opacity: [0, 1], duration: 150, easing: 'linear' });
    return;
  }

  // anime.setDashoffset is the classic line-draw: it sets stroke-dasharray
  // to the path length and returns that length as the starting offset.
  anime({
    targets: paths,
    strokeDashoffset: [anime.setDashoffset, 0],
    duration: 380,
    delay: anime.stagger(110),
    easing: 'easeOutQuart',
  });

  anime({
    targets: svg,
    scale: [0.55, 1],
    rotate: [player === 'X' ? -14 : 10, 0],
    duration: 780,
    easing: 'easeOutElastic(1, 0.55)',
  });

  // Deliberately no animation on `cell` itself: the hover handler owns the
  // cell's transform (scale + translateY), and a second instance here would
  // reset translateY and snap a hovered cell down mid-click. The SVG's own
  // elastic above already sells the placement.
}

function rippleAt(cell, event) {
  if (reduceMotion) return;

  const rect = cell.getBoundingClientRect();
  // Enter/Space on a <button> dispatches a click with detail 0 and no
  // coordinates; offsetting from those puts the ripple far outside the cell,
  // where overflow:hidden clips it entirely. Fall back to the centre.
  const keyboard = event.detail === 0 || (event.clientX === 0 && event.clientY === 0);
  const x = keyboard ? rect.width / 2 : event.clientX - rect.left;
  const y = keyboard ? rect.height / 2 : event.clientY - rect.top;

  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  cell.appendChild(ripple);

  anime({
    targets: ripple,
    scale: [0, 14],
    opacity: [0.6, 0],
    duration: 620,
    easing: 'easeOutExpo',
    complete: () => ripple.remove(),
  });
}

/* =========================================================
   Winning line strike-through
   ========================================================= */

function drawStrike(line) {
  const first = cells[line[0]];
  const last = cells[line[2]];
  const w = boardEl.clientWidth;
  const h = boardEl.clientHeight;

  strikeEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  strikeEl.innerHTML = '';

  const x1 = first.offsetLeft + first.offsetWidth / 2;
  const y1 = first.offsetTop + first.offsetHeight / 2;
  const x2 = last.offsetLeft + last.offsetWidth / 2;
  const y2 = last.offsetTop + last.offsetHeight / 2;

  // Overshoot slightly past both centres so the line caps outside the marks.
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const over = 26;
  const ox = (dx / len) * over;
  const oy = (dy / len) * over;

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M${x1 - ox} ${y1 - oy} L${x2 + ox} ${y2 + oy}`);
  strikeEl.appendChild(path);

  anime({
    targets: path,
    strokeDashoffset: [anime.setDashoffset, 0],
    duration: reduceMotion ? 120 : 460,
    delay: reduceMotion ? 0 : 180,
    easing: 'easeOutQuart',
  });
}

/* =========================================================
   Status text
   ========================================================= */

function setStatus(text) {
  // textContent lags by one fade-out (130ms), so comparing against it made a
  // quick second call match the stale value and drop its own text, leaving
  // the previous player's turn on screen.
  if (statusTarget === text) return;
  statusTarget = text;

  if (reduceMotion) {
    statusText.textContent = text;
    return;
  }

  anime.remove(statusText);
  anime({
    targets: statusText,
    opacity: [1, 0],
    translateY: [0, -10],
    duration: 130,
    easing: 'easeInQuad',
    complete: () => {
      statusText.textContent = text;
      anime({
        targets: statusText,
        opacity: [0, 1],
        translateY: [12, 0],
        duration: 420,
        easing: 'easeOutBack',
      });
    },
  });
}

/* =========================================================
   Celebration choreography
   ========================================================= */

function celebrate(line) {
  const boardRect = boardEl.getBoundingClientRect();
  const cx = boardRect.left + boardRect.width / 2;
  const cy = boardRect.top + boardRect.height / 2;
  const w = window.innerWidth;
  const h = window.innerHeight;

  // A second win must not inherit the previous one's pending volleys.
  celebrationTimers.forEach(clearTimeout);
  celebrationTimers = [];

  activeWinLine = line;
  drawStrike(line);

  const winCells = line.map((i) => cells[i]);
  anime.remove(winCells);

  // Guard runs BEFORE any cell motion: a springy 900ms elastic on the board is
  // exactly what prefers-reduced-motion exists to suppress.
  if (reduceMotion) {
    anime({
      targets: winCells,
      opacity: [{ value: 0.55, duration: 160 }, { value: 1, duration: 260 }],
      easing: 'linear',
    });
    return;
  }

  boardBusy = true;

  // Peaks at scale 1.06. Cells are 115.3px in a grid with a 10px gap, so they
  // collide with their neighbours above 1.087 - the old 1.16 made the winning
  // row visibly climb on top of the cells beside it.
  anime({
    targets: winCells,
    scale: [
      { value: 1.06, duration: 180, easing: 'easeOutQuad' },
      { value: 1, duration: 900, easing: 'easeOutElastic(1, 0.42)' },
    ],
    delay: anime.stagger(110, { start: 120 }),
    complete: () => {
      boardBusy = false;
    },
  });

  flashScreen();
  shockwaveAt(cx, cy);

  // Card recoil - the whole UI reacts to the blast.
  anime({
    targets: cardEl,
    scale: [
      { value: 1.05, duration: 150, easing: 'easeOutQuad' },
      { value: 1, duration: 1100, easing: 'easeOutElastic(1, 0.35)' },
    ],
    rotate: [
      { value: randomBetween(-1.4, 1.4), duration: 150 },
      { value: 0, duration: 900, easing: 'easeOutElastic(1, 0.4)' },
    ],
  });

  // Volley 1 - corner cannons, immediately.
  fireCannon(24, h - 12, 68, 26, 30);
  fireCannon(w - 24, h - 12, 112, 26, 30);

  // Every deferred volley keeps its handle so New Game can cancel it, instead
  // of raining confetti over a board that has already been reset.
  celebrationTimers.push(
    // Firework burst out of the board itself, just behind the cannons.
    setTimeout(() => burstFrom(cx, cy, 34), 150),

    // Volley 2 - flatter, wider, throws confetti across the screen.
    setTimeout(() => {
      fireCannon(24, h - 12, 55, 20, 24);
      fireCannon(w - 24, h - 12, 125, 20, 24);
    }, 380),

    // Volley 3 - steep and tall, so the last pieces hang the longest.
    setTimeout(() => {
      fireCannon(w * 0.28, h - 12, 84, 24, 22);
      fireCannon(w * 0.72, h - 12, 96, 24, 22);
      shockwaveAt(cx, cy);
    }, 820),

    // Lingering glitter.
    setTimeout(() => dropGlitter(30), 1000)
  );
}

/* =========================================================
   Draw ("everybody loses") choreography
   ========================================================= */

function launchPoopConfetti() {
  const h = window.innerHeight;
  const w = window.innerWidth;

  // Board sags and desaturates — deliberately the opposite of a win.
  cells.forEach((cell) => cell.classList.add('dud'));

  if (reduceMotion) return;

  anime({
    targets: boardEl,
    translateY: [
      { value: -8, duration: 140, easing: 'easeOutQuad' },
      { value: 0, duration: 900, easing: 'easeOutBounce' },
    ],
  });

  // Status wobbles like a head-shake.
  // Delayed past setStatus's fade-out+fade-in (130 + 420ms). Both animate
  // #status, and two instances on one element stomp each other's transform.
  anime({
    targets: statusText,
    translateX: [0, -7, 7, -5, 5, 0],
    duration: 520,
    delay: 620,
    easing: 'easeInOutSine',
  });

  const frag = document.createDocumentFragment();
  const queued = [];

  for (let i = 0; i < 22; i += 1) {
    if (liveParticles + queued.length >= MAX_PARTICLES) break;

    const fromLeft = Math.random() > 0.5;
    const originX = fromLeft ? 26 : w - 26;
    const particle = createParticle(originX, h - 12);

    particle.face.className = 'cf__glyph';
    particle.face.textContent = '💩';
    particle.face.style.fontSize = `${randomBetween(20, 40)}px`;

    const rad = ((fromLeft ? randomBetween(52, 82) : randomBetween(98, 128)) * Math.PI) / 180;
    const power = randomBetween(260, 620);

    frag.appendChild(particle.outer);
    queued.push({
      particle,
      travelX: Math.cos(rad) * power,
      riseH: Math.max(110, Math.sin(rad) * power),
      spin: randomBetween(-90, 90),
    });
  }

  confettiLayer.appendChild(frag);

  queued.forEach(({ particle, travelX, riseH, spin }) => {
    liveParticles += 1;

    // Sadder than the win confetti: lower arcs, slower spin, a wet plop
    // at the bottom instead of a clean fade.
    const riseTime = 420 + riseH * 0.7;
    const fallDist = riseH + 100;
    const fallTime = 560 + fallDist * 1.15;

    anime({
      targets: particle.outer,
      translateX: [{ value: travelX, duration: riseTime + fallTime, easing: 'easeOutQuad' }],
      translateY: [
        { value: -riseH, duration: riseTime, easing: 'easeOutQuad' },
        { value: fallDist - riseH, duration: fallTime, easing: 'easeInQuad' },
      ],
      rotateZ: [{ value: randomBetween(-200, 200), duration: riseTime + fallTime, easing: 'easeOutQuad' }],
      delay: randomBetween(0, 260),
      complete: () => {
        // Squash on landing, then sink.
        anime({
          targets: particle.face,
          // rotateZ is restated because this is a second instance on the same
          // node; omitting it would snap the emoji upright as it lands.
          rotateZ: spin,
          scaleX: [1, 1.5],
          scaleY: [1, 0.45],
          opacity: [1, 0],
          duration: 480,
          easing: 'easeOutQuad',
          complete: () => {
            particle.outer.remove();
            liveParticles -= 1;
          },
        });
      },
    });

    anime({
      targets: particle.face,
      scale: [{ value: 0.4, duration: 1 }, { value: 1, duration: 300, easing: 'easeOutBack' }],
      rotateZ: spin,
      duration: riseTime,
    });
  });
}

/* =========================================================
   Game logic
   ========================================================= */

function checkWinner() {
  for (const line of winningLines) {
    const [a, b, c] = line;

    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return line;
    }
  }

  return null;
}

function handleMove(event) {
  // currentTarget, not target: the cell now contains an SVG mark, and a
  // click landing on that child would otherwise give a NaN index.
  const cell = event.currentTarget;
  const index = Number(cell.dataset.index);

  if (resetting || board[index] || gameOver) {
    return;
  }

  rippleAt(cell, event);

  board[index] = currentPlayer;
  drawMark(cell, currentPlayer);

  const winnerLine = checkWinner();

  if (winnerLine) {
    gameOver = true;
    setStatus(`Player ${currentPlayer} wins!`);
    winnerLine.forEach((winningIndex) => cells[winningIndex].classList.add('winner'));
    // Move focus off the board before disabling it: disabling the focused
    // element drops focus to <body>, stranding keyboard users.
    if (cells.length && [...cells].includes(document.activeElement)) {
      resetButton.focus();
    }
    cells.forEach((button) => (button.disabled = true));
    celebrate(winnerLine);
    return;
  }

  if (board.every(Boolean)) {
    gameOver = true;
    setStatus("It's a draw!");
    // The draw path used to leave every cell enabled, which combined with
    // resetGame's async DOM clear to let a click land on a "finished" board.
    if (cells.length && [...cells].includes(document.activeElement)) {
      resetButton.focus();
    }
    cells.forEach((button) => (button.disabled = true));
    launchPoopConfetti();
    return;
  }

  currentPlayer = currentPlayer === 'X' ? 'O' : 'X';
  setStatus(`Player ${currentPlayer}'s turn`);
}

function resetGame() {
  // Kill anything still in flight from the previous round: pending confetti
  // volleys, live particles, and the liveParticles counter they hold up.
  clearConfetti();

  board = Array(9).fill('');
  currentPlayer = 'X';
  gameOver = false;
  activeWinLine = null;
  setStatus("Player X's turn");

  strikeEl.innerHTML = '';

  anime.remove(cells);
  anime.remove(boardEl);
  anime.remove(cardEl);
  cardEl.style.transform = '';

  /* The board is emptied inside an animation callback ~290ms from now, but
     board[] is already empty. Disabling the cells synchronously closes that
     window - otherwise a click lands against the fresh empty state, records a
     move, and then has its mark wiped by clear(), leaving an invisible mark
     that blocks the square for the rest of the game. */
  boardBusy = true;
  resetting = true;
  cells.forEach((cell) => (cell.disabled = true));

  const clear = () => {
    cells.forEach((cell, i) => {
      cell.innerHTML = '';
      cell.disabled = false;
      cell.classList.remove('winner', 'dud', 'filled');
      cell.setAttribute('aria-label', `Cell ${i + 1}, empty`);
      // Explicitly neutral: a killed instance can otherwise strand a cell
      // mid-flip at a partial rotateY/opacity.
      cell.style.transform = '';
      cell.style.opacity = '';
    });
    boardBusy = false;
    resetting = false;
  };

  if (reduceMotion) {
    clear();
    return;
  }

  // Cells flip away, get emptied at the halfway point, then flip back.
  anime({
    targets: cells,
    rotateY: [0, 90],
    opacity: [1, 0.25],
    duration: 220,
    delay: anime.stagger(35, { grid: [3, 3], from: 'center' }),
    easing: 'easeInQuad',
    complete: () => {
      clear();
      boardBusy = true;
      anime({
        targets: cells,
        rotateY: [-90, 0],
        opacity: [0.25, 1],
        duration: 520,
        delay: anime.stagger(35, { grid: [3, 3], from: 'center' }),
        easing: 'easeOutBack',
        complete: () => {
          boardBusy = false;
          cells.forEach((cell) => {
            cell.style.transform = '';
            cell.style.opacity = '';
          });
        },
      });
    },
  });

  anime({
    targets: resetButton,
    scale: [{ value: 0.94, duration: 90 }, { value: 1, duration: 560, easing: 'easeOutElastic(1, 0.5)' }],
  });
}

/* =========================================================
   Entrance + wiring
   ========================================================= */

function playIntro() {
  if (reduceMotion) return;

  // The intro's starting state is opacity 0. requestAnimationFrame is
  // throttled in a background tab, so running it while hidden would leave
  // the card invisible until the tab is focused. Wait for visibility.
  if (document.hidden) {
    document.addEventListener('visibilitychange', function once() {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', once);
      motionQuery.addEventListener('change', (e) => {
  reduceMotion = e.matches;
  if (!reduceMotion) return;
  // Switching Reduce Motion on must stop what is already moving.
  clearConfetti();
  anime.remove(cells);
  anime.remove(cardEl);
  anime.remove(boardEl);
  anime.remove(statusText);
  boardBusy = false;
  cardEl.style.transform = '';
  cells.forEach((cell) => {
    cell.style.transform = '';
    cell.style.opacity = '';
  });
});

// The winning strike line is drawn in board pixel coordinates, so it has to be
// redrawn if the board changes size while the finished game is still on screen.
window.addEventListener('resize', () => {
  if (activeWinLine) drawStrike(activeWinLine);
});

playIntro();
    });
    return;
  }

  boardBusy = true;

  anime({
    targets: cardEl,
    translateY: [40, 0],
    scale: [0.94, 1],
    opacity: [0, 1],
    duration: 900,
    easing: 'easeOutElastic(1, 0.7)',
  });

  /* Starts at 0.5, not 0. easeOutBack overshoots by ~13.2% of the tween's
     range, so scaling from 0 peaked at 1.132 - past the 1.087 at which these
     cells overlap their neighbours - and the whole grid visibly collided for
     a quarter of a second on load. From 0.5 the peak is 1.066. */
  anime({
    targets: cells,
    scale: [0.5, 1],
    opacity: [0, 1],
    duration: 700,
    delay: anime.stagger(45, { grid: [3, 3], from: 'center', start: 180 }),
    easing: 'easeOutBack',
    complete: () => {
      boardBusy = false;
      cells.forEach((cell) => {
        cell.style.transform = '';
        cell.style.opacity = '';
      });
    },
  });
}

cells.forEach((cell) => {
  cell.addEventListener('click', handleMove);

  if (reduceMotion) return;

  /* Springy hover / press feedback.

     Both handlers bail out while `boardBusy` is set. anime.js does not compose
     transforms across instances on one element, so calling anime.remove(cell)
     here during the intro or the reset flip used to destroy that cell's
     in-flight animation and strand it - rotated, faded and never restored -
     because nothing else ever writes rotateY/opacity back. */
  cell.addEventListener('mouseenter', () => {
    if (boardBusy || cell.disabled || gameOver) return;
    anime.remove(cell);
    anime({ targets: cell, scale: 1.06, translateY: -3, duration: 260, easing: 'easeOutBack' });
  });

  cell.addEventListener('mouseleave', () => {
    if (boardBusy || gameOver) return;
    anime.remove(cell);
    anime({ targets: cell, scale: 1, translateY: 0, duration: 420, easing: 'easeOutElastic(1, 0.6)' });
  });
});

resetButton.addEventListener('click', resetGame);

resetButton.addEventListener('mouseenter', () => {
  if (reduceMotion) return;
  anime.remove(resetButton);
  anime({ targets: resetButton, scale: 1.03, duration: 240, easing: 'easeOutBack' });
});

resetButton.addEventListener('mouseleave', () => {
  if (reduceMotion) return;
  anime.remove(resetButton);
  anime({ targets: resetButton, scale: 1, duration: 420, easing: 'easeOutElastic(1, 0.6)' });
});

playIntro();
