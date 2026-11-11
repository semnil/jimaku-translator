# 英語基本化の決定

> For the English version, see [english-base.md](english-base.md).

このリポジトリの文書を英語基本にしたとき ([#87](https://github.com/semnil/jimaku-translator/pull/87)、[#88](https://github.com/semnil/jimaku-translator/pull/88)) に閉じた判断と、却下した案を持つ。構成そのものは [CLAUDE.md](../../CLAUDE.md) の「Conventions」にある。

## issue テンプレートは英日併記のまま残す

- **決定** (2026-10-20): `.github/ISSUE_TEMPLATE/` の issue テンプレートは、英語と日本語を併記した見出しのまま残す。#87 は最初、「日本語で構いません」の注記を付けて英語だけにした (`521c3e5`) が、その変更はマージの前に取り消した (`05424a4`)。
- **規則**: リポジトリの持ち主に先に聞かずに、テンプレートを英語だけにしない。
- **却下した案**: 「日本語で構いません」の注記を付けた、英語 1 セットのテンプレート。

## issue #3 と手元のエージェントの指示は日本語のまま残す

- **決定** (2026-10-20): issue #3 (英日併記の「GitHubアカウント不要のフィードバック窓口」) と、`.claude/` の下にある追跡していないエージェントの指示は、今のまま残す。

## work フォルダは追跡中の .gitignore で無視する

- **決定** (2026-10-20、#88): 作業用のフォルダ `work/` は、追跡中の `.gitignore` の 1 行で無視する。
- **却下した案**: `.git/info/exclude` の 1 行 (1 つのチェックアウトにしか効かない)。ファイルを `.claude/` の下へ移す。
