# jimaku-translator

A real-time subtitle system for OBS. It receives OBS audio over VBAN, runs Japanese recognition + English translation with Whisper, and shows the subtitles in OBS text sources. A GUI shows the status and lets you change the settings.

> 日本語版は [README.ja.md](README.ja.md) を参照してください.

## Requirements

### OBS PC

- OBS Studio 28 or later
- The [obs-vban](https://github.com/norihiro/obs-vban/releases) plugin

### Subtitle PC (macOS / Windows)

- jimaku-translator (installed from the installer)
- It can be a different machine from the OBS PC, or run on the same PC at the same time

## Setup

### 1. On the OBS PC

1. Install obs-vban
2. Open the filters of the audio source to subtitle (a microphone, etc.)
3. Add "VBAN Audio Output" and set the following:
   - **IP Address To**: the IP address of the subtitle PC (`127.0.0.1` when running on the same PC)
   - **Port**: `6980`
   - **Stream Name**: any (e.g. `subtitle`). It also works when empty (if the subtitle PC does not specify one, it receives all streams)
   - **Format**: 16-bit integer
4. Place it **after** the noise suppression filter (so that clean audio is sent)
5. Create 2 Text (GDI+) sources. The names are up to you (e.g. `subtitle_ja`, `subtitle_en`); you select them from drop-downs in the GUI on the subtitle PC

### 2. On the subtitle PC

On macOS only, Homebrew is required beforehand. If it is not installed, install it first from https://brew.sh (not needed on Windows).

1. Install jimaku-translator from the installer and launch it
2. In the **Whisper** section of the settings form:
   - **Binary**: choose the variant that fits your environment and click "Download" (on macOS, `brew install whisper-cpp` runs automatically; on Windows, choose from CPU / CUDA)
   - **Model**: choose a model that fits your use and click "Download" (recommended: `large-v3-turbo-q5_0` is fast; `large-v3` is accurate and supports translation)
3. In the **OBS WebSocket** section, enter the host / port / password to connect to and click "Reconnect"
4. In the **Japanese Text Source** / **English Text Source** drop-downs, select the text sources you created in OBS
5. Click "Save" to save the settings. Changes take effect immediately (only changing the Whisper binary / model needs a restart)

## GUI

On launch, a window opens showing the status panel, the settings form, and the log.

- **Status panel**: shows the input reception status, the OBS connection status (while sending to OBS is held back by `clearDelay`, "Send pending: N" is shown next to it), and the Whisper server status in real time
- **Recognition result**: shows the latest Japanese recognition and English translation. It updates when the result arrives from Whisper, so you can see recognition results even while OBS is disconnected or sending to OBS is delayed by `clearDelay`. The green left sidebar is on **the single message whose send processing finished most recently** (including success, failure, and skipping while OBS is disconnected), and moves each time the queue advances
- **Settings form**: edit every setting in the GUI and save it to `config.local.toml`. Changes take effect on save (only changing the Whisper binary / model needs a restart). OBS text sources can be picked from the candidates in a drop-down. The Whisper binary / model can be selected from a drop-down and downloaded in one click
- **Input level meter**: shows the RMS level of the input audio in real time (dBFS). It can be compared directly with the RMS gate threshold
- **Audio capture**: the Capture 5s WAV button downloads a 16kHz mono WAV
- **Log**: shows the pipeline log in real time

In CLI mode, the same GUI is available from a browser at `http://127.0.0.1:9880/`.

## How it works

```
OBS microphone → obs-vban filter → VBAN (UDP) → jimaku-translator
  → downmix (stereo→mono)
  → resample (48kHz→16kHz)
  → RMS gate (skips audio below the threshold to reduce VAD false detections and CPU load)
  → Silero VAD (speech segment detection; 500ms of pre-speech padding fills in the onset)
  → speech segment normalization (amplifies RMS to -6 dBFS, +20 dB cap)
  → whisper.cpp server (recognition: JA + translation: EN, run sequentially)
    (when binary is set, the app starts/stops whisper-server automatically)
  → OBS WebSocket → text source update
  → automatic clear after the configured number of seconds (default 6 seconds)
```

## Where data is stored

The Electron app stores runtime data in the user data directory.

### Windows

| Data | Path |
|--------|------|
| Local settings | `%APPDATA%/jimaku-translator/config.local.toml` |
| Window state | `%APPDATA%/jimaku-translator/window-state.json` |
| Whisper binary | `%APPDATA%/jimaku-translator/whisper/bin/<variant>/Release/` |
| Whisper models | `%APPDATA%/jimaku-translator/whisper/models/` |
| Checksums | `%APPDATA%/jimaku-translator/whisper/models/*.sha256` |

### macOS

| Data | Path |
|--------|------|
| Local settings | `~/Library/Application Support/jimaku-translator/config.local.toml` |
| Window state | `~/Library/Application Support/jimaku-translator/window-state.json` |
| Whisper binary | `/opt/homebrew/bin/whisper-server` (managed by Homebrew) |
| Whisper models | `~/Library/Application Support/jimaku-translator/whisper/models/` |
| Checksums | `~/Library/Application Support/jimaku-translator/whisper/models/*.sha256` |

The environment variable `VBAN_WHISPER_DIR` overrides the Whisper data directory. In CLI mode, `config.local.toml` is saved in the same directory as `config.toml`.

## Settings (config.toml)

Settings are normally made from the GUI, so manual editing is not needed. All items are listed here for reference.

```toml
[vban]
port = 6980
stream_name = ""            # Optional. Empty string = receive all streams

[obs]
host = "127.0.0.1"          # IP of the OBS PC
port = 4455
password = ""               # OBS WebSocket password
source_ja = ""              # Japanese subtitle text source name (empty = disabled)
source_en = ""              # English subtitle text source name (empty = disabled)
closed_caption = false      # Embed CC in the broadcast stream
cc_language = "en"          # CC language ("en" or "ja")

[whisper]
server = "http://127.0.0.1:8080"  # Assigned automatically when the managed process is used
binary = ""                     # whisper-server binary path (empty = managed manually)
model = ""                      # GGML model path (required when binary is set)
binary_variant = ""             # Variant ID selected in the GUI (for automatic resolution)
model_name = ""                 # Model ID selected in the GUI (for automatic resolution)
# threads = 4                   # whisper-server --threads (automatic when omitted: macOS/GPU=4, CPU=logical cores/2)

[subtitle]
clear_delay = 6.0           # Seconds until the subtitle is cleared
chars_per_line = 0          # Characters per line (0 = no line breaks; OBS wraps the text)

[vad]
threshold = 0.5             # Speech detection threshold (0-1)
min_speech_ms = 500         # Minimum speech length (ms)
max_speech_ms = 10000       # Maximum chunk length (ms)

[audio]
rms_gate_db = -60           # RMS gate (dBFS). Audio below this is not passed to VAD. Range -90 to -30
normalize_target_dbfs = -6  # Target RMS (dBFS) for normalizing speech segments. 0 = disabled; hidden in the GUI

[ui]
language = ""               # "" = detect the system language automatically; "en" or "ja" to fix it
```

## Troubleshooting

### VBAN packets do not arrive
- Check that UDP 6980 is allowed in the firewall
- Check that the IP address in the VBAN Output Filter on the OBS side is correct
- Check that both machines are on the same subnet

### Cannot connect to OBS WebSocket
- Check that the WebSocket server is enabled in OBS (Tools → WebSocket Server Settings)
- Allow TCP 4455 in the firewall
- Check that the password is correct

### Whisper recognition is slow
- The `large-v3` model has a latency of about 1-3 seconds on an M5 Mac
- If you need speed, switch to `large-v3-turbo-q5_0` (574 MB)
- Specialized for Japanese: `kotoba-bilingual-q5_0` (538 MB, supports translation) or `kotoba-v2.2-q5_0` (538 MB, JA only)
- Windows: if you have a CUDA-capable GPU, download the CUDA variant from the Whisper section of the GUI
- macOS: the Homebrew build enables GPU acceleration automatically with Core ML / Metal

### The translation is empty / not translated into English
- The `large-v3-turbo` family, the `kotoba` family, and `anime-whisper` do not support translation (they are based on distil-whisper and do not keep the translation task)
- If you need translation, use an original Whisper model such as `large-v3`, `medium`, `small`, or `base`

### The inference queue builds up
- If `[Queue] Dropped segment` appears in the log, Whisper processing is not keeping up
- Use a smaller model, or shorten "Max Speech (ms)" to make the inference unit smaller

### Recognition accuracy is poor
- Check the dBFS on the input level meter. If it is lower than -30 dBFS, raise the microphone volume on the OBS side
- Setting the RMS Gate (dBFS) lower picks up quieter speech (but increases false detections from noise)
- If the start of speech is cut off, lower the Silero VAD `Threshold` (to about 0.3). False positives increase, though
- In internal quality checks, the `medium` model is practically sufficient for both Japanese recognition and English translation. Whether moving up to `large-v3` is needed depends on the use (consider it only when the accuracy of proper nouns has top priority, such as for broadcasting or streaming)
- In a noisy environment, place the noise suppression filter on the OBS side before the VBAN Output filter
- After VAD emits speech, it is automatically normalized to -6 dBFS before being sent to Whisper, so no gain adjustment is needed (the normalization target can be adjusted with `[audio] normalize_target_dbfs` in `config.local.toml`)

## Development

```bash
npm test              # vitest unit tests
npm run test:e2e      # Playwright E2E tests
npm run test:watch    # watch mode
npm run build         # TypeScript build
npm run dist:win      # build the Windows installer
npm run dist:mac      # build the macOS disk image (signing + notarization)
```

### macOS signing and notarization

`npm run dist:mac` signs both the `.app` and the `.dmg` with a Developer ID Application certificate and automatically runs notarization and stapling with Apple notarytool. Credentials are read from `.env` (using Node's `--env-file-if-exists`):

```bash
cp .env.example .env
# Set APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
npm run dist:mac
```

The app-specific password is issued at https://appleid.apple.com/. After electron-builder notarizes the `.app`, [build/notarize-dmg.cjs](build/notarize-dmg.cjs) runs sign → notarytool submit → stapler → spctl verification on the DMG.

### GitHub Actions CI/CD

A release starts with merging a version-bump PR (a PR that changes only the version in `package.json` and `package-lock.json`). When CI ([.github/workflows/ci.yaml](.github/workflows/ci.yaml)) run by the push to main succeeds, [.github/workflows/tag-release.yaml](.github/workflows/tag-release.yaml) tags the merge commit with `vX.Y.Z` and triggers [.github/workflows/release.yaml](.github/workflows/release.yaml) on that tag. `release.yaml` runs the Windows + macOS builds and creates a draft release. A push that does not change the version creates no tag, and when a tag with the same name already exists, the tag is not moved. Pushing a `v*.*.*` tag by hand also triggers `release.yaml`. The release notes are generated automatically by GitHub (`generate_release_notes: true`) and list the PRs/commits since the previous tag.

Dependabot PRs whose update is a semver patch or minor, and that are one verified commit by Dependabot, are merged automatically once main's required checks (`action-pins`, `Test 🧪`, `auto-merge`) pass ([.github/workflows/dependabot-auto-merge.yml](.github/workflows/dependabot-auto-merge.yml)). Other updates are merged by a person. Merges by auto-merge do not trigger workflows with the push to main.

macOS signing and notarization need the following GitHub Secrets (the build continues without them and produces a DMG without signing or notarization):

| Secret name | Purpose |
|---|---|
| `MACOS_SIGNING_CERT` | Developer ID Application certificate (base64-encoded `.p12`) |
| `MACOS_SIGNING_CERT_PASSWORD` | Password of the `.p12` |
| `MACOS_NOTARIZATION_USERNAME` | Apple ID (email address) |
| `MACOS_NOTARIZATION_PASSWORD` | App-specific password |
| `MACOS_NOTARIZATION_TEAM_ID` | Apple Developer Team ID |

Example of base64-encoding the `.p12`:
```bash
base64 -i cert.p12 -o cert.p12.b64  # macOS
gh secret set MACOS_SIGNING_CERT < cert.p12.b64
```

On the macOS runner, the certificate is imported into a persistent keychain under `$RUNNER_TEMP` before `dist:mac` runs. This avoids the problem where the temporary keychain used by electron-builder's `CSC_LINK` path is discarded after signing and the later `notarize-dmg.cjs` loses the identity.

Code signing is not set up on Windows at present, so no additional Secret is needed.

### Auto-update

The packaged app checks GitHub Releases for a new version on launch, downloads the difference, and applies it automatically when the app quits ([electron-updater](https://www.electron.build/auto-update)). In development mode (`npm run electron`), auto-update is skipped.

**Publishing a release**: the workflow creates a draft release, but electron-updater does not detect drafts. Only after merging the version-bump PR → `release.yaml` finishing, and publishing the release manually on GitHub, is the update delivered to installed clients.

**macOS limitation**: auto-update works only with signed builds. If an unsigned DMG is installed, Gatekeeper rejects the difference at the verification stage of auto-update, so updates must be done manually.

## License

MIT
