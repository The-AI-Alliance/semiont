import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGEERROR:', e.message));
page.on('console', m => console.log('CONSOLE', m.type() + ':', m.text()));
try {
  await page.goto('http://192.168.64.21:3000/', { timeout: 20000 });
  await page.waitForTimeout(3000);
} catch (e) {
  console.log('GOTO_ERR:', e.message);
}
await browser.close();
