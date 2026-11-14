---
name: k8ai
description: Join every AI agent session on this machine (Claude Code, opencode, codex; finished, running and future) to a k8ai cluster as AgentSession resources, publishing metadata only. Use when the user wants their local agent sessions to show up in k8ai, asks to adopt, import or backfill sessions into k8ai, or wants to stop or hide adopted sessions.
---

# k8ai: adopt this machine's agent sessions

k8ai is a Kubernetes flavour for orchestrating AI agent sessions. Adoption makes
the `k8ai-node` daemon on this machine publish every local agent session
(finished ones as a backfill, running ones, and every future one) as an
`AgentSession` in the cluster.

Only metadata is published: session id, working directory, git branch,
start and last activity timestamps, message counts, and busy/idle for live
sessions. Titles, prompts and message text never leave the machine.

In Claude Code, this plugin also installs hooks (SessionStart, UserPromptSubmit,
Stop, SessionEnd) that call `k8ai hook claude <event>`. They record only the
session id, process id, working directory and busy/idle state in
`~/.k8ai/hooks/claude`, never the prompt, so every new Claude Code session
is picked up exactly, with busy/idle, as soon as it starts. Without `k8ai` on
`PATH` the hooks do nothing. Sessions started before the plugin was installed
are still found from Claude Code's own files.

Use only the commands below. Never edit `~/.config/k8ai/node.yaml` by hand and
never signal or kill agent processes.

## 1. Check the CLI is installed

```sh
k8ai version
command -v k8ai k8ai-node
```

If either is missing, stop and tell the user to build both from their k8ai
checkout and put `bin/` on their `PATH`:

```sh
make build-node build-cli   # produces bin/k8ai-node and bin/k8ai
```

## 2. Check this node has joined

```sh
k8ai nodes
cat ~/.config/k8ai/node.yaml
```

The node has joined when `node.yaml` exists and its node name shows up in
`k8ai nodes` with Ready `True`. If not, **stop and ask the user** to join it themselves,
because it installs a background service and needs a node kubeconfig only they
hold:

```sh
k8ai node join --name <name> --kubeconfig <path> --terminal iterm2|ghostty|headless
```

On macOS with `iterm2` or `ghostty`, the first session that opens a tab
triggers an Automation consent prompt so the daemon can control the terminal.
Tell the user to allow it. Continue only after they confirm the join worked
and `k8ai nodes` shows the node.

## 3. Preview what would be published

Run a dry run. It reads local session files and prints what would be
published, without sending anything to the cluster:

```sh
k8ai adopt scan --dry-run                       # all supported harnesses
k8ai adopt scan --dry-run --harness claude,opencode,codex
```

Show the user a short summary, not the full output:

- session counts per harness, and how many are live versus finished;
- three to five sample rows (id, cwd, branch, timestamps, message counts).

Point out that working directory paths and branch names are published, and
that nothing else from the sessions is. **Ask the user to confirm** before
going on. If they want fewer harnesses, note the list for step 4. If they
decline, stop here.

## 4. Enable adoption

Only after the user confirmed the preview:

```sh
k8ai adopt enable                                  # defaults: all harnesses, all history, namespace k8ai-adopted
k8ai adopt enable --harness claude,codex --namespace k8ai-adopted
k8ai adopt enable --since 30d                      # backfill only the last 30 days
```

`enable` turns adoption on in `node.yaml` and restarts the daemon. On macOS it
restarts the launchd agent itself. If its output instead says the agent is
not installed, or prints a `systemctl --user restart` command (Linux), ask
the user to restart `k8ai-node` (or run the printed command with their
consent) before polling the status.

Then poll until the first scan has completed (the status shows a last scan
time and per-harness counts):

```sh
k8ai adopt status
```

Check every few seconds; a full backfill can take a minute or two. If the
`ERRORS` column is not zero or a `Last error` line appears, show it to the
user and stop.

When the scan is done, summarise the result:

```sh
k8ai ls --source adopted -n k8ai-adopted
kubectl get agentsessions -n k8ai-adopted
```

Report counts by phase (Running for live, Succeeded for finished) and by
harness, and mention that this session itself should appear as Running. Do
not paste every row.

## 5. Stop or hide

Stop adopting (no new or updated sessions are published):

```sh
k8ai adopt disable
```

Stop adopting and remove every session this node adopted from the cluster
(the user's own kubeconfig does the deletes). Sessions hidden one by one stay
hidden if adoption is enabled again. **Ask the user before running it**:

```sh
k8ai adopt disable --purge
```

Hide one session for good: it is removed from the cluster and the daemon
does not recreate it. This cannot be undone from the cluster, so **ask the user
before running it** and name the session you will delete:

```sh
kubectl delete agentsession <name> -n k8ai-adopted
```

## 6. Skills (optional)

k8ai can also publish which agent skills this machine has (folders with a
`SKILL.md` in `~/.claude/skills`, `~/.config/opencode/skills`,
`~/.codex/skills` and `~/.agents/skills`) as `NodeSkill` resources, and
install skills declared in the cluster as `AgentSkill` resources. Only do
this when the user asks for it.

Inventory publishes each skill's name, frontmatter description, folder paths,
link targets and a content hash, never file contents. Preview it first and
**ask the user to confirm** before enabling:

```sh
k8ai skills scan --dry-run
k8ai skills enable
k8ai skills status
k8ai skills ls --node <name>
```

Installing puts instructions into every future agent session on this
machine, so it is off by default and needs explicit namespaces and repo
hosts. **Ask the user** before enabling it, and name the hosts and
namespaces you will allow:

```sh
k8ai skills enable --install --allow-namespace default --allow-repo-host github.com
k8ai skills add https://github.com/<owner>/<repo>.git --path <dir> --selector k8ai.dev/pool=laptop
k8ai skills ls --declared
k8ai skills rm <name>
```

k8ai never replaces a skill it did not install (it reports a Conflict), and
removing an AgentSkill deletes only k8ai's own links and copy.
`k8ai skills disable --install --purge` removes everything k8ai installed on
this machine.
