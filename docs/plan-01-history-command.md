# 📋 خطة تنفيذ ميزة `/history` — استرجاع آخر N رسائل من المحادثة الحالية

---

## 🎯 الهدف
إضافة أمر `/history [N]` إلى البوت يسترجع آخر N رسائل (افتراضياً 5) من المحادثة النشطة حالياً في Antigravity Agent، ويعرضها في رسالة مقروءة ومنسقة في تيليجرام.

---

## 📐 نطاق العمل (Scope)

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/cdp_chat.ts` | إضافة دالة `getConversationHistory(port, limit)` |
| `src/extension.ts` | تسجيل أمر `bot.command('history', ...)` |
| `src/i18n.ts` | إضافة مفاتيح ترجمة جديدة لجميع 15+ لغة |
| `package.json` | إضافة الأمر لقائمة `contributes.commands` |

---

## 🔍 التحليل التقني

### آلية استرجاع المحادثة الحالية
تعتمد الإضافة حالياً على دالة `getLatestAgentConversationText()` في `cdp_chat.ts` التي تسترجع آخر دورة محادثة واحدة فقط. المطلوب تعديلها أو إنشاء دالة جديدة تسترجع N دورات (رسائل مستخدم + ردود وكيل).

### بنية DOM المستهدفة
يتم استهداف عناصر HTML داخل `iframe` محادثة Antigravity عبر CDP. الهيكل المتوقع:
- **رسائل المستخدم**: عناصر ذات `role="user"` أو `data-role="user"` داخل حاوية المحادثة
- **ردود الوكيل**: عناصر ذات `role="assistant"` أو `data-role="assistant"`
- **كود الاستهداف الحالي** (مرجع): الدوال `getLatestAgentConversationText` و `getAgentConversationsList`

---

## 🗂️ خطة التنفيذ خطوة بخطوة

### الخطوة 1 — إضافة دالة `getConversationHistory` في `cdp_chat.ts`

```typescript
export interface ConversationMessage {
    role: 'user' | 'assistant';
    text: string;
    timestamp?: string;
}

export async function getConversationHistory(
    port: number,
    limit: number = 5
): Promise<ConversationMessage[]> {
    // 1. جلب CDP targets وتحديد iframe المحادثة
    // 2. تشغيل JavaScript expression داخل iframe يستهدف:
    //    - عناصر رسائل المستخدم (data-role="user" أو .human-turn)
    //    - عناصر ردود الوكيل (.assistant-turn أو data-role="assistant")
    // 3. استخراج النص من كل عنصر
    // 4. ترتيبها زمنياً وإرجاع آخر `limit` رسالة
}
```

**JavaScript يُحقن في iframe:**
```javascript
(function() {
    const turns = [];

    // استهداف عناصر المحادثة بمحددات متعددة (resilient selectors)
    const messagePairs = document.querySelectorAll([
        '[data-role]',
        '.conversation-turn',
        '.human-turn, .assistant-turn',
        '[class*="message-"]'
    ].join(', '));

    messagePairs.forEach(el => {
        const role = el.getAttribute('data-role') ||
                     (el.className.includes('human') ? 'user' : 'assistant');
        const text = el.innerText?.trim();
        if (text && text.length > 0) {
            turns.push({ role, text: text.substring(0, 2000) }); // حد أقصى 2000 حرف للرسالة
        }
    });

    return turns.slice(-limit);
})()
```

### الخطوة 2 — تسجيل الأمر في `extension.ts`

**الموقع**: بعد سطر 691 (بعد معالج `/ask`)

```typescript
bot.command(['history', 'hist'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
        ctx.reply(t('unauthorized'));
        return;
    }

    const args = ctx.message.text.split(' ');
    args.shift(); // remove /history
    const limit = Math.min(Math.max(parseInt(args[0] || '5', 10) || 5, 1), 20);
    const port = getDebuggingPort();

    await ctx.reply(t('historyFetching', { count: limit.toString() }));

    try {
        const messages = await getConversationHistory(port, limit);

        if (!messages || messages.length === 0) {
            await ctx.reply(t('historyEmpty'));
            return;
        }

        // تنسيق الرسائل
        let output = t('historyHeader', { count: messages.length.toString() }) + '\n';
        output += '━'.repeat(30) + '\n\n';

        messages.forEach((msg, idx) => {
            const icon = msg.role === 'user' ? '👤' : '🤖';
            const roleLabel = msg.role === 'user' ? t('historyRoleUser') : t('historyRoleAgent');
            output += `${icon} *${roleLabel}* (#${idx + 1}):\n`;
            // اقتطاع الرسائل الطويلة
            const truncated = msg.text.length > 500
                ? msg.text.substring(0, 500) + '...'
                : msg.text;
            output += `${truncated}\n\n`;
        });

        // تقسيم الرسالة إذا تجاوزت حد تيليجرام (4096 حرف)
        const MAX_MSG_LEN = 4000;
        if (output.length <= MAX_MSG_LEN) {
            await ctx.reply(output, { parse_mode: 'Markdown' });
        } else {
            const chunks = [];
            for (let i = 0; i < output.length; i += MAX_MSG_LEN) {
                chunks.push(output.slice(i, i + MAX_MSG_LEN));
            }
            for (const chunk of chunks) {
                await ctx.reply(chunk, { parse_mode: 'Markdown' });
            }
        }
    } catch (e: any) {
        await ctx.reply(t('error', { msg: e.message }));
    }
});
```

### الخطوة 3 — إضافة مفاتيح الترجمة في `i18n.ts`

```typescript
// يُضاف لكل كائن لغة:
historyFetching: 'جاري استرجاع آخر {{count}} رسائل...',
historyEmpty: 'لا توجد رسائل في المحادثة الحالية.',
historyHeader: '📜 آخر {{count}} رسائل:',
historyRoleUser: 'المستخدم',
historyRoleAgent: 'الوكيل',
historyUsage: 'الاستخدام: /history [عدد] (مثال: /history 10)',
```

**اللغات المطلوب تحديثها** (15+ لغة موجودة في i18n.ts):
`ar`, `en`, `vi`, `zh`, `ja`, `fr`, `de`, `it`, `es`, `hi`, `tr`, `id`, `ru`, `pt`, `ko`

### الخطوة 4 — تسجيل الأمر في `package.json`

```json
{
    "command": "antigravity-telegram-control.historyCommand",
    "title": "Telegram: Fetch Conversation History"
}
```

وإضافته في `contributes.commands`:
```json
{
    "command": "antigravity-telegram-control.historyCommand",
    "title": "Telegram: Fetch Conversation History"
}
```

---

## 🔄 تدفق العمل الكامل (Flow Diagram)

```
المستخدم (تيليجرام)
       │
       │  /history 10
       ▼
extension.ts (bot.command handler)
       │
       │  getConversationHistory(port=9222, limit=10)
       ▼
cdp_chat.ts
       │
       │  httpGet("http://127.0.0.1:9222/json") → اختيار iframe المحادثة
       │  Runtime.evaluate(JS script) → استخراج الرسائل
       ▼
ConversationMessage[] ← [{ role, text }, ...]
       │
       ▼
تنسيق وتقسيم الرسالة + إرسالها إلى تيليجرام
```

---

## ⚠️ نقاط المخاطر والتحديات

| التحدي | الحل المقترح |
|:-------|:-------------|
| تغيّر محددات DOM مع تحديثات Antigravity | استخدام محددات متعددة بالتوازي (resilient selectors) + fallback |
| الرسائل الطويلة تتجاوز حد تيليجرام 4096 حرف | تقسيم الرسائل (chunking) تلقائياً |
| قد لا تحتوي iframe على `timestamp` | عرض الترتيب بالأرقام كبديل عن الوقت |
| قد تحتوي الرسائل على كود أو Markdown يكسر التنسيق | Escape characters قبل الإرسال |
| حد N كبير جداً يبطئ الاستجابة | تقييد N بين 1 و 20 رسالة |

---

## ✅ معايير القبول (Acceptance Criteria)

- [ ] `/history` يعمل بدون معاملات ويرجع آخر 5 رسائل
- [ ] `/history 10` يرجع آخر 10 رسائل
- [ ] `/history 25` يُقيَّد تلقائياً إلى 20 كحد أقصى
- [ ] الرسائل الطويلة (> 4000 حرف) تُقسَّم تلقائياً
- [ ] كل رسالة معنونة بأيقونة ودور (👤 مستخدم / 🤖 وكيل)
- [ ] رسالة خطأ مناسبة عند فشل CDP أو انعدام رسائل
- [ ] جميع الترجمات (15+ لغة) مُضافة

---

## 📁 الملفات المتأثرة

```
src/
├── cdp_chat.ts          ← إضافة دالة getConversationHistory()
├── extension.ts         ← تسجيل bot.command('history')
└── i18n.ts              ← إضافة مفاتيح الترجمة
package.json             ← إضافة command في contributes
```
