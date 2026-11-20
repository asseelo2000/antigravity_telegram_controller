# 📋 خطة تنفيذ ميزة — التحكم بالإضافات (Extensions Manager)

---

## 🎯 الهدف
إضافة قسم تفاعلي في تيليجرام لإدارة ومراقبة الإضافات المثبتة في Antigravity IDE، يتيح:
1. **`/extensions`** — عرض قائمة الإضافات النشطة (على الشريط الجانبي) كقائمة أزرار قابلة للتوسع
2. **النقر على إضافة** — التبديل إليها في VS Code والتقاط لقطة شاشة لمنطقتها الكاملة
3. **دعم خاص** لإضافات مثل: GitHub Actions, Source Control, Explorer, Problems, Terminal

---

## 📐 نطاق العمل

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تسجيل `/extensions` + actions |
| `src/extensions_manager.ts` | ملف جديد للتحكم بالإضافات |
| `src/cdp_chat.ts` | دوال جديدة للتقاط لقطة شاشة view محددة |
| `src/i18n.ts` | مفاتيح ترجمة |
| `package.json` | إضافة الأمر |

---

## 🔍 التحليل التقني

### آلية الوصول إلى الإضافات
**VS Code API** يوفر:
```typescript
// قائمة كل الإضافات المثبتة
vscode.extensions.all

// تفعيل إضافة بمعرفها
vscode.commands.executeCommand('workbench.view.extension.<viewId>')
vscode.commands.executeCommand('<extensionId>.focus')
```

### استهداف Views الشريط الجانبي
كل إضافة تُسجّل `views` في `activitybar`. يمكن تفعيلها عبر:
```typescript
// فتح Explorer
vscode.commands.executeCommand('workbench.view.explorer')
// فتح Source Control
vscode.commands.executeCommand('workbench.view.scm')
// فتح GitHub Actions
vscode.commands.executeCommand('workbench.view.extension.github-actions')
// فتح Problems
vscode.commands.executeCommand('workbench.actions.view.problems')
```

### التقاط لقطة شاشة لمنطقة محددة
بعد تفعيل الـ View، نستخدم CDP لالتقاط لقطة شاشة وتحديد منطقة الشريط الجانبي:
- **CDP Screenshot**: `Page.captureScreenshot` مع `clip` rect
- الشريط الجانبي في VS Code عادةً يمتد من `x=0` حتى `~380px` بعرض sidebar

### الإضافات المُعرَّفة مسبقاً (Predefined Well-Known Views)
```typescript
const KNOWN_VIEWS = {
    'explorer': { label: 'مستكشف الملفات', icon: '📁', command: 'workbench.view.explorer' },
    'scm': { label: 'Source Control', icon: '🔀', command: 'workbench.view.scm' },
    'github-actions': { label: 'GitHub Actions', icon: '⚙️', command: 'workbench.view.extension.github-actions' },
    'problems': { label: 'المشكلات', icon: '⚠️', command: 'workbench.actions.view.problems' },
    'output': { label: 'الإخراج', icon: '📋', command: 'workbench.action.output.toggleOutput' },
    'terminal': { label: 'الطرفية', icon: '🖥️', command: 'workbench.action.terminal.focus' },
    'debug': { label: 'التصحيح', icon: '🐛', command: 'workbench.view.debug' },
    'extensions-view': { label: 'الإضافات', icon: '🧩', command: 'workbench.view.extensions' },
    'search': { label: 'البحث', icon: '🔍', command: 'workbench.view.search' },
};
```

---

## 🗂️ خطة التنفيذ

### الخطوة 1 — ملف `src/extensions_manager.ts` (ملف جديد)

```typescript
import * as vscode from 'vscode';

export interface ExtensionInfo {
    id: string;
    displayName: string;
    description: string;
    version: string;
    isActive: boolean;
    viewId?: string;
    viewCommand?: string;
    icon: string;
    category: string;
}

export interface ViewDefinition {
    id: string;
    label: string;
    icon: string;
    command: string;
    category: string;
}

// إضافات مُعرَّفة بمعرفاتها المعروفة مع الأوامر المقابلة
export const PREDEFINED_VIEWS: ViewDefinition[] = [
    // VS Code المدمجة
    { id: 'explorer', label: 'مستكشف الملفات', icon: '📁', command: 'workbench.view.explorer', category: 'builtin' },
    { id: 'scm', label: 'Source Control', icon: '🔀', command: 'workbench.view.scm', category: 'builtin' },
    { id: 'debug', label: 'Debug & Run', icon: '🐛', command: 'workbench.view.debug', category: 'builtin' },
    { id: 'extensions-view', label: 'الإضافات', icon: '🧩', command: 'workbench.view.extensions', category: 'builtin' },
    { id: 'search', label: 'البحث', icon: '🔍', command: 'workbench.view.search', category: 'builtin' },
    { id: 'problems', label: 'المشكلات', icon: '⚠️', command: 'workbench.actions.view.problems', category: 'builtin' },
    { id: 'output', label: 'الإخراج (Output)', icon: '📋', command: 'workbench.action.output.toggleOutput', category: 'builtin' },
    { id: 'terminal', label: 'Terminal', icon: '🖥️', command: 'workbench.action.terminal.focus', category: 'builtin' },

    // إضافات شائعة
    { id: 'github-actions', label: 'GitHub Actions', icon: '⚙️', command: 'workbench.view.extension.github-actions', category: 'popular' },
    { id: 'gitlens', label: 'GitLens', icon: '🔭', command: 'workbench.view.extension.gitlens', category: 'popular' },
    { id: 'docker', label: 'Docker', icon: '🐋', command: 'workbench.view.extension.dockerView', category: 'popular' },
    { id: 'remote-explorer', label: 'Remote Explorer', icon: '🌐', command: 'workbench.view.extension.remote', category: 'popular' },
    { id: 'azure-devops', label: 'Azure DevOps', icon: '☁️', command: 'workbench.view.extension.azure-pipelines', category: 'popular' },
    { id: 'test-explorer', label: 'Test Explorer', icon: '🧪', command: 'workbench.view.extension.test', category: 'popular' },
    { id: 'timeline', label: 'Timeline', icon: '📅', command: 'workbench.action.showTimeline', category: 'builtin' },
];

/**
 * الحصول على قائمة الإضافات المثبتة الفعلية
 */
export function getInstalledExtensions(): ExtensionInfo[] {
    const installed = vscode.extensions.all.filter(ext =>
        !ext.id.startsWith('vscode.') &&        // استثناء الإضافات المدمجة في VS Code
        !ext.id.startsWith('ms-vscode.') &&
        ext.isActive
    );

    return installed.map(ext => {
        const pkg = ext.packageJSON;
        // البحث عن view مقابل لهذه الإضافة
        const matchedView = PREDEFINED_VIEWS.find(v =>
            v.id.includes(ext.id.split('.')[1]) ||
            ext.id.toLowerCase().includes(v.id.toLowerCase())
        );

        return {
            id: ext.id,
            displayName: pkg.displayName || pkg.name || ext.id,
            description: pkg.description?.substring(0, 80) || '',
            version: pkg.version || '—',
            isActive: ext.isActive,
            viewId: matchedView?.id,
            viewCommand: matchedView?.command,
            icon: matchedView?.icon || '🔌',
            category: 'installed'
        };
    });
}

/**
 * تفعيل View محدد عبر VS Code API
 */
export async function activateView(viewCommand: string): Promise<boolean> {
    try {
        await vscode.commands.executeCommand(viewCommand);
        // انتظار 800ms للتأكد من تحديث الواجهة
        await new Promise(resolve => setTimeout(resolve, 800));
        return true;
    } catch (e) {
        console.error('[ExtManager] Failed to activate view:', viewCommand, e);
        return false;
    }
}
```

### الخطوة 2 — تسجيل الأمر في `extension.ts`

```typescript
import { PREDEFINED_VIEWS, getInstalledExtensions, activateView, ViewDefinition } from './extensions_manager';

// ─── /extensions ───
bot.command(['extensions', 'ext', 'views', 'panels'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const installedExts = getInstalledExtensions();

    let msg = `🧩 *${t('extManagerTitle')}*\n\n`;
    msg += `📌 *${t('extManagerBuiltins')}:*\n`;
    msg += `_${t('extManagerTip')}_\n\n`;
    msg += `🔌 ${t('extManagerInstalled')}: ${installedExts.length} ${t('extManagerActiveExt')}`;

    // بناء Keyboard مُقسَّم بمجموعات
    const keyboard: any[][] = [];

    // ─── مجموعة 1: المدمجة ───
    const builtins = PREDEFINED_VIEWS.filter(v => v.category === 'builtin');
    keyboard.push([{ text: `📂 ── ${t('extGroupBuiltin')} ──`, callback_data: 'ext_header:builtin' }]);
    for (let i = 0; i < builtins.length; i += 3) {
        keyboard.push(
            builtins.slice(i, i + 3).map(v => ({
                text: `${v.icon} ${v.label}`,
                callback_data: `ext_open:${v.id}`
            }))
        );
    }

    // ─── مجموعة 2: الشائعة المثبتة ───
    const popularInstalled = PREDEFINED_VIEWS.filter(v => v.category === 'popular');
    if (popularInstalled.length > 0) {
        keyboard.push([{ text: `🌟 ── ${t('extGroupPopular')} ──`, callback_data: 'ext_header:popular' }]);
        for (let i = 0; i < popularInstalled.length; i += 2) {
            keyboard.push(
                popularInstalled.slice(i, i + 2).map(v => ({
                    text: `${v.icon} ${v.label}`,
                    callback_data: `ext_open:${v.id}`
                }))
            );
        }
    }

    // ─── مجموعة 3: مثبتة مكتشفة ───
    const topInstalled = installedExts.slice(0, 6);
    if (topInstalled.length > 0) {
        keyboard.push([{ text: `🔌 ── ${t('extGroupInstalled')} ──`, callback_data: 'ext_header:installed' }]);
        for (let i = 0; i < topInstalled.length; i += 2) {
            keyboard.push(
                topInstalled.slice(i, i + 2).map(e => ({
                    text: `${e.icon} ${e.displayName}`,
                    callback_data: `ext_open:${e.id}`
                }))
            );
        }
    }

    await ctx.reply(msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
});

// ─── Action: فتح View والتقاط لقطة ───
bot.action(/^ext_open:(.+)$/, async (ctx) => {
    if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
        await ctx.answerCbQuery(t('unauthorized'));
        return;
    }

    const viewId = ctx.match[1];
    const port = getDebuggingPort();

    // البحث عن الـ View Definition
    const viewDef = PREDEFINED_VIEWS.find(v => v.id === viewId);

    // البحث بين الإضافات المثبتة
    const installedExts = getInstalledExtensions();
    const installedExt = installedExts.find(e => e.id === viewId);

    const viewCommand = viewDef?.command ?? installedExt?.viewCommand;
    const viewLabel = viewDef?.label ?? installedExt?.displayName ?? viewId;
    const viewIcon = viewDef?.icon ?? installedExt?.icon ?? '🔌';

    await ctx.answerCbQuery(t('extActivating', { name: viewLabel }));

    // تفعيل الـ View
    if (viewCommand) {
        const success = await activateView(viewCommand);
        if (!success) {
            await ctx.reply(t('extActivateFailed', { name: viewLabel }));
            return;
        }
    }

    // انتظار تحميل الواجهة ثم التقاط لقطة
    await new Promise(resolve => setTimeout(resolve, 1200));

    try {
        // التقاط لقطة شاشة كاملة
        const { buffer } = await captureAgentScreenshot(port);

        const caption = `${viewIcon} *${viewLabel}*\n_${t('extScreenshotCaption')}_`;
        await ctx.replyWithPhoto(
            { source: buffer },
            {
                caption,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `🔄 ${t('extRefresh')}`, callback_data: `ext_open:${viewId}` },
                        { text: `🔙 ${t('extBackToList')}`, callback_data: `ext_list:main` }
                    ]]
                }
            }
        );
    } catch (screenshotErr: any) {
        // Fallback: رسالة نصية
        await ctx.reply(
            `${viewIcon} *${viewLabel}* — ${t('extActivated')}\n⚠️ ${t('extScreenshotFailed')}`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `🔄 ${t('extRefresh')}`, callback_data: `ext_open:${viewId}` }
                    ]]
                }
            }
        );
    }
});

// ─── Action: زر Header (لا يفعل شيئاً) ───
bot.action(/^ext_header:.+$/, async (ctx) => {
    await ctx.answerCbQuery();
});

// ─── Action: العودة للقائمة الرئيسية ───
bot.action(/^ext_list:main$/, async (ctx) => {
    await ctx.answerCbQuery();
    // إعادة إرسال القائمة (استدعاء منطق /extensions)
    // يمكن استخدام editMessageReplyMarkup لتحديث الأزرار
});
```

### الخطوة 3 — مفاتيح الترجمة

```typescript
extManagerTitle: 'مدير الإضافات والواجهات',
extManagerBuiltins: 'الواجهات المدمجة',
extManagerTip: 'انقر على أي واجهة لفتحها والتقاط لقطة شاشة',
extManagerInstalled: 'إضافات مثبتة ونشطة',
extManagerActiveExt: 'إضافة',
extGroupBuiltin: 'مدمجة في VS Code',
extGroupPopular: 'إضافات شائعة',
extGroupInstalled: 'إضافاتك المثبتة',
extActivating: 'جاري فتح {{name}}...',
extActivated: 'تم التفعيل',
extActivateFailed: 'فشل في تفعيل {{name}}',
extRefresh: 'تحديث اللقطة',
extBackToList: 'القائمة الرئيسية',
extScreenshotCaption: 'لقطة شاشة حية للواجهة',
extScreenshotFailed: 'لم يتمكن من التقاط الشاشة',
```

---

## 📸 مثال على التفاعل

```
🧩 مدير الإضافات والواجهات

📌 الواجهات المدمجة:
_انقر على أي واجهة لفتحها والتقاط لقطة شاشة_

🔌 إضافات مثبتة ونشطة: 12 إضافة

[📂 ── مدمجة في VS Code ──]
[📁 مستكشف] [🔀 Source Control] [🐛 Debug]
[🧩 الإضافات] [🔍 البحث] [⚠️ المشكلات]
[📋 الإخراج] [🖥️ Terminal] [📅 Timeline]
[🌟 ── إضافات شائعة ──]
[⚙️ GitHub Actions] [🔭 GitLens]
[🐋 Docker]       [🧪 Test Explorer]
[🔌 ── إضافاتك المثبتة ──]
[🔌 Prettier]     [🔌 ESLint]
[🔌 Tailwind CSS] [🔌 REST Client]
```

**عند النقر على "GitHub Actions":**
```
📸 [لقطة شاشة حية للواجهة]
⚙️ GitHub Actions
_لقطة شاشة حية للواجهة_

[🔄 تحديث اللقطة] [🔙 القائمة الرئيسية]
```

---

## ✅ معايير القبول

- [ ] `/extensions` يعرض قائمة مُقسَّمة بمجموعات واضحة
- [ ] كل زر يفتح الـ View ويلتقط لقطة شاشة
- [ ] لقطة الشاشة تعكس حالة الواجهة بعد فتحها
- [ ] زر "تحديث اللقطة" يعيد الالتقاط
- [ ] زر "القائمة الرئيسية" يعود للقائمة
- [ ] Fallback نصي إذا فشل screenshot
- [ ] الإضافات المثبتة المكتشفة تظهر تحت مجموعتها
- [ ] Headers الأقسام لا تُنفِّذ أي action عند النقر

---

## 📁 الملفات المتأثرة

```
src/
├── extensions_manager.ts    ← ملف جديد كامل
├── extension.ts             ← /extensions command + ext_open action + ext_list action
└── i18n.ts                  ← 14 مفتاح ترجمة جديد
package.json                 ← إضافة command
```
