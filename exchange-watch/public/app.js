const formatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 2,
});

const compact = new Intl.NumberFormat("ko-KR", {
  maximumFractionDigits: 2,
});

const els = {
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  preference: document.querySelector("#preference"),
  preferenceValue: document.querySelector("#preferenceValue"),
  interval: document.querySelector("#interval"),
  refresh: document.querySelector("#refresh"),
  bestUsdt: document.querySelector("#bestUsdt"),
  bestUsdtSource: document.querySelector("#bestUsdtSource"),
  bestBankBuy: document.querySelector("#bestBankBuy"),
  bestBankSource: document.querySelector("#bestBankSource"),
  premiumGap: document.querySelector("#premiumGap"),
  exchangeGap: document.querySelector("#exchangeGap"),
  bankUpdated: document.querySelector("#bankUpdated"),
  cryptoUpdated: document.querySelector("#cryptoUpdated"),
  bankRows: document.querySelector("#bankRows"),
  cryptoRows: document.querySelector("#cryptoRows"),
  notes: document.querySelector("#notes"),
  asOf: document.querySelector("#asOf"),
};

let timer = null;
let saveTimer = null;

function money(value) {
  return value == null ? "-" : formatter.format(value);
}

function number(value) {
  return value == null ? "-" : compact.format(value);
}

function localTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function setStatus(kind, text) {
  els.statusDot.className = `dot ${kind}`;
  els.statusText.textContent = text;
}

function renderSummary(data) {
  const { bestUsdt, bankBestBuy, usdtVsBankBest, upbitBithumbGap } = data.summary;
  els.bestUsdt.textContent = money(bestUsdt?.tradePrice);
  els.bestUsdtSource.textContent = bestUsdt?.name ?? "-";
  els.bestBankBuy.textContent = money(bankBestBuy?.preferredCashBuy);
  els.bestBankSource.textContent = bankBestBuy?.name ?? "-";
  els.premiumGap.textContent = money(usdtVsBankBest);
  els.exchangeGap.textContent = money(upbitBithumbGap);
}

function renderBanks(banks) {
  els.bankRows.innerHTML = banks
    .map((bank) => {
      if (bank.warning) {
        return `<tr><td colspan="7" class="warning">${bank.warning}</td></tr>`;
      }

      return `
        <tr>
          <td><strong>${bank.name}</strong><br><small>${bank.noticeTime ?? ""}</small></td>
          <td>${money(bank.baseRate)}</td>
          <td>${money(bank.cashBuy)}<br><small>${number(bank.cashBuySpread)}%</small></td>
          <td><strong>${money(bank.preferredCashBuy)}</strong></td>
          <td>${money(bank.cashSell)}<br><small>${number(bank.cashSellSpread)}%</small></td>
          <td><strong>${money(bank.preferredCashSell)}</strong></td>
          <td>보낼 때 ${money(bank.send)}<br><small>받을 때 ${money(bank.receive)}</small></td>
        </tr>
      `;
    })
    .join("");

  els.bankUpdated.textContent = banks[0] ? localTime(banks[0].timestamp) : "-";
}

function renderCrypto(crypto) {
  els.cryptoRows.innerHTML = crypto
    .map((item) => {
      const changeClass = item.changePrice > 0 ? "up" : item.changePrice < 0 ? "down" : "";
      const sign = item.changePrice > 0 ? "+" : "";
      return `
        <article class="exchange-card">
          <div>
            <h3>${item.name}</h3>
            <p>고가 ${money(item.dayHigh)} · 저가 ${money(item.dayLow)} · 24h ${number(item.volume24h)} USDT</p>
          </div>
          <div class="price">
            ${money(item.tradePrice)}
            <span class="change ${changeClass}">${sign}${money(item.changePrice)} · ${sign}${number(item.changeRate)}%</span>
          </div>
        </article>
      `;
    })
    .join("");

  els.cryptoUpdated.textContent = crypto[0] ? localTime(crypto[0].timestamp) : "-";
}

function renderNotes(data) {
  const warnings = [...data.banks, ...data.crypto].filter((item) => item.warning).map((item) => item.warning);
  els.notes.innerHTML = [...warnings.map((warning) => `<div class="warning">${warning}</div>`), ...data.notes.map((note) => `<div>${note}</div>`)].join("");
  els.asOf.textContent = `마지막 갱신 ${localTime(data.asOf)}`;
}

async function loadRates() {
  const preference = els.preference.value;
  els.preferenceValue.textContent = preference;
  setStatus("", "갱신 중");

  try {
    const res = await fetch(`/api/rates?preference=${preference}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    renderSummary(data);
    renderBanks(data.banks);
    renderCrypto(data.crypto);
    renderNotes(data);
    setStatus("live", `실시간 연결 · ${localTime(data.asOf)}`);
  } catch (error) {
    setStatus("error", `오류: ${error.message}`);
  }
}

async function loadAlertStatus() {
  try {
    const res = await fetch("/api/alerts/status", { cache: "no-store" });
    if (!res.ok) return;
    const status = await res.json();
    if (status.preferencePercent != null) {
      els.preference.value = status.preferencePercent;
      els.preferenceValue.textContent = status.preferencePercent;
    }
  } catch {
    // The dashboard can still work even when alert status is unavailable.
  }
}

async function saveAlertSettings() {
  const preferencePercent = Number(els.preference.value);
  try {
    const res = await fetch("/api/alerts/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ preferencePercent }),
    });
    if (!res.ok) throw new Error(`설정 저장 실패 ${res.status}`);
    setStatus("live", `알림 기준 저장 · 우대 ${preferencePercent}%`);
  } catch (error) {
    setStatus("error", error.message);
  }
}

function queueSaveAlertSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAlertSettings, 350);
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = setInterval(loadRates, Number(els.interval.value));
}

els.preference.addEventListener("input", () => {
  els.preferenceValue.textContent = els.preference.value;
  queueSaveAlertSettings();
});
els.preference.addEventListener("change", () => {
  saveAlertSettings();
  loadRates();
});
els.interval.addEventListener("change", schedule);
els.refresh.addEventListener("click", loadRates);

schedule();
await loadAlertStatus();
loadRates();
