# Don't Catch It!

A multiplayer **pumpkin dodgeball** game for [Decentraland](https://decentraland.org), in the spirit of Blade Ball.
A glowing, tumbling jack-o'-lantern homes in on one player at a time. If you're the target, swing your bat at
exactly the right moment to **parry** it onto someone else. Get hit too often, or touch the lava, and you're out.
Last player standing wins.

## How to play

1. **Join** – stand on the glowing pumpkin-sigil join pad on the lobby balcony to enter the queue.
2. **Countdown** – once at least 2 players are queued, a 10-second countdown starts and everyone is teleported onto the arena.
3. **Survive** – the pumpkin locks onto a player (marked with a red ring on the ground). When it reaches you, parry it.
   - Parry too early or too late and you take a hit. Everyone has **3 HP**.
   - A successful parry sends it to another living player, faster each time.
4. **Don't fall** – the arena is a raised ring surrounded by a toxic-green lava moat. Touching lava is instant elimination.
5. **Win** – the last player alive gets a winner dance and an orbiting camera, then it's back to the lobby.
   Eliminated players spectate from the balcony. There is no time limit: the Vampire rises in the middle after 20 seconds and
   starts floor attacks, slow fire rings follow at 30 seconds, and it all gets harder until someone is left (tune it in
   `src/shared/arenaHazards.ts`, `PACING`).

While waiting in the lobby you can swing at pumpkin dummies, check the leaderboard wall, and tweak music/SFX volume
(your settings are saved server-side).

## Tech overview

Built with the Decentraland **SDK7** (TypeScript) using the **authoritative multiplayer server** model: one
scene file runs on both client and server (`isServer()` in [src/index.ts](src/index.ts) picks the entry point).

| Path | Purpose |
| --- | --- |
| `src/server/` | Authoritative game logic: round state machine, pumpkin simulation, parry resolution, leaderboard and per-player sound-pref persistence |
| `src/client/` | Rendering, input, HUD (React-ECS), effects, music/SFX, lights, winner cinematic, leaderboard display |
| `src/shared/` | Config/tuning ([config.ts](src/shared/config.ts)), synced component schemas, client/server messages, deterministic pumpkin simulation, lava outline |
| `assets/` | 3D models, images and sounds; the scene layout is authored in the Creator Hub editor (`assets/scene/main.composite`) |
| `scripts/` | Blender/Python helpers (`generate-lava-shape.py`, `set-emission.py`) |
| `docs/` | Concept-art prompts for the visual style |
| `dclcontext/` | SDK7 reference notes used as AI-assistant context |

The server decides everything that matters (target selection, parry timing, hits, eliminations); clients only send
inputs such as "I pressed parry" and render synced state, which keeps it cheat-resistant.

## Getting started

Requirements: Node.js (see [.nvmrc](.nvmrc), v22.21.0) and the Decentraland SDK tooling (installed via npm).

```bash
npm install
npm run start     # run the scene locally (with the multiplayer server)
npm run build     # compile to bin/
npm run deploy    # publish the scene
```

You can also open the folder in the **Decentraland Creator Hub** to edit the layout visually.

### Tuning and dev switches

All gameplay numbers (arena size, HP, countdown, round length, pumpkin speed, ...) live in
[src/shared/config.ts](src/shared/config.ts). Two dev flags are there too:

- `SOLO_TEST` – lets a single player start a round (keep `false` for real play).
- `DEBUG_HUD` – shows parry/server debug lines on the HUD.

If you move or reshape the lava in the editor, regenerate its outline with:

```bash
npm run lava
```

## Scene

Occupies a 10×10 parcel area (160 m × 160 m) with the arena at the centre and the lobby balcony to the south.
See [scene.json](scene.json) for parcels and spawn points.
