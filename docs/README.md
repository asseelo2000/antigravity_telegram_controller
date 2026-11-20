# 📚 دليل خطط التنفيذ — Antigravity Telegram Control

> تم الإنشاء: 2026-11-20 | الإصدار الحالي: `1.0.14`

---

## 🗂️ فهرس خطط الميزات

| # | الملف | الميزة | الأوامر الجديدة | الملفات الجديدة | الصعوبة |
|:--|:------|:--------|:----------------|:----------------|:--------|
| 1 | [plan-01-history-command.md](./plan-01-history-command.md) | استرجاع آخر N رسائل | `/history [N]` | — | 🟢 بسيط |
| 2 | [plan-02-status-dashboard.md](./plan-02-status-dashboard.md) | لوحة الحالة الشاملة | `/status`, `/stat` | — | 🟡 متوسط |
| 3 | [plan-03-inline-keyboard-questions.md](./plan-03-inline-keyboard-questions.md) | أسئلة تفاعلية محسّنة | `/answer` | — | 🟡 متوسط |
| 4 | [plan-04-daily-report.md](./plan-04-daily-report.md) | التقرير اليومي التلقائي | `/dailyreport` | `daily_reporter.ts` | 🟡 متوسط |
| 5 | [plan-05-files-browser.md](./plan-05-files-browser.md) | استعراض ملفات المشروع | `/files [مسار]` | `file_browser.ts` | 🟡 متوسط |
| 6 | [plan-06-getfile-command.md](./plan-06-getfile-command.md) | جلب ملف معين إلى البوت | `/getfile`, `/getclipboard`, `/getlog` | — | 🟢 بسيط |
| 7 | [plan-07-extensions-manager.md](./plan-07-extensions-manager.md) | مدير الإضافات | `/extensions`, `/ext` | `extensions_manager.ts` | 🔴 معقد |
| 8 | [plan-08-live-changes-expander.md](./plan-08-live-changes-expander.md) | عرض التغييرات الآنية | `/expand`, `/changes` | — | 🔴 معقد |
| 9 | [plan-09-command-widget.md](./plan-09-command-widget.md) | لوحة الأوامر التفاعلية | `/menu`, `/search` | `command_widget.ts`, `command_definitions.ts` | 🟡 متوسط |

---

## 🗓️ ترتيب التنفيذ المقترح

### المرحلة الأولى — سريعة وعالية القيمة (1-2 أسابيع)
1. **plan-01**: `/history` — بسيط، يستخدم دوال موجودة
2. **plan-06**: `/getfile` — بسيط، يعتمد على Node.js fs
3. **plan-02**: `/status` — متوسط، يجمع بيانات موجودة

### المرحلة الثانية — تحسينات التجربة (1-2 أسابيع)
4. **plan-09**: Command Widget — يغير UX جذرياً لجميع الأوامر
5. **plan-03**: أسئلة تفاعلية محسّنة — يحسّن أكثر ميزة تفاعلية
6. **plan-05**: متصفح الملفات — يتكامل مع plan-06

### المرحلة الثالثة — ميزات متقدمة (2-3 أسابيع)
7. **plan-04**: التقرير اليومي — يحتاج نظام تتبع إحصائيات
8. **plan-07**: مدير الإضافات — يعتمد على VS Code API متقدم
9. **plan-08**: التغييرات الآنية — يعتمد على DOM discovery

---

## 📊 ملخص التأثيرات على المشروع

### الملفات الجديدة المُضافة

```
src/
├── daily_reporter.ts       (plan-04) — نظام التقرير اليومي
├── file_browser.ts         (plan-05) — مساعد الملفات
├── extensions_manager.ts   (plan-07) — مدير الإضافات
├── command_widget.ts       (plan-09) — بناء Widget الأوامر
└── command_definitions.ts  (plan-09) — تعريف جميع الأوامر
```

### الملفات المُعدَّلة في كل الخطط

```
src/extension.ts     ← تسجيل ~15 أمر + action جديد
src/cdp_chat.ts      ← 4 دوال جديدة (history, expand, changes, extractChanges)
src/auto_accept.ts   ← خيار auto-expand
src/i18n.ts          ← ~100 مفتاح ترجمة جديد (15+ لغة)
src/settings_view.ts ← قسم التقرير اليومي
package.json         ← ~15 أمر + إعدادات جديدة
```

---

## 🔧 متطلبات مشتركة بين الخطط

- جميع الخطط تعتمد على **CDP (Chrome DevTools Protocol)** عبر port `9222`
- جميع الخطط تضيف **مفاتيح i18n** بـ 15+ لغة
- جميع الخطط تُسجَّل في `contributes.commands` في `package.json`
- المحددات CSS/DOM حساسة لتحديثات Antigravity وتحتاج اختباراً دورياً

---

## ⚠️ ملاحظات مهمة قبل البدء

> [!IMPORTANT]
> **plan-07 و plan-08** يعتمدان على بنية DOM داخلية لـ Antigravity وقد تحتاج المحددات للتحديث مع كل إصدار جديد من الإضافة.

> [!TIP]
> ابدأ بـ **plan-09 (Command Widget)** بعد الميزات البسيطة مباشرة — فهو يُحسّن تجربة جميع الأوامر ويجعل الميزات الجديدة أكثر قابلية للاكتشاف.

> [!NOTE]
> **plan-04 (التقرير اليومي)** يحتاج دالة `incrementStat()` تُستدعى من باقي الأوامر لتتبع الإحصائيات — خطط لربطها مع باقي الميزات عند تنفيذها.
