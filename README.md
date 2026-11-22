# Sokoban solver — make.fun sokoban-solver-01

A Sokoban solver for make.fun's "Build the best Sokoban solver" bounty. It reads every
instance under `/input/<id>/level.txt` (XSB format) and writes the player's moves to
`/output/<id>/solution.txt`, aiming for the push-optimal count on every level.

## Approach

Levels from this competition's generator are a one-square-wide hallway with independent
rooms off it, and a box pushed out of a room can never come back — so a level's push optimum
is the sum of its rooms' optima, and the rooms can be solved one at a time:

1. **Room decomposition.** Squares from which a lone box can never be pushed to any goal
   ("dead squares", found by pulling boxes back from the goals) are cut out of the player's
   row; each remaining part of the floor that holds boxes is one room.
2. **Push-optimal search per room.** A breadth-first search over pushes — a state is the
   sorted box squares plus the player's reachable region — expands states in push order, so
   the first solved state it meets uses the fewest possible pushes. Dead squares and frozen
   2x2 blocks of walls and boxes prune states that can never be solved.
3. **Stitching.** Rooms are solved in turn with the other rooms' boxes (or their goals, once
   finished) standing as walls; the player's walk between pushes is a shortest path, and the
   player's final square of one room is the starting square for the next.

A room the breadth-first search cannot finish falls to an A* over pushes (admissible
estimate: each box's lone-box push distance to its nearest goal, summed), which is
push-optimal too; and if a level does not decompose into rooms at all, both searches run
on the whole level as the last resort. All search budgets are counted in states, never in
time, and the program reads no clock and no randomness — two runs write identical answers.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<dir with i001..i005 level folders> MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22, no dependencies: only `node:fs` and `node:path`.
