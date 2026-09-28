import { expect, test, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const baseURL = 'http://127.0.0.1:5186';
const remote = process.env.MUSE_E2E_REMOTE === '1';
const remoteAPI = 'http://127.0.0.1:8789';
const sessionKey = `muse-session:${remoteAPI}`;
const unique = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

async function readRemoteSession(page: Page) {
  const token = await page.evaluate(key => localStorage.getItem(key), sessionKey);
  expect(Boolean(token && /^[A-Za-z0-9_-]{43}$/.test(token)), '浏览器应保存有效的 43 位身份凭证。').toBe(true);
  return token!;
}

function observeRemoteAuthentication(page: Page) {
  const requests: { method: string; path: string; bearer: boolean; csrf: boolean; cookie: boolean }[] = [];
  const stateResponses: { initialized: boolean }[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== remoteAPI || !url.pathname.startsWith('/api/') || request.method() === 'OPTIONS') return;
    const headers = request.headers();
    requests.push({
      method: request.method(),
      path: url.pathname,
      bearer: /^Bearer [A-Za-z0-9_-]{43}$/.test(headers.authorization || ''),
      csrf: Boolean(headers['x-csrf-token']),
      cookie: Boolean(headers.cookie),
    });
  });
  page.on('response', response => {
    if (response.url() !== `${remoteAPI}/api/state` || response.request().method() !== 'GET') return;
    stateResponses.push({ initialized: Boolean(response.headers()['x-muse-session']) });
  });
  return () => {
    expect(requests.length).toBeGreaterThan(1);
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/api/state', bearer: false, cookie: false });
    expect(requests.slice(1).every(request => request.bearer && !request.cookie), '后续跨域请求必须使用 Bearer，且不发送第三方 Cookie。').toBe(true);
    expect(requests.filter(request => request.method !== 'GET').every(request => request.csrf), '所有写入请求必须同时携带 CSRF。').toBe(true);
    expect(stateResponses.length).toBeGreaterThan(0);
    expect(stateResponses[0].initialized).toBe(true);
    expect(stateResponses.slice(1).every(response => !response.initialized), '已有身份的状态响应不得重新创建会话。').toBe(true);
  };
}

async function openCommunity(page: Page) {
  await page.goto(baseURL);
  await expect(page.locator('.top-user')).toBeEnabled();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Muse 邀请互助');
}

async function rename(page: Page, name: string) {
  await page.locator('.top-user').click();
  const dialog = page.getByRole('dialog', { name: '修改昵称' });
  await dialog.getByLabel('昵称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '保存昵称', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.top-user')).toContainText(name);
}

async function navigate(page: Page, name: string) {
  const navigation = page.getByRole('navigation', { name: '主导航' });
  const button = navigation.getByRole('button', { name: new RegExp(`^${name}`) });
  if (!await button.isVisible()) await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await button.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name === '邀请码广场' ? 'Muse 邀请互助' : name);
}

async function fillPublication(dialog: Locator, code: string, note: string) {
  await dialog.getByLabel('邀请码', { exact: true }).fill(code);
  await dialog.getByLabel('可邀请名额', { exact: true }).fill('1');
  await dialog.getByLabel(/^备注/).fill(note);
  await dialog.getByRole('checkbox', { name: '我已核对可邀请名额' }).check();
}

async function publish(page: Page, code: string, note: string) {
  await page.locator('.publish-button').click();
  const dialog = page.getByRole('dialog', { name: '分享邀请码', exact: true });
  await fillPublication(dialog, code, note);
  await dialog.getByRole('button', { name: '分享邀请码', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, note)).toBeVisible();
}

function card(page: Page, note: string) {
  return page.locator('article.invitation-card').filter({ hasText: note });
}

async function search(page: Page, query: string) {
  await page.getByRole('textbox', { name: '搜索邀请' }).fill(query);
}

async function refresh(page: Page) {
  const response = page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET');
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await response;
  await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
}

async function closeDialog(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

async function verifyFailedMutationDuringRefresh(page: Page) {
  let releaseRefresh!: () => void;
  let finishRefresh!: () => void;
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
  const finishedRefresh = new Promise<void>(resolve => { finishRefresh = resolve; });
  await page.route('**/api/state', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    await heldRefresh;
    await route.fulfill({ response });
    finishRefresh();
  });
  await page.route('**/api/profile', route => {
    const headers: Record<string, string> = remote ? {
      'Access-Control-Allow-Origin': baseURL,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Authorization',
      Vary: 'Origin',
    } : {};
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    return route.fulfill({
      status: 400,
      headers,
      contentType: 'application/json',
      body: JSON.stringify({ error: '浏览器验收强制失败' }),
    });
  });
  try {
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await page.locator('.top-user').click();
    const profile = page.getByRole('dialog', { name: '修改昵称' });
    await profile.getByLabel('昵称', { exact: true }).fill('失败请求验收');
    await profile.getByRole('button', { name: '保存昵称', exact: true }).click();
    await expect(profile.getByRole('alert')).toHaveText('浏览器验收强制失败');
    releaseRefresh();
    await finishedRefresh;
    await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
    await closeDialog(page);
  } finally {
    releaseRefresh();
    await page.unroute('**/api/state');
    await page.unroute('**/api/profile');
  }
}

async function assertNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport);
}

async function assertSeparated(first: Locator, second: Locator) {
  const firstBox = await first.boundingBox();
  const secondBox = await second.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  if (!firstBox || !secondBox) throw new Error('布局验收元素不可见。');
  const intersects = firstBox.x < secondBox.x + secondBox.width - 1 &&
    firstBox.x + firstBox.width > secondBox.x + 1 &&
    firstBox.y < secondBox.y + secondBox.height - 1 &&
    firstBox.y + firstBox.height > secondBox.y + 1;
  expect(intersects, `${await first.textContent()} 与 ${await second.textContent()} 重叠`).toBe(false);
}

test('首访初始化只创建一次会话，响应延迟后仍可保存昵称', async ({ page }) => {
  let initialRequests = 0;
  let finishInitialResponse!: () => void;
  const initialResponseFinished = new Promise<void>(resolve => { finishInitialResponse = resolve; });
  await page.route('**/api/state', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const order = ++initialRequests;
    const response = await route.fetch();
    if (order === 1) await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ response });
    if (order === 1) finishInitialResponse();
  });
  await openCommunity(page);
  await initialResponseFinished;
  const name = `首访验收${unique().slice(-6)}`;
  await rename(page, name);
  expect(initialRequests).toBe(1);
  if (remote) {
    const token = await readRemoteSession(page);
    await page.reload();
    await expect(page.locator('.top-user')).toContainText(name);
    expect(await readRemoteSession(page) === token, '页面刷新后身份凭证应保持不变。').toBe(true);
    const expiredToken = 'A'.repeat(43);
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionKey, value: expiredToken });
    await page.reload();
    await expect(page.locator('.top-user')).toBeEnabled();
    await rename(page, `过期验收${unique().slice(-6)}`);
    const recoveredToken = await readRemoteSession(page);
    expect(recoveredToken !== expiredToken && recoveredToken !== token, '失效身份恢复后必须保存新的身份凭证。').toBe(true);
  } else {
    const cookies = await page.context().cookies();
    expect(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Lax')).toBe(true);
  }
});

test('两个独立身份完成分享、领取、反馈和确认，刷新保留身份与状态', async ({ page: owner, browser }) => {
  const memberContext = await browser.newContext({ baseURL });
  try {
    const member = await memberContext.newPage();
    const suffix = unique().slice(-6);
    const ownerName = `验收分享${suffix}`;
    const memberName = `验收领取${suffix}`;
    const code = `BROWSER-VERIFY-${unique()}`;
    const note = `浏览器验收双人互助 ${unique()}`;
    const assertOwnerAuthentication = remote ? observeRemoteAuthentication(owner) : undefined;
    const assertMemberAuthentication = remote ? observeRemoteAuthentication(member) : undefined;
    await openCommunity(owner);
    await rename(owner, ownerName);
    await publish(owner, code, note);
    await openCommunity(member);
    await rename(member, memberName);
    const ownerSession = remote ? undefined : (await owner.context().cookies()).find(cookie => cookie.httpOnly)!;
    const memberSession = remote ? undefined : (await member.context().cookies()).find(cookie => cookie.httpOnly)!;
    const ownerToken = remote ? await readRemoteSession(owner) : undefined;
    const memberToken = remote ? await readRemoteSession(member) : undefined;
    if (remote) expect(ownerToken !== memberToken, '两个独立浏览器上下文必须拥有不同身份。').toBe(true);
    else expect(ownerSession!.value).not.toBe(memberSession!.value);

    await search(member, ownerName);
    await expect(card(member, note)).toHaveCount(1);
    await search(member, note);
    const invitation = card(member, note);
    await expect(invitation).toHaveCount(1);
    await invitation.getByRole('button', { name: `查看 ${ownerName} 的邀请`, exact: true }).click();
    await expect(member.getByRole('dialog').locator('code')).not.toHaveText(code);
    await closeDialog(member);
    await invitation.getByRole('button', { name: '领取邀请码', exact: true }).click();
    let detail = member.getByRole('dialog', { name: '邀请详情', exact: true });
    await expect(detail.locator('code')).toHaveText(code);
    await expect(detail.locator('.claim-progress .badge')).toHaveText('待使用反馈');
    await detail.getByRole('button', { name: '提交反馈', exact: true }).click();
    const feedback = member.getByRole('dialog', { name: '反馈领取结果' });
    await feedback.getByRole('radio', { name: '已使用，等待确认', exact: true }).check();
    await feedback.getByLabel(/^备注/).fill('浏览器验收：已使用，请分享者核对。');
    await feedback.getByRole('button', { name: '保存反馈', exact: true }).click();
    detail = member.getByRole('dialog', { name: '邀请详情', exact: true });
    await expect(detail.locator('.claim-progress .badge')).toHaveText('待分享者确认');
    await closeDialog(member);
    await navigate(member, '我的领取');
    await member.reload();
    await expect(member.locator('.top-user')).toContainText(memberName);
    await expect(member.locator('.claim-item').filter({ hasText: ownerName }).locator('.badge')).toHaveText('待分享者确认');
    if (remote) expect(await readRemoteSession(member) === memberToken, '领取者刷新后身份凭证应保持不变。').toBe(true);
    else expect((await memberContext.cookies()).find(cookie => cookie.name === memberSession!.name)?.value).toBe(memberSession!.value);

    await refresh(owner);
    await navigate(owner, '我的分享');
    await card(owner, note).getByRole('button', { name: '管理分享', exact: true }).click();
    await owner.getByRole('dialog', { name: '我的邀请' }).getByRole('button', { name: '处理反馈', exact: true }).click();
    const review = owner.getByRole('dialog', { name: '处理领取反馈' });
    await expect(review).toContainText(memberName);
    await review.getByLabel(/^备注/).fill('浏览器验收：已核对，互助完成。');
    await review.getByRole('button', { name: '确认互助', exact: true }).click();
    await expect(owner.getByRole('dialog', { name: '我的邀请' }).locator('.owner-claim-row')).toContainText('互助已确认');
    await closeDialog(owner);

    await refresh(member);
    const claim = member.locator('.claim-item').filter({ hasText: ownerName });
    await expect(claim.locator('.badge')).toHaveText('互助已确认');
    await expect(claim).toContainText('已核对，互助完成。');
    await member.reload();
    await expect(claim.locator('.badge')).toHaveText('互助已确认');
    await expect(member.locator('.top-user')).toContainText(memberName);
    await owner.reload();
    await expect(card(owner, note)).toContainText('1 次互助已确认');
    await expect(owner.locator('.top-user')).toContainText(ownerName);
    if (remote) {
      expect(await readRemoteSession(owner) === ownerToken, '分享者刷新后身份凭证应保持不变。').toBe(true);
      expect(await readRemoteSession(member) === memberToken, '领取者确认后身份凭证应保持不变。').toBe(true);
      assertOwnerAuthentication!();
      assertMemberAuthentication!();
    } else expect((await owner.context().cookies()).find(cookie => cookie.name === ownerSession!.name)?.value).toBe(ownerSession!.value);
  } finally {
    await memberContext.close();
  }
});

test('空邀请和非法链接不能分享，无法使用需要原因，取消领取释放名额', async ({ page: owner, browser }) => {
  const memberContext = await browser.newContext({ baseURL });
  try {
    const member = await memberContext.newPage();
    const note = `浏览器验收校验与取消 ${unique()}`;
    const code = `BROWSER-CANCEL-${unique()}`;
    await openCommunity(owner);
    await verifyFailedMutationDuringRefresh(owner);
    await owner.locator('.publish-button').click();
    const publication = owner.getByRole('dialog', { name: '分享邀请码', exact: true });
    await publication.getByRole('button', { name: '分享邀请码', exact: true }).click();
    await expect(publication.getByRole('alert')).toHaveText('请填写邀请码。');
    await publication.getByRole('button', { name: '邀请链接', exact: true }).click();
    await publication.getByLabel('邀请链接', { exact: true }).fill('https://muse.ai.evil.example/invite');
    await publication.getByRole('button', { name: '分享邀请码', exact: true }).click();
    await expect(publication.getByRole('alert')).toContainText('邀请链接需为 muse.ai 或其子域名的 HTTPS 链接');
    await publication.getByRole('button', { name: '邀请码', exact: true }).click();
    await fillPublication(publication, code, note);
    await publication.getByRole('button', { name: '分享邀请码', exact: true }).click();
    await expect(publication).toBeHidden();

    await openCommunity(member);
    await search(member, note);
    await card(member, note).getByRole('button', { name: '领取邀请码', exact: true }).click();
    await member.getByRole('dialog').getByRole('button', { name: '提交反馈', exact: true }).click();
    const feedback = member.getByRole('dialog', { name: '反馈领取结果' });
    await feedback.getByRole('radio', { name: '邀请码无法使用', exact: true }).check();
    await feedback.getByRole('button', { name: '保存反馈', exact: true }).click();
    await expect(feedback.getByRole('alert')).toHaveText('请填写邀请码无法使用的原因。');
    await feedback.getByLabel('无法使用的原因', { exact: true }).fill('浏览器验收：这是测试码，不能用于官方注册。');
    await feedback.getByRole('button', { name: '保存反馈', exact: true }).click();
    const detail = member.getByRole('dialog', { name: '邀请详情', exact: true });
    await expect(detail.locator('.claim-progress .badge')).toHaveText('已反馈无效');
    await detail.getByRole('button', { name: '取消领取', exact: true }).click();
    await member.getByRole('dialog', { name: '取消这次领取？' }).getByRole('button', { name: '确认', exact: true }).click();
    await expect(member.getByRole('dialog')).toBeHidden();
    await expect(card(member, note).getByRole('button', { name: '领取邀请码', exact: true })).toBeEnabled();
    await navigate(member, '我的领取');
    await expect(member.locator('.claim-item').locator('.badge')).toHaveText('已取消领取');
    await refresh(owner);
    await card(owner, note).getByRole('button', { name: '管理分享', exact: true }).click();
    const management = owner.getByRole('dialog', { name: '我的邀请' });
    await expect(management.locator('.detail-stats').getByText('1 / 1', { exact: true })).toBeVisible();
    await expect(management.locator('.owner-claim-row')).toContainText('已取消领取');
  } finally {
    await memberContext.close();
  }
});

test('分享弹窗焦点循环和 Escape 有效，发布者可暂停、恢复及永久结束分享', async ({ page: owner, browser }) => {
  const memberContext = await browser.newContext({ baseURL });
  try {
    const member = await memberContext.newPage();
    const note = `浏览器验收分享管理 ${unique()}`;
    await openCommunity(owner);
    const trigger = owner.locator('.publish-button');
    await trigger.click();
    const publication = owner.getByRole('dialog', { name: '分享邀请码', exact: true });
    await expect(publication.getByLabel('邀请码', { exact: true })).toBeFocused();
    const first = publication.getByRole('button', { name: '关闭', exact: true });
    const last = publication.getByRole('button', { name: '分享邀请码', exact: true });
    await last.focus();
    await owner.keyboard.press('Tab');
    await expect(first).toBeFocused();
    await owner.keyboard.press('Shift+Tab');
    await expect(last).toBeFocused();
    await owner.locator('.top-user').evaluate((button: HTMLElement) => button.focus());
    await expect(first).toBeFocused();
    await owner.keyboard.press('Escape');
    await expect(publication).toBeHidden();
    await expect(trigger).toBeFocused();

    await publish(owner, `BROWSER-MANAGE-${unique()}`, note);
    await card(owner, note).getByRole('button', { name: '管理分享', exact: true }).click();
    let detail = owner.getByRole('dialog', { name: '我的邀请' });
    await detail.getByRole('button', { name: '暂停分享', exact: true }).click();
    await expect(detail.locator('.detail-top .badge')).toHaveText('已暂停');
    await openCommunity(member);
    await search(member, note);
    await expect(card(member, note).getByRole('button', { name: '已暂停', exact: true })).toBeDisabled();
    await detail.getByRole('button', { name: '恢复分享', exact: true }).click();
    await expect(detail.locator('.detail-top .badge')).toHaveText('可领取');
    await refresh(member);
    await expect(card(member, note).getByRole('button', { name: '领取邀请码', exact: true })).toBeEnabled();
    await detail.getByRole('button', { name: '结束分享', exact: true }).click();
    await owner.getByRole('dialog', { name: '结束这份分享？' }).getByRole('button', { name: '确认', exact: true }).click();
    detail = owner.getByRole('dialog', { name: '我的邀请' });
    await expect(detail.locator('.detail-top .badge')).toHaveText('已结束');
    await expect(detail.getByRole('button', { name: /暂停分享|恢复分享|结束分享/ })).toHaveCount(0);
    await refresh(member);
    await expect(card(member, note).getByRole('button', { name: '已结束', exact: true })).toBeDisabled();
    await closeDialog(owner);
    await owner.reload();
    await card(owner, note).getByRole('button', { name: '管理分享', exact: true }).click();
    await expect(owner.getByRole('dialog').locator('.detail-top .badge')).toHaveText('已结束');
  } finally {
    await memberContext.close();
  }
});

test('390 与 320 像素窄屏长昵称及长邀请码无横向溢出，保留真实验收截图', async ({ page }) => {
  const longName = `浏览器验收${'长'.repeat(11)}`;
  const code = `BROWSER-${'A'.repeat(112)}`;
  const note = `浏览器验收移动端长内容 ${unique()} ${'长备注用于检查窄屏换行与按钮位置。'.repeat(7)}`.slice(0, 160);
  await openCommunity(page);
  await rename(page, longName);
  await publish(page, code, note);
  await navigate(page, '邀请码广场');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => document.fonts.ready);
  const toastClose = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await toastClose.isVisible()) await toastClose.click();
  await expect.poll(() => page.locator('img[src="/muse-avatar.png"]').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: fileURLToPath(new URL('../../muse-invite-preview-desktop.png', import.meta.url)), fullPage: true });

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await search(page, note);
    const invitation = card(page, note);
    await expect(invitation).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await assertSeparated(page.getByRole('heading', { level: 1 }), page.locator('.publish-button'));
    await assertSeparated(page.getByRole('button', { name: '刷新状态', exact: true }), page.locator('.top-user'));
    await assertSeparated(invitation.locator('.invite-person'), invitation.locator('.invite-person-row > .badge'));
    await assertSeparated(invitation.locator('.invite-code-line'), invitation.locator('.invite-note'));
    await assertSeparated(invitation.locator('.invite-note'), invitation.locator('.invite-meta'));
    await assertSeparated(invitation.locator('.confirmed-mini'), invitation.getByRole('button', { name: '管理分享', exact: true }));
    await invitation.getByRole('button', { name: '管理分享', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '我的邀请' });
    await expect(dialog.locator('code')).toHaveText(code);
    await assertNoHorizontalOverflow(page);
    await assertSeparated(dialog.locator('.detail-code'), dialog.locator('.detail-note'));
    await assertSeparated(dialog.getByRole('button', { name: '暂停分享', exact: true }), dialog.getByRole('button', { name: '结束分享', exact: true }));
    const dialogSize = await dialog.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(dialogSize.scroll, JSON.stringify({ viewport, dialogSize })).toBeLessThanOrEqual(dialogSize.client);
    await closeDialog(page);
    await navigate(page, '我的分享');
    await expect(card(page, note)).toBeVisible();
    await navigate(page, '邀请码广场');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await search(page, '浏览器验收');
  await page.screenshot({ path: fileURLToPath(new URL('../../muse-invite-preview-mobile.png', import.meta.url)), fullPage: true });
});

test('旧刷新响应不能覆盖写入后的新昵称，再次刷新必须重新获取状态', async ({ page }) => {
  const suffix = unique().slice(-6);
  const previousName = `旧刷新甲${suffix}`;
  const currentName = `旧刷新乙${suffix}`;
  let manualRequests = 0;
  let releaseOldResponse!: () => void;
  let captureOldState!: () => void;
  let finishOldResponse!: () => void;
  const heldResponse = new Promise<void>(resolve => { releaseOldResponse = resolve; });
  const oldStateCaptured = new Promise<void>(resolve => { captureOldState = resolve; });
  const oldResponseFinished = new Promise<void>(resolve => { finishOldResponse = resolve; });
  await openCommunity(page);
  await rename(page, previousName);
  await page.route('**/api/state', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const order = ++manualRequests;
    const response = await route.fetch();
    if (order === 1) {
      captureOldState();
      await heldResponse;
    }
    await route.fulfill({ response });
    if (order === 1) finishOldResponse();
  });
  try {
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    await oldStateCaptured;
    await rename(page, currentName);
    await page.getByRole('button', { name: '刷新状态', exact: true }).click();
    releaseOldResponse();
    await oldResponseFinished;
    await expect(page.getByRole('button', { name: '刷新状态', exact: true })).toBeEnabled();
    await expect(page.locator('.top-user')).toContainText(currentName);
    expect(manualRequests, '写入后的手动刷新必须重新发起 GET，不能复用写入前的响应。').toBeGreaterThanOrEqual(2);
  } finally {
    releaseOldResponse();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('并发标签共享同一身份，两个页面都能保存昵称并看到相同状态', async ({ page: first, context }) => {
  const second = await context.newPage();
  const suffix = unique().slice(-6);
  const firstName = `并发甲${suffix}`;
  const sharedName = `并发乙${suffix}`;
  let anonymousRequests = 0;
  await context.route('**/api/state', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const headers = await route.request().allHeaders();
    const anonymous = remote ? !headers.authorization : !headers.cookie;
    const order = anonymous ? ++anonymousRequests : 0;
    const response = await route.fetch();
    if (order === 1) await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ response });
  });
  try {
    await Promise.all([openCommunity(first), openCommunity(second)]);
    if (remote) expect(anonymousRequests, '并发首访应只建立一次匿名身份。').toBe(1);
    await rename(first, firstName);
    await rename(second, sharedName);
    await refresh(first);
    await refresh(second);
    await expect(first.locator('.top-user')).toContainText(sharedName);
    await expect(second.locator('.top-user')).toContainText(sharedName);
    if (remote) expect(await readRemoteSession(first) === await readRemoteSession(second), '同一浏览器的两个标签页应共享身份凭证。').toBe(true);
    await Promise.all([first.reload(), second.reload()]);
    await expect(first.locator('.top-user')).toContainText(sharedName);
    await expect(second.locator('.top-user')).toContainText(sharedName);
  } finally {
    await context.unrouteAll({ behavior: 'wait' });
    await second.close();
  }
});
