import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentNodeRow, ClaimRow, KubeNode, Snapshot, Usage } from '../types'

const PANE = 'k8ai-nodes'
// Always this context: never whatever kubectl's current one is.
const CONTEXT = 'kind-k8ai'
const POLL_MS = 10_000
// Yellow from WARN, red and an alert from ALERT; the alert clears below CLEAR.
const WARN = 80
const ALERT = 90
const CLEAR = 85
// A daemon that stopped cannot clear its own sample.
const RESOURCES_MAX_AGE_MS = 2 * 60_000

const snapshot = atom({ plugin: 'k8ai-nodes', key: 'snapshot' } as const, null, {
  shape: 'snapshot-4',
})
// Ticks every second so ages are counted while drawing, not frozen at the
// poll (the daemon beats every 10s, as often as the poll, so an age taken
// at poll time is the same number every time).
const now = atom({ plugin: 'k8ai-nodes', key: 'now' } as const, 0)
// Bumped each tick so the spinner redraws the animation.
const frame = atom({ plugin: 'k8ai-nodes', key: 'frame' } as const, 0)

// "<node> <metric>" entries over ALERT, so each crossing toasts once.
const alerting = new Set<string>()

type Item = {
  metadata: { name: string; labels?: Record<string, string> }
  spec?: Record<string, unknown> & { providerID?: string; provider?: string; nodePool?: string }
  status?: {
    conditions?: { type: string; status: string }[]
    allocatedSessions?: number
    lastHeartbeatTime?: string
    phase?: string
    nodeInfo?: { kubeletVersion?: string }
    capacity?: { cpu?: string; memory?: string }
    resources?: {
      cpuPercent: number
      memoryUsedBytes: number
      memoryTotalBytes: number
      diskUsedBytes: number
      diskTotalBytes: number
      observedTime: string
    }
  }
}

type Summary = {
  node: {
    cpu?: { usageNanoCores?: number }
    memory?: { workingSetBytes?: number }
    fs?: { usedBytes?: number; capacityBytes?: number }
  }
}

// Kubernetes quantities as used for node capacity: plain, m, Ki, Mi, Gi, Ti.
function quantity(q: string | undefined): number | null {
  if (!q) return null
  const m = /^([0-9.]+)(m|Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(q)
  if (!m) return null
  const unit: Record<string, number> = {
    m: 1e-3, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  }
  return Number(m[1]) * (m[2] ? (unit[m[2]] ?? 1) : 1)
}

function condition(item: Item, type: string): string {
  const c = item.status?.conditions?.find(one => one.type === type)
  return c ? (c.status === 'True' ? 'Ready' : 'NotReady') : 'Unknown'
}

// Where a machine runs: the scheme of a Kubernetes node's providerID
// (kind://, azure://), or the provider of the NodePool that launched an
// AgentNode. kind and nodes without one run here: local.
const LOCAL = 'local'
function schemeProvider(providerID: string | undefined): string {
  const scheme = /^([a-z0-9-]+):\/\//.exec(providerID ?? '')?.[1]
  return !scheme || scheme === 'kind' ? LOCAL : scheme
}

function kubeNode(item: Item, summary: Summary | null): KubeNode {
  const roles = Object.keys(item.metadata.labels ?? {})
    .filter(k => k.startsWith('node-role.kubernetes.io/'))
    .map(k => k.slice('node-role.kubernetes.io/'.length))
  let usage: Usage | null = null
  if (summary) {
    const cores = quantity(item.status?.capacity?.cpu)
    const nano = summary.node.cpu?.usageNanoCores
    usage = {
      cpuPercent: cores && nano !== undefined ? Math.min(100, Math.round((nano / (cores * 1e9)) * 100)) : null,
      memUsed: summary.node.memory?.workingSetBytes ?? null,
      memTotal: quantity(item.status?.capacity?.memory),
      diskUsed: summary.node.fs?.usedBytes ?? null,
      diskTotal: summary.node.fs?.capacityBytes ?? null,
    }
  }
  return {
    name: item.metadata.name,
    ready: condition(item, 'Ready'),
    roles: roles.length > 0 ? roles.join(',') : 'worker',
    version: item.status?.nodeInfo?.kubeletVersion ?? '',
    provider: schemeProvider(item.spec?.providerID),
    usage,
  }
}

function agentNode(item: Item, polledAt: number, pools: Map<string, string>): AgentNodeRow {
  const spec = item.spec ?? {}
  const capacity = (spec.capacity as { sessions?: number } | undefined)?.sessions
  const labels = item.metadata.labels ?? {}
  const beat = item.status?.lastHeartbeatTime
  const r = item.status?.resources
  const fresh = r && polledAt - Date.parse(r.observedTime) <= RESOURCES_MAX_AGE_MS
  return {
    name: item.metadata.name,
    ready: (spec.unschedulable as boolean | undefined) ? 'Cordoned' : condition(item, 'Ready'),
    sessions: `${item.status?.allocatedSessions ?? 0}/${capacity ?? '?'}`,
    terminal: (spec.terminal as string | undefined) ?? '',
    pool: labels['restricted.k8ai.dev/pool'] ?? labels['k8ai.dev/pool'] ?? '',
    // The provisioner labels the AgentNodes it launches with their NodePool.
    provider: pools.get(labels['restricted.k8ai.dev/nodepool'] ?? '') ?? LOCAL,
    heartbeatAt: beat ? Date.parse(beat) : null,
    usage:
      r && fresh
        ? {
            cpuPercent: r.cpuPercent,
            memUsed: r.memoryUsedBytes,
            memTotal: r.memoryTotalBytes,
            diskUsed: r.diskUsedBytes,
            diskTotal: r.diskTotalBytes,
          }
        : null,
  }
}

function claim(item: Item, pools: Map<string, string>): ClaimRow {
  const pool = item.spec?.nodePool ?? ''
  return {
    name: item.metadata.name,
    pool,
    provider: pools.get(pool) ?? '?',
    phase: item.status?.phase ?? '',
  }
}

function pct(used: number | null, total: number | null): number | null {
  return used !== null && total ? Math.round((used / total) * 100) : null
}

// The three percentages of a usage, by metric name.
function percents(u: Usage | null): [string, number | null][] {
  return [
    ['CPU', u?.cpuPercent ?? null],
    ['MEM', u ? pct(u.memUsed, u.memTotal) : null],
    ['DISK', u ? pct(u.diskUsed, u.diskTotal) : null],
  ]
}

async function kubectl($: EngineInterface, args: string[]): Promise<string> {
  const r = await $.process.run(['kubectl', '--context', CONTEXT, ...args], { timeoutMs: 15_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n').pop() || `kubectl ${args.join(' ')} failed`)
  return r.stdout
}

// Toasts each metric that crossed ALERT and keeps the status line on the
// ones still above CLEAR.
async function alert($: EngineInterface, snap: Snapshot): Promise<void> {
  const rows: [string, Usage | null][] = [
    ...snap.kube.map(n => [n.name, n.usage] as [string, Usage | null]),
    ...snap.agents.map(n => [n.name, n.usage] as [string, Usage | null]),
  ]
  const over: string[] = []
  for (const [name, usage] of rows) {
    for (const [metric, value] of percents(usage)) {
      const key = `${name} ${metric}`
      if (value === null) continue
      if (value >= ALERT && !alerting.has(key)) {
        alerting.add(key)
        void $.ui.toast(`k8ai: ${name} ${metric} at ${value}%`)
      } else if (value < CLEAR) {
        alerting.delete(key)
      }
      if (alerting.has(key)) over.push(`${name} ${metric} ${value}%`)
    }
  }
  void $.ui.status(over.length > 0 ? `k8ai near limit: ${over.join(', ')}` : undefined)
}

async function poll($: EngineInterface): Promise<void> {
  const polledAt = Date.now()
  const get = async (resource: string): Promise<Item[]> =>
    (JSON.parse(await kubectl($, ['get', resource, '-o', 'json'])) as { items: Item[] }).items
  const summary = async (node: string): Promise<Summary | null> => {
    try {
      return JSON.parse(await kubectl($, ['get', '--raw', `/api/v1/nodes/${node}/proxy/stats/summary`])) as Summary
    } catch {
      return null
    }
  }
  let next: Snapshot
  try {
    const [kube, agents, claims, nodePools] = await Promise.all([
      get('nodes'),
      get('agentnodes.k8ai.dev'),
      get('nodeclaims.k8ai.dev').catch(() => [] as Item[]),
      get('nodepools.k8ai.dev').catch(() => [] as Item[]),
    ])
    const pools = new Map(nodePools.map(p => [p.metadata.name, p.spec?.provider ?? '?']))
    const summaries = await Promise.all(kube.map(n => summary(n.metadata.name)))
    next = {
      at: polledAt,
      error: null,
      kube: kube.map((n, i) => kubeNode(n, summaries[i] ?? null)),
      agents: agents.map(n => agentNode(n, polledAt, pools)),
      claims: claims.map(c => claim(c, pools)),
    }
    await alert($, next)
  } catch (err) {
    const prev = await read($, snapshot)
    next = {
      at: polledAt,
      error: err instanceof Error ? err.message : String(err),
      kube: prev?.kube ?? [],
      agents: prev?.agents ?? [],
      claims: prev?.claims ?? [],
    }
  }
  await update($, snapshot, () => next)
}

function age(at: number | null, nowMs: number): string {
  if (at === null) return '-'
  const s = Math.max(0, Math.round((nowMs - at) / 1000))
  if (s < 90) return `${s}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${Math.round(s / 3600)}h`
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

// A 7x7 screen left of the spinner's node table that cycles through short
// animations: Game of Life, "k8ai" scrolling past, and two effects after the
// terminal screensavers of Omarchy (rain, ripples), and pods scheduled onto
// nodes. One clock tick per TICK_MS; each animation runs for its own number of ticks, then the next.
// Drawn with half blocks: each terminal row is two pixel rows, the top in the
// foreground and the bottom in the background.
const SCREEN = 7
const TICK_MS = 100

type Animation = {
  name: string
  ticks: number // how long it runs
  start: () => void
  tick: (t: number) => void // t counts from 0 since start
  pixel: (x: number, y: number) => string | undefined // a colour, or nothing
}

function hsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

// Game of Life on a torus. Reseeds when it dies out or repeats a recent
// generation. Green the generation a cell is born, then white.
const lifeAnimation = (() => {
  type Life = number[][] // each cell's age in generations; 0 is dead
  const seed = (): Life =>
    Array.from({ length: SCREEN }, () => Array.from({ length: SCREEN }, () => (Math.random() < 0.35 ? 1 : 0)))
  const key = (g: Life) => g.map(row => row.map(age => (age > 0 ? 1 : 0)).join('')).join('/')
  let life: Life = seed()
  let seen: string[] = []
  const step = () => {
    const next = life.map((row, y) =>
      row.map((age, x) => {
        let n = 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            if ((dx || dy) && life[(y + dy + SCREEN) % SCREEN]![(x + dx + SCREEN) % SCREEN]! > 0) n++
        return age > 0 ? (n === 2 || n === 3 ? age + 1 : 0) : n === 3 ? 1 : 0
      }),
    )
    const k = key(next)
    if (!k.includes('1') || seen.includes(k)) {
      life = seed()
      seen = [key(life)]
    } else {
      life = next
      seen = [...seen, k].slice(-12)
    }
  }
  return {
    name: 'life',
    ticks: 80,
    start: () => {
      life = seed()
      seen = [key(life)]
    },
    tick: t => {
      if (t % 3 === 2) step() // a generation every 300ms
    },
    pixel: (x, y) => {
      const age = life[y]?.[x] ?? 0
      return age === 0 ? undefined : age === 1 ? '#4ade80' : '#ffffff'
    },
  } satisfies Animation
})()

// "k8ai" in a 3x5 font, scrolling right to left, in a moving rainbow.
const textAnimation = (() => {
  const GLYPHS: Record<string, string[]> = {
    k: ['#..', '#.#', '##.', '#.#', '#.#'],
    '8': ['###', '#.#', '###', '#.#', '###'],
    a: ['...', '.##', '#.#', '#.#', '.##'],
    i: ['#', '.', '#', '#', '#'],
  }
  const rows = Array.from({ length: 5 }, (_, r) => [...'k8ai'].map(c => GLYPHS[c]![r]).join('.'))
  const width = rows[0]!.length
  const lead = SCREEN // starts off the right edge and leaves off the left
  let offset = 0
  return {
    name: 'k8ai',
    ticks: 2 * (width + lead),
    start: () => {
      offset = 0
    },
    tick: t => {
      offset = t % (width + lead)
    },
    pixel: (x, y) => {
      const col = x + offset - lead
      if (y < 1 || y > 5 || col < 0 || col >= width || rows[y - 1]![col] !== '#') return undefined
      return hsl((col * 25 + offset * 12) % 360, 0.85, 0.62)
    },
  } satisfies Animation
})()

// Rain: drops fall down each column at their own speed with a fading trail.
const rainAnimation = (() => {
  const TRAIL = ['#d9f99d', '#4ade80', '#16a34a', '#14532d']
  type Drop = { y: number; speed: number }
  let drops: Drop[] = []
  const fresh = (): Drop => ({ y: -Math.floor(Math.random() * 8), speed: 1 + Math.floor(Math.random() * 3) })
  return {
    name: 'rain',
    ticks: 60,
    start: () => {
      drops = Array.from({ length: SCREEN }, fresh)
    },
    tick: t => {
      drops = drops.map(d => (t % d.speed !== 0 ? d : d.y - TRAIL.length > SCREEN ? fresh() : { ...d, y: d.y + 1 }))
    },
    pixel: (x, y) => {
      const back = (drops[x]?.y ?? -99) - y
      return back >= 0 && back < TRAIL.length ? TRAIL[back] : undefined
    },
  } satisfies Animation
})()

// Ripples: rings run out from the centre, each a step further round the colour wheel.
const rippleAnimation = (() => {
  let phase = 0
  return {
    name: 'ripple',
    ticks: 60,
    start: () => {
      phase = 0
    },
    tick: t => {
      phase = t
    },
    pixel: (x, y) => {
      const d = Math.hypot(x - 3, y - 3) - phase * 0.35
      const ring = ((d % 2.5) + 2.5) % 2.5
      return ring < 1 ? hsl((((Math.floor(d / 2.5) * 50) % 360) + 360) % 360, 0.8, 0.6) : undefined
    },
  } satisfies Animation
})()

// Written by Claude Code in a k8ai session on the AKS pod node aks-oodegard.
// Scheduling: pods drop from the top and the scheduler spreads them over three
// node racks (columns of 4 slots) until the cluster is full; then pods flash
// red and are evicted one by one until it has drained, and it starts over.
const scheduleAnimation = (() => {
  const COLS = [1, 3, 5] // x of each node
  const SLOTS = 4 // pods per node; slots fill from the bottom row up
  const FILLED = 50 // tick the eviction starts
  const RED = -1 // a pod being evicted
  type Pod = { node: number; y: number; hue: number }
  let nodes: number[][] = [[], [], []] // each pod's hue, bottom first
  let falling: Pod[] = []
  let reserved = [0, 0, 0] // pods placed or on their way, per node
  let made = 0
  return {
    name: 'schedule',
    ticks: 80,
    start: () => {
      nodes = [[], [], []]
      falling = []
      reserved = [0, 0, 0]
      made = 0
    },
    tick: t => {
      const landed: Pod[] = []
      falling = falling.filter(p => {
        p.y++
        if (p.y < 6 - (nodes[p.node]!.length)) return true
        landed.push(p)
        return false
      })
      for (const p of landed) nodes[p.node]!.push(p.hue)
      if (t < FILLED - 8 && t % 3 === 0) {
        // The emptiest node wins; ties go to a random one.
        const open = reserved.map((n, i) => [n, i, Math.random()] as const).filter(([n]) => n < SLOTS)
        const best = open.sort((a, b) => a[0] - b[0] || a[2] - b[2])[0]
        if (best) {
          reserved[best[1]]!++
          falling.push({ node: best[1], y: -1, hue: (made++ * 53 + 20) % 360 })
        }
      } else if (t >= FILLED) {
        for (const n of nodes) if (n[n.length - 1] === RED) n.pop() // gone after a flash
        if (t % 2 === 1) {
          const fullest = nodes.reduce((a, b) => (b.length > a.length ? b : a))
          if (fullest.length > 0) fullest[fullest.length - 1] = RED
        }
      }
    },
    pixel: (x, y) => {
      const i = COLS.indexOf(x)
      const p = falling.find(f => COLS[f.node] === x && f.y === y)
      if (p) return hsl(p.hue, 0.9, 0.7)
      if (i < 0 || y < 7 - SLOTS) return undefined
      const hue = nodes[i]![6 - y]
      if (hue === undefined) return '#1e293b' // an empty slot in the rack
      return hue === RED ? '#ef4444' : hsl(hue, 0.8, 0.55)
    },
  } satisfies Animation
})()

const ANIMATIONS: Animation[] = [lifeAnimation, textAnimation, rainAnimation, rippleAnimation, scheduleAnimation]
let playing = 0
let playingTick = 0
ANIMATIONS[0]!.start()
// One tick of the current animation, or the next one once it has run its course.
function advanceScreen(): void {
  playingTick++
  if (playingTick >= ANIMATIONS[playing]!.ticks) {
    playing = (playing + 1) % ANIMATIONS.length
    playingTick = 0
    ANIMATIONS[playing]!.start()
  }
  ANIMATIONS[playing]!.tick(playingTick)
}

type Ui = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Text'>

// One row per node under a header row; the footer only where asked.
function nodeTable({ Box, Text }: Ui, snap: Snapshot, nowMs: number, footer: boolean) {
  const color = (state: string) => (state === 'Ready' ? 'green' : state === 'Cordoned' ? 'yellow' : 'red')
  const phaseColor = (phase: string) => (phase === 'Ready' ? 'green' : phase === 'Failed' ? 'red' : 'yellow')
  const level = (v: number | null) => (v === null ? undefined : v >= ALERT ? 'red' : v >= WARN ? 'yellow' : 'green')
  const show = (v: number | null) => (v === null ? '   -' : `${String(v).padStart(3)}%`)
  const row = (state: string, stateColor: string | undefined, kind: string, provider: string, name: string,
    sessions: string, u: Usage | null, tail: string) => {
    const [[, cpu], [, mem], [, disk]] = percents(u) as [[string, number | null], [string, number | null], [string, number | null]]
    return (
      <Text wrap="truncate-end">
        <Text color={stateColor}>{pad(state, 9)}</Text> <Text dimColor>{pad(kind, 5)}</Text> {pad(provider, 8)} {pad(name, 22)} {pad(sessions, 5)}
        {' '}<Text color={level(cpu)}>{show(cpu)}</Text> <Text color={level(mem)}>{show(mem)}</Text>{' '}
        <Text color={level(disk)}>{show(disk)}</Text> <Text dimColor>{tail}</Text>
      </Text>
    )
  }
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate-end">
        {pad('STATE', 9)} {pad('KIND', 5)} {pad('PROVIDER', 8)} {pad('NAME', 22)} {pad('SESS', 5)}  CPU  MEM DISK INFO
      </Text>
      {snap.kube.map(n => row(n.ready, color(n.ready), 'k8s', n.provider, n.name, '-', n.usage, n.roles))}
      {snap.agents.map(n =>
        row(n.ready, color(n.ready), 'agent', n.provider, n.name, n.sessions, n.usage, age(n.heartbeatAt, nowMs)),
      )}
      {snap.claims.map(c => row(c.phase || '-', phaseColor(c.phase), 'claim', c.provider, c.name, '-', null, c.pool))}
      {snap.error ? <Text color="red" wrap="truncate-end">kubectl: {snap.error}</Text> : null}
      {footer && !snap.error ? (
        <Text dimColor>
          {'\n'}updated {new Date(snap.at).toLocaleTimeString('en-GB', { timeZone: 'Europe/Oslo' })}, every {POLL_MS / 1000}s;
          yellow from {WARN}%, red and an alert from {ALERT}%
        </Text>
      ) : null}
    </Box>
  )
}

// The overview shows in two places only: the pane while the conversation is
// still empty (a new session, or after /clear), closed by the first prompt,
// and under the spinner while a turn runs.
function screenView({ Box, Text }: Ui, _frame: number) {
  const animation = ANIMATIONS[playing]!
  return (
    <Box flexDirection="column">
      {Array.from({ length: Math.ceil(SCREEN / 2) }, (_, r) => (
        <Text>
          {Array.from({ length: SCREEN }, (_, x) => {
            const fg = animation.pixel(x, 2 * r)
            const bg = 2 * r + 1 < SCREEN ? animation.pixel(x, 2 * r + 1) : undefined
            if (fg) return <Text color={fg} backgroundColor={bg}>▀</Text>
            if (bg) return <Text color={bg}>▄</Text>
            return ' '
          })}
        </Text>
      ))}
    </Box>
  )
}

async function openWhileEmpty($: EngineInterface): Promise<void> {
  if ((await $.session.turns()) === 0) await $.ui.open({ id: PANE, title: 'k8ai nodes' })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'k8ai-nodes',
      description: 'Show the k8ai cluster nodes (control plane, AgentNodes, NodeClaims) and their usage in a pane',
    })
    void poll($)
    $.clock.every(POLL_MS, () => poll($))
    $.clock.every(1000, () => update($, now, () => Date.now()))
    $.clock.every(TICK_MS, () => {
      advanceScreen()
      return update($, frame, f => f + 1)
    })
    void openWhileEmpty($)
    return next(e)
  })

  // A /clear ends the session without a new session.start: the next one is empty.
  on('session.end', { reason: 'clear' }, async ($, e, next) => {
    const result = await next(e)
    void $.ui.open({ id: PANE, title: 'k8ai nodes' })
    return result
  })

  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    const result = await next(e)
    void $.ui.close({ id: PANE })
    return result
  })

  on('command.run', { command: 'k8ai-nodes' }, async $ => {
    await poll($)
    await $.ui.open({ id: PANE, title: 'k8ai nodes' })
    return { text: 'k8ai nodes pane opened; it closes at your next prompt.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const snap = await read($, snapshot)
    if (!snap) return <ui.Text dimColor>Reading {CONTEXT}...</ui.Text>
    return nodeTable(ui, snap, (await read($, now)) || Date.now(), true)
  })

  // The line closing a turn says "Worked for 3s", not "Baked for 3s".
  on('ui.render', { component: 'TurnDuration' }, ($, e, next) => next({ ...e, props: { ...e.props, word: 'Worked' } }))

  // Only the animation and the node table where the spinner line was: no word, no time. The
  // engine's line shows until the first poll has a snapshot.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (!snap) return next(e)
    const ui = $.ui.resolve(e)
    return (
      <ui.Box flexDirection="row" gap={2}>
        {screenView(ui, await read($, frame))}
        {nodeTable(ui, snap, (await read($, now)) || Date.now(), false)}
      </ui.Box>
    )
  })

}
