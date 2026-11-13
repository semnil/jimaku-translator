# 字幕の送信の決定

> For the English version, see [subtitle-dispatch.md](subtitle-dispatch.md).

[src/subtitle/manager.ts](../../src/subtitle/manager.ts) が認識結果を OBS へ送る方法について閉じた判断と、却下した案を持つ。挙動そのものは [AGENTS.md](../../AGENTS.md) の「The subtitle send queue keeps everything FIFO」と「Last Recognition's left sidebar」にある。

## 送信のキューは OBS の切断中も積み続ける

- **決定** (2026-05-04): `pendingQueue` は、OBS がつながっていてもいなくても同じように動く。OBS の切断中は、`showNow()` が OBS への呼び出しを飛ばし、1 件ごとに `clearDelay` を使う。
- **理由**: 求められているのは、OBS へ送る結果を間引かないことと、それぞれを遅延の経過後に送ること。GUI の Last Recognition は Whisper の応答が届いた時点で更新される ([src/pipeline.ts](../../src/pipeline.ts) の `processQueue()`) ので、OBS の切断中も結果は見える。
- **却下した案**: OBS の切断中は `show()` を何もしない処理にする。再接続のときに古いキューを捨てる。OBS の切断中はキューに積まずに捨てる。

## displayed イベントは、送信の成功ではなく、ハンドラの完了の印

- **決定** (2026-05-04): `showNow()` は `try/finally` から `'displayed'` をちょうど 1 回出す。`updateSubtitle()` が成功したとき、OBS の切断で送信を飛ばしたとき、`updateSubtitle()` が throw したときのどれでも出す。
- **理由**: Last Recognition の印 (緑のバー) の意味は「送信の処理が終わったメッセージ」で、「OBS が受け取ったメッセージ」ではない。成功のときだけ進めると、テキストソースの名前の間違いのように続くエラーの間、どの行も灰色のままになり、状態が読めなくなる。
- **却下した案**: `'displayed'` を、成功のときだけ、または OBS の接続中だけ出す。送信が成功したかを持つ `dispatched: boolean` のようなフィールドを足す。
