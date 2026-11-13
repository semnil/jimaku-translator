# リリースの決定

> For the English version, see [release.md](release.md).

jimaku-translator のビルドとリリースについて閉じた判断と、却下した案を持つ。流れそのものは [AGENTS.md](../../AGENTS.md) の「GitHub Actions release」と「auto-update」にあり、この文書は、なぜその形なのかを持つ。

## main の ruleset で rebase マージを外す

- **決定** (2026-10-20): main の ruleset が許すマージの方式は `merge` と `squash`。`rebase` は外した。
- **理由**: `tag-release.yaml` は、CI が検査したコミットと、その第 1 親を比べて版上げを見つける。2 つ以上のコミットを持つ版上げの PR を rebase でマージすると、最後のコミットの第 1 親は同じ PR の別のコミットになるので、最後のコミットに無い版上げは見落とされる。
- **却下した案**: rebase マージを残し、複数コミットの版上げの PR が rebase でマージされて見落とされるたびに、手でタグを push する。
- **結果**: リポジトリの設定では squash マージがオフで rebase マージがオン、ruleset では rebase がオフ。両方が許す方式は、マージコミットの 1 つ。

## electron-builder を 27 の alpha に固定する

- **決定** (2026-11-01、[#123](https://github.com/semnil/jimaku-translator/pull/123)): `electron-builder` を、版 `27.0.0-alpha.14` ちょうどに固定する。目的は、minimatch の Dependabot alert (GHSA-g3hv-75wg-m249) を閉じることだけ。electron-builder 26 のどの組み方でも、この alert は閉じなかった。
- **却下した案**:
  - alert を報告だけして、開いたままにする。
  - 26 に残り、`minimatch` の 9 と 10 を修正版へ上書きする。3.x と 5.x の写しが残るので、alert は開いたままになる。
  - 26 に残り、どの `minimatch` も修正版へ強制する。3.x と 5.x を必要とするパッケージが動かなくなる。

  それぞれで試した中身は、#123 の本文にある。
- **これで決まること**: `electron-builder` を含む Dependabot の更新は、自動ではマージしない ([.github/workflows/dependabot-auto-merge.yml](../../.github/workflows/dependabot-auto-merge.yml))。Dependabot は、alpha から alpha への移動と、alpha から安定版への移動を、semver の patch と分類するため。
- **見直す条件**: `27.0.0` の安定版が出たとき。そのとき、固定をそこへ移す。

## 更新の確認ダイアログの実機の流れは、それを持つ版からの最初の更新で確かめる

- **決定** (2026-11-01): [#126](https://github.com/semnil/jimaku-translator/pull/126) で足した更新の確認ダイアログは、モックとハーネスを使うテストだけでマージした。その範囲は、ダイアログそのもの、承諾したとき (ダウンロード、`quitAndInstall(true, true)`、再起動)、断ったとき (何もダウンロードしない)。インストールしたアプリでの流れは、ダイアログが出うる最初の更新で確かめる。
- **待つ理由**: 動く updater は、インストール済みのアプリのもの。v1.2.0 より古いアプリは尋ねずに更新するので、ダイアログが最初に出るのは、#126 を含む最初のリリースである v1.2.0 のアプリが、それより後のリリースへ更新するとき。
- **そのとき確かめること**: macOS では、アプリが新しい版で再起動すること。Windows では、インストーラーが自分のウィンドウを出さず、アプリが再起動すること。どちらでも、再起動の後に whisper-server のプロセスが残っていないこと。
- **閉じる条件**: v1.2.0 の後に公開する最初のリリースで、確かめ終えたとき。そこで AGENTS.md の「auto-update」との違いが見つかったら、その次のリリースの前に直す。
