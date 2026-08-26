import asyncio, sys
from playwright.async_api import async_playwright

BASE = 'http://localhost:3417'

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path='/opt/pw-browsers/chromium')
        errors = []

        # ---------- 1. logged-out home ----------
        ctx1 = await browser.new_context()
        page = await ctx1.new_page()
        page.on('pageerror', lambda e: errors.append(('logged_out', str(e))))
        await page.goto(BASE + '/')
        await page.wait_for_timeout(400)
        text = await page.inner_text('#root')
        assert 'Connect your Strava' in text, 'expected connect state, got: ' + text[:200]
        await page.screenshot(path='shot_logged_out.png', full_page=True)
        await ctx1.close()

        # ---------- 2. log in (mock), add two runs, verify comparison ----------
        ctx2 = await browser.new_context()
        page = await ctx2.new_page()
        page.on('pageerror', lambda e: errors.append(('main', str(e))))
        page.on('console', lambda m: errors.append(('main console', m.text)) if m.type == 'error' else None)
        await page.goto(BASE + '/auth/strava/login')
        await page.wait_for_timeout(400)
        text = await page.inner_text('#root')
        assert 'Connected as Test' in text, 'expected logged in, got: ' + text[:200]

        rows = page.locator('.activity-row')
        rc = await rows.count()
        print('activity rows:', rc)
        names = await page.locator('.activity-name').all_inner_texts()
        print('names:', names)
        assert 'Evening walk' not in names, 'Walk should be filtered from picker'
        assert set(names) == {'Sunday long run', 'Tempo intervals'}

        for i in range(rc):
            await rows.nth(i).locator('.add-btn').click()
            await page.wait_for_timeout(150)
        await page.wait_for_timeout(1000)
        await page.screenshot(path='shot_comparison.png', full_page=True)

        body_text = await page.inner_text('#root')
        assert 'Overview' in body_text
        assert 'Splits' in body_text
        assert 'Pace' in body_text
        assert 'Elevation' in body_text
        assert 'Heart rate' in body_text

        # verify computed km1 split reflects moving-time exclusion (mock run 1 has a 100s stop)
        split_cells = await page.locator('.splits-table tbody tr').first.inner_text()
        print('km1 split row:', split_cells)

        # ---------- manual add: reject a Walk by id ----------
        await page.fill('#manual-input', '700000003')
        await page.click('.manual-add .btn')
        await page.wait_for_timeout(400)
        toast = page.locator('.toast')
        if await toast.count():
            print('toast after adding a walk id:', await toast.first.inner_text())
            assert 'not a run' in (await toast.first.inner_text()).lower()

        # ---------- share flow ----------
        await page.click('button:has-text("Share this comparison")')
        await page.wait_for_timeout(700)
        share_input = page.locator('.share-link-input')
        assert await share_input.count() == 1
        share_url = await share_input.input_value()
        print('share url:', share_url)
        assert share_url.startswith('http://localhost:3417/s/')
        await page.screenshot(path='shot_share.png', full_page=True)
        await ctx2.close()

        # ---------- 3. visit the share link with NO cookies / logged out ----------
        ctx3 = await browser.new_context()
        page3 = await ctx3.new_page()
        page3.on('pageerror', lambda e: errors.append(('shared', str(e))))
        await page3.goto(share_url)
        await page3.wait_for_timeout(700)
        shared_text = await page3.inner_text('#root')
        assert 'Overview' in shared_text, 'shared link should render comparison without login, got: ' + shared_text[:300]
        assert 'Splits' in shared_text
        assert 'Sunday long run' in shared_text and 'Tempo intervals' in shared_text
        assert 'shared' in shared_text.lower()  # snap-badge text "· shared"
        await page3.screenshot(path='shot_shared_view_logged_out.png', full_page=True)
        await ctx3.close()

        await browser.close()
        print('\n--- ERRORS/CONSOLE ---')
        for e in errors:
            print(e)
        if not errors:
            print('none')
        if errors:
            sys.exit(1)

asyncio.run(main())
