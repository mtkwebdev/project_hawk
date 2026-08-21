import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, AreaChart, LineChart, Area, Line, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from "recharts";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon, PanelLeftOpen, PanelLeftClose, Sun, Moon, TrendingUp, Zap } from "lucide-react";

/* ============================================================================
   PROJECT HAWK — project finance model, ported from the original workbook
   (Inputs / Calc / FS / Solver / Summary) into a sequential JS calc engine.

   ENGINE NOTE ON CIRCULARITY
   The workbook carried a "Solver" sheet (Copy / Paste / Delta) — Excel's manual
   trick for breaking a circular reference. Tracing the actual dependencies here
   (Interest depends only on the *opening* debt balance, which is fixed by the
   prior period's close) shows the chain is directed, not circular: each period
   depends only on the period before it. So this engine just computes period 0,
   then 1, then 2, ... in order — no iteration or convergence loop needed.

   SIMPLIFICATIONS vs the original workbook (documented, not hidden):
   - Construction draw curve replicated exactly (EPC/Dev/Insurance: flat 1/12
     per month; SPV costs: 50/50 in the last two construction months).
   - FS/Balance-sheet section is a compact reconstruction (assets/liabilities/
     equity roll-forward), not a cell-for-cell port of every FS row.
   ========================================================================== */

// ---------------------------------------------------------------------------
// Generic utilities (cover the ~50 repetitive "row total / link / negate"
// formulas from the original workbook — one function each, reused everywhere)
// ---------------------------------------------------------------------------
const sumRange = (arr, from, to) => arr.slice(from, to + 1).reduce((a, b) => a + b, 0);
const negate = (x) => -x;
const add = (a, b) => a + b;
const subtract = (a, b) => a - b;
const clamp0 = (x) => Math.max(x, 0);

const addMonths = (date, n) => {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d;
};
const endOfMonth = (date) => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return d;
};
const fmtDate = (d) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Domain functions — the ~38 pieces of genuine business logic in the model
// ---------------------------------------------------------------------------

function computePpaEnd(codDate, ppaTermYears) {
  const d = new Date(codDate);
  d.setUTCFullYear(d.getUTCFullYear() + ppaTermYears);
  d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function generatePeriods(inputs) {
  const { fcDate, codDate, ppaTermYears, monthsInYear, semiAnnualPeriods } = inputs;
  const periods = [];
  let cursor = new Date(fcDate);
  const constructionMonths = monthsInYear; // 12 months of construction, per Inputs sheet
  for (let i = 0; i < constructionMonths; i++) {
    periods.push({
      index: i, phase: "construction",
      periodFrom: new Date(cursor), periodTo: endOfMonth(cursor),
      yearFraction: 1 / monthsInYear,
    });
    cursor = addMonths(cursor, 1);
  }
  const operationPeriods = ppaTermYears * semiAnnualPeriods;
  cursor = new Date(codDate);
  for (let i = 0; i < operationPeriods; i++) {
    const periodTo = addMonths(cursor, 12 / semiAnnualPeriods);
    periodTo.setUTCDate(periodTo.getUTCDate() - 1);
    periods.push({
      index: constructionMonths + i, phase: "operation",
      periodFrom: new Date(cursor), periodTo,
      yearFraction: 1 / semiAnnualPeriods,
    });
    cursor = addMonths(cursor, 12 / semiAnnualPeriods);
  }
  return periods;
}

function computeFlags(period, i) {
  return {
    isConstruction: period.phase === "construction",
    isOperation: period.phase === "operation",
    isFinancialClose: i === 0,
  };
}

// EPC / Dev / Insurance(construction): flat 1/12 per construction month.
// SPV costs: back-loaded 50/50 in the last two construction months.
function drawPct(kind, monthIndexInConstruction, constructionMonths) {
  if (kind === "spv") {
    return monthIndexInConstruction >= constructionMonths - 2 ? 0.5 : 0;
  }
  return 1 / constructionMonths;
}

function computeConstructionCostPeriod(inputs, monthIndexInConstruction) {
  const cm = inputs.monthsInYear;
  const epc = inputs.epcPrice * drawPct("epc", monthIndexInConstruction, cm);
  const dev = inputs.developmentCosts * drawPct("dev", monthIndexInConstruction, cm);
  const ins = inputs.insuranceConstruction * drawPct("ins", monthIndexInConstruction, cm);
  const spv = inputs.spvCostsConstruction * drawPct("spv", monthIndexInConstruction, cm);
  return { epc, dev, ins, spv, total: epc + dev + ins + spv };
}

// --- Construction-phase funding solve -------------------------------------
// The genuinely circular part of the model: each period's "funding required"
// includes that period's capitalised interest + fees, which depend on the
// debt balance, which depends on gearing, which depends on total funding
// required across ALL periods (interest and fees included). The original
// workbook broke this with a manual copy/paste/delta trick (see "Solver"
// sheet). Here we just iterate to a fixed point directly — a few passes
// converge to machine precision.
function solveConstructionFunding(inputs) {
  const cm = inputs.monthsInYear;
  const pureCapex = [];
  for (let t = 0; t < cm; t++) pureCapex.push(computeConstructionCostPeriod(inputs, t));

  let gearing = inputs.facilitySize / pureCapex.reduce((a, c) => a + c.total, 0);
  let periods = [];
  for (let iter = 0; iter < 50; iter++) {
    let debtOpening = 0;
    let totalFunding = 0;
    periods = [];
    for (let t = 0; t < cm; t++) {
      const capex = pureCapex[t].total;
      const interest = computeSeniorDebtInterest(debtOpening, inputs.interestRate, 1 / cm);
      const upfrontFee = computeUpfrontFee(inputs.facilitySize, inputs.upfrontFeePct, t === 0);
      const commitmentFee = computeCommitmentFee(inputs.facilitySize, debtOpening, inputs.commitmentFeePct, 1 / cm, true);
      const periodFunding = capex + interest + upfrontFee + commitmentFee;
      const drawdown = periodFunding * gearing;
      const shareInjection = periodFunding - drawdown;
      const closingBalance = debtOpening + drawdown;
      periods.push({ capex, interest, upfrontFee, commitmentFee, periodFunding, drawdown, shareInjection, debtOpening, closingBalance });
      debtOpening = closingBalance;
      totalFunding += periodFunding;
    }
    const nextGearing = inputs.facilitySize / totalFunding;
    if (Math.abs(nextGearing - gearing) < 1e-12) { gearing = nextGearing; break; }
    gearing = nextGearing;
  }
  const totalFundingRequired = periods.reduce((a, p) => a + p.periodFunding, 0);
  return { periods, gearing, totalFundingRequired, pureCapexTotal: pureCapex.reduce((a, c) => a + c.total, 0) };
}

const computeAnnualisedLineItem = (annualAmount, yearFraction, isOperation) =>
  isOperation ? annualAmount * yearFraction : 0;

// The longest / trickiest formula from the audit: blends monthly (construction)
// and semi-annual (operation) day-count conventions via mutually-exclusive flags.
function computeSeniorDebtInterest(openingBalance, annualRate, yearFraction) {
  return openingBalance * annualRate * yearFraction;
}

const computeUpfrontFee = (facilitySize, feePct, isFinancialClose) =>
  isFinancialClose ? facilitySize * feePct : 0;

const computeCommitmentFee = (facilitySize, openingBalance, feePct, yearFraction, isConstruction) =>
  isConstruction ? (facilitySize - openingBalance) * feePct * yearFraction : 0;

const computeDepreciation = (totalCapitalisedCost, operationPeriods, isOperation) =>
  isOperation ? totalCapitalisedCost / operationPeriods : 0;

const computeEbt = (ebitda, depreciation, interest, upfrontFee, commitmentFee) =>
  ebitda - depreciation - interest - upfrontFee - commitmentFee;

const computeTax = (ebt, citRate) => clamp0(ebt * citRate);

const computeCfads = (revenue, opex, tax) => revenue - opex - tax;

const computeMaxRepaymentAllowed = (cfads, dscrTarget, interest, isOperation) =>
  isOperation ? cfads / dscrTarget - interest : 0;

const computeActualRepayment = (maxRepaymentAllowed, availableBalance) =>
  Math.min(clamp0(maxRepaymentAllowed), availableBalance);

const computeClosingBalance = (opening, drawdown, repayment) => opening + drawdown - repayment;

const computeDscr = (isOperation, cfads, interest, repayment) =>
  isOperation && interest + repayment > 0 ? cfads / (interest + repayment) : null;

const computeDividends = (cashAvailableForDistribution) => clamp0(cashAvailableForDistribution);

// XIRR via Newton-Raphson on an XNPV root
function xnpv(rate, cashflows, dates) {
  const d0 = dates[0].getTime();
  return cashflows.reduce(
    (acc, cf, i) => acc + cf / Math.pow(1 + rate, (dates[i].getTime() - d0) / (365 * 86400000)),
    0
  );
}
function xirr(cashflows, dates, guess = 0.12) {
  let rate = guess;
  for (let iter = 0; iter < 200; iter++) {
    const f = xnpv(rate, cashflows, dates);
    const h = 1e-6;
    const df = (xnpv(rate + h, cashflows, dates) - f) / h;
    if (Math.abs(df) < 1e-10) break;
    const next = rate - f / df;
    if (!isFinite(next)) break;
    if (Math.abs(next - rate) < 1e-9) { rate = next; break; }
    rate = next;
  }
  return rate;
}

// ---------------------------------------------------------------------------
// Full model run
// ---------------------------------------------------------------------------
function runModel(inputs) {
  const periods = generatePeriods(inputs);
  const constructionMonths = inputs.monthsInYear;
  const operationPeriods = inputs.ppaTermYears * inputs.semiAnnualPeriods;

  // Solve the circular construction-funding sub-problem once, up front.
  const construction = solveConstructionFunding(inputs);
  const { gearing, totalFundingRequired, pureCapexTotal } = construction;
  const depreciationBase = pureCapexTotal; // PP&E base excludes capitalised IDC/fees

  const annualOpex = inputs.omCost + inputs.insuranceOps + inputs.spvCostsOps;
  const annualRevenue = inputs.tariff * inputs.generation;

  let debtOpening = 0;
  let ppeBalance = 0;
  let cashBalance = 0;
  let shareCapitalBalance = 0;
  let retainedEarnings = 0;

  const equityCashflows = [];
  const equityDates = [];
  const rows = [];

  periods.forEach((period, i) => {
    const flags = computeFlags(period, i);

    let capex, drawdown, shareInjection, interest, upfrontFee, commitmentFee, closingBalance;

    if (flags.isConstruction) {
      const c = construction.periods[i];
      capex = c.capex; drawdown = c.drawdown; shareInjection = c.shareInjection;
      interest = c.interest; upfrontFee = c.upfrontFee; commitmentFee = c.commitmentFee;
      closingBalance = c.closingBalance;
    } else {
      capex = 0; drawdown = 0; shareInjection = 0; upfrontFee = 0; commitmentFee = 0;
      interest = computeSeniorDebtInterest(debtOpening, inputs.interestRate, period.yearFraction);
    }

    const revenue = computeAnnualisedLineItem(annualRevenue, period.yearFraction, flags.isOperation);
    const opex = computeAnnualisedLineItem(annualOpex, period.yearFraction, flags.isOperation);
    const ebitda = revenue - opex;
    const depreciation = computeDepreciation(depreciationBase, operationPeriods, flags.isOperation);
    const ebt = computeEbt(ebitda, depreciation, interest, upfrontFee, commitmentFee);
    const tax = computeTax(ebt, inputs.citRate);
    const netIncome = ebt - tax;

    const cfads = computeCfads(revenue, opex, tax);
    let repayment = 0, dscr = null;
    if (flags.isOperation) {
      const maxRepay = computeMaxRepaymentAllowed(cfads, inputs.dscrTarget, interest, true);
      repayment = computeActualRepayment(maxRepay, debtOpening);
      closingBalance = computeClosingBalance(debtOpening, 0, repayment);
      dscr = computeDscr(true, cfads, interest, repayment);
    }

    const cashAvailableForDistribution = cfads - interest - upfrontFee - commitmentFee - repayment;
    const dividends = flags.isOperation ? computeDividends(cashAvailableForDistribution) : 0;

    // Balance sheet roll-forward
    ppeBalance = ppeBalance + capex - depreciation;
    // Construction funding (shareInjection + drawdown) covers capex AND that
    // period's interest/fees — but those financing costs are paid out in cash
    // that same period, not retained. Omitting them here left leftover cash
    // silently accumulating on the balance sheet (a real bug, not just a
    // rounding artifact — it threw the assets = liabilities + equity check
    // off by the full cumulative construction-period financing cost).
    const netCashflow = flags.isConstruction
      ? shareInjection + drawdown - capex - interest - upfrontFee - commitmentFee
      : cashAvailableForDistribution - dividends;
    cashBalance = cashBalance + netCashflow;
    shareCapitalBalance += shareInjection;
    retainedEarnings += netIncome - dividends;

    const totalAssets = ppeBalance + cashBalance;
    const totalLiabilities = closingBalance;
    const totalEquity = shareCapitalBalance + retainedEarnings;
    const balanceCheck = Math.abs(totalAssets - totalLiabilities - totalEquity);

    // Equity cashflow for EIRR
    const equityCf = flags.isConstruction ? -shareInjection : dividends;
    equityCashflows.push(equityCf);
    // Dated at period END (periodTo), matching the workbook's own cashflow-dating
    // convention — using periodFrom instead silently shifts every cashflow by
    // up to a full period and skews the IRR.
    equityDates.push(period.periodTo);

    rows.push({
      ...period,
      periodFromStr: fmtDate(period.periodFrom),
      periodToStr: fmtDate(period.periodTo),
      capex, drawdown, shareInjection,
      debtOpening, interest, upfrontFee, commitmentFee, repayment, closingBalance, dscr,
      revenue, opex, ebitda, depreciation, ebt, tax, netIncome, cfads,
      cashAvailableForDistribution, dividends,
      ppeBalance, cashBalance, shareCapitalBalance, retainedEarnings,
      totalAssets, totalLiabilities, totalEquity, balanceCheck,
    });

    debtOpening = closingBalance;
  });

  const eirr = xirr(equityCashflows, equityDates);
  const minDscr = Math.min(...rows.filter((r) => r.dscr != null).map((r) => r.dscr));
  const peakDebt = Math.max(...rows.map((r) => r.closingBalance));
  const totalDividends = sumRange(rows.map((r) => r.dividends), 0, rows.length - 1);
  const maxBalanceCheck = Math.max(...rows.map((r) => r.balanceCheck));

  return {
    rows, eirr, minDscr, peakDebt, totalDividends, gearing,
    totalConstructionCost: totalFundingRequired,
    shareCapitalTotal: totalFundingRequired - inputs.facilitySize,
    maxBalanceCheck,
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const DEFAULT_INPUTS = {
  fcDate: "2027-01-01", codDate: "2028-01-01", ppaTermYears: 10,
  monthsInYear: 12, semiAnnualPeriods: 2,
  epcPrice: 120000, developmentCosts: 5000, insuranceConstruction: 2000, spvCostsConstruction: 1000,
  omCost: 2000, insuranceOps: 500, spvCostsOps: 200,
  capacity: 150, generation: 250000, tariff: 0.1,
  facilitySize: 100000, dscrTarget: 1.2, interestRate: 0.07,
  upfrontFeePct: 0.01, commitmentFeePct: 0.005, citRate: 0.1,
};

const FIELD_GROUPS = [
  { title: "Timing", fields: [
    ["fcDate", "Financial Close"], ["codDate", "COD"], ["ppaTermYears", "PPA Term (yrs)"],
  ]},
  { title: "Construction Costs (USDk)", fields: [
    ["epcPrice", "EPC Price"], ["developmentCosts", "Development Costs"],
    ["insuranceConstruction", "Insurance (construction)"], ["spvCostsConstruction", "SPV Costs (construction)"],
  ]},
  { title: "Operating Costs (USDk / yr)", fields: [
    ["omCost", "O&M Cost"], ["insuranceOps", "Insurance (ops)"], ["spvCostsOps", "SPV Costs (ops)"],
  ]},
  { title: "Revenue", fields: [
    ["capacity", "Capacity (MWp)"], ["generation", "Generation (MWh/yr)"], ["tariff", "Tariff (USD/kWh)"],
  ]},
  { title: "Financing", fields: [
    ["facilitySize", "Facility Size (USDk)"], ["dscrTarget", "DSCR Target (x)"],
    ["interestRate", "Interest Rate"], ["upfrontFeePct", "Upfront Fee"],
    ["commitmentFeePct", "Commitment Fee"], ["citRate", "Corporate Tax Rate"],
  ]},
];

const fmtK = (v) => (v == null || isNaN(v) ? "—" : v.toLocaleString(undefined, { maximumFractionDigits: 0 }));
const fmtPct = (v) => (v == null || isNaN(v) ? "—" : (v * 100).toFixed(1) + "%");
const fmtX = (v) => (v == null || isNaN(v) ? "—" : v.toFixed(2) + "x");

// --- Theming -------------------------------------------------------------
const DARK_THEME = {
  mode: "dark", bg: "#0B0E14", panel: "#12161F", panelAlt: "#171C26", border: "#232B36",
  text: "#E6EDF3", textDim: "#8B96A5", amber: "#E8A33D", amberText: "#0B0E14",
  teal: "#45C4B0", red: "#E5484D", inputBg: "#0E1218", shadow: "rgba(0,0,0,0.55)",
  backdrop: "rgba(0,0,0,0.55)", rowTint: "rgba(232,163,61,0.05)",
};
const LIGHT_THEME = {
  mode: "light", bg: "#F6F4EF", panel: "#FFFFFF", panelAlt: "#F0EDE4", border: "#DEDAD0",
  text: "#1C1A16", textDim: "#6E6A5F", amber: "#B5651D", amberText: "#FFFFFF",
  teal: "#0F7A6E", red: "#B5342B", inputBg: "#FFFFFF", shadow: "rgba(30,25,15,0.12)",
  backdrop: "rgba(20,16,8,0.35)", rowTint: "rgba(181,101,29,0.06)",
};
const ThemeContext = React.createContext(DARK_THEME);
const useColors = () => React.useContext(ThemeContext);

// --- Responsive helper -----------------------------------------------------
function useIsMobile(breakpoint = 820) {
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < breakpoint : false
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}

function HeroStats({ eirr, tariff, isMobile }) {
  const c = useColors();
  const stats = [
    { label: "Equity IRR", value: fmtPct(eirr), icon: TrendingUp, accent: c.amber },
    { label: "Tariff", value: `$${tariff.toFixed(3)} / kWh`, icon: Zap, accent: c.teal },
  ];
  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", gap: 12, marginBottom: 18 }}>
      {stats.map(({ label, value, icon: Icon, accent }) => (
        <div key={label} style={{
          flex: 1, background: c.panel, border: `1.5px solid ${accent}`, borderRadius: 10,
          padding: isMobile ? "16px 18px" : "20px 24px", position: "relative", overflow: "hidden",
          boxShadow: `0 4px 20px ${c.shadow}`,
        }}>
          <div style={{
            position: "absolute", top: -30, right: -30, width: 110, height: 110, borderRadius: "50%",
            background: accent, opacity: c.mode === "dark" ? 0.10 : 0.08,
          }} />
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
            <Icon size={15} color={accent} />
            <div style={{ fontSize: 12, fontWeight: 700, color: c.textDim, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              {label}
            </div>
          </div>
          <div style={{
            fontSize: isMobile ? 34 : 44, fontWeight: 700, lineHeight: 1,
            fontFamily: "ui-monospace, 'SF Mono', 'Roboto Mono', monospace", color: accent,
          }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

function KpiCard({ label, value, accent }) {
  const c = useColors();
  return (
    <div style={{ background: c.panel, border: `1px solid ${c.border}`, borderRadius: 6, padding: "12px 14px", flex: "1 1 130px", minWidth: 130 }}>
      <div style={{ fontSize: 10.5, color: c.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: "ui-monospace, 'SF Mono', 'Roboto Mono', monospace", color: accent || c.text, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

// --- Field type inference ---------------------------------------------
function inferFieldType(id, value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return "date";
  if (typeof value === "number" && /(Pct|Rate)$/.test(id) && Math.abs(value) <= 1) return "percent";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "decimal";
  return "text";
}
function inferStep(type, value) {
  if (type === "integer") return 1;
  if (type === "decimal") return Math.abs(value) < 1 ? 0.001 : 0.1;
  return 1;
}

function Field({ id, label, value, onChange }) {
  const c = useColors();
  const type = inferFieldType(id, value);
  const style = inputStyle(c);

  if (type === "percent") {
    return (
      <label style={{ display: "block", marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: c.textDim, marginBottom: 3 }}>{label}</div>
        <div style={{ position: "relative" }}>
          <input type="number" step="0.1" value={(value * 100).toFixed(2)}
            onChange={(e) => onChange(id, parseFloat(e.target.value || 0) / 100)}
            style={style} />
          <span style={unitStyle(c)}>%</span>
        </div>
      </label>
    );
  }

  if (type === "date") {
    return (
      <label style={{ display: "block", marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: c.textDim, marginBottom: 3 }}>{label}</div>
        <DatePicker value={value} onChange={(v) => onChange(id, v)} />
      </label>
    );
  }

  const step = inferStep(type, value);
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: c.textDim, marginBottom: 3 }}>{label}</div>
      <input type="number" step={step} value={value}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(id, 0);
          onChange(id, type === "integer" ? parseInt(raw, 10) : parseFloat(raw));
        }}
        style={style} />
    </label>
  );
}

const inputStyle = (c) => ({
  width: "100%", background: c.inputBg, border: `1px solid ${c.border}`, borderRadius: 4,
  color: c.text, padding: "7px 9px", fontSize: 13, fontFamily: "ui-monospace, monospace", boxSizing: "border-box",
});
const unitStyle = (c) => ({ position: "absolute", right: 9, top: 7, fontSize: 12, color: c.textDim });

// --- Custom date picker -----------------------------------------------
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAY_LABELS = ["Su","Mo","Tu","We","Th","Fr","Sa"];

const parseISO = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toISO = (d) => d.toISOString().slice(0, 10);
const isSameDay = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();

function buildCalendarGrid(viewDate) {
  const year = viewDate.getUTCFullYear();
  const month = viewDate.getUTCMonth();
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const startWeekday = firstOfMonth.getUTCDay();
  const days = [];
  for (let i = 0; i < 42; i++) days.push(new Date(Date.UTC(year, month, 1 - startWeekday + i)));
  return days;
}

function DatePicker({ value, onChange }) {
  const c = useColors();
  const selected = parseISO(value);
  const [isOpen, setIsOpen] = useState(false);
  const [viewDate, setViewDate] = useState(new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth(), 1)));
  const rootRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const onOutside = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setIsOpen(false); };
    const onEscape = (e) => { if (e.key === "Escape") setIsOpen(false); };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onOutside); document.removeEventListener("keydown", onEscape); };
  }, [isOpen]);

  const openPicker = () => {
    setViewDate(new Date(Date.UTC(selected.getUTCFullYear(), selected.getUTCMonth(), 1)));
    setIsOpen(true);
  };

  const days = buildCalendarGrid(viewDate);
  const displayLabel = selected.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
  const style = inputStyle(c);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button type="button" onClick={openPicker}
        style={{ ...style, display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", textAlign: "left" }}>
        <span>{displayLabel}</span>
        <CalendarIcon size={14} color={c.textDim} />
      </button>

      {isOpen && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 100, width: 240,
          background: c.panelAlt, border: `1px solid ${c.border}`, borderRadius: 6,
          padding: 10, boxShadow: `0 8px 24px ${c.shadow}`,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <button type="button" onClick={() => setViewDate(new Date(Date.UTC(viewDate.getUTCFullYear(), viewDate.getUTCMonth() - 1, 1)))}
              style={navBtnStyle(c)}><ChevronLeft size={14} /></button>
            <div style={{ fontSize: 12, fontWeight: 600, color: c.text }}>
              {MONTH_NAMES[viewDate.getUTCMonth()]} {viewDate.getUTCFullYear()}
            </div>
            <button type="button" onClick={() => setViewDate(new Date(Date.UTC(viewDate.getUTCFullYear(), viewDate.getUTCMonth() + 1, 1)))}
              style={navBtnStyle(c)}><ChevronRight size={14} /></button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
            {WEEKDAY_LABELS.map((w) => (
              <div key={w} style={{ fontSize: 10, color: c.textDim, textAlign: "center", padding: "2px 0" }}>{w}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {days.map((d, i) => {
              const inMonth = d.getUTCMonth() === viewDate.getUTCMonth();
              const isSelected = isSameDay(d, selected);
              return (
                <button key={i} type="button"
                  onClick={() => { onChange(toISO(d)); setIsOpen(false); }}
                  style={{
                    fontSize: 11, padding: "5px 0", borderRadius: 4, border: "none", cursor: "pointer",
                    background: isSelected ? c.amber : "transparent",
                    color: isSelected ? c.amberText : inMonth ? c.text : c.textDim,
                    fontWeight: isSelected ? 700 : 400, fontFamily: "ui-monospace, monospace",
                    opacity: inMonth ? 1 : 0.4,
                  }}>
                  {d.getUTCDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
const navBtnStyle = (c) => ({
  background: "transparent", border: `1px solid ${c.border}`, borderRadius: 4,
  color: c.textDim, cursor: "pointer", padding: "3px 5px", display: "flex", alignItems: "center",
});

const TABS = ["Overview", "Debt Schedule", "Cash Flow", "Balance Sheet"];
const SIDEBAR_WIDTH = 280;
const TOPBAR_HEIGHT = 56;

export default function ProjectHawkModel() {
  const [inputs, setInputs] = useState(DEFAULT_INPUTS);
  const [tab, setTab] = useState("Overview");
  const [isLoading, setIsLoading] = useState(true);
  const [showOverlay, setShowOverlay] = useState(true);
  const [themeMode, setThemeMode] = useState("dark");
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(true); // desktop default: open. mobile default set below.

  useEffect(() => { setSidebarOpen(!isMobile); }, [isMobile]); // switching breakpoints resets to the sensible default

  const colors = themeMode === "dark" ? DARK_THEME : LIGHT_THEME;
  const handleChange = (id, val) => setInputs((prev) => ({ ...prev, [id]: val }));

  const result = useMemo(() => {
    try { return runModel(inputs); } catch (e) { return null; }
  }, [inputs]);

  useEffect(() => {
    if (result && isLoading) {
      const raf1 = requestAnimationFrame(() => { requestAnimationFrame(() => setIsLoading(false)); });
      return () => cancelAnimationFrame(raf1);
    }
  }, [result, isLoading]);

  useEffect(() => {
    if (!isLoading) {
      const t = setTimeout(() => setShowOverlay(false), 350);
      return () => clearTimeout(t);
    }
  }, [isLoading]);

  const chartData = useMemo(() => {
    if (!result) return [];
    return result.rows.map((r) => ({
      label: r.periodToStr.slice(0, 7),
      Revenue: Math.round(r.revenue), Opex: -Math.round(r.opex), EBITDA: Math.round(r.ebitda),
      Debt: Math.round(r.closingBalance), DSCR: r.dscr,
    }));
  }, [result]);

  const chartHeight = isMobile ? 200 : 240;
  const tickFont = isMobile ? 9 : 10;

  return (
    <ThemeContext.Provider value={colors}>
      <div style={{ position: "relative", background: colors.bg, minHeight: "100%" }}>
        {showOverlay && <LoadingScreen fading={!isLoading} />}

        {/* Top bar — always visible, holds the sidebar toggle + theme switch */}
        <div style={{
          height: TOPBAR_HEIGHT, display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 14px", borderBottom: `1px solid ${colors.border}`, background: colors.panel,
          position: "sticky", top: 0, zIndex: 30,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              onClick={() => setSidebarOpen((v) => !v)}
              aria-label={sidebarOpen ? "Hide inputs panel" : "Show inputs panel"}
              style={{
                display: "flex", alignItems: "center", gap: 7, background: colors.amber, color: colors.amberText,
                border: "none", borderRadius: 999, padding: "9px 14px", cursor: "pointer",
                fontSize: 12.5, fontWeight: 700, boxShadow: `0 2px 10px ${colors.shadow}`,
                whiteSpace: "nowrap",
              }}
            >
              {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
              {sidebarOpen ? "Hide Inputs" : "Show Inputs"}
            </button>
            {!isMobile && (
              <div>
                <div style={{ fontSize: 9.5, letterSpacing: "0.12em", color: colors.amber, textTransform: "uppercase" }}>Project Finance Model</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: colors.text, lineHeight: 1.1 }}>Project Hawk</div>
              </div>
            )}
          </div>

          <button
            onClick={() => setThemeMode((m) => (m === "dark" ? "light" : "dark"))}
            aria-label="Toggle light / dark theme"
            style={{
              display: "flex", alignItems: "center", gap: 6, background: "transparent",
              border: `1px solid ${colors.border}`, borderRadius: 999, padding: "7px 12px", cursor: "pointer",
              color: colors.text, fontSize: 12,
            }}
          >
            {themeMode === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            {!isMobile && (themeMode === "dark" ? "Light" : "Dark")}
          </button>
        </div>

        <div style={{ display: "flex", minHeight: `calc(100% - ${TOPBAR_HEIGHT}px)` }}>
          {/* Mobile backdrop */}
          {isMobile && sidebarOpen && (
            <div onClick={() => setSidebarOpen(false)}
              style={{ position: "fixed", inset: 0, top: TOPBAR_HEIGHT, background: colors.backdrop, zIndex: 25 }} />
          )}

          {/* Sidebar */}
          <div style={{
            width: sidebarOpen ? SIDEBAR_WIDTH : 0,
            flexShrink: 0,
            overflow: "hidden",
            transition: "width 220ms ease",
            borderRight: sidebarOpen ? `1px solid ${colors.border}` : "none",
            background: colors.panel,
            ...(isMobile
              ? {
                  position: "fixed", top: TOPBAR_HEIGHT, bottom: 0, left: 0, zIndex: 28,
                  width: sidebarOpen ? Math.min(SIDEBAR_WIDTH, window.innerWidth * 0.86) : 0,
                }
              : { position: "relative", maxHeight: `calc(100vh - ${TOPBAR_HEIGHT}px)` }),
          }}>
            <div style={{ width: SIDEBAR_WIDTH, padding: 18, overflowY: "auto", maxHeight: "100%", boxSizing: "border-box" }}>
              {FIELD_GROUPS.map((group) => (
                <div key={group.title} style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: colors.teal, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8, borderBottom: `1px solid ${colors.border}`, paddingBottom: 4 }}>
                    {group.title}
                  </div>
                  {group.fields.map(([id, label]) => (
                    <Field key={id} id={id} label={label} value={inputs[id]} onChange={handleChange} />
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* Main */}
          <div style={{ flex: 1, minWidth: 0, padding: isMobile ? 14 : 24, overflowY: "auto", maxHeight: `calc(100vh - ${TOPBAR_HEIGHT}px)`, boxSizing: "border-box" }}>
            {!result ? (
              <div style={{ color: colors.red }}>Model failed to compute — check inputs.</div>
            ) : (
              <>
                <HeroStats eirr={result.eirr} tariff={inputs.tariff} isMobile={isMobile} />

                <div style={{ display: "grid", gridTemplateColumns: isMobile ? "repeat(2, 1fr)" : "repeat(auto-fit, minmax(130px, 1fr))", gap: 10, marginBottom: 18 }}>
                  <KpiCard label="Min DSCR" value={fmtX(result.minDscr)} accent={result.minDscr < inputs.dscrTarget ? colors.red : colors.teal} />
                  <KpiCard label="Peak Debt (USDk)" value={fmtK(result.peakDebt)} />
                  <KpiCard label="Gearing" value={fmtPct(result.gearing)} />
                  <KpiCard label="Funding Required (USDk)" value={fmtK(result.totalConstructionCost)} />
                  <KpiCard label="BS Check (max Δ)" value={result.maxBalanceCheck.toFixed(3)} accent={result.maxBalanceCheck > 1 ? colors.red : colors.teal} />
                </div>

                <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${colors.border}`, overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
                  {TABS.map((t) => (
                    <button key={t} onClick={() => setTab(t)}
                      style={{
                        background: "transparent", border: "none", cursor: "pointer", flexShrink: 0,
                        color: tab === t ? colors.amber : colors.textDim,
                        borderBottom: tab === t ? `2px solid ${colors.amber}` : "2px solid transparent",
                        padding: "8px 12px", fontSize: 12.5, fontWeight: 600,
                      }}>{t}</button>
                  ))}
                </div>

                {tab === "Overview" && (
                  <>
                    <Panel title="Revenue, Opex & EBITDA (USDk / period)">
                      <ResponsiveContainer width="100%" height={chartHeight + 20}>
                        <ComposedChart data={chartData} margin={{ left: -14 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
                          <XAxis dataKey="label" tick={{ fill: colors.textDim, fontSize: tickFont }} interval={isMobile ? 4 : 2} />
                          <YAxis tick={{ fill: colors.textDim, fontSize: tickFont }} />
                          <Tooltip contentStyle={{ background: colors.panel, border: `1px solid ${colors.border}` }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Bar dataKey="Revenue" fill={colors.teal} />
                          <Bar dataKey="Opex" fill={colors.red} />
                          <Line dataKey="EBITDA" stroke={colors.amber} strokeWidth={2} dot={false} />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </Panel>
                    <Panel title="Senior Debt Balance (USDk)">
                      <ResponsiveContainer width="100%" height={chartHeight}>
                        <AreaChart data={chartData} margin={{ left: -14 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
                          <XAxis dataKey="label" tick={{ fill: colors.textDim, fontSize: tickFont }} interval={isMobile ? 4 : 2} />
                          <YAxis tick={{ fill: colors.textDim, fontSize: tickFont }} />
                          <Tooltip contentStyle={{ background: colors.panel, border: `1px solid ${colors.border}` }} />
                          <Area dataKey="Debt" stroke={colors.teal} fill={colors.teal} fillOpacity={0.15} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </Panel>
                    <Panel title="DSCR by operating period">
                      <ResponsiveContainer width="100%" height={chartHeight}>
                        <LineChart data={chartData.filter((d) => d.DSCR != null)} margin={{ left: -14 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
                          <XAxis dataKey="label" tick={{ fill: colors.textDim, fontSize: tickFont }} />
                          <YAxis tick={{ fill: colors.textDim, fontSize: tickFont }} domain={[0, "auto"]} />
                          <Tooltip contentStyle={{ background: colors.panel, border: `1px solid ${colors.border}` }} />
                          <ReferenceLine y={inputs.dscrTarget} stroke={colors.red} strokeDasharray="4 4" label={{ value: "Target", fill: colors.red, fontSize: 10 }} />
                          <Line dataKey="DSCR" stroke={colors.amber} strokeWidth={2} dot={{ r: 2 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </Panel>
                  </>
                )}

                {tab === "Debt Schedule" && (
                  <DataTable rows={result.rows} columns={[
                    ["periodToStr", "Period"], ["debtOpening", "Opening", fmtK], ["drawdown", "Drawdown", fmtK],
                    ["interest", "Interest", fmtK], ["repayment", "Repayment", fmtK], ["closingBalance", "Closing", fmtK],
                    ["dscr", "DSCR", fmtX],
                  ]} />
                )}

                {tab === "Cash Flow" && (
                  <DataTable rows={result.rows} columns={[
                    ["periodToStr", "Period"], ["revenue", "Revenue", fmtK], ["opex", "Opex", fmtK],
                    ["ebitda", "EBITDA", fmtK], ["tax", "Tax", fmtK], ["cfads", "CFADS", fmtK],
                    ["dividends", "Dividends", fmtK],
                  ]} />
                )}

                {tab === "Balance Sheet" && (
                  <DataTable rows={result.rows} columns={[
                    ["periodToStr", "Period"], ["ppeBalance", "PP&E", fmtK], ["cashBalance", "Cash", fmtK],
                    ["totalAssets", "Total Assets", fmtK], ["totalLiabilities", "Total Liab.", fmtK],
                    ["totalEquity", "Total Equity", fmtK], ["balanceCheck", "Δ Check", (v) => v.toFixed(4)],
                  ]} />
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </ThemeContext.Provider>
  );
}

function LoadingScreen({ fading }) {
  const c = useColors();
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: c.bg, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center", gap: 16,
        opacity: fading ? 0 : 1, pointerEvents: fading ? "none" : "auto",
        transition: "opacity 350ms ease",
      }}
    >
      <style>{`@keyframes hawk-spin { to { transform: rotate(360deg); } }`}</style>
      <div
        style={{
          width: 40, height: 40, borderRadius: "50%",
          border: `3px solid ${c.border}`, borderTopColor: c.amber,
          animation: "hawk-spin 800ms linear infinite",
        }}
      />
      <div style={{ fontSize: 11, letterSpacing: "0.14em", color: c.textDim, textTransform: "uppercase" }}>
        Loading Project Hawk
      </div>
    </div>
  );
}

function Panel({ title, children }) {
  const c = useColors();
  return (
    <div style={{ background: c.panel, border: `1px solid ${c.border}`, borderRadius: 6, padding: 14, marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: c.textDim, textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function DataTable({ rows, columns }) {
  const c = useColors();
  return (
    <div style={{ background: c.panel, border: `1px solid ${c.border}`, borderRadius: 6, overflow: "auto", maxHeight: 560, WebkitOverflowScrolling: "touch" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
        <thead>
          <tr>
            {columns.map(([key, label]) => (
              <th key={key} style={{ position: "sticky", top: 0, background: c.panelAlt, textAlign: "right", padding: "8px 10px", borderBottom: `1px solid ${c.border}`, color: c.textDim, fontFamily: "Inter, sans-serif", whiteSpace: "nowrap" }}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: r.phase === "construction" ? c.rowTint : "transparent" }}>
              {columns.map(([key, label, fmt]) => (
                <td key={key} style={{ textAlign: "right", padding: "6px 10px", borderBottom: `1px solid ${c.border}`, color: c.text, whiteSpace: "nowrap" }}>
                  {fmt ? fmt(r[key]) : r[key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
