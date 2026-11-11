# UI decisions

> 日本語版は [ui.ja.md](ui.ja.md) を参照してください.

Closed decisions about the GUI ([src/ui/index.html](../../src/ui/index.html)), with the alternatives that were turned down.

## Toasts sit at the top center

- **Decision** (2026-05-04): the toast that reports the result of a save, success or error, is fixed at the top center of the window (`.toast`: `position: fixed; top: 20px; left: 50%`), in front of everything else (`z-index: 10000`), with a shadow and a slide-down animation.
- **Reason**: beside the Save button at the bottom edge of the window, the toast is easy to miss.
- **Alternatives turned down**: the bottom or the bottom-right corner, where the toast was before; an inline message directly under the Save button, which puts the notice next to the button again.
