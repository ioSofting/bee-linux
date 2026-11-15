/**
 * The command of the npm package: `sudo npx bee-linux@latest install` asks what is needed (server, token, what the
 * portal may do) and runs install.sh of the package, which does the real work. Without questions with --yes or when
 * stdin is no terminal; an existing installation keeps its settings (only given options change them).
 *
 *   bee-linux install [options]    install, or update with the settings kept
 *   bee-linux update               the same without questions
 *   bee-linux uninstall [--purge]
 *   bee-linux version
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_URL = 'https://beekeeper.one';
const ENV_FILE = '/etc/bee-linux/bee-linux.env';

/** What install.sh gets; undefined: not asked, install.sh keeps or defaults it */
export interface Answers {
    url?: string;
    token?: string;
    comment?: string;
    console?: boolean;
    ai?: boolean;
    logs?: boolean;
    apt?: boolean;
    reboot?: boolean;
    docker?: boolean;
    pm2User?: string;
    update?: boolean;
    services?: boolean;
}

/** Options as install.sh takes them; the token goes by the environment (not visible in ps) */
export function installArgs(a: Answers): string[] {
    const args: string[] = [];
    const flag = (value: boolean | undefined, name: string): void => {
        if (value !== undefined) {
            args.push(value ? `--${name}` : `--no-${name}`);
        }
    };
    if (a.url) {
        args.push('--url', a.url);
    }
    if (a.comment !== undefined) {
        args.push('--comment', a.comment);
    }
    flag(a.console, 'console');
    flag(a.ai, 'ai');
    flag(a.logs, 'logs');
    flag(a.apt, 'apt');
    flag(a.reboot, 'reboot');
    flag(a.docker, 'docker');
    flag(a.update, 'update');
    flag(a.services, 'services');
    if (a.pm2User !== undefined) {
        args.push('--pm2-user', a.pm2User);
    }
    return args;
}

/** Options of the command line; unknown ones are an error */
export function parseOptions(argv: string[]): { answers: Answers; yes: boolean; purge: boolean } {
    const answers: Answers = {};
    let yes = false;
    let purge = false;
    const bools: Record<string, keyof Answers> = {
        console: 'console',
        ai: 'ai',
        logs: 'logs',
        apt: 'apt',
        reboot: 'reboot',
        docker: 'docker',
        update: 'update',
        services: 'services',
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const value = (): string => {
            const v = argv[++i];
            if (v === undefined) {
                throw new Error(`${arg} braucht einen Wert`);
            }
            return v;
        };
        const m = /^--(no-)?([a-z0-9-]+)$/.exec(arg);
        if (arg === '-y' || arg === '--yes') {
            yes = true;
        } else if (arg === '--purge') {
            purge = true;
        } else if (arg === '--url') {
            answers.url = value();
        } else if (arg === '--token') {
            answers.token = value();
        } else if (arg === '--comment') {
            answers.comment = value();
        } else if (arg === '--pm2-user') {
            answers.pm2User = value();
        } else if (m && bools[m[2]]) {
            (answers as Record<string, unknown>)[bools[m[2]]] = !m[1];
        } else {
            throw new Error(`Unbekannte Option ${arg}`);
        }
    }
    if (answers.url !== undefined) {
        answers.url = normalizeUrl(answers.url);
    }
    return { answers, yes, purge };
}

/** "beekeeper.one" -> "https://beekeeper.one"; only http(s), no path */
export function normalizeUrl(text: string): string {
    const t = text.trim().replace(/\/+$/, '');
    const url = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
    if (!/^https?:$/.test(url.protocol) || (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error(`Keine Adresse eines Servers: ${text}`);
    }
    return url.origin;
}

/** Users with processes of pm2 (a folder .pm2 in the home of root or under /home) */
export function pm2Users(): string[] {
    const users: string[] = [];
    if (existsSync('/root/.pm2')) {
        users.push('root');
    }
    try {
        for (const name of readdirSync('/home')) {
            if (/^[a-z_][a-z0-9_-]*$/.test(name) && existsSync(join('/home', name, '.pm2'))) {
                users.push(name);
            }
        }
    } catch {
        // no /home
    }
    return users;
}

function has(cmd: string): boolean {
    return (process.env.PATH || '/usr/bin:/bin').split(':').some(dir => {
        try {
            return statSync(join(dir, cmd)).isFile();
        } catch {
            return false;
        }
    });
}

/** Result of keys typed into a line: the text so far, what to show, and whether the line ended */
export interface LineEdit {
    text: string;
    echo: string;
    end?: 'enter' | 'abort';
    /** input after Enter, for the next question (several answers pasted at once) */
    rest: string;
    /** the line ended with \r: a \n right after it belongs to it */
    skipLf: boolean;
}

/**
 * The keys of a terminal in raw mode applied to a line: letters (also pasted), Backspace, Ctrl+U, Enter, Ctrl+C;
 * escape sequences (arrows, bracketed paste) are ignored. A secret line shows a * per character.
 */
export function editLine(text: string, input: string, secret = false, skipLf = false): LineEdit {
    const chars = Array.from(text);
    let echo = '';
    const keys = Array.from(input);
    let i = 0;
    if (skipLf && keys[0] === '\n') {
        i = 1;
    }
    for (; i < keys.length; i++) {
        const ch = keys[i];
        const code = ch.codePointAt(0)!;
        if (ch === '\r' || ch === '\n') {
            return { text: chars.join(''), echo, end: 'enter', rest: keys.slice(i + 1).join(''), skipLf: ch === '\r' };
        }
        if (ch === '\x03' || (ch === '\x04' && !chars.length)) {
            return { text: chars.join(''), echo, end: 'abort', rest: '', skipLf: false };
        }
        if (ch === '\x7f' || ch === '\b') {
            if (chars.length) {
                chars.pop();
                echo += '\b \b';
            }
        } else if (ch === '\x15') {
            echo += '\b \b'.repeat(chars.length);
            chars.length = 0;
        } else if (ch === '\x1b') {
            // ESC [ params final, ESC O x, or ESC x
            if (keys[i + 1] === '[') {
                i += 2;
                while (i < keys.length && !/[\x40-\x7e]/.test(keys[i])) {
                    i++;
                }
            } else {
                i++;
            }
        } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0)) {
            chars.push(ch);
            echo += secret ? '*' : ch;
        }
    }
    return { text: chars.join(''), echo, rest: '', skipLf: false };
}

/** Questions on the terminal, read in raw mode: the question stays visible, the token is shown as *** */
class Prompt {
    private pending = '';
    private skipLf = false;
    private readonly stdin = process.stdin;

    constructor() {
        this.stdin.setEncoding('utf8');
        this.stdin.setRawMode?.(true);
        this.stdin.resume();
    }

    ask(question: string, def = '', secret = false): Promise<string> {
        process.stdout.write(`${question}${def ? ` [${def}]` : ''}: `);
        return new Promise(resolve => {
            let text = '';
            const onData = (chunk: string | Buffer): void => {
                const r = editLine(text, chunk.toString(), secret, this.skipLf);
                this.skipLf = false;
                text = r.text;
                if (r.echo) {
                    process.stdout.write(r.echo);
                }
                if (!r.end) {
                    return;
                }
                this.stdin.off('data', onData);
                process.stdout.write('\n');
                if (r.end === 'abort') {
                    this.close();
                    console.log('Abgebrochen.');
                    process.exit(130);
                }
                this.pending = r.rest;
                this.skipLf = r.skipLf;
                resolve(text.trim() || def);
            };
            this.stdin.on('data', onData);
            if (this.pending) {
                const p = this.pending;
                this.pending = '';
                onData(p);
            }
        });
    }

    async yesNo(question: string, def: boolean): Promise<boolean> {
        for (;;) {
            const a = (await this.ask(`${question} ${def ? '[J/n]' : '[j/N]'}`)).toLowerCase();
            if (!a) {
                return def;
            }
            if (/^(j|ja|y|yes)$/.test(a)) {
                return true;
            }
            if (/^(n|nein|no)$/.test(a)) {
                return false;
            }
            console.log('Bitte j oder n.');
        }
    }

    close(): void {
        this.stdin.setRawMode?.(false);
        this.stdin.pause();
    }
}

/** An enrollment token of the portal: "<tenant>.<random>" */
export const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}$/;

/** Whether a Beekeeper server answers at url (GET /api/health); the reason if not */
export async function checkServer(url: string, timeoutMs = 10_000): Promise<string | null> {
    if (typeof fetch !== 'function') {
        return null;
    }
    try {
        const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        const body = (await res.json().catch(() => null)) as { ok?: unknown; transport?: unknown } | null;
        if (res.ok && body?.ok === true && typeof body.transport === 'string') {
            return null;
        }
        return `unter ${url} antwortet kein Beekeeper-Server (HTTP ${res.status})`;
    } catch (e) {
        const err = e as Error & { cause?: { code?: string; message?: string } };
        return `${url} nicht erreichbar: ${err.cause?.code || err.cause?.message || err.message}`;
    }
}

async function ask(given: Answers): Promise<Answers | null> {
    const p = new Prompt();
    try {
        const a: Answers = { ...given };
        console.log('bee-linux verbindet diesen Server mit dem Portal von Beekeeper. Enter nimmt den Vorschlag in [ ].');
        while (!a.url) {
            let url: string;
            try {
                url = normalizeUrl(await p.ask('Server', DEFAULT_URL));
            } catch (e) {
                console.log((e as Error).message);
                continue;
            }
            const problem = await checkServer(url);
            if (!problem || (console.log(`Achtung: ${problem}`), await p.yesNo('Trotzdem verwenden?', false))) {
                a.url = url;
            }
        }
        while (!a.token) {
            const token = await p.ask('Enrollment-Token aus dem Portal (Anlage, „Enrollment-Token …“)', '', true);
            if (TOKEN_RE.test(token)) {
                a.token = token;
            } else if (token) {
                console.log('Das ist kein Enrollment-Token (Form: name.zeichenfolge). Im Portal kopieren und hier einfügen.');
            }
        }
        a.comment ??= await p.ask('Kommentar im Portal, z. B. „Webserver Kunde Müller“ (leer: keiner)');
        a.console ??= await p.yesNo('Konsole im Portal erlauben (Shell als Nutzer bee)?', false);
        a.ai ??= await p.yesNo('KI-Zugang erlauben (nur lesen: Journal, Logs, Dienste; keine Shell)?', false);
        if (a.ai) {
            a.logs ??= await p.yesNo('Darf die KI auch Logs von Docker und pm2, nginx -t und certbot lesen (über root)?', false);
        }
        a.apt ??= await p.yesNo('Pakete aus dem Portal aktualisieren (apt)?', true);
        a.reboot ??= await p.yesNo('Neustart des Servers aus dem Portal?', true);
        a.services ??= await p.yesNo('Fehlgeschlagene Dienste aus dem Portal neu starten?', true);
        if (has('docker')) {
            a.docker ??= await p.yesNo('Container von Docker melden?', true);
        }
        if (a.pm2User === undefined) {
            const users = pm2Users();
            if (users.length === 1) {
                a.pm2User = (await p.yesNo(`Prozesse von pm2 des Nutzers ${users[0]} melden?`, true)) ? users[0] : '';
            } else if (users.length > 1) {
                a.pm2User = await p.ask(`Prozesse von pm2 welches Nutzers melden (${users.join(', ')}; leer: keine)`);
            }
        }
        a.update ??= await p.yesNo('bee-linux aus dem Portal aktualisieren (von npm)?', true);
        console.log(`\nServer ${a.url}${a.comment ? `, Kommentar „${a.comment}“` : ''}`);
        return (await p.yesNo('Jetzt installieren?', true)) ? a : null;
    } finally {
        p.close();
    }
}

function runInstall(pkg: string, args: string[], token?: string): Promise<number> {
    return new Promise(resolve => {
        const child = spawn('bash', [join(pkg, 'install.sh'), '--source', pkg, ...args], {
            stdio: 'inherit',
            env: { ...process.env, ...(token ? { BEE_TOKEN: token } : {}) },
        });
        child.on('error', e => {
            console.error(`bee-linux: ${e.message}`);
            resolve(1);
        });
        child.on('close', code => resolve(code ?? 1));
    });
}

const HELP = `bee-linux: der Agent von Beekeeper für Linux-Server

  sudo npx bee-linux@latest install      installieren (fragt nach Server, Token und Rechten) oder aktualisieren
  sudo npx bee-linux@latest update       aktualisieren, Einstellungen bleiben
  sudo npx bee-linux@latest uninstall [--purge]

Optionen für install (ohne Fragen mit --yes): --url URL, --token T, --comment TEXT, --pm2-user NAME,
  --console, --ai, --logs, --apt, --reboot, --services, --docker, --update (jeweils auch --no-...)
`;

export async function main(argv: string[], pkg: string, version: string): Promise<number> {
    const [cmd = 'help', ...rest] = argv;
    if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
        console.log(version);
        return 0;
    }
    if (!['install', 'update', 'uninstall'].includes(cmd)) {
        console.log(HELP);
        return cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1;
    }
    let opts;
    try {
        opts = parseOptions(rest);
    } catch (e) {
        console.error(`bee-linux: ${(e as Error).message}\n\n${HELP}`);
        return 1;
    }
    if (process.platform !== 'linux') {
        console.error('bee-linux: nur für Linux');
        return 1;
    }
    if (process.getuid?.() !== 0) {
        console.error(`bee-linux: bitte als root: sudo npx bee-linux@latest ${cmd}`);
        return 1;
    }
    if (cmd === 'uninstall') {
        return runInstall(pkg, ['--uninstall', ...(opts.purge ? ['--purge'] : [])]);
    }
    const installed = existsSync(ENV_FILE);
    let answers: Answers | null = { ...opts.answers, token: opts.answers.token ?? process.env.BEE_TOKEN };
    if (!installed && cmd === 'update') {
        console.error('bee-linux: noch nicht installiert: sudo npx bee-linux@latest install');
        return 1;
    }
    if (!installed && !opts.yes && process.stdin.isTTY) {
        answers = await ask(answers);
        if (!answers) {
            console.log('Abgebrochen.');
            return 1;
        }
    } else if (!installed && !answers.token) {
        console.error('bee-linux: erste Installation ohne Terminal: --token <Enrollment-Token> (oder BEE_TOKEN) nötig');
        return 1;
    }
    console.log(`bee-linux ${version}${installed ? ': Aktualisierung, die Einstellungen bleiben' : ''}`);
    return runInstall(pkg, installArgs(answers), answers.token);
}

// the bundle dist/cli.cjs, started by npx: the package is the folder above
if (typeof require !== 'undefined' && require.main === module) {
    const pkg = dirname(__dirname);
    let version = '?';
    try {
        version = (JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { version: string }).version;
    } catch {
        // not from the package
    }
    main(process.argv.slice(2), pkg, version).then(
        code => process.exit(code),
        e => {
            console.error(`bee-linux: ${e?.message ?? e}`);
            process.exit(1);
        },
    );
}
