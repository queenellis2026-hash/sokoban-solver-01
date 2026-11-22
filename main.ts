// Sokoban solver entry for make.fun's sokoban-solver-01.
//
// Strategy: a level from this competition's generator is a hallway with independent rooms off
// it, and a box can never leave its room, so the level's push optimum is the sum of its rooms'
// optima. This solver cuts the level into rooms (the hallway squares a box could never bring
// to a goal are cut out of the player's row, and each remaining part holding boxes is a room),
// solves every room with a breadth-first search over pushes -- which is push-optimal -- and
// stitches the rooms' move strings together, carrying the player's square from one room to the
// next. Dead squares (a box there reaches no goal) and frozen 2x2 blocks prune the search. A
// room the breadth-first search cannot finish falls to an A* over pushes with an admissible
// estimate, which is push-optimal too; only a room that defeats both gives up on the level's
// room-by-room path, and the whole-level searches below are the last resort.
// All budgets are counted in search states, never in time, and nothing here reads a clock, so
// two runs of the program write byte-identical answers.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions as [dx, dy, walk letter, push letter], in a fixed order so every run agrees.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Work budgets, in states kept. A room of this generator is kept only when a plain push
// breadth-first search solves it within 250,000 states; the room cap leaves wide headroom.
// The whole-level cap is deliberately small: a level that does not decompose is outside this
// generator's shapes, and a long hopeless search must fail fast, never eat the run's wall.
const ROOM_STATES = 1500000;
const LEVEL_STATES = 500000;
const TOTAL_STATES = 9000000;

/** Parse XSB level text into width, height, a wall mask, goal squares, box squares, player. */
function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * For every square, the fewest pushes in which a lone box there (other boxes ignored) can be
 * brought onto some goal, by pulling boxes back from the goals over open floor; -1 when no
 * push sequence gets a box from the square to a goal (a dead square).
 */
function pushDistances(w, wall, goals) {
  const dist = new Int32Array(wall.length).fill(-1);
  const queue = [];
  for (const g of goals) {
    dist[g] = 0;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (!wall[y] && !wall[y - d] && dist[y] < 0) {
        dist[y] = dist[x] + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

/**
 * Flood the squares the player reaches from `from` around walls and the boxes in `occupied`,
 * stamping them in `seen` with `stamp`; returns the region's lowest square.
 */
function flood(w, wall, occupied, from, seen, stamp, stack) {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const dn = p + w;
    const lf = p - 1;
    const rt = p + 1;
    if (!wall[up] && !occupied[up] && seen[up] !== stamp) { seen[up] = stamp; stack[n++] = up; }
    if (!wall[dn] && !occupied[dn] && seen[dn] !== stamp) { seen[dn] = stamp; stack[n++] = dn; }
    if (!wall[lf] && !occupied[lf] && seen[lf] !== stamp) { seen[lf] = stamp; stack[n++] = lf; }
    if (!wall[rt] && !occupied[rt] && seen[rt] !== stamp) { seen[rt] = stamp; stack[n++] = rt; }
  }
  return low;
}

/** Whether the box just pushed onto `t` completes a frozen 2x2 of walls and boxes, one box off its goal. */
function frozenBlock(w, wall, occupied, goal, t) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case LURD letters. */
function walkPath(w, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkPath: target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after playing `moves` from `from` on a board `w` wide. */
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves) {
    const c = ch.toLowerCase();
    p += c === 'u' ? -w : c === 'd' ? w : c === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Rebuild the move string of a push search: `getBoxes(s)` gives state s's sorted boxes,
 * `parent[s]` its predecessor, `found` the solved state. Between pushes the player walks the
 * shortest way to the next push's standing square.
 */
function rebuildMoves(w, wall, startBoxes, startPlayer, getBoxes, parent, found) {
  const path = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  const occupied = new Uint8Array(wall.length);
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  for (const s of path) {
    const next = getBoxes(s);
    let from = -1;
    let to = -1;
    for (const b of boxes) if (!next.includes(b)) from = b;
    for (const b of next) if (!boxes.includes(b)) to = b;
    const d = to - from;
    const dir = DIRS.find((dd) => dd[1] * w + dd[0] === d);
    for (const b of boxes) occupied[b] = 1;
    moves += walkPath(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = next;
  }
  return moves;
}

/**
 * Breadth-first search over pushes: states are (sorted boxes, the player's reachable region),
 * expanded in push order, so the first solved state met is push-optimal. Returns
 * { pushes, moves, states } or null when the state budget runs out or no solution exists.
 */
function solvePushBFS(w, wall, goals, startBoxes, startPlayer, maxStates) {
  const size = wall.length;
  const nB = startBoxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = pushDistances(w, wall, goals);
  for (const b of startBoxes) if (dist[b] < 0) return null;
  const solved = (arr, off) => {
    for (let i = 0; i < nB; i++) if (!goal[arr[off + i]]) return false;
    return true;
  };
  if (solved(startBoxes, 0)) return { pushes: 0, moves: '', states: 1 };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Numeric state keys while the packing stays exact, string keys for the largest boards.
  const numeric = nB <= 5 && size <= 256;
  const keyOf = numeric
    ? (boxes, off, low) => { let k = low; for (let i = 0; i < nB; i++) k = k * size + boxes[off + i]; return k; }
    : (boxes, off, low) => String.fromCharCode(low, ...boxes.slice(off, off + nB));

  let cap = 1024;
  let sb = new Int32Array(cap * nB);
  let parent = new Int32Array(cap);
  let splayer = new Int32Array(cap);
  const grow = () => {
    const nsb = new Int32Array(cap * 2 * nB);
    nsb.set(sb);
    sb = nsb;
    const np = new Int32Array(cap * 2);
    np.set(parent);
    parent = np;
    const npl = new Int32Array(cap * 2);
    npl.set(splayer);
    splayer = npl;
    cap *= 2;
  };
  const index = new Map();
  sb.set(startBoxes, 0);
  parent[0] = -1;
  splayer[0] = startPlayer;
  for (const b of startBoxes) occupied[b] = 1;
  index.set(keyOf(sb, 0, flood(w, wall, occupied, startPlayer, seen, ++stamp, stack)), 0);
  for (const b of startBoxes) occupied[b] = 0;
  let count = 1;
  let found = -1;
  const cur = new Int32Array(nB);
  const nxt = new Int32Array(nB);

  for (let head = 0; found < 0 && head < count; head++) {
    const off = head * nB;
    for (let i = 0; i < nB; i++) { cur[i] = sb[off + i]; occupied[cur[i]] = 1; }
    flood(w, wall, occupied, splayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < nB && found < 0; bi++) {
      const b = cur[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || dist[t] < 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let key = null;
        if (!frozen) {
          for (let i = 0; i < nB; i++) nxt[i] = cur[i];
          nxt[bi] = t;
          nxt.sort();
          key = keyOf(nxt, 0, flood(w, wall, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (count >= maxStates) {
          for (const x of cur) occupied[x] = 0;
          return null;
        }
        if (count >= cap) grow();
        const noff = count * nB;
        for (let i = 0; i < nB; i++) sb[noff + i] = nxt[i];
        parent[count] = head;
        splayer[count] = b;
        index.set(key, count);
        count++;
        if (solved(sb, noff)) found = count - 1;
      }
    }
    for (const x of cur) occupied[x] = 0;
  }
  if (found < 0) return null;
  const getBoxes = (s) => Array.from(sb.slice(s * nB, s * nB + nB));
  const moves = rebuildMoves(w, wall, startBoxes, startPlayer, getBoxes, parent, found);
  // Count the pushes on the path: the path's length in states.
  let pushes = 0;
  for (let s = found; s > 0; s = parent[s]) pushes++;
  return { pushes, moves, states: count };
}

/**
 * A* over pushes with the admissible estimate "each box's lone-box push distance to its
 * nearest goal, summed" (one push lowers it by at most one, so the first solved state is
 * still push-optimal). A safety net for boards the breadth-first search cannot finish.
 */
function solvePushAStar(w, wall, goals, startBoxes, startPlayer, maxStates) {
  const size = wall.length;
  const nB = startBoxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = pushDistances(w, wall, goals);
  for (const b of startBoxes) if (dist[b] < 0) return null;
  const est = (boxes) => boxes.reduce((a, b) => a + dist[b], 0);
  const solved = (boxes) => boxes.every((b) => goal[b]);
  if (solved(startBoxes)) return { pushes: 0, moves: '', states: 1 };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (boxes, low) => String.fromCharCode(low, ...boxes);

  const sboxes = [startBoxes.slice()];
  const splayer = [startPlayer];
  const sg = [0];
  const skey = [''];
  const parent = [-1];
  const best = new Map();
  for (const b of startBoxes) occupied[b] = 1;
  skey[0] = keyOf(startBoxes, flood(w, wall, occupied, startPlayer, seen, ++stamp, stack));
  best.set(skey[0], 0);
  for (const b of startBoxes) occupied[b] = 0;

  // Binary heap on (f, then deeper g, then insertion order): fully deterministic.
  const heap = [[est(startBoxes), 0, 0]];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const hpush = (e) => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const hpop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };

  let found = -1;
  while (heap.length > 0 && found < 0) {
    const [, g, s] = hpop();
    if (best.get(skey[s]) !== s) continue;
    const cur = sboxes[s];
    if (solved(cur)) { found = s; break; }
    if (sboxes.length >= maxStates) return null;
    for (const b of cur) occupied[b] = 1;
    flood(w, wall, occupied, splayer[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < nB; bi++) {
      const b = cur[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || dist[t] < 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let key = null;
        let nxt = null;
        if (!frozen) {
          nxt = cur.slice();
          nxt[bi] = t;
          nxt.sort((x, y) => x - y);
          key = keyOf(nxt, flood(w, wall, occupied, b, mark, ++stamp, stack));
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen) continue;
        const prev = best.get(key);
        if (prev !== undefined && sg[prev] <= g + 1) continue;
        const id = sboxes.length;
        sboxes.push(nxt);
        splayer.push(b);
        sg.push(g + 1);
        skey.push(key);
        parent.push(s);
        best.set(key, id);
        hpush([g + 1 + est(nxt), g + 1, id]);
      }
    }
    for (const b of cur) occupied[b] = 0;
  }
  if (found < 0) return null;
  const moves = rebuildMoves(w, wall, startBoxes, startPlayer, (s) => sboxes[s], parent, found);
  return { pushes: sg[found], moves, states: sboxes.length };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there
 * reaches no goal) out of the floor; each part left that holds a box is a room. Null when the
 * level is no such set of rooms (a box in the hallway, a goal cut off, a part whose box and
 * goal counts differ).
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const dist = pushDistances(w, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && dist[i] < 0) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DIRS[k][1] * w + DIRS[k][0];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level text; returns the move string ('' when no solution was found in budget). */
function solveLevel(text, budget) {
  const level = parseLevel(text);
  const { w, wall } = level;
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const rooms = roomsOf(level);
  if (rooms !== null) {
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const subWall = wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const sq of other.done ? other.goals : other.boxes) subWall[sq] = 1;
      }
      const roomBoxes = room.boxes.slice().sort((a, b) => a - b);
      let sol = solvePushBFS(w, subWall, room.goals, roomBoxes, player, Math.min(ROOM_STATES, budget.left));
      if (sol === null) {
        // The A* estimate usually reaches the same optimum through far fewer states; only a
        // room that defeats both searches gives up on the room-by-room path.
        sol = solvePushAStar(w, subWall, room.goals, roomBoxes, player, Math.min(ROOM_STATES, budget.left));
      }
      if (sol === null) { ok = false; break; }
      budget.left -= sol.states;
      moves += sol.moves;
      player = endOf(w, player, sol.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  // Fallback: search the whole level, breadth-first, then A*.
  const bfs = solvePushBFS(w, wall, level.goals, level.boxes, level.player, Math.min(LEVEL_STATES, budget.left));
  if (bfs !== null) { budget.left -= bfs.states; return bfs.moves; }
  const astar = solvePushAStar(w, wall, level.goals, level.boxes, level.player, Math.min(LEVEL_STATES, budget.left));
  if (astar !== null) { budget.left -= astar.states; return astar.moves; }
  return '';
}

const budget = { left: TOTAL_STATES };
for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
