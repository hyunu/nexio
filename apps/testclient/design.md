# TestClient — Serial test utility

Lightweight Node.js CLI program to connect to a serial port, send user input, and display incoming lines. Useful for testing device UART or virtual UART pairs.

Overview
- Entry: `node ./dist/index.js <port-path> [baud-rate]` (package.json `bin` exposes `testclient`)
- Default baud rate: 19200
- Line-oriented: uses `ReadlineParser({ delimiter: '\r\n' })`
- Heartbeat: sends `HB\r\n` when idle and monitors incoming activity
- Display modes: TEXT (default) and HEX (`/hex` toggle)

Features
- Read lines from serial and print to stdout with `[RX]` tag
- Read user input from stdin and write newline-terminated strings to serial
- Toggle HEX display/input: `/hex` switches display; in HEX mode user can type hex bytes separated by spaces (or continuous) and they are converted to bytes before sending
- `/close` closes the port and exits
- Idle heartbeat: when no RX for `UART_HB_IDLE_MS` (2000ms) and last HB older than `UART_HB_INTERVAL_MS` (1000ms), sends `HB\r\n`
- Disconnect detection: if no RX for `UART_HB_TIMEOUT_MS` (10000ms), prints disconnected notice

Configuration / Constants
- `UART_HB_IDLE_MS = 2000`
- `UART_HB_INTERVAL_MS = 1000`
- `UART_HB_TIMEOUT_MS = 10000`
- Parser delimiter: `\r\n`
- Default prompt: `[TX] `

Commands (stdin)
- `/hex` — toggle HEX mode
- `/help` — show help
- `/close` — close port and exit

Input handling
- In TEXT mode: typed line (trimmed) is written with `\n` appended
- In HEX mode: typed hex string (spaces optional) is parsed and converted to bytes; invalid hex prints error

Notes for integration
- Use this tool to emulate product UART for development, or to connect to virtual UART devices created by the desktop apps
- Matches firmware expectations: uses newline-terminated JSON/config lines and HB `HB\r\n` messages

