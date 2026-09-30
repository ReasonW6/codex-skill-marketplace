# Upstream snapshot

- Project: `mattpocock/skills`
- Upstream: https://github.com/mattpocock/skills
- Commit: `d81f3a183412e71a5b1e84ca21bc1a35eea03a60`
- Commit date: 2026-09-29T13:37:40+01:00
- License: MIT

This plugin contains eight current skills from the upstream `skills/engineering/`
directory plus `skills/productivity/grilling/`. It also retains
`resolving-merge-conflicts` from snapshot
`6654f6b60cd9d5be8b54c6fafe44346dabeb3b76`; that skill is no longer present
in the current upstream. Experimental and other productivity skills are not
added during this refresh.

The nine upstream user-invoked engineering skills that required removal of the
frontmatter field `disable-model-invocation: true` for Codex compatibility are
intentionally not included in this package. The retained `code-review` skill
has one local wording change so it no longer directs users to the removed
`setup-matt-pocock-skills` skill; other retained skill bodies and supporting
files are unmodified.
