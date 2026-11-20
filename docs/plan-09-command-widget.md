# 📋 خطة تنفيذ ميزة — Command Widget (لوحة الأوامر التفاعلية)

---

## 🎯 الهدف
استبدال تجربة كتابة `/` والتمرير للبحث عن الأوامر بـ **Widget تفاعلي غني** يظهر عند كتابة `/menu` أو `/help` أو الضغط على زر مخصص، يعرض:
- **الأوامر مُقسَّمة بمجموعات** واضحة بأيقونات ومسميات
- **بحث فوري** عن الأمر
- **أيقونات وعناوين معبّرة** لكل أمر
- **وصف مختصر** لكل أمر عند التحديد
- **تنفيذ فوري** بالضغط على الأمر

---

## 📐 نطاق العمل

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تسجيل `/menu`, `/help`, `/search` + actions |
| `src/command_widget.ts` | ملف جديد يُعرِّف بيانات الأوامر والـ Widget |
| `src/i18n.ts` | مفاتيح ترجمة |
| `package.json` | إضافة الأوامر |

---

## 🗂️ تصميم Widget الأوامر

### هيكل البيانات

```typescript
interface BotCommand {
    id: string;             // 'ask' | 'stop' | 'screenshot' | ...
    command: string;        // النص الذي يُرسَل فعلياً مثل '/ask'
    icon: string;           // إيموجي
    label: string;          // اسم قصير معبّر
    description: string;    // وصف مختصر (60 حرف)
    group: CommandGroup;    // المجموعة
    hasArgs?: boolean;      // هل يحتاج معاملات؟
    argHint?: string;       // مثال: '<سؤالك>'
    isDestructive?: boolean; // أوامر خطيرة (تلوين مختلف)
}

type CommandGroup =
    | 'ai'          // ذكاء اصطناعي
    | 'monitoring'  // مراقبة وحالة
    | 'files'       // الملفات
    | 'account'     // الحساب والحصة
    | 'system'      // النظام والجهاز
    | 'settings'    // الإعدادات والإضافات
    | 'media';      // وسائط ولقطات
```

### تعريف جميع الأوامر

```typescript
export const ALL_COMMANDS: BotCommand[] = [
    // ─── مجموعة: الذكاء الاصطناعي ───
    { id: 'ask',       command: '/ask',       icon: '💬', label: 'Ask Agent',     description: 'أرسل سؤالاً أو مهمة للوكيل', group: 'ai', hasArgs: true, argHint: '<سؤالك هنا>' },
    { id: 'stop',      command: '/stop',      icon: '🛑', label: 'Stop',          description: 'أوقف التوليد فوراً',          group: 'ai' },
    { id: 'newchat',   command: '/newchat',   icon: '➕', label: 'New Chat',      description: 'ابدأ محادثة جديدة',           group: 'ai' },
    { id: 'chats',     command: '/chats',     icon: '📚', label: 'Chats List',   description: 'استعرض المحادثات وبدّل بينها', group: 'ai' },
    { id: 'history',   command: '/history',   icon: '📜', label: 'History',       description: 'استرجع آخر N رسائل',          group: 'ai', hasArgs: true, argHint: '[عدد] (افتراضي: 5)' },
    { id: 'answer',    command: '/answer',    icon: '💡', label: 'Answer',        description: 'أجب على سؤال الوكيل نصياً',   group: 'ai', hasArgs: true, argHint: '<نص الإجابة>' },
    { id: 'expand',    command: '/expand',    icon: '🔍', label: 'Expand Changes',description: 'وسّع وشاهد التغييرات الجارية', group: 'ai' },
    { id: 'changes',   command: '/changes',   icon: '📋', label: 'Changes Text',  description: 'استخرج الملفات والأوامر نصياً', group: 'ai' },

    // ─── مجموعة: المراقبة والحالة ───
    { id: 'check',     command: '/check',     icon: '✅', label: 'Check',         description: 'تحقق من حالة الوكيل الحالية', group: 'monitoring' },
    { id: 'status',    command: '/status',    icon: '📊', label: 'Status Board',  description: 'لوحة حالة شاملة كاملة',       group: 'monitoring' },
    { id: 'alarm',     command: '/alarm',     icon: '🔔', label: 'Alarm',         description: 'راقب الوكيل وأرسل تنبيهاً',   group: 'monitoring' },
    { id: 'screenshot',command: '/screenshot',icon: '📸', label: 'Screenshot',    description: 'التقط لقطة شاشة حية',         group: 'monitoring' },
    { id: 'question',  command: '/question',  icon: '❓', label: 'Question',      description: 'تحقق من الأسئلة المعلقة',    group: 'monitoring' },

    // ─── مجموعة: الملفات ───
    { id: 'files',     command: '/files',     icon: '📁', label: 'Files',         description: 'استعرض ملفات المشروع',        group: 'files' },
    { id: 'getfile',   command: '/getfile',   icon: '⬇️', label: 'Get File',      description: 'جلب ملف معين إلى تيليجرام',  group: 'files', hasArgs: true, argHint: '<مسار الملف>' },
    { id: 'backup',    command: '/backup',    icon: '🗜️', label: 'Backup',         description: 'ضغط المشروع وتحميله',        group: 'files' },
    { id: 'recent',    command: '/recent',    icon: '🕐', label: 'Recent Folders',description: 'آخر المشاريع المفتوحة',       group: 'files' },
    { id: 'getclipboard',command:'/getclipboard',icon:'📋',label:'Clipboard',     description: 'إرسال محتوى الحافظة',         group: 'files' },

    // ─── مجموعة: الحساب والحصة ───
    { id: 'quota',     command: '/quota',     icon: '💳', label: 'Quota',         description: 'عرض رصيد الحساب والحصة',     group: 'account' },
    { id: 'accounts',  command: '/accounts',  icon: '👤', label: 'Accounts',      description: 'قائمة الحسابات المحفوظة',    group: 'account' },
    { id: 'switch',    command: '/switch',    icon: '🔄', label: 'Switch Account',description: 'تبديل الحساب النشط',         group: 'account', hasArgs: true, argHint: '<رقم أو بريد>' },
    { id: 'models',    command: '/models',    icon: '🧠', label: 'Models',        description: 'استعرض موديلات الذكاء الاصطناعي',group:'account'},
    { id: 'switchmodel',command:'/switchmodel',icon:'🔀',label:'Switch Model',    description: 'بدّل الموديل النشط',          group: 'account', hasArgs: true, argHint: '<رقم أو اسم>' },

    // ─── مجموعة: النظام والجهاز ───
    { id: 'sysinfo',   command: '/sysinfo',   icon: '💻', label: 'System Info',   description: 'معلومات الجهاز والموارد',    group: 'system' },
    { id: 'cmd',       command: '/cmd',       icon: '⌨️', label: 'Terminal',      description: 'نفّذ أمر في الطرفية',        group: 'system', hasArgs: true, argHint: '<الأمر>' },
    { id: 'shutdown',  command: '/shutdown',  icon: '⛔', label: 'Shutdown',      description: 'إيقاف تشغيل الجهاز',        group: 'system', isDestructive: true },
    { id: 'restart',   command: '/restart',   icon: '🔁', label: 'Restart',       description: 'إعادة تشغيل الجهاز',        group: 'system', isDestructive: true },
    { id: 'sleep',     command: '/sleep',     icon: '😴', label: 'Sleep',         description: 'وضع السكون',                 group: 'system' },
    { id: 'lock',      command: '/lock',      icon: '🔒', label: 'Lock Screen',   description: 'قفل الشاشة',                group: 'system' },
    { id: 'abort',     command: '/abort',     icon: '🚫', label: 'Abort Shutdown',description: 'إلغاء إيقاف التشغيل المجدول',group:'system'},

    // ─── مجموعة: الإضافات والإعدادات ───
    { id: 'extensions',command: '/extensions',icon: '🧩', label: 'Extensions',   description: 'مدير الإضافات والواجهات',    group: 'settings' },
    { id: 'report_now',command:'/dailyreport',icon: '📊', label: 'Daily Report',  description: 'إرسال التقرير اليومي الآن', group: 'settings' },
];
```

---

## 🗂️ خطة التنفيذ

### الخطوة 1 — ملف `src/command_widget.ts` (ملف جديد)

```typescript
import { BotCommand, ALL_COMMANDS, CommandGroup } from './command_definitions';

export const GROUP_META: Record<CommandGroup, { label: string; icon: string; order: number }> = {
    ai:         { label: 'الذكاء الاصطناعي',    icon: '🤖', order: 1 },
    monitoring: { label: 'المراقبة والحالة',    icon: '📡', order: 2 },
    files:      { label: 'الملفات والمشاريع',   icon: '📂', order: 3 },
    account:    { label: 'الحساب والموديلات',   icon: '💳', order: 4 },
    system:     { label: 'النظام والجهاز',      icon: '💻', order: 5 },
    settings:   { label: 'الإعدادات والإضافات', icon: '⚙️', order: 6 },
    media:      { label: 'وسائط',               icon: '🎬', order: 7 },
};

/**
 * بناء Inline Keyboard للـ Widget الكامل
 */
export function buildCommandWidgetKeyboard(
    activeGroup?: CommandGroup,
    searchQuery?: string
): any[][] {
    const rows: any[][] = [];

    if (searchQuery) {
        // وضع البحث: عرض نتائج البحث فقط
        return buildSearchResultsKeyboard(searchQuery);
    }

    if (activeGroup) {
        // وضع المجموعة: عرض أوامر مجموعة محددة
        return buildGroupCommandsKeyboard(activeGroup);
    }

    // وضع رئيسي: عرض المجموعات
    const groups = Object.entries(GROUP_META)
        .sort((a, b) => a[1].order - b[1].order);

    // صفان من 3 أزرار لأزرار المجموعات
    for (let i = 0; i < groups.length; i += 3) {
        rows.push(
            groups.slice(i, i + 3).map(([groupId, meta]) => ({
                text: `${meta.icon} ${meta.label}`,
                callback_data: `widget_group:${groupId}`
            }))
        );
    }

    // شريط البحث (يطلب من المستخدم كتابة استعلام)
    rows.push([
        { text: `🔍 بحث عن أمر`, callback_data: 'widget_search:prompt' }
    ]);

    return rows;
}

function buildGroupCommandsKeyboard(group: CommandGroup): any[][] {
    const rows: any[][] = [];
    const commands = ALL_COMMANDS.filter(c => c.group === group);
    const meta = GROUP_META[group];

    // Header يعرض اسم المجموعة
    rows.push([{ text: `${meta.icon} ${meta.label}`, callback_data: 'widget_header:noop' }]);

    // الأوامر في صفوف من 2
    for (let i = 0; i < commands.length; i += 2) {
        rows.push(
            commands.slice(i, i + 2).map(cmd => ({
                text: `${cmd.icon} ${cmd.label}`,
                callback_data: `widget_cmd:${cmd.id}`
            }))
        );
    }

    // أزرار التنقل
    rows.push([
        { text: `🔙 المجموعات`, callback_data: 'widget_home:main' },
        { text: `🔍 بحث`, callback_data: 'widget_search:prompt' }
    ]);

    return rows;
}

function buildSearchResultsKeyboard(query: string): any[][] {
    const rows: any[][] = [];
    const lowerQuery = query.toLowerCase();

    const results = ALL_COMMANDS.filter(cmd =>
        cmd.id.includes(lowerQuery) ||
        cmd.label.toLowerCase().includes(lowerQuery) ||
        cmd.command.includes(lowerQuery) ||
        cmd.description.includes(query)
    ).slice(0, 10);

    if (results.length === 0) {
        rows.push([{ text: `❌ لا نتائج لـ "${query}"`, callback_data: 'widget_home:main' }]);
    } else {
        for (let i = 0; i < results.length; i += 2) {
            rows.push(
                results.slice(i, i + 2).map(cmd => ({
                    text: `${cmd.icon} ${cmd.label}`,
                    callback_data: `widget_cmd:${cmd.id}`
                }))
            );
        }
    }

    rows.push([{ text: `🔙 الرئيسية`, callback_data: 'widget_home:main' }]);
    return rows;
}

/**
 * بناء رسالة تفاصيل أمر محدد مع زر التنفيذ
 */
export function buildCommandDetailMessage(cmd: BotCommand): {
    text: string;
    keyboard: any[][]
} {
    let text = `${cmd.icon} *${cmd.label}*\n\n`;
    text += `📌 الأمر: \`${cmd.command}`;
    if (cmd.argHint) text += ` ${cmd.argHint}`;
    text += `\`\n\n`;
    text += `📝 ${cmd.description}\n`;

    if (cmd.isDestructive) {
        text += `\n⚠️ _هذا أمر خطير — تأكد قبل التنفيذ_`;
    }

    const keyboard: any[][] = [
        [{ text: `${cmd.icon} تنفيذ ${cmd.command}`, callback_data: `widget_exec:${cmd.id}` }],
        [
            { text: `🔙 رجوع`, callback_data: `widget_group:${cmd.group}` },
            { text: `🏠 الرئيسية`, callback_data: 'widget_home:main' }
        ]
    ];

    return { text, keyboard };
}
```

### الخطوة 2 — تسجيل الأوامر والـ Actions في `extension.ts`

```typescript
import {
    buildCommandWidgetKeyboard,
    buildCommandDetailMessage,
    ALL_COMMANDS,
    CommandGroup
} from './command_widget';

// ─── /menu و /help ───
bot.command(['menu', 'help', 'start'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const keyboard = buildCommandWidgetKeyboard();
    const isStart = ctx.message.text.startsWith('/start');

    let msg = isStart
        ? `🌌 *${t('menuWelcome')}*\n\n${t('menuSubtitle')}\n\n`
        : `🎛️ *${t('menuTitle')}*\n\n`;

    msg += t('menuChooseGroup');

    await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
});

// ─── /search <query> ───
bot.command(['search', 'find'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const args = ctx.message.text.split(' ');
    args.shift();
    const query = args.join(' ').trim();

    if (!query) {
        await ctx.reply(t('searchPrompt'));
        return;
    }

    const keyboard = buildCommandWidgetKeyboard(undefined, query);
    await ctx.reply(t('searchResults', { query }), {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
});

// ─── Widget Actions ───

// العودة للصفحة الرئيسية
bot.action('widget_home:main', async (ctx) => {
    await ctx.answerCbQuery();
    const keyboard = buildCommandWidgetKeyboard();
    await ctx.editMessageText(`🎛️ *${t('menuTitle')}*\n\n${t('menuChooseGroup')}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
});

// عرض أوامر مجموعة
bot.action(/^widget_group:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const group = ctx.match[1] as CommandGroup;
    const keyboard = buildCommandWidgetKeyboard(group);
    const { label, icon } = GROUP_META[group] ?? { label: group, icon: '📌' };
    await ctx.editMessageText(`${icon} *${label}*\n\n${t('menuChooseCommand')}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
});

// عرض تفاصيل أمر
bot.action(/^widget_cmd:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const cmdId = ctx.match[1];
    const cmd = ALL_COMMANDS.find(c => c.id === cmdId);

    if (!cmd) {
        await ctx.answerCbQuery(t('menuCmdNotFound'));
        return;
    }

    const { text, keyboard } = buildCommandDetailMessage(cmd);
    await ctx.editMessageText(text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
});

// تنفيذ أمر
bot.action(/^widget_exec:(.+)$/, async (ctx) => {
    const cmdId = ctx.match[1];
    const cmd = ALL_COMMANDS.find(c => c.id === cmdId);

    if (!cmd) { await ctx.answerCbQuery(); return; }

    await ctx.answerCbQuery(t('menuExecuting', { cmd: cmd.command }));

    // إذا كان الأمر يحتاج معاملات، اطلب منه
    if (cmd.hasArgs) {
        await ctx.reply(
            t('menuProvideArgs', { cmd: cmd.command, hint: cmd.argHint || '' }),
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // تنفيذ الأمر مباشرة بمحاكاة كأن المستخدم أرسله
    // إنشاء fake ctx.message.text ثم استدعاء الـ handler
    // أو استخدام التفريخ المباشر:
    await executeBotCommandDirectly(ctx, cmd.command);
});

// طلب البحث
bot.action('widget_search:prompt', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(t('searchEnterQuery'));
    // انتظر الرسالة القادمة كـ search query (يمكن استخدام session أو flag)
});

// الـ header (بدون action)
bot.action('widget_header:noop', async (ctx) => {
    await ctx.answerCbQuery();
});
```

### الخطوة 3 — مفاتيح الترجمة

```typescript
menuWelcome: 'أهلاً! أنا بوت التحكم بـ Antigravity',
menuSubtitle: 'تحكم بالوكيل وجهازك من أي مكان.',
menuTitle: 'لوحة الأوامر التفاعلية',
menuChooseGroup: 'اختر مجموعة:',
menuChooseCommand: 'اختر أمراً:',
menuCmdNotFound: 'الأمر غير موجود.',
menuExecuting: 'جاري تنفيذ {{cmd}}...',
menuProvideArgs: 'أرسل الأمر مكتملاً:\n`{{cmd}} {{hint}}`',
searchPrompt: 'الاستخدام: /search <اسم الأمر>',
searchResults: '🔍 نتائج البحث عن "{{query}}":',
searchEnterQuery: '🔍 اكتب ما تبحث عنه (مثال: backup أو ملفات):',
```

---

## 📸 مثال على التفاعل الكامل

**الخطوة 1 — `/menu`:**
```
🎛️ لوحة الأوامر التفاعلية

اختر مجموعة:

[🤖 الذكاء الاصطناعي] [📡 المراقبة]  [📂 الملفات]
[💳 الحساب]           [💻 النظام]     [⚙️ الإعدادات]
[🔍 بحث عن أمر]
```

**الخطوة 2 — النقر على "الذكاء الاصطناعي":**
```
🤖 الذكاء الاصطناعي

اختر أمراً:

[🤖 الذكاء الاصطناعي]  ← Header (لا ينفّذ)
[💬 Ask Agent]  [🛑 Stop]
[➕ New Chat]   [📚 Chats List]
[📜 History]    [💡 Answer]
[🔍 Expand]     [📋 Changes]
[🔙 المجموعات] [🔍 بحث]
```

**الخطوة 3 — النقر على "Ask Agent":**
```
💬 Ask Agent

📌 الأمر: `/ask <سؤالك هنا>`

📝 أرسل سؤالاً أو مهمة للوكيل

[💬 تنفيذ /ask]
[🔙 رجوع]  [🏠 الرئيسية]
```

---

## ✅ معايير القبول

- [ ] `/menu` و `/help` يعرضان Widget بمجموعات
- [ ] كل مجموعة عند النقر تعرض أوامرها
- [ ] كل أمر عند النقر يعرض تفاصيله وزر تنفيذ
- [ ] الأوامر بدون معاملات تُنفَّذ فوراً
- [ ] الأوامر التي تحتاج معاملات تطلب من المستخدم
- [ ] `/search <query>` يبحث ويعرض النتائج
- [ ] زر "بحث" في Widget يطلب الاستعلام
- [ ] رسائل الـ Widget تُحدَّث (edit) لا تُرسَل جديدة (تجنب الفوضى)
- [ ] الأوامر الخطيرة (Destructive) تظهر بـ ⚠️

---

## 📁 الملفات المتأثرة

```
src/
├── command_widget.ts       ← ملف جديد (تعريف البيانات + بناء الـ Widget)
├── command_definitions.ts  ← ملف جديد (قائمة ALL_COMMANDS)
├── extension.ts            ← /menu + /search + جميع widget actions
└── i18n.ts                 ← 10 مفاتيح ترجمة جديدة
package.json                ← إضافة أوامر
```

---

## 🔮 تحسينات مستقبلية

- **Paginator**: تصفح صفحات عند كثرة الأوامر (> 10 أوامر في مجموعة)
- **Favorites**: تثبيت الأوامر الأكثر استخداماً في الصفحة الرئيسية
- **Quick Access**: اقتراح آخر 3 أوامر استُخدمت
- **Context Menu**: Widget يظهر تلقائياً عند إرسال رسالة غير معروفة
