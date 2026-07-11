// Display-name censor. Normalizes the usual evasion tricks (leetspeak,
// spacing/punctuation, letter stretching) and rejects names containing a
// banned substring. Deliberately not trying to be perfect — the cost of a
// false positive is just falling back to the default name, so the list
// leans aggressive but skips fragments that hit common innocent words
// ("ass" in grass, "cum" in cucumber).
const LEET = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't',
  '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i', '+': 't', '(': 'c',
  '|': 'i', '¡': 'i', '€': 'e', '£': 'l',
};

const BANNED = [
  'fuck', 'shit', 'bitch', 'cunt', 'twat', 'whore', 'slut', 'pussy',
  'penis', 'vagina', 'dick', 'cock', 'boob', 'tits', 'dildo', 'anal',
  'sex', 'porn', 'hentai', 'blowjob', 'handjob', 'wank', 'jizz', 'semen',
  'orgasm', 'rape', 'rapist', 'molest', 'pedo',
  'nigger', 'nigga', 'faggot', 'fag', 'kike', 'chink', 'tranny', 'retard',
  'nazi', 'hitler',
];

// leet-map each char, keep letters only — "F.u_c-K 1" -> "fucki"
function normalize(name) {
  let out = '';
  for (const ch of name.toLowerCase()) {
    const c = LEET[ch] ?? ch;
    if (c >= 'a' && c <= 'z') out += c;
  }
  return out;
}

// returns the name if acceptable, or null if it should be replaced
export function censorName(name) {
  const flat = normalize(name);
  const squeezed = flat.replace(/(.)\1+/g, '$1'); // "fuuuck" -> "fuck"
  for (const word of BANNED) {
    if (flat.includes(word) || squeezed.includes(word)) return null;
  }
  return name;
}
