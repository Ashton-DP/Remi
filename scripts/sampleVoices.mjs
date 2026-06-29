// Synthesizes a sample line across candidate Azure voices → mp3 files you can play.
// Usage: node --env-file=.env scripts/sampleVoices.mjs [en|af|zu]   (default en)
import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.AZURE_SPEECH_KEY;
const REGION = process.env.AZURE_SPEECH_REGION || 'southafricanorth';
if (!KEY) { console.error('Missing AZURE_SPEECH_KEY'); process.exit(1); }

const lang = (process.argv[2] || 'en').toLowerCase();

const SETS = {
  en: {
    locale: 'en-US',
    line: "Good evening, thank you for calling Southern Sun Sandton. This is Remi — I can check availability and book your stay. How may I help you?",
    voices: [
      ['en-ZA-LeahNeural', 'SA accent · female'],
      ['en-ZA-LukeNeural', 'SA accent · male'],
      ['en-GB-AdaMultilingualNeural', 'British · very natural'],
      ['en-US-AvaMultilingualNeural', 'US · most natural'],
      ['en-US-AndrewMultilingualNeural', 'US · most natural · male'],
    ],
  },
  af: {
    locale: 'af-ZA',
    line: "Goeienaand, dankie dat u die Southern Sun Sandton bel. Dit is Remi — ek kan beskikbaarheid nagaan en u verblyf bespreek. Hoe kan ek help?",
    voices: [
      ['af-ZA-AdriNeural', 'native Afrikaans · female'],
      ['af-ZA-WillemNeural', 'native Afrikaans · male'],
      ['en-US-AvaMultilingualNeural', 'multilingual speaking Afrikaans · female'],
      ['en-GB-AdaMultilingualNeural', 'multilingual speaking Afrikaans · female'],
      ['en-US-AndrewMultilingualNeural', 'multilingual speaking Afrikaans · male'],
    ],
  },
  zu: {
    locale: 'zu-ZA',
    line: "Sawubona, ngiyabonga ngokushayela i-Southern Sun Sandton. Lo ngu-Remi — ngingakusiza ngokubhuka indawo yokuhlala. Ngingakusiza kanjani namuhla?",
    voices: [
      ['zu-ZA-ThandoNeural', 'native isiZulu · female'],
      ['zu-ZA-ThembaNeural', 'native isiZulu · male'],
      ['en-US-AvaMultilingualNeural', 'multilingual speaking isiZulu · female'],
    ],
  },
};

const set = SETS[lang];
if (!set) { console.error(`Unknown lang '${lang}'. Use en, af or zu.`); process.exit(1); }

const outDir = path.join(process.cwd(), 'voice-samples');
fs.mkdirSync(outDir, { recursive: true });

async function synth(voice) {
  const ssml = `<speak version='1.0' xml:lang='${set.locale}'><voice name='${voice}'>${set.line}</voice></speak>`;
  const res = await fetch(`https://${REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
      'User-Agent': 'remi-voice-test',
    },
    body: ssml,
  });
  if (!res.ok) { console.log(`✗ ${voice} — HTTP ${res.status}`); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(outDir, `${lang}-${voice}.mp3`), buf);
  console.log(`✓ ${lang}-${voice}.mp3  (${(buf.length / 1024).toFixed(0)} KB)`);
}

console.log(`Synthesizing ${set.voices.length} ${lang.toUpperCase()} voices → ${outDir}\n`);
for (const [v, note] of set.voices) { await synth(v); console.log(`   ${note}`); }
console.log(`\nOpen the folder:  open ${outDir}`);
