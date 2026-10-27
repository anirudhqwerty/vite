const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')

async function test() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-inode-reuse-'))
  const file = path.join(directory, 'file.js')
  fs.writeFileSync(file, 'initial')

  // Keep native file events, but make inode reuse deterministic regardless of
  // the filesystem's allocator. Install before chokidar captures fs.stat.
  const stat = fs.stat
  fs.stat = (target, ...args) => {
    const callback = args.pop()
    stat(target, ...args, (error, stats) => {
      if (stats && target === file) stats.ino = 1
      callback(error, stats)
    })
  }
  const chokidar = require('chokidar')
  const watcher = chokidar.watch(file, { usePolling: false })
  const changes = []
  watcher.on('change', () => changes.push(fs.readFileSync(file, 'utf8')))
  async function expectChange(content, message) {
    const deadline = Date.now() + 3000
    while (!changes.includes(content) && Date.now() < deadline) {
      await sleep(20)
    }
    assert.ok(changes.includes(content), message)
  }

  try {
    await new Promise((resolve, reject) => {
      watcher.once('ready', resolve)
      watcher.once('error', reject)
    })
    await sleep(100)
    const birthtime = fs.statSync(file).birthtimeMs
    fs.unlinkSync(file)
    fs.writeFileSync(file, 'replacement')
    assert.notEqual(fs.statSync(file).birthtimeMs, birthtime)
    await expectChange('replacement', 'replacement must be detected')
    fs.writeFileSync(file, 'edited after replacement')
    await expectChange(
      'edited after replacement',
      'native watcher must stay attached after inode reuse',
    )
  } finally {
    await watcher.close()
    fs.stat = stat
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
