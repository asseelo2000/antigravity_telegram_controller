import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { getAgentActivitySnapshot } from './cdp_chat';

const SOUND_COOLDOWN_MS = 2500;
const SOUND_PLAY_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 1500;
const IDLE_CONFIRM_POLLS = 2;
const DEFAULT_SOUND_VOLUME_PERCENT = 300;
const MIN_SOUND_VOLUME_PERCENT = 0;
const MAX_SOUND_VOLUME_PERCENT = 800;
const BOOSTED_WAV_TEMP_PATH = path.join(os.tmpdir(), 'ag_telegram_boosted_alert.wav');

let lastSoundPlayedAt = 0;
let isSoundPlaying = false;
let cachedBoostKey = '';

interface SystemSoundSpec {
    dir: string;
    extensions: string[];
    defaultFile: string;
}

/**
 * Returns the OS system sounds directory, supported audio extensions, and default chime.
 */
function getSystemSoundSpec(): SystemSoundSpec {
    if (process.platform === 'win32') {
        const winDir = process.env.WINDIR || 'C:\\Windows';
        return {
            dir: path.join(winDir, 'Media'),
            extensions: ['.wav'],
            defaultFile: 'Windows Notify System Generic.wav'
        };
    }
    if (process.platform === 'darwin') {
        return {
            dir: '/System/Library/Sounds',
            extensions: ['.aiff', '.wav'],
            defaultFile: 'Glass.aiff'
        };
    }
    return {
        dir: '/usr/share/sounds/freedesktop/stereo',
        extensions: ['.oga', '.ogg', '.wav'],
        defaultFile: 'complete.oga'
    };
}

/**
 * Lists all audio files available in the OS system sounds directory.
 */
export function getAvailableSystemSounds(): string[] {
    const spec = getSystemSoundSpec();
    try {
        if (!fs.existsSync(spec.dir)) {
            return [];
        }
        return fs.readdirSync(spec.dir)
            .filter((name) => {
                const ext = path.extname(name).toLowerCase();
                if (!spec.extensions.includes(ext)) {
                    return false;
                }
                try {
                    return fs.statSync(path.join(spec.dir, name)).isFile();
                } catch (_) {
                    return false;
                }
            })
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch (_) {
        return [];
    }
}

/**
 * Resolves a requested or configured filename strictly within the OS system sounds folder.
 */
function resolveSystemSoundPath(requestedFile?: string): string | null {
    const spec = getSystemSoundSpec();
    const cfgFile = vscode.workspace.getConfiguration('antigravityTelegramControl').get<string>('soundAlertFile') || '';
    const rawName = (requestedFile !== undefined ? requestedFile : cfgFile).trim();
    const candidateName = path.basename(rawName || spec.defaultFile);

    const candidateExt = path.extname(candidateName).toLowerCase();
    if (candidateName && spec.extensions.includes(candidateExt)) {
        const candidatePath = path.join(spec.dir, candidateName);
        try {
            if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
                return candidatePath;
            }
        } catch (_) {
            // Fall through to default file lookup
        }
    }

    const fallbackPath = path.join(spec.dir, spec.defaultFile);
    try {
        if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isFile()) {
            return fallbackPath;
        }
    } catch (_) {
        // Return null if default sound file is unavailable on disk
    }
    return null;
}

/**
 * Executes an external OS audio command without spawning a shell window.
 */
function runAudioCommand(command: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<boolean> {
    return new Promise((resolve) => {
        execFile(command, args, {
            windowsHide: true,
            timeout: SOUND_PLAY_TIMEOUT_MS,
            env: extraEnv ? { ...process.env, ...extraEnv } : process.env
        }, (err) => {
            resolve(!err);
        });
    });
}

/**
 * Normalizes the amplification percentage slider value within [0, 800].
 */
function normalizeVolumePercent(volumePercent?: number): number {
    const raw = (typeof volumePercent === 'number' && !isNaN(volumePercent))
        ? volumePercent
        : (vscode.workspace.getConfiguration('antigravityTelegramControl').get<number>('soundAlertVolume') ?? DEFAULT_SOUND_VOLUME_PERCENT);
    return Math.max(MIN_SOUND_VOLUME_PERCENT, Math.min(MAX_SOUND_VOLUME_PERCENT, Math.round(raw)));
}

/**
 * Scales a normalized [-1.0, 1.0] PCM sample with a soft-knee limiter above 0.8
 * so heavy amplification boosts quiet WAV alerts without harsh clipping distortion.
 */
function applyGainWithSoftLimiter(normalized: number, gain: number): number {
    const scaled = normalized * gain;
    if (gain <= 1) {
        return Math.max(-1, Math.min(1, scaled));
    }
    const abs = Math.abs(scaled);
    if (abs <= 0.8) {
        return scaled;
    }
    return Math.sign(scaled) * (0.8 + 0.2 * Math.tanh((abs - 0.8) / 0.2));
}

/**
 * Creates or reuses a cached gain-adjusted WAV file in the OS temp directory when
 * volumePercent differs from 100%. Returns the source path directly on non-WAV or failure.
 */
function preparePlayableSoundPath(sourcePath: string | null, volumePercent: number): string | null {
    if (!sourcePath || volumePercent === 100 || !sourcePath.toLowerCase().endsWith('.wav')) {
        return sourcePath;
    }

    try {
        const stat = fs.statSync(sourcePath);
        const cacheKey = `${sourcePath}|${stat.mtimeMs}|${volumePercent}`;
        if (cachedBoostKey === cacheKey && fs.existsSync(BOOSTED_WAV_TEMP_PATH)) {
            return BOOSTED_WAV_TEMP_PATH;
        }

        const buf = Buffer.from(fs.readFileSync(sourcePath));
        if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
            return sourcePath;
        }

        let offset = 12;
        let audioFormat = 0;
        let bitsPerSample = 0;
        let dataOffset = 0;
        let dataEnd = 0;

        while (offset + 8 <= buf.length) {
            const chunkId = buf.toString('ascii', offset, offset + 4);
            const chunkSize = buf.readUInt32LE(offset + 4);
            if (chunkId === 'fmt ' && chunkSize >= 16 && offset + 24 <= buf.length) {
                audioFormat = buf.readUInt16LE(offset + 8);
                bitsPerSample = buf.readUInt16LE(offset + 22);
            } else if (chunkId === 'data') {
                dataOffset = offset + 8;
                dataEnd = Math.min(buf.length, dataOffset + chunkSize);
            }
            offset += 8 + chunkSize + (chunkSize % 2);
        }

        if (!dataOffset || dataEnd <= dataOffset) {
            return sourcePath;
        }

        const gain = volumePercent / 100;
        if (audioFormat === 1 && bitsPerSample === 16) {
            for (let i = dataOffset; i + 1 < dataEnd; i += 2) {
                const sample = applyGainWithSoftLimiter(buf.readInt16LE(i) / 32768, gain);
                buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i);
            }
        } else if (audioFormat === 1 && bitsPerSample === 8) {
            for (let i = dataOffset; i < dataEnd; i++) {
                const sample = applyGainWithSoftLimiter((buf.readUInt8(i) - 128) / 128, gain);
                buf.writeUInt8(Math.max(0, Math.min(255, Math.round(sample * 127) + 128)), i);
            }
        } else if (audioFormat === 1 && bitsPerSample === 24) {
            for (let i = dataOffset; i + 2 < dataEnd; i += 3) {
                let raw = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16);
                if (raw & 0x800000) {
                    raw -= 0x1000000;
                }
                const scaled = Math.max(-8388608, Math.min(8388607, Math.round(applyGainWithSoftLimiter(raw / 8388608, gain) * 8388607)));
                const unsigned = scaled < 0 ? scaled + 0x1000000 : scaled;
                buf[i] = unsigned & 0xff;
                buf[i + 1] = (unsigned >> 8) & 0xff;
                buf[i + 2] = (unsigned >> 16) & 0xff;
            }
        } else if (audioFormat === 3 && bitsPerSample === 32) {
            for (let i = dataOffset; i + 3 < dataEnd; i += 4) {
                buf.writeFloatLE(applyGainWithSoftLimiter(buf.readFloatLE(i), gain), i);
            }
        } else {
            return sourcePath;
        }

        fs.writeFileSync(BOOSTED_WAV_TEMP_PATH, buf);
        cachedBoostKey = cacheKey;
        return BOOSTED_WAV_TEMP_PATH;
    } catch (_) {
        return sourcePath;
    }
}

/**
 * Plays a local system notification sound on the host machine when enabled.
 * Includes overlap and cooldown protection to prevent duplicate chimes.
 */
export async function playNotificationSound(force = false, soundFile?: string, volumePercent?: number): Promise<boolean> {
    const now = Date.now();
    if (!force && (isSoundPlaying || (now - lastSoundPlayedAt) < SOUND_COOLDOWN_MS)) {
        return false;
    }

    const effectiveVolume = normalizeVolumePercent(volumePercent);
    if (effectiveVolume <= 0) {
        return false;
    }

    isSoundPlaying = true;
    lastSoundPlayedAt = now;

    try {
        const resolvedSource = resolveSystemSoundPath(soundFile);
        const soundPath = preparePlayableSoundPath(resolvedSource, effectiveVolume);

        if (process.platform === 'win32') {
            // Pass resolved WAV path via environment variable so filenames with spaces/symbols are safe
            const psScript = 'if ($env:AG_SOUND_PATH -and (Test-Path -LiteralPath $env:AG_SOUND_PATH)) { (New-Object System.Media.SoundPlayer $env:AG_SOUND_PATH).PlaySync() } else { [System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 600 }';
            const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
            const soundEnv: NodeJS.ProcessEnv = {};
            const envKey = 'AG_SOUND_PATH';
            soundEnv[envKey] = soundPath || '';
            return await runAudioCommand('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-WindowStyle',
                'Hidden',
                '-EncodedCommand',
                encodedCommand
            ], soundEnv);
        }

        if (process.platform === 'darwin') {
            return await runAudioCommand('afplay', [soundPath || '/System/Library/Sounds/Glass.aiff']);
        }

        // Linux desktop notification sound with fallback
        const played = await runAudioCommand('paplay', [soundPath || '/usr/share/sounds/freedesktop/stereo/complete.oga']);
        if (played) {
            return true;
        }
        return await runAudioCommand('canberra-gtk-play', ['-i', 'complete']);
    } finally {
        lastSoundPlayedAt = Date.now();
        isSoundPlaying = false;
    }
}

/**
 * Monitors the active Antigravity chat in the background (independent of Telegram)
 * and plays a local sound alert whenever the Agent completes a response or asks a question.
 */
export class AgentCompletionSoundWatcher implements vscode.Disposable {
    private timer: NodeJS.Timeout | undefined;
    private configListener: vscode.Disposable | undefined;
    private isChecking = false;
    private hasBaseline = false;
    private wasGenerating = false;
    private idleConfirmCount = 0;
    private lastQuestionKey: string | null = null;

    constructor() {
        this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('antigravityTelegramControl.soundAlertEnabled')) {
                this.syncWithConfig();
            }
        });
    }

    /**
     * Starts or stops the watcher based on current extension settings.
     */
    public syncWithConfig(): void {
        if (this.isEnabled()) {
            this.start();
        } else {
            this.stop();
        }
    }

    /**
     * Starts periodic background polling for completion and question transitions.
     */
    public start(): void {
        if (this.timer || !this.isEnabled()) {
            return;
        }

        this.resetState();
        this.timer = setInterval(() => {
            void this.poll();
        }, POLL_INTERVAL_MS);
    }

    /**
     * Stops periodic background polling and resets transition state.
     */
    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.isChecking = false;
        this.resetState();
    }

    /**
     * Plays the completion chime if enabled (deduplicated via global sound cooldown).
     */
    public notifyAlertIfEnabled(): void {
        if (!this.isEnabled()) {
            return;
        }
        void playNotificationSound();
    }

    public dispose(): void {
        this.stop();
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = undefined;
        }
        try {
            if (fs.existsSync(BOOSTED_WAV_TEMP_PATH)) {
                fs.unlinkSync(BOOSTED_WAV_TEMP_PATH);
            }
        } catch (_) {
            // Ignore temp cleanup failures on shutdown
        }
    }

    private isEnabled(): boolean {
        const cfg = vscode.workspace.getConfiguration('antigravityTelegramControl');
        return cfg.get<boolean>('soundAlertEnabled') ?? true;
    }

    private resetState(): void {
        this.hasBaseline = false;
        this.wasGenerating = false;
        this.idleConfirmCount = 0;
        this.lastQuestionKey = null;
    }

    private async poll(): Promise<void> {
        if (this.isChecking || !this.isEnabled()) {
            return;
        }
        this.isChecking = true;

        try {
            const cfg = vscode.workspace.getConfiguration('antigravityTelegramControl');
            const port = cfg.get<number>('debuggingPort') ?? 9222;
            const snapshot = await getAgentActivitySnapshot(port);

            const q = snapshot.pendingQuestion;
            const questionKey = (q && q.hasQuestion)
                ? `${q.questionText}::${q.options.map(o => o.text).join('|')}`
                : null;

            // Record initial IDE state without firing a stale sound on startup/reload
            if (!this.hasBaseline) {
                this.hasBaseline = true;
                this.wasGenerating = snapshot.isGenerating;
                this.lastQuestionKey = questionKey;
                this.idleConfirmCount = 0;
                return;
            }

            if (questionKey) {
                if (questionKey !== this.lastQuestionKey) {
                    this.lastQuestionKey = questionKey;
                    // Pause completion tracking while waiting for user input to avoid double dings
                    this.wasGenerating = false;
                    this.idleConfirmCount = 0;
                    void playNotificationSound();
                } else {
                    this.idleConfirmCount = 0;
                }
                return;
            }

            this.lastQuestionKey = null;

            if (snapshot.isGenerating) {
                this.wasGenerating = true;
                this.idleConfirmCount = 0;
                return;
            }

            if (this.wasGenerating && snapshot.hasChat && snapshot.isIdle) {
                this.idleConfirmCount++;
                if (this.idleConfirmCount >= IDLE_CONFIRM_POLLS) {
                    this.wasGenerating = false;
                    this.idleConfirmCount = 0;
                    void playNotificationSound();
                }
            } else {
                this.idleConfirmCount = 0;
            }
        } catch (_) {
            // Suppress transient CDP errors when IDE debugging port is busy or unavailable
        } finally {
            this.isChecking = false;
        }
    }
}
