// src/command_definitions.ts
// Comprehensive definition of all Antigravity Telegram Control commands

export type CommandGroup = 'ai' | 'monitoring' | 'files' | 'account' | 'system';

export interface BotCommand {
    id: string;
    command: string;
    icon: string;
    label: string;
    description: string;
    group: CommandGroup;
    hasArgs?: boolean;
    argHint?: string;
    isDestructive?: boolean;
}

export interface GroupMeta {
    label: string;
    labelAr: string;
    icon: string;
    order: number;
}

export const GROUP_META: Record<CommandGroup, GroupMeta> = {
    ai: { label: 'AI Agent', labelAr: 'الذكاء الاصطناعي', icon: '🤖', order: 1 },
    monitoring: { label: 'Monitoring', labelAr: 'المراقبة والحالة', icon: '📡', order: 2 },
    files: { label: 'Files & Projects', labelAr: 'الملفات والمشاريع', icon: '📂', order: 3 },
    account: { label: 'Account & Quota', labelAr: 'الحساب والحصص', icon: '💳', order: 4 },
    system: { label: 'System & PC', labelAr: 'النظام والجهاز', icon: '💻', order: 5 },
};

export const ALL_COMMANDS: BotCommand[] = [
    // ─── Group: AI Agent ───
    {
        id: 'ask',
        command: '/ask',
        icon: '💬',
        label: 'Ask Agent',
        description: 'Send prompt or task to Antigravity Agent',
        group: 'ai',
        hasArgs: true,
        argHint: '<prompt>'
    },
    {
        id: 'stop',
        command: '/stop',
        icon: '🛑',
        label: 'Stop Agent',
        description: 'Abort current Agent generation immediately',
        group: 'ai'
    },
    {
        id: 'newchat',
        command: '/newchat',
        icon: '➕',
        label: 'New Chat',
        description: 'Start a brand new conversation',
        group: 'ai'
    },
    {
        id: 'chats',
        command: '/chats',
        icon: '📚',
        label: 'Chats List',
        description: 'List all conversations with 1-tap switch buttons',
        group: 'ai'
    },
    {
        id: 'history',
        command: '/history',
        icon: '📜',
        label: 'Chat History',
        description: 'Fetch recent conversation turns (default: 5)',
        group: 'ai',
        hasArgs: true,
        argHint: '[number]'
    },
    {
        id: 'question',
        command: '/question',
        icon: '❓',
        label: 'Check Question',
        description: 'Check and answer pending interactive questions',
        group: 'ai'
    },
    {
        id: 'answer',
        command: '/answer',
        icon: '💬',
        label: 'Answer Question',
        description: 'Answer pending agent question with option number or text',
        group: 'ai',
        hasArgs: true,
        argHint: '<option or text>'
    },
    {
        id: 'expand',
        command: '/expand',
        icon: '▶️',
        label: 'Expand Changes',
        description: 'Expand collapsed steps/diffs in chat and capture screenshot',
        group: 'ai'
    },
    {
        id: 'changes',
        command: '/changes',
        icon: '📝',
        label: 'Extract Changes',
        description: 'Extract list of modified files, executed commands, and steps',
        group: 'ai'
    },

    // ─── Group: Monitoring ───
    {
        id: 'status',
        command: '/status',
        icon: '📊',
        label: 'Status Dashboard',
        description: 'Unified status board (Agent + Quota + System)',
        group: 'monitoring'
    },
    {
        id: 'check',
        command: '/check',
        icon: '✅',
        label: 'Check Status',
        description: 'Verify completion status and receive visual frame',
        group: 'monitoring'
    },
    {
        id: 'alarm',
        command: '/alarm',
        icon: '🔔',
        label: 'Alarm Watcher',
        description: 'Notify with screenshot when Agent finishes',
        group: 'monitoring'
    },
    {
        id: 'screenshot',
        command: '/screenshot',
        icon: '📸',
        label: 'Screenshot',
        description: 'Capture high-res cropped frame of Agent chat area',
        group: 'monitoring'
    },
    {
        id: 'extensions',
        command: '/extensions',
        icon: '🧩',
        label: 'Extensions & Views',
        description: 'Inspect sidebar extensions (GitHub Actions, Git, etc.) with live screenshots',
        group: 'monitoring'
    },

    // ─── Group: Files & Projects ───
    {
        id: 'files',
        command: '/files',
        icon: '📂',
        label: 'Browse Files',
        description: 'Explore workspace folders and files with interactive buttons',
        group: 'files'
    },
    {
        id: 'getfile',
        command: '/getfile',
        icon: '📥',
        label: 'Download File',
        description: 'Download any project file or photo directly to phone',
        group: 'files',
        hasArgs: true,
        argHint: '<path or name>'
    },
    {
        id: 'getclipboard',
        command: '/getclipboard',
        icon: '📋',
        label: 'Get Clipboard',
        description: 'Retrieve current text from computer clipboard',
        group: 'files'
    },
    {
        id: 'getlog',
        command: '/getlog',
        icon: '📜',
        label: 'Get Error Log',
        description: 'Send latest IDE or extension log file to chat',
        group: 'files'
    },
    {
        id: 'recent',
        command: '/recent',
        icon: '📁',
        label: 'Recent Workspaces',
        description: 'List and open recent folders in IDE',
        group: 'files',
        hasArgs: true,
        argHint: '[number]'
    },
    {
        id: 'backup',
        command: '/backup',
        icon: '📦',
        label: 'Project Backup',
        description: 'Create and download clean ZIP archive of workspace',
        group: 'files'
    },

    // ─── Group: Account & Quota ───
    {
        id: 'quota',
        command: '/quota',
        icon: '📊',
        label: 'Quota & Limits',
        description: 'Query prompt credits, flow credits, and model limits',
        group: 'account'
    },
    {
        id: 'models',
        command: '/models',
        icon: '🤖',
        label: 'Models List',
        description: 'List available AI models with 1-tap switch buttons',
        group: 'account'
    },
    {
        id: 'switchmodel',
        command: '/switchmodel',
        icon: '🔀',
        label: 'Switch Model',
        description: 'Switch active AI model by index or name',
        group: 'account',
        hasArgs: true,
        argHint: '<num|name>'
    },
    {
        id: 'accounts',
        command: '/accounts',
        icon: '👥',
        label: 'Accounts List',
        description: 'List saved Antigravity / Google accounts',
        group: 'account'
    },
    {
        id: 'switch',
        command: '/switch',
        icon: '🔄',
        label: 'Switch Account',
        description: 'Switch active account by ID, email, or index',
        group: 'account',
        hasArgs: true,
        argHint: '<id|email>'
    },
    {
        id: 'rotate_account',
        command: '/rotate_account',
        icon: '🔁',
        label: 'Rotate Account',
        description: 'Rotate to next saved account snapshot',
        group: 'account'
    },
    {
        id: 'save_account',
        command: '/save_account',
        icon: '💾',
        label: 'Save Account',
        description: 'Save current active account snapshot',
        group: 'account'
    },

    // ─── Group: System & PC ───
    {
        id: 'pc',
        command: '/pc',
        icon: '⚡',
        label: 'Power Dashboard',
        description: 'Interactive PC control dashboard',
        group: 'system'
    },
    {
        id: 'sysinfo',
        command: '/sysinfo',
        icon: '💻',
        label: 'System Info',
        description: 'Hardware, CPU, RAM, and OS telemetry',
        group: 'system'
    },
    {
        id: 'cmd',
        command: '/cmd',
        icon: '⌨️',
        label: 'Run Terminal Command',
        description: 'Execute shell command in active VS Code terminal',
        group: 'system',
        hasArgs: true,
        argHint: '<cmd>'
    },
    {
        id: 'shutdown',
        command: '/shutdown',
        icon: '⛔',
        label: 'Shutdown PC',
        description: 'Shut down the workstation (countdown optional)',
        group: 'system',
        hasArgs: true,
        argHint: '[seconds]',
        isDestructive: true
    },
    {
        id: 'restart',
        command: '/restart',
        icon: '🔁',
        label: 'Restart PC',
        description: 'Reboot workstation (countdown optional)',
        group: 'system',
        hasArgs: true,
        argHint: '[seconds]',
        isDestructive: true
    },
    {
        id: 'sleep',
        command: '/sleep',
        icon: '😴',
        label: 'Sleep Mode',
        description: 'Put computer into low-power sleep mode',
        group: 'system'
    },
    {
        id: 'lock',
        command: '/lock',
        icon: '🔒',
        label: 'Lock Screen',
        description: 'Lock active Windows/Mac/Linux session',
        group: 'system'
    },
    {
        id: 'abort',
        command: '/abort',
        icon: '🚫',
        label: 'Abort Shutdown',
        description: 'Cancel any pending scheduled shutdown or restart',
        group: 'system'
    }
];
