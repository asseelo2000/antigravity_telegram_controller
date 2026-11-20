# 📋 خطة تنفيذ ميزة — Inline Keyboard للأسئلة التفاعلية المحسّنة

---

## 🎯 الهدف
تحسين جذري لتجربة الإجابة على أسئلة الوكيل (Agent Questions) عبر:
1. عرض السؤال في رسالة ثرية بأيقونات وتنسيق أوضح
2. أزرار Inline مُقسَّمة بذكاء (صف/عمود حسب عدد الخيارات)
3. إضافة زر "تجاهل / Skip" دائم
4. إضافة زر "لقطة شاشة السياق" لرؤية ما يراه الوكيل
5. دعم إرسال رد مخصص عبر `/answer <نص>` كبديل عن الأزرار

---

## 📐 نطاق العمل

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تحديث `sendQuestionToTelegram()` + معالج `/answer` |
| `src/cdp_chat.ts` | التحقق من دالة `answerAgentQuestion()` وتحسينها |
| `src/question_watcher.ts` | إضافة صورة مصغّرة للسياق عند الكشف |
| `src/i18n.ts` | مفاتيح ترجمة جديدة |

---

## 🔍 التحليل التقني

### الوضع الحالي
في `extension.ts`، توجد دالة `sendQuestionToTelegram` التي ترسل أزرار Inline بسيطة:
```typescript
// callback_data: `agent_question:opt:${idx}` أو `agent_question:skip:0`
```
تُعالج في `bot.action(/^agent_question:(opt|skip):(\d+)$/, ...)`

### المشكلات الحالية
- الأزرار غير مُصنَّفة بأيقونات
- لا يوجد سياق بصري (screenshot) قبل الإجابة
- لا يوجد حقل نصي حر للرد
- تخطيط الأزرار ثابت (عمود واحد دائماً)
- لا يوجد زر "تجديد/Refresh" للتحقق من السؤال الحالي

---

## 🗂️ خطة التنفيذ

### الخطوة 1 — إعادة تصميم دالة `sendQuestionToTelegram` في `extension.ts`

```typescript
async function sendQuestionToTelegram(
    ctx: any,
    questionData: PendingAgentQuestion,
    port: number,
    withScreenshot: boolean = true
): Promise<void> {
    const chatId = ctx.chat?.id ?? lastInteractedChatId;

    // بناء رسالة السؤال المنسقة
    let questionMsg = `❓ *${t('questionDetected')}*\n\n`;
    questionMsg += `📝 *${t('questionText')}:*\n`;
    questionMsg += `${questionData.questionText}\n\n`;

    if (questionData.options && questionData.options.length > 0) {
        questionMsg += `🔘 *${t('questionOptions')}:*\n`;
        questionData.options.forEach((opt, idx) => {
            questionMsg += `  ${idx + 1}. ${opt.text}\n`;
        });
    }

    questionMsg += `\n💡 _${t('questionTip')}_`;

    // بناء Inline Keyboard ذكي
    const keyboard = buildSmartQuestionKeyboard(questionData.options);

    // محاولة إرسال screenshot للسياق
    if (withScreenshot) {
        try {
            const { buffer } = await captureAgentScreenshot(port);
            await bot!.telegram.sendPhoto(chatId, { source: buffer }, {
                caption: questionMsg,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        } catch (screenshotErr) {
            console.warn('[QuestionWatcher] Screenshot failed, sending text-only');
        }
    }

    // Fallback: رسالة نصية بدون صورة
    await bot!.telegram.sendMessage(chatId, questionMsg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

// بناء مصفوفة أزرار ذكية
function buildSmartQuestionKeyboard(options: Array<{ text: string }>): any[][] {
    const rows: any[][] = [];

    if (!options || options.length === 0) {
        // لا توجد خيارات — فقط Skip
        rows.push([{ text: `⏭️ تجاهل`, callback_data: `agent_question:skip:0` }]);
        return rows;
    }

    // ≤ 2 خيارات: صف واحد أفقي
    if (options.length <= 2) {
        rows.push(
            options.map((opt, idx) => ({
                text: `${['✅','🔵','🟡','🔴','🟢','⚪'][idx] || '🔘'} ${opt.text}`,
                callback_data: `agent_question:opt:${idx}`
            }))
        );
    }
    // 3-4 خيارات: صفان
    else if (options.length <= 4) {
        const mid = Math.ceil(options.length / 2);
        rows.push(
            options.slice(0, mid).map((opt, idx) => ({
                text: `${idx + 1}. ${opt.text}`,
                callback_data: `agent_question:opt:${idx}`
            }))
        );
        rows.push(
            options.slice(mid).map((opt, idx) => ({
                text: `${mid + idx + 1}. ${opt.text}`,
                callback_data: `agent_question:opt:${mid + idx}`
            }))
        );
    }
    // > 4 خيارات: عمود واحد
    else {
        options.forEach((opt, idx) => {
            rows.push([{
                text: `${idx + 1}. ${opt.text}`,
                callback_data: `agent_question:opt:${idx}`
            }]);
        });
    }

    // صف التحكم الثابت
    rows.push([
        { text: `⏭️ ${t('questionSkip')}`, callback_data: `agent_question:skip:0` },
        { text: `📸 ${t('questionRefreshScreenshot')}`, callback_data: `agent_question:screenshot:0` }
    ]);

    return rows;
}
```

### الخطوة 2 — تحديث معالج `bot.action` لأسئلة الوكيل

```typescript
// المعالج الحالي - تحديث ليشمل screenshot action
bot.action(/^agent_question:(opt|skip|screenshot):(\d+)$/, async (ctx) => {
    if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
        await ctx.answerCbQuery(t('unauthorized'));
        return;
    }

    const match = ctx.match;
    const actionType = match[1]; // 'opt' | 'skip' | 'screenshot'
    const optionIdx = parseInt(match[2], 10);
    const port = getDebuggingPort();

    if (actionType === 'screenshot') {
        // إرسال لقطة شاشة جديدة
        await ctx.answerCbQuery(t('questionFetchingScreenshot'));
        try {
            const { buffer } = await captureAgentScreenshot(port);
            await ctx.replyWithPhoto({ source: buffer }, {
                caption: `📸 ${t('questionCurrentState')}`
            });
        } catch (e: any) {
            await ctx.reply(t('screenshotError', { msg: e.message }));
        }
        return;
    }

    if (actionType === 'skip') {
        await ctx.answerCbQuery(t('questionSkipped'));
        await ctx.editMessageText(`⏭️ ${t('questionSkipped')}`, { parse_mode: 'Markdown' });
        questionWatcher?.resetLastNotified();
        return;
    }

    // actionType === 'opt'
    try {
        await ctx.answerCbQuery(t('questionAnswering'));

        const questionData = await getPendingAgentQuestion(port);
        if (!questionData?.hasQuestion) {
            await ctx.editMessageText(`⚠️ ${t('questionAlreadyAnswered')}`, { parse_mode: 'Markdown' });
            return;
        }

        const result: AnswerQuestionResult = await answerAgentQuestion(port, optionIdx, lastActiveQuestionTargetId);

        if (result.success) {
            const selectedOption = questionData.options?.[optionIdx];
            const selectedText = selectedOption?.text ?? optionIdx.toString();
            await ctx.editMessageText(
                `✅ *${t('questionAnswered')}*\n📌 ${t('questionSelectedOption')}: "${selectedText}"`,
                { parse_mode: 'Markdown' }
            );
            questionWatcher?.resetLastNotified();
        } else {
            await ctx.editMessageText(
                `❌ ${t('questionAnswerFailed', { msg: result.error || 'unknown' })}`,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (e: any) {
        await ctx.answerCbQuery(t('error', { msg: e.message }));
    }
});
```

### الخطوة 3 — أمر `/answer` للرد النصي الحر

```typescript
bot.command(['answer', 'ans'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;

    const parts = ctx.message.text.split(' ');
    parts.shift();
    const answerText = parts.join(' ').trim();

    if (!answerText) {
        await ctx.reply(t('answerUsage'));
        return;
    }

    const port = getDebuggingPort();
    try {
        const questionData = await getPendingAgentQuestion(port);
        if (!questionData?.hasQuestion) {
            await ctx.reply(t('questionAlreadyAnswered'));
            return;
        }

        // إرسال النص كإجابة حرة عبر CDP (الكتابة في حقل الإجابة)
        await sendViaCDP(answerText, port);
        await ctx.reply(`✅ ${t('answerSent', { text: answerText })}`, { parse_mode: 'Markdown' });
        questionWatcher?.resetLastNotified();
    } catch (e: any) {
        await ctx.reply(t('error', { msg: e.message }));
    }
});
```

### الخطوة 4 — مفاتيح الترجمة

```typescript
questionDetected: 'الوكيل يطرح سؤالاً!',
questionText: 'السؤال',
questionOptions: 'الخيارات المتاحة',
questionTip: 'اختر خياراً من الأزرار أدناه أو اكتب /answer <ردك>',
questionSkip: 'تجاهل',
questionRefreshScreenshot: 'لقطة السياق',
questionSkipped: 'تم تجاهل السؤال',
questionAnswering: 'جاري الإجابة...',
questionFetchingScreenshot: 'جاري التقاط الشاشة...',
questionCurrentState: 'الحالة الحالية للوكيل',
questionAnswered: 'تمت الإجابة بنجاح',
questionSelectedOption: 'الخيار المحدد',
questionAnswerFailed: 'فشلت الإجابة: {{msg}}',
questionAlreadyAnswered: 'السؤال تمت إجابته أو لم يعد موجوداً.',
answerUsage: 'الاستخدام: /answer <نص إجابتك>',
answerSent: 'تم إرسال الإجابة: "{{text}}"',
```

---

## 📸 مثال على الناتج المتوقع

```
📸 [لقطة شاشة السياق]

❓ الوكيل يطرح سؤالاً!

📝 السؤال:
هل تريد مسح جميع الملفات المؤقتة؟

🔘 الخيارات المتاحة:
  1. نعم، مسح الكل
  2. لا، احتفظ بها
  3. مراجعة قبل الحذف

💡 اختر خياراً من الأزرار أدناه أو اكتب /answer <ردك>

[✅ نعم، مسح الكل] [🔵 لا، احتفظ بها]
[🟡 مراجعة قبل الحذف]
[⏭️ تجاهل]  [📸 لقطة السياق]
```

---

## ✅ معايير القبول

- [ ] السؤال يُرسَل مع لقطة شاشة للسياق (Fallback نصي إذا فشل)
- [ ] الأزرار مُرتّبة ذكياً حسب عدد الخيارات
- [ ] زر "لقطة السياق" يرسل screenshot جديد فوري
- [ ] زر "تجاهل" يُلغي المراقبة ويُحدّث الرسالة
- [ ] `/answer <نص>` يعمل كبديل نصي حر
- [ ] الرسالة الأصلية تُحدَّث (edit) عند الاختيار لتجنب الفوضى
- [ ] يعمل في حالة عدم اتصال CDP مع رسالة خطأ مناسبة

---

## 📁 الملفات المتأثرة

```
src/
├── extension.ts         ← sendQuestionToTelegram() + buildSmartQuestionKeyboard() + /answer command
├── cdp_chat.ts          ← مراجعة answerAgentQuestion()
└── i18n.ts              ← 15+ مفتاح ترجمة جديد
```
