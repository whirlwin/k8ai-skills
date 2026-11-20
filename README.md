# k8ai-skills

Agent skills for k8ai, a Kubernetes flavour for orchestrating AI agent
sessions. In k8ai any Kubernetes API server is the control plane, each agent
session is an `AgentSession` custom resource, and every machine that runs
sessions joins as an `AgentNode` by running the `k8ai-node` daemon.

This repository holds instructions and one small hook script: no binaries, no
personal data. It is a Claude Code plugin marketplace, and its skills use the open
Agent Skills format, so other agents can use them too.

## Skills

| Skill | What it does |
|-------|--------------|
| `k8ai` | Joins every agent session on this machine (Claude Code, opencode, codex; finished, running and future) to a k8ai cluster. It checks the node has joined, shows a dry run of what would be published, and enables adoption only after you confirm. It can also publish the skills on this machine and install skills declared in the cluster, each only after you confirm. |

The skill drives the `k8ai` CLI (`k8ai adopt scan --dry-run`, `adopt enable`,
`adopt status`, `adopt disable`). You need `k8ai` and `k8ai-node` built from
your k8ai checkout (`make build-node build-cli`) and a joined node.

## Install

In Claude Code:

```
/plugin marketplace add whirlwin/k8ai-skills
/plugin install k8ai@k8ai
/plugin install k8ai-nodes@k8ai   # optional: the node overview mod below
```

Then ask Claude to "join my agent sessions to k8ai", or run `/k8ai:k8ai`.

### As a plain Agent Skill

For agents that support the Agent Skills format, copy
`plugins/k8ai/skills/k8ai` (the folder holding `SKILL.md`) into that agent's
skills directory.

## Hooks

In Claude Code the plugin registers four hooks (SessionStart,
UserPromptSubmit, Stop, SessionEnd). Each runs
[`plugins/k8ai/hooks/k8ai-hook.sh`](plugins/k8ai/hooks/k8ai-hook.sh), which
passes the event to `k8ai hook claude <event>` (k8ai builds without the
`hook` command fail quietly and nothing is recorded). That command keeps one file per running
session in `~/.k8ai/hooks/claude` with the session id, process id, working
directory and busy/idle state, and deletes it when the session ends. The
prompt that Claude Code hands to UserPromptSubmit hooks is never stored. The
script prints nothing, always exits 0, and does nothing if `k8ai` is not
installed. The `k8ai-node` daemon reads these files, so new sessions appear
in the cluster within seconds, including sessions started from inside another
Claude session, which leave no other reliable trace.

## Privacy

Adoption publishes metadata only, never content:

- published: harness, session id, working directory, git branch, start and
  last activity timestamps, message counts, busy/idle for live sessions;
- never published: session titles, prompts, message text, tool output.

The skill always shows you `k8ai adopt scan --dry-run` first and asks before
anything is sent to the cluster. `k8ai adopt disable` stops adoption, and
deleting an adopted `AgentSession` hides it for good. Working directory paths
and branch names can themselves be revealing, so review the dry run before
you enable adoption on a shared cluster.

## The k8ai-nodes mod

`k8ai-nodes` is a Claude Code mod (a hooks module, no skill) that shows the
nodes of your local k8ai cluster inside Claude Code:

- a pane with the kind cluster's Kubernetes nodes (control plane included),
  the AgentNodes and the NodeClaims, with state, provider (local, azure, ...),
  sessions and CPU, memory and disk use. It opens by itself in a new, empty
  session and closes at your first prompt; `/k8ai-nodes` opens it again;
- while Claude works, the same node table in place of the spinner words,
  next to a small animation that cycles through Game of Life, "k8ai"
  scrolling past, rain, ripples and pods being scheduled onto nodes.

It only reads: every 10 seconds it runs `kubectl --context kind-k8ai get` for
nodes, AgentNodes, NodeClaims and NodePools, and the nodes' stats summary. It
always uses the `kind-k8ai` context (what `hack/kind.sh` in the k8ai repo
creates), never kubectl's current context, so it shows nothing else. You need
`kubectl` on `PATH`; without the cluster the pane says what kubectl reported.

## License

MIT, see [LICENSE](LICENSE).
