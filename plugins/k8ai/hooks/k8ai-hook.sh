#!/bin/sh
# Claude Code hook for k8ai. Hands the hook event (JSON on stdin) to
# `k8ai hook claude <event>`, which records only the session id, process id,
# working directory and busy/idle state in ~/.k8ai/hooks/claude. The prompt in
# the UserPromptSubmit input is never stored.
#
# It never prints anything (SessionStart output would reach the model) and
# always exits 0, so a missing or failing k8ai never disturbs the session.
bin=$(command -v k8ai 2>/dev/null)
[ -z "$bin" ] && [ -x "$HOME/.local/bin/k8ai" ] && bin="$HOME/.local/bin/k8ai"
if [ -z "$bin" ]; then
	cat >/dev/null
	exit 0
fi
"$bin" hook claude "$1" >/dev/null 2>&1
exit 0
