import type { CheckSpec } from './lib/protocol.js';
import { runCheck } from './checks.js';
import { run } from './run.js';
import { callTool, type Tool } from './tools.js';

/**
 * Details for a deviation, for a person in the portal who clicks on it (job 'diagnose'): only reading, with the
 * tools of the AI access and fixed arguments, so the portal cannot ask for anything else.
 */

/** Text of a diagnosis at most */
export const DIAGNOSE_MAX = 64 * 1024;
/** What a deviation is about: a unit, a process, a container, a path, the id of a check */
export const SUBJECT = /^[A-Za-z0-9@:._/\\-]{1,200}$/;

export interface Diagnosis {
    text: string;
}

async function section(tools: Tool[], title: string, name: string, args: Record<string, unknown>): Promise<string> {
    const r = await callTool(tools, name, args);
    return `== ${title} ==\n${r.text.trim() || '(leer)'}`;
}

async function program(title: string, file: string, args: string[]): Promise<string> {
    const r = await run(file, args, { timeout: 20_000 });
    const out = (r.stdout || r.stderr || r.error || '').trim();
    return `== ${title} ==\n${out || '(leer)'}`;
}

/**
 * Failed logins of SSH in 24 h: the sources and user names tried most, then the last lines
 *
 * @param journal lines of the journal that match a failed login
 */
export function summarizeSsh(journal: string): string {
    const ips = new Map<string, number>();
    const users = new Map<string, number>();
    let total = 0;
    for (const line of journal.split('\n')) {
        const ip = /\bfrom ((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]*:[0-9a-f:]+)\b/i.exec(line)?.[1];
        if (!ip) {
            continue;
        }
        total++;
        ips.set(ip, (ips.get(ip) ?? 0) + 1);
        const user = /(?:Invalid user|invalid user|Failed \S+ for(?: invalid user)?) (\S+) from/.exec(line)?.[1];
        if (user) {
            users.set(user, (users.get(user) ?? 0) + 1);
        }
    }
    const top = (m: Map<string, number>): string =>
        [...m]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([k, n]) => `  ${String(n).padStart(6)}  ${k}`)
            .join('\n') || '  –';
    return `${total} fehlgeschlagene Anmeldungen von ${ips.size} Adressen\n\nHäufigste Adressen:\n${top(ips)}\n\nHäufigste Nutzernamen:\n${top(users)}`;
}

/**
 * The details for one deviation
 *
 * @param code the code of the deviation (src/fleet/linux.ts of the server)
 * @param subject what it is about, checked before
 * @param checks the checks of the portal the agent runs
 */
export async function diagnose(tools: Tool[], code: string, subject: string | undefined, checks: CheckSpec[]): Promise<Diagnosis> {
    const parts: string[] = [];
    switch (code) {
        case 'unit-failed':
            parts.push(await section(tools, `Dienst ${subject}`, 'service_status', { unit: subject, lines: 80 }));
            break;
        case 'ssh-failed': {
            const r = await callTool(tools, 'read_journal', {
                since: '-24h',
                grep: 'Failed password|Failed publickey|Invalid user|authentication failure',
                lines: 2000,
            });
            parts.push(`== Fehlgeschlagene Anmeldungen (24 h) ==\n${summarizeSsh(r.text)}`);
            parts.push(`== Die letzten Zeilen ==\n${r.text.trim().split('\n').slice(-30).join('\n') || '(keine)'}`);
            parts.push(await program('Ist fail2ban aktiv?', 'systemctl', ['is-active', 'fail2ban']));
            break;
        }
        case 'kernel-errors':
            parts.push(await section(tools, 'Kernel, Fehler der letzten 24 h', 'read_journal', { kernel: true, priority: 'err', since: '-24h', lines: 200 }));
            break;
        case 'ntp':
            parts.push(await program('timedatectl', 'timedatectl', ['status']));
            parts.push(await program('Synchronisation', 'timedatectl', ['timesync-status']));
            break;
        case 'disk-full':
        case 'disk-low':
        case 'disk-trend':
            parts.push(await program('Belegung der Dateisysteme', 'df', ['-h', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs']));
            parts.push(await section(tools, 'Größte Log-Ordner', 'list_log_files', {}));
            break;
        case 'inodes-full':
            parts.push(await program('Inodes der Dateisysteme', 'df', ['-i', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs']));
            break;
        case 'pm2':
            parts.push(await section(tools, 'Prozesse von pm2', 'pm2_list', {}));
            parts.push(await section(tools, `Fehler-Log von ${subject}`, 'pm2_logs', { name: subject, stream: 'error', lines: 80 }));
            break;
        case 'docker':
            parts.push(await section(tools, 'Container', 'docker_containers', {}));
            parts.push(await section(tools, `Log von ${subject}`, 'docker_logs', { name: subject, lines: 100 }));
            break;
        case 'check':
        case 'check-warn': {
            const spec = checks.find(c => c.id === subject);
            if (!spec) {
                parts.push('Diese Prüfung kennt der Agent nicht (mehr).');
                break;
            }
            const r = await runCheck(spec);
            parts.push(
                `== Prüfung „${spec.name}“, jetzt ausgeführt ==\nArt: ${spec.kind}\nZiel: ${spec.target || '–'}\nErgebnis: ${r.state === 'ok' ? 'in Ordnung' : r.state === 'warn' ? 'Warnung' : 'Fehler'}: ${r.text}`,
            );
            if (spec.kind === 'service') {
                parts.push(await section(tools, `Dienst ${spec.target}`, 'service_status', { unit: spec.target, lines: 40 }));
            }
            break;
        }
        case 'os-security':
        case 'os-updates':
        case 'os-updates-stale':
        case 'reboot-required':
            parts.push(await section(tools, 'Ausstehende Updates', 'package_updates', {}));
            break;
        case 'mem-low':
            parts.push(await section(tools, 'Prozesse nach Speicher', 'list_processes', { sort: 'mem', limit: 20 }));
            break;
        default:
            parts.push(await section(tools, 'Überblick', 'overview', {}));
    }
    let text = parts.join('\n\n');
    if (text.length > DIAGNOSE_MAX) {
        text = `… (gekürzt)\n${text.slice(-DIAGNOSE_MAX)}`;
    }
    return { text };
}
