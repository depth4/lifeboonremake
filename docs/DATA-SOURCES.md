> **Что это и когда понадобится.** Выгрузка из СТАРОГО проекта: все внешние
> адреса, лицензии и обязанности, которые он на себя брал, когда строил город
> по настоящим картам. Прислал Алекс 17.09.2026, текст ниже — дословный,
> ничего не правил.
>
> **Сегодня мы этим НЕ пользуемся и не собираемся.** Решение Алекса от
> 17.09.2026: «не делай карту на OSM как в прошлом проекте, слишком рано —
> сначала идеально выверяем шаблон». Город у нас процедурный, из сида, и
> остаётся таким. Настоящие карты — очень далеко потом.
>
> Зачем тогда файл лежит здесь: чтобы, когда до этого дойдёт, не собирать
> обязанности заново и не повторить забытую атрибуцию рельефа — она в §3.
> Отдельно: замер настоящего города, по которому сейчас поверяется генератор,
> взят НЕ отсюда и не из OSM — это кадастр Праги, см. `how-cities-work.md` §6.

---

# Every external thing the old project touched

Extracted from the source, not from memory. Every URL, every licence, every
obligation, and the gaps. Drop this into the new repository.

Verified against `attic/` at commit `ef6d48e`.

---

## 0. The whole list, in one table

The project made requests to exactly **five** external endpoints. Nothing else:
no analytics, no CDN, no fonts, no image hosting, no API keys, no accounts.

| # | Endpoint | What for | Licence | Cost |
|---|---|---|---|---|
| 1 | `https://overpass-api.de/api/interpreter` | map data | ODbL 1.0 | free, volunteer-run |
| 2 | `https://overpass.kumi.systems/api/interpreter` | map data (mirror) | ODbL 1.0 | free, volunteer-run |
| 3 | `https://overpass.private.coffee/api/interpreter` | map data (mirror) | ODbL 1.0 | free, volunteer-run |
| 4 | `https://nominatim.openstreetmap.org/search` | place search by name | ODbL 1.0 | free, volunteer-run |
| 5 | `https://s3.amazonaws.com/elevation-tiles-prod/terrarium` | elevation | see §3 | free, AWS Open Data |

Everything else — textures, fonts, the icon, the buildings, the people, the
weather, the car — is generated in code or drawn by hand. There is no asset
pipeline and nothing was downloaded from anywhere.

---

## 1. OpenStreetMap, via Overpass

### What was requested

One request per loaded area, and this is the entire query, verbatim. `${b}` is
the bounding box as `south,west,north,east` to six decimal places.

```
[out:json][timeout:90];
(
  way["building"](${b});
  relation["building"]["type"="multipolygon"](${b});
  way["highway"](${b});
  way["railway"](${b});
  node["highway"="crossing"](${b});
  way["natural"~"^(water|wood|scrub|grassland|sand|beach)$"](${b});
  way["waterway"="riverbank"](${b});
  way["waterway"~"^(river|stream|canal|ditch|drain)$"](${b});
  relation["natural"="water"]["type"="multipolygon"](${b});
  way["landuse"~"^(grass|forest|meadow|village_green|cemetery|recreation_ground|reservoir|basin)$"](${b});
  way["leisure"~"^(park|garden|pitch|playground|sports_centre)$"](${b});
  way["amenity"~"^(parking|grave_yard)$"](${b});
  node["amenity"](${b});
  node["shop"](${b});
  node["leisure"](${b});
  node["office"](${b});
  node["tourism"~"^(museum|gallery|hotel)$"](${b});
  node["railway"="station"](${b});
);
out body geom qt;
```

`out geom` inlines the coordinates on ways and relation members, which avoids a
second round trip to resolve node references.

### How the client behaved

This matters more than the licence, because service abuse is the thing that
actually gets you blocked:

- **One request per area.** Never per frame, never per pan.
- **Area capped at 6 000 m across** (`MAX_SPAN_M`). A request for a whole
  country is impossible by construction.
- **Cached for 7 days in IndexedDB**, database `lifeboon-osm`, store `areas`.
  Reloading the same city hits the network zero times.
- **Three mirrors tried in turn**, not one retried. A busy mirror moves the
  load elsewhere instead of hammering it.
- **90-second server-side timeout** declared in the query itself.

### Licence: ODbL 1.0

Open Database License. Free for commercial use. Two obligations:

1. **Attribution.** "© OpenStreetMap contributors" must be visible in the
   product — in the UI, not in a repository file. The old app kept it in a
   permanent footer, not in an About box.
2. **Share-alike, and this is the part usually got wrong.** ODbL separates the
   *database* from a *Produced Work* made from it:
   - the rendered city on screen, screenshots, video → **Produced Work**.
     Attribution only. It does **not** force you to license your game as ODbL.
   - a modified extract of the data itself, redistributed → stays **ODbL**.

   So: shipping the game is fine. Shipping a file of parsed OSM geometry
   alongside it is a database, and that file is ODbL. See §6 — the capture
   files are exactly this case.

Full text: https://opendatacommons.org/licenses/odbl/1-0/

---

## 2. Nominatim (place search)

```
https://nominatim.openstreetmap.org/search?q=…&format=jsonv2&limit=5&addressdetails=0
```

Same data, same licence (ODbL). Used only to turn "Alapaevsk" into
latitude/longitude before the Overpass request.

**Its usage policy is stricter than Overpass's** and is the one real
compliance gap in the old code:

| Требование политики | Что было |
|---|---|
| Maximum 1 request per second | Met by accident: search fires on submit only, never on keystroke |
| Valid HTTP Referer **or** User-Agent identifying the app | **Partially met.** A browser will not let `fetch` set `User-Agent`, so Nominatim saw the browser's own UA and the site's Referer. Adequate for a browser app, **not** adequate if this ever runs server-side |
| No bulk / systematic querying | Met — one lookup per explicit user search |
| No autocomplete-as-you-type | Met |

Policy: https://operations.osmfoundation.org/policies/nominatim/

**If the new project ever geocodes from a server or at volume, self-host or use
a commercial geocoder.** This is the single most likely way to get an IP banned.

---

## 3. Elevation — AWS Terrain Tiles

```
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```

- **Format:** ordinary 256×256 PNG, "terrarium" encoding — height packed into
  the colour channels. The decode, straight from the spec:
  ```
  height = R * 256 + G + B / 256 - 32768   (metres)
  ```
- **Zoom used:** 9–13, chosen per latitude so one pixel lands near 20 m on the
  ground. Finer just resamples the same data; coarser loses real landscape.
- **Real resolution:** roughly 20–30 m per pixel. Gives a city its hills and
  valleys. It does **not** give kerbs, ditches or embankments — those have to
  be built, not measured.
- **Access:** no key, no account, no cost, permissive CORS. `crossOrigin =
  'anonymous'` is required or the canvas is tainted and the pixels cannot be
  read back.
- **Dataset:** AWS Open Data — https://registry.opendata.aws/terrain-tiles/
- **Provenance:** assembled by Mapzen/Tilezen from about a dozen national and
  global datasets.

### Licences of the underlying sources

Checked source by source against the Tilezen attribution list
(https://github.com/tilezen/joerd/blob/master/docs/attribution.md):

- **No source restricts commercial use or redistribution.** 3DEP, SRTM,
  GMTED2010 and ETOPO1 are US public domain; the rest are CC BY, Open
  Government Licence, or explicitly free.
- **Every source requires attribution**, each with its own required wording.

### The required credit line, verbatim

This is a condition of the licence. Copy it as-is:

> Elevation from the Terrain Tiles open dataset on AWS, assembled by
> Mapzen/Tilezen from: 3DEP, SRTM and GMTED2010 data courtesy of the
> U.S. Geological Survey; DOC/NOAA/NESDIS/NCEI > National Centers for
> Environmental Information (ETOPO1); ArcticDEM, created from DigitalGlobe,
> Inc. imagery and funded under NSF awards 1043681, 1559691 and 1542736;
> produced using Copernicus data and information funded by the European Union
> (EU-DEM); Copyright 2011 Crown copyright (c) Land Information New Zealand and
> the New Zealand Government; © Environment Agency copyright and/or database
> right 2015, all rights reserved; © offene Daten Österreichs – Digitales
> Geländemodell (DGM) Österreich; © Kartverket; contains information licensed
> under the Open Government Licence – Canada; Source: INEGI, Continental
> relief, 2016; © Commonwealth of Australia (Geoscience Australia) 2017.

**Change the elevation provider and this whole list changes with it.**

This was the obligation the project was quietly failing for months: the app
named OpenStreetMap and said nothing about where the hills came from.

---

## 4. What was deliberately NOT taken

Decisions, not oversights. Each removes a category of legal risk at the source:

| Not taken | Why |
|---|---|
| **Brand, operator and shop names** | Trademark is a different body of law from copyright — it turns on confusion and implied endorsement. `data/tags.ts` discards `name`, `brand` and `operator` for anything commercial and keeps the category only. A cafe is "a cafe" |
| **Street names** | ...are *kept*. A street name is geography, a fact about the world |
| **Any imagery** | No aerial photos, no Street View, no photogrammetry, no textures from anywhere. Buildings are prisms extruded from footprint polygons with a generated window pattern: position and mass, which are factual, and none of the protected architectural expression |
| **Building interiors** | A footprint is not personal data. It becomes personal data when linked to identifiable people. No interiors means never rendering the inside of someone's actual home |
| **Real people** | Every inhabitant is invented and assigned statistically from floor area |

---

## 5. Software dependencies

| Package | Version used | Licence |
|---|---|---|
| `three` | 0.185.1 | MIT |
| `polygon-clipping` | 0.15.7 | MIT |
| `earcut` | 3.2.3 | ISC |
| `typescript`, `vite`, `@types/*` | — | Apache-2.0 / MIT (build only, not shipped) |

All permissive. Nothing copyleft, nothing that reaches your own code.

**No fonts were downloaded.** The CSS uses system stacks only:
```
--font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
--mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
```

**No textures were downloaded.** Asphalt, paving, grass, facades, roofs and
window lights are drawn at runtime onto a `<canvas>` and used as
`THREE.CanvasTexture`. `render/textures.ts` is the whole art pipeline.

**The favicon** is a hand-written SVG in the repository.

---

## 6. The capture files — read this before sharing one

`data/fixture.ts` exports a loaded place to one gzipped JSON file
(~0.2 MB for a small town). It holds the **parsed world**: building rings and
heights, road polylines with tags, water, land cover, POI categories, plus the
terrain heightfield it was measured on. Not the raw Overpass response.

**That file is a derived database under ODbL, not a Produced Work.** If you
publish one — commit it to a public repository, attach it to a release — then:

- it must carry the ODbL notice and "© OpenStreetMap contributors";
- the terrain array inside it carries the elevation attribution too.

Keeping one in a private repo for testing is fine and was the intended use:
Overpass is unreachable from the agent sandbox, so a capture is the only way to
measure anything against a real town.

---

## 7. Checklist for the new repository

1. **Footer, always visible, not in an About box:**
   `© OpenStreetMap contributors (ODbL)`
2. **Full elevation credit** from §3 somewhere reachable in one click.
3. **Cap the requested area.** 6 km across was the old limit.
4. **Cache** map responses locally. A week is generous and polite.
5. **Multiple mirrors**, tried in turn, not one retried.
6. **Never geocode as-you-type.** On submit only.
7. **Self-host Overpass/Nominatim** before the site has real traffic. Volunteer
   infrastructure is not a backend.
8. **Drop brand / operator / commercial names at import.** Cheapest possible
   protection and it costs nothing.
9. **Re-check the elevation credit list** if you ever change tile provider.
10. **Mark any published capture file as ODbL.**

---

## 8. Honest gaps in the old project

Stated so they are not inherited by accident:

- **Nominatim User-Agent.** Not set, and cannot be set from browser `fetch`.
  Fine in a browser, not fine server-side.
- **No rate limiting of its own.** The 1-request-per-second policy was met
  because of how the UI happened to work, not because anything enforced it.
- **No `Referer` policy set explicitly** — the browser default carried it.
- **The elevation attribution was missing entirely** for most of the project's
  life and was added late. If you fork from an early commit, it is not there.
- **No terms-of-service acceptance recorded anywhere.** For a hobby project
  that is normal; for anything commercial, read each service's terms yourself.

This is engineering orientation gathered while building the thing. It is not
legal advice. For a commercial release, have a lawyer in your jurisdiction look
at it.
