// @ts-nocheck
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>

function repoRoot() {
  return path.resolve(__dirname, '..')
}

function resolvePackageRoot(packageName: 'coding-agent' | 'tui') {
  return path.join(repoRoot(), 'third_party', 'pi-mono', 'packages', packageName)
}

function resolvePackageModule(packageName: 'coding-agent' | 'tui', relPath = path.join('dist', 'index.js')) {
  return pathToFileURL(path.join(resolvePackageRoot(packageName), relPath)).href
}

async function importPackageModule(packageName: 'coding-agent' | 'tui', relPath = path.join('dist', 'index.js')) {
  return await dynamicImport(resolvePackageModule(packageName, relPath))
}

export function resolvePiCodingAgentRoot() {
  return resolvePackageRoot('coding-agent')
}

export function resolvePiCodingAgentModule(relPath = path.join('dist', 'index.js')) {
  return resolvePackageModule('coding-agent', relPath)
}

export async function importPiCodingAgentModule(relPath = path.join('dist', 'index.js')) {
  return await importPackageModule('coding-agent', relPath)
}

export function resolvePiTuiRoot() {
  return resolvePackageRoot('tui')
}

export function resolvePiTuiModule(relPath = path.join('dist', 'index.js')) {
  return resolvePackageModule('tui', relPath)
}

export async function importPiTuiModule(relPath = path.join('dist', 'index.js')) {
  return await importPackageModule('tui', relPath)
}
