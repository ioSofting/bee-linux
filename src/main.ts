import { Agent } from './agent.js';
import { consoleLog, loadConfig } from './config.js';

const config = loadConfig();
const log = consoleLog(config.debug);
const agent = new Agent(config, log);

let stopping = false;
const shutdown = (signal: string): void => {
    if (stopping) {
        return;
    }
    stopping = true;
    log.info(`${signal}: stopping`);
    const force = setTimeout(() => process.exit(0), 5000);
    force.unref();
    agent.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

agent.start().catch(e => {
    log.error(`Start failed: ${e.message}`);
    process.exit(1);
});
