const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { saveMemory, searchMemories, compileMemory } = require('../dist/memory.js')

test('markdown-backed memory service saves, searches, and compiles resident slots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rin-memory-service-'))
  try {
    const saved = await saveMemory({
      content: 'Rin-Chan 是主人的女仆。',
      title: 'Agent identity',
      exposure: 'resident',
      fidelity: 'exact',
      residentSlot: 'agent_identity',
      source: 'test',
    }, root)
    assert.equal(saved.status, 'ok')

    const residentPath = path.join(root, 'memory', 'resident', 'agent_identity.md')
    assert.equal(fs.existsSync(residentPath), true)

    const search = await searchMemories('主人', { limit: 5 }, root)
    assert.equal(search.count, 1)
    assert.equal(search.results[0].resident_slot, 'agent_identity')

    const compiled = await compileMemory({ section: 'resident' }, root)
    assert.match(compiled.resident, /agent_identity/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
