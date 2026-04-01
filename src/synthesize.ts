import OpenAI from "openai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logMessage } from "./logging.js";

export type SynthesizeProvider = "gemini" | "mimo";

const SYSTEM_PROMPT =
  "You synthesize search results into clean, well-structured Markdown summaries. " +
  "Be concise, factual, and organized. Use headers, bullet points, and tables where appropriate. " +
  "Do not add information not present in the source material. " +
  "If the results are insufficient to answer the query, say so.";

interface ProviderConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  defaultParams: Record<string, unknown>;
}

export function getProviderConfig(provider: SynthesizeProvider): ProviderConfig {
  if (provider === "mimo") {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) {
      throw new Error(
        "MIMO_API_KEY not set. Set it to your Xiaomi MiMo API key to use the mimo synthesis provider."
      );
    }
    return {
      apiKey,
      baseURL: "https://api.xiaomimimo.com/v1",
      model: "mimo-v2-flash",
      defaultParams: {
        max_completion_tokens: 2048,
        temperature: 0.5,
      },
    };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY not set. Set it to your Google Gemini API key to use the gemini synthesis provider."
    );
  }
  return {
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-2.5-flash-lite",
    defaultParams: {
      max_completion_tokens: 4096,
    },
  };
}

export function resolveProvider(): SynthesizeProvider {
  const raw = process.env.SYNTHESIZE_PROVIDER?.trim().toLowerCase();
  if (!raw || raw === "gemini") return "gemini";
  if (raw === "mimo") return "mimo";
  throw new Error(
    `Invalid SYNTHESIZE_PROVIDER: "${process.env.SYNTHESIZE_PROVIDER}". Must be "gemini" or "mimo".`
  );
}

export function validateSynthesizeConfig(): string | null {
  try {
    const provider = resolveProvider();
    getProviderConfig(provider);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function buildUserMessage(query: string, results: string, instructions?: string): string {
  let message = `## Query\n${query}\n\n## Source Material\n${results}`;
  if (instructions?.trim()) {
    message += `\n\n## Additional Instructions\n${instructions.trim()}`;
  }
  return message;
}

export async function performSynthesize(
  mcpServer: McpServer,
  query: string,
  results: string,
  instructions?: string
): Promise<string> {
  const startTime = Date.now();

  logMessage(mcpServer, "info", `Starting synthesis for query: "${query}"`);

  if (!results?.trim()) {
    return "No results to synthesize.";
  }

  let provider: SynthesizeProvider;
  let config: ProviderConfig;
  try {
    provider = resolveProvider();
    config = getProviderConfig(provider);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logMessage(mcpServer, "error", `Synthesis config error: ${msg}`);
    return `Synthesis error: ${msg}`;
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  const userMessage = buildUserMessage(query, results, instructions);

  try {
    const completion = await client.chat.completions.create({
      model: config.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      ...config.defaultParams,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (!content) {
      logMessage(mcpServer, "warning", "Synthesis returned empty content");
      return "Synthesis returned no content. The source material may be insufficient or too large.";
    }

    const duration = Date.now() - startTime;
    logMessage(mcpServer, "info", `Synthesis completed: "${query}" (${provider}) in ${duration}ms`);

    return content;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logMessage(mcpServer, "error", `Synthesis LLM error: ${msg}`, { provider, query });
    return `Synthesis error: LLM request failed — ${msg}`;
  }
}
