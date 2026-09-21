import INDEX_HTML from './index.html';

const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyVsc2KHocAkGb4slg768TRC93INuGNFHn3ITkuI6OJD9m1a0lV8Em204ktzVVTlJUGuA/exec";

// Twee cache-lagen:
// - L1 (geheugen van déze Worker-instantie): bijna instant, maar verdwijnt
//   zodra Cloudflare de instantie na inactiviteit laat "inslapen".
// - L2 (Cloudflare KV, zie CHATBOT_CACHE-binding in wrangler.jsonc): iets
//   trager (~10-20ms) maar overleeft dat inslapen wél - dus de eerste
//   aanvraag na een tijdje stilte hoeft niet meer helemaal opnieuw naar
//   Google Apps Script (en diens eigen, tragere opstart-overhead).
// Eén cache-slot per taal - de NL- en EN-vragenlijst zijn twee losse Sheet-
// tabs in Code.gs (zie haalAntwoordenSheetNaam daar) en horen dus ook los
// gecacht te worden.
let faqCacheGeheugen = { nl: null, en: null };
const FAQ_CACHE_SECONDEN = 30 * 60; // 30 minuten

function normaliseerTaal(taal) {
  return String(taal || '').trim().toLowerCase() === 'en' ? 'en' : 'nl';
}
let chauffeursCacheGeheugen = null;
// Kort genoeg dat een net gedeactiveerde chauffeur niet te lang "actief" kan
// blijven lijken bij Cloudflare, lang genoeg om de meeste logins (van
// chauffeurs zonder 2FA-plicht) te versnellen.
const CHAUFFEURS_CACHE_SECONDEN = 10 * 60; // 10 minuten
// Een vertrouwd apparaat blijft sowieso tot het einde van de dag geldig (zie
// COL_CHAUFFEUR_APPARAAT_GELDIG_TOT in Code.gs), dus 6 uur cachen levert geen
// verouderde inlogstatus op en voorkomt dat dezelfde chauffeur meerdere keren
// per dienst de trage Apps Script-aanroep raakt.
const LOGIN_CACHE_SECONDEN = 6 * 60 * 60; // 6 uur
const TYP_VERTRAGING_MS = 1000; // 1 seconde vertraging voor "natuurlijk typen"

// Apps Script kan bij een "koude start" (een tijdje niet gebruikt) 5-8+
// seconden nodig hebben om te antwoorden. Zonder tijdslimiet zou de chauffeur
// onbeperkt kunnen blijven wachten; met een tweede, snelle nieuwe poging
// herstelt een kortstondige hapering (netwerk, quotum-piek) zichzelf meestal
// zonder dat de chauffeur er iets van merkt.
const APPS_SCRIPT_TIMEOUT_MS = 15000;
const APPS_SCRIPT_MAX_POGINGEN = 2;

async function fetchMetTimeout(url, opties, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, Object.assign({}, opties, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

// Doet de aanroep naar Google Apps Script, en probeert het bij een fout of
// timeout één keer opnieuw voordat de fout echt wordt doorgegeven.
async function fetchAppsScriptJson(url, opties) {
  let laatsteFout;
  for (let poging = 1; poging <= APPS_SCRIPT_MAX_POGINGEN; poging++) {
    try {
      const res = await fetchMetTimeout(url, opties, APPS_SCRIPT_TIMEOUT_MS);
      if (!res.ok) throw new Error('Apps Script gaf status ' + res.status);
      return await res.json();
    } catch (e) {
      laatsteFout = e;
    }
  }
  throw laatsteFout;
}

// Bij de allereerste (nog niet gecachete) inlog-check racen we na een korte
// vertraging een tweede, identieke aanroep tegen de eerste aan - wie het
// eerst antwoordt "wint". Dit vangt vooral het geval op waarin Apps Script
// net koud is gestart en de eerste aanroep traag op gang komt, zonder dat de
// chauffeur eerst een volle timeout + herhaling ná elkaar hoeft af te
// wachten. Alleen veilig voor aanroepen zonder bijwerkingen (zoals
// checkInloggen) - NIET gebruiken voor bijv. verstuurVerificatiecode, want
// dan zouden er per ongeluk 2 verschillende codes gemaild kunnen worden.
const INLOG_RACE_VERTRAGING_MS = 2000;

function vertraagdeAanroep(url, opties, vertragingMs) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      fetchAppsScriptJson(url, opties).then(resolve, reject);
    }, vertragingMs);
  });
}

// Start de normale aanroep meteen, en - als die na INLOG_RACE_VERTRAGING_MS
// nog niet klaar is - een tweede erbovenop; wie het eerst antwoordt wint.
// Faalt pas als ALLEBEI mislukken (Promise.any-gedrag).
async function fetchAppsScriptJsonMetRace(url, opties) {
  try {
    return await Promise.any([
      fetchAppsScriptJson(url, opties),
      vertraagdeAanroep(url, opties, INLOG_RACE_VERTRAGING_MS),
    ]);
  } catch (e) {
    // Promise.any gooit een AggregateError met alle onderliggende fouten
    // erin; we geven de eerste door zodat de bestaande foutafhandeling
    // (o.a. de "traag"-detectie) er gewoon op kan blijven werken.
    throw (e && e.errors && e.errors[0]) || e;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Nooit cachen: zonder dit kunnen browsers (en soms Cloudflare's eigen
      // edge-cache) een oude versie van de pagina blijven tonen na een
      // nieuwe deploy, ook al staat de nieuwste code al live.
      return new Response(INDEX_HTML, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    }

    if (url.pathname === "/api" && request.method === "POST") {
      try {
        const bodyText = await request.text();
        const body = JSON.parse(bodyText);
        const actie = body.actie;
        const args = body.argumenten || [];

        // 🚀 1. INLOGGEN OP CLOUDFLARE - eerst de KV-cache proberen (zelfde
        // idCode + token binnen 10 min = geen nieuwe aanroep naar Google nodig)
        if (actie === "checkInloggen") {
          const [idCode, apparaatToken, taal] = args;
          const loginSleutel = 'login_' + idCode + '_' + apparaatToken;

          const gecachedLogin = await veiligKvGet(env, loginSleutel);
          if (gecachedLogin) {
            ctx.waitUntil(haalCacheOp(env, GOOGLE_SCRIPT_URL, idCode, apparaatToken, taal));
            return jsonResponse(gecachedLogin);
          }

          // Voor chauffeurs zonder 2FA-plicht (dus buiten VERIFICATIE_TEST_EMAILS)
          // hangt "geldig ingelogd" niet af van een token-check in Apps
          // Script (zie isVertrouwdApparaat daar) - voor hén kunnen we het
          // hele antwoord dus lokaal samenstellen uit de gecachete
          // chauffeurslijst, zonder Apps Script te hoeven raken. Voor
          // chauffeurs die wél 2FA nodig hebben (nu alleen het testaccount,
          // straks iedereen) blijft de echte, per-toestel tokencheck via
          // Apps Script lopen - die slaan we hier bewust niet over.
          const chauffeursData = await haalChauffeursCacheOp(env, GOOGLE_SCRIPT_URL);
          if (chauffeursData && chauffeursData.chauffeurs) {
            const genormaliseerdId = String(idCode || '').trim().toLowerCase();
            const chauffeur = chauffeursData.chauffeurs.find(c => c.id === genormaliseerdId);
            if (chauffeur && !chauffeur.vereistVerificatie) {
              const lokaalJson = {
                status: 'ok',
                geldig: true,
                voornaam: chauffeur.voornaam,
                hub: chauffeur.hub,
              };
              ctx.waitUntil(veiligKvPut(env, loginSleutel, lokaalJson, LOGIN_CACHE_SECONDEN));
              ctx.waitUntil(haalCacheOp(env, GOOGLE_SCRIPT_URL, idCode, apparaatToken, taal));
              return jsonResponse(lokaalJson);
            }
          }

          const json = await fetchAppsScriptJsonMetRace(GOOGLE_SCRIPT_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: bodyText,
          });
          ctx.waitUntil(veiligKvPut(env, loginSleutel, json, LOGIN_CACHE_SECONDEN));
          ctx.waitUntil(haalCacheOp(env, GOOGLE_SCRIPT_URL, idCode, apparaatToken, taal));
          return jsonResponse(json);
        }

        // 🚀 2. FAQ-LIJST LADEN OP CLOUDFLARE
        if (actie === "haalAlleVragen") {
          const [idCode, apparaatToken, taal] = args;
          const cacheData = await haalCacheOp(env, GOOGLE_SCRIPT_URL, idCode, apparaatToken, taal);

          if (cacheData && cacheData.vragen) {
            return jsonResponse(cacheData);
          }
        }

        // 🚀 3. ZOEKOPDRACHT OP CLOUDFLARE
        if (actie === "zoekAntwoord") {
          const [idCode, apparaatToken, vraagTekst, taal] = args;
          const cacheData = await haalCacheOp(env, GOOGLE_SCRIPT_URL, idCode, apparaatToken, taal);

          if (cacheData && cacheData.vragen) {
            const match = vindBesteMatch(vraagTekst, cacheData.vragen);

            // A. MATCH GEVONDEN!
            if (match) {
              await wachtNatuurlijk();
              return jsonResponse(match);
            }

            // B. GÉÉN MATCH GEVONDEN -> Stuur vraag asynchroon naar Google (Log + Mail)
            ctx.waitUntil(
              fetch(GOOGLE_SCRIPT_URL, {
                method: "POST",
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: bodyText,
              }).catch(err => console.error("Fout bij loggen naar Google:", err))
            );

            // Bepaal slimme "bedoel je misschien..." suggesties uit de cache
            const suggesties = zoekSuggestiesInCache(cacheData.vragen, vraagTekst, taal);

            await wachtNatuurlijk();

            // Geef direct een geldig antwoordobject terug aan de frontend (geen crash!)
            return jsonResponse({ tekst: null, opties: [], suggesties: suggesties });
          }
        }

        // 🚀 4. FAQ KLIK OP CLOUDFLARE
        if (actie === "haalAntwoordOpRij") {
          const [idCode, apparaatToken, rijNummer, taal] = args;
          const cacheData = await haalCacheOp(env, GOOGLE_SCRIPT_URL, idCode, apparaatToken, taal);

          if (cacheData && cacheData.vragen) {
            const rijMatch = cacheData.vragen.find(v => Number(v.rij) === Number(rijNummer));
            if (rijMatch && !bevatPlaceholder(rijMatch.antwoord)) {
              await wachtNatuurlijk();
              return jsonResponse({ tekst: rijMatch.antwoord, opties: rijMatch.opties || [] });
            }
          }
        }

        // 🚀 5. KEUZEKNOP KLIK OP CLOUDFLARE
        if (actie === "haalStap") {
          const [idCode, apparaatToken, stapId, taal] = args;
          const cacheData = await haalCacheOp(env, GOOGLE_SCRIPT_URL, idCode, apparaatToken, taal);

          if (cacheData && cacheData.vragen) {
            const stapMatch = cacheData.vragen.find(v => String(v.id).trim() === String(stapId).trim());
            if (stapMatch && !bevatPlaceholder(stapMatch.antwoord)) {
              await new Promise(resolve => setTimeout(resolve, 600));
              return jsonResponse({ tekst: stapMatch.antwoord, opties: stapMatch.opties || [] });
            }
          }
        }

        // Overige verzoeken (zoals PDF's of verificatie) doorsturen naar Google Apps Script
        const json = await fetchAppsScriptJson(GOOGLE_SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: bodyText,
        });
        return jsonResponse(json);

      } catch (err) {
        // "traag: true" laat de frontend straks (indien gewenst) een minder
        // alarmerende melding tonen dan bij een echte, onherstelbare fout.
        const traag = err && err.name === 'AbortError';
        return new Response(JSON.stringify({ error: err.message, traag: traag }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function jsonResponse(data) {
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

function wachtNatuurlijk() {
  return new Promise(resolve => setTimeout(resolve, TYP_VERTRAGING_MS));
}

// KV-lezen/schrijven altijd veilig afhandelen: als Cloudflare KV een keer
// hapert, mag dat nooit de hele aanvraag laten crashen - dan wordt gewoon
// (iets langzamer) rechtstreeks bij Google opgehaald.
async function veiligKvGet(env, sleutel) {
  try {
    return await env.CHATBOT_CACHE.get(sleutel, { type: 'json' });
  } catch (e) {
    return null;
  }
}

async function veiligKvPut(env, sleutel, waarde, ttlSeconden) {
  try {
    await env.CHATBOT_CACHE.put(sleutel, JSON.stringify(waarde), { expirationTtl: ttlSeconden });
  } catch (e) {}
}

// Eerst het geheugen van déze Worker-instantie proberen (instant), dan
// Cloudflare KV (overleeft inactiviteit), en pas als beide leeg zijn de
// echte, tragere aanroep naar Google Apps Script. Eén cache-slot per taal
// (zie faqCacheGeheugen hierboven) - de NL- en EN-vragenlijst komen uit twee
// losse Sheet-tabs en mogen elkaar dus nooit overschrijven.
async function haalCacheOp(env, scriptUrl, idCode, apparaatToken, taal) {
  const t = normaliseerTaal(taal);
  if (faqCacheGeheugen[t]) return faqCacheGeheugen[t];

  const kvSleutel = 'faq_cache_' + t;
  const uitKv = await veiligKvGet(env, kvSleutel);
  if (uitKv) {
    faqCacheGeheugen[t] = uitKv;
    return uitKv;
  }

  try {
    const payload = JSON.stringify({ actie: "haalAlleVragen", argumenten: [idCode, apparaatToken, t] });
    const json = await fetchAppsScriptJson(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: payload,
    });
    if (json && json.vragen && json.vragen.length > 0) {
      faqCacheGeheugen[t] = json;
      await veiligKvPut(env, kvSleutel, json, FAQ_CACHE_SECONDEN);
    }
    return faqCacheGeheugen[t];
  } catch (e) {
    return faqCacheGeheugen[t];
  }
}

// Zelfde patroon als haalCacheOp hierboven, maar dan voor de lichte
// chauffeurslijst (id/voornaam/hub/vereistVerificatie) waarmee checkInloggen
// voor niet-2FA-chauffeurs lokaal beantwoord kan worden zonder Apps Script.
async function haalChauffeursCacheOp(env, scriptUrl) {
  if (chauffeursCacheGeheugen) return chauffeursCacheGeheugen;

  const uitKv = await veiligKvGet(env, 'chauffeurs_cache');
  if (uitKv) {
    chauffeursCacheGeheugen = uitKv;
    return uitKv;
  }

  try {
    const payload = JSON.stringify({ actie: "haalActieveChauffeurs", argumenten: [] });
    const json = await fetchAppsScriptJson(scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: payload,
    });
    if (json && json.chauffeurs && json.chauffeurs.length > 0) {
      chauffeursCacheGeheugen = json;
      await veiligKvPut(env, 'chauffeurs_cache', json, CHAUFFEURS_CACHE_SECONDEN);
    }
    return chauffeursCacheGeheugen;
  } catch (e) {
    return chauffeursCacheGeheugen;
  }
}

function bevatPlaceholder(tekst) {
  return typeof tekst === 'string' && tekst.indexOf('{{') !== -1;
}

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

function vindBesteMatch(vraagTekst, vragenLijst) {
  if (!vraagTekst || !vragenLijst) return null;

  const schoneInvoerZin = String(vraagTekst).toLowerCase().trim().replace(/\s+/g, ' ');

  const exacteMatch = vragenLijst.find(v => v.vraag && v.vraag.toLowerCase().trim().replace(/\s+/g, ' ') === schoneInvoerZin);
  if (exacteMatch) {
    if (bevatPlaceholder(exacteMatch.antwoord)) return null;
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
    if (bevatPlaceholder(besteVraag.antwoord)) return null;
    return { tekst: besteVraag.antwoord, opties: besteVraag.opties || [] };
  }

  return null;
}

const NL_STOPWOORDEN = [
  'de', 'het', 'een', 'en', 'of', 'maar', 'want', 'dus', 'als', 'dan',
  'dat', 'die', 'deze', 'dit', 'er', 'hier', 'daar', 'waar', 'wat', 'wie',
  'hoe', 'wanneer', 'waarom', 'welke', 'ik', 'jij', 'je', 'u', 'hij', 'zij',
  'ze', 'wij', 'we', 'jullie', 'mij', 'me', 'hem', 'haar', 'ons', 'hun',
  'mijn', 'jouw', 'onze', 'niet', 'geen', 'ook', 'al', 'nog', 'wel', 'te',
  'om', 'van', 'voor', 'met', 'op', 'in', 'aan', 'naar', 'uit', 'over',
  'onder', 'tussen', 'door', 'bij', 'zonder', 'tot', 'na', 'tijdens',
  'is', 'ben', 'bent', 'zijn', 'was', 'waren', 'wordt', 'worden', 'werd',
  'heeft', 'hebben', 'had', 'hadden', 'moet', 'moeten', 'mag', 'mogen',
  'kan', 'kunnen', 'wil', 'willen', 'zou', 'zullen', 'gaat', 'gaan'
];

const EN_STOPWOORDEN = [
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'if', 'then', 'that', 'this',
  'these', 'those', 'there', 'here', 'where', 'what', 'who', 'how', 'when',
  'why', 'which', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him',
  'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'not',
  'no', 'also', 'still', 'yet', 'to', 'of', 'for', 'with', 'on', 'in', 'at',
  'from', 'out', 'over', 'under', 'between', 'by', 'without', 'until',
  'after', 'during', 'is', 'am', 'are', 'was', 'were', 'be', 'been',
  'being', 'has', 'have', 'had', 'must', 'should', 'may', 'might', 'can',
  'could', 'will', 'would', 'shall', 'do', 'does', 'did', 'about'
];

function zoekSuggestiesInCache(vragenLijst, vraagTekst, taal) {
  if (!vragenLijst || !vraagTekst) return [];

  const stopwoorden = normaliseerTaal(taal) === 'en' ? EN_STOPWOORDEN : NL_STOPWOORDEN;
  const invoerWoorden = normaliseerWoorden(vraagTekst);
  const betekenisvolleInvoerWoorden = invoerWoorden.filter(w => stopwoorden.indexOf(w) === -1);

  const kandidaten = [];

  vragenLijst.forEach(function(item) {
    if (!item.vraag) return;

    const overlap = normaliseerWoorden(item.vraag).filter(function(woord) {
      return stopwoorden.indexOf(woord) === -1 && betekenisvolleInvoerWoorden.indexOf(woord) !== -1;
    }).length;

    if (overlap > 0) {
      kandidaten.push({ vraag: item.vraag, rij: item.rij, overlap: overlap });
    }
  });

  return kandidaten
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 2)
    .map(k => ({ vraag: k.vraag, rij: k.rij }));
}
