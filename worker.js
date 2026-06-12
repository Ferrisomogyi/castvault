/* ============================================================
   CastVault AI-proxy — Cloudflare Worker (v0.6)

   v0.6: bio-prompt verhard tegen hallucinatie (verzin-nooit-regels,
   verwisselings-check, geboortejaar-context) + temperature 0.
   HERDEPLOYEN NODIG: plak deze hele file opnieuw in de Worker-editor.

   LET OP: dit bestand hoort NIET op GitHub Pages. Het draait op
   Cloudflare en is de enige plek waar de Anthropic API-key leeft.

   Deployen (eenmalig, ±5 min):
   1. dash.cloudflare.com → Workers & Pages → Create Worker
      naam: castvault  →  URL wordt castvault.ferencsomogyi.workers.dev
   2. Plak deze hele file in de editor → Deploy.
   3. Settings → Variables → Add secret:  ANTHROPIC_API_KEY = sk-ant-…
      (als SECRET, niet als plain variable!)
   4. Klaar. De app praat er automatisch tegen (WORKER_URL in app.js).

   Veiligheid:
   - CORS: alleen jouw GitHub Pages origin (+ localhost voor dev).
   - Alleen POST met {task: 'bio'|'tv', naam}.
   - Naam wordt afgekapt op 120 tekens; geen andere user-input
     bereikt het prompt.
   ============================================================ */

const ALLOWED_ORIGINS = [
  'https://ferrisomogyi.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];
const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1200;

function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...corsHeaders(origin), 'Content-Type': 'application/json' },
  });
}

/* Pak het eerste JSON-object uit Claude's antwoord (robuust tegen
   eventuele tekst eromheen). */
function extractJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

function bioPrompt(naam, geboortejaar) {
  return `Je bent een feitelijke assistent voor een Nederlandse casting-database.
Schrijf een korte zakelijke biografie (maximaal 100 woorden, in het Nederlands) van de publieke persoon "${naam}"${geboortejaar ? ` (geboren ${geboortejaar})` : ''}.
Regels — heel belangrijk:
- Alleen feiten die je met grote zekerheid weet uit meerdere bronnen. Twijfel je over ook maar één feit (nationaliteit, opleiding, programma, jaartal)? Laat dat feit dan WEG.
- Verzin NOOIT iets en vul NOOIT aan met "waarschijnlijke" details. Een korte bio van 2 zinnen met alleen zekere feiten is veel beter dan een volle bio met fouten.
- Verwar deze persoon niet met iemand anders met een gelijkende naam. Bestaan er meerdere publieke personen met deze naam, of weet je niet zeker over wie het gaat? Antwoord dan {"onbekend": true}.
- Ken je deze persoon alleen vaag (naam komt bekend voor, maar je weet geen geverifieerde feiten)? Antwoord dan ook {"onbekend": true}. Beter géén bio dan een verzonnen bio.
- Geen speculatie, geen privégegevens.
Ken je deze persoon niet met grote zekerheid, of is de naam ambigu? Antwoord dan met exact dit JSON en niets anders: {"onbekend": true}
Anders antwoord je met exact dit JSON-formaat en niets anders: {"bio": "..."}`;
}

function tvPrompt(naam, geboortejaar) {
  return `Je bent een feitelijke assistent voor een Nederlandse casting-database.
Geef de tv-programma's en rollen van de publieke persoon "${naam}"${geboortejaar ? ` (geboren ${geboortejaar})` : ''}.
Antwoord met uitsluitend dit JSON-formaat en niets anders:
{"items": [{"titel": "...", "jaar": "...", "rol": "...", "zender": "...", "zeker": true}], "opmerking": "..."}
Regels — heel belangrijk:
- Wees eerlijk over onzekerheid: zet "zeker": false bij ALLES wat je niet vrijwel zeker weet.
- Verzin NOOIT programma's. Een leeg antwoord is beter dan een verzonnen antwoord.
- Ken je deze persoon niet of niet zeker genoeg? Geef dan {"items": [], "opmerking": "persoon niet (zeker genoeg) bekend"}.
- Maximaal 15 items, meest relevant eerst. "rol" is bv. "presentator", "deelnemer", "zichzelf", "hoofdrol als X".`;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Alleen POST' }, 405, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return jsonResponse({ error: 'ANTHROPIC_API_KEY secret ontbreekt in de Worker-settings' }, 500, origin);
    }

    let body;
    try { body = await request.json(); }
    catch (e) { return jsonResponse({ error: 'Body is geen JSON' }, 400, origin); }

    const naam = String(body.naam || '').slice(0, 120).trim();
    const geboortejaar = String(body.geboortejaar || '').slice(0, 4).replace(/\D/g, '');
    if (!naam) return jsonResponse({ error: 'naam ontbreekt' }, 400, origin);

    let prompt;
    if (body.task === 'bio') prompt = bioPrompt(naam, geboortejaar);
    else if (body.task === 'tv') prompt = tvPrompt(naam, geboortejaar);
    else return jsonResponse({ error: 'task moet "bio" of "tv" zijn' }, 400, origin);

    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          temperature: 0, /* v0.6: maximale feitelijkheid, minder fantasie */
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      return jsonResponse({ error: 'Claude API niet bereikbaar: ' + e.message }, 502, origin);
    }

    if (!upstream.ok) {
      const t = await upstream.text();
      return jsonResponse({ error: 'Claude API status ' + upstream.status, detail: t.slice(0, 300) }, 502, origin);
    }

    const data = await upstream.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    const parsed = extractJSON(text);
    if (!parsed) return jsonResponse({ error: 'Geen bruikbaar JSON in AI-antwoord' }, 502, origin);

    return jsonResponse(parsed, 200, origin);
  },
};
