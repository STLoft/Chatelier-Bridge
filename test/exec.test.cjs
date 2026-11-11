'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { generateExecImage, runExec } = require('../exec-transport.cjs');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

async function setup(t, code) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatelier-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const jobDir = path.join(root, 'job'); const outputDir = path.join(root, 'output');
    await fs.mkdir(jobDir); await fs.mkdir(outputDir);
    await fs.writeFile(path.join(jobDir, 'exec'), code);
    return { root, jobDir, outputDir, binary: process.execPath, instruction: 'A scene with $& and newlines\nsecond line', model: 'test-model', refFiles: [], jobId: '1234567890123-abcdef12', env: { ...process.env, CODEX_HOME: path.join(root, 'codex') } };
}
test('exec passes the prompt through stdin, honors model, and copies a fresh image', async t => {
    const args = await setup(t, `const fs=require('node:fs'); let text=''; process.stdin.on('data',d=>text+=d); process.stdin.on('end',()=>{fs.writeFileSync('input.txt',text);fs.writeFileSync('args.json',JSON.stringify(process.argv));fs.writeFileSync('result.png',Buffer.from('${png}','base64'));});`);
    const result = await generateExecImage(args);
    assert.match(result.filename, /^codex-image-/);
    assert.ok((await fs.stat(path.join(args.outputDir, result.filename))).size > 8);
    assert.match(await fs.readFile(path.join(args.jobDir, 'input.txt'), 'utf8'), /A scene with \$& and newlines\nsecond line/);
    const argv = JSON.parse(await fs.readFile(path.join(args.jobDir, 'args.json'), 'utf8'));
    assert.equal(argv.at(-1), '-');
    assert.equal(argv[argv.indexOf('--model') + 1], 'test-model');
});
test('unchanged old images and reference images are not returned as new results', async t => {
    const args = await setup(t, "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));");
    await fs.writeFile(path.join(args.jobDir, 'old.png'), Buffer.from(png, 'base64'));
    await fs.mkdir(path.join(args.jobDir, 'refs'));
    await fs.writeFile(path.join(args.jobDir, 'refs', '01-char.png'), Buffer.from(png, 'base64'));
    await assert.rejects(generateExecImage(args), /새 이미지 파일/);
});
test('a newly written image in generated_images is found', async t => {
    const args = await setup(t, `const fs=require('node:fs'),p=require('node:path'); process.stdin.resume();process.stdin.on('end',()=>{const dir=p.join(process.env.CODEX_HOME,'generated_images');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'new.png'),Buffer.from('${png}','base64'));});`);
    assert.ok((await generateExecImage(args)).filename);
});
test('cancellation and timeout stop a pending exec process', async t => {
    const args = await setup(t, 'setInterval(()=>{},1000);');
    const controller = new AbortController();
    const pending = runExec(process.execPath, ['exec'], 'scene', { cwd: args.jobDir, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /취소/);
    await assert.rejects(runExec(process.execPath, ['exec'], 'scene', { cwd: args.jobDir, timeoutMs: 100 }), /초과/);
});
