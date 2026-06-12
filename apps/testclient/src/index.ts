import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import * as readline from 'readline';

const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Usage: testclient <port-path> [baud-rate]');
  console.error('');
  console.error('Connects to a serial device and relays data bidirectionally.');
  console.error('Type input and press Enter to send data to the device.');
  console.error('Data received from the device is printed to stdout.');
  console.error('');
  console.error('Examples:');
  console.error('  testclient /tmp/vuart-1-device');
  console.error('  testclient /tmp/vuart-1-device 115200');
  process.exit(1);
}

const portPath = args[0];
const baudRate = parseInt(args[1] || '115200', 10);
let hexMode = false;

const port = new SerialPort({
  path: portPath,
  baudRate,
  autoOpen: false,
});

const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

function formatData(data: string): string {
  if (hexMode) {
    return Buffer.from(data, 'utf-8').toString('hex').replace(/(..)/g, '$1 ').trim().toUpperCase();
  }
  return data;
}

port.on('open', () => {
  console.log(`[TestClient] Connected to ${portPath} @ ${baudRate} baud`);
  console.log(`[TestClient] Mode: ${hexMode ? 'HEX' : 'TEXT'} (toggle with Ctrl+H)`);
  console.log('[TestClient] Type data and press Enter to send. Ctrl+C to exit.');
  console.log('');
});

parser.on('data', (data: string) => {
  const line = formatData(data);
  process.stdout.write(`\x1b[32m[RX]\x1b[0m ${line}\n`);
});

port.on('error', (err) => {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${err.message}`);
});

port.on('close', () => {
  console.log('\n[TestClient] Port closed');
  process.exit(0);
});

port.open((err) => {
  if (err) {
    console.error(`\x1b[31m[ERROR]\x1b[0m Failed to open ${portPath}: ${err.message}`);
    process.exit(1);
  }
});

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

process.on('uncaughtException', (err) => {
  console.error(`\x1b[31m[FATAL]\x1b[0m ${err.message}`);
  process.exit(1);
});
