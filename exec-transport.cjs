'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function snapshotImages(directory, result = new Map()) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return result; }
    for (const entry of entries) {
        if (entry.name === 'refs') continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await snapshotImages(file, result);
        else if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name) && !/^ref-/i.test(entry.name)) {
            const stat = await fs.stat(file);
            if (stat.size > 8) result.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
        }
    }
    return result;
}

function runExec(binary, args, input, { cwd, signal, timeoutMs = 8 * 60 * 1000, env = process.env }) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('사용자가 취소했습니다.'));
        const child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', failure = null;
        const stop = message => { failure = new Error(message); child.kill('SIGKILL'); };
        const onAbort = () => stop('사용자가 취소했습니다.');
        const timer = setTimeout(() => stop('Codex CLI 이미지 생성 시간이 8분을 초과했습니다.'), timeoutMs);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
        signal?.addEventListener('abort', onAbort, { once: true });
        child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-12000); });
        child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-12000); });
        child.once('error', error => { cleanup(); reject(error); });
        child.once('close', code => { cleanup(); failure ? reject(failure) : resolve({ code, stdout, stderr }); });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
        if (signal?.aborted) onAbort();
    });
}

async function generateExecImage({ binary, instruction, model, refFiles, jobDir, outputDir, jobId, abortSignal, env = process.env, timeoutMs }) {
    const generatedDir = path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images');
    const directories = [jobDir, generatedDir];
    const before = await Promise.all(directories.map(dir => snapshotImages(dir)));
    const startedAt = Date.now();
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--enable', 'image_generation', '--config', 'approval_policy="never"', '--cd', jobDir];
    if (model) args.push('--model', model);
    for (const ref of refFiles) args.push('--image', ref.path);
    args.push('-');
    const input = `${instruction}\n\nSave the generated raster image locally inside the current working directory. Do not create placeholder images.`;
    const result = await runExec(binary, args, input, { cwd: jobDir, signal: abortSignal, timeoutMs, env });
    if (abortSignal?.aborted) throw new Error('사용자가 취소했습니다.');
    const candidates = [];
    for (let i = 0; i < directories.length; i++) {
        const after = await snapshotImages(directories[i]);
        for (const [file, stat] of after) {
            const previous = before[i].get(file);
            if ((!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs) && stat.mtimeMs >= startedAt - 3000) candidates.push({ file, ...stat });
        }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (!candidates.length) throw new Error(`Codex CLI가 새 이미지 파일을 생성하지 못했습니다. (exit ${result.code})\n${(result.stderr || result.stdout).slice(-1800)}`);
    const source = candidates[0].file;
    const filename = `codex-image-${jobId}${path.extname(source).toLowerCase()}`;
    await fs.copyFile(source, path.join(outputDir, filename));
    return { filename, revisedPrompt: '', agentText: result.stdout.slice(-1800), warning: result.code ? `Codex CLI 종료 코드 ${result.code}. 생성된 이미지 파일을 반환했습니다.` : '' };
}

module.exports = { generateExecImage, runExec, snapshotImages };
