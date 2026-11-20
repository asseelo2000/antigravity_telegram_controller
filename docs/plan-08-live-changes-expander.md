# 📋 خطة تنفيذ ميزة — عرض التغييرات الآنية للمحادثة (Live Changes Expander)

---

## 🎯 الهدف
إضافة ميزة تُرسل إلى تيليجرام لقطة موسّعة للتغييرات/الأوامر التي يقوم الوكيل بتنفيذها حالياً والتي تظهر عادةً في قسم "▶ التغييرات" (Collapsible Diff/Changes section) أسفل رسالة الوكيل — عبر:
1. **`/expand`** — توسيع كل سهم التغييرات المطوية وإرسال لقطة شاشة موسّعة
2. **`/changes`** — استخراج نص التغييرات (الملفات المُعدَّلة، الأوامر) كنص قابل للقراءة
3. **Auto-Expand** في `auto_accept.ts` — إمكانية التوسيع التلقائي أثناء التوليد

---

## 📐 نطاق العمل

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تسجيل `/expand` و `/changes` |
| `src/cdp_chat.ts` | دوال `expandAllChanges()` و `extractCurrentChanges()` |
| `src/auto_accept.ts` | إضافة خيار auto-expand اختياري |
| `src/i18n.ts` | مفاتيح ترجمة |
| `package.json` | إعداد جديد + أوامر |

---

## 🔍 التحليل التقني

### فهم بنية DOM لقسم التغييرات
في واجهة Antigravity/VSCode Webview، تظهر التغييرات الآنية عادةً كـ:
```html
<!-- قسم التغييرات القابل للطي -->
<div class="changes-container" aria-expanded="false">
  <button class="expand-toggle">▶ 3 تغييرات</button>
  <div class="changes-content" style="display:none">
    <div class="file-change">src/extension.ts — تعديل</div>
    <div class="command-step">Running: npm install</div>
    ...
  </div>
</div>
```

**المحددات المحتملة** (يجب الاختبار على DOM الحقيقي):
```javascript
// محددات متعددة لاستهداف عناصر الطي
const expandSelectors = [
    '[aria-expanded="false"]',
    '[data-state="collapsed"]',
    'details:not([open])',
    '.collapsible-section:not(.expanded)',
    '[class*="changes"][class*="collapsed"]',
    '[class*="diff-container"]:not(.expanded)',
    'summary', // عنصر HTML details/summary
];
```

### استراتيجية التوسيع
1. **الطريقة 1**: محاكاة النقر على أزرار `expand-toggle` عبر CDP `Runtime.evaluate`
2. **الطريقة 2**: تغيير `aria-expanded` و `style.display` مباشرة بـ JavaScript
3. **الطريقة 3**: إرسال `Keyboard.dispatchKeyEvent` للمفاتيح (Space/Enter على العنصر)

---

## 🗂️ خطة التنفيذ

### الخطوة 1 — دوال جديدة في `cdp_chat.ts`

```typescript
export interface ChangesSnapshot {
    expandedCount: number;
    files: string[];
    commands: string[];
    rawText: string;
    success: boolean;
}

/**
 * يوسّع كل قسم "التغييرات" المطوية في واجهة المحادثة
 */
export async function expandAllChanges(port: number): Promise<number> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            const result = await client.send('Runtime.evaluate', {
                expression: `
                    (function expandAll() {
                        let expandedCount = 0;

                        // استهداف عناصر HTML details/summary
                        const detailsElements = document.querySelectorAll('details:not([open])');
                        detailsElements.forEach(el => {
                            el.setAttribute('open', '');
                            expandedCount++;
                        });

                        // استهداف عناصر aria-expanded
                        const collapsedElements = document.querySelectorAll(
                            '[aria-expanded="false"], [data-state="collapsed"]'
                        );
                        collapsedElements.forEach(el => {
                            // تجنب استهداف عناصر غير مرغوبة (مثل القوائم المنسدلة)
                            const rect = el.getBoundingClientRect();
                            if (rect.width === 0 || rect.height === 0) return;

                            // محاولة النقر
                            try {
                                el.setAttribute('aria-expanded', 'true');
                                el.setAttribute('data-state', 'expanded');
                                el.click();
                                expandedCount++;
                            } catch(e) {}
                        });

                        // استهداف عناصر مخفية بـ CSS مرتبطة بالتغييرات
                        const hiddenContents = document.querySelectorAll([
                            '[class*="changes-content"][style*="display: none"]',
                            '[class*="diff-content"][style*="display: none"]',
                            '[class*="step-content"][style*="display: none"]',
                            '.collapsed-content'
                        ].join(', '));

                        hiddenContents.forEach(el => {
                            el.style.display = '';
                            el.style.visibility = 'visible';
                            el.style.height = 'auto';
                            el.style.overflow = 'visible';
                            expandedCount++;
                        });

                        return { expandedCount };
                    })()
                `,
                returnByValue: true,
                awaitPromise: false
            }, 10000);

            client.close();

            if (result?.result?.value?.expandedCount > 0) {
                return result.result.value.expandedCount;
            }
        } catch (err) {
            // جرّب Target التالي
        }
    }
    return 0;
}

/**
 * استخراج نص التغييرات والأوامر الجارية كبيانات قابلة للقراءة
 */
export async function extractCurrentChanges(port: number): Promise<ChangesSnapshot> {
    const raw = await httpGet(`http://127.0.0.1:${port}/json`);
    const targets: CdpTarget[] = JSON.parse(raw);
    const candidates = getFilteredChatCandidates(targets);

    for (const target of candidates) {
        try {
            const client = new CdpClient(target.webSocketDebuggerUrl!);
            await client.connect();

            const result = await client.send('Runtime.evaluate', {
                expression: `
                    (function extractChanges() {
                        const files = [];
                        const commands = [];

                        // استخراج أسماء الملفات من عناصر التغييرات
                        const fileSelectors = [
                            '[class*="file-change"]',
                            '[class*="file-name"]',
                            '[class*="diff-file"]',
                            '[data-type="file"]',
                            '[class*="resource-label"]'
                        ];
                        document.querySelectorAll(fileSelectors.join(', ')).forEach(el => {
                            const text = el.innerText?.trim();
                            if (text && text.length > 0 && text.length < 200) {
                                files.push(text);
                            }
                        });

                        // استخراج الأوامر المنفّذة
                        const cmdSelectors = [
                            '[class*="command-step"]',
                            '[class*="terminal-command"]',
                            '[class*="step-title"]',
                            '[class*="tool-call"]',
                            'code[class*="command"]'
                        ];
                        document.querySelectorAll(cmdSelectors.join(', ')).forEach(el => {
                            const text = el.innerText?.trim();
                            if (text && text.length > 0 && text.length < 500) {
                                commands.push(text);
                            }
                        });

                        // استخراج النص الكامل من منطقة التغييرات
                        const changesArea = document.querySelector([
                            '[class*="changes-container"]',
                            '[class*="agent-actions"]',
                            '[class*="tool-calls"]',
                            '[class*="steps-container"]'
                        ].join(', '));

                        const rawText = changesArea?.innerText?.substring(0, 3000) ?? '';

                        return {
                            files: [...new Set(files)].slice(0, 20),
                            commands: [...new Set(commands)].slice(0, 20),
                            rawText,
                            expandedCount: files.length + commands.length
                        };
                    })()
                `,
                returnByValue: true,
                awaitPromise: false
            }, 10000);

            client.close();

            if (result?.result?.value) {
                return { ...result.result.value, success: true };
            }
        } catch (err) {}
    }

    return { expandedCount: 0, files: [], commands: [], rawText: '', success: false };
}
```

### الخطوة 2 — تسجيل الأوامر في `extension.ts`

```typescript
// ─── /expand — توسيع وإرسال لقطة شاشة ───
bot.command(['expand', 'show'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const port = getDebuggingPort();
    await ctx.reply(t('expandExpanding'));

    try {
        // توسيع كل الأقسام المطوية
        const expandedCount = await expandAllChanges(port);

        // انتظار قصير للتحديث البصري
        await new Promise(resolve => setTimeout(resolve, 800));

        // التقاط لقطة شاشة موسّعة
        const { buffer } = await captureAgentScreenshot(port);

        const caption = expandedCount > 0
            ? t('expandSuccess', { count: expandedCount.toString() })
            : t('expandNothingFound');

        await ctx.replyWithPhoto(
            { source: buffer },
            {
                caption,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `📋 ${t('expandGetText')}`, callback_data: 'changes:get_text' },
                        { text: `🔄 ${t('expandRefresh')}`, callback_data: 'changes:refresh' }
                    ]]
                }
            }
        );
    } catch (e: any) {
        await ctx.reply(t('error', { msg: e.message }));
    }
});

// ─── /changes — استخراج نص التغييرات ───
bot.command(['changes', 'diff', 'steps'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const port = getDebuggingPort();
    await ctx.reply(t('changesExtracting'));

    try {
        // توسيع أولاً ثم استخراج
        await expandAllChanges(port);
        await new Promise(resolve => setTimeout(resolve, 400));
        const snapshot = await extractCurrentChanges(port);

        if (!snapshot.success || snapshot.expandedCount === 0) {
            await ctx.reply(t('changesNotFound'));
            return;
        }

        let msg = `📋 *${t('changesTitle')}*\n`;
        msg += '━'.repeat(28) + '\n\n';

        if (snapshot.files.length > 0) {
            msg += `📝 *${t('changesFiles')}* (${snapshot.files.length}):\n`;
            snapshot.files.forEach(f => { msg += `  • \`${f}\`\n`; });
            msg += '\n';
        }

        if (snapshot.commands.length > 0) {
            msg += `⚡ *${t('changesCommands')}* (${snapshot.commands.length}):\n`;
            snapshot.commands.forEach(c => {
                msg += `  › \`${c.substring(0, 100)}\`\n`;
            });
            msg += '\n';
        }

        if (snapshot.rawText && snapshot.files.length === 0 && snapshot.commands.length === 0) {
            msg += `📄 *${t('changesRaw')}:*\n\`\`\`\n${snapshot.rawText.substring(0, 2000)}\n\`\`\``;
        }

        // تقسيم الرسالة إذا طالت
        if (msg.length > 4000) {
            const chunks = msg.match(/.{1,3900}/gs) ?? [msg];
            for (const chunk of chunks) {
                await ctx.reply(chunk, { parse_mode: 'Markdown' });
            }
        } else {
            await ctx.reply(msg, { parse_mode: 'Markdown' });
        }
    } catch (e: any) {
        await ctx.reply(t('error', { msg: e.message }));
    }
});

// ─── Actions للأزرار ───
bot.action('changes:get_text', async (ctx) => {
    await ctx.answerCbQuery(t('changesExtracting'));
    const port = getDebuggingPort();
    const snapshot = await extractCurrentChanges(port);
    // ... نفس منطق /changes
});

bot.action('changes:refresh', async (ctx) => {
    await ctx.answerCbQuery(t('expandExpanding'));
    // إعادة تنفيذ expand + screenshot
});
```

### الخطوة 3 — Auto-Expand اختياري في `auto_accept.ts`

```typescript
// إضافة في loadSettings():
this.autoExpandChanges = config.get<boolean>('autoExpandChanges') ?? false;

// في دورة الـ polling الحالية، بعد الضغط التلقائي:
if (this.autoExpandChanges) {
    await expandAllChanges(this.port);
}
```

**إعداد جديد في `package.json`:**
```json
"antigravityTelegramControl.autoExpandChanges": {
    "type": "boolean",
    "default": false,
    "description": "Automatically expand collapsed changes/steps sections during agent generation"
}
```

### الخطوة 4 — مفاتيح الترجمة

```typescript
expandExpanding: 'جاري توسيع الأقسام المطوية...',
expandSuccess: 'تم توسيع {{count}} قسم. إليك اللقطة الكاملة:',
expandNothingFound: 'لم يُعثر على أقسام مطوية — إليك الحالة الحالية:',
expandGetText: 'استخراج النص',
expandRefresh: 'تحديث',
changesExtracting: 'جاري استخراج التغييرات...',
changesTitle: 'التغييرات والأوامر الجارية',
changesFiles: 'الملفات المُعدَّلة',
changesCommands: 'الأوامر المنفّذة',
changesRaw: 'تفاصيل إضافية',
changesNotFound: 'لم يُعثر على تغييرات جارية في المحادثة.',
```

---

## ⚠️ تحديات وملاحظات مهمة

| التحدي | الحل |
|:-------|:-----|
| محددات DOM تتغير مع تحديثات Antigravity | استخدام محددات متعددة ومتسامحة + fallback |
| بعض الأقسام محمية من التعديل بـ JS | استخدام CDP Input simulation كبديل |
| التوسيع قد يُبطئ تحديث الواجهة | انتظار 800ms قبل screenshot |
| النص المستخرج قد يكون ضوضاء | تصفية النصوص الصغيرة جداً (< 3 chars) |

> [!IMPORTANT]
> هذه الميزة تعتمد اعتماداً كبيراً على بنية DOM الداخلية لـ Antigravity Agent Webview. **يجب اختبار المحددات** على الإصدار الحالي من الإضافة وتحديثها عند الحاجة.

---

## ✅ معايير القبول

- [ ] `/expand` يوسّع الأقسام المطوية ويرسل لقطة شاشة
- [ ] `/changes` يستخرج قائمة الملفات والأوامر كنص
- [ ] زر "استخراج النص" في الصورة يرسل البيانات النصية
- [ ] زر "تحديث" يعيد الالتقاط
- [ ] الميزة لا تتعطل إذا لم تجد أي أقسام مطوية
- [ ] `autoExpandChanges` اختياري ومعطّل افتراضياً

---

## 📁 الملفات المتأثرة

```
src/
├── cdp_chat.ts       ← expandAllChanges() + extractCurrentChanges()
├── extension.ts      ← /expand + /changes + actions
├── auto_accept.ts    ← إضافة auto-expand اختياري
└── i18n.ts           ← 10 مفاتيح ترجمة جديدة
package.json          ← إعداد autoExpandChanges + أوامر
```
