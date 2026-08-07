import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SkillConfig, WaiConfig } from "./types.js";

const WAI_DIR = join(homedir(), ".skychat-ai");
const CONFIG_PATH = join(WAI_DIR, "config.json");

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\")
    ? resolve(homedir(), path.slice(2))
    : resolve(path);
}

async function findSkillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findSkillFiles(path, depth + 1));
    } else if (/^skill\.md$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const line = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
  if (!line) return undefined;
  const value = line[1]!.trim();
  if (value === "|" || value === ">") {
    const start = line.index! + line[0].length;
    const block = frontmatter.slice(start).match(/^(?:\r?\n[ \t]+[^\r\n]*)+/)?.[0];
    return block?.replace(/^\r?\n[ \t]+/gm, " ").trim();
  }
  return value.replace(/^["']|["']$/g, "");
}

function frontmatterTriggers(frontmatter: string): string[] {
  const triggers = new Set<string>();
  const inline = frontmatter.match(/^\s*trigger:\s*(.+)$/mi)?.[1];
  if (inline) {
    for (const item of inline.split(/[,，]/)) {
      const trigger = item.trim().replace(/^["']|["']$/g, "");
      if (trigger) triggers.add(trigger);
    }
  }
  const block = frontmatter.match(/^triggers:\s*\r?\n((?:[ \t]+-[^\r\n]*(?:\r?\n|$))+)/mi)?.[1];
  if (block) {
    for (const match of block.matchAll(/^[ \t]+-\s*(.+)$/gm)) {
      const trigger = match[1]!.trim().replace(/^["']|["']$/g, "");
      if (trigger) triggers.add(trigger);
    }
  }
  return [...triggers];
}

async function loadExternalSkills(config: WaiConfig): Promise<void> {
  if (!config.skillDirectories?.length) return;
  const skills = { ...(config.skills || {}) };
  for (const configuredDir of config.skillDirectories) {
    const root = expandHome(configuredDir);
    if (!existsSync(root)) {
      console.warn(`\x1b[33m⚠\x1b[0m 技能目录不存在: ${root}`);
      continue;
    }
    for (const path of (await findSkillFiles(root)).sort()) {
      const content = await readFile(path, "utf8");
      const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)?.[1] || "";
      const fallbackName = basename(dirname(path));
      const name = (frontmatterValue(frontmatter, "slug")
        || frontmatterValue(frontmatter, "name")
        || fallbackName)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-");
      if (!name || skills[name]) continue;
      const description = frontmatterValue(frontmatter, "description")
        || content.match(/^#\s+(.+)$/m)?.[1]
        || fallbackName;
      const triggers = frontmatterTriggers(frontmatter);
      const whenToUse = frontmatterValue(frontmatter, "whenToUse")
        || frontmatterValue(frontmatter, "when-to-use")
        || frontmatterValue(frontmatter, "when_to_use");
      const skillRoot = dirname(path);
      const systemPrompt = [
        `You are using the external skill "${name}".`,
        `Skill root: ${skillRoot}`,
        "Follow the skill instructions below. Resolve every relative file or script path against the skill root.",
        "Use only tools available in the current provider; if a named tool is unavailable, explain that specific limitation.",
        "",
        content,
      ].join("\n");
      skills[name] = {
        description,
        systemPrompt,
        externalPath: path,
        triggers,
        whenToUse,
      } satisfies SkillConfig;
    }
  }
  config.skills = skills;
}

const DEFAULT_CONFIG: WaiConfig = {
  defaultProvider: "qwen",
  providers: {
    claude: {
      type: "claude-agent",
      allowedTools: [
        "Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch",
        "mcp__chrome-mcp-server__get_windows_and_tabs",
        "mcp__chrome-mcp-server__chrome_navigate",
        "mcp__chrome-mcp-server__chrome_javascript",
        "mcp__chrome-mcp-server__chrome_click_element",
        "mcp__chrome-mcp-server__chrome_screenshot",
        "mcp__chrome-mcp-server__chrome_upload_file",
        "mcp__chrome-mcp-server__chrome_handle_dialog",
        "mcp__chrome-mcp-server__chrome_read_page",
        "mcp__chrome-mcp-server__chrome_fill_or_select",
        "mcp__chrome-mcp-server__chrome_keyboard",
        "mcp__chrome-mcp-server__chrome_switch_tab",
        "mcp__chrome-mcp-server__chrome_close_tabs",
        "mcp__chrome-mcp-server__chrome_get_web_content",
      ],
    },
    qwen: {
      type: "claw-agent",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      apiKeyEnv: "DASHSCOPE_API_KEY",
    },
    deepseek: {
      type: "claw-agent",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    gpt: {
      type: "claw-agent",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    gemini: {
      type: "claw-agent",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-2.0-flash",
      apiKeyEnv: "GEMINI_API_KEY",
    },
    minimax: {
      type: "claw-agent",
      baseUrl: "https://api.minimax.chat/v1",
      model: "MiniMax-Text-01",
      apiKeyEnv: "MINIMAX_API_KEY",
    },
    glm: {
      type: "claw-agent",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4-plus",
      apiKeyEnv: "GLM_API_KEY",
    },
    kimi: {
      type: "claw-agent",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "moonshot-v1-8k",
      apiKeyEnv: "MOONSHOT_API_KEY",
    },
    openrouter: {
      type: "claw-agent",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "google/gemini-2.5-flash",
      apiKeyEnv: "OPENROUTER_API_KEY",
    },
  },
  channels: {
    weixin: {
      type: "weixin",
      enabled: true,
    },
    discord: {
      type: "discord",
      enabled: false,
      // token: "your-bot-token",
    },
    whatsapp: {
      type: "whatsapp",
      enabled: false,
    },
    telegram: {
      type: "telegram",
      enabled: false,
      // token: "your-bot-token-from-botfather",
    },
  },
  systemPrompt: "You are a helpful AI assistant. Always reply in the same language the user uses. Respond concisely.",
  chunkSize: 4000,
  skills: {
    translator: {
      description: "中英翻译助手",
      systemPrompt: "You are a professional translator. Translate Chinese to English and English to Chinese. Only output the translation, no explanations.",
    },
    coder: {
      description: "编程助手",
      systemPrompt: "You are a senior software engineer. Help with coding questions. Be concise and provide code examples.",
    },
    writer: {
      description: "写作助手",
      systemPrompt: "You are a skilled writer. Help with writing, editing, and polishing text. Match the user's language.",
    },
  },
};

export async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export async function loadConfig(): Promise<WaiConfig> {
  await ensureDir(WAI_DIR);

  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }

  const raw = await readFile(CONFIG_PATH, "utf-8");
  const user = JSON.parse(raw) as Partial<WaiConfig>;

  // Deep merge: default providers + user providers (user overrides per provider)
  const providers = { ...DEFAULT_CONFIG.providers };
  if (user.providers) {
    for (const [key, val] of Object.entries(user.providers)) {
      providers[key] = val;
    }
  }

  const config = { ...DEFAULT_CONFIG, ...user, providers } as WaiConfig;
  await loadExternalSkills(config);

  // Migrate: zhipu → glm
  if (config.providers.zhipu) {
    if (!config.providers.glm) {
      config.providers.glm = { ...config.providers.zhipu, apiKeyEnv: "GLM_API_KEY" };
    }
    delete config.providers.zhipu;
    if (config.defaultProvider === "zhipu") config.defaultProvider = "glm";
    await saveConfig(config);
  }

  return config;
}

export async function saveConfig(config: WaiConfig): Promise<void> {
  await ensureDir(WAI_DIR);
  const persisted = { ...config };
  if (persisted.skills) {
    persisted.skills = Object.fromEntries(
      Object.entries(persisted.skills)
        .filter(([, skill]) => !skill.externalPath)
        .map(([name, skill]) => [name, { ...skill, externalPath: undefined }]),
    );
  }
  await writeFile(CONFIG_PATH, JSON.stringify(persisted, null, 2));
}

export function getDataDir(): string {
  return WAI_DIR;
}

export function getAccountsDir(): string {
  return join(WAI_DIR, "accounts");
}
