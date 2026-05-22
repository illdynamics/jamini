# Jamini Quickstart

Get up and running with Jamini in under a minute.

## 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/illdynamics/jamini/main/scripts/install.sh | bash
```

This downloads the latest release, builds the container image, installs `@google/gemini-cli` globally, and puts the `jamini` command in `~/bin/jamini`.

Or from source:

```bash
git clone https://github.com/illdynamics/jamini.git
cd jamini
npm install && cd bridge && npm install && cd ..
npm run build
./jamini install
```

## 2. Set Your DeepSeek API Key

```bash
export DEEPSEEK_API_KEY="sk-..."
```

That's it. No Google login. No Gemini API key. No Vertex setup.

## 3. Add to PATH

```bash
export PATH="${HOME}/bin:${PATH}"
```

Add that line to `~/.zshrc` or `~/.bashrc` to make it permanent.

## 4. Run Instead of `gemini`

```bash
# Interactive mode
jamini

# Quick prompt
jamini "explain this codebase"

# Choose a model
jamini -m v4-flash "quick question"
jamini -m v4-flash-thinking "think through this bug"
jamini -m v4-pro "refactor this file"
jamini -m v4-pro-thinking "design the new API"

# YOLO mode (auto-approve all tool actions)
jamini -y -m v4-pro-thinking "run tests and fix failures"
```

## Models

| Model | Description |
|-------|-------------|
| `v4-flash` | Fast DeepSeek V4 Flash, thinking off |
| `v4-flash-thinking` | DeepSeek V4 Flash with reasoning |
| `v4-pro` | Stronger DeepSeek V4 Pro, thinking off |
| `v4-pro-thinking` | DeepSeek V4 Pro with deep reasoning |

## How It Works

```
jamini → starts local bridge → spawns gemini CLI → Gemini CLI talks to bridge → bridge talks to DeepSeek
```

The Gemini CLI source is never modified. Jamini wraps it with environment variables and a local HTTP translation bridge.

## Next Steps

- Full docs: [`README.md`](./README.md)
- Architecture: [`docs/architecture.md`](./docs/architecture.md)
- Troubleshooting: [`docs/troubleshooting.md`](./docs/troubleshooting.md)
