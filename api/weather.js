export default async function handler(req, res) {
  const { station } = req.query;

  const TOKENS = {
    farm: "f2b8d4a6c1e9f3b7d5a2c8e6f1b4d7qw",
    main: "a7c3e9f1b5d2a8c6e4f7b9d1c3a5e2xzard"
  };

  const token = TOKENS[station] || TOKENS.farm;

  try {
    const response = await fetch("https://fzevergreenagro.com/api/v1/device-data", {
      method: "GET",
      headers: {
        "X-API-KEY": token,
        "Accept": "application/json"
      }
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
}
