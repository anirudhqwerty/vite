import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createServer, version } from '../packages/vite/dist/node/index.js'

const mode = process.env.MODE ?? 'baseline'
const work = fs.mkdtempSync(path.join(process.env.REPRO_TMPDIR ?? os.tmpdir(), 'vite-23917-'))
const file = path.join(work, 'shared/a.js')
const git = (...args) => execFileSync('git', [
  '-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid', ...args,
], { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
console.log(JSON.stringify({ mode, vite: version, node: process.version, git: git('--version').trim(), filesystem: fs.statfsSync(work).type.toString(16) }))

async function scenario(control) {
  fs.mkdirSync(path.join(work, 'app'), { recursive: true })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'export const label = "v1"\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-q', '-m', 'v1')
  fs.writeFileSync(file, 'export const label = "v2"\n')
  git('commit', '-q', '-am', 'v2')
  git('tag', '-f', 'v2')
  git('reset', '-q', '--hard', 'HEAD~1')
  const server = await createServer({
    root: path.join(work, 'app'), configFile: false, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, fs: { allow: [work] }, watch: { usePolling: control === 'polling' } },
  })
  let stale = 0
  let reused = 0
  let changes = 0
  server.watcher.on('change', changed => { if (changed === file) changes++ })
  try {
    await server.listen()
    if (control === 'directory') server.watcher.add(path.dirname(file))
    const url = `http://127.0.0.1:${server.httpServer.address().port}/@fs${file}`
    const served = async () => {
      const response = await fetch(url)
      assert.equal(response.status, 200)
      return (await response.text()).match(/v[12]( edit)?/)?.[0]
    }
    assert.equal(await served(), 'v1')
    await sleep(500)
    for (let i = 0; i < 6; i++) {
      const before = fs.statSync(file)
      const fd = control === 'pinned' ? fs.openSync(file, 'r') : undefined
      git('checkout', i % 2 === 0 ? 'v2' : 'HEAD', '--', 'shared/a.js')
      if (fd !== undefined) fs.closeSync(fd)
      await sleep(1000)
      const after = fs.statSync(file)
      const sameInode = before.ino === after.ino
      const newBirthtime = before.birthtimeMs !== after.birthtimeMs
      if (sameInode && newBirthtime) reused++
      const disk = fs.readFileSync(file, 'utf8').match(/v[12]/)?.[0]
      const actual = await served()
      if (disk !== actual) stale++
      console.log(JSON.stringify({ control, step: i, inode: [before.ino, after.ino], birthtime: [before.birthtimeMs, after.birthtimeMs], sameInode, newBirthtime, disk, served: actual, changes }))
    }
    fs.writeFileSync(file, 'export const label = "v1 edit"\n')
    await sleep(1000)
    const final = await served()
    if (final !== 'v1 edit') stale++
    console.log(JSON.stringify({ control, reused, stale, final, changes }))
    return { reused, stale }
  } finally {
    await server.close()
    // Only this script's randomly-created temporary directory is removed.
    fs.rmSync(work, { recursive: true, force: true })
    fs.mkdirSync(work)
  }
}

try {
  const baseline = await scenario('file')
  assert.ok(baseline.reused > 0, 'INCONCLUSIVE: filesystem did not reuse an inode with a new birthtime')
  if (mode === 'baseline') assert.ok(baseline.stale > 0, 'Expected reported stale transform on unchanged main')
  else assert.equal(baseline.stale, 0, 'Transforms must update after inode reuse')
  for (const control of ['pinned', 'directory', 'polling']) {
    assert.equal((await scenario(control)).stale, 0, `${control} control must remain fresh`)
  }
  console.log(mode === 'baseline' ? 'CONFIRMED: unchanged main serves stale transforms; all controls pass' : 'PASS: fixed native watcher and all controls remain fresh')
} finally {
  fs.rmSync(work, { recursive: true, force: true })
}
