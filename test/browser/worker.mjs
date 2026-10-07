import { runScenarios } from './run-scenarios.mjs';

runScenarios().then(
    (observations) => postMessage({ observations }),
    (error) => postMessage({ error: String(error?.stack ?? error) })
);
