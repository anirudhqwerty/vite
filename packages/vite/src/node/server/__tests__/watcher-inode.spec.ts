import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it } from 'vitest'

// Chokidar's native inode replacement handling is Linux-specific. A subprocess
// isolates the controlled inode stats from the rest of the test suite.
it.runIf(process.platform === 'linux')(
  'keeps watching a replaced file when its inode is reused',
  async () => {
    await promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/watcher/inode-reuse.cjs', import.meta.url))],
      { timeout: 10_000 },
    )
  },
)
