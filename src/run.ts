import { execFile } from 'node:child_process';

export interface RunResult {
    /** Exit code; null: not started (missing program), killed or timed out */
    code: number | null;
    stdout: string;
    stderr: string;
    /** Why it did not run: ENOENT, timeout ... */
    error?: string;
}

/**
 * Runs a program without a shell and never throws: the agent asks many small programs (systemctl, df, journalctl),
 * any of which may be missing or slow on a server.
 */
export function run(
    file: string,
    args: string[],
    opts: { timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
    return new Promise(resolve => {
        execFile(
            file,
            args,
            {
                timeout: opts.timeout ?? 30_000,
                maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
                env: opts.env ?? { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
                encoding: 'utf8',
            },
            (err, stdout, stderr) => {
                if (!err) {
                    resolve({ code: 0, stdout, stderr });
                    return;
                }
                const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
                resolve({
                    code: typeof e.code === 'number' ? e.code : null,
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                    ...(typeof e.code === 'number' ? {} : { error: e.killed ? 'timeout' : String(e.code ?? e.message) }),
                });
            },
        );
    });
}
