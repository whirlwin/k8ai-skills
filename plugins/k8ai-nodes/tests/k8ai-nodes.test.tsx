import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

const SPINNER = { word: 'Baking', message: null, suffix: '…', mode: 'responding' as const }
const NODES = { items: [{ metadata: { name: 'k8ai-control-plane', labels: { 'node-role.kubernetes.io/control-plane': '' } },
  spec: { providerID: 'kind://podman/k8ai/k8ai-control-plane' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }] }
const AGENTS = { items: [
  { metadata: { name: 'mac', labels: { 'k8ai.dev/pool': 'laptop' } }, spec: { capacity: { sessions: 4 } }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
  { metadata: { name: 'azure-e2e-abcde', labels: { 'restricted.k8ai.dev/nodepool': 'azure-e2e' } }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
] }
const POOLS = { items: [{ metadata: { name: 'azure-e2e' }, spec: { provider: 'azure' } }] }

// The engine beneath: kubectl answered from fixtures, a session whose prompt
// count the test sets, and the pane calls recorded.
function engine(on: On, turns: { n: number }): string[] {
  const panes: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.turns', () => ({ value: turns.n }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_, e) => { panes.push(`open ${e.id}`); return { value: { isPlaced: true } } })
  on('ui.close', (_, e) => { panes.push(`close ${e.id}`); return { value: undefined } })
  on('process.run', (_, e) => {
    const args = e.argv.join(' ')
    const out = args.includes('agentnodes') ? AGENTS : args.includes('nodepools') ? POOLS
      : args.includes('nodeclaims') ? { items: [] } : args.includes('--raw') ? null : NODES
    return { value: { exitCode: out ? 0 : 1, stdout: JSON.stringify(out), stderr: out ? '' : 'no summary' } }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const props = e.props as { word: string; suffix: string }
    return h(Text, {}, `${props.word}${props.suffix}`) as RenderElement
  })
  return panes
}

function shown(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null || !('children' in node) || !Array.isArray(node.children)) return ''
  return node.children.map(shown).join('')
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

test('a new session opens the pane, the first prompt closes it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const panes = engine(on, { n: 0 })
  await start($)
  await clock.advance(1000)
  expect(panes).toEqual(['open k8ai-nodes'])
  await $.session.append({
    door: 'prompt', origin: 'person', uuid: 'u1',
    message: { type: 'user', content: [{ type: 'text', text: 'hi' }] },
  } as never)
  expect(panes).toEqual(['open k8ai-nodes', 'close k8ai-nodes'])
})

test('a resumed session with prompts opens no pane', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const panes = engine(on, { n: 3 })
  await start($)
  await clock.advance(1000)
  expect(panes).toEqual([])
})

test('the spinner shows only each node with its provider', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  engine(on, { n: 1 })
  await start($)
  await clock.advance(1000)
  const ui = await $.ui.mount({ plugin: 'k8ai-nodes', surface: 'terminal', component: 'Spinner', requestId: 'main', props: SPINNER })
  const text = shown(await ui.drawn())
  expect(text).not.toContain('Baking')
  expect(text).not.toContain('Working')
  expect(text).toMatch(/Ready +k8s +local +k8ai-control-plane/)
  expect(text).toMatch(/Ready +agent +local +mac/)
  expect(text).toMatch(/Ready +agent +azure +azure-e2e-abcde/)
})
