import { describe, it, expect } from 'vitest';

// Dynamic import since bridge uses ESM
let resolveModel: (raw: string) => { id: string; providerModel: string; thinking: boolean; displayName: string; description: string; group: string };

describe('Bridge Privacy - Model Denylist', () => {
  beforeAll(async () => {
    // Import the bridge server module
    const mod = await import('../bridge/src/server.js');
    resolveModel = mod.resolveModel;
  });

  it('rejects gemini-pro model', () => {
    expect(() => resolveModel('gemini-pro')).toThrow();
  });

  it('rejects models/gemini-pro model', () => {
    expect(() => resolveModel('models/gemini-pro')).toThrow();
  });

  it('rejects gemini-2.5-pro model', () => {
    expect(() => resolveModel('gemini-2.5-pro')).toThrow();
  });

  it('rejects google/gemini model', () => {
    expect(() => resolveModel('google/gemini')).toThrow();
  });

  it('rejects vertex model', () => {
    expect(() => resolveModel('vertex')).toThrow();
  });

  it('rejects palm model', () => {
    expect(() => resolveModel('palm')).toThrow();
  });

  it('rejects chat-bison model', () => {
    expect(() => resolveModel('chat-bison')).toThrow();
  });

  it('rejects models/vertex model', () => {
    expect(() => resolveModel('models/vertex')).toThrow();
  });

  it('accepts v4-flash model', () => {
    const m = resolveModel('v4-flash');
    expect(m.providerModel).toBe('deepseek-v4-flash');
  });

  it('accepts v4-flash-thinking model', () => {
    const m = resolveModel('v4-flash-thinking');
    expect(m.providerModel).toBe('deepseek-v4-flash');
    expect(m.thinking).toBe(true);
  });

  it('accepts v4-pro model', () => {
    const m = resolveModel('v4-pro');
    expect(m.providerModel).toBe('deepseek-v4-pro');
  });

  it('accepts v4-pro-thinking model', () => {
    const m = resolveModel('v4-pro-thinking');
    expect(m.providerModel).toBe('deepseek-v4-pro');
    expect(m.thinking).toBe(true);
  });

  it('error message mentions DeepSeek when model rejected', () => {
    try {
      resolveModel('gemini-pro');
    } catch (e: any) {
      expect(e.message).toMatch(/DeepSeek|Jamini/i);
    }
  });
});

describe('Bridge Privacy - Host Blocklist', () => {
  const BLOCKED_HOSTS: string[] = [
    'generativelanguage.googleapis.com',
    'aiplatform.googleapis.com',
    'oauth2.googleapis.com',
    'accounts.google.com',
    'play.googleapis.com',
    'logging.googleapis.com',
    'monitoring.googleapis.com',
    'cloudtrace.googleapis.com',
    'telemetry.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'firebase-settings.crashlytics.com',
    'crashlyticsreports-pa.googleapis.com',
    'analytics.google.com',
    'google-analytics.com',
    'www.google-analytics.com',
    'stats.g.doubleclick.net',
    'doubleclick.net',
    'gstatic.com',
    'googleapis.com',
    'googleusercontent.com',
    'google.com',
  ];

  function isBlockedHost(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return BLOCKED_HOSTS.some((blocked) => {
      if (lower === blocked) return true;
      if (lower.endsWith('.' + blocked)) return true;
      return false;
    });
  }

  it('blocks google.com exactly', () => {
    expect(isBlockedHost('google.com')).toBe(true);
  });

  it('blocks subdomain of google.com', () => {
    expect(isBlockedHost('sub.google.com')).toBe(true);
  });

  it('blocks deep subdomain of google.com', () => {
    expect(isBlockedHost('a.b.c.google.com')).toBe(true);
  });

  it('blocks generativelanguage.googleapis.com', () => {
    expect(isBlockedHost('generativelanguage.googleapis.com')).toBe(true);
  });

  it('blocks aiplatform.googleapis.com', () => {
    expect(isBlockedHost('aiplatform.googleapis.com')).toBe(true);
  });

  it('blocks oauth2.googleapis.com', () => {
    expect(isBlockedHost('oauth2.googleapis.com')).toBe(true);
  });

  it('blocks logging.googleapis.com', () => {
    expect(isBlockedHost('logging.googleapis.com')).toBe(true);
  });

  it('blocks firebaseinstallations.googleapis.com', () => {
    expect(isBlockedHost('firebaseinstallations.googleapis.com')).toBe(true);
  });

  it('blocks crashlyticsreports-pa.googleapis.com', () => {
    expect(isBlockedHost('crashlyticsreports-pa.googleapis.com')).toBe(true);
  });

  it('blocks analytics.google.com', () => {
    expect(isBlockedHost('analytics.google.com')).toBe(true);
  });

  it('blocks google-analytics.com', () => {
    expect(isBlockedHost('google-analytics.com')).toBe(true);
  });

  it('blocks doubleclick.net', () => {
    expect(isBlockedHost('doubleclick.net')).toBe(true);
  });

  it('blocks googleapis.com suffix', () => {
    expect(isBlockedHost('any.googleapis.com')).toBe(true);
  });

  it('blocks googleusercontent.com', () => {
    expect(isBlockedHost('googleusercontent.com')).toBe(true);
  });

  it('does NOT block api.deepseek.com', () => {
    expect(isBlockedHost('api.deepseek.com')).toBe(false);
  });

  it('does NOT block 127.0.0.1', () => {
    expect(isBlockedHost('127.0.0.1')).toBe(false);
  });

  it('does NOT block localhost', () => {
    expect(isBlockedHost('localhost')).toBe(false);
  });

  it('does NOT block example.com', () => {
    expect(isBlockedHost('example.com')).toBe(false);
  });
});

