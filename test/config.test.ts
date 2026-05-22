import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, reloadConfig, getJaminiHome } from '../src/config.js';

describe('JaminiConfig', () => {
  const testHome = join(tmpdir(), 'jamini-test-config-' + Date.now());

  beforeEach(() => {
    process.env.JAMINI_HOME = testHome;
    mkdirSync(testHome, { recursive: true, mode: 0o700 });

    // Remove config file from previous test
    const configPath = join(testHome, 'config.json');
    if (existsSync(configPath)) {
      rmSync(configPath);
    }

    // Clear env overrides
    delete process.env.JAMINI_MODEL;
    delete process.env.JAMINI_BRIDGE_MODE;
    delete process.env.JAMINI_TRANSLATOR_MODE;
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.JAMINI_LOG_LEVEL;
    delete process.env.JAMINI_ENABLE_BRAVE_SEARCH;
    delete process.env.JAMINI_ENABLE_UNSTRUCTURED;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.BRAVE_API_KEY;
    delete process.env.UNSTRUCTURED_API_KEY;

    // Force fresh config load
    reloadConfig();
  });

  afterEach(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.JAMINI_HOME;
  });

  it('loads default config when no file exists', () => {
    const cfg = loadConfig();
    expect(cfg.defaultModel).toBe('v4-flash-thinking');
    expect(cfg.bridgeMode).toBe('auto');
    expect(cfg.translatorMode).toBe('auto');
    expect(cfg.deepseekBaseUrl).toBe('https://api.deepseek.com');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.enableBraveSearch).toBe('auto');
    expect(cfg.enableUnstructured).toBe('auto');
  });

  it('creates config file with defaults on first load', () => {
    loadConfig();
    const configPath = join(testHome, 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(raw.defaultModel).toBe('v4-flash-thinking');
    expect(raw.bridgeMode).toBe('auto');
  });

  it('respects JAMINI_MODEL env override', () => {
    process.env.JAMINI_MODEL = 'v4-pro';
    reloadConfig();
    const cfg = loadConfig();
    expect(cfg.defaultModel).toBe('v4-pro');
  });

  it('respects JAMINI_BRIDGE_MODE env override', () => {
    process.env.JAMINI_BRIDGE_MODE = 'external';
    reloadConfig();
    const cfg = loadConfig();
    expect(cfg.bridgeMode).toBe('external');
  });

  it('respects JAMINI_TRANSLATOR_MODE env override', () => {
    process.env.JAMINI_TRANSLATOR_MODE = 'litellm';
    reloadConfig();
    const cfg = loadConfig();
    expect(cfg.translatorMode).toBe('litellm');
  });

  it('respects DEEPSEEK_BASE_URL env override', () => {
    process.env.DEEPSEEK_BASE_URL = 'https://custom.deepseek.example.com';
    reloadConfig();
    const cfg = loadConfig();
    expect(cfg.deepseekBaseUrl).toBe('https://custom.deepseek.example.com');
  });

  it('loads config from file', () => {
    const configDir = join(testHome);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(testHome, 'config.json'),
      JSON.stringify({ defaultModel: 'v4-pro', bridgeMode: 'container', logLevel: 'debug' }),
      { mode: 0o600 },
    );
    reloadConfig();
    const cfg = loadConfig();
    expect(cfg.defaultModel).toBe('v4-pro');
    expect(cfg.bridgeMode).toBe('container');
    expect(cfg.logLevel).toBe('debug');
    // Unset values should remain defaults
    expect(cfg.translatorMode).toBe('auto');
  });

  it('env overrides take precedence over file config', () => {
    writeFileSync(
      join(testHome, 'config.json'),
      JSON.stringify({ defaultModel: 'v4-flash' }),
      { mode: 0o600 },
    );
    process.env.JAMINI_MODEL = 'v4-pro-thinking';
    reloadConfig();
    const cfg = loadConfig();
    expect(cfg.defaultModel).toBe('v4-pro-thinking');
  });

  it('never writes secrets to config file', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-super-secret';
    process.env.BRAVE_API_KEY = 'brave-secret-key';
    reloadConfig();
    loadConfig();

    const configPath = join(testHome, 'config.json');
    const raw = readFileSync(configPath, 'utf8');
    expect(raw).not.toContain('sk-super-secret');
    expect(raw).not.toContain('brave-secret-key');
    expect(raw).not.toContain('DEEPSEEK_API_KEY');
    expect(raw).not.toContain('BRAVE_API_KEY');
  });

  it('getJaminiHome respects JAMINI_HOME env', () => {
    const customHome = join(tmpdir(), 'custom-jamini-' + Date.now());
    process.env.JAMINI_HOME = customHome;
    mkdirSync(customHome, { recursive: true });
    expect(getJaminiHome()).toBe(customHome);
    try { rmSync(customHome, { recursive: true, force: true }); } catch {}
  });

  it('ignores invalid config values in file', () => {
    writeFileSync(
      join(testHome, 'config.json'),
      JSON.stringify({
        defaultModel: 123,
        bridgeMode: 'not-a-mode',
        logLevel: 'verbose',
        extraUnknown: 'should-be-ignored',
      }),
      { mode: 0o600 },
    );
    reloadConfig();
    const cfg = loadConfig();
    expect(cfg.defaultModel).toBe('v4-flash-thinking');
    expect(cfg.bridgeMode).toBe('auto');
    expect(cfg.logLevel).toBe('info');
  });

  it('rejects non-boolean/non-string model values', () => {
    writeFileSync(
      join(testHome, 'config.json'),
      JSON.stringify({ defaultModel: null }),
      { mode: 0o600 },
    );
    reloadConfig();
    const cfg = loadConfig();
    // null is not a string, so defaultModel stays default
    expect(cfg.defaultModel).toBe('v4-flash-thinking');
  });
});
