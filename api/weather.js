export default async function handler(req, res) {
  const { station = 'farm' } = req.query;

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

  try {
    // Disable serverless caching so live telemetry always updates
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10-second timeout

    const response = await fetch(selectedConfig.endpoint, {
      method: "GET",
      headers: {
        "X-API-KEY": selectedConfig.token,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({
        status: false,
        message: `Upstream service returned HTTP ${response.status}`
      });
    }

    const payload = await response.json();
    return res.status(200).json(payload);
  } catch (error) {
    const isAbort = error.name === 'AbortError';
    return res.status(isAbort ? 504 : 500).json({
      status: false,
      message: isAbort ? "Telemetry upstream timeout" : error.message
    });
  }
}
