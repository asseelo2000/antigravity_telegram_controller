# 📋 خطة تنفيذ ميزة `/files` — استعراض ملفات المشروع المفتوح

---

## 🎯 الهدف
إضافة أمر `/files [مسار]` يسمح للمستخدم باستعراض هيكل ملفات المشروع المفتوح حالياً في VS Code عبر تيليجرام، مع تنقل تفاعلي بين المجلدات عبر أزرار Inline Keyboard.

---

## 📐 نطاق العمل

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تسجيل `bot.command('files')` + `bot.action('browse_files:...')` |
| `src/file_browser.ts` | ملف جديد لإدارة استعراض الملفات |
| `src/i18n.ts` | مفاتيح ترجمة جديدة |
| `package.json` | إضافة الأمر |

---

## 🔍 التحليل التقني

### مصدر بيانات الملفات
- **VS Code API**: `vscode.workspace.workspaceFolders` للحصول على مجلد المشروع الحالي
- **Node.js `fs` API**: `fs.readdirSync()` لقراءة محتوى المجلدات
- **المسار الجذري**: أول مجلد في `workspaceFolders[0].uri.fsPath`

### قيود الأمان
- **لا يُكشف عن الملفات خارج نطاق المشروع**
- **تقييد التنقل**: لا يمكن الصعود فوق جذر المشروع
- **قائمة سوداء للمجلدات**: `.git`, `node_modules`, `__pycache__`, `venv`, `bin`, `obj`

### بنية الاستعراض التفاعلي
```
callback_data: `browse_files:<base64_encoded_path>`
```
استخدام Base64 لتشفير المسار لتجنب مشكلات الأحرف الخاصة في callback_data.

---

## 🗂️ خطة التنفيذ

### الخطوة 1 — ملف `src/file_browser.ts` (ملف جديد)

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface FileEntry {
    name: string;
    fullPath: string;
    isDirectory: boolean;
    size?: number;
    extension?: string;
}

// المجلدات والملفات المستثناة من العرض
const IGNORED_NAMES = new Set([
    'node_modules', '.git', '.svn', '__pycache__', 'venv', '.venv',
    'env', '.env', 'build', 'dist', 'out', 'bin', 'obj', '.gradle',
    'target', '.dart_tool', 'Pods', '.idea', '.vs', '.cache'
]);

// أيقونات حسب نوع الملف
const FILE_ICONS: Record<string, string> = {
    '.ts': '🔷', '.tsx': '⚛️', '.js': '🟨', '.jsx': '⚛️',
    '.json': '📋', '.md': '📝', '.html': '🌐', '.css': '🎨',
    '.scss': '🎨', '.py': '🐍', '.cs': '💜', '.rs': '🦀',
    '.go': '🐹', '.java': '☕', '.php': '🐘', '.rb': '💎',
    '.sh': '🖥️', '.yaml': '⚙️', '.yml': '⚙️', '.env': '🔑',
    '.sql': '🗄️', '.xml': '📄', '.svg': '🖼️', '.png': '🖼️',
    '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.zip': '🗜️',
    '.pdf': '📕', '.txt': '📃', '.gitignore': '🚫', '.lock': '🔒'
};

export function getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;
    return folders[0].uri.fsPath;
}

export function listDirectory(dirPath: string, workspaceRoot: string): FileEntry[] | null {
    // تحقق أمني: المسار يجب أن يكون داخل المشروع
    const resolvedPath = path.resolve(dirPath);
    const resolvedRoot = path.resolve(workspaceRoot);
    if (!resolvedPath.startsWith(resolvedRoot)) return null;

    try {
        const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
        const result: FileEntry[] = [];

        entries.forEach(entry => {
            if (IGNORED_NAMES.has(entry.name)) return;
            if (entry.name.startsWith('.') && entry.isDirectory()) return;

            const fullPath = path.join(resolvedPath, entry.name);
            const isDirectory = entry.isDirectory();
            let size: number | undefined;

            if (!isDirectory) {
                try {
                    size = fs.statSync(fullPath).size;
                } catch (_) {}
            }

            result.push({
                name: entry.name,
                fullPath,
                isDirectory,
                size,
                extension: isDirectory ? undefined : path.extname(entry.name).toLowerCase()
            });
        });

        // ترتيب: مجلدات أولاً، ثم ملفات ألفبائياً
        result.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });

        return result;
    } catch (_) {
        return null;
    }
}

export function getFileIcon(entry: FileEntry): string {
    if (entry.isDirectory) return '📁';
    return FILE_ICONS[entry.extension ?? ''] ?? '📄';
}

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function encodePath(p: string): string {
    return Buffer.from(p).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function decodePath(encoded: string): string {
    const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4;
    return Buffer.from(padded + '='.repeat(pad ? 4 - pad : 0), 'base64').toString('utf8');
}
```

### الخطوة 2 — تسجيل الأمر والاستجابات في `extension.ts`

```typescript
import {
    getWorkspaceRoot, listDirectory, getFileIcon,
    formatFileSize, encodePath, decodePath, FileEntry
} from './file_browser';

// ─── الأمر /files ───
bot.command(['files', 'file', 'ls', 'dir'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
        await ctx.reply(t('filesNoWorkspace'));
        return;
    }

    // استخراج مسار اختياري من المعاملات
    const args = ctx.message.text.split(' ');
    args.shift();
    const subPath = args.join(' ').trim();
    const targetPath = subPath
        ? path.join(workspaceRoot, subPath)
        : workspaceRoot;

    await sendFileListing(ctx, targetPath, workspaceRoot, false);
});

// ─── Action للتنقل بين المجلدات ───
bot.action(/^browse_files:(.+)$/, async (ctx) => {
    if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
        await ctx.answerCbQuery(t('unauthorized'));
        return;
    }

    const encoded = ctx.match[1];
    const targetPath = decodePath(encoded);
    const workspaceRoot = getWorkspaceRoot();

    if (!workspaceRoot) {
        await ctx.answerCbQuery(t('filesNoWorkspace'));
        return;
    }

    await ctx.answerCbQuery();
    await sendFileListing(ctx, targetPath, workspaceRoot, true);
});

// ─── Action لتحميل ملف معين ───
bot.action(/^download_file:(.+)$/, async (ctx) => {
    if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
        await ctx.answerCbQuery(t('unauthorized'));
        return;
    }

    const encoded = ctx.match[1];
    const filePath = decodePath(encoded);
    const workspaceRoot = getWorkspaceRoot();

    if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) {
        await ctx.answerCbQuery(t('filesAccessDenied'));
        return;
    }

    await ctx.answerCbQuery(t('filesSendingFile'));

    try {
        const stats = fs.statSync(filePath);
        const MAX_SIZE = 50 * 1024 * 1024; // 50MB حد تيليجرام

        if (stats.size > MAX_SIZE) {
            await ctx.reply(t('filesTooLarge', { size: formatFileSize(stats.size) }));
            return;
        }

        await ctx.replyWithDocument({ source: filePath, filename: path.basename(filePath) });
    } catch (e: any) {
        await ctx.reply(t('filesReadError', { msg: e.message }));
    }
});

// ─── Helper: إرسال قائمة ملفات ───
async function sendFileListing(
    ctx: any,
    targetPath: string,
    workspaceRoot: string,
    editMessage: boolean
): Promise<void> {
    const entries = listDirectory(targetPath, workspaceRoot);

    if (entries === null) {
        const errorMsg = t('filesAccessDenied');
        if (editMessage) await ctx.editMessageText(errorMsg);
        else await ctx.reply(errorMsg);
        return;
    }

    // بناء نص الرسالة
    const relPath = path.relative(workspaceRoot, targetPath) || '.';
    let msg = `📂 *${t('filesListing')}:* \`${relPath}\`\n`;
    msg += `📊 ${entries.length} ${t('filesItems')}\n`;
    msg += '━'.repeat(24) + '\n\n';

    const MAX_ITEMS_IN_MSG = 20;
    const displayEntries = entries.slice(0, MAX_ITEMS_IN_MSG);

    displayEntries.forEach(entry => {
        const icon = getFileIcon(entry);
        const sizeStr = !entry.isDirectory && entry.size !== undefined
            ? ` _(${formatFileSize(entry.size)})_`
            : '';
        msg += `${icon} \`${entry.name}\`${sizeStr}\n`;
    });

    if (entries.length > MAX_ITEMS_IN_MSG) {
        msg += `\n_...و ${entries.length - MAX_ITEMS_IN_MSG} عنصر آخر_`;
    }

    // بناء Inline Keyboard للتنقل
    const keyboard = buildFileBrowserKeyboard(entries, targetPath, workspaceRoot);

    if (editMessage) {
        await ctx.editMessageText(msg, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    } else {
        await ctx.reply(msg, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }
}

function buildFileBrowserKeyboard(
    entries: FileEntry[],
    currentPath: string,
    workspaceRoot: string
): any[][] {
    const rows: any[][] = [];

    // أزرار المجلدات (صفان من 2)
    const dirs = entries.filter(e => e.isDirectory).slice(0, 8);
    for (let i = 0; i < dirs.length; i += 2) {
        const row = dirs.slice(i, i + 2).map(dir => ({
            text: `📁 ${dir.name}`,
            callback_data: `browse_files:${encodePath(dir.fullPath)}`
        }));
        rows.push(row);
    }

    // أزرار الملفات (للتحميل، صفان من 2)
    const files = entries.filter(e => !e.isDirectory).slice(0, 6);
    for (let i = 0; i < files.length; i += 2) {
        const row = files.slice(i, i + 2).map(file => ({
            text: `${getFileIcon(file)} ${file.name}`,
            callback_data: `download_file:${encodePath(file.fullPath)}`
        }));
        rows.push(row);
    }

    // زر الرجوع
    const navigationRow: any[] = [];
    if (currentPath !== workspaceRoot) {
        const parentPath = path.dirname(currentPath);
        navigationRow.push({
            text: `⬆️ ${t('filesGoUp')}`,
            callback_data: `browse_files:${encodePath(parentPath)}`
        });
    }
    navigationRow.push({
        text: `🏠 ${t('filesRoot')}`,
        callback_data: `browse_files:${encodePath(workspaceRoot)}`
    });
    rows.push(navigationRow);

    return rows;
}
```

### الخطوة 3 — مفاتيح الترجمة

```typescript
filesNoWorkspace: 'لا يوجد مشروع مفتوح في المحرر.',
filesListing: 'محتوى المجلد',
filesItems: 'عنصر',
filesGoUp: 'مجلد أعلى',
filesRoot: 'الجذر',
filesAccessDenied: 'وصول مرفوض — المسار خارج نطاق المشروع.',
filesSendingFile: 'جاري إرسال الملف...',
filesTooLarge: 'الملف كبير جداً ({{size}}) — الحد الأقصى 50MB.',
filesReadError: 'خطأ في قراءة الملف: {{msg}}',
```

---

## 📸 مثال على التفاعل

```
📂 محتوى المجلد: .
📊 12 عنصر
════════════════════════

📁 src
📁 docs
📁 resources
📁 out
📄 package.json (11.7KB)
📋 README.md (10.6KB)
🔑 .gitignore (55B)
⚙️ tsconfig.json (469B)

[📁 src]      [📁 docs]
[📁 resources][📁 out]
[📄 package.json][📋 README.md]
[🔑 .gitignore][⚙️ tsconfig.json]
[🏠 الجذر]
```

---

## ✅ معايير القبول

- [ ] `/files` يعرض محتوى مجلد المشروع الجذري
- [ ] `/files src` يعرض محتوى مجلد src مباشرة
- [ ] النقر على مجلد يفتحه (edit message)
- [ ] النقر على ملف يرسله كـ Document
- [ ] زر "مجلد أعلى" لا يتجاوز جذر المشروع
- [ ] الحماية الأمنية تمنع الوصول خارج نطاق المشروع
- [ ] الملفات الكبيرة (> 50MB) تعرض رسالة خطأ مناسبة
- [ ] المجلدات المستثناة (node_modules, .git) مخفية

---

## 📁 الملفات المتأثرة

```
src/
├── file_browser.ts    ← ملف جديد كامل
├── extension.ts       ← /files command + browse_files action + download_file action
└── i18n.ts            ← 9 مفاتيح ترجمة
package.json           ← إضافة command
```
