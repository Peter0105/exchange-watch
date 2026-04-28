import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || process.env.EXCHANGE_WATCH_PORT || 4177);
const defaultAlertThresholdKrw = Number(process.env.ALERT_THRESHOLD_KRW || 10);
const defaultAlertPreferencePercent = Number(process.env.ALERT_PREFERENCE_PERCENT || 90);
const alertPollIntervalMs = Number(process.env.ALERT_POLL_INTERVAL_MS || 60_000);
const alertCooldownMs = Number(process.env.ALERT_COOLDOWN_MS || 10 * 60_000);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatIds = (process.env.TELEGRAM_CHAT_IDS || "")
  .split(",")
  .map((chatId) => chatId.trim())
  .filter(Boolean);
const kakaoAlimtalkWebhookUrl = process.env.KAKAO_ALIMTALK_WEBHOOK_URL || "";
const kakaoAlimtalkWebhookSecret = process.env.KAKAO_ALIMTALK_WEBHOOK_SECRET || "";
const kakaoAlimtalkTemplateCode = process.env.KAKAO_ALIMTALK_TEMPLATE_CODE || "EXCHANGE_GAP_ALERT";
const kakaoAlimtalkRecipients = (process.env.KAKAO_ALIMTALK_RECIPIENTS || "")
  .split(",")
  .map((phoneNumber) => phoneNumber.trim())
  .filter(Boolean);

let lastAlert = {
  key: null,
  sentAt: 0,
  message: null,
  spread: null,
  checkedAt: null,
  error: null,
};

let alertSettings = {
  thresholdKrw: defaultAlertThresholdKrw,
  preferencePercent: defaultAlertPreferencePercent,
  updatedAt: null,
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const sources = {
  upbitTicker: "https://api.upbit.com/v1/ticker?markets=KRW-USDT",
  bithumbTicker: "https://api.bithumb.com/v1/ticker?markets=KRW-USDT",
  naverUsdKrw: "https://api.stock.naver.com/marketindex/exchange/FX_USDKRW",
  kbUsdKrw: "https://obank.kbstar.com/quics?monyCd=USD&page=C101422",
  wooriUsdKrw: "https://svc.wooribank.com/svc/Dream?withyou=CMCOM0297",
};

function todayKstYmd() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
}

function todayKstDashed() {
  const ymd = todayKstYmd();
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function hanaUrl() {
  const ymd = todayKstYmd();
  return `https://www.kebhana.com/cms/rate/wpfxd651_01i_01.do?ajax=true&curCd=USD&tmpInqStrDt=${ymd}&inqStrDt=${ymd}&pbldDvCd=0`;
}

function toNumber(value) {
  if (value == null) return null;
  const normalized = String(value).replaceAll(",", "").replace("%", "").trim();
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  const n = match ? Number(match[0]) : Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeBankNoticeTime(value) {
  if (!value) return null;
  const text = String(value).trim();

  let match = text.match(/(\d{4})년(\d{2})월(\d{2})일\s*(\d{2})시(\d{2})분(\d{2})초/);
  if (match) return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;

  match = text.match(/(\d{8})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (match) return `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)} ${match[2]}:${match[3]}:${match[4]}`;

  match = text.match(/(\d{4})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/);
  if (match) {
    const time = match[4] ? `${match[4]}:${match[5]}:${match[6]}` : "최종고시";
    return `${match[1]}-${match[2]}-${match[3]} ${time}`;
  }

  match = text.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (match) return `${todayKstDashed()} ${match[1]}:${match[2]}:${match[3]}`;

  return text.replace(/\s*\(\d+회차\)\s*/g, "").replace(/\s*기준\s*/g, "").trim();
}

function applyCashPreference(baseRate, postedRate, preferencePercent, direction) {
  const base = toNumber(baseRate);
  const posted = toNumber(postedRate);
  const pref = Math.min(100, Math.max(0, toNumber(preferencePercent) ?? 0));
  if (base == null || posted == null) return null;

  const spread = Math.abs(posted - base);
  const discountedSpread = spread * (1 - pref / 100);
  return direction === "sell"
    ? Number((base - discountedSpread).toFixed(2))
    : Number((base + discountedSpread).toFixed(2));
}

function formatKrw(value) {
  if (value == null) return "-";
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 2 }).format(value)}원`;
}

function clampNumber(value, fallback, min, max) {
  const n = toNumber(value);
  if (n == null) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "ExchangeWatch/1.0",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "ExchangeWatch/1.0",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res.json();
}

async function postJsonWithHeaders(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "ExchangeWatch/1.0",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return res.json().catch(() => ({}));
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 ExchangeWatch/1.0",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function tickerKstIso(ticker) {
  if (ticker.trade_date_kst && ticker.trade_time_kst) {
    const date = ticker.trade_date_kst;
    const time = ticker.trade_time_kst;
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00`;
  }
  return ticker.timestamp ? new Date(ticker.timestamp).toISOString() : new Date().toISOString();
}

async function getCryptoTicker(name, url) {
  const [ticker] = await fetchJson(url);
  return {
    type: "crypto",
    name,
    market: ticker.market,
    tradePrice: toNumber(ticker.trade_price),
    changeRate: Number((toNumber(ticker.signed_change_rate) * 100).toFixed(3)),
    changePrice: toNumber(ticker.signed_change_price),
    dayHigh: toNumber(ticker.high_price),
    dayLow: toNumber(ticker.low_price),
    volume24h: toNumber(ticker.acc_trade_volume_24h),
    value24h: toNumber(ticker.acc_trade_price_24h),
    timestamp: tickerKstIso(ticker),
    rawSource: url,
  };
}

function parseHanaRate(html, preferencePercent) {
  const timeMatch = html.match(/고시일시[\s\S]*?(\d{4}년\d{2}월\d{2}일)[\s\S]*?(\d{2}시\d{2}분\d{2}초)[\s\S]*?\((\d+)회차\)/);
  const usdRowMatch = html.match(/<tr>[\s\S]*?미국\s*USD[\s\S]*?<\/tr>/);
  if (!usdRowMatch) throw new Error("USD row not found");

  const cells = [...usdRowMatch[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => stripTags(match[1]));
  const cashBuy = toNumber(cells[1]);
  const cashBuySpread = toNumber(cells[2]);
  const cashSell = toNumber(cells[3]);
  const cashSellSpread = toNumber(cells[4]);
  const send = toNumber(cells[5]);
  const receive = toNumber(cells[6]);
  const baseRate = toNumber(cells[8]);

  return {
    type: "bank",
    name: "하나은행",
    currency: "USD/KRW",
    baseRate,
    cashBuy,
    cashSell,
    send,
    receive,
    cashBuySpread,
    cashSellSpread,
    preferredCashBuy: applyCashPreference(baseRate, cashBuy, preferencePercent, "buy"),
    preferredCashSell: applyCashPreference(baseRate, cashSell, preferencePercent, "sell"),
    preferencePercent,
    noticeTime: normalizeBankNoticeTime(timeMatch ? `${timeMatch[1]} ${timeMatch[2]}` : null),
    timestamp: new Date().toISOString(),
    rawSource: hanaUrl(),
  };
}

function parseKbRate(html, preferencePercent) {
  const spreadMatch = html.match(/현찰사실때 Spread[\s\S]*?<tbody>[\s\S]*?<tr>[\s\S]*?<td>([^<]+)<\/td>[\s\S]*?<td>([^<]+)<\/td>/);
  const tableIndex = html.indexOf("환율조회 결과 표");
  const firstRowMatch = tableIndex >= 0 ? html.slice(tableIndex).match(/<tbody>[\s\S]*?<tr>([\s\S]*?)<\/tr>/) : null;
  if (!firstRowMatch) throw new Error("KB USD row not found");

  const cells = [...firstRowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => stripTags(match[1]));
  const time = cells[1];
  const baseRate = toNumber(cells[2]);
  const send = toNumber(cells[4]);
  const receive = toNumber(cells[5]);
  const cashBuy = toNumber(cells[6]);
  const cashSell = toNumber(cells[7]);
  const cashBuySpread = toNumber(spreadMatch?.[1]);
  const cashSellSpread = toNumber(spreadMatch?.[2]);

  return {
    type: "bank",
    name: "KB국민은행",
    currency: "USD/KRW",
    baseRate,
    cashBuy,
    cashSell,
    send,
    receive,
    cashBuySpread,
    cashSellSpread,
    preferredCashBuy: applyCashPreference(baseRate, cashBuy, preferencePercent, "buy"),
    preferredCashSell: applyCashPreference(baseRate, cashSell, preferencePercent, "sell"),
    preferencePercent,
    noticeTime: normalizeBankNoticeTime(time ? `${todayKstYmd()} ${time}` : null),
    timestamp: new Date().toISOString(),
    rawSource: sources.kbUsdKrw,
  };
}

function parseWooriRate(html, preferencePercent) {
  const infoMatch = html.match(/조회기간\s*:[\s\S]*?<dd>([^<]+)<\/dd>[\s\S]*?통화코드[\s\S]*?<dd>\s*USD/);
  const tableIndex = html.indexOf("기간별환율 조회 결과");
  const firstRowMatch = tableIndex >= 0 ? html.slice(tableIndex).match(/<tbody>[\s\S]*?<tr>([\s\S]*?)<\/tr>/) : null;
  if (!firstRowMatch) throw new Error("Woori USD row not found");

  const cells = [...firstRowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => stripTags(match[1]));
  const date = cells[0];
  const send = toNumber(cells[1]);
  const receive = toNumber(cells[2]);
  const cashBuy = toNumber(cells[3]);
  const cashSell = toNumber(cells[4]);
  const baseRate = toNumber(cells[6]);

  return {
    type: "bank",
    name: "우리은행",
    currency: "USD/KRW",
    baseRate,
    cashBuy,
    cashSell,
    send,
    receive,
    cashBuySpread: baseRate && cashBuy ? Number((((cashBuy - baseRate) / baseRate) * 100).toFixed(2)) : null,
    cashSellSpread: baseRate && cashSell ? Number((((baseRate - cashSell) / baseRate) * 100).toFixed(2)) : null,
    preferredCashBuy: applyCashPreference(baseRate, cashBuy, preferencePercent, "buy"),
    preferredCashSell: applyCashPreference(baseRate, cashSell, preferencePercent, "sell"),
    preferencePercent,
    noticeTime: normalizeBankNoticeTime(date ?? infoMatch?.[1]?.trim()),
    timestamp: new Date().toISOString(),
    rawSource: sources.wooriUsdKrw,
  };
}

async function getNaverFallback(preferencePercent) {
  const data = await fetchJson(sources.naverUsdKrw);
  const info = data.exchangeInfo;
  const baseRate = toNumber(info.calcPrice ?? info.closePrice);
  return {
    type: "bank",
    name: "하나은행",
    currency: "USD/KRW",
    baseRate,
    cashBuy: null,
    cashSell: null,
    send: null,
    receive: null,
    preferredCashBuy: baseRate,
    preferredCashSell: baseRate,
    preferencePercent,
    noticeTime: normalizeBankNoticeTime(info.localTradedAt),
    timestamp: new Date().toISOString(),
    warning: "하나은행 상세 환율 파싱 실패로 네이버 매매기준율만 표시합니다.",
    rawSource: sources.naverUsdKrw,
  };
}

async function getBankRates(preferencePercent) {
  const results = await Promise.allSettled([
    fetchText(hanaUrl()).then((html) => parseHanaRate(html, preferencePercent)),
    fetchText(sources.kbUsdKrw).then((html) => parseKbRate(html, preferencePercent)),
    fetchText(sources.wooriUsdKrw).then((html) => parseWooriRate(html, preferencePercent)),
  ]);

  const banks = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  if (banks.length) {
    for (const result of results) {
      if (result.status === "rejected") {
        banks.push({
          type: "bank",
          name: "은행 커넥터",
          currency: "USD/KRW",
          warning: `일부 은행 환율 조회 실패: ${result.reason.message}`,
          timestamp: new Date().toISOString(),
        });
      }
    }
    return banks;
  }

  const fallback = await getNaverFallback(preferencePercent);
  const reason = results.find((result) => result.status === "rejected")?.reason?.message;
  fallback.warning = `${fallback.warning}${reason ? ` (${reason})` : ""}`;
  return [fallback];
}

async function getRates(requestUrl) {
  const preferencePercent = Math.min(100, Math.max(0, toNumber(requestUrl.searchParams.get("preference")) ?? 80));
  const [banks, upbit, bithumb] = await Promise.all([
    getBankRates(preferencePercent),
    getCryptoTicker("업비트 USDT", sources.upbitTicker),
    getCryptoTicker("빗썸 USDT", sources.bithumbTicker),
  ]);

  const crypto = [upbit, bithumb];
  const bankBestBuy = banks.filter((bank) => bank.preferredCashBuy != null).sort((a, b) => a.preferredCashBuy - b.preferredCashBuy)[0] ?? null;
  const bestUsdt = crypto.filter((item) => item.tradePrice != null).sort((a, b) => a.tradePrice - b.tradePrice)[0] ?? null;

  return {
    asOf: new Date().toISOString(),
    preferencePercent,
    banks,
    crypto,
    summary: {
      bankBestBuy,
      bestUsdt,
      usdtVsBankBest: bankBestBuy && bestUsdt ? Number((bestUsdt.tradePrice - bankBestBuy.preferredCashBuy).toFixed(2)) : null,
      upbitBithumbGap: upbit.tradePrice != null && bithumb.tradePrice != null ? Number((upbit.tradePrice - bithumb.tradePrice).toFixed(2)) : null,
    },
    notes: [
      "은행 우대율은 현찰 살 때/팔 때 스프레드에 적용됩니다.",
      "거래소 USDT 가격은 공개 현재가 API 기준이며, 실제 주문 체결가는 호가와 수수료에 따라 달라집니다.",
    ],
  };
}

function getComparableRates(data) {
  const bankItems = data.banks
    .filter((bank) => bank.preferredCashBuy != null)
    .map((bank) => ({
      name: `${bank.name} 우대 매수가`,
      value: bank.preferredCashBuy,
      sourceType: "bank",
    }));
  const cryptoItems = data.crypto
    .filter((item) => item.tradePrice != null)
    .map((item) => ({
      name: item.name,
      value: item.tradePrice,
      sourceType: "crypto",
    }));
  return [...bankItems, ...cryptoItems].sort((a, b) => a.value - b.value);
}

function buildAlert(data) {
  const items = getComparableRates(data);
  if (items.length < 2) return null;

  const low = items[0];
  const high = items[items.length - 1];
  const spread = Number((high.value - low.value).toFixed(2));
  if (spread < alertSettings.thresholdKrw) return null;

  const middle = items
    .slice(1, -1)
    .map((item) => `- ${item.name}: ${formatKrw(item.value)}`)
    .join("\n");
  const message = [
    `[Exchange Watch] ${formatKrw(spread)} 차이 감지`,
    `낮음: ${low.name} ${formatKrw(low.value)}`,
    `높음: ${high.name} ${formatKrw(high.value)}`,
    middle ? `\n나머지:\n${middle}` : "",
    `\n우대율: ${data.preferencePercent}%`,
    `기준시각: ${new Date(data.asOf).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    key: `${low.name}:${high.name}:${Math.floor(spread)}`,
    spread,
    low,
    high,
    message,
  };
}

async function sendKakaoAlimtalk(alert, data) {
  if (!kakaoAlimtalkWebhookUrl || kakaoAlimtalkRecipients.length === 0) {
    return { skipped: true, reason: "KAKAO_ALIMTALK_WEBHOOK_URL 또는 KAKAO_ALIMTALK_RECIPIENTS가 설정되지 않았습니다." };
  }

  await postJsonWithHeaders(
    kakaoAlimtalkWebhookUrl,
    {
      channel: "kakao_alimtalk",
      templateCode: kakaoAlimtalkTemplateCode,
      recipients: kakaoAlimtalkRecipients,
      message: alert.message,
      variables: {
        spread: formatKrw(alert.spread),
        lowName: alert.low.name,
        lowPrice: formatKrw(alert.low.value),
        highName: alert.high.name,
        highPrice: formatKrw(alert.high.value),
        preferencePercent: `${data.preferencePercent}%`,
        asOf: new Date(data.asOf).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
      },
    },
    kakaoAlimtalkWebhookSecret ? { authorization: `Bearer ${kakaoAlimtalkWebhookSecret}` } : {},
  );
  return { skipped: false };
}

async function sendTelegram(message) {
  if (!telegramBotToken || telegramChatIds.length === 0) {
    return { skipped: true, reason: "TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_IDS가 설정되지 않았습니다." };
  }

  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  await Promise.all(
    telegramChatIds.map((chatId) =>
      postJson(url, {
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    ),
  );
  return { skipped: false };
}

async function checkAlerts() {
  const requestUrl = new URL(`http://localhost/api/rates?preference=${alertSettings.preferencePercent}`);
  try {
    const data = await getRates(requestUrl);
    const alert = buildAlert(data);
    lastAlert.checkedAt = new Date().toISOString();
    lastAlert.error = null;

    if (!alert) {
      lastAlert.spread = null;
      return;
    }

    const now = Date.now();
    const isSameAlert = lastAlert.key === alert.key;
    const isCoolingDown = now - lastAlert.sentAt < alertCooldownMs;
    lastAlert.spread = alert.spread;
    lastAlert.message = alert.message;

    if (isSameAlert && isCoolingDown) return;

    const result = kakaoAlimtalkWebhookUrl
      ? await sendKakaoAlimtalk(alert, data)
      : await sendTelegram(alert.message);
    lastAlert.key = alert.key;
    lastAlert.sentAt = now;
    if (result.skipped) lastAlert.error = result.reason;
  } catch (error) {
    lastAlert.checkedAt = new Date().toISOString();
    lastAlert.error = error.message;
  }
}

async function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (requestUrl.pathname === "/api/rates") {
      const body = await getRates(requestUrl);
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(body));
      return;
    }

    if (requestUrl.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (requestUrl.pathname === "/api/alerts/status") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          enabled: Boolean(telegramBotToken && telegramChatIds.length),
          kakaoAlimtalkEnabled: Boolean(kakaoAlimtalkWebhookUrl && kakaoAlimtalkRecipients.length),
          telegramEnabled: Boolean(telegramBotToken && telegramChatIds.length),
          thresholdKrw: alertSettings.thresholdKrw,
          preferencePercent: alertSettings.preferencePercent,
          settingsUpdatedAt: alertSettings.updatedAt,
          pollIntervalMs: alertPollIntervalMs,
          cooldownMs: alertCooldownMs,
          lastAlert,
        }),
      );
      return;
    }

    if (requestUrl.pathname === "/api/alerts/settings" && req.method === "POST") {
      const body = await readRequestBody(req);
      alertSettings = {
        thresholdKrw: clampNumber(body.thresholdKrw, alertSettings.thresholdKrw, 0, 500),
        preferencePercent: clampNumber(body.preferencePercent, alertSettings.preferencePercent, 0, 100),
        updatedAt: new Date().toISOString(),
      };
      lastAlert = {
        ...lastAlert,
        key: null,
        sentAt: 0,
      };
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, settings: alertSettings }));
      checkAlerts();
      return;
    }

    await serveStatic(requestUrl.pathname, res);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Exchange Watch running at http://localhost:${port}`);
  console.log(`Alert monitor: threshold ${alertSettings.thresholdKrw} KRW, preference ${alertSettings.preferencePercent}%, interval ${alertPollIntervalMs}ms`);
  checkAlerts();
  setInterval(checkAlerts, alertPollIntervalMs);
});
