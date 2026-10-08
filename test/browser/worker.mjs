import { runSuite } from './run-scenarios.mjs';

// The page posts the suite name; the worker answers with its observations.
onmessage = ({ data }) => {
    runSuite(data.suite).then(
        (observations) => postMessage({ observations }),
        (error) => postMessage({ error: String(error?.stack ?? error) })
    );
};
