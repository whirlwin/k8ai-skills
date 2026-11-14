# k8ai-skills

Agent skills for k8ai, a Kubernetes flavour for orchestrating AI agent
sessions. In k8ai any Kubernetes API server is the control plane, each agent
session is an `AgentSession` custom resource, and every machine that runs
sessions joins as an `AgentNode` by running the `k8ai-node` daemon.

This repository holds instructions only: no binaries, no scripts, no personal
data. It is a Claude Code plugin marketplace, and its skills use the open
Agent Skills format, so other agents can use them too.

## Skills

| Skill | What it does |
|-------|--------------|
| `k8ai` | Joins every agent session on this machine (Claude Code, opencode, codex; finished, running and future) to a k8ai cluster. It checks the node has joined, shows a dry run of what would be published, and enables adoption only after you confirm. |

The skill drives the `k8ai` CLI (`k8ai adopt scan --dry-run`, `adopt enable`,
`adopt status`, `adopt disable`). You need `k8ai` and `k8ai-node` built from
your k8ai checkout (`make build-node build-cli`) and a joined node.

## Install

In Claude Code:

```
/plugin marketplace add whirlwin/k8ai-skills
/plugin install k8ai@k8ai
```

Then ask Claude to "join my agent sessions to k8ai", or run `/k8ai:k8ai`.

### As a plain Agent Skill

For agents that support the Agent Skills format, copy
`plugins/k8ai/skills/k8ai` (the folder holding `SKILL.md`) into that agent's
skills directory.

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

## License

MIT, see [LICENSE](LICENSE).
