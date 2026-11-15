import net from 'node:net';
import tls from 'node:tls';
import WebSocket from 'ws';
import type { TunnelRequest } from './lib/protocol.js';
import { CLOSE, Mux, REFUSE_HEADER, type TunnelStream } from './lib/tunnel.js';
import type { Log } from './config.js';

/**
 * Remote access without open ports, as ioBroker.bee and bee-ha do it: on request of the server (job "tunnel") the
 * agent opens a WebSocket to the server and carries the streams of the browser. bee-linux offers the console only:
 * each stream is one shell (console.ts). A local web interface as target is there for later (set here, never by the
 * server).
 */

/** Where the streams go */
export interface Target {
    host: string;
    port: number;
    secure: boolean;
}

/** Is the tunnel URL one of our own server? The job came over the broker, this is a second check. */
export function trustedTunnelUrl(url: string, serverUrls: string[]): boolean {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && local)) {
        return false;
    }
    return serverUrls.some(s => {
        try {
            return new URL(s).hostname === u.hostname;
        } catch {
            return false;
        }
    });
}

export interface TunnelClientOptions {
    /** Where the streams go; null together with a refusal, or for the console */
    target: Target | null;
    /** The console: each stream is one shell (console.ts) instead of a connection to the target */
    handler?: (stream: TunnelStream) => void;
    /** Reason to refuse the session instead of carrying it */
    refusal: string | null;
    /** Trusted CAs for the certificate of the server */
    ca: string[];
    log: Log;
    onEnd: (client: TunnelClient, reason: string) => void;
}

const MAX_BACKOFF = 60_000;

function closeReason(text: string): string {
    let out = text;
    while (Buffer.byteLength(out) > 123) {
        out = out.slice(0, -1);
    }
    return out;
}
/** The server pings every 25 s; without a ping for this long the connection is dead */
const DEAD_AFTER = 90_000;
/** Longest session the agent accepts, whatever the server says */
const MAX_SESSION = 4 * 3600_000;

/** Tunnel of one access session. Reconnects after a connection loss until the session expires. */
export class TunnelClient {
    private ws: WebSocket | null = null;
    private mux: Mux | null = null;
    private stopped = false;
    private backoff = 2000;
    private retryTimer: NodeJS.Timeout | null = null;
    private readonly endTimer: NodeJS.Timeout;
    private watchdog: NodeJS.Timeout | null = null;
    private lastPing = 0;
    /** When the agent took the session */
    readonly startedAt = Date.now();

    constructor(
        readonly req: TunnelRequest,
        private readonly opts: TunnelClientOptions,
    ) {
        const lifetime = Math.max(0, Math.min(req.expiresAt - Date.now(), MAX_SESSION));
        this.endTimer = setTimeout(() => this.stop('expired'), lifetime);
    }

    /** Payload bytes so far */
    get bytes(): number {
        return (this.mux?.bytesIn ?? 0) + (this.mux?.bytesOut ?? 0);
    }

    start(): void {
        this.connect();
    }

    /**
     * Ends the session on this side. With `refuse` (e.g. the owner ends it on the device) the server learns it and
     * ends the session too, with this reason in the audit log; otherwise it waits for a reconnect until it expires.
     */
    stop(reason: string, refuse?: string): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        clearTimeout(this.endTimer);
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
        }
        if (this.watchdog) {
            clearInterval(this.watchdog);
        }
        this.mux?.close('Fernzugriff beendet');
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            // the reason of a close frame: at most 123 bytes
            this.ws.close(refuse ? CLOSE.NOT_ALLOWED : 1000, refuse ? closeReason(refuse) : 'agent stop');
        } else {
            this.ws?.terminate();
            if (refuse) {
                this.refuseOnce(refuse);
            }
        }
        this.opts.onEnd(this, reason);
    }

    /** No tunnel open right now: tell the server with a refused tunnel request */
    private refuseOnce(reason: string): void {
        const ws = new WebSocket(this.req.url, {
            headers: { authorization: `Bearer ${this.req.ticket}`, [REFUSE_HEADER]: encodeURIComponent(reason) },
            ca: this.opts.ca,
            handshakeTimeout: 15_000,
        });
        const done = (): void => ws.terminate();
        ws.on('unexpected-response', (_q, res) => {
            res.resume();
            done();
        });
        ws.on('open', () => ws.close(CLOSE.NOT_ALLOWED, closeReason(reason)));
        ws.on('error', done);
    }

    private connect(): void {
        if (this.stopped) {
            return;
        }
        const headers: Record<string, string> = { authorization: `Bearer ${this.req.ticket}` };
        if (this.opts.refusal) {
            headers[REFUSE_HEADER] = encodeURIComponent(this.opts.refusal);
        }
        const ws = new WebSocket(this.req.url, {
            headers,
            ca: this.opts.ca,
            handshakeTimeout: 30_000,
            perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 1 } },
        });
        this.ws = ws;
        ws.on('open', () => {
            this.backoff = 2000;
            this.lastPing = Date.now();
            this.mux = new Mux(
                frame => ws.send(frame),
                stream => this.onStream(stream),
            );
            this.watchdog ??= setInterval(() => {
                if (this.ws?.readyState === WebSocket.OPEN && Date.now() - this.lastPing > DEAD_AFTER) {
                    this.opts.log.info('Remote access: no sign of the server, reconnecting');
                    this.ws.terminate();
                }
            }, 15_000);
            this.opts.log.debug(`Remote access ${this.req.id}: tunnel open`);
        });
        ws.on('ping', () => (this.lastPing = Date.now()));
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                this.mux?.receive(data as Buffer);
            }
        });
        ws.on('unexpected-response', (_request, res) => {
            res.resume();
            // 410: session unknown or ended, 403: refusal accepted; neither gets better by trying again
            this.stop(this.opts.refusal ? 'refused' : `server answered HTTP ${res.statusCode}`);
        });
        ws.on('error', err => this.opts.log.debug(`Remote access ${this.req.id}: ${err.message}`));
        ws.on('close', code => {
            this.mux?.close('Verbindung zum Server unterbrochen');
            this.mux = null;
            if (this.ws !== ws || this.stopped) {
                return;
            }
            if (code === CLOSE.ENDED || code === CLOSE.REPLACED) {
                this.stop(code === CLOSE.ENDED ? 'ended by the server' : 'replaced');
                return;
            }
            const delay = this.backoff;
            this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
            this.opts.log.info(`Remote access: connection lost, reconnecting in ${Math.round(delay / 1000)} s`);
            this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.connect();
            }, delay);
        });
    }

    private onStream(stream: TunnelStream): void {
        if (this.opts.handler) {
            this.opts.handler(stream);
            return;
        }
        const t = this.opts.target;
        if (!t) {
            stream.destroy(new Error('no target'));
            return;
        }
        // a local web interface with its own, usually self-signed certificate: nothing to verify there
        const sock = t.secure
            ? tls.connect({ host: t.host, port: t.port, servername: net.isIP(t.host) ? undefined : t.host, rejectUnauthorized: false })
            : net.connect(t.port, t.host);
        stream.pipe(sock);
        sock.pipe(stream);
        // a regular end runs through the pipes in both directions (half close); only errors cut off
        sock.on('error', err => stream.destroy(err));
        stream.on('error', () => sock.destroy());
    }
}
