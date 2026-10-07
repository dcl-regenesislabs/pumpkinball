# Pumpkin Ball!

A multiplayer **pumpkin dodgeball** game for [Decentraland](https://decentraland.org), in the spirit of Blade Ball, with a
solo boss adventure on the side. A glowing, tumbling jack-o'-lantern homes in on one player at a time. If you're the target,
swing your bat at exactly the right moment to **parry** it onto someone else. Get hit too often, touch the lava, or get caught
by the Vampire's tricks, and you're out. Last player standing wins.

Works on desktop and on phones (touch controls).

## Game modes

### Multiplayer match

1. **Join** – stand on the glowing pumpkin-sigil join pad on the lobby balcony to enter the queue.
2. **Countdown** – once at least 2 players are queued, a 10-second countdown starts, then everyone is teleported onto the
   arena for a 3-2-1.
3. **Survive** – the pumpkin locks onto a player (marked with a spinning ring on the ground). When it reaches you, parry it.
   - Press **E** (or left click on desktop, the bat button on phones) to swing. Parry too early or too late and you take a hit.
     Everyone has **3 HP**.
   - A successful parry sends the pumpkin to another living player, faster each time. A missed swing has a short cooldown;
     a good parry refunds it.
4. **Don't fall** – the arena is a raised ring surrounded by a toxic-green lava moat. Touching lava is instant elimination.
5. **The Vampire joins in** – there is no time limit. The round heats up on its own:

   | Time | What happens |
   | --- | --- |
   | 0:00 | Normal game |
   | ~0:20 | The Vampire rises in the middle (as a pure hazard: he cannot be hit and never throws pumpkins you can parry) and starts casting floor attacks |
   | ~0:30 | Slow **fire rings** start closing in from the edge |
   | Later | More and faster attacks, new kinds join in, rings close faster with narrower gaps. It ramps up faster when few players are left, so duels don't drag |

   - **Floor circles** fill up (a warning), then blast. Be off them when they pop.
   - **Green orbs** fly in straight lines. Dodge them. Don't swing at them.
   - **Explosive pumpkins** arc in and blast where they land.
   - **Fire rings** are concentric walls with gaps that slowly turn. They never overlap, and together they form a maze you
     walk through. A ring burns you (once in a while) if you touch it outside a gap.
   - Every hit costs a heart. The round always ends: the hazards keep getting harder until someone is the last one standing,
     and if the final two go out in the same instant, the second one is spared and wins.
6. **Win** – the last player alive gets a winner dance and an orbiting camera, then it's back to the lobby.
   Eliminated players spectate from the balcony and see all of the Vampire's hazards too.

A recap feed in the top corner shows who eliminated whom (the pumpkin, a player's parry, the Vampire, or the lava).

### Solo adventure

Talk to the **Vampire** in the lobby to start a solo run in the same ring (nobody else sees your run, and you don't see
other people's). Five levels, each against one or more bosses with their own attack combos and health bars:

1. **Pumpkin Lord** – the tutorial: one pumpkin, learn the swing.
2. **Scarecrow** – volleys of pumpkins and the first floor tiles.
3. **Skelly** – green orbs you must dodge (don't swing at them), mixed with volleys and tiles.
4. **Wizzir & Witch** – explosive pumpkins and fire rings, two bosses at once.
5. **The Vampire Master** – everyone together, then the Vampire Master himself, who goes through a second phase.

Parry a pumpkin back to hurt a boss. You have 3 hearts per level. Your progress (levels cleared) is saved on the server, and
beating the whole run earns you a closing talk with the Vampire.

### In the lobby

- Swing at pumpkin dummies for fun.
- Check the **leaderboard wall** (most match wins, saved on the server).
- Open the sound panel to change music and effects volume or mute (saved per player on the server; on phones use the "+" menu).

## Tech overview

Built with the Decentraland **SDK7** (TypeScript) using the **authoritative multiplayer server** model: one
scene file runs on both client and server (`isServer()` in [src/index.ts](src/index.ts) picks the entry point).

| Path | Purpose |
| --- | --- |
| `src/server/` | Authoritative game logic: round state machine, pumpkin simulation, parry resolution, the Vampire's hazard director ([hazards.ts](src/server/hazards.ts)), leaderboard, and per-player persistence (sound prefs, solo progress) |
| `src/client/` | Rendering, input, HUD (React-ECS), effects, music/SFX, the solo adventure ([solo.ts](src/client/solo.ts)), the shared hazard renderer ([arenaHazards.ts](src/client/arenaHazards.ts)), lights, winner cinematic, leaderboard display |
| `src/shared/` | Config/tuning ([config.ts](src/shared/config.ts)), hazard rules and pacing ([arenaHazards.ts](src/shared/arenaHazards.ts)), solo levels ([soloLevels.ts](src/shared/soloLevels.ts)), synced component schemas, client/server messages, deterministic pumpkin simulation, lava outline |
| `assets/` | 3D models, images and sounds; the scene layout is authored in the Creator Hub editor (`assets/scene/main.composite`) |
| `scripts/` | Blender/Python helpers (`generate-lava-shape.py`, `set-emission.py`) |
| `docs/` | Concept-art prompts for the visual style |
| `dclcontext/` | SDK7 reference notes used as AI-assistant context |

The server decides everything that matters (target selection, parry timing, hits, eliminations, every hazard hit); clients
only send inputs such as "I pressed parry" and render synced state, which keeps it cheat-resistant. The Vampire's attacks are
published as a short list of entries with a start time (server clock) and parameters, and every client works out where each
one is from its age, so nothing streams per frame and spectators see the same thing. Solo runs are local to the player's
client; the server only marks who is in one.

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

- **Gameplay numbers** (arena size, HP, countdown, pumpkin speed, parry timing, ...) live in
  [src/shared/config.ts](src/shared/config.ts).
- **The Vampire's pacing** (when he and the rings appear, how fast the pressure ramps, attack cadence, ring speed and gap
  width) is the `PACING` table in [src/shared/arenaHazards.ts](src/shared/arenaHazards.ts).
- **Solo levels and boss combos** are in [src/shared/soloLevels.ts](src/shared/soloLevels.ts).
- Dev flags in config.ts: `SOLO_TEST` lets a single player start a round (keep `false` for real play), `DEBUG_HUD` shows
  parry/server debug lines, `SOLO_LEVEL_SELECT` shows level buttons in the solo HUD.

If you move or reshape the lava in the editor, regenerate its outline with:

```bash
npm run lava
```

## Scene

Occupies a 10×10 parcel area (160 m × 160 m) with the arena at the centre and the lobby balcony to the south.
See [scene.json](scene.json) for parcels and spawn points.
