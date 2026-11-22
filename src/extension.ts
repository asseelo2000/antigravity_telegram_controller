import * as vscode from 'vscode';
import { Telegraf, Telegram } from 'telegraf';
import screenshot from 'screenshot-desktop';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import { Jimp } from 'jimp';
import { getSettingsHtml } from './settings_view';
import { TelegramSettingsProvider } from './settings_provider';
// CDP chat helpers for communication, screenshot capture, conversation reading, and interactive question handling
import { sendViaCDP, waitForAgentResponse, checkAgentCurrentStatus, captureAgentScreenshot, stopAgent, clickRetryButton, getLatestAgentConversationText, getAgentConversationsList, startNewConversation, switchToConversation, getAvailableModels, switchModel, getPendingAgentQuestion, answerAgentQuestion, PendingAgentQuestion, AnswerQuestionResult, getConversationHistory, ConversationMessage, expandAllChanges, extractCurrentChanges, ChangesSnapshot, getWorkbenchPartBoundingRect, captureWorkbenchZone } from './cdp_chat';
import { translations, t } from './i18n';
import { BotCommand, ALL_COMMANDS, CommandGroup, GROUP_META } from './command_definitions';
import { buildCommandWidgetKeyboard, buildCommandDetailMessage, buildProgressBar, buildSmartQuestionKeyboard } from './command_widget';
import * as os from 'os';
import { fetchQuotaInfo } from './quota_checker';
import { StatusBarManager } from './status_bar';
import { AutoAcceptManager } from './auto_accept';
import { MirrorServerManager } from './mirror_server';
import { installScript, uninstallScript, clearV8CodeCache, updateProductChecksums, writeConfigJson } from './workbench_injector';
import { AccountManager } from './account_manager';
// Recent folders helper for retrieving and opening recent workspaces
import { getRecentFolders, openRecentFolder, RecentFolderItem } from './recent_folders';
// Project backup helper for archiving workspaces excluding gitignore and framework dependencies
import { createProjectBackup, BackupResult, sendDocumentDirect } from './project_backup';
// Proactive background watcher for detecting active agent questions and notifying Telegram
import { AgentQuestionWatcher } from './question_watcher';
// PC control helpers for remote shutdown, sleep, restart, lock, and system statistics
import { shutdownSystem, restartSystem, sleepSystem, lockWorkstation, abortShutdown, getSystemInfo, getSystemTelemetry, SystemTelemetry } from './pc_control';
// Local sound alert watcher for agent completion and interactive question notifications
import { AgentCompletionSoundWatcher, playNotificationSound, getAvailableSystemSounds } from './sound_alert';
// Workspace file browser and file downloader helpers
import {
    getWorkspaceRoot, listDirectory, getFileIcon,
    formatFileSize, findFileInWorkspace, buildFileBrowserKeyboard, pathRegistry, searchFilesInDirectory
} from './file_browser';
// Sidebar extensions and views manager helpers
import {
    getDiscoveredSidebarViews, activateSidebarView, buildExtensionsKeyboard, SidebarViewItem
} from './extensions_manager';

let bot: Telegraf | undefined;
let telegramAgent: https.Agent | undefined;
let lockManager: BotLockManager | undefined;
let statusBarManager: StatusBarManager | undefined;
let autoAcceptManager: AutoAcceptManager | undefined;
let mirrorServerManager: MirrorServerManager | undefined;
// Global background question watcher instance
let questionWatcher: AgentQuestionWatcher | undefined;
// Background watcher for playing local system sound when the Agent finishes or asks a question
let completionSoundWatcher: AgentCompletionSoundWatcher | undefined;
// Extension context reference for global state access
let extensionContext: vscode.ExtensionContext | undefined;
// Last active chat ID from Telegram interaction as fallback
let lastInteractedChatId: string | undefined;
// Last detected CDP target ID hosting the active question dialog
let lastActiveQuestionTargetId: string | undefined;

// In-memory state tracking for user interactions requiring interactive text input (Fix #15, #17, #21)
interface PendingInputState {
    type: 'cmd_search' | 'terminal_cmd' | 'file_search';
    cmdId?: string;
    data?: any;
}
const pendingUserInputMap = new Map<string, PendingInputState>();

class BotLockManager {
    private lockFile: string;
    constructor(context: vscode.ExtensionContext) {
        this.lockFile = path.join(context.globalStorageUri.fsPath, 'bot.lock');
    }

    public acquireLock(): boolean {
        try {
            const dir = path.dirname(this.lockFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const currentPid = process.pid;

            if (fs.existsSync(this.lockFile)) {
                const content = fs.readFileSync(this.lockFile, 'utf8').trim();
                const lockPid = parseInt(content, 10);
                if (!isNaN(lockPid)) {
                    // If current process already owns the lock, permit operation
                    if (lockPid === currentPid) {
                        return true;
                    }
                    if (this.isProcessRunning(lockPid)) {
                        // Check if lock file is older than 5 minutes to prevent stale deadlocks
                        try {
                            const stat = fs.statSync(this.lockFile);
                            if (Date.now() - stat.mtimeMs > 300000) {
                                console.warn('[Telegram] Overwriting stale lock file from PID:', lockPid);
                            } else {
                                return false;
                            }
                        } catch (_) {
                            return false;
                        }
                    }
                }
            }

            fs.writeFileSync(this.lockFile, currentPid.toString(), 'utf8');
            return true;
        } catch (e) {
            console.error('[Telegram] Failed to acquire lock:', e);
            return true; // fallback
        }
    }

    public releaseLock(): void {
        try {
            if (fs.existsSync(this.lockFile)) {
                const content = fs.readFileSync(this.lockFile, 'utf8').trim();
                const lockPid = parseInt(content, 10);
                if (lockPid === process.pid) {
                    fs.unlinkSync(this.lockFile);
                }
            }
        } catch (e) {
            console.error('[Telegram] Failed to release lock:', e);
        }
    }

    private isProcessRunning(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e: any) {
            return e.code === 'EPERM';
        }
    }
}

function getLanguage(): string {
    return vscode.workspace.getConfiguration('antigravityTelegramControl').get<string>('language') ?? 'en';
}

function escapeMarkdownText(text: string): string {
    if (!text) return '';
    return text.replace(/([_*`\[\]\\])/g, '\\$1');
}

function buildConversationsMessage(conversations: any[], isAr: boolean, activeIndex?: number): { message: string; plainMessage: string } {
    let message = `📋 *${t('chatsTitle') || (isAr ? 'قائمة المحادثات' : 'Conversations')}*\n\n`;
    let plainMessage = `📋 ${t('chatsTitle') || (isAr ? 'قائمة المحادثات' : 'Conversations')}\n\n`;

    for (const c of conversations) {
        const isCur = (activeIndex !== undefined ? c.index === activeIndex : c.isCurrent);
        const badge = isCur ? (isAr ? ' 🟢 *(الحالية / Active)*' : ' 🟢 *(Active)*') : '';
        const plainBadge = isCur ? (isAr ? ' 🟢 (الحالية / Active)' : ' 🟢 (Active)') : '';
        const safeTitle = escapeMarkdownText(c.title);
        const safeDetails = c.details ? escapeMarkdownText(c.details) : '';

        message += `${c.index}. *${safeTitle}*${badge}\n`;
        plainMessage += `${c.index}. ${c.title}${plainBadge}\n`;

        if (c.details) {
            message += `   ⏱️ ${safeDetails}\n`;
            plainMessage += `   ⏱️ ${c.details}\n`;
        }
        message += '\n';
        plainMessage += '\n';
    }

    const hint = `👉 *${t('switchChatHint') || (isAr ? 'للتبديل اكتب' : 'To switch: ')}* \`/switchchat <رقم>\``;
    const plainHint = `👉 ${t('switchChatHint') || (isAr ? 'للتبديل اكتب' : 'To switch: ')} /switchchat <رقم>`;
    message += hint;
    plainMessage += plainHint;

    return { message, plainMessage };
}

async function sendSafeReply(ctx: any, markdownText: string, plainText: string, replyMarkup: any) {
    try {
        return await ctx.reply(markdownText, {
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
        });
    } catch (err: any) {
        return await ctx.reply(plainText, {
            reply_markup: replyMarkup
        });
    }
}



const SLASH_COMMANDS = [
    // ─── 1. Core Navigation & Fast Group Access (Ordered as requested) ───
    { command: 'start', description: '🚀 Start the bot and get your Chat ID' },
    { command: 'menu', description: '🎛️ Command Center (Interactive Widget)' },
    { command: 'agent', description: '🤖 AI Agent: Chats, Ask, Questions, Expand' },
    { command: 'monitoring', description: '📡 Monitoring: Status, Screenshots, Checks, Alarms' },
    { command: 'projects', description: '📂 Files & Projects: Files, Logs, Backups, Views' },
    { command: 'account', description: '💳 Account & Quota: Credits, Models, Switch Accounts' },
    { command: 'system', description: '💻 System & PC: Terminal, Power, Sleep, Specs' },

    // ─── 2. Monitoring & Diagnostic Commands ───
    { command: 'status', description: '📊 Unified dashboard: Quota, Agent, and System status' },
    { command: 'screenshot', description: '📸 Capture workspace zones or full screen' },
    { command: 'history', description: '📜 Fetch last N messages: /history [count]' },
    { command: 'check', description: '⏱️ Manually check if the agent has finished' },
    { command: 'alarm', description: '🔔 Notify when agent finishes responding' },
    { command: 'extensions', description: '🧩 Sidebar extensions & views: /extensions' },

    // ─── 3. AI Agent Commands ───
    { command: 'chats', description: '💬 List all Antigravity agent conversations' },
    { command: 'newchat', description: '➕ Start a new Antigravity agent conversation' },
    { command: 'switchchat', description: '🔄 Switch conversation: /switchchat <number>' },
    { command: 'ask', description: '💬 Send a message to Antigravity agent: /ask <text>' },
    { command: 'stop', description: '🛑 Stop agent generation immediately' },
    { command: 'expand', description: '🔍 Expand collapsed agent execution steps' },
    { command: 'changes', description: '📋 Extract list of modified files & steps' },
    { command: 'question', description: '❓ Check and answer pending agent questions' },
    { command: 'answer', description: '✍️ Answer pending agent question: /answer <text>' },

    // ─── 4. Files & Projects Commands ───
    { command: 'files', description: '📁 Browse project folders & download files' },
    { command: 'getfile', description: '📥 Download project file to phone: /getfile <path>' },
    { command: 'getclipboard', description: '📋 Send PC clipboard text to Telegram' },
    { command: 'getlog', description: '📜 Send latest IDE or extension error log' },
    { command: 'recent', description: '📂 List and open recent folders/workspaces' },
    { command: 'backup', description: '📦 Create and download a clean project ZIP backup' },

    // ─── 5. Account & Quota Commands ───
    { command: 'quota', description: '💳 Show prompt credits and model quota limits' },
    { command: 'models', description: '🧠 List available AI models in chat' },
    { command: 'model', description: '🔄 Switch active AI model: /model <name>' },
    { command: 'accounts', description: '👥 List all saved Antigravity accounts' },
    { command: 'switch', description: '🔄 Switch active account: /switch <id>' },
    { command: 'save_account', description: '💾 Save current account snapshot: /save_account' },
    { command: 'rotate_account', description: '🔁 Rotate to the next available account' },

    // ─── 6. System & PC Commands ───
    { command: 'cmd', description: '⚡ Execute shell command in IDE: /cmd <command>' },
    { command: 'pc', description: '💻 Open quick PC power and action dashboard' },
    { command: 'sysinfo', description: '🖥️ Display hardware, CPU, RAM, and uptime' },
    { command: 'lock', description: '🔒 Lock computer workstation screen' },
    { command: 'sleep', description: '🌙 Put computer into sleep mode' },
    { command: 'restart', description: '🔄 Restart computer: /restart [seconds]' },
    { command: 'shutdown', description: '🔌 Shut down computer: /shutdown [seconds]' },
    { command: 'abort', description: '🛑 Abort scheduled shutdown or restart' },

    // ─── 7. General Utility Commands ───
    { command: 'search', description: '🔍 Search bot commands: /search <query>' },
    { command: 'help', description: '❓ Show available commands guide' }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getToken(): string | undefined {
    return vscode.workspace.getConfiguration('antigravityTelegramControl').get<string>('botToken') || undefined;
}

function getAllowedChatId(): string | undefined {
    const configId = vscode.workspace.getConfiguration('antigravityTelegramControl').get<string>('allowedChatId');
    if (configId && configId.trim()) {
        return configId.trim();
    }
    return lastInteractedChatId || extensionContext?.globalState.get<string>('lastTelegramChatId') || undefined;
}

/**
 * Builds an IPv4-first HTTPS agent for Telegram Bot API calls, avoiding Node 20+
 * Happy Eyeballs stalls and unreachable IPv6 timeouts on dual-stack networks.
 */
function createTelegramHttpsAgent(keepAlive = true): https.Agent {
    const opts: https.AgentOptions & { family?: number; autoSelectFamily?: boolean } = {
        keepAlive,
        family: 4,
        autoSelectFamily: false
    };
    if (keepAlive) {
        opts.keepAliveMsecs = 10000;
    }
    return new https.Agent(opts);
}

/**
 * Uploads a photo buffer directly via raw HTTPS multipart POST over IPv4 with explicit
 * Content-Length and Connection: close to recover from Telegraf keep-alive socket drops.
 */
function sendPhotoDirect(
    token: string,
    chatId: string | number,
    photoBuffer: Buffer,
    extra?: { caption?: string; parseMode?: string; replyMarkup?: any }
): Promise<any> {
    return new Promise((resolve, reject) => {
        const boundary = '----TelegramPhotoBoundary' + crypto.randomBytes(16).toString('hex');
        const parts: Buffer[] = [];

        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`
        ));
        if (extra?.caption) {
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${extra.caption}\r\n`
            ));
        }
        if (extra?.parseMode) {
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\n${extra.parseMode}\r\n`
            ));
        }
        if (extra?.replyMarkup) {
            const markupStr = typeof extra.replyMarkup === 'string'
                ? extra.replyMarkup
                : JSON.stringify(extra.replyMarkup);
            parts.push(Buffer.from(
                `--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${markupStr}\r\n`
            ));
        }

        const isPng = photoBuffer.length >= 4 && photoBuffer[0] === 0x89 && photoBuffer[1] === 0x50;
        const fileName = isPng ? 'screenshot.png' : 'screenshot.jpg';
        const mimeType = isPng ? 'image/png' : 'image/jpeg';

        parts.push(Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`
        ));
        parts.push(photoBuffer);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const fullBody = Buffer.concat(parts);
        const reqHeaders: Record<string, string | number> = {};
        reqHeaders['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
        reqHeaders['Content-Length'] = fullBody.length;
        reqHeaders['Connection'] = 'close';

        const fullBodyOpts: https.RequestOptions & { family?: number; autoSelectFamily?: boolean } = {
            hostname: 'api.telegram.org',
            port: 443,
            path: `/bot${token}/sendPhoto`,
            method: 'POST',
            family: 4,
            autoSelectFamily: false,
            headers: reqHeaders,
            timeout: 30000
        };

        const req = https.request(fullBodyOpts, (res) => {
            let resData = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { resData += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(resData);
                    if (json.ok) {
                        resolve(json.result);
                    } else {
                        reject(new Error(`Telegram API Error: ${json.description || 'Unknown'} (code ${json.error_code})`));
                    }
                } catch (_) {
                    reject(new Error(`Invalid response from Telegram API (${res.statusCode})`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Photo upload timed out after 30 seconds'));
        });
        req.end(fullBody);
    });
}

/**
 * Sends a photo via Telegraf first, falling back to direct IPv4 HTTPS multipart upload
 * if Telegraf fails with a transport or keep-alive socket reset error.
 */
async function sendTelegramPhoto(
    ctx: any,
    chatId: string | number | undefined,
    photoBuffer: Buffer,
    extra?: { caption?: string; parseMode?: string; replyMarkup?: any }
): Promise<any> {
    const telegrafOpts: any = {};
    if (extra?.caption) {
        telegrafOpts.caption = extra.caption;
    }
    if (extra?.parseMode) {
        telegrafOpts.parse_mode = extra.parseMode;
    }
    if (extra?.replyMarkup) {
        telegrafOpts.reply_markup = extra.replyMarkup;
    }

    try {
        if (ctx && typeof ctx.replyWithPhoto === 'function') {
            return await ctx.replyWithPhoto({ source: photoBuffer }, telegrafOpts);
        }
        if (bot && chatId !== undefined) {
            return await bot.telegram.sendPhoto(chatId, { source: photoBuffer }, telegrafOpts);
        }
    } catch (telegrafErr: any) {
        const token = getToken();
        const targetChat = chatId ?? ctx?.chat?.id;
        if (!token || targetChat === undefined) {
            throw telegrafErr;
        }
        console.warn('[Telegram] Telegraf sendPhoto failed, retrying via direct IPv4 upload:', telegrafErr?.message || telegrafErr);
        return await sendPhotoDirect(token, targetChat, photoBuffer, extra);
    }
    throw new Error('No Telegram sender or target chat ID available');
}

async function registerSlashCommands(token: string, chatId?: string): Promise<void> {
    const tgAgent = createTelegramHttpsAgent(false);
    const tg = new Telegram(token, { agent: tgAgent });
    try {
        if (chatId) {
            const numericChatId = Number(chatId);
            if (!isNaN(numericChatId)) {
                console.log(`[Telegram] Registering slash commands ONLY for chat ${chatId}...`);

                // Clear commands for default scopes so unauthorized users/groups don't see them
                try {
                    await tg.deleteMyCommands({ scope: { type: 'default' } });
                    await tg.deleteMyCommands({ scope: { type: 'all_private_chats' } });
                    await tg.deleteMyCommands({ scope: { type: 'all_group_chats' } });
                } catch (e: any) {
                    console.warn('[Telegram] Failed to clear general commands:', e.message);
                }

                // Register commands only for this specific chat
                await tg.setMyCommands(SLASH_COMMANDS, {
                    scope: { type: 'chat', chat_id: numericChatId }
                });
                await tg.setMyCommands(SLASH_COMMANDS, {
                    scope: { type: 'chat_administrators', chat_id: numericChatId }
                });
                console.log(`[Telegram] Commands registered for chat ${chatId}`);
            }
        } else {
            console.log('[Telegram] No allowedChatId specified. Registering slash commands for all users/chats...');
            // Set commands for all chat types
            await tg.setMyCommands(SLASH_COMMANDS, { scope: { type: 'default' } });
            // Also set for private chats
            await tg.setMyCommands(SLASH_COMMANDS, { scope: { type: 'all_private_chats' } });
            // Also set for group chats
            await tg.setMyCommands(SLASH_COMMANDS, { scope: { type: 'all_group_chats' } });
        }

        console.log('[Telegram] Slash commands registered successfully!');
    } finally {
        tgAgent.destroy();
    }
}

async function deleteSlashCommands(token: string, chatId?: string): Promise<void> {
    const tgAgent = createTelegramHttpsAgent(false);
    const tg = new Telegram(token, { agent: tgAgent });
    console.log('[Telegram] Deleting slash commands...');
    try {
        // Delete general commands for all scopes
        await tg.deleteMyCommands({ scope: { type: 'default' } });
        await tg.deleteMyCommands({ scope: { type: 'all_private_chats' } });
        await tg.deleteMyCommands({ scope: { type: 'all_group_chats' } });

        // Also delete for specific chat if provided
        if (chatId) {
            const numericChatId = Number(chatId);
            if (!isNaN(numericChatId)) {
                try {
                    await tg.deleteMyCommands({ scope: { type: 'chat', chat_id: numericChatId } });
                    await tg.deleteMyCommands({ scope: { type: 'chat_administrators', chat_id: numericChatId } });
                } catch (e: any) {
                    console.warn('[Telegram] Failed to delete specific chat commands:', e.message);
                }
            }
        }

        console.log('[Telegram] All slash commands deleted successfully!');
    } finally {
        tgAgent.destroy();
    }
}


function getDebuggingPort(): number {
    return vscode.workspace.getConfiguration('antigravityTelegramControl').get<number>('debuggingPort') ?? 9222;
}

async function sendToAgentChat(text: string): Promise<void> {
    const port = getDebuggingPort();
    let cdpErrorMsg = '';

    // ── Strategy 1: CDP via remote debugging port ────────────────────────────
    try {
        await sendViaCDP(text, port);
        return;
    } catch (cdpErr: any) {
        cdpErrorMsg = cdpErr.message;
        console.warn('[Telegram] CDP failed:', cdpErr.message);
    }

    // ── Strategy 2: workbench.action.chat.open (built-in VS Code chat) ───────
    try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
            query: text,
            isPartialQuery: false
        });
        return;
    } catch (_) { /* command not available */ }

    // ── Strategy 3: clipboard fallback ───────────────────────────────────────
    await vscode.env.clipboard.writeText(text);
    try { 
        await vscode.commands.executeCommand('workbench.action.chat.open'); 
        // If we opened the chat sidebar, don't throw a fatal error, just warn
        console.warn('[Telegram] Falling back to clipboard for:', text);
        return; 
    } catch (_) { }

    // Localized clipboard fallback message without duplicate error wrapper
    const clipboardHint = t('clipboardFallback') || 'Content copied to clipboard — press Ctrl+V in the chat window.';
    throw new Error(`CDP: ${cdpErrorMsg}\n\n${clipboardHint}`);
}

const activeAlarms = new Set<string>();

/**
 * Generates and sends a complete, unified Status Dashboard to Telegram.
 */
async function sendStatusDashboardToTelegram(chatId: string, loadingMessageId?: number): Promise<void> {
    if (!bot) return;

    const port = getDebuggingPort();
    const lang = getLanguage();
    const isAr = lang === 'ar';

    // Fetch all telemetry and statuses concurrently
    const [agentStatusRes, questionRes, quotaRes, chatsRes] = await Promise.allSettled([
        checkAgentCurrentStatus(port),
        getPendingAgentQuestion(port),
        fetchQuotaInfo(lang),
        getAgentConversationsList(port)
    ]);

    const agentStatus = agentStatusRes.status === 'fulfilled' ? agentStatusRes.value : null;
    const questionData = questionRes.status === 'fulfilled' ? questionRes.value : null;
    const quota = quotaRes.status === 'fulfilled' ? quotaRes.value : null;
    const chats = chatsRes.status === 'fulfilled' ? chatsRes.value : null;
    const sys = getSystemTelemetry();

    const nowTime = new Date().toLocaleTimeString(isAr ? 'ar-SA' : 'en-US');
    const dashTitle = t('statusTitle') || (isAr ? 'لوحة الحالة الشاملة' : 'Antigravity Status Dashboard');

    let msg = `🌌 *${dashTitle}*\n`;
    msg += `🕐 \`${nowTime}\`\n`;
    msg += '━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    // ─── 1. AI Agent Section ───
    const agentHeader = t('statusSectionAgent') || (isAr ? 'حالة الوكيل (Agent)' : 'AI Agent Status');
    msg += `🤖 *${agentHeader}*\n`;
    if (agentStatus) {
        const isGen = agentStatus.isGenerating;
        const stateText = isGen
            ? (t('statusAgentGenerating') || (isAr ? '⚡ جارٍ التوليد والتفكير' : '⚡ Generating / Thinking'))
            : (t('statusAgentIdle') || (isAr ? '✅ جاهز (خامل)' : '✅ Idle (Ready)'));
        msg += `  • ${t('statusAgentState') || (isAr ? 'الحالة' : 'State')}: ${stateText}\n`;
    } else {
        msg += `  • ${t('statusAgentState') || (isAr ? 'الحالة' : 'State')}: ⚠️ ${t('statusUnavailable') || (isAr ? 'غير متاح حالياً' : 'Unavailable')}\n`;
    }

    if (chats && chats.length > 0) {
        const currentChat = chats.find(c => c.isCurrent);
        if (currentChat) {
            const cleanTitle = currentChat.title.length > 35 ? currentChat.title.substring(0, 32) + '...' : currentChat.title;
            msg += `  • ${t('statusActiveChat') || (isAr ? 'المحادثة النشطة' : 'Active Chat')}: 💬 *#${currentChat.index} ${cleanTitle}*\n`;
        }
        msg += `  • ${t('statusTotalChats') || (isAr ? 'إجمالي المحادثات' : 'Total Chats')}: 📚 ${chats.length}\n`;
    }

    if (questionData && questionData.hasQuestion) {
        const shortQ = questionData.questionText.length > 50 ? questionData.questionText.substring(0, 47) + '...' : questionData.questionText;
        msg += `  • ❓ *${t('statusPendingQuestion') || (isAr ? 'سؤال معلّق' : 'Pending Question')}:* "${shortQ}"\n`;
    }
    msg += '\n';

    // ─── 2. Quota & Account Section ───
    const quotaHeader = t('statusSectionQuota') || (isAr ? 'الحساب والحصص (Quota)' : 'Quota & Account');
    msg += `📊 *${quotaHeader}*\n`;
    if (quota) {
        if (quota.user_info) {
            const u = quota.user_info;
            const tierStr = u.tier || u.planName || '';
            const userStr = u.name ? (u.email ? `${u.name} (${u.email})` : u.name) : (u.email || '');
            if (userStr || tierStr) {
                msg += `  • 👤 ${userStr}${tierStr ? ` [${tierStr}]` : ''}\n`;
            }
        }

        if (quota.prompt_credits) {
            const pc = quota.prompt_credits;
            const bar = buildProgressBar(pc.remaining_percentage);
            msg += `  • 💬 ${t('promptCreditsLabel') || 'Prompt Credits'}: [${bar}] ${pc.remaining_percentage.toFixed(1)}%\n`;
        }

        if (quota.flow_credits) {
            const fc = quota.flow_credits;
            const bar = buildProgressBar(fc.remaining_percentage);
            msg += `  • 🔄 ${t('flowCreditsLabel') || 'Flow Credits'}: [${bar}] ${fc.remaining_percentage.toFixed(1)}%\n`;
        }

        if (quota.model_groups && quota.model_groups.length > 0) {
            msg += `  • 🧠 ${isAr ? 'حدود النماذج:' : 'Model Limits:'}\n`;
            for (const group of quota.model_groups) {
                msg += `    *${group.title}:*\n`;
                for (const limit of group.limits) {
                    const bar = buildProgressBar(limit.remaining_percentage, 6);
                    const resetNotice = limit.time_until_reset_formatted ? ` _(${limit.time_until_reset_formatted})_` : '';
                    msg += `      - ${limit.name}: [${bar}] ${limit.remaining_percentage}%${resetNotice}\n`;
                }
            }
        } else if (quota.models && quota.models.length > 0) {
            msg += `  • 🧠 ${isAr ? 'النماذج المتاحة:' : 'Top Model Limits:'}\n`;
            const topModels = quota.models.slice(0, 3);
            for (const m of topModels) {
                const pct = m.remaining_percentage ?? (m.remaining_fraction !== undefined ? m.remaining_fraction * 100 : 0);
                const bar = buildProgressBar(pct, 6);
                const resetNotice = m.time_until_reset_formatted ? ` _(${m.time_until_reset_formatted})_` : '';
                msg += `    - ${m.label}: [${bar}] ${pct.toFixed(0)}%${resetNotice}\n`;
            }
        }
    } else {
        msg += `  • ⚠️ ${t('statusUnavailable') || (isAr ? 'بيانات الحصة غير متاحة' : 'Quota info unavailable')}\n`;
    }
    msg += '\n';

    // ─── 3. System & Telemetry Section ───
    const sysHeader = t('statusSectionSystem') || (isAr ? 'موارد الجهاز (System)' : 'Workstation Telemetry');
    msg += `💻 *${sysHeader}*\n`;
    msg += `  • 🖥️ \`${sys.hostname}\` (${sys.platform} ${sys.arch})\n`;
    const ramBar = buildProgressBar(100 - sys.memUsagePct);
    msg += `  • 💾 ${t('statusMemory') || 'RAM'}: [${ramBar}] ${sys.usedMemGb} GB / ${sys.totalMemGb} GB (${sys.memUsagePct}% ${t('statusUsed') || (isAr ? 'مستخدم' : 'used')})\n`;
    msg += `  • ⚡ ${t('statusProcessor') || 'CPU'}: ${sys.cpuModel} (${sys.cpuCores} ${t('statusCores') || (isAr ? 'نواة' : 'cores')})\n`;
    msg += `  • ⏱️ ${t('statusUptime') || 'Uptime'}: ${sys.uptimeFormatted}\n`;

    if (loadingMessageId) {
        try {
            await bot.telegram.deleteMessage(chatId, loadingMessageId);
        } catch (_) {}
    }

    await bot.telegram.sendMessage(chatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: isAr ? '🔄 تحديث الحالة' : '🔄 Refresh Status', callback_data: 'widget_exec:status' },
                    { text: isAr ? '📸 لقطة شاشة' : '📸 Screenshot', callback_data: 'widget_exec:screenshot_full' }
                ],
                [
                    { text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }
                ]
            ]
        }
    });
}

/**
 * Helper to send the interactive file and directory browser to Telegram.
 */
async function sendFileListing(
    target: any,
    targetPath: string,
    workspaceRoot: string,
    editMessage: boolean = false
): Promise<void> {
    const isAr = getLanguage() === 'ar';
    const entries = listDirectory(targetPath, workspaceRoot);
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());

    if (!targetChatId || !bot) {
        return;
    }

    if (entries === null) {
        const errorMsg = t('filesAccessDenied') || '❌ Access denied: Path is outside workspace.';
        if (editMessage && typeof target !== 'string' && target?.editMessageText) {
            try {
                await target.editMessageText(errorMsg);
                return;
            } catch (_) {}
        }
        await bot.telegram.sendMessage(targetChatId, errorMsg);
        return;
    }

    const relPath = path.relative(workspaceRoot, targetPath) || '.';
    const listingTitle = t('filesListing') || (isAr ? 'محتوى المجلد' : 'Folder Contents');
    const itemsLabel = t('filesItems') || (isAr ? 'عنصر' : 'items');

    let msg = `📂 *${listingTitle}:* \`${relPath}\`\n`;
    msg += `📊 ${entries.length} ${itemsLabel}\n`;
    msg += '━'.repeat(24) + '\n\n';

    const MAX_ITEMS_IN_MSG = 18;
    const displayEntries = entries.slice(0, MAX_ITEMS_IN_MSG);

    displayEntries.forEach(entry => {
        const icon = getFileIcon(entry);
        const sizeStr = !entry.isDirectory && entry.size !== undefined
            ? ` _(${formatFileSize(entry.size)})_`
            : '';
        msg += `${icon} \`${entry.name}\`${sizeStr}\n`;
    });

    if (entries.length > MAX_ITEMS_IN_MSG) {
        const remaining = entries.length - MAX_ITEMS_IN_MSG;
        msg += `\n_${isAr ? `...و ${remaining} عنصر آخر` : `...and ${remaining} more items`}_\n`;
    }

    msg += `\n💡 _${isAr ? 'اضغط على مجلد للاستعراض أو على ملف لتحميله مباشرة للهاتف.' : 'Click a folder to browse or a file to download directly to your phone.'}_`;

    const keyboard = buildFileBrowserKeyboard(entries, targetPath, workspaceRoot, isAr);

    if (editMessage && typeof target !== 'string' && target?.editMessageText) {
        try {
            await target.editMessageText(msg, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        } catch (_) {
            // Fallback to sending new message if edit fails
        }
    }

    await bot.telegram.sendMessage(targetChatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

/**
 * Helper to send any project or host file to Telegram as photo, small text code preview, or document.
 */
async function sendFileToChat(target: any, rawPath: string): Promise<void> {
    const workspaceRoot = getWorkspaceRoot();
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());

    if (!targetChatId || !bot) {
        return;
    }

    const reply = async (text: string, extra?: any) => {
        if (typeof target !== 'string' && target?.reply) {
            return target.reply(text, extra);
        }
        return bot!.telegram.sendMessage(targetChatId, text, extra);
    };

    let resolvedPath: string | null = null;

    // 1. Check if absolute path exists
    if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
        resolvedPath = path.normalize(rawPath);
    }
    // 2. Check if relative to workspaceRoot
    else if (workspaceRoot && fs.existsSync(path.join(workspaceRoot, rawPath))) {
        resolvedPath = path.normalize(path.join(workspaceRoot, rawPath));
    }
    // 3. Search in workspace by filename
    else if (workspaceRoot) {
        const found = await findFileInWorkspace(rawPath, workspaceRoot);
        if (found && fs.existsSync(found)) {
            resolvedPath = found;
        }
    }

    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        await reply(t('getfileNotFound', { path: rawPath }) || `❌ File not found: "${rawPath}"`);
        return;
    }

    try {
        const stats = fs.statSync(resolvedPath);
        if (stats.isDirectory()) {
            await reply(t('getfileIsDirectory', { path: rawPath }) || `📁 "${rawPath}" is a directory. Use /files to browse.`);
            return;
        }

        const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB Telegram limit
        if (stats.size > MAX_FILE_SIZE) {
            await reply(t('filesTooLarge', { size: formatFileSize(stats.size) }) || `❌ File too large (${formatFileSize(stats.size)}). Max limit: 50MB.`);
            return;
        }

        const fileName = path.basename(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico'];
        const textExts = [
            '.txt', '.md', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml',
            '.yml', '.html', '.css', '.scss', '.py', '.cs', '.rs', '.go',
            '.java', '.php', '.rb', '.sh', '.bat', '.ps1', '.sql', '.xml',
            '.env', '.gitignore'
        ];

        // 1. If Image: send as Photo
        if (imageExts.includes(ext)) {
            const imgBuffer = fs.readFileSync(resolvedPath);
            await sendTelegramPhoto(target, targetChatId, imgBuffer, {
                caption: `📸 \`${fileName}\` (${formatFileSize(stats.size)})`,
                parseMode: 'Markdown'
            });
            return;
        }

        // 2. If Small text file (<= 3000 bytes): send formatted preview
        if (textExts.includes(ext) && stats.size <= 3000) {
            const content = fs.readFileSync(resolvedPath, 'utf8');
            const langHint = ext.replace('.', '') || 'text';
            const previewMsg = `📄 \`${fileName}\` (${formatFileSize(stats.size)})\n\`\`\`${langHint}\n${content.substring(0, 3500)}\n\`\`\``;
            await reply(previewMsg, { parse_mode: 'Markdown' });
            return;
        }

        // 3. Send as Document
        try {
            if (typeof target !== 'string' && target?.replyWithDocument) {
                await target.replyWithDocument(
                    { source: resolvedPath, filename: fileName },
                    { caption: `📎 \`${fileName}\` (${formatFileSize(stats.size)})` }
                );
            } else {
                await bot.telegram.sendDocument(
                    targetChatId,
                    { source: resolvedPath, filename: fileName },
                    { caption: `📎 \`${fileName}\` (${formatFileSize(stats.size)})` }
                );
            }
        } catch (docErr: any) {
            console.warn('[Telegram] sendDocument failed, attempting sendDocumentDirect fallback:', docErr.message);
            const token = getToken();
            if (token) {
                await sendDocumentDirect(token, targetChatId, resolvedPath, fileName, `📎 \`${fileName}\` (${formatFileSize(stats.size)})`);
            } else {
                throw docErr;
            }
        }
    } catch (e: any) {
        console.error('[Telegram] Error sending file:', e);
        await reply(t('filesReadError', { msg: e.message }) || `❌ Error reading file: ${e.message}`);
    }
}

type WorkspaceZone = 'right' | 'left' | 'editor' | 'terminal' | 'full';

interface ZoneMeta {
    nameAr: string;
    nameEn: string;
    openCmd: string;
}

const ZONE_METAS: Record<WorkspaceZone, ZoneMeta> = {
    right: {
        nameAr: 'لوحة المحادثة (الجانب الأيمن)',
        nameEn: 'Chat Panel (Right)',
        openCmd: 'workbench.action.chat.open'
    },
    left: {
        nameAr: 'مستكشف الملفات والإضافات (الجانب الأيسر)',
        nameEn: 'Explorer & Extensions (Left)',
        openCmd: 'workbench.view.explorer'
    },
    editor: {
        nameAr: 'منطقة المحرر (المنتصف العلوي)',
        nameEn: 'Editor Area (Center Top)',
        openCmd: 'workbench.action.openPreviousRecentlyUsedEditorInGroup'
    },
    terminal: {
        nameAr: 'اللوحة السفلية / الطرفية',
        nameEn: 'Terminal Panel (Bottom)',
        openCmd: 'workbench.action.terminal.toggleTerminal'
    },
    full: {
        nameAr: 'مساحة العمل الكلية',
        nameEn: 'Full Workspace',
        openCmd: ''
    }
};

/**
 * Checks if a specific workspace zone is currently open/visible (Fix #10).
 */
async function checkIsZoneOpen(zone: WorkspaceZone): Promise<boolean> {
    if (zone === 'full') return true;

    const port = getDebuggingPort();
    const cdpPartMap: Record<string, 'sidebar' | 'editor' | 'panel' | 'auxiliarybar'> = {
        left: 'sidebar',
        right: 'auxiliarybar',
        editor: 'editor',
        terminal: 'panel'
    };

    const cdpPart = cdpPartMap[zone];
    if (cdpPart) {
        try {
            const rect = await getWorkbenchPartBoundingRect(port, cdpPart);
            if (rect && rect.exists) {
                return rect.isOpen;
            }
        } catch (_) {}
    }

    // Fallbacks via VS Code API
    if (zone === 'terminal') {
        return vscode.window.terminals.length > 0 && !!vscode.window.activeTerminal;
    }
    if (zone === 'editor') {
        return vscode.window.visibleTextEditors.length > 0;
    }
    return true;
}

/**
 * Captures a cropped screenshot of the specified workspace zone directly via CDP with desktop fallback (Fix #7, #10, #12, #13, #14).
 */
async function captureZoneBuffer(zone: WorkspaceZone): Promise<Buffer> {
    const port = getDebuggingPort();
    try {
        const result = await captureWorkbenchZone(port, zone);
        if (result.isOpen && result.buffer && result.buffer.length > 0) {
            return result.buffer;
        }
        if (!result.isOpen && zone !== 'full') {
            throw new Error(`Zone ${zone} is currently closed`);
        }
    } catch (cdpErr: any) {
        console.warn(`[Screenshot] CDP zone capture failed for ${zone}:`, cdpErr.message);
        if (cdpErr.message && cdpErr.message.includes('closed')) {
            throw cdpErr;
        }
    }

    // Secondary fallback: only attempt desktop screenshot if CDP connection failed entirely
    try {
        const fullBuffer = await screenshot({ format: 'png' });
        if (zone === 'full') {
            return fullBuffer;
        }

        const img = await Jimp.read(fullBuffer);
        const w = img.bitmap.width;
        const h = img.bitmap.height;

        const topBarOffset = Math.round(h * 0.035);
        const usableH = Math.round(h * 0.93);

        let cropX = 0;
        let cropY = topBarOffset;
        let cropW = w;
        let cropH = usableH;

        if (zone === 'left') {
            cropX = 0;
            cropY = topBarOffset;
            cropW = Math.round(w * 0.23);
            cropH = usableH;
        } else if (zone === 'editor') {
            cropX = Math.round(w * 0.23);
            cropY = topBarOffset;
            cropW = Math.round(w * 0.49);
            cropH = Math.round(usableH * 0.65);
        } else if (zone === 'terminal') {
            cropX = Math.round(w * 0.23);
            cropY = topBarOffset + Math.round(usableH * 0.65);
            cropW = Math.round(w * 0.49);
            cropH = Math.round(usableH * 0.35);
        } else if (zone === 'right') {
            cropX = Math.round(w * 0.72);
            cropY = topBarOffset;
            cropW = Math.round(w * 0.28);
            cropH = usableH;
        }

        cropX = Math.max(0, Math.min(cropX, w - 10));
        cropY = Math.max(0, Math.min(cropY, h - 10));
        cropW = Math.max(10, Math.min(cropW, w - cropX));
        cropH = Math.max(10, Math.min(cropH, h - cropY));

        img.crop({ x: cropX, y: cropY, w: cropW, h: cropH });
        return await img.getBuffer('image/jpeg');
    } catch (fallbackErr: any) {
        throw new Error(`Screenshot failed: Please ensure Antigravity IDE is running with --remote-debugging-port=${port} (${fallbackErr.message})`);
    }
}

/**
 * Sends the 4-zone selection menu to Telegram for /screenshot (Fix #10).
 */
async function sendScreenshotZoneMenu(target: any): Promise<void> {
    const isAr = getLanguage() === 'ar';
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());
    if (!targetChatId || !bot) return;

    const title = isAr ? '📸 التقاط لقطة شاشة' : '📸 Capture Screenshot';
    const desc = isAr
        ? 'اختر نطاق الشاشة المطلوب التقاطه من مساحة العمل:'
        : 'Select the workspace zone to capture:';

    const keyboard = [
        [
            { text: isAr ? '👉 لوحة المحادثة (اليمين)' : '👉 Chat Panel (Right)', callback_data: 'zone_shot:right' },
            { text: isAr ? '👈 مستكشف الملفات (اليسار)' : '👈 File Explorer (Left)', callback_data: 'zone_shot:left' }
        ],
        [
            { text: isAr ? '⬆️ منطقة المحرر (العلوي)' : '⬆️ Editor Area (Center Top)', callback_data: 'zone_shot:editor' },
            { text: isAr ? '⬇️ اللوحة السفلية / الطرفية' : '⬇️ Terminal Panel (Bottom)', callback_data: 'zone_shot:terminal' }
        ],
        [
            { text: isAr ? '🖥️ مساحة العمل الكلية' : '🖥️ Full Workspace', callback_data: 'zone_shot:full' }
        ],
        [
            { text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }
        ]
    ];

    await bot.telegram.sendMessage(targetChatId, `📸 *${title}*\n\n${desc}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

/**
 * Handles capturing and sending a specific zone with verification of whether it is open (Fix #10).
 */
async function handleZoneScreenshot(target: any, zone: WorkspaceZone): Promise<void> {
    const isAr = getLanguage() === 'ar';
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());
    if (!targetChatId || !bot) return;

    const meta = ZONE_METAS[zone];
    const zoneName = isAr ? meta.nameAr : meta.nameEn;

    // Check if zone is currently open
    const isOpen = await checkIsZoneOpen(zone);
    if (!isOpen) {
        const warningMsg = isAr
            ? `⚠️ تنبيه: *${zoneName}* غير مفتوح حالياً في مساحة العمل لالتقاط صورة له.`
            : `⚠️ Warning: *${zoneName}* is currently closed in the workspace.`;

        const openBtnText = isAr
            ? `🔄 فتح ${zoneName} والتقاط الصورة`
            : `🔄 Open ${zoneName} & Capture`;

        await bot.telegram.sendMessage(targetChatId, warningMsg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: openBtnText, callback_data: `zone_open_shot:${zone}` }],
                    [{ text: isAr ? '📸 اختيار جزء آخر' : '📸 Choose Another Zone', callback_data: 'widget_exec:screenshot' }],
                    [{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]
                ]
            }
        });
        return;
    }

    try {
        const buffer = await captureZoneBuffer(zone);
        const caption = `📸 *${zoneName}*\n_${isAr ? 'تم التقاط لقطة الشاشة بنجاح' : 'Screenshot captured successfully'}_`;
        await sendTelegramPhoto(target, targetChatId, buffer, {
            caption,
            parseMode: 'Markdown',
            replyMarkup: {
                inline_keyboard: [
                    [
                        { text: isAr ? '🔄 تحديث اللقطة' : '🔄 Refresh', callback_data: `zone_shot:${zone}` },
                        { text: isAr ? '📸 نطاق آخر' : '📸 Other Zone', callback_data: 'widget_exec:screenshot' }
                    ],
                    [{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]
                ]
            }
        });
    } catch (e: any) {
        await bot.telegram.sendMessage(targetChatId, `❌ Failed to capture ${zoneName}: ${e.message}`);
    }
}

/**
 * Helper to display the interactive Extensions & Sidebar Views menu.
 */
async function sendExtensionsMenu(
    target: any,
    expanded: boolean = false,
    editMessage: boolean = false
): Promise<void> {
    const isAr = getLanguage() === 'ar';
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());

    if (!targetChatId || !bot) {
        return;
    }

    const title = t('extManagerTitle') || (isAr ? 'لوحة التحكم بالإضافات والشريط الجانبي' : 'Extensions & Sidebar Views Manager');
    const subtitle = t('extManagerSubtitle') || (isAr
        ? 'اختر أي إضافة أو واجهة جانبية أدناه لفتحها في المحرر والتقاط لقطة شاشة حية لرؤية التغييرات والنتائج:'
        : 'Select any sidebar view or extension below to focus it and capture a live screenshot of its panel and changes:');

    const msg = `🧩 *${title}*\n\n${subtitle}`;
    const keyboard = buildExtensionsKeyboard(expanded, getLanguage());

    if (editMessage && typeof target !== 'string' && target?.editMessageText) {
        try {
            await target.editMessageText(msg, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
            return;
        } catch (_) {
            // Fallback to sending new message if edit fails
        }
    }

    await bot.telegram.sendMessage(targetChatId, msg, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
}

/**
 * Focuses a specific sidebar view in VS Code and sends a live screenshot of the sidebar to Telegram (Fix #12, #13, #14).
 */
async function openAndCaptureSidebarView(target: any, viewId: string): Promise<void> {
    const isAr = getLanguage() === 'ar';
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());

    if (!targetChatId || !bot) {
        return;
    }

    const allViews = getDiscoveredSidebarViews();
    const view = allViews.find(v => v.id === viewId);

    if (!view) {
        await bot.telegram.sendMessage(targetChatId, `❌ View not found: ${viewId}`);
        return;
    }

    // Answer callback query if target is a callback context
    if (typeof target !== 'string' && target?.answerCbQuery) {
        try {
            const activatingNotice = (t('extActivating') || 'Opening {name} and capturing view...')
                .replace('{name}', view.label);
            await target.answerCbQuery(activatingNotice);
        } catch (_) {}
    }

    // Activate the view in VS Code
    const activated = await activateSidebarView(view.command);
    if (!activated) {
        const failMsg = (t('extActivateFailed') || 'Failed to open view {name}.')
            .replace('{name}', view.label);
        await bot.telegram.sendMessage(targetChatId, `⚠️ ${failMsg}`);
        return;
    }

    // Wait a brief moment for the view content to load and render
    await new Promise(res => setTimeout(res, 1200));

    const caption = `${view.icon} *${view.label}*\n_${t('extScreenshotCaption') || (isAr ? 'لقطة شاشة حية لنافذة الإضافة والشريط الجانبي' : 'Live screenshot of sidebar view')}_`;
    const actionButtons = [
        [
            { text: t('extRefresh') || (isAr ? '🔄 تحديث اللقطة' : '🔄 Refresh Screenshot'), callback_data: `ext_open:${view.id}` },
            { text: t('extBackToList') || (isAr ? '🧩 قائمة الإضافات' : '🧩 Extensions List'), callback_data: 'ext_list:main' }
        ],
        [
            { text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }
        ]
    ];

    try {
        // Fix #12, #13, #14: Capture the actual LEFT sidebar zone where the extension / view is opened!
        const buffer = await captureZoneBuffer('left');
        await sendTelegramPhoto(target, targetChatId, buffer, {
            caption,
            parseMode: 'Markdown',
            replyMarkup: { inline_keyboard: actionButtons }
        });
    } catch (err: any) {
        console.warn('[Telegram] captureZoneBuffer failed in openAndCaptureSidebarView, attempting desktop fallback:', err.message);
        try {
            const fallbackBuffer = await screenshot({ format: 'jpg' });
            await sendTelegramPhoto(target, targetChatId, fallbackBuffer, {
                caption,
                parseMode: 'Markdown',
                replyMarkup: { inline_keyboard: actionButtons }
            });
        } catch (fbErr: any) {
            console.error('[Telegram] Fallback screenshot failed in openAndCaptureSidebarView:', fbErr.message);
            await bot.telegram.sendMessage(targetChatId, `${view.icon} *${view.label}* — ${t('extActivated') || 'Activated'}\n⚠️ ${t('extScreenshotFailed') || 'Could not capture screenshot of view.'}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: actionButtons }
            });
        }
    }
}

/**
 * Expands all collapsed changes/steps accordions in Antigravity chat and sends an expanded screenshot.
 */
async function handleExpandCommand(target: any): Promise<void> {
    const isAr = getLanguage() === 'ar';
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());

    if (!targetChatId || !bot) {
        return;
    }

    const reply = async (text: string, extra?: any) => {
        if (typeof target !== 'string' && target?.reply) {
            return target.reply(text, extra);
        }
        return bot!.telegram.sendMessage(targetChatId, text, extra);
    };

    if (typeof target !== 'string' && target?.answerCbQuery) {
        try {
            await target.answerCbQuery(t('expandExpanding') || (isAr ? 'جاري توسيع خطوات وعمليات الوكيل...' : 'Expanding agent steps...'));
        } catch (_) {}
    }

    const port = getDebuggingPort();
    const noticeMsg = await reply(t('expandExpanding') || (isAr ? '🔍 جاري فحص وتوسيع خطوات وعمليات الوكيل في المحادثة...' : '🔍 Expanding agent execution steps in conversation...'));

    try {
        const { expandedCount, hasOperations } = await expandAllChanges(port);
        // Wait 400ms for UI animation and expansion rendering
        await new Promise(res => setTimeout(res, 400));

        let captionText = '';
        if (expandedCount > 0) {
            captionText = isAr
                ? `✅ تم توسيع ${expandedCount} من خطوات وعمليات الوكيل بنجاح:`
                : `✅ Expanded ${expandedCount} agent execution step(s):`;
        } else if (hasOperations) {
            captionText = isAr
                ? `ℹ️ جميع خطوات وعمليات الوكيل في المحادثة موسعة بالفعل:`
                : `ℹ️ All agent steps in the conversation are already expanded:`;
        } else {
            captionText = isAr
                ? `ℹ️ لا توجد خطوات أو عمليات مطوية حالياً للوكيل في المحادثة المفتوحة.`
                : `ℹ️ No collapsed agent operations found in the active conversation.`;
        }

        const keyboard = [
            [
                { text: isAr ? '🔄 تحديث اللقطة' : '🔄 Refresh View', callback_data: 'changes:refresh' },
                { text: t('expandGetText') || (isAr ? '📋 استخراج التقرير' : '📋 Extract Text'), callback_data: 'changes:get_text' }
            ],
            [
                { text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }
            ]
        ];

        try {
            const { buffer } = await captureAgentScreenshot(port);
            if (noticeMsg && noticeMsg.message_id) {
                try { await bot.telegram.deleteMessage(targetChatId, noticeMsg.message_id); } catch (_) {}
            }
            await sendTelegramPhoto(target, targetChatId, buffer, {
                caption: captionText,
                replyMarkup: { inline_keyboard: keyboard }
            });
        } catch (screenshotErr: any) {
            console.warn('[Telegram] captureAgentScreenshot failed in expand, falling back to desktop:', screenshotErr.message);
            const fallbackBuffer = await screenshot({ format: 'jpg' });
            if (noticeMsg && noticeMsg.message_id) {
                try { await bot.telegram.deleteMessage(targetChatId, noticeMsg.message_id); } catch (_) {}
            }
            await sendTelegramPhoto(target, targetChatId, fallbackBuffer, {
                caption: captionText,
                replyMarkup: { inline_keyboard: keyboard }
            });
        }
    } catch (err: any) {
        console.error('[Telegram] Error in handleExpandCommand:', err);
        await reply(t('error', { msg: err.message }));
    }
}

/**
 * Expands collapsed sections and extracts a structured report of modified files, commands, and steps.
 */
async function handleChangesCommand(target: any): Promise<void> {
    const isAr = getLanguage() === 'ar';
    const targetChatId = typeof target === 'string' || typeof target === 'number'
        ? target.toString()
        : (target?.chat?.id?.toString() || getAllowedChatId());

    if (!targetChatId || !bot) {
        return;
    }

    const reply = async (text: string, extra?: any) => {
        if (typeof target !== 'string' && target?.reply) {
            return target.reply(text, extra);
        }
        return bot!.telegram.sendMessage(targetChatId, text, extra);
    };

    if (typeof target !== 'string' && target?.answerCbQuery) {
        try {
            await target.answerCbQuery(t('changesExtracting') || 'Extracting live changes...');
        } catch (_) {}
    }

    const port = getDebuggingPort();
    const noticeMsg = await reply(t('changesExtracting') || '📋 Extracting live changes and commands...');

    try {
        // Expand first to ensure full DOM presence
        await expandAllChanges(port);
        await new Promise(res => setTimeout(res, 500));

        const snapshot = await extractCurrentChanges(port);

        if (noticeMsg && noticeMsg.message_id) {
            try { await bot.telegram.deleteMessage(targetChatId, noticeMsg.message_id); } catch (_) {}
        }

        if (!snapshot.success || snapshot.totalCount === 0) {
            await reply(t('changesNotFound') || 'ℹ️ No live changes or tool steps found.');
            return;
        }

        let msg = `📋 *${t('changesTitle') || 'Live Agent Changes & Executed Steps'}*\n`;
        msg += '━'.repeat(26) + '\n\n';

        if (snapshot.files.length > 0) {
            msg += `📝 *${t('changesFiles') || 'Modified / Viewed Files'}* (${snapshot.files.length}):\n`;
            snapshot.files.forEach(f => {
                msg += `  • \`${f}\`\n`;
            });
            msg += '\n';
        }

        if (snapshot.commands.length > 0) {
            msg += `⚡ *${t('changesCommands') || 'Executed Commands'}* (${snapshot.commands.length}):\n`;
            snapshot.commands.forEach(c => {
                const cleanC = c.length > 120 ? c.substring(0, 117) + '...' : c;
                msg += `  › \`${cleanC}\`\n`;
            });
            msg += '\n';
        }

        if (snapshot.steps.length > 0) {
            msg += `🛠️ *${t('changesSteps') || 'Tool Steps & Actions'}* (${snapshot.steps.length}):\n`;
            snapshot.steps.forEach(s => {
                msg += `  › ${s}\n`;
            });
            msg += '\n';
        }

        if (snapshot.rawText && snapshot.files.length === 0 && snapshot.commands.length === 0 && snapshot.steps.length === 0) {
            msg += `📄 *${t('changesRaw') || 'Details'}:*\n\`\`\`\n${snapshot.rawText.substring(0, 2000)}\n\`\`\``;
        }

        const keyboard = [
            [
                { text: isAr ? '📸 لقطة موسّعة' : '📸 Expanded Screenshot', callback_data: 'changes:screenshot' },
                { text: isAr ? '🔄 تحديث' : '🔄 Refresh', callback_data: 'changes:refresh' }
            ],
            [
                { text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }
            ]
        ];

        const MAX_LEN = 3900;
        if (msg.length <= MAX_LEN) {
            await reply(msg, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } else {
            const chunks = msg.match(/.{1,3800}/gs) ?? [msg];
            for (let i = 0; i < chunks.length; i++) {
                const isLast = i === chunks.length - 1;
                await reply(chunks[i], {
                    parse_mode: 'Markdown',
                    reply_markup: isLast ? { inline_keyboard: keyboard } : undefined
                });
            }
        }
    } catch (err: any) {
        console.error('[Telegram] Error in handleChangesCommand:', err);
        await reply(t('error', { msg: err.message }));
    }
}

// ─── Start bot ────────────────────────────────────────────────────────────────

async function startBot(context: vscode.ExtensionContext): Promise<void> {
    const token = getToken();

    if (!token) {
        vscode.window.showErrorMessage(t('invalidToken'));
        return;
    }

    if (bot) {
        vscode.window.showWarningMessage(t('botAlreadyRunning'));
        return;
    }

    if (lockManager && !lockManager.acquireLock()) {
        vscode.window.showWarningMessage(t('botAlreadyRunningInAnotherWindow'));
        return;
    }

    try {
        console.log('[Telegram] Starting bot...');
        telegramAgent?.destroy();
        telegramAgent = createTelegramHttpsAgent(true);
        bot = new Telegraf(token, { telegram: { agent: telegramAgent } });
        // Global error handler for Telegraf to prevent polling loop crashes on unhandled errors
        bot.catch((err: any, ctx: any) => {
            console.error(`[Telegram] Unhandled bot error in update ${ctx?.updateType}:`, err);
        });
        const allowedChatId = getAllowedChatId();

        // Track the active user chat ID on any incoming Telegram update
        bot.use(async (ctx, next) => {
            if (ctx.chat?.id) {
                lastInteractedChatId = ctx.chat.id.toString();
                if (extensionContext) {
                    extensionContext.globalState.update('lastTelegramChatId', lastInteractedChatId);
                }
            }
            return next();
        });

        // ── Handlers ──
        bot.start(async (ctx) => {
            const lang = getLanguage();
            const welcomeText = t('welcome').replace('${id}', ctx.chat.id.toString());
            const keyboard = buildCommandWidgetKeyboard(undefined, undefined, lang);
            await ctx.reply(welcomeText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        });

        bot.help(async (ctx) => {
            await handleMenuCommand(ctx, undefined, undefined, false);
        });

        // Helper to format and send interactive agent questions with inline keyboard buttons to Telegram
        const sendQuestionToTelegram = async (target: any, questionData: PendingAgentQuestion, port: number): Promise<void> => {
            try {
                if (questionData.targetId) {
                    lastActiveQuestionTargetId = questionData.targetId;
                }
                const targetChatId = typeof target === 'string' ? target : (target?.chat?.id?.toString() || getAllowedChatId());
                if (!targetChatId || !bot) {
                    return;
                }

                let optionsListText = '';
                for (const opt of questionData.options) {
                    optionsListText += `${opt.index}️⃣ *${opt.text}*\n`;
                }

                const fullMsg = `${t('questionTitleText') || '❓ *Agent Question:*'}\n\n` +
                    `*${questionData.questionText}*\n\n` +
                    (optionsListText ? `🔘 *${getLanguage() === 'ar' ? 'الخيارات المتاحة:' : 'Options:'}*\n${optionsListText}\n` : '') +
                    `\n${t('questionCustomHint') || '💡 Click an option below, type its number (e.g. 1), or type /answer <text> directly.'}`;

                // Build smart, adaptive Inline Keyboard
                const inlineKeyboard = buildSmartQuestionKeyboard(questionData.options, getLanguage());

                // Try capturing screenshot of the question frame
                const photoCaption = fullMsg.length > 1000 ? fullMsg.substring(0, 990) + '...' : fullMsg;
                try {
                    const { buffer } = await captureAgentScreenshot(port);
                    await sendTelegramPhoto(null, targetChatId, buffer, {
                        caption: photoCaption,
                        parseMode: 'Markdown',
                        replyMarkup: { inline_keyboard: inlineKeyboard }
                    });
                } catch (photoErr: any) {
                    console.warn('[Telegram] sendPhoto failed, falling back to text:', photoErr.message);
                    try {
                        await bot.telegram.sendMessage(targetChatId, fullMsg, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: inlineKeyboard }
                        });
                    } catch (msgErr: any) {
                        console.warn('[Telegram] sendMessage with Markdown failed, falling back to plain text:', msgErr.message);
                        await bot.telegram.sendMessage(targetChatId, fullMsg.replace(/[*_`\[\]]/g, ''), {
                            reply_markup: { inline_keyboard: inlineKeyboard }
                        });
                    }
                }
            } catch (err: any) {
                console.error('[Telegram] Error sending question to Telegram:', err);
                if (typeof target !== 'string' && target?.reply) {
                    target.reply(t('error', { msg: err.message }));
                }
            }
        };

        // Helper function to fetch and send the latest conversation turn text in Telegram-safe chunks
        const sendLatestConversationText = async (ctx: any, port: number, contextLabel: string): Promise<void> => {
            try {
                const conversationText = await getLatestAgentConversationText(port);
                const fullText = (conversationText || '').trim();
                if (!fullText) {
                    return;
                }

                // Split into message chunks to respect Telegram's 4096 character limit
                const maxChunkSize = 4000;
                for (let offset = 0; offset < fullText.length; offset += maxChunkSize) {
                    const chunk = fullText.slice(offset, offset + maxChunkSize);
                    try {
                        await ctx.reply(chunk);
                    } catch (chunkErr: any) {
                        console.warn(`[Telegram] Could not send message chunk in ${contextLabel}:`, chunkErr.message);
                    }
                }
            } catch (textErr: any) {
                console.warn(`[Telegram] Could not fetch conversation text for ${contextLabel}:`, textErr.message);
            }
        };

        // Helper function to send the completion screenshot followed by the latest conversation text
        const sendCompletionScreenshotAndText = async (ctx: any, port: number, caption: string, contextLabel: string): Promise<void> => {
            // Trigger local sound alert if enabled (deduplicated against background watcher via cooldown)
            completionSoundWatcher?.notifyAlertIfEnabled();

            try {
                const { buffer } = await captureAgentScreenshot(port);
                await sendTelegramPhoto(ctx, ctx.chat?.id, buffer, { caption });
            } catch (screenshotErr: any) {
                try {
                    await ctx.reply(t('screenshotError', { msg: screenshotErr.message }));
                } catch (_) {
                    // Suppress secondary error if Telegram reply fails
                }
            }

            await sendLatestConversationText(ctx, port, contextLabel);
        };

        // Helper function to monitor Antigravity agent progress and notify user or display question on completion
        const runAgentProgressCheck = async (ctx: any, attempt = 1) => {
            const port = getDebuggingPort();
            const autoRetry = vscode.workspace.getConfiguration('antigravityTelegramControl').get<boolean>('autoRetry') ?? false;
            const chatId = ctx.chat?.id?.toString();

            try {
                const finished = await waitForAgentResponse(port);
                if (finished) {
                    // Check if the agent paused waiting for an interactive question
                    const questionData = await getPendingAgentQuestion(port);
                    if (questionData && questionData.hasQuestion) {
                        await sendQuestionToTelegram(ctx, questionData, port);
                        return;
                    }

                    await sendCompletionScreenshotAndText(ctx, port, t('agentFinished'), 'runAgentProgressCheck');
                } else {
                    if (autoRetry && attempt < 3) {
                        // NEW LOGIC: Try to find and click the retry button ONLY
                        const retryResult = await clickRetryButton(port);
                        if (retryResult.success) {
                            await ctx.reply(t('autoRetryMsg', { attempt: (attempt + 1).toString() }));
                            await runAgentProgressCheck(ctx, attempt + 1);
                        } else {
                            ctx.reply(t('timeoutError'));
                        }
                    } else {
                        ctx.reply(t('timeoutError'));
                    }
                }
            } catch (e: any) {
                if (autoRetry && attempt < 3) {
                    // Try clicking retry even on error (maybe it's a transient error)
                    const retryResult = await clickRetryButton(port);
                    if (retryResult.success) {
                        await ctx.reply(t('autoRetryMsg', { attempt: (attempt + 1).toString() }));
                        await runAgentProgressCheck(ctx, attempt + 1);
                    } else {
                        ctx.reply(t('trackingError', { msg: e.message }));
                    }
                } else {
                    ctx.reply(t('trackingError', { msg: e.message }));
                }
            } finally {
                // Ensure active alarm is cleaned up for this chat once finished
                if (chatId) {
                    activeAlarms.delete(chatId);
                }
            }
        };

        // Helper to display Command Widget Dashboard
        async function handleMenuCommand(ctx: any, activeGroup?: CommandGroup, searchQuery?: string, editMessage: boolean = false) {
            const lang = getLanguage();
            const keyboard = buildCommandWidgetKeyboard(activeGroup, searchQuery, lang);
            const title = t('menuTitle') || 'Antigravity Command Center';
            const subtitle = searchQuery
                ? (t('searchResults', { query: searchQuery }) || `🔍 Search results for: *${searchQuery}*`)
                : activeGroup
                    ? (lang === 'ar' ? `اختر أمراً من مجموعة: *${GROUP_META[activeGroup]?.labelAr}*` : `Select a command from: *${GROUP_META[activeGroup]?.label}*`)
                    : (t('menuChooseGroup') || 'Select a category below to explore commands:');

            const fullText = `🎛️ *${title}*\n\n${subtitle}`;

            if (editMessage) {
                try {
                    await ctx.editMessageText(fullText, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: keyboard }
                    });
                    return;
                } catch (_) {
                    // Fallback to sending a new reply if message cannot be edited
                }
            }

            await ctx.reply(fullText, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

        // Handler for /history and /hist commands to retrieve recent conversation turns from active session
        async function handleHistoryCommand(ctx: any, customLimit?: number) {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            let limit = customLimit;
            if (limit === undefined && ctx.message?.text) {
                const parts = ctx.message.text.split(' ');
                parts.shift();
                const limitArg = parts.join(' ').trim();
                limit = limitArg ? Math.min(Math.max(parseInt(limitArg, 10) || 5, 1), 20) : 5;
            } else if (limit === undefined) {
                limit = 5;
            }

            const port = getDebuggingPort();
            const fetchingNotice = (t('historyFetching') || '📜 Fetching last {count} messages from active conversation...')
                .replace('{count}', limit.toString());
            const loadingMsg = await ctx.reply(fetchingNotice);

            try {
                const messages = await getConversationHistory(port, limit);

                if (!messages || messages.length === 0) {
                    await ctx.reply(t('historyEmpty') || 'ℹ️ No conversation messages found in the active session.');
                    return;
                }

                const header = (t('historyHeader') || 'Chat History (Last {count} messages)')
                    .replace('{count}', messages.length.toString());
                let output = `📜 *${header}*\n`;
                output += '━'.repeat(25) + '\n\n';

                const roleUserLabel = t('historyRoleUser') || 'User';
                const roleAgentLabel = t('historyRoleAgent') || 'Antigravity Agent';

                messages.forEach((msg, idx) => {
                    const icon = msg.role === 'user' ? '👤' : '🤖';
                    const roleLabel = msg.role === 'user' ? roleUserLabel : roleAgentLabel;
                    const maxLen = 800;
                    const cleanText = msg.text.length > maxLen ? msg.text.substring(0, maxLen) + '...' : msg.text;
                    output += `${icon} *${roleLabel}* (#${idx + 1}):\n${cleanText}\n\n`;
                });

                const MAX_LEN = 3900;
                if (output.length <= MAX_LEN) {
                    await ctx.reply(output, { parse_mode: 'Markdown' });
                } else {
                    const chunks: string[] = [];
                    let current = '';
                    const lines = output.split('\n');
                    for (const line of lines) {
                        if ((current + '\n' + line).length > MAX_LEN) {
                            chunks.push(current);
                            current = line;
                        } else {
                            current = current ? current + '\n' + line : line;
                        }
                    }
                    if (current) chunks.push(current);

                    for (const chunk of chunks) {
                        await ctx.reply(chunk, { parse_mode: 'Markdown' });
                    }
                }
            } catch (e: any) {
                console.error('[Telegram] Error in /history command:', e);
                ctx.reply(t('error', { msg: e.message }));
            } finally {
                try {
                    if (loadingMsg && loadingMsg.message_id) {
                        await ctx.deleteMessage(loadingMsg.message_id);
                    }
                } catch (_) {}
            }
        }

        // Handler for /status, /stat, /dashboard to generate a unified status dashboard
        async function handleStatusCommand(ctx: any) {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            const loadingMsg = await ctx.reply(t('statusFetching') || '🔍 Gathering complete status from IDE & System...');
            await sendStatusDashboardToTelegram(ctx.chat.id.toString(), loadingMsg?.message_id);
        }

        // ─── Register Widget & History Commands ───

        bot.command(['status', 'stat', 'dashboard'], async (ctx) => {
            await handleStatusCommand(ctx);
        });

        bot.command(['menu', 'dashboard', 'commands'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            await handleMenuCommand(ctx, undefined, undefined, false);
        });

        // Fast group navigation commands (Fix #22)
        bot.command(['agent', 'ai'], async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            await handleMenuCommand(ctx, 'ai', undefined, false);
        });

        bot.command(['monitoring', 'mon'], async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            await handleMenuCommand(ctx, 'monitoring', undefined, false);
        });

        bot.command(['projects', 'files_projects'], async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            await handleMenuCommand(ctx, 'files', undefined, false);
        });

        bot.command(['account', 'accounts_quota'], async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            await handleMenuCommand(ctx, 'account', undefined, false);
        });

        bot.command(['system', 'system_pc'], async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            await handleMenuCommand(ctx, 'system', undefined, false);
        });

        bot.command(['search', 'find'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            const parts = ctx.message.text.split(' ');
            parts.shift();
            const query = parts.join(' ').trim();
            if (!query) {
                await ctx.reply(t('searchPrompt') || 'Usage: /search <keyword>');
                return;
            }
            await handleMenuCommand(ctx, undefined, query, false);
        });

        bot.command(['history', 'hist'], async (ctx) => {
            await handleHistoryCommand(ctx);
        });

        // ─── Command Widget Inline Actions ───

        // Action: Navigate to Main Dashboard
        bot.action('widget_home:main', async (ctx) => {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            await handleMenuCommand(ctx, undefined, undefined, true);
        });

        // Action: Open Group Commands
        bot.action(/^widget_group:(.+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            const group = ctx.match[1] as CommandGroup;
            await handleMenuCommand(ctx, group, undefined, true);
        });

        // Action: View Command Detail
        bot.action(/^widget_cmd:(.+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            const cmdId = ctx.match[1];
            const cmd = ALL_COMMANDS.find(c => c.id === cmdId);
            if (!cmd) {
                await ctx.reply(t('menuCmdNotFound') || 'Command not found.');
                return;
            }
            const lang = getLanguage();
            const { text, keyboard } = buildCommandDetailMessage(cmd, lang);
            try {
                await ctx.editMessageText(text, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } catch (_) {
                await ctx.reply(text, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            }
        });

        // Action: Prompt user to search commands (Fix #15: search within bot widgets without sending to IDE)
        bot.action('widget_search:prompt', async (ctx) => {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            const chatId = ctx.chat?.id?.toString();
            if (chatId) {
                pendingUserInputMap.set(chatId, { type: 'cmd_search' });
            }
            const isAr = getLanguage() === 'ar';
            const promptMsg = isAr
                ? '🔍 أرسل كلمة للبحث في أوامر البوت (مثال: quota, files, status):'
                : '🔍 Type a keyword to search bot commands (e.g. quota, files, status):';

            await ctx.reply(promptMsg, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: isAr ? '❌ إلغاء البحث' : '❌ Cancel Search', callback_data: 'awaiting_cancel' }]
                    ]
                }
            });
        });

        // Action: Header noop
        bot.action('widget_header:noop', async (ctx) => {
            try { await ctx.answerCbQuery(); } catch (_) {}
        });

        // Action: Execute command directly from Widget (Fix #2, #3, #4, #5, #6, #7, #8, #9, #10, #11, #16, #18, #19, #20, #21)
        bot.action(/^widget_exec:(.+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            const cmdId = ctx.match[1];
            const isAr = getLanguage() === 'ar';

            // Special virtual execution target: Screenshot Full Workspace (Fix #7)
            if (cmdId === 'screenshot_full') {
                try {
                    await ctx.answerCbQuery(isAr ? '📸 جاري التقاط شاشة مساحة العمل الكلية...' : '📸 Capturing full workspace...');
                } catch (_) {}
                await handleZoneScreenshot(ctx, 'full');
                return;
            }

            const cmd = ALL_COMMANDS.find(c => c.id === cmdId);
            if (!cmd) {
                await ctx.answerCbQuery(t('menuCmdNotFound') || 'Command not found');
                return;
            }

            // ── Commands with arguments: Present smart UI instead of manual typing prompts ──
            if (cmd.hasArgs) {
                try { await ctx.answerCbQuery(); } catch (_) {}

                // Fix #3: History — show count selection buttons
                if (cmd.id === 'history') {
                    await ctx.reply(isAr ? '📜 اختر عدد الرسائل لاسترجاعها:' : '📜 Select how many messages to retrieve:', {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '5', callback_data: 'history_count:5' },
                                    { text: '10', callback_data: 'history_count:10' },
                                    { text: '15', callback_data: 'history_count:15' },
                                    { text: '20', callback_data: 'history_count:20' }
                                ],
                                [{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]
                            ]
                        }
                    });
                    return;
                }

                // Fix #5: Answer — show pending question options as buttons
                if (cmd.id === 'answer') {
                    const port = getDebuggingPort();
                    try {
                        const questionData = await getPendingAgentQuestion(port);
                        if (questionData && questionData.hasQuestion) {
                            await sendQuestionToTelegram(ctx, questionData, port);
                        } else {
                            await ctx.reply(t('noPendingQuestion') || 'ℹ️ No pending questions from the Agent right now.', {
                                reply_markup: {
                                    inline_keyboard: [[
                                        { text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }
                                    ]]
                                }
                            });
                        }
                    } catch (e: any) {
                        ctx.reply(t('error', { msg: e.message }));
                    }
                    return;
                }

                // Fix #19: Switch Model — show model list as buttons
                if (cmd.id === 'switchmodel') {
                    const port = getDebuggingPort();
                    try {
                        const result = await getAvailableModels(port);
                        if (!result || !result.models || result.models.length === 0) {
                            await ctx.reply(t('noModelsFound') || 'No models found.');
                            return;
                        }
                        let message = `${t('modelsListTitle') || '🤖 *Available AI Models*'}\n\n`;
                        for (const m of result.models) {
                            const badge = m.isCurrent ? ' 🟢 *(Active)*' : '';
                            message += `${m.index}. *${m.label}*${badge}\n`;
                        }
                        const inlineButtons = result.models.map((m) => {
                            const prefix = m.isCurrent ? '🟢 ' : '';
                            const shortLabel = m.label.length > 25 ? m.label.substring(0, 22) + '...' : m.label;
                            return [{
                                text: `${prefix}${m.index}. ${shortLabel}`,
                                callback_data: `switch_model:${m.index}`
                            }];
                        });
                        inlineButtons.push([{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]);
                        await ctx.reply(message, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: inlineButtons }
                        });
                    } catch (e: any) {
                        ctx.reply(t('error', { msg: e.message }));
                    }
                    return;
                }

                // Fix #20: Switch Account — show accounts list as buttons
                if (cmd.id === 'switch') {
                    try {
                        const accountMgr = AccountManager.getInstance();
                        const current = accountMgr.getCurrentAccount();
                        const stored = accountMgr.getStoredAccounts();
                        if (stored.length === 0) {
                            await ctx.reply(isAr ? '⚠️ لا توجد حسابات محفوظة. استخدم /save_account أولاً.' : '⚠️ No accounts saved yet. Use /save_account first.');
                            return;
                        }
                        let message = `👥 *${isAr ? 'اختر حساباً للتبديل إليه:' : 'Select account to switch to:'}*\n\n`;
                        stored.forEach((acc, index) => {
                            const isActive = current && current.email.toLowerCase() === acc.email.toLowerCase();
                            const badge = isActive ? ' 🟢 *(Active)*' : '';
                            message += `${index + 1}. *${acc.name}*${badge}\n   📧 \`${acc.email}\`\n`;
                        });
                        const inlineButtons = stored.map((acc, index) => {
                            const isActive = current && current.email.toLowerCase() === acc.email.toLowerCase();
                            const prefix = isActive ? '🟢 ' : '';
                            const shortName = acc.name.length > 20 ? acc.name.substring(0, 17) + '...' : acc.name;
                            return [{
                                text: `${prefix}${index + 1}. ${shortName}`,
                                callback_data: `switch_account:${index + 1}`
                            }];
                        });
                        inlineButtons.push([{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]);
                        await ctx.reply(message, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: inlineButtons }
                        });
                    } catch (e: any) {
                        ctx.reply(t('error', { msg: e.message }));
                    }
                    return;
                }

                // Fix #21: CMD — activate awaiting state for shell input
                if (cmd.id === 'cmd') {
                    const chatId = ctx.chat?.id?.toString();
                    if (chatId) { pendingUserInputMap.set(chatId, { type: 'terminal_cmd' }); }
                    await ctx.reply(isAr
                        ? '⌨️ أرسل الأمر المراد تنفيذه في الطرفية (Terminal):'
                        : '⌨️ Type the shell command to execute in the Terminal:', {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: isAr ? '❌ إلغاء' : '❌ Cancel', callback_data: 'awaiting_cancel' }
                            ]]
                        }
                    });
                    return;
                }

                // Generic fallback for other argument commands
                const hint = cmd.argHint ? ` ${cmd.argHint}` : '';
                await ctx.reply(
                    (t('menuProvideArgs') || 'ℹ️ This command requires parameters.\nPlease send:\n`{cmd} {hint}`')
                        .replace('{cmd}', cmd.command)
                        .replace('{hint}', hint),
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            try {
                await ctx.answerCbQuery((t('menuExecuting') || '⚡ Executing: {cmd}...').replace('{cmd}', cmd.command));
            } catch (_) {}

            // Dispatch execution directly without fake message loop (Fix #2, #4, #6, #8, #9, #10, #11, #16, #18)
            switch (cmd.id) {
                case 'status':
                    await handleStatusCommand(ctx);
                    break;
                case 'history':
                    await handleHistoryCommand(ctx, 5);
                    break;
                // Fix #10: Screenshot — present the 4 workspace zones selection menu
                case 'screenshot':
                    await sendScreenshotZoneMenu(ctx);
                    break;
                case 'stop': {
                    const port = getDebuggingPort();
                    try {
                        const res = await stopAgent(port);
                        if (res.success) await ctx.reply(t('agentStopped'));
                        else await ctx.reply(t('agentNotRunning'));
                    } catch (e: any) {
                        ctx.reply(t('error', { msg: e.message }));
                    }
                    break;
                }
                // Fix #8: Check — execute check directly
                case 'check': {
                    const port = getDebuggingPort();
                    await ctx.reply(t('checkingStatus'));
                    try {
                        const questionData = await getPendingAgentQuestion(port);
                        if (questionData && questionData.hasQuestion) {
                            await sendQuestionToTelegram(ctx, questionData, port);
                            return;
                        }
                        const status = await checkAgentCurrentStatus(port);
                        const captionText = !status.isGenerating ? t('agentFinished') : t('agentProcessing');
                        try {
                            const { buffer } = await captureAgentScreenshot(port);
                            await sendTelegramPhoto(ctx, ctx.chat?.id, buffer, { caption: captionText });
                        } catch (_) {
                            const fb = await screenshot({ format: 'jpg' });
                            await sendTelegramPhoto(ctx, ctx.chat?.id, fb, { caption: captionText });
                        }
                        await sendLatestConversationText(ctx, port, 'widget/check');
                    } catch (e: any) {
                        ctx.reply(t('error', { msg: e.message }));
                    }
                    break;
                }
                // Fix #18: Quota — execute directly
                case 'quota': {
                    const msg = await ctx.reply(t('findingProcess') || 'Checking quota...');
                    try {
                        const snapshot = await fetchQuotaInfo(getLanguage());
                        let replyText = `${t('quotaTitle') || '📊 *Antigravity Quota Info*'}\n\n`;
                        if (snapshot.user_info) {
                            const u = snapshot.user_info;
                            const tierName = u.tier || u.planName || '';
                            const userLabel = u.name ? (u.email ? `${u.name} (${u.email})` : u.name) : (u.email || '');
                            if (userLabel || tierName) {
                                replyText += `👤 *Account:* ${userLabel}${tierName ? ` [${tierName}]` : ''}\n`;
                            }
                        }
                        if (snapshot.prompt_credits) {
                            const pc = snapshot.prompt_credits;
                            replyText += `💳 Prompt Credits: ${pc.available.toLocaleString()}/${pc.monthly.toLocaleString()} (${pc.remaining_percentage.toFixed(1)}%)\n`;
                        }
                        if (snapshot.flow_credits) {
                            const fc = snapshot.flow_credits;
                            replyText += `⚡ Flow Credits: ${fc.available.toLocaleString()}/${fc.monthly.toLocaleString()} (${fc.remaining_percentage.toFixed(1)}%)\n`;
                        }

                        replyText += '\n';

                        if (snapshot.model_groups && snapshot.model_groups.length > 0) {
                            for (const group of snapshot.model_groups) {
                                replyText += `*${group.title}* ℹ️\n`;
                                for (const limit of group.limits) {
                                    const pctStr = `${limit.remaining_percentage}%`;
                                    replyText += `  • *${limit.name}*: *${pctStr}*\n`;
                                    if (limit.subtitle) {
                                        replyText += `    _${limit.subtitle}_\n`;
                                    }
                                }
                                replyText += `\n`;
                            }
                        } else if (snapshot.models && snapshot.models.length > 0) {
                            replyText += `*${t('modelsTitle') || 'AI Models:'}*\n`;
                            for (const model of snapshot.models) {
                                const pct = model.remaining_percentage !== undefined ? `${model.remaining_percentage.toFixed(1)}%` : 'N/A';
                                replyText += `• *${model.label}*: ${pct} (⏱ ${model.time_until_reset_formatted})\n`;
                            }
                        }

                        await bot!.telegram.editMessageText(ctx.chat!.id, msg.message_id, undefined, replyText, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]]
                            }
                        });
                    } catch (e: any) {
                        await bot!.telegram.editMessageText(ctx.chat!.id, msg.message_id, undefined, `❌ ${e.message}`);
                    }
                    break;
                }
                // Fix #2: Chats — execute directly
                case 'chats': {
                    const port = getDebuggingPort();
                    await ctx.reply(t('fetchingChats') || 'Fetching conversations...');
                    try {
                        const conversations = await getAgentConversationsList(port);
                        if (!conversations || conversations.length === 0) {
                            await ctx.reply(t('noChatsFound') || 'No conversations found.');
                            return;
                        }
                        const { message, plainMessage } = buildConversationsMessage(conversations, isAr);
                        const inlineButtons = conversations.slice(0, 10).map((c) => {
                            const prefix = c.isCurrent ? '🟢 ' : '';
                            const shortTitle = c.title.length > 22 ? c.title.substring(0, 19) + '...' : c.title;
                            return [{ text: `${prefix}${c.index}. ${shortTitle}`, callback_data: `switch_chat:${c.index}` }];
                        });
                        inlineButtons.push([{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]);
                        await sendSafeReply(ctx, message, plainMessage, { inline_keyboard: inlineButtons });
                    } catch (e: any) {
                        ctx.reply(t('error', { msg: e.message }));
                    }
                    break;
                }
                case 'newchat': {
                    const port = getDebuggingPort();
                    try {
                        const result = await startNewConversation(port);
                        if (result.success) await ctx.reply(t('newChatSuccess'));
                        else await ctx.reply(t('newChatError', { msg: result.message || 'Button not found' }));
                    } catch (e: any) { ctx.reply(t('error', { msg: e.message })); }
                    break;
                }
                // Fix #18: Models — execute directly
                case 'models': {
                    const port = getDebuggingPort();
                    await ctx.reply(t('fetchingModels') || 'Fetching models...');
                    try {
                        const result = await getAvailableModels(port);
                        if (!result || !result.models || result.models.length === 0) {
                            await ctx.reply(t('noModelsFound') || 'No models found.');
                            return;
                        }
                        let message = `${t('modelsListTitle') || '🤖 *Available AI Models*'}\n\n`;
                        for (const m of result.models) {
                            const badge = m.isCurrent ? ' 🟢 *(Active)*' : '';
                            message += `${m.index}. *${m.label}*${badge}\n`;
                        }
                        const inlineButtons = result.models.map((m) => {
                            const prefix = m.isCurrent ? '🟢 ' : '';
                            const shortLabel = m.label.length > 25 ? m.label.substring(0, 22) + '...' : m.label;
                            return [{ text: `${prefix}${m.index}. ${shortLabel}`, callback_data: `switch_model:${m.index}` }];
                        });
                        inlineButtons.push([{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]);
                        await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineButtons } });
                    } catch (e: any) { ctx.reply(t('error', { msg: e.message })); }
                    break;
                }
                // Fix #18: Accounts — execute directly
                case 'accounts': {
                    try {
                        const accountMgr = AccountManager.getInstance();
                        const current = accountMgr.getCurrentAccount();
                        const stored = accountMgr.getStoredAccounts();
                        let text = `👥 *Antigravity Accounts*\n\n`;
                        if (current) {
                            text += `🟢 *Active:* ${current.name} (${current.email})\n\n`;
                        } else {
                            text += `⚪ *Active:* _None / Logged out_\n\n`;
                        }
                        if (stored.length === 0) {
                            text += `_No accounts saved yet._\n`;
                        } else {
                            text += `*Saved Accounts (${stored.length}):*\n`;
                            stored.forEach((acc, index) => {
                                const isActive = current && current.email.toLowerCase() === acc.email.toLowerCase();
                                const badge = isActive ? ' [ACTIVE]' : '';
                                text += `${index + 1}. *${acc.name}*${badge}\n   📧 \`${acc.email}\`\n`;
                            });
                        }
                        await ctx.reply(text, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: [[{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]] }
                        });
                    } catch (e: any) { ctx.reply(`❌ ${e.message}`); }
                    break;
                }
                // Fix #4: Question — execute directly
                case 'question': {
                    const port = getDebuggingPort();
                    try {
                        await ctx.reply(t('checkingStatus'));
                        const questionData = await getPendingAgentQuestion(port);
                        if (questionData && questionData.hasQuestion) {
                            await sendQuestionToTelegram(ctx, questionData, port);
                        } else {
                            await ctx.reply(t('noPendingQuestion') || 'ℹ️ No pending questions from the Agent.', {
                                reply_markup: { inline_keyboard: [[{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]] }
                            });
                        }
                    } catch (e: any) { ctx.reply(t('error', { msg: e.message })); }
                    break;
                }
                // Fix #9: Alarm — execute directly
                case 'alarm': {
                    const chatIdStr = ctx.chat?.id?.toString();
                    if (!chatIdStr) break;
                    if (activeAlarms.has(chatIdStr)) {
                        await ctx.reply(isAr ? '🔔 المراقبة نشطة بالفعل...' : '🔔 Already monitoring agent...');
                        break;
                    }
                    const port = getDebuggingPort();
                    await ctx.reply(t('alarmStarted'));
                    activeAlarms.add(chatIdStr);
                    // Run alarm monitoring in background
                    (async () => {
                        try {
                            let finished = false;
                            const maxAttempts = 30;
                            for (let i = 0; i < maxAttempts; i++) {
                                finished = await waitForAgentResponse(port, 45000);
                                if (finished) break;
                                if (i > 0 && i % 10 === 0) {
                                    await bot!.telegram.sendMessage(chatIdStr, t('alarmMonitoring'));
                                }
                            }
                            if (finished) {
                                const questionData = await getPendingAgentQuestion(port);
                                if (questionData && questionData.hasQuestion) {
                                    await sendQuestionToTelegram(chatIdStr, questionData, port);
                                } else {
                                    await sendCompletionScreenshotAndText(ctx, port, t('alarmFinished'), '/alarm');
                                }
                            } else {
                                await bot!.telegram.sendMessage(chatIdStr, t('timeoutError'));
                            }
                        } catch (e: any) {
                            await bot!.telegram.sendMessage(chatIdStr, t('error', { msg: e.message }));
                        } finally {
                            activeAlarms.delete(chatIdStr);
                        }
                    })();
                    break;
                }
                // Fix #11: Extensions — execute directly
                case 'extensions':
                    await sendExtensionsMenu(ctx, false, false);
                    break;
                // Fix #16: Files — execute directly
                case 'files': {
                    const workspaceRoot = getWorkspaceRoot();
                    if (!workspaceRoot) {
                        await ctx.reply(t('filesNoWorkspace') || 'No workspace folder open.');
                        break;
                    }
                    await sendFileListing(ctx, workspaceRoot, workspaceRoot, false);
                    break;
                }
                // Fix #6: Changes — execute directly
                case 'changes':
                    await handleChangesCommand(ctx);
                    break;
                // Fix #1: Expand — execute directly
                case 'expand':
                    await handleExpandCommand(ctx);
                    break;
                case 'recent':
                case 'backup':
                case 'sysinfo':
                case 'pc':
                case 'sleep':
                case 'lock':
                case 'abort': {
                    const fakeMsg: any = {
                        message_id: (ctx.callbackQuery as any)?.message?.message_id || 0,
                        date: Math.floor(Date.now() / 1000),
                        chat: ctx.chat,
                        from: ctx.from,
                        text: cmd.command
                    };
                    await (bot as any)?.handleUpdate({
                        update_id: Date.now(),
                        message: fakeMsg
                    });
                    break;
                }
                default:
                    await ctx.reply(`ℹ️ Send ${cmd.command} to run.`);
                    break;
            }
        });

        // ─── Callback Action Handlers for New Interactive Flows ───

        // Action: History Count Selection (Fix #3)
        bot.action(/^history_count:(\d+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            const count = parseInt(ctx.match[1], 10) || 5;
            await handleHistoryCommand(ctx, count);
        });

        // Action: Switch Account Selection (Fix #20)
        bot.action(/^switch_account:(\d+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            const index = parseInt(ctx.match[1], 10);
            try {
                const accountMgr = AccountManager.getInstance();
                const stored = accountMgr.getStoredAccounts();
                if (index >= 1 && index <= stored.length) {
                    const acc = stored[index - 1];
                    const result = accountMgr.switchAccount(acc.id);
                    await ctx.reply(`✅ *Account Switched!*\n\n👤 *Active:* ${result.account.name}\n📧 \`${result.account.email}\``, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: getLanguage() === 'ar' ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]]
                        }
                    });
                    if (statusBarManager) {
                        statusBarManager.update();
                    }
                }
            } catch (e: any) {
                ctx.reply(`❌ Switch failed: ${e.message}`);
            }
        });

        // Action: Capture Specific Workspace Zone (Fix #10)
        bot.action(/^zone_shot:(right|left|editor|terminal|full)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            const zone = ctx.match[1] as WorkspaceZone;
            try { await ctx.answerCbQuery(); } catch (_) {}
            await handleZoneScreenshot(ctx, zone);
        });

        // Action: Open Zone and Capture Screenshot (Fix #10)
        bot.action(/^zone_open_shot:(right|left|editor|terminal)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            const zone = ctx.match[1] as WorkspaceZone;
            try { await ctx.answerCbQuery(); } catch (_) {}

            if (zone === 'right') {
                try { await vscode.commands.executeCommand('workbench.action.chat.open'); } catch (_) {}
                try { await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar'); } catch (_) {}
            } else if (zone === 'left') {
                try { await vscode.commands.executeCommand('workbench.view.explorer'); } catch (_) {}
                try { await vscode.commands.executeCommand('workbench.action.focusSideBar'); } catch (_) {}
            } else if (zone === 'terminal') {
                try { await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal'); } catch (_) {}
                try { await vscode.commands.executeCommand('workbench.action.terminal.focus'); } catch (_) {}
            } else if (zone === 'editor') {
                try { await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup'); } catch (_) {}
            }

            // Allow UI time to render
            await new Promise(res => setTimeout(res, 800));
            await handleZoneScreenshot(ctx, zone);
        });

        // Action: Prompt for File Search within current folder (Fix #17)
        bot.action(/^fb_search:(.+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            const folderId = ctx.match[1];
            const targetPath = pathRegistry.resolve(folderId) || getWorkspaceRoot();
            const chatId = ctx.chat?.id?.toString();
            if (chatId && targetPath) {
                pendingUserInputMap.set(chatId, { type: 'file_search', data: targetPath });
            }
            const isAr = getLanguage() === 'ar';
            const relPath = targetPath && getWorkspaceRoot() ? path.relative(getWorkspaceRoot()!, targetPath) || '.' : '';
            const msg = isAr
                ? `🔍 أرسل اسم الملف أو جزءاً منه للبحث داخل:\n📁 \`${relPath || 'Workspace Root'}\``
                : `🔍 Send the file name or keyword to search within:\n📁 \`${relPath || 'Workspace Root'}\``;

            await ctx.reply(msg, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: isAr ? '❌ إلغاء البحث' : '❌ Cancel Search', callback_data: 'awaiting_cancel' }]
                    ]
                }
            });
        });

        // Action: Cancel Awaiting Input State (Fix #15, #17, #21)
        bot.action('awaiting_cancel', async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }
            const chatId = ctx.chat?.id?.toString();
            if (chatId) {
                pendingUserInputMap.delete(chatId);
            }
            try { await ctx.answerCbQuery(); } catch (_) {}
            const isAr = getLanguage() === 'ar';
            await ctx.reply(isAr ? '❌ تم إلغاء الإجراء.' : '❌ Action cancelled.', {
                reply_markup: {
                    inline_keyboard: [[{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]]
                }
            });
        });

        bot.command('ask', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            const parts = ctx.message.text.split(' ');
            parts.shift(); // remove /ask
            const query = parts.join(' ').trim();
            if (!query) { ctx.reply(t('askUsage')); return; }
            try {
                await sendToAgentChat(query);

                // Enable /alert notification by default when using /ask
                const chatId = ctx.chat.id.toString();
                activeAlarms.add(chatId);

                // Send confirmation including the default alert activation notice
                const sentNotice = `${t('askSent', { query })}\n\n${t('alarmStarted')}`;
                ctx.reply(sentNotice, { parse_mode: 'Markdown' });

                // Spawn background task to check when generating completes
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('agentThinking'),
                    cancellable: false
                }, () => runAgentProgressCheck(ctx));

            } catch (e: any) {
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        bot.command('check', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                await ctx.reply(t('unauthorized'));
                return;
            }
            const port = getDebuggingPort();
            await ctx.reply(t('checkingStatus'));

            try {
                // Check if an interactive question is waiting for an answer
                const questionData = await getPendingAgentQuestion(port);
                if (questionData && questionData.hasQuestion) {
                    await sendQuestionToTelegram(ctx, questionData, port);
                    return;
                }

                // Check agent status instantly without blocking polling loops
                const status = await checkAgentCurrentStatus(port);
                const isFinished = !status.isGenerating;
                const captionText = isFinished ? t('agentFinished') : t('agentProcessing');

                // Try capturing agent frame screenshot via CDP
                let screenshotSent = false;
                try {
                    const { buffer } = await captureAgentScreenshot(port);
                    await sendTelegramPhoto(ctx, ctx.chat?.id, buffer, { caption: captionText });
                    screenshotSent = true;
                } catch (screenshotErr: any) {
                    console.warn('[Telegram] CDP screenshot failed in /check, attempting fallback:', screenshotErr.message);
                    try {
                        // In-memory fallback capture to avoid disk locks on Windows
                        const fallbackBuffer = await screenshot({ format: 'jpg' });
                        await sendTelegramPhoto(ctx, ctx.chat?.id, fallbackBuffer, { caption: captionText });
                        screenshotSent = true;
                    } catch (fallbackErr: any) {
                        console.error('[Telegram] Fallback screenshot failed in /check:', fallbackErr.message);
                        try {
                            await ctx.reply(t('screenshotError', { msg: screenshotErr.message }));
                        } catch (e) {
                            // Suppress failure when sending error reply
                        }
                    }
                }

                // Retrieve and send the full conversation text
                // Extracted strictly as the latest conversation turn (last user prompt and agent response)
                await sendLatestConversationText(ctx, port, '/check');
            } catch (e: any) {
                console.error('[Telegram] Error in /check command:', e);
                try {
                    await ctx.reply(t('error', { msg: e.message }));
                } catch (replyErr: any) {
                    console.error('[Telegram] Failed to reply error in /check:', replyErr.message);
                }
            }
        });

        // Helper function to execute switching to an Antigravity agent conversation
        async function handleSwitchConversation(ctx: any, port: number, target: number | string) {
            let switchingMsg: any = null;
            try {
                // If this is a text command (not an inline callback), send temporary status message
                if (!ctx.callbackQuery) {
                    switchingMsg = await ctx.reply(t('switchingToChat'));
                } else {
                    try {
                        await ctx.answerCbQuery(t('switchingToChat'));
                    } catch (_) {}
                }

                // Trigger conversation switch via CDP
                const result = await switchToConversation(port, target);

                if (result.success) {
                    const activeIndex = Number(result.index || target);
                    const title = result.title || '';

                    // Update the inline keyboard buttons and message text of the /chats list if invoked from inline button
                    const targetMsg = ctx.callbackQuery?.message;
                    if (targetMsg) {
                        try {
                            // Give IDE UI a moment to settle
                            await new Promise(r => setTimeout(r, 350));
                            let freshConversations = await getAgentConversationsList(port);

                            if (!freshConversations || freshConversations.length === 0) {
                                // Fallback: update buttons from existing reply_markup
                                if (targetMsg.reply_markup?.inline_keyboard) {
                                    const updatedKeyboard = targetMsg.reply_markup.inline_keyboard.map((row: any[]) => {
                                        return row.map((btn: any) => {
                                            if (!btn || !btn.callback_data) return btn;
                                            if (btn.callback_data.startsWith('switch_chat:')) {
                                                const btnIdx = parseInt(btn.callback_data.split(':')[1], 10);
                                                const isTarget = btnIdx === activeIndex;
                                                const cleanText = btn.text.replace(/^🟢\s*/, '');
                                                return {
                                                    ...btn,
                                                    text: isTarget ? `🟢 ${cleanText}` : cleanText
                                                };
                                            }
                                            return btn;
                                        });
                                    });
                                    await ctx.editMessageReplyMarkup({ inline_keyboard: updatedKeyboard });
                                }
                            } else {
                                const isAr = getLanguage() === 'ar';
                                const { message, plainMessage } = buildConversationsMessage(freshConversations, isAr, activeIndex);

                                const updatedButtons = freshConversations.slice(0, 10).map((c) => {
                                    const isCur = (c.index === activeIndex) || c.isCurrent;
                                    const prefix = isCur ? '🟢 ' : '';
                                    const shortTitle = c.title.length > 22 ? c.title.substring(0, 19) + '...' : c.title;
                                    return [{
                                        text: `${prefix}${c.index}. ${shortTitle}`,
                                        callback_data: `switch_chat:${c.index}`
                                    }];
                                });
                                updatedButtons.push([{
                                    text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center',
                                    callback_data: 'widget_home:main'
                                }]);

                                try {
                                    await ctx.editMessageText(message, {
                                        parse_mode: 'Markdown',
                                        reply_markup: { inline_keyboard: updatedButtons }
                                    });
                                } catch (err: any) {
                                    try {
                                        await ctx.editMessageText(plainMessage, {
                                            reply_markup: { inline_keyboard: updatedButtons }
                                        });
                                    } catch (_) {
                                        try {
                                            await ctx.editMessageReplyMarkup({ inline_keyboard: updatedButtons });
                                        } catch (_) {}
                                    }
                                }
                            }
                        } catch (uiErr: any) {
                            console.warn('[Telegram] Failed to update chats message markup:', uiErr.message);
                        }
                    }

                    // Check if the selected conversation is already the current active one
                    const safeTitle = escapeMarkdownText(title);
                    if (result.isCurrent) {
                        try {
                            await ctx.reply(t('switchChatAlreadyActive', {
                                index: activeIndex.toString(),
                                title: safeTitle
                            }), { parse_mode: 'Markdown' });
                        } catch (_) {
                            await ctx.reply(t('switchChatAlreadyActive', {
                                index: activeIndex.toString(),
                                title: title
                            }));
                        }
                    } else {
                        // Send success confirmation message
                        try {
                            await ctx.reply(t('switchChatSuccess', {
                                index: activeIndex.toString(),
                                title: safeTitle
                            }), { parse_mode: 'Markdown' });
                        } catch (_) {
                            await ctx.reply(t('switchChatSuccess', {
                                index: activeIndex.toString(),
                                title: title
                            }));
                        }
                    }
                } else if (result.message === 'conversation_not_found') {
                    // Send conversation not found message
                    await ctx.reply(t('switchChatNotFound'));
                } else {
                    // Send error message with details
                    await ctx.reply(t('switchChatError', { msg: result.message || 'Unknown error' }));
                }

                // Delete temporary status message if possible
                try {
                    if (switchingMsg && switchingMsg.message_id) {
                        await ctx.deleteMessage(switchingMsg.message_id);
                    }
                } catch (_) { /* ignore deletion error */ }
            } catch (e: any) {
                // Log and reply if an unexpected error occurs during conversation switch
                console.error('[Telegram] Error switching conversation:', e);
                ctx.reply(t('error', { msg: e.message }));
            }
        }

        // Handler for /chats or /chat command to display the list of all Antigravity agent conversations
        bot.command(['chats', 'chat'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract optional conversation index or title parameter from message
            const parts = ctx.message.text.split(' ');
            parts.shift(); // remove command name
            const targetArg = parts.join(' ').trim();

            const port = getDebuggingPort();

            // If an argument was provided (e.g. /chat 2), switch directly to that conversation
            if (targetArg) {
                await handleSwitchConversation(ctx, port, targetArg);
                return;
            }

            await ctx.reply(t('fetchingChats'));

            try {
                const conversations = await getAgentConversationsList(port);
                if (!conversations || conversations.length === 0) {
                    await ctx.reply(t('noChatsFound'));
                    return;
                }

                const isAr = getLanguage() === 'ar';
                const { message, plainMessage } = buildConversationsMessage(conversations, isAr);

                // Build inline keyboard buttons to allow switching with a single tap
                const inlineButtons = conversations.slice(0, 10).map((c) => {
                    const prefix = c.isCurrent ? '🟢 ' : '';
                    const shortTitle = c.title.length > 22 ? c.title.substring(0, 19) + '...' : c.title;
                    return [{
                        text: `${prefix}${c.index}. ${shortTitle}`,
                        callback_data: `switch_chat:${c.index}`
                    }];
                });
                inlineButtons.push([{
                    text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center',
                    callback_data: 'widget_home:main'
                }]);

                await sendSafeReply(ctx, message, plainMessage, { inline_keyboard: inlineButtons });
            } catch (e: any) {
                console.error('[Telegram] Error in /chats command:', e);
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        // Handler for /switchchat or /switch_chat command to switch to a specific conversation
        bot.command(['switchchat', 'switch_chat'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract target parameter from command text
            const parts = ctx.message.text.split(' ');
            parts.shift(); // remove command name
            const targetParam = parts.join(' ').trim();

            const port = getDebuggingPort();

            // If no target parameter provided, display conversation list with buttons for easy selection
            if (!targetParam) {
                try {
                    await ctx.reply(t('fetchingChats'));
                    const conversations = await getAgentConversationsList(port);
                    if (!conversations || conversations.length === 0) {
                        await ctx.reply(t('noChatsFound'));
                        return;
                    }

                    const isAr = getLanguage() === 'ar';
                    const { message, plainMessage } = buildConversationsMessage(conversations, isAr);

                    // Create inline keyboard buttons for switching
                    const inlineButtons = conversations.slice(0, 10).map((c) => {
                        const prefix = c.isCurrent ? '🟢 ' : '';
                        const shortTitle = c.title.length > 22 ? c.title.substring(0, 19) + '...' : c.title;
                        return [{
                            text: `${prefix}${c.index}. ${shortTitle}`,
                            callback_data: `switch_chat:${c.index}`
                        }];
                    });
                    inlineButtons.push([{
                        text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center',
                        callback_data: 'widget_home:main'
                    }]);

                    await sendSafeReply(ctx, message, plainMessage, { inline_keyboard: inlineButtons });
                } catch (e: any) {
                    ctx.reply(t('error', { msg: e.message }));
                }
                return;
            }

            // Switch to the specified conversation index or title
            await handleSwitchConversation(ctx, port, targetParam);
        });

        // Callback query handler for inline button conversation switching
        bot.action(/^switch_chat:(\d+)$/, async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            // Acknowledge callback query to stop loading spinner in Telegram client
            try {
                await ctx.answerCbQuery();
            } catch (_) { /* ignore callback answer error */ }

            // Extract conversation index from regex match
            const indexStr = ctx.match[1];
            const targetIndex = parseInt(indexStr, 10);
            const port = getDebuggingPort();

            // Execute conversation switch
            await handleSwitchConversation(ctx, port, targetIndex);
        });

        // Handler for /newchat command to start a new Antigravity agent conversation
        bot.command('newchat', async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            // Retrieve configured debugging port
            const port = getDebuggingPort();
            try {
                // Trigger opening a new conversation via CDP
                const result = await startNewConversation(port);
                // Check if new conversation opened successfully
                if (result.success) {
                    // Send success confirmation message
                    await ctx.reply(t('newChatSuccess'));
                } else {
                    // Send error details if failed
                    await ctx.reply(t('newChatError', { msg: result.message || 'Button not found' }));
                }
            } catch (e: any) {
                // Reply with error message if an exception occurred
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        // Helper function to switch the active AI model in Antigravity chat
        async function handleSwitchModel(ctx: any, port: number, target: number | string) {
            try {
                // Send temporary notification indicating model switch is in progress
                const switchingMsg = await ctx.reply(t('switchingToModel', { model: target.toString() }));
                // Trigger model switch via CDP
                const result = await switchModel(port, target);

                // Check if model switch operation succeeded
                if (result.success) {
                    // Check if target model was already active
                    if (result.isCurrent) {
                        // Notify user that model is already active
                        await ctx.reply(t('switchModelAlreadyActive', {
                            model: result.currentModel || target.toString()
                        }), { parse_mode: 'Markdown' });
                    } else {
                        // Send success confirmation message
                        await ctx.reply(t('switchModelSuccess', {
                            model: result.currentModel || target.toString()
                        }), { parse_mode: 'Markdown' });
                    }
                } else if (result.message === 'model_not_found') {
                    // Send model not found message
                    await ctx.reply(t('switchModelNotFound'));
                } else {
                    // Send error details if failed
                    await ctx.reply(t('switchModelError', { msg: result.message || 'Unknown error' }));
                }

                // Delete temporary notification message if possible
                try {
                    // Verify if switchingMsg exists with valid ID
                    if (switchingMsg && switchingMsg.message_id) {
                        // Delete status message
                        await ctx.deleteMessage(switchingMsg.message_id);
                    }
                } catch (_) { /* ignore deletion error */ }
            } catch (e: any) {
                // Log error to console
                console.error('[Telegram] Error switching model:', e);
                // Reply with error message
                ctx.reply(t('error', { msg: e.message }));
            }
        }

        // Handler for /models and /model command to display or switch available AI models
        bot.command(['models', 'model'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract optional model argument from command text
            const parts = ctx.message.text.split(' ');
            // Remove command name prefix
            parts.shift();
            // Join remainder as target parameter
            const targetArg = parts.join(' ').trim();

            // Retrieve configured debugging port
            const port = getDebuggingPort();

            // If an argument was provided (e.g. /model 2 or /model claude), switch directly
            if (targetArg) {
                // Execute model switch immediately
                await handleSwitchModel(ctx, port, targetArg);
                // Finish execution
                return;
            }

            // Otherwise, inform user that models are being fetched
            await ctx.reply(t('fetchingModels'));

            try {
                // Fetch list of available models via CDP
                const result = await getAvailableModels(port);
                // Check if models were found
                if (!result || !result.models || result.models.length === 0) {
                    // Send no models found message
                    await ctx.reply(t('noModelsFound'));
                    // Return from handler
                    return;
                }

                // Build Markdown message showing available models
                let message = `${t('modelsListTitle')}\n\n`;
                // Append each model item to the message
                for (const m of result.models) {
                    // Format active badge if model is current
                    const badge = m.isCurrent ? ' 🟢 *(النشط / Active)*' : '';
                    // Append line with model number and name
                    message += `${m.index}. *${m.label}*${badge}\n`;
                }

                // Append usage hint
                message += `\n👉 *${t('switchModelHint')}* \`/switchmodel <رقم>\``;

                // Build inline keyboard buttons to allow switching models with a single tap
                const inlineButtons = result.models.map((m) => {
                    // Add green prefix if model is currently active
                    const prefix = m.isCurrent ? '🟢 ' : '';
                    // Truncate long labels for compact display
                    const shortLabel = m.label.length > 25 ? m.label.substring(0, 22) + '...' : m.label;
                    // Return button row with callback data
                    return [{
                        text: `${prefix}${m.index}. ${shortLabel}`,
                        callback_data: `switch_model:${m.index}`
                    }];
                });

                // Send message with inline keyboard
                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: inlineButtons
                    }
                });
            } catch (e: any) {
                // Log error to console
                console.error('[Telegram] Error in /models command:', e);
                // Reply with error message
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        // Handler for /switchmodel and /switch_model command to switch model by number or name
        bot.command(['switchmodel', 'switch_model'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract target parameter from command text
            const parts = ctx.message.text.split(' ');
            // Remove command name prefix
            parts.shift();
            // Join remainder as target parameter
            const targetParam = parts.join(' ').trim();

            // Retrieve configured debugging port
            const port = getDebuggingPort();

            // If no target parameter provided, display models list with buttons
            if (!targetParam) {
                try {
                    // Send fetching notification
                    await ctx.reply(t('fetchingModels'));
                    // Retrieve available models from CDP
                    const result = await getAvailableModels(port);
                    // Check if models were retrieved
                    if (!result || !result.models || result.models.length === 0) {
                        // Send no models found message
                        await ctx.reply(t('noModelsFound'));
                        // Return from handler
                        return;
                    }

                    // Build message header
                    let message = `${t('modelsListTitle')}\n\n`;
                    // Iterate through models
                    for (const m of result.models) {
                        // Format active badge
                        const badge = m.isCurrent ? ' 🟢 *(النشط / Active)*' : '';
                        // Append model row
                        message += `${m.index}. *${m.label}*${badge}\n`;
                    }
                    // Append usage instruction
                    message += `\n${t('switchModelUsage')}`;

                    // Create inline keyboard buttons for switching
                    const inlineButtons = result.models.map((m) => {
                        // Format prefix
                        const prefix = m.isCurrent ? '🟢 ' : '';
                        // Truncate label if necessary
                        const shortLabel = m.label.length > 25 ? m.label.substring(0, 22) + '...' : m.label;
                        // Return inline button row
                        return [{
                            text: `${prefix}${m.index}. ${shortLabel}`,
                            callback_data: `switch_model:${m.index}`
                        }];
                    });

                    // Send reply with inline buttons
                    await ctx.reply(message, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: inlineButtons
                        }
                    });
                } catch (e: any) {
                    // Reply with error message
                    ctx.reply(t('error', { msg: e.message }));
                }
                // Return from handler
                return;
            }

            // Switch to the specified model index or name
            await handleSwitchModel(ctx, port, targetParam);
        });

        // Callback query handler for inline button model switching
        bot.action(/^switch_model:(.+)$/, async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                // Reject unauthorized callback query
                await ctx.answerCbQuery(t('unauthorized'));
                // Return immediately
                return;
            }

            // Acknowledge callback query to stop loading spinner in Telegram client
            try {
                // Send acknowledgment to Telegram
                await ctx.answerCbQuery();
            } catch (_) { /* ignore callback answer error */ }

            // Extract target model from regex match
            const modelParam = ctx.match[1];
            // Retrieve configured debugging port
            const port = getDebuggingPort();

            // Execute model switch
            await handleSwitchModel(ctx, port, modelParam);
        });

        // Guard flag to prevent concurrent or replayed folder opening requests
        let isOpeningFolderInProgress = false;
        // In-memory cache mapping unique folder identifiers to recent folder items
        const recentFoldersMap = new Map<string, RecentFolderItem>();

        // Helper function to execute opening a recent folder or workspace in Antigravity IDE
        async function handleOpenRecentFolder(ctx: any, target: number | string) {
            // Prevent multiple simultaneous folder opens
            if (isOpeningFolderInProgress) {
                console.log('[Telegram] Folder open operation already in progress. Ignoring duplicate call.');
                return;
            }

            try {
                // Fetch list of recent folders from IDE
                const folders = await getRecentFolders();
                if (!folders || folders.length === 0) {
                    await ctx.reply(t('noRecentFound'));
                    return;
                }

                let matchedFolder: RecentFolderItem | undefined;

                if (typeof target === 'number') {
                    // Match by 1-based sequential index
                    matchedFolder = folders.find(f => f.index === target);
                } else {
                    const trimmed = target.trim();
                    // Check if target matches a unique cached identifier
                    if (recentFoldersMap.has(trimmed)) {
                        matchedFolder = recentFoldersMap.get(trimmed);
                    } else {
                        const numericIndex = parseInt(trimmed, 10);
                        if (!isNaN(numericIndex) && String(numericIndex) === trimmed) {
                            // Match numeric string parameter (e.g. "1")
                            matchedFolder = folders.find(f => f.index === numericIndex);
                        } else {
                            // Match by folder name or filesystem path (case-insensitive)
                            const searchLower = trimmed.toLowerCase();
                            matchedFolder = folders.find(f =>
                                f.name.toLowerCase() === searchLower ||
                                f.name.toLowerCase().includes(searchLower) ||
                                f.fsPath.toLowerCase().includes(searchLower)
                            );
                        }
                    }
                }

                if (!matchedFolder) {
                    await ctx.reply(t('recentNotFound'));
                    return;
                }

                // Check if the target folder is already the active workspace in the IDE
                if (matchedFolder.isCurrent) {
                    await ctx.reply(t('recentAlreadyOpen', { name: matchedFolder.name }), { parse_mode: 'Markdown' });
                    return;
                }

                // Set guard flag to lock further execution
                isOpeningFolderInProgress = true;

                // Send notification that the folder is being opened
                await ctx.reply(t('openingRecentFolder', { name: matchedFolder.name }), { parse_mode: 'Markdown' });

                // Send success confirmation message to Telegram before the window reloads
                await ctx.reply(t('recentOpenSuccess', { name: matchedFolder.name }), { parse_mode: 'Markdown' });

                // Allow 600ms for network buffers to flush to Telegram servers
                await new Promise(resolve => setTimeout(resolve, 600));

                // Cleanly stop the bot and release lock before window reload to avoid pending update loops
                try {
                    bot?.stop('SIGTERM');
                } catch (_) { /* ignore stop error */ }
                if (lockManager) {
                    try { lockManager.releaseLock(); } catch (_) { /* ignore lock release error */ }
                }

                // Execute opening the folder in the current window as configured
                await openRecentFolder(matchedFolder);
            } catch (e: any) {
                console.error('[Telegram] Error opening recent folder:', e);
                ctx.reply(t('error', { msg: e.message }));
            } finally {
                // Reset guard flag after a safety timeout in case open didn't cause an immediate window reload
                setTimeout(() => {
                    isOpeningFolderInProgress = false;
                }, 3000);
            }
        }

        // Handler for /recent command to list and open recently opened folders and workspaces
        bot.command(['recent', 'openrecent', 'recentfolder', 'recent_folder'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            // Extract optional folder index or name parameter from message
            const parts = ctx.message.text.split(' ');
            parts.shift(); // remove command name
            const targetArg = parts.join(' ').trim();

            // If an argument was provided (e.g. /recent 2 or /recent CyberTik), open directly
            if (targetArg) {
                await handleOpenRecentFolder(ctx, targetArg);
                return;
            }

            // Otherwise, fetch and display list of recent folders with inline buttons
            await ctx.reply(t('fetchingRecent'));

            try {
                const folders = await getRecentFolders();
                if (!folders || folders.length === 0) {
                    await ctx.reply(t('noRecentFound'));
                    return;
                }

                // Build Markdown message showing available recent folders
                let message = `${t('recentTitle')}\n\n`;
                for (const f of folders.slice(0, 15)) {
                    const badge = f.isCurrent ? ' 🟢' : '';
                    const typeIcon = f.isWorkspace ? '📦' : '📁';
                    message += `${f.index}. ${typeIcon} *${f.name}*${badge}\n\`${f.fsPath}\`\n\n`;
                }
                message += `${t('recentHint')}`;

                // Populate unique IDs in cache for each recent folder item
                recentFoldersMap.clear();
                // Create inline keyboard buttons for quick folder opening (up to 10 items)
                const inlineButtons = folders.slice(0, 10).map((f) => {
                    const prefix = f.isCurrent ? '🟢 ' : '';
                    const shortName = f.name.length > 22 ? f.name.substring(0, 19) + '...' : f.name;
                    // Generate safe, unique identifier for callback data (under 64 bytes)
                    const folderKey = `rf_${f.index}_${Buffer.from(f.name).toString('hex').slice(0, 16)}`;
                    recentFoldersMap.set(folderKey, f);
                    return [{
                        text: `${prefix}${f.index}. 📁 ${shortName}`,
                        callback_data: `open_recent:${folderKey}`
                    }];
                });

                await ctx.reply(message, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: inlineButtons
                    }
                });
            } catch (e: any) {
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        // Callback query handler for inline button recent folder opening
        bot.action(/^open_recent:(.+)$/, async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            // Acknowledge callback query immediately
            try {
                await ctx.answerCbQuery();
            } catch (_) { /* ignore callback answer error */ }

            // Remove inline keyboard buttons immediately to prevent duplicate clicks
            try {
                await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
            } catch (_) { /* ignore edit error */ }

            // Extract folder identifier from regex match
            const folderKey = ctx.match[1];

            // Execute folder opening
            await handleOpenRecentFolder(ctx, folderKey);
        });

        // Handler for /backup command to archive project files excluding gitignore entries and framework libraries
        bot.command(['backup', 'zip', 'project_backup'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract optional path argument from command text
            const parts = ctx.message.text.split(' ');
            // Remove command name prefix
            parts.shift();
            // Join remaining text as custom project folder path
            const customPath = parts.join(' ').trim() || undefined;

            // Check if a workspace folder is open when no custom path is provided
            if (!customPath && (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0)) {
                // Inform user that no workspace folder is currently open
                await ctx.reply(t('noWorkspaceForBackup'));
                // Return from handler
                return;
            }

            // Send notification that backup creation has started
            const progressMsg = await ctx.reply(t('creatingBackup'));

            try {
                // Execute project backup archiving
                const result = await createProjectBackup(customPath);

                // Check if backup operation was successful and file path is valid
                if (!result.success || !result.zipPath || !result.fileName || result.fileSize === undefined) {
                    // Send error message if backup failed
                    await ctx.reply(t('backupError', { msg: result.error || 'Failed to create backup file' }));
                    // Clean up progress message
                    try { if (progressMsg && progressMsg.message_id) { await ctx.deleteMessage(progressMsg.message_id); } } catch (_) {}
                    // Return from handler
                    return;
                }

                // Telegram Bot API maximum file upload limit (50 MB)
                const MAX_TELEGRAM_UPLOAD = 50 * 1024 * 1024;

                // Check if generated zip file is within Telegram upload limits
                if (result.fileSize <= MAX_TELEGRAM_UPLOAD) {
                    // Build success caption with file name, size, and file count
                    const caption = t('backupSuccess', {
                        fileName: result.fileName,
                        fileSize: result.fileSizeFormatted || `${(result.fileSize / 1024 / 1024).toFixed(2)} MB`,
                        fileCount: (result.fileCount || 0).toString()
                    });

                    // Track whether the document upload succeeded
                    let uploadSuccess = false;
                    // Track last encountered upload error
                    let lastUploadError: any = null;

                    // Retrieve bot token for direct transmission
                    const token = getToken();

                    // Retry up to 3 attempts to gracefully recover from socket reuse drops and transient ECONNRESET
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            if (token) {
                                // Upload directly via raw HTTPS multipart with explicit Content-Length and Connection: close
                                await sendDocumentDirect(token, ctx.chat.id, result.zipPath, result.fileName, caption);
                            } else {
                                // Fallback to Telegraf client
                                const fileBuffer = fs.readFileSync(result.zipPath);
                                await ctx.replyWithDocument(
                                    { source: fileBuffer, filename: result.fileName },
                                    { caption, parse_mode: 'Markdown' }
                                );
                            }
                            // Mark upload as successful
                            uploadSuccess = true;
                            // Exit retry loop
                            break;
                        } catch (uploadErr: any) {
                            // Capture error details
                            lastUploadError = uploadErr;
                            // Log retry attempt failure
                            console.warn(`[Telegram] Backup upload attempt ${attempt} failed:`, uploadErr?.message);
                            // Wait 1.5s before next attempt if attempts remain
                            if (attempt < 3) {
                                await new Promise(res => setTimeout(res, 1500));
                            }
                        }
                    }

                    // Check if file upload succeeded
                    if (uploadSuccess) {
                        // Clean up temporary zip file after successful transmission
                        try {
                            // Check if file still exists on disk
                            if (fs.existsSync(result.zipPath)) {
                                // Unlink temporary archive file
                                fs.unlinkSync(result.zipPath);
                            }
                        } catch (_) { /* ignore deletion error */ }
                    } else {
                        // If all upload attempts fail due to network reset, retain local file and provide full local path
                        await ctx.reply(t('backupUploadError', {
                            zipPath: result.zipPath,
                            fileSize: result.fileSizeFormatted || `${(result.fileSize / 1024 / 1024).toFixed(2)} MB`,
                            fileCount: (result.fileCount || 0).toString(),
                            error: lastUploadError?.message || 'Connection reset'
                        }), { parse_mode: 'Markdown' });
                    }
                } else {
                    // If archive exceeds 50MB, retain local file and notify user with full filesystem path
                    await ctx.reply(t('backupTooLarge', {
                        zipPath: result.zipPath,
                        fileSize: result.fileSizeFormatted || `${(result.fileSize / 1024 / 1024).toFixed(2)} MB`,
                        fileCount: (result.fileCount || 0).toString()
                    }), { parse_mode: 'Markdown' });
                }

                // Delete the initial progress notification message
                try {
                    // Check if progress message has a valid message ID
                    if (progressMsg && progressMsg.message_id) {
                        // Delete status message
                        await ctx.deleteMessage(progressMsg.message_id);
                    }
                } catch (_) { /* ignore deletion error */ }
            } catch (e: any) {
                // Log error to console
                console.error('[Telegram] Backup failed:', e);
                // Send error details to user
                ctx.reply(t('backupError', { msg: e.message }));
            }
        });

        // Handler for /files, /file, /ls, /dir to browse workspace files interactively
        bot.command(['files', 'file', 'ls', 'dir'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            const workspaceRoot = getWorkspaceRoot();
            if (!workspaceRoot) {
                await ctx.reply(t('filesNoWorkspace') || 'No workspace folder open in VS Code.');
                return;
            }

            const parts = ctx.message.text.split(' ');
            parts.shift();
            const subPath = parts.join(' ').trim();
            const targetPath = subPath ? path.resolve(workspaceRoot, subPath) : workspaceRoot;

            await sendFileListing(ctx, targetPath, workspaceRoot, false);
        });

        // Handler for /getfile, /get, /send to download any file to phone
        bot.command(['getfile', 'get', 'send'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            const parts = ctx.message.text.split(' ');
            parts.shift();
            const filePath = parts.join(' ').trim();

            if (!filePath) {
                await ctx.reply(t('getfileUsage') || '💡 Usage: /getfile <file path or name>');
                return;
            }

            await sendFileToChat(ctx, filePath);
        });

        // Handler for /getclipboard, /clipboard, /clip to fetch host clipboard
        bot.command(['getclipboard', 'clipboard', 'clip'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            try {
                const clipText = await vscode.env.clipboard.readText();
                if (!clipText || clipText.trim().length === 0) {
                    await ctx.reply(t('clipboardEmpty') || '📋 Clipboard is empty.');
                    return;
                }
                const truncated = clipText.substring(0, 3800);
                const title = t('clipboardContent') || 'Clipboard Content';
                await ctx.reply(`📋 *${title}:*\n\`\`\`\n${truncated}\n\`\`\``, {
                    parse_mode: 'Markdown'
                });
            } catch (e: any) {
                ctx.reply(t('clipboardError', { msg: e.message }) || `❌ Clipboard error: ${e.message}`);
            }
        });

        // Handler for /getlog, /log, /errors to send the latest log file
        bot.command(['getlog', 'log', 'errors'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            try {
                const candidates: string[] = [
                    path.join(process.env.APPDATA || os.homedir(), 'Antigravity IDE', 'logs'),
                    path.join(process.env.APPDATA || os.homedir(), 'Code', 'logs'),
                    path.join(os.homedir(), '.gemini', 'antigravity', 'logs'),
                    extensionContext?.logUri?.fsPath || ''
                ].filter(p => p && fs.existsSync(p));

                let latestLogPath: string | null = null;
                let latestMtime = 0;

                for (const logDir of candidates) {
                    try {
                        const files = fs.readdirSync(logDir, { withFileTypes: true });
                        for (const f of files) {
                            if (!f.isDirectory() && (f.name.endsWith('.log') || f.name.endsWith('.txt'))) {
                                const fullP = path.join(logDir, f.name);
                                const mt = fs.statSync(fullP).mtimeMs;
                                if (mt > latestMtime) {
                                    latestMtime = mt;
                                    latestLogPath = fullP;
                                }
                            }
                        }
                    } catch (_) {}
                }

                if (!latestLogPath) {
                    await ctx.reply(t('logFileNotFound') || 'ℹ️ No log files found.');
                    return;
                }

                await sendFileToChat(ctx, latestLogPath);
            } catch (e: any) {
                ctx.reply(t('logError', { msg: e.message }) || `❌ Error retrieving logs: ${e.message}`);
            }
        });

        // Callback handler for browsing folder: bf:<id> or refreshing folder: rf:<id>
        bot.action(/^(bf|rf):(.+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            const folderId = ctx.match[2];
            const targetPath = pathRegistry.resolve(folderId);
            const workspaceRoot = getWorkspaceRoot();

            if (!workspaceRoot) {
                await ctx.answerCbQuery(t('filesNoWorkspace') || 'No workspace open');
                return;
            }

            if (!targetPath) {
                await ctx.answerCbQuery(t('filesAccessDenied') || 'Path expired or not found');
                return;
            }

            try {
                await ctx.answerCbQuery();
            } catch (_) {}

            await sendFileListing(ctx, targetPath, workspaceRoot, true);
        });

        // Callback handler for downloading file: df:<id>
        bot.action(/^df:(.+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            const fileId = ctx.match[1];
            const filePath = pathRegistry.resolve(fileId);
            const workspaceRoot = getWorkspaceRoot();

            if (!workspaceRoot || !filePath) {
                await ctx.answerCbQuery(t('filesAccessDenied') || 'File not found');
                return;
            }

            try {
                await ctx.answerCbQuery(t('filesSendingFile') || '📤 Sending file...');
            } catch (_) {}

            await sendFileToChat(ctx, filePath);
        });

        // Handler for /extensions, /ext, /views, /sidebar to inspect sidebar extensions & panels
        bot.command(['extensions', 'ext', 'views', 'sidebar'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            await sendExtensionsMenu(ctx, false, false);
        });

        // Callback handler for focusing and capturing a sidebar view
        bot.action(/^ext_open:(.+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            const viewId = ctx.match[1];
            await openAndCaptureSidebarView(ctx, viewId);
        });

        // Callback handler for expanding/collapsing extra extensions in the menu
        bot.action(/^ext_toggle:(expand|collapse)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            try { await ctx.answerCbQuery(); } catch (_) {}
            const isExpanded = ctx.match[1] === 'expand';
            await sendExtensionsMenu(ctx, isExpanded, true);
        });

        // Callback handler for section headers (no-op)
        bot.action(/^ext_header:.+$/, async (ctx) => {
            try { await ctx.answerCbQuery(); } catch (_) {}
        });

        // Callback handler for returning to the main extensions menu
        bot.action(/^ext_list:main$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            try { await ctx.answerCbQuery(); } catch (_) {}
            await sendExtensionsMenu(ctx, false, false);
        });

        // Handler for /expand to expand all collapsed steps/diffs in chat and send screenshot
        bot.command(['expand', 'show', 'unfold'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            await handleExpandCommand(ctx);
        });

        // Handler for /changes to extract modified files and executed commands as text
        bot.command(['changes', 'diff', 'steps'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            await handleChangesCommand(ctx);
        });

        // Callback action to extract changes text from screenshot card
        bot.action('changes:get_text', async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            await handleChangesCommand(ctx);
        });

        // Callback action to refresh expanded screenshot
        bot.action('changes:refresh', async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            await handleExpandCommand(ctx);
        });

        // Callback action to capture expanded screenshot from changes text card
        bot.action('changes:screenshot', async (ctx) => {
            if (allowedChatId && ctx.chat?.id?.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            await handleExpandCommand(ctx);
        });

        bot.command('stop', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            const port = getDebuggingPort();
            await ctx.reply(t('stoppingAgent'));

            try {
                const result = await stopAgent(port);
                if (result.success) {
                    await ctx.reply(t('agentStopped'));
                } else {
                    await ctx.reply(t('agentNotRunning'));
                }
            } catch (e: any) {
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        // Support both /alarm and /alert aliases
        bot.command(['alarm', 'alert'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            const chatId = ctx.chat.id.toString();
            if (activeAlarms.has(chatId)) {
                // Quietly ignore or could send a "Already monitoring" message
                return;
            }

            const port = getDebuggingPort();
            await ctx.reply(t('alarmStarted'));
            activeAlarms.add(chatId);

            try {
                let finished = false;
                const maxAttempts = 30; // ~20 minutes max
                for (let i = 0; i < maxAttempts; i++) {
                    finished = await waitForAgentResponse(port, 45000);
                    if (finished) break;

                    // Periodically updated status if i is high
                    if (i > 0 && i % 10 === 0) {
                        await ctx.reply(t('alarmMonitoring'));
                    }
                }

                if (finished) {
                    // Check if an interactive question is waiting
                    const questionData = await getPendingAgentQuestion(port);
                    if (questionData && questionData.hasQuestion) {
                        await sendQuestionToTelegram(ctx, questionData, port);
                    } else {
                        await sendCompletionScreenshotAndText(ctx, port, t('alarmFinished'), '/alarm');
                    }
                } else {
                    ctx.reply(t('timeoutError'));
                }
            } catch (e: any) {
                ctx.reply(t('error', { msg: e.message }));
            } finally {
                activeAlarms.delete(chatId);
            }
        });

        bot.command('quota', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            const msg = await ctx.reply(t('findingProcess') || 'Checking quota...');
            try {
                const snapshot = await fetchQuotaInfo(getLanguage());

                let replyText = `${t('quotaTitle') || '📊 *Antigravity Quota Info*'}\n\n`;

                if (snapshot.user_info) {
                    const u = snapshot.user_info;
                    const tierName = u.tier || u.planName || '';
                    const userLabel = u.name ? (u.email ? `${u.name} (${u.email})` : u.name) : (u.email || '');
                    if (userLabel || tierName) {
                        replyText += `👤 *${t('accountTitle') || 'Account:'}* ${userLabel}${tierName ? ` [${tierName}]` : ''}\n`;
                    }
                }

                if (snapshot.prompt_credits) {
                    const pc = snapshot.prompt_credits;
                    const pcStr = (t('promptCredits') || 'Prompt Credits: {available}/{monthly} ({remaining}%)')
                        .replace('{available}', pc.available.toLocaleString())
                        .replace('{monthly}', pc.monthly.toLocaleString())
                        .replace('{remaining}', pc.remaining_percentage.toFixed(1));
                    replyText += `💳 ${pcStr}\n`;
                }

                if (snapshot.flow_credits) {
                    const fc = snapshot.flow_credits;
                    const fcStr = (t('flowCredits') || 'Flow Credits: {available}/{monthly} ({remaining}%)')
                        .replace('{available}', fc.available.toLocaleString())
                        .replace('{monthly}', fc.monthly.toLocaleString())
                        .replace('{remaining}', fc.remaining_percentage.toFixed(1));
                    replyText += `⚡ ${fcStr}\n`;
                }

                replyText += `\n`;

                if (snapshot.model_groups && snapshot.model_groups.length > 0) {
                    for (const group of snapshot.model_groups) {
                        replyText += `*${group.title}* ℹ️\n`;
                        for (const limit of group.limits) {
                            const pctStr = `${limit.remaining_percentage}%`;
                            replyText += `  • *${limit.name}*: *${pctStr}*\n`;
                            if (limit.subtitle) {
                                replyText += `    _${limit.subtitle}_\n`;
                            }
                        }
                        replyText += `\n`;
                    }
                } else if (snapshot.models && snapshot.models.length > 0) {
                    replyText += `*${t('modelsTitle') || 'AI Models:'}*\n`;
                    for (const model of snapshot.models) {
                        const pct = model.remaining_percentage !== undefined ? `${model.remaining_percentage.toFixed(1)}%` : 'N/A';
                        replyText += `• *${model.label}*: ${pct} (⏱ ${model.time_until_reset_formatted})\n`;
                    }
                } else {
                    replyText += `_${t('noQuotaInfo') || 'No active model quota information found.'}_\n`;
                }

                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    msg.message_id,
                    undefined,
                    replyText,
                    { parse_mode: 'Markdown' }
                );
            } catch (e: any) {
                const errMessage = e.message || '';
                let userFriendlyErr = '';
                if (errMessage.toLowerCase().includes('process not found')) {
                    userFriendlyErr = t('noProcessFound') || '❌ Antigravity language server is not running.';
                } else {
                    userFriendlyErr = (t('fetchError') || '❌ Failed to fetch quota: {msg}').replace('{msg}', errMessage);
                }

                await ctx.telegram.editMessageText(
                    ctx.chat.id,
                    msg.message_id,
                    undefined,
                    userFriendlyErr
                );
            }
        });

        bot.command('accounts', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            try {
                const accountMgr = AccountManager.getInstance();
                const current = accountMgr.getCurrentAccount();
                const stored = accountMgr.getStoredAccounts();

                let text = `👥 *Antigravity Accounts*\n\n`;
                if (current) {
                    text += `🟢 *Active:* ${current.name} (${current.email})\n\n`;
                } else {
                    text += `⚪ *Active:* _None / Logged out_\n\n`;
                }

                if (stored.length === 0) {
                    text += `_No accounts saved yet. Use /save_account to save the current account._\n`;
                } else {
                    text += `*Saved Accounts (${stored.length}):*\n`;
                    stored.forEach((acc, index) => {
                        const isActive = current && current.email.toLowerCase() === acc.email.toLowerCase();
                        const badge = isActive ? ' [ACTIVE]' : '';
                        text += `${index + 1}. *${acc.name}*${badge}\n`;
                        text += `   📧 \`${acc.email}\`\n`;
                        text += `   🆔 \`/switch ${index + 1}\` or \`/switch ${acc.id}\`\n\n`;
                    });
                }

                text += `\n💡 *Commands:*\n• \`/save_account [name]\` — Save current login\n• \`/switch <1-${stored.length || 1}>\` — Switch account\n• \`/rotate_account\` — Rotate to next account`;

                ctx.reply(text, { parse_mode: 'Markdown' });
            } catch (e: any) {
                ctx.reply(`❌ Failed to list accounts: ${e.message}`);
            }
        });

        bot.command('switch', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            const parts = ctx.message.text.split(' ');
            parts.shift(); // remove /switch
            const targetParam = parts.join(' ').trim();
            if (!targetParam) {
                ctx.reply(`Usage: /switch <account_number, email, or id>\n\nUse /accounts to see list.`);
                return;
            }

            try {
                const accountMgr = AccountManager.getInstance();
                const stored = accountMgr.getStoredAccounts();

                let identifier = targetParam;
                const indexNum = parseInt(targetParam, 10);
                if (!isNaN(indexNum) && indexNum >= 1 && indexNum <= stored.length) {
                    identifier = stored[indexNum - 1].id;
                }

                const result = accountMgr.switchAccount(identifier);
                await ctx.reply(`✅ *Account Switched Successfully!*\n\n👤 *Active Account:* ${result.account.name}\n📧 *Email:* \`${result.account.email}\`\n\n_Credentials updated in IDE database._`, { parse_mode: 'Markdown' });

                // Refresh quota status bar
                if (statusBarManager) {
                    statusBarManager.update();
                }
            } catch (e: any) {
                ctx.reply(`❌ Switch failed: ${e.message}`);
            }
        });

        bot.command('save_account', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            const parts = ctx.message.text.split(' ');
            parts.shift();
            const customName = parts.join(' ').trim();

            try {
                const accountMgr = AccountManager.getInstance();
                const saved = accountMgr.saveCurrentAccount(customName || undefined);
                if (saved) {
                    ctx.reply(`✅ *Account Saved to Storage!*\n\n👤 *Name:* ${saved.name}\n📧 *Email:* \`${saved.email}\`\n🆔 *ID:* \`${saved.id}\``, { parse_mode: 'Markdown' });
                } else {
                    ctx.reply(`❌ No active account found in Antigravity IDE.`);
                }
            } catch (e: any) {
                ctx.reply(`❌ Failed to save account: ${e.message}`);
            }
        });

        bot.command('rotate_account', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            try {
                const accountMgr = AccountManager.getInstance();
                const rotated = accountMgr.rotateAccount();
                if (rotated) {
                    ctx.reply(`🔄 *Rotated to Next Account!*\n\n👤 *Active Account:* ${rotated.name}\n📧 *Email:* \`${rotated.email}\``, { parse_mode: 'Markdown' });
                    if (statusBarManager) {
                        statusBarManager.update();
                    }
                } else {
                    ctx.reply(`ℹ️ Need at least 2 saved accounts to rotate. Use /save_account to add accounts.`);
                }
            } catch (e: any) {
                ctx.reply(`❌ Rotate failed: ${e.message}`);
            }
        });

        bot.command('delete_account', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            const parts = ctx.message.text.split(' ');
            parts.shift();
            const targetParam = parts.join(' ').trim();
            if (!targetParam) {
                ctx.reply(`Usage: /delete_account <index, email, or id>`);
                return;
            }

            try {
                const accountMgr = AccountManager.getInstance();
                const stored = accountMgr.getStoredAccounts();
                let identifier = targetParam;
                const indexNum = parseInt(targetParam, 10);
                if (!isNaN(indexNum) && indexNum >= 1 && indexNum <= stored.length) {
                    identifier = stored[indexNum - 1].id;
                }

                const deleted = accountMgr.deleteAccount(identifier);
                if (deleted) {
                    ctx.reply(`🗑️ *Account Deleted from Storage.*`, { parse_mode: 'Markdown' });
                } else {
                    ctx.reply(`❌ Account '${targetParam}' not found in storage.`);
                }
            } catch (e: any) {
                ctx.reply(`❌ Delete failed: ${e.message}`);
            }
        });

        bot.command('cmd', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            const parts = ctx.message.text.split(' ');
            parts.shift(); // remove /cmd
            const cmd = parts.join(' ').trim();
            if (!cmd) { ctx.reply(t('cmdUsage')); return; }
            const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Telegram');
            terminal.show();
            terminal.sendText(cmd);
            ctx.reply(t('cmdExecuted', { cmd }));
        });

        // Handler for /shutdown command to shut down the computer
        bot.command('shutdown', async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract optional arguments (e.g. "now" or seconds)
            const parts = ctx.message.text.split(' ');
            parts.shift();
            const arg = parts.join(' ').trim().toLowerCase();

            // If user supplied "now", trigger immediate shutdown
            if (arg === 'now') {
                await ctx.reply(t('pcShutdownNow'));
                await shutdownSystem(0);
                return;
            }

            // If user supplied a numeric delay in seconds (e.g. /shutdown 60)
            const seconds = parseInt(arg, 10);
            if (!isNaN(seconds) && seconds > 0) {
                await ctx.reply(t('pcShutdownScheduled', { seconds: seconds.toString() }));
                await shutdownSystem(seconds);
                return;
            }

            // Otherwise, show confirmation dialog with interactive inline buttons
            await ctx.reply(t('pcShutdownConfirm'), {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔴 Shutdown Now', callback_data: 'pc_action:shutdown:now' },
                            { text: '⏱️ In 60s', callback_data: 'pc_action:shutdown:60' }
                        ],
                        [
                            { text: '❌ Cancel', callback_data: 'pc_action:cancel' }
                        ]
                    ]
                }
            });
        });

        // Handler for /restart and /reboot command to restart the computer
        bot.command(['restart', 'reboot'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract optional arguments (e.g. "now" or seconds)
            const parts = ctx.message.text.split(' ');
            parts.shift();
            const arg = parts.join(' ').trim().toLowerCase();

            // If user supplied "now", trigger immediate restart
            if (arg === 'now') {
                await ctx.reply(t('pcRestartNow'));
                await restartSystem(0);
                return;
            }

            // If user supplied a numeric delay in seconds (e.g. /restart 60)
            const seconds = parseInt(arg, 10);
            if (!isNaN(seconds) && seconds > 0) {
                await ctx.reply(t('pcRestartScheduled', { seconds: seconds.toString() }));
                await restartSystem(seconds);
                return;
            }

            // Otherwise, show confirmation dialog with interactive inline buttons
            await ctx.reply(t('pcRestartConfirm'), {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🔄 Restart Now', callback_data: 'pc_action:restart:now' },
                            { text: '⏱️ In 60s', callback_data: 'pc_action:restart:60' }
                        ],
                        [
                            { text: '❌ Cancel', callback_data: 'pc_action:cancel' }
                        ]
                    ]
                }
            });
        });

        // Handler for /sleep command to put the computer into sleep mode
        bot.command('sleep', async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Extract optional arguments (e.g. "now")
            const parts = ctx.message.text.split(' ');
            parts.shift();
            const arg = parts.join(' ').trim().toLowerCase();

            // If user supplied "now", trigger immediate sleep
            if (arg === 'now') {
                await ctx.reply(t('pcSleepSuccess'));
                await sleepSystem();
                return;
            }

            // Otherwise, prompt for confirmation with inline buttons
            await ctx.reply(t('pcSleepConfirm'), {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '💤 Sleep Now', callback_data: 'pc_action:sleep:now' },
                            { text: '❌ Cancel', callback_data: 'pc_action:cancel' }
                        ]
                    ]
                }
            });
        });

        // Handler for /lock command to lock the workstation screen immediately
        bot.command(['lock', 'lockscreen'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            try {
                // Execute screen locking
                const res = await lockWorkstation();
                if (res.success) {
                    await ctx.reply(t('pcLockSuccess'));
                } else {
                    await ctx.reply(t('pcError', { msg: res.message || 'Failed to lock screen' }));
                }
            } catch (e: any) {
                await ctx.reply(t('pcError', { msg: e?.message || 'Lock error' }));
            }
        });

        // Handler for /abort or /cancelshutdown command to cancel pending shutdown or restart
        bot.command(['abort', 'cancelshutdown', 'cancel_shutdown'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            try {
                // Execute abort command
                const res = await abortShutdown();
                if (res.alreadyAborted) {
                    await ctx.reply(t('pcNoAbortPending'));
                } else if (res.success) {
                    await ctx.reply(t('pcAbortSuccess'));
                } else {
                    await ctx.reply(t('pcError', { msg: res.message || 'Abort failed' }));
                }
            } catch (e: any) {
                await ctx.reply(t('pcError', { msg: e?.message || 'Abort error' }));
            }
        });

        // Handler for /sysinfo or /pcinfo command to display system hardware and status
        bot.command(['sysinfo', 'pcinfo', 'system'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            try {
                // Generate and send system report
                const report = getSystemInfo();
                await ctx.reply(report, { parse_mode: 'Markdown' });
            } catch (e: any) {
                await ctx.reply(t('pcError', { msg: e?.message || 'System info error' }));
            }
        });

        // Handler for /pc or /power command to show quick control dashboard
        bot.command(['pc', 'power'], async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }

            // Display interactive PC actions menu
            await ctx.reply(t('pcTitle'), {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🛑 Shutdown', callback_data: 'pc_action:menu_shutdown' },
                            { text: '🔄 Restart', callback_data: 'pc_action:menu_restart' }
                        ],
                        [
                            { text: '💤 Sleep', callback_data: 'pc_action:menu_sleep' },
                            { text: '🔒 Lock Screen', callback_data: 'pc_action:lock' }
                        ],
                        [
                            { text: '📊 System Info', callback_data: 'pc_action:sysinfo' },
                            { text: '❌ Abort Shutdown', callback_data: 'pc_action:abort' }
                        ]
                    ]
                }
            });
        });

        // Callback query handler for PC control inline action buttons
        bot.action(/^pc_action:(.+)$/, async (ctx) => {
            // Verify if caller is authorized
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            // Acknowledge callback query
            try { await ctx.answerCbQuery(); } catch (_) { }

            // Extract action payload
            const action = ctx.match[1];

            // Remove previous keyboard markup
            try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) { }

            // Process requested action
            if (action === 'cancel') {
                await ctx.reply(t('pcActionCancelled'));
            } else if (action === 'shutdown:now') {
                await ctx.reply(t('pcShutdownNow'));
                await shutdownSystem(0);
            } else if (action === 'shutdown:60') {
                await ctx.reply(t('pcShutdownScheduled', { seconds: '60' }));
                await shutdownSystem(60);
            } else if (action === 'restart:now') {
                await ctx.reply(t('pcRestartNow'));
                await restartSystem(0);
            } else if (action === 'restart:60') {
                await ctx.reply(t('pcRestartScheduled', { seconds: '60' }));
                await restartSystem(60);
            } else if (action === 'sleep:now') {
                await ctx.reply(t('pcSleepSuccess'));
                await sleepSystem();
            } else if (action === 'lock') {
                const res = await lockWorkstation();
                if (res.success) {
                    await ctx.reply(t('pcLockSuccess'));
                } else {
                    await ctx.reply(t('pcError', { msg: res.message || 'Failed to lock' }));
                }
            } else if (action === 'abort') {
                const res = await abortShutdown();
                if (res.alreadyAborted) {
                    await ctx.reply(t('pcNoAbortPending'));
                } else if (res.success) {
                    await ctx.reply(t('pcAbortSuccess'));
                } else {
                    await ctx.reply(t('pcError', { msg: res.message || 'Abort failed' }));
                }
            } else if (action === 'sysinfo') {
                const report = getSystemInfo();
                await ctx.reply(report, { parse_mode: 'Markdown' });
            } else if (action === 'menu_shutdown') {
                await ctx.reply(t('pcShutdownConfirm'), {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔴 Shutdown Now', callback_data: 'pc_action:shutdown:now' },
                                { text: '⏱️ In 60s', callback_data: 'pc_action:shutdown:60' }
                            ],
                            [
                                { text: '❌ Cancel', callback_data: 'pc_action:cancel' }
                            ]
                        ]
                    }
                });
            } else if (action === 'menu_restart') {
                await ctx.reply(t('pcRestartConfirm'), {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '🔄 Restart Now', callback_data: 'pc_action:restart:now' },
                                { text: '⏱️ In 60s', callback_data: 'pc_action:restart:60' }
                            ],
                            [
                                { text: '❌ Cancel', callback_data: 'pc_action:cancel' }
                            ]
                        ]
                    }
                });
            } else if (action === 'menu_sleep') {
                await ctx.reply(t('pcSleepConfirm'), {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '💤 Sleep Now', callback_data: 'pc_action:sleep:now' },
                                { text: '❌ Cancel', callback_data: 'pc_action:cancel' }
                            ]
                        ]
                    }
                });
            }
        });

        bot.command('screenshot', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            try {
                await ctx.reply(t('capturingFrame'));
                const port = getDebuggingPort();
                const { buffer } = await captureAgentScreenshot(port);
                await sendTelegramPhoto(ctx, ctx.chat?.id, buffer);
            } catch (e: any) {
                ctx.reply(t('error', { msg: e.message }));

                // Fallback to full screenshot if CDP fails
                try {
                    await ctx.reply(t('capturingFull'));
                    // Use in-memory buffer directly to avoid disk lock errors on Windows
                    const fallbackBuffer = await screenshot({ format: 'jpg' });
                    await sendTelegramPhoto(ctx, ctx.chat?.id, fallbackBuffer);
                } catch (fallbackErr: any) {
                    await ctx.reply(t('error', { msg: fallbackErr.message }));
                }
            }
        });

        // Handler for /question and /q to check and display any pending interactive questions from the agent
        bot.command(['question', 'q'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { ctx.reply(t('unauthorized')); return; }
            const port = getDebuggingPort();
            try {
                await ctx.reply(t('checkingStatus'));
                const questionData = await getPendingAgentQuestion(port);
                if (questionData && questionData.hasQuestion) {
                    await sendQuestionToTelegram(ctx, questionData, port);
                } else {
                    await ctx.reply(t('noPendingQuestion') || 'ℹ️ No pending questions from the Agent.');
                }
            } catch (e: any) {
                console.error('[Telegram] Error in /question command:', e);
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        // Handler for /answer and /ans to answer pending agent questions via option number or free text
        bot.command(['answer', 'ans'], async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) {
                ctx.reply(t('unauthorized'));
                return;
            }

            const parts = ctx.message.text.split(' ');
            parts.shift();
            const rawAnswer = parts.join(' ').trim();

            if (!rawAnswer) {
                await ctx.reply(t('answerUsage') || '💡 Usage: /answer <option number or custom text>');
                return;
            }

            const port = getDebuggingPort();
            try {
                const questionData = await getPendingAgentQuestion(port);
                if (!questionData || !questionData.hasQuestion) {
                    await ctx.reply(t('noPendingQuestion') || 'ℹ️ No pending questions from the Agent right now.');
                    return;
                }

                const num = parseInt(rawAnswer, 10);
                let res: AnswerQuestionResult;
                if (!isNaN(num) && String(num) === rawAnswer && questionData.options.some(o => o.index === num)) {
                    res = await answerAgentQuestion(port, { optionIndex: num, targetId: questionData.targetId });
                } else if (rawAnswer.toLowerCase() === 'skip' || rawAnswer === 'تخطي') {
                    res = await answerAgentQuestion(port, { isSkip: true, targetId: questionData.targetId });
                } else {
                    res = await answerAgentQuestion(port, { customText: rawAnswer, targetId: questionData.targetId });
                }

                if (res.success) {
                    questionWatcher?.resetLastNotified();
                    const answerLabel = res.skipped
                        ? (t('questionSkipped') || '⏭️ Question was skipped.')
                        : (res.chosenOptionText || res.customText || rawAnswer);
                    await ctx.reply(t('questionAnswered', { answer: answerLabel }), { parse_mode: 'Markdown' });

                    // Monitor subsequent agent response
                    vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: t('agentThinking'),
                        cancellable: false
                    }, () => runAgentProgressCheck(ctx));
                } else {
                    await ctx.reply(t('questionAnswerError', { msg: res.message || 'Failed to submit answer' }));
                }
            } catch (err: any) {
                console.error('[Telegram] Error in /answer command:', err);
                ctx.reply(t('error', { msg: err.message }));
            }
        });

        // Callback query handler for interactive agent question inline buttons
        bot.action(/^agent_question:(opt|skip|screenshot):(\d+)$/, async (ctx) => {
            if (allowedChatId && ctx.chat?.id.toString() !== allowedChatId) {
                await ctx.answerCbQuery(t('unauthorized'));
                return;
            }

            const actionType = ctx.match[1];
            const optIndex = parseInt(ctx.match[2], 10);
            const port = getDebuggingPort();

            if (actionType === 'screenshot') {
                try {
                    await ctx.answerCbQuery(t('questionFetchingScreenshot') || '📸 Capturing screenshot...');
                } catch (_) {}
                try {
                    const { buffer } = await captureAgentScreenshot(port);
                    await sendTelegramPhoto(ctx, ctx.chat?.id, buffer, {
                        caption: `📸 *${t('questionCurrentState') || 'Agent Context Frame'}*`,
                        parseMode: 'Markdown'
                    });
                } catch (screenshotErr: any) {
                    await ctx.reply(t('screenshotError', { msg: screenshotErr.message }));
                }
                return;
            }

            try {
                await ctx.answerCbQuery();
            } catch (_) { /* ignore callback acknowledge error */ }

            try {
                if (actionType === 'skip') {
                    const res = await answerAgentQuestion(port, { isSkip: true, targetId: lastActiveQuestionTargetId });
                    if (res.success) {
                        questionWatcher?.resetLastNotified();
                        await ctx.reply(t('questionSkipped') || '⏭️ Question was skipped.');
                        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: t('agentThinking'),
                            cancellable: false
                        }, () => runAgentProgressCheck(ctx));
                    } else {
                        await ctx.reply(t('questionAnswerError', { msg: res.message || 'Skip failed' }));
                    }
                } else if (actionType === 'opt') {
                    const res = await answerAgentQuestion(port, { optionIndex: optIndex, targetId: lastActiveQuestionTargetId });
                    if (res.success) {
                        questionWatcher?.resetLastNotified();
                        const chosenText = res.chosenOptionText || `Option ${optIndex}`;
                        await ctx.reply(t('questionAnswered', { answer: chosenText }), { parse_mode: 'Markdown' });
                        try { await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); } catch (_) {}
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: t('agentThinking'),
                            cancellable: false
                        }, () => runAgentProgressCheck(ctx));
                    } else {
                        await ctx.reply(t('questionAnswerError', { msg: res.message || 'Submit failed' }));
                    }
                }
            } catch (err: any) {
                console.error('[Telegram] Error answering agent question:', err);
                ctx.reply(t('error', { msg: err.message }));
            }
        });

        // Catch-all text (excluding commands)
        // Directly answers pending agent questions, handles awaiting input state, or forwards conversational text to the Agent chat
        bot.on('text', async (ctx) => {
            if (allowedChatId && ctx.chat.id.toString() !== allowedChatId) { return; }
            const rawText = ctx.message.text.trim();
            if (!rawText) return;

            const isAr = getLanguage() === 'ar';
            const chatId = ctx.chat.id.toString();

            // Intercept pending user input states (Fix #15, #17, #21)
            if (pendingUserInputMap.has(chatId)) {
                const state = pendingUserInputMap.get(chatId)!;
                pendingUserInputMap.delete(chatId);

                // If user didn't cancel with a slash command, process the input
                if (!rawText.startsWith('/')) {
                    // Fix #15: Command search within bot widget without sending to IDE
                    if (state.type === 'cmd_search') {
                        await handleMenuCommand(ctx, undefined, rawText, false);
                        return;
                    }

                    // Fix #21: Shell command execution in terminal
                    if (state.type === 'terminal_cmd') {
                        const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('Telegram');
                        terminal.show();
                        terminal.sendText(rawText);
                        await ctx.reply(t('cmdExecuted', { cmd: rawText }) || `⚡ Executed: \`${rawText}\``, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]]
                            }
                        });
                        return;
                    }

                    // Fix #17: File search within specific directory or workspace root
                    if (state.type === 'file_search') {
                        const searchDir = state.data || getWorkspaceRoot();
                        if (searchDir) {
                            const results = searchFilesInDirectory(searchDir, rawText, 10);
                            const currentRel = getWorkspaceRoot() ? path.relative(getWorkspaceRoot()!, searchDir) || '.' : '.';
                            if (results.length === 0) {
                                await ctx.reply(
                                    isAr
                                        ? `❌ لم يتم العثور على أي ملف يطابق: "*${rawText}*" داخل \`${currentRel}\``
                                        : `❌ No files found matching "*${rawText}*" inside \`${currentRel}\``,
                                    {
                                        parse_mode: 'Markdown',
                                        reply_markup: {
                                            inline_keyboard: [
                                                [{ text: isAr ? '📂 تصفح المجلد' : '📂 Browse Folder', callback_data: `bf:${pathRegistry.register(searchDir)}` }],
                                                [{ text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }]
                                            ]
                                        }
                                    }
                                );
                            } else {
                                const buttons = results.map(f => {
                                    const fid = pathRegistry.register(f.fullPath);
                                    return [{ text: `${getFileIcon(f)} ${f.name}`, callback_data: `df:${fid}` }];
                                });
                                buttons.push([
                                    { text: isAr ? '📂 تصفح المجلد' : '📂 Browse Folder', callback_data: `bf:${pathRegistry.register(searchDir)}` },
                                    { text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center', callback_data: 'widget_home:main' }
                                ]);
                                await ctx.reply(
                                    isAr
                                        ? `🔍 نتائج البحث عن "*${rawText}*" (${results.length}):`
                                        : `🔍 Search results for "*${rawText}*" (${results.length}):`,
                                    {
                                        parse_mode: 'Markdown',
                                        reply_markup: { inline_keyboard: buttons }
                                    }
                                );
                            }
                            return;
                        }
                    }
                }
            }

            // If text starts with a slash, it's an unhandled command, skip
            if (rawText.startsWith('/')) return;

            const port = getDebuggingPort();

            try {
                // 1. Check if an interactive question is waiting for response
                const questionData = await getPendingAgentQuestion(port);
                if (questionData && questionData.hasQuestion) {
                    const num = parseInt(rawText, 10);
                    let res: AnswerQuestionResult;

                    if (!isNaN(num) && String(num) === rawText && questionData.options.some(o => o.index === num)) {
                        res = await answerAgentQuestion(port, { optionIndex: num, targetId: questionData.targetId });
                    } else if (rawText.toLowerCase() === 'skip' || rawText === 'تخطي') {
                        res = await answerAgentQuestion(port, { isSkip: true, targetId: questionData.targetId });
                    } else {
                        res = await answerAgentQuestion(port, { customText: rawText, targetId: questionData.targetId });
                    }

                    if (res.success) {
                        questionWatcher?.resetLastNotified();
                        const answerLabel = res.skipped
                            ? (t('questionSkipped') || '⏭️ Question was skipped.')
                            : t('questionAnswered', { answer: res.chosenOptionText || res.customText || rawText });
                        await ctx.reply(answerLabel, { parse_mode: 'Markdown' });

                        // Monitor subsequent agent response
                        vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: t('agentThinking'),
                            cancellable: false
                        }, () => runAgentProgressCheck(ctx));
                        return;
                    }
                }

                // 2. If no interactive question is pending, forward message directly to the Agent chat
                await sendToAgentChat(rawText);
                await ctx.reply(t('askSent', { query: rawText }), { parse_mode: 'Markdown' });

                // Monitor agent response
                vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: t('agentThinking'),
                    cancellable: false
                }, () => runAgentProgressCheck(ctx));

            } catch (e: any) {
                console.error('[Telegram] Error in text handler:', e);
                ctx.reply(t('error', { msg: e.message }));
            }
        });

        // ── Register slash commands (Background, don't block launch) ──
        registerSlashCommands(token, allowedChatId).catch(e => {
            console.warn('[Telegram] Slash command registration failed:', e.message);
        });

        // ── Launch ──
        bot.launch({ dropPendingUpdates: true }).then(() => {
            console.log('[Telegram] Bot polling started.');
        }).catch(err => {
            console.error('[Telegram] Bot launch failed:', err);
            vscode.window.showErrorMessage(t('error', { msg: err.message }));
            bot = undefined;
            if (lockManager) {
                lockManager.releaseLock();
            }
        });

        vscode.window.showInformationMessage(t('botStarted'));

        // Initialize and start proactive question watcher to detect agent questions in the background
        if (!questionWatcher) {
            questionWatcher = new AgentQuestionWatcher(async (qData, p) => {
                const chatId = getAllowedChatId();
                if (chatId && bot) {
                    await sendQuestionToTelegram(chatId, qData, p);
                } else {
                    console.warn('[QuestionWatcher] Active agent question detected, but no Telegram chatId is known yet.');
                }
            });
            context.subscriptions.push(questionWatcher);
        }
        questionWatcher.start();

    } catch (err: any) {
        bot = undefined;
        if (lockManager) {
            lockManager.releaseLock();
        }
        console.error('[Telegram] startBot fatal error:', err);
        vscode.window.showErrorMessage(t('error', { msg: err.message }));
    }
}

function stopBot(): void {
    if (!bot) { return; }
    // Stop proactive background question watcher
    if (questionWatcher) {
        questionWatcher.stop();
    }
    try {
        bot.stop('SIGINT');
    } catch (e) {
        console.error('[Telegram] Error stopping bot:', e);
    }
    telegramAgent?.destroy();
    telegramAgent = undefined;
    bot = undefined;
    if (lockManager) {
        lockManager.releaseLock();
    }
}

// ─── Activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    lockManager = new BotLockManager(context);
    statusBarManager = new StatusBarManager(context);
    autoAcceptManager = new AutoAcceptManager(context);
    mirrorServerManager = new MirrorServerManager();
    completionSoundWatcher = new AgentCompletionSoundWatcher();

    // Sidebar settings panel
    const provider = new TelegramSettingsProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(TelegramSettingsProvider.viewType, provider),
        autoAcceptManager,
        mirrorServerManager,
        completionSoundWatcher
    );

    // Start auto accept if enabled
    autoAcceptManager.start();

    // Start mirror server if enabled
    mirrorServerManager.start();

    // Start local completion sound alert watcher if enabled
    completionSoundWatcher.start();

    // Commands
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravity-telegram-control.startBot', () => startBot(context)),
        vscode.commands.registerCommand('antigravity-telegram-control.stopBot', stopBot),
        vscode.commands.registerCommand('antigravity-telegram-control.testSoundAlert', async (soundFile?: string, volumePercent?: number) => {
            const played = await playNotificationSound(
                true,
                typeof soundFile === 'string' ? soundFile : undefined,
                typeof volumePercent === 'number' ? volumePercent : undefined
            );
            if (played) {
                vscode.window.showInformationMessage(t('soundTestPlayed') || '🔔 Test notification sound played.');
            } else {
                vscode.window.showWarningMessage('Could not play system notification sound on this device.');
            }
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.injectScript', async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Injecting script into workbench...",
                cancellable: false
            }, async () => {
                try {
                    const success = installScript(context);
                    if (success) {
                        clearV8CodeCache();
                        updateProductChecksums();
                        provider.updateHtml();
                        const choice = await vscode.window.showInformationMessage(
                            '[AG Auto] ✅ Script injected! Reload VS Code to activate.',
                            'Reload Now'
                        );
                        if (choice === 'Reload Now') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Inject failed: ${e.message}`);
                }
            });
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.uninstallScript', async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Removing script from workbench...",
                cancellable: false
            }, async () => {
                try {
                    const success = uninstallScript();
                    if (success) {
                        clearV8CodeCache();
                        updateProductChecksums();
                        provider.updateHtml();
                        const choice = await vscode.window.showInformationMessage(
                            '[AG Auto] 🗑️ Script removed! Reload VS Code to complete.',
                            'Reload Now'
                        );
                        if (choice === 'Reload Now') {
                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                        }
                    } else {
                        vscode.window.showErrorMessage('[AG Auto] workbench.html not found!');
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Removal failed: ${e.message}`);
                }
            });
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.refreshQuota', async () => {
            if (statusBarManager) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: getLanguage() === 'vi' ? 'Đang cập nhật hạn mức...' : 'Updating quota status...',
                    cancellable: false
                }, async () => {
                    await statusBarManager!.update();
                });
            }
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.saveCurrentAccount', async () => {
            try {
                const name = await vscode.window.showInputBox({
                    prompt: getLanguage() === 'vi' ? 'Nhập tên nhận diện cho tài khoản này (tùy chọn):' : 'Enter account label / name (optional):',
                    placeHolder: 'My Main Account'
                });
                const accountMgr = AccountManager.getInstance();
                const saved = accountMgr.saveCurrentAccount(name || undefined);
                if (saved) {
                    vscode.window.showInformationMessage(
                        getLanguage() === 'vi'
                            ? `✅ Đã lưu tài khoản: ${saved.name} (${saved.email})`
                            : `✅ Account saved: ${saved.name} (${saved.email})`
                    );
                    provider.updateHtml();
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to save account: ${e.message}`);
            }
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.switchAccount', async () => {
            try {
                const accountMgr = AccountManager.getInstance();
                const stored = accountMgr.getStoredAccounts();
                if (stored.length === 0) {
                    vscode.window.showWarningMessage(
                        getLanguage() === 'vi'
                            ? 'Chưa có tài khoản nào được lưu. Hãy dùng lệnh "Save Current Account" trước.'
                            : 'No accounts saved yet. Save the current account first.'
                    );
                    return;
                }

                const current = accountMgr.getCurrentAccount();
                const items = stored.map((acc) => {
                    const isActive = current && current.email.toLowerCase() === acc.email.toLowerCase();
                    return {
                        label: `${isActive ? '🟢 ' : ''}${acc.name}`,
                        description: acc.email,
                        detail: `ID: ${acc.id} | Last Used: ${acc.lastUsed}`,
                        accountId: acc.id
                    };
                });

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: getLanguage() === 'vi' ? 'Chọn tài khoản muốn chuyển đổi:' : 'Select account to switch to:'
                });

                if (selected) {
                    const res = accountMgr.switchAccount(selected.accountId);
                    provider.updateHtml();
                    if (statusBarManager) {
                        statusBarManager.update();
                    }
                    const choice = await vscode.window.showInformationMessage(
                        getLanguage() === 'vi'
                            ? `✅ Đã chuyển sang tài khoản ${res.account.name} (${res.account.email})! Reload IDE để đồng bộ.`
                            : `✅ Switched to ${res.account.name} (${res.account.email})! Reload IDE to synchronize.`,
                        'Reload Now'
                    );
                    if (choice === 'Reload Now') {
                        vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to switch account: ${e.message}`);
            }
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.rotateAccount', async () => {
            try {
                const accountMgr = AccountManager.getInstance();
                const rotated = accountMgr.rotateAccount();
                if (rotated) {
                    provider.updateHtml();
                    if (statusBarManager) {
                        statusBarManager.update();
                    }
                    vscode.window.showInformationMessage(
                        getLanguage() === 'vi'
                            ? `🔄 Đã xoay vòng sang tài khoản: ${rotated.name} (${rotated.email})`
                            : `🔄 Rotated to account: ${rotated.name} (${rotated.email})`
                    );
                } else {
                    vscode.window.showWarningMessage(
                        getLanguage() === 'vi'
                            ? 'Cần ít nhất 2 tài khoản đã lưu để xoay vòng.'
                            : 'Need at least 2 saved accounts to rotate.'
                    );
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Failed to rotate account: ${e.message}`);
            }
        }),

        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration('antigravityTelegramControl.showStatusBar') ||
                e.affectsConfiguration('antigravityTelegramControl.statusBarUpdateInterval') ||
                e.affectsConfiguration('antigravityTelegramControl.language')) {
                if (statusBarManager) {
                    statusBarManager.startTimer();
                    await statusBarManager.update();
                }
            }
            if (e.affectsConfiguration('antigravityTelegramControl.autoAccept') ||
                e.affectsConfiguration('antigravityTelegramControl.autoAcceptInterval') ||
                e.affectsConfiguration('antigravityTelegramControl.scrollEnabled') ||
                e.affectsConfiguration('antigravityTelegramControl.scrollPauseMs') ||
                e.affectsConfiguration('antigravityTelegramControl.scrollIntervalMs') ||
                e.affectsConfiguration('antigravityTelegramControl.debuggingPort')) {
                if (autoAcceptManager) {
                    autoAcceptManager.onConfigChanged();
                }
                writeConfigJson(context);
            }
            if (e.affectsConfiguration('antigravityTelegramControl.enableMirror') ||
                e.affectsConfiguration('antigravityTelegramControl.mirrorPort') ||
                e.affectsConfiguration('antigravityTelegramControl.mirrorToken') ||
                e.affectsConfiguration('antigravityTelegramControl.debuggingPort') ||
                e.affectsConfiguration('antigravityTelegramControl.enableTunnel') ||
                e.affectsConfiguration('antigravityTelegramControl.tunnelType') ||
                e.affectsConfiguration('antigravityTelegramControl.ngrokAuthToken')) {
                if (mirrorServerManager) {
                    mirrorServerManager.onConfigChanged();
                }
            }
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.showMenu', async () => {
            const targetChatId = getAllowedChatId();
            if (!targetChatId || !bot) {
                vscode.window.showWarningMessage('Telegram Bot is not running or Allowed Chat ID is not configured.');
                return;
            }
            const lang = getLanguage();
            const keyboard = buildCommandWidgetKeyboard(undefined, undefined, lang);
            const title = t('menuTitle') || 'Antigravity Command Center';
            const subtitle = t('menuChooseGroup') || 'Select a category below to explore commands:';
            await bot.telegram.sendMessage(targetChatId, `🎛️ *${title}*\n\n${subtitle}`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
            vscode.window.showInformationMessage('Command Center sent to Telegram!');
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.fetchHistory', async () => {
            const port = getDebuggingPort();
            const messages = await getConversationHistory(port, 5);
            if (!messages || messages.length === 0) {
                vscode.window.showInformationMessage('No active conversation messages found in Antigravity Agent.');
                return;
            }
            vscode.window.showInformationMessage(`Fetched ${messages.length} messages from Agent session.`);
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.statusDashboard', async () => {
            const targetChatId = getAllowedChatId();
            if (!targetChatId || !bot) {
                vscode.window.showWarningMessage('Telegram Bot is not running or Allowed Chat ID is not configured.');
                return;
            }
            await sendStatusDashboardToTelegram(targetChatId);
            vscode.window.showInformationMessage('Status Dashboard sent to Telegram!');
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.openSettings', () => {
            const panel = vscode.window.createWebviewPanel(
                'telegramSettings', 'Telegram Control Settings', vscode.ViewColumn.One,
                { enableScripts: true }
            );
            const cfg = vscode.workspace.getConfiguration('antigravityTelegramControl');

            // Load paths and agent files
            const agentsMsPath = cfg.get<string>('agentsMsPath') || '';
            const geminiMdPath = cfg.get<string>('geminiMdPath') || '';
            let agentsMs = '';
            let geminiMd = '';

            try {
                const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const msPath = agentsMsPath || (root ? path.join(root, 'agents.md') : undefined);
                const mdPath = geminiMdPath || (root ? path.join(root, 'gemini.md') : undefined);

                if (msPath && fs.existsSync(msPath)) agentsMs = fs.readFileSync(msPath, 'utf8');
                if (mdPath && fs.existsSync(mdPath)) geminiMd = fs.readFileSync(mdPath, 'utf8');
            } catch (e) { }

            const autoAccept = cfg.get<boolean>('autoAccept') ?? false;
            const soundAlertEnabled = cfg.get<boolean>('soundAlertEnabled') ?? true;
            const soundAlertFile = cfg.get<string>('soundAlertFile') || '';
            const soundAlertVolume = cfg.get<number>('soundAlertVolume') ?? 300;
            const availableSystemSounds = getAvailableSystemSounds();
            const autoAcceptInterval = cfg.get<number>('autoAcceptInterval') ?? 800;
            const enableMirror = cfg.get<boolean>('enableMirror') ?? false;
            const mirrorPort = cfg.get<number>('mirrorPort') ?? 9999;
            const mirrorToken = cfg.get<string>('mirrorToken') ?? '';
            const enableTunnel = cfg.get<boolean>('enableTunnel') ?? false;
            const tunnelType = cfg.get<string>('tunnelType') ?? 'localhost.run';
            const ngrokAuthToken = cfg.get<string>('ngrokAuthToken') ?? '';

            const clickPatterns = cfg.get<string[]>('clickPatterns') ?? ["Allow", "Always Allow", "Run", "Keep Waiting", "Accept all", "Accept"];
            
            const totalClicks = context.globalState.get<number>('totalClicks') ?? 0;
            const clickStats = context.globalState.get<Record<string, number>>('clickStats') ?? {};
            const clickLog = context.globalState.get<Array<any>>('clickLog') ?? [];

            panel.webview.html = getSettingsHtml(
                cfg.get('botToken') ?? '',
                cfg.get('allowedChatId') ?? '',
                cfg.get('debuggingPort') ?? 9222,
                cfg.get('language') ?? 'en',
                agentsMs,
                geminiMd,
                agentsMsPath,
                geminiMdPath,
                cfg.get('autoRetry') ?? false,
                autoAccept,
                autoAcceptInterval,
                enableMirror,
                mirrorPort,
                mirrorToken,
                enableTunnel,
                tunnelType,
                ngrokAuthToken,
                clickPatterns,
                totalClicks,
                clickStats,
                clickLog,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                soundAlertEnabled,
                soundAlertFile,
                availableSystemSounds,
                soundAlertVolume
            );

            panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.command === 'save') {
                    await cfg.update('botToken', msg.token, vscode.ConfigurationTarget.Global);
                    await cfg.update('allowedChatId', msg.chatId, vscode.ConfigurationTarget.Global);
                    await cfg.update('debuggingPort', msg.debuggingPort ?? 9222, vscode.ConfigurationTarget.Global);
                    await cfg.update('language', msg.language ?? 'en', vscode.ConfigurationTarget.Global);

                    vscode.window.showInformationMessage(t('settingsSaved'));
                    stopBot();
                    setTimeout(() => {
                        startBot(context);
                    }, 500);
                }
                if (msg.command === 'saveAgents') {
                    try {
                        await cfg.update('agentsMsPath', msg.agentsMsPath, vscode.ConfigurationTarget.Global);
                        await cfg.update('geminiMdPath', msg.geminiMdPath, vscode.ConfigurationTarget.Global);

                        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        const msPath = msg.agentsMsPath || (root ? path.join(root, 'agents.md') : undefined);
                        const mdPath = msg.geminiMdPath || (root ? path.join(root, 'gemini.md') : undefined);

                        if (msPath) fs.writeFileSync(msPath, msg.agentsMs, 'utf8');
                        if (mdPath) fs.writeFileSync(mdPath, msg.geminiMd, 'utf8');

                        vscode.window.showInformationMessage('Agent configuration updated!');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save agents: ${e.message}`);
                    }
                }
                if (msg.command === 'saveAuto') {
                    try {
                        await cfg.update('autoRetry', msg.autoRetry, vscode.ConfigurationTarget.Global);
                        if (typeof msg.soundAlertEnabled === 'boolean') {
                            await cfg.update('soundAlertEnabled', msg.soundAlertEnabled, vscode.ConfigurationTarget.Global);
                        }
                        if (typeof msg.soundAlertFile === 'string') {
                            await cfg.update('soundAlertFile', msg.soundAlertFile, vscode.ConfigurationTarget.Global);
                        }
                        if (typeof msg.soundAlertVolume === 'number' && !isNaN(msg.soundAlertVolume)) {
                            await cfg.update('soundAlertVolume', msg.soundAlertVolume, vscode.ConfigurationTarget.Global);
                        }
                        await cfg.update('autoAccept', msg.autoAccept, vscode.ConfigurationTarget.Global);
                        await cfg.update('autoAcceptInterval', msg.autoAcceptInterval ?? 800, vscode.ConfigurationTarget.Global);
                        try {
                            await cfg.update('scrollEnabled', msg.scrollEnabled ?? true, vscode.ConfigurationTarget.Global);
                        } catch (_e) { }
                        try {
                            await cfg.update('scrollPauseMs', msg.scrollPauseMs ?? 7000, vscode.ConfigurationTarget.Global);
                        } catch (_e) { }
                        try {
                            await cfg.update('scrollIntervalMs', msg.scrollIntervalMs ?? 500, vscode.ConfigurationTarget.Global);
                        } catch (_e) { }
                        await cfg.update('clickPatterns', msg.clickPatterns ?? ["Allow", "Always Allow", "Run", "Keep Waiting", "Accept all", "Accept"], vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('Automation settings updated!');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save automation settings: ${e.message}`);
                    }
                }
                if (msg.command === 'saveMirror') {
                    try {
                        await cfg.update('enableMirror', msg.enableMirror, vscode.ConfigurationTarget.Global);
                        await cfg.update('mirrorPort', msg.mirrorPort ?? 9999, vscode.ConfigurationTarget.Global);
                        await cfg.update('mirrorToken', msg.mirrorToken || '', vscode.ConfigurationTarget.Global);
                        await cfg.update('enableTunnel', msg.enableTunnel, vscode.ConfigurationTarget.Global);
                        await cfg.update('tunnelType', msg.tunnelType || 'localhost.run', vscode.ConfigurationTarget.Global);
                        await cfg.update('ngrokAuthToken', msg.ngrokAuthToken || '', vscode.ConfigurationTarget.Global);
                        vscode.window.showInformationMessage('Web Mirror settings updated!');
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to save Web Mirror settings: ${e.message}`);
                    }
                }
                if (msg.command === 'resetStats') {
                    await context.globalState.update('totalClicks', 0);
                    await context.globalState.update('clickStats', {});
                    await context.globalState.update('clickLog', []);
                    panel.webview.postMessage({ command: 'statsUpdated', clickStats: {}, totalClicks: 0 });
                    panel.webview.postMessage({ command: 'clickLogUpdate', log: [] });
                }
                if (msg.command === 'clearClickLog') {
                    await context.globalState.update('clickLog', []);
                    panel.webview.postMessage({ command: 'clickLogUpdate', log: [] });
                }
                if (msg.command === 'getStats') {
                    const totalClicks = context.globalState.get<number>('totalClicks') ?? 0;
                    const clickStats = context.globalState.get<Record<string, number>>('clickStats') ?? {};
                    panel.webview.postMessage({ command: 'statsUpdated', clickStats, totalClicks });
                }
                if (msg.command === 'getClickLog') {
                    const log = context.globalState.get<Array<any>>('clickLog') ?? [];
                    panel.webview.postMessage({ command: 'clickLogUpdate', log });
                }
                if (msg.command === 'autofind') {
                    try {
                        const home = os.homedir();
                        const geminiDir = path.join(home, '.gemini');
                        const results: any = { command: 'foundPaths' };

                        if (fs.existsSync(geminiDir)) {
                            const msPath = path.join(geminiDir, 'agents.md');
                            const mdPath = path.join(geminiDir, 'gemini.md');

                            if (fs.existsSync(msPath)) {
                                results.agentsMsPath = msPath;
                                results.agentsMs = fs.readFileSync(msPath, 'utf8');
                            }
                            if (fs.existsSync(mdPath)) {
                                results.geminiMdPath = mdPath;
                                results.geminiMd = fs.readFileSync(mdPath, 'utf8');
                            }

                            if (results.agentsMsPath || results.geminiMdPath) {
                                panel.webview.postMessage(results);
                                vscode.window.showInformationMessage('Found agent files in .gemini folder!');
                            } else {
                                vscode.window.showWarningMessage('No agent files found in .gemini folder.');
                            }
                        } else {
                            vscode.window.showWarningMessage('Could not find .gemini folder in home directory.');
                        }
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Search failed: ${e.message}`);
                    }
                }
                if (msg.command === 'registerCommands') {
                    const tokenToUse = msg.token || cfg.get('botToken') || '';
                    const chatIdToUse = cfg.get('allowedChatId') || '';
                    vscode.commands.executeCommand('antigravity-telegram-control.registerCommands', tokenToUse, chatIdToUse);
                }
                if (msg.command === 'deleteCommands') {
                    const tokenToUse = msg.token || cfg.get('botToken') || '';
                    const chatIdToUse = cfg.get('allowedChatId') || '';
                    vscode.commands.executeCommand('antigravity-telegram-control.deleteCommands', tokenToUse, chatIdToUse);
                }
                if (msg.command === 'injectScript') {
                    vscode.commands.executeCommand('antigravity-telegram-control.injectScript');
                }
                if (msg.command === 'uninstallScript') {
                    vscode.commands.executeCommand('antigravity-telegram-control.uninstallScript');
                }
                if (msg.command === 'testSoundAlert') {
                    vscode.commands.executeCommand('antigravity-telegram-control.testSoundAlert', msg.soundAlertFile, msg.soundAlertVolume);
                }
            }, undefined, context.subscriptions);
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.registerCommands', async (manualToken?: string, manualChatId?: string) => {
            const token = manualToken || getToken();
            const chatId = manualChatId || getAllowedChatId();
            if (!token) {
                vscode.window.showErrorMessage(t('invalidToken'));
                return;
            }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Registering Slash Commands on Telegram...",
                cancellable: false
            }, async () => {
                try {
                    await registerSlashCommands(token, chatId);
                    vscode.window.showInformationMessage('✅ Slash commands registered successfully!');
                    // Restart bot if token came from the UI but wasn't saved yet
                    if (manualToken) {
                        stopBot();
                        setTimeout(() => {
                            startBot(context);
                        }, 500);
                    }
                } catch (e: any) {
                    vscode.window.showErrorMessage(t('error', { msg: e.message }));
                }
            });
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.deleteCommands', async (manualToken?: string, manualChatId?: string) => {
            const token = manualToken || getToken();
            const chatId = manualChatId || getAllowedChatId();
            if (!token) {
                vscode.window.showErrorMessage(t('invalidToken'));
                return;
            }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Deleting Slash Commands on Telegram...",
                cancellable: false
            }, async () => {
                try {
                    await deleteSlashCommands(token, chatId);
                    vscode.window.showInformationMessage('✅ All slash commands deleted successfully!');
                } catch (e: any) {
                    vscode.window.showErrorMessage(t('error', { msg: e.message }));
                }
            });
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.browseFiles', async () => {
            const chatId = getAllowedChatId();
            const workspaceRoot = getWorkspaceRoot();
            if (!workspaceRoot) {
                vscode.window.showWarningMessage('No open workspace folder found.');
                return;
            }
            if (!chatId || !bot) {
                vscode.window.showWarningMessage('Telegram bot is not running or no Chat ID is set.');
                return;
            }
            await sendFileListing(chatId, workspaceRoot, workspaceRoot, false);
            vscode.window.showInformationMessage('Sent files browser to Telegram!');
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.getFile', async () => {
            const filePath = await vscode.window.showInputBox({
                prompt: 'Enter relative or absolute path of file to send to Telegram',
                placeHolder: 'e.g. src/extension.ts or package.json'
            });
            if (!filePath) return;
            const chatId = getAllowedChatId();
            if (!chatId || !bot) {
                vscode.window.showWarningMessage('Telegram bot is not running or no Chat ID is set.');
                return;
            }
            await sendFileToChat(chatId, filePath);
            vscode.window.showInformationMessage(`Sent ${filePath} to Telegram!`);
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.getClipboard', async () => {
            const chatId = getAllowedChatId();
            if (!chatId || !bot) {
                vscode.window.showWarningMessage('Telegram bot is not running or no Chat ID is set.');
                return;
            }
            const clipText = await vscode.env.clipboard.readText();
            if (!clipText || !clipText.trim()) {
                vscode.window.showWarningMessage('Clipboard is empty.');
                return;
            }
            await bot.telegram.sendMessage(chatId, `📋 *Clipboard Content:*\n\`\`\`\n${clipText.substring(0, 3800)}\n\`\`\``, {
                parse_mode: 'Markdown'
            });
            vscode.window.showInformationMessage('Sent clipboard to Telegram!');
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.showExtensions', async () => {
            const chatId = getAllowedChatId();
            if (!chatId || !bot) {
                vscode.window.showWarningMessage('Telegram bot is not running or no Chat ID is set.');
                return;
            }
            await sendExtensionsMenu(chatId, false, false);
            vscode.window.showInformationMessage('Sent extensions menu to Telegram!');
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.expandChanges', async () => {
            const chatId = getAllowedChatId();
            if (!chatId || !bot) {
                vscode.window.showWarningMessage('Telegram bot is not running or no Chat ID is set.');
                return;
            }
            await handleExpandCommand(chatId);
            vscode.window.showInformationMessage('Sent expanded changes view to Telegram!');
        }),

        vscode.commands.registerCommand('antigravity-telegram-control.extractChanges', async () => {
            const chatId = getAllowedChatId();
            if (!chatId || !bot) {
                vscode.window.showWarningMessage('Telegram bot is not running or no Chat ID is set.');
                return;
            }
            await handleChangesCommand(chatId);
            vscode.window.showInformationMessage('Sent changes report to Telegram!');
        })
    );

    // ── Auto-start if token already exists ──
    if (getToken()) {
        startBot(context);
    }
}

export function deactivate() {
    if (completionSoundWatcher) {
        completionSoundWatcher.dispose();
        completionSoundWatcher = undefined;
    }
    if (questionWatcher) {
        questionWatcher.dispose();
    }
    bot?.stop('SIGINT');
    lockManager?.releaseLock();
    if (statusBarManager) {
        statusBarManager.dispose();
    }
}

export function sendBotMessage(text: string, options: any = {}) {
    if (bot && getAllowedChatId()) {
        bot.telegram.sendMessage(getAllowedChatId()!, text, options).catch(e => {
            console.error('[Telegram] Failed to send notification message:', e);
        });
    }
}
