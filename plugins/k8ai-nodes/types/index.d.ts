// provider: where the machine runs (local, azure, ...).
// Usage of one machine; a field is null when it is not reported (yet).
export type Usage = {
  cpuPercent: number | null
  memUsed: number | null
  memTotal: number | null
  diskUsed: number | null
  diskTotal: number | null
}
export type KubeNode = { name: string; ready: string; roles: string; version: string; provider: string; usage: Usage | null }
export type AgentNodeRow = {
  name: string
  ready: string
  sessions: string
  terminal: string
  pool: string
  provider: string
  heartbeatAt: number | null
  usage: Usage | null
}
export type ClaimRow = { name: string; pool: string; provider: string; phase: string }
export type Snapshot = {
  at: number
  error: string | null
  kube: KubeNode[]
  agents: AgentNodeRow[]
  claims: ClaimRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'k8ai-nodes': { snapshot: Shaped<Snapshot | null>; now: number; frame: number }
  }
}
