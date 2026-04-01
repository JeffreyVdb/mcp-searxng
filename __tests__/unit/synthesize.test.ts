#!/usr/bin/env tsx

import { strict as assert } from 'node:assert';
import { performSynthesize, resolveProvider, getProviderConfig, validateSynthesizeConfig } from '../../src/synthesize.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { FetchMocker } from '../helpers/mock-fetch.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();
const fetchMocker = new FetchMocker();

function setupGeminiEnv() {
  envManager.set('GEMINI_API_KEY', 'test-gemini-key');
  envManager.delete('MIMO_API_KEY');
  envManager.delete('SYNTHESIZE_PROVIDER');
}

function setupMimoEnv() {
  envManager.set('MIMO_API_KEY', 'test-mimo-key');
  envManager.delete('GEMINI_API_KEY');
  envManager.set('SYNTHESIZE_PROVIDER', 'mimo');
}

function mockLLMFetch(responseBody: any, options?: { status?: number; ok?: boolean }) {
  const { status = 200, ok = true } = options ?? {};
  fetchMocker.mock(async () => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => responseBody,
    text: async () => JSON.stringify(responseBody),
  }) as Response);
}

function mockLLMError(errorMessage: string) {
  fetchMocker.mock(async () => {
    throw new Error(errorMessage);
  });
}

function createLLMResponse(content: string | null) {
  return {
    id: 'test-id',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

async function runTests() {
  console.log('🧪 Testing: synthesize.ts\n');

  await testFunction('resolveProvider defaults to gemini', async () => {
    envManager.delete('SYNTHESIZE_PROVIDER');
    assert.strictEqual(resolveProvider(), 'gemini');
    envManager.restore();
  }, results);

  await testFunction('resolveProvider returns gemini explicitly', async () => {
    envManager.set('SYNTHESIZE_PROVIDER', 'gemini');
    assert.strictEqual(resolveProvider(), 'gemini');
    envManager.restore();
  }, results);

  await testFunction('resolveProvider returns mimo', async () => {
    envManager.set('SYNTHESIZE_PROVIDER', 'mimo');
    assert.strictEqual(resolveProvider(), 'mimo');
    envManager.restore();
  }, results);

  await testFunction('resolveProvider throws for invalid value', async () => {
    envManager.set('SYNTHESIZE_PROVIDER', 'unknown');
    try {
      resolveProvider();
      assert.fail('Should have thrown');
    } catch (error: any) {
      assert.ok(error.message.includes('Invalid SYNTHESIZE_PROVIDER'));
    }
    envManager.restore();
  }, results);

  await testFunction('resolveProvider is case-insensitive', async () => {
    envManager.set('SYNTHESIZE_PROVIDER', 'MIMO');
    assert.strictEqual(resolveProvider(), 'mimo');
    envManager.restore();
  }, results);

  await testFunction('getProviderConfig returns correct Gemini config', async () => {
    envManager.set('GEMINI_API_KEY', 'test-key');
    envManager.delete('MIMO_API_KEY');
    envManager.delete('SYNTHESIZE_PROVIDER');
    const config = getProviderConfig('gemini');
    assert.strictEqual(config.apiKey, 'test-key');
    assert.strictEqual(config.baseURL, 'https://generativelanguage.googleapis.com/v1beta/openai/');
    assert.strictEqual(config.model, 'gemini-2.5-flash-lite');
    assert.ok(config.defaultParams.max_completion_tokens);
    envManager.restore();
  }, results);

  await testFunction('getProviderConfig returns correct MiMo config', async () => {
    envManager.set('MIMO_API_KEY', 'test-mimo-key');
    const config = getProviderConfig('mimo');
    assert.strictEqual(config.apiKey, 'test-mimo-key');
    assert.strictEqual(config.baseURL, 'https://api.xiaomimimo.com/v1');
    assert.strictEqual(config.model, 'mimo-v2-flash');
    assert.strictEqual(config.defaultParams.max_completion_tokens, 2048);
    assert.strictEqual(config.defaultParams.temperature, 0.5);
    envManager.restore();
  }, results);

  await testFunction('getProviderConfig throws for missing GEMINI_API_KEY', async () => {
    envManager.delete('GEMINI_API_KEY');
    try {
      getProviderConfig('gemini');
      assert.fail('Should have thrown');
    } catch (error: any) {
      assert.ok(error.message.includes('GEMINI_API_KEY'));
    }
    envManager.restore();
  }, results);

  await testFunction('getProviderConfig throws for missing MIMO_API_KEY', async () => {
    envManager.delete('MIMO_API_KEY');
    try {
      getProviderConfig('mimo');
      assert.fail('Should have thrown');
    } catch (error: any) {
      assert.ok(error.message.includes('MIMO_API_KEY'));
    }
    envManager.restore();
  }, results);

  await testFunction('validateSynthesizeConfig returns null with valid Gemini config', async () => {
    setupGeminiEnv();
    assert.strictEqual(validateSynthesizeConfig(), null);
    envManager.restore();
  }, results);

  await testFunction('validateSynthesizeConfig returns error for missing key', async () => {
    envManager.delete('GEMINI_API_KEY');
    envManager.delete('MIMO_API_KEY');
    envManager.delete('SYNTHESIZE_PROVIDER');
    const error = validateSynthesizeConfig();
    assert.ok(error !== null);
    assert.ok(error.includes('GEMINI_API_KEY'));
    envManager.restore();
  }, results);

  await testFunction('performSynthesize returns early for empty results', async () => {
    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', '   ');
    assert.strictEqual(result, 'No results to synthesize.');
  }, results);

  await testFunction('performSynthesize returns early for empty string results', async () => {
    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', '');
    assert.strictEqual(result, 'No results to synthesize.');
  }, results);

  await testFunction('performSynthesize returns config error for missing key', async () => {
    envManager.delete('GEMINI_API_KEY');
    envManager.delete('MIMO_API_KEY');
    envManager.delete('SYNTHESIZE_PROVIDER');
    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', 'some content');
    assert.ok(result.includes('GEMINI_API_KEY'));
    envManager.restore();
  }, results);

  await testFunction('performSynthesize returns config error for invalid provider', async () => {
    envManager.set('SYNTHESIZE_PROVIDER', 'bad-provider');
    envManager.set('GEMINI_API_KEY', 'key');
    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', 'some content');
    assert.ok(result.includes('Invalid SYNTHESIZE_PROVIDER'));
    envManager.restore();
  }, results);

  await testFunction('performSynthesize returns error when LLM call fails', async () => {
    setupGeminiEnv();
    mockLLMError('API rate limit exceeded');

    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', 'some content');
    assert.ok(result.includes('LLM request failed'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('performSynthesize handles null LLM content gracefully', async () => {
    setupGeminiEnv();
    mockLLMFetch(createLLMResponse(null));

    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', 'some content');
    assert.ok(result.includes('no content'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('performSynthesize returns Markdown from successful LLM call', async () => {
    setupGeminiEnv();
    const markdownResponse = '## Summary\n\n- Point 1\n- Point 2\n';
    mockLLMFetch(createLLMResponse(markdownResponse));

    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', 'some content');
    assert.strictEqual(result, markdownResponse);

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('performSynthesize with optional instructions', async () => {
    setupGeminiEnv();
    let capturedBody: any = null;
    fetchMocker.mock(async (url: any, options: any) => {
      capturedBody = JSON.parse(options?.body as string);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => createLLMResponse('## Summary\nTest result'),
        text: async () => JSON.stringify(createLLMResponse('## Summary\nTest result')),
      } as Response;
    });

    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', 'some content', 'focus on pricing');
    assert.ok(result.includes('Summary'));
    assert.ok(capturedBody !== null);
    const userMsg = capturedBody.messages[1].content;
    assert.ok(userMsg.includes('focus on pricing'));
    assert.ok(userMsg.includes('Additional Instructions'));

    fetchMocker.restore();
    envManager.restore();
  }, results);

  await testFunction('performSynthesize works with mimo provider', async () => {
    setupMimoEnv();
    let capturedBody: any = null;
    fetchMocker.mock(async (url: any, options: any) => {
      capturedBody = JSON.parse(options?.body as string);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => createLLMResponse('## MiMo Summary'),
        text: async () => JSON.stringify(createLLMResponse('## MiMo Summary')),
      } as Response;
    });

    const mockServer = createMockServer();
    const result = await performSynthesize(mockServer as any, 'test query', 'some content');
    assert.strictEqual(result, '## MiMo Summary');
    assert.strictEqual(capturedBody.model, 'mimo-v2-flash');

    fetchMocker.restore();
    envManager.restore();
  }, results);

  printTestSummary(results, 'Synthesize Module');
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };
