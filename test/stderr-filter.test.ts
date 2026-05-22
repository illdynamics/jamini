import { describe, it, expect, beforeEach } from 'vitest';
import { filterStderrLine, _resetYoloCount } from '../src/stderr-filter.js';

describe('stderr-filter', () => {
  beforeEach(() => {
    _resetYoloCount();
  });

  describe('drops known warning lines', () => {
    it('drops true-color warning (original format)', () => {
      expect(filterStderrLine('Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.')).toBe('');
    });

    it('drops true-color warning (short format)', () => {
      expect(filterStderrLine('Warning: True color (24-bit) support not detected.')).toBe('');
    });

    it('drops basic terminal warning', () => {
      expect(filterStderrLine('Warning: Basic terminal detected (TERM=dumb). Visual rendering will be limited. For the best experience, use a terminal emulator with truecolor support.')).toBe('');
    });

    it('drops 256-color warning', () => {
      expect(filterStderrLine('Warning: 256-color support not detected. Using a terminal with at least 256-color support is recommended for a better visual experience.')).toBe('');
    });

    it('drops ripgrep fallback warning', () => {
      expect(filterStderrLine('Ripgrep is not available. Falling back to GrepTool.')).toBe('');
    });

    it('drops cleanup_ops startup phase warning', () => {
      expect(filterStderrLine("[STARTUP] Phase 'cleanup_ops' was started but never ended. Skipping metrics.")).toBe('');
    });

    it('drops cleanup_ops start mark warning', () => {
      expect(filterStderrLine("[STARTUP] Cannot measure phase 'cleanup_ops': start mark 'startup:cleanup_ops:start' not found (likely cleared by reset).")).toBe('');
    });
  });

  describe('YOLO deduplication', () => {
    it('allows first YOLO message', () => {
      const result = filterStderrLine('YOLO mode is enabled. All tool calls will be automatically approved.');
      expect(result).toContain('YOLO mode is enabled');
    });

    it('drops second YOLO message', () => {
      filterStderrLine('YOLO mode is enabled. All tool calls will be automatically approved.');
      const result = filterStderrLine('YOLO mode is enabled. All tool calls will be automatically approved.');
      expect(result).toBe('');
    });

    it('drops third YOLO message', () => {
      filterStderrLine('YOLO mode is enabled. All tool calls will be automatically approved.');
      filterStderrLine('YOLO mode is enabled. All tool calls will be automatically approved.');
      const result = filterStderrLine('YOLO mode is enabled. All tool calls will be automatically approved.');
      expect(result).toBe('');
    });
  });

  describe('no-input message replacement', () => {
    it('replaces gemini with jamini in no-input message', () => {
      const input = 'No input provided via stdin. Input can be provided by piping data into gemini or using the --prompt option.';
      const result = filterStderrLine(input);
      expect(result).toContain('jamini');
      expect(result).not.toContain('gemini');
    });
  });

  describe('thinking/reasoning leak prevention', () => {
    it('does not filter visible assistant content', () => {
      expect(filterStderrLine('Hello, I am an AI assistant.')).toBe('Hello, I am an AI assistant.');
    });

    it('does not filter reasoning content from the bridge', () => {
      // Normal reasoning content output (not from Gemini CLI startup messages)
      expect(filterStderrLine('Let me think about this...')).toBe('Let me think about this...');
    });

    it('passes through normal output with thinking keyword in user context', () => {
      // This simulates actual assistant content that should not be filtered
      expect(filterStderrLine('I am thinking about the best approach.')).toBe('I am thinking about the best approach.');
    });
  });

  describe('passes through normal output', () => {
    it('passes through normal text', () => {
      expect(filterStderrLine('Hello world')).toBe('Hello world');
    });

    it('passes through error messages', () => {
      expect(filterStderrLine('Error: something went wrong')).toBe('Error: something went wrong');
    });

    it('passes through blank lines', () => {
      expect(filterStderrLine('   ')).toBe('   ');
    });
  });
});
