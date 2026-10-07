import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Browser tests against the built package (run `npm run build` first).
 */
export default defineConfig({
    testDir: 'test/browser',
    testMatch: '**/*.spec.ts',
    reporter: 'list',
    use: {
        baseURL: `http://localhost:${PORT}`,
    },
    webServer: {
        command: `node test/browser/server.mjs ${PORT}`,
        url: `http://localhost:${PORT}/test/browser/harness.html`,
        reuseExistingServer: !process.env.CI,
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ],
});
