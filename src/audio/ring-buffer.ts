/**
 * Ring buffer for INT16 PCM samples.
 * Supports writing incoming chunks and reading contiguous regions.
 */
export class RingBuffer {
  private buf: Int16Array;
  private writePos = 0;
  private available = 0;

  /** @param capacity Max number of samples to hold. */
  constructor(capacity: number) {
    this.buf = new Int16Array(capacity);
  }

  get length(): number {
    return this.available;
  }

  get capacity(): number {
    return this.buf.length;
  }

  /** Append samples. If the buffer overflows, oldest samples are dropped. */
  write(samples: Int16Array): void {
    const len = samples.length;
    if (len >= this.buf.length) {
      // Incoming data larger than buffer: keep only the tail
      samples = samples.subarray(len - this.buf.length);
      this.buf.set(samples);
      this.writePos = 0;
      this.available = this.buf.length;
      return;
    }

    const spaceToEnd = this.buf.length - this.writePos;
    if (len <= spaceToEnd) {
      this.buf.set(samples, this.writePos);
    } else {
      this.buf.set(samples.subarray(0, spaceToEnd), this.writePos);
      this.buf.set(samples.subarray(spaceToEnd), 0);
    }

    this.writePos = (this.writePos + len) % this.buf.length;
    this.available = Math.min(this.available + len, this.buf.length);
  }

  /**
   * Read the last `count` samples from the buffer (the most recent data).
   * If count > available, returns all available samples.
   */
  readLast(count: number): Int16Array {
    const n = Math.min(count, this.available);
    if (n === 0) return new Int16Array(0);

    const out = new Int16Array(n);
    const readStart = (this.writePos - n + this.buf.length) % this.buf.length;

    if (readStart + n <= this.buf.length) {
      out.set(this.buf.subarray(readStart, readStart + n));
    } else {
      const firstPart = this.buf.length - readStart;
      out.set(this.buf.subarray(readStart, this.buf.length));
      out.set(this.buf.subarray(0, n - firstPart), firstPart);
    }
    return out;
  }

  /** Discard all data. */
  clear(): void {
    this.writePos = 0;
    this.available = 0;
  }

  /** Discard the oldest `count` samples. */
  discard(count: number): void {
    const n = Math.min(count, this.available);
    this.available -= n;
  }
}
