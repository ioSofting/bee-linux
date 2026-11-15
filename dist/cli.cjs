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
var import_node_readline = require("node:readline");
var import_node_stream = require("node:stream");
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
var Prompt = class {
  muted = false;
  rl;
  constructor() {
    const out = new import_node_stream.Writable({
      write: (chunk, _enc, cb) => {
        if (!this.muted) {
          process.stdout.write(chunk);
        }
        cb();
      }
    });
    this.rl = (0, import_node_readline.createInterface)({ input: process.stdin, output: out, terminal: true });
  }
  ask(question, def = "", secret = false) {
    return new Promise((resolve) => {
      process.stdout.write(`${question}${def ? ` [${def}]` : ""}: `);
      this.muted = secret;
      this.rl.question("", (answer) => {
        if (secret) {
          this.muted = false;
          process.stdout.write("\n");
        }
        resolve(answer.trim() || def);
      });
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
    }
  }
  close() {
    this.rl.close();
  }
};
async function ask(given) {
  const p = new Prompt();
  try {
    const a = { ...given };
    console.log("bee-linux verbindet diesen Server mit dem Portal von Beekeeper. Enter nimmt den Vorschlag.\n");
    while (!a.url) {
      try {
        a.url = normalizeUrl(await p.ask("Server", DEFAULT_URL));
      } catch (e) {
        console.log(e.message);
      }
    }
    while (!a.token) {
      a.token = await p.ask("Enrollment-Token aus dem Portal (Anlage, \u201EEnrollment-Token \u2026\u201C; Eingabe unsichtbar)", "", true);
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
    console.log("");
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
  installArgs,
  main,
  normalizeUrl,
  parseOptions,
  pm2Users
});
