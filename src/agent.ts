import { randomUUID } from 'node:crypto';
import { mkdir, readFile, statfs, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import {
    normalizeComment,
    PROTOCOL_VERSION,
    type AgentCommand,
    type CheckResult,
    type CheckSpec,
    type EnrollError,
    type EnrollRequest,
    type EnrollResponse,
    type Inventory,
    type JobMessage,
    type LinuxInfo,
    type McpRequest,
    type OsUpdates,
    type ReplyMessage,
    type StateMessage,
    type TunnelRequest,
} from './lib/protocol.js';
import { CONSOLE, consoleMessage, type TunnelStream } from './lib/tunnel.js';
import { osUpdates } from './apt.js';
import { invalidCheck, runChecks, UNIT_NAME } from './checks.js';
import type { Config, Log } from './config.js';
import { consoleUser, findScript, MAX_SHELLS, startShell } from './console.js';
import { diagnose, SUBJECT } from './diagnose.js';
import { journalSummary, type JournalSummary } from './journal.js';
import { PACKAGE_NAME, Root, type RootAbilities } from './root.js';
import { failedUnits, memInfo, mounts, ntpSynced, osRelease, temperature } from './system.js';
import { buildTools, callTool } from './tools.js';
import { Transport, trustedCas } from './transport.js';
import { TunnelClient, trustedTunnelUrl } from './tunnel-client.js';

/**
 * bee-linux: the agent of beekeeper on a Linux server. It enrolls with a one-time token, keeps the MQTT connection to
 * the broker of the platform with its device certificate, reports heartbeat and inventory (system, filesystems,
 * updates, journal, the checks of the portal) and carries the console through the tunnel. It runs as its own user
 * (bee); what needs root goes through the helper bee-root (root.ts).
 */

export const AGENT_VERSION = '0.5.2';

const MIN = 60_000;
/** The journal of 24 hours is read this often */
const JOURNAL_EVERY = 10 * MIN;
/** apt list (reads only the lists on disk) */
const APT_LIST_EVERY = 30 * MIN;
/** pm2, Docker and what sudo allows */
const EXTRAS_EVERY = 5 * MIN;
/** Longest text of an upgrade that goes back to the portal */
const MAX_REPLY_TEXT = 8000;
/** Where the agent looks up the newest version: npm (the helper installs from the same place: bee-root self-update) */
export const LATEST_URL = 'https://registry.npmjs.org/bee-linux/latest';
/** How often the agent looks up the newest version */
const LATEST_EVERY = 6 * 60 * MIN;

/** The version of package.json, if it looks like one */
export function parseLatest(text: string): string | null {
    try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        return typeof v === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
    } catch {
        return null;
    }
}

async function lookUpLatest(): Promise<string | null> {
    try {
        const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `bee-linux/${AGENT_VERSION}` } });
        return res.ok ? parseLatest(await res.text()) : null;
    } catch {
        return null;
    }
}

type EnrollResult =
    { kind: 'ok'; creds: EnrollResponse } | { kind: 'rejected'; reason: string } | { kind: 'retry'; reason: string };

export async function enroll(url: string, req: EnrollRequest): Promise<EnrollResult> {
    let res: Response;
    try {
        res = await fetch(`${url}/api/enroll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req),
            signal: AbortSignal.timeout(30_000),
        });
    } catch (e) {
        return { kind: 'retry', reason: e.cause?.message || e.message };
    }
    const body = (await res.json().catch(() => null)) as EnrollResponse | EnrollError | null;
    if (res.ok) {
        const creds = body as EnrollResponse;
        if (!creds?.deviceId || !creds.cert || !creds.key || !creds.ca || !creds.mqttUrl) {
            return { kind: 'retry', reason: 'Unvollständige Antwort des Servers' };
        }
        return { kind: 'ok', creds };
    }
    const reason = (body as EnrollError | null)?.reason || `HTTP ${res.status}`;
    return res.status === 403 || res.status === 400 ? { kind: 'rejected', reason } : { kind: 'retry', reason };
}

/** What the agent collected, for the inventory */
export interface Collected {
    distro: string;
    model: string;
    memTotal: number;
    swapTotal: number;
    linux: Omit<LinuxInfo, 'distro' | 'cpus' | 'swapTotal'>;
    osUpdates?: OsUpdates;
    abilities: RootAbilities;
}

export function buildInventory(input: {
    uuid: string;
    config: Pick<Config, 'comment'>;
    /** The console is allowed and can run here */
    console: boolean;
    /** The owner allows the AI access (BEE_AI) */
    ai?: boolean;
    c: Collected;
}): Inventory {
    const { c } = input;
    const comment = normalizeComment(input.config.comment);
    const commands: AgentCommand[] = ['checks', 'mcp', 'diagnose'];
    if (c.abilities.apt && c.osUpdates) {
        commands.push('osUpgrade');
    }
    if (c.abilities.reboot) {
        commands.push('reboot');
    }
    if (c.abilities.update) {
        commands.push('agentUpdate');
    }
    if (c.abilities.services) {
        commands.push('unit');
    }
    const root = c.linux.mounts.find(m => m.path === '/');
    return {
        platform: 'linux',
        linux: { distro: c.distro, cpus: os.cpus().length, swapTotal: c.swapTotal, ...c.linux },
        agentVersion: AGENT_VERSION,
        uuid: input.uuid,
        hostname: os.hostname(),
        ...(comment ? { comment } : {}),
        remoteAccess: input.console ? ['console'] : [],
        ...(input.console ? { consoleUser: consoleUser() } : {}),
        accessTargets: {},
        commands,
        // reading only, as the user of bee-linux; the name is no login of a program as with ioBroker
        ...(input.ai ? { ai: { user: consoleUser(), setState: false, objectChange: false } } : {}),
        ...(c.osUpdates ? { osUpdates: c.osUpdates } : {}),
        // no ioBroker here; node empty on purpose: the Node.js of the agent is no matter of the server
        software: { jsController: '', node: '', npm: '', adapters: {}, instances: {} },
        system: {
            platform: os.platform(),
            arch: os.arch(),
            os: c.distro,
            kernel: os.release(),
            model: c.model,
            memTotal: c.memTotal,
            diskTotal: root?.size ?? 0,
        },
        backup: { lastLocal: null, offDevice: false },
    };
}

/** Raspberry Pi and other boards: the device tree; PCs and virtual machines: DMI; else the CPU */
async function machineModel(): Promise<string> {
    const read = (f: string): Promise<string> =>
        readFile(f, 'utf8')
            .then(s => s.replace(/\0/g, '').trim())
            .catch(() => '');
    const board = await read('/proc/device-tree/model');
    if (board) {
        return board;
    }
    const [vendor, product] = await Promise.all([read('/sys/class/dmi/id/sys_vendor'), read('/sys/class/dmi/id/product_name')]);
    const dmi = [vendor, product].filter(s => s && !/^(To be filled|System manufacturer|System Product Name|Default string)/i.test(s));
    return dmi.join(' ') || os.cpus()[0]?.model?.trim() || '';
}

const ENROLL_MIN = 30_000;
const ENROLL_MAX = 3600_000;

interface StoredChecks {
    hash: string;
    list: CheckSpec[];
}

export class Agent {
    private transport: Transport | null = null;
    private creds: EnrollResponse | null = null;
    private uuid = '';
    private seq = 0;
    private lastInventory = '';
    private readonly tunnels = new Map<string, TunnelClient>();
    /** Running shells per console session */
    private readonly shells = new Map<string, number>();
    private readonly timers: NodeJS.Timeout[] = [];
    private enrollTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private readonly root: Root;
    private checks: StoredChecks | null = null;
    private results: CheckResult[] = [];
    private journal: { at: number; value: JournalSummary | null } | null = null;
    private apt: { at: number; value: OsUpdates | undefined } | null = null;
    /** When the agent last loaded the lists of packages itself */
    private aptUpdatedAt: number | null = null;
    private extras: { at: number; abilities: RootAbilities; pm2: LinuxInfo['pm2']; docker: LinuxInfo['docker'] } | null = null;
    private static: { distro: string; model: string } | null = null;
    private collecting: Promise<void> | null = null;
    /** An upgrade of packages is running */
    private upgrading = false;
    /** The newest version on npm, when the agent may update itself */
    private latest: { at: number; value: string | null } | null = null;
    /** An update of the agent itself was started */
    private updating = false;
    /** The tools of the AI access */
    private readonly tools;
    /** AI sessions seen, for the log: id -> who */
    private readonly aiSessions = new Map<string, string>();

    constructor(
        private readonly config: Config,
        private readonly log: Log,
    ) {
        this.root = new Root(config.rootHelper);
        this.tools = buildTools({ root: this.root, rootLogs: () => !!this.extras?.abilities.logs });
    }

    get connected(): boolean {
        return !!this.transport?.connected;
    }

    async start(): Promise<void> {
        await mkdir(this.config.dataDir, { recursive: true });
        this.uuid = await this.loadUuid();
        this.creds = await this.loadCreds();
        this.checks = await this.loadChecks();
        this.log.info(
            `bee-linux ${AGENT_VERSION}: server ${this.config.url}, ${this.checks?.list.length ?? 0} checks every ${this.config.check} s, ` +
                `console ${!this.config.console ? 'off' : findScript() ? 'allowed' : 'allowed, but no script (util-linux) here'}, AI access ${this.config.ai ? 'allowed (reading)' : 'off'}`,
        );
        if (this.creds) {
            this.connect();
        } else {
            await this.tryEnroll(ENROLL_MIN);
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.timers.forEach(t => clearInterval(t));
        this.timers.length = 0;
        if (this.enrollTimer) {
            clearTimeout(this.enrollTimer);
        }
        for (const t of this.tunnels.values()) {
            t.stop('agent stops');
        }
        await this.transport?.stop();
    }

    private async loadUuid(): Promise<string> {
        const file = join(this.config.dataDir, 'uuid');
        const known = (await readFile(file, 'utf8').catch(() => '')).trim();
        if (known) {
            return known;
        }
        const uuid = randomUUID();
        await writeFile(file, `${uuid}\n`, { mode: 0o600 });
        return uuid;
    }

    private async loadCreds(): Promise<EnrollResponse | null> {
        try {
            return JSON.parse(await readFile(join(this.config.dataDir, 'device.json'), 'utf8')) as EnrollResponse;
        } catch {
            return null;
        }
    }

    private async loadChecks(): Promise<StoredChecks | null> {
        try {
            const c = JSON.parse(await readFile(join(this.config.dataDir, 'checks.json'), 'utf8')) as StoredChecks;
            return typeof c?.hash === 'string' && Array.isArray(c.list) ? c : null;
        } catch {
            return null;
        }
    }

    private async saveChecks(c: StoredChecks): Promise<void> {
        const file = join(this.config.dataDir, 'checks.json');
        await writeFile(`${file}.tmp`, JSON.stringify(c), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
    }

    private async tryEnroll(delay: number): Promise<void> {
        if (this.stopped) {
            return;
        }
        if (!this.config.token) {
            this.log.error('Not enrolled and no BEE_TOKEN: create an enrollment token for the asset in the portal and set it in /etc/bee-linux/bee-linux.env');
            this.enrollTimer = setTimeout(() => void this.tryEnroll(delay), ENROLL_MAX);
            return;
        }
        const result = await enroll(this.config.url, {
            token: this.config.token,
            uuid: this.uuid,
            hostname: os.hostname(),
            agentVersion: AGENT_VERSION,
            ...(normalizeComment(this.config.comment) ? { comment: normalizeComment(this.config.comment) } : {}),
        });
        if (result.kind === 'ok') {
            this.creds = result.creds;
            await writeFile(join(this.config.dataDir, 'device.json'), JSON.stringify(result.creds), { mode: 0o600 });
            this.log.info(`Enrolled as device ${result.creds.deviceId} (asset ${result.creds.assetId})`);
            this.connect();
            return;
        }
        // a rejected token stays rejected until someone sets a new one; ask again rarely, a network error sooner
        const next = result.kind === 'rejected' ? ENROLL_MAX : Math.min(delay * 2, ENROLL_MAX);
        this.log.warn(`Enrollment ${result.kind === 'rejected' ? 'rejected' : 'failed'}: ${result.reason}; next attempt in ${Math.round(next / 1000)} s`);
        this.enrollTimer = setTimeout(() => void this.tryEnroll(next), next);
    }

    private connect(): void {
        const creds = this.creds!;
        const transport = new Transport(creds, { keepalive: 60, log: this.log });
        this.transport = transport;
        transport.on('connected', () => {
            this.log.info(`Connected to ${creds.mqttUrl}`);
            void this.sendState();
            void this.collect(true);
        });
        transport.on('disconnected', () => this.log.info('Disconnected from the broker'));
        transport.on('rejected', reason => {
            this.log.error(
                `The broker rejects this device (${reason}): it was revoked in the portal. To enroll again, delete ${join(this.config.dataDir, 'device.json')} and set a new BEE_TOKEN.`,
            );
        });
        transport.on('job', job => void this.onJob(job));
        transport.start();
        this.timers.push(setInterval(() => void this.sendState(), this.config.heartbeat * 1000));
        this.timers.push(setInterval(() => void this.collect(false), this.config.check * 1000));
        if (this.config.aptUpdate > 0) {
            // the first time a few minutes after the start, not together with everything else
            const first = setTimeout(() => void this.aptUpdate(), 3 * MIN);
            this.timers.push(first, setInterval(() => void this.aptUpdate(), this.config.aptUpdate * 3600_000));
        }
    }

    private async sendState(): Promise<void> {
        const [mem, root, temp] = await Promise.all([
            memInfo(),
            statfs('/').catch(() => null),
            temperature(),
        ]);
        const st: StateMessage = {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            online: true,
            agentVersion: AGENT_VERSION,
            uptime: Math.round(os.uptime()),
            load: Math.round(os.loadavg()[0] * 100) / 100,
            memFree: mem.available,
            ...(root ? { diskFree: root.bavail * root.bsize } : {}),
            ...(temp !== undefined ? { temperature: temp } : {}),
        };
        await this.transport?.publish('state', st);
    }

    /** Loads the lists of packages again (sudo), then reads the updates */
    private async aptUpdate(): Promise<void> {
        const abilities = this.extras?.abilities ?? (await this.root.abilities());
        if (!abilities.apt || this.upgrading) {
            return;
        }
        const error = await this.root.aptUpdate();
        if (error) {
            this.log.warn(`apt-get update: ${error}`);
            return;
        }
        this.aptUpdatedAt = Date.now();
        this.apt = null;
        await this.collect(false);
    }

    /** Runs the checks, looks at the system and sends the inventory when it changed (always with force) */
    collect(force: boolean): Promise<void> {
        this.collecting ??= (async () => {
            try {
                const now = Date.now();
                this.static ??= { distro: (await osRelease()).pretty, model: await machineModel() };
                if (force || !this.extras || now - this.extras.at > EXTRAS_EVERY) {
                    const [abilities, pm2, docker] = await Promise.all([this.root.abilities(), this.root.pm2(), this.root.docker()]);
                    this.extras = { at: now, abilities, pm2, docker };
                }
                if (force || !this.journal || now - this.journal.at > JOURNAL_EVERY) {
                    this.journal = { at: now, value: await journalSummary() };
                }
                if (this.extras.abilities.update && (!this.latest || now - this.latest.at > LATEST_EVERY)) {
                    this.latest = { at: now, value: await lookUpLatest() };
                }
                if (force || !this.apt || now - this.apt.at > APT_LIST_EVERY) {
                    this.apt = { at: now, value: await osUpdates(this.aptUpdatedAt) };
                }
                const [mem, fs, failed, ntp, results] = await Promise.all([
                    memInfo(),
                    mounts(),
                    failedUnits(),
                    ntpSynced(),
                    runChecks(this.checks?.list ?? [], this.results, now),
                ]);
                this.results = results;
                const inv = buildInventory({
                    uuid: this.uuid,
                    config: this.config,
                    console: this.consoleReady(),
                    ai: this.config.ai,
                    c: {
                        distro: this.static.distro,
                        model: this.static.model,
                        memTotal: mem.total,
                        swapTotal: mem.swapTotal,
                        abilities: this.extras.abilities,
                        ...(this.apt.value ? { osUpdates: this.apt.value } : {}),
                        linux: {
                            mounts: fs,
                            failedUnits: failed,
                            ntpSynced: ntp,
                            checksHash: this.checks?.hash ?? null,
                            checks: results,
                            journal: this.journal.value,
                            pm2: this.extras.pm2,
                            docker: this.extras.docker,
                            sudo: { apt: this.extras.abilities.apt, reboot: this.extras.abilities.reboot },
                            ...(this.extras.abilities.update ? { agentLatest: this.latest?.value ?? null } : {}),
                        },
                    },
                });
                const text = JSON.stringify(inv);
                if (!force && text === this.lastInventory) {
                    return;
                }
                const sent = await this.transport?.publish('inventory', {
                    v: PROTOCOL_VERSION,
                    ts: Date.now(),
                    seq: ++this.seq,
                    type: 'full',
                    data: inv,
                });
                if (sent) {
                    this.lastInventory = text;
                }
            } catch (e) {
                this.log.warn(`Collecting failed: ${e.message}`);
            } finally {
                this.collecting = null;
            }
        })();
        return this.collecting;
    }

    private reply(ref: string, state: ReplyMessage['state'], message?: string): Promise<boolean> {
        return this.transport?.publish('reply', {
            v: PROTOCOL_VERSION,
            ts: Date.now(),
            ref,
            state,
            ...(message ? { message } : {}),
        } satisfies ReplyMessage) ?? Promise.resolve(false);
    }

    private async onJob(job: JobMessage): Promise<void> {
        switch (job.cmd) {
            case 'resync':
            case 'refresh':
                this.journal = null;
                this.apt = null;
                this.extras = null;
                await this.collect(true);
                return;
            case 'tunnel':
                if (job.tunnel) {
                    this.openTunnel(job.tunnel);
                }
                return;
            case 'checks':
                if (job.checks) {
                    await this.setChecks(job.checks);
                }
                return;
            case 'osUpgrade':
                if (job.ref) {
                    await this.osUpgrade(job);
                }
                return;
            case 'reboot':
                if (job.ref) {
                    await this.reboot(job);
                }
                return;
            case 'agentUpdate':
                if (job.ref) {
                    await this.agentUpdate(job);
                }
                return;
            case 'diagnose':
                if (job.ref) {
                    await this.diagnose(job);
                }
                return;
            case 'unit':
                if (job.ref) {
                    await this.unit(job);
                }
                return;
            case 'mcp':
                if (job.ref && job.mcp) {
                    await this.mcp(job.ref, job.mcp);
                }
                return;
        }
        if (job.ref) {
            await this.reply(job.ref, 'error', `bee-linux kennt den Befehl ${job.cmd} nicht`);
        }
    }

    /** A request of an AI session: only with the consent of the owner, and only until the session ends */
    private async mcp(ref: string, m: McpRequest): Promise<void> {
        if (!this.config.ai) {
            await this.reply(ref, 'error', 'Der KI-Zugang ist auf dem Server nicht erlaubt (BEE_AI=true in /etc/bee-linux/bee-linux.env)');
            return;
        }
        if (typeof m.expiresAt !== 'number' || m.expiresAt < Date.now()) {
            await this.reply(ref, 'error', 'Die KI-Sitzung ist abgelaufen');
            return;
        }
        const tools = this.tools.map(t => t.def);
        switch (m.action) {
            case 'open':
                this.aiSessions.set(m.session, m.by);
                this.log.info(`AI session ${m.session} of ${m.by} until ${new Date(m.expiresAt).toISOString()}: ${m.purpose}`);
                await this.publishMcp(ref, { tools });
                return;
            case 'tools':
                await this.publishMcp(ref, { tools });
                return;
            case 'close':
                this.aiSessions.delete(m.session);
                this.log.info(`AI session ${m.session} ended`);
                await this.publishMcp(ref, {});
                return;
            case 'call': {
                if (typeof m.tool !== 'string') {
                    await this.reply(ref, 'error', 'Werkzeug fehlt');
                    return;
                }
                this.log.info(`AI session ${m.session} (${m.by}): ${m.tool}`);
                const result = await callTool(this.tools, m.tool, (m.args ?? {}) as Record<string, unknown>);
                await this.publishMcp(ref, { result });
                return;
            }
        }
        await this.reply(ref, 'error', `Unbekannte Aktion ${String(m.action)}`);
    }

    private publishMcp(ref: string, mcp: NonNullable<ReplyMessage['mcp']>): Promise<boolean> {
        return (
            this.transport?.publish('reply', { v: PROTOCOL_VERSION, ts: Date.now(), ref, state: 'done', mcp } satisfies ReplyMessage) ??
            Promise.resolve(false)
        );
    }

    private async setChecks(c: { hash: string; list: CheckSpec[] }): Promise<void> {
        if (typeof c.hash !== 'string' || !Array.isArray(c.list)) {
            return;
        }
        for (const spec of c.list) {
            const invalid = invalidCheck(spec);
            if (invalid) {
                this.log.warn(`Check ${spec?.name ?? spec?.id}: ${invalid}`);
            }
        }
        this.checks = { hash: c.hash, list: c.list };
        await this.saveChecks(this.checks).catch(e => this.log.warn(`Checks not saved: ${e.message}`));
        this.log.info(`${c.list.length} checks from the portal`);
        await this.collect(false);
    }

    private async osUpgrade(job: JobMessage): Promise<void> {
        const ref = job.ref!;
        const req = job.osUpgrade;
        const listed = this.apt?.value?.packages ?? [];
        const wanted = Array.isArray(req?.packages) ? req.packages : [];
        const unknown = wanted.filter(p => typeof p !== 'string' || !PACKAGE_NAME.test(p) || !listed.some(l => l.name === p));
        if (this.upgrading || this.updating) {
            await this.reply(ref, 'error', 'Es läuft schon ein Update');
            return;
        }
        if (!wanted.length || unknown.length) {
            await this.reply(ref, 'error', wanted.length ? `Nicht als aktualisierbar bekannt: ${unknown.join(', ')}` : 'Keine Pakete');
            return;
        }
        if (!this.extras?.abilities.apt) {
            await this.reply(ref, 'error', 'bee-linux darf keine Pakete aktualisieren (/etc/bee-linux/root.conf, APT=1)');
            return;
        }
        this.upgrading = true;
        this.log.info(`Upgrade of ${wanted.length} packages for ${job.by ?? '?'}: ${wanted.join(' ')}`);
        await this.reply(ref, 'running', `${wanted.length} Pakete werden aktualisiert`);
        let output = '';
        let code: number | null;
        try {
            code = await this.root.aptUpgrade(wanted, text => {
                output = (output + text).slice(-64 * 1024);
            });
        } finally {
            this.upgrading = false;
        }
        this.apt = null;
        await this.collect(false);
        const tail = output.trim().slice(-MAX_REPLY_TEXT);
        if (code !== 0) {
            this.log.warn(`Upgrade failed (${code ?? 'not started'})`);
            await this.reply(ref, 'error', `apt-get endete mit ${code ?? 'Fehler'}\n${tail}`);
            return;
        }
        if (req?.reboot) {
            const error = await this.root.reboot();
            await this.reply(ref, error ? 'error' : 'done', error ? `Aktualisiert, Neustart fehlgeschlagen: ${error}\n${tail}` : `Aktualisiert, Server startet neu\n${tail}`);
            return;
        }
        await this.reply(ref, 'done', tail);
    }

    /** Details for a deviation a person clicked on in the portal: only reading, fixed per code (diagnose.ts) */
    private async diagnose(job: JobMessage): Promise<void> {
        const ref = job.ref!;
        const code = job.diagnose?.code;
        const subject = job.diagnose?.subject;
        if (typeof code !== 'string' || !/^[a-z0-9-]{1,40}$/.test(code) || (subject !== undefined && (typeof subject !== 'string' || !SUBJECT.test(subject)))) {
            await this.reply(ref, 'error', 'Ungültige Anfrage');
            return;
        }
        this.log.info(`Details for ${code}${subject ? ` ${subject}` : ''} for ${job.by ?? '?'}`);
        const d = await diagnose(this.tools, code, subject, this.checks?.list ?? []);
        await this.transport?.publish('reply', { v: PROTOCOL_VERSION, ts: Date.now(), ref, state: 'done', text: d.text } satisfies ReplyMessage);
    }

    /** Restarts a failed unit, or clears its failed state (the helper allows only failed units) */
    private async unit(job: JobMessage): Promise<void> {
        const ref = job.ref!;
        const name = job.unit?.name;
        const action = job.unit?.action;
        if (typeof name !== 'string' || !UNIT_NAME.test(name) || (action !== 'restart' && action !== 'reset-failed')) {
            await this.reply(ref, 'error', 'Ungültige Anfrage');
            return;
        }
        if (!this.extras?.abilities.services) {
            await this.reply(ref, 'error', 'bee-linux darf keine Dienste neu starten (SERVICES=1 in /etc/bee-linux/root.conf)');
            return;
        }
        this.log.info(`${action} of ${name} for ${job.by ?? '?'}`);
        await this.reply(ref, 'running', action === 'restart' ? `${name} wird neu gestartet` : `Fehlerstatus von ${name} wird zurückgesetzt`);
        const r = await this.root.unit(action, name);
        await this.collect(false);
        await this.reply(ref, r.ok ? 'done' : 'error', r.text || (r.ok ? 'erledigt' : 'fehlgeschlagen'));
    }

    /** Installs the newest bee-linux through the helper; install.sh restarts this agent a moment later */
    private async agentUpdate(job: JobMessage): Promise<void> {
        const ref = job.ref!;
        if (this.upgrading || this.updating) {
            await this.reply(ref, 'error', 'Es läuft gerade ein Update');
            return;
        }
        if (!this.extras?.abilities.update) {
            await this.reply(ref, 'error', 'bee-linux darf sich nicht selbst aktualisieren (UPDATE=1 in /etc/bee-linux/root.conf)');
            return;
        }
        this.updating = true;
        this.log.info(`Update of bee-linux for ${job.by ?? '?'}`);
        await this.reply(ref, 'running', 'bee-linux wird heruntergeladen');
        const r = await this.root.selfUpdate();
        if ('error' in r) {
            this.updating = false;
            this.log.warn(`Update failed: ${r.error}`);
            await this.reply(ref, 'error', `Update fehlgeschlagen: ${r.error}`);
            return;
        }
        this.log.info(`Installing bee-linux ${r.version}, restart follows`);
        await this.reply(
            ref,
            'done',
            `bee-linux ${r.version} wird installiert (${AGENT_VERSION} vorher); der Agent startet gleich neu. Log: /var/log/bee-linux/update.log`,
        );
    }

    private async reboot(job: JobMessage): Promise<void> {
        const ref = job.ref!;
        if (this.upgrading || this.updating) {
            await this.reply(ref, 'error', 'Es läuft gerade ein Update');
            return;
        }
        this.log.info(`Reboot for ${job.by ?? '?'}`);
        const error = await this.root.reboot();
        await this.reply(ref, error ? 'error' : 'done', error ? `Neustart fehlgeschlagen: ${error}` : 'Server startet neu');
    }

    private openTunnel(req: TunnelRequest): void {
        const creds = this.creds!;
        if (!trustedTunnelUrl(req.url, [this.config.url, creds.mqttUrl])) {
            this.log.warn(`Remote access ${req.id}: tunnel address ${req.url} is not the own server, ignored`);
            return;
        }
        const refusal =
            req.kind !== 'console'
                ? `bee-linux bietet nur die Konsole an, nicht ${req.kind}`
                : !this.config.console
                  ? 'Die Konsole ist am Server nicht freigegeben (BEE_CONSOLE in /etc/bee-linux/bee-linux.env)'
                  : !findScript()
                    ? 'Die Konsole braucht script (util-linux) auf dem Server'
                    : null;
        this.tunnels.get(req.id)?.stop('replaced');
        const client = new TunnelClient(req, {
            target: null,
            ...(!refusal ? { handler: (stream: TunnelStream) => this.openShell(req, stream) } : {}),
            refusal,
            ca: trustedCas(creds.ca),
            log: this.log,
            onEnd: (c, reason) => {
                if (this.tunnels.get(c.req.id) === c) {
                    this.tunnels.delete(c.req.id);
                    this.shells.delete(c.req.id);
                }
                if (!refusal) {
                    this.log.info(`Remote access ${c.req.id} ended (${reason}), ${Math.round(c.bytes / 1024)} KB`);
                }
            },
        });
        if (refusal) {
            this.log.info(`Remote access ${req.id} for ${req.by} refused: ${refusal}`);
        } else {
            this.tunnels.set(req.id, client);
            this.log.info(`Console ${req.id} for ${req.by} until ${new Date(req.expiresAt).toISOString()}: ${req.purpose}`);
        }
        client.start();
    }

    private consoleReady(): boolean {
        return this.config.console && !!findScript();
    }

    /** One shell for a stream of a console session, at most MAX_SHELLS at the same time */
    private openShell(req: TunnelRequest, stream: TunnelStream): void {
        const running = this.shells.get(req.id) ?? 0;
        if (running >= MAX_SHELLS) {
            stream.end(
                Buffer.concat([
                    consoleMessage(CONSOLE.DATA, Buffer.from(`Höchstens ${MAX_SHELLS} Shells je Sitzung.\r\n`)),
                    consoleMessage(CONSOLE.EXIT, Buffer.from('zu viele Shells')),
                ]),
            );
            return;
        }
        this.shells.set(req.id, running + 1);
        startShell(stream, {
            cwd: os.homedir(),
            log: this.log,
            by: req.by,
            onEnd: () => {
                const n = (this.shells.get(req.id) ?? 1) - 1;
                if (n > 0) {
                    this.shells.set(req.id, n);
                } else {
                    this.shells.delete(req.id);
                }
            },
        });
    }
}
