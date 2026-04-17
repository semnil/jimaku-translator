# セキュリティ監査レポート

**対象**: jimaku-translator v1.0.9
**日付**: 2026-04-17
**スコープ**: HTTP サーバー (`server.ts`)、Electron メインプロセス (`electron.ts`)、Web UI (`ui/index.html`)、パイプライン (`pipeline.ts`)、音声レベル処理 (`audio/level.ts`)、Whisper プロセス管理 (`whisper-process.ts`)、Whisper セットアップ (`whisper-setup.ts`)、OBS クライアント (`obs/client.ts`)、ビルドフック (`build/afterPack.cjs`)

## 概要

jimaku-translator は `127.0.0.1:9880` でローカル HTTP サーバーを公開する。外部ネットワークからはアクセス不可 (localhost バインド)。Electron ウィンドウは `nodeIntegration: false`, `contextIsolation: true` で動作する。

## 攻撃面

| 攻撃面 | リスク | 対策状況 |
|--------|--------|----------|
| HTTP サーバー (localhost:9880) | ローカルアプリケーションからのアクセス | localhost バインドで外部公開なし |
| POST /api/config | 設定ファイル書き込み | 入力バリデーション + TOML エスケープ実装済み |
| POST /api/capture | 音声キャプチャ WAV 出力 | localhost バインド、最大 30 秒制限、タイムアウト付き |
| GET /api/obs/sources | OBS テキストソース列挙 | localhost バインド、読み取り専用 |
| POST /api/whisper/download-binary | 外部バイナリダウンロード | GitHub Releases の固定 URL のみ。リダイレクト上限 10。macOS は `brew install` |
| POST /api/whisper/download-model | 外部モデルダウンロード | HuggingFace の固定 URL のみ。リダイレクト上限 10 |
| whisper-server 子プロセス | バイナリ実行 | ダウンロード済み or config 指定パスのみ実行 |
| Homebrew バイナリ検出 | シンボリックリンク差し替え | `realpathSync` でリンク先を解決し、Cellar 配下の実ファイルのみ許可 |
| `brew install` 実行 | Homebrew 経由のパッケージインストール | 絶対パス (`/opt/homebrew/bin/brew`) で `execFileAsync` 使用。引数は固定 |
| afterPack ビルドフック | Info.plist 書き換え | `execFileSync` + 引数配列で PlistBuddy 呼び出し。シェル解釈なし |
| VBAN UDP (port 6980) | 不正パケット受信 | パーサーがヘッダ検証、全フォーマット対応 |
| POST /api/config → VBAN ポート変更 | ランタイム UDP ソケット再バインド | ポート変更は localhost API 経由のみ。バインド失敗時はステータスをリセット |
| OBS WebSocket | 認証情報 (パスワード) | config.local.toml に保存 (.gitignore 済み) |
| Electron ウィンドウ | XSS / コード実行 | contextIsolation + nodeIntegration 無効 |
| SSE ストリーム | download-progress イベント | 秘密情報なし。ファイル名とバイト数のみ |

## 検出された問題と対策

### 修正済み

1. **TOML インジェクション (S2)**
   - `POST /api/config` で送信された文字列値が TOML にエスケープなしで書き込まれていた
   - `escapeTomlString()` を追加し、`"`, `\`, `\n`, `\r` をエスケープ

2. **JSON 入力の型検証なし (S2)**
   - `JSON.parse(body) as Config` で型アサーションのみ、構造検証なし
   - `parseConfigInput()` で全フィールドの型チェックを追加

3. **リクエストボディサイズ無制限 (S3)**
   - `readBody()` がサイズ制限なしでメモリに蓄積していた
   - 64KB 上限を追加、超過時は接続切断

4. **サーバーエラーハンドリング不足 (S4)**
   - `server.listen()` の `EADDRINUSE` エラーが未処理だった
   - `index.ts`, `electron.ts` 両方にエラーハンドラ追加

5. **getObs() 初期化前アクセス (S2)**
   - Pipeline.start() 完了前に `/api/obs/sources` が呼ばれると undefined
   - `getObs()` の戻り型を `ObsClient | null` に変更、null ガード追加

6. **captureAudio promise リーク (S2)**
   - パイプライン停止時や VBAN ストリーム切断時に capture promise が永久に解決しない
   - タイムアウト (2x duration + 5s) と `stop()` 時の reject を追加

7. **downloadFile 不完全ダウンロード (S3)**
   - HTTP 接続が途中で切断された場合、不完全なファイルが正常としてディスクに残る
   - Content-Length と実際のダウンロードバイト数の比較を追加、不一致時は削除

8. **downloadFile レスポンスストリームエラー未処理 (S3)**
   - `res.on('error')` が未登録。ネットワーク切断時にエラーが伝播しない
   - `res.on('error')` ハンドラを追加、ファイル削除 + reject

9. **processQueue 状態リセット漏れ (S3)**
   - `stop()` が `inferring` と `inferQueue` をリセットしない
   - stop → start の再起動で推論キューが詰まる
   - `stop()` でリセットを追加

10. **logBuffer 無制限成長 (S4)**
    - パイプラインが長時間稼働するとログバッファがメモリを圧迫
    - 500 エントリ上限を追加

11. **VAD feedQueue Promise チェーン断絶 (S2)**
    - `feedInternal` が一度 reject すると feedQueue チェーンが永続的に壊れ、以降の全 feed() がスキップ
    - `.catch(() => {})` で前回のエラーを吸収してチェーンを維持

12. **ダウンロード完了時のチェックサム未検証 (S3)**
    - ダウンロード完了ファイルのデータ整合性を検証する手段がなかった
    - SHA-256 ハッシュをストリーミング計算し `.sha256` サイドカーファイルに保存
    - `getInstalledModel` / `getInstalledBinary` はサイドカー不在で未インストール扱い

13. **同一リソースの重複ダウンロード (S3)**
    - 同じモデル/バリアントのダウンロードを並行して開始できた
    - `downloadingResources` Set でリソース ID を追跡、409 で拒否

14. **Homebrew バイナリ検出のシンボリックリンク検証 (S3)**
    - `detectHomebrewWhisperServer()` が `fs.existsSync()` でシンボリックリンクを無検証で透過していた
    - 攻撃者がローカルに `whisper-server` → 悪意あるバイナリのシンボリックリンクを作成可能
    - `fs.realpathSync()` でリンク先を解決し、Homebrew Cellar 配下 (`prefix/Cellar/`) の実ファイルのみ許可

15. **afterPack ビルドフックのコマンドインジェクション防止 (S3)**
    - PlistBuddy 呼び出しが `execSync` + テンプレートリテラルでシェル解釈を経由していた
    - `execFileSync` + 引数配列に変更し、シェル解釈を完全に排除

16. **OBS 字幕送信エラーによる推論結果消失防止 (S3)**
    - `subtitle.show()` のエラーが `processQueue` の try-catch に巻き込まれ、「Inference failed」として報告されていた
    - 推論結果の保持 (`lastResult`) は成功していたが、OBS 字幕更新失敗が推論失敗と区別できなかった
    - `subtitle.show()` を個別 catch で処理し、推論エラーと OBS エラーを分離

17. **多重起動防止 (S4)**
    - Electron アプリが多重起動可能で、ポート競合 (9880, 6980) やリソース競合が発生していた
    - `app.requestSingleInstanceLock()` で多重起動を防止。2 回目の起動は既存ウィンドウをフォーカス

18. **OBS 初回接続失敗時の自動再接続不能 (S2)**
    - OBS Studio より先に jimaku-translator を起動すると、初回 `connect()` 失敗後に再接続がスケジュールされない
    - `connect()` 失敗時に `scheduleReconnect()` を呼び出すよう修正。リスナー登録を `setupListeners()` に分離し接続試行前に実行

19. **VBAN ポート再バインド失敗時のステータス不整合 (S2)**
    - 設定変更でポートを使用中ポートに変更 → `stop()` → `start()` 失敗 → `vbanListening` が `true` のまま
    - `updateVbanConfig` でポート変更時に `vbanListening` を `false` にリセット。`listening` イベントで復帰

20. **VAD feedQueue の無制限成長 (S2)**
    - `vad.feed()` が fire-and-forget で呼ばれるため、ONNX 推論が音声到着速度に追いつかない場合、未処理の Promise が無制限に蓄積
    - `feedQueueDepth` カウンタで深さ 4 を上限とし、超過時は新しい feed をドロップ

21. **VAD LSTM 状態の飽和 (S3)**
    - Silero VAD の LSTM 隠れ状態が長時間の連続音声入力でドリフトし、speech 検出精度が低下
    - 30 秒間の非発話継続で `resetState()` を自動呼び出しし、LSTM 状態をゼロクリア

22. **発話先頭の音声欠損 (S3)**
    - VAD が speech と判定するのは実際の発話開始から 50-150ms 遅れるため、子音や息などの立ち上がりが欠損し認識精度が低下
    - 500ms の pre-speech リングバッファ (`preSpeechBuffer`) を保持し、speech 検出時に前置。メモリ上限は 8000 samples (16KB)

23. **VAD 最大発話長分割の不動作 (S2)**
    - `processChunk` の最大発話長強制分割 (`speechSampleCount >= maxSpeechSamples`) が `prob >= threshold` ブランチ内にしかなく、Silero の母音飽和で prob が崩壊し、かつ continuationRmsFloor で `silenceSamples=0` に固定された場合、発話セグメントが無制限に成長し Whisper Dispatch が発火しない
    - silence ブランチ側にも `else if (this.speechSampleCount >= maxSpeechSamples) { this.emitSpeech(); }` を追加し、prob 状態に依らず最大長で確実に分割
    - メモリ枯渇には至らないが (16kHz × maxSpeechMs で上限あり)、長大セグメントが whisper-server に送信され遅延が累積する DoS 類似の影響を排除

24. **適応ゲート設定値のバリデーション (S4)**
    - `audio.adaptive_gate_*` 4 フィールドを追加 (`adaptive_gate_enabled`, `adaptive_gate_margin_db`, `adaptive_gate_window_sec`, `adaptive_gate_max_db`)
    - `validateConfig()` で範囲制約を実施: `margin_db >= 0`, `window_sec > 0`, `max_db <= -10`, `max_db >= rms_gate_db`
    - GUI から不正値が POST されてもバリデーションで弾かれ、ファイル書き込みに到達しない
    - 新規攻撃面なし (内部数値計算のみ、外部入出力なし)

25. **低音量入力時の認識精度低下 (S3)**
    - Whisper は学習データ分布に近い -3 〜 -6 dBFS 付近で最も精度が高いが、OBS 側入力レベルが低いと認識品質が劣化
    - `src/audio/level.ts` に `computeRms` / `normalizeToTarget` を追加
    - VAD が emit した発話セグメントを RMS 測定し `audio.normalize_target_dbfs` (デフォルト -6) まで増幅 (最大 +20 dB、減衰なし、INT16 クリップ)
    - RMS ゲート (`audio.rms_gate_db`、デフォルト -60、上限 -30) で VAD 前に足切りを行い、ノイズ誤検出と CPU 負荷を削減
    - 入力は全て内部計算で境界が明確 (Int16 PCM、サンプル数上限、ゲート閾値上限 `-30 dBFS`)。新規攻撃面なし

26. **翻訳結果への改行混入による OBS 字幕崩れ (S3)**
    - whisper-server が `\n` を含む翻訳テキストを返すと、`subtitle.show()` がそのまま OBS WebSocket に転送し、テキストソースが意図せず複数行表示
    - `pipeline.ts` の recognition emit 前段と `subtitle/manager.ts` の `show()` 入口の二段で `[\r\n]+` を空白に畳み込む正規化を実施 (defense in depth)
    - 第三者による injection ではなく、上流モデルの非決定的出力が原因。XSS/コマンド注入リスクは無いが、UX 品質劣化として S3 扱い

27. **OBS 再接続失敗ログのスパム (S4)**
    - `obs/client.ts` の自動再接続が失敗するたびに同一エラーが Log パネルに大量出力され、本来の警告が埋もれる可観測性低下
    - 60 秒ウィンドウで連続同一エラーを抑制し、再発時にサマリー (`suppressed N similar errors over Ms`) を 1 行に集約
    - 抑制は文字列キー一致のみで、異なるエラー (DNS 失敗 → 認証失敗等) は即座に通知される

28. **CLI/Electron データディレクトリの不整合 (S2)**
    - 旧版は CLI が `~/.jimaku-translator/whisper`、Electron が `app.getPath('userData')` を参照し、ダウンロード済みモデルが二重管理されていた
    - `getJimakuDataRoot()` で OS 標準の userData (Electron と同一) に統一し、`JIMAKU_DATA_DIR` 環境変数で上書き可能に
    - 起動時に `migrateLegacyDataIfNeeded()` で旧パスをシンボリックリンク (失敗時はコピー) で新パスへ移行
    - macOS の小文字 product name (`jimaku-translator`) と Windows の `%APPDATA%/jimaku-translator/whisper` も migration 候補に追加

29. **Migration 部分コピーによるデータ整合性破損 (S2)**
    - シンボリックリンク不可な環境で `cpSync` がディスクフル等で途中失敗すると、`targetDir` に部分コピーが残存
    - 次回起動時 `fs.existsSync(targetDir)` が真となり migration がスキップされ、欠落モデルを「正常」と誤認
    - 一時 staging dir (`<targetDir>.migrating-<pid>`) へコピー → `fs.renameSync` でアトミックに昇格、失敗時は `fs.rmSync` で staging を削除
    - 攻撃面ではないが、無音失敗によるデータ破損リスクとして S2 扱い

30. **VAD 発話末尾の句点欠落 (S4)**
    - Silero VAD が `silenceMs` 経過時点で発話末尾を切ると、Whisper が句点 (「。」) を出力するための末尾無音余韻が不足
    - `silenceMs` 判定に 125ms の `TAIL_PAD_SAMPLES` を加算し、Whisper に自然な文末を見せる
    - セキュリティ影響なし。UX 品質改善

31. **VAD LSTM 長時間ドリフトの短縮 (S3)**
    - 30 秒の LSTM 自動リセット間隔では、長時間の連続無発話後に隠れ状態が偏り、その後の発話で prob が立ち上がらない事象を確認
    - リセット間隔を 30s → 3s に短縮 (`SILENCE_RESET_SAMPLES = 16000 * 3`)
    - メモリ・CPU 影響軽微 (LSTM は 128 次元、reset 自体は O(1))

32. **CORS ワイルドカード許可 (S3)**
    - `Access-Control-Allow-Origin: *` で任意 origin からの preflight を受け入れていた
    - localhost 上の別ポートで動作する第三者ページから cookie なし fetch で API が叩ける状態
    - `Origin` ヘッダが `http://127.0.0.1:*` / `http://localhost:*` の場合のみ該当 origin を返し、それ以外は CORS ヘッダを付与しない実装に変更 (`src/server.ts`)
    - Electron (`loadURL('http://127.0.0.1:9880/')`) と Playwright (`baseURL` 同じ) は同一 origin のため影響なし

33. **Windows `extractZip` の zip slip 対策 (S2)**
    - `Expand-Archive` は zip エントリの相対パスを検証しないため、`../../` を含む悪意 zip で destDir 外に書き込まれる可能性
    - 展開後に `readdirSync(destDir, { recursive: true })` で全エントリを列挙し、`path.resolve()` が `destDir` プレフィックス外なら `rmSync` で destDir ごと巻き戻し + throw
    - ダウンロード URL はハードコード (GitHub Releases) のため実用リスクは低いが、MITM 環境や将来の設定拡張時に備えた事前対策

34. **PowerShell コマンドインジェクション対策 (S2)**
    - `extractZip` が `powershell -Command "Expand-Archive -Path ${zipPath} ..."` 形式でパスを文字列補間していた
    - `execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', '--', zipPath, destDir])` に変更
    - `-LiteralPath` への切り替えで `[`, `]`, `*` 等のワイルドカード展開も抑止
    - 他のシェル実行箇所 (`nvidia-smi`, `brew install`, `dns-sd`, `whisper-server` spawn) も引数配列形式で既に対策済み (横展開チェック完了)

35. **config.local.toml 破損時の起動クラッシュ (S3)**
    - `loadConfig()` 内 `smol-toml.parse()` が破損 TOML で throw するが、`src/index.ts` / `src/electron.ts` は catch せずプロセス終了
    - ユーザーが GUI で設定を編集中にクラッシュした場合、次回起動できず復旧手段が不明
    - `src/config.ts` で `config.local.toml` のパース失敗時のみ DEFAULTS にフォールバック + `console.warn` でログ出力。ベース `config.toml` 失敗は従来通り throw
    - 攻撃面ではなく可用性の堅牢化

36. **`audio.rmsDb` の -Infinity JSON 直列化 (S4)**
    - `JSON.stringify(Number.NEGATIVE_INFINITY)` は `null` を返すため、UI 側が `null` と真の「未計測」を区別できない
    - `src/pipeline.ts` で `lastFrameRmsLinear <= 0` 時に `-200` (有限値) を返すよう変更。JSON 直列化後も数値として解釈可能

37. **SSE log replay のフラッディング抑制 (S4)**
    - 新規 SSE 接続時に `logBuffer` 最大 500 件が一度に送出され、低速接続でバックプレッシャー無しに帯域を圧迫
    - `src/server.ts` で `getLogBuffer().slice(-100)` に変更。最新 100 件のみ replay
    - Reconnect 頻発環境でのメモリ・帯域累積を抑制

38. **Web UI アクセシビリティ強化 (S4)**
    - WCAG 2.1 AA 準拠に向けて以下を整備:
      - タッチターゲット 32px 以上 (WCAG 2.5.8)
      - `<main>` / `<h1>` / ARIA landmark で文書構造を明示
      - 折りたたみトグルを `<h2>/<h3><button>` 入れ子構造に変更しセマンティクス重複を解消
      - `.toast` に `role="alert" aria-live="assertive"`、`<canvas>` に `role="img" aria-label`
      - `#config-toggle` / `#audio-monitor-toggle` / `#log-toggle` に `aria-controls`
      - range スライダーに `aria-valuetext` を `oninput` で同期、対応する値 span に `aria-hidden="true"`
      - `.indicator` 全てに `aria-hidden="true"` (色のみ情報は隣接テキストに委任)
      - Closed Caption 無効時に言語 select を `disabled` + `aria-disabled` 連動
      - `.indicator.off` の背景色を `#666` → `#888` にしてコントラスト比 3:1 を確保 (WCAG 1.4.11)
      - `html lang` を `applyI18n()` で言語切替時に更新
      - ログエラー判定を英語固定 → `/error|failed|エラー|失敗/i` で日本語対応
    - 攻撃面に影響なし。WCAG 違反の是正として S4 扱い

### 残存リスク (受容)

| リスク | 深刻度 | 理由 |
|--------|--------|------|
| localhost CSRF | LOW | ブラウザからの悪意あるリクエストでローカル設定が変更される可能性。設定変更は即時反映されるが、localhost バインドかつ CORS が `127.0.0.1` / `localhost` origin のみを許可するため、サードパーティ page からのクロスオリジン変更は阻止される |
| SSE ストリーム認証なし | LOW | localhost バインドのため外部アクセス不可。同一マシン上の他プロセスからは読み取り可能だが、秘密情報は含まない |
| OBS パスワード平文保存 | LOW | config.local.toml にパスワードが平文保存される。ローカルファイルアクセス権限に依存 |
| `process.exit()` による即座終了 | LOW | in-flight の Whisper リクエストがキャンセルされない。データ損失はないが、不要なネットワークリクエストが残る可能性 |
| whisper.binary による任意バイナリ実行 | LOW | config.toml/GUI で指定されたパスのバイナリを spawn() で実行する。localhost バインドのため外部からの設定変更は不可 |
| Homebrew バイナリの信頼性 | LOW | `/opt/homebrew/bin/brew` の正当性は OS のファイル権限に依存。ローカル管理者権限がなければ改竄不可 |
| ダウンロード URL のハードコード | LOW | GitHub/HuggingFace の固定 URL にのみアクセス。ユーザー入力による URL 変更不可 |
| SSE クライアント切断後のバックグラウンドダウンロード継続 | LOW | UI 切断後もダウンロードは完了まで続行。config への自動保存は正常に動作するため実害なし |

## Electron セキュリティ設定

| 設定 | 値 | 推奨 |
|------|----|----|
| `nodeIntegration` | `false` | OK |
| `contextIsolation` | `true` | OK |
| `webPreferences.sandbox` | デフォルト (`true` in Electron 20+) | OK |
| メニューバー | `autoHideMenuBar: true` | OK |
| 外部 URL ナビゲーション | 制限なし (localhost のみロード) | OK |

## ダウンロード機能のセキュリティ

| 項目 | 対策 |
|------|------|
| ダウンロード元 URL | ハードコードされた GitHub Releases / HuggingFace URL のみ |
| リダイレクト | 上限 10 回。無限リダイレクトループ防止 |
| ディスク書き込み先 | `%APPDATA%/jimaku-translator/whisper/` (Win) / `~/Library/Application Support/jimaku-translator/whisper/` (macOS) 配下のみ |
| 中断 | AbortController で即座にキャンセル可能 |
| 不完全ファイル | Content-Length 検証、サイズ検証 (90%)、エラー時自動削除 |
| チェックサム | SHA-256 ハッシュをサイドカーに保存。サイドカー不在 = 未完了 |
| 重複ダウンロード | `downloadingResources` Set で同一リソースの並行ダウンロードを拒否 (409) |
| キャンセル | AbortController で即座にキャンセル可能。Cancel UI ボタン付き |
| 並行ダウンロード | 各ダウンロードに固有 ID。Map で管理 |

## ビルドフックのセキュリティ

| 項目 | 対策 |
|------|------|
| afterPack (macOS) | `execFileSync` + 引数配列で PlistBuddy 呼び出し。シェル解釈なし |
| afterPack (Win32) | `rcedit` ライブラリ API。コマンド実行なし |
| asar integrity | SHA-256 ハッシュ + 4MB ブロック配列を afterPack で再計算。electron-builder のタイミングバグを回避 |
| コード署名 (macOS) | Developer ID Application 証明書で `.app` / `.dmg` 両方に署名。hardened runtime 有効、entitlements は最小権限 (network client/server のみ) |
| 公証 (macOS) | electron-builder `notarize: true` で `.app` を自動公証・staple。DMG は `build/notarize-dmg.cjs` で sign → notarytool submit --wait → stapler → spctl 検証。Apple 認証情報は `.env` から `node --env-file-if-exists` 経由で注入 (.gitignore 済み) |

## 自動更新 (electron-updater) のセキュリティ

| 項目 | 対策 |
|------|------|
| 配信元 | `publish.provider: github` で `semnil/jimaku-translator` の Releases のみを参照。任意 URL 指定は不可 |
| 改竄検証 | `latest.yml` / `latest-mac.yml` に SHA-512 ハッシュとファイルサイズを記録。electron-updater がダウンロード後に検証 |
| 差分更新 | `.blockmap` によるブロック単位の差分取得。同じ SHA-512 検証が差分適用後の最終成果物に対して実施される |
| macOS | 署名済み `.app` のみインストール・更新可能。Gatekeeper + notarization により改竄された更新を拒否。unsigned ビルドでは自動更新経路が無効 |
| Windows | NSIS 署名が未設定のため auto-update 自体は動作するが、SmartScreen 警告が残る |
| ドラフトリリース | electron-updater はドラフトを検出しない。手動 publish まで配信されないため、誤って作成されたドラフトが自動配信されるリスクなし |
| dev 環境 | `app.isPackaged` チェックで更新処理をスキップ。開発中に意図しない更新が走らない |

## CI/CD (GitHub Actions) のセキュリティ

| 項目 | 対策 |
|------|------|
| ワークフロートリガ | `v[0-9]+.[0-9]+.[0-9]+` タグ push のみ発火。`check-event` ジョブが正規タグ形式を検証し `validTag` を下流ジョブに伝達 |
| `permissions` | `contents: write` のみ (リリース作成用)。他の権限は付与しない |
| 署名証明書の取り扱い | `MACOS_SIGNING_CERT` は base64 エンコード済み `.p12` を GitHub Secrets に保存。ランナー上で `$RUNNER_TEMP/cert.p12` に復元後、import 完了で即削除 |
| キーチェーン分離 | 証明書は `$RUNNER_TEMP/app-signing.keychain-db` 専用キーチェーンにインポート。パスワードは `openssl rand -hex 32` で生成。`set-keychain-settings -lut 21600` でロック時間を制限。ランナー終了時に破棄 |
| `security set-key-partition-list` | `apple-tool:,apple:` のみを許可。他ツールからのアクセスを遮断 |
| 未設定時のフォールバック | `MACOS_SIGNING_CERT` 未設定時は `Check Signing Secrets` ステップが `signed=false` を出力し、署名関連ステップが skip。`npm run dist:mac:unsigned` で署名・公証なしの DMG を生成しビルドを継続 |
| Apple 公証認証情報 | `MACOS_NOTARIZATION_USERNAME` / `MACOS_NOTARIZATION_PASSWORD` / `MACOS_NOTARIZATION_TEAM_ID` を環境変数経由で `dist:mac` に注入。`.env` ファイルは使用せずランナー環境変数のみ |
| 外部 action のピン留め | `softprops/action-gh-release` はコミット SHA (`9d7c94cfd0a1f3ed45544c887983e9fa900f0564`) で固定。タグ参照ではないため、タグ付け替え攻撃を防止 |
| リリース公開方式 | `draft: true` で常にドラフトとして作成し、手動確認後に公開。誤 push による意図しない公開リリースを防止 |

## 推奨事項

1. CSP ヘッダーを HTML レスポンスに追加して inline script を制限する（現在は単一 HTML のため実質的な影響なし）
2. Windows コード署名 (EV 証明書) を導入する。現在 `signAndEditExecutable: false` で未署名
