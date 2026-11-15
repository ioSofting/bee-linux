/**
 * Settings of bee-linux, from the environment: systemd reads them from /etc/bee-linux/bee-linux.env (install.sh
 * writes it). Usually only the enrollment token is set; the rest has defaults.
 */
export interface Config {
    /** Enrollment URL of the beekeeper server (BEE_URL) */
    url: string;
    /** One-time enrollment token from the portal (BEE_TOKEN); only needed until the device is enrolled */
    token: string;
    /** Folder for the device certificate, the UUID and the checks (BEE_DATA_DIR); keep it, or the server enrolls anew */
    dataDir: string;
    /** Free text shown in the portal, e.g. "Webserver Kunde Müller" (BEE_COMMENT) */
    comment: string;
    /**
     * The owner allows the console: a shell as the user of bee-linux through the portal, for people with the permission
     * console (BEE_CONSOLE, default off)
     */
    console: boolean;
    /**
     * The owner allows the AI access: an AI of the integrator reads the server through the tools of bee-linux (tools.ts),
     * only while a person opened an AI session in the portal (BEE_AI, default off). Nothing of it writes.
     */
    ai: boolean;
    /** Heartbeat with load, memory and free space, seconds (BEE_HEARTBEAT, default 5 min) */
    heartbeat: number;
    /** How often the checks run, seconds (BEE_CHECK, default 60) */
    check: number;
    /** How often the lists of packages are loaded (apt-get update), hours (BEE_APT_UPDATE, default 6; 0: never) */
    aptUpdate: number;
    /** The helper for what needs root, through sudo (BEE_ROOT_HELPER) */
    rootHelper: string;
    debug: boolean;
}

function flag(value: string | undefined, def: boolean): boolean {
    if (value === undefined || value.trim() === '') {
        return def;
    }
    return !/^(0|false|no|off|nein|aus)$/i.test(value.trim());
}

function seconds(value: string | undefined, def: number, min: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.max(min, Math.round(n)) : def;
}

function hours(value: string | undefined, def: number): number {
    if (value === undefined || value.trim() === '') {
        return def;
    }
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return {
        url: (env.BEE_URL || 'https://beekeeper.one').trim().replace(/\/+$/, ''),
        token: (env.BEE_TOKEN || '').trim(),
        dataDir: env.BEE_DATA_DIR || '/var/lib/bee-linux',
        comment: (env.BEE_COMMENT || '').trim(),
        console: flag(env.BEE_CONSOLE, false),
        ai: flag(env.BEE_AI, false),
        heartbeat: seconds(env.BEE_HEARTBEAT, 300, 60),
        check: seconds(env.BEE_CHECK, 60, 15),
        aptUpdate: hours(env.BEE_APT_UPDATE, 6),
        rootHelper: (env.BEE_ROOT_HELPER || '/opt/bee-linux/bee-root').trim(),
        debug: flag(env.BEE_DEBUG, false),
    };
}

export interface Log {
    debug(msg: string): void;
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
}

/** One line per message on stdout (the journal of the unit), with level; systemd adds the time */
export function consoleLog(debug: boolean): Log {
    const line = (level: string, msg: string): void => {
        process.stdout.write(`${level} ${msg}\n`);
    };
    return {
        debug: msg => debug && line('debug', msg),
        info: msg => line('info', msg),
        warn: msg => line('warn', msg),
        error: msg => line('error', msg),
    };
}
