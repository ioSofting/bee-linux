import type { LinuxInfo } from './lib/protocol.js';
import { run } from './run.js';

/**
 * The journal of systemd: what went wrong on the server in the last 24 hours. The agent reads it as its own user,
 * which needs the group systemd-journal (install.sh adds it); without it journalctl shows only the own messages.
 */

/** journalctl without the right to read the journal of the system says so on stderr */
const NOT_ALLOWED = /not seeing messages from other users and the system|No journal files were opened due to insufficient permissions/i;

/** Lines of SSH that are a failed login */
const SSH_FAILED = /^(Failed password|Invalid user|Failed keyboard-interactive|authentication failure|maximum authentication attempts exceeded)/i;

/** Longest output the agent reads for one question (errors of 24 h are usually a few hundred lines) */
const MAX_LINES = '50000';

export type JournalSummary = NonNullable<LinuxInfo['journal']>;

/** Counts lines of `journalctl -o json --output-fields=...` per unit; kernel separately */
export function countErrors(text: string, top = 10): { errors: { unit: string; count: number }[]; kernelErrors: number } {
    const counts = new Map<string, number>();
    let kernel = 0;
    for (const line of text.split('\n')) {
        if (!line.startsWith('{')) {
            continue;
        }
        let e: Record<string, unknown>;
        try {
            e = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        if (e._TRANSPORT === 'kernel') {
            kernel++;
            continue;
        }
        const unit = String(e._SYSTEMD_UNIT || e.SYSLOG_IDENTIFIER || 'unbekannt');
        counts.set(unit, (counts.get(unit) ?? 0) + 1);
    }
    const errors = [...counts.entries()]
        .map(([unit, count]) => ({ unit, count }))
        .sort((a, b) => b.count - a.count || a.unit.localeCompare(b.unit))
        .slice(0, top);
    return { errors, kernelErrors: kernel };
}

export function countSshFailed(text: string): number {
    return text.split('\n').filter(l => SSH_FAILED.test(l.trim())).length;
}

/** The summary of the last 24 hours; null: the agent may not read the journal of the system */
export async function journalSummary(): Promise<JournalSummary | null> {
    const errors = await run(
        'journalctl',
        ['--since', '-24h', '-p', 'err', '-o', 'json', '--output-fields=_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,_TRANSPORT', '-q', '--no-pager', '-n', MAX_LINES],
        { timeout: 60_000 },
    );
    if (errors.error === 'ENOENT' || NOT_ALLOWED.test(errors.stderr) || (errors.code !== 0 && !errors.stdout)) {
        return null;
    }
    // OpenSSH from 9.8 logs the logins as sshd-session
    const ssh = await run(
        'journalctl',
        ['--since', '-24h', 'SYSLOG_IDENTIFIER=sshd', 'SYSLOG_IDENTIFIER=sshd-session', '-o', 'cat', '-q', '--no-pager', '-n', MAX_LINES],
        { timeout: 60_000 },
    );
    return { ...countErrors(errors.stdout), sshFailed: countSshFailed(ssh.stdout) };
}

/** Lines of the journal of the last minutes (of one unit, or all), for a check of kind journal */
export async function journalLines(minutes: number, unit: string): Promise<string[] | null> {
    const args = ['--since', `-${Math.max(1, Math.round(minutes))}min`, '-o', 'cat', '-q', '--no-pager', '-n', MAX_LINES];
    if (unit) {
        args.push('-u', unit);
    }
    const r = await run('journalctl', args, { timeout: 60_000 });
    if (r.error || NOT_ALLOWED.test(r.stderr)) {
        return null;
    }
    return r.stdout.split('\n').filter(Boolean);
}
