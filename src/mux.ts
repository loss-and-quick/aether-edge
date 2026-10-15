import { connect } from 'cloudflare:sockets';
import {
  concat,
  isCloudflareIPv4,
  queryDoh,
  safeCloseSocket,
  type DatagramHandler,
  type ProxyTarget,
} from './session';

export const MUX_HOST = 'v1.mux.cool';

export const MUX_STATUS_NEW = 0x01;
export const MUX_STATUS_DATA = 0x02; // SessionStatusKeep
export const MUX_STATUS_END = 0x03;
export const MUX_STATUS_KEEP_ALIVE = 0x04;

export const MUX_OPTION_DATA = 0x01;
export const MUX_OPTION_ERROR = 0x02;

export const MUX_NETWORK_TCP = 0x01;
export const MUX_NETWORK_UDP = 0x02;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x02;
const ATYP_IPV6 = 0x03;

const textDecoder = new TextDecoder();

export interface DecodedMuxTarget {
  network: number;
  hostname: string;
  port: number;
}

export type MuxFrame =
  | {
      sessionId: number;
      status: typeof MUX_STATUS_NEW;
      network: number;
      hostname: string;
      port: number;
      payload: Uint8Array;
    }
  | {
      sessionId: number;
      status: typeof MUX_STATUS_DATA;
      payload: Uint8Array;
    }
  | {
      sessionId: number;
      status: typeof MUX_STATUS_END | typeof MUX_STATUS_KEEP_ALIVE;
      payload: Uint8Array;
    };

interface MuxTcpSession {
  type: 'tcp';
  socket: Socket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

interface MuxUdpSession {
  type: 'udp';
  write: (chunk: Uint8Array) => Promise<void>;
}

type MuxSession = MuxTcpSession | MuxUdpSession;

interface OpenedMuxSocket {
  socket: Socket;
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

export function decodeMuxTarget(data: Uint8Array, offset = 0): DecodedMuxTarget {
  if (data.length < offset + 4) {
    throw new Error('mux target truncated');
  }

  const network = data[offset++];
  if (network !== MUX_NETWORK_TCP && network !== MUX_NETWORK_UDP) {
    throw new Error(`unknown network ${network}`);
  }

  const port = (data[offset] << 8) | data[offset + 1];
  offset += 2;
  if (port === 0) {
    throw new Error('invalid port');
  }

  const addressType = data[offset++];
  let hostname: string;

  switch (addressType) {
    case ATYP_IPV4: {
      if (data.length < offset + 4) {
        throw new Error('truncated ipv4 address');
      }
      hostname = Array.from(data.subarray(offset, offset + 4)).join('.');
      offset += 4;
      break;
    }

    case ATYP_DOMAIN: {
      if (data.length < offset + 1) {
        throw new Error('truncated domain');
      }
      const length = data[offset++];
      if (length === 0 || data.length < offset + length) {
        throw new Error('truncated domain');
      }
      hostname = textDecoder.decode(data.subarray(offset, offset + length));
      offset += length;
      break;
    }

    case ATYP_IPV6: {
      if (data.length < offset + 16) {
        throw new Error('truncated ipv6 address');
      }
      const groups: string[] = [];
      for (let index = 0; index < 8; index++) {
        const group = (data[offset + index * 2] << 8) | data[offset + index * 2 + 1];
        groups.push(group.toString(16));
      }
      hostname = groups.join(':');
      offset += 16;
      break;
    }

    default:
      throw new Error(`unknown address type ${addressType}`);
  }

  return { network, hostname, port };
}

export class MuxFrameParser {
  private pending = new Uint8Array(0);

  push(chunk: Uint8Array): MuxFrame[] {
    this.pending = this.pending.length ? new Uint8Array(concat(this.pending, chunk)) : new Uint8Array(chunk);
    const frames: MuxFrame[] = [];

    while (this.pending.length >= 2) {
      const metaLen = (this.pending[0] << 8) | this.pending[1];
      if (this.pending.length < 2 + metaLen) {
        break;
      }

      const meta = this.pending.subarray(2, 2 + metaLen);
      if (meta.length < 4) {
        throw new Error('mux metadata too short');
      }

      const sessionId = (meta[0] << 8) | meta[1];
      const status = meta[2];
      const option = meta[3];
      const hasData = (option & MUX_OPTION_DATA) !== 0;

      let consumed = 2 + metaLen;
      let payload = new Uint8Array(0);

      if (hasData) {
        if (this.pending.length < consumed + 2) {
          break; // wait for data length header
        }
        const dataLen = (this.pending[consumed] << 8) | this.pending[consumed + 1];
        consumed += 2;
        if (this.pending.length < consumed + dataLen) {
          break; // wait for full payload
        }
        payload = this.pending.subarray(consumed, consumed + dataLen);
        consumed += dataLen;
      }

      switch (status) {
        case MUX_STATUS_NEW: {
          const target = decodeMuxTarget(meta, 4);
          frames.push({ sessionId, status, ...target, payload });
          break;
        }

        case MUX_STATUS_DATA:
          frames.push({ sessionId, status, payload });
          break;

        case MUX_STATUS_END:
        case MUX_STATUS_KEEP_ALIVE:
          frames.push({ sessionId, status, payload: new Uint8Array(0) });
          break;

        default:
          throw new Error(`unknown mux status ${status}`);
      }

      this.pending = new Uint8Array(this.pending.subarray(consumed));
    }

    return frames;
  }

  getPending(): Uint8Array {
    return this.pending;
  }
}

export function serializeMuxDataFrame(sessionId: number, payload: Uint8Array): Uint8Array {
  // metaLen (2 bytes) = 4, sessionId (2 bytes), status (1 byte) = MUX_STATUS_DATA, option (1 byte) = MUX_OPTION_DATA
  // dataLen (2 bytes) = payload.length, payload
  const frame = new Uint8Array(8 + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint16(0, 4); // metaLen
  view.setUint16(2, sessionId);
  frame[4] = MUX_STATUS_DATA;
  frame[5] = MUX_OPTION_DATA;
  view.setUint16(6, payload.length); // dataLen
  frame.set(payload, 8);
  return frame;
}

export function serializeMuxEndFrame(sessionId: number, hasError = false): Uint8Array {
  // metaLen (2 bytes) = 4, sessionId (2 bytes), status (1 byte) = MUX_STATUS_END, option (1 byte)
  const frame = new Uint8Array(6);
  const view = new DataView(frame.buffer);
  view.setUint16(0, 4); // metaLen
  view.setUint16(2, sessionId);
  frame[4] = MUX_STATUS_END;
  frame[5] = hasError ? MUX_OPTION_ERROR : 0;
  return frame;
}

async function connectMuxSocket(
  target: ProxyTarget,
  initialPayload: Uint8Array,
  proxyTarget: ProxyTarget | null,
): Promise<OpenedMuxSocket> {
  const mustProxy = isCloudflareIPv4(target.hostname);
  const firstTarget = mustProxy && proxyTarget ? proxyTarget : target;

  const attach = async ({ hostname, port }: ProxyTarget): Promise<OpenedMuxSocket> => {
    const socket = connect({ hostname, port });
    await socket.opened;

    const writer = socket.writable.getWriter();
    if (initialPayload.length) {
      await writer.write(initialPayload);
    }

    return { socket, writer };
  };

  try {
    return await attach(firstTarget);
  } catch (error) {
    if (firstTarget === proxyTarget || !proxyTarget) {
      throw error;
    }
    return attach(proxyTarget);
  }
}

class MuxSessionManager implements DatagramHandler {
  private closed = false;
  private readonly parser = new MuxFrameParser();
  private readonly sessions = new Map<number, MuxSession>();

  constructor(
    private readonly reply: (frame: Uint8Array) => void,
    private readonly proxyTarget: ProxyTarget | null,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    for (const frame of this.parser.push(chunk)) {
      await this.handleFrame(frame);
      if (this.closed) {
        break;
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId, false);
    }
  }

  private async handleFrame(frame: MuxFrame): Promise<void> {
    switch (frame.status) {
      case MUX_STATUS_NEW:
        await this.openSession(frame);
        return;

      case MUX_STATUS_DATA:
        await this.writeSession(frame.sessionId, frame.payload);
        return;

      case MUX_STATUS_END:
        this.closeSession(frame.sessionId, false);
        return;

      case MUX_STATUS_KEEP_ALIVE:
        return;
    }
  }

  private async openSession(frame: Extract<MuxFrame, { status: typeof MUX_STATUS_NEW }>): Promise<void> {
    this.closeSession(frame.sessionId, false);

    if (frame.network === MUX_NETWORK_UDP) {
      if (frame.port === 53) {
        const resolve = async (query: Uint8Array): Promise<void> => {
          const answer = await queryDoh(query);
          if (answer && !this.closed) {
            this.reply(serializeMuxDataFrame(frame.sessionId, answer));
          }
        };
        const session: MuxSession = { type: 'udp', write: resolve };
        this.sessions.set(frame.sessionId, session);
        if (frame.payload.length > 0) {
          await resolve(frame.payload);
        }
        return;
      }

      this.reply(serializeMuxEndFrame(frame.sessionId));
      return;
    }

    if (frame.network !== MUX_NETWORK_TCP) {
      this.reply(serializeMuxEndFrame(frame.sessionId));
      return;
    }

    let opened: OpenedMuxSocket;
    try {
      opened = await connectMuxSocket(
        { hostname: frame.hostname, port: frame.port },
        frame.payload,
        this.proxyTarget,
      );
    } catch {
      this.reply(serializeMuxEndFrame(frame.sessionId));
      return;
    }

    if (this.closed) {
      try {
        opened.writer.releaseLock();
      } catch {
        // Ignore pending writes.
      }
      safeCloseSocket(opened.socket);
      return;
    }

    const session: MuxSession = { type: 'tcp', socket: opened.socket, writer: opened.writer };
    this.sessions.set(frame.sessionId, session);
    void this.pipeSession(frame.sessionId, session);
  }

  private async writeSession(sessionId: number, payload: Uint8Array): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.reply(serializeMuxEndFrame(sessionId));
      return;
    }

    try {
      if (session.type === 'tcp') {
        await session.writer.write(payload);
      } else {
        await session.write(payload);
      }
    } catch {
      this.closeSession(sessionId, true);
    }
  }

  private async pipeSession(sessionId: number, session: MuxTcpSession): Promise<void> {
    const reader = session.socket.readable.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        if (!value?.length || this.closed) {
          continue;
        }

        this.reply(serializeMuxDataFrame(sessionId, value));
      }
    } catch {
      // Socket errors are handled by the shared cleanup path below.
    } finally {
      reader.releaseLock();
      if (this.sessions.get(sessionId) === session) {
        this.closeSession(sessionId, !this.closed);
      }
    }
  }

  private closeSession(sessionId: number, sendEnd: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      if (sendEnd && !this.closed) {
        this.reply(serializeMuxEndFrame(sessionId));
      }
      return;
    }

    this.sessions.delete(sessionId);
    if (session.type === 'tcp') {
      try {
        session.writer.releaseLock();
      } catch {
        // Ignore pending writes.
      }

      safeCloseSocket(session.socket);
    }
    if (sendEnd && !this.closed) {
      this.reply(serializeMuxEndFrame(sessionId));
    }
  }
}

export function handleMux(
  reply: (frame: Uint8Array) => void,
  proxyTarget: ProxyTarget | null,
): DatagramHandler {
  return new MuxSessionManager(reply, proxyTarget);
}
