type DateCell = string | number | boolean | null | undefined;

const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface ParsedDate {
  isoLocal: string;
  sortValue: number;
  hasTime: boolean;
}

export function sheetCellToString(value: DateCell): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function normalizeDateValue(value: DateCell): string {
  return parseDateValue(value)?.isoLocal || sheetCellToString(value).trim();
}

export function dateSortValue(value: DateCell): number {
  return parseDateValue(value)?.sortValue || 0;
}

export function isDateSortField(field: string): boolean {
  return field === "createdAt" || field === "calledAt" || field === "lastUpdatedAt";
}

export function formatDateValue(value: DateCell): string {
  const parsed = parseDateValue(value);
  if (!parsed) {
    const raw = sheetCellToString(value).trim();
    return raw || "-";
  }

  const date = new Date(parsed.isoLocal);
  if (Number.isNaN(date.getTime())) return parsed.isoLocal;

  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (parsed.hasTime) {
    options.hour = "numeric";
    options.minute = "2-digit";
  }

  return date.toLocaleDateString("en-US", options);
}

function parseDateValue(value: DateCell): ParsedDate | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return fromSheetsSerial(value);
  }

  const raw = sheetCellToString(value).trim();
  if (!raw) return null;

  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    if (serial > 20000 && serial < 100000) return fromSheetsSerial(serial);
  }

  const dmy = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[,\s]+(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?)?$/i
  );
  if (dmy) {
    const [, first, second, yearRaw, hourRaw, minuteRaw, secondRaw, meridiem] = dmy;
    let day = Number(first);
    let month = Number(second);
    const firstNum = Number(first);
    const secondNum = Number(second);

    if (secondNum > 12 && firstNum <= 12) {
      day = secondNum;
      month = firstNum;
    }

    let hour = hourRaw ? Number(hourRaw) : 0;
    const minute = minuteRaw ? Number(minuteRaw) : 0;
    const secondPart = secondRaw ? Number(secondRaw) : 0;
    if (meridiem) {
      const upper = meridiem.toUpperCase();
      if (upper === "PM" && hour < 12) hour += 12;
      if (upper === "AM" && hour === 12) hour = 0;
    }

    const year = yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw);
    return fromParts(year, month, day, hour, minute, secondPart, Boolean(hourRaw));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const hasTime = /(?:T|\s)\d{1,2}:\d{2}/.test(raw);
  return {
    isoLocal: toLocalIso(parsed),
    sortValue: parsed.getTime(),
    hasTime,
  };
}

function fromSheetsSerial(serial: number): ParsedDate {
  const ms = SHEETS_EPOCH_MS + serial * MS_PER_DAY;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  const second = d.getUTCSeconds();
  return fromParts(year, month, day, hour, minute, second, hasSerialTime(serial));
}

function fromParts(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  hasTime: boolean
): ParsedDate {
  return {
    isoLocal: `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
    sortValue: Date.UTC(year, month - 1, day, hour, minute, second),
    hasTime,
  };
}

function toLocalIso(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function hasSerialTime(serial: number): boolean {
  const fraction = Math.abs(serial - Math.floor(serial));
  return fraction > 1 / MS_PER_DAY;
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0");
}
