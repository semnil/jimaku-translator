# Security audit report

**Target**: jimaku-translator v1.0.9
**Date**: 2026-04-17 (in the "CI/CD (GitHub Actions) security" section, the 3 rows "Workflow triggers", "`permissions`" and "Pinning external actions" were checked on 2026-09-30, and the descriptions of `tag-release.yaml` and `check-event` in the same section were added on 2026-10-20)
**Scope**: HTTP server (`server.ts`), Electron main process (`electron.ts`), Web UI (`ui/index.html`), pipeline (`pipeline.ts`), audio level processing (`audio/level.ts`), Whisper process management (`whisper-process.ts`), Whisper setup (`whisper-setup.ts`), OBS client (`obs/client.ts`), build hook (`build/afterPack.cjs`)

## Overview

jimaku-translator exposes a local HTTP server on `127.0.0.1:9880`. It cannot be reached from external networks (localhost bind). The Electron window runs with `nodeIntegration: false`, `contextIsolation: true`.

## Attack surface

| Attack surface | Risk | Mitigation status |
|--------|--------|----------|
| HTTP server (localhost:9880) | Access from local applications | localhost bind, not exposed externally |
| POST /api/config | Writing the settings file | Input validation + TOML escaping implemented |
| POST /api/capture | Audio capture WAV output | localhost bind, 30-second maximum, with a timeout |
| GET /api/obs/sources | Enumerating OBS text sources | localhost bind, read-only |
| POST /api/whisper/download-binary | Downloading external binaries | Only fixed GitHub Releases URLs. Redirect limit 10. `brew install` on macOS |
| POST /api/whisper/download-model | Downloading external models | Only fixed HuggingFace URLs. Redirect limit 10 |
| whisper-server child process | Binary execution | Only downloaded paths or paths specified in config are executed |
| Homebrew binary detection | Symbolic link substitution | Resolves the link target with `realpathSync` and allows only real files under Cellar |
| Running `brew install` | Package installation through Homebrew | Uses `execFileAsync` with an absolute path (`/opt/homebrew/bin/brew`). Fixed arguments |
| afterPack build hook | Rewriting Info.plist | Calls PlistBuddy with `execFileSync` + an argument array. No shell interpretation |
| VBAN UDP (port 6980) | Receiving malformed packets | The parser validates the header and supports every format |
| POST /api/config → VBAN port change | Rebinding the UDP socket at runtime | Port changes only through the localhost API. Status is reset when binding fails |
| OBS WebSocket | Credentials (password) | Saved in config.local.toml (in .gitignore) |
| Electron window | XSS / code execution | contextIsolation + nodeIntegration disabled |
| SSE stream | download-progress events | No secrets. Only file names and byte counts |

## Issues found and fixes

### Fixed

1. **TOML injection (S2)**
   - String values sent to `POST /api/config` were written to TOML without escaping
   - Added `escapeTomlString()`, which escapes `"`, `\`, `\n`, `\r`

2. **No type validation of JSON input (S2)**
   - `JSON.parse(body) as Config` was only a type assertion with no structural validation
   - Added type checks of every field in `parseConfigInput()`

3. **Unlimited request body size (S3)**
   - `readBody()` accumulated the body in memory without a size limit
   - Added a 64KB limit; the connection is closed when it is exceeded

4. **Insufficient server error handling (S4)**
   - The `EADDRINUSE` error of `server.listen()` was not handled
   - Added error handlers to both `index.ts` and `electron.ts`

5. **getObs() access before initialization (S2)**
   - If `/api/obs/sources` is called before Pipeline.start() completes, the result is undefined
   - Changed the return type of `getObs()` to `ObsClient | null` and added a null guard

6. **captureAudio promise leak (S2)**
   - When the pipeline stops or the VBAN stream disconnects, the capture promise never resolves
   - Added a timeout (2x duration + 5s) and a reject on `stop()`

7. **downloadFile incomplete download (S3)**
   - If the HTTP connection is cut midway, the incomplete file stays on disk as if it were complete
   - Added a comparison of Content-Length with the number of bytes actually downloaded; the file is deleted on mismatch

8. **downloadFile response stream errors not handled (S3)**
   - `res.on('error')` was not registered. Errors did not propagate when the network was cut
   - Added a `res.on('error')` handler that deletes the file + rejects

9. **processQueue state not reset (S3)**
   - `stop()` did not reset `inferring` and `inferQueue`
   - Restarting with stop → start left the inference queue stuck
   - Added the reset to `stop()`

10. **Unbounded growth of logBuffer (S4)**
    - When the pipeline runs for a long time, the log buffer puts pressure on memory
    - Added a 500-entry limit

11. **VAD feedQueue promise chain breaking (S2)**
    - Once `feedInternal` rejected, the feedQueue chain was permanently broken and every later feed() was skipped
    - Absorbs the previous error with `.catch(() => {})` to keep the chain

12. **Checksum not verified on download completion (S3)**
    - There was no way to verify the data integrity of a downloaded file
    - Computes a SHA-256 hash while streaming and saves it in a `.sha256` sidecar file
    - `getInstalledModel` / `getInstalledBinary` treat a missing sidecar as not installed

13. **Duplicate downloads of the same resource (S3)**
    - Downloads of the same model/variant could be started in parallel
    - Tracks resource IDs in the `downloadingResources` Set and rejects with 409

14. **Symbolic link validation in Homebrew binary detection (S3)**
    - `detectHomebrewWhisperServer()` passed through symbolic links with `fs.existsSync()` without validating them
    - An attacker could create a local symbolic link `whisper-server` → a malicious binary
    - Resolves the link target with `fs.realpathSync()` and allows only real files under the Homebrew Cellar (`prefix/Cellar/`)

15. **Command injection prevention in the afterPack build hook (S3)**
    - The PlistBuddy call went through shell interpretation with `execSync` + a template literal
    - Changed to `execFileSync` + an argument array, removing shell interpretation entirely

16. **Preventing loss of inference results from OBS subtitle send errors (S3)**
    - Errors from `subtitle.show()` were caught by the try-catch of `processQueue` and reported as "Inference failed"
    - Keeping the inference result (`lastResult`) succeeded, but an OBS subtitle update failure could not be told apart from an inference failure
    - Handles `subtitle.show()` with its own catch, separating inference errors from OBS errors

17. **Preventing multiple instances (S4)**
    - The Electron app could be launched multiple times, causing port conflicts (9880, 6980) and resource conflicts
    - Prevents multiple instances with `app.requestSingleInstanceLock()`. A second launch focuses the existing window

18. **No automatic reconnection after the first OBS connection fails (S2)**
    - When jimaku-translator was started before OBS Studio, no reconnection was scheduled after the first `connect()` failed
    - Fixed to call `scheduleReconnect()` when `connect()` fails. Moved listener registration into `setupListeners()`, run before the connection attempt

19. **Inconsistent status when rebinding the VBAN port fails (S2)**
    - Changing the port to a port in use in the settings → `stop()` → `start()` fails → `vbanListening` stays `true`
    - `updateVbanConfig` resets `vbanListening` to `false` when the port changes. It recovers on the `listening` event

20. **Unbounded growth of the VAD feedQueue (S2)**
    - Because `vad.feed()` is called fire-and-forget, unprocessed promises piled up without limit when ONNX inference could not keep up with the audio arrival rate
    - Limits the depth to 4 with the `feedQueueDepth` counter and drops new feeds beyond it

21. **Saturation of the VAD LSTM state (S3)**
    - The LSTM hidden state of Silero VAD drifts under long continuous audio input, lowering speech detection accuracy
    - Calls `resetState()` automatically after 30 seconds of continuous non-speech, zeroing the LSTM state

22. **Loss of audio at the start of speech (S3)**
    - VAD decides on speech 50-150ms after the actual start of speech, so onsets such as consonants and breaths were lost, lowering recognition accuracy
    - Keeps a 500ms pre-speech ring buffer (`preSpeechBuffer`) and prepends it when speech is detected. The memory limit is 8000 samples (16KB)

23. **Maximum speech length split not working (S2)**
    - The forced split at the maximum speech length in `processChunk` (`speechSampleCount >= maxSpeechSamples`) was only inside the `prob >= threshold` branch, so when prob collapsed from Silero's vowel saturation and `silenceSamples=0` was pinned by continuationRmsFloor, the speech segment grew without limit and Whisper Dispatch never fired
    - Added `else if (this.speechSampleCount >= maxSpeechSamples) { this.emitSpeech(); }` to the silence branch as well, so the segment is always split at the maximum length regardless of the prob state
    - It did not lead to memory exhaustion (bounded by 16kHz × maxSpeechMs), but removes a DoS-like effect where long segments were sent to whisper-server and delay accumulated

24. **Validation of adaptive gate settings (S4)**
    - Added 4 `audio.adaptive_gate_*` fields (`adaptive_gate_enabled`, `adaptive_gate_margin_db`, `adaptive_gate_window_sec`, `adaptive_gate_max_db`)
    - `validateConfig()` enforces range constraints: `margin_db >= 0`, `window_sec > 0`, `max_db <= -10`, `max_db >= rms_gate_db`
    - Even if invalid values are POSTed from the GUI, validation rejects them before they reach the file write
    - No new attack surface (internal numerical computation only, no external input/output)

25. **Lower recognition accuracy with low-volume input (S3)**
    - Whisper is most accurate around -3 to -6 dBFS, close to its training data distribution, and recognition quality degrades when the input level on the OBS side is low
    - Added `computeRms` / `normalizeToTarget` to `src/audio/level.ts`
    - Measures the RMS of the speech segment emitted by VAD and amplifies it to `audio.normalize_target_dbfs` (default -6) (at most +20 dB, no attenuation, INT16 clipping)
    - The RMS gate (`audio.rms_gate_db`, default -60, upper limit -30) cuts off audio before VAD, reducing false detections from noise and CPU load
    - All inputs are internal computations with clear bounds (Int16 PCM, sample count limit, gate threshold upper limit `-30 dBFS`). No new attack surface

26. **Broken OBS subtitles from line breaks in translation results (S3)**
    - When whisper-server returned translation text containing `\n`, `subtitle.show()` forwarded it to OBS WebSocket as is, and the text source unintentionally showed multiple lines
    - Normalizes by collapsing `[\r\n]+` into a space in two places, before the recognition emit in `pipeline.ts` and at the entry of `show()` in `subtitle/manager.ts` (defense in depth)
    - The cause is non-deterministic output of the upstream model, not injection by a third party. There is no XSS/command injection risk, but it is treated as S3 for UX quality degradation

27. **OBS reconnection failure log spam (S4)**
    - Each time the automatic reconnection in `obs/client.ts` failed, the same error was output to the Log panel in large volume, burying real warnings and reducing observability
    - Suppresses consecutive identical errors in a 60-second window and collapses them into a 1-line summary (`suppressed N similar errors over Ms`) when they recur
    - Suppression matches only on the string key, so different errors (DNS failure → authentication failure, etc.) are reported immediately

28. **Inconsistent CLI/Electron data directories (S2)**
    - Older versions referred to `~/.jimaku-translator/whisper` from the CLI and to `app.getPath('userData')` from Electron, so downloaded models were managed in two places
    - Unified on the OS-standard userData (same as Electron) with `getJimakuDataRoot()`, overridable with the `JIMAKU_DATA_DIR` environment variable
    - On startup, `migrateLegacyDataIfNeeded()` migrates the old path to the new path with a symbolic link (a copy if that fails)
    - Also added the lowercase product name on macOS (`jimaku-translator`) and Windows' `%APPDATA%/jimaku-translator/whisper` as migration candidates

29. **Data integrity corruption from a partial migration copy (S2)**
    - In environments where symbolic links are not possible, if `cpSync` failed midway from a full disk or similar, a partial copy remained in `targetDir`
    - On the next startup, `fs.existsSync(targetDir)` was true so the migration was skipped, and missing models were mistaken for "complete"
    - Copies to a temporary staging dir (`<targetDir>.migrating-<pid>`) → promotes it atomically with `fs.renameSync`, and deletes the staging dir with `fs.rmSync` on failure
    - Not an attack surface, but treated as S2 as a risk of data corruption from a silent failure

30. **Missing final period at the end of VAD speech (S4)**
    - When Silero VAD cut the end of speech as soon as `silenceMs` elapsed, there was not enough trailing silence for Whisper to output the sentence-final period ("。")
    - Adds a 125ms `TAIL_PAD_SAMPLES` to the `silenceMs` decision so that Whisper sees a natural end of sentence
    - No security impact. A UX quality improvement

31. **Shortening long-term VAD LSTM drift (S3)**
    - With a 30-second LSTM automatic reset interval, a case was confirmed where the hidden state became biased after a long continuous stretch without speech, and prob did not rise for the next speech
    - Shortened the reset interval from 30s → 3s (`SILENCE_RESET_SAMPLES = 16000 * 3`)
    - Minor memory/CPU impact (the LSTM has 128 dimensions, and the reset itself is O(1))

32. **CORS wildcard allowed (S3)**
    - Preflights from any origin were accepted with `Access-Control-Allow-Origin: *`
    - A third-party page running on another port on localhost could call the API with a cookie-less fetch
    - Changed to return the origin only when the `Origin` header is `http://127.0.0.1:*` / `http://localhost:*`, and to add no CORS headers otherwise (`src/server.ts`)
    - Electron (`loadURL('http://127.0.0.1:9880/')`) and Playwright (same `baseURL`) are same-origin and unaffected

33. **Zip slip protection in Windows `extractZip` (S2)**
    - `Expand-Archive` does not validate the relative paths of zip entries, so a malicious zip containing `../../` could write outside destDir
    - After extraction, enumerates every entry with `readdirSync(destDir, { recursive: true })`, and if `path.resolve()` is outside the `destDir` prefix, rolls back the whole destDir with `rmSync` + throws
    - The download URLs are hard-coded (GitHub Releases), so the practical risk is low, but this is a precaution for MITM environments and future configuration extensions

34. **PowerShell command injection protection (S2)**
    - `extractZip` interpolated paths into a string in the form `powershell -Command "Expand-Archive -Path ${zipPath} ..."`
    - Changed to `execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', '--', zipPath, destDir])`
    - Switching to `-LiteralPath` also suppresses wildcard expansion such as `[`, `]`, `*`
    - Other shell execution sites (`nvidia-smi`, `brew install`, `dns-sd`, `whisper-server` spawn) already use the argument array form (cross-site check done)

35. **Startup crash when config.local.toml is corrupted (S3)**
    - `smol-toml.parse()` in `loadConfig()` throws on corrupted TOML, but `src/index.ts` / `src/electron.ts` did not catch it and the process exited
    - If a crash happened while the user was editing settings in the GUI, the app could not start the next time and there was no obvious way to recover
    - `src/config.ts` falls back to DEFAULTS + logs with `console.warn` only when parsing `config.local.toml` fails. A failure of the base `config.toml` throws as before
    - Not an attack surface; an availability hardening

36. **-Infinity JSON serialization of `audio.rmsDb` (S4)**
    - `JSON.stringify(Number.NEGATIVE_INFINITY)` returns `null`, so the UI side could not tell `null` from a real "not measured"
    - Changed `src/pipeline.ts` to return `-200` (a finite value) when `lastFrameRmsLinear <= 0`. It can still be read as a number after JSON serialization

37. **Suppressing SSE log replay flooding (S4)**
    - On a new SSE connection, up to 500 entries of `logBuffer` were sent at once, putting pressure on bandwidth with no backpressure on slow connections
    - Changed `src/server.ts` to `getLogBuffer().slice(-100)`. Replays only the latest 100 entries
    - Reduces accumulated memory and bandwidth in environments with frequent reconnects

38. **Web UI accessibility improvements (S4)**
    - Put the following in place toward WCAG 2.1 AA conformance:
      - Touch targets of 32px or more (WCAG 2.5.8)
      - Document structure made explicit with `<main>` / ARIA landmarks (h1 is omitted because it duplicates the window title `<title>`)
      - Changed the collapse toggles to a nested `<h2>/<h3><button>` structure to remove duplicated semantics
      - `role="alert" aria-live="assertive"` on `.toast`, `role="img" aria-label` on `<canvas>`
      - `aria-controls` on `#config-toggle` / `#audio-monitor-toggle` / `#log-toggle`
      - Range sliders sync `aria-valuetext` on `oninput`, and the corresponding value spans have `aria-hidden="true"`
      - `aria-hidden="true"` on every `.indicator` (color-only information is delegated to the adjacent text)
      - The language select is `disabled` + `aria-disabled` together when Closed Caption is off
      - Changed the background color of `.indicator.off` from `#666` → `#888` to secure a 3:1 contrast ratio (WCAG 1.4.11)
      - `html lang` is updated by `applyI18n()` when the language is switched
      - Log error detection changed from English only → `/error|failed|エラー|失敗/i` to support Japanese
      - Fixed the sticky Save/Reload bar covering setting fields: `#config-form { padding-bottom: 72px }` secures scroll room, and the `.actions` background is changed to `rgba(26,26,46,0.92) + backdrop-filter: blur(8px)` (WCAG 2.4.11 Focus Not Obscured)
    - No effect on the attack surface. Treated as S4 as a fix of WCAG violations

### Residual risks (accepted)

| Risk | Severity | Reason |
|--------|--------|------|
| localhost CSRF | LOW | Local settings could be changed by a malicious request from a browser. Setting changes take effect immediately, but with the localhost bind and CORS allowing only `127.0.0.1` / `localhost` origins, cross-origin changes from third-party pages are blocked |
| No authentication on the SSE stream | LOW | Not reachable externally because of the localhost bind. Other processes on the same machine can read it, but it contains no secrets |
| OBS password stored in plain text | LOW | The password is stored in plain text in config.local.toml. Depends on local file access permissions |
| Immediate termination by `process.exit()` | LOW | In-flight Whisper requests are not cancelled. No data loss, but unnecessary network requests may remain |
| Arbitrary binary execution through whisper.binary | LOW | Runs the binary at the path specified in config.toml/GUI with spawn(). Settings cannot be changed from outside because of the localhost bind |
| Trustworthiness of the Homebrew binary | LOW | The legitimacy of `/opt/homebrew/bin/brew` depends on OS file permissions. It cannot be tampered with without local administrator rights |
| Hard-coded download URLs | LOW | Only fixed GitHub/HuggingFace URLs are accessed. URLs cannot be changed by user input |
| Background downloads continue after the SSE client disconnects | LOW | Downloads continue to completion after the UI disconnects. Automatic saving to config works normally, so there is no actual harm |

## Electron security settings

| Setting | Value | Recommendation |
|------|----|----|
| `nodeIntegration` | `false` | OK |
| `contextIsolation` | `true` | OK |
| `webPreferences.sandbox` | Default (`true` in Electron 20+) | OK |
| Menu bar | `autoHideMenuBar: true` | OK |
| External URL navigation | Not restricted (only localhost is loaded) | OK |

## Download feature security

| Item | Measure |
|------|------|
| Download source URLs | Only hard-coded GitHub Releases / HuggingFace URLs |
| Redirects | Limit of 10. Prevents infinite redirect loops |
| Disk write destination | Only under `%APPDATA%/jimaku-translator/whisper/` (Win) / `~/Library/Application Support/jimaku-translator/whisper/` (macOS) |
| Interruption | Can be cancelled immediately with AbortController |
| Incomplete files | Content-Length check, size check (90%), automatic deletion on error |
| Checksums | SHA-256 hash saved in a sidecar. Missing sidecar = incomplete |
| Duplicate downloads | The `downloadingResources` Set rejects parallel downloads of the same resource (409) |
| Cancellation | Can be cancelled immediately with AbortController. Has a Cancel UI button |
| Parallel downloads | Each download has its own ID. Managed in a Map |

## Build hook security

| Item | Measure |
|------|------|
| afterPack (macOS) | Calls PlistBuddy with `execFileSync` + an argument array. No shell interpretation |
| afterPack (Win32) | `rcedit` library API. No command execution |
| asar integrity | Recomputes the SHA-256 hash + 4MB block array in afterPack. Works around the electron-builder timing bug |
| Code signing (macOS) | Signs both the `.app` / `.dmg` with a Developer ID Application certificate. Hardened runtime enabled, entitlements are least privilege (network client/server only) |
| Notarization (macOS) | electron-builder `notarize: true` notarizes and staples the `.app` automatically. The DMG goes through sign → notarytool submit --wait → stapler → spctl verification in `build/notarize-dmg.cjs`. Apple credentials are injected from `.env` through `node --env-file-if-exists` (in .gitignore) |

## Auto-update (electron-updater) security

| Item | Measure |
|------|------|
| Distribution source | `publish.provider: github` refers only to the Releases of `semnil/jimaku-translator`. Arbitrary URLs cannot be specified |
| Tamper detection | `latest.yml` / `latest-mac.yml` record the SHA-512 hash and file size. electron-updater verifies them after downloading |
| Differential updates | Block-level differential download with `.blockmap`. The same SHA-512 verification is run on the final artifact after the difference is applied |
| macOS | Only signed `.app` can be installed and updated. Gatekeeper + notarization reject tampered updates. The auto-update path is disabled for unsigned builds |
| Windows | NSIS signing is not set up, so auto-update itself works, but SmartScreen warnings remain |
| Draft releases | electron-updater does not detect drafts. Nothing is delivered until it is published manually, so there is no risk of an accidentally created draft being delivered automatically |
| dev environment | The `app.isPackaged` check skips update processing. No unintended updates run during development |

## CI/CD (GitHub Actions) security

The 3 rows "Workflow triggers", "`permissions`" and "Pinning external actions" were checked on 2026-09-30 against the actual workflows and the current values of main's ruleset and the Actions allow policy. Of these, the descriptions of `tag-release.yaml` and of `check-event` in `release.yaml`, and the "Tag creation from version bumps" row, were checked on 2026-10-20 against the actual workflows. The "Dependabot auto-merge" row, and in the other rows the descriptions of `dependabot-auto-merge.yml` and of the required checks `Test 🧪` and `auto-merge`, were added on 2026-10-20. The other rows are descriptions from the 2026-04-17 audit and outside this check.

| Item | Measure |
|------|------|
| Workflow triggers | `ci.yaml`: push to main, PRs targeting main, manual (`workflow_dispatch`). `tag-release.yaml`: completion of `ci.yaml` (`workflow_run`, main only). `release.yaml`: pushes of `v[0-9]+.[0-9]+.[0-9]+` / `v[0-9]+.[0-9]+.[0-9]+-*` tags and manual. Only when the ref is a tag (a tag push, and a `workflow_dispatch` on a tag by `tag-release.yaml`), the `check-event` job validates the canonical tag shape (`vx.y.z` and `vx.y.z-(beta\|rc\|alpha)…`) with `build/release-tag.cjs` and outputs `validTag`, and `create-release` runs only when `validTag == 'true'` (a manual run on a branch and a malformed tag only go as far as the build and create no release; when the check script did not run, `check-event` fails). `workflow-checks.yml`: every PR (`pull_request_target`, run with the default branch's definition). `workflow-checks-test.yml`: PRs that change the check file or its tests, pushes to main / master that change the same files, manual. `dependabot-auto-merge.yml`: every PR (`pull_request`, no filter) |
| `permissions` | Specified per workflow; the only job-level override is the `auto-merge` job in `dependabot-auto-merge.yml` (`contents: write` and `pull-requests: write`, for scheduling and cancelling auto-merge). `ci.yaml` / `workflow-checks.yml` / `workflow-checks-test.yml` / `dependabot-auto-merge.yml` (workflow level) have `contents: read`, `release.yaml` has `contents: write` (for creating the draft release), and `tag-release.yaml` has `contents: write` (pushing the tag) and `actions: write` (dispatching `release.yaml`). No other permissions are granted |
| Handling the signing certificate | `MACOS_SIGNING_CERT` stores the base64-encoded `.p12` in GitHub Secrets. It is restored to `$RUNNER_TEMP/cert.p12` on the runner and deleted immediately after the import completes |
| Keychain isolation | The certificate is imported into the dedicated keychain `$RUNNER_TEMP/app-signing.keychain-db`. The password is generated with `openssl rand -hex 32`. `set-keychain-settings -lut 21600` limits the lock time. Discarded when the runner finishes |
| `security set-key-partition-list` | Allows only `apple-tool:,apple:`. Blocks access from other tools |
| Fallback when not configured | When `MACOS_SIGNING_CERT` is not set, the `Check Signing Secrets` step outputs `signed=false` and the signing-related steps are skipped. `npm run dist:mac:unsigned` produces a DMG without signing or notarization and the build continues |
| Apple notarization credentials | `MACOS_NOTARIZATION_USERNAME` / `MACOS_NOTARIZATION_PASSWORD` / `MACOS_NOTARIZATION_TEAM_ID` are injected into `dist:mac` through environment variables. No `.env` file is used; only runner environment variables |
| Pinning external actions | The `uses:` in `ci.yaml` / `release.yaml` / `tag-release.yaml` / `workflow-checks-test.yml` / `dependabot-auto-merge.yml` are pinned with a commit SHA + version comment (`@<sha> # vX.Y.Z`). They are not tag references, which prevents tag-moving attacks. `workflow-checks.yml` (main's required check `action-pins`; requires branches to be up to date with the base branch, no bypass) checks this form on every PR (it uses the default branch's definition through `pull_request_target`, and only fetches the PR's workflow and action files as data through the API and reads them with yq; the PR's code is neither checked out nor executed). Actions in the same repository must be referenced with `$/` in steps (a step's `./` is rejected because it resolves against the runner's workspace), alternative spellings of local reference paths and symbolic links / submodules on the path to the target are rejected, and PRs in which the check file itself does not match the default branch fail. The check's regression test is `.github/tests/workflow-checks-test.sh` (run by `workflow-checks-test.yml`). `pull_request_target` is allowed by an Actions allow policy that targets `workflow-checks.yml` |
| Release publication method | Always created as a draft with `draft: true` and published after manual review. Prevents unintended public releases from a mistaken push |
| Tag creation from version bumps (`tag-release.yaml`, added 2026-10-20) | Runs after CI completes through `workflow_run` and handles only runs that succeeded on a `push` to main. What it checks out is the `head_sha` that CI checked. The version to tag is decided by `build/release-tag.cjs`, which compares `version` in `package.json` with the first parent, and a malformed version fails before the tag is pushed. Existing remote tags are not moved, and it fails if a tag with the same name points to a different commit |
| Dependabot auto-merge (`dependabot-auto-merge.yml`, added 2026-10-20) | Runs on every PR with `pull_request`, and runs the `dependabot/fetch-metadata` and `gh` steps only when the PR's author is `dependabot[bot]` (on other PRs the steps are skipped and the job reports success). The PR's code is neither checked out nor executed, and values from the PR (URL, head SHA, update type) are passed through environment variables. Only when the update type is a semver patch does it schedule auto-merge (merge commit) conditioned on the head SHA it read (`--match-head-commit`); for other types it cancels the scheduling, and when it cannot read whether auto-merge is scheduled, the job fails. The job `auto-merge` is a required check on main (along with `action-pins` and `Test 🧪`), so nothing is merged before a judgment for its head comes out. The token used is `GITHUB_TOKEN` (no secrets are used). Merges by auto-merge are made with `GITHUB_TOKEN`, so the push to main does not trigger workflows (neither `ci.yaml` nor `tag-release.yaml`, which starts from its completion, runs) |

## Recommendations

1. Add a CSP header to HTML responses to restrict inline scripts (no practical effect at present, since it is a single HTML file)
2. Introduce Windows code signing (an EV certificate). Currently unsigned with `signAndEditExecutable: false`
