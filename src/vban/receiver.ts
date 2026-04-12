import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  parseVbanPacket,
  extractInt16Samples,
  VBAN_SUB_AUDIO,
  type VbanPacket,
} from './protocol.js';

export interface VbanAudioEvent {
  sampleRate: number;
  channels: number;
  samples: Int16Array;
  streamName: string;
  frameCounter: number;
}

export interface VbanReceiverOptions {
  port: number;
  /** Filter by stream name. Empty string accepts all. */
  streamName: string;
}

export class VbanReceiver extends EventEmitter<{
  audio: [VbanAudioEvent];
  error: [Error];
  listening: [{ port: number }];
}> {
  private socket: dgram.Socket | null = null;
  private opts: VbanReceiverOptions;
  /** Total UDP datagrams received (before any parsing/filtering). */
  rawPacketCount = 0;

  constructor(opts: VbanReceiverOptions) {
    super();
    this.opts = opts;
  }

  start(): void {
    if (this.socket) return;

    const socket = dgram.createSocket('udp4');

    socket.on('message', (msg) => {
      this.rawPacketCount++;
      this.handleMessage(msg);
    });

    socket.on('error', (err) => {
      this.emit('error', err);
    });

    socket.on('listening', () => {
      const addr = socket.address();
      this.emit('listening', { port: addr.port });
    });

    socket.bind(this.opts.port);
    this.socket = socket;
  }

  stop(): void {
    if (!this.socket) return;
    this.socket.close();
    this.socket = null;
  }

  /** Update options. If port changed, rebinds the UDP socket. */
  updateOpts(opts: Partial<VbanReceiverOptions>): void {
    const portChanged = opts.port !== undefined && opts.port !== this.opts.port;
    Object.assign(this.opts, opts);
    if (portChanged && this.socket) {
      this.stop();
      this.start();
    }
  }

  private handleMessage(buf: Buffer): void {
    const pkt = parseVbanPacket(buf);
    if (!pkt) return;

    // Only handle audio sub-protocol
    if (pkt.subProtocol !== VBAN_SUB_AUDIO) return;

    // Filter by stream name if configured
    if (this.opts.streamName && pkt.streamName !== this.opts.streamName) return;

    const samples = extractInt16Samples(pkt);
    if (!samples) return;

    this.emit('audio', {
      sampleRate: pkt.sampleRate,
      channels: pkt.channels,
      samples,
      streamName: pkt.streamName,
      frameCounter: pkt.frameCounter,
    });
  }
}
