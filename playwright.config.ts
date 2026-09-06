import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./browser",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:3190", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3190",
    url: "http://127.0.0.1:3190",
    reuseExistingServer: false,
    env: {
      APP_SECRET: "browser-test-access-code",
      ANTHROPIC_API_KEY: "not-a-real-key",
      SESSION_SECRET: "test-session-secret-at-least-32-characters",
    },
  },
});
