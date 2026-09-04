# Tic Tac Toe

A two-player Tic Tac Toe game in vanilla HTML, CSS and JavaScript, with
animation driven by [Anime.js](https://animejs.com).

No build step and nothing to install — open the file and play.

## Running it

Open `index.html` in a browser.

Some browsers restrict `file://` pages, so if anything misbehaves, serve the
folder instead:

```bash
python3 -m http.server 4173
```

Then visit <http://localhost:4173>.

Anime.js is vendored in `vendor/`, so the game also works offline.

## Features

- Two-player local play with win and draw detection.
- X and O are SVG strokes, drawn on rather than typed in.
- The winning line is struck through with an animated line and a glow.
- Winning triggers a layered confetti celebration; a draw gets its own
  (less dignified) send-off.
- Keyboard playable, and the board is readable by screen readers.
- Respects `prefers-reduced-motion`, including when toggled mid-session.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure |
| `styles.css` | Layout, board, and particle styling |
| `script.js` | Game logic and all animation |
| `vendor/anime.min.js` | Anime.js 3.2.2 (MIT) |
| `HANDOVER.md` | Implementation notes and the constraints behind the code |

## A note on the animation

The confetti is a ballistic simulation rather than a single tween: pieces
decelerate on the way up (`easeOutQuad`) and accelerate on the way down
(`easeInQuad`), with horizontal drag across the whole flight. Each particle is
two DOM nodes so its tumble and its flutter can animate independently.

[`HANDOVER.md`](HANDOVER.md) documents the non-obvious constraints — chiefly
that Anime.js does not compose transforms across separate instances on one
element, and that the board cells overlap above scale 1.087. Both have caused
real bugs, so it is worth reading before changing the animation code.

## Credits

Anime.js by Julian Garnier, MIT licensed.
