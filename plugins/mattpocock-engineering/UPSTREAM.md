# Upstream snapshot

- Project: `mattpocock/skills`
- Upstream: https://github.com/mattpocock/skills
- Commit: `6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`
- Commit date: 2026-08-24T15:19:57+01:00
- License: MIT

This plugin contains nine skills from the upstream `skills/engineering/`
directory plus `skills/productivity/grilling/`. Experimental, deprecated,
miscellaneous, and other productivity skills are not included.

The nine upstream user-invoked engineering skills that required removal of the
frontmatter field `disable-model-invocation: true` for Codex compatibility are
intentionally not included in this package. The retained `code-review` skill
has one local wording change so it no longer directs users to the removed
`setup-matt-pocock-skills` skill; other retained skill bodies and supporting
files are unmodified.
