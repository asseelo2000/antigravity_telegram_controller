# 📋 خطة تنفيذ ميزة — جلب ملف معين إلى البوت

---

## 🎯 الهدف
إتاحة إرسال أي ملف من المشروع أو من الجهاز إلى تيليجرام بطرق متعددة:
1. **`/getfile <مسار>`** — جلب ملف بمساره الكامل أو النسبي
2. **تكامل مع `/files`** — النقر على أي ملف في متصفح الملفات يرسله فوراً
3. **`/getclipboard`** — إرسال ما في الحافظة (نص أو صورة)
4. **`/getlog`** — إرسال سجل الأخطاء الأخيرة (Extension Host Log)

---

## 📐 نطاق العمل

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تسجيل `/getfile`, `/getclipboard`, `/getlog` |
| `src/file_browser.ts` | استخدام `download_file` action الموجود من plan-05 |
| `src/i18n.ts` | مفاتيح ترجمة |
| `package.json` | إضافة الأوامر |

> **ملاحظة**: هذه الميزة تتكامل مع `plan-05-files-browser.md` حيث `download_file action` مُعرَّف بالفعل هناك. هذه الخطة تُضيف `/getfile` كأمر مباشر مستقل.

---

## 🔍 التحليل التقني

### طرق الإرسال المتاحة في تيليجرام
```typescript
// 1. إرسال document
ctx.replyWithDocument({ source: filePath, filename: fileName })
// 2. إرسال صورة
ctx.replyWithPhoto({ source: imageBuffer })
// 3. إرسال نص (للملفات الصغيرة < 4096 حرف)
ctx.reply(`\`\`\`\n${fileContent}\n\`\`\``, { parse_mode: 'Markdown' })
```

### استراتيجية اختيار طريقة الإرسال
```
حجم الملف > 50MB    → رفض مع رسالة خطأ
الملف صورة (jpg/png/gif/webp)  → sendPhoto
الملف نص صغير (< 3KB + قابل للقراءة) → sendAsText مع syntax highlighting
غير ذلك              → sendDocument
```

### حل مشكلة المسارات المعقدة
- دعم المسارات النسبية (من جذر المشروع)
- دعم المسارات المطلقة
- دعم أسماء الملفات فقط مع بحث في المشروع
- دعم glob patterns بسيطة (`*.ts`, `src/**/*.json`)

---

## 🗂️ خطة التنفيذ

### الخطوة 1 — تسجيل أوامر الجلب في `extension.ts`

```typescript
// ─── /getfile ───
bot.command(['getfile', 'get', 'send'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const args = ctx.message.text.split(' ');
    args.shift();
    const filePath = args.join(' ').trim();

    if (!filePath) {
        await ctx.reply(t('getfileUsage'));
        return;
    }

    await sendFileToChat(ctx, filePath);
});

// ─── الدالة المساعدة المركزية ───
async function sendFileToChat(ctx: any, rawPath: string): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    let resolvedPath: string;

    // 1. محاولة المسار المطلق
    if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
        resolvedPath = rawPath;
    }
    // 2. محاولة المسار النسبي من جذر المشروع
    else if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, rawPath))) {
        resolvedPath = path.join(workspaceRoot, rawPath);
    }
    // 3. بحث بالاسم فقط في المشروع
    else if (workspaceRoot) {
        const found = await findFileInWorkspace(rawPath, workspaceRoot);
        if (!found) {
            await ctx.reply(t('getfileNotFound', { path: rawPath }));
            return;
        }
        resolvedPath = found;
    } else {
        await ctx.reply(t('filesNoWorkspace'));
        return;
    }

    // تحقق أمني: لا يخرج عن نطاق معقول
    // (نسمح بالملفات خارج المشروع إذا كان المسار مطلقاً صريحاً)
    try {
        const stats = fs.statSync(resolvedPath);

        if (stats.isDirectory()) {
            await ctx.reply(t('getfileIsDirectory', { path: rawPath }));
            return;
        }

        const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
        if (stats.size > MAX_FILE_SIZE) {
            await ctx.reply(t('filesTooLarge', { size: formatFileSize(stats.size) }));
            return;
        }

        const fileName = path.basename(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();

        await ctx.reply(t('getfileSending', { name: fileName }));

        // اختيار طريقة الإرسال
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
        const textExts = ['.txt', '.md', '.ts', '.js', '.py', '.json', '.yaml',
                          '.yml', '.cs', '.go', '.rs', '.rb', '.sh', '.env',
                          '.gitignore', '.html', '.css', '.xml', '.sql'];

        if (imageExts.includes(ext)) {
            // إرسال كصورة
            await ctx.replyWithPhoto(
                { source: resolvedPath },
                { caption: `📸 \`${fileName}\`` }
            );
        } else if (textExts.includes(ext) && stats.size < 3 * 1024) {
            // إرسال كنص مع syntax highlighting
            const content = fs.readFileSync(resolvedPath, 'utf8');
            const langHint = ext.replace('.', '') || 'text';
            const formatted = `📄 \`${fileName}\`\n\`\`\`${langHint}\n${content.substring(0, 3500)}\n\`\`\``;
            await ctx.reply(formatted, { parse_mode: 'Markdown' });
        } else {
            // إرسال كملف Document
            await ctx.replyWithDocument(
                { source: resolvedPath, filename: fileName },
                { caption: `📎 \`${fileName}\` — ${formatFileSize(stats.size)}` }
            );
        }

    } catch (e: any) {
        await ctx.reply(t('filesReadError', { msg: e.message }));
    }
}

// ─── البحث عن ملف بالاسم في المشروع ───
async function findFileInWorkspace(
    fileName: string,
    root: string,
    maxDepth: number = 6
): Promise<string | null> {
    // استخدام vscode API أولاً (أسرع)
    try {
        const results = await vscode.workspace.findFiles(
            `**/${fileName}`,
            '**/node_modules/**',
            1
        );
        if (results.length > 0) return results[0].fsPath;
    } catch (_) {}
    return null;
}

// ─── /getclipboard ───
bot.command(['getclipboard', 'clipboard', 'clip'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    try {
        const clipText = await vscode.env.clipboard.readText();
        if (!clipText || clipText.trim().length === 0) {
            await ctx.reply(t('clipboardEmpty'));
            return;
        }
        const truncated = clipText.substring(0, 4000);
        await ctx.reply(`📋 *${t('clipboardContent')}:*\n\`\`\`\n${truncated}\n\`\`\``, {
            parse_mode: 'Markdown'
        });
    } catch (e: any) {
        await ctx.reply(t('clipboardError', { msg: e.message }));
    }
});

// ─── /getlog — سجل الأخطاء الأخيرة ───
bot.command(['getlog', 'log', 'errors'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    try {
        // مسار سجل Extension Host في VS Code
        const logDir = path.join(
            process.env.APPDATA || os.homedir(),
            'Antigravity IDE', 'logs'
        );

        if (!fs.existsSync(logDir)) {
            await ctx.reply(t('logDirNotFound'));
            return;
        }

        // جلب أحدث ملف سجل
        const logFiles = fs.readdirSync(logDir)
            .filter(f => f.endsWith('.log'))
            .map(f => ({ name: f, path: path.join(logDir, f), mtime: fs.statSync(path.join(logDir, f)).mtime }))
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

        if (logFiles.length === 0) {
            await ctx.reply(t('logFileNotFound'));
            return;
        }

        const latestLog = logFiles[0];
        await sendFileToChat(ctx, latestLog.path);
    } catch (e: any) {
        await ctx.reply(t('logError', { msg: e.message }));
    }
});
```

### الخطوة 2 — مفاتيح الترجمة

```typescript
getfileUsage: 'الاستخدام: /getfile <مسار الملف>\nمثال: /getfile src/extension.ts',
getfileNotFound: 'الملف غير موجود: "{{path}}"',
getfileIsDirectory: '"{{path}}" هو مجلد وليس ملفاً. استخدم /files للاستعراض.',
getfileSending: 'جاري إرسال الملف: {{name}}...',
clipboardEmpty: 'الحافظة فارغة.',
clipboardContent: 'محتوى الحافظة',
clipboardError: 'خطأ في قراءة الحافظة: {{msg}}',
logDirNotFound: 'مجلد السجلات غير موجود.',
logFileNotFound: 'لا توجد ملفات سجل.',
logError: 'خطأ في جلب السجل: {{msg}}',
```

---

## 📸 أمثلة على التفاعل

**مثال 1 — جلب ملف TypeScript صغير:**
```
/getfile src/extension.ts

📄 `extension.ts`
```typescript
import * as vscode from 'vscode';
...
```
```

**مثال 2 — جلب صورة:**
```
/getfile icon.png
📸 `icon.png`  [صورة]
```

**مثال 3 — جلب بالاسم فقط:**
```
/getfile package.json
جاري إرسال الملف: package.json...
📎 `package.json` — 11.7KB
```

**مثال 4 — محتوى الحافظة:**
```
/getclipboard
📋 محتوى الحافظة:
```
const greeting = "Hello World";
```
```

---

## ✅ معايير القبول

- [ ] `/getfile <مسار مطلق>` يرسل الملف
- [ ] `/getfile <مسار نسبي من الجذر>` يرسل الملف
- [ ] `/getfile <اسم فقط>` يبحث ويرسل أول تطابق
- [ ] الصور تُرسَل كـ Photo وليس Document
- [ ] الملفات النصية الصغيرة تُعرَض مباشرة بـ syntax highlighting
- [ ] الملفات الكبيرة (> 50MB) ترفض مع رسالة
- [ ] `/getclipboard` يرسل نص الحافظة
- [ ] `/getlog` يرسل آخر ملف سجل
- [ ] رسائل خطأ واضحة عند كل حالة فشل

---

## 📁 الملفات المتأثرة

```
src/
├── extension.ts    ← /getfile + /getclipboard + /getlog + sendFileToChat()
└── i18n.ts         ← 10 مفاتيح ترجمة جديدة
package.json        ← إضافة 3 أوامر
```
