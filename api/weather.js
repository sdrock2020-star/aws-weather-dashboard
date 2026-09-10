// In-memory cache across serverless/node invocations
const globalCache = {
  farm: { data: null, lastFetched: 0 },
  main: { data: null, lastFetched: 0 }
};
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes upstream cache

export default async function handler(req, res) {
  const { station = 'farm', mode = 'latest' } = req.query;

  const STATIONS_CONFIG = {
    farm: {
      token: process.env.API_KEY_FARM || "f2b8d4a6c1e9f3b7d5a2c8e6f1b4d7qw",
      endpoint: "https://fzevergreenagro.com/api/v1/device-data"
    },
    main: {
      token: process.env.API_KEY_MAIN || "a7c3e9f1b5d2a8c6e4f7b9d1c3a5e2xz",
      endpoint: "https://fzevergreenagro.com/api/v1/device-data"
    }
  };

  const selectedConfig = STATIONS_CONFIG[station] || STATIONS_CONFIG.farm;
  const now = Date.now();
  const stationCache = globalCache[station] || { data: null, lastFetched: 0 };

  // CDN & Browser Cache Header: dynamic max-age depending on mode
  if (mode === 'latest') {
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  } else {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  }

  let rawPayload = stationCache.data;

  // Fetch upstream only if cache expired or missing
  if (!rawPayload || (now - stationCache.lastFetched) > CACHE_TTL_MS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);

      const response = await fetch(selectedConfig.endpoint, {
        method: "GET",
        headers: {
          "X-API-KEY": selectedConfig.token,
          "Accept": "application/json"
        },
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (response.ok) {
        rawPayload = await response.json();
        globalCache[station] = {
          data: rawPayload,
          lastFetched: now
        };
      } else if (!rawPayload) {
        return res.status(response.status).json({
          status: false,
          message: `Upstream service returned HTTP ${response.status}`
        });
      }
    } catch (error) {
      if (!rawPayload) {
        const isAbort = error.name === 'AbortError';
        return res.status(isAbort ? 504 : 500).json({
          status: false,
          message: isAbort ? "Telemetry upstream timeout" : error.message
        });
      }
    }
  }

  if (!rawPayload || !rawPayload.status || !Array.isArray(rawPayload.data)) {
    return res.status(200).json(rawPayload || { status: false, message: "No records found" });
  }

  const allRecords = rawPayload.data;
  const totalLen = allRecords.length;

  // -------------------------------------------------------------
  // MODE 1: 'latest' -> Metric cards only (< 2 KB payload, instant)
  // Scans from newest records first and breaks early once all params found
  // -------------------------------------------------------------
  if (mode === 'latest') {
    const latestMap = {};
    for (let i = 0; i < totalLen; i++) {
      const item = allRecords[i];
      if (!item) continue;
      const key = String(item.data_class || item.name || "").toLowerCase().trim();
      if (!latestMap[key]) {
        latestMap[key] = item;
      }
      // Mendhasal has 15, Campus has 16. If we have found 16, exit early!
      if (Object.keys(latestMap).length >= 16) break;
    }

    return res.status(200).json({
      status: true,
      device: rawPayload.device,
      data: Object.values(latestMap),
      total_count: totalLen
    });
  }

  // -------------------------------------------------------------
  // MODE 2: 'csv' -> Full historical dataset
  // -------------------------------------------------------------
  if (mode === 'csv') {
    return res.status(200).json({
      status: true,
      device: rawPayload.device,
      data: allRecords,
      total_count: totalLen
    });
  }

  // -------------------------------------------------------------
  // MODE 3: 'recent' -> Optimized Fast Date Parsing & Slice
  // Pre-computes integer epoch timestamps instead of redundant Date objects
  // -------------------------------------------------------------
  let maxTime = 0;
  const sampleLimit = Math.min(50, totalLen);
  for (let i = 0; i < sampleLimit; i++) {
    const t = Date.parse(allRecords[i].created_at);
    if (!isNaN(t) && t > maxTime) maxTime = t;
  }
  if (!maxTime) maxTime = now;

  const fiveDaysCutoff = maxTime - (5 * 24 * 60 * 60 * 1000);
  const fiveDayRecords = [];

  for (let i = 0; i < totalLen; i++) {
    const item = allRecords[i];
    if (item && item.created_at) {
      const timeMs = Date.parse(item.created_at);
      if (timeMs >= fiveDaysCutoff) {
        // Cache numeric time for sorting
        item._t = timeMs;
        fiveDayRecords.push(item);
      }
    }
  }

  // Fast numeric sort (avoids creating 2 Date objects per item comparison)
  fiveDayRecords.sort((a, b) => (b._t || 0) - (a._t || 0));

  return res.status(200).json({
    status: true,
    device: rawPayload.device,
    data: fiveDayRecords,
    total_count: totalLen,
    five_day_count: fiveDayRecords.length
  });
}
