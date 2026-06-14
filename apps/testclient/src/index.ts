import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import * as readline from 'readline';
import * as fs from 'fs';

const args = process.argv.slice(2);
const testSend = args.includes('--test-send');
const testSendIdx = args.indexOf('--test-send');
const testDuration = testSend ? parseInt(args[testSendIdx + 1] || '60', 10) : 0;
const outputIdx = args.indexOf('--output');
const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : '';

if (args.length < 1 && !testSend) {
  console.error('Usage:');
  console.error('  testclient <port-path> [baud-rate] [--output <file>]');
  console.error('  testclient <port-path> [baud-rate] --test-send [minutes] [--output <file>]');
  console.error('');
  console.error('Sends sequenced test packets every 100ms to verify no loss/corruption.');
  console.error('Connect test-verify to ws://host:10008/ws/monitor to check results.');
  process.exit(1);
}

const portPath = args[0];
const baudRate = parseInt(args[1] || '19200', 10);

function logOutput(data: string) {
  if (!outputPath) return;
  const ts = new Date().toISOString();
  fs.appendFileSync(outputPath, `[${ts}] ${data}\n`);
}
let hexMode = false;

const UART_HB_TIMEOUT_MS = 10000;

const port = new SerialPort({
  path: portPath,
  baudRate,
  autoOpen: false,
});

const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

let lastRxTime = 0;
let disconnectedNotified = false;

function formatData(data: string): string {
  if (hexMode) {
    return Buffer.from(data, 'utf-8').toString('hex').replace(/(..)/g, '$1 ').trim().toUpperCase();
  }
  return data;
}

function isHeartbeat(data: string): boolean {
  return data === 'HB';
}

port.on('open', () => {
  if (testSend) {
    const totalPackets = testDuration * 60 * 10;
    console.log(`[TestSend] Starting: ${testDuration}min, ${totalPackets} packets @ 100ms`);
    console.log(`[TestSend] Format: S:<seq>:<checksum>`);
    startTestSend(totalPackets);
    return;
  }

  console.log(`[TestClient] Connected to ${portPath} @ ${baudRate} baud`);
  console.log(`[TestClient] Mode: ${hexMode ? 'HEX' : 'TEXT'} (toggle with Ctrl+H)`);
  console.log('[TestClient] Type data and press Enter to send. Ctrl+C to exit.');
  console.log('');
  lastRxTime = Date.now();
  disconnectedNotified = false;
});

function checksum(s: string): string {
  let c = 0;
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}

function startTestSend(totalPackets: number) {
  let sent = 0;
  const startTime = Date.now();

  const timer = setInterval(() => {
    if (sent >= totalPackets) {
      clearInterval(timer);
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`\n[TestSend] Complete: ${sent} packets in ${elapsed.toFixed(1)}s`);
      port.close();
      return;
    }

    const payload = `S:${sent}`;
    const chk = checksum(payload);
    const line = `${payload}:${chk}\r\n`;
    port.write(line, (err) => {
      if (err) console.error(`[TestSend] Write error: ${err.message}`);
    });

    if (sent % 1000 === 0) {
      console.log(`[TestSend] ${sent}/${totalPackets} (${(sent / totalPackets * 100).toFixed(1)}%)`);
    }

    sent++;
  }, 100);
}

parser.on('data', (data: string) => {
  lastRxTime = Date.now();
  disconnectedNotified = false;

  if (isHeartbeat(data)) {
    port.write('HB\r\n');
    return;
  }

  logOutput(data);

  if (testSend) return;

  const line = formatData(data);
  process.stdout.write(`\x1b[32m[RX]\x1b[0m ${line}\n`);
});

port.on('error', (err) => {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${err.message}`);
});

port.on('close', () => {
  console.log('\n[TestClient] Port closed');
  if (!testSend) process.exit(0);
});

port.open((err) => {
  if (err) {
    console.error(`\x1b[31m[ERROR]\x1b[0m Failed to open ${portPath}: ${err.message}`);
    process.exit(1);
  }
});

setInterval(() => {
  const now = Date.now();

  if (lastRxTime > 0 && now - lastRxTime > UART_HB_TIMEOUT_MS && !disconnectedNotified) {
    disconnectedNotified = true;
    console.log(`\x1b[31m[TestClient] Product disconnected (no data for ${UART_HB_TIMEOUT_MS / 1000}s)\x1b[0m`);
    logOutput(`[EVENT] Product disconnected (no data for ${UART_HB_TIMEOUT_MS / 1000}s)`);
  }
}, 1000);

if (!testSend) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36m[TX]\x1b[0m ',
  });

  rl.prompt();

  rl.on('line', (line) => {
    const trimmed = line.trim();

    if (trimmed === '/hex') {
      hexMode = !hexMode;
      console.log(`[TestClient] Mode: ${hexMode ? 'HEX' : 'TEXT'}`);
      rl.prompt();
      return;
    }

    if (trimmed === '/help') {
      console.log('');
      console.log('Commands:');
      console.log('  /hex    Toggle hex/text display mode');
      console.log('  /help   Show this help');
      console.log('  /close  Close the serial port and exit');
      console.log('');
      rl.prompt();
      return;
    }

    if (trimmed === '/close') {
      port.close();
      return;
    }

    if (!trimmed) {
      rl.prompt();
      return;
    }

    let data = trimmed;

    if (hexMode) {
      const hex = trimmed.replace(/\s+/g, '');
      data = Buffer.from(hex, 'hex').toString('utf-8');
      if (!data) {
        console.log('[TestClient] Invalid hex input');
        rl.prompt();
        return;
      }
    }

    port.write(data + '\n', (err) => {
      if (err) {
        console.error(`\x1b[31m[ERROR]\x1b[0m Write failed: ${err.message}`);
      }
    });

    rl.prompt();
  });

  rl.on('SIGINT', () => {
    console.log('\n[TestClient] Closing...');
    port.close();
  });
}

process.on('uncaughtException', (err) => {
  console.error(`\x1b[31m[FATAL]\x1b[0m ${err.message}`);
  process.exit(1);
});
