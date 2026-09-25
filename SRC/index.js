export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runAITradingAgent(env));
  },

  async fetch(request, env, ctx) {
    try {
      const result = await runAITradingAgent(env);
      return new Response(JSON.stringify({ success: true, data: result }), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};

async function runAITradingAgent(env) {
  const CONFIG = {
    LEVERAGE: 8,         
    TP_PERCENT: 1.16,    // 16% Take Profit multiplier (1.16x)
    TSL_DISTANCE_PCT: 0.053, // 5.3% Trailing Stop Retracement Distance
  };

  const accountEquity = await getAccountBalance(env);
  
  if (accountEquity <= 0) {
    throw new Error("Account equity is too low or zero.");
  }

  const allocatedCapital = accountEquity;

  const tickerUrl = "https://api-testnet.bybit.com/v5/market/tickers?category=linear";
  const tickerRes = await fetch(tickerUrl);
  const tickerData = await tickerRes.json();

  if (tickerData.retCode !== 0) {
    throw new Error("Failed to fetch Bybit tickers");
  }

  const rawList = tickerData.result.list;
  const targetCoins = rawList.filter(item => {
    const symbol = item.symbol;
    if (symbol.includes("BTC") || symbol.includes("ETH")) return false; 
    
    const turnover24h = parseFloat(item.turnover24h || 0);
    return turnover24h >= 3000000 && turnover24h <= 40000000; 
  }).slice(0, 8); 

  const executedTrades = [];

  for (let coin of targetCoins) {
    const symbol = coin.symbol;
    const currentPrice = parseFloat(coin.lastPrice);

    const klineUrl = `https://api-testnet.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=35`;
    const klineRes = await fetch(klineUrl);
    const klineData = await klineRes.json();

    if (klineData.retCode !== 0) continue;
    
    const candles = klineData.result.list.reverse();
    const closes = candles.map(c => parseFloat(c[4]));
    const volumes = candles.map(c => parseFloat(c[5]));

    const macdResult = calculateMACD(closes);
    const volumeOk = checkVolumeHealth(volumes);

    if (!macdResult.crossover || !volumeOk) continue;

    const aiDecision = await getAIDecision(symbol, macdResult, candles, env);

    if (aiDecision.action === macdResult.signal && aiDecision.confidence >= 80) {
      const orderRes = await executeAdvancedOrder(symbol, aiDecision.action, currentPrice, allocatedCapital, CONFIG, env);
      executedTrades.push({ symbol, action: aiDecision.action, allocatedCapital, orderRes });
      break; 
    }
  }

  return { accountEquity, allocatedCapital, scanned: targetCoins.length, executed: executedTrades };
}

async function getAccountBalance(env) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const queryString = "accountType=UNIFIED";
  
  const signaturePayload = timestamp + env.BYBIT_API_KEY + recvWindow + queryString;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BYBIT_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signaturePayload));
  const signature = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  try {
    const res = await fetch(`https://api-testnet.bybit.com/v5/account/wallet-balance?${queryString}`, {
      method: "GET",
      headers: {
        "X-BAPI-API-KEY": env.BYBIT_API_KEY,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-SIGN": signature,
        "X-BAPI-RECV-WINDOW": recvWindow
      }
    });
    const data = await res.json();
    if (data.retCode === 0) {
      const totalEquity = parseFloat(data.result.list[0].totalEquity || "0");
      return totalEquity;
    }
  } catch (e) {
    console.log("Error fetching wallet balance.");
  }
  return 0;
}

function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = calculateEMA(macdLine.slice(25), 9);
  
  const currentMacd = macdLine[macdLine.length - 1];
  const previousMacd = macdLine[macdLine.length - 2];
  const currentSignal = signalLine[signalLine.length - 1];
  const previousSignal = signalLine[signalLine.length - 2];

  let crossover = null;
  if (previousMacd <= previousSignal && currentMacd > currentSignal) {
    crossover = "BUY";
  } else if (previousMacd >= previousSignal && currentMacd < currentSignal) {
    crossover = "SELL";
  }

  return { crossover, signal: crossover, currentMacd, currentSignal };
}

function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  let emaArray = [];
  let prevEma = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      emaArray.push(0);
    } else if (i === period - 1) {
      emaArray.push(prevEma);
    } else {
      let currentEma = (data[i] - prevEma) * k + prevEma;
      emaArray.push(currentEma);
      prevEma = currentEma;
    }
  }
  return emaArray;
}

function checkVolumeHealth(volumes) {
  const recentVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;
  return recentVol >= (avgVol * 0.8);
}

async function getAIDecision(symbol, macd, candles, env) {
  const prompt = `You are a crypto trading AI agent. Analyzing midcap asset ${symbol} on a 15m chart.
  MACD Status: Crossover detected type ${macd.crossover}.
  Recent 5 closes: ${JSON.stringify(candles.slice(-5).map(c => c[4]))}
  
  Confirm if this trade should be taken. Reply strictly in JSON:
  {"action": "BUY" or "SELL" or "HOLD", "confidence": 0-100, "reason": "text"}`;

  const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${env.AI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });

  const json = await aiRes.json();
  const rawText = json.candidates[0].content.parts[0].text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(rawText);
}

async function executeAdvancedOrder(symbol, side, entryPrice, allocatedCapital, config, env) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";

  await setBybitLeverage(symbol, config.LEVERAGE, env);

  const totalNotionalValue = allocatedCapital * config.LEVERAGE;
  const rawQty = totalNotionalValue / entryPrice;
  const qty = rawQty.toFixed(2);

  let tpPrice, trailingStopDistance;
  if (side === "BUY") {
    tpPrice = (entryPrice * config.TP_PERCENT).toFixed(4);
    trailingStopDistance = (entryPrice * config.TSL_DISTANCE_PCT).toFixed(4);
  } else {
    tpPrice = (entryPrice * (2 - config.TP_PERCENT)).toFixed(4);
    trailingStopDistance = (entryPrice * config.TSL_DISTANCE_PCT).toFixed(4);
  }

  const bodyObject = {
    category: "linear",
    symbol: symbol,
    side: side === "BUY" ? "Buy" : "Sell",
    orderType: "Market",
    qty: qty.toString(),
    takeProfit: tpPrice.toString(),
    trailingStop: trailingStopDistance.toString(),
    tpslMode: "Full"
  };

  const bodyString = JSON.stringify(bodyObject);
  const signaturePayload = timestamp + env.BYBIT_API_KEY + recvWindow + bodyString;
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BYBIT_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signaturePayload));
  const signature = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  const res = await fetch(`https://api-testnet.bybit.com/v5/order/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": env.BYBIT_API_KEY,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": recvWindow
    },
    body: bodyString
  });

  return await res.json();
}

async function setBybitLeverage(symbol, leverage, env) {
  const timestamp = Date.now().toString();
  const recvWindow = "5000";
  const bodyObject = {
    category: "linear",
    symbol: symbol,
    buyLeverage: leverage.toString(),
    sellLeverage: leverage.toString()
  };

  const bodyString = JSON.stringify(bodyObject);
  const signaturePayload = timestamp + env.BYBIT_API_KEY + recvWindow + bodyString;
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.BYBIT_API_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signaturePayload));
  const signature = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  await fetch(`https://api-testnet.bybit.com/v5/position/set-leverage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-BAPI-API-KEY": env.BYBIT_API_KEY,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": recvWindow
    },
    body: bodyString
  });
}
