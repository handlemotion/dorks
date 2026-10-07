# Agent ground rules

## Branching

- Branch from and target `main` by default.
- Only continue on, or branch from, another feature branch when the work truly stacks on unmerged changes (it cannot work without them). If unsure, use `main`.

## Models

- Flagship models: Opus, Sonnet 5.5, Haiku 5.5. Use only these when spawning agents/sessions or choosing a model.
- Haiku 5.5 is not yet available in Conductor (expected soon); until it is, use Sonnet 5.5 in its place.
- Do not use older or non-Anthropic models (e.g. codex/gpt, cursor/grok, older Opus/Sonnet/Haiku versions).
