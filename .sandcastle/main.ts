/* eslint-disable no-console -- CLI script, output goes to the Actions log */
import { claudeCode, run } from '@ai-hero/sandcastle';
import { noSandbox } from '@ai-hero/sandcastle/sandboxes/no-sandbox';
import { execSync } from 'node:child_process';

// Implements a single GitHub issue on the current branch.
// Invoked by .github/workflows/sandcastle.yml. The GitHub Actions runner is
// already a throwaway VM, so the agent runs directly on it (noSandbox) the
// same way Sandcastle's own CI does.

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
};

const ISSUE_NUMBER = required('ISSUE_NUMBER');
const BRANCH = required('BRANCH');
const BASE_BRANCH = process.env.BASE_BRANCH ?? 'main';
const MODEL = process.env.SANDCASTLE_MODEL || 'claude-opus-5-5';

const issueContext = execSync(`gh issue view ${ISSUE_NUMBER} --comments`, {
  encoding: 'utf8',
});

await run({
  name: `issue-#${ISSUE_NUMBER}`,
  agent: claudeCode(MODEL, {
    env: { CLAUDE_CODE_OAUTH_TOKEN: required('CLAUDE_CODE_OAUTH_TOKEN') },
  }),
  sandbox: noSandbox(),
  logging: { type: 'stdout' },
  promptFile: '.sandcastle/prompt.md',
  promptArgs: {
    ISSUE_NUMBER,
    BRANCH,
    ISSUE_CONTEXT: issueContext,
  },
});

const commitsAhead = Number(
  execSync(`git rev-list --count origin/${BASE_BRANCH}..HEAD`, { encoding: 'utf8' }).trim(),
);
if (!commitsAhead) {
  console.error('Agent finished but made no commits.');
  process.exit(1);
}
console.log(`Agent produced ${commitsAhead} commit(s) on ${BRANCH}.`);
