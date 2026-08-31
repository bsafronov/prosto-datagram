# Domain Docs

This repository uses a single domain context.

## Before exploring

- Read `/CONTEXT.md`.
- Read relevant records under `/docs/adr/`.
- If either is absent, proceed silently.

## Layout

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary

Use the canonical terms from `CONTEXT.md` in issues, specifications, tests, and implementation. Avoid synonyms explicitly rejected by the glossary.

If required language is missing, reconsider the term or record the gap for `/domain-modeling`.

## ADR conflicts

Explicitly identify any proposal that contradicts an existing ADR. Never override an accepted decision silently.
