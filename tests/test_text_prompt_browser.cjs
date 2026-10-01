// Use an isolated CPU test server, never an active working ComfyUI session.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

async function checkSnippetHistory(page, vue) {
    await page.evaluate(async vue => {
        await testApp.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', vue);
        testApp.graph.clear();
        const node = LiteGraph.createNode('A5TextPrompt');
        node.pos = [180, 170];
        testApp.graph.add(node);
        node.setSize([500, 520]);
        window.testNode = node;
    }, vue);
    const inline = page.locator(vue ? '.lg-node-widgets textarea:visible' : 'textarea.comfy-multiline-input:visible');
    await inline.waitFor();
    const count = () => page.evaluate(() => Number(testNode.__a5TextPromptHistoryControls.indicator.textContent.split('/')[1]));
    const before = await count();
    await inline.fill('Manual ');
    await inline.press('End');
    await page.getByRole('button', { name: 'Insert snippet 1', exact: true }).click();
    await page.getByRole('button', { name: 'Insert snippet 2', exact: true }).click();
    assert.equal(await inline.inputValue(), 'Manual <image 1><image 2>');
    assert.equal(await count(), before, 'Inline snippet clicks must not save partial prompts');
    await inline.evaluate(element => element.blur());
    assert.equal(await count(), before + 1, 'Leaving inline text commits one completed edit');

    await page.getByRole('button', { name: 'Open text editor', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const popout = dialog.getByRole('textbox', { name: 'Prompt text', exact: true });
    await popout.fill('Popout ');
    await dialog.getByRole('button', { name: 'Insert snippet 1', exact: true }).click();
    await dialog.getByRole('button', { name: 'Insert snippet 2', exact: true }).click();
    assert.equal(await popout.inputValue(), 'Popout <image 1><image 2>');
    assert.equal(await count(), before + 1, 'Popout snippet clicks must not save partial prompts');
    await popout.evaluate(element => element.blur());
    assert.equal(await count(), before + 2, 'Leaving popout text commits once');

    await popout.fill('Queued ');
    await dialog.getByRole('button', { name: 'Insert snippet 1', exact: true }).click();
    assert.equal(await count(), before + 2);
    await page.evaluate(() => testNode.widgets.find(w => w.name === 'text').beforeQueued());
    assert.equal(await count(), before + 3, 'Queue commits pending insertion without needing blur');
    await popout.press('Escape');
    assert.equal(await count(), before + 3, 'Closing after queue does not add a duplicate');
}

async function run() {
    assert.ok(process.env.COMFY_TEST_URL, 'Set COMFY_TEST_URL to an isolated ComfyUI test server.');
    const browser = await chromium.launch({
        headless: true,
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    });
    try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(process.env.COMFY_TEST_URL);
        const definitions = await (await page.request.get(`${process.env.COMFY_TEST_URL}/object_info`)).json();
        assert.ok(definitions.A5TextPrompt, 'The pack registers A5TextPrompt');
        assert.equal(definitions.A5TextPromptSnippets, undefined, 'Disable the experiment for this standalone pack test');
        const snippetResponse = await page.request.get(`${process.env.COMFY_TEST_URL}/a5_text_prompt/snippets`);
        assert.equal(snippetResponse.status(), 200, 'The pack registers its own snippet route');
        assert.equal((await snippetResponse.json()).slots.length, 8);
        await page.waitForFunction(() => window.comfyAPI?.app?.app?.graph
            && window.LiteGraph?.registered_node_types.A5TextPrompt);
        await page.waitForLoadState('networkidle');
        await page.evaluate(async () => {
            const { app } = await import('/scripts/app.js');
            await app.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', true);
            window.testApp = app;
            app.graph.clear();
            app.canvas.ds.scale = 1;
            app.canvas.ds.offset = [0, 0];
            const node = LiteGraph.createNode('A5TextPrompt');
            node.pos = [180, 170];
            app.graph.add(node);
            node.setSize([500, 520]);
            window.testNode = node;
            app.graph.setDirtyCanvas(true, true);
        });
        await page.getByRole('button', { name: 'Insert snippet 1', exact: true }).waitFor();
        const settle = () => page.evaluate(() => new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measure = () => page.evaluate(() => {
            const grid = document.querySelector('.lg-node-widgets:has([node-type="A5TextPrompt"])');
            const rows = [...grid.children];
            const height = element => element.getBoundingClientRect().height;
            const rects = rows.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; });
            return {
                node: [...testNode.size], grid: height(grid),
                switch: height(rows[0]), text: height(rows[1]),
                history: height(rows[2]), snippets: height(rows[3]),
                gap: parseFloat(getComputedStyle(grid).rowGap), rects,
                hasRule: getComputedStyle(grid).getPropertyValue('grid-template-rows'),
            };
        });
        const checkLayout = (m, expanded = false) => {
            assert.ok(m.history <= 36, `History must stay compact: ${JSON.stringify(m)}`);
            assert.ok(m.snippets <= (expanded ? 242 : 94), 'Snippet controls must not absorb extra height');
            assert.ok(m.text >= 80, 'Text remains usable');
            const spare = m.grid - m.switch - m.history - m.snippets - m.gap * 3;
            assert.ok(Math.abs(m.text - spare) < 2, 'Text must receive all the remaining grid height');
            m.rects.slice(1).forEach((r, i) => assert.ok(r.top >= m.rects[i].bottom, 'Rows must not overlap'));
        };
        await settle();
        const large = await measure();
        checkLayout(large);
        assert.ok(large.text >= 280, 'Large node must have a large text field');
        const details = page.locator('.a5-snippet-library details');
        await details.locator('summary').click();
        await settle();
        const expanded = await measure();
        checkLayout(expanded, true);
        assert.ok(expanded.snippets > large.snippets + 80);
        await details.locator('summary').click();
        await settle();
        const collapsed = await measure();
        assert.deepEqual(collapsed.node, expanded.node, 'Collapsing must not shrink the user-sized node');
        assert.ok(collapsed.text > expanded.text + 80, 'Collapsed settings give space back to text');
        checkLayout(collapsed);

        for (const [width, height] of [[350, 360], [620, 720], [300, 310]]) {
            await page.evaluate(size => testNode.setSize(size), [width, height]);
            await settle();
            checkLayout(await measure());
        }
        await page.evaluate(() => testNode.setSize([500, 520]));
        await settle();
        if (process.env.A5_LAYOUT_SCREENSHOT) await page.screenshot({ path: process.env.A5_LAYOUT_SCREENSHOT });
        await page.getByRole('button', { name: 'Open text editor', exact: true }).click();
        const dialog = page.getByRole('dialog');
        const text = dialog.getByRole('textbox', { name: 'Prompt text', exact: true });
        await text.fill('Popout still edits the same prompt');
        assert.equal(await page.evaluate(() => testNode.widgets.find(w => w.name === 'text').value), 'Popout still edits the same prompt');
        await text.press('Escape');
        await dialog.waitFor({ state: 'detached' });

        await page.evaluate(async () => {
            await testApp.ui.settings.setSettingValue('Comfy.VueNodes.Enabled', false);
            testNode.setSize([500, 520]);
        });
        await settle();
        const classic = await page.evaluate(() => {
            const widget = testNode.widgets.find(w => w.name === 'a5_snippet_buttons');
            return { grid: !!widget.element.closest('.lg-node-widgets'), height: widget.options.getHeight() };
        });
        assert.equal(classic.grid, false, 'The override cannot match Classic');
        assert.equal(classic.height, 92, 'Classic retains its original snippet height');
        await checkSnippetHistory(page, false);
        await checkSnippetHistory(page, true);
        assert.deepEqual(errors, []);
        console.log('Layout and batched snippet history checks passed in Classic and Nodes 2.0, inline and popout.');
    } finally {
        await browser.close();
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
