'use strict';

const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createInterface } = require('node:readline');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const execFileAsync = promisify(execFile);
const { generateExecImage } = require('./exec-transport.cjs');
const { cliPackage, firstWindowsCommand, resolveNpmInstallation, backupNpmInstallation } = require('./cli-update.cjs');
const IS_TERMUX = process.platform === 'android' || Boolean(process.env.TERMUX_VERSION) || /com\.termux/.test(process.env.PREFIX || '');
const CODEX_TRANSPORT = process.env.ST_CODEX_TRANSPORT || (IS_TERMUX ? 'exec' : 'app-server');
const CLI_UPDATE_ENABLED = process.env.ST_CODEX_ALLOW_CLI_UPDATE === '1';
const CLI_AUTO_UPDATE_ENABLED = process.env.ST_CODEX_AUTO_UPDATE !== '0';
const CODEX_NPM_PACKAGE = cliPackage(IS_TERMUX);

const PLUGIN_ID = 'codex-image';
const PLUGIN_ROOT = __dirname;
const OUTPUT_DIR = path.join(PLUGIN_ROOT, 'output');
const WORKSPACE_DIR = path.join(PLUGIN_ROOT, 'workspace');
const JOBS_DIR = path.join(WORKSPACE_DIR, 'jobs');
const MAX_PROMPT_CHARS = 30000;
const MAX_REF_COUNT = 3;
const MAX_REF_BYTES = 12 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 7 * 60 * 1000;
const CLIENT_VERSION = '1.1.0';

let cachedBinary = null;
let cachedStatus = null;
let cachedStatusAt = 0;
let cachedLatestVersion = '';
let cachedLatestAt = 0;
let installedPackageVersion = '';
let cliUpdating = null;
let startupCliUpdate = null;
const cliAutoUpdate = { enabled: CLI_AUTO_UPDATE_ENABLED, state: CLI_AUTO_UPDATE_ENABLED ? 'checking' : 'disabled', error: '' };
let activeGenerations = 0;

const CLI_UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

const CODEX_REGISTRY_URL = `https://registry.npmjs.org/${CODEX_NPM_PACKAGE}/latest`;
const LATEST_VERSION_TTL_MS = 6 * 60 * 60 * 1000;

function safeError(error) {
    if (!error) return 'Unknown error';
    return error.message || String(error);
}

async function ensureDirs() {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.mkdir(JOBS_DIR, { recursive: true });
}

function isCmdFile(binary) {
    return process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
}

async function resolveCodexBinary(force = false) {
    if (cachedBinary && !force) return cachedBinary;

    const configured = String(process.env.ST_CODEX_BIN || '').trim();
    if (configured) {
        cachedBinary = configured;
        return cachedBinary;
    }

    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('where.exe', ['codex'], { windowsHide: true, timeout: 10000 });
            const found = String(stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
            const preferred = firstWindowsCommand(found);
            if (preferred) {
                cachedBinary = preferred;
                return cachedBinary;
            }
        } else {
            const { stdout } = await execFileAsync('which', ['codex'], { timeout: 10000 });
            const found = String(stdout || '').trim();
            if (found) {
                cachedBinary = found.split(/\r?\n/)[0];
                return cachedBinary;
            }
        }
    } catch (_) {
        // handled below
    }

    throw new Error('Codex CLI를 찾지 못했습니다. Codex CLI를 설치한 뒤 SillyTavern을 재시작하세요. (서버 환경변수 ST_CODEX_BIN으로 경로 지정 가능)');
}

function runCodexCommand(binary, args, { timeout = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            windowsHide: true,
            shell: isCmdFile(binary),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch (_) {}
            reject(new Error(`codex ${args.join(' ')} timed out`));
        }, timeout);

        child.stdout?.on('data', d => { stdout += d.toString(); });
        child.stderr?.on('data', d => { stderr += d.toString(); });
        child.once('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        });
    });
}

function parseVersion(text) {
    const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?/);
    return match ? { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') || [] } : null;
}

function isNewerVersion(latest, current) {
    const a = parseVersion(latest);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i];
    }
    if (!a.prerelease.length || !b.prerelease.length) return !a.prerelease.length && Boolean(b.prerelease.length);
    for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
        const left = a.prerelease[i], right = b.prerelease[i];
        if (left === right) continue;
        if (left === undefined || right === undefined) return right === undefined;
        const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
        if (leftNumeric && rightNumeric) return Number(left) > Number(right);
        if (leftNumeric !== rightNumeric) return !leftNumeric;
        return left > right;
    }
    return false;
}

// The model list Codex CLI returns depends on the CLI version, so an outdated CLI
// silently hides newer models. Ask the npm registry what the latest release is.
async function getLatestCodexVersion(force = false) {
    const now = Date.now();
    if (!force && cachedLatestAt && now - cachedLatestAt < LATEST_VERSION_TTL_MS) return cachedLatestVersion;
    try {
        const response = await fetch(CODEX_REGISTRY_URL, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`registry ${response.status}`);
        const json = await response.json();
        cachedLatestVersion = parseVersion(json?.version) ? String(json.version) : '';
    } catch (_) {
        // Offline or registry unreachable: keep whatever we knew before.
    }
    cachedLatestAt = now;
    return cachedLatestVersion;
}

// The package is selected locally by platform; request bodies cannot change the npm command.
async function detectCliInstallation(binary) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const root = await runCodexCommand(npm, ['root', '-g']);
    if (root.code !== 0 || !root.stdout) throw new Error('npm 전역 설치 경로를 확인하지 못했습니다.');
    const installation = await resolveNpmInstallation(binary, root.stdout.trim(), CODEX_NPM_PACKAGE);
    installedPackageVersion = installation.version;
    return installation;
}

async function updateCodexCli(knownInstallation = null) {
    if (cliUpdating) return await cliUpdating;
    if (activeGenerations > 0) throw new Error('이미지 생성 중에는 업데이트할 수 없습니다. 생성이 끝난 뒤 다시 시도하세요.');
    cliUpdating = (async () => {
        const before = (await getCodexStatus(true)).version;
        const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const installation = knownInstallation || await detectCliInstallation(await resolveCodexBinary());
        const backup = await backupNpmInstallation(installation, path.join(WORKSPACE_DIR, 'cli-backups'));
        console.log(`[${PLUGIN_ID}] CLI ${installation.version} backup verified: ${backup}`);
        const result = await runCodexCommand(npm, ['install', '-g', `${CODEX_NPM_PACKAGE}@latest`], { timeout: CLI_UPDATE_TIMEOUT_MS });
        if (result.code !== 0) throw new Error(`npm install 실패 (exit ${result.code})\n${(result.stderr || result.stdout).slice(-1500)}`);
        cachedBinary = null;
        await detectCliInstallation(await resolveCodexBinary(true));
        const status = await getCodexStatus(true);
        if (!status.available) throw new Error('업데이트 후 Codex CLI 실행을 확인하지 못했습니다. CLI 백업과 서버 로그를 확인하세요.');
        cliAutoUpdate.error = '';
        cliAutoUpdate.state = 'updated';
        return { before, after: status.version, status: statusWithMaintenance(status) };
    })();
    try {
        return await cliUpdating;
    } finally {
        cliUpdating = null;
    }
}

async function updateCliAtStartup() {
    if (!CLI_AUTO_UPDATE_ENABLED) return;
    try {
        const status = await getCodexStatus(true);
        if (!status.available) { cliAutoUpdate.state = 'unavailable'; return; }
        if (!status.latestVersion) throw new Error('CLI 최신 버전을 확인하지 못했습니다. 다음 시작 시 다시 시도합니다.');
        const installation = await detectCliInstallation(await resolveCodexBinary());
        if (!isNewerVersion(status.latestVersion, installation.version)) { cliAutoUpdate.state = 'current'; return; }
        cliAutoUpdate.state = 'updating';
        const result = await updateCodexCli(installation);
        cliAutoUpdate.state = 'updated';
        console.log(`[${PLUGIN_ID}] CLI auto-update: ${result.before} -> ${result.after}`);
    } catch (error) {
        cliAutoUpdate.state = error.code === 'UNSUPPORTED_INSTALL' ? 'unsupported' : 'failed';
        cliAutoUpdate.error = safeError(error);
        console.warn(`[${PLUGIN_ID}] CLI auto-update: ${cliAutoUpdate.error}`);
    }
}

function cliMaintenancePending() {
    return Boolean(cliUpdating) || ['checking', 'updating'].includes(cliAutoUpdate.state);
}

function statusWithMaintenance(status) {
    return { ...status, installedPackageVersion,
        updateAvailable: isNewerVersion(status.latestVersion, installedPackageVersion || status.version),
        cliAutoUpdate: { ...cliAutoUpdate } };
}

async function getCodexStatus(force = false) {
    const now = Date.now();
    if (!force && cachedStatus && now - cachedStatusAt < 10000) return statusWithMaintenance(cachedStatus);

    const status = {
        available: false,
        binary: '',
        version: '',
        latestVersion: '',
        updateAvailable: false,
        loginStatus: '',
        loggedInWithChatGPT: false,
        imageGenerationFeature: null,
        error: '',
        transport: CODEX_TRANSPORT,
        modelRequired: CODEX_TRANSPORT !== 'exec',
        cliUpdateEnabled: CLI_UPDATE_ENABLED,
    };

    try {
        if (!['exec', 'app-server'].includes(CODEX_TRANSPORT)) throw new Error('ST_CODEX_TRANSPORT는 exec 또는 app-server여야 합니다.');
        const binary = await resolveCodexBinary(force);
        status.binary = binary;

        const version = await runCodexCommand(binary, ['--version']);
        if (version.code !== 0) throw new Error(version.stderr || version.stdout || 'codex --version failed');
        status.version = version.stdout || version.stderr;
        status.available = true;

        status.latestVersion = await getLatestCodexVersion(force);
        status.updateAvailable = isNewerVersion(status.latestVersion, status.version);

        try {
            const login = await runCodexCommand(binary, ['login', 'status']);
            status.loginStatus = login.stdout || login.stderr || `exit ${login.code}`;
            status.loggedInWithChatGPT = /chatgpt/i.test(status.loginStatus) && login.code === 0;
        } catch (error) {
            status.loginStatus = safeError(error);
        }

        try {
            const features = await runCodexCommand(binary, ['features', 'list']);
            const line = (features.stdout || '').split(/\r?\n/).find(x => /image[_-]generation/i.test(x));
            if (line) status.imageGenerationFeature = line.trim();
        } catch (_) {
            // Older/newer Codex CLI builds may not expose this command. Generation itself is the authority.
        }
    } catch (error) {
        status.error = safeError(error);
    }

    cachedStatus = status;
    cachedStatusAt = now;
    return statusWithMaintenance(status);
}

class CodexAppServer extends EventEmitter {
    constructor(binary, cwd) {
        super();
        this.binary = binary;
        this.cwd = cwd;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map();
        this.stderr = '';
        this.closed = false;
    }

    async start() {
        this.child = spawn(this.binary, ['app-server'], {
            cwd: this.cwd,
            windowsHide: true,
            shell: isCmdFile(this.binary),
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.child.stderr?.on('data', chunk => {
            this.stderr = (this.stderr + chunk.toString()).slice(-16000);
        });

        this.child.once('error', error => this.#failAll(error));
        this.child.once('close', code => {
            if (!this.closed && code !== 0) {
                this.#failAll(new Error(`codex app-server exited (${code}): ${this.stderr.slice(-2000)}`));
            }
            this.emit('close', code);
        });

        const rl = createInterface({ input: this.child.stdout });
        rl.on('line', line => this.#handleLine(line));

        await this.request('initialize', {
            clientInfo: {
                name: 'sillytavern_codex_image',
                title: 'SillyTavern Codex CLI Image',
                version: CLIENT_VERSION,
            },
        }, 30000);
        this.notify('initialized', {});
    }

    #handleLine(line) {
        const text = String(line || '').trim();
        if (!text) return;
        let message;
        try {
            message = JSON.parse(text);
        } catch (_) {
            this.stderr = (this.stderr + `\n[non-json stdout] ${text}`).slice(-16000);
            return;
        }

        if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.error) {
                pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        // App-server can send server-initiated requests. This integration never authorizes
        // commands/file changes; it is an image-only client.
        if (message.method && Object.prototype.hasOwnProperty.call(message, 'id')) {
            if (/requestApproval$/i.test(message.method)) {
                this.#write({ id: message.id, result: { decision: 'decline' } });
            } else if (message.method === 'item/tool/requestUserInput') {
                this.#write({ id: message.id, result: { answers: {} } });
            } else {
                this.#write({ id: message.id, error: { code: -32601, message: `Unsupported client request: ${message.method}` } });
            }
            return;
        }

        if (message.method) this.emit('notification', message.method, message.params || {});
    }

    #write(payload) {
        if (!this.child?.stdin || this.child.stdin.destroyed) throw new Error('Codex CLI app-server stdin is unavailable');
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    }

    request(method, params = {}, timeoutMs = 60000) {
        if (this.closed) return Promise.reject(new Error('Codex CLI app-server is closed'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.#write({ method, id, params });
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    notify(method, params = {}) {
        try { this.#write({ method, params }); } catch (_) {}
    }

    #failAll(error) {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    close() {
        this.closed = true;
        this.#failAll(new Error('Codex CLI app-server closed'));
        try { this.child?.stdin?.end(); } catch (_) {}
        try { this.child?.kill(); } catch (_) {}
    }
}

function decodeDataUrl(dataUrl) {
    const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('참조 이미지는 PNG/JPEG/WebP data URL만 지원합니다.');
    const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
    const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!bytes.length) throw new Error('빈 참조 이미지입니다.');
    if (bytes.length > MAX_REF_BYTES) throw new Error('참조 이미지 한 장은 12MB 이하여야 합니다.');
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    return { bytes, ext, mime };
}

function sanitizeRefs(refs) {
    if (!Array.isArray(refs)) return [];
    const allowedSlots = new Set(['char', 'persona', 'style']);
    const out = [];
    for (const ref of refs.slice(0, MAX_REF_COUNT)) {
        if (!ref || !allowedSlots.has(ref.slot) || !ref.dataUrl) continue;
        const parsed = decodeDataUrl(ref.dataUrl);
        out.push({ slot: ref.slot, ...parsed });
    }
    return out;
}

async function writeReferenceFiles(jobDir, refs) {
    const refDir = path.join(jobDir, 'refs');
    await fs.mkdir(refDir, { recursive: true });
    const files = [];
    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const filePath = path.join(refDir, `${String(i + 1).padStart(2, '0')}-${ref.slot}.${ref.ext}`);
        await fs.writeFile(filePath, ref.bytes);
        files.push({ slot: ref.slot, path: filePath });
    }
    return files;
}

function buildCodexInstruction(prompt, mode, sizeHint, qualityHint, refFiles) {
    const modeText = mode === 'solo'
        ? 'SOLO portrait: focus on one prominent character only; other people must not appear.'
        : 'SCENE shot: depict one coherent, visually striking instant from the roleplay scene.';

    const refs = refFiles.map((ref, index) => {
        if (ref.slot === 'style') {
            return [
                `${index + 1}. STYLE REFERENCE — GLOBAL RENDERING ONLY: ${ref.path}`,
                'Treat this image strictly as a reference for the global visual language, not as a character or content reference.',
                'Ignore the depicted person as content. Do not copy or derive their identity, face, facial proportions, hairstyle, hair color, body, clothing, pose, expression, accessories, or composition.',
                'Extract only the line weight, inking, contour treatment, shape simplification, coloring, cel shading, gradients, textures, lighting, contrast, highlights, shadow design, background rendering, effects, atmosphere, and overall webtoon/comic finish.',
                'Apply that visual language consistently to the ENTIRE generated image: every character, face, hair, garment, prop, structure, background, light, effect, and visible region of the canvas.',
                'The scene prompt determines what appears, and CHARACTER/PERSONA references determine identity only. This STYLE reference must never determine a person\'s identity or appearance.',
                'Create a completely new scene rendered in the same overall visual language; do not recreate the subject or composition shown in the STYLE reference.',
            ].join(' ');
        }
        const label = ref.slot === 'char' ? 'CHARACTER' : 'PERSONA';
        return `${index + 1}. ${label} appearance reference: ${ref.path} — preserve face/hair/identity only; outfit, pose, expression, and background must follow the scene prompt.`;
    }).join('\n');

    const hasStyleRef = refFiles.some(ref => ref.slot === 'style');
    const globalStylePriority = hasStyleRef
        ? 'GLOBAL STYLE PRIORITY: Render 100% of the canvas in the STYLE reference\'s visual language. Do not apply it selectively only to a character\'s face or hair. The background and all non-character elements must visibly share the same linework, coloring, shading, lighting, texture, atmosphere, and webtoon/comic finish. Preserve identities only from CHARACTER/PERSONA references; never import a person\'s identity or appearance from the STYLE reference.'
        : '';

    return [
        'Create exactly ONE image by calling Codex CLI\'s built-in image generation tool.',
        'Do not use shell commands, Python drawing/image libraries, or the API-key fallback image script. Do not ask for an API key.',
        'Do not return a text-only answer when image generation is available.',
        modeText,
        `Preferred canvas: ${sizeHint || 'auto'}. Preferred detail/quality: ${qualityHint || 'auto'}. These are visual preferences; if the built-in tool only supports auto sizing/quality, proceed with auto instead of failing.`,
        refs ? `\nREFERENCE IMAGES\n${refs}\nWhen calling the image tool, pass these local paths as referenced image paths in the same order.` : '',
        globalStylePriority ? `\n${globalStylePriority}` : '',
        '\nVISUAL PROMPT',
        prompt,
    ].filter(Boolean).join('\n');
}

function waitForImageTurn(session, expectedTurnId, timeoutMs) {
    return new Promise((resolve, reject) => {
        let imageItem = null;
        let lastAgentText = '';
        let warningText = '';
        let settled = false;

        const cleanup = () => {
            clearTimeout(timer);
            session.off('notification', onNotification);
            session.off('close', onClose);
        };
        const finishReject = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const finishResolve = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const onClose = code => {
            if (!settled) finishReject(new Error(`Codex CLI app-server가 응답 도중 종료되었습니다. (${code})`));
        };
        const onNotification = (method, params) => {
            if (method === 'warning' || method === 'configWarning') {
                warningText = [warningText, params.message || params.summary || params.details || ''].filter(Boolean).join('\n').slice(-4000);
                return;
            }
            if (method === 'item/completed') {
                const item = params.item || {};
                if (['imageGeneration', 'image_generation'].includes(item.type) && item.result) imageItem = item;
                if (item.type === 'agentMessage' && item.text) lastAgentText = item.text;
                return;
            }
            if (method === 'turn/completed') {
                const turn = params.turn || {};
                if (expectedTurnId && turn.id && turn.id !== expectedTurnId) return;
                if (turn.status === 'failed') {
                    const reason = turn.error?.message || turn.error?.additionalDetails || lastAgentText || warningText || 'Codex CLI turn failed';
                    finishReject(new Error(reason));
                    return;
                }
                if (!imageItem?.result) {
                    const detail = lastAgentText || warningText || 'imageGeneration 결과가 수신되지 않았습니다.';
                    finishReject(new Error(`Codex CLI가 이미지를 생성하지 못했습니다: ${detail}`));
                    return;
                }
                finishResolve({ imageItem, lastAgentText, warningText });
            }
        };

        session.on('notification', onNotification);
        session.on('close', onClose);
        const timer = setTimeout(() => finishReject(new Error('Codex CLI 이미지 생성 시간이 7분을 초과했습니다.')), timeoutMs);
    });
}

const SANDBOX_CANDIDATES = ['workspace-write', 'read-only'];

function expectedVariantsFrom(message) {
    const match = String(message || '').match(/expected one of (.+)$/i);
    if (!match) return [];
    return (match[1].match(/`([^`]+)`/g) || []).map(x => x.replace(/`/g, '').trim()).filter(Boolean);
}

async function listCodexModels(session) {
    const models = new Map();
    const cursors = new Set();
    let cursor;
    do {
        const page = await session.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, 30000);
        if (!Array.isArray(page?.data)) throw new Error('Codex CLI 모델 목록 응답 형식이 올바르지 않습니다.');
        for (const item of page.data) {
            if (item.hidden || typeof item.model !== 'string' || !item.model.trim()) continue;
            models.set(item.model, { model: item.model, displayName: item.displayName || item.model, isDefault: item.isDefault === true });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Codex CLI 모델 목록 페이지가 반복됩니다.');
        if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!models.size) throw new Error('선택 가능한 Codex CLI 모델이 없습니다. Codex CLI 로그인 상태를 확인하세요.');
    return [...models.values()];
}

async function getCodexModels() {
    if (CODEX_TRANSPORT === 'exec') return [];
    const session = new CodexAppServer(await resolveCodexBinary(), PLUGIN_ROOT);
    try {
        await session.start();
        return await listCodexModels(session);
    } finally {
        session.close();
    }
}

async function startThread(session, model) {
    const preferred = String(process.env.ST_CODEX_SANDBOX || '').trim();
    const order = [];
    for (const value of [preferred, ...SANDBOX_CANDIDATES]) {
        if (value && !order.includes(value)) order.push(value);
    }

    let lastError = null;
    for (let i = 0; i < order.length; i++) {
        const sandbox = order[i];
        try {
            const response = await session.request('thread/start', {
                model,
                cwd: WORKSPACE_DIR,
                approvalPolicy: 'never',
                sandbox,
                personality: 'none',
                serviceName: 'sillytavern_codex_image',
                ephemeral: true,
            }, 60000);
            if (i > 0) console.log(`[Chatelier Bridge] sandbox fallback in use: ${sandbox}`);
            return response;
        } catch (error) {
            lastError = error;
            const message = safeError(error);
            if (!/unknown variant|expected one of|invalid request/i.test(message)) throw error;
            for (const variant of expectedVariantsFrom(message)) {
                if (SANDBOX_CANDIDATES.includes(variant) && !order.includes(variant)) order.push(variant);
            }
            console.warn(`[Chatelier Bridge] thread/start rejected sandbox '${sandbox}': ${message}`);
        }
    }
    throw lastError || new Error('Codex CLI thread/start\uc5d0 \uc2e4\ud328\ud588\uc2b5\ub2c8\ub2e4.');
}

async function generateWithCodex({ prompt, model, mode, sizeHint, qualityHint, refs, abortSignal }) {
    await ensureDirs();
    const binary = await resolveCodexBinary();
    const jobId = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const jobDir = path.join(JOBS_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const parsedRefs = sanitizeRefs(refs);
    const refFiles = await writeReferenceFiles(jobDir, parsedRefs);
    const instruction = buildCodexInstruction(prompt, mode, sizeHint, qualityHint, refFiles);

    if (CODEX_TRANSPORT === 'exec') {
        try {
            return await generateExecImage({ binary, instruction, model, refFiles, jobDir, outputDir: OUTPUT_DIR, jobId, abortSignal });
        } finally { await fs.rm(jobDir, { recursive: true, force: true }); }
    }

    const session = new CodexAppServer(binary, WORKSPACE_DIR);
    let abortHandler;
    try {
        await session.start();
        if (abortSignal?.aborted) throw new Error('사용자가 취소했습니다.');

        abortHandler = () => session.close();
        abortSignal?.addEventListener('abort', abortHandler, { once: true });

        const models = await listCodexModels(session);
        if (!models.some(item => item.model === model)) throw new Error('선택한 Codex CLI 모델이 목록에 없습니다. 설정에서 모델 목록을 새로고침하고 다시 선택하세요.');
        const threadResponse = await startThread(session, model);
        const threadId = threadResponse?.thread?.id;
        if (!threadId) throw new Error('Codex CLI thread/start 응답에 thread id가 없습니다.');

        const input = [{ type: 'text', text: instruction }];
        for (const ref of refFiles) input.push({ type: 'localImage', path: ref.path });

        const turnResponse = await session.request('turn/start', { threadId, input }, 60000);
        const turnId = turnResponse?.turn?.id;
        if (!turnId) throw new Error('Codex CLI turn/start 응답에 turn id가 없습니다.');

        const result = await waitForImageTurn(session, turnId, GENERATION_TIMEOUT_MS);
        const base64 = String(result.imageItem.result || '').replace(/^data:image\/[^;]+;base64,/i, '').trim();
        if (!base64) throw new Error('Codex CLI imageGeneration 결과가 비어 있습니다.');

        const bytes = Buffer.from(base64, 'base64');
        if (!bytes.length) throw new Error('Codex CLI 이미지 base64 디코딩에 실패했습니다.');

        const filename = `codex-image-${jobId}.png`;
        await fs.writeFile(path.join(OUTPUT_DIR, filename), bytes);
        return {
            filename,
            revisedPrompt: result.imageItem.revisedPrompt || result.imageItem.revised_prompt || '',
            savedPath: result.imageItem.savedPath || null,
            agentText: result.lastAgentText || '',
            warning: result.warningText || '',
        };
    } finally {
        if (abortHandler) abortSignal?.removeEventListener('abort', abortHandler);
        session.close();
        fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
}

const OUTPUT_NAME_RE = /^(?:codex-image-\d+-[a-f0-9]{8}|vertex-\d+-[a-z0-9]{4,12})\.(png|jpg|jpeg|webp)$/i;

function imageFileFromName(name) {
    const filename = path.basename(String(name || ''));
    if (!OUTPUT_NAME_RE.test(filename)) return null;
    return path.join(OUTPUT_DIR, filename);
}

function contentTypeFor(filename) {
    const ext = path.extname(filename).slice(1).toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
    if (ext === 'webp') return 'webp';
    return 'png';
}

module.exports = {
    info: {
        id: PLUGIN_ID,
        name: 'Chatelier Bridge',
        description: 'Chatelier image bridge for desktop and Termux. Uses the local Codex CLI login.',
    },

    async init(router) {
        await ensureDirs();

        // Run in the background so SillyTavern can start serving while CLI maintenance runs.
        startupCliUpdate = updateCliAtStartup();

        // Check the CLI once at startup without delaying SillyTavern's boot.
        startupCliUpdate.then(() => getCodexStatus(false)).then(status => {
            if (!status.available) console.warn(`[${PLUGIN_ID}] Codex CLI 확인 실패: ${status.error}`);
            else if (status.updateAvailable) console.warn(`[${PLUGIN_ID}] ${status.version} → 최신 ${status.latestVersion} 업데이트 가능 (npm install -g @openai/codex@latest)`);
            else console.log(`[${PLUGIN_ID}] ${status.version}${status.latestVersion ? ' (최신)' : ''}`);
        }).catch(() => {});

        router.get('/status', async (req, res) => {
            try {
                const force = String(req.query?.refresh || '') === '1';
                const status = await getCodexStatus(force);
                res.json({ ok: true, ...status });
            } catch (error) {
                res.status(500).json({ ok: false, error: safeError(error) });
            }
        });

        router.get('/models', async (req, res) => {
            if (cliMaintenancePending()) return res.status(503).json({ ok: false, error: 'Codex CLI 자동 업데이트 확인 중입니다. 잠시 후 새로고침하세요.' });
            try {
                res.json({ ok: true, models: await getCodexModels(), allowCustom: CODEX_TRANSPORT === 'exec', modelRequired: CODEX_TRANSPORT !== 'exec' });
            } catch (error) {
                res.status(503).json({ ok: false, error: safeError(error) });
            }
        });

        router.post('/update-cli', async (_req, res) => {
            if (!CLI_UPDATE_ENABLED) return res.status(403).json({ ok: false, error: 'CLI 업데이트는 서버 터미널에서 실행하세요.' });
            if (cliMaintenancePending()) return res.status(503).json({ ok: false, error: 'Codex CLI 자동 업데이트가 진행 중입니다.' });
            try {
                res.json({ ok: true, ...(await updateCodexCli()) });
            } catch (error) {
                res.status(500).json({ ok: false, error: safeError(error) });
            }
        });

        router.post('/generate', async (req, res) => {
            const startedAt = Date.now();
            const abortController = new AbortController();
            let finished = false;
            const onClosed = () => {
                if (!finished && !res.writableEnded) abortController.abort();
            };
            req.once('aborted', onClosed);
            res.once('close', onClosed);

            try {
                if (cliMaintenancePending()) return res.status(503).json({ ok: false, error: 'Codex CLI 자동 업데이트 확인 중입니다. 완료 후 다시 생성하세요.' });
                const prompt = String(req.body?.prompt || '').trim();
                if (!prompt) return res.status(400).json({ ok: false, error: '이미지 프롬프트가 비어 있습니다.' });
                if (prompt.length > MAX_PROMPT_CHARS) return res.status(400).json({ ok: false, error: `프롬프트가 너무 깁니다. (${MAX_PROMPT_CHARS}자 제한)` });

                const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
                if ((CODEX_TRANSPORT !== 'exec' && !model) || model.length > 200 || model.startsWith('-')) return res.status(400).json({ ok: false, error: 'Chatelier 설정에서 Codex CLI 모델을 선택하세요.' });
                const mode = req.body?.mode === 'solo' ? 'solo' : 'scene';
                const sizeHint = String(req.body?.sizeHint || 'auto').slice(0, 32);
                const qualityHint = String(req.body?.qualityHint || 'auto').slice(0, 32);
                const refs = Array.isArray(req.body?.refs) ? req.body.refs : [];

                const status = await getCodexStatus(false);
                if (!status.available) return res.status(503).json({ ok: false, error: status.error || 'Codex CLI를 사용할 수 없습니다.' });
                if (!status.loggedInWithChatGPT) {
                    const detail = status.loginStatus || '로그인 상태를 확인할 수 없음';
                    return res.status(401).json({ ok: false, error: `ChatGPT 계정으로 로그인한 Codex CLI가 필요합니다. 터미널에서 codex login을 실행하세요. (${detail})` });
                }

                if (CODEX_TRANSPORT === 'exec' && activeGenerations > 0) return res.status(409).json({ ok: false, error: '이미지 생성이 이미 진행 중입니다. 완료 후 다시 시도하세요.' });
                if (cliUpdating) return res.status(503).json({ ok: false, error: 'Codex CLI를 업데이트하는 중입니다. 끝난 뒤 다시 시도하세요.' });
                let result;
                activeGenerations++;
                try {
                    result = await generateWithCodex({ prompt, model, mode, sizeHint, qualityHint, refs, abortSignal: abortController.signal });
                } finally {
                    activeGenerations--;
                }
                finished = true;
                const imageUrl = `/api/plugins/${PLUGIN_ID}/image/${encodeURIComponent(result.filename)}`;
                res.json({
                    ok: true,
                    imageUrl,
                    revisedPrompt: result.revisedPrompt,
                    agentText: result.agentText,
                    warning: result.warning,
                    elapsedMs: Date.now() - startedAt,
                });
            } catch (error) {
                finished = true;
                const message = safeError(error);
                const aborted = abortController.signal.aborted || /사용자가 취소|closed/i.test(message);
                if (!res.headersSent) res.status(aborted ? 499 : 500).json({ ok: false, error: message });
            } finally {
                req.off('aborted', onClosed);
                res.off('close', onClosed);
            }
        });

        // Stores a client-generated image (e.g. Vertex) in the same output folder
        // so history entries can hold a short URL instead of a huge data URL.
        router.post('/store', async (req, res) => {
            try {
                const dataUrl = String(req.body?.dataUrl || '');
                const match = dataUrl.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
                if (!match) return res.status(400).json({ error: 'dataUrl 형식이 올바르지 않습니다.' });

                const ext = match[1].split('/')[1].replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
                const bytes = Buffer.from(match[2], 'base64');
                if (!bytes.length) return res.status(400).json({ error: '이미지 데이터가 비어 있습니다.' });
                if (bytes.length > 32 * 1024 * 1024) return res.status(413).json({ error: '이미지가 너무 큽니다.' });

                await fs.mkdir(OUTPUT_DIR, { recursive: true });
                const filename = `vertex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
                await fs.writeFile(path.join(OUTPUT_DIR, filename), bytes);
                res.json({
                    filename,
                    imageUrl: `/api/plugins/${PLUGIN_ID}/image/${encodeURIComponent(filename)}`,
                });
            } catch (error) {
                res.status(500).json({ error: safeError(error) });
            }
        });

        router.get('/image/:name', async (req, res) => {
            const file = imageFileFromName(req.params.name);
            if (!file) return res.status(400).send('Invalid image name');
            try {
                await fs.access(file);
                res.type(contentTypeFor(file));
                res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
                res.sendFile(file);
            } catch (_) {
                res.status(404).send('Image not found');
            }
        });

        router.post('/delete-image', async (req, res) => {
            const file = imageFileFromName(req.body?.name);
            if (!file) return res.status(400).json({ error: 'Invalid image name' });
            try {
                await fs.unlink(file);
                res.json({ deleted: true });
            } catch (error) {
                if (error?.code === 'ENOENT') return res.json({ deleted: false });
                res.status(500).json({ error: safeError(error) });
            }
        });

        router.post('/purge-output', async (_req, res) => {
            try {
                const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
                let deleted = 0;
                for (const entry of entries) {
                    if (!entry.isFile() || !OUTPUT_NAME_RE.test(entry.name)) continue;
                    await fs.unlink(path.join(OUTPUT_DIR, entry.name));
                    deleted++;
                }
                res.json({ ok: true, deleted });
            } catch (error) {
                res.status(500).json({ ok: false, error: safeError(error) });
            }
        });

        console.log('[Chatelier Bridge] loaded');
    },
};
