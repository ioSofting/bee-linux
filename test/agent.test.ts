import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, utimes } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { AGENT_VERSION, buildInventory, parseLatest, type Collected } from '../src/agent.js';
import { DEFAULT_URL, installArgs, normalizeUrl, parseOptions } from '../src/cli.js';
import { diagnose, SUBJECT, summarizeSsh } from '../src/diagnose.js';
import { parseUpgradeable } from '../src/apt.js';
import { hostPort, invalidCheck, runChecks } from '../src/checks.js';
import { countErrors, countSshFailed } from '../src/journal.js';
import { PACKAGE_NAME, parseAbilities, parseDocker, parsePm2 } from '../src/root.js';
import { parseDf, parseFailedUnits, parseMemInfo, parseOsRelease } from '../src/system.js';
import { buildTools, callTool, JOURNAL_TIME, logPath } from '../src/tools.js';
import { Root } from '../src/root.js';
import type { CheckSpec } from '../src/lib/protocol.js';

test('os-release', () => {
    const r = parseOsRelease('PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nID=debian\n');
    assert.deepEqual(r, { pretty: 'Debian GNU/Linux 12 (bookworm)', id: 'debian', versionId: '12' });
    assert.equal(parseOsRelease('').pretty, 'Linux');
});

test('meminfo', () => {
    const m = parseMemInfo('MemTotal:        4028140 kB\nMemFree:          201712 kB\nMemAvailable:    2513352 kB\nSwapTotal:       1048572 kB\nSwapFree:         998400 kB\n');
    assert.equal(m.total, 4028140 * 1024);
    assert.equal(m.available, 2513352 * 1024);
    assert.equal(m.swapTotal, 1048572 * 1024);
});

test('df: space and inodes, bind mounts once, mount points with spaces', () => {
    const space = [
        'Filesystem     Type     1-blocks        Used   Available Capacity Mounted on',
        '/dev/sda1      ext4  84278435840 40960000000 39000000000      52% /',
        '/dev/sda15     vfat    129718272     6291456   123426816       5% /boot/efi',
        '/dev/sda1      ext4  84278435840 40960000000 39000000000      52% /var/lib/docker/volumes/x',
        '/dev/sdb1      xfs  500000000000 450000000000 50000000000     91% /mnt/backup disk',
    ].join('\n');
    const inodes = [
        'Filesystem      Inodes  IUsed   IFree IUse% Mounted on',
        '/dev/sda1      5242880 400000 4842880    8% /',
        '/dev/sda15           0      0       0     - /boot/efi',
        '/dev/sdb1     1000000  10000  990000    1% /mnt/backup disk',
    ].join('\n');
    const m = parseDf(space, inodes);
    assert.deepEqual(
        m.map(x => [x.path, x.usedPct, x.inodesPct]),
        [
            ['/', 52, 8],
            ['/boot/efi', 5, null],
            ['/mnt/backup disk', 91, 1],
        ],
    );
    assert.equal(m[0].fstype, 'ext4');
    assert.equal(m[0].size, 84278435840);
});

test('failed units', () => {
    assert.deepEqual(parseFailedUnits('nginx.service loaded failed failed A high performance web server\nlogrotate.service loaded failed failed Rotate log files\n'), [
        'logrotate.service',
        'nginx.service',
    ]);
    assert.deepEqual(parseFailedUnits(''), []);
});

test('journal: errors per unit and kernel, failed logins of SSH', () => {
    const lines = [
        '{"_SYSTEMD_UNIT":"nginx.service","SYSLOG_IDENTIFIER":"nginx"}',
        '{"_SYSTEMD_UNIT":"nginx.service"}',
        '{"SYSLOG_IDENTIFIER":"CRON"}',
        '{"_TRANSPORT":"kernel","SYSLOG_IDENTIFIER":"kernel"}',
        'not json',
    ].join('\n');
    assert.deepEqual(countErrors(lines), {
        errors: [
            { unit: 'nginx.service', count: 2 },
            { unit: 'CRON', count: 1 },
        ],
        kernelErrors: 1,
    });
    const ssh = [
        'Failed password for root from 1.2.3.4 port 1234 ssh2',
        'Invalid user admin from 1.2.3.4 port 1235',
        'Accepted publickey for ops from 5.6.7.8 port 22 ssh2',
        'Connection closed by 1.2.3.4 port 1236 [preauth]',
    ].join('\n');
    assert.equal(countSshFailed(ssh), 2);
});

test('apt list --upgradeable, with security', () => {
    const p = parseUpgradeable(
        [
            'Listing... Done',
            'openssl/stable-security 3.0.15-1~deb12u1 amd64 [upgradable from: 3.0.14-1~deb12u2]',
            'libc6/noble-updates,noble-security 2.39-0ubuntu8.4 amd64 [upgradable from: 2.39-0ubuntu8.3]',
            'curl/stable 7.88.1-10+deb12u8 amd64 [upgradable from: 7.88.1-10+deb12u7]',
        ].join('\n'),
    );
    assert.deepEqual(
        p.map(x => [x.name, !!x.security, x.from]),
        [
            ['curl', false, '7.88.1-10+deb12u7'],
            ['libc6', true, '2.39-0ubuntu8.3'],
            ['openssl', true, '3.0.14-1~deb12u2'],
        ],
    );
});

test('package names: nothing that looks like an option', () => {
    assert.ok(PACKAGE_NAME.test('libc6'));
    assert.ok(PACKAGE_NAME.test('libstdc++6:amd64'));
    assert.ok(!PACKAGE_NAME.test('-oDpkg::Pre-Invoke=sh'));
    assert.ok(!PACKAGE_NAME.test('a b'));
    assert.ok(!PACKAGE_NAME.test(''));
});

test('helper: abilities, docker and pm2', () => {
    assert.deepEqual(parseAbilities('apt=1\nreboot=0\npm2=1\ndocker=0\nlogs=1\nupdate=1\n'), { apt: true, reboot: false, pm2: true, docker: false, logs: true, update: true, services: false });
    assert.deepEqual(
        parseDocker(
            'web\tnginx:1.27\trunning\tUp 3 hours (healthy)\nold\tbusybox\texited\tExited (137) 2 days ago\ndb\tpostgres:16\trunning\tUp 5 seconds (health: starting)\n',
        ),
        [
            { name: 'db', image: 'postgres:16', state: 'running', health: 'starting' },
            { name: 'old', image: 'busybox', state: 'exited', exitCode: 137 },
            { name: 'web', image: 'nginx:1.27', state: 'running', health: 'healthy' },
        ],
    );
    assert.deepEqual(parsePm2('web-updater\tonline\t3\napi\terrored\t15\n'), [
        { name: 'api', status: 'errored', restarts: 15 },
        { name: 'web-updater', status: 'online', restarts: 3 },
    ]);
});

test('checks: targets are validated', () => {
    assert.deepEqual(hostPort('example.com:443'), { host: 'example.com', port: 443 });
    assert.deepEqual(hostPort('[::1]:8080'), { host: '::1', port: 8080 });
    assert.equal(hostPort('example.com'), null);
    assert.equal(hostPort('example.com:99999'), null);
    const spec = (kind: CheckSpec['kind'], target: string, text?: string): CheckSpec => ({ id: 'c', name: 'c', kind, target, text });
    assert.equal(invalidCheck(spec('service', 'nginx.service')), null);
    assert.ok(invalidCheck(spec('service', '--user')));
    assert.ok(invalidCheck(spec('http', 'file:///etc/passwd')));
    assert.ok(invalidCheck(spec('file', 'relative/path')));
    assert.ok(invalidCheck(spec('journal', '', '(')));
    assert.equal(invalidCheck(spec('journal', '', 'error')), null);
});

test('checks: tcp, http and file, with since kept while the state stays', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(req.url === '/down' ? 503 : 200, { 'content-type': 'text/plain' });
        res.end('hello beekeeper');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    // a port nobody listens on
    const closed = await new Promise<number>(r => {
        const s = net.createServer().listen(0, '127.0.0.1', () => {
            const p = (s.address() as net.AddressInfo).port;
            s.close(() => r(p));
        });
    });
    const dir = await mkdtemp(join(os.tmpdir(), 'bee-linux-'));
    await writeFile(join(dir, 'backup-1.tar'), 'x');
    const old = join(dir, 'old.tar');
    await writeFile(old, 'x');
    const twoDays = (Date.now() - 2 * 86400_000) / 1000;
    await utimes(old, twoDays, twoDays);
    const list: CheckSpec[] = [
        { id: 'tcp-ok', name: 'a', kind: 'tcp', target: `127.0.0.1:${port}` },
        { id: 'tcp-fail', name: 'b', kind: 'tcp', target: `127.0.0.1:${closed}`, timeout: 2 },
        { id: 'http-ok', name: 'c', kind: 'http', target: `http://127.0.0.1:${port}/`, text: 'beekeeper' },
        { id: 'http-text', name: 'd', kind: 'http', target: `http://127.0.0.1:${port}/`, text: 'missing' },
        { id: 'http-503', name: 'e', kind: 'http', target: `http://127.0.0.1:${port}/down` },
        { id: 'dir', name: 'f', kind: 'file', target: dir, maxAgeHours: 1 },
        { id: 'file-old', name: 'g', kind: 'file', target: old, maxAgeHours: 26 },
        { id: 'none', name: 'h', kind: 'file', target: join(dir, 'nope') },
    ];
    try {
        const t0 = Date.now();
        const first = await runChecks(list, [], t0);
        const state = Object.fromEntries(first.map(r => [r.id, `${r.state} ${r.text}`]));
        assert.equal(state['tcp-ok'], 'ok erreichbar');
        assert.match(state['tcp-fail'], /^fail ECONNREFUSED/);
        assert.equal(state['http-ok'], 'ok HTTP 200');
        assert.equal(state['http-text'], 'fail HTTP 200, Text fehlt');
        assert.equal(state['http-503'], 'fail HTTP 503');
        assert.match(state.dir, /^ok Stand /);
        assert.match(state['file-old'], /^fail Stand /);
        assert.equal(state.none, 'fail nicht vorhanden');
        const second = await runChecks(list, first, t0 + 1000);
        assert.ok(second.every(r => r.since === t0));
    } finally {
        server.close();
    }
});

test('inventory: platform linux, commands by what sudo allows', () => {
    const c: Collected = {
        distro: 'Debian GNU/Linux 12 (bookworm)',
        model: 'QEMU Standard PC',
        memTotal: 4e9,
        swapTotal: 1e9,
        abilities: { apt: true, reboot: false, pm2: false, docker: false, logs: false, update: false, services: false },
        osUpdates: { packages: [], checkedAt: 1, rebootRequired: false },
        linux: {
            mounts: [{ path: '/', device: '/dev/sda1', fstype: 'ext4', size: 8e10, usedPct: 50, inodesPct: 8 }],
            failedUnits: [],
            ntpSynced: true,
            checksHash: null,
            checks: [],
            journal: null,
            pm2: null,
            docker: null,
            sudo: { apt: true, reboot: false },
        },
    };
    const inv = buildInventory({ uuid: 'u', config: { comment: ' Web\nserver ' }, console: false, c });
    assert.equal(inv.platform, 'linux');
    assert.equal(inv.comment, 'Web server');
    assert.deepEqual(inv.commands, ['checks', 'mcp', 'diagnose', 'osUpgrade']);
    assert.equal(inv.ai, undefined, 'no AI access without BEE_AI');
    assert.deepEqual(inv.remoteAccess, []);
    assert.equal(inv.system.diskTotal, 8e10);
    assert.equal(inv.system.os, 'Debian GNU/Linux 12 (bookworm)');
    assert.equal(inv.linux?.distro, 'Debian GNU/Linux 12 (bookworm)');
    const withConsole = buildInventory({ uuid: 'u', config: { comment: '' }, console: true, ai: true, c: { ...c, abilities: { ...c.abilities, reboot: true, update: true, services: true } } });
    assert.deepEqual(withConsole.remoteAccess, ['console']);
    assert.deepEqual(withConsole.commands, ['checks', 'mcp', 'diagnose', 'osUpgrade', 'reboot', 'agentUpdate', 'unit']);
    assert.equal(withConsole.ai?.setState, false);
    assert.equal(withConsole.ai?.objectChange, false);
});

test('AI tools: only read, arguments checked', async () => {
    const tools = buildTools({ root: new Root('/nonexistent/bee-root'), rootLogs: () => false });
    assert.ok(tools.length >= 15);
    assert.ok(tools.every(t => t.def.annotations?.readOnlyHint === true), 'every tool only reads');
    assert.ok(!tools.some(t => /shell|exec|command|write|restart/i.test(t.def.name)), 'no shell, no writing');
    for (const ok of ['-2h', '-30min', 'today', 'yesterday', '2026-11-15 08:00', '2026-11-15']) {
        assert.ok(JOURNAL_TIME.test(ok), ok);
    }
    for (const bad of ['--output=json', '-2h; rm', '', 'now --all']) {
        assert.ok(!JOURNAL_TIME.test(bad), bad);
    }
    await assert.rejects(logPath('/etc/shadow'), /Nur Dateien unter \/var\/log|gibt es nicht/);
    await assert.rejects(logPath('relative.log'), /absolut/);
    assert.deepEqual(await callTool(tools, 'nope', {}), { text: 'Unbekanntes Werkzeug: nope', isError: true });
    const badUnit = await callTool(tools, 'service_status', { unit: '--user' });
    assert.equal(badUnit.isError, true);
    assert.match(badUnit.text, /Ungültiger Name/);
    const badPrio = await callTool(tools, 'read_journal', { priority: 'all' });
    assert.equal(badPrio.isError, true);
    const badGrep = await callTool(tools, 'read_journal', { grep: '(' });
    assert.match(badGrep.text, /regulärer Ausdruck/);
    const noRoot = await callTool(tools, 'nginx_test', {});
    assert.match(noRoot.text, /LOGS=1/);
    const badContainer = await callTool(tools, 'docker_logs', { name: '--all' });
    assert.match(badContainer.text, /Ungültiger Name/);
    const badConn = await callTool(tools, 'test_connection', { kind: 'tcp', target: 'nohost' });
    assert.match(badConn.text, /host:port/);
});

test('update of the agent: the newest version, and package.json fits the agent', () => {
    assert.equal(parseLatest('{"name":"bee-linux","version":"0.3.1"}'), '0.3.1');
    assert.equal(parseLatest('{"version":"1.0.0-beta.2"}'), '1.0.0-beta.2');
    assert.equal(parseLatest('{"version":"0.3; rm -rf /"}'), null);
    assert.equal(parseLatest('<html>404</html>'), null);
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(pkg.version, AGENT_VERSION, 'the portal compares the version of package.json on GitHub with the agent');
});

test('npx bee-linux: options, arguments for install.sh, the token never on the command line', () => {
    assert.equal(DEFAULT_URL, 'https://beekeeper.one');
    assert.equal(normalizeUrl('beekeeper.one'), 'https://beekeeper.one');
    assert.equal(normalizeUrl('https://beekeeper.one/'), 'https://beekeeper.one');
    assert.equal(normalizeUrl('http://10.0.0.5:8080'), 'http://10.0.0.5:8080');
    assert.throws(() => normalizeUrl('ftp://x'), /Keine Adresse/);
    assert.throws(() => normalizeUrl('https://beekeeper.one/api/enroll'), /Keine Adresse/);

    const { answers, yes } = parseOptions(['--url', 'beekeeper.one', '--token', 'T', '--ai', '--no-console', '--pm2-user', 'root', '-y']);
    assert.equal(yes, true);
    assert.deepEqual(answers, { url: 'https://beekeeper.one', token: 'T', ai: true, console: false, pm2User: 'root' });
    const args = installArgs(answers);
    assert.deepEqual(args, ['--url', 'https://beekeeper.one', '--no-console', '--ai', '--pm2-user', 'root']);
    assert.ok(!args.includes('T'), 'the token goes by the environment');
    assert.deepEqual(installArgs({}), [], 'an update keeps the settings');
    assert.deepEqual(installArgs({ comment: '', update: false, logs: true }), ['--comment', '', '--logs', '--no-update']);
    assert.throws(() => parseOptions(['--shell']), /Unbekannte Option/);
    assert.throws(() => parseOptions(['--url']), /braucht einen Wert/);
    assert.equal(parseOptions(['--purge']).purge, true);
});

test('details of a deviation: fixed reads, the sources of failed SSH logins', async () => {
    const journal = [
        '2026-11-15T08:00:01+01:00 web sshd[1]: Failed password for root from 203.0.113.5 port 4711 ssh2',
        '2026-11-15T08:00:02+01:00 web sshd[1]: Failed password for invalid user admin from 203.0.113.5 port 4712 ssh2',
        '2026-11-15T08:00:03+01:00 web sshd[1]: Invalid user oracle from 198.51.100.7 port 22',
        '2026-11-15T08:00:04+01:00 web sshd[1]: Connection closed',
    ].join('\n');
    const s = summarizeSsh(journal);
    assert.match(s, /^3 fehlgeschlagene Anmeldungen von 2 Adressen/);
    assert.match(s, /2 {2}203\.0\.113\.5/);
    assert.match(s, /admin/);
    assert.match(s, /oracle/);
    assert.ok(SUBJECT.test('certbot.service') && SUBJECT.test('/var/lib/docker') && SUBJECT.test('chk_abc'));
    assert.ok(!SUBJECT.test('a b') && !SUBJECT.test('x;y') && !SUBJECT.test(''));
    const tools = buildTools({ root: new Root('/nonexistent/bee-root'), rootLogs: () => false });
    const unknownCheck = await diagnose(tools, 'check', 'chk_gone', []);
    assert.match(unknownCheck.text, /kennt der Agent nicht/);
    const badUnit = await diagnose(tools, 'unit-failed', '--user', []);
    assert.match(badUnit.text, /Ungültiger Name/);
});
