# English-base decisions

> 日本語版は [english-base.ja.md](english-base.ja.md) を参照してください.

Closed decisions from making English the base language of this repository's documents ([#87](https://github.com/semnil/jimaku-translator/pull/87), [#88](https://github.com/semnil/jimaku-translator/pull/88)), with the alternatives that were turned down. The layout itself is in [CLAUDE.md](../../CLAUDE.md) "Conventions".

## Issue templates stay bilingual

- **Decision** (2026-10-20): the issue templates in `.github/ISSUE_TEMPLATE/` keep their English / Japanese headings. #87 first made them English only, with a note that Japanese is fine (`521c3e5`), and that change was reverted before the merge (`05424a4`).
- **Rule**: the templates are not made English only without asking the repository owner first.
- **Alternatives turned down**: one English set of templates with a note that Japanese is fine.

## Issue #3 and the local agent instructions stay Japanese

- **Decision** (2026-10-20): issue #3, the bilingual "Feedback without a GitHub account" issue, and the agent instructions under `.claude/`, which are not tracked, stay as they are.

## The work folder is ignored through the tracked .gitignore

- **Decision** (2026-10-20, #88): the scratch folder `work/` is ignored by a line in the tracked `.gitignore`.
- **Alternatives turned down**: a line in `.git/info/exclude`, which covers one checkout only; moving the files under `.claude/`.
