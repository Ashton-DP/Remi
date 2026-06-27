/**
 * South Africa's 11 official languages. Remi auto-detects the language of each
 * incoming message and replies in that same language — no per-clinic config
 * needed. Shared by the system prompt (and available for future UI/config).
 */
export const SA_LANGUAGES: { code: string; name: string; native: string }[] = [
  { code: 'en',  name: 'English',     native: 'English' },
  { code: 'af',  name: 'Afrikaans',   native: 'Afrikaans' },
  { code: 'zu',  name: 'isiZulu',     native: 'isiZulu' },
  { code: 'xh',  name: 'isiXhosa',    native: 'isiXhosa' },
  { code: 'nso', name: 'Sepedi',      native: 'Sepedi' },
  { code: 'st',  name: 'Sesotho',     native: 'Sesotho' },
  { code: 'tn',  name: 'Setswana',    native: 'Setswana' },
  { code: 'ts',  name: 'Xitsonga',    native: 'Xitsonga' },
  { code: 'ss',  name: 'siSwati',     native: 'siSwati' },
  { code: 've',  name: 'Tshivenda',   native: 'Tshivenḓa' },
  { code: 'nr',  name: 'isiNdebele',  native: 'isiNdebele' },
];

/** "English, Afrikaans, isiZulu, …" — for prompts and copy. */
export const SA_LANGUAGE_NAMES = SA_LANGUAGES.map((l) => l.name).join(', ');
