// Set COMFY_TEST_URL to an isolated CPU ComfyUI server running this pack.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

(async () => {
    assert.ok(process.env.COMFY_TEST_URL, 'An isolated ComfyUI test URL is required.');
    const browser = await chromium.launch({ headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    try {
        const context = await browser.newContext({ viewport: { width: 1400, height: 1050 },
            permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage();
        const errors = [];
        let filePickers = 0;
        page.on('pageerror', error => errors.push(error.message));
        page.on('filechooser', () => filePickers++);
        await page.goto(process.env.COMFY_TEST_URL);
        await page.waitForFunction(() => window.comfyAPI?.app?.app?.graph
            && window.LiteGraph?.registered_node_types.A5MultiImageLoad);
        await page.waitForLoadState('networkidle');
        // Upload deterministic fixtures, without depending on the user's images.
        await page.evaluate(async () => {
            const canvas = document.createElement('canvas');
            canvas.width = 71; canvas.height = 43;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#8d32cf'; ctx.fillRect(0, 0, 71, 43);
            ctx.fillStyle = '#e4a015'; ctx.fillRect(10, 8, 30, 20);
            window.multiFixtures = [];
            for (const [type, extension] of [['image/png', 'png'], ['image/jpeg', 'jpg']]) {
                const blob = await new Promise(resolve => canvas.toBlob(resolve, type));
                const body = new FormData();
                body.append('image', blob, `a5-context-menu.${extension}`);
                body.append('type', 'input');
                const result = await (await fetch('/upload/image', { method: 'POST', body })).json();
                multiFixtures.push(result.name);
            }
        });
        for (const vue of [false, true]) {
            await page.evaluate(async vue => {
                const { app, ComfyApp } = await import('/scripts/app.js');
                window.testApp = app; window.testComfyApp = ComfyApp;
                await app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', vue);
                app.graph.clear();
                app.canvas.ds.scale = 0.85; app.canvas.ds.offset = [0, 0];
                const node = LiteGraph.createNode('A5MultiImageLoad');
                node.pos = [200, 100]; app.graph.add(node); node.setSize([300, 620]);
                const widget = node.widgets.find(w => w.name === 'state');
                const state = JSON.parse(widget.value);
                state.slots[0].file = multiFixtures[vue ? 1 : 0];
                state.slots[0].enabled = false;
                state.resize = true;
                widget.value = JSON.stringify(state);
                window.testNode = node; window.testWidget = widget;
                app.graph.setDirtyCanvas(true, true);
            }, vue);
            const slot = index => page.locator(`.a5-multi-tile[data-slot="${index}"]:visible`);
            await slot(0).waitFor();
            await page.waitForFunction(() => document.querySelector('.a5-multi-tile img')?.naturalWidth === 71);
            await slot(0).click({ button: 'right' });
            const menu = page.getByRole('menu', { name: 'Image 1 actions', exact: true });
            await menu.waitFor();
            await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.a5-multi-status').textContent.includes('copied to clipboard'));
            const copiedSize = await page.evaluate(async () => {
                const item = (await navigator.clipboard.read())[0];
                const blob = await item.getType('image/png');
                const bitmap = await createImageBitmap(blob);
                const result = [bitmap.width, bitmap.height]; bitmap.close(); return result;
            });
            assert.deepEqual(copiedSize, [71, 43], 'Copy preserves original size with reference resize enabled');

            await slot(1).click({ button: 'right' });
            assert.ok(await page.getByRole('menuitem', { name: 'Copy image', exact: true }).isDisabled());
            await page.getByRole('menuitem', { name: 'Paste image', exact: true }).click();
            await page.waitForFunction(() => JSON.parse(testWidget.value).slots[1].file !== ''
                && document.querySelector('.a5-multi').getAttribute('aria-busy') === 'false');
            assert.equal(filePickers, 0, 'Right-click paste into empty slot must not open the file picker');
            assert.equal(await page.locator('dialog:visible').count(), 0);
            assert.equal(await page.evaluate(() => JSON.parse(testWidget.value).slots[0].enabled), false);

            await slot(2).click({ button: 'right' });
            await page.keyboard.press('Escape');
            await page.keyboard.press('Control+v');
            await page.waitForFunction(() => JSON.parse(testWidget.value).slots[2].file !== '');
            assert.equal(filePickers, 0, 'Right-click/Escape allows native Ctrl+V into an empty slot');

            await slot(0).click({ button: 'right' });
            await page.getByRole('menuitem', { name: 'Copy (Clipspace)', exact: true }).click();
            const clip = await page.evaluate(() => {
                const loader = LiteGraph.createNode('LoadImage');
                testApp.graph.add(loader);
                testComfyApp.pasteFromClipspace(loader);
                const result = { file: loader.widgets.find(w => w.name === 'image').value,
                    images: testComfyApp.clipspace.images, count: testComfyApp.clipspace.imgs.length,
                    selectedIndex: testComfyApp.clipspace.selectedIndex };
                testApp.graph.remove(loader);
                return result;
            });
            const sourceFile = await page.evaluate(() => JSON.parse(testWidget.value).slots[0].file);
            assert.equal(clip.file.replace(/ \[input\]$/, ''), sourceFile);
            assert.equal(clip.images[0].filename, sourceFile);
            assert.equal(clip.count, 1); assert.equal(clip.selectedIndex, 0);

            await slot(3).click({ button: 'right' });
            await page.mouse.click(1150, 800);
            assert.equal(await page.locator('.a5-multi-image-menu').count(), 0, 'Outside click dismisses');
            await slot(0).click({ button: 'right' });
            if (process.env.MULTI_SCREENSHOT_DIR) {
                await page.screenshot({ path: `${process.env.MULTI_SCREENSHOT_DIR}/context-menu-${vue ? 'nodes2' : 'classic'}.png` });
            }
            await page.evaluate(() => testApp.graph.remove(testNode));
            assert.equal(await page.locator('.a5-multi-image-menu').count(), 0, 'Removing node cleans up menu');
            console.log(`${vue ? 'Nodes 2.0' : 'Classic'}: PNG/JPEG copy, empty-slot paste, Ctrl+V, Clipspace interoperability and menu lifecycle passed.`);
        }
        assert.deepEqual(errors, [], 'No browser errors');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
