// src/extensions_manager.ts
// Interactive Extensions and Sidebar Views Manager for Antigravity Telegram Control

import * as vscode from 'vscode';

export interface SidebarViewItem {
    id: string;
    label: string;
    icon: string;
    command: string;
    category: 'primary' | 'builtin' | 'installed';
    extensionId?: string;
    description?: string;
}

export const PREDEFINED_SIDEBAR_VIEWS: SidebarViewItem[] = [
    // Primary highlighted views specifically requested: Source Control and GitHub Actions
    {
        id: 'scm',
        label: 'Source Control (Git)',
        icon: '🔀',
        command: 'workbench.view.scm',
        category: 'primary',
        description: 'Git changes, commits, diffs, and staged files'
    },
    {
        id: 'github-actions',
        label: 'GitHub Actions',
        icon: '⚙️',
        command: 'workbench.view.extension.github-actions',
        category: 'primary',
        description: 'GitHub workflows, test runs, and CI/CD status'
    },
    {
        id: 'explorer',
        label: 'Explorer',
        icon: '📁',
        command: 'workbench.view.explorer',
        category: 'primary',
        description: 'Project files tree and workspace structure'
    },
    {
        id: 'problems',
        label: 'Problems',
        icon: '⚠️',
        command: 'workbench.actions.view.problems',
        category: 'builtin',
        description: 'Workspace diagnostics, compilation errors, and warnings'
    },
    {
        id: 'terminal',
        label: 'Terminal',
        icon: '🖥️',
        command: 'workbench.action.terminal.focus',
        category: 'builtin',
        description: 'Integrated command-line terminal'
    },
    {
        id: 'output',
        label: 'Output',
        icon: '📋',
        command: 'workbench.action.output.toggleOutput',
        category: 'builtin',
        description: 'Antigravity IDE channel output and logs'
    },
    {
        id: 'debug',
        label: 'Debug & Run',
        icon: '🐛',
        command: 'workbench.view.debug',
        category: 'builtin',
        description: 'Breakpoints, call stack, and debug variables'
    },
    {
        id: 'search',
        label: 'Search',
        icon: '🔍',
        command: 'workbench.view.search',
        category: 'builtin',
        description: 'Find and replace across all project files'
    },
    {
        id: 'extensions-tab',
        label: 'Extensions',
        icon: '🧩',
        command: 'workbench.view.extensions',
        category: 'builtin',
        description: 'Extensions marketplace and installed plugins'
    }
];

/**
 * Scans installed extensions to discover all sidebar views registered on the Activity Bar.
 */
export function getDiscoveredSidebarViews(): SidebarViewItem[] {
    const list: SidebarViewItem[] = [...PREDEFINED_SIDEBAR_VIEWS];
    const existingCommands = new Set(list.map(v => v.command.toLowerCase()));

    for (const ext of vscode.extensions.all) {
        if (ext.id.startsWith('vscode.') || ext.id.startsWith('ms-vscode.')) {
            continue;
        }

        const pkg = ext.packageJSON;
        const containers = pkg?.contributes?.viewsContainers?.activitybar;

        if (Array.isArray(containers)) {
            for (const c of containers) {
                if (!c.id) continue;
                const cmd = `workbench.view.extension.${c.id}`;
                if (existingCommands.has(cmd.toLowerCase())) {
                    continue;
                }
                existingCommands.add(cmd.toLowerCase());

                const rawTitle = c.title || pkg.displayName || ext.id;
                const cleanLabel = rawTitle.length > 22 ? rawTitle.substring(0, 20) + '...' : rawTitle;

                list.push({
                    id: `ext_${c.id}`,
                    label: cleanLabel,
                    icon: '🔌',
                    command: cmd,
                    category: 'installed',
                    extensionId: ext.id,
                    description: pkg.description?.substring(0, 60)
                });
            }
        }
    }

    return list;
}

/**
 * Focuses and activates a specific sidebar view or extension panel in VS Code.
 */
export async function activateSidebarView(command: string): Promise<boolean> {
    try {
        await vscode.commands.executeCommand(command);
        // Wait 800ms for UI to render
        await new Promise(resolve => setTimeout(resolve, 800));
        return true;
    } catch (e: any) {
        console.warn(`[ExtensionsManager] Failed to execute view command ${command}:`, e.message);
        return false;
    }
}

/**
 * Builds the interactive Telegram inline keyboard for sidebar views and extensions.
 * Supports collapsible/expandable view for extra installed extensions.
 */
export function buildExtensionsKeyboard(expanded: boolean = false, lang: string = 'en'): any[][] {
    const isAr = lang === 'ar';
    const allViews = getDiscoveredSidebarViews();
    const rows: any[][] = [];

    // 1. Primary Views (Source Control, GitHub Actions, Explorer, etc.)
    const primaryViews = allViews.filter(v => v.category === 'primary');
    for (let i = 0; i < primaryViews.length; i += 2) {
        const slice = primaryViews.slice(i, i + 2);
        rows.push(
            slice.map(v => ({
                text: `${v.icon} ${v.label}`,
                callback_data: `ext_open:${v.id}`
            }))
        );
    }

    // 2. Extra Views (Built-in + Installed extensions)
    const extraViews = allViews.filter(v => v.category !== 'primary');

    if (expanded) {
        // Section divider header
        rows.push([
            {
                text: isAr ? '── 🧩 باقي الإضافات والواجهات ──' : '── 🧩 Additional Views & Extensions ──',
                callback_data: 'ext_header:noop'
            }
        ]);

        for (let i = 0; i < extraViews.length; i += 2) {
            const slice = extraViews.slice(i, i + 2);
            rows.push(
                slice.map(v => ({
                    text: `${v.icon} ${v.label}`,
                    callback_data: `ext_open:${v.id}`
                }))
            );
        }

        // Collapse toggle button
        rows.push([
            {
                text: isAr ? '➖ إخفاء الإضافات الإضافية ▴' : '➖ Collapse Extra Views ▴',
                callback_data: 'ext_toggle:collapse'
            }
        ]);
    } else {
        // Expand toggle button
        const count = extraViews.length;
        const expandText = isAr
            ? `➕ عرض باقي الإضافات والواجهات (${count}) ▾`
            : `➕ Show More Extensions & Views (${count}) ▾`;
        rows.push([
            {
                text: expandText,
                callback_data: 'ext_toggle:expand'
            }
        ]);
    }

    // Bottom Navigation Bar: Command Center Widget Home
    rows.push([
        {
            text: isAr ? '🎛️ لوحة الأوامر' : '🎛️ Command Center',
            callback_data: 'widget_home:main'
        }
    ]);

    return rows;
}
