import fs from 'node:fs'
import path from 'node:path'

const repoRoot = process.cwd()
const gitDir = path.join(repoRoot, '.git')

if (process.env.HUSKY === '0' || process.env.CI === 'true' || process.env.NODE_ENV === 'production') {
  process.exit(0)
}

if (!fs.existsSync(gitDir)) {
  process.exit(0)
}

const husky = (await import('husky')).default
console.log(husky())
