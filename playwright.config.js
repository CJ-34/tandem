'use strict';
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  // On CI a failed test runs once more and is reported as flaky if it then
  // passes; the trace of the failed attempt is kept in the uploaded report.
  retries: process.env.CI ? 1 : 0,
  use: { trace: 'retain-on-failure' },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
