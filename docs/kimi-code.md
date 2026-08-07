# Kimi Code with persistent local memory

SkyChat can use the Kimi Code OpenAI-compatible endpoint through its `kimi`
provider. Agent file and command tools use `memoryDir` as their working
directory, so memory survives process restarts.

## Configuration

Add or update these fields in `~/.skychat-ai/config.json`:

```json
{
  "defaultProvider": "kimi",
  "memoryDir": "D:\\KimiSpace\\memory",
  "providers": {
    "kimi": {
      "type": "claw-agent",
      "baseUrl": "https://api.kimi.com/coding/v1",
      "model": "kimi-for-coding",
      "credentialFile": "~/.kimi-code/credentials/kimi-code.json",
      "credentialField": "access_token",
      "authRefreshCommand": "~/.kimi-code/bin/kimi.exe",
      "authRefreshArgs": ["--prompt", "Reply with OK only."],
      "maxAuthRetries": 3
    }
  }
}
```

On a 401 authentication response, SkyChat runs the configured refresh command,
reloads `access_token`, and retries up to three times. Do not commit access
tokens or files from `~/.kimi-code/credentials`.

For persistent memory behavior, customize `systemPrompt` to tell the agent
which Markdown files to read and when it should update them. Tool operations
run with the permissions of the operating-system user that launched SkyChat;
they do not bypass Windows UAC.

Example:

```json
{
  "systemPrompt": "You are a local assistant with real file tools. Read MEMORY.md when it is relevant. When the owner asks you to remember something, write it to MEMORY.md and only confirm after the write succeeds."
}
```

Restart SkyChat after changing its configuration.
