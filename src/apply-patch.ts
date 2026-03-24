// @ts-nocheck
import path from 'node:path'
import { spawn } from 'node:child_process'

function safeString(value: any): string {
  if (value == null) return ''
  return String(value)
}

function normalizePatchPath(rawPath: string): string {
  const trimmed = safeString(rawPath).trim().replace(/^([ab])\//, '')
  const normalized = trimmed.replace(/\\/g, '/')
  return normalized
}

function isSafeRelativePatchPath(rawPath: string): boolean {
  const normalized = normalizePatchPath(rawPath)
  if (!normalized || normalized === '/dev/null') return true
  if (path.posix.isAbsolute(normalized)) return false
  const clean = path.posix.normalize(normalized)
  if (clean === '..' || clean.startsWith('../')) return false
  return true
}

function parseTouchedPaths(patchText: string) {
  const lines = safeString(patchText).split(/\r?\n/)
  const touched = new Set<string>()
  let strip = 0
  for (const line of lines) {
    const match = line.match(/^(---|\+\+\+)\s+(.+)$/)
    if (!match) continue
    const token = safeString(match[2]).trim().split(/\s+/)[0]
    if (!token || token === '/dev/null') continue
    if (/^[ab]\//.test(token)) strip = 1
    if (!isSafeRelativePatchPath(token)) {
      throw new Error(`unsafe_patch_path:${token}`)
    }
    touched.add(normalizePatchPath(token))
  }
  return {
    strip,
    paths: Array.from(touched).sort(),
  }
}

function runPatchCommand({ cwd, patchText, strip, dryRun = false, signal }: { cwd: string, patchText: string, strip: number, dryRun?: boolean, signal?: AbortSignal }) {
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const args = [
      '--batch',
      '--forward',
      '--silent',
      `-p${Math.max(0, Number(strip) || 0)}`,
    ]
    if (dryRun) args.unshift('--dry-run')
    const child = spawn('patch', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.write(patchText)
    child.stdin.end()
  })
}

async function applyUnifiedPatch({ cwd, patchText, signal }: { cwd: string, patchText: string, signal?: AbortSignal }) {
  const trimmed = safeString(patchText)
  if (!trimmed.trim()) throw new Error('empty_patch')
  if (!path.isAbsolute(cwd)) throw new Error(`invalid_cwd:${cwd}`)
  const touched = parseTouchedPaths(trimmed)
  if (touched.paths.length === 0) throw new Error('patch_has_no_file_headers')

  const check = await runPatchCommand({ cwd, patchText: trimmed, strip: touched.strip, dryRun: true, signal })
  if (Number(check.code) !== 0) {
    const detail = [safeString(check.stdout).trim(), safeString(check.stderr).trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'patch_check_failed')
  }

  const applied = await runPatchCommand({ cwd, patchText: trimmed, strip: touched.strip, signal })
  if (Number(applied.code) !== 0) {
    const detail = [safeString(applied.stdout).trim(), safeString(applied.stderr).trim()].filter(Boolean).join('\n')
    throw new Error(detail || 'patch_apply_failed')
  }

  return {
    ok: true,
    cwd,
    strip: touched.strip,
    paths: touched.paths,
    stdout: safeString(applied.stdout).trim(),
    stderr: safeString(applied.stderr).trim(),
  }
}

export {
  applyUnifiedPatch,
}
