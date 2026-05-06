# Hyprflow Chrome Extension (hyprflow-ce)

AI Browser Automation — directly in your Chrome browser.

## Architecture

```
┌─────────────────────────────┐     HTTP POST (JSON)     ┌──────────────────────┐
│  Chrome Extension           │ ──────────────────────►   │  Laravel API Backend │
│  (Side Panel + Content JS)  │                           │  Port 8001           │
│                             │ ◄──────────────────────   │                      │
│  • Observes DOM elements    │     AI Decision (JSON)    │  • Calls Gemini/     │
│  • Executes click/type/etc  │                           │    OpenAI/Mistral    │
│  • Manages tabs & popups    │                           │  • Returns next      │
│  • Loop/stale detection     │                           │    action as JSON    │
└─────────────────────────────┘                           └──────────────────────┘
```

## Quick Start

### 1. Backend Setup

```bash
# Install PHP dependencies
composer install

# Create .env from template
copy .env.example .env

# Generate app key
php artisan key:generate

# Add your AI API key(s) to .env
# At minimum, set GEMINI_API_KEY or OPENAI_API_KEY

# Start the backend on port 8001
php artisan serve --port=8001
```

### 2. Chrome Extension Setup

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `extension/` folder in this repo
5. The Hyprflow icon appears in your toolbar

### 3. Usage

1. Navigate to any website in Chrome
2. Click the Hyprflow icon → opens the side panel
3. Type a task (e.g., "Fill in the registration form with test data")
4. Click **Run Agent** — the AI will observe the page and execute actions step-by-step

## Project Structure

```
hyprflow-ce/
├── extension/                  # Chrome Extension (load unpacked from here)
│   ├── manifest.json           # MV3 manifest
│   ├── background.js           # Agent loop coordinator (the "brain")
│   ├── content.js              # DOM observer & action executor (the "hands")
│   ├── panel.html/js           # Side panel UI
│   ├── popup.html/js           # Popup UI (fallback)
│   └── icons/                  # Extension icons
├── app/                        # Laravel backend
│   ├── Http/Controllers/
│   │   └── ExtensionController.php   # AI brain endpoint
│   └── Services/
│       └── AiService.php             # Multi-provider AI (Gemini/OpenAI/Mistral)
├── config/                     # Laravel configs (AI providers only)
├── routes/
│   └── api.php                 # POST /api/extension/loop, GET /api/extension/health
├── .env.example                # Environment template
├── composer.json               # PHP dependencies
└── README.md
```

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/extension/health` | Health check — verifies backend & AI config |
| `POST` | `/api/extension/loop` | AI brain — receives page state, returns next action |

## Configuration

All configuration is in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | — | Google Gemini API key |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model name |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model name |
| `MISTRAL_API_KEY` | — | Mistral API key |
| `AUTOMATION_PRIMARY_AI` | `gemini` | Primary AI provider |
| `CURL_SSL_VERIFY_DISABLED` | `true` | Disable SSL verify (dev only) |

## Development

```bash
# Run backend (port 8001)
composer dev

# Or with explicit port
php artisan serve --port=8001

# Check health
curl http://localhost:8001/api/extension/health
```

## Differences from hyprflow-webapp

This repo is a **standalone microservice** extracted from `hyprflow-webapp`:

- ✅ **Port 8001** (webapp uses 8000)
- ✅ **No database** — stateless AI proxy
- ✅ **No authentication** — will be added via API tokens
- ✅ **No Playwright/BrowserService** — the browser IS the extension
- ✅ **No frontend build** — no Vite, no npm, no React
- ✅ **Minimal deps** — Laravel + AI SDKs only
