import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { parseOsPackage, type OsPackage, type OsUpdates } from './lib/protocol.js';
import { run } from './run.js';

/** Packages from `apt list --upgradeable` (needs no root; reads the lists apt-get update loaded) */
export function parseUpgradeable(text: string): OsPackage[] {
    return text
        .split('\n')
        .filter(l => l.includes('/') && !/^Listing/.test(l))
        .map(parseOsPackage)
        .filter((p): p is OsPackage => !!p)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Debian and Ubuntu: apt; null: another system */
export function hasApt(): boolean {
    return existsSync('/usr/bin/apt') || existsSync('/usr/bin/apt-get');
}

/**
 * The updates as the lists of apt know them, and whether the system waits for a reboot.
 *
 * @param updatedAt when the agent last loaded the lists itself; otherwise the time of the lists on disk
 */
export async function osUpdates(updatedAt: number | null): Promise<OsUpdates | undefined> {
    if (!hasApt()) {
        return undefined;
    }
    const r = await run('apt', ['list', '--upgradeable'], { timeout: 60_000 });
    if (r.code !== 0) {
        return undefined;
    }
    const lists = await stat('/var/lib/apt/lists').catch(() => null);
    return {
        packages: parseUpgradeable(r.stdout),
        checkedAt: updatedAt ?? (lists ? Math.round(lists.mtimeMs) : null),
        rebootRequired: existsSync('/var/run/reboot-required'),
    };
}
