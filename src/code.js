import INDEX_HTML from './index.html';

const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyVsc2KHocAkGb4slg768TRC93INuGNFHn3ITkuI6OJD9m1a0lV8Em204ktzVVTlJUGuA/exec";

let faqCache = null;
let lastCacheTime = 0;
const CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minuten bewaren
const TYP_VERTRAGING_MS = 1000; // 1 seconde vertraging voor "natuurlijk typen"

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api" && request.method === "POST") {
      try {
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        const actie = body.actie;
        const args = body.argumenten || [];

        // 🚀 1. Inlog-check: alvast cache vullen op de achtergrond
        if (actie === "checkInloggen") {
          const [idCode, apparaatToken] = args;
          ctx.waitUntil(haalCacheOp(GOOGLE_SCRIPT_URL, idCode, apparaatToken));
        }

        // 🚀 2. FAQ-LIJST LADEN OP CLOUDFLARE (~20ms INSTANT!)
        if (actie === "haalAlleVragen") {
          const [idCode, apparaatToken] = args;
          const cacheData = await haalCacheOp(GOOGLE_SCRIPT_URL, idCode, apparaatToken);

          if (cacheData && cacheData.vragen) {
            return new Response(JSON.stringify(cacheData), {
              headers: { "Content-Type": "application/json" }
            });
          }
        }

        // 🚀 3. ZOEKOPDRACHT OP CLOUDFLARE (~1 sec)
        if (actie === "zoekAntwoord") {
          const [idCode, apparaatToken, vraagTekst] = args;
          const cacheData = await haalCacheOp(GOOGLE_SCRIPT_URL, idCode, apparaatToken);

          if (cacheData && cacheData.vragen) {
            const match = vindBesteMatch(vraagTekst, cacheData.vragen);
            if (match) {
              await new Promise(resolve => setTimeout(resolve, TYP_VERTRAGING_MS));
              return new Response(JSON.stringify(match), {
                headers: { "Content-Type": "application/json" }
              });
            }
          }
        }

        // 🚀 4. FAQ KLIK OP CLOUDFLARE
        if (actie === "haalAntwoordOpRij") {
          const [idCode, apparaatToken, rijNummer] = args;
          const cacheData = await haalCacheOp(GOOGLE_SCRIPT_URL, idCode, apparaatToken);

          if (cacheData && cacheData.vragen) {
            const rijMatch = cacheData.vragen.find(v => Number(v.rij) === Number(rijNummer));
            if (rijMatch && !bevatPlaceholder(rijMatch.antwoord)) {
              await new Promise(resolve => setTimeout(resolve, TYP_VERTRAGING_MS));
              return new Response(JSON.stringify({
                tekst: rijMatch.antwoord,
                opties: rijMatch.opties || []
              }), {
                headers: { "Content-Type": "application/json" }
              });
            }
          }
        }

        // 🚀 5. KEUZEKNOP KLIK OP CLOUDFLARE
        if (actie === "haalStap") {
          const [idCode, apparaatToken, stapId] = args;
          const cacheData = await haalCacheOp(GOOGLE_SCRIPT_URL, idCode, apparaatToken);

          if (cacheData && cacheData.vragen) {
            const stapMatch = cacheData.vragen.find(v => String(v.id).trim() === String(stapId).trim());
            if (stapMatch && !bevatPlaceholder(stapMatch.antwoord)) {
              await new Promise(resolve => setTimeout(resolve, 600));
              return new Response(JSON.stringify({
                tekst: stapMatch.antwoord,
                opties: stapMatch.opties || []
              }), {
                headers: { "Content-Type": "application/json" }
              });
            }
          }
        }

        // Overige verzoeken (zoals PDF's of verificatie) doorsturen naar Google Apps Script
        const res = await fetch(GOOGLE_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: bodyText,
        });

        const responseText = await res.text();
        return new Response(responseText, {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function haalCacheOp(scriptUrl, idCode, apparaatToken) {
  const nu = Date.now();
  if (faqCache && (nu - lastCacheTime < CACHE_DURATION_MS)) {
    return faqCache;
  }

  try {
    const payload = JSON.stringify({ actie: "haalAlleVragen", argumenten: [idCode, apparaatToken] });
    const res = await fetch(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: payload,
    });
    const json = await res.json();
    if (json && json.vragen && json.vragen.length > 0) {
      faqCache = json;
      lastCacheTime = nu;
    }
    return faqCache;
  } catch (e) {
    return faqCache;
  }
}

// Een antwoord met een {{...}}-token (bijv. {{WEER}}, {{TIJD}}) moet altijd
// vers door de echte backend (Code.gs) ingevuld worden - deze cache mag zo'n
// antwoord nooit zelf teruggeven, anders krijgt de chauffeur een verouderd of
// zelfs letterlijk "{{WEER}}" antwoord.
function bevatPlaceholder(tekst) {
  return typeof tekst === 'string' && tekst.indexOf('{{') !== -1;
}

// Zelfde matchtTrefwoord-regel als in Code.gs: een meerdere-woorden-trefwoord
// moet als hele zin voorkomen; een los woord moet exact overeenkomen, of het
// trefwoord mag (vanaf 4 tekens) een prefix van het ingevoerde woord zijn.
function matchtTrefwoord(trefwoord, invoerZin, invoerWoorden) {
  if (!trefwoord) return false;
  if (trefwoord.indexOf(' ') !== -1) {
    return invoerZin.indexOf(trefwoord) !== -1;
  }
  return invoerWoorden.some(function(w) {
    if (w === trefwoord) return true;
    if (trefwoord.length >= 4 && w.indexOf(trefwoord) === 0) return true;
    return false;
  });
}

function normaliseerWoorden(tekst) {
  return String(tekst || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean);
}

// Spiegelt exact de matching-logica van zoekAntwoord() in Code.gs (inclusief
// de "zwak trefwoord" (~) regel: die telt alleen mee als er in dezelfde rij
// ook een sterk trefwoord matcht) - zodat een chauffeur nooit een ander
// antwoord krijgt afhankelijk van welke route (Cloudflare-cache of de echte
// backend) toevallig de vraag afhandelt.
function vindBesteMatch(vraagTekst, vragenLijst) {
  if (!vraagTekst || !vragenLijst) return null;

  const schoneInvoerZin = String(vraagTekst).toLowerCase().trim().replace(/\s+/g, ' ');

  const exacteMatch = vragenLijst.find(v => v.vraag && v.vraag.toLowerCase().trim().replace(/\s+/g, ' ') === schoneInvoerZin);
  if (exacteMatch) {
    if (bevatPlaceholder(exacteMatch.antwoord)) return null; // laat de echte backend dit afhandelen
    return { tekst: exacteMatch.antwoord, opties: exacteMatch.opties || [] };
  }

  const invoerWoorden = normaliseerWoorden(vraagTekst);
  const invoerZin = invoerWoorden.join(' ');

  let besteVraag = null;
  let besteScore = 0;

  for (const item of vragenLijst) {
    if (!item.trefwoorden) continue;
    const ruweTrefwoorden = String(item.trefwoorden).split(',').map(t => t.trim()).filter(Boolean);

    let sterkeScore = 0;
    let zwakkeScore = 0;

    ruweTrefwoorden.forEach(function(ruw) {
      const isZwak = ruw.charAt(0) === '~';
      const trefwoord = (isZwak ? ruw.slice(1) : ruw).toLowerCase().trim();
      if (!trefwoord || !matchtTrefwoord(trefwoord, invoerZin, invoerWoorden)) return;
      if (isZwak) zwakkeScore++; else sterkeScore++;
    });

    const score = sterkeScore > 0 ? sterkeScore + zwakkeScore : 0;
    if (score > besteScore) {
      besteScore = score;
      besteVraag = item;
    }
  }

  if (besteVraag && besteScore >= 1) {
    if (bevatPlaceholder(besteVraag.antwoord)) return null; // idem
    return { tekst: besteVraag.antwoord, opties: besteVraag.opties || [] };
  }

  return null;
}