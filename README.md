# jimaku-translator

OBS リアルタイム字幕システム。VBAN 経由で OBS の音声を受信し、Whisper で日本語認識 + 英語翻訳を行い、OBS のテキストソースに字幕を表示する。GUI でステータス表示・設定変更が可能。

## 必要なもの

### OBS PC

- OBS Studio 28 以上
- [obs-vban](https://github.com/norihiro/obs-vban/releases) プラグイン

### 字幕 PC (macOS / Windows)

- jimaku-translator (インストーラーから導入)
- OBS PC と別マシンでも、同じ PC で同時に動かしてもよい

## セットアップ

### 1. OBS PC 側

1. obs-vban をインストール
2. 字幕対象の音声ソース（マイク等）のフィルターを開く
3. 「VBAN Audio Output」を追加し、以下を設定:
   - **IP Address To**: 字幕 PC の IP アドレス (同一 PC で動作させる場合は `127.0.0.1`)
   - **Port**: `6980`
   - **Stream Name**: 任意 (例: `subtitle`)。空でも動作する (字幕 PC 側で未指定なら全ストリームを受信)
   - **Format**: 16-bit integer
4. ノイズ除去フィルターの **後** に配置する（クリーンな音声を送るため）
5. テキスト (GDI+) ソースを 2 つ作成。名前は任意 (例: `subtitle_ja`, `subtitle_en`) で、字幕 PC 側の GUI からドロップダウンで選択する

### 2. 字幕 PC 側

macOS のみ、事前に Homebrew が必要。未インストールの場合は https://brew.sh から先にインストールする (Windows は不要)。

1. インストーラーから jimaku-translator をインストールして起動
2. 設定フォームの **Whisper** セクションで:
   - **バイナリ**: 自分の環境に合うバリアントを選び「ダウンロード」(macOS は `brew install whisper-cpp` が自動実行される。Windows は CPU / CUDA から選択)
   - **モデル**: 用途に合うモデルを選び「ダウンロード」(推奨: `large-v3-turbo-q5_0` は高速、`large-v3` は高精度で翻訳対応)
3. **OBS WebSocket** セクションで接続先ホスト/ポート/パスワードを入力し「再接続」
4. **日本語テキストソース** / **英語テキストソース** のドロップダウンで OBS 側に作成したテキストソースを選択
5. 「保存」を押して設定を保存。変更は即時反映される (Whisper のバイナリ/モデル変更のみ再起動が必要)

## GUI

起動するとステータスパネル・設定フォーム・ログを表示するウィンドウが開く。

- **ステータスパネル**: 入力受信状態、OBS 接続状態、Whisper サーバー状態をリアルタイム表示
- **認識結果**: 直近の日本語認識・英語翻訳を表示
- **設定フォーム**: 全設定項目を GUI で編集し `config.local.toml` に保存。保存時に即時反映される (Whisper のバイナリ/モデル変更のみ再起動が必要)。OBS テキストソースはドロップダウンで候補を選択可能。Whisper のバイナリ/モデルはドロップダウンから選択してワンクリックでダウンロード可能
- **入力レベルメーター**: 入力音声の RMS レベルをリアルタイム表示 (dBFS)。RMS ゲート閾値との直接比較が可能
- **音声キャプチャ**: Capture 5s WAV ボタンで 16kHz mono WAV をダウンロード
- **ログ**: パイプラインのログをリアルタイム表示

CLI モードでも `http://127.0.0.1:9880/` でブラウザから同じ GUI にアクセスできる。

## 動作の流れ

```
OBS マイク → obs-vban フィルター → VBAN (UDP) → jimaku-translator
  → ダウンミックス (stereo→mono)
  → リサンプル (48kHz→16kHz)
  → RMS ゲート (閾値未満はスキップして VAD 誤検出とCPU負荷を抑制)
  → Silero VAD (発話区間検出、500ms の pre-speech padding で立ち上がり補完)
  → 発話セグメント正規化 (RMS を -6 dBFS に増幅、+20 dB キャップ)
  → whisper.cpp server (認識: JA + 翻訳: EN を逐次実行)
    (binary 設定時はアプリが whisper-server を自動起動/停止)
  → OBS WebSocket → テキストソース更新
  → 設定秒数後に自動クリア (デフォルト 6 秒)
```

## データ保存先

Electron アプリはユーザーデータディレクトリにランタイムデータを保存する。

### Windows

| データ | パス |
|--------|------|
| ローカル設定 | `%APPDATA%/jimaku-translator/config.local.toml` |
| ウインドウ状態 | `%APPDATA%/jimaku-translator/window-state.json` |
| Whisper バイナリ | `%APPDATA%/jimaku-translator/whisper/bin/<variant>/Release/` |
| Whisper モデル | `%APPDATA%/jimaku-translator/whisper/models/` |
| チェックサム | `%APPDATA%/jimaku-translator/whisper/models/*.sha256` |

### macOS

| データ | パス |
|--------|------|
| ローカル設定 | `~/Library/Application Support/jimaku-translator/config.local.toml` |
| ウインドウ状態 | `~/Library/Application Support/jimaku-translator/window-state.json` |
| Whisper バイナリ | `/opt/homebrew/bin/whisper-server` (Homebrew 管理) |
| Whisper モデル | `~/Library/Application Support/jimaku-translator/whisper/models/` |
| チェックサム | `~/Library/Application Support/jimaku-translator/whisper/models/*.sha256` |

環境変数 `VBAN_WHISPER_DIR` で Whisper データディレクトリを上書き可能。CLI モードでは `config.local.toml` は `config.toml` と同じディレクトリに保存される。

## 設定 (config.toml)

通常は GUI から設定するため手動編集は不要。参考として全項目を掲載する。

```toml
[vban]
port = 6980
stream_name = ""            # 任意。空文字 = 全ストリーム受信

[obs]
host = "127.0.0.1"          # OBS PC の IP
port = 4455
password = ""               # OBS WebSocket パスワード
source_ja = ""              # 日本語字幕テキストソース名 (空 = 無効)
source_en = ""              # 英語字幕テキストソース名 (空 = 無効)
closed_caption = false      # 配信ストリームに CC を埋め込む
cc_language = "en"          # CC の言語 ("en" or "ja")

[whisper]
server = "http://127.0.0.1:8080"  # managed process 使用時は自動割り当て
binary = ""                     # whisper-server バイナリパス (空 = 手動管理)
model = ""                      # GGML モデルパス (binary 設定時は必須)
binary_variant = ""             # GUI で選択したバリアント ID (自動解決用)
model_name = ""                 # GUI で選択したモデル ID (自動解決用)

[subtitle]
clear_delay = 6.0           # 字幕クリアまでの秒数
chars_per_line = 0          # 1 行の文字数 (0 = 改行しない、OBS 側で折り返し)

[vad]
threshold = 0.5             # 発話検出閾値 (0-1)
min_speech_ms = 500         # 最小発話長 (ms)
max_speech_ms = 10000       # 最大チャンク長 (ms)

[audio]
rms_gate_db = -60           # RMS ゲート (dBFS)。これ未満は VAD に渡さない。範囲 -90 〜 -30
normalize_target_dbfs = -6  # 発話セグメントを正規化する目標 RMS (dBFS)。0 = 無効、GUI 非表示

[ui]
language = ""               # "" = システム言語を自動判定、"en" または "ja" で固定
```

## トラブルシューティング

### VBAN パケットが届かない
- ファイアウォールで UDP 6980 を許可しているか確認
- OBS 側の VBAN Output Filter の IP アドレスが正しいか確認
- 同一サブネットであることを確認

### OBS WebSocket に接続できない
- OBS 側で WebSocket サーバーが有効か確認（ツール → WebSocket サーバー設定）
- ファイアウォールで TCP 4455 を許可
- パスワードが正しいか確認

### Whisper の認識が遅い
- `large-v3` モデルは M5 Mac で 1-3 秒程度のレイテンシ
- 速度が必要な場合は `large-v3-turbo-q5_0` (574 MB) に変更
- 日本語特化: `kotoba-bilingual-q5_0` (538 MB, 翻訳対応) または `kotoba-v2.2-q5_0` (538 MB, JA のみ)
- Windows: CUDA 対応 GPU がある場合は GUI の Whisper セクションから CUDA バリアントをダウンロード
- macOS: Homebrew 版は Core ML / Metal で自動的に GPU アクセラレーションが有効

### 翻訳が空になる / 英語に翻訳されない
- `large-v3-turbo` 系、`kotoba` 系、`anime-whisper` は翻訳非対応 (distil-whisper ベースで翻訳タスク未保持)
- 翻訳が必要な場合は `large-v3`, `medium`, `small`, `base` 等のオリジナル Whisper モデルを使用

### 推論キューが溜まる
- ログに `[Queue] Dropped segment` が出る場合、Whisper の処理が追いついていない
- モデルサイズを下げるか、「最長発話 (ms)」を短くして推論単位を小さくする

### 認識精度が悪い
- 入力レベルメーターで dBFS を確認。-30 dBFS より低い場合、OBS 側のマイク音量を上げる
- RMS ゲート (dBFS) を低めに設定すると微小音声も拾う (ただしノイズ誤検出が増える)
- 発話先頭が欠ける場合は Silero VAD の `しきい値` を下げる (0.3 程度)。ただし false positive 増加
- ノイズが多い環境では OBS 側のノイズ除去フィルターを VBAN Output フィルターより前に配置
- VAD が speech を emit した後は自動で -6 dBFS まで正規化して Whisper に送られるため、ゲイン調整は不要 (正規化ターゲットは `config.local.toml` の `[audio] normalize_target_dbfs` で調整可能)

## 開発

```bash
npm test              # vitest ユニットテスト
npm run test:e2e      # Playwright E2E テスト
npm run test:watch    # ウォッチモード
npm run build         # TypeScript ビルド
npm run dist:win      # Windows インストーラー生成
npm run dist:mac      # macOS ディスクイメージ生成 (署名 + 公証)
```

### macOS 署名・公証

`npm run dist:mac` は Developer ID Application 証明書で `.app` と `.dmg` の両方に署名し、Apple notarytool で公証・staple まで自動実行する。認証情報は `.env` から読み込む (Node の `--env-file-if-exists` を使用):

```bash
cp .env.example .env
# APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID を設定
npm run dist:mac
```

App 用パスワードは https://appleid.apple.com/ で発行する。electron-builder が `.app` を公証した後、[build/notarize-dmg.cjs](build/notarize-dmg.cjs) が DMG の sign → notarytool submit → stapler → spctl 検証を実施する。

### GitHub Actions CI/CD

`v*.*.*` 形式のタグを push すると [.github/workflows/release.yaml](.github/workflows/release.yaml) が発火し、Windows + macOS ビルドを実行してドラフトリリースを作成する。リリースノートは GitHub 自動生成 (`generate_release_notes: true`) で、前回のタグからの PR/コミットが列挙される。

macOS 署名・公証には以下の GitHub Secrets が必要 (未設定でもビルドは継続し、署名・公証なしの DMG が生成される):

| Secret 名 | 用途 |
|---|---|
| `MACOS_SIGNING_CERT` | Developer ID Application 証明書 (base64 エンコードした `.p12`) |
| `MACOS_SIGNING_CERT_PASSWORD` | `.p12` のパスワード |
| `MACOS_NOTARIZATION_USERNAME` | Apple ID (メールアドレス) |
| `MACOS_NOTARIZATION_PASSWORD` | App 用パスワード |
| `MACOS_NOTARIZATION_TEAM_ID` | Apple Developer Team ID |

`.p12` を base64 化する例:
```bash
base64 -i cert.p12 -o cert.p12.b64  # macOS
gh secret set MACOS_SIGNING_CERT < cert.p12.b64
```

macOS ランナー上では証明書を `$RUNNER_TEMP` 配下の永続キーチェーンにインポートしてから `dist:mac` を実行する。これは electron-builder の `CSC_LINK` 経路が使う一時キーチェーンが署名後に破棄され、後段の `notarize-dmg.cjs` で identity を見失う問題を回避するため。

Windows 側は現状コード署名未設定のため、追加の Secret は不要。

## ライセンス

MIT
