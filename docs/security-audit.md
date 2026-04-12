# セキュリティ監査レポート

**対象**: jimaku-translator v1.0.0
**日付**: 2026-04-14
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

23. **低音量入力時の認識精度低下 (S3)**
    - Whisper は学習データ分布に近い -3 〜 -6 dBFS 付近で最も精度が高いが、OBS 側入力レベルが低いと認識品質が劣化
    - `src/audio/level.ts` に `computeRms` / `normalizeToTarget` を追加
    - VAD が emit した発話セグメントを RMS 測定し `audio.normalize_target_dbfs` (デフォルト -6) まで増幅 (最大 +20 dB、減衰なし、INT16 クリップ)
    - RMS ゲート (`audio.rms_gate_db`、デフォルト -60、上限 -30) で VAD 前に足切りを行い、ノイズ誤検出と CPU 負荷を削減
    - 入力は全て内部計算で境界が明確 (Int16 PCM、サンプル数上限、ゲート閾値上限 `-30 dBFS`)。新規攻撃面なし

### 残存リスク (受容)

| リスク | 深刻度 | 理由 |
|--------|--------|------|
| localhost CSRF | LOW | ブラウザからの悪意あるリクエストでローカル設定が変更される可能性。設定変更は即時反映されるが、localhost バインドのため攻撃者は同一マシン上のコード実行が前提 |
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
