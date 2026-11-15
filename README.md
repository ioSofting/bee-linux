# bee-linux

The agent of [beekeeper](https://beekeeper.one) for Linux servers (Debian, Ubuntu). It connects the server to the
fleet management and reports what matters to operations: system, filesystems, failed services, the journal, pending
updates, pm2 and Docker, and the result of the checks set in the portal. From the portal, people with the right
permission can install updates, restart the server and, if the owner allows it, open a console.

The agent opens no port. It connects outbound to the beekeeper server (MQTT over TLS with its own device
certificate, plus a WebSocket for the console).

## Installation

Requirements: systemd, Node.js 18 or newer (`node` in the `PATH` of root, not in a home folder), `sudo`. The console
also needs `script` (util-linux).

1. In the portal, create the asset and an enrollment token (asset, "Enrollment-Token …"). The dialog shows the
   command for the server.
2. On the server:

```sh
sudo npx bee-linux@latest install
```

It asks for the server (default `https://beekeeper.one`), the enrollment token (hidden input), a comment and what the
portal may do there (console, AI access, updates of packages, restart, Docker, pm2, updates of bee-linux), then runs
`install.sh` of the package. The server then appears in the portal. Check the log with `journalctl -u bee-linux -f`.

Without questions (scripts, images): `sudo BEE_TOKEN=<token> npx bee-linux@latest install --yes [options]`. The token
goes to `install.sh` by the environment, not on its command line.

| Option | Meaning |
| --- | --- |
| `--token T` | one-time enrollment token from the portal (better: `BEE_TOKEN` in the environment) |
| `--url URL` | the beekeeper server (default `https://beekeeper.one`) |
| `--comment TEXT` | shown in the portal |
| `--console` / `--no-console` | allow the console in the portal (default off) |
| `--ai` / `--no-ai` | allow the AI access, read only (default off; see below) |
| `--logs` / `--no-logs` | let the AI also read logs of Docker and pm2, `nginx -t` and `certbot certificates` (default off) |
| `--update` / `--no-update` | allow updates of bee-linux itself from the portal (default on) |
| `--apt` / `--no-apt` | allow updates of packages from the portal (default on) |
| `--reboot` / `--no-reboot` | allow a restart from the portal (default on) |
| `--services` / `--no-services` | restart a failed service from the portal, or clear its failed state (default on; only failed ones) |
| `--docker` / `--no-docker` | report the containers of Docker (default on if Docker is installed) |
| `--pm2-user USER` | report the processes of pm2 of this user |
| `--yes` | no questions |

Later: `sudo npx bee-linux@latest update` (keeps the settings; an option changes one),
`sudo npx bee-linux@latest uninstall [--purge]` (`--purge` also removes the settings, the enrollment and the user).
`install.sh` takes the same options and works from a clone of this repository as well.

### Updates from the portal

The agent looks up the newest version on npm every 6 hours (`https://registry.npmjs.org/bee-linux/latest`); the portal
shows it in the row "Agent" with the button "Aktualisieren". The helper then downloads the package of that version,
always from `registry.npmjs.org` (the portal can start an update, but never say where the code comes from), checks it
against the checksum (sha512) the registry gives, and runs its `install.sh` in a unit of its own; that keeps the
settings and restarts the service. The output is in `/var/log/bee-linux/update.log`. `UPDATE=0` in `root.conf`
(`--no-update`) switches both off.

## Publishing (maintainers)

GitHub Actions publishes (`.github/workflows/test-and-release.yml`, trusted publishing on npm, no token):

1. Set the new version in `package.json` and `AGENT_VERSION` in `src/agent.ts` (a test checks they are the same, and
   the helper refuses a package whose agent has another version), `npm run build`, commit.
2. `git tag v0.4.1 && git push && git push --tags`.

The workflow tests on Node.js 20, 22 and 24, checks that the tag is that version, publishes on npm and creates the
GitHub release. A pre-release tag (`v0.5.0-beta.1`) goes to the dist-tag `next`, so the agents do not offer it.

## What it sets up

| Where | What |
| --- | --- |
| user `bee` | system user without login; groups `systemd-journal` and `adm` to read the journal and the logs |
| `/opt/bee-linux` | `bee-linux.cjs` (the agent, one file) and `bee-root` (the helper for root), owned by root |
| `/etc/bee-linux/bee-linux.env` | settings of the agent (`BEE_URL`, `BEE_TOKEN`, `BEE_COMMENT`, `BEE_CONSOLE`, `BEE_AI`, `BEE_CHECK`, `BEE_HEARTBEAT`, `BEE_APT_UPDATE`) |
| `/etc/bee-linux/root.conf` | what the helper may do as root (`APT`, `REBOOT`, `DOCKER`, `PM2_USER`, `LOGS`, `UPDATE`, `SERVICES`) |
| `/var/lib/bee-linux` | device certificate, UUID and the checks from the portal; keep it, or the server enrolls anew |
| `/etc/sudoers.d/bee-linux` | `bee` may run `/opt/bee-linux/bee-root` without a password, nothing else |
| `bee-linux.service` | the service (systemd), as user `bee` |

## Security

- The agent runs as the unprivileged user `bee`. What needs root goes through `/opt/bee-linux/bee-root`, a short shell
  script owned by root that allows fixed actions only: `apt-get update`, `apt-get install --only-upgrade` of package
  names (checked, never options: `apt-get -o` could run anything as root), a reboot, the name, status and restarts of
  pm2 processes (not their environment, which holds passwords), and `docker ps`. `root.conf` switches each of them on
  or off. The user `bee` is not in the group `docker` (that would be root).
- An upgrade runs in a unit of its own (`systemd-run`), so a restart of bee-linux does not kill dpkg. needrestart only
  lists, it restarts nothing by itself. The output is in `/var/log/bee-linux/apt-upgrade.log` and in the portal.
- The console runs as `bee`. For root, use `su -` or `sudo` with a password: the button "Passwort" of the console types
  one from the access data of the asset without showing it. Every console is in the audit log of the portal.
- The server decides nothing about targets on the device: the checks are validated on both sides (unit names,
  host:port, http(s) addresses, absolute paths), and the console address must belong to the own server.
- The AI access has no shell and nothing that writes: only the fixed tools below, each with checked arguments.

## Deviations in the portal

A click on a deviation of the server opens it with the details read live from the server (only reading, the same
fixed reads as the tools of the AI access): the state and journal of a failed service, the sources and user names of
failed SSH logins, the errors of the kernel, the filesystems, the result of a check run again, the log of a container or
of a pm2 process (with `LOGS=1`), the pending updates. Buttons there restart a failed service or clear its failed
state (`SERVICES=1`), install updates, restart the server, open the console or an AI session.

## Checks

Set per asset in the portal ("Prüfungen"). The agent runs them every minute (`BEE_CHECK`); a failure is a deviation
of the asset with the severity set for the check.

| Kind | Target | Fails when |
| --- | --- | --- |
| Service | unit of systemd | `systemctl is-active` is not `active` |
| Website | `http(s)://…` | no answer, another status (default 200–399), or the text is missing |
| Certificate | `host:port` | invalid, expired, or warning `warnDays` before the end (default 14) |
| Port | `host:port` | no TCP connection |
| File / backup | path | the file (or the newest file in the folder) is older than `maxAgeHours` (default 26) |
| Journal pattern | unit or empty | more than `maxCount` lines match the pattern in `windowMinutes` |

Without any check the agent still reports failed units, full filesystems (space and inodes), pending updates (with
security updates separately), a pending reboot, the clock (NTP), pm2 processes that do not run and Docker containers
that restart, are unhealthy or ended with an error.

## AI access

With `BEE_AI=true` (`--ai`) an AI of the integrator can investigate the server through the MCP server of beekeeper
(`device_list_tools`, `device_call_tool`), but only while a person opened an AI session for the asset in the portal
(button "KI-Zugang", with a purpose and an end). Every call is in the audit log of the asset. The tools run as the
user `bee`, read only, and never get a shell:

| Tool | What it reads |
| --- | --- |
| `overview` | system, load, memory, filesystems, failed units, clock |
| `list_services`, `list_timers`, `service_status` | units of systemd, their state and the last lines of their journal |
| `read_journal` | the journal, filtered by unit, priority, time and a pattern |
| `list_log_files`, `read_log_file` | files below `/var/log` that `bee` may read (groups `adm`, `systemd-journal`) |
| `list_processes` | processes with CPU and memory (program names, no command lines: they may hold passwords) |
| `listening_ports`, `network`, `test_connection` | open ports, addresses and routes, a test of tcp, http(s) or a certificate |
| `package_updates`, `package_info` | pending updates, one package |
| `docker_containers`, `pm2_list` | containers and pm2 processes (as reported) |
| `docker_logs`, `pm2_logs`, `nginx_test`, `certbot_certificates` | through the helper; only with `LOGS=1` in `root.conf` (`--logs`) |

## Development

```sh
npm install
npm test          # tests of the parsers and checks
npm run check-ts  # type check
npm run build     # dist/bee-linux.cjs (committed: install.sh takes it from here)
```

`src/lib/protocol.ts` and `src/lib/tunnel.ts` are copies of the files of the beekeeper server and must stay identical
to them.

## License

Proprietary, see [LICENSE](LICENSE).
