// PreToolUse hook (Bash): refuse any shell command that calls the Portainer
// deploy webhook directly. Deploys go through scripts/deploy-when-idle.mjs,
// which waits until the scanner is idle; a direct POST is how a deploy killed
// a running scan cycle on Nov 13 2026 despite a "check first" rule.
//
// Reads the hook payload on stdin; prints a deny decision or nothing.

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let command = '';
  try {
    command = String(JSON.parse(raw)?.tool_input?.command ?? '');
  } catch {
    return; // not a payload we understand: stay out of the way
  }
  if (!/\/api\/stacks\/webhooks\//i.test(command)) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Never POST the deploy webhook directly: a redeploy mid-scan kills the cycle. '
        + 'Run `node scripts/deploy-when-idle.mjs` (in the background), which waits until '
        + "prod's scanner is idle for the whole cycle, deploys, and confirms the new build.",
    },
  }));
});
