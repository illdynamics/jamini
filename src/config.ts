/**
 * Jamini configuration management.
 *
 * Loads config from:
 *   1. Default hardcoded values
 *   2. ~/.jamini/config.json (created with defaults if missing)
 *   3. Environment variable overrides
 *
 * Secrets (API keys) are NEVER written to config files.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ── Types ──────────────────────────────────────────────────────────

export type BridgeMode = 'auto' | 'process' | 'container' | 'external';
export type TranslatorMode = 'auto' | 'litellm' | 'custom';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EnableFlag = 'auto' | 'on' | 'off';

export interface JaminiConfig {
  defaultModel: string;
  bridgeMode: BridgeMode;
  translatorMode: TranslatorMode;
  deepseekBaseUrl: string;
  logLevel: LogLevel;
  enableBraveSearch: EnableFlag;
  enableUnstructured: EnableFlag;
  historyMode: 'ephemeral' | 'local' | 'off';
  systemPrompt: string;
}

// ── Defaults ───────────────────────────────────────────────────────

const DEFAULTS: JaminiConfig = {
  defaultModel: 'v4-flash-thinking',
  bridgeMode: 'auto',
  translatorMode: 'auto',
  deepseekBaseUrl: 'https://api.deepseek.com',
  logLevel: 'info',
  enableBraveSearch: 'auto',
  enableUnstructured: 'auto',
  historyMode: 'ephemeral',
  systemPrompt: '',
};

// ── Paths ──────────────────────────────────────────────────────────

export function getJaminiHome(): string {
  return process.env.JAMINI_HOME || join(homedir(), '.jamini');
}

function configFilePath(): string {
  return join(getJaminiHome(), 'config.json');
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ── Load from JSON ──────────────────────────────────────────────────

function loadFileConfig(): Partial<JaminiConfig> {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const out: Partial<JaminiConfig> = {};
    if (typeof raw.defaultModel === 'string') out.defaultModel = raw.defaultModel;
    if (isBridgeMode(raw.bridgeMode)) out.bridgeMode = raw.bridgeMode;
    if (isTranslatorMode(raw.translatorMode)) out.translatorMode = raw.translatorMode;
    if (typeof raw.deepseekBaseUrl === 'string') out.deepseekBaseUrl = raw.deepseekBaseUrl;
    if (isLogLevel(raw.logLevel)) out.logLevel = raw.logLevel;
    if (isEnableFlag(raw.enableBraveSearch)) out.enableBraveSearch = raw.enableBraveSearch;
    if (isEnableFlag(raw.enableUnstructured)) out.enableUnstructured = raw.enableUnstructured;
    if (typeof raw.systemPrompt === 'string') out.systemPrompt = raw.systemPrompt;
    if (typeof raw.historyMode === 'string' && ['ephemeral', 'local', 'off'].includes(raw.historyMode)) {
      out.historyMode = raw.historyMode;
    }
    return out;
  } catch {
    return {};
  }
}

// ── Env overrides ───────────────────────────────────────────────────

function loadEnvOverrides(): Partial<JaminiConfig> {
  const out: Partial<JaminiConfig> = {};

  if (process.env.JAMINI_MODEL) out.defaultModel = process.env.JAMINI_MODEL;
  if (isBridgeMode(process.env.JAMINI_BRIDGE_MODE)) out.bridgeMode = process.env.JAMINI_BRIDGE_MODE;
  if (isTranslatorMode(process.env.JAMINI_TRANSLATOR_MODE)) out.translatorMode = process.env.JAMINI_TRANSLATOR_MODE;
  if (process.env.DEEPSEEK_BASE_URL) out.deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL;
  if (isLogLevel(process.env.JAMINI_LOG_LEVEL)) out.logLevel = process.env.JAMINI_LOG_LEVEL;
  if (isEnableFlag(process.env.JAMINI_ENABLE_BRAVE_SEARCH)) out.enableBraveSearch = process.env.JAMINI_ENABLE_BRAVE_SEARCH;
  if (isEnableFlag(process.env.JAMINI_ENABLE_UNSTRUCTURED)) out.enableUnstructured = process.env.JAMINI_ENABLE_UNSTRUCTURED;
  if (process.env.JAMINI_SYSTEM_PROMPT) out.systemPrompt = process.env.JAMINI_SYSTEM_PROMPT;
  if (process.env.JAMINI_HISTORY_MODE === 'ephemeral' || process.env.JAMINI_HISTORY_MODE === 'local' || process.env.JAMINI_HISTORY_MODE === 'off') {
    out.historyMode = process.env.JAMINI_HISTORY_MODE;
  }

  return out;
}

// ── Validation helpers ──────────────────────────────────────────────

function isBridgeMode(v: unknown): v is BridgeMode {
  return v === 'auto' || v === 'process' || v === 'container' || v === 'external';
}

function isTranslatorMode(v: unknown): v is TranslatorMode {
  return v === 'auto' || v === 'litellm' || v === 'custom';
}

function isLogLevel(v: unknown): v is LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error';
}

function isEnableFlag(v: unknown): v is EnableFlag {
  return v === 'auto' || v === 'on' || v === 'off';
}

// ── Save config ────────────────────────────────────────────────────

function saveConfig(cfg: JaminiConfig): void {
  const path = configFilePath();
  ensureDir(path);
  // NEVER write secrets — only user-configurable non-secret values
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// ── Init (first-run) ──────────────────────────────────────────────

function initializeConfig(): JaminiConfig {
  const cfg = { ...DEFAULTS };
  const path = configFilePath();
  if (!existsSync(path)) {
    saveConfig(cfg);
  }
  return cfg;
}

// ── Public API ────────────────────────────────────────────────────

let _cached: JaminiConfig | null = null;

export function loadConfig(): JaminiConfig {
  if (_cached) return _cached;

  // Start with defaults
  const cfg: JaminiConfig = { ...DEFAULTS };

  // Layer file config on top
  const fileCfg = loadFileConfig();
  Object.assign(cfg, fileCfg);

  // Layer env overrides on top
  const envCfg = loadEnvOverrides();
  Object.assign(cfg, envCfg);

  // Ensure config file exists with at least defaults
  initializeConfig();

  _cached = cfg;
  return cfg;
}

/**
 * Reload config (clears cache). Useful for tests.
 */
export function reloadConfig(): JaminiConfig {
  _cached = null;
  return loadConfig();
}

/**
 * Update and persist a single config key.
 * Only allows known keys; rejects secrets.
 */
export function updateConfig<K extends keyof JaminiConfig>(
  key: K,
  value: JaminiConfig[K],
): JaminiConfig {
  const cfg = loadConfig();
  cfg[key] = value;
  saveConfig(cfg);
  _cached = cfg;
  return cfg;
}

