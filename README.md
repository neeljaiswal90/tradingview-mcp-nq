# TradingView MCP Server

AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol.

> **Disclaimer:** Unofficial tool. Not affiliated with TradingView Inc. or Anthropic, PBC. Ensure your usage complies with TradingView's [Terms of Use](https://www.tradingview.com/policies/).

## Features

- **78 MCP tools** for reading and controlling a live TradingView Desktop chart
- **Full CLI** with 30 commands and 66 subcommands
- **Pine Script development**: read/write source, compile, analyze, error checking
- **Chart control**: symbol, timeframe, chart type, indicators, drawings
- **Data access**: OHLCV bars, quotes, indicator values, strategy results
- **Pine graphics**: read line.new, label.new, table.new, box.new outputs
- **Replay mode**: start, step, autoplay, paper trading
- **UI automation**: click, hover, scroll, keyboard, panel management
- **Multi-chart**: pane layouts, tab management, batch operations
- **Screenshots**: full page, chart region, strategy tester
- **Streaming**: real-time JSONL output for quotes, bars, indicators

## Quick Start

```bash
# 1. Launch TradingView Desktop with CDP
#    Windows: scripts\launch_tv_debug.bat
#    macOS:   bash scripts/launch_tv_debug_mac.sh
#    Linux:   bash scripts/launch_tv_debug_linux.sh

# 2. Build
npm install
npm run build

# 3. Use as MCP server (add to your client config)
node dist/server.js

# 4. Or use the CLI
npx tv status
npx tv symbol AAPL
npx tv pine get
```

See [SETUP_GUIDE.md](SETUP_GUIDE.md) for detailed instructions.

## Architecture

```
src/
├── config.ts                  # Environment-based configuration
├── logger.ts                  # Stderr structured logger
├── result.ts                  # Result<T> discriminated union
├── server.ts                  # MCP server entry point
├── core/
│   ├── cdp/
│   │   ├── connection.ts      # CDP connect with retry
│   │   ├── evaluate.ts        # evaluate(), safeString(), requireFinite()
│   │   └── targets.ts         # Target discovery via /json/list
│   ├── session/
│   │   └── manager.ts         # Singleton session with liveness probe
│   └── tradingview/
│       ├── index.ts           # Barrel export
│       ├── known-paths.ts     # TradingView internal API paths
│       ├── wait.ts            # Chart ready detection
│       ├── health.ts          # Health check, discovery, launch
│       ├── chart.ts           # Symbol, timeframe, indicators, ranges
│       ├── data.ts            # OHLCV, quotes, study values, Pine graphics
│       ├── pine.ts            # Pine Script editor and compilation
│       ├── capture.ts         # Screenshots
│       ├── drawing.ts         # Shape drawing
│       ├── alerts.ts          # Alert management
│       ├── replay.ts          # Bar replay mode
│       ├── indicators.ts      # Indicator settings
│       ├── watchlist.ts       # Watchlist management
│       ├── pane.ts            # Multi-chart pane layouts
│       ├── tab.ts             # Tab management
│       ├── ui.ts              # UI automation + layout management
│       ├── batch.ts           # Batch operations
│       └── stream.ts          # Real-time streaming
├── tools/                     # MCP tool registrations (14 modules)
└── cli/                       # CLI with router + 15 command modules
```

## Testing

```bash
npm test                  # All tests
npm run test:unit         # Unit tests only
npm run test:smoke        # Smoke tests only
npm run test:integration  # Integration tests (requires TradingView)
```

## License

See the reference project for license terms.
