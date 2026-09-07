// In-memory cache across serverless/node invocations
const globalCache = {
  farm: { data: null, lastFetched: 0 },
  main: { data: null, lastFetched: 0 }
};

const CACHE_TTL_MS = 2 * 60 * 1000; // Cache upstream data for 2 minutes

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

  // CDN & Browser Cache Header: Instant delivery with background refresh
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=60');

  let rawPayload = stationCache.data;

  // Fetch upstream only if cache expired or missing
  if (!rawPayload || (now - stationCache.lastFetched) > CACHE_TTL_MS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

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
      // If fetch fails but we have stale cache, serve stale cache instead of failing
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

  // MODE 1: 'latest' -> Metric cards only (< 3 KB payload, loads instantly)
  if (mode === 'latest') {
    const latestMap = {};
    for (let i = allRecords.length - 1; i >= 0; i--) {
      const item = allRecords[i];
      if (!item) continue;
      const key = String(item.data_class || item.name || "").toLowerCase().trim();
      if (!latestMap[key] || new Date(item.created_at) > new Date(latestMap[key].created_at)) {
        latestMap[key] = item;
      }
    }
    return res.status(200).json({
      status: true,
      device: rawPayload.device,
      data: Object.values(latestMap),
      total_count: allRecords.length
    });
  }

  // MODE 2: 'csv' -> Full entire historical dataset (all 40,000+ records)
  if (mode === 'csv') {
    return res.status(200).json({
      status: true,
      device: rawPayload.device,
      data: allRecords,
      total_count: allRecords.length
    });
  }

  // MODE 3: 'recent' -> Last 5 Days data only (for the table feed)
  // Calculate cutoff timestamp: 5 days prior to the newest recorded log
  let maxTime = 0;
  for (let i = 0; i < Math.min(100, allRecords.length); i++) {
    const t = new Date(allRecords[i].created_at).getTime();
    if (!isNaN(t) && t > maxTime) maxTime = t;
  }
  if (!maxTime) maxTime = now;
  const fiveDaysCutoff = maxTime - (5 * 24 * 60 * 60 * 1000);

  const fiveDayRecords = [];
  for (let i = 0; i < allRecords.length; i++) {
    const item = allRecords[i];
    if (item && item.created_at) {
      const t = new Date(item.created_at).getTime();
      if (t >= fiveDaysCutoff) {
        fiveDayRecords.push(item);
      }
    }
  }

  fiveDayRecords.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  return res.status(200).json({
    status: true,
    device: rawPayload.device,
    data: fiveDayRecords,
    total_count: allRecords.length,
    five_day_count: fiveDayRecords.length
  });
}

