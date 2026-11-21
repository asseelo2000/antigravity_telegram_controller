// src/command_widget.ts
// Interactive visual widget keyboard builder for Antigravity Telegram Control

import { ALL_COMMANDS, BotCommand, CommandGroup, GROUP_META } from './command_definitions';
import { t } from './i18n';

/**
 * Builds a visual ASCII/Unicode progress bar string for percentages.
 */
export function buildProgressBar(percentage: number, length: number = 8): string {
    const clamped = Math.min(Math.max(percentage, 0), 100);
    const filled = Math.round((clamped / 100) * length);
    const empty = length - filled;
    return '█'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
}

/**
 * Builds the inline keyboard for the Command Widget.
 * Can render the main groups view, a specific group view, or search results.
 */
export function buildCommandWidgetKeyboard(
    activeGroup?: CommandGroup,
    searchQuery?: string,
    lang: string = 'en'
): any[][] {
    const isAr = lang === 'ar';
    const rows: any[][] = [];

    // Mode 1: Search query results
    if (searchQuery && searchQuery.trim().length > 0) {
        return buildSearchResultsKeyboard(searchQuery.trim(), isAr);
    }

    // Mode 2: Specific group view
    if (activeGroup && GROUP_META[activeGroup]) {
        return buildGroupCommandsKeyboard(activeGroup, isAr);
    }

    // Mode 3: Main dashboard / groups view
    const sortedGroups = (Object.keys(GROUP_META) as CommandGroup[])
        .sort((a, b) => GROUP_META[a].order - GROUP_META[b].order);

    // Layout groups in 2 buttons per row for ideal readability on mobile
    for (let i = 0; i < sortedGroups.length; i += 2) {
        const slice = sortedGroups.slice(i, i + 2);
        rows.push(
            slice.map(g => {
                const meta = GROUP_META[g];
                const label = isAr ? meta.labelAr : meta.label;
                return {
                    text: `${meta.icon} ${label}`,
                    callback_data: `widget_group:${g}`
                };
            })
        );
    }

    // Bottom action bar: Search button & Close button
    rows.push([
        {
            text: isAr ? '🔍 بحث عن أمر' : '🔍 Search Commands',
            callback_data: 'widget_search:prompt'
        }
    ]);

    return rows;
}

/**
 * Builds the command list keyboard for a specific group.
 */
function buildGroupCommandsKeyboard(group: CommandGroup, isAr: boolean): any[][] {
    const rows: any[][] = [];
    const meta = GROUP_META[group];
    const groupTitle = isAr ? meta.labelAr : meta.label;

    // Header label row (noop)
    rows.push([
        {
            text: `${meta.icon} ─── ${groupTitle} ───`,
            callback_data: 'widget_header:noop'
        }
    ]);

    const commands = ALL_COMMANDS.filter(c => c.group === group);

    // List commands in rows of 2 buttons
    for (let i = 0; i < commands.length; i += 2) {
        const slice = commands.slice(i, i + 2);
        rows.push(
            slice.map(cmd => ({
                text: `${cmd.icon} ${cmd.label}`,
                callback_data: `widget_cmd:${cmd.id}`
            }))
        );
    }

    // Navigation footer
    rows.push([
        {
            text: isAr ? '🔙 كل المجموعات' : '🔙 All Groups',
            callback_data: 'widget_home:main'
        },
        {
            text: isAr ? '🔍 بحث' : '🔍 Search',
            callback_data: 'widget_search:prompt'
        }
    ]);

    return rows;
}

/**
 * Builds the search results inline keyboard.
 */
function buildSearchResultsKeyboard(query: string, isAr: boolean): any[][] {
    const rows: any[][] = [];
    const q = query.toLowerCase();

    const matches = ALL_COMMANDS.filter(cmd =>
        cmd.id.toLowerCase().includes(q) ||
        cmd.command.toLowerCase().includes(q) ||
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q)
    ).slice(0, 10);

    // Results header
    const headerText = isAr
        ? `🔍 نتائج البحث عن "${query}" (${matches.length})`
        : `🔍 Results for "${query}" (${matches.length})`;

    rows.push([
        {
            text: headerText,
            callback_data: 'widget_header:noop'
        }
    ]);

    if (matches.length === 0) {
        rows.push([
            {
                text: isAr ? '❌ لا توجد أوامر مطابقة' : '❌ No matching commands found',
                callback_data: 'widget_header:noop'
            }
        ]);
    } else {
        for (let i = 0; i < matches.length; i += 2) {
            const slice = matches.slice(i, i + 2);
            rows.push(
                slice.map(cmd => ({
                    text: `${cmd.icon} ${cmd.label}`,
                    callback_data: `widget_cmd:${cmd.id}`
                }))
            );
        }
    }

    // Return to main menu
    rows.push([
        {
            text: isAr ? '🏠 القائمة الرئيسية' : '🏠 Main Dashboard',
            callback_data: 'widget_home:main'
        }
    ]);

    return rows;
}

/**
 * Prepares the rich message and action keyboard for a single command.
 */
export function buildCommandDetailMessage(
    cmd: BotCommand,
    lang: string = 'en'
): { text: string; keyboard: any[][] } {
    const isAr = lang === 'ar';
    const groupMeta = GROUP_META[cmd.group];
    const groupName = isAr ? groupMeta.labelAr : groupMeta.label;

    let text = `${cmd.icon} *${cmd.label}*\n`;
    text += `${isAr ? 'المجموعة:' : 'Category:'} _${groupName}_\n\n`;

    const usageExample = cmd.argHint ? `${cmd.command} ${cmd.argHint}` : cmd.command;
    text += `📌 *${isAr ? 'الأمر:' : 'Command:'}* \`${usageExample}\`\n`;
    text += `📝 *${isAr ? 'الوصف:' : 'Description:'}* ${cmd.description}\n`;

    if (cmd.isDestructive) {
        text += `\n⚠️ _${isAr ? 'تنبيه: هذا إجراء حساس، تأكد قبل التنفيذ.' : 'Caution: This is a high-sensitivity action.'}_\n`;
    }

    const execLabel = isAr
        ? `⚡ تنفيذ ${cmd.command}`
        : `⚡ Execute ${cmd.command}`;

    const keyboard: any[][] = [
        [
            {
                text: execLabel,
                callback_data: `widget_exec:${cmd.id}`
            }
        ],
        [
            {
                text: isAr ? `🔙 ${groupName}` : `🔙 ${groupName}`,
                callback_data: `widget_group:${cmd.group}`
            },
            {
                text: isAr ? '🏠 الرئيسية' : '🏠 Home',
                callback_data: 'widget_home:main'
            }
        ]
    ];

    return { text, keyboard };
}

/**
 * Builds an adaptive, clean inline keyboard for interactive agent questions.
 * - <= 2 options: 1 horizontal row
 * - 3 to 4 options: 2x2 grid
 * - > 4 options: 1 column
 * - Bottom control row: [⏭️ Skip] [📸 Context Frame]
 */
export function buildSmartQuestionKeyboard(
    options: Array<{ index: number; text: string }>,
    lang: string = 'en'
): any[][] {
    const isAr = lang === 'ar';
    const rows: any[][] = [];

    const truncate = (str: string, max: number) => {
        const clean = str.replace(/\s+/g, ' ').trim();
        return clean.length > max ? clean.substring(0, max - 3) + '...' : clean;
    };

    if (options && options.length > 0) {
        if (options.length <= 2) {
            // Single horizontal row for <= 2 options
            rows.push(
                options.map((opt, idx) => ({
                    text: `${['1️⃣', '2️⃣'][idx] || `${opt.index}️⃣`} ${truncate(opt.text, 22)}`,
                    callback_data: `agent_question:opt:${opt.index}`
                }))
            );
        } else if (options.length <= 4) {
            // 2x2 grid for 3-4 options
            for (let i = 0; i < options.length; i += 2) {
                const slice = options.slice(i, i + 2);
                rows.push(
                    slice.map(opt => ({
                        text: `${opt.index}️⃣ ${truncate(opt.text, 18)}`,
                        callback_data: `agent_question:opt:${opt.index}`
                    }))
                );
            }
        } else {
            // Single column for > 4 options (max 10 buttons)
            options.slice(0, 10).forEach(opt => {
                rows.push([{
                    text: `${opt.index}️⃣ ${truncate(opt.text, 30)}`,
                    callback_data: `agent_question:opt:${opt.index}`
                }]);
            });
        }
    }

    // Bottom control row: Skip & Context Frame
    const skipLabel = isAr ? '⏭️ تخطي' : '⏭️ Skip';
    const screenshotLabel = isAr ? '📸 لقطة السياق' : '📸 Context Frame';

    rows.push([
        { text: skipLabel, callback_data: 'agent_question:skip:0' },
        { text: screenshotLabel, callback_data: 'agent_question:screenshot:0' }
    ]);

    return rows;
}

