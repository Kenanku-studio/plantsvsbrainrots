window.PVBR_CONFIG = {
	// Public endpoints
	STOCK_URL: "https://plantsvsbrainrotsstocktracker.com/api/stock", // uses KV or fallback
	ALERT_WEBHOOK_URL: "", // disabled for now
	// WebSocket enabled - connecting to Grow A Garden WebSocket
	WEBSOCKET_URL: "wss://ws.growagardenpro.com", // Grow A Garden WebSocket server
	// Local fallback (for dev without backend)
	FALLBACK_JSON: "./data/stock.json",
};


