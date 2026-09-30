/**
 * Minimal WebSocket client (RFC 6455) for the msg9 watcher daemon.
 *
 * The package supports node >=20, which has no global `WebSocket`, and the
 * dependency policy forbids pulling in `ws`/`undici` for one connection per
 * inbox — so this module implements exactly what the daemon needs on top of
 * node:net / node:tls / node:crypto:
 *
 *   - HTTP Upgrade handshake with Sec-WebSocket-Protocol negotiation
 *     (msg9 authenticates via `msg9-l0, <ticket>`);
 *   - frame encode/decode with client-side masking (required by the RFC),
 *     16/64-bit extended lengths, fragmentation reassembly;
 *   - control frames: ping → automatic pong, pong, close handshake.
 *
 * `encodeFrame` / `FrameParser` are exported so the integration test can run
 * a spec-faithful fake SERVER with the same codec. They are internals, not
 * public API.
 *
 * @module dsh-msg9-kit/daemon/wsclient
 */

import { createHash, randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export const OPCODES = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const

/** A protocol-level failure (bad handshake, malformed frame, oversize message). */
export class WsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'WsError'
  }
}

/** One decoded frame. Control frames may arrive interleaved inside a message. */
export interface WsFrame {
  fin: boolean
  opcode: number
  payload: Buffer
}

/** The absolute ceiling for one reassembled message (msg9 events are ~1KB). */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024

/**
 * Incremental frame decoder: feed raw socket bytes, get whole frames back.
 * Handles split headers, split payloads, 126/127 lengths and masked peers
 * (servers MUST NOT mask, but the decoder accepts both — the test double
 * exercises the masked path too).
 */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): WsFrame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames: WsFrame[] = []
    for (;;) {
      const frame = this.readFrame()
      if (!frame) break
      frames.push(frame)
    }
    return frames
  }

  private readFrame(): WsFrame | undefined {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const fin = (buffer[0]! & 0x80) !== 0
    const opcode = buffer[0]! & 0x0f
    const masked = (buffer[1]! & 0x80) !== 0
    let length = buffer[1]! & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const high = buffer.readUInt32BE(offset)
      const low = buffer.readUInt32BE(offset + 4)
      if (high > 0x1fffff) throw new WsError('websocket frame exceeds the size ceiling')
      length = high * 2 ** 32 + low
      offset += 8
    }
    if (length > MAX_MESSAGE_BYTES) throw new WsError(`websocket frame too large (${length} bytes)`)
    const maskLength = masked ? 4 : 0
    if (buffer.length < offset + maskLength + length) return undefined
    let payload = buffer.subarray(offset + maskLength, offset + maskLength + length)
    if (masked) {
      const mask = buffer.subarray(offset, offset + 4)
      const unmasked = Buffer.allocUnsafe(length)
      for (let index = 0; index < length; index += 1) unmasked[index] = payload[index]! ^ mask[index % 4]!
      payload = unmasked
    } else {
      payload = Buffer.from(payload) // detach from the shared buffer
    }
    this.buffer = buffer.subarray(offset + maskLength + length)
    return { fin, opcode, payload }
  }
}

/**
 * Serialize one frame. Clients MUST mask (`mask: true`); the test server
 * passes false. Empty payloads are fine (close/ping/pong).
 */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4)
    header.writeUInt16BE(length, 2)
    header[1] = 126
  } else {
    header = Buffer.allocUnsafe(10)
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(length, 6)
    header[1] = 127
  }
  header[0] = 0x80 | opcode
  if (!mask) return Buffer.concat([header, payload])
  header[1] = header[1]! | 0x80
  const maskKey = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let index = 0; index < length; index += 1) masked[index] = payload[index]! ^ maskKey[index % 4]!
  return Buffer.concat([header, maskKey, masked])
}

function acceptKey(secKey: string): string {
  return createHash('sha1').update(secKey + WS_GUID).digest('base64')
}

export interface WsConnectOptions {
  /** Sec-WebSocket-Protocol tokens, in preference order. */
  protocols?: string[]
  /** Extra handshake headers. */
  headers?: Record<string, string>
  /** Handshake ceiling (default 10s); the socket is untimed afterwards. */
  timeoutMs?: number
  signal?: AbortSignal
}

/** A live WebSocket connection. Callbacks are assigned by the consumer. */
export class WsConnection {
  ontext?: (data: string) => void
  onclose?: (code: number, reason: string) => void
  onerror?: (error: Error) => void
  /** Monotonic-ish liveness marker for the engine's watchdog. */
  lastFrameAt = Date.now()
  /** The subprotocol the server accepted, when it answered one. */
  readonly protocol: string | undefined
  /**
   * Whether the socket has already closed. The engine needs this to close a
   * window its `onclose` handler cannot see: a socket that dies between
   * `wsConnect()` and the handler being installed has already fired (and
   * swallowed) its close event, so nothing would ever wake the loop.
   */
  get isClosed(): boolean {
    return this.closed
  }

  private readonly socket: Socket
  private readonly parser = new FrameParser()
  private fragments: Buffer[] = []
  private fragmentBytes = 0
  private closeSent = false
  private closed = false

  constructor(socket: Socket, protocol: string | undefined) {
    this.socket = socket
    this.protocol = protocol
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('error', (error) => {
      if (this.closed) return
      this.onerror?.(error)
    })
    socket.on('close', () => {
      if (this.closed) return
      this.closed = true
      this.onclose?.(1006, 'abnormal closure')
    })
  }

  private onData(chunk: Buffer): void {
    let frames: WsFrame[]
    try {
      frames = this.parser.push(chunk)
    } catch (error) {
      this.onerror?.(error as Error)
      this.destroy()
      return
    }
    for (const frame of frames) {
      this.lastFrameAt = Date.now()
      try {
        this.handleFrame(frame)
      } catch (error) {
        this.onerror?.(error as Error)
        this.destroy()
        return
      }
    }
  }

  private handleFrame(frame: WsFrame): void {
    switch (frame.opcode) {
      case OPCODES.PING:
        this.sendFrame(OPCODES.PONG, frame.payload)
        return
      case OPCODES.PONG:
        return
      case OPCODES.CLOSE: {
        const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000
        const reason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : ''
        if (!this.closeSent) this.sendFrame(OPCODES.CLOSE, frame.payload)
        this.finish(code, reason)
        return
      }
      case OPCODES.TEXT:
      case OPCODES.BINARY:
      case OPCODES.CONTINUATION: {
        this.fragments.push(frame.payload)
        this.fragmentBytes += frame.payload.length
        if (this.fragmentBytes > MAX_MESSAGE_BYTES) throw new WsError('websocket message exceeds the size ceiling')
        if (!frame.fin) return
        const whole = Buffer.concat(this.fragments)
        this.fragments = []
        this.fragmentBytes = 0
        if (frame.opcode === OPCODES.BINARY) return // msg9 speaks JSON text only
        this.ontext?.(whole.toString('utf8'))
        return
      }
      default:
        throw new WsError(`unsupported websocket opcode ${frame.opcode}`)
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return
    this.socket.write(encodeFrame(opcode, payload, true))
  }

  sendText(data: string): void {
    this.sendFrame(OPCODES.TEXT, Buffer.from(data, 'utf8'))
  }

  /** Graceful close: send the close frame; the peer's reply ends the socket. */
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closeSent = true
    const reasonBytes = Buffer.from(reason, 'utf8')
    const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
    payload.writeUInt16BE(code, 0)
    reasonBytes.copy(payload, 2)
    this.sendFrame(OPCODES.CLOSE, payload)
    // A peer that never answers the close handshake must not pin the engine.
    setTimeout(() => this.destroy(), 1_000).unref()
  }

  /** Hard teardown (watchdog, abort): no close handshake. */
  destroy(): void {
    if (this.closed) return
    this.socket.destroy()
    this.finish(1006, 'abnormal closure')
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    this.socket.destroy()
    this.onclose?.(code, reason)
  }
}

/**
 * Perform the Upgrade handshake and return the live connection. Rejects with
 * WsError (status set for HTTP rejections) on any failure.
 */
export function connectWebSocket(rawUrl: string, options: WsConnectOptions = {}): Promise<WsConnection> {
  const url = new URL(rawUrl)
  const secure = url.protocol === 'wss:' || url.protocol === 'https:'
  if (!secure && url.protocol !== 'ws:' && url.protocol !== 'http:') {
    return Promise.reject(new WsError(`unsupported websocket scheme: ${url.protocol}`))
  }
  const port = Number(url.port) || (secure ? 443 : 80)
  const host = url.hostname
  const timeoutMs = options.timeoutMs ?? 10_000
  const secKey = randomBytes(16).toString('base64')
  const path = `${url.pathname || '/'}${url.search}`

  return new Promise<WsConnection>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }
    const onAbort = (): void => fail(new WsError('websocket connect aborted'))

    const socket: Socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port })
    socket.setTimeout(timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })

    let handshaken = false
    let head = Buffer.alloc(0)

    socket.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${secKey}`,
        'Sec-WebSocket-Version: 13',
      ]
      if (options.protocols?.length) lines.push(`Sec-WebSocket-Protocol: ${options.protocols.join(', ')}`)
      for (const [name, value] of Object.entries(options.headers ?? {})) lines.push(`${name}: ${value}`)
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    socket.on('timeout', () => fail(new WsError(`websocket handshake timed out after ${Math.round(timeoutMs / 1000)}s`)))
    socket.on('error', (error) => {
      if (!handshaken) fail(error)
    })
    socket.on('data', (chunk) => {
      if (handshaken) return
      head = head.length === 0 ? chunk : Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > 16_384) fail(new WsError('websocket handshake response too large'))
        return
      }
      handshaken = true
      socket.setTimeout(0)
      options.signal?.removeEventListener('abort', onAbort)
      const text = head.subarray(0, end).toString('latin1')
      const rest = head.subarray(end + 4)
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(text)
      const status = statusMatch ? Number(statusMatch[1]) : 0
      if (status !== 101) {
        fail(new WsError(`websocket upgrade rejected (HTTP ${status || '???'})`, status || undefined))
        return
      }
      const headers = new Map<string, string>()
      for (const line of text.split('\r\n').slice(1)) {
        const colon = line.indexOf(':')
        if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
      }
      if (headers.get('sec-websocket-accept') !== acceptKey(secKey)) {
        fail(new WsError('websocket handshake failed: bad Sec-WebSocket-Accept'))
        return
      }
      settled = true
      const connection = new WsConnection(socket, headers.get('sec-websocket-protocol'))
      resolve(connection)
      // Bytes that arrived with the handshake tail belong to the frame stream.
      if (rest.length > 0) socket.emit('data', rest)
    })
  })
}
