/**
 * test-verify: Test sequence verifier for Nexio long-term test
 *
 * Connects to server WS monitor endpoint and checks for packet loss/corruption
 * from testclient --test-send mode.
 *
 * Usage:
 *   tsx tools/test-verify.ts <ws-url> [duration_minutes]
 *
 * Examples:
 *   tsx tools/test-verify.ts ws://192.168.0.9:10008/ws/monitor 60
 *   tsx tools/test-verify.ts ws://localhost:10008/ws/monitor 10
 */

const url = process.argv[2];
const durationMin = parseInt(process.argv[3] || '60', 10);

if (!url) {
  console.error('Usage: tsx tools/test-verify.ts <ws-url> [duration_minutes]');
  console.error('');
  console.error('Connects to Nexio server monitor WS and verifies test sequence integrity.');
  console.error('Run alongside: testclient <port> --test-send <minutes>');
  process.exit(1);
}

type SeqEntry = {
  seq: number;
  chk: string;
  expectedChk: string;
  ok: boolean;
  time: number;
};

const received = new Map<number, SeqEntry>();
let totalReceived = 0;
let corrupted = 0;
let maxSeq = -1;
let minSeq = Infinity;
let startTime = 0;
let lastLogTime = 0;

function checksum(s: string): string {
  let c = 0;
  for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}

function parseTestPacket(payload: string): { seq: number; chk: string } | null {
  const prefix = 'S:';
  if (!payload.startsWith(prefix)) return null;

  const rest = payload.slice(2);
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx < 0) return null;

  const seqStr = rest.slice(0, colonIdx);
  const chk = rest.slice(colonIdx + 1);
  const seq = parseInt(seqStr, 10);

  if (isNaN(seq)) return null;

  return { seq, chk };
}

function reportStats(final: boolean) {
  const now = Date.now();
  const elapsed = ((now - startTime) / 1000).toFixed(1);
  const expectedTotal = maxSeq + 1;

  let missing: number[] = [];
  if (expectedTotal > 0) {
    for (let i = 0; i <= maxSeq; i++) {
      if (!received.has(i)) missing.push(i);
    }
  }

  const line = `[Verify] ${final ? 'FINAL' : 'Live'}: ${elapsed}s | ` +
    `rx=${totalReceived} | exp=${expectedTotal} | ` +
    `missing=${missing.length} | corrupt=${corrupted} | ` +
    `seq_range=[${minSeq}-${maxSeq}]`;

  console.log(line);

  if (final && missing.length > 0) {
    console.log(`[Verify] Missing sequences: ${missing.length} total`);

    // Show condensed gap report
    const gaps: { from: number; to: number }[] = [];
    let gapStart = missing[0];
    let prev = missing[0];
    for (let i = 1; i < missing.length; i++) {
      if (missing[i] !== prev + 1) {
        gaps.push({ from: gapStart, to: prev });
        gapStart = missing[i];
      }
      prev = missing[i];
    }
    gaps.push({ from: gapStart, to: prev });

    for (const g of gaps) {
      const count = g.to - g.from + 1;
      if (count === 1) {
        console.log(`  Seq ${g.from}`);
      } else {
        console.log(`  Seq ${g.from}-${g.to} (${count} packets)`);
      }
    }
  }
}

async function main() {
  const ws = new WebSocket(url);

  ws.onopen = () => {
    startTime = Date.now();
    lastLogTime = startTime;
    console.log(`[Verify] Connected to ${url}`);
    console.log(`[Verify] Monitoring for ${durationMin} minutes...`);
    console.log('');
  };

  ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data as string);
      if (msg.type !== 'DATA_RELAY' || !msg.payload) return;

      // Monitor receives raw hex payload
      const hex = msg.payload as string;
      if (!/^[0-9A-Fa-f]+$/.test(hex)) return;

      const raw = Buffer.from(hex, 'hex').toString('utf-8').replace(/\r?\n$/, '');

      const parsed = parseTestPacket(raw);
      if (!parsed) return;

      const { seq, chk } = parsed;
      const expectedChk = checksum(`S:${seq}`);

      totalReceived++;

      if (seq > maxSeq) maxSeq = seq;
      if (seq < minSeq) minSeq = seq;

      const ok = chk === expectedChk;
      if (!ok) corrupted++;

      received.set(seq, { seq, chk, expectedChk, ok, time: Date.now() });

      // Log progress every 30s
      const now = Date.now();
      if (now - lastLogTime > 30000) {
        reportStats(false);
        lastLogTime = now;
      }
    } catch {
      // ignore parse errors
    }
  };

  ws.onerror = (err: Event) => {
    console.error(`[Verify] WS Error:`, err);
  };

  ws.onclose = () => {
    console.log('');
    reportStats(true);
    process.exit(0);
  };

  // Auto-stop after duration
  setTimeout(() => {
    console.log(`\n[Verify] ${durationMin}min elapsed, closing...`);
    ws.close();
  }, durationMin * 60 * 1000);

  // Handle Ctrl+C
  process.on('SIGINT', () => {
    console.log('\n[Verify] Interrupted, reporting...');
    ws.close();
  });
}

main().catch(console.error);
