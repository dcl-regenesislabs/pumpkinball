import { engine, UiCanvasInformation } from '@dcl/sdk/ecs'
import { Color4 } from '@dcl/sdk/math'
import ReactEcs, { Label, ReactEcsRenderer, UiEntity } from '@dcl/sdk/react-ecs'
import { getPlayer } from '@dcl/sdk/src/players'
import { IN_PROGRESS_SIGN_IMAGE, JOIN_SIGN_IMAGE } from './startSign'
import { BAT_ICON, FEED_TTL_MS, MAX_HP, PARRY_COOLDOWN_MS, Phase, PlayerStatus, DEBUG_HUD, SOLO_LEVEL_SELECT } from '../shared/config'
import { GameState, PlayerState, Pumpkin } from '../shared/schemas'
import { NOTICE_SHOW_MS, parryFeedback } from './feedback'
import { debug } from './debug'
import { feed, FeedEntry } from './feed'
import { displayName } from './names'
import { hasSwung, parryCooldown, requestParry } from './parry'
import { isMobile } from './platform'
import { MUSIC_ICONS, music, sfxPrefs, soundPanel } from './music'
import { playSfx, SWING_SFX, VAMPIRE_VOICE_SFX } from './sfx'
import { sinceRoundStart, START_IMAGE, START_SHOW_MS } from './roundStart'
import { isServerAlive } from './serverReadiness'
import { solo, vampireDialog } from './soloState'
import { jumpToLevel, killOneBoss, leaveSolo, nextSoloLevel, retrySolo } from './solo'
import { LEVELS } from '../shared/soloLevels'
import { acceptVampireFight, closeVampireDialog, vampireLines } from './vampire'

const ORANGE = Color4.create(1, 0.6, 0.1, 1)
const RED = Color4.create(1, 0.1, 0.1, 1)
const PANEL = Color4.create(0, 0, 0, 0.55)

type State = NonNullable<ReturnType<typeof readState>>

function readState() {
  for (const [, s] of engine.getEntitiesWith(GameState)) return s
  return undefined
}

function myId(): string | undefined {
  return getPlayer()?.userId?.toLowerCase()
}

function myStatus(): string {
  const me = myId()
  if (!me) return PlayerStatus.Idle
  for (const [, p] of engine.getEntitiesWith(PlayerState)) if (p.playerId === me) return p.status
  return PlayerStatus.Idle
}

function myHp(): number {
  const me = myId()
  if (!me) return 0
  for (const [, p] of engine.getEntitiesWith(PlayerState)) if (p.playerId === me) return p.hp
  return 0
}

function pumpkinTargetsMe(): boolean {
  const me = myId()
  if (!me) return false
  for (const [, p] of engine.getEntitiesWith(Pumpkin)) return p.active && p.targetId === me
  return false
}

function headline(s: State, status: string): string {
  switch (s.phase) {
    case Phase.Lobby:
      return s.queued > 0 ? `${s.queued} waiting on the pad` : 'Step on the pumpkin pad to join'
    case Phase.Countdown:
      return status === PlayerStatus.Queued ? 'Get ready! Round starts in' : 'Next round in'
    case Phase.Starting:
      return 'Get ready!'
    case Phase.Round:
      return `${s.alive} alive` // the round number is a server counter, not something players care about
    case Phase.Winner: {
      const name = s.winnerId ? (getPlayer({ userId: s.winnerId })?.name ?? 'Someone') : 'Nobody'
      return `${name} wins!`
    }
    default:
      return ''
  }
}

// ---- Layout: every size is a fraction of the SCREEN HEIGHT (text too), with a bigger variant for phones ----
// A phone screen is physically small, so small HUD pieces need to take a larger share of it to stay readable.
// Desktop numbers are the old pixel sizes divided by 1080. Percent values are relative to the screen.

interface Layout {
  bannerTop: number
  bannerH: number
  bannerFont: number
  bannerLeft: number // % of screen width
  bannerW: number
  hintTop: number
  hintH: number
  hintFont: number
  heartsTop: number
  heartF: number
  digitsF: number
  digitsTop: number
  debugTops: number[]
  debugH: number
  debugW: number // % of screen width
  debugFont: number
  feedTop: number // first row, when the debug lines are showing
  feedTopClean: number // first row, when they are not
  feedRowH: number
  feedGap: number
  feedW: number // % of screen width
  feedFont: number
  detailFont: number // reason line in the elimination sequence
}

const DESKTOP: Layout = {
  bannerTop: 0.015, bannerH: 0.041, bannerFont: 0.0204, bannerLeft: 30, bannerW: 40,
  hintTop: 0.059, hintH: 0.026, hintFont: 0.013,
  heartsTop: 0.093, heartF: 0.028,
  digitsF: 0.09, digitsTop: 0.1,
  debugTops: [0.015, 0.041, 0.067], debugH: 0.022, debugW: 18.75, debugFont: 0.011,
  feedTop: 0.1, feedTopClean: 0.015, feedRowH: 0.0315, feedGap: 0.035, feedW: 18.75, feedFont: 0.012,
  detailFont: 0.024
}

const MOBILE: Layout = {
  bannerTop: 0.02, bannerH: 0.105, bannerFont: 0.052, bannerLeft: 12, bannerW: 76,
  hintTop: 0.13, hintH: 0.075, hintFont: 0.038,
  heartsTop: 0.22, heartF: 0.085,
  digitsF: 0.2, digitsTop: 0.24,
  debugTops: [0.02, 0.1, 0.18], debugH: 0.07, debugW: 40, debugFont: 0.03,
  feedTop: 0.27, feedTopClean: 0.02, feedRowH: 0.085, feedGap: 0.095, feedW: 34, feedFont: 0.04,
  detailFont: 0.05
}

const layout = (): Layout => (isMobile() ? MOBILE : DESKTOP)

/**
 * The UI is drawn on a fixed virtual canvas that the renderer scales to the real screen (1920x1080 on desktop,
 * 1600x720 on phones, the SDK defaults). Layout units are virtual pixels, so sizes must be derived from THAT, not
 * from the real device resolution (UiCanvasInformation), or text comes out far too big on high-density screens.
 */
const VIRTUAL = { desktop: { w: 1920, h: 1080 }, mobile: { w: 1600, h: 720 } }
const virtualCanvas = () => (isMobile() ? VIRTUAL.mobile : VIRTUAL.desktop)
function canvasHeight(): number {
  return virtualCanvas().h
}
/** Fixed-size pieces (buttons, modals): a design size in virtual pixels, scaled up on phones (same idea as Marsh Colony). */
const S = (n: number) => Math.round(n * (isMobile() ? 1.6 : 1.18))
/** Like S() but for the in-game status HUD (banner, parry/ouch pop-up, hearts): on phones these stay compact so they don't cover the arena. */
const HS = (n: number) => Math.round(n * (isMobile() ? 0.8 : 1.18))
/** Scale for the match recap (top-right feed): small on phones, where many players fill the screen with rows quickly. */
const FS = (n: number) => Math.round(n * (isMobile() ? 0.85 : 1.18))
const FEED_MAX_ROWS_MOBILE = 3
const fontPx = (fractionOfHeight: number) => Math.max(9, Math.round(fractionOfHeight * canvasHeight()))

const WHITE = Color4.White()

// ---- Shared look for the HUD pieces: dark purple panels with an orange edge, rounded, sized in virtual px via S() ----

const PANEL_BG = Color4.create(0.1, 0.05, 0.17, 0.9)
const EDGE = Color4.create(1, 0.6, 0.1, 1)
const GOLD = Color4.create(1, 0.82, 0.25, 1)
const DANGER_EDGE = Color4.create(1, 0.2, 0.2, 1)

/** Rough pixel width of a text line (the UI doesn't measure text for us). Capitals are wider. */
function estW(text: string, font: number): number {
  let w = 0
  for (const ch of text) w += ch >= 'A' && ch <= 'Z' ? 0.7 : ch === ' ' || ch === 'i' || ch === 'l' || ch === '.' ? 0.32 : 0.56
  return Math.ceil(w * font)
}

type Tone = 'normal' | 'danger' | 'gold'

/** The main status line at the top center: headline of the match, or the pumpkin warning (red, pulsing). */
let bannerText = ''
const StatusBanner = (props: { text: string; tone: Tone }) => {
  if (props.text !== bannerText) {
    bannerText = props.text
    popPress('banner')
  }
  const k = popFactor('banner')
  const font = HS(24)
  const baseW = Math.max(HS(240), estW(props.text, font) + HS(56))
  const baseH = HS(48)
  const w = Math.round(baseW * k)
  const h = Math.round(baseH * k)
  const pulse = props.tone === 'danger' ? 0.5 + 0.5 * Math.sin(Date.now() / 140) : 0
  const bg = props.tone === 'danger' ? Color4.create(0.28 + 0.2 * pulse, 0.04, 0.07, 0.94) : PANEL_BG
  const edge = props.tone === 'danger' ? DANGER_EDGE : props.tone === 'gold' ? GOLD : EDGE
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: HS(10), left: '50%' },
        margin: { left: -Math.round(w / 2) },
        width: w,
        height: h,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: Math.round(h / 2),
        borderWidth: props.tone === 'danger' ? 3 : 2,
        borderColor: edge
      }}
      uiBackground={{ color: bg }}
    >
      <Label
        value={props.text}
        fontSize={Math.round(font * k)}
        color={props.tone === 'gold' ? GOLD : WHITE}
        textAlign="middle-center"
        textWrap="nowrap"
        uiTransform={{ width: '100%', height: Math.round(font * 1.3) }}
      />
    </UiEntity>
  )
}

/** "<name> WON this match!" with the winner's face, shown to everyone during the winner phase. */
const WinnerCard = (props: { winnerId: string; round: number }) => {
  if (props.round !== lastWinnerRound) {
    lastWinnerRound = props.round
    popPress('winner')
  }
  const k = 1 + 2 * (popFactor('winner') - 1)
  const name = displayName(props.winnerId)
  const head = S(70)
  const nameFont = S(30)
  const subFont = S(20)
  const textW = Math.max(estW(name, nameFont), estW('WON THIS MATCH!', subFont))
  const baseW = S(24) * 2 + head + S(18) + textW
  const baseH = head + S(24)
  const w = Math.round(baseW * k)
  const h = Math.round(baseH * k)
  const headSize = Math.round(head * k)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: S(10), left: '50%' },
        margin: { left: -Math.round(w / 2) },
        width: w,
        height: h,
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: Math.round(S(24) * k), right: Math.round(S(24) * k) },
        borderRadius: Math.round(h / 2),
        borderWidth: 3,
        borderColor: GOLD
      }}
      uiBackground={{ color: Color4.create(0.14, 0.07, 0.04, 0.94) }}
    >
      <UiEntity
        uiTransform={{ width: headSize, height: headSize, borderRadius: Math.round(headSize / 2), borderWidth: 3, borderColor: GOLD }}
        uiBackground={{ avatarTexture: { userId: props.winnerId }, textureMode: 'stretch' }}
      />
      <UiEntity uiTransform={{ width: Math.round(textW * k), height: '100%', margin: { left: Math.round(S(18) * k) }, flexDirection: 'column', justifyContent: 'center' }}>
        <Label value={name} fontSize={Math.round(nameFont * k)} color={GOLD} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: Math.round(nameFont * 1.3 * k) }} />
        <Label value="WON THIS MATCH!" fontSize={Math.round(subFont * k)} color={WHITE} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: '100%', height: Math.round(subFont * 1.3 * k) }} />
      </UiEntity>
    </UiEntity>
  )
}
let lastWinnerRound = -1

// ---- "Game starts in:" image at the top during the pad countdown (the digits go right below it) ----
const GAME_STARTS_IN_IMAGE = 'assets/images/GameStartsIn.png'
const GAME_STARTS_IN_ASPECT = 748 / 447
const GSI_TOP = 10
const GSI_GAP = 6
const gameStartsInHeight = () => S(88)

const GameStartsIn = () => {
  const h = gameStartsInHeight()
  const w = Math.round(h * GAME_STARTS_IN_ASPECT)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: S(GSI_TOP), left: '50%' },
        margin: { left: -Math.round(w / 2) },
        width: w,
        height: h,
        pointerFilter: 'none'
      }}
      uiBackground={{ texture: { src: GAME_STARTS_IN_IMAGE }, textureMode: 'stretch' }}
    />
  )
}

/** Where the countdown digits start: right under the "Game starts in" image (fraction of the screen height). */
const countdownDigitsTop = () => (S(GSI_TOP) + gameStartsInHeight() + S(GSI_GAP)) / canvasHeight()

// ---- "WINNER" image, only for the winner, low on the screen under their character during the winner animation ----
const WINNER_IMAGE = 'assets/images/Winner.png'
let winnerImgRound = -1
let winnerImgAt = 0

const WinnerImage = (props: { round: number }) => {
  if (props.round !== winnerImgRound) {
    winnerImgRound = props.round
    winnerImgAt = Date.now()
  }
  const age = Date.now() - winnerImgAt
  const pop = easeOutBack(clamp01(age / 450))
  const h = Math.max(2, Math.round(S(150) * Math.max(0.05, pop)))
  const w = Math.round(h * (1004 / 447))
  const bob = Math.round(Math.sin(age / 380) * S(6))
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '76%', left: '50%' },
        margin: { left: -Math.round(w / 2), top: -Math.round(h / 2) + bob },
        width: w,
        height: h,
        pointerFilter: 'none'
      }}
      uiBackground={{ texture: { src: WINNER_IMAGE }, textureMode: 'stretch' }}
    />
  )
}

/** "START" image in the middle of the screen when the pumpkin is released: pops in, holds, fades out. */
const StartBanner = () => {
  const age = sinceRoundStart()
  if (age < 0 || age > START_SHOW_MS) return null
  const pop = easeOutBack(clamp01(age / 200))
  const fade = 1 - clamp01((age - (START_SHOW_MS - 380)) / 380)
  const h = Math.max(2, Math.round(S(130) * Math.max(0.05, pop)))
  const w = Math.round(h * (1004 / 447))
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '24%', left: '50%' }, // above the middle of the screen, where the action is
        margin: { left: -Math.round(w / 2), top: -Math.round(h / 2) },
        width: w,
        height: h,
        pointerFilter: 'none'
      }}
      uiBackground={{ texture: { src: START_IMAGE }, textureMode: 'stretch', color: Color4.create(1, 1, 1, fade) }}
    />
  )
}

/** Short pop-up under the hearts for what just happened: PARRY!, OUCH!, Missed. Pops in, then fades. */
const FeedbackPop = (props: { text: string; age: number; top?: number }) => {
  const t = props.text
  const good = t.startsWith('PARRY')
  const bad = t.startsWith('OUCH')
  const colour = good ? Color4.create(0.45, 1, 0.5, 1) : bad ? Color4.create(1, 0.35, 0.35, 1) : Color4.create(0.85, 0.85, 0.95, 1)
  const edge = good ? Color4.create(0.3, 0.9, 0.4, 1) : bad ? DANGER_EDGE : Color4.create(0.6, 0.6, 0.75, 1)
  const pop = easeOutBack(clamp01(props.age / 180))
  const fade = 1 - clamp01((props.age - (NOTICE_SHOW_MS - 250)) / 250)
  const font = Math.max(8, Math.round(HS(34) * Math.max(0.2, pop)))
  const w = estW(t, font) + HS(56)
  const h = Math.round(font * 1.7)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: props.top ?? HS(132), left: '50%' },
        margin: { left: -Math.round(w / 2) },
        width: w,
        height: h,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: Math.round(h / 2),
        borderWidth: 3,
        borderColor: Color4.create(edge.r, edge.g, edge.b, fade)
      }}
      uiBackground={{ color: Color4.create(0.08, 0.04, 0.14, 0.9 * fade) }}
    >
      <Label
        value={t}
        fontSize={font}
        color={Color4.create(colour.r, colour.g, colour.b, fade)}
        textAlign="middle-center"
        textWrap="nowrap"
        uiTransform={{ width: '100%', height: Math.round(font * 1.3) }}
      />
    </UiEntity>
  )
}


// ---- Responsive layout ----
// Phones and desktops have very different UI canvas sizes, so the big pieces (countdown numbers, the "you're dead"
// sequence) are laid out in PERCENT of the screen. Squares need width = height, and percent widths refer to the screen
// WIDTH, so a square's width is derived from the screen's aspect ratio (width / height). Units cancel: it works anywhere.

/**
 * Screen width / height of the window. The virtual canvas keeps a fixed HEIGHT (1080) and its width follows the window
 * shape, so percent widths are relative to a canvas as wide as the window: squares must use the real aspect ratio.
 */
function uiAspect(): number {
  const info = UiCanvasInformation.getOrNull(engine.RootEntity)
  return info && info.width > 0 && info.height > 0 ? info.width / info.height : 16 / 9
}

const pct = (n: number): `${number}%` => `${n}%`

/** A square `f` of the screen height tall: its height and width as percent values. */
function square(f: number) {
  return { height: pct(f * 100), width: pct((f * 100) / uiAspect()) }
}

// ---- Countdown numbers: one image per digit (assets/images/00.png ... 09.png, a single digit each) ----

// Each digit image is a square with the glyph centred in it, at most ~0.47 of the width. So digits are placed at
// half-image spacing and the squares simply overlap in their empty margins.
const DIGIT_STEP = 0.5

const digitImage = (d: string) => `assets/images/0${d}.png`

/** A number drawn with the digit images, centred horizontally. `f` = digit height as a fraction of the screen height. */
const Digits = (props: { text: string; f: number; topFraction: number }) => {
  const n = props.text.length
  const span = (n - 1) * DIGIT_STEP + 1 // total width, in digit-squares
  const sq = square(props.f)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: `${props.topFraction * 100}%`, left: 0 },
        width: '100%',
        height: sq.height,
        justifyContent: 'center'
      }}
    >
      <UiEntity uiTransform={{ width: pct(((props.f * 100) / uiAspect()) * span), height: '100%' }}>
        {props.text.split('').map((d, i) => (
          <UiEntity
            key={`digit-${i}`}
            uiTransform={{
              positionType: 'absolute',
              position: { top: 0, left: `${((i * DIGIT_STEP) / span) * 100}%` },
              width: `${100 / span}%`,
              height: '100%'
            }}
            uiBackground={{ texture: { src: digitImage(d) }, textureMode: 'stretch' }}
          />
        ))}
      </UiEntity>
    </UiEntity>
  )
}

// The big 3-2-1 just before a round starts: each number pops in larger and settles.
let lastBigSecond = -1
let bigChangedAt = 0
const BIG_F = 0.28 // digit height, as a fraction of the screen height
const BIG_CENTER = 0.42 // vertical centre, as a fraction of the screen height
const POP_MS = 350

const BigCountdown = (props: { seconds: number }) => {
  if (props.seconds !== lastBigSecond) {
    lastBigSecond = props.seconds
    bigChangedAt = Date.now()
  }
  const t = Math.min(1, (Date.now() - bigChangedAt) / POP_MS)
  const pop = 1 + 0.45 * (1 - t) * (1 - t)
  const f = BIG_F * pop
  return <Digits text={`${props.seconds}`} f={f} topFraction={BIG_CENTER - f / 2} />
}

// Small left-aligned line in the top-right corner, for the dev debug readout.
const DebugLine = (props: { text: string; index: number }) => {
  const L = layout()
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: pct(L.debugTops[props.index] * 100), right: pct(0.8) },
        width: pct(L.debugW),
        height: pct(L.debugH * 100)
      }}
      uiBackground={{ color: PANEL }}
    >
      <Label
        value={props.text}
        fontSize={fontPx(L.debugFont)}
        color={WHITE}
        textAlign="middle-left"
        textWrap="nowrap"
        uiTransform={{ width: '100%', height: '100%', padding: { left: 6 } }}
      />
    </UiEntity>
  )
}

// Desktop parry button: a white ring around the bat icon. On touch screens the native big button
// (set up in controls.ts) is the bat instead.
// ---- Press "pop": a button swells a little and settles when pressed (feels good on touch). UI has no scale transform, so
// the visible part is an absolutely placed child that grows around the center, while the fixed outer slot keeps the layout
// and the hit area stable. ----
const BTN_POP_MS = 240
const BTN_POP_AMOUNT = 0.16
const popAt = new Map<string, number>()
const popPress = (id: string) => popAt.set(id, Date.now())
const popFactor = (id: string) => {
  const t = Date.now() - (popAt.get(id) ?? -1e9)
  return t >= 0 && t < BTN_POP_MS ? 1 + BTN_POP_AMOUNT * Math.sin((Math.PI * t) / BTN_POP_MS) : 1
}

const PopButton = (props: {
  id: string
  width: number
  height: number
  radius: number
  onPress: () => void
  bg?: Color4
  texture?: string
  label?: string
  font?: number
  labelColor?: Color4
  borderColor?: Color4
  slot?: { positionType?: 'absolute'; position?: { top?: number; right?: number; left?: number; bottom?: number }; margin?: { left?: number; right?: number; top?: number } }
  key?: string
}) => {
  const k = popFactor(props.id)
  const w = Math.round(props.width * k)
  const h = Math.round(props.height * k)
  const font = props.font ? Math.round(props.font * k) : 0
  return (
    <UiEntity
      uiTransform={{ width: props.width, height: props.height, pointerFilter: 'block', ...(props.slot ?? {}) }}
      onMouseDown={() => {
        popPress(props.id)
        props.onPress()
      }}
    >
      <UiEntity
        uiTransform={{
          positionType: 'absolute',
          position: { left: Math.round((props.width - w) / 2), top: Math.round((props.height - h) / 2) },
          width: w,
          height: h,
          justifyContent: 'center',
          alignItems: 'center',
          borderRadius: Math.round(props.radius * k),
          borderWidth: props.borderColor ? 2 : 0,
          borderColor: props.borderColor ?? Color4.Black(),
          pointerFilter: 'none'
        }}
        uiBackground={props.texture ? { texture: { src: props.texture }, textureMode: 'stretch', color: WHITE } : { color: props.bg ?? TILE }}
      >
        {props.label !== undefined && (
          <Label
            value={props.label}
            fontSize={font}
            color={props.labelColor ?? WHITE}
            textAlign="middle-center"
            textWrap="nowrap"
            uiTransform={{ width: '100%', height: Math.round(font * 1.3) }}
          />
        )}
      </UiEntity>
    </UiEntity>
  )
}

const ParryButton = () => {
  const frac = parryCooldown.fraction()
  const ready = frac >= 1
  const remaining = ((1 - frac) * PARRY_COOLDOWN_MS) / 1000
  const k = popFactor('parry')
  const size = Math.round(S(104) * k)
  const icon = Math.round(S(70) * k)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: S(40), left: '50%' },
        margin: { left: -Math.round(size / 2) },
        width: size,
        height: size,
        borderRadius: Math.round(size / 2),
        borderWidth: 4,
        borderColor: ready ? EDGE : Color4.create(1, 1, 1, 0.35),
        justifyContent: 'center',
        alignItems: 'center'
      }}
      uiBackground={{ color: Color4.create(0.1, 0.05, 0.17, 0.82) }}
      onMouseDown={() => {
        popPress('parry')
        requestParry()
      }}
    >
      <UiEntity
        uiTransform={{ width: icon, height: icon }}
        uiBackground={{ textureMode: 'stretch', texture: { src: BAT_ICON }, color: ready ? WHITE : Color4.create(1, 1, 1, 0.3) }}
      />
      {!ready && (
        <Label
          value={remaining.toFixed(1)}
          fontSize={S(20)}
          color={WHITE}
          uiTransform={{ positionType: 'absolute', position: { top: S(38), left: 0 }, width: '100%', height: S(28) }}
        />
      )}
    </UiEntity>
  )
}

// Rows are `feedRowH` of the screen height tall and `feedW` percent of its width. Heads are squares measured against
// the row, converted to a percent of the row's width through the screen's aspect ratio.
type FeedPart = { kind: 'head'; id: string } | { kind: 'pumpkin' } | { kind: 'text'; text: string; color?: Color4 }

/** Set by the Hud each frame: the sound button (top right, desktop) is hidden while you are playing, so the feed moves up. */
let soundButtonShown = false

const FeedRow = (props: { entry: FeedEntry; index: number; key?: string }) => {
  const e = props.entry
  const ICON = FS(30)
  const font = FS(16)
  const gap = FS(8)
  const parts: FeedPart[] =
    e.kind === 'fall'
      ? [
          { kind: 'head', id: e.victimId },
          { kind: 'text', text: displayName(e.victimId) },
          { kind: 'text', text: 'fell into the lava', color: EDGE }
        ]
      : [
          e.killerId ? { kind: 'head', id: e.killerId } : { kind: 'pumpkin' },
          { kind: 'text', text: e.killerId ? displayName(e.killerId) : 'The pumpkin' },
          { kind: 'text', text: 'eliminated', color: EDGE },
          { kind: 'head', id: e.victimId },
          { kind: 'text', text: displayName(e.victimId) }
        ]
  const widths = parts.map((part) => (part.kind === 'text' ? estW(part.text, font) : ICON))
  const w = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + FS(24)
  const h = FS(40)
  const age = Date.now() - e.at
  const slide = easeOutCubic(clamp01(age / 260))
  const fade = 1 - clamp01((age - (FEED_TTL_MS - 600)) / 600)
  const top = (soundButtonShown ? FS(64) : FS(10)) + props.index * (h + FS(6))
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top, right: Math.round(FS(12) - (1 - slide) * (w + FS(20))) },
        width: w,
        height: h,
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: FS(12), right: FS(12) },
        borderRadius: Math.round(h / 2),
        borderWidth: 2,
        borderColor: Color4.create(EDGE.r, EDGE.g, EDGE.b, 0.7 * fade)
      }}
      uiBackground={{ color: Color4.create(0.1, 0.05, 0.17, 0.88 * fade) }}
    >
      {parts.map((part, i) => {
        const margin = { left: i === 0 ? 0 : gap }
        if (part.kind === 'text') {
          return (
            <Label
              key={`fp-${i}`}
              value={part.text}
              fontSize={font}
              color={part.color ?? WHITE}
              textAlign="middle-left"
              textWrap="nowrap"
              uiTransform={{ width: widths[i], height: FS(24), margin }}
            />
          )
        }
        return (
          <UiEntity
            key={`fp-${i}`}
            uiTransform={{ width: ICON, height: ICON, margin, borderRadius: Math.round(ICON / 2) }}
            uiBackground={part.kind === 'head' ? { avatarTexture: { userId: part.id }, textureMode: 'stretch' } : { color: Color4.create(1, 0.45, 0, 1) }}
          />
        )
      })}
    </UiEntity>
  )
}

// Match recap, top right.
const KillFeed = () => (
  <UiEntity uiTransform={{ width: '100%', height: '100%', positionType: 'absolute', pointerFilter: 'none' }}>
    {feed.recent().slice(0, isMobile() ? FEED_MAX_ROWS_MOBILE : undefined).map((entry, i) => (
      <FeedRow key={`feed-${entry.at}-${entry.victimId}`} entry={entry} index={i} />
    ))}
  </UiEntity>
)

// ---- "YOU'RE DEAD" sequence: the skull expands in the middle of the screen, rises, and the title slides out from under it ----
// All sizes and positions are fractions of the screen height (see "Responsive layout" above).

const TITLE_IMAGE = 'assets/images/YOUAREDEAD.png'
const SKULL_IMAGE = 'assets/images/Skull01.png'
const TITLE_F = 0.5 // title height
const SKULL_BIG_F = 0.41 // the skull while it sits in the middle of the screen
const SKULL_FINAL_F = 0.3 // ...and after it has risen to the top
const SKULL_MIDDLE = 0.5 // its centre while in the middle
const SKULL_FINAL_CENTER = 0.264 // ...and after rising
const TITLE_START_TOP = 0.28 // the title starts tucked behind the skull...
const TITLE_FINAL_TOP = 0.4 // ...and slides down to here

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeOutCubic = (v: number) => 1 - Math.pow(1 - v, 3)
const easeInOut = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2)
/** Overshoots past 1 and settles back: a springy pop. */
const easeOutBack = (v: number) => 1 + 2.2 * Math.pow(v - 1, 3) + 1.2 * Math.pow(v - 1, 2)

const EliminatedSplash = (props: { detail: string; age: number }) => {
  const t = props.age / 1000
  const fadeOut = 1 - clamp01((t - 4.3) / 0.7)

  // Skull: expands in the middle (0 - 0.45 s), holds, then rises and shrinks a little (1.05 - 1.75 s)
  const pop = easeOutBack(clamp01(t / 0.45))
  const rise = easeInOut(clamp01((t - 1.05) / 0.7))
  const skullF = Math.max(0.001, lerp(SKULL_BIG_F, SKULL_FINAL_F, rise) * pop)
  const skullCenter = lerp(SKULL_MIDDLE, SKULL_FINAL_CENTER, rise)
  const skullAlpha = clamp01(t / 0.15) * fadeOut

  // Title: waits for the skull, then slides out from underneath it while fading in (from 1.2 s)
  const slide = easeOutCubic(clamp01((t - 1.2) / 0.55))
  const titleTop = lerp(TITLE_START_TOP, TITLE_FINAL_TOP, slide)
  const titleAlpha = clamp01((t - 1.2) / 0.3) * fadeOut

  const detailAlpha = clamp01((t - 2.0) / 0.4) * fadeOut
  const titleSq = square(TITLE_F)
  const skullSq = square(skullF)

  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: '100%', height: '100%' }}>
      {/* title first, so the skull is drawn over it while it is still tucked behind */}
      {t >= 1.2 && (
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { top: `${titleTop * 100}%`, left: 0 }, width: '100%', height: titleSq.height, justifyContent: 'center' }}
        >
          <UiEntity
            uiTransform={{ width: titleSq.width, height: '100%' }}
            uiBackground={{ texture: { src: TITLE_IMAGE }, textureMode: 'stretch', color: Color4.create(1, 1, 1, titleAlpha) }}
          />
        </UiEntity>
      )}

      <UiEntity
        uiTransform={{ positionType: 'absolute', position: { top: `${(skullCenter - skullF / 2) * 100}%`, left: 0 }, width: '100%', height: skullSq.height, justifyContent: 'center' }}
      >
        <UiEntity
          uiTransform={{ width: skullSq.width, height: '100%' }}
          uiBackground={{ texture: { src: SKULL_IMAGE }, textureMode: 'stretch', color: Color4.create(1, 1, 1, skullAlpha) }}
        />
      </UiEntity>

      {(() => {
        const font = S(26)
        const w = estW(props.detail, font) + S(64)
        const h = S(58)
        return (
          <UiEntity
            uiTransform={{
              positionType: 'absolute',
              position: { bottom: S(90), left: '50%' },
              margin: { left: -Math.round(w / 2) },
              width: w,
              height: h,
              justifyContent: 'center',
              alignItems: 'center',
              borderRadius: Math.round(h / 2),
              borderWidth: 3,
              borderColor: Color4.create(DANGER_EDGE.r, DANGER_EDGE.g, DANGER_EDGE.b, detailAlpha)
            }}
            uiBackground={{ color: Color4.create(0.2, 0.04, 0.08, 0.92 * detailAlpha) }}
          >
            <Label
              value={props.detail}
              fontSize={font}
              color={Color4.create(1, 1, 1, detailAlpha)}
              textAlign="middle-center"
              textWrap="nowrap"
              uiTransform={{ width: '100%', height: Math.round(font * 1.3) }}
            />
          </UiEntity>
        )
      })()}
    </UiEntity>
  )
}

const HEART_FULL = 'assets/images/HeartFull.png'
const HEART_EMPTY = 'assets/images/HeartEmpty.png'
let lastHp = -1

/** Hearts under the status banner. A heart that was just lost pops as it empties. */
const Hearts = (props: { hp?: number; top?: number }) => {
  const hp = props.hp ?? myHp()
  if (lastHp >= 0 && hp < lastHp) for (let i = hp; i < lastHp; i++) popPress(`heart-${i}`)
  lastHp = hp
  const size = HS(46)
  const gap = HS(6)
  const total = MAX_HP * size + (MAX_HP - 1) * gap
  const hearts = []
  for (let i = 0; i < MAX_HP; i++) {
    const k = 1 + 2.2 * (popFactor(`heart-${i}`) - 1) // heart pops harder than a button
    const d = Math.round(size * k)
    hearts.push(
      <UiEntity key={`heart-${i}`} uiTransform={{ width: size, height: size, margin: { left: i === 0 ? 0 : gap } }}>
        <UiEntity
          uiTransform={{ positionType: 'absolute', position: { left: Math.round((size - d) / 2), top: Math.round((size - d) / 2) }, width: d, height: d }}
          uiBackground={{ texture: { src: i < hp ? HEART_FULL : HEART_EMPTY }, textureMode: 'stretch' }}
        />
      </UiEntity>
    )
  }
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: props.top ?? HS(66), left: '50%' },
        margin: { left: -Math.round(total / 2) },
        width: total,
        height: size,
        flexDirection: 'row',
        pointerFilter: 'none'
      }}
    >
      {hearts}
    </UiEntity>
  )
}

// ---- "Waiting for more players": shown to a player who is alone on the pad (top of the screen, replaces the headline) ----

export const WAITING_IMAGE = 'assets/images/WAITINGMOREPLAYERS.png'
const WAITING_ASPECT = 1004 / 447 // image width / height
const WAITING_HEIGHT = { desktop: 0.13, mobile: 0.2 } // fraction of the screen height
const WAITING_TOP = { desktop: 0.012, mobile: 0.02 }
const WAITING_MAX_WIDTH = 90 // % of screen width, so it always fits (portrait phones)

/** Size of the waiting image as percent of the screen, from the screen's aspect ratio. */
function waitingSize() {
  const mobile = isMobile()
  let w = ((mobile ? WAITING_HEIGHT.mobile : WAITING_HEIGHT.desktop) * 100 * WAITING_ASPECT) / uiAspect()
  w = Math.min(WAITING_MAX_WIDTH, w)
  return { w, h: (w * uiAspect()) / WAITING_ASPECT, top: (mobile ? WAITING_TOP.mobile : WAITING_TOP.desktop) * 100 }
}

const WaitingForPlayers = (props: { size: ReturnType<typeof waitingSize> }) => (
  <UiEntity
    uiTransform={{
      positionType: 'absolute',
      position: { top: pct(props.size.top), left: pct((100 - props.size.w) / 2) },
      width: pct(props.size.w),
      height: pct(props.size.h)
    }}
    uiBackground={{ texture: { src: WAITING_IMAGE }, textureMode: 'stretch' }}
  />
)

// ---- Sound: one button top right that opens a centered modal (volume steps + mute), like the Marsh Colony jukebox.
// Fixed design sizes in virtual pixels through S(). Desktop has a button top right; on phones the sound action lives
// in the explorer's native "+" menu instead (see controls.ts), so no button here. ----

const VOLUME_STEPS = [20, 40, 60, 80, 100]
const SOUND_ORANGE = Color4.create(1, 0.6, 0.1, 1)
const MODAL_BG = Color4.create(0.13, 0.06, 0.22, 0.98)
const TILE = Color4.create(0.36, 0.2, 0.58, 1) // purple tiles
const CLOSE_BG = Color4.create(0.6, 0.15, 0.25, 1)
const MUTE_BG = Color4.create(0.5, 0.18, 0.62, 1)
const RED_BTN = Color4.create(0.8, 0.15, 0.2, 1)
const BTN_BG = Color4.create(0.2, 0.09, 0.32, 0.92)

/** Screen-height fraction the sound button takes up (the kill feed starts below it). */
const musicControlsBottom = () => (isMobile() ? 0 : (S(10) + S(46) + S(8)) / canvasHeight())

const SoundButton = () => {
  if (isMobile()) return null
  const muted = (music.muted() || music.volume() <= 0) && (sfxPrefs.muted() || sfxPrefs.volume() <= 0)
  return (
    <PopButton
      id="sound-open"
      width={S(46)}
      height={S(46)}
      radius={S(23)}
      texture={muted ? MUSIC_ICONS.off : MUSIC_ICONS.on}
      slot={{ positionType: 'absolute', position: { top: S(10), right: S(12) } }}
      onPress={soundPanel.toggle}
    />
  )
}

/** One labelled section of the panel: a title with its own mute button, then the five volume steps. */
const VolumeSection = (props: {
  id: string
  title: string
  width: number
  volume: number // 0-1
  muted: boolean
  onVolume: (v: number) => void
  onMute: () => void
  key?: string
}) => {
  const muted = props.muted || props.volume <= 0
  const volPct = props.volume * 100
  const active = VOLUME_STEPS.reduce((best, v) => (Math.abs(v - volPct) < Math.abs(best - volPct) ? v : best))
  const stepW = Math.round((props.width - 4 * S(8)) / VOLUME_STEPS.length)
  return (
    <UiEntity uiTransform={{ width: props.width, flexDirection: 'column', margin: { top: S(16) } }}>
      <UiEntity uiTransform={{ width: '100%', height: S(40), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Label value={props.title} fontSize={S(20)} color={WHITE} textAlign="middle-left" uiTransform={{ width: S(180), height: S(28) }} />
        <PopButton
          id={`${props.id}-mute`}
          width={S(130)}
          height={S(38)}
          radius={S(12)}
          bg={muted ? RED_BTN : MUTE_BG}
          borderColor={muted ? Color4.create(1, 0.6, 0.6, 1) : Color4.create(1, 0.6, 0.1, 0.8)}
          label={muted ? 'Unmute' : 'Mute'}
          font={S(17)}
          onPress={props.onMute}
        />
      </UiEntity>
      <UiEntity uiTransform={{ width: '100%', height: S(48), flexDirection: 'row', margin: { top: S(6) } }}>
        {VOLUME_STEPS.map((v, i) => (
          <PopButton
            key={`${props.id}-${v}`}
            id={`${props.id}-${v}`}
            width={stepW}
            height={S(46)}
            radius={S(10)}
            bg={!muted && v === active ? SOUND_ORANGE : TILE}
            label={`${v}%`}
            font={S(15)}
            labelColor={!muted && v === active ? Color4.Black() : WHITE}
            slot={{ margin: { left: i === 0 ? 0 : S(8) } }}
            onPress={() => props.onVolume(v / 100)}
          />
        ))}
      </UiEntity>
    </UiEntity>
  )
}

/** Centered modal: title and close, then separate Music and Effects sections (volume steps + mute each). */
const SoundPanel = () => {
  const w = S(500)
  const h = S(335) // fits a phone's 720 high virtual screen at the 1.6 phone scale
  const inner = w - S(48)
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '50%', left: '50%' },
        margin: { top: -Math.round(h / 2), left: -Math.round(w / 2) },
        width: w,
        height: h,
        flexDirection: 'column',
        alignItems: 'center',
        padding: S(24),
        borderRadius: S(20),
        borderWidth: 3,
        borderColor: SOUND_ORANGE,
        pointerFilter: 'block'
      }}
      uiBackground={{ color: MODAL_BG }}
    >
      <Label value="Sound" fontSize={S(28)} color={SOUND_ORANGE} textAlign="middle-left" uiTransform={{ width: '100%', height: S(40) }} />
      <PopButton
        id="sound-close"
        width={S(40)}
        height={S(40)}
        radius={S(10)}
        bg={CLOSE_BG}
        label="X"
        font={S(20)}
        slot={{ positionType: 'absolute', position: { top: S(10), right: S(10) } }}
        onPress={() => {
          soundPanel.open = false
        }}
      />

      <VolumeSection
        id="music"
        title="Music"
        width={inner}
        volume={music.volume()}
        muted={music.muted()}
        onVolume={music.setVolume}
        onMute={music.toggleMute}
      />
      <VolumeSection
        id="sfx"
        title="Effects"
        width={inner}
        volume={sfxPrefs.volume()}
        muted={sfxPrefs.muted()}
        onVolume={(v) => {
          sfxPrefs.setVolume(v)
          playSfx(SWING_SFX) // hear the new level (and whether effects play at all)
        }}
        onMute={() => {
          sfxPrefs.toggleMute()
          if (!sfxPrefs.muted()) playSfx(SWING_SFX)
        }}
      />
    </UiEntity>
  )
}

// ---- Prompt toast: a small pill under the explorer's avatar icon (top left) with what to do next. Short, and the "how to"
// ones fade away after a few seconds so they stop nagging. Desktop shows the key, phones show the bat button. ----

interface ToastMsg {
  key: string
  pre: string
  glyph?: boolean // the E key (desktop) or bat icon (mobile) goes between pre and post
  post?: string
  persistent: boolean
}

const TOAST_TOP = 96 // design px below the top edge, clear of the explorer's avatar icon
const TOAST_LEFT = { desktop: 78, mobile: 14 } // desktop sits further right, clear of the explorer's left-hand icons
const TOAST_SHOW_MS = 7000
const TOAST_ANIM_MS = 280
const TOAST_SWAP_MS = 4500

function toastFor(s: State, status: string): ToastMsg | undefined {
  const mobile = isMobile()
  const verb = mobile ? 'Tap' : 'Press'
  if (s.phase === Phase.Lobby || s.phase === Phase.Countdown) {
    if (status !== PlayerStatus.Queued) {
      // On desktop alternate with the swing tip so people learn they can swing (phones always see the bat button)
      if (!mobile && !hasSwung() && Math.floor(Date.now() / TOAST_SWAP_MS) % 2 === 1) return { key: 'swing-tip', pre: verb, glyph: true, post: 'to swing your bat', persistent: true }
      return { key: 'join', pre: 'Step on the pad to join', persistent: true }
    }
    return hasSwung() ? undefined : { key: 'swing', pre: verb, glyph: true, post: 'to swing', persistent: false }
  }
  if (s.phase === Phase.Starting || s.phase === Phase.Round) {
    if (status === PlayerStatus.Alive) return hasSwung() ? undefined : { key: 'parry', pre: verb, glyph: true, post: 'to parry', persistent: false }
    if (status === PlayerStatus.Out) return { key: 'out', pre: "You're out - spectating", persistent: true }
    return { key: 'busy', pre: 'Round in progress', persistent: true }
  }
  return undefined
}

let toastKey = ''
let toastAt = 0

const PromptToast = (props: { msg: ToastMsg | undefined }) => {
  const msg = props.msg
  if (!msg) {
    toastKey = ''
    return null
  }
  const now = Date.now()
  if (msg.key !== toastKey) {
    toastKey = msg.key
    toastAt = now
  }
  const age = now - toastAt
  if (!msg.persistent && age > TOAST_SHOW_MS + TOAST_ANIM_MS) return null

  const font = S(18)
  const charW = font * 0.56
  const glyphW = S(34)
  const gap = S(10)
  const padX = S(16)
  const textW = (t: string) => Math.ceil(t.length * charW)
  const preW = textW(msg.pre)
  const postW = msg.post ? textW(msg.post) : 0
  const w = padX * 2 + preW + (msg.glyph ? gap + glyphW : 0) + (msg.post ? gap + postW : 0)
  const h = S(46)

  // slide in from the left, and (for timed ones) back out at the end
  const inT = Math.min(1, age / TOAST_ANIM_MS)
  const outT = msg.persistent ? 0 : Math.min(1, Math.max(0, (age - TOAST_SHOW_MS) / TOAST_ANIM_MS))
  const shown = (1 - Math.pow(1 - inT, 3)) * (1 - outT)
  const left = -w + ((isMobile() ? TOAST_LEFT.mobile : S(TOAST_LEFT.desktop)) + w) * shown

  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: S(TOAST_TOP), left },
        width: w,
        height: h,
        flexDirection: 'row',
        alignItems: 'center',
        padding: { left: padX, right: padX },
        borderRadius: Math.round(h / 2),
        borderWidth: 2,
        borderColor: ORANGE
      }}
      uiBackground={{ color: Color4.create(0.08, 0.05, 0.12, 0.88) }}
    >
      <Label value={msg.pre} fontSize={font} color={WHITE} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: preW, height: S(26) }} />
      {msg.glyph && (
        <UiEntity
          uiTransform={{
            width: glyphW,
            height: glyphW,
            margin: { left: gap },
            justifyContent: 'center',
            alignItems: 'center',
            borderRadius: isMobile() ? Math.round(glyphW / 2) : S(8)
          }}
          uiBackground={isMobile() ? { texture: { src: BAT_ICON }, textureMode: 'stretch' } : { color: ORANGE }}
        >
          {!isMobile() && <Label value="E" fontSize={S(20)} color={Color4.Black()} textAlign="middle-center" uiTransform={{ width: '100%', height: S(26) }} />}
        </UiEntity>
      )}
      {msg.post && (
        <Label value={msg.post} fontSize={font} color={WHITE} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: postW, height: S(26), margin: { left: gap } }} />
      )}
    </UiEntity>
  )
}


// ---- Solo run (the Vampire): boss bar, hearts, parry button, and the end card ----

/** One health bar per boss (names above), up to three to a row so a six-boss level still fits. */
const BOSS_BARS_TOP = () => HS(64)
const BOSS_ROW_H = () => HS(34)
const bossRows = () => Math.max(1, Math.ceil(solo.bosses.length / 3))
const bossBarsBottom = () => BOSS_BARS_TOP() + bossRows() * BOSS_ROW_H()

const BossBars = () => {
  const n = solo.bosses.length
  const perRow = Math.min(3, Math.max(1, n))
  const w = perRow === 1 ? HS(300) : perRow === 2 ? HS(210) : HS(170)
  const h = HS(14)
  const gap = HS(8)
  const rowW = perRow * w + (perRow - 1) * gap
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: BOSS_BARS_TOP(), left: '50%' },
        margin: { left: -Math.round(rowW / 2) },
        width: rowW,
        height: bossRows() * BOSS_ROW_H(),
        flexDirection: 'row',
        flexWrap: 'wrap',
        pointerFilter: 'none'
      }}
    >
      {solo.bosses.map((boss, i) => {
        const frac = Math.max(0, boss.hp / boss.maxHp)
        return (
          <UiEntity
            key={`bossbar-${i}`}
            uiTransform={{ width: w, height: BOSS_ROW_H(), margin: { right: i % 3 === perRow - 1 ? 0 : gap }, flexDirection: 'column', pointerFilter: 'none' }}
          >
            <Label
              value={boss.name.toUpperCase()}
              fontSize={HS(13)}
              color={boss.hp > 0 ? WHITE : Color4.create(0.6, 0.6, 0.65, 1)}
              textAlign="middle-left"
              textWrap="nowrap"
              uiTransform={{ width: '100%', height: HS(18) }}
            />
            <UiEntity
              uiTransform={{ width: w, height: h, borderRadius: Math.round(h / 2), borderWidth: 2, borderColor: DANGER_EDGE, pointerFilter: 'none' }}
              uiBackground={{ color: Color4.create(0.08, 0.02, 0.1, 0.9) }}
            >
              <UiEntity
                uiTransform={{ width: Math.max(0, Math.round((w - 4) * frac)), height: h - 4, borderRadius: Math.round((h - 4) / 2), pointerFilter: 'none' }}
                uiBackground={{ color: Color4.create(0.75, 0.1, 0.25, 1) }}
              />
            </UiEntity>
          </UiEntity>
        )
      })}
    </UiEntity>
  )
}

const EndButton = (props: { id: string; label: string; onPress: () => void; primary?: boolean }) => (
  <PopButton
    id={props.id}
    width={S(210)}
    height={S(50)}
    radius={S(25)}
    label={props.label}
    font={S(20)}
    bg={props.primary ? ORANGE : PANEL_BG}
    labelColor={props.primary ? Color4.Black() : WHITE}
    borderColor={EDGE}
    onPress={props.onPress}
    slot={{ margin: { left: S(8), right: S(8) } }}
  />
)

const SoloEndCard = () => {
  if (solo.phase === 'fight' || solo.victory || parryFeedback.eliminatedNotice()) return null // the "you died" and victory shots play first
  const won = solo.phase === 'won'
  const finalWin = won && solo.level >= solo.levelCount
  const w = S(560)
  const h = S(230)
  const title = finalWin ? 'ALL FIVE LEVELS CLEARED' : won ? `LEVEL ${solo.level} CLEARED` : solo.bosses.length > 1 ? 'THEY WIN' : 'YOU WERE DEFEATED'
  const subtitle = finalWin ? 'The Vampire Master kneels' : won ? 'Next up: get ready' : 'Three hearts is all you get'
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { top: '28%', left: '50%' },
        margin: { left: -Math.round(w / 2) },
        width: w,
        height: h,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: S(18),
        borderWidth: 3,
        borderColor: won ? GOLD : DANGER_EDGE,
        pointerFilter: 'block'
      }}
      uiBackground={{ color: PANEL_BG }}
    >
      <Label value={title} fontSize={S(30)} color={won ? GOLD : RED} textAlign="middle-center" uiTransform={{ width: '100%', height: S(44) }} />
      <Label value={subtitle} fontSize={S(18)} color={WHITE} textAlign="middle-center" uiTransform={{ width: '100%', height: S(30), margin: { bottom: S(18) } }} />
      <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'center', width: '100%', height: S(50) }}>
        {won ? (
          <EndButton id="solo-next" label={finalWin ? 'Play again' : 'Next level'} primary onPress={nextSoloLevel} />
        ) : (
          <EndButton id="solo-retry" label="Try again" primary onPress={retrySolo} />
        )}
        <EndButton id="solo-leave" label="Leave the ring" onPress={leaveSolo} />
      </UiEntity>
    </UiEntity>
  )
}

/** Testing only (SOLO_LEVEL_SELECT in config.ts): buttons to jump straight to a level. */
const LevelSelect = () => {
  if (!SOLO_LEVEL_SELECT) return null
  const w = S(46)
  const gap = S(6)
  const levels = []
  for (let i = 1; i <= solo.levelCount; i++) {
    levels.push(
      <PopButton
        key={`lvl-${i}`}
        id={`lvl-${i}`}
        width={w}
        height={w}
        radius={Math.round(w / 2)}
        label={`${i}`}
        font={S(20)}
        bg={solo.level === i ? ORANGE : PANEL_BG}
        labelColor={solo.level === i ? Color4.Black() : WHITE}
        borderColor={EDGE}
        onPress={() => jumpToLevel(i)}
        slot={{ margin: { left: gap } }}
      />
    )
  }
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: S(24), left: S(24) },
        flexDirection: 'row',
        alignItems: 'center',
        height: w
      }}
    >
      <PopButton
        id="solo-kill"
        width={S(70)}
        height={S(46)}
        radius={S(23)}
        label="KILL 1"
        font={S(16)}
        bg={Color4.create(0.5, 0.05, 0.1, 0.95)}
        labelColor={WHITE}
        borderColor={DANGER_EDGE}
        onPress={killOneBoss}
        slot={{ margin: { right: S(14) } }}
      />
      <Label value="TEST LEVEL" fontSize={S(14)} color={Color4.create(1, 1, 1, 0.6)} textAlign="middle-left" textWrap="nowrap" uiTransform={{ width: S(96), height: S(20) }} />
      {levels}
    </UiEntity>
  )
}

/** The title that fades in over the level intro camera. */
const IntroTitle = () => {
  if (!solo.intro) return null
  const fadeIn = clamp01(solo.introAge / 0.6)
  const fadeOut = 1 - clamp01((solo.introAge - (solo.introDur - 0.7)) / 0.7)
  const a = fadeIn * fadeOut
  return (
    <UiEntity
      uiTransform={{ positionType: 'absolute', position: { top: '12%', left: 0 }, width: '100%', height: S(120), flexDirection: 'column', alignItems: 'center', pointerFilter: 'none' }}
    >
      <Label value={`LEVEL ${solo.level}`} fontSize={S(58)} color={Color4.create(GOLD.r, GOLD.g, GOLD.b, a)} textAlign="middle-center" uiTransform={{ width: '100%', height: S(70) }} />
      <Label value={solo.levelName.toUpperCase()} fontSize={S(28)} color={Color4.create(1, 1, 1, a)} textAlign="middle-center" uiTransform={{ width: '100%', height: S(40) }} />
    </UiEntity>
  )
}

const SoloHud = () => {
  const fb = parryFeedback.current()
  const elim = parryFeedback.eliminatedNotice()
  soundButtonShown = false
  soundPanel.open = false
  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      <StatusBanner text={`LEVEL ${solo.level}  -  ${solo.levelName.toUpperCase()}`} tone="normal" />
      <BossBars />
      <Hearts hp={solo.hp} top={bossBarsBottom() + HS(6)} />
      {fb && <FeedbackPop text={fb} age={parryFeedback.age()} top={bossBarsBottom() + HS(6) + HS(46) + HS(8)} />}
      {elim && <EliminatedSplash detail={elim.detail} age={elim.age} />}
      {solo.phase === 'fight' && !solo.intro && !isMobile() && <ParryButton />}
      <SoloEndCard />
      {solo.victory && <WinnerImage round={solo.victoryId} />}
      <IntroTitle />
      <LevelSelect />
      {!isServerAlive() && (
        <Label
          value="Server connection lost - your run continues"
          fontSize={S(15)}
          color={Color4.create(1, 0.8, 0.3, 1)}
          textAlign="middle-center"
          uiTransform={{ positionType: 'absolute', position: { bottom: S(8), left: 0 }, width: '100%', height: S(22) }}
        />
      )}
    </UiEntity>
  )
}

// ---- The lobby Vampire's conversation ----

const VampireDialog = () => {
  if (!vampireDialog.open) return null
  const lines = vampireLines()
  const line = lines[Math.min(vampireDialog.line, lines.length - 1)]
  const last = vampireDialog.line >= lines.length - 1
  const unlocked = Math.min(LEVELS.length, solo.cleared + 1)
  const picker = last && vampireDialog.mode !== 'intro' // returning players choose a level
  const w = Math.min(S(760), Math.round(virtualCanvas().w * 0.9))
  const font = S(19)
  const textW = w - S(48)
  const textLines = Math.max(1, Math.ceil(estW(line, font) / textW))
  const textH = Math.round(textLines * font * 1.35)
  const pickerH = picker ? S(30) + S(56) : 0
  const h = S(40) + textH + S(24) + S(50) + S(20) + pickerH
  const levelButtons = []
  if (picker) {
    for (let i = 1; i <= unlocked; i++) {
      levelButtons.push(
        <PopButton
          key={`vlvl-${i}`}
          id={`vlvl-${i}`}
          width={S(50)}
          height={S(50)}
          radius={S(25)}
          label={`${i}`}
          font={S(22)}
          bg={i === unlocked && solo.cleared < LEVELS.length ? ORANGE : PANEL_BG}
          labelColor={i === unlocked && solo.cleared < LEVELS.length ? Color4.Black() : WHITE}
          borderColor={EDGE}
          onPress={() => acceptVampireFight(i)}
          slot={{ margin: { left: S(6), right: S(6) } }}
        />
      )
    }
  }
  return (
    <UiEntity
      uiTransform={{
        positionType: 'absolute',
        position: { bottom: S(50), left: '50%' },
        margin: { left: -Math.round(w / 2) },
        width: w,
        height: h,
        flexDirection: 'column',
        alignItems: 'center',
        padding: { top: S(14), left: S(24), right: S(24) },
        borderRadius: S(18),
        borderWidth: 3,
        borderColor: EDGE,
        pointerFilter: 'block'
      }}
      uiBackground={{ color: PANEL_BG }}
    >
      <Label value="THE VAMPIRE" fontSize={S(20)} color={GOLD} textAlign="middle-left" uiTransform={{ width: '100%', height: S(30) }} />
      <Label value={line} fontSize={font} color={WHITE} textAlign="top-left" textWrap="wrap" uiTransform={{ width: textW, height: textH + S(10) }} />
      {picker && (
        <UiEntity uiTransform={{ flexDirection: 'column', alignItems: 'center', width: '100%', height: pickerH }}>
          <Label value="CHOOSE YOUR FIGHT" fontSize={S(14)} color={Color4.create(1, 1, 1, 0.65)} textAlign="middle-center" uiTransform={{ width: '100%', height: S(26) }} />
          <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'center', width: '100%', height: S(52) }}>{levelButtons}</UiEntity>
        </UiEntity>
      )}
      <UiEntity uiTransform={{ flexDirection: 'row', justifyContent: 'flex-end', width: '100%', height: S(50), margin: { top: S(12) } }}>
        {last ? (
          <UiEntity uiTransform={{ flexDirection: 'row' }}>
            <EndButton id="vamp-no" label="Not now" onPress={closeVampireDialog} />
            {!picker && <EndButton id="vamp-yes" label="Fight!" primary onPress={() => acceptVampireFight(1)} />}
          </UiEntity>
        ) : (
          <UiEntity uiTransform={{ flexDirection: 'row' }}>
            <EndButton id="vamp-leave" label="Leave" onPress={closeVampireDialog} />
            <EndButton id="vamp-next" label="Next" primary onPress={() => {
                vampireDialog.line += 1
                playSfx(VAMPIRE_VOICE_SFX, 0.9)
              }} />
          </UiEntity>
        )}
      </UiEntity>
    </UiEntity>
  )
}

const Hud = () => {
  const L = layout()
  // A solo run is local: if the server's heartbeat drops, the fight carries on and keeps its HUD (with a small notice)
  if (solo.active) return <SoloHud />
  if (!isServerAlive()) {
    return (
      <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
        <StatusBanner text="Waking up the pumpkin patch..." tone="normal" />
        <SoundButton />
        {soundPanel.open && <SoundPanel />}
      </UiEntity>
    )
  }

  const s = readState()
  if (!s) return <StatusBanner text="Connecting to server..." tone="normal" />

  const status = myStatus()
  const fb = parryFeedback.current()
  const elim = parryFeedback.eliminatedNotice()
  const hunted = pumpkinTargetsMe()
  const top = hunted ? 'THE PUMPKIN IS COMING FOR YOU!' : headline(s, status)
  // Alone on the pad, waiting for a second player: the image takes the place of the headline banner
  const alone = s.phase === Phase.Lobby && status === PlayerStatus.Queued && s.queued === 1 && !hunted
  const waiting = waitingSize()
  // The pad prompts live in the toast; in the lobby the top banner only carries urgent things (parry feedback, being hunted)
  // Alive in a running round: no sound button or panel (more room for the recap messages)
  const playing = (s.phase === Phase.Round || s.phase === Phase.Starting) && status === PlayerStatus.Alive
  if (playing) soundPanel.open = false
  soundButtonShown = !isMobile() && !playing
  const winnerShown = s.phase === Phase.Winner && s.winnerId !== ''
  const showBanner = !((s.phase === Phase.Lobby || s.phase === Phase.Countdown) && !hunted)

  return (
    <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
      {alone ? (
        <WaitingForPlayers size={waiting} />
      ) : (
        showBanner && !winnerShown && <StatusBanner text={top} tone={hunted ? 'danger' : s.phase === Phase.Winner ? 'gold' : 'normal'} />
      )}
      {DEBUG_HUD && <DebugLine text={debug.press || 'press: -'} index={0} />}
      {DEBUG_HUD && <DebugLine text={debug.resolve || 'resolve: -'} index={1} />}
      {DEBUG_HUD && <DebugLine text={debug.server || 'server: -'} index={2} />}
      {s.phase === Phase.Countdown && s.secondsLeft >= 1 && <GameStartsIn />}
      {s.phase === Phase.Countdown && s.secondsLeft >= 1 && <Digits text={`${s.secondsLeft}`} f={L.digitsF} topFraction={countdownDigitsTop()} />}
      {/* the big 3-2-1 plays on the arena, after the teleport, before the pumpkin is released */}
      {s.phase === Phase.Starting && s.secondsLeft >= 1 && s.secondsLeft <= 3 && <BigCountdown seconds={s.secondsLeft} />}
      <KillFeed />
      <StartBanner />
      {winnerShown && s.winnerId === myId() && <WinnerImage round={s.round} />}
      {winnerShown && <WinnerCard winnerId={s.winnerId} round={s.round} />}
      {fb && <FeedbackPop text={fb} age={parryFeedback.age()} />}
      <PromptToast msg={toastFor(s, status)} />
      {!playing && <SoundButton />}
      {!playing && soundPanel.open && <SoundPanel />}
      {elim && <EliminatedSplash detail={elim.detail} age={elim.age} />}
      {(s.phase === Phase.Round || s.phase === Phase.Starting) && status === PlayerStatus.Alive && <Hearts />}
      {(s.phase === Phase.Round || s.phase === Phase.Starting) && status === PlayerStatus.Alive && !isMobile() && <ParryButton />}
    </UiEntity>
  )
}

// ---- Preload: every UI image is kept on screen from the start, 1 px and almost transparent, so the renderer
// downloads and decodes them at scene load. When the countdown, skull or bat icon is first shown, it is already ready. ----

const PRELOAD_IMAGES = [
  ...'0123456789'.split('').map(digitImage),
  TITLE_IMAGE,
  SKULL_IMAGE,
  BAT_ICON,
  JOIN_SIGN_IMAGE,
  IN_PROGRESS_SIGN_IMAGE,
  WAITING_IMAGE,
  START_IMAGE,
  GAME_STARTS_IN_IMAGE,
  WINNER_IMAGE,
  HEART_FULL,
  HEART_EMPTY,
  MUSIC_ICONS.on,
  MUSIC_ICONS.off
]

const Preload = () => (
  <UiEntity uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: 1, height: 1 }}>
    {PRELOAD_IMAGES.map((src) => (
      <UiEntity
        key={`preload-${src}`}
        uiTransform={{ positionType: 'absolute', position: { top: 0, left: 0 }, width: 1, height: 1 }}
        uiBackground={{ texture: { src }, textureMode: 'stretch', color: Color4.create(1, 1, 1, 0.01) }}
      />
    ))}
  </UiEntity>
)

const Root = () => (
  <UiEntity uiTransform={{ width: '100%', height: '100%' }}>
    <Preload />
    <Hud />
    <VampireDialog />
  </UiEntity>
)

export function setupUi() {
  ReactEcsRenderer.setUiRenderer(Root)
}
