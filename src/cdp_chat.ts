import * as http from 'http';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebSocket = require('ws') as typeof import('ws');

interface CdpTarget {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
}

function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

class CdpClient {
    private ws: import('ws');
    private msgId = 1;
    private pending = new Map<number, { resolve: Function, reject: Function }>();

    constructor(wsUrl: string) {
        this.ws = new WebSocket(wsUrl);
        // Add persistent error listener to prevent uncaught WebSocket errors from crashing the extension host process
        this.ws.on('error', (err) => {
            for (const [id, { reject }] of this.pending) {
                reject(err);
            }
            this.pending.clear();
        });
        // Handle socket closure and cleanly reject any pending queries
        this.ws.on('close', () => {
            for (const [id, { reject }] of this.pending) {
                reject(new Error('WebSocket closed'));
            }
            this.pending.clear();
        });
        this.ws.on('message', (raw: Buffer | string) => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id)!;
                    this.pending.delete(msg.id);
                    if (msg.error) reject(new Error(msg.error.message));
                    else resolve(msg.result);
                }
            } catch (parseErr) {
                // Ignore parse errors on malformed messages
            }
        });
    }

    async connect(): Promise<void> {
        // Asynchronously establish connection to Chrome DevTools Protocol WebSocket
        return new Promise((resolve, reject) => {
            if (this.ws.readyState === 1) { // WebSocket.OPEN
                resolve();
                return;
            }
            if (this.ws.readyState === 2 || this.ws.readyState === 3) { // CLOSING or CLOSED
                reject(new Error('WebSocket is already closed or closing'));
                return;
            }
            const timer = setTimeout(() => {
                reject(new Error('WebSocket connection timeout'));
            }, 6000);
            this.ws.once('open', () => {
                clearTimeout(timer);
                resolve();
            });
            this.ws.once('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    async send(method: string, params: object = {}, timeoutMs = 15000): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.msgId++;
            this.pending.set(id, { resolve, reject });
            try {
                this.ws.send(JSON.stringify({ id, method, params }));
            } catch (err) {
                this.pending.delete(id);
                reject(err);
                return;
            }
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`Timeout waiting for CDP response (${method})`));
                }
            }, timeoutMs);
        });
    }

    close() {
        try {
            if (this.ws.readyState === 0 || this.ws.readyState === 1) {
                this.ws.close();
            }
        } catch (e) {
            // Silently ignore any closing exceptions
        }
    }
}

/**
 * Check if a CDP target URL belongs to the Antigravity 1.11.0+ embedded chat iframe.
 */
function isEmbeddedChatTarget(target: CdpTarget): boolean {
    const url = target.url || '';
    return target.type === 'iframe' && (
        url.includes('extensionView=true') ||
        url.includes('hostVariant=antigravity-ide') ||
        /https?:\/\/127\.0\.0\.1:\d+\/c\//.test(url)
    );
}

/**
 * Filter and prioritize CDP targets to locate the chat UI accurately.
 * Excludes self extension settings and prioritizes embedded Antigravity chat iframes over webviews and pages.
 */
function getFilteredChatCandidates(targets: CdpTarget[]): CdpTarget[] {
    const candidates = targets.filter(t =>
        (t.type === 'page' || t.type === 'iframe' || t.type === 'webview') &&
        t.webSocketDebuggerUrl &&
        !t.url.includes('devtools://') &&
        !t.title.includes('Extension: Antigravity Telegram Control') &&
        !t.url.includes('extensionId=acmatvjrus.antigravity-telegram-control')
    );

    const scoreTarget = (t: CdpTarget): number => {
        if (isEmbeddedChatTarget(t)) {
            return 100;
        }
        if (t.type === 'webview' || (t.url || '').startsWith('vscode-webview://')) {
            return 50;
        }
        let score = t.type === 'page' ? 20 : 10;
        if (t.title.toLowerCase().includes('antigravity')) {
            score += 5;
        }
        return score;
    };

    candidates.sort((a, b) => scoreTarget(b) - scoreTarget(a));

    return candidates;
}

/**
 * Main export — search ALL possible page/iframe targets and inject the chat message using native input emulation.
 */
export async function sendViaCDP(text: string, port: number): Promise<void> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);

    // Filter to any target that could reasonably host the chat UI
    const candidates = getFilteredChatCandidates(targets);

    let allDebugs: string[] = [];

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            // 1. Locate the chat editor, focus it, clear existing content, and attempt direct text insertion
            const focusResult = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        ${SCROLL_INJECTION_JS}

                        const escapedText = ${JSON.stringify(text)};
                        
                        // Look specifically for the contenteditable used by the chat input (Fast direct search first, then deep search)
                        const selectors = [
                            '[data-testid="agent-input-box"] [contenteditable="true"]',
                            '[aria-label="Message input"][contenteditable="true"]',
                            '[data-lexical-editor="true"][contenteditable="true"]',
                            '[role="combobox"][contenteditable="true"]',
                            '#conversation [contenteditable="true"]', 
                            '#chat [contenteditable="true"]', 
                            '#cascade [contenteditable="true"]', 
                            '.chat-input [contenteditable="true"]', 
                            '.interactive-input-editor [contenteditable="true"]', 
                            '[role="textbox"][contenteditable="true"]',
                            '.chat-input', 
                            'textarea'
                        ];
                        const combinedChatSelectors = selectors.join(', ');

                        const isValidEditor = (el) => {
                            if (!el || el.offsetParent === null) return false;
                            const cls = typeof el.className === 'string' ? el.className : '';
                            if (cls.includes('xterm')) return false;
                            const r = el.getBoundingClientRect();
                            return r.width > 0 && r.height > 0 && r.right > 0;
                        };

                        let editor = null;
                        try {
                            const directMatches = Array.from(document.querySelectorAll(combinedChatSelectors));
                            editor = directMatches.find(isValidEditor) || null;
                        } catch(e) {}

                        // Deep search through shadow roots only if not found in root document
                        if (!editor) {
                            editor = await querySelectorDeep(combinedChatSelectors);
                            if (!isValidEditor(editor)) {
                                editor = null;
                            }
                        }

                        if (!editor) return { found: false, error: "editor_not_found" };

                        editor.focus();
                        
                        // Clear existing text securely
                        try {
                            document.execCommand("selectAll", false, null);
                            document.execCommand("delete", false, null);
                        } catch(e) {}

                        const isLexical = editor.hasAttribute('data-lexical-editor');
                        // Try to insert text securely via execCommand first
                        let inserted = false;
                        try { 
                            inserted = !!document.execCommand("insertText", false, escapedText); 
                        } catch(e) {}

                        const currentVal = editor.tagName === 'TEXTAREA' ? (editor.value || '') : (editor.textContent || '');
                        if (inserted && escapedText.length > 0 && !currentVal.includes(escapedText.slice(0, 12))) {
                            inserted = false;
                        }

                        return {
                            found: true,
                            inserted,
                            isLexical,
                            isTextarea: editor.tagName === 'TEXTAREA'
                        };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            const focusVal = focusResult?.result?.value;

            if (!focusVal || !focusVal.found) {
                client.close();
                allDebugs.push(`[${target.type}] ${target.title}: ${focusVal?.error || 'No chat input element found'}`);
                continue;
            }

            // If execCommand did not insert cleanly (common in Lexical editors), use trusted CDP Input.insertText
            if (!focusVal.inserted) {
                try {
                    await client.send('Input.insertText', { text });
                } catch (e) {
                    // Fallback handled in step 2 below if editor remains empty
                }
            }

            // 2. Verify insertion (apply React DOM fallback if still empty) and submit the message
            const submitResult = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        ${SCROLL_INJECTION_JS}

                        const escapedText = ${JSON.stringify(text)};
                        const selectors = [
                            '[data-testid="agent-input-box"] [contenteditable="true"]',
                            '[aria-label="Message input"][contenteditable="true"]',
                            '[data-lexical-editor="true"][contenteditable="true"]',
                            '[role="combobox"][contenteditable="true"]',
                            '#conversation [contenteditable="true"]', 
                            '#chat [contenteditable="true"]', 
                            '#cascade [contenteditable="true"]', 
                            '.chat-input [contenteditable="true"]', 
                            '.interactive-input-editor [contenteditable="true"]', 
                            '[role="textbox"][contenteditable="true"]',
                            '.chat-input', 
                            'textarea'
                        ];
                        const editor = document.querySelector(selectors.join(', ')) || await querySelectorDeep(selectors.join(', '));
                        if (!editor) return { found: false, error: "editor_not_found_after_insert" };

                        const currentVal = editor.tagName === 'TEXTAREA' ? (editor.value || '') : (editor.textContent || '');
                        if (escapedText.length > 0 && currentVal.trim().length === 0) {
                            // Fallback insertion (triggers React state updates)
                            if (editor.tagName === 'TEXTAREA') {
                                // For textareas (monaco fallback)
                                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                                if (setter) setter.call(editor, escapedText);
                                else editor.value = escapedText;
                            } else {
                                // For contenteditable
                                editor.textContent = escapedText;
                            }

                            // Emulate input events to wake up React onChange handlers
                            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: escapedText }));
                            editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: escapedText }));
                            editor.dispatchEvent(new Event("change", { bubbles: true }));
                        }

                        // Wait for React to render the submit button
                        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                        await new Promise(r => setTimeout(r, 120));

                        // Find the submit button natively (Fast direct search first, then deep search)
                        const submitSelectors = [
                            '[data-testid="input-send-button"]',
                            '[data-testid="agent-input-box"] button[aria-label*="Send" i]',
                            '[data-testid="agent-input-box"] button[data-testid*="send" i]',
                            '[data-testid="agent-input-box"] button[type="submit"]:not([data-testid="input-cancel-button"])',
                            "svg.lucide-arrow-right", 
                            "svg[class*='arrow-right']", 
                            "svg[class*='send']",
                            "button[title*='Send']",
                            "button[aria-label*='Send']"
                        ];
                        const combinedSubmitSelectors = submitSelectors.join(', ');

                        let submit = null;
                        try {
                            const directIcons = Array.from(document.querySelectorAll(combinedSubmitSelectors));
                            for (const icon of directIcons) {
                                const btn = icon.tagName === 'BUTTON' ? icon : icon.closest("button");
                                if (btn && !btn.disabled && btn.offsetParent !== null && btn.getAttribute('data-testid') !== 'input-cancel-button') {
                                    submit = btn;
                                    break;
                                }
                            }
                        } catch(e) {}

                        if (!submit) {
                            const icon = await querySelectorDeep(combinedSubmitSelectors);
                            if (icon) {
                                const btn = icon.tagName === 'BUTTON' ? icon : icon.closest("button");
                                if (btn && !btn.disabled && btn.offsetParent !== null && btn.getAttribute('data-testid') !== 'input-cancel-button') submit = btn;
                            }
                        }

                        // Fallback: check composer footer trailing button in new Antigravity UI
                        if (!submit) {
                            const footerBtns = Array.from(document.querySelectorAll('[data-testid="agent-input-box"] .agy-composer-footer > div:last-child button'));
                            const candidateBtn = footerBtns.find(b => b.offsetParent !== null && !b.disabled && b.getAttribute('data-testid') !== 'input-cancel-button');
                            if (candidateBtn) submit = candidateBtn;
                        }

                        if (submit && !submit.disabled) {
                            submit.click();
                            return { found: true, method: "click_submit" };
                        }

                        // Submit via Enter key if button not found or disabled
                        ['keydown', 'keypress', 'keyup'].forEach(type => {
                            editor.dispatchEvent(new KeyboardEvent(type, { 
                                bubbles: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 
                            }));
                        });
                        
                        return { found: true, method: "enter_keypress" };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            const val = submitResult?.result?.value;

            if (val && val.found) {
                // If submitted via Enter fallback (or button wasn't clicked), also send native CDP Enter event
                if (val.method !== 'click_submit') {
                    await new Promise(r => setTimeout(r, 50));
                    try {
                        await client.send('Input.dispatchKeyEvent', {
                            type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
                        });
                        await client.send('Input.dispatchKeyEvent', {
                            type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
                        });
                    } catch (e) { /* ignore CDP input error if JS already submitted */ }
                }

                client.close();
                return;
            } else {
                client.close();
                allDebugs.push(`[${target.type}] ${target.title}: ${val?.error || 'No chat input element found'}`);
            }
        } catch (e: any) {
            allDebugs.push(`[${target.type}] ${target.title}: Error ${e.message}`);
        }
    }

    const debugInfo = allDebugs.length > 0 ? "\nDetails: " + allDebugs.slice(0, 4).join("\n") : "";
    throw new Error("Chat input element not found to type message." + debugInfo);
}


/**
 * Deep search querySelector helper that traverses Shadow DOM efficiently.
 */
const SCROLL_INJECTION_JS = `
    async function querySelectorDeep(selector, root = document) {
        try {
            const el = root.querySelector(selector);
            if (el) return el;
        } catch (_) {}

        // Non-recursive queue-based shadow DOM search with depth limit to prevent UI thread freezing
        const queue = [{ node: root, depth: 0 }];
        const visited = new Set();
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item || item.depth > 3 || visited.has(item.node)) continue;
            visited.add(item.node);

            try {
                const found = item.node.querySelector(selector);
                if (found) return found;
            } catch (_) {}

            try {
                const all = item.node.querySelectorAll('*');
                for (let i = 0; i < all.length; i++) {
                    const shadow = all[i].shadowRoot;
                    if (shadow && !visited.has(shadow)) {
                        queue.push({ node: shadow, depth: item.depth + 1 });
                    }
                }
            } catch (_) {}
        }
        return null;
    }

    async function performDeepScroll() {
        try {
            // 1. Find main chat container using combined query
            const selectors = [
                '[data-testid="autoscroll-viewport"]',
                '[data-testid="conversation-view"]',
                '#conversation', '#chat', '#cascade', 
                '.chat-container', '.messages-container', 
                '[class*="message-list"]', '[class*="Conversation"]'
            ];
            const combinedSelectors = selectors.join(', ');
            let targetEl = null;
            try {
                targetEl = document.querySelector(combinedSelectors);
            } catch (_) {}
            if (!targetEl || targetEl.offsetParent === null) {
                targetEl = await querySelectorDeep(combinedSelectors);
            }
            if (targetEl && targetEl.offsetParent === null) targetEl = null;

            if (!targetEl) targetEl = document.body;

            // 2. Focused Scroll Logic (NO scrollIntoView OR window.scrollTo TO AVOID FLASHING)
            function scrollTarget(el) {
                if (!el) return;
                try {
                    if (el.scrollHeight > el.clientHeight) {
                        el.scrollTop = el.scrollHeight + 1000;
                    }
                } catch(e) {}
            }

            // A. Scroll the target container specifically
            scrollTarget(targetEl);

            // B. Find last message item and ensure its parents are scrolled
            const lastMsg = await querySelectorDeep('[data-testid="agent-response"]:last-child, .message:last-child, .chat-item:last-child, [class*="item"]:last-child, .conversation-item:last-child');
            if (lastMsg) {
                let curr = lastMsg.parentElement;
                while (curr && curr !== document.body) {
                    scrollTarget(curr);
                    curr = curr.parentElement || (curr.parentNode && curr.parentNode.host);
                }
            }

            // Minimal delay to let React render if needed, but no sudden window jumps
            await new Promise(r => setTimeout(r, 500)); 
            return { success: true };
        } catch(e) {
            return { success: false, error: e.message };
        }
    }
`;

/**
 * Reusable function to trigger the deep scroll logic in a target webview.
 */
export async function autoScrollToBottom(client: CdpClient): Promise<void> {
    await client.send('Runtime.evaluate', {
        expression: `(async function() { ${SCROLL_INJECTION_JS}; return await performDeepScroll(); })()`,
        awaitPromise: true,
        returnByValue: true
    });
}

/**
 * Resolves the top-level page target and the bounding rectangle offset of an embedded chat iframe on that page.
 * Required because CDP Page.captureScreenshot only executes on top-level targets.
 */
async function resolveTopLevelPageClipForTarget(
    targets: CdpTarget[],
    chatTarget: CdpTarget,
    innerRect: { x: number; y: number; width: number; height: number }
): Promise<{ pageTarget: CdpTarget; clip: { x: number; y: number; width: number; height: number; scale: number } } | null> {
    const pageTarget = targets.find(t => t.type === 'page' && !t.url.includes('devtools://'));
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
        return null;
    }

    // Determine the outer vscode-webview ID that wraps the embedded chat iframe
    let matchedWebviewId = '';
    const webviewTargets = targets.filter(t =>
        (t.type === 'iframe' || t.type === 'webview') &&
        t.webSocketDebuggerUrl &&
        t.url.startsWith('vscode-webview://') &&
        !t.url.includes('extensionId=acmatvjrus.antigravity-telegram-control')
    );

    for (const wv of webviewTargets) {
        try {
            const wvClient = new CdpClient(wv.webSocketDebuggerUrl!);
            await wvClient.connect();
            const probe = await wvClient.send('Runtime.evaluate', {
                returnByValue: true,
                expression: `(() => {
                    try {
                        const f = document.querySelector('iframe');
                        const innerDoc = f && f.contentDocument;
                        const innerIframe = innerDoc ? innerDoc.querySelector('iframe') : null;
                        const innerSrc = innerIframe ? (innerIframe.src || '') : '';
                        const fRect = f ? f.getBoundingClientRect() : { x: 0, y: 0 };
                        const iRect = innerIframe ? innerIframe.getBoundingClientRect() : { x: 0, y: 0 };
                        return {
                            innerSrc,
                            offsetX: (fRect.x || 0) + (iRect.x || 0),
                            offsetY: (fRect.y || 0) + (iRect.y || 0)
                        };
                    } catch (e) {
                        return null;
                    }
                })()`
            });
            wvClient.close();
            const pv = probe?.result?.value;
            if (pv && pv.innerSrc && (pv.innerSrc === chatTarget.url || pv.innerSrc.includes('extensionView=true') || /\/c\/[a-f0-9-]+/i.test(pv.innerSrc))) {
                const idMatch = wv.url.match(/[?&]id=([^&]+)/);
                if (idMatch) {
                    matchedWebviewId = idMatch[1];
                    innerRect = {
                        x: (innerRect.x || 0) + (pv.offsetX || 0),
                        y: (innerRect.y || 0) + (pv.offsetY || 0),
                        width: innerRect.width,
                        height: innerRect.height
                    };
                    break;
                }
            }
        } catch (_) { /* ignore individual webview inspection failure */ }
    }

    // Locate the matching iframe bounding rect inside the top-level workbench page
    const pageClient = new CdpClient(pageTarget.webSocketDebuggerUrl);
    try {
        await pageClient.connect();
        const rectRes = await pageClient.send('Runtime.evaluate', {
            returnByValue: true,
            expression: `(() => {
                const targetId = ${JSON.stringify(matchedWebviewId)};
                const iframes = Array.from(document.querySelectorAll('iframe'));
                let match = null;
                if (targetId) {
                    match = iframes.find(f => (f.src || '').includes('id=' + targetId));
                }
                if (!match) {
                    match = iframes.find(f => {
                        const src = f.src || '';
                        const r = f.getBoundingClientRect();
                        return src.startsWith('vscode-webview://') && !src.includes('acmatvjrus') && r.width > 50 && r.height > 50;
                    });
                }
                if (!match) return null;
                const r = match.getBoundingClientRect();
                return { x: r.x, y: r.y, width: r.width, height: r.height };
            })()`
        });
        pageClient.close();

        const frameRect = rectRes?.result?.value;
        if (frameRect && frameRect.width > 0 && frameRect.height > 0) {
            const clipX = Math.max(0, Math.floor(frameRect.x + (innerRect.x || 0)));
            const clipY = Math.max(0, Math.floor(frameRect.y + (innerRect.y || 0)));
            const maxW = Math.max(1, Math.floor(frameRect.width - Math.max(0, innerRect.x || 0)));
            const maxH = Math.max(1, Math.floor(frameRect.height - Math.max(0, innerRect.y || 0)));
            return {
                pageTarget,
                clip: {
                    x: clipX,
                    y: clipY,
                    width: Math.min(Math.max(1, Math.floor(innerRect.width || frameRect.width)), maxW),
                    height: Math.min(Math.max(1, Math.floor(innerRect.height || frameRect.height)), maxH),
                    scale: 1
                }
            };
        }
    } catch (_) {
        pageClient.close();
    }

    return null;
}

/**
 * Captures a screenshot of the agent chat area using CDP.
 * Returns the screenshot Buffer and diagnostic metadata.
 */
export async function captureAgentScreenshot(port: number): Promise<{ buffer: Buffer, metadata: string }> {
    let raw;
    try {
        raw = await httpGet(`http://127.0.0.1:${port}/json`);
    } catch (e: any) {
        throw new Error(`Could not connect to Port ${port}. Please run VS Code with --remote-debugging-port=${port}`);
    }

    const targets: CdpTarget[] = JSON.parse(raw);
    // Prioritize embedded chat iframe and exclude self extension webview
    const candidates = getFilteredChatCandidates(targets);

    let logs: string[] = [];

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            // (Auto-scroll will be done after finding the chat area below to avoid flashing non-chat targets)

            const boxResult = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        ${SCROLL_INJECTION_JS}
                        
                        const selectors = [
                            '[data-testid="conversation-view"]',
                            '[data-testid="aux-pane-split"]',
                            '[data-testid="autoscroll-viewport"]',
                            '#conversation', '#chat', '#cascade', 
                            '.chat-container', '.messages-container', 
                            '[class*="message-list"]', '[class*="Conversation"]',
                            '[data-testid="agent-input-box"]',
                            '.chat-input', '[contenteditable="true"]'
                        ];
                        
                        let foundSelector = "none";
                        let targetEl = null;
                        for (const s of selectors) {
                            targetEl = await querySelectorDeep(s);
                            if (targetEl && targetEl.offsetParent !== null) {
                                // If it's just an input, try to find the container
                                if (s === '.chat-input' || s === '[contenteditable="true"]' || s === '[data-testid="agent-input-box"]') {
                                     const container = targetEl.closest('[data-testid="conversation-view"], [data-testid="aux-pane-split"], #conversation, #chat, #cascade, [class*="Conversation"], [class*="chat-container"]');
                                     if (container) targetEl = container;
                                }
                                foundSelector = s;
                                break;
                            }
                        }

                        // VALIDATION: If no chat-related selector was found, this target likely isn't the chat UI.
                        if (!targetEl) return { error: "chat_elements_not_found" };

                        let captureEl = targetEl;
                        let captureType = "selector";
                        
                        // If we found a tiny element or the input only, fallback to largest scroller in this context
                        if (targetEl.offsetHeight < 200) {
                            const scrollers = Array.from(document.querySelectorAll('div'))
                                .filter(d => d.offsetHeight > 400 && d.offsetParent !== null)
                                .sort((a, b) => b.offsetHeight - a.offsetHeight);
                            if (scrollers.length > 0) {
                                captureEl = scrollers[0];
                                captureType = "largest-scroller";
                            }
                        }

                        const rect = captureEl.getBoundingClientRect();
                        return {
                            x: rect.x,
                            y: rect.y,
                            width: rect.width || document.documentElement.clientWidth,
                            height: rect.height || document.documentElement.clientHeight,
                            title: document.title,
                            url: window.location.href,
                            selector: foundSelector,
                            captureType: captureType
                        };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            const res = boxResult?.result?.value;
            if (res && !res.error) {
                // Scroll down immediately after confirming the correct chat container
                await autoScrollToBottom(client);

                let screenshotResult: any = null;

                if (target.type === 'page') {
                    screenshotResult = await client.send('Page.captureScreenshot', {
                        format: 'jpeg',
                        quality: 90,
                        clip: {
                            // Ensure non-negative integer coordinates for CDP Page.captureScreenshot clip parameter
                            x: Math.max(0, Math.floor(res.x || 0)),
                            y: Math.max(0, Math.floor(res.y || 0)),
                            width: Math.max(1, Math.floor(res.width || 1)),
                            height: Math.max(1, Math.floor(res.height || 1)),
                            scale: 1
                        }
                    });
                    client.close();
                } else {
                    client.close();
                    // Embedded iframe targets cannot execute Page.captureScreenshot directly; capture via top-level page target
                    const topLevel = await resolveTopLevelPageClipForTarget(targets, target, {
                        x: res.x || 0,
                        y: res.y || 0,
                        width: res.width || 1,
                        height: res.height || 1
                    });
                    if (topLevel && topLevel.pageTarget.webSocketDebuggerUrl) {
                        const pageClient = new CdpClient(topLevel.pageTarget.webSocketDebuggerUrl);
                        await pageClient.connect();
                        screenshotResult = await pageClient.send('Page.captureScreenshot', {
                            format: 'jpeg',
                            quality: 90,
                            clip: topLevel.clip
                        });
                        pageClient.close();
                    }
                }

                if (screenshotResult && screenshotResult.data) {
                    const metadata = `Target: ${res.title}\nSelector: ${res.selector}\nType: ${res.captureType}\nURL: ${res.url.substring(0, 50)}...`;
                    return {
                        buffer: Buffer.from(screenshotResult.data, 'base64'),
                        metadata: metadata
                    };
                }
            } else {
                logs.push(`${target.title}: ${res?.error || 'no_res'}`);
                client.close();
            }
        } catch (e: any) {
            logs.push(`${target.title}: ${e.message}`);
        }
    }

    throw new Error(`Visible chat frame not found to capture screenshot. (Details: ${logs.join(', ')})`);
}

/**
 * Shared browser evaluation script that checks whether the Antigravity chat is present, generating, or idle.
 */
const CHAT_STATUS_EVAL_JS = `
    (function() {
        const isVisible = (el) => {
            if (!el || el.offsetParent === null) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < (window.innerWidth || 9999);
        };

        const stopCandidates = Array.from(document.querySelectorAll(
            '[data-testid="input-cancel-button"], button[aria-label^="Cancel"], svg.lucide-square, [data-tooltip-id*="cancel"], [aria-label*="Stop"], [title*="Stop"]'
        ));
        const hasVisibleStop = stopCandidates.some(isVisible);
        const isGenerating = hasVisibleStop;

        const sendCandidates = Array.from(document.querySelectorAll(
            '[data-testid="input-send-button"], [data-testid="agent-input-box"] button[aria-label*="Send" i], svg.lucide-arrow-right, svg[class*="arrow-right"], svg[class*="send"], [aria-label*="Send"], [title*="Send"]'
        ));
        const hasVisibleSend = sendCandidates.some(isVisible);

        const editor = document.querySelector(
            '[data-testid="agent-input-box"] [contenteditable="true"], [aria-label="Message input"][contenteditable="true"], [role="combobox"][contenteditable="true"], [contenteditable="true"], textarea'
        );
        const isInputDisabled = editor ? (editor.getAttribute('contenteditable') === 'false' || !!editor.disabled) : false;

        const hasNewChatUi = !!document.querySelector('[data-testid="conversation-view"], [data-testid="agent-input-box"]');
        const hasChat = hasNewChatUi || !!document.querySelector('#conversation, #chat, #cascade, .chat-input, .interactive-input-editor');

        // In the new Antigravity UI, the send button may be hidden while input is empty; absence of cancel button + enabled input indicates idle
        const isIdle = hasNewChatUi
            ? (!isGenerating && !isInputDisabled)
            : (!!hasVisibleSend && !isGenerating && !isInputDisabled);

        return { hasChat, isGenerating, isIdle };
    })()
`;

/**
 * Polls the Antigravity chat input UI to determine when the agent has finished generating.
 */
export async function waitForAgentResponse(port: number, timeoutMs = 450000): Promise<boolean> {
    // Safely query available CDP targets with try/catch to avoid uncaught ECONNREFUSED
    let candidates: CdpTarget[] = [];
    try {
        const raw = await httpGet(`http://127.0.0.1:${port}/json`);
        const targets: CdpTarget[] = JSON.parse(raw);
        candidates = getFilteredChatCandidates(targets);
    } catch (e: any) {
        return false;
    }

    const startTime = Date.now();
    let consecutiveIdleCount = 0;

    while (Date.now() - startTime < timeoutMs) {
        let foundChatInThisLoop = false;
        let isIdleInThisLoop = false;
        let isGeneratingInThisLoop = false;

        for (const target of candidates) {
            try {
                const client = new CdpClient(target.webSocketDebuggerUrl!);
                await client.connect();

                const checkResult = await client.send('Runtime.evaluate', {
                    expression: CHAT_STATUS_EVAL_JS,
                    returnByValue: true
                });

                const val = checkResult?.result?.value;
                if (val && val.hasChat) {
                    foundChatInThisLoop = true;
                    if (val.isGenerating) isGeneratingInThisLoop = true;
                    if (val.isIdle && !val.isGenerating) isIdleInThisLoop = true;

                    // Scroll down to the bottom if agent has finished generating
                    if (isIdleInThisLoop && !isGeneratingInThisLoop) {
                        await autoScrollToBottom(client);
                    }

                    client.close();
                    break;
                }
                client.close();
            } catch (e: any) { }
        }

        if (foundChatInThisLoop) {
            if (isIdleInThisLoop && !isGeneratingInThisLoop) {
                consecutiveIdleCount++;
                if (consecutiveIdleCount >= 2) return true;
            } else {
                consecutiveIdleCount = 0;
            }
        }
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

/**
 * Quickly inspects the agent's current state (generating vs idle) in a single pass without blocking.
 */
export async function checkAgentCurrentStatus(port: number): Promise<{ hasChat: boolean, isGenerating: boolean, isIdle: boolean }> {
    try {
        const raw = await httpGet(`http://127.0.0.1:${port}/json`);
        const targets: CdpTarget[] = JSON.parse(raw);
        const candidates = getFilteredChatCandidates(targets);

        for (const target of candidates) {
            try {
                const client = new CdpClient(target.webSocketDebuggerUrl!);
                await client.connect();

                const checkResult = await client.send('Runtime.evaluate', {
                    expression: CHAT_STATUS_EVAL_JS,
                    returnByValue: true
                });

                client.close();
                const val = checkResult?.result?.value;
                if (val && val.hasChat) {
                    return val;
                }
            } catch (e: any) {
                // Ignore individual candidate evaluation failure
            }
        }
    } catch (e: any) {
        // Return default status when CDP port is not accessible
    }
    return { hasChat: false, isGenerating: false, isIdle: true };
}

/**
 * Stop the Antigravity agent if it is currently generating.
 */
export async function stopAgent(port: number): Promise<{ success: boolean, message?: string }> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            const stopResult = await client.send('Runtime.evaluate', {
                expression: `
                    (function() {
                        const isVisible = (el) => {
                            if (!el || el.offsetParent === null) return false;
                            const r = el.getBoundingClientRect();
                            return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0;
                        };
                        const stopCandidates = Array.from(document.querySelectorAll(
                            '[data-testid="input-cancel-button"], button[aria-label^="Cancel"], svg.lucide-square, [data-tooltip-id*="cancel"], [aria-label*="Stop"], [title*="Stop"]'
                        ));
                        for (const el of stopCandidates) {
                            if (!isVisible(el)) continue;
                            const button = el.tagName === 'BUTTON' ? el : el.closest('button');
                            if (button && isVisible(button)) {
                                button.click();
                                return { success: true };
                            }
                        }
                        return { success: false };
                    })()
                `,
                returnByValue: true
            });

            const val = stopResult?.result?.value;
            if (val && val.success) {
                client.close();
                return { success: true };
            }
            client.close();
        } catch (e: any) {
            console.warn(`[CDP] Error stopping agent in target ${target.title}:`, e.message);
        }
    }

    return { success: false, message: "Stop button not found or already stopped." };
}
/**
 * Find and click the retry button in the chat UI if it exists.
 */
export async function clickRetryButton(port: number): Promise<{ success: boolean, message?: string }> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            const retryResult = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        ${SCROLL_INJECTION_JS}
                        
                        const retrySelectors = [
                            "button[aria-label*='Retry']",
                            "button[title*='Retry']",
                            "button:has(svg.lucide-refresh-cw)",
                            "button:has(svg.lucide-rotate-ccw)",
                            ".retry-button",
                            "button:contains('Retry')",
                            "button:contains('Thử lại')"
                        ];

                        let retryBtn = null;
                        for (const s of retrySelectors) {
                            if (s.includes(':contains') || s.includes(':has')) {
                                // Fallback for pseudo-selectors if needed
                                const buttons = Array.from(document.querySelectorAll('button'));
                                if (s.includes(':contains')) {
                                    const text = s.match(/'(.*)'/)[1];
                                    retryBtn = buttons.find(b => b.textContent.includes(text));
                                } else if (s.includes(':has')) {
                                    const sub = s.match(/\\((.*)\\)/)[1];
                                    retryBtn = buttons.find(b => b.querySelector(sub));
                                }
                            } else {
                                retryBtn = await querySelectorDeep(s);
                            }
                            
                            if (retryBtn && !retryBtn.disabled && retryBtn.offsetParent !== null) break;
                            else retryBtn = null;
                        }

                        if (retryBtn) {
                            retryBtn.click();
                            return { success: true };
                        }
                        return { success: false };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            const val = retryResult?.result?.value;
            if (val && val.success) {
                client.close();
                return { success: true };
            }
            client.close();
        } catch (e: any) {
            console.warn(`[CDP] Error clicking retry in target ${target.title}:`, e.message);
        }
    }

    return { success: false, message: "Retry button not found." };
}

/**
 * Extracts the conversation text from the Antigravity agent chat area via CDP.
 * Traverses potential chat containers and retrieves full conversation messages.
 * Refined to strictly retrieve only the latest message turn (last user prompt and last agent response).
 */
export async function getLatestAgentConversationText(port: number): Promise<string> {
    // Safely query available CDP targets with try/catch to avoid uncaught ECONNREFUSED
    let candidates: CdpTarget[] = [];
    try {
        const raw = await httpGet(`http://127.0.0.1:${port}/json`);
        const targets: CdpTarget[] = JSON.parse(raw);
        candidates = getFilteredChatCandidates(targets);
    } catch (e: any) {
        return '';
    }

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            const textResult = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        ${SCROLL_INJECTION_JS}

                        const extractCleanResponseText = (respEl) => {
                            if (!respEl) return '';
                            // New Antigravity 1.11.0+ UI renders actual reply text inside .leading-relaxed.select-text (not tool-step chips)
                            const isNewResp = respEl.getAttribute('data-testid') === 'agent-response';
                            const selectBlocks = Array.from(respEl.querySelectorAll('.leading-relaxed.select-text, div.px-2.py-1 > .select-text'));
                            if (selectBlocks.length > 0) {
                                const texts = selectBlocks
                                    .filter(b => !b.closest('[data-testid="worked-for-collapsible"], [data-testid="tool-group-collapsible"], [data-testid="turn-cards-container"], [data-testid="agent-loading"], button'))
                                    .map(b => {
                                        const clone = b.cloneNode(true);
                                        clone.querySelectorAll('style, script, button, .sr-only').forEach(el => el.remove());
                                        return (clone.innerText || '').trim();
                                    })
                                    .filter(Boolean);
                                if (texts.length > 0) return texts.join('\\n\\n');
                            }
                            if (isNewResp) {
                                // Still thinking / running tools with no prose reply yet
                                return '';
                            }

                            // Legacy / generic fallback inside respEl
                            const responseChildren = Array.from(respEl.children).slice(1);
                            if (responseChildren.length > 0) {
                                const clone = document.createElement('div');
                                responseChildren.forEach(c => clone.appendChild(c.cloneNode(true)));
                                clone.querySelectorAll('style, script, button, .sr-only, [data-testid="worked-for-collapsible"], [data-testid="tool-group-collapsible"], [data-testid="turn-cards-container"], [data-testid="agent-loading"], [class*="thought"], [class*="thinking"]').forEach(el => el.remove());
                                const text = (clone.innerText || '').trim();
                                if (text) return text;
                            } else {
                                const firstChild = respEl.children[0];
                                const isThinkingOnly = firstChild && (firstChild.querySelector('[data-testid="worked-for-collapsible"]') || (firstChild.innerText || '').startsWith('Worked for'));
                                if (!isThinkingOnly && firstChild) {
                                    const clone = firstChild.cloneNode(true);
                                    clone.querySelectorAll('style, script, button, .sr-only, [data-testid="worked-for-collapsible"], [data-testid="tool-group-collapsible"], [data-testid="turn-cards-container"], [data-testid="agent-loading"], [class*="thought"], [class*="thinking"], [class*="group/run-command"]').forEach(el => el.remove());
                                    const text = (clone.innerText || '').trim();
                                    if (text) return text;
                                }
                            }
                            return '';
                        };

                        // Strategy 1: Find the latest user input step and subsequent agent response(s) in the DOM
                        const userSteps = Array.from(document.querySelectorAll('[data-testid="user-input-step"]'));
                        const agentResps = Array.from(document.querySelectorAll('[data-testid="agent-response"]'));

                        if (userSteps.length > 0) {
                            const lastUserStep = userSteps[userSteps.length - 1];
                            const userTextEl = lastUserStep.querySelector('[data-testid="user-message-content"] .whitespace-pre-wrap, [data-testid="user-message-content"], .whitespace-pre-wrap') || lastUserStep;
                            const userClone = userTextEl.cloneNode(true);
                            userClone.querySelectorAll('style, script, button, .sr-only').forEach(el => el.remove());
                            const userPrompt = (userClone.innerText || '').trim();

                            let agentText = '';
                            if (agentResps.length > 0) {
                                // Collect all agent-response nodes appearing after the latest user prompt in document order
                                const followingResps = agentResps.filter(r => !!(lastUserStep.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING));
                                if (followingResps.length > 0) {
                                    agentText = followingResps.map(extractCleanResponseText).filter(Boolean).join('\\n\\n');
                                }
                            }

                            // Fallback to legacy sibling turn container if no [data-testid="agent-response"] matched
                            if (!agentText) {
                                const turnContainer = lastUserStep.closest('.scroll-mt-4') || lastUserStep.closest('[class*="flex-col"]') || lastUserStep.parentElement;
                                let respEl = null;
                                if (turnContainer && turnContainer.children.length > 1) {
                                    respEl = turnContainer.children[1];
                                } else if (turnContainer && turnContainer.nextElementSibling) {
                                    respEl = turnContainer.nextElementSibling;
                                }
                                if (respEl) {
                                    agentText = extractCleanResponseText(respEl);
                                }
                            }

                            if (userPrompt && agentText) {
                                return { found: true, text: "👤 *User:*\\n" + userPrompt + "\\n\\n🤖 *Agent:*\\n" + agentText };
                            } else if (agentText) {
                                return { found: true, text: "🤖 *Agent:*\\n" + agentText };
                            } else if (userPrompt) {
                                return { found: true, text: "👤 *User:*\\n" + userPrompt + "\\n\\n🤖 *Agent:*\\n(Processing... / جاري المعالجة)" };
                            }
                        } else if (agentResps.length > 0) {
                            const lastRespText = extractCleanResponseText(agentResps[agentResps.length - 1]);
                            if (lastRespText) {
                                return { found: true, text: "🤖 *Agent:*\\n" + lastRespText };
                            }
                        }

                        // Strategy 2: Fallback to isolating only the last turn container in conversation
                        const selectors = [
                            '[data-testid="autoscroll-viewport"]',
                            '[data-testid="conversation-view"]',
                            '#conversation', '#chat', '#cascade', 
                            '.chat-container', '.messages-container', 
                            '[class*="message-list"]', '[class*="Conversation"]'
                        ];

                        let targetEl = null;
                        for (const s of selectors) {
                            targetEl = await querySelectorDeep(s);
                            if (targetEl && targetEl.offsetParent !== null) break;
                        }

                        if (targetEl) {
                            const turns = Array.from(targetEl.querySelectorAll('.scroll-mt-4, .relative.flex.flex-col.gap-y-3 > div')).filter(d => (d.innerText || '').trim().length > 0);
                            if (turns.length > 0) {
                                const lastTurn = turns[turns.length - 1];
                                const clone = lastTurn.cloneNode(true);
                                clone.querySelectorAll('style, script, button, .sr-only, [data-testid="worked-for-collapsible"], [data-testid="tool-group-collapsible"], [data-testid="turn-cards-container"], [data-testid="agent-loading"], [class*="thought"], [class*="thinking"], [class*="group/run-command"]').forEach(el => el.remove());
                                const cleanText = (clone.innerText || '').trim();
                                if (cleanText) return { found: true, text: cleanText };
                            }
                        }

                        // Do NOT return all conversation text; strictly return empty if no turn is isolated
                        return { found: false, text: '' };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            client.close();

            const val = textResult?.result?.value;
            if (val && val.found && val.text) {
                return val.text;
            }
        } catch (e: any) {
            console.warn(`[CDP] Error reading conversation text from ${target.title}:`, e.message);
        }
    }

    return '';
}

/**
 * Interface representing an Antigravity agent conversation summary from the IDE.
 */
export interface AgentConversationItem {
    index: number;
    title: string;
    details: string;
    isCurrent: boolean;
}

/**
 * Retrieves the list of all Antigravity agent conversations from the IDE via CDP.
 * Reads directly from the new conversation sidebar rows or falls back to the legacy past conversations panel.
 */
export async function getAgentConversationsList(port: number): Promise<AgentConversationItem[]> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            const listResult = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        // Strategy 1: New Antigravity 1.11.0+ embedded sidebar rows
                        const sidebarRows = Array.from(document.querySelectorAll('[data-testid="conversation-row-sidebar"]'));
                        if (sidebarRows.length > 0) {
                            const seenIds = new Set();
                            const conversations = [];
                            for (const row of sidebarRows) {
                                const cascadeId = row.getAttribute('data-cascade-id') || '';
                                const titleEl = row.querySelector('span.truncate') || row.querySelector('span');
                                const title = (titleEl ? titleEl.innerText : '').trim();
                                if (!title) continue;
                                const dedupKey = cascadeId || title;
                                if (seenIds.has(dedupKey)) continue;
                                seenIds.add(dedupKey);

                                const subtext = (row.getAttribute('data-subtext') || '').trim();
                                const timeEl = row.querySelector('span.text-foreground.opacity-60');
                                const timeText = timeEl ? timeEl.innerText.trim() : '';
                                const details = [subtext, timeText].filter(Boolean).join(' • ');
                                const isCurrent = row.getAttribute('data-selected') === 'true';

                                conversations.push({
                                    index: conversations.length + 1,
                                    title,
                                    details,
                                    isCurrent
                                });
                            }
                            if (conversations.length > 0) {
                                return { found: true, conversations };
                            }
                        }

                        // Strategy 2: Legacy past conversations fast-pick dropdown
                        function querySelectorDeep(selector, root = document) {
                            try {
                                const el = root.querySelector(selector);
                                if (el) return el;
                            } catch (_) {}
                            const queue = [{ node: root, depth: 0 }];
                            const visited = new Set();
                            while (queue.length > 0) {
                                const item = queue.shift();
                                if (!item || item.depth > 3 || visited.has(item.node)) continue;
                                visited.add(item.node);
                                try {
                                    const found = item.node.querySelector(selector);
                                    if (found) return found;
                                } catch (_) {}
                                try {
                                    const all = item.node.querySelectorAll('*');
                                    for (let i = 0; i < all.length; i++) {
                                        const shadow = all[i].shadowRoot;
                                        if (shadow && !visited.has(shadow)) {
                                            queue.push({ node: shadow, depth: item.depth + 1 });
                                        }
                                    }
                                } catch (_) {}
                            }
                            return null;
                        }

                        // Robust identification of past conversations button using combined query
                        const historySelector = '[data-past-conversations-toggle="true"], [data-tooltip-id="history-tooltip"], a:has(svg.lucide-history), button:has(svg.lucide-history), [aria-label*="Past Conversations"], [title*="Past Conversations"]';
                        const historyBtn = querySelectorDeep(historySelector);

                        if (!historyBtn) return { found: false, error: 'no history button' };

                        // Click past conversations toggle to open the list
                        historyBtn.click();
                        
                        // Poll for fast-pick dropdown container to appear
                        let fastPick = null;
                        for (let i = 0; i < 10; i++) {
                            await new Promise(r => setTimeout(r, 100));
                            fastPick = document.querySelector('.jetski-fast-pick') || document.querySelector('[class*="fast-pick"]');
                            if (fastPick) break;
                        }

                        let conversations = [];

                        if (fastPick) {
                            // Locate listbox container and its first child section representing the active conversation
                            const listbox = fastPick.querySelector('[role="listbox"]');
                            const currentSection = listbox?.children[0];
                            const rowElements = Array.from(fastPick.querySelectorAll('div.cursor-pointer.flex.items-start.justify-between'));
                            conversations = rowElements.map((row, idx) => {
                                const titleEl = row.querySelector('span.text-sm') || row.querySelector('span');
                                const title = titleEl ? titleEl.innerText.trim() : '';

                                const textParts = (row.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
                                // Determine active conversation by membership in the Current section of the listbox
                                const isCurrent = currentSection ? currentSection.contains(row) : (idx === 0);

                                return {
                                    index: idx + 1,
                                    title: title || textParts[0] || 'Untitled',
                                    details: textParts.slice(1).join(' • '),
                                    isCurrent
                                };
                            }).filter(c => c.title && !c.title.includes('Show ') && !c.title.includes('more...'));
                        }

                        // Close the past conversations popup cleanly using Escape and backdrop click
                        const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
                        document.dispatchEvent(escEvent);
                        const backdrop = document.querySelector('.jetski-fast-pick')?.parentElement;
                        if (backdrop) {
                            backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
                        }

                        return { found: true, conversations };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            client.close();

            const val = listResult?.result?.value;
            if (val && val.found && Array.isArray(val.conversations)) {
                return val.conversations;
            }
        } catch (e: any) {
            console.warn(`[CDP] Error reading conversations list from ${target.title}:`, e.message);
        }
    }

    return [];
}

/**
 * Triggers a new conversation in the Antigravity agent chat UI via CDP.
 * Finds and clicks the New Conversation (+) button across candidate targets.
 */
export async function startNewConversation(port: number): Promise<{ success: boolean, message?: string }> {
    // Retrieve list of active CDP targets from the remote debugging endpoint
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    // Parse response into array of CDP targets
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    // Loop through each candidate target
    for (const target of candidates) {
        try {
            // Instantiate CDP client connected to candidate WebSocket debugger
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            // Open WebSocket connection to CDP target
            await client.connect();

            // Evaluate in-browser script to identify button and trigger click
            const result = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        // Locate the new conversation button (new UI first, then legacy selectors)
                        const newBtn = document.querySelector('[data-testid="extension-new-conversation"]')
                            || document.querySelector('button[aria-label="New Conversation"]')
                            || document.querySelector('[data-testid="new-conversation-button"]')
                            || document.querySelector('[data-tooltip-id="new-conversation-tooltip"]')
                            || document.querySelector('[data-tooltip-id*="new-conversation"]')
                            || document.querySelector('a:has(svg path[d*="M450-450H220"])')
                            || document.querySelector('button:has(svg path[d*="M450-450H220"])');

                        // Check if new conversation element was successfully located
                        if (!newBtn) return { success: false, error: 'new_conversation_button_not_found' };

                        // Click the button element directly
                        newBtn.click();

                        // Also trigger click on overlay child div element if present
                        const child = newBtn.querySelector('div');
                        if (child && typeof child.click === 'function') {
                            child.click();
                        }

                        // Short pause to ensure action is processed by the UI
                        await new Promise(r => setTimeout(r, 400));

                        // Return success state
                        return { success: true };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            // Close connection to current CDP client
            client.close();

            // Extract returned value from runtime evaluation
            const val = result?.result?.value;
            // Check if element was found and click succeeded
            if (val && val.success) {
                // Return success state
                return { success: true };
            }
        } catch (e: any) {
            // Log warning if an error occurs while evaluating in target
            console.warn(`[CDP] Error starting new conversation in target ${target.title}:`, e.message);
        }
    }

    // Return failure when button could not be found across any targets
    return { success: false, message: 'New conversation button not found in chat UI.' };
}

/**
 * Result returned by switchToConversation.
 */
export interface SwitchConversationResult {
    success: boolean;
    index?: number;
    title?: string;
    isCurrent?: boolean;
    totalConversations?: number;
    message?: string;
}

/**
 * Switches to an Antigravity agent conversation by index (1-based) or by title search query.
 * Supports the new embedded sidebar rows as well as the legacy past conversations panel.
 */
export async function switchToConversation(port: number, target: number | string): Promise<SwitchConversationResult> {
    // Retrieve list of active CDP targets from remote debugging endpoint
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    // Parse response into array of CDP targets
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    // Loop through each candidate target
    for (const targetItem of candidates) {
        try {
            // Instantiate CDP client connected to candidate WebSocket debugger
            const client = new CdpClient(targetItem.webSocketDebuggerUrl!);
            // Open WebSocket connection to CDP target
            await client.connect();

            // Evaluate in-browser script to identify conversation and trigger switch
            const result = await client.send('Runtime.evaluate', {
                expression: `
                    (async function() {
                        // Retrieve target parameter passed from Node context
                        const targetParam = ${JSON.stringify(target)};

                        // Strategy 1: New Antigravity 1.11.0+ embedded sidebar rows
                        const rawSidebarRows = Array.from(document.querySelectorAll('[data-testid="conversation-row-sidebar"]'));
                        if (rawSidebarRows.length > 0) {
                            const seenIds = new Set();
                            const uniqueRows = [];
                            for (const row of rawSidebarRows) {
                                const cascadeId = row.getAttribute('data-cascade-id') || '';
                                const titleEl = row.querySelector('span.truncate') || row.querySelector('span');
                                const title = (titleEl ? titleEl.innerText : '').trim();
                                if (!title) continue;
                                const dedupKey = cascadeId || title;
                                if (seenIds.has(dedupKey)) continue;
                                seenIds.add(dedupKey);
                                uniqueRows.push({ row, title });
                            }

                            if (uniqueRows.length === 0) {
                                return { success: false, message: 'no_conversations_found' };
                            }

                            let matched = null;
                            let matchedIndex = -1;
                            const num = typeof targetParam === 'number' ? targetParam : parseInt(targetParam, 10);
                            if (!isNaN(num) && num >= 1 && num <= uniqueRows.length) {
                                matchedIndex = num - 1;
                                matched = uniqueRows[matchedIndex];
                            } else if (typeof targetParam === 'string' && targetParam.trim()) {
                                const query = targetParam.trim().toLowerCase();
                                matchedIndex = uniqueRows.findIndex(r => r.title.toLowerCase().includes(query));
                                if (matchedIndex !== -1) matched = uniqueRows[matchedIndex];
                            }

                            if (!matched) {
                                return { success: false, message: 'conversation_not_found', totalConversations: uniqueRows.length };
                            }

                            if (matched.row.getAttribute('data-selected') === 'true') {
                                return { success: true, index: matchedIndex + 1, title: matched.title, isCurrent: true, isSidebarRow: true };
                            }

                            // Open sidebar drawer if it is currently collapsed offscreen
                            let sidebarWasToggled = false;
                            const rowRect = matched.row.getBoundingClientRect();
                            if (rowRect.right <= 0) {
                                const toggleBtn = document.querySelector('[data-testid="sidebar-toggle"]');
                                if (toggleBtn) {
                                    toggleBtn.click();
                                    sidebarWasToggled = true;
                                    await new Promise(r => setTimeout(r, 250));
                                }
                            }

                            matched.row.scrollIntoView({ block: 'nearest' });
                            const clickTarget = matched.row.querySelector('a') || matched.row;
                            clickTarget.click();
                            const rect = clickTarget.getBoundingClientRect();

                            return {
                                success: true,
                                index: matchedIndex + 1,
                                title: matched.title,
                                isCurrent: false,
                                isSidebarRow: true,
                                sidebarWasToggled,
                                x: Math.round(rect.x + rect.width / 2),
                                y: Math.round(rect.y + rect.height / 2)
                            };
                        }

                        // Strategy 2: Legacy fast-pick dropdown
                        function querySelectorDeep(selector, root = document) {
                            try {
                                const el = root.querySelector(selector);
                                if (el) return el;
                            } catch (_) {}
                            const queue = [{ node: root, depth: 0 }];
                            const visited = new Set();
                            while (queue.length > 0) {
                                const item = queue.shift();
                                if (!item || item.depth > 3 || visited.has(item.node)) continue;
                                visited.add(item.node);
                                try {
                                    const found = item.node.querySelector(selector);
                                    if (found) return found;
                                } catch (_) {}
                                try {
                                    const all = item.node.querySelectorAll('*');
                                    for (let i = 0; i < all.length; i++) {
                                        const shadow = all[i].shadowRoot;
                                        if (shadow && !visited.has(shadow)) {
                                            queue.push({ node: shadow, depth: item.depth + 1 });
                                        }
                                    }
                                } catch (_) {}
                            }
                            return null;
                        }

                        // Robust identification of past conversations button using combined query
                        const historySelector = '[data-past-conversations-toggle="true"], [data-tooltip-id="history-tooltip"], a:has(svg.lucide-history), button:has(svg.lucide-history), [aria-label*="Past Conversations" i], [title*="Past Conversations" i]';
                        const historyBtn = querySelectorDeep(historySelector);

                        // Check if past conversations toggle button was found
                        if (!historyBtn) return { success: false, message: 'history_button_not_found' };

                        // Click past conversations toggle button to open the list
                        historyBtn.click();

                        // Poll for fast-pick dropdown container to appear
                        let fastPick = null;
                        for (let i = 0; i < 15; i++) {
                            await new Promise(r => setTimeout(r, 100));
                            fastPick = document.querySelector('.jetski-fast-pick') || document.querySelector('[class*="fast-pick"]');
                            if (fastPick) break;
                        }

                        // Check if fast-pick dropdown container appeared
                        if (!fastPick) return { success: false, message: 'popup_not_found' };

                        // Query all conversation rows inside the fast-pick popup
                        const rows = Array.from(fastPick.querySelectorAll('div.cursor-pointer.flex.items-start.justify-between'))
                            .filter(r => {
                                const text = (r.innerText || '').trim();
                                return text && !text.includes('Show ') && !text.includes('more...');
                            });

                        // Verify that at least one conversation was found
                        if (rows.length === 0) {
                            // Close the popup cleanly using Escape key
                            const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
                            document.dispatchEvent(escEvent);
                            return { success: false, message: 'no_conversations_found' };
                        }

                        // Determine target row based on index or title search
                        let matchedRow = null;
                        let matchedIndex = -1;

                        // Parse potential numeric index
                        const num = typeof targetParam === 'number' ? targetParam : parseInt(targetParam, 10);
                        if (!isNaN(num) && num >= 1 && num <= rows.length) {
                            // Match 1-based index directly
                            matchedIndex = num - 1;
                            matchedRow = rows[matchedIndex];
                        } else if (typeof targetParam === 'string' && targetParam.trim()) {
                            // Match by case-insensitive title search query
                            const query = targetParam.trim().toLowerCase();
                            matchedIndex = rows.findIndex(r => (r.innerText || '').toLowerCase().includes(query));
                            if (matchedIndex !== -1) {
                                matchedRow = rows[matchedIndex];
                            }
                        }

                        // Check if a matching conversation row was located
                        if (!matchedRow) {
                            // Close the popup cleanly using Escape key
                            const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
                            document.dispatchEvent(escEvent);
                            return { 
                                success: false, 
                                message: 'conversation_not_found', 
                                totalConversations: rows.length 
                            };
                        }

                        // Extract title from matched row
                        const titleEl = matchedRow.querySelector('span.text-sm') || matchedRow.querySelector('span');
                        const title = titleEl ? titleEl.innerText.trim() : (matchedRow.innerText || '').split('\\n')[0].trim();

                        // Check if conversation is already in the Current active section
                        const listbox = fastPick.querySelector('[role="listbox"]');
                        const currentSection = listbox?.children[0];
                        const isCurrent = currentSection ? currentSection.contains(matchedRow) : false;

                        // If conversation is already active, close popup cleanly and return
                        if (isCurrent) {
                            const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true });
                            document.dispatchEvent(escEvent);
                            return {
                                success: true,
                                index: matchedIndex + 1,
                                title,
                                isCurrent: true
                            };
                        }

                        // Scroll the target conversation row into view
                        matchedRow.scrollIntoView({ block: 'nearest' });
                        // Retrieve element bounding box coordinates
                        const rect = matchedRow.getBoundingClientRect();

                        // Return coordinates for hardware-level CDP click emulation
                        return {
                            success: true,
                            index: matchedIndex + 1,
                            title,
                            isCurrent: false,
                            x: Math.round(rect.x + rect.width / 2),
                            y: Math.round(rect.y + rect.height / 2)
                        };
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            });

            // Extract returned value from runtime evaluation
            const val = result?.result?.value;

            // If conversation was found and is already current, return immediately
            if (val && val.success && val.isCurrent) {
                // Close connection to current CDP client
                client.close();
                return val;
            }

            // If coordinates were returned, perform native hardware-level click and confirm prompt
            if (val && val.success && typeof val.x === 'number' && typeof val.y === 'number') {
                // Dispatch mouse move to target row center
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: val.x,
                    y: val.y
                });

                // Short delay for hover styling trigger
                await new Promise(r => setTimeout(r, 50));

                // Dispatch mouse pressed event at button center
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: val.x,
                    y: val.y,
                    button: 'left',
                    clickCount: 1
                });

                // Short delay between press and release
                await new Promise(r => setTimeout(r, 80));

                // Dispatch mouse released event at button center
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: val.x,
                    y: val.y,
                    button: 'left',
                    clickCount: 1
                });

                if (val.isSidebarRow) {
                    // Wait for route change and collapse sidebar drawer if we opened it
                    await new Promise(r => setTimeout(r, 350));
                    if (val.sidebarWasToggled) {
                        await client.send('Runtime.evaluate', {
                            expression: `(() => {
                                const closeBtn = document.querySelector('button[aria-label="Close Sidebar"]');
                                if (closeBtn) { closeBtn.click(); return; }
                                const backdrop = document.querySelector('[data-testid="sidebar-popover-backdrop"]');
                                if (backdrop) backdrop.click();
                            })()`
                        });
                    }
                } else {
                    // Wait for workspace prompt (asking to open in current window / workspace)
                    // Poll for the QuickPick prompt asking where to open the conversation
                    for (let attempt = 0; attempt < 12; attempt++) {
                        // Poll interval between checks
                        await new Promise(r => setTimeout(r, 100));
                        // Check if QuickPick prompt is open and get first option coordinates
                        const promptCheck = await client.send('Runtime.evaluate', {
                            expression: `
                                (function() {
                                    const qi = document.querySelector('.quick-input-widget');
                                    if (qi && qi.style.display !== 'none') {
                                        const firstRow = qi.querySelector('.monaco-list-row, .quick-input-list-row');
                                        if (firstRow) {
                                            const rect = firstRow.getBoundingClientRect();
                                            return {
                                                visible: true,
                                                x: Math.round(rect.x + rect.width / 2),
                                                y: Math.round(rect.y + rect.height / 2)
                                            };
                                        }
                                        return { visible: true };
                                    }
                                    return null;
                                })()
                            `,
                            returnByValue: true
                        });

                        // Check evaluation result
                        const promptVal = promptCheck?.result?.value;
                        if (promptVal && promptVal.visible) {
                            // Dispatch Enter key to confirm first option ("Open in current window")
                            await client.send('Input.dispatchKeyEvent', {
                                type: 'rawKeyDown',
                                key: 'Enter',
                                code: 'Enter',
                                windowsVirtualKeyCode: 13,
                                nativeVirtualKeyCode: 13
                            });
                            // Short key press interval
                            await new Promise(r => setTimeout(r, 50));
                            // Release Enter key
                            await client.send('Input.dispatchKeyEvent', {
                                type: 'keyUp',
                                key: 'Enter',
                                code: 'Enter',
                                windowsVirtualKeyCode: 13,
                                nativeVirtualKeyCode: 13
                            });

                            // Also perform hardware-level mouse click on the first option to ensure confirmation
                            if (typeof promptVal.x === 'number' && typeof promptVal.y === 'number') {
                                // Move mouse to first option
                                await client.send('Input.dispatchMouseEvent', {
                                    type: 'mouseMoved',
                                    x: promptVal.x,
                                    y: promptVal.y
                                });
                                // Mouse press on first option
                                await client.send('Input.dispatchMouseEvent', {
                                    type: 'mousePressed',
                                    x: promptVal.x,
                                    y: promptVal.y,
                                    button: 'left',
                                    clickCount: 1
                                });
                                // Short click interval
                                await new Promise(r => setTimeout(r, 50));
                                // Mouse release on first option
                                await client.send('Input.dispatchMouseEvent', {
                                    type: 'mouseReleased',
                                    x: promptVal.x,
                                    y: promptVal.y,
                                    button: 'left',
                                    clickCount: 1
                                });
                            }
                            // Stop polling once confirmed
                            break;
                        }
                    }
                }

                // Short pause for window navigation and UI to settle
                await new Promise(r => setTimeout(r, 500));

                // Close connection to current CDP client
                client.close();

                // Return success state
                return {
                    success: true,
                    index: val.index,
                    title: val.title,
                    isCurrent: false
                };
            }

            // Close connection to current CDP client if not successful
            client.close();
            if (val && !val.success) {
                return val;
            }
        } catch (e: any) {
            // Log warning if an error occurs while evaluating in target
            console.warn(`[CDP] Error switching conversation in target ${targetItem.title}:`, e.message);
        }
    }

    // Return failure when conversation could not be switched across any candidate targets
    return { success: false, message: 'Failed to switch conversation via CDP.' };
}

/**
 * Represents an available AI model option in the Antigravity chat model selector.
 */
export interface AgentModelItem {
    // 1-based index in the model selector dropdown
    index: number;
    // Display name of the model
    label: string;
    // Whether this model is currently active
    isCurrent: boolean;
}

/**
 * Result structure returned by getAvailableModels.
 */
export interface AvailableModelsResult {
    // Whether models were successfully retrieved
    success: boolean;
    // Currently active model name if detected
    currentModel?: string;
    // Array of available models
    models: AgentModelItem[];
    // Error message if query failed
    message?: string;
}

/**
 * Result structure returned by switchModel.
 */
export interface SwitchModelResult {
    // Whether switching succeeded
    success: boolean;
    // 1-based index of matched model
    index?: number;
    // Name of the active model after switch
    currentModel?: string;
    // Previous model name before switch
    previousModel?: string;
    // True if target model was already active
    isCurrent?: boolean;
    // Total count of models available
    totalModels?: number;
    // Error or status message
    message?: string;
}

interface CollectedModelItem extends AgentModelItem {
    effort?: string;
    type: 'effort_option' | 'model_item';
    x: number;
    y: number;
    groupHoverX?: number;
    groupHoverY?: number;
}

/**
 * Shared helper that opens the model selector menu in a CDP target, expands all effort groups,
 * and returns the ordered list of selectable models with live coordinates.
 * Leaves the menu open only when keepMenuOpen is true.
 */
async function collectModelsFromTarget(
    client: CdpClient,
    keepMenuOpen = false
): Promise<{ success: boolean; currentModel: string; items: CollectedModelItem[]; message?: string }> {
    const initRes = await client.send('Runtime.evaluate', {
        expression: `
            (async function() {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                await new Promise(r => setTimeout(r, 100));

                const btn = document.querySelector('[data-testid="model-selector-trigger"]')
                         || document.querySelector('button[aria-label^="Select model"]');
                if (!btn) return { success: false, message: 'model_trigger_not_found' };

                const currentModelText = btn.innerText.trim();
                btn.click();

                let menu = null;
                for (let i = 0; i < 15; i++) {
                    await new Promise(r => setTimeout(r, 100));
                    const menus = Array.from(document.querySelectorAll('div[role="menu"]'));
                    menu = menus.find(m => m.querySelector('[data-testid="model-selector-item"], [data-testid="model-selector-effort-group"], [role="menuitem"]')) || null;
                    if (menu) break;
                }

                if (!menu) return { success: false, message: 'model_menu_not_found' };

                const rows = Array.from(menu.querySelectorAll('[role="menuitem"]'));
                const hasModelTestIds = !!menu.querySelector('[data-testid="model-selector-item"], [data-testid="model-selector-effort-group"]');
                const entries = [];

                for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                    const row = rows[rowIdx];
                    const effortEl = row.querySelector('[data-testid="model-selector-effort-group"]');
                    const isModelItem = row.getAttribute('data-testid') === 'model-selector-item' || row.hasAttribute('data-model-label');
                    if (hasModelTestIds && !effortEl && !isModelItem) {
                        // Skip non-model menu items such as "View Usage"
                        continue;
                    }

                    const isUnavailable = row.getAttribute('aria-disabled') === 'true'
                        || row.hasAttribute('data-disabled')
                        || /\bUnavailable\b/i.test(row.innerText || '');
                    if (isUnavailable) continue;

                    const rect = row.getBoundingClientRect();
                    const cx = Math.round(rect.x + rect.width / 2);
                    const cy = Math.round(rect.y + rect.height / 2);

                    if (effortEl) {
                        const base = effortEl.getAttribute('data-model-base') || (row.innerText || '').trim();
                        entries.push({
                            kind: 'effort_group',
                            base,
                            hoverX: cx,
                            hoverY: cy
                        });
                    } else {
                        const label = row.getAttribute('data-model-label') || (row.innerText || '').trim();
                        const isCurrent = row.classList.contains('bg-secondary')
                            || (label.length > 0 && currentModelText.toLowerCase().includes(label.toLowerCase()));
                        entries.push({
                            kind: 'model_item',
                            label,
                            isCurrent,
                            clickX: cx,
                            clickY: cy
                        });
                    }
                }

                return {
                    success: true,
                    currentModelText,
                    entries
                };
            })()
        `,
        awaitPromise: true,
        returnByValue: true
    });

    const initVal = initRes?.result?.value;
    if (!initVal || !initVal.success) {
        return { success: false, currentModel: '', items: [], message: initVal?.message || 'model_menu_not_found' };
    }

    const currentBtnText: string = initVal.currentModelText || '';
    const items: CollectedModelItem[] = [];
    let index = 1;

    for (const entry of initVal.entries || []) {
        if (entry.kind === 'effort_group') {
            // Hover each effort group individually so its submenu opens and returns exact options & coordinates
            await client.send('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x: entry.hoverX,
                y: entry.hoverY
            });
            await new Promise(r => setTimeout(r, 170));

            const subRes = await client.send('Runtime.evaluate', {
                returnByValue: true,
                expression: `(() => {
                    const menus = Array.from(document.querySelectorAll('div[role="menu"]'));
                    const mainContentMenu = menus.find(m => m.querySelector('[data-testid="model-selector-item"], [data-testid="model-selector-effort-group"]')) || menus[0];
                    const subMenu = menus.find(m => m !== mainContentMenu && (m.querySelector('[role="menuitemradio"]') || m.querySelector('[data-testid="model-selector-effort-option"]')));
                    if (!subMenu) return [];

                    const rawOpts = Array.from(subMenu.querySelectorAll('[role="menuitemradio"]'));
                    const opts = rawOpts.length > 0 ? rawOpts : Array.from(subMenu.querySelectorAll('[data-testid="model-selector-effort-option"]'));
                    return opts.map(opt => {
                        const innerOpt = opt.querySelector('[data-testid="model-selector-effort-option"]') || opt;
                        const textLabel = (opt.innerText || innerOpt.getAttribute('data-effort') || '').replace(/\\s+/g, ' ').trim();
                        const effortAttr = (innerOpt.getAttribute('data-effort') || textLabel || '').trim().toLowerCase();
                        const isChecked = opt.getAttribute('aria-checked') === 'true' || opt.getAttribute('data-checked') !== null;
                        const rect = opt.getBoundingClientRect();
                        return {
                            textLabel,
                            effortAttr,
                            isChecked,
                            x: Math.round(rect.x + rect.width / 2),
                            y: Math.round(rect.y + rect.height / 2)
                        };
                    });
                })()`
            });

            const subOpts = subRes?.result?.value || [];
            if (subOpts.length > 0) {
                const seenEfforts = new Set<string>();
                for (const opt of subOpts) {
                    const rawName = (opt.textLabel || opt.effortAttr || '').trim();
                    const capitalEffort = rawName.charAt(0).toUpperCase() + rawName.slice(1);
                    if (!capitalEffort || seenEfforts.has(capitalEffort.toLowerCase())) {
                        continue;
                    }
                    seenEfforts.add(capitalEffort.toLowerCase());

                    const fullLabel = `${entry.base} (${capitalEffort})`;
                    const baseMatches = currentBtnText.toLowerCase().includes((entry.base || '').toLowerCase());
                    const effortMatches = opt.isChecked || currentBtnText.toLowerCase().includes(capitalEffort.toLowerCase());

                    items.push({
                        index: index++,
                        label: fullLabel,
                        effort: opt.effortAttr || capitalEffort.toLowerCase(),
                        isCurrent: baseMatches && effortMatches,
                        type: 'effort_option',
                        x: opt.x,
                        y: opt.y,
                        groupHoverX: entry.hoverX,
                        groupHoverY: entry.hoverY
                    });
                }
            } else {
                // Fallback if submenu did not open
                for (const eff of ['Low', 'Medium', 'High']) {
                    const baseMatches = currentBtnText.toLowerCase().includes((entry.base || '').toLowerCase());
                    items.push({
                        index: index++,
                        label: `${entry.base} (${eff})`,
                        effort: eff.toLowerCase(),
                        isCurrent: baseMatches && currentBtnText.toLowerCase().includes(eff.toLowerCase()),
                        type: 'effort_option',
                        x: entry.hoverX,
                        y: entry.hoverY,
                        groupHoverX: entry.hoverX,
                        groupHoverY: entry.hoverY
                    });
                }
            }
        } else {
            items.push({
                index: index++,
                label: entry.label,
                isCurrent: !!entry.isCurrent,
                type: 'model_item',
                x: entry.clickX,
                y: entry.clickY
            });
        }
    }

    if (!keepMenuOpen) {
        await client.send('Runtime.evaluate', {
            expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));`
        });
    }

    return {
        success: items.length > 0,
        currentModel: currentBtnText,
        items,
        message: items.length === 0 ? 'no_models_found' : undefined
    };
}

/**
 * Retrieves the list of available models and the currently selected model from Antigravity agent chat.
 */
export async function getAvailableModels(port: number): Promise<AvailableModelsResult> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();
            const res = await collectModelsFromTarget(client, false);
            client.close();

            if (res.success) {
                return {
                    success: true,
                    currentModel: res.currentModel,
                    models: res.items.map(({ index, label, isCurrent }) => ({ index, label, isCurrent }))
                };
            }
        } catch (e: any) {
            console.warn(`[CDP] Error fetching available models from ${target.title}:`, e.message);
        }
    }

    return { success: false, models: [], message: 'Model selector not found in chat UI.' };
}

/**
 * Switches the active model in Antigravity agent chat by 1-based index or name query.
 */
export async function switchModel(port: number, targetParam: number | string): Promise<SwitchModelResult> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    for (const targetItem of candidates) {
        try {
            const client = new CdpClient(targetItem.webSocketDebuggerUrl!);
            await client.connect();

            const collected = await collectModelsFromTarget(client, true);
            if (!collected.success) {
                client.close();
                continue;
            }

            const items = collected.items;
            let matched: CollectedModelItem | undefined;
            const num = typeof targetParam === 'number' ? targetParam : parseInt(targetParam, 10);
            if (!isNaN(num) && num >= 1 && num <= items.length) {
                matched = items[num - 1];
            } else if (typeof targetParam === 'string' && targetParam.trim()) {
                const query = targetParam.trim().toLowerCase();
                matched = items.find(i => i.label.toLowerCase() === query)
                       || items.find(i => i.effort && i.effort === query)
                       || items.find(i => i.label.toLowerCase().includes(query));
            }

            if (!matched) {
                await client.send('Runtime.evaluate', {
                    expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));`
                });
                client.close();
                return { success: false, message: 'model_not_found', totalModels: items.length };
            }

            if (matched.isCurrent) {
                await client.send('Runtime.evaluate', {
                    expression: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));`
                });
                client.close();
                return {
                    success: true,
                    isCurrent: true,
                    index: matched.index,
                    currentModel: matched.label
                };
            }

            // Re-hover the matched effort group so its submenu is open at the target coordinates
            if (matched.type === 'effort_option' && typeof matched.groupHoverX === 'number' && typeof matched.groupHoverY === 'number') {
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseMoved',
                    x: matched.groupHoverX,
                    y: matched.groupHoverY
                });
                await new Promise(r => setTimeout(r, 170));
            }

            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: matched.x, y: matched.y });
            await new Promise(r => setTimeout(r, 50));
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: matched.x, y: matched.y, button: 'left', clickCount: 1 });
            await new Promise(r => setTimeout(r, 80));
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: matched.x, y: matched.y, button: 'left', clickCount: 1 });

            await new Promise(r => setTimeout(r, 400));

            const afterRes = await client.send('Runtime.evaluate', {
                expression: `(() => {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                    const btn = document.querySelector('[data-testid="model-selector-trigger"]')
                             || document.querySelector('button[aria-label^="Select model"]');
                    return btn ? btn.innerText.trim() : null;
                })()`,
                returnByValue: true
            });

            client.close();

            return {
                success: true,
                isCurrent: false,
                index: matched.index,
                currentModel: afterRes?.result?.value || matched.label,
                previousModel: collected.currentModel
            };
        } catch (e: any) {
            console.warn(`[CDP] Error switching model in target ${targetItem.title}:`, e.message);
        }
    }

    return { success: false, message: 'Failed to switch model via CDP.' };
}

/**
 * Represents an option item in an interactive agent question.
 */
export interface PendingQuestionOption {
    // 1-based sequential index of the option
    index: number;
    // Display text of the option
    text: string;
    // Optional identifier attribute
    id?: string;
    // Whether this option is currently selected
    selected?: boolean;
}

/**
 * Represents an interactive question asked by the Antigravity agent awaiting user response.
 */
export interface PendingAgentQuestion {
    // Whether an interactive question is currently active and awaiting response
    hasQuestion: boolean;
    // Main question text or prompt heading
    questionText: string;
    // Array of available choice options
    options: PendingQuestionOption[];
    // Whether multiple choices can be selected
    isMultiSelect: boolean;
    // Whether a Submit button is present in the UI
    hasSubmitButton: boolean;
    // Whether a Skip button is present in the UI
    hasSkipButton: boolean;
    // Whether a custom write-in text field is present
    hasCustomInput: boolean;
    // CDP target ID hosting the question dialog
    targetId?: string;
}

/**
 * Result structure returned by answerAgentQuestion.
 */
export interface AnswerQuestionResult {
    // Whether submitting or skipping the question succeeded
    success: boolean;
    // Explanatory message or error detail
    message?: string;
    // Text of the chosen option if selected
    chosenOptionText?: string;
    // Text of custom write-in input if provided
    customText?: string;
    // True if question was skipped
    skipped?: boolean;
}

/**
 * Shared browser evaluation script that detects an active interactive question modal or card.
 */
const PENDING_QUESTION_EVAL_JS = `(() => {
                        // Scan for visible Skip and Submit buttons inside viewport (excluding composer/sidebar)
                        const allButtons = Array.from(document.querySelectorAll('button')).filter(b => {
                            const s = window.getComputedStyle(b);
                            if (s.display === 'none' || s.visibility === 'hidden' || b.offsetHeight <= 0) return false;
                            if (b.closest('[data-testid="agent-input-box"], [data-testid="conversation-list-sidebar"]')) return false;
                            const r = b.getBoundingClientRect();
                            return r.right > 0 && r.bottom > 0 && r.left < (window.innerWidth || 9999);
                        });

                        const skipBtn = allButtons.find(b => {
                            const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                        });

                        const submitBtn = allButtons.find(b => {
                            const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
                            return bt === 'submit' || bt === 'proceed' || bt.includes('إرسال') || bt.includes('تأكيد') || b.getAttribute('type') === 'submit';
                        });

                        // Locate question container directly from the active Skip or Submit button
                        let questionRoot = null;
                        if (skipBtn) {
                            questionRoot = skipBtn.closest('div.no-focus-ring') ||
                                           skipBtn.closest('div[tabindex="-1"]') ||
                                           skipBtn.closest('div.border') ||
                                           skipBtn.parentElement?.parentElement;
                        } else if (submitBtn) {
                            questionRoot = submitBtn.closest('div.no-focus-ring') ||
                                           submitBtn.closest('div[tabindex="-1"]') ||
                                           submitBtn.closest('div.border') ||
                                           submitBtn.parentElement?.parentElement;
                        }

                        // Priority 1: Check for open modal dialogs containing questions/options
                        if (!questionRoot) {
                            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .monaco-dialog-box, [data-radix-portal], div.fixed.inset-0, div[class*="modal"]'));
                            for (const d of dialogs) {
                                const style = window.getComputedStyle(d);
                                if (style.display === 'none' || style.visibility === 'hidden' || d.getAttribute('aria-hidden') === 'true') continue;
                                const hasSubmit = !!d.querySelector('button') && Array.from(d.querySelectorAll('button')).some(b => {
                                    const bt = (b.innerText || '').trim().toLowerCase();
                                    return bt === 'submit' || bt === 'proceed' || bt.includes('إرسال') || bt.includes('تأكيد') || b.getAttribute('type') === 'submit';
                                });
                                const hasSkip = !!d.querySelector('button') && Array.from(d.querySelectorAll('button')).some(b => {
                                    const bt = (b.innerText || '').trim().toLowerCase();
                                    return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                                });
                                const hasOptions = d.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], label').length > 0;

                                if (hasSubmit || (hasOptions && hasSkip)) {
                                    questionRoot = d;
                                    break;
                                }
                            }
                        }

                        // Priority 2: Check for active in-chat question cards with pending options / submit buttons
                        if (!questionRoot) {
                            const chatCards = Array.from(document.querySelectorAll('.rounded-xl.border.border-border, [data-testid*="question"], div.flex.flex-col:has(> .divide-y)'));
                            for (let i = chatCards.length - 1; i >= 0; i--) {
                                const c = chatCards[i];
                                const style = window.getComputedStyle(c);
                                if (style.display === 'none' || style.visibility === 'hidden' || c.getAttribute('aria-hidden') === 'true') continue;
                                const hasSubmit = Array.from(c.querySelectorAll('button')).some(b => {
                                    const bt = (b.innerText || '').trim().toLowerCase();
                                    return bt === 'submit' || bt.includes('إرسال') || bt === 'proceed' || bt.includes('تأكيد') || b.getAttribute('type') === 'submit';
                                });
                                const hasSkip = Array.from(c.querySelectorAll('button')).some(b => {
                                    const bt = (b.innerText || '').trim().toLowerCase();
                                    return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                                });
                                const hasRadios = c.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').length > 0;
                                const hasClickableOptions = c.querySelectorAll('.cursor-pointer, label').length > 0;
                                const cardText = (c.innerText || '').toLowerCase();

                                if ((hasSubmit || hasSkip) && (hasRadios || hasClickableOptions || cardText.includes('question'))) {
                                    questionRoot = c;
                                    break;
                                }
                            }
                        }

                        if (!questionRoot) {
                            return { hasQuestion: false };
                        }

                        // Extract Question text: find heading or main paragraph
                        let questionText = '';
                        const headings = Array.from(questionRoot.querySelectorAll('.leading-relaxed, .select-text, h1, h2, h3, h4, p, [class*="font-semibold"], [class*="font-medium"]'));
                        for (const h of headings) {
                            const clone = h.cloneNode(true);
                            clone.querySelectorAll('style, script, svg').forEach(s => s.remove());
                            const ht = (clone.innerText || clone.textContent || '').trim();
                            if (ht && ht.length > 3 && !ht.includes('/* Copied from') && !ht.toLowerCase().includes('submit') && !ht.toLowerCase().includes('skip')) {
                                questionText = ht;
                                break;
                            }
                        }

                        // Extract Options:
                        const options = [];
                        const seenTexts = new Set();
                        let optIndex = 1;
                        let hasCustomInput = false;

                        // Check labels inside questionRoot (matches Antigravity custom choice labels)
                        const optionLabels = Array.from(questionRoot.querySelectorAll('label, [role="radio"], [role="checkbox"]'));
                        for (const lbl of optionLabels) {
                            if (lbl.tagName === 'BUTTON' || lbl.closest('button')) continue;

                            const rawAll = (lbl.innerText || lbl.textContent || '').trim();
                            if (rawAll.includes('↵') || lbl.querySelector('input[type="text"], textarea')) {
                                hasCustomInput = true;
                                continue;
                            }

                            const textSpan = lbl.querySelector('span.text-secondary-foreground:not(.font-mono)') ||
                                             lbl.querySelector('span:not(.font-mono)');
                            let text = '';
                            if (textSpan) {
                                text = (textSpan.innerText || textSpan.textContent || '').trim();
                            }

                            if (!text) {
                                const clone = lbl.cloneNode(true);
                                clone.querySelectorAll('.font-mono, svg, style, script').forEach(e => e.remove());
                                text = (clone.innerText || clone.textContent || '').trim();
                            }

                            text = text.replace(/^\\d+[\\s\\n\\r]+/, '').trim();

                            if (!text || text === '↵' || text.toLowerCase() === 'submit' || text.toLowerCase() === 'skip') continue;
                            if (text === questionText) continue;

                            if (!seenTexts.has(text)) {
                                seenTexts.add(text);
                                const isSelected = lbl.classList.contains('bg-secondary') ||
                                                   !lbl.classList.contains('!border-transparent') ||
                                                   lbl.getAttribute('aria-checked') === 'true';
                                options.push({
                                    index: optIndex++,
                                    text: text,
                                    selected: isSelected
                                });
                            }
                        }

                        // Check radio/checkbox inputs and their parent labels first
                        if (options.length === 0) {
                            const inputEls = Array.from(questionRoot.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
                            if (inputEls.length > 0) {
                                for (const inp of inputEls) {
                                    const label = inp.closest('label') || inp.parentElement;
                                    const clone = label ? label.cloneNode(true) : null;
                                    if (clone) clone.querySelectorAll('style, script, svg, input').forEach(s => s.remove());
                                    const text = (clone ? clone.innerText : inp.value || '').trim();
                                    if (text && !seenTexts.has(text)) {
                                        seenTexts.add(text);
                                        options.push({
                                            index: optIndex++,
                                            text: text,
                                            selected: inp.checked
                                        });
                                    }
                                }
                            }
                        }

                        // If no radio inputs found, query option labels, spans, or items
                        if (options.length === 0) {
                            const optionElements = Array.from(questionRoot.querySelectorAll('label, [role="radio"], [role="checkbox"], span.text-secondary-foreground, div.divide-y > div'));
                            for (const el of optionElements) {
                                if (el.tagName === 'BUTTON' || el.closest('button')) continue;
                                const clone = el.cloneNode(true);
                                clone.querySelectorAll('style, script, svg').forEach(s => s.remove());
                                const rawText = (clone.innerText || '').trim();
                                if (!rawText || rawText.length < 2 || seenTexts.has(rawText)) continue;
                                if (rawText.toLowerCase() === 'submit' || rawText.toLowerCase() === 'skip' || rawText.includes('/* Copied')) continue;
                                if (rawText === questionText) continue;

                                seenTexts.add(rawText);
                                const radioInput = el.querySelector('input[type="radio"], input[type="checkbox"]');
                                const isChecked = radioInput ? radioInput.checked : (el.getAttribute('aria-checked') === 'true' || el.classList.contains('selected'));

                                options.push({
                                    index: optIndex++,
                                    text: rawText,
                                    selected: isChecked
                                });
                            }
                        }

                        const finalSubmitBtn = Array.from(questionRoot.querySelectorAll('button')).find(b => {
                            const bt = (b.innerText || '').trim().toLowerCase();
                            return bt === 'submit' || bt.includes('إرسال') || bt === 'proceed' || bt.includes('تأكيد') || b.getAttribute('type') === 'submit';
                        }) || submitBtn;

                        const finalSkipBtn = Array.from(questionRoot.querySelectorAll('button')).find(b => {
                            const bt = (b.innerText || '').trim().toLowerCase();
                            return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                        }) || skipBtn;

                        const customInput = questionRoot.querySelector('input[type="text"], textarea');
                        if (customInput) hasCustomInput = true;
                        const isMultiSelect = questionRoot.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 0;

                        return {
                            hasQuestion: (options.length > 0 || hasCustomInput) && (!!finalSubmitBtn || !!finalSkipBtn),
                            questionText: questionText || 'Antigravity Agent Question',
                            options: options,
                            isMultiSelect: isMultiSelect,
                            hasSubmitButton: !!finalSubmitBtn,
                            hasSkipButton: !!finalSkipBtn,
                            hasCustomInput: hasCustomInput
                        };
                    })()`;

/**
 * Checks if the Antigravity agent currently has an active interactive question modal or card waiting for input.
 */
export async function getPendingAgentQuestion(port: number): Promise<PendingAgentQuestion | null> {
    try {
        const raw = await httpGet(`http://127.0.0.1:${port}/json`);
        const targets: CdpTarget[] = JSON.parse(raw);
        // Search across all candidate pages and webviews
        const candidates = getFilteredChatCandidates(targets);

        for (const target of candidates) {
            try {
                const client = new CdpClient(target.webSocketDebuggerUrl!);
                await client.connect();

                const evalRes = await client.send('Runtime.evaluate', {
                    expression: PENDING_QUESTION_EVAL_JS,
                    returnByValue: true
                });

                client.close();
                const val = evalRes?.result?.value;
                if (val && val.hasQuestion) {
                    val.targetId = target.id;
                    return val as PendingAgentQuestion;
                }
            } catch (err: any) {
                console.warn(`[CDP] Error checking pending question in target ${target.title}:`, err.message);
            }
        }
    } catch (e: any) {
        console.warn('[CDP] getPendingAgentQuestion failed:', e.message);
    }
    return null;
}

export interface AgentActivitySnapshot {
    hasChat: boolean;
    isGenerating: boolean;
    isIdle: boolean;
    pendingQuestion: PendingAgentQuestion | null;
}

/**
 * Probes CDP targets once to retrieve both generation status and any pending interactive question
 * in a single Runtime.evaluate round trip.
 */
export async function getAgentActivitySnapshot(port: number): Promise<AgentActivitySnapshot> {
    try {
        const raw = await httpGet(`http://127.0.0.1:${port}/json`);
        const targets: CdpTarget[] = JSON.parse(raw);
        const candidates = getFilteredChatCandidates(targets);

        for (const target of candidates) {
            try {
                const client = new CdpClient(target.webSocketDebuggerUrl!);
                await client.connect();

                const evalRes = await client.send('Runtime.evaluate', {
                    expression: `(() => ({
                        status: ${CHAT_STATUS_EVAL_JS},
                        question: ${PENDING_QUESTION_EVAL_JS}
                    }))()`,
                    returnByValue: true
                });

                client.close();
                const val = evalRes?.result?.value;
                const status = val?.status;
                const question = val?.question;

                if (status?.hasChat || question?.hasQuestion) {
                    let pendingQuestion: PendingAgentQuestion | null = null;
                    if (question?.hasQuestion) {
                        question.targetId = target.id;
                        pendingQuestion = question as PendingAgentQuestion;
                    }
                    return {
                        hasChat: !!status?.hasChat,
                        isGenerating: !!status?.isGenerating,
                        isIdle: !!status?.isIdle,
                        pendingQuestion
                    };
                }
            } catch (_) {
                // Ignore transient errors on closed or inaccessible targets
            }
        }
    } catch (_) {
        // Ignore transient CDP connection errors when debugging port is unreachable
    }

    return { hasChat: false, isGenerating: false, isIdle: false, pendingQuestion: null };
}

/**
 * Answers or skips a pending interactive agent question via CDP.
 */
export async function answerAgentQuestion(
    port: number,
    options: { optionIndex?: number; optionText?: string; customText?: string; isSkip?: boolean; targetId?: string }
): Promise<AnswerQuestionResult> {
    // Track errors and modal container detection across candidate windows
    let lastError = '';
    let foundAnyContainer = false;

    try {
        const raw = await httpGet(`http://127.0.0.1:${port}/json`);
        const targets: CdpTarget[] = JSON.parse(raw);
        const candidates = getFilteredChatCandidates(targets);
        if (options.targetId) {
            candidates.sort((a, b) => (a.id === options.targetId ? -1 : (b.id === options.targetId ? 1 : 0)));
        }

        for (const target of candidates) {
            try {
                const client = new CdpClient(target.webSocketDebuggerUrl!);
                await client.connect();

                const answerRes = await client.send('Runtime.evaluate', {
                    expression: `(async function() {
                        try {
                            const targetOptions = ${JSON.stringify(options)};

                            // Helper function to dispatch full sequence of pointer and mouse events
                            const triggerClick = (el) => {
                                if (!el) return;
                                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                                if (typeof el.focus === 'function') el.focus();
                                const eventOpts = { bubbles: true, cancelable: true, view: window };
                                el.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
                                el.dispatchEvent(new MouseEvent('mousedown', eventOpts));
                                el.dispatchEvent(new PointerEvent('pointerup', eventOpts));
                                el.dispatchEvent(new MouseEvent('mouseup', eventOpts));
                                el.click();
                            };

                            // Locate question container (modal or in-chat card)
                            // Scan for visible Skip and Submit buttons inside viewport (excluding composer/sidebar)
                            const allButtons = Array.from(document.querySelectorAll('button')).filter(b => {
                                const s = window.getComputedStyle(b);
                                if (s.display === 'none' || s.visibility === 'hidden' || b.offsetHeight <= 0) return false;
                                if (b.closest('[data-testid="agent-input-box"], [data-testid="conversation-list-sidebar"]')) return false;
                                const r = b.getBoundingClientRect();
                                return r.right > 0 && r.bottom > 0 && r.left < (window.innerWidth || 9999);
                            });

                            const skipBtn = allButtons.find(b => {
                                const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                            });

                            const submitBtn = allButtons.find(b => {
                                const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                return bt === 'submit' || bt === 'proceed' || bt.includes('إرسال') || bt.includes('تأكيد') || b.getAttribute('type') === 'submit';
                            });

                            let questionRoot = null;
                            if (skipBtn) {
                                questionRoot = skipBtn.closest('div.no-focus-ring') ||
                                               skipBtn.closest('div[tabindex="-1"]') ||
                                               skipBtn.closest('div.border') ||
                                               skipBtn.parentElement?.parentElement;
                            } else if (submitBtn) {
                                questionRoot = submitBtn.closest('div.no-focus-ring') ||
                                               submitBtn.closest('div[tabindex="-1"]') ||
                                               submitBtn.closest('div.border') ||
                                               submitBtn.parentElement?.parentElement;
                            }

                            if (!questionRoot) {
                                const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .monaco-dialog-box, [data-radix-portal], div.fixed.inset-0, div[class*="modal"]'));
                                for (const d of dialogs) {
                                    const style = window.getComputedStyle(d);
                                    if (style.display === 'none' || style.visibility === 'hidden' || d.getAttribute('aria-hidden') === 'true') continue;
                                    const hasSubmit = !!d.querySelector('button') && Array.from(d.querySelectorAll('button')).some(b => {
                                        const bt = (b.innerText || '').trim().toLowerCase();
                                        return bt === 'submit' || bt === 'proceed' || bt.includes('إرسال') || bt.includes('تأكيد') || b.getAttribute('type') === 'submit';
                                    });
                                    const hasSkip = !!d.querySelector('button') && Array.from(d.querySelectorAll('button')).some(b => {
                                        const bt = (b.innerText || '').trim().toLowerCase();
                                        return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                                    });
                                    const hasOptions = d.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], label').length > 0;
                                    if (hasSubmit || (hasOptions && hasSkip)) {
                                        questionRoot = d;
                                        break;
                                    }
                                }
                            }

                            if (!questionRoot) {
                                const chatCards = Array.from(document.querySelectorAll('.rounded-xl.border.border-border, [data-testid*="question"], div.flex.flex-col:has(> .divide-y)'));
                                for (let i = chatCards.length - 1; i >= 0; i--) {
                                    const c = chatCards[i];
                                    const style = window.getComputedStyle(c);
                                    if (style.display === 'none' || style.visibility === 'hidden' || c.getAttribute('aria-hidden') === 'true') continue;
                                    const hasSubmit = Array.from(c.querySelectorAll('button')).some(b => {
                                        const bt = (b.innerText || '').trim().toLowerCase();
                                        return bt === 'submit' || bt.includes('إرسال') || bt === 'proceed' || bt.includes('تأكيد') || b.getAttribute('type') === 'submit';
                                    });
                                    const hasSkip = Array.from(c.querySelectorAll('button')).some(b => {
                                        const bt = (b.innerText || '').trim().toLowerCase();
                                        return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                                    });
                                    const hasRadios = c.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]').length > 0;
                                    const hasClickableOptions = c.querySelectorAll('.cursor-pointer, label').length > 0;
                                    const cardText = (c.innerText || '').toLowerCase();
                                    if ((hasSubmit || hasSkip) && (hasRadios || hasClickableOptions || cardText.includes('question'))) {
                                        questionRoot = c;
                                        break;
                                    }
                                }
                            }

                            if (!questionRoot) {
                                return { success: false, message: 'question_container_not_found' };
                            }

                            // Action 1: Handle Skip
                            if (targetOptions.isSkip) {
                                const curSkipBtn = Array.from(questionRoot.querySelectorAll('button')).find(b => {
                                    const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                    return bt === 'skip' || bt.includes('تخطي') || bt === 'cancel' || bt.includes('إلغاء');
                                }) || skipBtn;

                                if (curSkipBtn) {
                                    triggerClick(curSkipBtn);
                                    return { success: true, skipped: true };
                                }

                                // Fallback: Dispatch Escape key to dismiss modal
                                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                                return { success: true, skipped: true };
                            }

                            // Extract Question text to filter out matching label duplicates
                            let questionText = '';
                            const headings = Array.from(questionRoot.querySelectorAll('.leading-relaxed, .select-text, h1, h2, h3, h4, p'));
                            for (const h of headings) {
                                const clone = h.cloneNode(true);
                                clone.querySelectorAll('style, script, svg').forEach(s => s.remove());
                                const ht = (clone.innerText || clone.textContent || '').trim();
                                if (ht && ht.length > 3 && !ht.toLowerCase().includes('submit') && !ht.toLowerCase().includes('skip')) {
                                    questionText = ht;
                                    break;
                                }
                            }

                            // Action 2: Handle custom text write-in
                            if (targetOptions.customText) {
                                // First check if custom write-in label exists and click it to open text input
                                const customLabel = Array.from(questionRoot.querySelectorAll('label')).find(l => (l.innerText || l.textContent || '').includes('↵'));
                                if (customLabel) {
                                    triggerClick(customLabel);
                                    await new Promise(r => setTimeout(r, 150));
                                }

                                const customInput = questionRoot.querySelector('input[type="text"], textarea, [contenteditable="true"]');
                                if (customInput) {
                                    customInput.focus();
                                    if (customInput.tagName === 'INPUT' || customInput.tagName === 'TEXTAREA') {
                                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
                                                       Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
                                        if (setter) setter.call(customInput, targetOptions.customText);
                                        else customInput.value = targetOptions.customText;

                                        customInput.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: targetOptions.customText }));
                                        customInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: targetOptions.customText }));
                                        customInput.dispatchEvent(new Event('change', { bubbles: true }));
                                    } else {
                                        customInput.innerText = targetOptions.customText;
                                        customInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
                                    }

                                    await new Promise(r => setTimeout(r, 150));

                                    // Locate Submit button
                                    let curSubmitBtn = Array.from(document.querySelectorAll('button')).find(b => {
                                        const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                        const isSkip = bt === 'skip' || bt.includes('تخطي') || bt === 'cancel';
                                        if (isSkip) return false;
                                        return (bt === 'submit' || bt.includes('إرسال') || bt === 'proceed' || bt.includes('تأكيد')) && !b.disabled;
                                    }) || submitBtn;

                                    if (curSubmitBtn) {
                                        triggerClick(curSubmitBtn);
                                        return { success: true, customText: targetOptions.customText };
                                    }
                                }
                            }

                            // Action 3: Handle Option Selection by index or text
                            // Collect valid option targets matching the exact logic of getPendingAgentQuestion
                            const validOptions = [];
                            const seen = new Set();

                            // Query label elements first (Antigravity options)
                            const optionLabels = Array.from(questionRoot.querySelectorAll('label, [role="radio"], [role="checkbox"]'));

                            for (const lbl of optionLabels) {
                                if (lbl.tagName === 'BUTTON' || lbl.closest('button')) continue;
                                const rawAll = (lbl.innerText || lbl.textContent || '').trim();
                                if (rawAll.includes('↵') || lbl.querySelector('input[type="text"], textarea')) {
                                    continue; // Custom write-in label
                                }

                                const textSpan = lbl.querySelector('span.text-secondary-foreground:not(.font-mono)') ||
                                                 lbl.querySelector('span:not(.font-mono)');
                                let text = '';
                                if (textSpan) {
                                    text = (textSpan.innerText || textSpan.textContent || '').trim();
                                }
                                if (!text) {
                                    const clone = lbl.cloneNode(true);
                                    clone.querySelectorAll('.font-mono, svg, style, script').forEach(s => s.remove());
                                    text = (clone.textContent || '').trim();
                                }

                                text = text.replace(/^\\d+[\\s\\n\\r]+/, '').trim();
                                if (!text || text === '↵' || text.toLowerCase() === 'submit' || text.toLowerCase() === 'skip') continue;
                                if (text === questionText) continue;

                                if (!seen.has(text)) {
                                    seen.add(text);
                                    validOptions.push({ element: lbl, text: text });
                                }
                            }

                            // Fallback option targets if no labels found
                            if (validOptions.length === 0) {
                                const optionElements = Array.from(questionRoot.querySelectorAll('div.divide-y > div, span.text-secondary-foreground, .cursor-pointer'));
                                for (const el of optionElements) {
                                    if (el.tagName === 'BUTTON' || el.closest('button')) continue;
                                    const clone = el.cloneNode(true);
                                    clone.querySelectorAll('style, script, svg').forEach(s => s.remove());
                                    const raw = (clone.innerText || clone.textContent || '').trim();
                                    if (!raw || raw.length < 2 || seen.has(raw)) continue;
                                    if (raw.toLowerCase() === 'submit' || raw.toLowerCase() === 'skip' || raw.includes('/* Copied')) continue;
                                    seen.add(raw);
                                    validOptions.push({ element: el, text: raw });
                                }
                            }

                            let matchedEl = null;
                            let matchedText = '';

                            if (typeof targetOptions.optionIndex === 'number' && targetOptions.optionIndex >= 1 && targetOptions.optionIndex <= validOptions.length) {
                                const opt = validOptions[targetOptions.optionIndex - 1];
                                matchedEl = opt.element;
                                matchedText = opt.text;
                            } else if (targetOptions.optionText) {
                                const qLower = targetOptions.optionText.trim().toLowerCase();
                                const opt = validOptions.find(o => o.text.toLowerCase().includes(qLower));
                                if (opt) {
                                    matchedEl = opt.element;
                                    matchedText = opt.text;
                                }
                            } else if (targetOptions.customText) {
                                // Check if customText matches an option directly
                                const qLower = targetOptions.customText.trim().toLowerCase();
                                const opt = validOptions.find(o => o.text.toLowerCase().includes(qLower));
                                if (opt) {
                                    matchedEl = opt.element;
                                    matchedText = opt.text;
                                }
                            }

                            if (matchedEl) {
                                // Click the matching option with full event emulation
                                triggerClick(matchedEl);

                                const radioOrCheck = matchedEl.querySelector('input[type="radio"], input[type="checkbox"]');
                                if (radioOrCheck) {
                                    if (!radioOrCheck.checked) {
                                        triggerClick(radioOrCheck);
                                    }
                                    radioOrCheck.checked = true;
                                    radioOrCheck.dispatchEvent(new Event('change', { bubbles: true }));
                                }

                                // Wait for React to process state change and enable Submit button (up to 800ms)
                                let finalSubmit = null;
                                const waitStart = Date.now();
                                while (Date.now() - waitStart < 800) {
                                    const btns = Array.from(document.querySelectorAll('button')).filter(b => {
                                        const s = window.getComputedStyle(b);
                                        return s.display !== 'none' && s.visibility !== 'hidden' && b.offsetHeight > 0;
                                    });

                                    finalSubmit = btns.find(b => {
                                        const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
                                        const isSkip = bt === 'skip' || bt.includes('تخطي') || bt === 'cancel';
                                        if (isSkip) return false;
                                        return (bt === 'submit' || bt === 'proceed' || bt.includes('إرسال') || bt.includes('تأكيد') || b.getAttribute('type') === 'submit') && !b.disabled;
                                    });

                                    // Fallback: check sibling button next to skipBtn
                                    if (!finalSubmit && skipBtn && skipBtn.parentElement) {
                                        const sibling = Array.from(skipBtn.parentElement.querySelectorAll('button')).find(b => b !== skipBtn && !b.disabled);
                                        if (sibling) finalSubmit = sibling;
                                    }

                                    if (finalSubmit) break;
                                    await new Promise(r => setTimeout(r, 50));
                                }

                                // Click the Submit button
                                if (finalSubmit) {
                                    triggerClick(finalSubmit);
                                    return { success: true, chosenOptionText: matchedText };
                                }

                                return { success: true, chosenOptionText: matchedText, message: 'option_clicked_submit_pending' };
                            }

                            return { success: false, message: 'option_not_found', optionsCount: validOptions.length, requestedIndex: targetOptions.optionIndex };
                        } catch (evalErr) {
                            return { success: false, message: evalErr.message || String(evalErr) };
                        }
                    })()`,
                    awaitPromise: true,
                    returnByValue: true
                });

                client.close();
                if (answerRes?.exceptionDetails) {
                    lastError = answerRes.exceptionDetails.exception?.description || answerRes.exceptionDetails.text || 'Runtime.evaluate exception';
                    console.warn(`[CDP] Exception in target ${target.title}:`, lastError);
                }
                const val = answerRes?.result?.value;
                if (val) {
                    if (val.success) {
                        return val as AnswerQuestionResult;
                    }
                    // If this target contained the question container but returned an error, surface it directly
                    if (val.message !== 'question_container_not_found') {
                        foundAnyContainer = true;
                        return val as AnswerQuestionResult;
                    }
                }
            } catch (err: any) {
                lastError = err.message;
                console.warn(`[CDP] Error answering question in target ${target.title}:`, err.message);
            }
        }
    } catch (e: any) {
        lastError = e.message;
        console.warn('[CDP] answerAgentQuestion failed:', e.message);
    }

    if (foundAnyContainer) {
        return { success: false, message: lastError || 'Question option could not be selected.' };
    }
    return {
        success: false,
        message: lastError ? `CDP Error: ${lastError}` : 'No active question found to answer (modal may have closed).'
    };
}




