import { defineConfig } from '@playwright/test';
import { API_PORT, useTestEnv, WEB_PORT, WEB_URL } from './e2e/test-env.js';

useTestEnv();

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.js',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB_URL,
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    // GPU canvas text anti-aliasing varies under load; posters are compared byte for byte.
    launchOptions: { args: ['--disable-accelerated-2d-canvas', '--disable-gpu'] },
  },
  projects: [
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'desktop', testMatch: /(layout|register|partner-join)\.spec\.js/, use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: 'node --env-file=.env.test apps/api/server.js',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      env: { PORT: String(API_PORT), APP_ORIGIN: WEB_URL },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite apps/web --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
