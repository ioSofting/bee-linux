import { readdir, readFile } from 'node:fs/promises';
import type { LinuxMount } from './lib/protocol.js';
import { run } from './run.js';

/** PRETTY_NAME of /etc/os-release, e.g. "Debian GNU/Linux 12 (bookworm)" */
export function parseOsRelease(text: string): { pretty: string; id: string; versionId: string } {
    const values: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (m) {
            values[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        }
    }
    return {
        pretty: values.PRETTY_NAME || [values.NAME, values.VERSION].filter(Boolean).join(' ') || 'Linux',
        id: values.ID || '',
        versionId: values.VERSION_ID || '',
    };
}

export async function osRelease(): Promise<ReturnType<typeof parseOsRelease>> {
    const text = await readFile('/etc/os-release', 'utf8').catch(() => readFile('/usr/lib/os-release', 'utf8').catch(() => ''));
    return parseOsRelease(text);
}

export interface MemInfo {
    total: number;
    /** MemAvailable: what programs can still get without swapping (free plus caches) */
    available: number;
    swapTotal: number;
    swapFree: number;
}

export function parseMemInfo(text: string): MemInfo {
    const kb = (key: string): number => {
        const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
        return m ? Number(m[1]) * 1024 : 0;
    };
    return { total: kb('MemTotal'), available: kb('MemAvailable') || kb('MemFree'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
}

export async function memInfo(): Promise<MemInfo> {
    return parseMemInfo(await readFile('/proc/meminfo', 'utf8').catch(() => ''));
}

/** Filesystems that hold no data of their own */
const SKIP_TYPES = ['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'fuse.lxcfs', 'nsfs', 'ramfs'];

/** Lines of `df -P` after the header; the mount point is the rest of the line (may contain spaces) */
function dfRows(text: string, columns: number): string[][] {
    return text
        .split('\n')
        .slice(1)
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
            const parts = l.split(/\s+/);
            return [...parts.slice(0, columns - 1), parts.slice(columns - 1).join(' ')];
        })
        .filter(p => p.length === columns && p[columns - 1].startsWith('/'));
}

/**
 * Parses `df -P -T -B1` and `df -P -i`. The same device mounted more than once (bind mounts of Docker) only with its
 * shortest mount point.
 */
export function parseDf(space: string, inodes: string): LinuxMount[] {
    const inodeUse = new Map<string, number | null>();
    for (const [, total, , , pct, path] of dfRows(inodes, 6)) {
        inodeUse.set(path, Number(total) > 0 ? parseInt(pct, 10) : null);
    }
    const byDevice = new Map<string, LinuxMount>();
    for (const [device, fstype, size, , , pct, path] of dfRows(space, 7)) {
        if (SKIP_TYPES.includes(fstype) || !(Number(size) > 0)) {
            continue;
        }
        const mount: LinuxMount = {
            path,
            device,
            fstype,
            size: Number(size),
            usedPct: parseInt(pct, 10) || 0,
            inodesPct: inodeUse.has(path) ? Number.isFinite(inodeUse.get(path)) ? inodeUse.get(path)! : null : null,
        };
        const known = byDevice.get(device);
        if (!known || mount.path.length < known.path.length) {
            byDevice.set(device, mount);
        }
    }
    return [...byDevice.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function mounts(): Promise<LinuxMount[]> {
    const exclude = SKIP_TYPES.flatMap(t => ['-x', t]);
    const [space, inodes] = await Promise.all([
        run('df', ['-P', '-T', '-B1', '-l', ...exclude], { timeout: 15_000 }),
        run('df', ['-P', '-i', '-l', ...exclude], { timeout: 15_000 }),
    ]);
    // df ends with 1 if one filesystem is not readable (a mount of another user): the rest is still good
    return parseDf(space.stdout, inodes.stdout);
}

/** Highest temperature of the CPU in °C, from thermal zones and hwmon; undefined: no sensor (virtual machine) */
export async function temperature(): Promise<number | undefined> {
    const values: number[] = [];
    const read = async (file: string): Promise<void> => {
        const v = Number((await readFile(file, 'utf8').catch(() => '')).trim());
        // millidegrees; ignore sensors that report nonsense
        if (Number.isFinite(v) && v > 0 && v < 150_000) {
            values.push(v / 1000);
        }
    };
    const zones = await readdir('/sys/class/thermal').catch(() => [] as string[]);
    await Promise.all(zones.filter(z => z.startsWith('thermal_zone')).map(z => read(`/sys/class/thermal/${z}/temp`)));
    if (!values.length) {
        const mons = await readdir('/sys/class/hwmon').catch(() => [] as string[]);
        for (const m of mons) {
            const name = (await readFile(`/sys/class/hwmon/${m}/name`, 'utf8').catch(() => '')).trim();
            if (/coretemp|k10temp|zenpower|cpu_thermal|soc_thermal/.test(name)) {
                await read(`/sys/class/hwmon/${m}/temp1_input`);
            }
        }
    }
    return values.length ? Math.round(Math.max(...values) * 10) / 10 : undefined;
}

/** Units of systemd in state failed, from `systemctl list-units --state=failed --plain --no-legend` */
export function parseFailedUnits(text: string): string[] {
    return text
        .split('\n')
        .map(l => l.trim().split(/\s+/)[0])
        .filter(u => !!u && /^[\w@.:\\-]+$/.test(u))
        .sort();
}

export async function failedUnits(): Promise<string[]> {
    const r = await run('systemctl', ['list-units', '--state=failed', '--plain', '--no-legend', '--no-pager'], { timeout: 15_000 });
    return r.code === 0 ? parseFailedUnits(r.stdout) : [];
}

/** The clock is synchronized; null: no timedatectl (or no systemd-timesyncd/chrony behind it that it knows) */
export async function ntpSynced(): Promise<boolean | null> {
    const r = await run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 10_000 });
    const v = r.stdout.trim();
    return v === 'yes' ? true : v === 'no' ? false : null;
}
