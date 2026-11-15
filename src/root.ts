import { spawn } from 'node:child_process';
import type { DockerContainer, Pm2Process } from './lib/protocol.js';
import { run } from './run.js';

/**
 * What needs root goes through the helper bee-root (install.sh puts it to /opt/bee-linux, owned by root) with
 * `sudo -n`: the sudoers rule allows the user of bee-linux this one program, and the helper allows only fixed
 * actions with checked arguments (packages by name), what /etc/bee-linux/root.conf switches on. So apt-get itself
 * is not open to the user (with its options -o it could run anything as root), and Docker is asked without giving
 * the user the group docker (that would be root as well).
 */

export interface RootAbilities {
    /** apt-get update and upgrade of named packages */
    apt: boolean;
    /** systemctl reboot */
    reboot: boolean;
    /** the processes of pm2 of BEE_PM2_USER */
    pm2: boolean;
    /** the containers of Docker */
    docker: boolean;
    /** reading for the AI access: logs of Docker and pm2, nginx -t, certbot certificates */
    logs: boolean;
    /** update of bee-linux itself from GitHub (self-update) */
    update: boolean;
}

const NONE: RootAbilities = { apt: false, reboot: false, pm2: false, docker: false, logs: false, update: false };

/** A package name as Debian allows it; nothing that could be taken for an option */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*(:[a-z0-9]+)?$/;

export function parseAbilities(text: string): RootAbilities {
    const on = (key: string): boolean => new RegExp(`^${key}=1$`, 'm').test(text);
    return { apt: on('apt'), reboot: on('reboot'), pm2: on('pm2'), docker: on('docker'), logs: on('logs'), update: on('update') };
}

/** Lines "name\timage\tstate\tstatus" of `docker ps -a --format` */
export function parseDocker(text: string): DockerContainer[] {
    const list: DockerContainer[] = [];
    for (const line of text.split('\n')) {
        const [name, image, state, status = ''] = line.split('\t');
        if (!name || !image || !state) {
            continue;
        }
        const health = /\((healthy|unhealthy)\)/.exec(status)?.[1] ?? (/\(health: starting\)/.test(status) ? 'starting' : undefined);
        const exit = /^Exited \((\d+)\)/.exec(status);
        list.push({
            name,
            image,
            state,
            ...(health ? { health } : {}),
            ...(exit ? { exitCode: Number(exit[1]) } : {}),
        });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** Lines "name\tstatus\trestarts" the helper makes of `pm2 jlist` (nothing else of it: jlist has the environment) */
export function parsePm2(text: string): Pm2Process[] {
    const list: Pm2Process[] = [];
    for (const line of text.split('\n')) {
        const [name, status, restarts] = line.split('\t');
        if (name && status) {
            list.push({ name, status, restarts: Number(restarts) || 0 });
        }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
}

export class Root {
    constructor(private readonly helper: string) {}

    private call(args: string[], timeout = 60_000): ReturnType<typeof run> {
        return run('sudo', ['-n', this.helper, ...args], { timeout });
    }

    /** A reading action of the helper for a tool of the AI (docker-logs, pm2-logs, nginx-test, certbot) */
    read(args: string[]): ReturnType<typeof run> {
        return run('sudo', ['-n', this.helper, ...args], { timeout: 90_000, maxBuffer: 32 * 1024 * 1024 });
    }

    async abilities(): Promise<RootAbilities> {
        const r = await this.call(['can'], 15_000);
        return r.code === 0 ? parseAbilities(r.stdout) : NONE;
    }

    /** Loads the lists of packages again; the error text if it failed */
    async aptUpdate(): Promise<string | null> {
        const r = await this.call(['apt-update'], 15 * 60_000);
        return r.code === 0 ? null : (r.stderr || r.stdout || r.error || `Ende mit ${r.code}`).trim().slice(-500);
    }

    /** null: no pm2 or not allowed */
    async pm2(): Promise<Pm2Process[] | null> {
        const r = await this.call(['pm2'], 30_000);
        return r.code === 0 ? parsePm2(r.stdout) : null;
    }

    /** null: no Docker or not allowed */
    async docker(): Promise<DockerContainer[] | null> {
        const r = await this.call(['docker'], 30_000);
        return r.code === 0 ? parseDocker(r.stdout) : null;
    }

    /**
     * Upgrades the packages, with the output of apt-get as it comes. Resolves with the exit code (null: not started).
     *
     * @param packages names, checked before (PACKAGE_NAME); the helper checks them again
     * @param onOutput the output, piece by piece
     */
    aptUpgrade(packages: string[], onOutput: (text: string) => void): Promise<number | null> {
        return new Promise(resolve => {
            const child = spawn('sudo', ['-n', this.helper, 'apt-upgrade', ...packages], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
            });
            child.stdout.on('data', (b: Buffer) => onOutput(b.toString('utf8')));
            child.stderr.on('data', (b: Buffer) => onOutput(b.toString('utf8')));
            child.on('error', err => {
                onOutput(`${err.message}\n`);
                resolve(null);
            });
            child.on('close', code => resolve(code));
        });
    }

    /**
     * Downloads the newest bee-linux and starts install.sh in a unit of its own, which restarts this agent shortly
     * after. The version that is being installed, or the error.
     */
    async selfUpdate(): Promise<{ version: string } | { error: string }> {
        const r = await this.call(['self-update'], 5 * 60_000);
        const version = r.stdout.trim().split('\n').pop() ?? '';
        return r.code === 0 && /^\d+\.\d+\.\d+/.test(version)
            ? { version }
            : { error: (r.stderr || r.stdout || r.error || `Ende mit ${r.code}`).trim().slice(-500) };
    }

    /** Restarts the server; the agent gets SIGTERM from systemd shortly after */
    async reboot(): Promise<string | null> {
        const r = await this.call(['reboot'], 30_000);
        return r.code === 0 ? null : (r.stderr || r.error || `Ende mit ${r.code}`).trim().slice(-300);
    }
}
