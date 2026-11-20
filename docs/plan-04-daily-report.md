# 📋 خطة تنفيذ ميزة — التقرير اليومي التلقائي

---

## 🎯 الهدف
إضافة نظام تقرير يومي يُرسَل تلقائياً في وقت محدد (يختاره المستخدم) يتضمن:
- ملخص نشاط اليوم (عدد المحادثات، عدد الأسئلة، عدد الأوامر المنفّذة)
- استهلاك الحصة اليومي
- أطول وأقصر محادثة
- حالة النظام ختام اليوم
- توصية بالنوم (رسالة تحفيزية اختيارية)

---

## 📐 نطاق العمل

| المكوّن | التغيير المطلوب |
|:--------|:----------------|
| `src/extension.ts` | تهيئة المؤقت اليومي + جمع إحصائيات اليوم |
| `src/daily_reporter.ts` | ملف جديد مسؤول عن التقرير |
| `src/settings_view.ts` | إضافة حقول ضبط التقرير في واجهة الإعدادات |
| `src/i18n.ts` | مفاتيح ترجمة جديدة |
| `package.json` | إضافة إعدادات جديدة في `contributes.configuration` |

---

## 🔍 التحليل التقني

### آلية الجدولة
- استخدام `setInterval` و `setTimeout` لجدولة وقت محدد يومياً
- المقارنة بين الوقت الحالي ووقت الإرسال المُهيَّأ كل دقيقة
- مقاومة إعادة التشغيل (persist last report time في `globalState`)

### مصادر البيانات للتقرير
- **الحصة**: `fetchQuotaInfo()` (quota_checker.ts) — مقارنة مع snapshot مسبق
- **المحادثات**: `getAgentConversationsList()` (cdp_chat.ts)
- **النظام**: `getSystemInfo()` (pc_control.ts)
- **إحصائيات الضغطات**: `autoAcceptManager.getStats()` (auto_accept.ts)
- **سجل محلي اليومي**: يُحفظ في `globalState` ويُصفَّر كل يوم

---

## 🗂️ خطة التنفيذ

### الخطوة 1 — ملف `src/daily_reporter.ts` (ملف جديد)

```typescript
import * as vscode from 'vscode';
import { fetchQuotaInfo, QuotaSnapshot } from './quota_checker';
import { getAgentConversationsList } from './cdp_chat';
import { getSystemInfo } from './pc_control';
import { t } from './i18n';

export interface DailyStats {
    date: string;
    questionsAnswered: number;
    commandsExecuted: number;
    autoAcceptClicks: number;
    quotaSnapshotStart?: Partial<QuotaSnapshot>;
    quotaSnapshotEnd?: Partial<QuotaSnapshot>;
    chatsCountStart: number;
    chatsCountEnd: number;
}

export class DailyReporter implements vscode.Disposable {
    private checkTimer: NodeJS.Timeout | undefined;
    private lastReportDate = '';

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly sendReport: (message: string) => Promise<void>,
        private readonly getDebuggingPort: () => number,
        private readonly getLanguage: () => string
    ) {}

    public start(): void {
        this.loadLastReportDate();
        // فحص كل دقيقة
        this.checkTimer = setInterval(() => this.checkAndSendIfDue(), 60 * 1000);
        // فحص فوري عند البدء
        this.checkAndSendIfDue();
    }

    public stop(): void {
        if (this.checkTimer) {
            clearInterval(this.checkTimer);
            this.checkTimer = undefined;
        }
    }

    private loadLastReportDate(): void {
        this.lastReportDate = this.context.globalState.get<string>('dailyReportLastDate') ?? '';
    }

    private async checkAndSendIfDue(): Promise<void> {
        const config = vscode.workspace.getConfiguration('antigravityTelegramControl');
        const enabled = config.get<boolean>('dailyReportEnabled') ?? false;
        if (!enabled) return;

        const scheduledTime = config.get<string>('dailyReportTime') ?? '23:00';
        const now = new Date();
        const todayDate = now.toISOString().split('T')[0]; // YYYY-MM-DD

        // لا تُرسل مرتين في نفس اليوم
        if (this.lastReportDate === todayDate) return;

        const [scheduledHour, scheduledMinute] = scheduledTime.split(':').map(Number);
        const isTimeReached = now.getHours() === scheduledHour && now.getMinutes() >= scheduledMinute;

        if (isTimeReached) {
            await this.generateAndSendReport();
            this.lastReportDate = todayDate;
            await this.context.globalState.update('dailyReportLastDate', todayDate);
        }
    }

    private async generateAndSendReport(): Promise<void> {
        const port = this.getDebuggingPort();
        const lang = this.getLanguage();

        const [quotaResult, chatsResult, sysResult] = await Promise.allSettled([
            fetchQuotaInfo(lang),
            getAgentConversationsList(port),
            getSystemInfo()
        ]);

        const quota = quotaResult.status === 'fulfilled' ? quotaResult.value : null;
        const chats = chatsResult.status === 'fulfilled' ? chatsResult.value : null;
        const sys = sysResult.status === 'fulfilled' ? sysResult.value : null;

        // جلب الإحصائيات المحفوظة
        const stats = this.context.globalState.get<DailyStats>('dailyStats') ?? {
            date: new Date().toISOString().split('T')[0],
            questionsAnswered: 0,
            commandsExecuted: 0,
            autoAcceptClicks: 0,
            chatsCountStart: 0,
            chatsCountEnd: chats?.length ?? 0
        };

        const now = new Date();
        const dateStr = now.toLocaleDateString('ar-SA', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });

        let report = `📊 *${t('dailyReportTitle')}*\n`;
        report += `📅 ${dateStr}\n`;
        report += '━'.repeat(28) + '\n\n';

        // ─── إحصائيات النشاط ───
        report += `📈 *${t('dailyReportActivity')}*\n`;
        report += `  💬 ${t('dailyReportChats')}: ${chats?.length ?? '—'}\n`;
        report += `  ❓ ${t('dailyReportQuestions')}: ${stats.questionsAnswered}\n`;
        report += `  ⚡ ${t('dailyReportAutoClicks')}: ${stats.autoAcceptClicks}\n`;
        report += `  💻 ${t('dailyReportCommands')}: ${stats.commandsExecuted}\n\n`;

        // ─── استهلاك الحصة ───
        if (quota) {
            report += `📊 *${t('dailyReportQuota')}*\n`;
            if (quota.prompt_credits) {
                report += `  💬 ${t('dailyReportPromptUsed')}: ${quota.prompt_credits.used_percentage.toFixed(1)}%\n`;
                report += `  💬 ${t('dailyReportPromptLeft')}: ${quota.prompt_credits.remaining_percentage.toFixed(1)}%\n`;
            }
            if (quota.user_info) {
                report += `  👤 ${quota.user_info.email ?? '—'} (${quota.user_info.tier ?? '—'})\n`;
            }
            report += '\n';
        }

        // ─── حالة النظام ───
        if (sys) {
            const uptimeH = Math.floor(sys.uptime / 3600);
            const uptimeM = Math.floor((sys.uptime % 3600) / 60);
            report += `💻 *${t('dailyReportSystem')}*\n`;
            report += `  ⏱️ ${t('dailyReportUptime')}: ${uptimeH}h ${uptimeM}m\n`;
            const ramUsed = ((sys.totalMemory - sys.freeMemory) / sys.totalMemory * 100).toFixed(0);
            report += `  💾 ${t('dailyReportRAM')}: ${ramUsed}% ${t('statusUsed')}\n\n`;
        }

        // ─── الرسالة التحفيزية ───
        const motivation = this.getMotivationalMessage(stats.questionsAnswered + stats.autoAcceptClicks);
        report += `✨ ${motivation}\n`;
        report += `\n_${t('dailyReportGeneratedAt', { time: now.toLocaleTimeString() })}_`;

        await this.sendReport(report);

        // إعادة تعيين الإحصائيات اليومية
        await this.resetDailyStats();
    }

    private getMotivationalMessage(activity: number): string {
        if (activity > 100) return t('motivationHigh');
        if (activity > 50)  return t('motivationMedium');
        return t('motivationLow');
    }

    public async incrementStat(key: keyof DailyStats, amount: number = 1): Promise<void> {
        const stats = this.context.globalState.get<DailyStats>('dailyStats') ?? {
            date: new Date().toISOString().split('T')[0],
            questionsAnswered: 0, commandsExecuted: 0, autoAcceptClicks: 0,
            chatsCountStart: 0, chatsCountEnd: 0
        };
        (stats as any)[key] = ((stats as any)[key] ?? 0) + amount;
        await this.context.globalState.update('dailyStats', stats);
    }

    private async resetDailyStats(): Promise<void> {
        await this.context.globalState.update('dailyStats', {
            date: new Date().toISOString().split('T')[0],
            questionsAnswered: 0, commandsExecuted: 0, autoAcceptClicks: 0,
            chatsCountStart: 0, chatsCountEnd: 0
        });
    }

    public dispose(): void { this.stop(); }
}
```

### الخطوة 2 — تهيئة DailyReporter في `extension.ts`

```typescript
// إضافة في أعلى الملف
import { DailyReporter } from './daily_reporter';

let dailyReporter: DailyReporter | undefined;

// داخل دالة activate() أو startBot():
dailyReporter = new DailyReporter(
    context,
    async (message: string) => {
        const targetChatId = getAllowedChatId();
        if (targetChatId && bot) {
            await bot.telegram.sendMessage(targetChatId, message, { parse_mode: 'Markdown' });
        }
    },
    getDebuggingPort,
    getLanguage
);
dailyReporter.start();

// أمر لإرسال التقرير فوراً (للاختبار)
bot.command(['dailyreport', 'report_now'], async (ctx) => {
    if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) return;
    await ctx.reply(t('dailyReportGenerating'));
    // إعادة ضبط التاريخ ليُرسَل الآن
    await context.globalState.update('dailyReportLastDate', '');
    // انتظار الدورة التالية أو تشغيل يدوي
    await dailyReporter?.['generateAndSendReport']?.();
});
```

### الخطوة 3 — إعدادات جديدة في `package.json`

```json
"antigravityTelegramControl.dailyReportEnabled": {
    "type": "boolean",
    "default": false,
    "description": "Enable automatic daily productivity report sent to Telegram"
},
"antigravityTelegramControl.dailyReportTime": {
    "type": "string",
    "default": "23:00",
    "description": "Time to send daily report (HH:MM format, 24-hour)"
}
```

### الخطوة 4 — إضافة حقول في `settings_view.ts`

إضافة قسم جديد في واجهة HTML للإعدادات:
```html
<div class="section">
    <h3>📊 التقرير اليومي</h3>
    <label>
        <input type="checkbox" id="dailyReportEnabled" />
        تفعيل التقرير اليومي التلقائي
    </label>
    <label>وقت الإرسال (HH:MM):
        <input type="time" id="dailyReportTime" value="23:00" />
    </label>
</div>
```

### الخطوة 5 — مفاتيح الترجمة

```typescript
dailyReportTitle: 'التقرير اليومي',
dailyReportActivity: 'إحصائيات النشاط',
dailyReportChats: 'المحادثات',
dailyReportQuestions: 'الأسئلة المُجابة',
dailyReportAutoClicks: 'ضغطات الموافقة التلقائية',
dailyReportCommands: 'الأوامر المنفّذة',
dailyReportQuota: 'استهلاك الحصة',
dailyReportPromptUsed: 'مُستهلَك من المطالبات',
dailyReportPromptLeft: 'متبقٍ من المطالبات',
dailyReportSystem: 'حالة النظام',
dailyReportUptime: 'وقت التشغيل',
dailyReportRAM: 'الذاكرة',
dailyReportGenerating: 'جاري إعداد التقرير...',
dailyReportGeneratedAt: 'تم الإنشاء الساعة {{time}}',
motivationHigh: 'يوم منتج جداً! استمر على هذا الإيقاع 🔥',
motivationMedium: 'يوم جيد! غداً أفضل 💪',
motivationLow: 'استريح جيداً، غداً يوم جديد 🌙',
```

---

## 📸 مثال على التقرير المتوقع

```
📊 التقرير اليومي
📅 الجمعة، 20 نوفمبر 2026
════════════════════════════

📈 إحصائيات النشاط
  💬 المحادثات: 7
  ❓ الأسئلة المُجابة: 12
  ⚡ ضغطات الموافقة التلقائية: 47
  💻 الأوامر المنفّذة: 23

📊 استهلاك الحصة
  💬 مُستهلَك من المطالبات: 34.2%
  💬 متبقٍ من المطالبات: 65.8%
  👤 user@example.com (Pro)

💻 حالة النظام
  ⏱️ وقت التشغيل: 8h 45m
  💾 الذاكرة: 61% مُستهلَك

✨ يوم منتج جداً! استمر على هذا الإيقاع 🔥

_تم الإنشاء الساعة 11:00:00 م_
```

---

## ✅ معايير القبول

- [ ] التقرير يُرسَل تلقائياً في الوقت المحدد مرة واحدة يومياً
- [ ] لا يُرسَل مرتين في نفس اليوم (حتى بعد إعادة تشغيل VS Code)
- [ ] `/dailyreport` يُرسِل التقرير فوراً للاختبار
- [ ] الإحصائيات (أسئلة، أوامر، ضغطات) تتراكم طوال اليوم
- [ ] الإحصائيات تُصفَّر تلقائياً بعد إرسال التقرير
- [ ] يمكن تعطيل الميزة من إعدادات الإضافة
- [ ] وقت الإرسال قابل للضبط من الإعدادات (HH:MM)

---

## 📁 الملفات المتأثرة

```
src/
├── daily_reporter.ts    ← ملف جديد كامل
├── extension.ts         ← تهيئة DailyReporter + /dailyreport command
├── settings_view.ts     ← إضافة قسم إعدادات التقرير
└── i18n.ts              ← 16 مفتاح ترجمة جديد
package.json             ← إضافة 2 إعدادات جديدة
```
