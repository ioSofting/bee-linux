import { constants } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { CheckSpec, McpTool } from './lib/protocol.js';
import { parseUpgradeable } from './apt.js';
import { hostPort, runCheck, UNIT_NAME } from './checks.js';
import type { Root } from './root.js';
import { failedUnits, memInfo, mounts, ntpSynced, osRelease } from './system.js';
import { run } from './run.js';

/**
 * Tools of the AI access on a Linux server (command 'mcp'). All of them only read, as the user of bee-linux; what
 * needs root (logs of Docker and pm2, nginx -t, certbot certificates) goes through the helper, if root.conf allows it
 * (LOGS=1). No shell and no free command line: every argument is checked, and goes to a program as one argument.
 */

/** Longest text of one tool result; the protocol allows more, the AI reads less */
export const MAX_TOOL_TEXT = 200 * 1024;
/** Lines a log tool returns at most */
const MAX_LINES = 2000;
/** Largest log file read (compressed ones after unpacking) */
const MAX_FILE = 64 * 1024 * 1024;
/** Log files the AI may read: below this folder only */
export const LOG_ROOT = '/var/log';

export class ToolError extends Error {}

export interface ToolResult {
    text: string;
    isError: boolean;
    truncated?: boolean;
}

type Args = Record<string, unknown>;

const str = (a: Args, key: string): string | undefined => (typeof a[key] === 'string' && (a[key] as string).trim() ? (a[key] as string).trim() : undefined);

function lines(a: Args, def = 200): number {
    const n = Number(a.lines ?? def);
    return Number.isFinite(n) ? Math.max(1, Math.min(MAX_LINES, Math.round(n))) : def;
}

function unit(a: Args, key = 'unit', required = true): string | undefined {
    const u = str(a, key);
    if (!u) {
        if (required) {
            throw new ToolError(`${key} fehlt`);
        }
        return undefined;
    }
    if (!UNIT_NAME.test(u)) {
        throw new ToolError(`Ungültiger Name einer Unit: ${u}`);
    }
    return u;
}

/** A regular expression from the AI, case-insensitive; null: none given */
function pattern(a: Args): RegExp | null {
    const g = str(a, 'grep');
    if (!g) {
        return null;
    }
    if (g.length > 300) {
        throw new ToolError('grep: höchstens 300 Zeichen');
    }
    try {
        return new RegExp(g, 'i');
    } catch {
        throw new ToolError(`grep ist kein gültiger regulärer Ausdruck: ${g}`);
    }
}

/** Times as journalctl takes them: "-2h", "-30min", "today", "yesterday", "2026-11-15 08:00" */
export const JOURNAL_TIME = /^(-?\d{1,5}\s?(s|sec|min|m|h|d|day|days|w|weeks?)|now|today|yesterday|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)$/;

function journalTime(a: Args, key: string): string | undefined {
    const t = str(a, key);
    if (t && !JOURNAL_TIME.test(t)) {
        throw new ToolError(`${key}: Zeit wie "-2h", "-30min", "today" oder "2026-11-15 08:00"`);
    }
    return t;
}

const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

function tail(text: string, n: number, re: RegExp | null): string {
    let all = text.split('\n');
    if (all.length && all[all.length - 1] === '') {
        all.pop();
    }
    if (re) {
        all = all.filter(l => re.test(l));
    }
    const out = all.slice(-n);
    return `${all.length > n ? `[${all.length - n} ältere Zeilen ausgelassen]\n` : ''}${out.join('\n')}`;
}

function bytes(n: number): string {
    return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

function duration(sec: number): string {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d ? `${d} d ` : ''}${h} h ${m} min`;
}

/** Output of a program, or its error as text */
async function program(file: string, args: string[], timeout = 30_000): Promise<string> {
    const r = await run(file, args, { timeout });
    if (r.error) {
        throw new ToolError(r.error === 'ENOENT' ? `${file} ist auf dem Server nicht installiert` : `${file}: ${r.error}`);
    }
    return (r.stdout + (r.code !== 0 && r.stderr ? `\n${r.stderr}` : '')).trim();
}

/** A path below /var/log, after resolving links; otherwise an error */
export async function logPath(path: string): Promise<string> {
    if (!path.startsWith('/')) {
        throw new ToolError('Pfad muss absolut sein, z. B. /var/log/nginx/error.log');
    }
    let real: string;
    try {
        real = await realpath(path);
    } catch (e) {
        throw new ToolError((e as NodeJS.ErrnoException).code === 'ENOENT' ? `${path} gibt es nicht` : `${path}: ${(e as Error).message}`);
    }
    if (real !== LOG_ROOT && !real.startsWith(`${LOG_ROOT}/`)) {
        throw new ToolError(`Nur Dateien unter ${LOG_ROOT}; für den Rest read_journal`);
    }
    return real;
}

export interface Tool {
    def: McpTool;
    run: (args: Args) => Promise<string>;
}

export function buildTools(deps: { root: Root; rootLogs: () => boolean }): Tool[] {
    const ro = { readOnlyHint: true, openWorldHint: false };
    const tools: Tool[] = [
        {
            def: {
                name: 'overview',
                title: 'Server overview',
                description:
                    'Distribution, kernel, uptime, load, memory, swap, filesystems, failed units of systemd, clock and pending updates of the server.',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: async () => {
                const [rel, mem, fs, failed, ntp, apt] = await Promise.all([
                    osRelease(),
                    memInfo(),
                    mounts(),
                    failedUnits(),
                    ntpSynced(),
                    run('apt', ['list', '--upgradeable'], { timeout: 60_000 }),
                ]);
                const [l1, l5, l15] = os.loadavg();
                const updates = apt.code === 0 ? parseUpgradeable(apt.stdout) : null;
                return [
                    `Host: ${os.hostname()}`,
                    `System: ${rel.pretty}, Kernel ${os.release()}, ${os.arch()}`,
                    `Uptime: ${duration(os.uptime())}`,
                    `Last: ${l1.toFixed(2)} / ${l5.toFixed(2)} / ${l15.toFixed(2)} bei ${os.cpus().length} CPU`,
                    `Speicher: ${bytes(mem.available)} verfügbar von ${bytes(mem.total)}; Swap ${bytes(mem.swapTotal - mem.swapFree)} belegt von ${bytes(mem.swapTotal)}`,
                    'Dateisysteme:',
                    ...fs.map(m => `  ${m.path} (${m.device}, ${m.fstype}) ${bytes(m.size)}, ${m.usedPct} % belegt, Inodes ${m.inodesPct ?? '–'} %`),
                    `Fehlgeschlagene Units: ${failed.length ? failed.join(', ') : 'keine'}`,
                    `Uhr synchronisiert: ${ntp === null ? 'unbekannt' : ntp ? 'ja' : 'nein'}`,
                    `Updates: ${updates ? `${updates.length} (davon Sicherheit: ${updates.filter(p => p.security).length})` : 'unbekannt'}`,
                ].join('\n');
            },
        },
        {
            def: {
                name: 'list_services',
                title: 'Services',
                description: 'Services of systemd with their state. state: "failed", "running", "all" (default: all loaded services).',
                inputSchema: {
                    type: 'object',
                    properties: { state: { type: 'string', enum: ['all', 'running', 'failed', 'inactive'] } },
                },
                annotations: ro,
            },
            run: async a => {
                const state = str(a, 'state') ?? 'all';
                const args = ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager'];
                if (['running', 'failed', 'inactive'].includes(state)) {
                    args.push(`--state=${state}`);
                }
                return (await program('systemctl', args)) || 'keine';
            },
        },
        {
            def: {
                name: 'list_timers',
                title: 'Timers',
                description: 'Timers of systemd: when each ran last and runs next (e.g. certbot.timer, apt-daily, logrotate).',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: () => program('systemctl', ['list-timers', '--all', '--no-pager']),
        },
        {
            def: {
                name: 'service_status',
                title: 'State of a unit',
                description:
                    'State of one unit of systemd (service, timer, socket): active state, result, exit code, restarts, start time, and its last journal lines.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        unit: { type: 'string', description: 'e.g. "nginx", "certbot.service", "certbot.timer"' },
                        lines: { type: 'number', description: 'journal lines (default 30)' },
                    },
                    required: ['unit'],
                },
                annotations: ro,
            },
            run: async a => {
                const u = unit(a)!;
                const props = await program('systemctl', [
                    'show',
                    u,
                    '--no-pager',
                    '-p',
                    'Id,Description,LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,ActiveEnterTimestamp,InactiveEnterTimestamp,NRestarts,MainPID,MemoryCurrent,FragmentPath,TriggeredBy,Triggers,UnitFileState',
                ]);
                const log = await program('journalctl', ['-u', u, '-n', String(lines(a, 30)), '-o', 'short-iso', '--no-pager', '-q']);
                return `${props}\n\nJournal:\n${log || '(keine Einträge)'}`;
            },
        },
        {
            def: {
                name: 'read_journal',
                title: 'Read the journal',
                description:
                    'Lines of the journal of systemd, newest last. Filter by unit, priority (err and worse: "err"), time (since/until like "-2h", "today", ' +
                    '"2026-11-15 08:00"), kernel messages, and a regular expression (grep, case-insensitive).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        unit: { type: 'string' },
                        priority: { type: 'string', enum: PRIORITIES },
                        since: { type: 'string', description: 'default -1h' },
                        until: { type: 'string' },
                        kernel: { type: 'boolean' },
                        grep: { type: 'string' },
                        lines: { type: 'number', description: 'default 200, at most 2000' },
                    },
                },
                annotations: ro,
            },
            run: async a => {
                const u = unit(a, 'unit', false);
                const priority = str(a, 'priority');
                if (priority && !PRIORITIES.includes(priority)) {
                    throw new ToolError(`priority: eins von ${PRIORITIES.join(', ')}`);
                }
                const since = journalTime(a, 'since') ?? '-1h';
                const until = journalTime(a, 'until');
                const re = pattern(a);
                const n = lines(a);
                const args = ['-o', 'short-iso', '--no-pager', '-q', `--since=${since}`, '-n', String(re ? 50_000 : n)];
                if (until) {
                    args.push(`--until=${until}`);
                }
                if (u) {
                    args.push('-u', u);
                }
                if (priority) {
                    args.push('-p', priority);
                }
                if (a.kernel === true) {
                    args.push('-k');
                }
                return tail(await program('journalctl', args, 60_000), n, re) || '(keine Einträge)';
            },
        },
        {
            def: {
                name: 'list_log_files',
                title: 'Log files',
                description: `Log files below ${LOG_ROOT} (size, time, readable for bee-linux), e.g. of nginx, apt, letsencrypt.`,
                inputSchema: { type: 'object', properties: { dir: { type: 'string', description: `a folder below ${LOG_ROOT}` } } },
                annotations: ro,
            },
            run: async a => {
                const dir = await logPath(str(a, 'dir') ?? LOG_ROOT);
                const out: string[] = [];
                const walk = async (d: string, depth: number): Promise<void> => {
                    let names: string[];
                    try {
                        names = (await readdir(d)).sort();
                    } catch {
                        out.push(`${d}/ (nicht lesbar)`);
                        return;
                    }
                    for (const name of names) {
                        const p = join(d, name);
                        const s = await stat(p).catch(() => null);
                        if (!s) {
                            continue;
                        }
                        if (s.isDirectory()) {
                            if (depth < 3) {
                                await walk(p, depth + 1);
                            }
                        } else if (s.isFile()) {
                            const readable = await access(p, constants.R_OK).then(
                                () => true,
                                () => false,
                            );
                            out.push(`${p}  ${s.size} B  ${new Date(s.mtimeMs).toISOString().slice(0, 16)}${readable ? '' : '  (nicht lesbar)'}`);
                        }
                        if (out.length >= 500) {
                            return;
                        }
                    }
                };
                await walk(dir, 0);
                return out.join('\n') || 'keine Dateien';
            },
        },
        {
            def: {
                name: 'read_log_file',
                title: 'Read a log file',
                description: `The end of a log file below ${LOG_ROOT} (also .gz), optionally only lines matching grep (regular expression).`,
                inputSchema: {
                    type: 'object',
                    properties: { path: { type: 'string' }, lines: { type: 'number' }, grep: { type: 'string' } },
                    required: ['path'],
                },
                annotations: ro,
            },
            run: async a => {
                const path = await logPath(str(a, 'path') ?? '');
                const s = await stat(path);
                if (!s.isFile()) {
                    throw new ToolError(`${path} ist keine Datei`);
                }
                if (s.size > MAX_FILE) {
                    throw new ToolError(`${path} ist zu groß (${bytes(s.size)})`);
                }
                let buf: Buffer;
                try {
                    buf = await readFile(path);
                } catch (e) {
                    throw new ToolError((e as NodeJS.ErrnoException).code === 'EACCES' ? `${path}: kein Lesezugriff für bee-linux` : (e as Error).message);
                }
                if (path.endsWith('.gz')) {
                    buf = gunzipSync(buf, { maxOutputLength: MAX_FILE });
                }
                return tail(buf.toString('utf8'), lines(a), pattern(a)) || '(leer)';
            },
        },
        {
            def: {
                name: 'list_processes',
                title: 'Processes',
                description: 'The processes using the most CPU or memory: pid, user, CPU %, memory %, resident size, running time, name (no command lines).',
                inputSchema: {
                    type: 'object',
                    properties: { sort: { type: 'string', enum: ['cpu', 'mem'] }, limit: { type: 'number', description: 'default 25' } },
                },
                annotations: ro,
            },
            run: async a => {
                const by = str(a, 'sort') === 'mem' ? '-pmem' : '-pcpu';
                const limit = Math.max(1, Math.min(200, Math.round(Number(a.limit ?? 25)) || 25));
                const text = await program('ps', ['-eo', 'pid,user:16,pcpu,pmem,rss,etime,comm', `--sort=${by}`]);
                return text.split('\n').slice(0, limit + 1).join('\n');
            },
        },
        {
            def: {
                name: 'listening_ports',
                title: 'Listening ports',
                description: 'TCP and UDP ports the server listens on, with their address (without the processes: those need root).',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: () => program('ss', ['-tuln']),
        },
        {
            def: {
                name: 'network',
                title: 'Network',
                description: 'Addresses of the interfaces, routes and name servers of the server.',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: async () => {
                const [addr, route, resolv] = await Promise.all([
                    program('ip', ['-br', 'addr']).catch(e => String(e.message)),
                    program('ip', ['route']).catch(e => String(e.message)),
                    readFile('/etc/resolv.conf', 'utf8').catch(() => ''),
                ]);
                const ns = resolv.split('\n').filter(l => /^\s*(nameserver|search)\b/.test(l));
                return `Interfaces:\n${addr}\n\nRouten:\n${route}\n\nDNS:\n${ns.join('\n') || '–'}`;
            },
        },
        {
            def: {
                name: 'test_connection',
                title: 'Test a connection',
                description:
                    'Tests from the server once, as the checks do: tcp (host:port answers), http (an http(s) address: status, optionally a text in the body), ' +
                    'cert (TLS certificate of host:port: valid, until when).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        kind: { type: 'string', enum: ['tcp', 'http', 'cert'] },
                        target: { type: 'string', description: 'host:port, or the address for http' },
                        text: { type: 'string', description: 'http: text the body must contain' },
                    },
                    required: ['kind', 'target'],
                },
                annotations: { readOnlyHint: true, openWorldHint: true },
            },
            run: async a => {
                const kind = str(a, 'kind') as CheckSpec['kind'];
                const target = str(a, 'target') ?? '';
                if (!['tcp', 'http', 'cert'].includes(kind)) {
                    throw new ToolError('kind: tcp, http oder cert');
                }
                if (kind !== 'http' && !hostPort(target)) {
                    throw new ToolError('target als host:port');
                }
                const r = await runCheck({ id: 'test', name: 'test', kind, target, ...(str(a, 'text') ? { text: str(a, 'text') } : {}) });
                return `${r.state}: ${r.text}`;
            },
        },
        {
            def: {
                name: 'package_updates',
                title: 'Package updates',
                description: 'Packages of apt that can be upgraded (security updates marked), and whether the server waits for a reboot.',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: async () => {
                const r = await run('apt', ['list', '--upgradeable'], { timeout: 60_000 });
                if (r.code !== 0) {
                    throw new ToolError(r.error === 'ENOENT' ? 'kein apt auf diesem Server' : r.stderr.trim());
                }
                const list = parseUpgradeable(r.stdout);
                const reboot = await stat('/var/run/reboot-required').then(
                    () => true,
                    () => false,
                );
                return `${list.length ? list.map(p => `${p.name} ${p.from ?? '?'} -> ${p.version ?? '?'}${p.security ? ' [Sicherheit]' : ''}`).join('\n') : 'keine Updates'}\nNeustart nötig: ${reboot ? 'ja' : 'nein'}`;
            },
        },
        {
            def: {
                name: 'package_info',
                title: 'Package',
                description: 'Installed and available versions of a package of apt (apt-cache policy) and its state (dpkg).',
                inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
                annotations: ro,
            },
            run: async a => {
                const name = str(a, 'name') ?? '';
                if (!/^[a-z0-9][a-z0-9+.-]*(:[a-z0-9]+)?$/.test(name)) {
                    throw new ToolError('Ungültiger Paketname');
                }
                const [policy, status] = await Promise.all([
                    program('apt-cache', ['policy', name]),
                    program('dpkg-query', ['-W', '-f=${Status} ${Version}\n', name]).catch(e => String(e.message)),
                ]);
                return `${policy || `${name}: unbekannt`}\n\ndpkg: ${status || 'nicht installiert'}`;
            },
        },
    ];

    // through the helper, with LOGS=1 in root.conf
    const viaRoot = async (args: string[], what: string): Promise<string> => {
        if (!deps.rootLogs()) {
            throw new ToolError(`${what} braucht root: auf dem Server LOGS=1 in /etc/bee-linux/root.conf (install.sh --logs)`);
        }
        const r = await deps.root.read(args);
        if (r.code !== 0 && !r.stdout.trim()) {
            throw new ToolError((r.stderr || r.error || `Ende mit ${r.code}`).trim().slice(-2000));
        }
        return (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();
    };
    const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
    tools.push(
        {
            def: {
                name: 'docker_containers',
                title: 'Docker containers',
                description: 'Containers of Docker: name, image, state and status (through the helper of bee-linux, DOCKER=1).',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: async () => {
                const list = await deps.root.docker();
                if (!list) {
                    throw new ToolError('Docker nicht erlaubt oder nicht installiert (DOCKER=1 in /etc/bee-linux/root.conf)');
                }
                return list.map(c => `${c.name}  ${c.image}  ${c.state}${c.health ? ` (${c.health})` : ''}${c.exitCode !== undefined ? ` exit ${c.exitCode}` : ''}`).join('\n') || 'keine Container';
            },
        },
        {
            def: {
                name: 'docker_logs',
                title: 'Logs of a container',
                description: 'The last lines of the log of a Docker container (needs LOGS=1 and DOCKER=1 in root.conf).',
                inputSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' }, lines: { type: 'number' }, since: { type: 'string', description: 'e.g. "2h", "30m"' }, grep: { type: 'string' } },
                    required: ['name'],
                },
                annotations: ro,
            },
            run: async a => {
                const name = str(a, 'name') ?? '';
                if (!NAME.test(name)) {
                    throw new ToolError('Ungültiger Name eines Containers');
                }
                const since = str(a, 'since');
                if (since && !/^\d{1,5}[smhd]$/.test(since)) {
                    throw new ToolError('since wie "30m", "2h", "1d"');
                }
                const re = pattern(a);
                const n = lines(a);
                const text = await viaRoot(['docker-logs', name, String(re ? 20_000 : n), ...(since ? [since] : [])], 'docker_logs');
                return tail(text, n, re) || '(leer)';
            },
        },
        {
            def: {
                name: 'pm2_list',
                title: 'pm2 processes',
                description: 'Processes of pm2: name, status, restarts (PM2_USER in root.conf).',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: async () => {
                const list = await deps.root.pm2();
                if (!list) {
                    throw new ToolError('pm2 nicht eingerichtet (PM2_USER in /etc/bee-linux/root.conf)');
                }
                return list.map(p => `${p.name}  ${p.status}  restarts ${p.restarts}`).join('\n') || 'keine Prozesse';
            },
        },
        {
            def: {
                name: 'pm2_logs',
                title: 'Logs of a pm2 process',
                description: 'The last lines of the output and error log of a process of pm2 (needs LOGS=1 and PM2_USER in root.conf).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        stream: { type: 'string', enum: ['out', 'error'], description: 'default error' },
                        lines: { type: 'number' },
                        grep: { type: 'string' },
                    },
                    required: ['name'],
                },
                annotations: ro,
            },
            run: async a => {
                const name = str(a, 'name') ?? '';
                if (!NAME.test(name)) {
                    throw new ToolError('Ungültiger Name eines Prozesses');
                }
                const stream = str(a, 'stream') === 'out' ? 'out' : 'error';
                const re = pattern(a);
                const n = lines(a);
                return tail(await viaRoot(['pm2-logs', name, stream, String(re ? 20_000 : n)], 'pm2_logs'), n, re) || '(leer)';
            },
        },
        {
            def: {
                name: 'nginx_test',
                title: 'Test the configuration of nginx',
                description: 'nginx -t: whether the configuration of nginx is valid, with the errors (needs LOGS=1 in root.conf).',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: () => viaRoot(['nginx-test'], 'nginx_test'),
        },
        {
            def: {
                name: 'certbot_certificates',
                title: 'Certificates of certbot',
                description: 'certbot certificates: the certificates of Let\'s Encrypt on the server, their domains and expiry (needs LOGS=1 in root.conf).',
                inputSchema: { type: 'object', properties: {} },
                annotations: ro,
            },
            run: () => viaRoot(['certbot'], 'certbot_certificates'),
        },
    );
    return tools;
}

/** Runs a tool; errors of the tool come back as result with isError, so the AI reads them */
export async function callTool(tools: Tool[], name: string, args: Args): Promise<ToolResult> {
    const tool = tools.find(t => t.def.name === name);
    if (!tool) {
        return { text: `Unbekanntes Werkzeug: ${name}`, isError: true };
    }
    try {
        const text = await tool.run(args ?? {});
        return text.length > MAX_TOOL_TEXT
            ? { text: `[gekürzt, nur das Ende]\n${text.slice(-MAX_TOOL_TEXT)}`, isError: false, truncated: true }
            : { text, isError: false };
    } catch (e) {
        return { text: (e as Error).message, isError: true };
    }
}
