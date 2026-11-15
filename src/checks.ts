import net from 'node:net';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import tls from 'node:tls';
import { CHECK_KINDS, type CheckResult, type CheckSpec } from './lib/protocol.js';
import { journalLines } from './journal.js';
import { run } from './run.js';

/**
 * The checks of the portal (command 'checks'). Every result text is free of times and durations, so that the
 * inventory only changes when a result does.
 */

/** A unit name of systemd, nothing that could be taken for an option */
export const UNIT_NAME = /^[A-Za-z0-9][\w@.:\\-]*$/;

type Outcome = Pick<CheckResult, 'state' | 'text'>;

const DAY = 24 * 3600_000;

/** "host:port", "[::1]:443"; null: not valid */
export function hostPort(target: string): { host: string; port: number } | null {
    const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(target.trim()) ?? /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target.trim());
    const port = m ? Number(m[2]) : 0;
    return m && port > 0 && port < 65536 ? { host: m[1], port } : null;
}

/** Why the agent does not run a check as it came; null: it does */
export function invalidCheck(c: CheckSpec): string | null {
    if (!c || typeof c.id !== 'string' || !c.id || !CHECK_KINDS.includes(c.kind) || typeof c.target !== 'string') {
        return 'ungültige Prüfung';
    }
    switch (c.kind) {
        case 'service':
            return UNIT_NAME.test(c.target) ? null : 'ungültiger Name der Unit';
        case 'tcp':
        case 'cert':
            return hostPort(c.target) ? null : 'Ziel muss host:port sein';
        case 'http':
            return /^https?:\/\/[^\s]+$/i.test(c.target) ? null : 'Adresse muss mit http:// oder https:// beginnen';
        case 'file':
            return isAbsolute(c.target) ? null : 'Pfad muss absolut sein';
        case 'journal':
            if (c.target && !UNIT_NAME.test(c.target)) {
                return 'ungültiger Name der Unit';
            }
            try {
                new RegExp(c.text || '', 'i');
            } catch {
                return 'ungültiger regulärer Ausdruck';
            }
            return c.text && c.text.length <= 500 ? null : 'Muster fehlt';
    }
    return 'unbekannte Art';
}

const seconds = (c: CheckSpec): number => Math.max(1, Math.min(120, c.timeout ?? 10)) * 1000;

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const minuteOf = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

async function service(c: CheckSpec): Promise<Outcome> {
    const r = await run('systemctl', ['is-active', c.target], { timeout: 15_000 });
    const state = r.stdout.trim() || r.error || 'unbekannt';
    return { state: state === 'active' ? 'ok' : 'fail', text: state };
}

function tcp(c: CheckSpec): Promise<Outcome> {
    const t = hostPort(c.target)!;
    return new Promise(resolve => {
        const sock = net.connect({ host: t.host, port: t.port });
        const done = (o: Outcome): void => {
            sock.destroy();
            resolve(o);
        };
        sock.setTimeout(seconds(c), () => done({ state: 'fail', text: 'keine Antwort' }));
        sock.on('connect', () => done({ state: 'ok', text: 'erreichbar' }));
        sock.on('error', (e: NodeJS.ErrnoException) => done({ state: 'fail', text: e.code || e.message }));
    });
}

async function http(c: CheckSpec): Promise<Outcome> {
    let res: Response;
    try {
        res = await fetch(c.target, { redirect: 'manual', signal: AbortSignal.timeout(seconds(c)), headers: { 'user-agent': 'bee-linux' } });
    } catch (e) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const text = (e as Error).name === 'TimeoutError' ? 'keine Antwort' : cause?.code || cause?.message || (e as Error).message;
        return { state: 'fail', text };
    }
    const okStatus = c.status ? res.status === c.status : res.status >= 200 && res.status < 400;
    if (!okStatus) {
        await res.body?.cancel().catch(() => {});
        return { state: 'fail', text: `HTTP ${res.status}` };
    }
    if (c.text) {
        const body = (await res.text().catch(() => '')).slice(0, 1024 * 1024);
        if (!body.includes(c.text)) {
            return { state: 'fail', text: `HTTP ${res.status}, Text fehlt` };
        }
    } else {
        await res.body?.cancel().catch(() => {});
    }
    return { state: 'ok', text: `HTTP ${res.status}` };
}

function cert(c: CheckSpec, now: number): Promise<Outcome> {
    const t = hostPort(c.target)!;
    const warnDays = c.warnDays ?? 14;
    return new Promise(resolve => {
        const sock = tls.connect({
            host: t.host,
            port: t.port,
            servername: net.isIP(t.host) ? undefined : t.host,
            rejectUnauthorized: false,
        });
        const done = (o: Outcome): void => {
            sock.destroy();
            resolve(o);
        };
        sock.setTimeout(seconds(c), () => done({ state: 'fail', text: 'keine Antwort' }));
        sock.on('secureConnect', () => {
            const peer = sock.getPeerCertificate();
            const end = peer?.valid_to ? Date.parse(peer.valid_to) : NaN;
            if (!Number.isFinite(end)) {
                done({ state: 'fail', text: 'kein Zertifikat' });
            } else if (end <= now) {
                done({ state: 'fail', text: `abgelaufen am ${dateOf(end)}` });
            } else if (!sock.authorized) {
                done({ state: 'fail', text: `ungültig: ${String(sock.authorizationError)}` });
            } else if (end - now < warnDays * DAY) {
                done({ state: 'warn', text: `läuft ab am ${dateOf(end)}` });
            } else {
                done({ state: 'ok', text: `gültig bis ${dateOf(end)}` });
            }
        });
        sock.on('error', (e: NodeJS.ErrnoException) => done({ state: 'fail', text: e.code || e.message }));
    });
}

/** The time of the file, or of the newest file in the folder (not in subfolders) */
async function newest(path: string): Promise<number | null> {
    const s = await stat(path);
    if (!s.isDirectory()) {
        return s.mtimeMs;
    }
    let best: number | null = null;
    for (const name of await readdir(path)) {
        const f = await stat(join(path, name)).catch(() => null);
        if (f?.isFile() && (best === null || f.mtimeMs > best)) {
            best = f.mtimeMs;
        }
    }
    return best;
}

async function file(c: CheckSpec, now: number): Promise<Outcome> {
    let time: number | null;
    try {
        time = await newest(c.target);
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        return { state: 'fail', text: code === 'ENOENT' ? 'nicht vorhanden' : code === 'EACCES' ? 'kein Zugriff für bee' : String(code) };
    }
    if (time === null) {
        return { state: 'fail', text: 'Ordner leer' };
    }
    const maxAge = (c.maxAgeHours ?? 26) * 3600_000;
    return { state: now - time > maxAge ? 'fail' : 'ok', text: `Stand ${minuteOf(time)}` };
}

async function journal(c: CheckSpec): Promise<Outcome> {
    const minutes = c.windowMinutes ?? 60;
    const lines = await journalLines(minutes, c.target);
    if (!lines) {
        return { state: 'fail', text: 'Journal nicht lesbar' };
    }
    const pattern = new RegExp(c.text!, 'i');
    const n = lines.filter(l => pattern.test(l)).length;
    const max = c.maxCount ?? 0;
    return { state: n > max ? 'fail' : 'ok', text: `${n} Treffer in ${minutes} min` };
}

export async function runCheck(c: CheckSpec, now = Date.now()): Promise<Outcome> {
    const invalid = invalidCheck(c);
    if (invalid) {
        return { state: 'fail', text: invalid };
    }
    try {
        switch (c.kind) {
            case 'service':
                return await service(c);
            case 'tcp':
                return await tcp(c);
            case 'http':
                return await http(c);
            case 'cert':
                return await cert(c, now);
            case 'file':
                return await file(c, now);
            case 'journal':
                return await journal(c);
        }
    } catch (e) {
        return { state: 'fail', text: (e as Error).message };
    }
    return { state: 'fail', text: 'unbekannte Art' };
}

/**
 * Runs all checks at the same time; a result keeps its `since` while its state stays.
 *
 * @param previous the results of the last run
 */
export async function runChecks(list: CheckSpec[], previous: CheckResult[], now = Date.now()): Promise<CheckResult[]> {
    const before = new Map(previous.map(r => [r.id, r]));
    return Promise.all(
        list.map(async c => {
            const o = await runCheck(c, now);
            const old = before.get(c.id);
            return { id: c.id, state: o.state, text: o.text, since: old && old.state === o.state ? old.since : now };
        }),
    );
}
