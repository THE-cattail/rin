#!/usr/bin/env node
// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { connect, Index } from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';

process.env.MEM0_TELEMETRY = typeof process.env.MEM0_TELEMETRY === 'string' && process.env.MEM0_TELEMETRY.trim()
  ? process.env.MEM0_TELEMETRY
  : 'false';
const { Memory: Mem0Memory } = require('mem0ai/oss');
const { TransformersEmbeddingFunction } = require('@lancedb/lancedb/embedding/transformers');
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (filename: string) => any };

type Json = Record<string, unknown>;
type EventRow = {
  id: string;
  ts: string;
  type: string;
  content: string;
  chat_key: string;
  shard: string;
  meta: Record<string, unknown>;
};

type KbChunk = {
  id: string;
  path: string;
  title: string;
  chunkIndex: number;
  text: string;
  sha256: string;
  mtime: number;
};

type KbRow = KbChunk & { vector: number[] };

type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | boolean>;
};

type ScopeMode = 'agent' | 'user' | 'chat' | 'run';

type ScopeContext = {
  scope: ScopeMode;
  chatKey: string;
  userId: string;
  agentId: string;
  runId: string;
  scopeKey: string;
  mem0Filters: { userId?: string; agentId?: string; runId?: string };
  metadata: Record<string, unknown>;
};

type CandidateRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  text: string;
  normalizedText: string;
  status: string;
  reason: string;
  source: string;
  chatKey: string;
  userId: string;
  agentId: string;
  runId: string;
  memoryScope: ScopeMode;
  scopeKey: string;
  importance: number;
  ttlDays: number;
  expiresAt: string;
  hits: number;
  eventId: string;
  metadata: Record<string, unknown>;
};

type CandidateWriteOptions = {
  importance: number;
  ttlDays: number;
  source: string;
  sourceEventId?: string;
  metadata?: Record<string, unknown>;
};

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseIso(raw: string): Date | null {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function readText(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf8');
}

async function writeText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
}

async function appendJsonLine(filePath: string, row: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(row, null, 0) + '\n', 'utf8');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function shaFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return sha256Hex(data);
}

function firstHeading(markdown: string, fallback: string): string {
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return fallback;
}

function slugifyChatKey(chatKey: string): string {
  const raw = chatKey.trim() || 'chat';
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 80) || 'chat';
  return `${slug}--${sha256Hex(raw).slice(0, 10)}`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const key = token.replace(/^--/, '').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { positionals, options };
}

function optString(args: ParsedArgs, key: string, fallback = ''): string {
  const value = args.options[key];
  return typeof value === 'string' ? value : fallback;
}

function optInt(args: ParsedArgs, key: string, fallback: number): number {
  const raw = optString(args, key, '');
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenizeRecallText(input: string): string[] {
  return [...new Set(normalizeMemoryText(input)
    .split(/[^a-z0-9\u4e00-\u9fff@._-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2))];
}

function recallLexicalScore(query: string, text: string): number {
  const rawQuery = normalizeMemoryText(query);
  const rawText = normalizeMemoryText(text);
  if (!rawQuery || !rawText) return 0;
  let score = 0;
  if (rawText.includes(rawQuery)) score += 2;
  const queryTokens = tokenizeRecallText(rawQuery);
  if (!queryTokens.length) return score;
  for (const token of queryTokens) {
    if (!token) continue;
    if (rawText.includes(token)) score += token.length >= 4 ? 0.7 : 0.4;
  }
  return score;
}

function recencyScore(iso: string): number {
  const ts = parseIso(iso)?.getTime();
  if (!ts) return 0;
  const ageHours = Math.max(0, (Date.now() - ts) / (1000 * 60 * 60));
  if (ageHours <= 24) return 0.45;
  if (ageHours <= 24 * 7) return 0.3;
  if (ageHours <= 24 * 30) return 0.18;
  return 0.05;
}

function findExecutableOnPath(name: string): string {
  const rawPath = safeString(process.env.PATH);
  for (const dir of rawPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fssync.accessSync(candidate, fssync.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return '';
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}

class RuntimePaths {
  root: string;

  constructor(root: string) {
    this.root = root;
  }

  get dataDir(): string {
    return path.join(this.root, 'data');
  }

  get memoryDir(): string {
    return path.join(this.dataDir, 'memory');
  }

  get mem0Dir(): string {
    return path.join(this.memoryDir, 'mem0');
  }

  get mem0VectorDb(): string {
    return path.join(this.mem0Dir, 'vector_store.db');
  }

  get mem0HistoryDb(): string {
    return path.join(this.mem0Dir, 'history.db');
  }

  get candidateDb(): string {
    return path.join(this.memoryDir, 'candidates.sqlite');
  }

  get eventsDir(): string {
    return path.join(this.memoryDir, 'events');
  }

  get kbDir(): string {
    return path.join(this.root, 'kb');
  }

  get kbVault(): string {
    return path.join(this.kbDir, 'vault');
  }

  get kbIndexDir(): string {
    return path.join(this.dataDir, 'kb-index');
  }

  get kbManifest(): string {
    return path.join(this.kbIndexDir, 'manifest.json');
  }

  get kbLanceDir(): string {
    return path.join(this.kbIndexDir, 'lancedb');
  }
}

class SharedEmbeddings {
  private static instance: SharedEmbeddings | null = null;
  private embedder: TransformersEmbeddingFunction;
  readonly model: string;
  readonly dims: number;
  private initialized = false;

  private constructor() {
    this.model = process.env.RIN_EMBED_MODEL || process.env.RIN_MEMORY_EMBED_MODEL || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
    this.dims = Number(process.env.RIN_EMBED_DIMS || process.env.RIN_MEMORY_EMBED_DIMS || '384');
    this.embedder = new TransformersEmbeddingFunction({ model: this.model, ndims: this.dims });
  }

  static get(): SharedEmbeddings {
    if (!SharedEmbeddings.instance) SharedEmbeddings.instance = new SharedEmbeddings();
    return SharedEmbeddings.instance;
  }

  async init(): Promise<void> {
    if (!this.initialized) {
      const transformers = await import('@huggingface/transformers');
      transformers.env.cacheDir = process.env.RIN_EMBED_CACHE_DIR || path.join(os.homedir(), '.cache', 'rin-brain', 'transformers');
      await fs.mkdir(transformers.env.cacheDir, { recursive: true });
      await this.embedder.init();
      this.initialized = true;
    }
  }

  async embedQuery(text: string): Promise<number[]> {
    await this.init();
    return await this.embedder.computeQueryEmbeddings(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.init();
    return await this.embedder.computeSourceEmbeddings(texts);
  }

  asMem0Embedder(): { embedQuery: (text: string) => Promise<number[]>; embedDocuments: (texts: string[]) => Promise<number[][]>; batchSize: number } {
    return {
      batchSize: 16,
      embedQuery: async (text: string) => await this.embedQuery(text),
      embedDocuments: async (texts: string[]) => await this.embedBatch(texts),
    };
  }
}

class MemoryRuntime {
  private paths: RuntimePaths;
  private embeddings: SharedEmbeddings;
  private mem0: Mem0Memory | null = null;
  private memoryModelRuntimePromise: Promise<any> | null = null;

  constructor(paths: RuntimePaths) {
    this.paths = paths;
    this.embeddings = SharedEmbeddings.get();
  }

  private scope(): { userId: string; agentId: string } {
    return {
      userId: process.env.RIN_MEMORY_USER_ID || 'owner',
      agentId: process.env.RIN_MEMORY_AGENT_ID || 'rin',
    };
  }

  private resolveScopeArgs(args: ParsedArgs, fallbackScope: ScopeMode = 'user'): ScopeContext {
    const base = this.scope();
    const requested = optString(args, 'scope', fallbackScope).trim().toLowerCase();
    const scope = (['agent', 'user', 'chat', 'run'].includes(requested) ? requested : fallbackScope) as ScopeMode;
    const userId = optString(args, 'userId', base.userId).trim() || base.userId;
    const agentId = optString(args, 'agentId', base.agentId).trim() || base.agentId;
    const chatKey = this.resolveChatKey(optString(args, 'chatKey', ''));
    const rawRunId = optString(args, 'runId', '').trim();
    let runId = '';
    let scopeKey = '';
    const mem0Filters: { userId?: string; agentId?: string; runId?: string } = {};
    if (scope === 'agent') {
      mem0Filters.agentId = agentId;
      scopeKey = `agent:${agentId}`;
    } else if (scope === 'chat') {
      runId = rawRunId || `chat:${chatKey}`;
      mem0Filters.userId = userId;
      mem0Filters.agentId = agentId;
      mem0Filters.runId = runId;
      scopeKey = `chat:${chatKey}`;
    } else if (scope === 'run') {
      runId = rawRunId || (chatKey ? `chat:${chatKey}` : '');
      if (!runId) throw new Error('Missing --runId or --chatKey for --scope run');
      mem0Filters.userId = userId;
      mem0Filters.agentId = agentId;
      mem0Filters.runId = runId;
      scopeKey = `run:${runId}`;
    } else {
      mem0Filters.userId = userId;
      mem0Filters.agentId = agentId;
      scopeKey = `user:${userId}:agent:${agentId}`;
    }
    return {
      scope,
      chatKey,
      userId,
      agentId,
      runId,
      scopeKey,
      mem0Filters,
      metadata: {
        memory_scope: scope,
        scope_key: scopeKey,
        user_id: userId,
        agent_id: agentId,
        ...(runId ? { run_id: runId } : {}),
        ...(chatKey ? { chat_key: chatKey } : {}),
      },
    };
  }

  private readMemoryModelSettings(): { provider: string; model: string; thinking: string } {
    let settings: any = {};
    try {
      settings = JSON.parse(fssync.readFileSync(path.join(this.paths.root, 'settings.json'), 'utf8'));
    } catch {}
    const memory = settings && typeof settings.memory === 'object' ? settings.memory : {};
    const provider = safeString(process.env.RIN_MEMORY_MODEL_PROVIDER || memory.provider || settings.memoryProvider || settings.defaultProvider || 'openai-codex').trim() || 'openai-codex';
    const model = safeString(process.env.RIN_MEMORY_MODEL || memory.model || settings.memoryModel || settings.defaultModel || 'gpt-5.4').trim() || 'gpt-5.4';
    const thinking = safeString(process.env.RIN_MEMORY_MODEL_THINKING || memory.thinking || settings.memoryThinking || 'minimal').trim() || 'minimal';
    return { provider, model, thinking };
  }

  private async getMemoryModelRuntime(): Promise<any> {
    if (!this.memoryModelRuntimePromise) {
      this.memoryModelRuntimePromise = (async () => {
        const piSdkPath = path.join(__dirname, '..', 'node_modules', '@mariozechner', 'pi-coding-agent', 'dist', 'index.js');
        const piAiPath = path.join(__dirname, '..', 'node_modules', '@mariozechner', 'pi-ai', 'dist', 'index.js');
        const { AuthStorage, ModelRegistry } = require(piSdkPath);
        const { completeSimple } = require(piAiPath);
        const authPath = path.join(this.paths.root, 'auth.json');
        const modelsPath = path.join(this.paths.root, 'models.json');
        const authStorage = AuthStorage.create(authPath);
        const modelRegistry = new ModelRegistry(authStorage, modelsPath);
        const selected = this.readMemoryModelSettings();
        const model = modelRegistry.find(selected.provider, selected.model);
        if (!model) throw new Error(`memory_model_not_found:${selected.provider}/${selected.model}`);
        const apiKey = await modelRegistry.getApiKey(model);
        if (!apiKey) throw new Error(`memory_model_auth_missing:${selected.provider}`);
        return {
          selected,
          model,
          apiKey,
          completeSimple,
        };
      })();
    }
    return await this.memoryModelRuntimePromise;
  }

  private async memoryInferReady(): Promise<boolean> {
    if (process.env.RIN_MEMORY_INFER_WRITES === '0') return false;
    try {
      await this.getMemoryModelRuntime();
      return true;
    } catch {
      return false;
    }
  }

  private defaultChatKey(): string {
    return process.env.RIN_MEMORY_CHAT_KEY || process.env.RIN_CHAT_KEY || process.env.CHAT_KEY || 'local:default';
  }

  private resolveChatKey(chatKey?: string, meta?: Record<string, unknown>, fallback?: string): string {
    const direct = safeString(chatKey || '').trim();
    if (direct) return direct;
    const fromMeta = safeString(meta?.chat_key ?? '').trim();
    if (fromMeta) return fromMeta;
    return fallback || this.defaultChatKey();
  }

  private eventShardPath(_chatKey: string, ts: Date): string {
    return path.join(this.paths.eventsDir, `${ts.getUTCFullYear()}`, `${String(ts.getUTCMonth() + 1).padStart(2, '0')}`, `${String(ts.getUTCDate()).padStart(2, '0')}`, 'events.jsonl');
  }

  private async iterEventFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      if (!(await pathExists(dir))) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
      }
    };
    await walk(this.paths.eventsDir);
    return out.sort();
  }

  private normalizeEventRow(row: any, sourcePath: string): EventRow | null {
    if (!row || typeof row !== 'object') return null;
    const meta = typeof row.meta === 'object' && row.meta ? { ...row.meta } : {};
    const chatKey = this.resolveChatKey(safeString(row.chat_key || ''), meta, this.defaultChatKey());
    const shard = safeString(row.shard || '').trim() || path.relative(this.paths.memoryDir, sourcePath);
    return {
      id: safeString(row.id || crypto.randomUUID()),
      ts: safeString(row.ts || nowIso()),
      type: safeString(row.type || 'event'),
      content: safeString(row.content || ''),
      chat_key: chatKey,
      shard,
      meta: { ...meta, chat_key: chatKey },
    };
  }

  private async readAllEvents(): Promise<EventRow[]> {
    const rows: EventRow[] = [];
    for (const filePath of await this.iterEventFiles()) {
      const content = await readText(filePath).catch(() => '');
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          const row = this.normalizeEventRow(parsed, filePath);
          if (row) rows.push(row);
        } catch {
          // ignore broken lines
        }
      }
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }

  async appendEvent(type: string, content: string, meta: Record<string, unknown> = {}, chatKey?: string): Promise<EventRow> {
    const resolvedChatKey = this.resolveChatKey(chatKey, meta);
    const ts = nowIso();
    const tsDate = parseIso(ts) || new Date();
    const shardPath = this.eventShardPath(resolvedChatKey, tsDate);
    const row: EventRow = {
      id: crypto.randomUUID(),
      ts,
      type,
      content,
      chat_key: resolvedChatKey,
      shard: path.relative(this.paths.memoryDir, shardPath),
      meta: { ...meta, chat_key: resolvedChatKey },
    };
    await appendJsonLine(shardPath, row);
    return row;
  }

  async readRecentEvents(hours: number, limit: number, chatKey?: string): Promise<EventRow[]> {
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const wantChatKey = safeString(chatKey).trim();
    const rows = (await this.readAllEvents()).filter((row) => {
      const ts = parseIso(row.ts);
      if (!ts) return false;
      if (wantChatKey && safeString(row.chat_key).trim() !== wantChatKey) return false;
      return ts.getTime() >= cutoff;
    });
    rows.sort((a, b) => b.ts.localeCompare(a.ts));
    return rows.slice(0, limit);
  }

  async searchEvents(query: string, limit: number, chatKey?: string): Promise<EventRow[]> {
    const needle = query.trim();
    if (!needle) return [];
    const wantChatKey = safeString(chatKey).trim();
    const rows = (await this.readAllEvents())
      .filter((row) => !wantChatKey || safeString(row.chat_key).trim() === wantChatKey)
      .map((row) => {
        const haystack = `${row.type} ${row.content} ${row.chat_key} ${JSON.stringify(row.meta)}`;
        const score = recallLexicalScore(needle, haystack) + recencyScore(row.ts);
        return { row, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || b.row.ts.localeCompare(a.row.ts))
      .slice(0, limit)
      .map((entry) => entry.row);
    return rows;
  }

  private mem0Config(): Record<string, unknown> {
    const embed = this.embeddings;
    return {
      version: 'v1.1',
      embedder: {
        provider: 'langchain',
        config: {
          model: embed.asMem0Embedder(),
          embeddingDims: embed.dims,
        },
      },
      vectorStore: {
        provider: 'memory',
        config: {
          collectionName: process.env.RIN_MEMORY_COLLECTION || 'rin-memory',
          dimension: embed.dims,
          dbPath: this.paths.mem0VectorDb,
        },
      },
      llm: {
        provider: 'openai',
        config: {
          apiKey: process.env.RIN_MEMORY_OPENAI_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || 'not-configured',
          baseURL: process.env.RIN_MEMORY_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          model: process.env.RIN_MEMORY_LLM_MODEL || 'gpt-4.1-nano-2025-04-14',
        },
      },
      historyStore: {
        provider: 'sqlite',
        config: {
          historyDbPath: this.paths.mem0HistoryDb,
        },
      },
      enableGraph: false,
    };
  }

  private async getMem0(): Promise<Mem0Memory> {
    if (!this.mem0) {
      await fs.mkdir(this.paths.mem0Dir, { recursive: true });
      this.mem0 = new Mem0Memory(this.mem0Config() as any);
      (this.mem0 as any).llm = {
        generateResponse: async (messages: Array<Record<string, unknown>>, responseFormat?: Record<string, unknown>) => {
          const runtime = await this.getMemoryModelRuntime();
          const baseSystemPrompt = (Array.isArray(messages) ? messages : [])
            .filter((message) => safeString(message && message.role) === 'system')
            .map((message) => safeString(message && message.content))
            .join('\n\n')
            .trim();
          const baseChatMessages = (Array.isArray(messages) ? messages : [])
            .filter((message) => ['user', 'assistant'].includes(safeString(message && message.role)))
            .map((message) => ({
              role: safeString(message && message.role) === 'assistant' ? 'assistant' : 'user',
              content: safeString(message && message.content),
              timestamp: Date.now(),
            }));
          const wantJson = safeString((responseFormat as any)?.type || '') === 'json_object';
          const jsonInstruction = 'Return exactly one valid JSON object. Do not wrap it in markdown fences. Do not add explanations before or after the JSON.';
          const collectText = (response: any) => (Array.isArray(response?.content) ? response.content : [])
            .filter((block: any) => block && block.type === 'text')
            .map((block: any) => safeString(block.text))
            .join('\n')
            .trim();
          const invoke = async (repair = false, priorText = '') => {
            const messages = repair
              ? [
                  ...baseChatMessages,
                  ...(priorText ? [{ role: 'assistant', content: priorText, timestamp: Date.now() }] : []),
                  {
                    role: 'user',
                    content: 'Your previous reply was invalid for the required format. Return only a valid JSON object now. No markdown fences, no commentary, no surrounding text.',
                    timestamp: Date.now(),
                  },
                ]
              : baseChatMessages;
            const systemPrompt = wantJson
              ? [baseSystemPrompt, jsonInstruction].filter(Boolean).join('\n\n')
              : baseSystemPrompt;
            return await runtime.completeSimple(runtime.model, {
              ...(systemPrompt ? { systemPrompt } : {}),
              messages,
            }, {
              apiKey: runtime.apiKey,
              reasoning: runtime.selected.thinking,
              maxTokens: 4096,
            });
          };
          const first = await invoke(false, '');
          let text = collectText(first);
          if (wantJson) {
            try {
              JSON.parse(text);
            } catch {
              const repaired = await invoke(true, text);
              text = collectText(repaired);
            }
          }
          return text;
        },
      };
    }
    return this.mem0;
  }

  private vectorStoreRowCount(): number {
    if (!fssync.existsSync(this.paths.mem0VectorDb)) return 0;
    try {
      const db = new DatabaseSync(this.paths.mem0VectorDb);
      const row = db.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n?: number } | undefined;
      db.close();
      return Number(row?.n || 0);
    } catch {
      return 0;
    }
  }

  private openCandidateDb(): any {
    fssync.mkdirSync(this.paths.memoryDir, { recursive: true });
    const db = new DatabaseSync(this.paths.candidateDb);
    db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'candidate',
        chat_key TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        memory_scope TEXT NOT NULL DEFAULT 'user',
        scope_key TEXT NOT NULL DEFAULT '',
        importance INTEGER NOT NULL DEFAULT 50,
        ttl_days INTEGER NOT NULL DEFAULT 14,
        expires_at TEXT NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        event_id TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_candidates_status_updated ON candidates(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_candidates_scope_status ON candidates(scope_key, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_candidates_norm_scope ON candidates(normalized_text, scope_key, status);
    `);
    return db;
  }

  private candidateRow(raw: Record<string, unknown>): CandidateRow {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(safeString(raw.metadata_json || '{}'));
    } catch {
      metadata = {};
    }
    return {
      id: safeString(raw.id),
      createdAt: safeString(raw.created_at),
      updatedAt: safeString(raw.updated_at),
      text: safeString(raw.text),
      normalizedText: safeString(raw.normalized_text),
      status: safeString(raw.status),
      reason: safeString(raw.reason),
      source: safeString(raw.source),
      chatKey: safeString(raw.chat_key),
      userId: safeString(raw.user_id),
      agentId: safeString(raw.agent_id),
      runId: safeString(raw.run_id),
      memoryScope: (safeString(raw.memory_scope || 'user') as ScopeMode),
      scopeKey: safeString(raw.scope_key),
      importance: Number(raw.importance || 0),
      ttlDays: Number(raw.ttl_days || 0),
      expiresAt: safeString(raw.expires_at),
      hits: Number(raw.hits || 0),
      eventId: safeString(raw.event_id),
      metadata,
    };
  }

  private async addCandidate(scope: ScopeContext, text: string, options: CandidateWriteOptions): Promise<{ merged: boolean; candidate: CandidateRow }> {
    const importance = clampInt(options.importance, 1, 100);
    const ttlDays = clampInt(options.ttlDays, 1, 3650);
    const source = safeString(options.source || 'candidate').trim() || 'candidate';
    const eventMeta = {
      ...scope.metadata,
      importance,
      ttl_days: ttlDays,
      source,
      ...(options.sourceEventId ? { source_event_id: options.sourceEventId } : {}),
      ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
    };
    const event = await this.appendEvent('candidate.add', text, eventMeta, scope.chatKey);
    const now = nowIso();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const normalizedText = normalizeMemoryText(text);
    const db = this.openCandidateDb();
    const existing = db.prepare(`
      SELECT *
      FROM candidates
      WHERE status = 'pending' AND normalized_text = ? AND scope_key = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(normalizedText, scope.scopeKey) as Record<string, unknown> | undefined;
    let id: string = crypto.randomUUID();
    let merged = false;
    if (existing) {
      const prior = this.candidateRow(existing);
      id = prior.id;
      merged = true;
      db.prepare(`
        UPDATE candidates
        SET
          updated_at = ?,
          importance = ?,
          ttl_days = ?,
          expires_at = ?,
          hits = hits + 1,
          event_id = ?,
          metadata_json = ?
        WHERE id = ?
      `).run(
        now,
        Math.max(prior.importance, importance),
        Math.max(prior.ttlDays, ttlDays),
        expiresAt > prior.expiresAt ? expiresAt : prior.expiresAt,
        event.id,
        JSON.stringify({
          ...prior.metadata,
          ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
          last_event_id: event.id,
          last_source: source,
          ...(options.sourceEventId ? { source_event_id: options.sourceEventId } : {}),
        }),
        prior.id,
      );
    } else {
      db.prepare(`
        INSERT INTO candidates (
          id, created_at, updated_at, text, normalized_text, status, reason, source, chat_key, user_id, agent_id,
          run_id, memory_scope, scope_key, importance, ttl_days, expires_at, hits, event_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, 'pending', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        now,
        now,
        text,
        normalizedText,
        source,
        scope.chatKey,
        scope.userId,
        scope.agentId,
        scope.runId,
        scope.scope,
        scope.scopeKey,
        importance,
        ttlDays,
        expiresAt,
        event.id,
        JSON.stringify({
          ...scope.metadata,
          ...(options.metadata && typeof options.metadata === 'object' ? options.metadata : {}),
          source_event_id: options.sourceEventId || event.id,
          source,
        }),
      );
    }
    const row = db.prepare(`SELECT * FROM candidates WHERE id = ?`).get(id) as Record<string, unknown>;
    db.close();
    return { merged, candidate: this.candidateRow(row) };
  }

  private eventMatchesScope(row: EventRow, scope: ScopeContext): boolean {
    const meta = row.meta || {};
    if (scope.scope === 'chat') return row.chat_key === scope.chatKey;
    if (scope.scope === 'run') return safeString(meta.run_id) === scope.runId || row.chat_key === scope.chatKey;
    if (scope.scope === 'agent') return safeString(meta.agent_id) === scope.agentId;
    return safeString(meta.user_id) === scope.userId && safeString(meta.agent_id) === scope.agentId;
  }

  private candidateFiltersSql(scope?: ScopeContext, status = '', limit = 50): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (scope) {
      where.push('scope_key = ?');
      params.push(scope.scopeKey);
    }
    if (status && status !== 'all') {
      where.push('status = ?');
      params.push(status);
    }
    const sql = `
      SELECT *
      FROM candidates
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    params.push(limit);
    return { sql, params };
  }

  private searchCandidates(query: string, limit: number, scope?: ScopeContext): CandidateRow[] {
    if (!fssync.existsSync(this.paths.candidateDb)) return [];
    const db = this.openCandidateDb();
    const tokens = [...new Set(query.split(/[^A-Za-z0-9\u4e00-\u9fff]+/).map((token) => token.trim()).filter((token) => token.length >= 2))];
    const needles = tokens.length ? tokens : [query];
    const params: unknown[] = [];
    const tokenClauses = needles.map((token) => {
      params.push(`%${token}%`, `%${normalizeMemoryText(token)}%`);
      return `(text LIKE ? OR normalized_text LIKE ?)`;
    });
    const where = [`status = 'pending'`, `(${tokenClauses.join(' OR ')})`];
    if (scope) {
      where.push('scope_key = ?');
      params.push(scope.scopeKey);
    }
    const rows = db.prepare(`
      SELECT *
      FROM candidates
      WHERE ${where.join(' AND ')}
      ORDER BY importance DESC, hits DESC, updated_at DESC
      LIMIT ?
    `).all(...params, limit) as Array<Record<string, unknown>>;
    db.close();
    return rows.map((row) => this.candidateRow(row));
  }

  private rankMem0Row(query: string, scope: ScopeContext, row: Record<string, unknown>): number {
    const text = safeString(row.memory || '');
    const metadata = (row.metadata && typeof row.metadata === 'object') ? row.metadata as Record<string, unknown> : {};
    const source = safeString(metadata.source || '');
    const memoryScope = safeString(metadata.memory_scope || '');
    const runId = safeString(row.runId || metadata.run_id || '');
    let score = Number(row.score || 0);
    score += recallLexicalScore(query, text);
    score += recencyScore(safeString(row.updatedAt || row.createdAt || ''));
    if (source === 'remember' || source === 'inbox') score += 0.7;
    if (source.startsWith('session.finalize')) score -= 0.45;
    if (source === 'candidate.tidy') score -= 0.2;
    if (scope.scope === 'user' && (memoryScope === 'chat' || memoryScope === 'run' || runId)) score -= 0.7;
    if (scope.scope === 'chat' && runId && runId === scope.runId) score += 0.35;
    if (scope.scope === 'chat' && safeString(metadata.chat_key || '') === scope.chatKey) score += 0.1;
    return score;
  }

  private rankCandidateRow(query: string, row: Record<string, unknown>): number {
    return recallLexicalScore(query, safeString(row.text || ''))
      + (Number(row.importance || 0) / 100)
      + Math.min(0.5, Number(row.hits || 0) * 0.05)
      + recencyScore(safeString(row.updatedAt || ''));
  }

  async cmdShow(args: ParsedArgs): Promise<number> {
    const limit = optInt(args, 'limit', 20);
    const scope = this.resolveScopeArgs(args);
    const memory = await this.getMem0();
    const result = await memory.getAll({ ...scope.mem0Filters, limit });
    const rows = Array.isArray(result?.results) ? result.results : [];
    if (!rows.length) {
      console.log('(no mem0 memories yet)');
      return 0;
    }
    rows.sort((a: any, b: any) => safeString(b.createdAt || '').localeCompare(safeString(a.createdAt || '')));
    for (const item of rows.slice(0, limit)) {
      const created = safeString((item as any).createdAt || '').replace('T', ' ');
      console.log(`- [${created || 'unknown'}] ${safeString((item as any).memory || '')}`);
    }
    return 0;
  }

  async cmdSearch(args: ParsedArgs): Promise<number> {
    const [query] = args.positionals;
    if (!query) throw new Error('Missing query');
    const limit = optInt(args, 'limit', 12);
    const scope = this.resolveScopeArgs(args);
    const memory = await this.getMem0();
    const result = await memory.search(query, { ...scope.mem0Filters, limit });
    const rows = Array.isArray(result?.results) ? result.results : [];
    if (!rows.length) {
      console.log('(no matches)');
      return 0;
    }
    rows.forEach((item: any, idx: number) => {
      const score = typeof item.score === 'number' ? ` score=${item.score.toFixed(3)}` : '';
      console.log(`${idx + 1}. ${safeString(item.memory || '')}${score}`);
    });
    return 0;
  }

  async cmdRecall(args: ParsedArgs): Promise<number> {
    const [query] = args.positionals;
    if (!query) throw new Error('Usage: brain recall <query> [--limit N] [--scope user|chat|agent|run]');
    const limit = optInt(args, 'limit', 12);
    const perSource = Math.max(4, Math.ceil(limit / 2));
    const scope = this.resolveScopeArgs(args);
    const includeCandidates = Boolean(args.options.includeCandidates);
    const memory = await this.getMem0();
    const mem0FetchLimit = Math.max(limit * 4, 24);
    const mem0Result = await memory.search(query, { ...scope.mem0Filters, limit: mem0FetchLimit });
    const mem0Rows = ((Array.isArray(mem0Result?.results) ? mem0Result.results : []) as unknown as Array<Record<string, unknown>>)
      .map((row) => ({ ...row, _rinRank: this.rankMem0Row(query, scope, row) }))
      .sort((a, b) => Number(b._rinRank || 0) - Number(a._rinRank || 0))
      .slice(0, perSource)
      .map(({ _rinRank, ...row }) => row);
    const candidateRows = includeCandidates
      ? this.searchCandidates(query, Math.max(perSource * 2, 12), scope)
        .map((row) => ({
          id: row.id,
          text: row.text,
          importance: row.importance,
          hits: row.hits,
          updatedAt: row.updatedAt,
          status: row.status,
          scopeKey: row.scopeKey,
          _rinRank: this.rankCandidateRow(query, row),
        }))
        .sort((a, b) => Number(b._rinRank || 0) - Number(a._rinRank || 0))
        .slice(0, perSource)
        .map(({ _rinRank, ...row }) => row)
      : [];
    const eventRows = (await this.searchEvents(query, Math.max(perSource * 2, 12)))
      .filter((row) => this.eventMatchesScope(row, scope))
      .slice(0, perSource);
    const kbRuntime = new KBRuntime(this.paths);
    const kbRows = await kbRuntime.recall(query, perSource);

    const fused = new Map<string, Record<string, unknown>>();
    const add = (source: 'mem0' | 'candidate' | 'event' | 'kb', rows: Array<Record<string, unknown>>) => {
      rows.forEach((row, index) => {
        const key = `${source}:${safeString(row.id || row.event_id || row.rowId || index)}`;
        const existing = fused.get(key) || {
          id: safeString(row.id || ''),
          source,
          score: 0,
          text: safeString(row.memory || row.content || row.text || ''),
        };
        const baseWeight = source === 'mem0'
          ? this.rankMem0Row(query, scope, row)
          : source === 'candidate'
            ? this.rankCandidateRow(query, row) * 0.85
            : source === 'event'
              ? (recallLexicalScore(query, safeString(row.content || '')) * 0.35) + (recencyScore(safeString(row.ts || '')) * 0.1)
              : recallLexicalScore(query, safeString(row.text || '')) * 0.25;
        existing.score = Number(existing.score || 0) + baseWeight + (1 / (40 + index + 1));
        if (source === 'mem0') Object.assign(existing, { createdAt: safeString(row.createdAt || ''), memory: safeString(row.memory || '') });
        if (source === 'candidate') Object.assign(existing, { updatedAt: safeString(row.updatedAt || ''), importance: Number(row.importance || 0), hits: Number(row.hits || 0), status: safeString(row.status || '') });
        if (source === 'event') Object.assign(existing, { ts: safeString(row.ts || ''), type: safeString(row.type || ''), chatKey: safeString(row.chat_key || '') });
        if (source === 'kb') Object.assign(existing, { path: safeString(row.path || ''), title: safeString(row.title || ''), chunkIndex: Number(row.chunkIndex || 0) });
        fused.set(key, existing);
      });
    };
    add('mem0', mem0Rows);
    if (includeCandidates) add('candidate', candidateRows);
    add('event', eventRows as unknown as Array<Record<string, unknown>>);
    add('kb', kbRows as Array<Record<string, unknown>>);

    printJson({
      query,
      scope: {
        scope: scope.scope,
        userId: scope.userId,
        agentId: scope.agentId,
        runId: scope.runId,
        chatKey: scope.chatKey,
        scopeKey: scope.scopeKey,
      },
      results: {
        mem0: mem0Rows,
        candidates: candidateRows,
        events: eventRows,
        kb: kbRows,
      },
      merged: [...fused.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0)).slice(0, limit),
    });
    return 0;
  }

  async cmdTurn(args: ParsedArgs): Promise<number> {
    const [role, text] = args.positionals;
    if (!role || !text || !['user', 'assistant'].includes(role)) throw new Error('Usage: brain turn <user|assistant> <text> [--chatKey <key>]');
    const scope = this.resolveScopeArgs(args);
    const event = await this.appendEvent(`turn.${role}`, text, { role, ...scope.metadata }, scope.chatKey);
    printJson({ event_id: event.id, ts: event.ts, backend: 'events-daily', chat_key: event.chat_key, file: event.shard });
    return 0;
  }

  async cmdRemember(args: ParsedArgs, source = 'remember'): Promise<number> {
    const [text] = args.positionals;
    if (!text) throw new Error(`Usage: brain ${source} <text> [--chatKey <key>]`);
    const scope = this.resolveScopeArgs(args);
    const infer = await this.memoryInferReady();
    const event = await this.appendEvent(source, text, { ...scope.metadata, infer }, scope.chatKey);
    const memory = await this.getMem0();
    const result = await memory.add(text, {
      ...scope.mem0Filters,
      infer,
      metadata: { source, event_id: event.id, chat_key: event.chat_key, ...scope.metadata },
    } as any);
    printJson(result);
    return 0;
  }

  async cmdCandidateAdd(args: ParsedArgs): Promise<number> {
    const [text] = args.positionals;
    if (!text) throw new Error('Usage: brain candidate add <text> [--importance N] [--ttlDays N]');
    const scope = this.resolveScopeArgs(args);
    const importance = optInt(args, 'importance', 50);
    const ttlDays = optInt(args, 'ttlDays', 14);
    const source = optString(args, 'source', 'candidate') || 'candidate';
    const result = await this.addCandidate(scope, text, { importance, ttlDays, source });
    printJson({ status: 'ok', merged: result.merged, candidate: result.candidate });
    return 0;
  }

  async cmdCandidateList(args: ParsedArgs): Promise<number> {
    const db = this.openCandidateDb();
    const scope = optString(args, 'scope', '').trim() ? this.resolveScopeArgs(args) : undefined;
    const status = optString(args, 'status', 'pending');
    const limit = optInt(args, 'limit', 50);
    const { sql, params } = this.candidateFiltersSql(scope, status, limit);
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    db.close();
    printJson({
      status,
      scope: scope ? {
        scope: scope.scope,
        scopeKey: scope.scopeKey,
        userId: scope.userId,
        agentId: scope.agentId,
        runId: scope.runId,
        chatKey: scope.chatKey,
      } : null,
      results: rows.map((row) => this.candidateRow(row)),
    });
    return 0;
  }

  async cmdDaily(args: ParsedArgs): Promise<number> {
    const [text] = args.positionals;
    if (!text) throw new Error('Usage: brain daily <text> [--chatKey <key>]');
    const scope = this.resolveScopeArgs(args);
    const event = await this.appendEvent('daily', text, scope.metadata, scope.chatKey);
    printJson({ event_id: event.id, ts: event.ts, type: event.type, chat_key: event.chat_key, file: event.shard });
    return 0;
  }

  async cmdSession(args: ParsedArgs): Promise<number> {
    const [title] = args.positionals;
    if (!title) throw new Error('Usage: brain session <title> [--chatKey <key>]');
    const scope = this.resolveScopeArgs(args);
    const event = await this.appendEvent('session', title, scope.metadata, scope.chatKey);
    printJson({ event_id: event.id, ts: event.ts, type: event.type, chat_key: event.chat_key, file: event.shard });
    return 0;
  }

  async cmdFinalize(args: ParsedArgs): Promise<number> {
    const scope = this.resolveScopeArgs(args, 'chat');
    const reason = optString(args, 'reason', 'manual').trim() || 'manual';
    const limit = clampInt(optInt(args, 'limit', 40), 1, 400);
    const all = await this.readAllEvents();
    const sessionEnds = all.filter((row) =>
      row.chat_key === scope.chatKey &&
      row.type === 'session.end' &&
      this.eventMatchesScope(row, scope)
    );
    const lastSessionEnd = sessionEnds.length ? sessionEnds[sessionEnds.length - 1] : null;
    const sinceTs = safeString(lastSessionEnd?.ts || '');
    const turnRows = all
      .filter((row) =>
        row.chat_key === scope.chatKey &&
        (row.type === 'turn.user' || row.type === 'turn.assistant') &&
        this.eventMatchesScope(row, scope) &&
        (!sinceTs || row.ts > sinceTs)
      )
      .slice(-limit);

    let processedTurns = turnRows.length;
    let extractedMemories = 0;
    let addedMemories = 0;
    let updatedMemories = 0;
    let deletedMemories = 0;

    if (!(await this.memoryInferReady())) {
      const endEvent = await this.appendEvent(
        'session.end',
        `finalize:${reason}`,
        {
          ...scope.metadata,
          reason,
          processed_turns: processedTurns,
          extracted_memories: 0,
          added_memories: 0,
          updated_memories: 0,
          deleted_memories: 0,
          finalize_backend: 'mem0-infer',
          skipped_reason: 'memory_infer_unconfigured',
          ...(sinceTs ? { since_ts: sinceTs } : {}),
        },
        scope.chatKey,
      );
      printJson({
        status: 'skip',
        reason,
        skip_reason: 'memory_infer_unconfigured',
        chat_key: scope.chatKey,
        scope: scope.scope,
        processed_turns: processedTurns,
        extracted_memories: 0,
        added_memories: 0,
        updated_memories: 0,
        deleted_memories: 0,
        finalize_backend: 'mem0-infer',
        since_ts: sinceTs || null,
        end_event_id: endEvent.id,
        end_event_ts: endEvent.ts,
      });
      return 0;
    }

    const memory = await this.getMem0();
    if (turnRows.length) {
      const result = await memory.add(
        turnRows.map((row) => ({
          role: row.type === 'turn.user' ? 'user' : 'assistant',
          content: row.content,
        })),
        {
          ...scope.mem0Filters,
          infer: true,
          metadata: {
            source: `session.finalize.${reason}`,
            finalize_reason: reason,
            chat_key: scope.chatKey,
            ...scope.metadata,
            ...(sinceTs ? { since_ts: sinceTs } : {}),
          },
        } as any,
      );
      const actions = Array.isArray(result?.results) ? result.results : [];
      extractedMemories = actions.length;
      for (const item of actions as Array<Record<string, unknown>>) {
        const event = safeString(item?.metadata?.event || '');
        if (event === 'ADD') addedMemories += 1;
        else if (event === 'UPDATE') updatedMemories += 1;
        else if (event === 'DELETE') deletedMemories += 1;
      }
    }

    const endEvent = await this.appendEvent(
      'session.end',
      `finalize:${reason}`,
      {
        ...scope.metadata,
        reason,
        processed_turns: processedTurns,
        extracted_memories: extractedMemories,
        added_memories: addedMemories,
        updated_memories: updatedMemories,
        deleted_memories: deletedMemories,
        finalize_backend: 'mem0-infer',
        ...(sinceTs ? { since_ts: sinceTs } : {}),
      },
      scope.chatKey,
    );

    printJson({
      status: 'ok',
      reason,
      chat_key: scope.chatKey,
      scope: scope.scope,
      processed_turns: processedTurns,
      extracted_memories: extractedMemories,
      added_memories: addedMemories,
      updated_memories: updatedMemories,
      deleted_memories: deletedMemories,
      finalize_backend: 'mem0-infer',
      since_ts: sinceTs || null,
      end_event_id: endEvent.id,
      end_event_ts: endEvent.ts,
    });
    return 0;
  }

  async cmdEventsRecent(args: ParsedArgs): Promise<number> {
    const rows = await this.readRecentEvents(optInt(args, 'hours', 48), optInt(args, 'limit', 200), optString(args, 'chatKey'));
    const filtered = optString(args, 'scope', '').trim() ? rows.filter((row) => this.eventMatchesScope(row, this.resolveScopeArgs(args))) : rows;
    printJson({ results: filtered });
    return 0;
  }

  async cmdEventsSearch(args: ParsedArgs): Promise<number> {
    const [query] = args.positionals;
    if (!query) throw new Error('Usage: brain history search <query> [--limit N] [--chatKey <key>]');
    const rows = await this.searchEvents(query, optInt(args, 'limit', 50), optString(args, 'chatKey'));
    const filtered = optString(args, 'scope', '').trim() ? rows.filter((row) => this.eventMatchesScope(row, this.resolveScopeArgs(args))) : rows;
    printJson({ results: filtered });
    return 0;
  }

  async cmdTidy(args: ParsedArgs): Promise<number> {
    const db = this.openCandidateDb();
    const limit = optInt(args, 'limit', 200);
    const status = 'pending';
    const scope = optString(args, 'scope', '').trim() ? this.resolveScopeArgs(args) : undefined;
    const { sql, params } = this.candidateFiltersSql(scope, status, limit);
    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const memory = await this.getMem0();
    const promoteThreshold = clampInt(optInt(args, 'promoteThreshold', 80), 1, 100);
    const hitsThreshold = clampInt(optInt(args, 'hitsThreshold', 2), 1, 100);
    let promoted = 0;
    let expired = 0;
    let duplicate = 0;
    let kept = 0;
    for (const raw of rows) {
      const row = this.candidateRow(raw);
      const expiredNow = parseIso(row.expiresAt)?.getTime() ? Number(parseIso(row.expiresAt)?.getTime()) < Date.now() : false;
      if (expiredNow) {
        db.prepare(`UPDATE candidates SET status = 'expired', reason = 'ttl_expired', updated_at = ? WHERE id = ?`).run(nowIso(), row.id);
        await this.appendEvent('candidate.expire', row.text, { candidate_id: row.id, scope_key: row.scopeKey }, row.chatKey);
        expired += 1;
        continue;
      }
      if (row.importance < promoteThreshold && row.hits < hitsThreshold) {
        kept += 1;
        continue;
      }
      const filters: Record<string, unknown> = {};
      if (row.userId) filters.userId = row.userId;
      if (row.agentId) filters.agentId = row.agentId;
      if (row.runId) filters.runId = row.runId;
      const result = await memory.add(row.text, {
        ...filters,
        infer: await this.memoryInferReady(),
        metadata: {
          source: 'candidate.tidy',
          candidate_id: row.id,
          candidate_scope: row.memoryScope,
          candidate_hits: row.hits,
          candidate_importance: row.importance,
          chat_key: row.chatKey,
          scope_key: row.scopeKey,
        },
      } as any);
      const actions = Array.isArray(result?.results) ? result.results : [];
      const nextStatus = actions.length ? 'promoted' : 'dropped';
      const nextReason = actions.length ? 'promoted_by_tidy' : 'no_change_in_mem0';
      db.prepare(`UPDATE candidates SET status = ?, reason = ?, updated_at = ? WHERE id = ?`).run(nextStatus, nextReason, nowIso(), row.id);
      await this.appendEvent(actions.length ? 'candidate.promote' : 'candidate.drop', row.text, { candidate_id: row.id, scope_key: row.scopeKey, importance: row.importance, hits: row.hits, reason: nextReason }, row.chatKey);
      if (actions.length) promoted += 1;
      else duplicate += 1;
    }
    db.close();
    printJson({ backend: 'mem0ai-node', status: 'ok', promoted, expired, duplicate, kept, promote_threshold: promoteThreshold, hits_threshold: hitsThreshold });
    return 0;
  }

  async cmdDoctor(): Promise<number> {
    const shardFiles = await this.iterEventFiles();
    let candidateCounts: Record<string, number> = {};
    const candidateDbExists = await pathExists(this.paths.candidateDb);
    if (candidateDbExists) {
      const db = this.openCandidateDb();
      const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM candidates GROUP BY status`).all() as Array<Record<string, unknown>>;
      candidateCounts = Object.fromEntries(rows.map((row) => [safeString(row.status), Number(row.n || 0)]));
      db.close();
    }
    printJson({
      root: this.paths.root,
      memory_dir: this.paths.memoryDir,
      events_dir: this.paths.eventsDir,
      events_dir_exists: await pathExists(this.paths.eventsDir),
      events_shard_files: shardFiles.length,
      mem0_history_db_exists: await pathExists(this.paths.mem0HistoryDb),
      mem0_vector_db_exists: await pathExists(this.paths.mem0VectorDb),
      candidate_db_exists: candidateDbExists,
      candidate_counts: candidateCounts,
      embed_model: this.embeddings.model,
      llm_ready: await this.memoryInferReady(),
      memory_model: this.readMemoryModelSettings(),
    });
    return 0;
  }

}

class KBRuntime {
  private paths: RuntimePaths;
  private embeddings: SharedEmbeddings;

  constructor(paths: RuntimePaths) {
    this.paths = paths;
    this.embeddings = SharedEmbeddings.get();
  }

  private async ensureKb(): Promise<void> {
    await fs.mkdir(this.paths.kbVault, { recursive: true });
    const readmePath = path.join(this.paths.kbVault, 'README.md');
    if (!(await pathExists(readmePath))) {
      await writeText(readmePath, ['# KB Vault (Obsidian)', '', 'This vault is for public-shareable knowledge base material only.', '', 'Rules:', '', '- Do not place day-to-day memory here (preferences, profiles, journals, or transient runtime state).', '- Use plain Markdown notes, wikilinks, and tags as the human-editable note layer.', ''].join('\n'));
    }
  }

  private async configureVault(): Promise<void> {
    await this.ensureKb();
    const cfgPath = path.join(os.homedir(), '.config', 'obsidian', 'obsidian.json');
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    const cfg = (await readJson<any>(cfgPath)) || { vaults: {} };
    cfg.vaults = cfg.vaults || {};
    cfg.vaults['rin-kb'] = { path: this.paths.kbVault };
    await writeJson(cfgPath, cfg);
  }

  private async ghLatestAssetUrl(repo: string, pattern: RegExp): Promise<string> {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'user-agent': 'rin-brain' } });
    if (!res.ok) throw new Error(`github_release_lookup_failed:${repo}`);
    const data = await res.json() as any;
    const assets = Array.isArray(data.assets) ? data.assets : [];
    for (const asset of assets) {
      const url = safeString(asset.browser_download_url || '');
      if (pattern.test(url)) return url;
    }
    return '';
  }

  private async download(url: string, outPath: string): Promise<void> {
    const res = await fetch(url, { headers: { 'user-agent': 'rin-brain' } });
    if (!res.ok || !res.body) throw new Error(`download_failed:${url}`);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    const dest = fssync.createWriteStream(outPath);
    await pipeline(Readable.fromWeb(res.body as any), dest);
  }

  private async installObsidianCli(): Promise<void> {
    const url = await this.ghLatestAssetUrl('Yakitrak/obsidian-cli', /linux_amd64\.tar\.gz$/);
    if (!url) throw new Error('obsidian_cli_asset_not_found');
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rin-obsidian-cli-'));
    const tarball = path.join(tmpDir, 'obsidian-cli.tar.gz');
    await this.download(url, tarball);
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', tmpDir], { stdio: 'inherit' });
    if ((untar.status ?? 1) !== 0) throw new Error('obsidian_cli_extract_failed');
    const candidates = await fs.readdir(tmpDir, { recursive: true }).catch(() => [] as any[]);
    const rel = (candidates as string[]).find((name) => /(^|\/)obsidian-cli$/.test(name) || /(^|\/)notesmd-cli$/.test(name));
    if (!rel) throw new Error('obsidian_cli_binary_not_found');
    const source = path.join(tmpDir, rel);
    const dest = path.join(os.homedir(), '.local', 'bin', 'obsidian-cli');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
    await fs.chmod(dest, 0o755);
    console.log(`Installed: ${dest}`);
  }

  private async installObsidianDesktop(): Promise<void> {
    const url = await this.ghLatestAssetUrl('obsidianmd/obsidian-releases', /Obsidian-.*\.AppImage$/);
    if (!url) throw new Error('obsidian_appimage_asset_not_found');
    const app = path.join(os.homedir(), '.local', 'opt', 'obsidian', 'Obsidian.AppImage');
    await this.download(url, app);
    await fs.chmod(app, 0o755);
    const dest = path.join(os.homedir(), '.local', 'bin', 'obsidian');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try { await fs.unlink(dest); } catch {}
    await fs.symlink(app, dest);
    console.log(`Installed: ${dest}`);
  }

  private async loadDocs(): Promise<Array<{ path: string; title: string; text: string; sha256: string; mtime: number }>> {
    await this.ensureKb();
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
      }
    };
    await walk(this.paths.kbVault);
    const docs = [] as Array<{ path: string; title: string; text: string; sha256: string; mtime: number }>;
    for (const filePath of files.sort()) {
      const text = await readText(filePath);
      const rel = path.relative(this.paths.kbVault, filePath);
      const stat = await fs.stat(filePath);
      docs.push({
        path: rel,
        title: firstHeading(text, path.basename(rel, '.md')),
        text,
        sha256: await shaFile(filePath),
        mtime: stat.mtimeMs,
      });
    }
    return docs;
  }

  private splitMarkdown(doc: { path: string; title: string; text: string; sha256: string; mtime: number }): KbChunk[] {
    const chunkSize = Number(process.env.RIN_KB_CHUNK_SIZE || '768');
    const overlap = Number(process.env.RIN_KB_CHUNK_OVERLAP || '96');
    const cleaned = doc.text.replace(/\r/g, '').trim();
    if (!cleaned) return [];
    const parts = cleaned.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
    const chunks: string[] = [];
    let current = '';
    for (const part of parts) {
      if (!current) {
        current = part;
        continue;
      }
      if ((current + '\n\n' + part).length <= chunkSize) {
        current += `\n\n${part}`;
      } else {
        chunks.push(current);
        const tail = current.slice(Math.max(0, current.length - overlap));
        current = `${tail}\n\n${part}`.slice(-chunkSize);
      }
    }
    if (current) chunks.push(current);
    return chunks.map((text, index) => ({
      id: sha256Hex(`${doc.path}:${index}:${text}`),
      path: doc.path,
      title: doc.title,
      chunkIndex: index,
      text,
      sha256: doc.sha256,
      mtime: doc.mtime,
    }));
  }

  private async openKbTable(): Promise<Table> {
    const conn = await connect(this.paths.kbLanceDir);
    return await conn.openTable('kb_chunks');
  }

  async cmdIndex(): Promise<number> {
    await this.ensureKb();
    await fs.mkdir(this.paths.kbIndexDir, { recursive: true });
    const docs = await this.loadDocs();
    if (!docs.length) {
      printJson({ status: 'skip', reason: `no markdown files under ${this.paths.kbVault}` });
      return 0;
    }
    const chunks = docs.flatMap((doc) => this.splitMarkdown(doc));
    const vectors = await this.embeddings.embedBatch(chunks.map((chunk) => chunk.text));
    const rows: KbRow[] = chunks.map((chunk, idx) => ({ ...chunk, vector: vectors[idx] || [] }));
    const conn = await connect(this.paths.kbLanceDir);
    const table = await conn.createTable('kb_chunks', rows as any[], { mode: 'overwrite' });
    try {
      await table.createIndex('text', { config: Index.fts(), replace: true });
    } catch {
      // ignore FTS re-create issues; search can still work on small local data if index creation is unavailable
    }
    try {
      await table.createIndex('vector', { replace: true });
    } catch {
      // optional on small local datasets
    }
    await writeJson(this.paths.kbManifest, {
      embed_model: this.embeddings.model,
      files: Object.fromEntries(docs.map((doc) => [doc.path, { sha256: doc.sha256, mtime: doc.mtime }])),
      chunks: rows.length,
      indexed_at: nowIso(),
    });
    printJson({ status: 'ok', docs: docs.length, chunks: rows.length, lancedb_dir: this.paths.kbLanceDir });
    return 0;
  }

  private async searchBm25(query: string, limit: number): Promise<any[]> {
    const table = await this.openKbTable();
    return await (table.search(query, 'fts', ['text']) as any).select(['id', 'path', 'title', 'chunkIndex', 'text', '_score']).withRowId().limit(limit).toArray();
  }

  private async searchVector(query: string, limit: number): Promise<any[]> {
    const table = await this.openKbTable();
    const vector = await this.embeddings.embedQuery(query);
    return await (table.search(vector, 'vector') as any).select(['id', 'path', 'title', 'chunkIndex', 'text', '_distance']).withRowId().limit(limit).toArray();
  }

  private fuseResults(ftsRows: any[], vectorRows: any[], limit: number): any[] {
    const map = new Map<string, any>();
    const add = (rows: any[], source: 'bm25' | 'vector') => {
      rows.forEach((row, index) => {
        const key = safeString((row as any)._rowid ?? row.id);
        const existing = map.get(key) || {
          id: row.id,
          path: row.path,
          title: row.title,
          chunkIndex: row.chunkIndex,
          text: row.text,
          rowId: key,
          sources: [] as string[],
          score: 0,
        };
        existing.sources = [...new Set([...existing.sources, source])];
        existing.score += 1 / (60 + index + 1);
        map.set(key, existing);
      });
    };
    add(ftsRows, 'bm25');
    add(vectorRows, 'vector');
    return [...map.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async recall(query: string, limit: number): Promise<any[]> {
    if (!(await pathExists(this.paths.kbManifest))) return [];
    const [ftsRows, vectorRows] = await Promise.all([this.searchBm25(query, Math.max(limit, 8)), this.searchVector(query, Math.max(limit, 8))]);
    return this.fuseResults(ftsRows, vectorRows, limit);
  }

  async cmdSearch(args: ParsedArgs): Promise<number> {
    const [query] = args.positionals;
    if (!query) throw new Error('Usage: knowledge search <query> [--limit N] [--mode bm25|vector|hybrid]');
    const limit = optInt(args, 'limit', 8);
    const mode = optString(args, 'mode', 'hybrid') || 'hybrid';
    if (!(await pathExists(this.paths.kbManifest))) throw new Error('kb_not_indexed');
    if (mode === 'bm25') {
      printJson({ mode, results: await this.searchBm25(query, limit) });
      return 0;
    }
    if (mode === 'vector') {
      printJson({ mode, results: await this.searchVector(query, limit) });
      return 0;
    }
    printJson({ mode: 'hybrid', results: await this.recall(query, limit) });
    return 0;
  }

  async cmdDoctor(): Promise<number> {
    const docs = await this.loadDocs();
    const manifest = await readJson<any>(this.paths.kbManifest);
    let stale = true;
    if (manifest && manifest.files && typeof manifest.files === 'object') {
      stale = docs.some((doc) => {
        const prior = (manifest.files as any)[doc.path];
        return !prior || prior.sha256 !== doc.sha256 || Number(prior.mtime || 0) !== doc.mtime;
      }) || Object.keys(manifest.files).length !== docs.length;
    }
    printJson({
      vault: this.paths.kbVault,
      markdown_files: docs.length,
      index_dir: this.paths.kbIndexDir,
      manifest_exists: await pathExists(this.paths.kbManifest),
      lancedb_dir_exists: await pathExists(this.paths.kbLanceDir),
      embed_model: this.embeddings.model,
      stale,
    });
    return 0;
  }

  async cmdInstall(): Promise<number> {
    console.log('Installing KB toolchain (user-local, no sudo)...');
    await this.installObsidianDesktop();
    await this.installObsidianCli();
    await this.configureVault();
    await this.ensureKb();
    return 0;
  }

  async cmdSetup(): Promise<number> {
    await this.configureVault();
    await this.ensureKb();
    return 0;
  }

  async cmdVault(args: ParsedArgs): Promise<number> {
    const [sub] = args.positionals;
    if (sub !== 'open') throw new Error('Usage: knowledge vault open');
    await this.ensureKb();
    const obsidian = findExecutableOnPath('obsidian') || path.join(os.homedir(), '.local', 'bin', 'obsidian');
    if (fssync.existsSync(obsidian)) {
      const child = spawn(obsidian, [this.paths.kbVault], { stdio: 'ignore', detached: true });
      child.unref();
      console.log(`Opened: ${this.paths.kbVault}`);
    } else {
      console.log(this.paths.kbVault);
    }
    return 0;
  }

  async cmdObsidian(args: ParsedArgs): Promise<number> {
    await this.ensureKb();
    const obsidianCli = findExecutableOnPath('obsidian-cli') || path.join(os.homedir(), '.local', 'bin', 'obsidian-cli');
    if (!fssync.existsSync(obsidianCli)) throw new Error('obsidian_cli_missing');
    const result = spawnSync(obsidianCli, args.positionals, { cwd: this.paths.kbVault, stdio: 'inherit' });
    if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
    return 0;
  }
}

function usage(exitCode = 2): never {
  console.error([
    'Usage:',
    '  rin-brain brain show [--limit N]',
    '  rin-brain brain search <query> [--limit N]',
    '  rin-brain brain recall <query> [--limit N] [--scope user|chat|agent|run]',
    '  rin-brain brain remember <text> [--chatKey <key>]',
    '  rin-brain brain candidate add <text> [--importance N] [--ttlDays N] [--scope user|chat|agent|run]',
    '  rin-brain brain candidate list [--status pending|promoted|expired|dropped|all] [--limit N] [--scope ...]',
    '  rin-brain brain inbox <text> [--chatKey <key>]',
    '  rin-brain brain turn <user|assistant> <text> [--chatKey <key>]',
    '  rin-brain brain daily <text> [--chatKey <key>]',
    '  rin-brain brain session <title> [--chatKey <key>]',
    '  rin-brain brain finalize [--chatKey <key>] [--reason done|reset|manual] [--limit N] [--scope user|chat|agent|run]',
    '  rin-brain brain history recent [--hours H] [--limit N] [--chatKey <key>]',
    '  rin-brain brain history search <query> [--limit N] [--chatKey <key>]',
    '  rin-brain brain preheat [--limit N]',
    '  rin-brain brain tidy',
    '  rin-brain brain doctor',
    '  rin-brain knowledge index',
    '  rin-brain knowledge search <query> [--limit N] [--mode bm25|vector|hybrid]',
    '  rin-brain knowledge doctor',
    '  rin-brain knowledge install',
    '  rin-brain knowledge setup',
    '  rin-brain knowledge vault open',
    '  rin-brain knowledge obsidian <args...>',
  ].join('\n'));
  process.exit(exitCode);
}

export async function runBrainCli(argvInput = process.argv.slice(2), rootOverride = ''): Promise<number> {
  const root = path.resolve(rootOverride || path.join(os.homedir(), '.rin'));
  const paths = new RuntimePaths(root);
  const argv = argvInput.slice();
  const area = argv.shift();
  if (!area || area === '-h' || area === '--help' || area === 'help') usage(0);

  if (area === 'brain') {
    const runtime = new MemoryRuntime(paths);
    const cmd = argv.shift();
    if (!cmd) usage(2);
    if (cmd === 'show') return await runtime.cmdShow(parseArgs(argv));
    if (cmd === 'search') return await runtime.cmdSearch(parseArgs(argv));
    if (cmd === 'recall') return await runtime.cmdRecall(parseArgs(argv));
    if (cmd === 'turn') return await runtime.cmdTurn(parseArgs(argv));
    if (cmd === 'remember') return await runtime.cmdRemember(parseArgs(argv), 'remember');
    if (cmd === 'inbox') return await runtime.cmdRemember(parseArgs(argv), 'inbox');
    if (cmd === 'daily') return await runtime.cmdDaily(parseArgs(argv));
    if (cmd === 'session') return await runtime.cmdSession(parseArgs(argv));
    if (cmd === 'finalize') return await runtime.cmdFinalize(parseArgs(argv));
    if (cmd === 'preheat') return await runtime.cmdShow(parseArgs(argv));
    if (cmd === 'tidy') return await runtime.cmdTidy(parseArgs(argv));
    if (cmd === 'doctor') return await runtime.cmdDoctor();
    if (cmd === 'candidate') {
      const sub = argv.shift();
      if (sub === 'add') return await runtime.cmdCandidateAdd(parseArgs(argv));
      if (sub === 'list') return await runtime.cmdCandidateList(parseArgs(argv));
    }
    if (cmd === 'history') {
      const sub = argv.shift();
      if (sub === 'recent') return await runtime.cmdEventsRecent(parseArgs(argv));
      if (sub === 'search') return await runtime.cmdEventsSearch(parseArgs(argv));
    }
    usage(2);
  }

  if (area === 'knowledge') {
    const runtime = new KBRuntime(paths);
    const cmd = argv.shift();
    if (!cmd) usage(2);
    if (cmd === 'index') return await runtime.cmdIndex();
    if (cmd === 'search') return await runtime.cmdSearch(parseArgs(argv));
    if (cmd === 'doctor') return await runtime.cmdDoctor();
    if (cmd === 'install') return await runtime.cmdInstall();
    if (cmd === 'setup') return await runtime.cmdSetup();
    if (cmd === 'vault') return await runtime.cmdVault(parseArgs(argv));
    if (cmd === 'obsidian') return await runtime.cmdObsidian(parseArgs(argv));
    usage(2);
  }

  usage(2);
}

async function main(): Promise<void> {
  process.exitCode = await runBrainCli();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(safeString((error as Error)?.message || error));
    process.exit(1);
  });
}
