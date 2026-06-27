# Language support

Remi serves South Africa's **11 official languages** — but the depth differs by
channel, because text and voice have very different provider constraints.

## Text channels (WhatsApp, SMS, email) — all 11 ✅

| | |
|---|---|
| Languages | English, Afrikaans, isiZulu, isiXhosa, Sepedi, Sesotho, Setswana, Xitsonga, siSwati, Tshivenda, isiNdebele |
| How | The LLM auto-detects each incoming message's language and replies in kind. No per-clinic config. |
| Where | `src/lib/languages.ts` (`SA_LANGUAGES`) + the `LANGUAGE` rule in `src/brain/systemPrompt.ts` |

This is the primary, WhatsApp-first surface, and it genuinely covers all 11.

## Voice (phone calls) — 3 languages: English, Afrikaans, isiZulu ✅

Voice needs real-time **STT _and_ TTS** for each language — a much higher bar than
text. The three most-spoken are production-ready (verified against Azure docs);
the long tail has no turnkey real-time speech support yet.

| | |
|---|---|
| Languages | English, Afrikaans, **isiZulu** |
| STT | Azure auto-detect across `en-ZA, af-ZA, zu-ZA` (Azure caps continuous LID at 4 languages) |
| TTS | English → ElevenLabs · Afrikaans → `af-ZA-AdriNeural` · isiZulu → `zu-ZA-ThandoNeural` |
| Where | `src/voice/azureSpeech.ts` (`detectZulu`/`detectAfrikaans`) + `src/routes/mediaStream.ts` |
| Mode | Only the `VOICE_MODE=mediastream` pipeline with `AZURE_SPEECH_KEY` set. The default `gather` mode does not do multi-language auto-detect. |
| Config | `AZURE_STT_LANGUAGES`, `AZURE_VOICE_AF`, `AZURE_VOICE_ZU` |

**To verify before relying on it:** a live isiZulu test call — Azure docs confirm
zu-ZA STT, but did not explicitly list it for *continuous* language identification.

### Why not all 11 in voice (yet)

The major cloud speech providers don't offer production real-time STT/TTS for
isiXhosa, Sesotho, Sepedi, Setswana, siSwati, Tshivenda, Xitsonga or isiNdebele.
Options that exist (Google Chirp/USM for some, Meta MMS, Whisper, SA specialists
like Lelapa AI) are either partial, not real-time, or not yet production-grade.
This will improve — African-language speech AI is moving fast — but adding more
voice languages is a real integration project, not a config change.

**Roadmap:** keep text at 11; add voice languages opportunistically as real-time
STT+TTS coverage matures (isiXhosa is the most likely next, once a provider ships
production support).
