/**
 * Location Extractor — pull self-reported location from free text (profile bio,
 * repo READMEs/descriptions). Three tiers, combined for precision + recall:
 *
 *   1. MARKERS (high)   — explicit cues ("📍", "Based in", flag emoji, "Location:",
 *                          resume "Address:") tell us WHERE to look; compromise then
 *                          confirms WHAT the place is.
 *   2. FLAG EMOJI (high)— 🇩🇪 etc. decoded to a country via Intl.DisplayNames.
 *   3. NER (medium/low) — compromise's place lexicon (#City / #Country) catches
 *                          unlabeled mentions. Country = medium; bare city = low
 *                          (could be travel/infra context, so it's flagged low).
 *
 * Returns discovered locations with method + confidence; the caller attaches the
 * source URL. compromise's built-in place lexicon serves as the gazetteer, so no
 * extra dataset is bundled.
 */

const nlp = require('compromise');

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    return null;
  }
})();

// Cues that precede a self-reported location. (Deliberately NOT a bare "from" — too noisy.)
const MARKER_RE =
  /(?:📍|🌍|🌎|🌏|📌|🏡|🏠|🗺️?|based\s+(?:in|out\s+of)|located\s+in|i\s+live\s+in|living\s+in|lives?\s+in|location\s*[:\-=]+|home\s*town\s*[:\-=]*|address\s*[:\-=]+|city\s*[:\-=]+|currently\s+(?:in|living\s+in)|hailing\s+from|originally\s+from)\s*[:\-]?\s*([^\n\r;|·•<>()[\]{}]{2,60})/gi;

const RANK = { high: 3, medium: 2, low: 1 };

function clean(s) {
  return String(s || '')
    .replace(/^[\s.,;:!?(){}[\]<>'"`*_-]+/, '') // strip leading punctuation/brackets
    .replace(/[\s.,;:!?(){}[\]<>'"`*_-]+$/, '') // strip trailing
    .replace(/\s+/g, ' ')
    .trim();
}

// Chars of each text block fed to NLP / codepoint scans. 0 = NO cap — the FULL README is
// passed through NLP (the default). On tiny hosts where a huge README's NLP pass blocks the
// event loop / delays heartbeats, set LOCATION_NLP_MAX_CHARS to bound it.
const NLP_CAP = parseInt(process.env.LOCATION_NLP_MAX_CHARS || '0', 10);
const capForNlp = (text) => (NLP_CAP > 0 && text.length > NLP_CAP ? text.slice(0, NLP_CAP) : text);

/** Decode any flag emojis in a string into country names. Bounded (no full-string spread). */
function flagsToCountries(text) {
  const out = [];
  if (!regionNames) return out;
  const len = NLP_CAP > 0 ? Math.min(text.length, NLP_CAP) : text.length;
  for (let i = 0; i + 1 < len; i += 1) {
    const a = text.codePointAt(i);
    if (a >= 0x1f1e6 && a <= 0x1f1ff) {
      const next = i + (a > 0xffff ? 2 : 1);
      const b = text.codePointAt(next);
      if (b >= 0x1f1e6 && b <= 0x1f1ff) {
        const code = String.fromCharCode(65 + (a - 0x1f1e6)) + String.fromCharCode(65 + (b - 0x1f1e6));
        try {
          const name = regionNames.of(code);
          if (name && name !== code) out.push(name);
        } catch {
          /* invalid pair */
        }
        i = next + (b > 0xffff ? 2 : 1) - 1; // -1 because the for-loop adds 1
      }
    }
  }
  return out;
}

/** Split a place value into city/country coherently — derived from the value ITSELF only. */
function classify(value) {
  if (value.includes(',')) {
    const parts = value.split(',').map(clean).filter(Boolean);
    return { city: parts[0] || null, country: parts[1] || null };
  }
  return nlp(value).has('#Country') ? { city: null, country: value } : { city: value, country: null };
}

/**
 * Find the place in a short phrase and derive city/country from THAT place only (so the
 * fields stay coherent). `tagged` is true only when compromise recognized a real place token
 * (#City/#Country) — used to reject non-place fragments like a street "123 Main St".
 */
function placeOf(phrase) {
  const doc = nlp(phrase);
  const places = doc.places().out('array').map(clean).filter(Boolean);
  if (!places.length) return null;
  const value = places[0];
  const tagged = doc.has('#City') || doc.has('#Country');
  return { value, ...classify(value), tagged };
}

/**
 * Extract candidate locations from one block of text.
 * @returns {Array<{value, city, country, method, confidence}>}
 */
function extractLocations(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Map(); // normalized value → entry

  const add = (entry) => {
    if (!entry || !entry.value) return;
    const value = clean(entry.value);
    if (value.length < 2 || value.length > 60) return;
    const key = value.toLowerCase();
    const prev = found.get(key);
    if (!prev || RANK[entry.confidence] > RANK[prev.confidence]) {
      found.set(key, { ...entry, value });
    }
  };

  // Tier 1: markers → confirm the place with compromise. Only emit when a real place token
  // was recognized (tagged), so street/junk after "Address:" isn't taken as a location.
  let m;
  MARKER_RE.lastIndex = 0;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const place = placeOf(m[1]);
    if (place && place.tagged) {
      add({ value: place.value, city: place.city, country: place.country, method: 'marker', confidence: 'high' });
    }
  }

  // Tier 2: flag emojis → country.
  for (const country of flagsToCountries(text)) {
    add({ value: country, city: null, country, method: 'flag', confidence: 'high' });
  }

  // Tier 3: NER over the FULL text (the entire README), unless LOCATION_NLP_MAX_CHARS caps it.
  // Iterate whole place spans (keeps multi-word cities like "San Francisco" intact instead of
  // splitting into tokens), keep only recognized places, and classify: a pure country is
  // medium, a city (or city,country) is low/noise.
  const doc = nlp(capForNlp(text));
  for (const raw of doc.places().out('array')) {
    const value = clean(raw);
    if (!value) continue;
    const vd = nlp(value);
    const isCountry = vd.has('#Country');
    const isCity = vd.has('#City');
    if (!isCountry && !isCity && !value.includes(',')) continue; // skip non-place junk
    const { city, country } = classify(value);
    add({ value, city, country, method: 'ner', confidence: isCountry && !isCity ? 'medium' : 'low' });
  }

  return [...found.values()];
}

/**
 * Build the User.locationInfo object from the same {text, source} list that contact
 * discovery already gathers, plus the profile location.
 * @returns {{ profile: string|null, discovered: Array, best: string|null }}
 */
function buildLocationInfo(sources, profileLocation) {
  const map = new Map(); // normalized value → { value, city, country, method, confidence, sources:Set }
  for (const { text, source } of sources) {
    for (const loc of extractLocations(text)) {
      const key = loc.value.toLowerCase();
      const ex = map.get(key);
      if (ex) {
        ex.sources.add(source);
        if (RANK[loc.confidence] > RANK[ex.confidence]) {
          ex.confidence = loc.confidence;
          ex.method = loc.method;
        }
        ex.city = ex.city || loc.city;
        ex.country = ex.country || loc.country;
      } else {
        map.set(key, { ...loc, sources: new Set([source]) });
      }
    }
  }

  const ranked = [...map.values()]
    .map((d) => ({
      value: d.value,
      city: d.city || null,
      country: d.country || null,
      method: d.method,
      confidence: d.confidence,
      sources: [...d.sources],
    }))
    // Confidence first; then LONGEST value first so "Berlin, Germany" is considered before
    // its fragments "Berlin"/"Germany" regardless of source order (order-independent dedup).
    .sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || b.value.length - a.value.length);

  // Drop entries that are just a token-fragment of a stronger one (e.g. "Berlin" / "Germany"
  // when "Berlin, Germany" was already captured at higher confidence). Regex-free, so a value
  // containing regex metacharacters can't break it.
  const tokens = (s) => ` ${s.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const discovered = [];
  for (const d of ranked) {
    const dv = tokens(d.value);
    const isFragment = discovered.some((k) => {
      const kv = tokens(k.value);
      return kv !== dv && kv.includes(dv);
    });
    if (!isFragment) discovered.push(d);
  }

  const profile = profileLocation && profileLocation.trim() ? profileLocation.trim() : null;
  const best = profile || (discovered[0] ? discovered[0].value : null);

  return { profile, discovered, best };
}

module.exports = { extractLocations, buildLocationInfo, flagsToCountries };
