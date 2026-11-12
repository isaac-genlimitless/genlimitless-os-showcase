"use client";

import { centralParts, centralToIso, fmtCentral, parseStored } from "@/lib/time";

const cls = "bg-black/30 border border-panel-border rounded px-2 py-1.5 text-xs";

export function CentralDateTimeInput({
  value,
  onChange,
  label,
  testId,
}: {
  value: string;
  onChange: (iso: string) => void;
  label?: string;
  testId?: string;
}) {
  let d = parseStored(value);
  if (!d) {
    const t = Math.ceil(Date.now() / 300000) * 300000;
    d = new Date(t);
  }
  const { date, hour24, minute } = centralParts(d);
  const ampm = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const minutes: number[] = [];
  for (let m = 0; m < 60; m += 5) minutes.push(m);
  if (!minutes.includes(minute)) {
    minutes.push(minute);
    minutes.sort((a, b) => a - b);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const to24 = (h12: number, ap: string) => (h12 % 12) + (ap === "PM" ? 12 : 0);
  const zone = fmtCentral(d, { weekday: undefined, month: undefined, day: undefined, hour: undefined, minute: undefined, timeZoneName: "short" });
  const id = (s: string) => (testId ? `${testId}-${s}` : undefined);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {label && <span className="text-xs text-muted w-10">{label}</span>}
      <input
        type="date"
        aria-label={label ? `${label} date` : "Date"}
        data-testid={id("date")}
        value={date}
        onChange={(e) => e.target.value && onChange(centralToIso(e.target.value, hour24, minute))}
        className={cls}
      />
      <select
        aria-label={label ? `${label} hour` : "Hour"}
        data-testid={id("hour")}
        value={hour12}
        onChange={(e) => onChange(centralToIso(date, to24(Number(e.target.value), ampm), minute))}
        className={cls}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <select
        aria-label={label ? `${label} minute` : "Minute"}
        data-testid={id("minute")}
        value={minute}
        onChange={(e) => onChange(centralToIso(date, hour24, Number(e.target.value)))}
        className={cls}
      >
        {minutes.map((m) => (
          <option key={m} value={m}>
            {pad(m)}
          </option>
        ))}
      </select>
      <select
        aria-label={label ? `${label} AM/PM` : "AM/PM"}
        data-testid={id("ampm")}
        value={ampm}
        onChange={(e) => onChange(centralToIso(date, to24(hour12, e.target.value), minute))}
        className={cls}
      >
        <option value="AM">AM</option>
        <option value="PM">PM</option>
      </select>
      <span className="text-[10px] text-muted">{zone}</span>
    </div>
  );
}
