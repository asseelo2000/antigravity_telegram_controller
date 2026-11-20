// src/question_watcher.ts
// Background monitor that continuously detects pending interactive Agent questions
// and triggers Telegram notification with inline keyboard choices.

import * as vscode from 'vscode';
import { getPendingAgentQuestion, PendingAgentQuestion } from './cdp_chat';

/**
 * AgentQuestionWatcher runs a lightweight background polling loop
 * to detect when Antigravity Agent presents an interactive question modal or card.
 */
export class AgentQuestionWatcher implements vscode.Disposable {
    // Background polling timer
    private timer: NodeJS.Timeout | undefined;
    // Mutex flag to prevent overlapping poll operations
    private isChecking = false;
    // Fingerprint of the last notified question to prevent duplicate spam
    private lastNotifiedKey: string | null = null;
    // Check interval in milliseconds (default 2500ms)
    private checkIntervalMs = 2500;

    constructor(
        private readonly onQuestionDetected: (question: PendingAgentQuestion, port: number) => Promise<void>
    ) {}

    /**
     * Start the background watcher.
     */
    public start(): void {
        if (this.timer) {
            return;
        }

        const config = vscode.workspace.getConfiguration('antigravityTelegramControl');
        this.checkIntervalMs = Math.max(1000, config.get<number>('questionWatchIntervalMs') ?? 2500);

        // Schedule periodic check
        this.timer = setInterval(() => this.poll(), this.checkIntervalMs);
    }

    /**
     * Stop the background watcher.
     */
    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.isChecking = false;
        this.lastNotifiedKey = null;
    }

    /**
     * Clear the last notified key so subsequent questions or retries can re-trigger immediately.
     */
    public resetLastNotified(): void {
        this.lastNotifiedKey = null;
    }

    /**
     * Single check iteration across CDP targets.
     */
    private async poll(): Promise<void> {
        // Prevent concurrent check loops
        if (this.isChecking) {
            return;
        }
        this.isChecking = true;

        try {
            const config = vscode.workspace.getConfiguration('antigravityTelegramControl');
            // Check if automatic question notification is enabled
            const enabled = config.get<boolean>('autoNotifyQuestions') ?? true;
            if (!enabled) {
                return;
            }

            const port = config.get<number>('debuggingPort') ?? 9222;
            const questionData = await getPendingAgentQuestion(port);

            if (questionData && questionData.hasQuestion) {
                // Construct a unique key from question text and option choices
                const optKey = questionData.options.map(o => o.text).join('|');
                const currentKey = `${questionData.questionText}::${optKey}`;

                // Only notify if this is a newly appeared question
                if (currentKey !== this.lastNotifiedKey) {
                    this.lastNotifiedKey = currentKey;
                    console.log('[QuestionWatcher] Detected active agent question. Forwarding to Telegram...');
                    await this.onQuestionDetected(questionData, port);
                }
            } else {
                // When question is answered, dismissed, or no longer waiting, reset state
                this.lastNotifiedKey = null;
            }
        } catch (err: any) {
            // Silently swallow transient errors during background poll
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Dispose resources when extension deactivates.
     */
    public dispose(): void {
        this.stop();
    }
}
