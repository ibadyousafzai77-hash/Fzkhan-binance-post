const https = require("https");
const http  = require("http");

const BINANCE_SQUARE_API_KEY = process.env.BINANCE_SQUARE_API_KEY;
const SQUARE_URL = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

const SCAN_COINS = [
  "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
  "AVAXUSDT", "LINKUSDT", "DOTUSDT",  "ADAUSDT",  "NEARUSDT",
  "INJUSDT",  "SUIUSDT",  "JUPUSDT",  "TIAUSDT",  "SEIUSDT",
  "APTUSDT",  "OPUSDT",   "ARBUSDT",  "LDOUSDT",  "FETUSDT",
  "WIFUSDT",  "BONKUSDT", "RENDERUSDT","AAVEUSDT", "PENDLEUSDT"
];

function httpGet(url) {
  return new Promise(function(resolve, reject) {
    var mod = url.startsWith("https") ? https : http;
    var req = mod.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, function(res) {
      var data = "";
      res.on("data", function(c) { data += c; });
      res.on("end", function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("JSON parse error: " + data.slice(0,100))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(12000, function() { req.destroy(); reject(new Error("Timeout")); });
  });
}

function postJSON(urlStr, payload, headers) {
  return new Promise(function(resolve, reject) {
    var body = Buffer.from(JSON.stringify(payload), "utf8");
    var u    = new URL(urlStr);
    var opts = {
      hostname: u.hostname, port: 443, path: u.pathname, method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": body.length }, headers || {})
    };
    var req = https.request(opts, function(res) {
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

function calcRSI(closes, period) {
  period = period || 14;
  if (closes.length < period + 1) return 50;
  var gains = [], losses = [];
  for (var i = 1; i < closes.length; i++) {
    var d = closes[i] - closes[i-1];
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
  return 100 - 100/(1+ag/al);
}

function calcEMA(arr, period) {
  var k = 2/(period+1), ema = arr[0];
  for (var i = 1; i < arr.length; i++) { ema = arr[i]*k + ema*(1-k); }
  return ema;
}

function calcMACD(closes) {
  var k12=2/13, k26=2/27, e12=closes[0], e26=closes[0], mv=[];
  for (var i = 0; i < closes.length; i++) {
    e12=closes[i]*k12+e12*(1-k12); e26=closes[i]*k26+e26*(1-k26); mv.push(e12-e26);
  }
  return { macd: mv[mv.length-1], signal: calcEMA(mv, 9) };
}

function calcATR(highs, lows, period) {
  period = period||14; var sum=0, n=0;
  for (var i=highs.length-period; i<highs.length; i++) { sum+=highs[i]-lows[i]; n++; }
  return n>0 ? sum/n : 0;
}

function fmt(n) {
  if (n>=10000) return n.toLocaleString("en-US",{maximumFractionDigits:0});
  if (n>=100) return n.toFixed(2);
  if (n>=1)   return n.toFixed(3);
  if (n>=0.01) return n.toFixed(4);
  return n.toFixed(6);
}

async function analyseCoin(symbol) {
  var url = "https://api.binance.com/api/v3/klines?symbol="+symbol+"&interval=15m&limit=100";
  var klines = await httpGet(url);
  if (!klines || klines.length < 60) throw new Error("Not enough data");

  var opens=klines.map(function(k){return parseFloat(k[1]);});
  var highs=klines.map(function(k){return parseFloat(k[2]);});
  var lows=klines.map(function(k){return parseFloat(k[3]);});
  var closes=klines.map(function(k){return parseFloat(k[4]);});
  var volumes=klines.map(function(k){return parseFloat(k[5]);});

  var price=closes[closes.length-1];
  var rsi=calcRSI(closes);
  var ema9=calcEMA(closes,9), ema21=calcEMA(closes,21), ema50=calcEMA(closes,50);
  var md=calcMACD(closes);
  var atr=calcATR(highs,lows,14);
  var rv=volumes.slice(-20,-1).reduce(function(a,b){return a+b;},0)/19;
  var volRatio=rv>0?volumes[volumes.length-1]/rv:1;
  var l3b=0;
  for(var i=-3;i<0;i++){if(closes[closes.length+i]>opens[opens.length+i])l3b++;}

  var ls=0,ss=0;
  if(rsi<30){ls+=3;}else if(rsi<45){ls+=1;}
  if(rsi>70){ss+=3;}else if(rsi>55){ss+=1;}
  if(md.macd>md.signal){ls+=2;}else{ss+=2;}
  if(price>ema9){ls++;}else{ss++;}
  if(price>ema21){ls++;}else{ss++;}
  if(price>ema50){ls++;}else{ss++;}
  if(volRatio>1.5){if(ls>ss)ls++;else ss++;}
  if(l3b>=2){ls++;}else{ss++;}

  var direction=ls>=ss?"LONG":"SHORT";
  var sd=Math.abs(ls-ss);
  var conf=sd>=5?"STRONG":sd>=3?"MEDIUM":"WEAK";
  var tp1,tp2,tp3,sl;
  if(direction==="LONG"){tp1=price+atr*1.5;tp2=price+atr*2.5;tp3=price+atr*4;sl=price-atr;}
  else{tp1=price-atr*1.5;tp2=price-atr*2.5;tp3=price-atr*4;sl=price+atr;}
  var rr=Math.abs(tp2-price)/Math.abs(sl-price);
  var c1h=(closes[closes.length-1]-closes[closes.length-5])/closes[closes.length-5]*100;
  var c24h=(closes[closes.length-1]-closes[closes.length-97])/closes[closes.length-97]*100;

  return {
    symbol,price,direction,conf,sd,ls,ss,rsi,ema9,ema21,ema50,
    macd:md.macd,macdSig:md.signal,volRatio,atr,l3b,tp1,tp2,tp3,sl,rr,
    support:Math.min.apply(null,lows.slice(-20)),
    resistance:Math.max.apply(null,highs.slice(-20)),
    c1h,c24h
  };
}

async function scanMarket() {
  console.log("Scanning "+SCAN_COINS.length+" coins...");
  var results=[];
  for(var i=0;i<SCAN_COINS.length;i++){
    try{var r=await analyseCoin(SCAN_COINS[i]);results.push(r);process.stdout.write(".");}
    catch(e){process.stdout.write("x");}
  }
  console.log(" done");
  results.sort(function(a,b){
    var co={STRONG:3,MEDIUM:2,WEAK:1};
    return co[b.conf]!==co[a.conf]?co[b.conf]-co[a.conf]:b.sd-a.sd;
  });
  return results;
}

function buildPost(s, rank, total) {
  var dir=s.direction==="LONG"?"LONG (BUY)":"SHORT (SELL)";
  var sign=s.direction==="LONG"?"+":"-";
  var c24s=s.c24h>=0?"+":"", c1s=s.c1h>=0?"+":"";
  var tp1p=(Math.abs(s.tp1-s.price)/s.price*100).toFixed(1);
  var tp2p=(Math.abs(s.tp2-s.price)/s.price*100).toFixed(1);
  var tp3p=(Math.abs(s.tp3-s.price)/s.price*100).toFixed(1);
  var slp=(Math.abs(s.sl-s.price)/s.price*100).toFixed(1);
  var rsiL=s.rsi>70?"Overbought":s.rsi<30?"Oversold":"Neutral";
  var macdL=s.macd>s.macdSig?"Bullish":"Bearish";
  var volL=s.volRatio>1.5?"HIGH ("+s.volRatio.toFixed(1)+"x)":"Normal";
  var coin=s.symbol.replace("USDT","");
  var now=new Date().toUTCString();

  return [
    "CRYPTO SIGNAL #"+rank+" | "+now,
    "",
    s.symbol+" | "+dir+" | "+s.conf,
    "Timeframe: 15-Minute Chart",
    "",
    "Price:      "+fmt(s.price)+" USDT",
    "1h Change:  "+c1s+s.c1h.toFixed(2)+"%",
    "24h Change: "+c24s+s.c24h.toFixed(2)+"%",
    "",
    "ENTRY:      "+fmt(s.price),
    "TP1:        "+fmt(s.tp1)+"  ("+sign+tp1p+"%)",
    "TP2:        "+fmt(s.tp2)+"  ("+sign+tp2p+"%)",
    "TP3:        "+fmt(s.tp3)+"  ("+sign+tp3p+"%)",
    "STOP LOSS:  "+fmt(s.sl)+"  (-"+slp+"%)",
    "R:R Ratio:  1:"+s.rr.toFixed(1),
    "",
    "TECHNICAL ANALYSIS:",
    "RSI(14):  "+s.rsi.toFixed(1)+"  ["+rsiL+"]",
    "MACD:     "+macdL,
    "EMA 9:    "+fmt(s.ema9)+"  ["+(s.price>s.ema9?"ABOVE":"BELOW")+"]",
    "EMA 21:   "+fmt(s.ema21)+"  ["+(s.price>s.ema21?"ABOVE":"BELOW")+"]",
    "EMA 50:   "+fmt(s.ema50)+"  ["+(s.price>s.ema50?"ABOVE":"BELOW")+"]",
    "Volume:   "+volL,
    "Candles:  "+s.l3b+"/3 bullish",
    "Support:  "+fmt(s.support),
    "Resist:   "+fmt(s.resistance),
    "",
    "Score: "+s.ls+" LONG vs "+s.ss+" SHORT",
    "Scanned "+total+" coins. Best signal selected.",
    "",
    "Not financial advice. Always use Stop Loss.",
    "#Crypto #Trading #"+coin+" #BinanceSquare #CryptoSignals"
  ].join("\n");
}

async function postToSquare(content) {
  if(!BINANCE_SQUARE_API_KEY) throw new Error("BINANCE_SQUARE_API_KEY not set in GitHub Secrets!");
  var res=await postJSON(SQUARE_URL,{bodyTextOnly:content},{"X-Square-OpenAPI-Key":BINANCE_SQUARE_API_KEY});
  return res;
}

async function main() {
  var runNum=Math.floor(Date.now()/(15*60*1000));
  var slot=runNum%4;
  console.log("=== Crypto Signal Bot ===");
  console.log("Time: "+new Date().toISOString());
  console.log("Slot: "+slot+" (Signal "+(slot+1)+"/4 this hour)");
  console.log();

  if(!BINANCE_SQUARE_API_KEY) throw new Error("BINANCE_SQUARE_API_KEY missing in GitHub Secrets!");

  var results=await scanMarket();
  console.log("Scanned: "+results.length+" coins");
  if(results.length===0) throw new Error("No coin data");

  var pick=results[slot]||results[0];
  var post=buildPost(pick,slot+1,results.length);

  console.log("Signal: "+pick.symbol+" "+pick.direction+" ["+pick.conf+"] | "+fmt(pick.price));
  console.log("Posting to Binance Square...");

  var res=await postToSquare(post);
  console.log("Status: "+res.status);

  if(res.body&&res.body.success){
    console.log("SUCCESS! Post ID: "+res.body.data.id);
    console.log("Link: "+res.body.data.shareLink);
  } else {
    throw new Error("Failed: "+JSON.stringify(res.body));
  }
}

main().catch(function(err){
  console.error("ERROR:",err.message||err);
  process.exit(1);
});
