'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

async function pluginFixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatelier-api-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const pluginPath = path.resolve(__dirname, '../index.js');
    const realRequire = createRequire(pluginPath);
    const generated = [];
    const spawn = (_binary, args) => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => {
            const text = args[0] === '--version' ? 'codex-cli 1.0.0' : args[0] === 'login' ? 'Logged in using ChatGPT' : 'image_generation stable true';
            child.stdout.emit('data', Buffer.from(text)); child.emit('close', 0);
        });
        return child;
    };
    const context = {
        require: name => name === 'node:child_process' ? { spawn, execFile: () => {} } : name === './exec-transport.cjs' ? {
            generateExecImage: async options => { generated.push(options); return { filename: 'codex-image-1234567890123-abcdef12.png' }; },
        } : realRequire(name),
        __dirname: directory, module: { exports: {} },
        process: { platform: 'android', env: { ST_CODEX_BIN: 'fake-codex', TERMUX_VERSION: 'test' } },
        Buffer, AbortController, AbortSignal, URL, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
    };
    vm.runInNewContext(await fs.readFile(pluginPath, 'utf8') + '\nmodule.exports.testStartThread = startThread;', context);
    const plugin = context.module.exports;
    const routes = new Map();
    await plugin.init({ get: (route, handler) => routes.set(`GET ${route}`, handler), post: (route, handler) => routes.set(`POST ${route}`, handler) });
    const call = async (route, body = {}) => {
        const req = Object.assign(new EventEmitter(), { body, query: {} });
        const res = Object.assign(new EventEmitter(), {
            statusCode: 200, headersSent: false, writableEnded: false,
            status(code) { this.statusCode = code; return this; },
            json(data) { this.data = data; this.writableEnded = true; return this; },
        });
        await routes.get(route)(req, res); return res;
    };
    return { call, generated, plugin };
}

test('same server plugin detects Termux, offers CLI default model, and accepts generation with no explicit model', async t => {
    const { call, generated } = await pluginFixture(t);
    const status = await call('GET /status');
    assert.equal(status.data.transport, 'exec'); assert.equal(status.data.modelRequired, false);
    assert.equal(status.data.loggedInWithChatGPT, true);
    const models = await call('GET /models');
    assert.equal(models.data.allowCustom, true); assert.equal(models.data.models.length, 0);
    const result = await call('POST /generate', { prompt: 'A quiet cafe', refs: [] });
    assert.equal(result.statusCode, 200); assert.equal(result.data.ok, true);
    assert.equal(generated.length, 1); assert.equal(generated[0].model, '');
    assert.match(result.data.imageUrl, /^\/api\/plugins\/codex-image\/image\//);
});
test('CLI update is off on Termux and invalid generation requests are rejected before running the CLI', async t => {
    const { call, generated } = await pluginFixture(t);
    assert.equal((await call('POST /update-cli')).statusCode, 403);
    assert.equal((await call('POST /generate', { prompt: '' })).statusCode, 400);
    assert.equal((await call('POST /generate', { prompt: 'x'.repeat(30001) })).statusCode, 400);
    assert.equal((await call('POST /generate', { prompt: 'scene', model: '--bad-option' })).statusCode, 400);
    assert.equal(generated.length, 0);
});
test('sandbox fallback never silently grants full filesystem access', async t => {
    const { plugin } = await pluginFixture(t);
    const requested = [];
    await assert.rejects(plugin.testStartThread({ request: async (_method, parameters) => {
        requested.push(parameters.sandbox);
        throw new Error('unknown variant; expected one of `danger-full-access`');
    } }, 'test-model'));
    assert.deepEqual(requested, ['workspace-write', 'read-only']);
});
