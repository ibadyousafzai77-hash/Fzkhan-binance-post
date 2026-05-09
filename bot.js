const https = require("https");

const BINANCE_SQUARE_API_KEY = process.env.BINANCE_SQUARE_API_KEY;
const SQUARE_URL = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    var req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 CryptoBot/1.0" } }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        if (res.statusCode === 429) { reject(new Error("Rate limited (429)")); return; }
        if (res.statusCode !== 200) { reject(new Error("HTTP " + res.statusCode)); return; }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON error: " + data.slice(0,80))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, function() { req.destroy(); reject(new Error("Timeout")); });
  });
}

function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

function postToSquare(content) {
  return new Promise(function(resolve, reject) {
    if (!BINANCE_SQUARE_API_KEY) { reject(new Error("BINANCE_SQUARE_API_KEY not set!")); return; }
    var body = Buffer.from(JSON.stringify({ bodyTextOnly: content }), "utf8");
    var req  = https.request({
      hostname: "www.binance.com", port: 443,
      path: "/bapi/composite/v1/public/pgc/openApi/content/add",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        "X-Square-OpenAPI-Key": BINANCE_SQUARE_API_KEY
      }
    }, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, function() { req.destroy(); reject(new Error("POST timeout")); });
    req.write(body); req.end();
  });
}

function calcRSI(prices, period) {
  period = period || 14;
  if (prices.length < period + 2) return 50;
  var gains = [], losses = [];
  for (var i = 1; i < prices.length; i++) {
    var d = prices[i] - prices[i-1];
    gains.push(d > 0 ? d : 0);
    losses.push(d < 0 ? -d : 0);
  }
  var ag = gains.slice(0, period).reduce(function(a,b){return a+b;},0) / period;
  var al = losses.slice(0, period).reduce(function(a,b){return a+b;},0) / period;
  for (var j = period; j < gains.length; j++) {
    ag = (ag*(period-1)+gains[j])/period;
    al = (al*(period-1)+losses[j])/period;
  }
  if (al === 0) return 100;
  return 100 - 100/(1 + ag/al);
}

function calcEMA(prices, period) {
  var k = 2/(period+1), ema = prices[0];
  for (var i = 1; i < prices.length; i++) { ema = prices[i]*k + ema*(1-k); }
  return ema;
}

function scoreFromMarketData(coin) {
  var price = coin.current_price || 0;
  var high  = coin.high_24h      || price;
  var low   = coin.low_24h       || price;
  var ch24h = coin.price_change_percentage_24h || 0;
  var ch1h  = coin.price_change_percentage_1h_in_currency || 0;
  var vol   = coin.total_volume  || 0;
  var mcap  = coin.market_cap    || 1;
  if (price <= 0 || high <= low) return null;

  var range    = high - low;
  var position = (price - low) / range * 100;
  var volMcap  = vol / mcap;
  var ls = 0, ss = 0;

  if (ch1h >  2) { ls += 3; } else if (ch1h > 0.5) { ls += 1; }
  if (ch1h < -2) { ss += 3; } else if (ch1h < -0.5) { ss += 1; }
  if (ch24h > 5) { ls += 2; } else if (ch24h > 1) { ls += 1; }
  if (ch24h < -5) { ss += 2; } else if (ch24h < -1) { ss += 1; }
  if (position > 70) { ls += 2; }
  else if (position < 30) { ls += 2; ss += 1; }
  if (volMcap > 0.15) { if (ls > ss) ls++; else ss++; }

  var direction  = ls >= ss ? "LONG" : "SHORT";
  var scoreDiff  = Math.abs(ls - ss);
  var confidence = scoreDiff >= 5 ? "STRONG" : scoreDiff >= 3 ? "MEDIUM" : "WEAK";
  var atr = range * 0.25;
  var tp1, tp2, tp3, sl;
  if (direction === "LONG") {
    tp1=price+atr*1.5; tp2=price+atr*2.5; tp3=price+atr*4.0; sl=price-atr;
  } else {
    tp1=price-atr*1.5; tp2=price-atr*2.5; tp3=price-atr*4.0; sl=price+atr;
  }
  return {
    symbol: coin.symbol.toUpperCase(), name: coin.name, coinId: coin.id,
    price, high, low, ch24h, ch1h, vol, position,
    direction, confidence, scoreDiff, ls, ss,
    atr, tp1, tp2, tp3, sl, rr: Math.abs(tp2-price)/Math.abs(sl-price)
  };
}

async function enrichWithChart(coin) {
  try {
    await sleep(1500);
    var url  = "https://api.coingecko.com/api/v3/coins/" + coin.coinId +
               "/market_chart?vs_currency=usd&days=3&interval=hourly";
    var data = await httpGet(url);
    var prices  = data.prices.map(function(p){ return p[1]; });
    var volumes = data.total_volumes.map(function(v){ return v[1]; });
    if (prices.length < 30) return coin;

    var rsi  = calcRSI(prices);
    var ema9  = calcEMA(prices, 9);
    var ema21 = calcEMA(prices, 21);
    var ema50 = calcEMA(prices, Math.min(50, prices.length - 1));
    var ls = coin.ls, ss = coin.ss;

    if (rsi < 30) { ls += 3; } else if (rsi < 45) { ls += 1; }
    if (rsi > 70) { ss += 3; } else if (rsi > 55) { ss += 1; }
    if (coin.price > ema9)  { ls++; } else { ss++; }
    if (coin.price > ema21) { ls++; } else { ss++; }
    if (coin.price > ema50) { ls++; } else { ss++; }

    var avgVol = volumes.slice(-25,-1).reduce(function(a,b){return a+b;},0)/24;
    var volRatio = avgVol > 0 ? volumes[volumes.length-1] / avgVol : 1;
    if (volRatio > 1.5) { if (ls > ss) ls++; else ss++; }

    var direction  = ls >= ss ? "LONG" : "SHORT";
    var scoreDiff  = Math.abs(ls - ss);
    var confidence = scoreDiff >= 6 ? "STRONG" : scoreDiff >= 4 ? "MEDIUM" : "WEAK";
    var tp1, tp2, tp3, sl;
    if (direction === "LONG") {
      tp1=coin.price+coin.atr*1.5; tp2=coin.price+coin.atr*2.5;
      tp3=coin.price+coin.atr*4.0; sl=coin.price-coin.atr;
    } else {
      tp1=coin.price-coin.atr*1.5; tp2=coin.price-coin.atr*2.5;
      tp3=coin.price-coin.atr*4.0; sl=coin.price+coin.atr;
    }
    return Object.assign({}, coin, {
      rsi, ema9, ema21, ema50, volRatio,
      direction, confidence, scoreDiff, ls, ss,
      tp1, tp2, tp3, sl, rr: Math.abs(tp2-coin.price)/Math.abs(sl-coin.price),
      hasChart: true
    });
  } catch(e) {
    console.log("Chart skipped: " + e.message);
    return coin;
  }
}

function fmt(n) {
  if (!n || isNaN(n)) return "N/A";
  if (n >= 10000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 100) return n.toFixed(2);
  if (n >= 1)   return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function buildPost(s, rank, total) {
  var dir   = s.direction === "LONG" ? "LONG (BUY)" : "SHORT (SELL)";
  var sign  = s.direction === "LONG" ? "+" : "-";
  var c24s  = s.ch24h >= 0 ? "+" : "";
  var c1s   = s.ch1h  >= 0 ? "+" : "";
  var tp1p  = (Math.abs(s.tp1-s.price)/s.price*100).toFixed(1);
  var tp2p  = (Math.abs(s.tp2-s.price)/s.price*100).toFixed(1);
  var tp3p  = (Math.abs(s.tp3-s.price)/s.price*100).toFixed(1);
  var slp   = (Math.abs(s.sl -s.price)/s.price*100).toFixed(1);
  var posLbl = s.position > 70 ? "Near Day High" : s.position < 30 ? "Near Day Low" : "Mid Range";
  var now   = new Date().toUTCString();

  var lines = [
    "CRYPTO SIGNAL #" + rank + " | " + now, "",
    s.symbol + "/USDT | " + dir + " | " + s.confidence,
    "Timeframe: Hourly Chart", "",
    "Price:      " + fmt(s.price) + " USDT",
    "1h Change:  " + c1s  + s.ch1h.toFixed(2)  + "%",
    "24h Change: " + c24s + s.ch24h.toFixed(2) + "%",
    "24h High:   " + fmt(s.high),
    "24h Low:    " + fmt(s.low),
    "Position:   " + posLbl + " (" + s.position.toFixed(0) + "%)", "",
    "ENTRY:      " + fmt(s.price),
    "TP1:        " + fmt(s.tp1) + "  (" + sign + tp1p + "%)",
    "TP2:        " + fmt(s.tp2) + "  (" + sign + tp2p + "%)",
    "TP3:        " + fmt(s.tp3) + "  (" + sign + tp3p + "%)",
    "STOP LOSS:  " + fmt(s.sl)  + "  (-" + slp  + "%)",
    "R:R Ratio:  1:" + s.rr.toFixed(1), "",
    "TECHNICAL ANALYSIS:",
  ];

  if (s.hasChart) {
    var rsiLbl = s.rsi > 70 ? "Overbought" : s.rsi < 30 ? "Oversold" : "Neutral";
    var volLbl = s.volRatio > 1.5 ? "HIGH (" + s.volRatio.toFixed(1) + "x)" : "Normal";
    lines.push("RSI(14):  " + s.rsi.toFixed(1) + "  [" + rsiLbl + "]");
    lines.push("EMA 9:    " + fmt(s.ema9)  + "  [" + (s.price>s.ema9  ? "ABOVE":"BELOW") + "]");
    lines.push("EMA 21:   " + fmt(s.ema21) + "  [" + (s.price>s.ema21 ? "ABOVE":"BELOW") + "]");
    lines.push("EMA 50:   " + fmt(s.ema50) + "  [" + (s.price>s.ema50 ? "ABOVE":"BELOW") + "]");
    lines.push("Volume:   " + volLbl);
  } else {
    lines.push("1h Momentum: " + (s.ch1h >= 0 ? "Positive" : "Negative"));
    lines.push("24h Trend:   " + (s.ch24h >= 0 ? "Uptrend" : "Downtrend"));
    lines.push("Range Pos:   " + posLbl);
  }

  lines.push("", "Score: " + s.ls + " LONG vs " + s.ss + " SHORT");
  lines.push("Scanned " + total + " coins. Top signal selected.", "");
  lines.push("Not financial advice. Always use Stop Loss.");
  lines.push("#Crypto #Trading #" + s.symbol + " #BinanceSquare #CryptoSignals");
  return lines.join("\n");
}

async function main() {
  var runNum = Math.floor(Date.now() / (15 * 60 * 1000));
  var slot   = runNum % 4;
  console.log("=== Crypto Signal Bot ===");
  console.log("Time: " + new Date().toISOString());
  console.log("Slot: " + slot + " -> Signal " + (slot+1) + "/4");

  if (!BINANCE_SQUARE_API_KEY) throw new Error("BINANCE_SQUARE_API_KEY not set in GitHub Secrets!");

  console.log("\nFetching top 100 coins from CoinGecko...");
  var url = "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&order=market_cap_desc&per_page=100&page=1" +
    "&price_change_percentage=1h%2C24h&sparkline=false";
  var markets = await httpGet(url);
  console.log("Got " + markets.length + " coins");

  var scored = markets.map(scoreFromMarketData).filter(Boolean);
  scored.sort(function(a, b) {
    var co = { STRONG:3, MEDIUM:2, WEAK:1 };
    return co[b.confidence] !== co[a.confidence]
      ? co[b.confidence] - co[a.confidence]
      : b.scoreDiff - a.scoreDiff;
  });

  console.log("Top signals: " + scored.slice(0,3).map(function(s){
    return s.symbol+"("+s.direction+"/"+s.confidence+")";
  }).join(", "));

  var pick = scored[slot] || scored[0];
  console.log("Picked slot " + slot + ": " + pick.symbol);

  console.log("Fetching RSI+EMA chart for " + pick.coinId + "...");
  pick = await enrichWithChart(pick);

  var post = buildPost(pick, slot + 1, scored.length);
  console.log("\nPosting to Binance Square...");
  var res = await postToSquare(post);
  console.log("Status: " + res.status);

  if (res.body && res.body.success) {
    console.log("SUCCESS! ID: " + res.body.data.id);
    console.log("Link: " + res.body.data.shareLink);
  } else {
    throw new Error("Failed: " + JSON.stringify(res.body));
  }
}

main().catch(function(err) {
  console.error("ERROR:", err.message || err);
  process.exit(1);
});
