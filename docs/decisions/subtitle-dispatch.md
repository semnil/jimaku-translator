# Subtitle dispatch decisions

> 日本語版は [subtitle-dispatch.ja.md](subtitle-dispatch.ja.md) を参照してください.

Closed decisions about how [src/subtitle/manager.ts](../../src/subtitle/manager.ts) sends recognition results to OBS, with the alternatives that were turned down. The behavior itself is in [CLAUDE.md](../../CLAUDE.md) "The subtitle send queue keeps everything FIFO" and "Last Recognition's left sidebar".

## The send queue keeps filling while OBS is disconnected

- **Decision** (2026-05-04): `pendingQueue` works the same whether OBS is connected or not. While OBS is disconnected, `showNow()` skips the call to OBS and still spends `clearDelay` on each entry.
- **Reason**: the requirement is that results sent to OBS are not thinned out, and that each one is sent once its delay has passed. The GUI's Last Recognition is updated when the Whisper response arrives (`processQueue()` in [src/pipeline.ts](../../src/pipeline.ts)), so the results stay visible while OBS is disconnected.
- **Alternatives turned down**: making `show()` do nothing while OBS is disconnected; discarding the old queue on reconnection; discarding results instead of queueing them while OBS is disconnected.

## The displayed event marks a finished handler, not a successful send

- **Decision** (2026-05-04): `showNow()` emits `'displayed'` exactly once from a `try/finally`, in every case: `updateSubtitle()` succeeded, the send was skipped because OBS is disconnected, or `updateSubtitle()` threw.
- **Reason**: the marker in Last Recognition (the green bar) means "the message whose send processing finished", not "the message OBS received". If it moved only on success, an error that keeps happening, such as a wrong text source name, would leave every entry gray and the state unreadable.
- **Alternatives turned down**: emitting `'displayed'` only on success, or only while OBS is connected; adding a field such as `dispatched: boolean` that carries whether the send succeeded.
