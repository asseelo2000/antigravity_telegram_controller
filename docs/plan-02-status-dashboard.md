# 📋 خطة تنفيذ ميزة `/status` — لوحة الحالة الشاملة

---

## 🎯 الهدف
إضافة أمر `/status` يرسل في رسالة واحدة منسقة لوحة شاملة تضم:
- **حالة الوكيل (Agent)**: هل يعمل؟ ما المحادثة الحالية؟ هل هناك سؤال معلّق؟
- **حصص الحساب (Quota)**: نسب استهلاك الموديلات + رصيد الحساب
- **موارد الجهاز (System)**: CPU, RAM, وقت التشغيل (Uptime)

---

## 📐 نطاق العمل (Scope)

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تسجيل `bot.command('status', ...)` |
| `src/cdp_chat.ts` | استخدام `checkAgentCurrentStatus()` و `getLatestAgentConversationText()` |
| `src/quota_checker.ts` | استخدام `fetchQuotaInfo()` |
| `src/pc_control.ts` | استخدام `getSystemInfo()` |
| `src/i18n.ts` | إضافة مفاتيح ترجمة `status*` |
| `package.json` | إضافة الأمر |

---

## 🔍 التحليل التقني

### البيانات المطلوب جمعها

**1. حالة الوكيل — من `cdp_chat.ts`:**
```typescript
// الدوال الموجودة المُستخدمة:
checkAgentCurrentStatus(port)       // { isGenerating: boolean }
getPendingAgentQuestion(port)       // { hasQuestion, questionText, options[] }
getAgentConversationsList(port)     // قائمة المحادثات للحصول على عنوان الحالية
getLatestAgentConversationText(port) // آخر نص للمحادثة
```

**2. الحصص — من `quota_checker.ts`:**
```typescript
fetchQuotaInfo(lang)  // QuotaSnapshot { prompt_credits, flow_credits, models[], user_info }
```

**3. موارد النظام — من `pc_control.ts`:**
```typescript
getSystemInfo()  // { platform, arch, totalMemory, freeMemory, cpuModel, uptime, hostname }
```

### استراتيجية التجميع
جلب جميع البيانات بالتوازي (`Promise.allSettled`) لضمان سرعة الاستجابة حتى لو فشل أحد المصادر.

---

## 🗂️ خطة التنفيذ خطوة بخطوة

### الخطوة 1 — تسجيل الأمر في `extension.ts`

**الموقع**: بعد معالج `/check` (سطر ~748)

```typescript
bot.command(['status', 'stat', 'dashboard'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
        ctx.reply(t('unauthorized'));
        return;
    }

    const port = getDebuggingPort();
    const lang = getLanguage();
    const loadingMsg = await ctx.reply(t('statusFetching'));

    // جلب جميع البيانات بالتوازي لأقصى سرعة
    const [agentStatusResult, questionResult, quotaResult, sysResult, chatsResult] =
        await Promise.allSettled([
            checkAgentCurrentStatus(port),
            getPendingAgentQuestion(port),
            fetchQuotaInfo(lang),
            getSystemInfo(),
            getAgentConversationsList(port)
        ]);

    const agentStatus = agentStatusResult.status === 'fulfilled' ? agentStatusResult.value : null;
    const questionData = questionResult.status === 'fulfilled' ? questionResult.value : null;
    const quota = quotaResult.status === 'fulfilled' ? quotaResult.value : null;
    const sysInfo = sysResult.status === 'fulfilled' ? sysResult.value : null;
    const chats = chatsResult.status === 'fulfilled' ? chatsResult.value : null;

    // ===== بناء رسالة الحالة =====
    let msg = `🌌 *${t('statusTitle')}*\n`;
    msg += `🕐 ${new Date().toLocaleTimeString()}\n`;
    msg += '━'.repeat(28) + '\n\n';

    // ─── قسم الوكيل ───
    msg += `🤖 *${t('statusSectionAgent')}*\n`;
    if (agentStatus) {
        const icon = agentStatus.isGenerating ? '⚡' : '✅';
        const stateLabel = agentStatus.isGenerating
            ? t('statusAgentGenerating')
            : t('statusAgentIdle');
        msg += `  ${icon} ${t('statusAgentState')}: ${stateLabel}\n`;
    } else {
        msg += `  ⚠️ ${t('statusAgentUnavailable')}\n`;
    }

    if (questionData?.hasQuestion) {
        msg += `  ❓ ${t('statusPendingQuestion')}: "${questionData.questionText?.substring(0, 60)}..."\n`;
    }

    if (chats) {
        const current = chats.find((c: any) => c.isCurrent);
        if (current) {
            msg += `  💬 ${t('statusCurrentChat')}: ${current.title?.substring(0, 40) || '#' + current.index}\n`;
        }
        msg += `  📚 ${t('statusTotalChats')}: ${chats.length}\n`;
    }
    msg += '\n';

    // ─── قسم الحصة ───
    msg += `📊 *${t('statusSectionQuota')}*\n`;
    if (quota) {
        if (quota.user_info) {
            msg += `  👤 ${quota.user_info.email || quota.user_info.name || t('statusUnknownUser')}\n`;
            msg += `  🏷️ ${quota.user_info.planName || quota.user_info.tier || t('statusUnknownPlan')}\n`;
        }
        if (quota.prompt_credits) {
            const pct = quota.prompt_credits.remaining_percentage;
            const bar = buildProgressBar(pct);
            msg += `  💬 ${t('statusPromptCredits')}: ${bar} ${pct.toFixed(0)}%\n`;
        }
        if (quota.flow_credits) {
            const pct = quota.flow_credits.remaining_percentage;
            const bar = buildProgressBar(pct);
            msg += `  🔄 ${t('statusFlowCredits')}: ${bar} ${pct.toFixed(0)}%\n`;
        }
        // أكثر 3 موديلات استهلاكاً
        const topModels = quota.models?.slice(0, 3) || [];
        topModels.forEach(m => {
            const pct = (m.remaining_fraction ?? 0) * 100;
            const bar = buildProgressBar(pct, 8);
            msg += `  🧠 ${m.label}: ${bar} ${pct.toFixed(0)}%\n`;
        });
    } else {
        msg += `  ⚠️ ${t('statusQuotaUnavailable')}\n`;
    }
    msg += '\n';

    // ─── قسم النظام ───
    msg += `💻 *${t('statusSectionSystem')}*\n`;
    if (sysInfo) {
        const ramUsedPct = ((sysInfo.totalMemory - sysInfo.freeMemory) / sysInfo.totalMemory) * 100;
        const ramBar = buildProgressBar(100 - ramUsedPct);
        const uptimeHours = Math.floor(sysInfo.uptime / 3600);
        const uptimeMins = Math.floor((sysInfo.uptime % 3600) / 60);
        msg += `  🖥️ ${sysInfo.hostname} (${sysInfo.platform} ${sysInfo.arch})\n`;
        msg += `  💾 ${t('statusRAM')}: ${ramBar} ${(sysInfo.freeMemory / 1024 / 1024 / 1024).toFixed(1)}GB ${t('statusFree')}\n`;
        msg += `  ⏱️ ${t('statusUptime')}: ${uptimeHours}h ${uptimeMins}m\n`;
    } else {
        msg += `  ⚠️ ${t('statusSystemUnavailable')}\n`;
    }

    // حذف رسالة التحميل وإرسال اللوحة
    try {
        await ctx.deleteMessage(loadingMsg.message_id);
    } catch (_) {}

    await ctx.reply(msg, { parse_mode: 'Markdown' });
});
```

### الخطوة 2 — دالة مساعدة `buildProgressBar`

تُضاف كدالة محلية مساعدة في `extension.ts`:

```typescript
function buildProgressBar(percentage: number, length: number = 10): string {
    const filled = Math.round((percentage / 100) * length);
    const empty = length - filled;
    const bar = '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));

    // تلوين الشريط حسب النسبة
    if (percentage >= 60) return `[${bar}]`; // أخضر (نسبة متبقية جيدة)
    if (percentage >= 30) return `[${bar}]`; // أصفر (تنبيه)
    return `[${bar}]`; // أحمر (شحيح)
}
```

### الخطوة 3 — مفاتيح الترجمة في `i18n.ts`

```typescript
statusFetching: 'جاري تجميع لوحة الحالة...',
statusTitle: 'لوحة الحالة الشاملة',
statusSectionAgent: 'حالة الوكيل',
statusSectionQuota: 'الحصص والرصيد',
statusSectionSystem: 'موارد الجهاز',
statusAgentGenerating: 'يعمل (جارٍ التوليد)',
statusAgentIdle: 'جاهز (خامل)',
statusAgentUnavailable: 'الوكيل غير متاح',
statusPendingQuestion: 'سؤال معلّق',
statusCurrentChat: 'المحادثة الحالية',
statusTotalChats: 'إجمالي المحادثات',
statusPromptCredits: 'رصيد المطالبات',
statusFlowCredits: 'رصيد التدفق',
statusQuotaUnavailable: 'بيانات الحصة غير متاحة',
statusRAM: 'الذاكرة',
statusFree: 'متاح',
statusUptime: 'وقت التشغيل',
statusSystemUnavailable: 'بيانات النظام غير متاحة',
statusUnknownUser: 'مستخدم غير معروف',
statusUnknownPlan: 'خطة غير معروفة',
```

---

## 🔄 تدفق العمل (Flow Diagram)

```
/status
   │
   ├──► checkAgentCurrentStatus()     ─┐
   ├──► getPendingAgentQuestion()      │
   ├──► getAgentConversationsList()    ├── Promise.allSettled (parallel)
   ├──► fetchQuotaInfo()               │
   └──► getSystemInfo()               ─┘
                │
                ▼
         buildStatusMessage()
                │
                ▼
     ctx.reply(formattedMessage)
```

---

## 📸 مثال على الناتج المتوقع

```
🌌 لوحة الحالة الشاملة
🕐 09:45:32
════════════════════════════

🤖 حالة الوكيل
  ✅ الحالة: جاهز (خامل)
  💬 المحادثة الحالية: تطوير IBS Backend API
  📚 إجمالي المحادثات: 7

📊 الحصص والرصيد
  👤 user@example.com
  🏷️ Pro Plan
  💬 رصيد المطالبات: [████████░░] 78%
  🔄 رصيد التدفق:    [██████░░░░] 61%
  🧠 Gemini Pro: [█████░░░░░] 52%
  🧠 Claude 3.5: [████████░░] 80%
  🧠 GPT-4o:     [███░░░░░░░] 30%

💻 موارد الجهاز
  🖥️ DESKTOP-ABC (win32 x64)
  💾 الذاكرة: [████░░░░░░] 6.2GB متاح
  ⏱️ وقت التشغيل: 3h 27m
```

---

## ⚠️ نقاط المخاطر

| التحدي | الحل |
|:-------|:-----|
| أحد مصادر البيانات بطيء | `Promise.allSettled` يضمن إرجاع النتائج المتاحة |
| تجاوز حد 4096 حرف | تقليص نص المحادثة واقتطاع الموديلات |
| CDP غير متصل | عرض قسم الوكيل بـ ⚠️ |
| الحساب لم يسجّل دخول | Quota section تعرض ⚠️ |

---

## ✅ معايير القبول

- [ ] الأمر يعمل بـ `/status` و `/stat` و `/dashboard`
- [ ] كل الأقسام الثلاثة (وكيل + حصة + نظام) تظهر في رسالة واحدة
- [ ] البيانات تُجلب بالتوازي (< 3 ثوانٍ)
- [ ] أشرطة التقدم تعرض نسب الاستهلاك بصرياً
- [ ] كل قسم يعرض ⚠️ عند فشله بشكل مستقل دون تعطّل الأقسام الأخرى
- [ ] رسالة تحميل أولية تُحذف عند وصول البيانات

---

## 📁 الملفات المتأثرة

```
src/
├── extension.ts    ← إضافة bot.command('status') + buildProgressBar()
└── i18n.ts         ← إضافة 18 مفتاح ترجمة جديد
package.json        ← إضافة command
```
