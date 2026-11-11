'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

async function pluginFixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatelier-api-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const pluginPath = path.resolve(__dirname, '../index.js');
    const realRequire = createRequire(pluginPath);
    const generated = [];
    const commands = [];
    const platform = options.platform || 'android';
    const packageName = platform === 'android' ? '@mmmbuto/codex-cli-termux' : '@openai/codex';
    const globalRoot = path.join(directory, 'global', 'node_modules');
    const packageRoot = path.join(globalRoot, ...packageName.split('/'));
    const packageFile = path.join(packageRoot, 'package.json');
    let installedVersion = options.version || '0.163.0-termux.2';
    const latest = options.latest || '0.163.0-termux.3';
    await fs.mkdir(path.join(packageRoot, 'bin'), { recursive: true });
    await fs.writeFile(packageFile, JSON.stringify({ name: packageName, version: installedVersion }));
    const binary = options.unsupported ? path.join(directory, 'standalone') : path.join(packageRoot, 'bin', 'codex.js');
    await fs.writeFile(binary, 'mock CLI');
    const spawn = (_binary, args) => {
        commands.push({ binary: _binary, args });
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(async () => {
            let text = args[0] === '--version' ? options.cliVersion || `codex-cli ${installedVersion}` : args[0] === 'login' ? 'Logged in using ChatGPT' : 'image_generation stable true';
            if (args[0] === 'root') text = globalRoot;
            if (args[0] === 'install') {
                if (options.delayInstall) await new Promise(resolve => setTimeout(resolve, options.delayInstall));
                if (options.failInstall) { child.stderr.emit('data', Buffer.from('mock install failure')); child.emit('close', 1); return; }
                installedVersion = latest;
                await fs.writeFile(packageFile, JSON.stringify({ name: packageName, version: installedVersion }));
                text = 'updated';
            }
            child.stdout.emit('data', Buffer.from(text)); child.emit('close', 0);
        });
        return child;
    };
    const context = {
        require: name => name === 'node:child_process' ? { spawn, execFile: () => {} } : name === './exec-transport.cjs' ? {
            generateExecImage: async options => { generated.push(options); return { filename: 'codex-image-1234567890123-abcdef12.png' }; },
        } : realRequire(name),
        __dirname: directory, module: { exports: {} },
        process: { platform, env: { ST_CODEX_BIN: binary, ...(platform === 'android' ? { TERMUX_VERSION: 'test' } : {}), ST_CODEX_AUTO_UPDATE: options.autoUpdate ? '1' : '0' } },
        fetch: async () => ({ ok: true, json: async () => ({ version: latest }) }),
        Buffer, AbortController, AbortSignal, URL, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
    };
    vm.runInNewContext(await fs.readFile(pluginPath, 'utf8') + '\nmodule.exports.testStartThread = startThread; module.exports.waitForCliStartup = () => startupCliUpdate;', context);
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
    return { call, generated, plugin, commands, directory, packageName, latest };
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

test('Termux startup updates only its community package and verifies a backup first', async t => {
    const fixture = await pluginFixture(t, { autoUpdate: true });
    await fixture.plugin.waitForCliStartup();
    const status = (await fixture.call('GET /status')).data;
    assert.equal(status.cliAutoUpdate.state, 'updated');
    assert.equal(status.updateAvailable, false);
    assert.equal(status.installedPackageVersion, fixture.latest);
    const install = fixture.commands.filter(command => command.args[0] === 'install');
    assert.equal(install.length, 1);
    assert.equal(install[0].args[2], '@mmmbuto/codex-cli-termux@latest');
    const backups = path.join(fixture.directory, 'workspace', 'cli-backups');
    const [name] = await fs.readdir(backups);
    const verified = JSON.parse(await fs.readFile(path.join(backups, name, 'VERIFIED.json'), 'utf8'));
    assert.equal(verified.version, '0.163.0-termux.2');
    assert.ok(verified.files['package.json']);
});

test('desktop startup selects the official package and blocks generation while updating', async t => {
    const fixture = await pluginFixture(t, { autoUpdate: true, platform: 'win32', version: '0.162.0', latest: '0.167.1', delayInstall: 80 });
    assert.equal((await fixture.call('GET /models')).statusCode, 503);
    assert.equal((await fixture.call('POST /generate', { prompt: 'scene', model: 'test' })).statusCode, 503);
    await fixture.plugin.waitForCliStartup();
    const install = fixture.commands.filter(command => command.args[0] === 'install');
    assert.equal(install.length, 1);
    assert.equal(install[0].args[2], '@openai/codex@latest');
    assert.equal((await fixture.call('GET /status')).data.cliAutoUpdate.state, 'updated');
});

test('latest installed package is not reinstalled when its binary reports a different build label', async t => {
    const fixture = await pluginFixture(t, { autoUpdate: true, version: '0.163.0-termux.3', latest: '0.163.0-termux.3', cliVersion: 'codex-cli 0.163.0-alpha.10.2' });
    await fixture.plugin.waitForCliStartup();
    assert.equal(fixture.commands.filter(command => command.args[0] === 'install').length, 0);
    const status = (await fixture.call('GET /status')).data;
    assert.equal(status.cliAutoUpdate.state, 'current');
    assert.equal(status.updateAvailable, false);
});

test('failed startup update preserves the backup and permits the existing CLI after maintenance', async t => {
    const fixture = await pluginFixture(t, { autoUpdate: true, failInstall: true });
    await fixture.plugin.waitForCliStartup();
    const status = (await fixture.call('GET /status')).data;
    assert.equal(status.cliAutoUpdate.state, 'failed');
    assert.equal(status.available, true);
    assert.equal((await fixture.call('GET /models')).statusCode, 200);
    assert.equal((await fs.readdir(path.join(fixture.directory, 'workspace', 'cli-backups'))).length, 1);
});

test('custom standalone binary and disabled auto-update never invoke npm installation', async t => {
    for (const options of [{ autoUpdate: true, unsupported: true }, { autoUpdate: false }]) {
        const fixture = await pluginFixture(t, options);
        await fixture.plugin.waitForCliStartup();
        assert.equal(fixture.commands.filter(command => command.args[0] === 'install').length, 0);
        assert.equal((await fixture.call('GET /status')).data.cliAutoUpdate.state, options.autoUpdate ? 'unsupported' : 'disabled');
    }
});
