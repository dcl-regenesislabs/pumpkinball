# "Pumpkin Ball" — concept art prompts (for Gemini)

## Master prompt (paste this first)

Concept art for a stylized low-poly Halloween multiplayer arena game that runs in a web browser (Decentraland). The game is called "Pumpkin Ball": a Blade-Ball-style dodge-and-parry game where a glowing, tumbling jack-o'-lantern pumpkin homes in on one player at a time. The targeted player must swing a baseball bat at exactly the right moment to bounce the pumpkin to another player. Players have 3 HP, and anyone who falls off the arena is out instantly. Up to ~16 players, playful and competitive, spooky but fun (not gory).

SCENE LAYOUT (wide establishing shot, looking north from the lobby balcony):
- CENTER: a circular raised platform ("the ring"), about 44 m across and 4 m high. Dark purple-black matte stone, worn carved runes and pumpkin sigils, a glowing orange lip running around the edge so the drop-off reads clearly from far away.
- AROUND THE RING: a wide lake of glowing toxic green lava with slow green bubbles rising and popping, a charred black shore at the outer edge. Eerie green light washing up onto the platform's underside.
- OUTSIDE THE LAVA: a circle of spooky set dressing — leaning tombstones, dead twisted trees, tall stone pillars topped with purple flames, and giant carved jack-o'-lanterns. Night sky, huge moon, low fog, a few bats in the sky.
- FOREGROUND (south): the lobby is a stone balcony / viewing gallery, raised slightly above the arena so you look out across the fight. Low stone wall with a glowing orange trim rail. A glowing circular pumpkin-sigil "join pad" on the floor. A large wooden-and-stone LEADERBOARD wall behind the players. Players in varied cosmetic avatars hold baseball bats and watch.
- ACTION: the pumpkin mid-flight leaving a trail of small glowing purple bubbles. A glowing red ring marks the ground around the player it is hunting. One player swinging the bat with an orange burst of sparks; another hit player with a red/orange splash.

STYLE: stylized low-poly, chunky readable shapes, matte painted materials (NO glossy, NO metallic, NO realistic PBR shine), hand-painted look, bold silhouettes. Think Fall Guys / Roblox-quality readability with a Tim-Burton-lite spooky mood. Must be buildable as low-poly game assets (simple geometry, small textures).

PALETTE (keep these dominant): night blue-black #0B0A1A, stone violet #332642, platform #260D33, pumpkin orange #FF6600, magic purple #9933FF, toxic lava green #40F21A, danger red #FF1A00.

COMPOSITION: 16:9, wide-angle, camera slightly elevated behind the balcony railing; balcony in the bottom foreground, the ring in the center, the prop circle and moon in the background. No text or UI in the image.

## Follow-up prompts (one at a time, reusing the same style)

1. **Top-down map**: same world from directly above — balcony at the bottom, ring in the middle, lava lake, prop circle around it. Show scale: ring 44 m wide, lava lake 80 m wide, prop circle radius 52 m, balcony 40 m x 14 m.
2. **Arena action shot**: eye-level on the ring with 6-8 players spaced around the edge, pumpkin mid-flight with the purple bubble trail, red target ring on one player, lava glow behind.
3. **Balcony lobby detail**: join pad, leaderboard wall, railing, players swinging bats for fun, the arena visible beyond the rail.
4. **Prop sheet** (turnaround/asset sheet on a neutral background): 3 tombstone variants, 3 dead tree variants, stone pillar with purple flame, 2 giant jack-o'-lanterns, lava rocks. Flat matte, low-poly.
5. **Hero pumpkin**: front, side, back and 3/4 views of the glowing jack-o'-lantern (about 1 m wide), plus 3 face expressions (idle, hunting, hit).
6. **The bat**: a baseball bat with subtle spooky details (stitched pumpkin-vine grip, faint orange runes), front/side views.
7. **HUD/UI style frames**: three HP hearts (top center), kill-feed with round avatar heads (top right), a white ring button with a bat icon (bottom center), "YOU'RE ELIMINATED" banner. Purple/orange/white on translucent dark panels.

## Technical constraints to mention if Gemini goes too detailed

- Everything must read at a distance (players are ~1.8 m tall on a 44 m ring).
- Low-poly, few materials, small textures, matte only (roughness 100%).
- Lighting is stylized: glow comes from emissive parts (lava, rim, flames, pumpkin), not realistic lighting.
- The arena must stay visually clear: nothing tall on the platform, strong contrast at its edge.
