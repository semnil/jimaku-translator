# Release decisions

> 日本語版は [release.ja.md](release.ja.md) を参照してください.

Closed decisions about how jimaku-translator is built and released, with the alternatives that were turned down. The flow itself is in [CLAUDE.md](../../CLAUDE.md) "GitHub Actions release" and "auto-update"; this document holds why it has that shape.

## Rebase merging is off in main's ruleset

- **Decision** (2026-10-20): main's ruleset allows the merge methods `merge` and `squash`. `rebase` was removed from it.
- **Reason**: `tag-release.yaml` finds a version bump by comparing the commit CI checked with that commit's first parent. After a rebase merge of a version-bump pull request with two or more commits, the first parent of the last commit is another commit of the same pull request, so a bump that is not in the last commit is missed.
- **Alternatives turned down**: keeping rebase merging and pushing the tag by hand whenever a multi-commit version-bump pull request merged by rebase is missed.
- **Result**: the repository settings have squash merging off and rebase merging on, and the ruleset has rebase off. A merge commit is the one method both allow.

## electron-builder is pinned to a 27 alpha

- **Decision** (2026-11-01, [#123](https://github.com/semnil/jimaku-translator/pull/123)): `electron-builder` is pinned to the exact version `27.0.0-alpha.14`. The only purpose is to clear the Dependabot alert for minimatch (GHSA-g3hv-75wg-m249), which no arrangement of electron-builder 26 cleared.
- **Alternatives turned down**:
  - Reporting the alert and leaving it open.
  - Staying on 26 and overriding `minimatch` 9 and 10 to a fixed version: the alert stays open, because the 3.x and 5.x copies remain.
  - Staying on 26 and forcing every `minimatch` to the fixed version: the packages that need 3.x and 5.x stop working.

  What was tried for each is in the body of #123.
- **Consequence**: a Dependabot update that includes `electron-builder` is never merged automatically ([.github/workflows/dependabot-auto-merge.yml](../../.github/workflows/dependabot-auto-merge.yml)), because Dependabot labels a move between two alphas, or from an alpha to the stable release, as a semver patch.
- **Reopen when**: `27.0.0` stable is released. The pin moves to it then.

## The update prompt's real flow is checked on the first update from a release that has it

- **Decision** (2026-11-01): the update prompt added in [#126](https://github.com/semnil/jimaku-translator/pull/126) was merged with tests that use mocks and a harness only. That covers the prompt itself, accepting it (download, `quitAndInstall(true, true)`, relaunch) and declining it (nothing is downloaded). The flow in the installed app is checked at the first update where the prompt can appear.
- **Why it waits**: the updater that runs is the installed app's. An installed app older than v1.2.0 updates without asking, so the prompt first appears when an app at v1.2.0, the first release that contains #126, updates to a later release.
- **What to check then**: on macOS, that the app relaunches into the new version; on Windows, that the installer shows no window of its own and the app relaunches; on both, that no whisper-server process is left after the restart.
- **Closes when**: the check has been made on the first release published after v1.2.0. A difference from CLAUDE.md "auto-update" found there is fixed before the release after that.
