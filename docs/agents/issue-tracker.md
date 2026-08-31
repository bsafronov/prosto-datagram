# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `bsafronov/prosto-datagram`. Use the `gh` CLI.

## Operations

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --comments`
- List: `gh issue list --state open --json number,title,body,labels,comments`
- Comment: `gh issue comment <number> --body "..."`
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: `gh issue close <number> --comment "..."`

Infer the repository from the current Git remote.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill conventions

When a skill says “publish to the issue tracker,” create a GitHub issue.

When a skill says “fetch the relevant ticket,” run:

`gh issue view <number> --comments`

## Wayfinding

- A map is one issue labelled `wayfinder:map`.
- Child tickets use `wayfinder:<type>`.
- Link children using GitHub sub-issues when available.
- Represent blockers with native GitHub issue dependencies.
- Fall back to `Blocked by: #<number>` when dependencies are unavailable.
- A ticket is available when all blockers are closed and it has no assignee.
- Claim with `gh issue edit <number> --add-assignee @me`.
- Resolve by commenting with the answer, closing the ticket, and updating the map.
