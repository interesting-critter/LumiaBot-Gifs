import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';

import { config } from '../../utils/config';
import { modelSelectorService } from '../model-selector';
import { promptSelectorService } from '../prompt-selector';

/**
 * Model changes and prompt profiles are one behaviour, not two.
 *
 * The operator's rule: switching model clears the manual prompt override, so the
 * prompt follows the new model. That makes `model-selector.ts` the only thing
 * that can clear it, which means the interesting cases are all about *when* it
 * is called:
 *
 *   - after a successful change, and
 *   - never after a rejected one.
 *
 * These run against the real singletons, because the wiring between the two
 * services is the thing under test and a hand-built instance would not exercise
 * it. The config each test mutates is restored in `finally`, and the model
 * selector is reset afterwards, so nothing leaks into the rest of the suite.
 *
 * Both singletons share the throwaway `DATA_DIR` that `bunfig.toml`'s preload
 * points at, so these rows never touch a real database.
 */

const MODELS = ['gpt-4o', 'kimi-k2-thinking'];
const originalOptions = config.dashboard.modelOptions;
const originalAvailable = config.promptProfiles.available;
const originalByModel = config.promptProfiles.byModel;
const originalModel = config.openai.modelAlias;

function configure(options: { available?: string[]; byModel?: Record<string, string> } = {}): void {
  config.dashboard.modelOptions = [...MODELS];
  config.promptProfiles.available = options.available ?? ['default', 'big-rpd'];
  config.promptProfiles.byModel = options.byModel ?? {};
  // model-selector mirrors the active model here; the profile selector reads it
  // back through config, which is how the two agree on the current model.
  config.openai.modelAlias = modelSelectorService.getActiveModel();
}

function restoreConfig(): void {
  config.dashboard.modelOptions = originalOptions;
  config.promptProfiles.available = originalAvailable;
  config.promptProfiles.byModel = originalByModel;
  config.openai.modelAlias = originalModel;
}

const warn = spyOn(console, 'warn').mockImplementation(() => {});
const error = spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  modelSelectorService.reset();
  promptSelectorService.clearOverride();
});

afterAll(() => {
  warn.mockRestore();
  error.mockRestore();
  restoreConfig();
});

describe('model-selector drives the prompt profile', () => {
  test('a successful model switch clears the override and applies the new model\'s binding', () => {
    configure({ byModel: { 'kimi-k2-thinking': 'big-rpd' } });
    try {
      modelSelectorService.setModel('gpt-4o');
      promptSelectorService.setOverride('big-rpd');
      expect(promptSelectorService.getState().override).toBe('big-rpd');

      modelSelectorService.setModel('kimi-k2-thinking');

      const state = promptSelectorService.getState();
      expect(state.override).toBeNull();
      expect(state.active).toBe('big-rpd');
    } finally {
      restoreConfig();
    }
  });

  test('a model with no binding falls back to the default profile', () => {
    configure({ byModel: { 'kimi-k2-thinking': 'big-rpd' } });
    try {
      modelSelectorService.setModel('kimi-k2-thinking');
      promptSelectorService.setOverride('big-rpd');

      modelSelectorService.setModel('gpt-4o');

      const state = promptSelectorService.getState();
      expect(state.override).toBeNull();
      expect(state.active).toBe('default');
    } finally {
      restoreConfig();
    }
  });

  test('a rejected model leaves the override intact', () => {
    configure();
    try {
      modelSelectorService.setModel('gpt-4o');
      promptSelectorService.setOverride('big-rpd');

      // Not in DASHBOARD_MODEL_OPTIONS, so setModel throws before persisting.
      expect(() => modelSelectorService.setModel('not-a-real-model')).toThrow();

      // The whole point of ordering the call after validation: a failed model
      // change must not quietly discard the operator's prompt selection.
      expect(promptSelectorService.getState().override).toBe('big-rpd');
      expect(promptSelectorService.getState().active).toBe('big-rpd');
      expect(modelSelectorService.getActiveModel()).toBe('gpt-4o');
    } finally {
      restoreConfig();
    }
  });

  test('resetting the model clears the override too', () => {
    configure();
    try {
      modelSelectorService.setModel('kimi-k2-thinking');
      promptSelectorService.setOverride('big-rpd');
      expect(promptSelectorService.getState().override).toBe('big-rpd');

      modelSelectorService.reset();

      expect(promptSelectorService.getState().override).toBeNull();
    } finally {
      restoreConfig();
    }
  });

  test('re-selecting the current model is not a change and keeps the override', () => {
    configure();
    try {
      modelSelectorService.setModel('gpt-4o');
      promptSelectorService.setOverride('big-rpd');

      modelSelectorService.setModel('gpt-4o');

      // Nothing moved, so nothing was reset. An operator re-confirming the
      // model should not lose their prompt profile.
      expect(promptSelectorService.getState().override).toBe('big-rpd');
    } finally {
      restoreConfig();
    }
  });
});