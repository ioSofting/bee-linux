#!/usr/bin/env node
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cli.ts
var cli_exports = {};
__export(cli_exports, {
  DEFAULT_URL: () => DEFAULT_URL,
  TOKEN_RE: () => TOKEN_RE,
  checkServer: () => checkServer,
  editLine: () => editLine,
  installArgs: () => installArgs,
  main: () => main,
  normalizeUrl: () => normalizeUrl,
  parseOptions: () => parseOptions,
  pm2Users: () => pm2Users
});
module.exports = __toCommonJS(cli_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var DEFAULT_URL = "https://beekeeper.one";
var ENV_FILE = "/etc/bee-linux/bee-linux.env";
function installArgs(a) {
  const args = [];
  const flag = (value, name) => {
    if (value !== void 0) {
      args.push(value ? `--${name}` : `--no-${name}`);
    }
  };
  if (a.url) {
    args.push("--url", a.url);
  }
  if (a.comment !== void 0) {
    args.push("--comment", a.comment);
  }
  flag(a.console, "console");
  flag(a.ai, "ai");
  flag(a.logs, "logs");
  flag(a.apt, "apt");
  flag(a.reboot, "reboot");
  flag(a.docker, "docker");
  flag(a.update, "update");
  flag(a.services, "services");
  if (a.pm2User !== void 0) {
    args.push("--pm2-user", a.pm2User);
  }
  return args;
}
function parseOptions(argv) {
  const answers = {};
  let yes = false;
  let purge = false;
  const bools = {
    console: "console",
    ai: "ai",
    logs: "logs",
    apt: "apt",
    reboot: "reboot",
    docker: "docker",
    update: "update",
    services: "services"
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === void 0) {
        throw new Error(`${arg} braucht einen Wert`);
      }
      return v;
    };
    const m = /^--(no-)?([a-z0-9-]+)$/.exec(arg);
    if (arg === "-y" || arg === "--yes") {
      yes = true;
    } else if (arg === "--purge") {
      purge = true;
    } else if (arg === "--url") {
      answers.url = value();
    } else if (arg === "--token") {
      answers.token = value();
    } else if (arg === "--comment") {
      answers.comment = value();
    } else if (arg === "--pm2-user") {
      answers.pm2User = value();
    } else if (m && bools[m[2]]) {
      answers[bools[m[2]]] = !m[1];
    } else {
      throw new Error(`Unbekannte Option ${arg}`);
    }
  }
  if (answers.url !== void 0) {
    answers.url = normalizeUrl(answers.url);
  }
  return { answers, yes, purge };
}
function normalizeUrl(text) {
  const t = text.trim().replace(/\/+$/, "");
  const url = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
  if (!/^https?:$/.test(url.protocol) || url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`Keine Adresse eines Servers: ${text}`);
  }
  return url.origin;
}
function pm2Users() {
  const users = [];
  if ((0, import_node_fs.existsSync)("/root/.pm2")) {
    users.push("root");
  }
  try {
    for (const name of (0, import_node_fs.readdirSync)("/home")) {
      if (/^[a-z_][a-z0-9_-]*$/.test(name) && (0, import_node_fs.existsSync)((0, import_node_path.join)("/home", name, ".pm2"))) {
        users.push(name);
      }
    }
  } catch {
  }
  return users;
}
function has(cmd) {
  return (process.env.PATH || "/usr/bin:/bin").split(":").some((dir) => {
    try {
      return (0, import_node_fs.statSync)((0, import_node_path.join)(dir, cmd)).isFile();
    } catch {
      return false;
    }
  });
}
function editLine(text, input, secret = false, skipLf = false) {
  const chars = Array.from(text);
  let echo = "";
  const keys = Array.from(input);
  let i = 0;
  if (skipLf && keys[0] === "\n") {
    i = 1;
  }
  for (; i < keys.length; i++) {
    const ch = keys[i];
    const code = ch.codePointAt(0);
    if (ch === "\r" || ch === "\n") {
      return { text: chars.join(""), echo, end: "enter", rest: keys.slice(i + 1).join(""), skipLf: ch === "\r" };
    }
    if (ch === "" || ch === "" && !chars.length) {
      return { text: chars.join(""), echo, end: "abort", rest: "", skipLf: false };
    }
    if (ch === "\x7F" || ch === "\b") {
      if (chars.length) {
        chars.pop();
        echo += "\b \b";
      }
    } else if (ch === "") {
      echo += "\b \b".repeat(chars.length);
      chars.length = 0;
    } else if (ch === "\x1B") {
      if (keys[i + 1] === "[") {
        i += 2;
        while (i < keys.length && !/[\x40-\x7e]/.test(keys[i])) {
          i++;
        }
      } else {
        i++;
      }
    } else if (code >= 32 && code !== 127 && !(code >= 128 && code < 160)) {
      chars.push(ch);
      echo += secret ? "*" : ch;
    }
  }
  return { text: chars.join(""), echo, rest: "", skipLf: false };
}
var Prompt = class {
  pending = "";
  skipLf = false;
  stdin = process.stdin;
  constructor() {
    this.stdin.setEncoding("utf8");
    this.stdin.setRawMode?.(true);
    this.stdin.resume();
  }
  ask(question, def = "", secret = false) {
    process.stdout.write(`${question}${def ? ` [${def}]` : ""}: `);
    return new Promise((resolve) => {
      let text = "";
      const onData = (chunk) => {
        const r = editLine(text, chunk.toString(), secret, this.skipLf);
        this.skipLf = false;
        text = r.text;
        if (r.echo) {
          process.stdout.write(r.echo);
        }
        if (!r.end) {
          return;
        }
        this.stdin.off("data", onData);
        process.stdout.write("\n");
        if (r.end === "abort") {
          this.close();
          console.log("Abgebrochen.");
          process.exit(130);
        }
        this.pending = r.rest;
        this.skipLf = r.skipLf;
        resolve(text.trim() || def);
      };
      this.stdin.on("data", onData);
      if (this.pending) {
        const p = this.pending;
        this.pending = "";
        onData(p);
      }
    });
  }
  async yesNo(question, def) {
    for (; ; ) {
      const a = (await this.ask(`${question} ${def ? "[J/n]" : "[j/N]"}`)).toLowerCase();
      if (!a) {
        return def;
      }
      if (/^(j|ja|y|yes)$/.test(a)) {
        return true;
      }
      if (/^(n|nein|no)$/.test(a)) {
        return false;
      }
      console.log("Bitte j oder n.");
    }
  }
  close() {
    this.stdin.setRawMode?.(false);
    this.stdin.pause();
  }
};
var TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}$/;
async function checkServer(url, timeoutMs = 1e4) {
  if (typeof fetch !== "function") {
    return null;
  }
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok === true && typeof body.transport === "string") {
      return null;
    }
    return `unter ${url} antwortet kein Beekeeper-Server (HTTP ${res.status})`;
  } catch (e) {
    const err = e;
    return `${url} nicht erreichbar: ${err.cause?.code || err.cause?.message || err.message}`;
  }
}
async function ask(given) {
  const p = new Prompt();
  try {
    const a = { ...given };
    console.log("bee-linux verbindet diesen Server mit dem Portal von Beekeeper. Enter nimmt den Vorschlag in [ ].");
    while (!a.url) {
      let url;
      try {
        url = normalizeUrl(await p.ask("Server", DEFAULT_URL));
      } catch (e) {
        console.log(e.message);
        continue;
      }
      const problem = await checkServer(url);
      if (!problem || (console.log(`Achtung: ${problem}`), await p.yesNo("Trotzdem verwenden?", false))) {
        a.url = url;
      }
    }
    while (!a.token) {
      const token = await p.ask("Enrollment-Token aus dem Portal (Anlage, \u201EEnrollment-Token \u2026\u201C)", "", true);
      if (TOKEN_RE.test(token)) {
        a.token = token;
      } else if (token) {
        console.log("Das ist kein Enrollment-Token (Form: name.zeichenfolge). Im Portal kopieren und hier einf\xFCgen.");
      }
    }
    a.comment ??= await p.ask("Kommentar im Portal, z. B. \u201EWebserver Kunde M\xFCller\u201C (leer: keiner)");
    a.console ??= await p.yesNo("Konsole im Portal erlauben (Shell als Nutzer bee)?", false);
    a.ai ??= await p.yesNo("KI-Zugang erlauben (nur lesen: Journal, Logs, Dienste; keine Shell)?", false);
    if (a.ai) {
      a.logs ??= await p.yesNo("Darf die KI auch Logs von Docker und pm2, nginx -t und certbot lesen (\xFCber root)?", false);
    }
    a.apt ??= await p.yesNo("Pakete aus dem Portal aktualisieren (apt)?", true);
    a.reboot ??= await p.yesNo("Neustart des Servers aus dem Portal?", true);
    a.services ??= await p.yesNo("Fehlgeschlagene Dienste aus dem Portal neu starten?", true);
    if (has("docker")) {
      a.docker ??= await p.yesNo("Container von Docker melden?", true);
    }
    if (a.pm2User === void 0) {
      const users = pm2Users();
      if (users.length === 1) {
        a.pm2User = await p.yesNo(`Prozesse von pm2 des Nutzers ${users[0]} melden?`, true) ? users[0] : "";
      } else if (users.length > 1) {
        a.pm2User = await p.ask(`Prozesse von pm2 welches Nutzers melden (${users.join(", ")}; leer: keine)`);
      }
    }
    a.update ??= await p.yesNo("bee-linux aus dem Portal aktualisieren (von npm)?", true);
    console.log(`
Server ${a.url}${a.comment ? `, Kommentar \u201E${a.comment}\u201C` : ""}`);
    return await p.yesNo("Jetzt installieren?", true) ? a : null;
  } finally {
    p.close();
  }
}
function runInstall(pkg, args, token) {
  return new Promise((resolve) => {
    const child = (0, import_node_child_process.spawn)("bash", [(0, import_node_path.join)(pkg, "install.sh"), "--source", pkg, ...args], {
      stdio: "inherit",
      env: { ...process.env, ...token ? { BEE_TOKEN: token } : {} }
    });
    child.on("error", (e) => {
      console.error(`bee-linux: ${e.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
var HELP = `bee-linux: der Agent von Beekeeper f\xFCr Linux-Server

  sudo npx bee-linux@latest install      installieren (fragt nach Server, Token und Rechten) oder aktualisieren
  sudo npx bee-linux@latest update       aktualisieren, Einstellungen bleiben
  sudo npx bee-linux@latest uninstall [--purge]

Optionen f\xFCr install (ohne Fragen mit --yes): --url URL, --token T, --comment TEXT, --pm2-user NAME,
  --console, --ai, --logs, --apt, --reboot, --services, --docker, --update (jeweils auch --no-...)
`;
async function main(argv, pkg, version) {
  const [cmd = "help", ...rest] = argv;
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(version);
    return 0;
  }
  if (!["install", "update", "uninstall"].includes(cmd)) {
    console.log(HELP);
    return cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 1;
  }
  let opts;
  try {
    opts = parseOptions(rest);
  } catch (e) {
    console.error(`bee-linux: ${e.message}

${HELP}`);
    return 1;
  }
  if (process.platform !== "linux") {
    console.error("bee-linux: nur f\xFCr Linux");
    return 1;
  }
  if (process.getuid?.() !== 0) {
    console.error(`bee-linux: bitte als root: sudo npx bee-linux@latest ${cmd}`);
    return 1;
  }
  if (cmd === "uninstall") {
    return runInstall(pkg, ["--uninstall", ...opts.purge ? ["--purge"] : []]);
  }
  const installed = (0, import_node_fs.existsSync)(ENV_FILE);
  let answers = { ...opts.answers, token: opts.answers.token ?? process.env.BEE_TOKEN };
  if (!installed && cmd === "update") {
    console.error("bee-linux: noch nicht installiert: sudo npx bee-linux@latest install");
    return 1;
  }
  if (!installed && !opts.yes && process.stdin.isTTY) {
    answers = await ask(answers);
    if (!answers) {
      console.log("Abgebrochen.");
      return 1;
    }
  } else if (!installed && !answers.token) {
    console.error("bee-linux: erste Installation ohne Terminal: --token <Enrollment-Token> (oder BEE_TOKEN) n\xF6tig");
    return 1;
  }
  console.log(`bee-linux ${version}${installed ? ": Aktualisierung, die Einstellungen bleiben" : ""}`);
  return runInstall(pkg, installArgs(answers), answers.token);
}
if (typeof require !== "undefined" && require.main === module) {
  const pkg = (0, import_node_path.dirname)(__dirname);
  let version = "?";
  try {
    version = JSON.parse((0, import_node_fs.readFileSync)((0, import_node_path.join)(pkg, "package.json"), "utf8")).version;
  } catch {
  }
  main(process.argv.slice(2), pkg, version).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`bee-linux: ${e?.message ?? e}`);
      process.exit(1);
    }
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_URL,
  TOKEN_RE,
  checkServer,
  editLine,
  installArgs,
  main,
  normalizeUrl,
  parseOptions,
  pm2Users
});
